#!/usr/bin/env python3
"""Pull free, high-quality instruction data (OpenHermes 2.5) into Flint's training
set — $0, no API. General-capability breadth; personal data stays the moat.
Writes ~/.flint/brain/data/public.jsonl as {input, output} pairs."""
import json, os
from datasets import load_dataset

N = int(os.environ.get("PULL_N", "50000"))
OUT = os.path.expanduser("~/.flint/brain/data/public.jsonl")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

ds = load_dataset("teknium/OpenHermes-2.5", split="train", streaming=True)
seen, count = set(), 0
with open(OUT, "w") as f:
    for ex in ds:
        convs = ex.get("conversations") or []
        user = asst = None
        for c in convs:
            if c.get("from") == "human" and user is None:
                user = (c.get("value") or "").strip()
            elif c.get("from") == "gpt" and user and asst is None:
                asst = (c.get("value") or "").strip()
                break
        if not user or not asst or len(user) < 4 or len(asst) < 20:
            continue
        k = user.lower()[:200]
        if k in seen:
            continue
        seen.add(k)
        f.write(json.dumps({"input": user, "output": asst}) + "\n")
        count += 1
        if count % 5000 == 0:
            print(f"  {count}/{N}", flush=True)
        if count >= N:
            break
print(f"pulled {count} free examples -> {OUT}", flush=True)
