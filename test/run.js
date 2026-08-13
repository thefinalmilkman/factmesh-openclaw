'use strict';
// factmesh test runner. Zero-dep, plain node. Four suites:
//   extract / budget : pure unit tests of the deterministic capture + token-budget logic
//   client-live      : read-only probe of the LIVE Lichen at 127.0.0.1:4174 (GET /health only —
//                      /learn is NEVER posted against the live personal brain; /recall is attempted
//                      and reported informationally — it 404s until Lichen is restarted with the new route)
//   harness          : a TEMP COPY of the Lichen server (own scratch port, own tiny mesh in a tmp dir —
//                      the live mesh.json / journal are never touched) exercising /learn + /recall end-to-end

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { extractFacts, userTexts } = require('../lib/extract');
const { estimateTokens, fitBudget } = require('../lib/budget');
const { makeClient } = require('../lib/client');
const plugin = require('../index');

// Dev default: lichen checked out as a sibling of this package. Override with LICHEN_DIR.
const LICHEN_DIR = process.env.LICHEN_DIR || path.resolve(__dirname, '..', '..', 'lichen');
const LIVE_URL = process.env.LICHEN_URL || 'http://127.0.0.1:4174';
const SCRATCH_PORT = Number(process.env.FACTMESH_SCRATCH_PORT || 4199);

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ok  ' + name); })
    .catch((e) => { failed++; console.log('  FAIL ' + name + ' — ' + ((e && e.message) || e)); });
}

// ---------- extract ----------
async function suiteExtract() {
  console.log('\n[extract]');
  await test('explicit "remember:" is captured', () => {
    const f = extractFacts([{ role: 'user', content: 'Remember: Vallarta project is closed.' }]);
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].text, 'Vallarta project is closed');
    assert.strictEqual(f[0].meta.capture, 'explicit');
  });
  await test('"remember that" and "don\'t forget" variants', () => {
    const f = extractFacts([{ role: 'user', content: "Please remember that I use Tailscale for remote access. Don't forget: the laptop runs hot." }]);
    assert.strictEqual(f.length, 2);
  });
  await test('user-stated facts captured verbatim', () => {
    const f = extractFacts([{ role: 'user', content: 'I prefer tea over coffee. My editor is Vim.' }]);
    assert.deepStrictEqual(f.map((x) => x.text), ['I prefer tea over coffee', 'My editor is Vim']);
  });
  await test('assistant messages are NEVER captured', () => {
    const f = extractFacts([
      { role: 'assistant', content: 'Remember: this is assistant speculation. I prefer lying.' },
      { role: 'user', content: 'ok, sounds good' },
    ]);
    assert.strictEqual(f.length, 0);
  });
  await test('questions and agent-addressed text are skipped', () => {
    const f = extractFacts([{ role: 'user', content: 'Remember: can you check the logs? Remember: you should always ask me first.' }]);
    assert.strictEqual(f.length, 0);
  });
  await test('dedupes within a batch', () => {
    const f = extractFacts([{ role: 'user', content: 'Remember: Lichen runs on port 4174. Remember: Lichen runs on port 4174.' }]);
    assert.strictEqual(f.length, 1);
  });
  await test('array-of-parts content + non-user roles in userTexts', () => {
    const t = userTexts([
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', url: 'x' }] },
      { role: 'system', content: 'nope' },
      'garbage',
    ]);
    assert.deepStrictEqual(t, ['hello']);
  });
  await test('malformed input never throws', () => {
    assert.deepStrictEqual(extractFacts(null), []);
    assert.deepStrictEqual(extractFacts(undefined), []);
    assert.deepStrictEqual(extractFacts([null, 42, {}]), []);
  });
}

