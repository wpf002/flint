# App audit — Flint integration map

Full classification of all ~28 repos (Q6). Feeds Roadmap v2 Phase 8 (integration)
and Phase 9 (the Legion). Already wired in v1: **Prophet, Meridian, Vantage**.

Legend: **BOT** = autonomous agent for the Legion · **TOOL** = Flint queries/operates ·
**DATA** = read-only source · **NOISE/DEFER** = stub/empty/low-value.

## The Legion (Q8) — bots Flint commands (read-only status; financial = human-gated)
| Repo | What | Data | Financial? | Notes |
|---|---|---|---|---|
| **hive** | Distributed bot platform — 8 worker pools incl CCXT **live trading**, scrapers, browsers, AI agents | Postgres+Redis | **YES** (live-gated) | Read-only observer: bot_list, job_status, trading_audit. NEVER execute live trades via Flint — Hive owns the gate |
| **bloomberg** | Self-hosted terminal + Alpaca trading bots (paper default, live gated) | TimescaleDB+Redis | **YES** (live-gated) | Market data + bot status/P&L; no trading by Flint |
| **crossbar** | Prediction-market exchange + 6 trading bots; Flint already named "AI manager" | Postgres+Redis | play-money v1 | bot status + market summary; order placement stays human-gated |

## Intelligence tools — high value, mostly safe reads
| Repo | What | Data | Priority |
|---|---|---|---|
| **bellwether** | Market-intelligence worker scraping 24/7 w/ provenance | Postgres+Redis (**:5432 up**) | HIGH — autonomous signal stream |
| **vigil** | SIEM-agnostic security ops + attack-state AI engine | Postgres+ES+Kafka | HIGH — security analyst (day-job) |
| **project_hype** | FX hype/catalyst dashboard, 40 exotic currencies | Postgres | HIGH — live market signals |
| **syntrackr** | Tax-loss harvesting + wash-sale detection (Alpaca) | Postgres | HIGH — tax planning (read-only) |
| **tdl** | 700 ATT&CK-mapped SIEM detection rules | **flat YAML/JSON (zero-infra)** | MED — security runbooks, easy wire |

## Multi-model brain (Q9)
| Repo | What | Data | Notes |
|---|---|---|---|
| **trident** | Multi-AI orchestration (Claude/GPT/Perplexity), MCP, scheduled chains | SQLite | MED — wrap as Flint's escalation tool. ⚠ **Security debt** (no auth, prompt-injection, plaintext Google tokens) → local MCP client only, **harden before exposing** (ties to Phase 12) |

## Personal / domain tools — medium
| Repo | What | Data | Priority |
|---|---|---|---|
| **inkling** | Big Five personality scoring | SQLite/PG | MED — *personalization data for Flint itself* |
| **brefach_studio** | Personal CMS (tasks/calendar/revenue) | Postgres (**:5435 up**) | MED — daily brief (read-only) |
| **knit** | Social closet rental + trust graph | Postgres | MED — niche/personal |
| **idip** | ID/age-verification compliance engine | Postgres (Railway) | MED — audit/alerting |
| **gate_smart** | Horse-racing betting intelligence (Racing API) | Redis cache | MED — daily reads |
| **ice_sight** | NHL scouting reports (NHL API) | localStorage | MED — sports brief |
| **furlong** | Racehorse valuation (LightGBM) | Postgres+Redis | MED — domain, licensed data |
| **tracksense** | HISA racing compliance | Postgres | MED — slow-moving data |
| **fray** | Deterministic combat sim oracle | Postgres | MED — demo value |
| **bhis** | Church discipleship diagnostics | Postgres | LOW-MED — DATA |

## Defer / noise
asclepius (static anatomy), fauna (Phase-0 static), brain_buffet (Firebase, low),
hym (offline game — none), physica (sim, no state), strata (frontend stub, no backend).

---

## Recommended first wave (Phase 8 / 9)
The "Jarvis with a Legion" shape, prioritized by leverage + safety + data-already-live:

1. **bellwether** — market-intel stream (DB already on :5432). Pure-read, high signal.
2. **The Legion status layer** — hive + bloomberg + crossbar **read-only** (status/P&L/audit). This is the "Iron Legion" command view; financial actions stay human-gated.
3. **vigil** — security analyst (your day-job edge).
4. **trident** — multi-model escalation (Q9) — but **harden first** (Phase 12 dependency).
5. **project_hype** + **syntrackr** — FX + tax signals.

Pattern: reuse the Vantage connector approach (pg over the app's live Postgres,
read-only tools safe, any write non-readonly → gated). Several app DBs are
already running in Docker (bellwether :5432, vantage :5434, brefach :5435).

**Hard rule across the Legion:** Flint observes and reports; it never places a
trade or moves money. Financial execution is always human-gated, never
policy-auto-approved.
