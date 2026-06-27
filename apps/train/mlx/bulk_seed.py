#!/usr/bin/env python3
"""Bulk-grow the training corpus toward ~1000 examples.
Stage 1: Claude generates a large, diverse set of PUBLIC questions.
Stage 2: fire them at Flint concurrently so Claude's ANSWERS are captured as
teacher data (~/.flint/training/corpus.jsonl). Public questions only -> they
route to the frontier/teacher brain."""
import json, os, urllib.request, subprocess, concurrent.futures as cf, time, re

TOKEN = subprocess.check_output(
    ["/usr/libexec/PlistBuddy", "-c", "Print :EnvironmentVariables:FLINT_TOKEN",
     "/Users/willfoti/Library/LaunchAgents/com.flint.server.plist"]).decode().strip()

def anthropic_key():
    for line in open(os.path.expanduser("~/.flint/secrets.env")):
        line = line.strip()
        if line.startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("no ANTHROPIC_API_KEY")
KEY = anthropic_key()

THEMES = [
  "how things work in science and engineering", "computer science, programming, and software design",
  "world history and historical events", "health, fitness, nutrition, and the human body",
  "personal finance, economics, and markets", "philosophy, ethics, and big ideas",
  "practical how-to and life skills", "clear writing and communication",
  "math, probability, statistics, and logic puzzles", "business strategy and decision-making",
  "everyday curiosity and 'why does X happen'", "psychology and human behavior",
  "nature, space, and the environment", "technology trends and how modern systems work",
  "law, government, and how society is organized", "cooking, food science, and nutrition",
]

def gen_questions(theme):
    body = {"model": "claude-sonnet-4-6", "max_tokens": 1500,
        "system": "You generate diverse, specific, answerable questions a curious person would ask an AI. No numbering, one question per line, no preamble.",
        "messages": [{"role": "user", "content": f"List 55 diverse, specific questions about {theme}. One per line."}]}
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
        headers={"x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    try:
        txt = json.loads(urllib.request.urlopen(req, timeout=90).read())["content"][0]["text"]
    except Exception as e:
        print("  gen err:", str(e)[:50]); return []
    out = []
    for line in txt.splitlines():
        q = re.sub(r"^\s*[-*\d.)]+\s*", "", line).strip()
        if len(q) > 12 and q.endswith("?"):
            out.append(q)
    return out

def ask(args):
    i, q = args
    body = json.dumps({"conversationId": f"bulk-{i}", "message": q}).encode()
    req = urllib.request.Request("http://127.0.0.1:8080/chat", data=body,
        headers={"authorization": "Bearer " + TOKEN, "content-type": "application/json"})
    try:
        got = False
        for raw in urllib.request.urlopen(req, timeout=120):
            line = raw.decode().strip()
            if line.startswith("data:") and json.loads(line[5:]).get("type") == "text":
                got = True
        return got
    except Exception:
        return False

def main():
    print("stage 1: generating questions via Claude...", flush=True)
    qs = []
    for t in THEMES:
        qs += gen_questions(t)
        print(f"  +{t[:30]}... total={len(qs)}", flush=True)
    # dedupe
    seen, uniq = set(), []
    for q in qs:
        k = q.lower()
        if k not in seen:
            seen.add(k); uniq.append(q)
    print(f"stage 1 done: {len(uniq)} unique questions", flush=True)

    print("stage 2: capturing Claude's answers (concurrency 5)...", flush=True)
    done = 0
    with cf.ThreadPoolExecutor(max_workers=5) as ex:
        for ok in ex.map(ask, list(enumerate(uniq))):
            done += 1
            if done % 25 == 0:
                print(f"  {done}/{len(uniq)} captured", flush=True)
    print(f"bulk seed done: fired {len(uniq)} questions.", flush=True)

if __name__ == "__main__":
    main()
