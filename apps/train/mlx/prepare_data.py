#!/usr/bin/env python3
"""corpus.jsonl -> MLX-LM chat training set.
Takes the captured TEACHER (Claude) interactions and writes train/valid splits
in the format mlx_lm.lora expects ({"messages":[user, assistant]}). The student
model learns to reproduce the teacher's answers."""
import json, os, random, sys

CORPUS = os.path.expanduser("~/.flint/training/corpus.jsonl")
OUT = os.path.expanduser("~/.flint/brain/data")
HOLDOUT = os.path.expanduser("~/.flint/brain/holdout.jsonl")  # for eval (teacher answers kept)

def load():
    rows = []
    seen = set()
    with open(CORPUS) as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try: r = json.loads(line)
            except: continue
            # teacher signal only — Claude's answers are what we distill
            if r.get("brain") != "frontier": continue
            inp = (r.get("input") or "").strip()
            out = (r.get("output") or "").strip()
            if len(inp) < 3 or len(out) < 20: continue
            key = inp.lower()
            if key in seen: continue
            seen.add(key)
            rows.append({"input": inp, "output": out})
    return rows

def main():
    rows = load()
    if len(rows) < 12:
        print(f"only {len(rows)} usable teacher examples — seed more first (need ~50+).")
        sys.exit(1)
    random.seed(7)
    random.shuffle(rows)
    n_val = min(12, max(4, len(rows) // 10))
    n_hold = min(12, max(6, len(rows) // 10))
    holdout = rows[:n_hold]
    valid = rows[n_hold:n_hold + n_val]
    train = rows[n_hold + n_val:]
    os.makedirs(OUT, exist_ok=True)

    def to_chat(r):
        return {"messages": [
            {"role": "user", "content": r["input"]},
            {"role": "assistant", "content": r["output"]},
        ]}

    for name, split in [("train", train), ("valid", valid)]:
        with open(os.path.join(OUT, name + ".jsonl"), "w") as f:
            for r in split:
                f.write(json.dumps(to_chat(r)) + "\n")
    # holdout keeps the teacher answer so eval can measure "closeness to teacher"
    with open(HOLDOUT, "w") as f:
        for r in holdout:
            f.write(json.dumps(r) + "\n")

    print(f"prepared: {len(train)} train / {len(valid)} valid / {len(holdout)} holdout (eval)")
    print(f"  -> {OUT}/train.jsonl, valid.jsonl ; holdout -> {HOLDOUT}")

if __name__ == "__main__":
    main()
