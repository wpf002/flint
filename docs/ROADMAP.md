# MAX FLINT — roadmap & status

Target: the maximum achievable subset of a Jarvis-style assistant — an
extraordinary interface that runs your digital world. Build the **action stack**
(Phases 0–3) first and finish it; 4–6 are additive. Physical actuation and AGI
are the wall — not budgeted.

## Status at a glance

| Phase | What | Status |
| --- | --- | --- |
| **0** | Flint core (provider-agnostic model layer) | ✅ **done** — `@flint/core`, contract suite green, adapters (Anthropic + Ollama), consumers |
| **1** | Tool / actuation layer (MCP) | ✅ **DoD met** — `@flint/mcp` + 3 live app connectors (Prophet, Meridian, **Vantage**), cross-app fusion, and a real **gated write** (Vantage watchlist: approved → executes, denied → blocked, verified against Postgres). Read 3+ apps + one safe write, done |
| **2** | Orchestration (multi-step + checkpoints) | ✅ **done** — multi-step tool loop, idempotency-gated retry, approver checkpoint, and a full **auditable action log** (`ActionLogObserver`; `ask log`; server `/actions`). Verified: a multi-app task with a clean audited trace |
| **3** | Memory / context | ◐ strong — durable `FileMemoryStore` + `LessonStore`, and **semantic retrieval** (`SemanticRetriever` + local `OllamaEmbedder`, meaning-based) verified live. Remaining: the durable pgvector backend (same `Retriever` interface; parked with Railway) |
| **4** | Voice / presence | ✅ built (local) — `ask voice`: whisper.cpp STT + macOS `say` TTS + `sox` mic capture. Full STT→Flint→TTS chain verified end to end (via a generated clip); live mic loop ready for the user to test. All local, no cloud |
| **5** | Proactive | ✅ deterministic cases done — nightly reflection (03:00), morning brief (07:00), and a **watch-trigger framework** (`ask watch`, `~/.flint/triggers.json`): code-evaluated threshold alerts over live tool data, no LLM in the firing decision. Open-ended "notice what I didn't ask" stays out of scope (honest ceiling) |
| **6** | Computer-use (gated) | ◐ mechanism built — `computer-use-server.ts`: screenshot + cursor read (safe), move/click/type/key (GATED — denied without approval, verified). Opt-in only. Live use needs USER: Screen Recording + Accessibility permissions, a vision model for autonomy, and per-action approval. Supervised by design |

Bonus, off the original spec: `@flint/persona` (voice identity) and
self-evolution (`reflect` + `consolidate`) — overlap Phases 3 and 5.

## The phases

**Phase 1 — Tool / actuation (highest leverage).** Adopt MCP as the uniform
tool standard. Each app becomes an MCP server exposing typed tools; a registry
Flint reads to know what it can do. Read-only tools wire freely; side-effecting
tools (deploy/write/trade/delete) are **checkpointed** — Flint proposes, you
confirm, until trust is earned per-tool.
*DoD:* Flint reads live state from 3+ apps and performs one safe write end to end.
*Built:* `@flint/mcp` — `McpRegistry.connect(specs, { approver })` → `registry.tools()`.
*Next:* a real MCP server per app (Crossbar / Prophet / Vantage / Sentinel / Trident).

**Phase 2 — Orchestration.** model→tool→model loop with planning over the tool
set; checkpoints on irreversible steps; per-step retries honoring idempotency.
*Honest ceiling:* full hands-off autonomy on consequential actions breaks (error
compounds) — autonomous on reversible steps, human-in-loop on irreversible ones.
*DoD:* a real 5+ step task across apps, pausing only at irreversible steps, fully logged.

**Phase 3 — Memory / context.** The real persistence behind core's memory
interface; retrieval over your data, conversations, project state, preferences.
Postgres + pgvector; embeddings behind a Flint-style interface. Crown-jewel data
— encrypt at rest, scope access.
*DoD:* recalls and uses prior-session + project context without re-statement.

**Phase 4 — Voice / presence.** Real-time STT → Flint → TTS, barge-in, wake-word.
Largely integration, not research. Can be pulled earlier; it front-ends 1–3.
*DoD:* spoken command executes a Phase 1/2 action and speaks back.

**Phase 5 — Proactive.** Scheduler + event bus + watchers; "watch X, when Y, do
Z"; morning brief; threshold alerts on app signals.
*Honest ceiling:* predefined triggers solvable now; open-ended "notice what I
didn't ask" is not — it invents false alarms. Ship deterministic cases; treat
genuine proactivity as low-authority (suggests, never acts unsupervised).
*DoD:* a useful unprompted action from a real event, low false-positive rate.

**Phase 6 — Computer-use (gated).** Drive no-API apps via the screen. Error-prone;
sandboxed, supervised, never destructive unattended. Last layer, by need only.
*DoD:* one bounded task in a no-API app under supervision.

## Cross-cutting rails

- **Security:** tool access to deploy/trade/delete/read-logs is a real attack
  surface. Least-privilege per tool; irreversible actions checkpointed; memory
  store is crown-jewel data. Threat-model as you build.
- **Auditability:** every tool call and autonomous action logged with lineage.
  No LLM in the outcome path for consequential actions without a human gate.
- **Finish it:** depth play. Don't start Phase N+1 before Phase N hits its DoD.

## The wall (fiction — do not budget)

Real-time physical actuation, inventing novel physics on command, genuine
autonomous agency / a mind. Jarvis is a character; you build an interface. The
ceiling here is the field, not the stack.

## Build order

0 → 1 → 2 → 3 (finish in order) → 4 (voice; pull earlier if hands-free matters
more) → 5 (deterministic first) → 6 (only if a real no-API need justifies it).
