#!/usr/bin/env python3
"""Data builder v2: the training set for one cycle, and a manifest of how it was made.

Replaces prepare_data.py, whose output could not produce a model that beats a
frontier model on anything: 98.6% OpenHermes, Claude's answers as targets, the
parity prompts inside the training set, no system prompt, and tool-using
answers without the tool calls (which teaches the model to state facts it never
looked up). What this does instead, in order:

  1. Collect candidate rows from the corpus (~/.flint/training/corpus.jsonl) and
     from sample batches (~/.flint/training/samples/*.jsonl, see README).
  2. Prompt filters. Drop prompts a vendor model wrote (the retired
     bulk_seed/auto_grow scripts), trivial prompts (parity's isTrivial),
     anything the contamination guard matches against the eval sets, and
     conversations in the eval pool (pool.py). What survives is an eligible
     prompt.
  3. Target filters. Drop targets whose provenance is not allowed
     (provenance.py: never a frontier vendor's output), the server's canned
     "no model answered" messages, answers under 40 characters, tool-using
     answers without their tool trajectory, and answers that visibly correct
     themselves mid-answer. Eligible prompts left without a target are written
     to prompts_for_sampling.jsonl for a compliant teacher to answer.
  4. Dedupe (exact + parity's near-duplicate rule) keeping human > self >
     open-weight, then a fixed, stratified valid split. Deduping first means no
     valid prompt has a near-duplicate in train.
  5. Render chat rows for mlx-lm: the live local system prompt when given
     (--local-prompt), one row per assistant turn so every turn is a masked
     target, tool definitions as they were sent.
  6. Re-check every rendered user turn against the guard. Any overlap is a hard
     failure (exit 3), never a warning.

Exit codes: 0 built, 4 NO_DATA (manifest written, nothing to train on),
3 contamination found after filtering, 2 error (missing eval set, bad profile).
Reads ~/.flint; writes only under --out.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import glob
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from contamination import ContaminationGuard, MissingEvalSet
from parity_text import NEAR_DUP_THRESHOLD, is_near_duplicate, is_trivial, normalize, prompt_id, source_of, word_set
from pool import pool_of
from profiles import ProfileError, load_profile
from provenance import judge_target, prompt_origin, teacher_of_corpus_row

BUILDER_VERSION = 2
EXIT_OK, EXIT_ERROR, EXIT_CONTAMINATED, EXIT_NO_DATA = 0, 2, 3, 4

HOME = os.path.expanduser("~")
TRAINING_DIR = os.environ.get("FLINT_TRAINING_DIR") or os.path.join(HOME, ".flint", "training")
DEFAULT_CORPUS = os.path.join(TRAINING_DIR, "corpus.jsonl")
DEFAULT_SAMPLES = os.path.join(TRAINING_DIR, "samples")
DEFAULT_EVAL_DIR = os.environ.get("PARITY_DIR") or os.path.join(HOME, ".flint", "eval")

MIN_ANSWER_CHARS = 40
# apps/server/src/unanswered.ts: the honest fallback messages' first sentences.
UNANSWERED_LEADS = ("I can't get you an answer on that one:", "I came back empty on that one:")
# A no-think answer that reasons in the open (apps/parity README): "He has 24
# sheep ... Wait, I made a calculation error". Never a target.
VISIBLE_REASONING = re.compile(r"(^|[.!?]\s+|\n)(Wait,|Hmm, wait|Let me re-read|Let me recompute|Correction:)", re.M)
KIND_PRIORITY = {"human": 0, "self": 1, "open-weight": 2}


@dataclass
class Row:
    prompt: str
    source: str
    conversation_id: str
    ts: int
    teacher: Dict[str, Any]
    messages: Optional[List[Dict[str, Any]]] = None  # trajectory from the first user turn on
    output: Optional[str] = None
    reasoning: Optional[str] = None
    tools_used: List[str] = field(default_factory=list)
    tool_defs: Optional[List[Dict[str, Any]]] = None
    kind: str = ""
    pid: str = ""

    def final_text(self) -> str:
        if self.messages:
            for m in reversed(self.messages):
                if m.get("role") == "assistant" and not m.get("tool_calls"):
                    return _text(m.get("content"))
            return ""
        return (self.output or "").strip()

    def user_turns(self) -> List[str]:
        if self.messages:
            return [_text(m.get("content")) for m in self.messages if m.get("role") == "user"]
        return [self.prompt]

    def has_tool_trajectory(self) -> bool:
        return bool(self.messages) and any(m.get("role") == "tool" or m.get("tool_calls") for m in self.messages)


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):  # [{type:'text', text}]
        return " ".join(str(p.get("text", "")) for p in content if isinstance(p, dict)).strip()
    return ""


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_jsonl(path: str) -> Iterable[Dict[str, Any]]:
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue  # a torn last line from a killed writer
            if isinstance(row, dict):
                yield row


def load_corpus(path: str) -> List[Row]:
    rows: List[Row] = []
    for r in _read_jsonl(path):
        prompt = str(r.get("input") or "").strip()
        rows.append(
            Row(
                prompt=prompt,
                source="corpus",
                conversation_id=str(r.get("conversationId") or ""),
                ts=int(r.get("ts") or 0),
                teacher=teacher_of_corpus_row(r),
                messages=r.get("messages") if isinstance(r.get("messages"), list) else None,
                output=str(r.get("output") or ""),
                tools_used=[str(t.get("tool")) for t in (r.get("tools") or []) if isinstance(t, dict) and t.get("tool")],
            )
        )
    return rows


def load_samples(paths: Sequence[str]) -> List[Row]:
    rows: List[Row] = []
    for path in paths:
        for r in _read_jsonl(path):
            msgs = r.get("messages") if isinstance(r.get("messages"), list) else None
            prompt = str(r.get("prompt") or "").strip()
            if not prompt and msgs:
                users = [_text(m.get("content")) for m in msgs if m.get("role") == "user"]
                prompt = users[-1] if users else ""
            rows.append(
                Row(
                    prompt=prompt,
                    source=f"samples:{os.path.basename(path)}",
                    conversation_id=str(r.get("conversationId") or ""),
                    ts=int(r.get("ts") or 0),
                    teacher=r.get("teacher") if isinstance(r.get("teacher"), dict) else {},
                    messages=msgs,
                    output=str(r.get("output") or "") if r.get("output") is not None else None,
                    reasoning=str(r.get("reasoning")) if r.get("reasoning") else None,
                    tool_defs=r.get("tools") if isinstance(r.get("tools"), list) else None,
                )
            )
    return rows


def normalize_tool_calls(messages: List[Dict[str, Any]]) -> Optional[List[Dict[str, Any]]]:
    """Chat templates (muse-glimmer's included) need tool_call arguments as a mapping, not a JSON string."""
    out = []
    for m in messages:
        m = dict(m)
        if m.get("tool_calls"):
            calls = []
            for tc in m["tool_calls"]:
                tc = json.loads(json.dumps(tc))
                fn = tc.get("function") or {}
                args = fn.get("arguments")
                if isinstance(args, str):
                    try:
                        args = json.loads(args) if args.strip() else {}
                    except json.JSONDecodeError:
                        return None
                if not isinstance(args, dict):
                    return None
                fn["arguments"] = args
                tc["function"] = fn
                calls.append(tc)
            m["tool_calls"] = calls
        out.append(m)
    return out


def dedupe(rows: List[Row]) -> Tuple[List[Row], int]:
    """Exact + parity near-duplicates, keeping the first after sorting human > self > open-weight, then oldest."""
    kept = _first_unique(sorted(rows, key=lambda r: (KIND_PRIORITY.get(r.kind, 9), r.ts, r.pid)))
    return kept, len(rows) - len(kept)


def dedupe_prompts(rows: List[Row]) -> List[Row]:
    """Prompts only: Will's own (organic) copy first, as parity's build does, then oldest."""
    return _first_unique(sorted(rows, key=lambda r: (source_of(r.conversation_id) == "synthetic", r.ts, r.pid)))


def _first_unique(ordered: List[Row]) -> List[Row]:
    kept: List[Tuple[Row, frozenset]] = []
    seen = set()
    for r in ordered:
        norm = normalize(r.prompt)
        if norm in seen:
            continue
        words = word_set(r.prompt)
        if any(is_near_duplicate(w, words, NEAR_DUP_THRESHOLD) for _, w in kept):
            continue
        seen.add(norm)
        kept.append((r, words))
    return [r for r, _ in kept]


def _rank(seed: int, pid: str) -> str:
    return hashlib.sha256(f"valid|{seed}|{pid}".encode()).hexdigest()


def split_valid(rows: List[Row], valid_n: int, seed: int) -> Tuple[List[Row], List[Row]]:
    """A fixed, stratified valid set: per kind, the lowest hash ranks, in proportion to the kind's share."""
    if not rows:
        return [], []
    valid_n = min(valid_n, len(rows) // 5) if len(rows) < valid_n * 5 else valid_n
    by_kind: Dict[str, List[Row]] = {}
    for r in rows:
        by_kind.setdefault(r.kind, []).append(r)
    valid_ids = set()
    for kind, items in sorted(by_kind.items()):
        quota = round(valid_n * len(items) / len(rows))
        for r in sorted(items, key=lambda r: _rank(seed, r.pid))[:quota]:
            valid_ids.add(r.pid)
    train = [r for r in rows if r.pid not in valid_ids]
    valid = [r for r in rows if r.pid in valid_ids]
    return train, valid


def render(row: Row, system: Optional[str], reasoning_key: str) -> List[Dict[str, Any]]:
    """mlx-lm chat rows: one per assistant turn (mask_prompt masks all but the last message)."""
    head = [{"role": "system", "content": system}] if system else []
    if row.messages:
        msgs = row.messages
        if msgs and msgs[0].get("role") == "system":
            # The sample recorded the exact system prompt it was answered under: that one wins.
            head, msgs = [msgs[0]], msgs[1:]
    else:
        final: Dict[str, Any] = {"role": "assistant", "content": row.final_text()}
        if row.reasoning:
            final[reasoning_key] = row.reasoning
        msgs = [{"role": "user", "content": row.prompt}, final]
    out = []
    for i, m in enumerate(msgs):
        if m.get("role") != "assistant":
            continue
        rendered: Dict[str, Any] = {"messages": head + msgs[: i + 1]}
        if row.tool_defs:
            rendered["tools"] = row.tool_defs
        out.append(rendered)
    return out


def repeat_factor(n_human: int, n_other: int, max_share: float) -> int:
    """Repeat Will-written rows up to twice, never past max_share of the training set."""
    if n_human == 0 or n_other == 0 or max_share <= 0:
        return 1
    r = int((max_share * n_other) / (n_human * (1 - max_share)))
    return max(1, min(2, r))


@dataclass
class BuildResult:
    status: str
    manifest: Dict[str, Any]
    train: List[Dict[str, Any]]
    valid: List[Dict[str, Any]]
    sampling_prompts: List[Dict[str, Any]]


def build(
    *,
    profile: Dict[str, Any],
    guard: ContaminationGuard,
    corpus_rows: List[Row],
    sample_rows: List[Row],
    local_prompt: Optional[Dict[str, Any]],
    seed: int = 1,
    sources: Optional[Dict[str, Any]] = None,
) -> BuildResult:
    tr = profile["train"]
    drops: Dict[str, int] = {}
    guard_hits: Dict[str, int] = {}

    def drop(reason: str) -> None:
        drops[reason] = drops.get(reason, 0) + 1

    eligible: List[Row] = []
    for r in corpus_rows + sample_rows:
        if not r.prompt:
            drop("empty-prompt")
            continue
        r.pid = prompt_id(r.prompt)
        if prompt_origin(r.conversation_id) == "frontier-generated":
            drop("prompt:frontier-generated")
            continue
        if is_trivial(r.prompt):
            drop("trivial-prompt")
            continue
        hit = next((m for m in (guard.match(u) for u in r.user_turns() if u) if m), None)
        if hit:
            drop("eval-overlap")
            guard_hits[hit.eval_set] = guard_hits.get(hit.eval_set, 0) + 1
            continue
        if pool_of(r.conversation_id, r.prompt) == "eval":
            drop("eval-pool")
            continue
        eligible.append(r)

    targets: List[Row] = []
    for r in eligible:
        v = judge_target(r.teacher, profile["base"]["self_models"], profile.get("teachers", {}))
        if not v.ok:
            drop(f"target:{v.reason}")
            continue
        r.kind = v.kind
        if r.messages is not None:
            fixed = normalize_tool_calls(r.messages)
            if fixed is None:
                drop("target:bad-tool-call")
                continue
            r.messages = fixed
        final = r.final_text()
        if final.startswith(UNANSWERED_LEADS):
            drop("target:unanswered")
            continue
        if len(final) < MIN_ANSWER_CHARS:
            drop("target:too-short")
            continue
        if r.tools_used and not r.has_tool_trajectory():
            drop("target:tools-without-trajectory")
            continue
        if VISIBLE_REASONING.search(final):
            drop("target:visible-reasoning")
            continue
        targets.append(r)

    targets, dup_count = dedupe(targets)
    if dup_count:
        drops["duplicate"] = dup_count

    # Will's prompts that still need a compliant answer: eligible, no kept target, not a near-dup of one.
    kept = {id(t) for t in targets}
    target_words = [word_set(t.prompt) for t in targets]
    sampling: List[Dict[str, Any]] = []
    for r in dedupe_prompts([r for r in eligible if id(r) not in kept]):
        w = word_set(r.prompt)
        if any(is_near_duplicate(w, tw) for tw in target_words):
            continue
        sampling.append({"id": r.pid, "prompt": r.prompt, "conversationId": r.conversation_id, "source": r.source, "origin": source_of(r.conversation_id)})

    train_rows, valid_rows = split_valid(targets, int(tr["valid_n"]), seed)
    n_human = sum(1 for r in train_rows if r.kind == "human")
    reps = repeat_factor(n_human, len(train_rows) - n_human, float(tr["max_human_share"]))

    system = (local_prompt or {}).get("system") or None
    rkey = profile["base"]["reasoning_key"]
    train: List[Dict[str, Any]] = []
    for r in train_rows:
        rendered = render(r, system, rkey)
        train.extend(rendered * (reps if r.kind == "human" else 1))
    valid = [x for r in valid_rows for x in render(r, system, rkey)]

    def has_reasoning(x: Dict[str, Any]) -> bool:
        return bool(x["messages"][-1].get(rkey))

    reasoning_share = (sum(1 for x in train if has_reasoning(x)) / len(train)) if train else 0.0

    # Backstop: every rendered user turn, re-checked. Any hit here is a bug upstream.
    overlap = {"train": 0, "valid": 0}
    for name, split in (("train", train), ("valid", valid)):
        for x in split:
            for m in x["messages"]:
                if m.get("role") == "user" and guard.match(_text(m.get("content"))):
                    overlap[name] += 1

    status, reason = "ok", ""
    if overlap["train"] or overlap["valid"]:
        status, reason = "CONTAMINATED", f"{overlap} rendered rows overlap an eval set after filtering"
    elif len(train_rows) < int(tr["min_train"]):
        status, reason = "NO_DATA", f"{len(train_rows)} unique target rows < min_train {tr['min_train']}"
    elif len(valid) < int(tr["min_valid"]):
        status, reason = "NO_DATA", f"{len(valid)} valid rows < min_valid {tr['min_valid']}"
    elif profile["serve"]["think"] and reasoning_share < float(tr["min_reasoning_share"]):
        status, reason = "NO_DATA", (
            f"only {reasoning_share:.0%} of rows carry {rkey}; serving with thinking on needs >= "
            f"{float(tr['min_reasoning_share']):.0%} or training erodes the reasoning channel"
        )

    by_kind: Dict[str, int] = {}
    for r in targets:
        by_kind[r.kind] = by_kind.get(r.kind, 0) + 1
    by_source: Dict[str, int] = {}
    for r in targets:
        by_source[r.source] = by_source.get(r.source, 0) + 1

    manifest = {
        "builderVersion": BUILDER_VERSION,
        "builtAt": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "status": status,
        "statusReason": reason,
        "seed": seed,
        "profile": {
            "name": profile["name"],
            "path": profile.get("_path"),
            "sha256": profile.get("_sha256"),
            "mlxModel": profile["base"]["mlx_model"],
            "ollamaLive": profile["base"]["ollama_live"],
            "serveThink": profile["serve"]["think"],
            "serveVariant": profile["serve"]["variant"],
        },
        "sources": sources or {},
        "localPrompt": ({"sha": local_prompt.get("sha"), "path": local_prompt.get("_path")} if local_prompt else None),
        "counts": {
            "candidates": len(corpus_rows) + len(sample_rows),
            "eligiblePrompts": len(eligible),
            "targets": len(targets),
            "trainTargets": len(train_rows),
            "validTargets": len(valid_rows),
            "trainRows": len(train),
            "validRows": len(valid),
            "byKind": by_kind,
            "bySource": by_source,
            "humanRepeat": reps,
            "samplingPrompts": len(sampling),
        },
        "reasoningShare": round(reasoning_share, 3),
        "drops": dict(sorted(drops.items())),
        "guard": {**guard.describe(), "droppedByEvalSet": guard_hits, "overlap": overlap},
        "promptIds": {"train": sorted({r.pid for r in train_rows}), "valid": sorted({r.pid for r in valid_rows})},
    }
    return BuildResult(status, manifest, train, valid, sampling)


def _write_jsonl(path: str, rows: Iterable[Dict[str, Any]]) -> None:
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Build one cycle's training data (see module docstring).")
    ap.add_argument("--profile", default=None, help="profile name or path (default: FLINT_BRAIN_PROFILE or muse-glimmer-30b)")
    ap.add_argument("--corpus", default=DEFAULT_CORPUS)
    ap.add_argument("--samples-dir", default=DEFAULT_SAMPLES)
    ap.add_argument("--eval-set", action="append", default=None, help="required eval set (default: parity_prompts.jsonl)")
    ap.add_argument("--optional-eval-set", action="append", default=None, help="guarded when present (default: flint_tasks.jsonl)")
    ap.add_argument("--local-prompt", default=None, help='JSON {"system", "sha"}: the live local system prompt')
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", help="output dir (train.jsonl, valid.jsonl, manifest.json, prompts_for_sampling.jsonl)")
    ap.add_argument("--count-only", action="store_true", help="print counts and a source fingerprint as JSON; write nothing")
    a = ap.parse_args(argv)
    if not a.count_only and not a.out:
        ap.error("--out is required (or --count-only)")

    required = a.eval_set or [os.path.join(DEFAULT_EVAL_DIR, "parity_prompts.jsonl")]
    optional = a.optional_eval_set if a.optional_eval_set is not None else [os.path.join(DEFAULT_EVAL_DIR, "flint_tasks.jsonl")]
    try:
        profile = load_profile(a.profile)
        guard = ContaminationGuard.from_paths(required, optional)
    except (ProfileError, MissingEvalSet) as e:
        print(f"build_data: {e}", file=sys.stderr)
        return EXIT_ERROR

    sources: Dict[str, Any] = {}
    corpus_rows: List[Row] = []
    if os.path.exists(a.corpus):
        corpus_rows = load_corpus(a.corpus)
        sources["corpus"] = {"path": a.corpus, "sha256": _sha256_file(a.corpus), "rows": len(corpus_rows)}
    sample_paths = sorted(glob.glob(os.path.join(a.samples_dir, "*.jsonl"))) if os.path.isdir(a.samples_dir) else []
    sample_rows = load_samples(sample_paths)
    sources["samples"] = [{"path": p, "sha256": _sha256_file(p)} for p in sample_paths]

    local_prompt = None
    if a.local_prompt:
        with open(a.local_prompt) as f:
            local_prompt = json.load(f)
        if not isinstance(local_prompt, dict) or not local_prompt.get("system"):
            print(f"build_data: {a.local_prompt} has no `system`", file=sys.stderr)
            return EXIT_ERROR
        local_prompt["_path"] = a.local_prompt
        local_prompt.setdefault("sha", hashlib.sha256(local_prompt["system"].encode()).hexdigest()[:16])
    elif not a.count_only:
        print(
            "build_data: WARNING no --local-prompt: rows are rendered without the live local system prompt, so the "
            "model trains on a context it is never served in. The gate still judges the served model; this only wastes the run.",
            file=sys.stderr,
        )

    res = build(profile=profile, guard=guard, corpus_rows=corpus_rows, sample_rows=sample_rows, local_prompt=local_prompt, seed=a.seed, sources=sources)
    fingerprint = hashlib.sha256(
        json.dumps({"corpus": sources.get("corpus", {}).get("sha256"), "samples": sources["samples"], "profile": profile["_sha256"]}, sort_keys=True).encode()
    ).hexdigest()[:16]
    res.manifest["sourceFingerprint"] = fingerprint

    if a.count_only:
        c = res.manifest["counts"]
        print(json.dumps({"status": res.status, "targets": c["targets"], "trainTargets": c["trainTargets"], "samplingPrompts": c["samplingPrompts"], "fingerprint": fingerprint, "drops": res.manifest["drops"]}))
        return EXIT_OK

    os.makedirs(a.out, exist_ok=True)
    _write_jsonl(os.path.join(a.out, "prompts_for_sampling.jsonl"), res.sampling_prompts)
    if res.status == "ok":
        _write_jsonl(os.path.join(a.out, "train.jsonl"), res.train)
        _write_jsonl(os.path.join(a.out, "valid.jsonl"), res.valid)
    with open(os.path.join(a.out, "manifest.json"), "w") as f:
        json.dump(res.manifest, f, indent=2)
        f.write("\n")

    c = res.manifest["counts"]
    print(
        f"build_data: {res.status} train_n={c['trainRows']} valid_n={c['validRows']} targets={c['targets']} "
        f"by_kind={c['byKind']} sampling_prompts={c['samplingPrompts']} -> {a.out}",
        file=sys.stderr,
    )
    print(f"build_data: drops {res.manifest['drops']}", file=sys.stderr)
    if res.status == "CONTAMINATED":
        print(f"build_data: {res.manifest['statusReason']}", file=sys.stderr)
        return EXIT_CONTAMINATED
    if res.status == "NO_DATA":
        print(f"build_data: NO_DATA: {res.manifest['statusReason']}", file=sys.stderr)
        return EXIT_NO_DATA
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
