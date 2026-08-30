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
