#!/usr/bin/env python3
"""Did Flint-v0 absorb the teacher? For each held-out prompt, generate from the
BASE model and from BASE+adapter (Flint-v0), then score each answer's embedding
similarity to CLAUDE's answer (the teacher). If Flint-v0 is closer on average,
the distillation loop works."""
import json, os, sys, urllib.request, math

HOLDOUT = os.path.expanduser("~/.flint/brain/holdout.jsonl")
BASE = os.environ.get("BASE_MODEL", "mlx-community/Qwen2.5-7B-Instruct-4bit")
ADAPTER = os.path.expanduser("~/.flint/brain/adapters")
OLLAMA = "http://127.0.0.1:11434"
MAXTOK = 320

def embed(text):
    body = json.dumps({"model": "nomic-embed-text", "prompt": text[:6000]}).encode()
    req = urllib.request.Request(OLLAMA + "/api/embeddings", data=body, headers={"content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())["embedding"]

def cos(a, b):
    dot = sum(x*y for x, y in zip(a, b))
    na = math.sqrt(sum(x*x for x in a)); nb = math.sqrt(sum(y*y for y in b))
    return dot/(na*nb) if na and nb else 0.0

def gen_all(prompts, adapter=None):
    from mlx_lm import load, generate
    model, tok = load(BASE, adapter_path=adapter)
    outs = []
    for p in prompts:
        msgs = [{"role": "user", "content": p}]
        text = tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False)
        out = generate(model, tok, prompt=text, max_tokens=MAXTOK, verbose=False)
        outs.append(out.strip())
    del model, tok
    return outs

def main():
    rows = [json.loads(l) for l in open(HOLDOUT) if l.strip()]
    prompts = [r["input"] for r in rows]
    teacher = [r["output"] for r in rows]
    print(f"eval on {len(rows)} held-out prompts\n")

    print("generating BASE answers...", flush=True)
    base = gen_all(prompts, adapter=None)
    print("generating FLINT-v0 (base+adapter) answers...", flush=True)
    flint = gen_all(prompts, adapter=ADAPTER)

    tvec = [embed(t) for t in teacher]
    base_sim = [cos(embed(b), tv) for b, tv in zip(base, tvec)]
    flint_sim = [cos(embed(f), tv) for f, tv in zip(flint, tvec)]

    bavg = sum(base_sim)/len(base_sim)
    favg = sum(flint_sim)/len(flint_sim)
    wins = sum(1 for f, b in zip(flint_sim, base_sim) if f > b)
    print("\n================ RESULT ================")
    print(f"avg similarity to Claude  —  BASE: {bavg:.3f}   FLINT-v0: {favg:.3f}   (delta {favg-bavg:+.3f})")
    print(f"Flint-v0 closer to teacher on {wins}/{len(rows)} prompts")
    print("verdict:", "✅ LOOP WORKS — fine-tuning moved the student toward Claude" if favg > bavg
          else "❌ no improvement — adjust (more data / more iters / params)")
    print("========================================\n")

    for i in range(min(2, len(rows))):
        print(f"--- prompt: {prompts[i][:70]}")
        print(f"  CLAUDE : {teacher[i][:140]}")
        print(f"  BASE   : {base[i][:140]}")
        print(f"  FLINTv0: {flint[i][:140]}\n")

if __name__ == "__main__":
    main()
