#!/usr/bin/env python3
"""Seed Flint's training corpus with diverse TEACHER (Claude) examples.
Fires public-knowledge prompts at /chat; the server's TrainingLogger captures
each Claude answer to ~/.flint/training/corpus.jsonl. Run in background."""
import json, time, urllib.request, subprocess, sys

TOKEN = subprocess.check_output(
    ["/usr/libexec/PlistBuddy", "-c", "Print :EnvironmentVariables:FLINT_TOKEN",
     "/Users/willfoti/Library/LaunchAgents/com.flint.server.plist"]).decode().strip()

# Diverse PUBLIC prompts (route to the frontier/teacher brain). Variety matters
# more than count for proving the distillation loop.
PROMPTS = [
  # science / how things work
  "Explain how a transistor works in simple terms.",
  "Why is the sky blue but sunsets red?",
  "How does mRNA vaccine technology work?",
  "What causes the seasons to change?",
  "How do noise-cancelling headphones work?",
  "Explain how GPS determines your location.",
  "What is CRISPR and how does it edit genes?",
  "How does a nuclear reactor generate electricity?",
  "Why does ice float on water?",
  "How do solar panels convert light into electricity?",
  "What is dark matter and why do scientists think it exists?",
  "How does the immune system fight off a virus?",
  "Explain photosynthesis at a high level.",
  "How do airplanes generate lift?",
  "What makes superconductors special?",
  # technical / coding
  "What's the difference between TCP and UDP?",
  "Explain the difference between processes and threads.",
  "When should I use a hash map versus a binary search tree?",
  "What is a race condition and how do you prevent one?",
  "Explain Big-O notation with a couple examples.",
  "What's the difference between SQL and NoSQL databases?",
  "How does public-key cryptography work?",
  "Explain what a deadlock is and how to avoid it.",
  "What is the difference between optimistic and pessimistic locking?",
  "How does garbage collection work in modern languages?",
  "Explain the CAP theorem and its practical tradeoffs.",
  "What is idempotency and why does it matter in APIs?",
  "Explain how a Bloom filter works and when to use one.",
  "What's the difference between authentication and authorization?",
  "How does HTTPS keep a connection secure?",
  "Explain eventual consistency in distributed systems.",
  "What is a memory leak and how do you find one?",
  "Explain the difference between latency and throughput.",
  "How does a load balancer distribute traffic?",
  "What are the tradeoffs between REST and gRPC?",
  # reasoning / advice / judgment
  "How should I think about whether to rent or buy a home?",
  "What's a sound framework for making a hard decision under uncertainty?",
  "How do I evaluate whether a startup idea is worth pursuing?",
  "What are the main tradeoffs between equity and salary in a job offer?",
  "How should a small team prioritize features with limited time?",
  "What's a good way to give difficult feedback to a colleague?",
  "How do I tell the difference between a sunk cost and a real investment?",
  "What questions should I ask before signing a contract?",
  "How do I build a habit that actually sticks?",
  "What's a reasonable way to think about diversifying investments?",
  # history / world
  "What were the main causes of World War I?",
  "Summarize the significance of the printing press.",
  "What was the Industrial Revolution and why did it matter?",
  "Explain the fall of the Roman Empire in brief.",
  "What was the Manhattan Project?",
  "Why was the discovery of penicillin so important?",
  "What were the key ideas of the Enlightenment?",
  "Summarize the space race between the US and USSR.",
  "What caused the 2008 financial crisis?",
  "Explain the significance of the Magna Carta.",
  # explanations / concepts
  "Explain compound interest and why it's powerful.",
  "What is opportunity cost?",
  "Explain inflation in plain terms.",
  "What is game theory and where is it used?",
  "Explain the concept of entropy.",
  "What does 'statistically significant' actually mean?",
  "Explain the difference between correlation and causation.",
  "What is a logical fallacy? Give three common ones.",
  "Explain Bayesian thinking with an everyday example.",
  "What is the placebo effect?",
  # comparisons
  "Compare electric cars and gas cars on total cost of ownership.",
  "What are the tradeoffs between coffee and tea for daily energy?",
  "Compare renting cloud servers versus owning hardware.",
  "Roth IRA vs traditional IRA — how do I choose?",
  "Compare Python and Rust for building a backend service.",
  "What's the difference between machine learning and deep learning?",
  "Compare solar and wind power for home energy.",
  # writing / language
  "Rewrite this to be more concise: 'Due to the fact that it was raining, we made the decision to stay inside.'",
  "Give me three strong subject lines for a cold outreach email.",
  "Explain the difference between 'affect' and 'effect'.",
  "Draft a polite message declining a meeting invitation.",
  "What makes a good opening sentence for an essay?",
  # math / logic
  "If a shirt is 30% off and then an extra 20% off, what's the total discount?",
  "Explain why 0.999... equals 1.",
  "What is the Monty Hall problem and what's the right strategy?",
  "How do I calculate compound annual growth rate?",
  "Explain the birthday paradox.",
  "What's the difference between mean, median, and mode?",
  # health / everyday
  "What actually happens to your body when you don't sleep enough?",
  "Why is strength training recommended as you age?",
  "What's the science behind intermittent fasting?",
  "How does caffeine affect the brain?",
  "Why does stretching help and when should you do it?",
  # general knowledge
  "How do credit scores actually work?",
  "What is the difference between weather and climate?",
  "How do central banks influence the economy?",
  "What is a supply chain and why do disruptions matter?",
  "How does the electoral college work?",
  "What makes a bridge able to hold so much weight?",
  "Why do onions make you cry and how do you stop it?",
  "How does a microwave oven heat food?",
  "What is the greenhouse effect?",
  "How do vaccines create herd immunity?",
]

def ask(msg, cid):
    body = json.dumps({"conversationId": cid, "message": msg}).encode()
    req = urllib.request.Request("http://127.0.0.1:8080/chat", data=body,
        headers={"authorization": "Bearer " + TOKEN, "content-type": "application/json"})
    brain = "?"; got = False
    try:
        for raw in urllib.request.urlopen(req, timeout=90):
            line = raw.decode().strip()
            if not line.startswith("data:"): continue
            ev = json.loads(line[5:])
            if ev.get("type") == "meta": brain = ev.get("brain", "?")
            if ev.get("type") == "text": got = True
    except Exception as e:
        return "err:" + str(e)[:40]
    return brain if got else "empty"

def main():
    n = len(PROMPTS)
    print(f"seeding {n} prompts...", flush=True)
    for i, p in enumerate(PROMPTS, 1):
        b = ask(p, f"seed-{i}")
        if i % 10 == 0 or i == n:
            print(f"  {i}/{n} (last brain={b})", flush=True)
        time.sleep(0.5)
    print("seeding done.", flush=True)

if __name__ == "__main__":
    main()
