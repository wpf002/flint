# Flint — Roadmap v2 ("Jarvis")

v1 built the **action stack** (Phases 0–6): a local, voice-capable, self-evolving
personal AI that reads/operates apps with an auditable safety gate, runs proactive
jobs, and does bounded overnight autonomy — all on your machine, no cloud
dependency. This is the substrate. v2 turns the substrate into **your Jarvis**:
always-on, broadly integrated, stronger-brained, secured, and present.

> Frame (unchanged): you build an extraordinary **interface and operator**, not a
> mind. Physical actuation and AGI are the wall. Everything below is integration,
> a machine, and a security workstream — no research breakthrough required.

Derived directly from your 17 questions; the `(Q#)` tags map each phase back.

---

## v1 baseline — DONE (Phases 0–6)

Core (provider-agnostic) · MCP tools + 3 live apps + gated write · orchestration +
audit log · semantic memory · voice (live mic) · proactive (reflect / brief /
triggers) · gated computer-use · **policy-gated overnight autonomy**. 96 tests,
local, no cloud.

## The 5 throughlines of v2
1. **Home base** — a dedicated always-on machine (model + service, yours).
2. **Breadth** — wire everything: apps, the bot legion, the web, Trident.
3. **A stronger brain + escalation** — bigger model; escalate hard calls.
4. **A secured gateway** — the safe door to the outside world.
5. **Presence** — real-time voice + a black-and-gold console.

---

## Cross-cutting: Flint ⇄ Cowork (Claude) (Q1, Q10)
Claude is the **workshop**, Flint is the **resident**. Claude builds/maintains
Flint and handles the hardest one-off reasoning; Flint runs the recurring,
personal, autonomous operations. They bridge over MCP: Cowork's Claude can drive
Flint; Flint **escalates** hard problems up to Claude/Trident and distills the
answers into lessons. No task is done by both. Flint runs independently at
runtime; the Claude dependency is development + optional escalation, both
removable.

---

## Phase 7 — Home base: hosting & independence (Q2, Q10)
**Goal:** Flint always-on, reachable from anywhere, fully yours.
**Build:** stand up a dedicated machine — **recommended: a Mac mini you own**
(model + service co-located, no cloud bill, no GPU-rental). Alternatives: Fly.io
(GPU machines, cloud) or a rented GPU + Railway/Fly for the service. Deploy the
hosted Flint service (built in v1) + durable Postgres/pgvector memory; keep
Ollama serving the model on the same box.
**DoD:** Flint answers from your phone with your Mac asleep-proof box on; survives
reboot; memory persists in Postgres; zero cloud model dependency.
**Gate/risk:** the box becomes single-point-of-trust → disk encryption, backups.
**Unblocks:** you (buy/dedicate the machine); me (deploy + configure).

## Phase 8 — Full integration sweep (Q6, Q3)
**Goal:** Flint operates and reads your whole world; apps call Flint as their AI.
**Build:** run the **full app audit** (all ~28 repos → tool / data-source / bot /
noise), then wire the keepers as MCP connectors (read-only first, gated writes
second). Flip ≥1 app from a direct Anthropic key to Flint's endpoint.
**DoD:** Flint reads live state from N apps and ≥1 app uses Flint as its AI
backend, with the gate on every write.
**Gate/risk:** breadth = attack surface; least-privilege per connector.
**Unblocks:** me (audit + connectors); you (DB creds / which apps).

## Phase 9 — The Legion: fleet command (Q8)
**Goal:** Flint as commander of your bots (Hive / Bloomberg / Crossbar) — his
"Iron Legion."
**Build:** wrap each bot as an MCP server (status / params / start / stop /
results); Flint monitors, coordinates, and strategizes across the fleet.
**DoD:** Flint reports fleet status and issues one **non-financial** command end
to end.
**Gate/risk:** HARD line — anything that places money or trades is human-gated,
never policy-auto-approved. Financial autonomy stays off.
**Unblocks:** me (wrappers); you (which bots, their interfaces).

## Phase 10 — Multi-model brain & escalation (Q9, Q5, Q12)
**Goal:** Flint reaches GPT/Perplexity/Claude for hard reasoning without rebuilding it.
**Build:** wrap **Trident** as one Flint tool (reuse, no duplication); Flint
escalates hard/ambiguous problems to the multi-model panel and folds the result
back. Optionally pull a bigger local model (qwen2.5:32b on a real GPU) for a
stronger default.
**DoD:** Flint detects a hard query, routes it to Trident, and uses the panel's
answer.
**Unblocks:** me (Trident connector + escalation logic).

