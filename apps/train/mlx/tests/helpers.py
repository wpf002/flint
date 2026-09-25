"""Shared test helpers: temp eval sets, a small-data profile, row builders."""
import copy
import json
import os
import tempfile

import _path  # noqa: F401  (sys.path)
from profiles import load_profile

_BASE = load_profile("muse-glimmer-30b")


def small_profile(**train):
    """The default profile with thresholds sized for a handful of test rows."""
    p = copy.deepcopy(_BASE)
    p["train"].update({"min_train": 3, "min_valid": 1, "valid_n": 2, "min_reasoning_share": 0.0, "max_human_share": 0.3})
    p["train"].update(train)
    p["serve"]["think"] = False
    return p


def write_jsonl(path, rows):
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    return path


def temp_dir():
    return tempfile.mkdtemp(prefix="flint-train-test-")


def eval_set(dir_, prompts, name="parity_prompts.jsonl"):
    return write_jsonl(os.path.join(dir_, name), [{"id": f"e{i}", "prompt": p, "category": "knowledge"} for i, p in enumerate(prompts)])


LONG = "This is a thorough, specific answer with enough substance to be a real target. " * 2


def corpus_row(prompt, output=LONG, *, brain="frontier", model="claude-sonnet-4-6", cid="c100", tools=None, ts=1):
    return {"ts": ts, "id": ts, "conversationId": cid, "brain": brain, "model": model, "input": prompt, "output": output, "tools": tools or []}


def sample_row(prompt, output=LONG, *, kind="human", model="", checks=None, cid="c100", reasoning=None, messages=None, tools=None, ts=1):
    r = {"prompt": prompt, "conversationId": cid, "ts": ts, "teacher": {"kind": kind, "model": model}}
    if checks is not None:
        r["teacher"]["checks"] = checks
    if messages is not None:
        r["messages"] = messages
    else:
        r["output"] = output
    if reasoning:
        r["reasoning"] = reasoning
    if tools:
        r["tools"] = tools
    return r


def train_pool_cid(start=0):
    """Conversation ids that pool.py assigns to the train pool (so rows aren't dropped as eval-pool)."""
    from pool import pool_of

    i = start
    while True:
        cid = f"c{i}"
        if pool_of(cid, "x") == "train":
            yield cid
        i += 1


def eval_pool_cid():
    from pool import pool_of

    i = 0
    while True:
        cid = f"c{i}"
        if pool_of(cid, "x") == "eval":
            return cid
        i += 1
