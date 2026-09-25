#!/usr/bin/env python3
"""When is a training cycle worth running, and what happened in the last ones.

No calendar retrain. The old weekly job retrained whether or not there was
anything new to learn, and nothing stopped it after a string of failures. A
cycle is due only when all of these hold:

- there is enough compliant data to train on at all (build_data --count-only
  targets >= the profile's min_train);
- something changed since the last cycle that trained: at least --min-new
  (150) more target rows, or a different profile (a new base, new knobs);
- at least --min-days (7) since the last cycle that trained;
- the kill switch is off: two REJECT / NO_CANDIDATE results in a row stop
  scheduled cycles until someone runs `cycle.sh --force` on purpose. After
  that the effort belongs in base-model bake-offs through the same gate.

State lives in ~/.flint/brain/cycles/state.json (one record per cycle).

  cycle_state.py due --count-json '<build_data --count-only output>' --profile-sha <sha> --min-train 200
  cycle_state.py record --id <cycle id> --result <RESULT> [--set key=value ...]
  cycle_state.py last
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

DEFAULT_STATE = os.path.expanduser("~/.flint/brain/cycles/state.json")
EXIT_DUE, EXIT_ERROR, EXIT_NOT_DUE = 0, 2, 10

# Results of a cycle that actually trained (and so start the min-days clock).
TRAINED = {"PROMOTE", "REJECT", "HOLD", "NO_CANDIDATE", "PREEMPTED", "PACKAGE_FAILED", "GATE_ERROR"}
# Results that count toward the kill switch.
FAILED = {"REJECT", "NO_CANDIDATE"}
RESULTS = TRAINED | {"NO_DATA", "DEFER", "ERROR", "CONTAMINATED"}


def load_state(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {"cycles": []}
    with open(path) as f:
        s = json.load(f)
    s.setdefault("cycles", [])
    return s


def save_state(path: str, state: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def is_due(
    state: Dict[str, Any],
    *,
    targets: int,
    profile_sha: str,
    now: _dt.datetime,
    min_train: int,
    min_new: int = 150,
    min_days: float = 7.0,
) -> Tuple[bool, str]:
    cycles: List[Dict[str, Any]] = state.get("cycles", [])
    finished = [c for c in cycles if c.get("result") in RESULTS]
    decided = [c for c in finished if c.get("result") in {"PROMOTE", "REJECT", "HOLD", "NO_CANDIDATE"}]
    if len(decided) >= 2 and all(c["result"] in FAILED for c in decided[-2:]):
        return False, (
            f"kill switch: the last two cycles ended {decided[-2]['result']} and {decided[-1]['result']}. "
            "Fix the data or the recipe, or move to a base-model bake-off; `cycle.sh --force` overrides once."
        )
    if targets < min_train:
        return False, f"only {targets} compliant target rows (min_train {min_train}): nothing worth training yet"
    trained = [c for c in finished if c.get("result") in TRAINED]
    if not trained:
        return True, f"first cycle: {targets} compliant target rows"
    last = trained[-1]
    ended = _dt.datetime.fromisoformat(str(last.get("endedAt") or last.get("startedAt")))
    days = (now - ended).total_seconds() / 86400
    if days < min_days:
        return False, f"last training cycle {last.get('id')} was {days:.1f} days ago (< {min_days:g})"
    if last.get("profileSha") != profile_sha:
        return True, "the profile changed since the last training cycle"
    grown = targets - int(last.get("targets") or 0)
    if grown < min_new:
        return False, f"{grown} new target rows since cycle {last.get('id')} (< {min_new})"
    return True, f"{grown} new target rows since cycle {last.get('id')}"


def _parse_sets(pairs: Sequence[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for p in pairs:
        k, _, v = p.partition("=")
        if not k:
            continue
        try:
            out[k] = json.loads(v)
        except json.JSONDecodeError:
            out[k] = v
    return out


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Training-cycle scheduling state.")
    ap.add_argument("--state", default=DEFAULT_STATE)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("due")
    d.add_argument("--count-json", required=True)
    d.add_argument("--profile-sha", required=True)
    d.add_argument("--min-train", type=int, required=True)
    d.add_argument("--min-new", type=int, default=150)
    d.add_argument("--min-days", type=float, default=7.0)
    r = sub.add_parser("record")
    r.add_argument("--id", required=True)
    r.add_argument("--result", required=True, choices=sorted(RESULTS | {"STARTED"}))
    r.add_argument("--set", action="append", default=[], help="key=value (value parsed as JSON when it can be)")
    sub.add_parser("last")
    a = ap.parse_args(argv)

    try:
        state = load_state(a.state)
    except (OSError, ValueError) as e:
        print(f"cycle_state: can't read {a.state}: {e}", file=sys.stderr)
        return EXIT_ERROR
    now = _dt.datetime.now(_dt.timezone.utc)

    if a.cmd == "due":
        counts = json.loads(a.count_json)
        due, why = is_due(state, targets=int(counts.get("targets", 0)), profile_sha=a.profile_sha, now=now, min_train=a.min_train, min_new=a.min_new, min_days=a.min_days)
        print(why)
        return EXIT_DUE if due else EXIT_NOT_DUE

    if a.cmd == "record":
        cycles = state["cycles"]
        rec = next((c for c in cycles if c.get("id") == a.id), None)
        if rec is None:
            rec = {"id": a.id, "startedAt": now.isoformat(timespec="seconds")}
            cycles.append(rec)
        rec.update(_parse_sets(a.set))
        rec["result"] = a.result
        if a.result != "STARTED":
            rec["endedAt"] = now.isoformat(timespec="seconds")
        save_state(a.state, state)
        return 0

    last = state["cycles"][-1] if state["cycles"] else None
    print(json.dumps(last))
    return 0


if __name__ == "__main__":
    sys.exit(main())
