# Flint independence roadmap

The goal: Flint as capable as a frontier model on any query, **with no runtime
dependency on anyone**. Today Flint is local-first and escalates only the
genuinely-hard reasoning/coding queries to Claude (the "frontier brain"). That
escalation is a **bridge**, not a destination — built behind one swappable seam
so it can be repointed at a local model, or switched off entirely, the day the
local side is good enough.

## The seam (already in code)

`buildFrontierProvider()` in `apps/server/src/index.ts` picks the escalation
brain from env:

| Env | Effect |
|-----|--------|
| `ANTHROPIC_API_KEY` (in `~/.flint/secrets.env`) | Escalate to Claude (default `claude-sonnet-4-6`; set `FLINT_FRONTIER_MODEL=claude-opus-4-8` for max). |
| `FLINT_FRONTIER_PROVIDER=ollama` + `FLINT_FRONTIER_BASE_URL` + `FLINT_FRONTIER_MODEL` | Escalate to a **self-hosted big model** (e.g. a 70B on a home box). Fully independent. |
| none | Pure local — frontier off. The header "Local only" toggle forces this per-session too. |

Switching from Claude to a local 70B is therefore a **config change, not a
rewrite**. Everything else — the difficulty judge, the shared memory + tools,
the streaming, the badge — stays identical.

## The milestone

A local model that meaningfully closes the gap on hard reasoning/coding is in
the **32B–70B** class, which needs roughly **48–64 GB** of (V)RAM:

- **Mac Studio / Mac mini, 64 GB unified** — ~$1,500–2,000. Quietest, simplest;
  runs a 70B (quantized) or a fast 32B via Ollama. Recommended path.
- **Single/dual used GPU box (2× 24 GB)** — similar cost, more speed, but power,
  heat, noise, and maintenance.

Even then it won't fully equal the current frontier and will be slower per
token — but for *Will's* mix of queries (everyday + web-grounded + the
occasional hard one) it crosses "good enough to drop the bridge."

### Steps to flip independence on, when the hardware lands

1. `ollama pull` the target model (e.g. a 70B) on the box.
2. In `~/.flint/secrets.env`: set `FLINT_FRONTIER_PROVIDER=ollama`,
   `FLINT_FRONTIER_BASE_URL=http://<box>:11434`, `FLINT_FRONTIER_MODEL=<model>`,
   and remove `ANTHROPIC_API_KEY`.
3. `./apps/server/install-server.sh` to reload.
4. Log shows `[brain] frontier escalation ENABLED -> ollama:<model>`. Done —
   no code touched, nothing leaves the network.

Until then, the bridge gives frontier-grade answers now, at pennies, with the
local brain handling everything private and everyday.
