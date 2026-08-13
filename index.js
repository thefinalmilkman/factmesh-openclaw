'use strict';
// factmesh — an OpenClaw memory plugin backed by a Lichen fact-mesh (http://127.0.0.1:4174, local-only).
// Lichen is a grown-not-trained fact store with reinforce/decay: recall strengthens, disuse fades, and it
// reports structured coverage ({score, level, gaps}) instead of hallucinating. This plugin wires it into
// OpenClaw as the memory backend:
//   before_prompt_build  -> POST /recall with the current user turn, inject top-k facts via prependContext
//                           under a configurable token budget (retrieval-only on Lichen's side — NO LLM,
//                           works with Ollama down; a down Lichen silently skips, never breaks a prompt)
//   agent_end / before_compaction -> deterministic write-through capture of USER-stated durable facts to
//                           /learn (patterns only, no LLM; assistant text is never captured)
//   tools                -> memory_search (/recall), memory_add (/learn), memory_forget (see its honest
//                           description: Lichen v1 has NO delete — it downweights via /outcome and supersedes
//                           via /learn corrections)
//   CLI                  -> `openclaw factmesh status` (/health), `openclaw factmesh search <query>` (/recall)
// Plain CommonJS, zero runtime dependencies. Tool input schemas are hand-written JSON Schema — the exact
// shape TypeBox compiles to — so @sinclair/typebox is NOT required (if a future OpenClaw validates via
// TypeBox internals rather than JSON Schema, add it and swap the schemas; noted in README).

const { makeClient } = require('./lib/client');
const { extractFacts } = require('./lib/extract');
const { fitBudget, estimateTokens } = require('./lib/budget');

const DEFAULTS = {
  lichenUrl: 'http://127.0.0.1:4174',
  tokenBudget: 600,   // max tokens of recalled facts injected per prompt (chars/4 estimate)
  capture: true,      // write-through capture on agent_end / before_compaction
  recallK: 6,         // top-k facts recalled per turn
  timeoutMs: 4000,    // hard HTTP timeout; a slow Lichen must never stall a turn
};

// Hand-rolled, zero-dep equivalent of a zod schema's safeParse ({ success, data | error }) — the only
// contract OpenClaw's config loader needs. Keeps the plugin dependency-free.
const configSchema = {
  safeParse(value) {
    const v = value == null ? {} : value;
    if (typeof v !== 'object' || Array.isArray(v)) return { success: false, error: new Error('factmesh config must be an object') };
    if (v.lichenUrl != null && typeof v.lichenUrl !== 'string') return { success: false, error: new Error('lichenUrl must be a string') };
    if (v.tokenBudget != null && (typeof v.tokenBudget !== 'number' || v.tokenBudget < 0)) return { success: false, error: new Error('tokenBudget must be a non-negative number') };
    if (v.capture != null && typeof v.capture !== 'boolean') return { success: false, error: new Error('capture must be a boolean') };
    if (v.recallK != null && (typeof v.recallK !== 'number' || v.recallK < 1)) return { success: false, error: new Error('recallK must be a positive number') };
    if (v.timeoutMs != null && (typeof v.timeoutMs !== 'number' || v.timeoutMs < 100)) return { success: false, error: new Error('timeoutMs must be a number >= 100') };
    return { success: true, data: v };
  },
  uiHints: {
    lichenUrl: { label: 'Lichen URL', placeholder: DEFAULTS.lichenUrl },
    tokenBudget: { label: 'Recall token budget', advanced: true },
    capture: { label: 'Write-through capture' },
    recallK: { label: 'Facts per turn (k)', advanced: true },
    timeoutMs: { label: 'HTTP timeout (ms)', advanced: true },
  },
};

const RECALL_HEADER =
  'LICHEN MEMORY — facts recalled from the local fact-mesh (grown from the user\'s own world, confidence tier in brackets; treat [stale]/[inferred] as uncertain):';