// ---------- budget ----------
async function suiteBudget() {
  console.log('\n[budget]');
  await test('estimateTokens is chars/4 ceil', () => {
    assert.strictEqual(estimateTokens(''), 0);
    assert.strictEqual(estimateTokens('abcd'), 1);
    assert.strictEqual(estimateTokens('abcde'), 2);
  });
  await test('fits rank-ordered lines until full', () => {
    const lines = ['aaaa', 'bbbb', 'cccc']; // 1 token each
    const fit = fitBudget(lines, 2);
    assert.deepStrictEqual(fit.lines, ['aaaa', 'bbbb']);
    assert.strictEqual(fit.usedTokens, 2);
    assert.strictEqual(fit.dropped, 1);
  });
  await test('oversized line is truncated, not dropped, when room remains', () => {
    const fit = fitBudget(['x'.repeat(400)], 50); // 100-token line, 50-token budget
    assert.strictEqual(fit.lines.length, 1);
    assert.ok(fit.lines[0].endsWith('…'));
    assert.ok(fit.lines[0].length <= 50 * 4);
  });
  await test('zero budget yields nothing', () => {
    assert.deepStrictEqual(fitBudget(['aaaa'], 0).lines, []);
  });
}

// ---------- plugin shape (no OpenClaw needed: register against a mock api) ----------
async function suitePluginShape() {
  console.log('\n[plugin shape — mock OpenClaw api]');
  await test('register wires hooks, 3 tools, CLI against a mock api', async () => {
    const hooks = {}, tools = [], clis = [];
    const mock = {
      pluginConfig: { lichenUrl: 'http://127.0.0.1:1', timeoutMs: 300 }, // dead URL: hooks must fail silent
      logger: { info() {}, error() {}, debug() {} },
      registerHook: (name, fn) => { hooks[name] = fn; },
      registerTool: (t, opts) => { tools.push({ t, opts }); },
      registerCli: (fn) => { clis.push(fn); },
    };
    plugin.register(mock);
    assert.ok(hooks.before_prompt_build && hooks.agent_end && hooks.before_compaction, 'hooks registered');
    assert.deepStrictEqual(tools.map((x) => x.t.name), ['memory_search', 'memory_add', 'memory_forget']);
    assert.strictEqual(tools[2].opts.optional, true, 'memory_forget is optional (sensitive)');
    assert.strictEqual(clis.length, 1);
    // down Lichen: recall hook resolves to undefined (silent skip), never throws
    const out = await hooks.before_prompt_build({ prompt: 'anything' });
    assert.strictEqual(out, undefined);
  });
  await test('configSchema.safeParse validates types', () => {
    assert.strictEqual(plugin.configSchema.safeParse({}).success, true);
    assert.strictEqual(plugin.configSchema.safeParse({ capture: 'yes' }).success, false);
    assert.strictEqual(plugin.configSchema.safeParse({ tokenBudget: -5 }).success, false);
    assert.strictEqual(plugin.configSchema.safeParse({ lichenUrl: 'http://x', recallK: 3 }).success, true);
  });
}

// ---------- client against LIVE lichen (read-only) ----------
async function suiteClientLive() {
  console.log('\n[client vs LIVE lichen @ ' + LIVE_URL + ' — read-only]');
  const client = makeClient({ lichenUrl: LIVE_URL, timeoutMs: 3000 });
  await test('GET /health on the live brain', async () => {
    const h = await client.health();
    assert.strictEqual(h.ok, true);
    assert.ok(typeof h.facts === 'number' && h.facts > 0, 'live mesh has facts');
    console.log('       live: ' + h.version + ', ' + h.facts + ' facts, ' + h.edges + ' edges');
  });
  await test('POST /recall on live (informational until lichen restart)', async () => {
    try {
      const r = await client.recall('what is Lichen?', 3);
      console.log('       live /recall is UP: ' + (r.facts || []).length + ' facts');
    } catch (e) {
      console.log('       live /recall not up yet (expected until lichen restarts): ' + e.message + ' — harness suite covers the route');
    }
  });
}

// ---------- harness: temp copy of lichen on a scratch port ----------
const HARNESS_FILES = ['server.js', 'lichen.js', 'mesh.js', 'embed.js', 'retrieval.js', 'graph.js', 'journal.js', 'recipes.js', 'notify.js'];

