#!/usr/bin/env python3
"""Sharp eval: Claude judges, head-to-head, whether Flint (base+adapter) gives a
better answer than the base model — accuracy, clarity, structure, helpfulness.
Position-randomized to kill order bias. The real verdict the embedding metric
couldn't give."""
import json, os, urllib.request, random

BRAIN = os.path.expanduser("~/.flint/brain")
HOLDOUT = os.path.join(BRAIN, "holdout.jsonl")
BASE = os.environ.get("BASE_MODEL", "mlx-community/Qwen2.5-7B-Instruct-4bit")
ADAPTER = os.environ.get("ADAPTER", os.path.join(BRAIN, "adapters7b"))
MAXTOK = 360
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "claude-sonnet-4-6")

def anthropic_key():
    for line in open(os.path.expanduser("~/.flint/secrets.env")):
        line = line.strip()
        if line.startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("no ANTHROPIC_API_KEY in ~/.flint/secrets.env")

KEY = anthropic_key()

def judge(question, ans_a, ans_b):
    system = ("You are a strict evaluator. Compare two answers to the same question and decide which "
              "is better overall — more accurate, clear, well-structured, and genuinely helpful. "
              "Ignore length unless it hurts quality. Reply with EXACTLY one token: A, B, or TIE.")
    user = f"Question:\n{question}\n\nAnswer A:\n{ans_a}\n\nAnswer B:\n{ans_b}\n\nWhich is better? Reply A, B, or TIE."
    body = {"model": JUDGE_MODEL, "max_tokens": 5, "system": system,
            "messages": [{"role": "user", "content": user}]}
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
        headers={"x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    t = json.loads(urllib.request.urlopen(req, timeout=60).read())["content"][0]["text"].strip().upper()
    return "A" if t.startswith("A") else ("B" if t.startswith("B") else "TIE")

def gen_all(prompts, adapter):
    from mlx_lm import load, generate
    model, tok = load(BASE, adapter_path=adapter)
    outs = []
    for p in prompts:
        text = tok.apply_chat_template([{"role": "user", "content": p}], add_generation_prompt=True, tokenize=False)
        outs.append(generate(model, tok, prompt=text, max_tokens=MAXTOK, verbose=False).strip())
    del model, tok
    return outs

def main():
    rows = [json.loads(l) for l in open(HOLDOUT) if l.strip()][:int(os.environ.get("EVAL_N", "10"))]
    prompts = [r["input"] for r in rows]
    print(f"LLM-judge eval on {len(rows)} held-out prompts — student: {BASE}\n", flush=True)
    print("generating BASE answers...", flush=True); base = gen_all(prompts, None)
    print("generating FLINT answers...", flush=True); flint = gen_all(prompts, ADAPTER)

    fw = bw = tie = 0
    random.seed(1)
    for q, b, f in zip(prompts, base, flint):
        flint_is_A = random.random() < 0.5
        a_ans, b_ans = (f, b) if flint_is_A else (b, f)
        v = judge(q, a_ans, b_ans)
        if v == "TIE":
            tie += 1
        elif (v == "A") == flint_is_A:
            fw += 1
        else:
            bw += 1

    n = len(rows)
    print("\n================ JUDGE RESULT ================")
    print(f"Flint wins: {fw}/{n}   Base wins: {bw}/{n}   Ties: {tie}/{n}")
    print("verdict:", "✅ Flint is better — the owned brain absorbed real capability" if fw > bw
          else ("≈ roughly even — needs more training data" if fw == bw else "❌ base still better — more data/iters needed"))
    print("=============================================")

if __name__ == "__main__":
    main()
