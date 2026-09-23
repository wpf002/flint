#!/usr/bin/env python3
"""Promotion gate: an adapter is only fit to serve if its latest judged eval is
a SIGNIFICANT win over its base. Writes PROMOTED.json or REJECTED.json into the
adapter dir (removing the other) and exits 0 / 1.

eval_judge.py reports SIGNIFICANT for a real gap in EITHER direction; the 7B run
on 2026-09-20 was SIGNIFICANT at 25-48, i.e. significantly worse than base.
Nothing checked the direction, so the weekly retrain could have produced a
regression and the only record was a CSV row. Anything that serves an adapter
(docs/MAC_STUDIO_UPGRADE.md step 3) must require PROMOTED.json.

usage: promote_gate.py <adapter_dir> [eval_history.csv]
"""
import csv, json, os, sys, time


def verdict(row):
    fw, bw = int(row["flint_wins"]), int(row["base_wins"])
    if row["signal"] != "SIGNIFICANT":
        return False, f"not significant ({row['signal']}, {fw}-{bw})"
    if fw <= bw:
        return False, f"significantly WORSE than base ({fw}-{bw})"
    return True, f"significant win over base ({fw}-{bw})"


def main():
    adapter_dir = sys.argv[1].rstrip("/")
    brain = os.path.dirname(adapter_dir)
    csv_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(brain, "eval_history.csv")
    name = os.path.basename(adapter_dir)
    rows = []
    if os.path.exists(csv_path):
        with open(csv_path) as f:
            rows = [r for r in csv.DictReader(f) if r.get("adapter") == name]
    if not rows:
        ok, why, row = False, "no eval recorded for this adapter", {}
    else:
        row = rows[-1]
        ok, why = verdict(row)
    out = "PROMOTED.json" if ok else "REJECTED.json"
    stale = "REJECTED.json" if ok else "PROMOTED.json"
    if os.path.exists(os.path.join(adapter_dir, stale)):
        os.remove(os.path.join(adapter_dir, stale))
    with open(os.path.join(adapter_dir, out), "w") as f:
        json.dump({"decided": time.strftime("%Y-%m-%d %H:%M"), "reason": why, "eval": row}, f, indent=1)
    print(f"promote_gate: {name} {'PROMOTED' if ok else 'REJECTED'} — {why}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