async function waitUp(url, ms) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url + '/health'); if (r.ok) return; } catch (_) {}
    if (Date.now() - t0 > ms) throw new Error('harness server never came up');
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function suiteHarness() {
  console.log('\n[harness — temp lichen copy on 127.0.0.1:' + SCRATCH_PORT + ', own tmp mesh]');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factmesh-harness-'));
  for (const f of HARNESS_FILES) fs.copyFileSync(path.join(LICHEN_DIR, f), path.join(tmp, f));
  process.env.LICHEN_PORT = String(SCRATCH_PORT);
  const base = 'http://127.0.0.1:' + SCRATCH_PORT;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  try {
    require(path.join(tmp, 'server.js')); // listens immediately on LICHEN_PORT; mesh.json absent => empty mesh
    await waitUp(base, 8000);

    await test('/learn teaches the temp mesh (not the live one)', async () => {
      const r = await post('/learn', { facts: [
        { text: 'The team offsite is planned for early October.', meta: { src: 'harness' } },
        { text: 'Alex prefers USDT for crypto payments.', meta: { src: 'harness' } },
        { text: 'The office laptop CPU runs hot and needs a repaste.', meta: { src: 'harness' } },
      ] });
      const j = await r.json();
      assert.strictEqual(r.status, 200);
      assert.strictEqual(j.added, 3);
      assert.strictEqual(j.total, 3);
    });

    await test('/recall returns relevant facts with living metadata + coverage', async () => {
      const r = await post('/recall', { query: 'which crypto does Alex prefer?', k: 2 });
      const j = await r.json();
      assert.strictEqual(r.status, 200);
      assert.strictEqual(j.ok, true);
      assert.ok(Array.isArray(j.facts) && j.facts.length >= 1 && j.facts.length <= 2);
      const f = j.facts[0];
      for (const key of ['id', 'text', 'confidence', 'stability', 'availability', 'uses', 'born', 'lastUsed']) assert.ok(key in f, 'fact has ' + key);
      assert.ok(/USDT/.test(j.facts.map((x) => x.text).join(' ')), 'USDT fact surfaced for a crypto query');
      assert.ok(j.coverage && typeof j.coverage.score === 'number' && ['high', 'partial', 'low'].includes(j.coverage.level));
      console.log('       recall: "' + f.text + '" [' + f.confidence + ', s=' + f.stability + ', avail=' + f.availability + '], coverage ' + j.coverage.level + ', ' + j.latencyMs + 'ms');
    });

    await test('/recall is retrieval-only: fast, and no answer field (no LLM output)', async () => {
      const t0 = Date.now();
      const r = await post('/recall', { query: 'laptop temperature' });
      const j = await r.json();
      const ms = Date.now() - t0;
      assert.strictEqual(r.status, 200);
      assert.ok(!('text' in j) && !('answer' in j), 'no LLM answer in the response');
      assert.ok(!('model' in j), 'no procedure-model tag — the LLM was never touched');
      assert.ok(ms < 15000, 'fast (' + ms + 'ms) — /ask through phi4-mini takes far longer');
    });

    await test('/recall k is honored and capped at the candidate pool', async () => {
      const r = await post('/recall', { query: 'trip', k: 99 });
      const j = await r.json();
      assert.ok(j.facts.length <= 24, 'capped at candidates pool');
    });

    await test('/recall rejects an empty query (400), GET /recall is 404', async () => {
      const r1 = await post('/recall', { query: '   ' });
      assert.strictEqual(r1.status, 400);
      const r2 = await fetch(base + '/recall');
      assert.strictEqual(r2.status, 404);
    });

    await test('plugin client drives the harness: learnText -> recall -> outcome', async () => {
      const client = makeClient({ lichenUrl: base });
      await client.learnText('Remember: harness fact about the backup off-ramp.', { src: 'harness:client' });
      const rec = await client.recall('backup off-ramp', 3);
      assert.ok(rec.facts.some((f) => /off-ramp/.test(f.text)));
      const out = await client.outcome({ text: 'off-ramp', good: false });
      assert.strictEqual(out.ok, true);
      assert.ok(out.rewardFactor < 1, 'bad outcome downweights (rewardFactor < 1)');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  console.log('factmesh tests — node ' + process.version);
  await suiteExtract();
  await suiteBudget();
  await suitePluginShape();
  await suiteHarness();
  await suiteClientLive();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('runner crashed:', e); process.exit(1); });
