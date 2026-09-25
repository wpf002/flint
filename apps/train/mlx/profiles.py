#!/usr/bin/env python3
"""Base-model profiles (profiles/*.toml): which model, which toolchain, which knobs.

The pipeline is parameterised by one profile. The default is the research
recommendation, muse-glimmer-30b (the live local model); set FLINT_BRAIN_PROFILE
or pass --profile to use another. Everything else in the pipeline reads its
settings from here, so switching base is one flag, and a cycle's manifest
records exactly which profile (and its sha256) produced a candidate.

  python3 profiles.py show                       # the resolved default profile
  python3 profiles.py get base.ollama_live       # one value, for shell scripts
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from typing import Any, Dict, Optional

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover - the training venv is 3.12
    tomllib = None  # type: ignore[assignment]

HERE = os.path.dirname(os.path.abspath(__file__))
PROFILES_DIR = os.path.join(HERE, "profiles")
DEFAULT_PROFILE = "muse-glimmer-30b"

REQUIRED = {
    "base": ["family", "mlx_model", "licence", "ollama_live", "candidate_prefix", "self_models", "reasoning_key"],
    "toolchain": ["mlx_lm_version"],
    "lora": ["num_layers", "rank", "scale", "dropout"],
    "train": [
        "batch_size", "grad_accumulation_steps", "learning_rate", "lr_end", "warmup_updates", "max_epochs",
        "max_seq_length", "grad_checkpoint", "mask_prompt", "evals_per_epoch", "min_steps_per_eval",
        "min_train", "min_valid", "valid_n", "max_human_share", "min_reasoning_share",
    ],
    "early_stop": ["patience", "min_delta", "min_epochs", "diverge", "max_hours"],
    "serve": ["think", "variant"],
    "memory": ["live_resident_gb", "headroom_gb", "footprints", "peak_gb"],
}


class ProfileError(Exception):
    pass


def profile_path(name_or_path: Optional[str] = None) -> str:
    name = name_or_path or os.environ.get("FLINT_BRAIN_PROFILE") or DEFAULT_PROFILE
    if name.endswith(".toml") or os.sep in name:
        return os.path.abspath(os.path.expanduser(name))
    return os.path.join(PROFILES_DIR, f"{name}.toml")


def load_profile(name_or_path: Optional[str] = None) -> Dict[str, Any]:
    if tomllib is None:
        raise ProfileError("profiles need Python 3.11+ (tomllib); use the training venv's python")
    path = profile_path(name_or_path)
    if not os.path.exists(path):
        known = sorted(f[:-5] for f in os.listdir(PROFILES_DIR) if f.endswith(".toml"))
        raise ProfileError(f"no profile {path} (known: {', '.join(known)})")
    with open(path, "rb") as f:
        raw = f.read()
    prof = tomllib.loads(raw.decode("utf-8"))
    missing = [f"{sec}.{k}" for sec, keys in REQUIRED.items() for k in keys if k not in prof.get(sec, {})]
    if missing:
        raise ProfileError(f"profile {path} is missing: {', '.join(missing)}")
    for fp in prof["memory"]["footprints"]:
        parse_footprint(fp)
        if fp not in prof["memory"]["peak_gb"]:
            raise ProfileError(f"profile {path}: footprint {fp} has no memory.peak_gb estimate")
    prof.setdefault("teachers", {})
    prof["_path"] = path
    prof["_sha256"] = hashlib.sha256(raw).hexdigest()
    return prof


def parse_footprint(fp: str) -> tuple:
    """'2048x16' -> (max_seq_length=2048, num_layers=16)."""
    try:
        seq, layers = fp.lower().split("x")
        return int(seq), int(layers)
    except ValueError:
        raise ProfileError(f"footprint {fp!r} is not <seq>x<layers>")


def get_path(prof: Dict[str, Any], dotted: str) -> Any:
    cur: Any = prof
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            raise ProfileError(f"no {dotted} in profile {prof.get('_path')}")
        cur = cur[part]
    return cur


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="Read a base-model profile.")
    ap.add_argument("--profile", default=None)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("show")
    g = sub.add_parser("get")
    g.add_argument("key")
    a = ap.parse_args(argv)
    try:
        prof = load_profile(a.profile)
        if a.cmd == "show":
            print(json.dumps(prof, indent=2, default=str))
        else:
            v = get_path(prof, a.key)
            print(json.dumps(v) if isinstance(v, (dict, list)) else ("true" if v is True else "false" if v is False else v))
    except ProfileError as e:
        print(f"profiles: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
