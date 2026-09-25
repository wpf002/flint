#!/usr/bin/env python3
"""The contamination guard: nothing Flint is measured on may be trained on.

The parity set (~/.flint/eval/parity_prompts.jsonl) was built from the same
corpus the old pipeline trained on: 310 corpus rows were exact parity prompts,
and the old holdout shared 63 of its 150 prompts with parity. A model trained on
those rows is graded on questions it has seen answered, and the gate would
promote memorisation as "closer to GPT-5". This module makes that impossible
and fails closed:

- a required eval set that is missing is an error (MissingEvalSet), never a
  silent "no overlap";
- a prompt is contaminated if it has the same parity id as an eval prompt, or
  its content words overlap one by Jaccard >= 0.6 (stricter than dedupe's 0.8),
  or a 3+ word set is >= 80% contained in the other;
- every eval set's path, sha256 and size go into the training manifest, so the
  gate can refuse a candidate that was guarded against a different version of
  the set it is being judged on.

CLI (for a manual check of any JSONL with a `prompt`/`input` field):
  python3 contamination.py --eval-set ~/.flint/eval/parity_prompts.jsonl rows.jsonl
exits 0 when clean, 3 when anything overlaps, 2 when a required set is missing.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence

from parity_text import CONTAINMENT_THRESHOLD, containment, jaccard, normalize, prompt_id, word_set

GUARD_JACCARD = 0.6


class MissingEvalSet(Exception):
    """A required eval set is not on disk. The guard cannot say "clean" without it."""


@dataclass
class EvalSet:
    path: str
    required: bool
    present: bool = False
    sha256: Optional[str] = None
    n: int = 0
    ids: set = field(default_factory=set)
    # (id, content-word set) per prompt, for the fuzzy checks.
    entries: List[tuple] = field(default_factory=list)

    def describe(self) -> Dict[str, object]:
        """What the manifest records about this set."""
        return {
            "path": self.path,
            "required": self.required,
            "present": self.present,
            "sha256": self.sha256,
            "n": self.n,
        }


def _prompt_of(row: dict) -> Optional[str]:
    for k in ("prompt", "input"):
        v = row.get(k)
        if isinstance(v, str) and v.strip():
            return v
    return None


def load_eval_set(path: str, required: bool) -> EvalSet:
    path = os.path.expanduser(path)
    es = EvalSet(path=path, required=required)
    if not os.path.exists(path):
        if required:
            raise MissingEvalSet(f"required eval set {path} is missing: refusing to call anything uncontaminated")
        return es
    with open(path, "rb") as f:
        raw = f.read()
    es.present = True
    es.sha256 = hashlib.sha256(raw).hexdigest()
    for line in raw.decode("utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            # A torn line in an eval set means we can't know what it held.
            raise MissingEvalSet(f"eval set {path} has an unparseable line; fix it before building data")
        p = _prompt_of(row)
        if p is None:
            continue
        # Trust the file's own id when it has one (parity writes it), else compute it.
        pid = row.get("id") if isinstance(row.get("id"), str) else prompt_id(p)
        es.ids.add(pid)
        es.ids.add(prompt_id(p))
        es.entries.append((pid, word_set(p)))
        es.n += 1
    return es


@dataclass
class Match:
    eval_set: str
    eval_id: str
    reason: str  # 'exact' | 'jaccard' | 'containment'
    score: float

    def as_dict(self) -> Dict[str, object]:
        return {"evalSet": self.eval_set, "evalId": self.eval_id, "reason": self.reason, "score": round(self.score, 3)}


class ContaminationGuard:
    def __init__(self, sets: Sequence[EvalSet], jaccard_threshold: float = GUARD_JACCARD, containment_threshold: float = CONTAINMENT_THRESHOLD):
        if not any(s.present for s in sets):
            raise MissingEvalSet("no eval set is present: the guard has nothing to guard against")
        self.sets = list(sets)
        self.jaccard_threshold = jaccard_threshold
        self.containment_threshold = containment_threshold

    @classmethod
    def from_paths(cls, required: Iterable[str], optional: Iterable[str] = (), **kw) -> "ContaminationGuard":
        sets = [load_eval_set(p, True) for p in required] + [load_eval_set(p, False) for p in optional]
        return cls(sets, **kw)

    def match(self, prompt: str) -> Optional[Match]:
        """The first eval prompt this prompt collides with, or None when it is clean."""
        pid = prompt_id(prompt)
        for s in self.sets:
            if pid in s.ids:
                return Match(s.path, pid, "exact", 1.0)
        words = word_set(prompt)
        for s in self.sets:
            for eid, ewords in s.entries:
                j = jaccard(words, ewords)
                if j >= self.jaccard_threshold:
                    return Match(s.path, eid, "jaccard", j)
                c = containment(words, ewords)
                if c >= self.containment_threshold:
                    return Match(s.path, eid, "containment", c)
        return None

    def describe(self) -> Dict[str, object]:
        return {
            "jaccard": self.jaccard_threshold,
            "containment": self.containment_threshold,
            "normalize": "apps/parity/src/prompts.ts normalize (ported in parity_text.py)",
            "evalSets": [s.describe() for s in self.sets],
        }


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--eval-set", action="append", default=[], help="required eval set (repeatable)")
    ap.add_argument("--optional-eval-set", action="append", default=[], help="checked when present (repeatable)")
    ap.add_argument("files", nargs="+", help="JSONL files whose prompts to check")
    a = ap.parse_args(argv)
    if not a.eval_set:
        ap.error("at least one --eval-set is required")
    try:
        guard = ContaminationGuard.from_paths(a.eval_set, a.optional_eval_set)
    except MissingEvalSet as e:
        print(f"contamination: {e}", file=sys.stderr)
        return 2
    hits = 0
    for path in a.files:
        with open(path) as f:
            lines = f.readlines()
        for i, line in enumerate(lines, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            p = _prompt_of(row)
            if p is None and isinstance(row.get("messages"), list):
                users = [m.get("content") for m in row["messages"] if m.get("role") == "user" and isinstance(m.get("content"), str)]
                p = users[-1] if users else None
            if p is None:
                continue
            m = guard.match(p)
            if m:
                hits += 1
                print(json.dumps({"file": path, "line": i, **m.as_dict(), "prompt": normalize(p)[:120]}))
    print(f"contamination: {hits} overlapping row(s)", file=sys.stderr)
    return 3 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