function makeMemoryBlock(recall, tokenBudget) {
  const facts = Array.isArray(recall && recall.facts) ? recall.facts : [];
  if (!facts.length) return null;
  const lines = facts.map((f) => '- [' + (f.confidence || 'observed') + '] ' + f.text);
  const fit = fitBudget(lines, Math.max(0, tokenBudget - estimateTokens(RECALL_HEADER)));
  if (!fit.lines.length) return null;
  let block = RECALL_HEADER + '\n' + fit.lines.join('\n');
  const cov = recall.coverage;
  if (cov && cov.level === 'low') {
    block += '\n(Coverage LOW' + (cov.gaps && cov.gaps.length ? ' — the mesh has nothing mentioning: ' + cov.gaps.join(', ') : '') +
      '. Do not treat the above as authoritative; say honestly when the memory does not cover something.)';
  }
  return block;
}

const plugin = {
  id: 'factmesh',
  name: 'factmesh (Lichen memory)',
  description: 'Memory backend backed by a local Lichen fact-mesh: honest recall with confidence tiers and coverage, write-through capture, zero API cost, fully offline.',
  configSchema,

  register(api) {
    const cfg = Object.assign({}, DEFAULTS, api.pluginConfig || {});
    const client = makeClient(cfg);
    const log = api.logger || console;
    const debug = (msg) => { try { (log.debug || log.info).call(log, msg); } catch (_) {} };

    // ---- RECALL: inject mesh facts into every prompt, budget-bounded, failure-silent ----
    api.registerHook('before_prompt_build', async (event) => {
      try {
        const query = String((event && event.prompt) || '').trim();
        if (!query) return;
        const recall = await client.recall(query, cfg.recallK);
        const block = makeMemoryBlock(recall, cfg.tokenBudget);
        if (!block) return;
        return { prependContext: block };
      } catch (e) {
        debug('factmesh: recall skipped (' + ((e && e.message) || e) + ')'); // memory down must never break a prompt
      }
    }, { name: 'factmesh-recall', description: 'Inject Lichen fact-mesh recall into the prompt' });

    // ---- CAPTURE: deterministic write-through of user-stated durable facts ----
    const capture = async (messages, why) => {
      if (!cfg.capture) return;
      try {
        const facts = extractFacts(messages, { src: 'openclaw:' + why });
        if (!facts.length) return;
        const r = await client.learn(facts);
        log.info('factmesh: captured ' + facts.length + ' fact(s) to Lichen (' + why + ', added ' + (r && r.added != null ? r.added : '?') + ' new)');
      } catch (e) {
        debug('factmesh: capture skipped (' + ((e && e.message) || e) + ')');
      }
    };
    api.registerHook('agent_end', (event) => capture(event && event.messages, 'agent_end'), { name: 'factmesh-capture-agent-end', description: 'Write-through capture of user-stated facts at turn end' });
    api.registerHook('before_compaction', (event) => capture(event && event.messages, 'before_compaction'), { name: 'factmesh-capture-compaction', description: 'Write-through capture of user-stated facts before compaction' });

    // ---- TOOLS ----
    api.registerTool({
      name: 'memory_search',
      description: 'Search the user\'s Lichen fact-mesh memory for facts relevant to a query. Returns facts with confidence tiers (verified/observed/inferred/stale) and a coverage level; low coverage means the memory honestly has little — say so rather than guessing.',
      input: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for in memory', minLength: 1 },
          k: { type: 'integer', minimum: 1, maximum: 24, description: 'How many facts to return (default from plugin config)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async (args) => {
        try {
          const r = await client.recall(String(args.query), args.k);
          return {
            result: 'success',
            details: {
              facts: (r.facts || []).map((f) => ({ text: f.text, confidence: f.confidence, stability: f.stability, availability: f.availability, src: f.src })),
              coverage: r.coverage || null,
              count: (r.facts || []).length,
            },
          };
        } catch (e) {
          return { result: 'error', error: 'Lichen unreachable: ' + ((e && e.message) || e) };
        }
      },
    });

    api.registerTool({
      name: 'memory_add',
      description: 'Teach the user\'s Lichen fact-mesh a durable fact (preference, project state, decision, person detail). Exact duplicates just reinforce the existing fact; a correction ("Correction: ...") can supersede the old one. Do NOT use for speculation or one-off chatter.',
      input: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact to remember, as a plain statement', minLength: 4, maxLength: 400 },
          confidence: { type: 'string', enum: ['verified', 'observed', 'inferred'], description: 'Confidence tier (default observed)' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      execute: async (args) => {
        try {
          const r = await client.learnText(String(args.text), { src: 'openclaw:tool', confidence: args.confidence || 'observed' });
          return { result: 'success', details: { added: r.added, total: r.total } };
        } catch (e) {
          return { result: 'error', error: 'Lichen unreachable: ' + ((e && e.message) || e) };
        }
      },
    });

    // Honest surface: Lichen v1 has NO delete endpoint. What exists: /outcome {good:false} downweights a fact
    // (up to ~2x faster decay) and /learn with a correction supersedes it. True deletion is a Lichen-side TODO.
    api.registerTool({
      name: 'memory_forget',
      description: 'Downweight a wrong or unwanted memory so it fades faster (Lichen has no hard delete: this records a bad outcome, up to ~2x faster decay). To correct a fact instead, use memory_add with "Correction: ..." to supersede it.',
      input: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Exact text (or distinctive substring) of the fact to downweight', minLength: 2 },
        },
        required: ['text'],
        additionalProperties: false,
      },
      execute: async (args) => {
        try {
          const r = await client.outcome({ text: String(args.text), good: false });
          return {
            result: 'success',
            details: { factId: r.factId, rewardFactor: r.rewardFactor, note: 'Downweighted, not deleted — Lichen has no hard delete; the fact now decays faster.' },
          };
        } catch (e) {
          if (e && e.status === 404) return { result: 'error', error: 'No matching fact in the mesh.' };
          return { result: 'error', error: 'Lichen unreachable: ' + ((e && e.message) || e) };
        }
      },
    }, { optional: true }); // optional: downweighting memory is sensitive — requires explicit allowlisting

    // ---- CLI: `openclaw factmesh status` / `openclaw factmesh search <query>` ----
    api.registerCli((ctx) => {
      const fm = ctx.program.command('factmesh').description('Lichen fact-mesh memory backend');
      fm.command('status')
        .description('Check the Lichen memory backend (GET /health)')
        .action(async () => {
          try {
            const h = await client.health();
            ctx.logger.info('Lichen ' + (h.version || '') + ' at ' + cfg.lichenUrl + ': ' + h.facts + ' facts, ' + h.edges + ' edges, ' + (h.attention || 0) + ' attention item(s)');
          } catch (e) {
            ctx.logger.error('Lichen unreachable at ' + cfg.lichenUrl + ': ' + ((e && e.message) || e));
          }
        });
      fm.command('search <query>')
        .description('Recall facts from the mesh (POST /recall)')
        .option('-k <n>', 'how many facts', String(cfg.recallK))
        .action(async (query, opts) => {
          try {
            const r = await client.recall(query, parseInt(opts && opts.k, 10) || cfg.recallK);
            if (!r.facts || !r.facts.length) { ctx.logger.info('(no facts — coverage: ' + (r.coverage ? r.coverage.level : 'unknown') + ')'); return; }
            for (const f of r.facts) ctx.logger.info('[' + f.confidence + '] ' + f.text);
            if (r.coverage) ctx.logger.info('coverage: ' + r.coverage.level + ' (score ' + r.coverage.score + ')' + (r.coverage.gaps && r.coverage.gaps.length ? ', gaps: ' + r.coverage.gaps.join(', ') : ''));
          } catch (e) {
            ctx.logger.error('Lichen unreachable at ' + cfg.lichenUrl + ': ' + ((e && e.message) || e));
          }
        });
    });

    log.info('factmesh registered (Lichen at ' + cfg.lichenUrl + ', capture ' + (cfg.capture ? 'on' : 'off') + ', budget ' + cfg.tokenBudget + ' tokens)');
  },
};

module.exports = plugin;
module.exports.default = plugin; // jiti/ESM interop: OpenClaw dynamic-imports the entry and reads .default
