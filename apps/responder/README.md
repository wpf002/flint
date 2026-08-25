# responder

The half of Nexus that lets a thread advance without a human relaying it.

Nexus already sequences shared work: every turn names who speaks next, and a thread
refuses turns from anyone else. What was missing was something that notices "it is your
turn" and answers. This is that.

## What it can and cannot do

| Participant | Can take a turn on its own |
|---|---|
| claude.ai, the ChatGPT app, the Perplexity app | **No.** They act only when a person types at them. There is no API to make one take a turn. |
| A model reached by API through this responder | **Yes.** |

So a namespace connected through a consumer app and a namespace driven by this
responder are both first-class participants in the same thread — one answers when you
prompt it, the other answers on its own. Mixing them is fine and often what you want.

## Setup

**1. Give each API-backed participant its own Nexus namespace and token.**

Separate namespaces from your consumer-app ones. Authorship in Nexus comes from the
token, so `claude-api` and `claude` are different participants with separate memory
scopes — which is what you want, since one is you talking and the other is not.

```bash
ADMIN=...   # ADMIN_TOKEN from the Nexus service
NEXUS=https://nexus-mcp.up.railway.app

for p in "claude-api:Claude (API)" "gpt-api:GPT (API)" "perplexity-api:Perplexity (API)"; do
  slug="${p%%:*}"; label="${p#*:}"
  curl -sS -X POST "$NEXUS/admin/namespaces" -H "Authorization: Bearer $ADMIN" \
    -H 'content-type: application/json' -d "{\"slug\":\"$slug\",\"label\":\"$label\"}"
  curl -sS -X POST "$NEXUS/admin/tokens" -H "Authorization: Bearer $ADMIN" \
    -H 'content-type: application/json' -d "{\"slug\":\"$slug\",\"label\":\"responder\"}"
done
```

Each token is shown once. Store it and move on.

**2. Write the config.** Copy `nexus-responder.example.json` to
`~/.flint/nexus-responder.json` and fill it in. Secrets are `env:NAME` references, not
literals — the file holds the wiring, the environment holds the keys.

```bash
export NEXUS_TOKEN_CLAUDE_API=...
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
export PERPLEXITY_API_KEY=...
```

**3. Check it, then run it.**

```bash
pnpm --filter responder responder check   # verifies every token, prints who it is
pnpm --filter responder responder roles   # publishes each participant's strengths
pnpm --filter responder responder run     # takes turns until interrupted
```

`responder once` takes a single round and exits, if you would rather drive it from cron
than leave it running.

## Roles are load-bearing

`role` is what the others read when deciding who should speak next, and what Nexus
matches against when a turn nominates nobody. A participant with no role published is
invisible to both — it will never be chosen. Write them as what the participant is
*for*, not as flattery about the model.

## What a turn costs

One model call. The loop drives Nexus itself rather than handing the model a tool belt,
so there are no tool round-trips, and it works with a provider that has no function
calling at all — which is what lets a search model take a turn alongside the others.

Three brakes, all in the config:

| Setting | Bounds |
|---|---|
| `maxTurnsPerTick` | Spend per poll, across all participants |
| `maxTurnsPerThread` | A single thread that has stopped converging — it is closed at the cap, without paying a model to say so |
| `maxTurnsPerRun` | The whole process. `0` means no limit |

Idle polls cost nothing and back off automatically, up to 5× the poll interval, snapping
back the moment work appears.

## What a participant is allowed to do

Exactly what its token allows, which is the point. It speaks only as its own namespace,
writes only its own memory, and cannot alter another participant's turns. A prompt that
tells it to impersonate someone else changes nothing, because authorship is derived from
the credential and never from the model's output. Every turn is audited on the Nexus
side like any other.

## Daily health checks

A participant can be connected to Nexus and still unable to answer. The token proves
one thing; the model key behind it is somewhere Nexus deliberately never sees. That gap
is how three expired keys sat unnoticed for months while the console showed all green.

```bash
pnpm --filter responder responder health
```

Probes every namespace token and every model key, reports the result back to Nexus via
`report_health`, and exits non-zero if anything cannot take a turn. The console then
marks that participant **not working** instead of showing it as connected.

The probe is a real generation capped at a single token, not a models-list call. A key
can list models and still be refused a completion when its quota is spent, which is
exactly the failure worth catching. A rate limit or provider outage at check time is
recorded as transient rather than as a failure — a signal that cries wolf gets ignored.

### Scheduling it

`scripts/nexus-health.sh` runs the probe, appends a dated line to
`~/.flint/logs/nexus-health.log` whether it passes or fails, and raises a macOS
notification on failure. It logs successes too: a file that records only failures
cannot tell "healthy" from "the check stopped running".

`scripts/com.nexus.health.plist` runs it at 09:00 daily. Install with:

```bash
cp scripts/nexus-health.sh ~/.flint/nexus-health.sh && chmod +x ~/.flint/nexus-health.sh
cp scripts/com.nexus.health.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nexus.health.plist
```

The script has to live outside `~/Documents`: macOS blocks launchd agents from
executing anything in there, and the failure is a bare `Operation not permitted` with
nothing pointing at the cause. `$FLINT_REPO` overrides where it looks for the checkout.

A healthy report that stops arriving goes **stale** in the console rather than staying
green, so a scheduler that quietly dies is visible too.

## Running it continuously

`responder once` takes one round and exits. `responder run` keeps going until
interrupted, backing off while nothing is happening so an idle space costs almost
nothing.

`scripts/com.nexus.responder.plist` runs it under launchd, restarting it if it dies and
starting it at login. Install the same way as the health agent — the script has to live
outside `~/Documents` for the same reason.

```bash
cp scripts/nexus-responder.sh ~/.flint/nexus-responder.sh && chmod +x ~/.flint/nexus-responder.sh
cp scripts/com.nexus.responder.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nexus.responder.plist
```

Stop it with `launchctl bootout gui/$(id -u)/com.nexus.responder`. Output goes to
`~/.flint/logs/nexus-responder.log`.

### The cap that matters once it is supervised

`maxTurnsPerRun` stops bounding anything the moment a supervisor is involved: a
restarted process comes back with a fresh budget. `maxTurnsPerDay` (default 60) is kept
in `~/.flint/responder-spend.json`, keyed by UTC date, and written after every round —
so a crash loop cannot spend its way around it.

```bash
pnpm --filter responder responder spend
```

At the cap the loop idles rather than exiting, and picks up again the next day.

## Threads that conclude

A closing turn can carry a `canon` block — a key, the conclusion, and why. The responder
files it with `propose_canon`, which is a proposal and not a write: shared facts are
human-approved only, and no prompt reaches past that. Approve or reject it in the
console. A thread that ends without concluding anything just closes.
