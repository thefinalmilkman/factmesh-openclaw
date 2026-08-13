'use strict';
// factmesh's Lichen HTTP client. Zero-dependency: global fetch (Node >= 18, OpenClaw needs 22) with a hard
// timeout on every call, so a hung Lichen can never stall an OpenClaw turn. Lichen binds 127.0.0.1 ONLY
// (the mesh holds personal knowledge), so this client never leaves the machine by design.
// Every function throws on transport error or non-2xx; callers decide whether that is fatal (tools) or a
// silent skip (prompt-recall hook — a down memory backend must never break a prompt).

function makeClient({ lichenUrl = 'http://127.0.0.1:4174', timeoutMs = 4000 } = {}) {
  const base = String(lichenUrl).replace(/\/+$/, '');

  async function req(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: body != null ? { 'content-type': 'application/json' } : undefined,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    // GET /health -> { ok, version, facts, edges, attention }
    health: () => req('GET', '/health'),
    // POST /recall { query, k? } -> { ok, facts: [{id,text,confidence,stability,availability,uses,born,lastUsed,src}], coverage, latencyMs }
    // retrieval-only on the Lichen side: no LLM is involved, works with Ollama down (lexical-embed fallback).
    recall: (query, k) => req('POST', '/recall', k ? { query, k } : { query }),
    // POST /learn { facts: [{text, meta}] } — dedup-triaged on the Lichen side (exact dup reinforces,
    // near-dup may supersede on a contradiction signal). Returns { ok, added, total }.
    learn: (facts) => req('POST', '/learn', { facts }),
    learnText: (text, meta) => req('POST', '/learn', { text, meta }),
    // POST /outcome { factId|text, good } — Hippo-Memory R-STDP reward: bends decay, never deletes.
    outcome: (opts) => req('POST', '/outcome', opts),
  };
}

module.exports = { makeClient };
