"""Which future conversations are for training and which are for measuring.

Today the eval set and the training data are the same data (parity_prompts.jsonl
was built from corpus.jsonl). The prompt-level guard (contamination.py) removes
the overlap after the fact; this split keeps it from happening again. Every
conversation is assigned, forever, to one pool by a hash:

    pool = 'eval'  if int(sha256(key)[:8], 16) % 10 < 3   (30%)
           'train' otherwise

- flint_tasks.jsonl (Will's real tasks, the gate's second set) may only be built
  from 'eval' conversations;
- build_data.py only trains on 'train' conversations.

The key is the conversation id, except for the shared buckets the server files
many unrelated turns under ('console', 'generate', 'default', ...): there a
conversation id says nothing about which turns belong together, and hashing it
would put all 31 console turns in the same pool. Those rows are keyed by the
parity prompt id instead, so the same question always lands in the same pool.

apps/parity/src/pool.ts is the TypeScript twin; apps/parity/test/fixtures/pool-cases.json
is checked by both.
"""
from __future__ import annotations

import hashlib

from parity_text import prompt_id

EVAL_SHARE_TENTHS = 3

# Conversation ids that are buckets, not conversations (see the server's
# /generate, the console and the old default).
SHARED_CONVERSATION_IDS = frozenset({"", "console", "generate", "default", "chat", "api"})


def pool_key(conversation_id: str, prompt: str) -> str:
    cid = (conversation_id or "").strip()
    if cid.lower() in SHARED_CONVERSATION_IDS:
        return f"prompt:{prompt_id(prompt)}"
    return f"conv:{cid}"


def pool_of(conversation_id: str, prompt: str) -> str:
    h = hashlib.sha256(pool_key(conversation_id, prompt).encode("utf-8")).hexdigest()
    return "eval" if int(h[:8], 16) % 10 < EVAL_SHARE_TENTHS else "train"
