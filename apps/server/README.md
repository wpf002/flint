# Hosted Flint (server)

The always-on shared Flint service. Wraps the Flint client (with the Flint
persona) behind an authenticated HTTP/SSE API so your apps and devices talk to
**one** Flint. Provider/memory/tools come from env — the same image runs with
Anthropic (cloud) or a remote Ollama (rented GPU). The local model never moves
here; Railway has no GPU.

## Endpoints

| Method | Path | Auth | Body | Returns |
| --- | --- | --- | --- | --- |
| GET | `/health` | no | — | `{ ok, provider, model, tools }` |
| POST | `/generate` | yes | `{ prompt }` | `{ text, usage, reason }` |
| POST | `/chat` | yes | `{ conversationId, message }` | SSE stream of `StreamEvent`s |

Auth: send `Authorization: Bearer $FLINT_TOKEN` on everything but `/health`.

```bash
curl -s $URL/health
curl -s -X POST $URL/generate -H "Authorization: Bearer $FLINT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"prompt":"status?"}'
```

## Environment

| Var | Required | Purpose |
| --- | --- | --- |
| `FLINT_TOKEN` | **yes** | Bearer token clients must send. Server refuses to start without it. |
| `ANTHROPIC_API_KEY` | one provider | Use Anthropic (model via `FLINT_MODEL`, default `claude-sonnet-4-6`). |
| `OLLAMA_MODEL` + `OLLAMA_HOST` | one provider | Use a remote Ollama (e.g. a rented GPU). Takes precedence over Anthropic. |
| `MCP_CONFIG` | no | Path to an `mcp.json` of integration servers (your apps as tools). |
| `PORT` | no | Injected by Railway. |

**Model choice (the Railway tradeoff):** Railway can't run the local 14B model.
Pick one — `ANTHROPIC_API_KEY` (fast, always-on, cloud-backed) **or** point
`OLLAMA_HOST` at a rented GPU box running your model. Swappable any time; it's
just env.

## Tools / integrations

If `MCP_CONFIG` is set, the server connects those MCP servers and exposes their
tools. **Read-only tools run freely; side-effecting tools are DENIED** — a hosted
service has no interactive approver yet (a hosted approval flow is a later step).
Fail-safe by design.

## Deploy to Railway

```bash
railway login
railway init                 # or: railway link  (existing project)
railway up                   # builds apps/server/Dockerfile from the repo root
railway variables --set FLINT_TOKEN=$(openssl rand -hex 24) \
                   --set ANTHROPIC_API_KEY=sk-ant-...   # or OLLAMA_MODEL + OLLAMA_HOST
```

`railway.toml` (repo root) already points the build at this Dockerfile and uses
`/health` as the healthcheck. After deploy, `GET $RAILWAY_URL/health` should
return `ok`.

## Run locally

```bash
FLINT_TOKEN=dev OLLAMA_MODEL=qwen2.5:14b OLLAMA_HOST=http://127.0.0.1:11434 \
  PORT=8787 pnpm --filter server start
```
