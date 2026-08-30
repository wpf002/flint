# Flint → Mac Studio: the ultimate upgrade

When the Mac Studio (M4 Max, 64GB) arrives, this turns Flint from a 7B into a
fine-tuned **70B** trained on every lesson banked so far.

## The one command (remote, from your laptop)

Once the Studio is up and reachable (Remote Login on + Tailscale — see
[REMOTE_ACCESS.md](REMOTE_ACCESS.md)), you don't run the steps below by hand.
From your laptop, in this repo:

```
STUDIO=willfoti@studio ./apps/studio/migrate_to_studio.sh
```

That single script (see [apps/studio/README.md](../apps/studio/README.md)):
1. **carries Flint's life over** — `~/.flint` (memory, the banked `training/corpus.jsonl`,
   `secrets.env`, the `brain/` harness + 50k data) and the LaunchAgents, over
   encrypted SSH/Tailscale;
2. **bootstraps the Studio** — toolchain, clones the repo, rebuilds the server,
   loads every agent → **Flint is live on the new machine** (still on the Claude
   teacher);
3. **starts the roadmap** — pulls the 70B and launches the overnight fine-tune,
   detached, plus the daily/weekly flywheel.

Flags: `--dry-run` (show, change nothing), `--with-models` (also copy the ~40GB
ollama blobs instead of re-pulling), `--no-roadmap` (migrate only).

Steps 3-4 below (**serve the 70B**, **flip to primary**) stay a human decision,
gated on the training + eval verdict — the migrator does everything up to that
gate. The rest of this doc is the manual reference for what the scripts automate.

---

## 0. Transfer Flint to the Mac Studio
Copy from the old Mac to the new one (same paths):
- `~/.flint/` — runtime: server.mjs, console.html, connectors, mcp.json,
  **secrets.env** (Anthropic + OpenAI keys), and **training/corpus.jsonl** (your
  banked lessons — the whole point).
- `~/.flint/brain/` — the training harness + data (incl. `data/public.jsonl`, the 50k).
- `~/.flint-ollama/` — ollama + pulled models.
- The `flint` repo (this folder).
- `~/Library/LaunchAgents/com.flint.*.plist` — the agents.
Then: install node (nvm v24), `uv`, recreate the venv (`uv venv --python 3.12`,
`uv pip install mlx-lm datasets`), and `launchctl bootstrap` the agents.

## 1. Pull the 70B (the new brain)
```
ollama pull qwen2.5:72b            # or llama3.3:70b — the local fallback/base
# MLX copy for fine-tuning + serving:
# mlx-community/Qwen2.5-72B-Instruct-4bit  (auto-downloaded by the scripts)
```

## 2. Run the ultimate upgrade (the big training)
```
cd ~/.flint/brain
FLINT_70B=mlx-community/Qwen2.5-72B-Instruct-4bit ./ultimate_upgrade.sh
```
This: prepares ALL banked data (your personal Claude lessons + the 50k), runs a
proper multi-hour QLoRA fine-tune on the 70B (early-stopped on best val loss),
then has Claude judge the fine-tuned 70B vs the base 70B. Expect it to run
overnight. Output: `~/.flint/brain/adapters70b/`.

## 3. Serve Flint-70B as the primary brain (the serving seam)
Two options — pick one:
- **A. MLX server + provider:** run `mlx_lm.server --model <base> --adapter-path
  adapters70b` (OpenAI-compatible on a local port); point Flint's local provider
  at it. Needs a small OpenAI-compatible provider added to the server.
- **B. Fuse → Ollama:** `mlx_lm.fuse` the adapter into the base, convert to GGUF,
  `ollama create flint-70b -f Modelfile`, set `OLLAMA_MODEL=flint-70b`. Reuses the
  existing Ollama path — zero server code change. (Preferred if GGUF conversion
  is clean.)

## 4. Flip the routing: Flint primary, Claude backup
In `judgeBrain` (apps/server/src/index.ts): once Flint-70B is serving and eval
shows it's strong, invert the default — local (Flint-70B) first, escalate to
Claude only for the hardest queries (restore a HARD_RE gate) or on low
confidence. Keep Claude as the teacher (capture stays on) so it keeps improving.

## 5. Keep the flywheel
`com.flint.retrain` now retrains the 70B weekly on the growing corpus. Claude's
role shrinks over time as Flint-70B gets better. Independence, achieved.

---
**Net:** buy the box → transfer → pull 70B → `ultimate_upgrade.sh` (overnight) →
serve Flint-70B → flip to primary. Every banked lesson finally lands.
