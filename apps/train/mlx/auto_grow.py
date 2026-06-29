#!/usr/bin/env python3
"""Autonomous corpus growth — Flint trains itself.
On each run: Claude generates fresh, diverse questions (weighted to Will's
domains + general breadth), Flint captures Claude's ANSWERS as teacher data,
deduped against the existing corpus. Throttled + retried to survive rate limits.
Scheduled via launchd; the weekly retrain consumes what this produces.

Knobs (env): GROW_TARGET (new examples/run, default 150), GROW_CONCURRENCY (3)."""
import json, os, urllib.request, subprocess, re, random, concurrent.futures as cf

TARGET = int(os.environ.get("GROW_TARGET", "150"))
CONCURRENCY = int(os.environ.get("GROW_CONCURRENCY", "3"))
CORPUS = os.path.expanduser("~/.flint/training/corpus.jsonl")

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

# Weighted toward Will's world; the tail adds general breadth.
THEMES = [
  "quantitative trading, market microstructure, and algorithmic strategies",
  "financial markets, valuation, macro, and risk management",
  "cybersecurity, threat detection, red-teaming, and defensive engineering",
  "software architecture, distributed systems, and backend engineering",
  "AI/ML, LLMs, fine-tuning, RAG, and model evaluation",
  "data engineering, databases, and pipelines",
  "startup strategy, product, and business decision-making",
  "DevOps, infrastructure, observability, and reliability",
  "statistics, probability, and quantitative reasoning",
  "negotiation, leadership, and high-stakes decisions",
  "economics, incentives, and game theory",
  "science, how things work, and first-principles explanations",
  "history, geopolitics, and how the modern world got here",
  "writing, communication, and persuasion",
  "health, performance, longevity, and the body",
  "general curiosity and practical how-to",
]
DIFFICULTY = ["practical and concrete", "intermediate and nuanced",
              "hard, expert-level, and multi-step"]

def gen_questions(theme, level, n=40):
    body = {"model": "claude-sonnet-4-6", "max_tokens": 1400,
        "system": "You generate diverse, specific, answerable questions an expert would ask an AI. "
                  "One per line, no numbering, no preamble. End each with a question mark.",
        "messages": [{"role": "user", "content": f"List {n} {level} questions about {theme}. One per line."}]}
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
        headers={"x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    try:
        txt = json.loads(urllib.request.urlopen(req, timeout=90).read())["content"][0]["text"]
    except Exception:
        return []
    out = []
    for line in txt.splitlines():
        q = re.sub(r"^\s*[-*\d.)]+\s*", "", line).strip()
        if len(q) > 12 and q.endswith("?"):
            out.append(q)
    return out

def existing():
    s = set()
    if os.path.exists(CORPUS):
        for l in open(CORPUS):
            try: s.add(json.loads(l).get("input", "").strip().lower())
            except: pass
    return s

def ask(args):
    i, q = args
    for attempt in range(2):
        body = json.dumps({"conversationId": f"grow-{i}", "message": q}).encode()
        req = urllib.request.Request("http://127.0.0.1:8080/chat", data=body,
            headers={"authorization": "Bearer " + TOKEN, "content-type": "application/json"})
        try:
            for raw in urllib.request.urlopen(req, timeout=120):
                line = raw.decode().strip()
                if line.startswith("data:") and json.loads(line[5:]).get("type") == "text":
                    return True
        except Exception:
            continue
    return False

def main():
    seen = existing()
    fresh, themes = [], THEMES[:]
    random.shuffle(themes)
    ti = 0
    while len(fresh) < TARGET and ti < len(themes) * len(DIFFICULTY):
        theme = themes[ti % len(themes)]
        level = DIFFICULTY[ti % len(DIFFICULTY)]
        for q in gen_questions(theme, level):
            k = q.lower()
            if k not in seen:
                seen.add(k); fresh.append(q)
        ti += 1
    fresh = fresh[:TARGET]
    print(f"auto_grow: {len(fresh)} fresh questions; capturing...", flush=True)
    done = 0
    with cf.ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        for _ in ex.map(ask, list(enumerate(fresh))):
            done += 1
            if done % 25 == 0:
                print(f"  {done}/{len(fresh)}", flush=True)
    total = sum(1 for l in open(CORPUS) if l.strip())
    print(f"auto_grow done: +{len(fresh)} fired. corpus now ~{total} examples.", flush=True)

if __name__ == "__main__":
    main()
