#!/usr/bin/env python3
"""Can a training run share this machine with the live local model? Decides before it starts.

The old scripts made room by `launchctl unload com.flint.ollama`. That took down
more than the chat model: nomic-embed-text lives in the same Ollama, and memory
recall, knowledge, the router and deep_research call it on every FRONTIER turn
too. So a "local" training run degraded every Claude turn for hours, and an
aborted run left Ollama unloaded. This pipeline never touches Ollama. Instead
it trains only in a footprint that fits NEXT TO the live model:

  coexist  if  ollama + train + headroom <= RAM
          and  ollama + train <= GPU wired limit - 2 GB

- ollama: the larger of Ollama's resident models right now (GET /api/ps) and
  the profile's live_resident_gb. The profile number matters: an idle Ollama
  unloads the model after keep_alive, and the next chat loads it right back.
- train: the last measured peak for this profile and footprint (a previous
  early_stop.json), else the profile's estimate.
- footprints are tried in the profile's order (e.g. 2048x16, 2048x8, 1536x8);
  the first that fits wins. If none fits: defer (exit 20). No cover mode:
  taking the live model offline, or silently answering private local-only
  turns with a frontier model instead, is a decision for Will (README).

Also defers when macOS already reports memory pressure above normal.

  memcheck.py [--profile P] [--cycles-dir ~/.flint/brain/cycles]
prints one JSON line {decision, footprint, maxSeqLength, numLayers, memBudgetGb, ...}
and exits 0 (coexist) or 20 (defer).
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import subprocess
import sys
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Sequence

from early_stop import macos_memory_pressure
from profiles import ProfileError, load_profile, parse_footprint

EXIT_COEXIST, EXIT_ERROR, EXIT_DEFER = 0, 2, 20
WIRED_MARGIN_GB = 2.0
GB = 1e9


def sysctl_int(name: str) -> Optional[int]:
    try:
        out = subprocess.run(["sysctl", "-n", name], capture_output=True, text=True, timeout=5).stdout.strip()
        return int(out)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def ollama_resident_gb(host: str) -> Optional[float]:
    """Sum of Ollama's loaded models (bytes in memory), or None if Ollama can't be asked."""
    try:
        with urllib.request.urlopen(f"{host.rstrip('/')}/api/ps", timeout=5) as r:
            body = json.loads(r.read())
    except (OSError, ValueError):
        return None
    return sum(float(m.get("size", 0) or 0) for m in body.get("models", [])) / GB


def measured_peaks(cycles_dir: str, profile_name: str) -> Dict[str, float]:
    """footprint -> highest measured training peak (GB) from earlier runs of this profile."""
    peaks: Dict[str, float] = {}
    for path in glob.glob(os.path.join(cycles_dir, "*", "adapter", "early_stop.json")):
        try:
            with open(path) as f:
                s = json.load(f)
        except (OSError, ValueError):
            continue
        if s.get("profile") != profile_name or not s.get("footprint"):
            continue
        peak = max(float(s.get("peak_memory_gb") or 0), float(s.get("peakMemoryGbMlx") or 0))
        if peak > 0:
            peaks[s["footprint"]] = max(peaks.get(s["footprint"], 0.0), peak)
    return peaks


def decide(
    profile: Dict[str, Any],
    *,
    ram_gb: float,
    wired_limit_gb: float,
    ollama_now_gb: Optional[float],
    pressure: str,
    measured: Dict[str, float],
) -> Dict[str, Any]:
    """Pure decision: which footprint (if any) fits next to the live model."""
    mem = profile["memory"]
    ollama_gb = max(float(mem["live_resident_gb"]), ollama_now_gb or 0.0)
    headroom = float(mem["headroom_gb"])
    tried: List[Dict[str, Any]] = []
    out: Dict[str, Any] = {
        "ramGb": round(ram_gb, 1),
        "wiredLimitGb": round(wired_limit_gb, 1),
        "ollamaGb": round(ollama_gb, 1),
        "ollamaNowGb": None if ollama_now_gb is None else round(ollama_now_gb, 1),
        "pressure": pressure,
        "tried": tried,
    }
    if pressure != "normal":
        return {**out, "decision": "defer", "reason": f"macOS memory pressure is {pressure} before training even starts"}
    for fp in mem["footprints"]:
        train_gb = measured.get(fp, float(mem["peak_gb"][fp]))
        fits_ram = ollama_gb + train_gb + headroom <= ram_gb
        fits_wired = ollama_gb + train_gb <= wired_limit_gb - WIRED_MARGIN_GB
        tried.append({"footprint": fp, "trainGb": train_gb, "source": "measured" if fp in measured else "estimate", "fitsRam": fits_ram, "fitsWired": fits_wired})
        if fits_ram and fits_wired:
            seq, layers = parse_footprint(fp)
            # The run's own budget: what it was sized at, plus a little, and never past the wired ceiling.
            budget = min(train_gb * 1.1, wired_limit_gb - WIRED_MARGIN_GB - ollama_gb)
            return {**out, "decision": "coexist", "footprint": fp, "maxSeqLength": seq, "numLayers": layers, "memBudgetGb": round(budget, 1)}
    return {**out, "decision": "defer", "reason": "no footprint fits next to the live model; see `tried`"}


def main(argv: Optional[Sequence[str]] = None, *, sysctl: Callable[[str], Optional[int]] = sysctl_int) -> int:
    ap = argparse.ArgumentParser(description="Decide whether training can share the machine with the live model.")
    ap.add_argument("--profile", default=None)
    ap.add_argument("--cycles-dir", default=os.path.expanduser("~/.flint/brain/cycles"))
    ap.add_argument("--ollama-host", default=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"))
    a = ap.parse_args(argv)
    try:
        profile = load_profile(a.profile)
    except ProfileError as e:
        print(f"memcheck: {e}", file=sys.stderr)
        return EXIT_ERROR
    ram = sysctl("hw.memsize")
    if not ram:
        print("memcheck: can't read hw.memsize", file=sys.stderr)
        return EXIT_ERROR
    ram_gb = ram / GB
    wired_mb = sysctl("iogpu.wired_limit_mb") or 0
    # 0 means the macOS default, about 75% of RAM on these machines.
    wired_gb = wired_mb * 1024 * 1024 / GB if wired_mb > 0 else ram_gb * 0.75
    res = decide(
        profile,
        ram_gb=ram_gb,
        wired_limit_gb=wired_gb,
        ollama_now_gb=ollama_resident_gb(a.ollama_host),
        pressure=macos_memory_pressure(),
        measured=measured_peaks(a.cycles_dir, profile["name"]),
    )
    print(json.dumps(res))
    return EXIT_COEXIST if res["decision"] == "coexist" else EXIT_DEFER


if __name__ == "__main__":
    sys.exit(main())
