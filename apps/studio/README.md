# apps/studio — move Flint onto the Mac Studio, remotely, in one command

When the Mac Studio is set up and reachable, run **one script from your laptop**
and Flint moves himself over and comes back to life on the new machine. (The move
happened in 2026-09; this stays for a rebuild or the next machine.)

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
- `--no-roadmap` — skip the closing roadmap report.
- `--studio=willfoti@100.x.y.z` — explicit host if MagicDNS name `studio` isn't set.

## What each script does
| Script | Runs on | Does |
|---|---|---|
| `migrate_to_studio.sh` | **laptop** | orchestrates all three phases over SSH/rsync |
| `studio_bootstrap.sh` | Studio | toolchain (brew/nvm/pnpm/uv/ollama), clone repo, rebuild server, load agents → Flint live. Never loads a training agent. |
| `studio_roadmap.sh` | Studio | reports what the local brain serves, whether the training schedule is disabled, and what a training cycle would do (a dry run). Starts nothing. |
| `install_searxng.sh` | Studio | keyless web search: SearXNG in `~/searxng` + the `com.flint.searxng` agent (see below) |
| `rebuild.sh`, `restore_file.sh`, `rollback.sh` | MacBook / Studio | recovery: rebuild from the offsite backups, put one file back, go back a version (see "Rebuild and recovery") |

## Rebuild and recovery

What to do when something breaks is in [docs/RECOVERY.md](../../docs/RECOVERY.md).
This is how the pieces behind it work.

| File | Runs on | Does |
|---|---|---|
| `rebuild.sh --to you@new-mac.local` | **MacBook** | Asks the new Mac whether it is fit (FileVault on, someone logged in, no Flint there, not this Mac) before anything is opened or sent. Then opens the newest offsite backups with the key that lives there, sends the opened copies over SSH, sets the new Mac up at the version the old one was running, and runs the rebuild there. The key is never sent; the opened copies are removed from the new Mac when the rebuild ends or fails. |
| `rebuild.sh --unseal <folder>` | MacBook | Opens the newest backups into a folder, and nothing more. The runbook uses it to prove the key works. |
| `rebuild.sh --from <folder>` | new Mac | The rebuild itself: your data (unpacked by name: memory, training, eval, spend, the adapters, notifications, the settings snapshot), your settings, new secrets, the database (roles, restore, checks), the LaunchAgents, remote access, the installers, and the list of what still needs you. Refuses a Mac that already has a Flint; run again after it stopped part-way, it starts over. |
| `rebuild.sh --rehearse <folder>` | anywhere | The same rebuild into a scratch home folder and a scratch Postgres, with stand-ins for launchd and for anything that installs, signs in or shows something (`rehearsal/`). `rebuild.sh --stop <folder>` ends one left running. |
| `settings.manifest` | — | Every setting, by name: restored, made new, re-entered by you, worked out at install, or retired. No values. A name that is not listed is treated as a secret. |
| `settings_manifest.sh` | Studio, nightly | Saves the settings that are not secrets into `~/.flint/settings-snapshot.tsv`, so the offsite backup (which leaves out every settings file) still carries your switches. `--preview` says what it would save, by name, and writes nothing. `--check` names any setting on this Mac the manifest does not list. |
| `agents.manifest`, `templates/` | — | Every `com.flint.*` LaunchAgent and where its file comes from: a template here (the server, the local model, Tailscale), a file kept in the repo, or an install script. |
| `restore_file.sh memory` | Studio | Lists what every local backup holds, then puts one of Flint's own files back from the newest backup whose copy was not emptied, or from the day you add (`restore_file.sh memory 2026-10-10`). The file as it was is kept. |
| `restore_database.sh` | Studio | The database's one command: `--check` (a trial run), no option (restore the newest whole backup, after you type `RESTORE`), `--list`, `--dump <name>`, `--repair`. It runs the runtime's own `restore-production` directly, so nothing but that command's sentences is printed. |
| `rollback.sh` | Studio | Names the running version and the one before it, asks before going back, refuses to undo a revert unless told to by name, and pauses updates (`~/.flint/deploy-hold`) only when it went back. Never undoes a database update. |
| `run_rehearsal.sh` | Studio | Runs the rebuild rehearsal and writes how it went to `~/.flint/rehearsal-result` for Settings > Health. Run weekly by `com.flint.rebuild-rehearsal`, and by the deploy gate when a deploy changes what a rebuild is made of. |
| `free_space.sh` | Studio | Lists what Flint keeps on the Mac, by size, and removes nothing. `--remove` takes the rotated logs and the runtime versions beyond the ones the installer keeps. `--remove-test-leftovers` takes the temp folders Flint's own tests left more than a day ago, by their own names (`test-support/temp-prefixes`, every one starting with `flint-`, followed by the system's six characters with a digit or a capital among them), and leaves any that holds a socket or has anything in it changed in the last day. The listing names the first twenty. It never removes a backup, your memory, the database or a model. |
| `backup_flint.sh` | Studio, nightly | The files backup. It writes one line for each archive it made or could not make in `~/.flint/backup-events.jsonl`, which Settings > Health reads, and checks for room first. `--catch-up` runs it at login for a night that was missed, only when `FLINT_BACKUP_CATCHUP=on` is in `~/.flint/backup.env`. |
| `recovery_lib.sh` | — | Shared by the above: the manifest reader, the checks a setting's value must pass, and the template renderer. |

