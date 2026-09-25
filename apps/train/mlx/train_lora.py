#!/usr/bin/env python3
"""One LoRA run with in-process early stopping. Replaces `mlx_lm lora` + pick_best.py.

  train_lora.py --data <cycle>/data --out <cycle>/adapter [--profile muse-glimmer-30b]
                [--max-seq-length N --num-layers N]   (memcheck.py's footprint)
                [--mem-budget-gb G] [--max-hours H] [--allow-download] [--dry-run]

Why not `python -m mlx_lm lora`: its run() replaces any callback it is given
with its own reporting callbacks, so early stopping can't be plugged in. This
calls the pieces run() calls (utils.load, datasets.load_dataset,
lora.train_model) with EarlyStop as the callback, and refuses to start if the
installed mlx-lm is not the version the profile pins or train_model's signature
has changed, rather than training through an API it wasn't written for.

Before the first step it also checks, on the real tokenizer, that mask_prompt's
offset is a true prefix of each rendered row (a chat template with a reasoning
channel can break that, and then the loss trains on the prompt or skips the
answer), and that the answers aren't truncated away by max_seq_length.

Nothing is downloaded unless --allow-download: HF_HUB_OFFLINE=1 is set before
mlx-lm loads, so a model that isn't already in the local Hugging Face cache (or
a local directory) is an error, not a surprise 19 GB download.

Exit codes: 0 CANDIDATE (adapters.safetensors = best weights), 10 NO_CANDIDATE
(no eval beat the base by min_delta; no adapter left behind), 75 PREEMPTED
(yielded to the live model), 2 config/environment error, 1 crash.
early_stop.json in --out records the whole curve and why the run ended.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import inspect
import json
import math
import os
import shutil
import sys
import time
from typing import Any, Dict, List, Optional, Sequence

from early_stop import EarlyStop, EarlyStopConfig, Preempt, StopTraining
from profiles import ProfileError, load_profile

EXIT_CANDIDATE, EXIT_CRASH, EXIT_CONFIG, EXIT_NO_CANDIDATE, EXIT_PREEMPTED = 0, 1, 2, 10, 75
EXPECTED_TRAIN_MODEL_PARAMS = ["args", "model", "train_set", "valid_set", "training_callback"]
MASK_CHECK_ROWS = 20
MAX_TRUNCATED_SHARE = 0.10


def count_rows(path: str) -> int:
    if not os.path.exists(path):
        return 0
    with open(path) as f:
        return sum(1 for line in f if line.strip())


def resolve_config(
    profile: Dict[str, Any],
    n_train: int,
    n_valid: int,
    *,
    max_seq_length: Optional[int] = None,
    num_layers: Optional[int] = None,
    mem_budget_gb: Optional[float] = None,
    max_hours: Optional[float] = None,
) -> Dict[str, Any]:
    """Everything the run will do, computed from the profile and the data size. Pure."""
    tr, lo, es = profile["train"], profile["lora"], profile["early_stop"]
    if n_train < int(tr["min_train"]):
        raise ProfileError(f"{n_train} training rows < min_train {tr['min_train']}")
    if n_valid < int(tr["min_valid"]):
        raise ProfileError(f"{n_valid} valid rows < min_valid {tr['min_valid']}: early stopping would be noise")
    batch = int(tr["batch_size"])
    accum = int(tr["grad_accumulation_steps"])
    steps_per_epoch = math.ceil(n_train / batch)
    iters = math.ceil(float(tr["max_epochs"]) * steps_per_epoch)
    updates = max(1, iters // accum)
    warmup = min(int(tr["warmup_updates"]), max(0, updates - 1))
    steps_per_eval = max(int(tr["min_steps_per_eval"]), math.ceil(steps_per_epoch / int(tr["evals_per_epoch"])))
    lr = float(tr["learning_rate"])
    mlx_args = {
        "fine_tune_type": "lora",
        "optimizer": "adam",
        "mask_prompt": bool(tr["mask_prompt"]),
        "num_layers": int(num_layers if num_layers is not None else lo["num_layers"]),
        "batch_size": batch,
        "iters": iters,
        # The whole valid set, every eval: the curve moves only when the weights do.
        "val_batches": -1,
        "learning_rate": lr,
        "steps_per_report": 10,
        "steps_per_eval": steps_per_eval,
        # Only the callback saves (the best weights); no per-step checkpoint files.
        "save_every": 10**9,
        "max_seq_length": int(max_seq_length if max_seq_length is not None else tr["max_seq_length"]),
        "grad_checkpoint": bool(tr["grad_checkpoint"]),
        "grad_accumulation_steps": accum,
        # The schedule counts optimizer updates, not steps (one update per `accum` steps).
        "lr_schedule": {
            "name": "cosine_decay",
            "arguments": [lr, max(1, updates - warmup), float(tr["lr_end"])],
            "warmup": warmup,
            "warmup_init": lr / 10,
        },
        "lora_parameters": {"rank": int(lo["rank"]), "scale": float(lo["scale"]), "dropout": float(lo["dropout"])},
        "seed": 0,
    }
    early = EarlyStopConfig(
        patience=int(es["patience"]),
        min_delta=float(es["min_delta"]),
        min_iter=math.ceil(float(es["min_epochs"]) * steps_per_epoch),
        diverge=float(es["diverge"]),
        max_hours=float(max_hours if max_hours is not None else es["max_hours"]),
        mem_budget_gb=mem_budget_gb,
    )
    return {"mlx": mlx_args, "early_stop": early.__dict__, "n_train": n_train, "n_valid": n_valid, "updates": updates}


def check_mask_offsets(dataset: Any, tokenizer: Any, max_seq_length: int, rows: int = MASK_CHECK_ROWS) -> List[str]:
    """Problems with prompt masking on the real template; empty when fine."""
    problems: List[str] = []
    truncated = 0
    n = len(dataset)
    for i in range(n):
        d = dataset[i]
        tokens, offset = dataset.process(d)
        if offset >= max_seq_length:
            truncated += 1
        if i >= rows:
            continue
        msgs = d["messages"]
        prefix = tokenizer.apply_chat_template(msgs[:-1], tools=d.get("tools"), add_generation_prompt=True, return_dict=False)
        if list(tokens[: len(prefix)]) != list(prefix):
            problems.append(f"row {i}: the prompt's tokens are not a prefix of the full row's, so mask_prompt would mask the wrong span")
        elif offset >= len(tokens) - 1:
            problems.append(f"row {i}: nothing left to train on after the mask (offset {offset} of {len(tokens)} tokens)")
    if n and truncated / n > MAX_TRUNCATED_SHARE:
        problems.append(f"{truncated} of {n} rows have their whole answer past max_seq_length {max_seq_length}: raise it or trim the data")
    return problems


def _log(msg: str) -> None:
    print(msg, flush=True)


def local_model_dir(model: str, revision: Optional[str], allow_download: bool) -> str:
    """A local directory with the base weights: `model` itself, or its pinned HF snapshot.

    Resolving the pinned revision here (rather than letting mlx-lm fetch "main")
    means the weights trained on are exactly the ones the profile names, and
    package_candidate.sh fuses into the same ones.
    """
    if os.path.isdir(os.path.expanduser(model)):
        return os.path.expanduser(model)
    from huggingface_hub import snapshot_download  # installed with mlx-lm

    return snapshot_download(model, revision=revision or None, local_files_only=not allow_download)


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="One LoRA run with in-process early stopping (see module docstring).")
    ap.add_argument("--profile", default=None)
    ap.add_argument("--data", required=True, help="dir with train.jsonl, valid.jsonl (build_data.py --out)")
    ap.add_argument("--out", required=True, help="adapter dir: adapters.safetensors, early_stop.json")
    ap.add_argument("--model", default=None, help="override the profile's base.mlx_model (a local dir or cached HF repo)")
    ap.add_argument("--max-seq-length", type=int, default=None)
    ap.add_argument("--num-layers", type=int, default=None)
    ap.add_argument("--mem-budget-gb", type=float, default=None, help="preempt when mlx's peak memory passes this")
    ap.add_argument("--max-hours", type=float, default=None)
    ap.add_argument("--allow-download", action="store_true", help="let mlx-lm download the base model if it isn't cached")
    ap.add_argument("--dry-run", action="store_true", help="print the resolved run and exit without importing mlx")
    a = ap.parse_args(argv)

    try:
        profile = load_profile(a.profile)
        n_train = count_rows(os.path.join(a.data, "train.jsonl"))
        n_valid = count_rows(os.path.join(a.data, "valid.jsonl"))
        cfg = resolve_config(profile, n_train, n_valid, max_seq_length=a.max_seq_length, num_layers=a.num_layers, mem_budget_gb=a.mem_budget_gb, max_hours=a.max_hours)
    except ProfileError as e:
        print(f"train_lora: {e}", file=sys.stderr)
        return EXIT_CONFIG
    model_path = a.model or profile["base"]["mlx_model"]
    cfg["model"] = model_path
    stamp = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    _log(f"[{stamp}] training: profile={profile['name']} model={model_path} train_n={n_train} iters={cfg['mlx']['iters']} valid_n={n_valid}")
    if a.dry_run:
        print(json.dumps(cfg, indent=2))
        return EXIT_CANDIDATE

    if not a.allow_download:
        os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "true")
    try:
        import types

        import mlx.core as mx
        import mlx_lm
        from mlx.utils import tree_flatten
        from mlx_lm import lora as mlx_lora
        from mlx_lm.tuner.datasets import load_dataset
        from mlx_lm.utils import load as load_model
    except ImportError as e:
        print(f"train_lora: can't import mlx-lm ({e}); run setup_train_env.sh and use its python", file=sys.stderr)
        return EXIT_CONFIG

    want = str(profile["toolchain"]["mlx_lm_version"])
    if mlx_lm.__version__ != want:
        print(f"train_lora: mlx-lm {mlx_lm.__version__} installed, profile pins {want} ({profile['toolchain'].get('mlx_lm_git', '')}); run setup_train_env.sh", file=sys.stderr)
        return EXIT_CONFIG
    params = list(inspect.signature(mlx_lora.train_model).parameters)
    if params != EXPECTED_TRAIN_MODEL_PARAMS:
        print(f"train_lora: mlx_lm.lora.train_model{tuple(params)} is not the signature this driver was written for {tuple(EXPECTED_TRAIN_MODEL_PARAMS)}", file=sys.stderr)
        return EXIT_CONFIG

    os.makedirs(a.out, exist_ok=True)
    state_path = os.path.join(a.out, "early_stop.json")
    best_path = os.path.join(a.out, "best_adapters.safetensors")
    final_path = os.path.join(a.out, "adapters.safetensors")
    for stale in (best_path, final_path, os.path.join(a.out, "NO_CANDIDATE")):
        if os.path.exists(stale):
            os.remove(stale)
    if a.mem_budget_gb:
        try:
            # Allocations past this wait on in-flight work rather than growing (mlx memory limit).
            mx.set_memory_limit(int(a.mem_budget_gb * 1e9))
        except (AttributeError, TypeError, ValueError) as e:
            _log(f"train_lora: could not set the mlx memory limit ({e}); the callback's budget check still applies")

    started = time.monotonic()
    try:
        revision = None if a.model else profile["base"].get("mlx_revision")
        model_dir = local_model_dir(model_path, revision, a.allow_download)
    except Exception as e:  # huggingface_hub raises several kinds for "not cached"
        print(f"train_lora: base model {model_path} is not available locally ({e}). Download it on purpose: setup_train_env.sh --download-base", file=sys.stderr)
        return EXIT_CONFIG
    cfg["modelDir"] = model_dir
    model, tokenizer = load_model(model_dir, tokenizer_config={"trust_remote_code": False})
    args = types.SimpleNamespace(**{**mlx_lora.CONFIG_DEFAULTS, **cfg["mlx"], "model": model_path, "data": a.data, "train": True, "test": False, "adapter_path": a.out})
    train_set, valid_set, _ = load_dataset(args, tokenizer)
    problems = check_mask_offsets(train_set, tokenizer, cfg["mlx"]["max_seq_length"])
    if problems:
        for p in problems:
            print(f"train_lora: {p}", file=sys.stderr)
        return EXIT_CONFIG

    def save_best(step: int) -> None:
        mx.save_safetensors(best_path, dict(tree_flatten(model.trainable_parameters())))

    cb = EarlyStop(EarlyStopConfig(**cfg["early_stop"]), save_best, state_path=state_path, log=_log)
    outcome = "max-iters"
    try:
        mlx_lora.train_model(args, model, train_set, valid_set, training_callback=cb)
    except StopTraining as e:
        outcome = f"stopped: {e.reason}"
    except Preempt as e:
        outcome = f"preempted: {e.reason}"

    summary = {
        **cb.summary(),
        "outcome": outcome,
        "profile": profile["name"],
        "profileSha256": profile["_sha256"],
        "model": model_path,
        "mlxLmVersion": mlx_lm.__version__,
        "resolved": cfg,
        "peakMemoryGbMlx": round(mx.get_peak_memory() / 1e9, 2),
        "elapsedMinutes": round((time.monotonic() - started) / 60, 1),
        "footprint": f"{cfg['mlx']['max_seq_length']}x{cfg['mlx']['num_layers']}",
    }
    code = EXIT_CANDIDATE
    if outcome.startswith("preempted"):
        code = EXIT_PREEMPTED
    elif not cb.improved:
        # No eval beat the base: nothing may be packaged from this run.
        for p in (best_path, final_path):
            if os.path.exists(p):
                os.remove(p)
        with open(os.path.join(a.out, "NO_CANDIDATE"), "w") as f:
            f.write(f"no eval beat the base val {cb.state.base_val} by {cb.cfg.min_delta}\n")
        code = EXIT_NO_CANDIDATE
    else:
        # mlx-lm saved its FINAL weights to adapters.safetensors; the best ones replace them.
        shutil.copyfile(best_path, final_path)
    summary["exit"] = {EXIT_CANDIDATE: "CANDIDATE", EXIT_NO_CANDIDATE: "NO_CANDIDATE", EXIT_PREEMPTED: "PREEMPTED"}[code]
    with open(state_path, "w") as f:
        json.dump(summary, f, indent=2)
    _log(f"[{_dt.datetime.now().strftime('%Y-%m-%d %H:%M')}] train_lora: {summary['exit']} ({outcome}); base val {cb.state.base_val} best {cb.state.best_val} @ step {cb.state.best_iter}")
    return code


if __name__ == "__main__":
    sys.exit(main())
