'use strict';
// Deterministic durable-fact extraction for factmesh's write-through capture.
// NO LLM calls — patterns only, conservative on purpose: a missed fact is cheap (the user can say
// "remember: ..."), a captured hallucination pollutes the mesh forever. Two signal classes:
//   1. EXPLICIT intent at sentence start: "remember: ...", "remember that ...", "don't forget ..." — captured.
//   2. USER-STATED self facts: "I prefer/use/always/never ...", "my <thing> is/are ..." — captured verbatim.
// Only USER messages are ever scanned. Assistant text is speculation and is never captured.
// Extraction runs PER SENTENCE (split on newlines / sentence terminators) so an explicit marker can never
// swallow the sentences that follow it; a sentence that matched explicit is not re-scanned for stated.

const EXPLICIT_RE = /^(?:please\s+)?(?:remember\s*:\s*|remember\s+that\s+|don'?t forget\s*:\s*|don'?t forget\s+that\s+|note to self\s*:\s*)(.+)$/i;
const STATED_RE = /^((?:i\s+(?:prefer|use|always|never|usually)\b|my\s+[a-z][\w -]{1,40}\s+(?:is|are)\b).{3,200})$/i;

const MIN_LEN = 8;
const MAX_LEN = 400;

// normalize + filter one candidate; returns the fact text or null. Terminal sentence punctuation is
// stripped — "X." and "X" must dedupe to the same fact in the mesh (Lichen's exact-dedup ignores
// case/whitespace but not punctuation).
function cleanFact(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (s.endsWith('?')) return null;                       // a question is not a fact
  const t = s.replace(/[.!]+$/, '');
  if (t.length < MIN_LEN || t.length > MAX_LEN) return null;
  if (/\b(you|your|assistant|chatgpt|claude)\b/i.test(t)) return null; // addressed AT the agent, not about the user
  return t;
}

// pull user-authored text out of OpenClaw's unknown-shaped message list. Content may be a string
// or an array of parts ({ type:'text', text }); anything else is skipped. Never throws.
function userTexts(messages) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (const m of messages) {
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') { out.push(m.content); continue; }
    if (Array.isArray(m.content)) {
      for (const p of m.content) if (p && (p.type === 'text' || p.text) && typeof p.text === 'string') out.push(p.text);
    }
  }
  return out;
}

// messages: OpenClaw event.messages (unknown[]). opts.src: provenance tag for meta.src.
// Returns [{ text, meta }] deduped (case-insensitive, ignoring terminal punctuation) within this batch —
// Lichen's /learn dedups across time.
function extractFacts(messages, { src = 'openclaw', confidence = 'observed' } = {}) {
  const seen = new Set();
  const facts = [];
  const push = (raw, kind) => {
    const text = cleanFact(raw);
    if (!text) return;
    const key = text.replace(/[.!?]+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    facts.push({ text, meta: { src, confidence, capture: kind } });
  };
  for (const text of userTexts(messages)) {
    for (const sentence of String(text).split(/\n+|(?<=[.!?])\s+/)) {
      const s = sentence.trim();
      if (!s) continue;
      const ex = EXPLICIT_RE.exec(s);
      if (ex) { push(ex[1], 'explicit'); continue; } // explicit intent wins; don't double-capture as 'stated'
      const st = STATED_RE.exec(s);
      if (st) push(st[1], 'stated');
    }
  }
  return facts;
}

module.exports = { extractFacts, userTexts };