## Phase 11 — The open world: web & datasets (Q7, Q11)
**Goal:** Flint pulls live information like ChatGPT/Perplexity do.
**Build:** a web tool stack — **search** (Brave/Tavily/SerpAPI) + **fetch/scrape**
+ optional headless **browse**; ingest public datasets into the vector store;
a search→rerank→synthesize pipeline run on Flint's model.
**DoD:** Flint answers a current-events question with cited live web data.
**Gate/risk:** reads are safe (ungated); sanitize fetched content (prompt-injection
defense — treat web content as untrusted).
**Unblocks:** me (tools); you (one search-API key).

## Phase 12 — Secured gateway (Q16)
**Goal:** a hardened door between Flint and the outside world / your bots.
**Build:** TLS, strong auth (rotate the bearer / mTLS), secrets management, scoped
per-client permissions, rate limiting, structured audit, network policy. Threat-
model it (your offensive-security edge).
**DoD:** all external access flows only through the gateway; a documented threat
model; the memory store treated as crown-jewel data (encrypted, scoped).
**Unblocks:** me (build); you (review/red-team).

## Phase 13 — Presence: real-time voice (Q14, Q13)
**Goal:** fluid spoken conversation, not turn-by-turn.
**Build:** streaming STT + low-latency TTS, **barge-in** (interrupt and it stops),
wake-word / push-to-talk. Upgrade the v1 voice loop to real-time.
**DoD:** a sub-2s, interruptible spoken conversation that executes actions and
speaks back.
**Unblocks:** me (build); you (mic test).

## Phase 14 — The Console: black & gold (Q15)
**Goal:** a control surface with the Jarvis aesthetic — the Age-of-Ultron "brain."
**Build:** a web console on the hosted service: black-and-gold theme, live
conversation, the action log, the legion view, and an animated "thinking brain"
visualization. I'll mock the look first for sign-off, then build.
**DoD:** a usable console showing Flint's live state + the brain viz.
**Unblocks:** me (build); you (taste/approval).

## Phase 15 — Deeper autonomy & self-learning (Q5, Q12)
**Goal:** Flint that meaningfully improves itself and handles richer overnight work.
**Build:** expand the policy engine (constraints, budgets, time-windows); multi-
step overnight tasks with a richer morning review queue; **periodic LoRA
fine-tuning** on your data + distilled Claude answers; lesson curation at scale;
honest eval to prove gains.
**DoD:** a measured quality gain from fine-tuning vs. the base model; a real
multi-step overnight task completed within policy.
**Gate/risk:** fine-tuning can degrade general reasoning — prove the voice gain
with numbers before adopting (the original Phase-3 bar).
**Unblocks:** me (build); you (GPU for fine-tune, your data).

## Phase 16 — Sandboxed computer-use (Q17)
**Goal:** the *more*-responsible way to let Flint drive no-API apps unattended.
**Build:** a **sandbox** — dedicated VM / separate user / isolated display (never
your main desktop); a **vision model** so it can see; tight app/region whitelist
via the policy; **screenshot recording of every action**; bound scope + timeouts
+ kill-switch.
**DoD:** one bounded task completed in the sandbox under full recording.
**Gate/risk:** HIGHEST. Experimental/low-trust even sandboxed. Never on your real
machine unattended. Last phase, by need only.
**Unblocks:** me (build); you (a VM + accept the risk posture).

---

## Honest ceilings (restated, do not budget against)
- **Open-ended autonomy** on consequential/irreversible actions — error compounds;
  we do reversible/whitelisted only, human-gated otherwise.
- **"Truly smart"** — capped by the model; maximize tools/memory/retrieval; raw
  intelligence is the model lever (bigger model / escalation), not a breakthrough.
- **Financial autonomy** — off. Trades and money movement are always human-gated.
- **Unattended computer-use on your real desktop** — no. Sandbox only.
- **A mind / AGI** — not on the table for anyone. Flint is an interface + operator.

## Recommended build order
Foundation first: **8 (audit) → 7 (home base) → 12 (security) → 10/11 (brain +
web)** give the biggest leverage. Then **9 (legion)** and **13/14 (presence +
console)** for the Jarvis feel. **15 (deeper autonomy)** continuously. **16
(sandboxed computer-use)** only when a real no-API need justifies it.

The first concrete step is the **full app audit (Phase 8)** — it tells us what to
wire, which bots join the legion, and what's noise. Everything else aims better
once we have that map.
