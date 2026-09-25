# apps/studio — move Flint onto the Mac Studio, remotely, in one command

When the Mac Studio is set up and reachable, run **one script from your laptop**
and Flint moves himself over, comes back to life on the new machine, and starts
the roadmap to becoming a real, owned 70B AI.

## Prereq (once, on the Studio)
See [../../docs/REMOTE_ACCESS.md](../../docs/REMOTE_ACCESS.md):
- **Remote Login (SSH)** on — System Settings › General › Sharing.
- **Tailscale** installed + signed in with the same account as your laptop, so
  `studio` is reachable from anywhere.
- Push your latest code: `git push origin main` (the Studio clones from GitHub).

## Run it (from your laptop, in this repo)
```
STUDIO=willfoti@studio ./apps/studio/migrate_to_studio.sh
```
Flags:
- `--dry-run` — print every action, change nothing. **Do this first.**
- `--with-models` — also rsync the ~40GB of ollama model blobs (otherwise the
  Studio re-pulls them fresh, which is usually cleaner).
- `--no-roadmap` — migrate + go live, but don't kick off the 70B training yet.
- `--studio=willfoti@100.x.y.z` — explicit host if MagicDNS name `studio` isn't set.

## What each script does
| Script | Runs on | Does |
|---|---|---|
| `migrate_to_studio.sh` | **laptop** | orchestrates all three phases over SSH/rsync |
| `studio_bootstrap.sh` | Studio | toolchain (brew/nvm/pnpm/uv/ollama), clone repo, rebuild server, load agents → Flint live |
| `studio_roadmap.sh` | Studio | pull the 70B, launch the overnight fine-tune (detached), start the grow/retrain flywheel |
| `install_searxng.sh` | Studio | keyless web search: SearXNG in `~/searxng` + the `com.flint.searxng` agent (see below) |

## Keyless search (SearXNG)

`install_searxng.sh` gives Flint web search that needs no API key: a private
[SearXNG](https://github.com/searxng/searxng) on `127.0.0.1:8888`, kept running by the
`com.flint.searxng` LaunchAgent. It is the **fallback** behind `web_search`, not a
replacement. With `SEARCH_PROVIDER=auto` the Tavily key stays primary while it works.
SearXNG answers when there is no key or Tavily fails (quota, rate limit, outage, timeout),
so credits are spent only where they buy something.

```
./apps/studio/install_searxng.sh               # clone + uv venv + settings + agent, then a live JSON check
./apps/studio/install_searxng.sh --update      # later: pull the latest SearXNG (engines break as sites change)
./apps/studio/install_searxng.sh --no-launchd  # install only; prints the foreground command
```

It writes `~/searxng/{src,venv,settings.yml,logs}` and
`~/Library/LaunchAgents/com.flint.searxng.plist`, rendered from the template
`com.flint.searxng.plist` and served by granian as SearXNG's own container does.
`settings.yml` is written **once**, mode 600, with a secret generated at install. Re-runs
never touch it; delete it to get a fresh one. The settings: DuckDuckGo, Brave, Bing, Mojeek,
Wikipedia and Qwant; safe search off; JSON output on; the limiter off, since it guards
public instances and this one only listens on loopback. Some engines get blocked from some
IPs (Mojeek and Qwant did in testing). SearXNG suspends them for a while and the rest carry
the query. Re-running the script is safe: it reports `✓` for what it changed and `=` for
what it kept.

Then switch the web connector over. In `~/.flint/mcp.json`, set the `web` server's `env`:

```json
"env": { "SEARCH_PROVIDER": "auto", "SEARCH_API_KEY": "tvly-…" }
```

Add `"SEARXNG_URL"` only if you changed the port. Remove `SEARCH_API_KEY` to run fully
keyless. Every `web_search` result now says which backend answered (`"source"`), plus a
`"fallback"` reason when SearXNG stood in (all the knobs are in
[packages/mcp/README.md](../../packages/mcp/README.md#web-search-metered-keyless-or-both)).
The connector runs from a bundle, and auto-deploy rebuilds only `server.mjs`. So after
pulling this change, rebuild the bundle once and restart Flint:

```
ESBUILD="$(find ~/flint/node_modules/.pnpm -path '*esbuild*/bin/esbuild' -type f | head -1)"
"$ESBUILD" ~/flint/packages/mcp/connectors/web-server.ts --bundle --platform=node --format=esm --target=node20 \
  --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" \
  --outfile="$HOME/.flint/connectors/web-server.mjs"
launchctl kickstart -k "gui/$UID/com.flint.server"
```

Is SearXNG good enough to lean on? Measure it on Will's research prompts before trusting it
further: `pnpm --filter @flint/parity search-compare --budget-usd 1` (see
[../parity/README.md](../parity/README.md#search-compare-is-keyless-search-good-enough)).

To remove it: `launchctl bootout gui/$UID/com.flint.searxng`, then delete
`~/Library/LaunchAgents/com.flint.searxng.plist` and `~/searxng`.

## What it carries over
`~/.flint/` — memory, `training/corpus.jsonl` (every banked lesson), `secrets.env`,
`brain/` (training harness + the 50k `data/public.jsonl`) — plus the
`com.flint.*` / `com.nexus.*` LaunchAgents. The repo itself is cloned fresh from
GitHub. The `.venv` is rebuilt on the Studio, not copied.

## What it deliberately does NOT do
Serving the fine-tuned 70B and **flipping it to primary** are left to you, after
the overnight run finishes and Claude's eval says it's ready — steps 3-4 of
[../../docs/MAC_STUDIO_UPGRADE.md](../../docs/MAC_STUDIO_UPGRADE.md). Auto-promoting
an unproven brain would make Flint worse. That flip is the moment he becomes his
own AI, and it should be a decision, not a side effect.

## After it runs
```
open http://studio:8080                                   # talk to Flint
ssh willfoti@studio 'tail -f ~/.flint/brain/upgrade.out'   # watch the fine-tune
ssh willfoti@studio 'cat ~/.flint/brain/history.log'       # the eval verdict, when done
```
