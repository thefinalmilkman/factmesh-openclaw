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

OpenClaw 2026.7+ requires two packaging files, both shipped here: `openclaw.extensions` in `package.json`
(pointing at `./index.js`) and the `openclaw.plugin.json` manifest in the plugin root. Because the manifest
declares `kind: "memory"`, the installer switches `plugins.slots.memory` to `factmesh` for you.

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
        },
        "hooks": {
          "allowPromptInjection": true,
          "allowConversationAccess": true
        }
      }
    },
    "slots": { "memory": "factmesh" }
  }
}
```

The `hooks` opt-ins are **required** for non-bundled plugins in 2026.7+: `allowPromptInjection` lets the
recall hook mutate the prompt, `allowConversationAccess` lets `agent_end` read user messages for capture.
Without them the hooks are blocked (warn-level diagnostics). `plugins.slots.memory` makes factmesh the
exclusive memory backend (verified real in 2026.7.1-2). To downweight memories via chat, allowlist the
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
index.js            plugin definition: hooks (typed api.on), tools, CLI, config schema
openclaw.plugin.json  native plugin manifest (id, inline configSchema, kind: "memory", contracts.tools)
lib/client.js       zero-dep Lichen HTTP client (fetch + hard timeout)
lib/extract.js      deterministic user-fact extraction (patterns only, no LLM)
lib/budget.js       chars/4 token estimation + greedy budget fitting
test/run.js         npm test — 22 tests (see "Tested" below)
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

**Tested against a real OpenClaw 2026.7.1-2 gateway** (2026-08-13, scratch Lichen on 127.0.0.1:4199, Ollama
phi4-mini, no channels):

- Install from a local path: requires `openclaw.extensions` in package.json **and** `openclaw.plugin.json`
  in the plugin root (manifest with `id` + inline `configSchema`; `kind: "memory"` makes the installer switch
  `plugins.slots.memory` to factmesh automatically — the slot key is real in this version).
- All 3 tools register and are served to the model **without TypeBox** — but the schema field must be named
  `parameters` (plain JSON Schema object), `execute` is called as `(toolCallId, params)`, and results must be
  `{ content: [{ type: "text", text }], details? }`. The pre-2026.7 shape (`input`, single-arg execute,
  `{ result, details }`) is rejected: "plugin tool is malformed: missing parameters object".
- Hooks must use the **typed** API `api.on(event, handler)` — the legacy `api.registerHook` feeds the
  internal-hook system the agent harness never consults (hooks "register" but never fire). `api.registerHook`
  is kept as a fallback for older hosts.
- Non-bundled plugins need explicit hook opt-ins in the entry config:
  `"hooks": { "allowPromptInjection": true, "allowConversationAccess": true }` (recall injection is a
  prompt-mutating hook; `agent_end` reads conversation content).
- Verified live: recall injection into the prompt (`LICHEN MEMORY` block, +203 prompt chars, model used the
  fact), write-through capture on `agent_end` ("remember: ..." → `/learn`, `src: openclaw:agent_end`),
  assistant text never captured, `openclaw factmesh status` / `openclaw factmesh search <q>` both work.
- CLI registration requires explicit command metadata: `api.registerCli(registrar, { descriptors: [...] })`.

**Not tested:**

- Model-driven tool calls end-to-end — phi4-mini 3.8b emitted tool-call JSON as plain text instead of a
  structured invocation ("Assistant reply looks like a tool call, but no structured tool invocation was
  emitted"). The tool definitions reach the model (it quoted `memory_add` + `parameters` unprompted); whether
  a tool-capable model completes the call is unverified.
- `before_compaction` firing (no compaction occurred during the test); `memory_forget` end-to-end (optional
  tool, not allowlisted in the test).

## Notes

- Requires Lichen ≥ the 2026-08-13 `/recall` route (restart Lichen after pulling it). On older Lichen the
  recall hook and `memory_search` fail silent / return a structured error; capture and `memory_forget` still work.
- Package name is unscoped `openclaw-factmesh` (scoped `@factmesh/…` would require owning the npm org;
  OpenClaw's own docs use the unscoped `openclaw-plugin-*` convention). `private: true` until publish.
- Plain CommonJS JavaScript, **zero runtime dependencies**. Node ≥ 18 (OpenClaw itself requires 22).
