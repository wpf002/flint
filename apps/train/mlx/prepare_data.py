#!/usr/bin/env python3
"""corpus.jsonl -> MLX-LM chat training set.

Takes the captured TEACHER (Claude) interactions and writes train/valid splits
in the format mlx_lm.lora expects ({"messages":[user, assistant]}). The student
model learns to reproduce the teacher's answers.

TWO THINGS THIS FIXES (2026-09-06), both of which made the weekly loop unable to
teach Flint anything or to tell you whether it had:

1. MIX. train.jsonl was 705 personal rows against ~49,749 public ones (98.6%
   public). retrain.sh draws ~1000 random examples per run, so a weekly run saw
   roughly FOURTEEN of your examples. It burned hours of GPU and was
   arithmetically incapable of moving the model toward your voice or systems.
   Personal rows are now OVERSAMPLED to a target share of the training set, and
   the actual ratio is printed and logged so it can never silently drift again.

2. HOLDOUT. The eval set was capped at 12 rows and re-derived by shuffling a
   GROWING corpus each run — same seed, different input list, so every week
   scored a different set of prompts and consecutive runs were not comparable.
   The holdout is now FROZEN on disk by prompt key, reused forever, and excluded
   from train/valid by that key. Growing the corpus adds to train, never to the
   yardstick.

Env knobs:
  HOLDOUT_N        target frozen-holdout size (default 150)
  PERSONAL_SHARE   target fraction of train that is your data (default 0.35)
  PUBLIC_CAP       hard cap on public rows mixed in (default 20000; 0 = none)
"""
import json, os, random, sys

CORPUS = os.path.expanduser("~/.flint/training/corpus.jsonl")
OUT = os.path.expanduser("~/.flint/brain/data")
HOLDOUT = os.path.expanduser("~/.flint/brain/holdout.jsonl")      # eval set (teacher answers kept)
HOLDOUT_KEYS = os.path.expanduser("~/.flint/brain/holdout_keys.json")  # FROZEN membership
PUBLIC = os.path.expanduser("~/.flint/brain/data/public.jsonl")   # free open datasets (breadth)

HOLDOUT_N = int(os.environ.get("HOLDOUT_N", "150"))
PERSONAL_SHARE = float(os.environ.get("PERSONAL_SHARE", "0.35"))
PUBLIC_CAP = int(os.environ.get("PUBLIC_CAP", "20000"))


def key_of(text):
    """Stable identity for a prompt — the holdout is frozen on this."""
    return " ".join(text.lower().split())


def load_public():
    rows = []
    if not os.path.exists(PUBLIC):
        return rows
    for line in open(PUBLIC):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        inp = (r.get("input") or "").strip()
        out = (r.get("output") or "").strip()
        if len(inp) >= 4 and len(out) >= 20:
            rows.append({"input": inp, "output": out})
    return rows


def load():
    rows = []
    seen = set()
    with open(CORPUS) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            # teacher signal only — Claude's answers are what we distill
            if r.get("brain") != "frontier":
                continue
            inp = (r.get("input") or "").strip()
            out = (r.get("output") or "").strip()
            if len(inp) < 3 or len(out) < 20:
                continue
            k = key_of(inp)
            if k in seen:
                continue
            seen.add(k)
            rows.append({"input": inp, "output": out})
    return rows


def frozen_holdout(rows):
    """Return (holdout_rows, holdout_key_set).

    The membership list is written ONCE and then only ever topped up if the file
    is short of target — never re-drawn. That is what makes week-over-week
    numbers comparable.
    """
    keys = []
    if os.path.exists(HOLDOUT_KEYS):
        try:
            keys = json.load(open(HOLDOUT_KEYS)).get("keys", [])
        except Exception:
            keys = []
    kset = set(keys)
    by_key = {key_of(r["input"]): r for r in rows}

    # Top up toward the target from rows not already held out (first run: fills it).
    if len(kset) < HOLDOUT_N:
        candidates = [k for k in by_key if k not in kset]
        random.Random(7).shuffle(candidates)  # fixed seed, but only for NEW picks
        take = candidates[: HOLDOUT_N - len(kset)]
        keys.extend(take)
        kset.update(take)
        json.dump({"keys": keys}, open(HOLDOUT_KEYS, "w"), indent=0)

    held = [by_key[k] for k in keys if k in by_key]
    return held, kset


def main():
    rows = load()
    if len(rows) < 12:
        print(f"only {len(rows)} usable teacher examples — seed more first (need ~50+).")
        sys.exit(1)

    holdout, hkeys = frozen_holdout(rows)
    # Everything not frozen into the holdout is available to learn from.
    rest = [r for r in rows if key_of(r["input"]) not in hkeys]
    random.seed(7)
    random.shuffle(rest)

    n_val = min(40, max(4, len(rest) // 10))
    valid = rest[:n_val]
    personal = rest[n_val:]

    public = load_public()
    if PUBLIC_CAP > 0 and len(public) > PUBLIC_CAP:
        random.Random(11).shuffle(public)
        public = public[:PUBLIC_CAP]

    # OVERSAMPLE personal rows so they are actually a meaningful share of what a
    # run samples. Repeating your examples is the cheap, standard way to weight a
    # small high-value set against a large generic one.
    reps = 1
    if personal and PERSONAL_SHARE > 0 and public:
        # want: (p*reps) / (p*reps + pub) >= share  ->  reps >= share*pub / (p*(1-share))
        need = (PERSONAL_SHARE * len(public)) / (len(personal) * (1 - PERSONAL_SHARE))
        reps = max(1, int(round(need)))
    train = personal * reps + public
    random.shuffle(train)

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

    n_personal = len(personal) * reps
    share = (n_personal / len(train) * 100) if train else 0.0
    print(f"prepared: {len(train)} train / {len(valid)} valid / {len(holdout)} holdout (FROZEN)")
    print(f"  personal: {len(personal)} unique x{reps} = {n_personal} rows  ({share:.1f}% of train)")
    print(f"  public:   {len(public)} rows" + (f" (capped at {PUBLIC_CAP})" if PUBLIC_CAP else ""))
    print(f"  -> {OUT}/train.jsonl, valid.jsonl ; holdout -> {HOLDOUT}")
    # Machine-readable line so retrain.sh can put the ratio in history.log.
    print(f"MIX personal={n_personal} public={len(public)} share={share:.1f} holdout={len(holdout)}")


if __name__ == "__main__":
    main()
