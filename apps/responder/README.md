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
