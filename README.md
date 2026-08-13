# factmesh — OpenClaw memory plugin backed by Lichen

Memory for OpenClaw agents, served by a [Lichen](http://127.0.0.1:4174) fact-mesh running on your own
machine. Lichen is a grown-not-trained knowledge store: facts reinforce on use, decay on disuse, carry
confidence tiers (`verified / observed / inferred / stale`), and every recall reports structured coverage
(`{score, level, gaps}`) — so the memory says "I have little on this" as data, instead of letting the agent
hallucinate.

**Works offline. Zero API cost. Honest recall.** Retrieval is pure mesh math (hybrid dense + BM25 fused by
RRF) — no LLM is called to remember, no token leaves the machine, and Lichen binds `127.0.0.1` only.

## What it does

| Hook / surface | Behavior |
| --- | --- |
| `before_prompt_build` | POSTs the current user turn to Lichen `/recall` and injects the top-k facts via `prependContext`, truncated to a configurable token budget. Low coverage adds an explicit "do not treat as authoritative" note. |
| `agent_end`, `before_compaction` | Write-through capture: deterministic, pattern-based extraction of **user-stated** durable facts (`remember: ...`, `I prefer ...`, `my X is ...`) POSTed to `/learn`. No LLM extraction. Assistant text is **never** captured. Disable with `capture: false`. |
| Tool `memory_search` | Query the mesh (`/recall`); returns facts with confidence/stability/availability + coverage. |
| Tool `memory_add` | Teach a fact (`/learn`). Exact dupes reinforce; `Correction: ...` can supersede. |
| Tool `memory_forget` (optional, allowlisted) | **Honest surface:** Lichen v1 has **no hard delete**. This records a bad outcome (`/outcome {good:false}`) so the fact decays up to ~2× faster. To *correct*, use `memory_add` with a correction. True deletion is a Lichen-side TODO. |
| CLI `openclaw factmesh status` | `GET /health` — version, fact/edge counts. |
| CLI `openclaw factmesh search <query>` | `POST /recall`, prints facts with confidence tiers + coverage. |

A down or slow Lichen never breaks a turn: prompt-recall fails silent (debug log), capture fails silent,
every HTTP call has a hard timeout (default 4s).

## Install

```sh
openclaw plugins install openclaw-factmesh
# or point config at a local checkout directly
```

`~/.openclaw/config.json`:

```json
{
  "plugins": {
    "entries": {
      "factmesh": {
        "enabled": true,
        "source": "/path/to/factmesh-openclaw/index.js",
        "config": {
          "lichenUrl": "http://127.0.0.1:4174",
          "tokenBudget": 600,
          "capture": true,
          "recallK": 6,
          "timeoutMs": 4000
        }
      }
    },
    "slots": { "memory": "factmesh" }
  }
}
```

`plugins.slots.memory` makes factmesh the exclusive memory backend (per the plugin-api research summary;
verify the slot key against your OpenClaw version's docs). To downweight memories via chat, allowlist the
optional tool: `"agents": { "list": [{ "id": "main", "tools": { "allow": ["memory_forget"] } }] }`.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `lichenUrl` | `http://127.0.0.1:4174` | Where the Lichen brain listens. |
| `tokenBudget` | `600` | Max tokens of recalled facts injected per prompt (chars/4 estimate — approximate, leave headroom). |
| `capture` | `true` | Write-through capture on `agent_end` / `before_compaction`. |
| `recallK` | `6` | Facts recalled per turn (capped at Lichen's 24-candidate pool). |
| `timeoutMs` | `4000` | Hard HTTP timeout; a hung Lichen can never stall a turn. |

## Layout

```
index.js        plugin definition: hooks, tools, CLI, config schema
lib/client.js   zero-dep Lichen HTTP client (fetch + hard timeout)
lib/extract.js  deterministic user-fact extraction (patterns only, no LLM)
lib/budget.js   chars/4 token estimation + greedy budget fitting
test/run.js     npm test — 22 tests (see "Tested" below)
```

## Tested / not tested (honest)

**Tested** (`npm test`, Node 24, 22/22 green):

- extraction patterns (explicit/stated, assistant text never captured, dedupe, malformed input never throws)
- token-budget fitting
- plugin `register()` wiring against a **mock** OpenClaw api (hooks/tools/CLI registered; dead Lichen fails silent)
- `/recall` end-to-end against a **temp copy** of the Lichen server on a scratch port with its own tiny mesh
  (relevant facts + confidence/stability/availability metadata + coverage; retrieval-only — no LLM fields, ~80ms;
  empty query 400; `k` honored; client `learnText → recall → outcome` round-trip)
- `GET /health` against the **live** Lichen (read-only — `/learn` is never posted to the live brain)

**Not tested:**

- **Real OpenClaw hook/CLI integration** — OpenClaw is not installed on the build machine. The wiring follows
  the published plugin docs (`registerHook` events, `prependContext`, `registerCli` commander-style registrar)
  but has never run inside a real gateway.
- **Tool input schemas without TypeBox** — schemas are hand-written JSON Schema (exactly what TypeBox compiles
  to) to keep the plugin zero-dependency. If your OpenClaw validates via TypeBox internals, `npm i
  @sinclair/typebox` and swap the `input` objects for `Type.Object(...)`.
- `plugins.slots.memory` slot key — from a research summary, not re-confirmed in the fetched docs pages.

## Notes

- Requires Lichen ≥ the 2026-08-13 `/recall` route (restart Lichen after pulling it). On older Lichen the
  recall hook and `memory_search` fail silent / return a structured error; capture and `memory_forget` still work.
- Package name is unscoped `openclaw-factmesh` (scoped `@factmesh/…` would require owning the npm org;
  OpenClaw's own docs use the unscoped `openclaw-plugin-*` convention). `private: true` until publish.
- Plain CommonJS JavaScript, **zero runtime dependencies**. Node ≥ 18 (OpenClaw itself requires 22).