The database side is in the runtime (`apps/runtime/README.md`, "Putting the
database back from a backup"): `restore-production` (Will, at the keyboard, through
`restore_database.sh`), `restore-empty` (a rebuild's step: the same path, into an
empty database only) and `bootstrap-db` (the five roles and two databases, each
password new).

**What a rebuild trusts.** An offsite backup is encrypted to a public key, so it
is private, but nothing proves who wrote it: whoever can write to the offsite
folder can put a file there that opens with the key. So a rebuild trusts nothing
in a backup to be what Flint wrote.

- Only the folders that hold your data are unpacked, by name. A settings file, a
  connector list (whose commands the server would run), a token, tailnet state
  or a program in the archive stays in it, whatever case its name is written
  in. What was unpacked is checked again on the disk, and an archive that holds
  two names for one place, a path out of its folder, or more than a backup
  could, is refused.
- Settings are read as text; each value must match the shape its name is listed
  with and not look like a secret. Who may reach Flint over the tailnet is read
  from the Tailscale sign-in, never from the backup.
- The routing mode is never taken from a backup: not the setting, and not the
  file Settings keeps it in. A changed backup could turn Local into Cloud, and
  the mode decides where your words go. The rebuild writes Local for the new
  Mac, whatever the old one was in, and says so in one sentence ("Flint is in
  Local mode after a rebuild. Choose another mode in Settings if you want
  one."). Where the local model server is, its key and the two switches that
  let it be another machine are left to you as well.
- Nothing unpacked can run, links are dropped, and connectors are rebuilt from
  this repo.
- The key future backups are encrypted to is worked out from your key on the
  MacBook, never read from the archive.
- The database is restored by a role that owns nothing else, compared object by
  object with a database built from this repo's migrations, and only then put
  into use. A promotion your signature does not cover is switched off, and the
  keys that can approve are shown.
- The code installed is the commit the old Mac was running, as its backup names
  it; when it names none, main's newest is tested before it is installed.

What is left: forged rows that need no signature (a made-up memory, a key row
that the rebuild shows you and cannot judge). Signing the backups on the Studio
would close that, and is not done yet.

**Checks.**

```
zsh apps/studio/test/rebuild_rehearse.test.sh       # the whole rebuild, rehearsed three times, and every refusal (about 70 s)
zsh apps/studio/test/run_rehearsal.test.sh          # the runner that records how the rehearsal went
zsh apps/studio/test/settings_manifest.test.sh      # the manifest and the nightly snapshot
zsh apps/studio/test/settings_names_static.test.sh  # every FLINT_ setting the code reads is in the manifest
zsh apps/studio/test/plist_templates.test.sh        # the templates render and lint; every agent has a source
zsh apps/studio/test/restore_file.test.sh
zsh apps/studio/test/restore_database.test.sh
zsh apps/studio/test/rollback.test.sh
zsh apps/studio/test/runbook.test.sh                # every command the runbook gives exists
zsh apps/studio/test/live/settings_names.check.sh   # this Mac's setting, agent and secret-file NAMES against the manifests
```

All but the first and the last run in every deploy's gate. The rehearsal runs in
the gate only when a deploy changes what a rebuild is made of, and every Sunday
(`run_rehearsal.sh`). The last one reads the real Mac (names only), so it is run
by hand after adding a setting, an agent or a secret file.

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
never touch it; delete it to get a fresh one. The settings: DuckDuckGo, Brave, Mojeek and
Wikipedia; safe search moderate; JSON output on; the limiter off, since it guards public
instances and this one only listens on loopback. Bing and Qwant stay disabled, as upstream
ships them. In testing, Bing's scraper put unrelated pages at rank 1 (npm for "granian wsgi
server", FedEx for a Fed-rates query, adult sites), and Qwant only ever answered CAPTCHA.
Add an engine only after `search-compare` shows it helps. The scraped engines get blocked
from some IPs: in testing, DuckDuckGo answered CAPTCHA, Brave rate-limited after about a
dozen queries, and Mojeek sometimes returned 403. SearXNG suspends a blocked engine for a
while and the rest carry the query. When none can, `web_search` reports that as a failure
rather than an empty web. This is why the key stays primary. Re-running the script is safe:
it reports `✓` for what it changed and `=` for what it kept, and warns if an existing
`settings.yml` still enables Bing or Qwant.

Then switch the web connector over. In `~/.flint/mcp.json`, set the `web` server's `env`:

```json
"env": { "SEARCH_PROVIDER": "auto", "SEARCH_API_KEY": "tvly-…" }
```

Add `"SEARXNG_URL"` only if you changed the port. Remove `SEARCH_API_KEY` to run fully
keyless. A `tvly-…` key goes to Tavily and a `BSA…` key to Brave. A key of any other shape
is used nowhere until you add `"SEARCH_KEY_PROVIDER": "tavily"` or `"brave"`; the
connector's startup line in the server log says so. Every `web_search` result now says which backend answered (`"source"`), plus a
`"fallback"` reason when SearXNG stood in (all the knobs are in
[packages/mcp/README.md](../../packages/mcp/README.md#web-search-metered-keyless-or-both)).
The connector runs from its own bundle in `~/.flint/connectors/`. Auto-deploy
(`apps/server/install-server.sh`) rebuilds every installed `*-server.mjs` that has
source in `packages/mcp/connectors/`, test-starts it (`apps/server/connector-smoke.mjs`:
it must list its tools), and only then swaps it in, keeping the old one as
`<name>.mjs.prev`. A connector that fails to build or start keeps its old bundle,
and the deploy log says so. A manual build is needed only to install a connector
for the first time:

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

To remove it: `launchctl disable gui/$UID/com.flint.searxng` and `launchctl bootout gui/$UID/com.flint.searxng`, then delete
`~/Library/LaunchAgents/com.flint.searxng.plist` and `~/searxng`.

## What it carries over
`~/.flint/` — memory, `training/corpus.jsonl`, `secrets.env`, `brain/` — plus the
`com.flint.*` / `com.nexus.*` LaunchAgents. The repo itself is cloned fresh from
GitHub. The `.venv` is rebuilt on the Studio, not copied.

## What it deliberately does NOT do
Train or promote a local model. The 72B fine-tune and the daily-grow / weekly-retrain
flywheel this used to start are retired (see
[../train/mlx/HISTORY.md](../train/mlx/HISTORY.md)): they never measured the local
model against a frontier model, trained on Claude's answers, and took the live model
offline to train. Local training now runs through
[../train/mlx/cycle.sh](../train/mlx/README.md), which ships a candidate only if it
makes Flint-local measurably better against GPT-5, never touches the live model, and
leaves promotion to you.
