"""Exact Python ports of apps/parity/src/prompts.ts's prompt identity and filters.

The contamination guard is only as good as its agreement with the parity
harness: a prompt the harness calls `00100cd7a076` must be `00100cd7a076` here
too, and two prompts parity treats as the same question must be the same
question here. So nothing in this file is "inspired by" prompts.ts; each
function is a line-for-line port, and apps/parity/test/fixtures/normalize-cases.json
is checked by both vitest (test/normalize-fixture.test.ts) and unittest
(tests/test_parity_text.py). If you change one side, the other side's test fails.

Stdlib only: this runs in the training venv and in plain python3 for the tests.
"""
from __future__ import annotations

import hashlib
import re

# prompts.ts normalize(): lower-case, curly apostrophes to ', anything that is not
# [a-z0-9' ] to a space, collapse whitespace, trim. After the third step the only
# whitespace left is ASCII space, so JS's and Python's different ideas of \s and
# trim() cannot disagree.
_CURLY = re.compile("[‘’]")
_NOT_KEPT = re.compile(r"[^a-z0-9' ]+")
_SPACES = re.compile(r"\s+")


def normalize(s: str) -> str:
    s = s.lower()
    s = _CURLY.sub("'", s)
    s = _NOT_KEPT.sub(" ", s)
    s = _SPACES.sub(" ", s)
    return s.strip()


def prompt_id(prompt: str) -> str:
    """parity's EvalPrompt.id: sha256 of the normalized (trimmed) prompt, 12 hex chars."""
    return hashlib.sha256(normalize(prompt.strip()).encode("utf-8")).hexdigest()[:12]


def word_count(s: str) -> int:
    """categorize.ts wordCount(): whitespace-separated tokens of the trimmed string."""
    return len([w for w in s.strip().split() if w])


STOPWORDS = frozenset(
    (
        "a an the of in on at to for from by with and or but is are was were be been do does did you your i me my we our it its "
        "this that these those what which who whom how why when where can could would should will shall may might about as into "
        "than then there their they them he she his her so if not no just also more most some any all tell explain"
    ).split(" ")
)


def word_set(s: str) -> frozenset:
    """Content words only (prompts.ts wordSet)."""
    return frozenset(w for w in normalize(s).split(" ") if w and w not in STOPWORDS)


def jaccard(a: frozenset, b: frozenset) -> float:
    if not a and not b:
        return 1.0
    inter = len(a & b)
    return inter / (len(a) + len(b) - inter)


NEAR_DUP_THRESHOLD = 0.8
CONTAINMENT_THRESHOLD = 0.8


def containment(a: frozenset, b: frozenset) -> float:
    """Share of the smaller set inside the larger; 0 when the smaller has < 3 words."""
    small, big = (a, b) if len(a) <= len(b) else (b, a)
    if len(small) < 3:
        return 0.0
    return len(small & big) / len(small)


def is_near_duplicate(a: frozenset, b: frozenset, threshold: float = NEAR_DUP_THRESHOLD) -> bool:
    """prompts.ts isNearDuplicate(): Jaccard >= threshold, or a 3+ word set >= 80% contained in the other."""
    if jaccard(a, b) >= threshold:
        return True
    return containment(a, b) >= CONTAINMENT_THRESHOLD


# prompts.ts isTrivial() and its three patterns, byte for byte. The input to the
# patterns is already normalized ASCII, so JS's ASCII \b and Python's Unicode \b
# see the same boundaries.
_GREETING = re.compile(
    r"^(hey|hi|hello|yo|sup|howdy|good (morning|afternoon|evening|night)|gm|thanks|thank you|ty|ok|okay|cool|nice|great|awesome|lol|how are (you|we)|how'?s it going|what'?s up)\b"
)
_GREETING_REAL_ASK = re.compile(r"\?.*\S.*\?|\b(what|why|how|who|when|where|tell me)\b.{25,}")
_FOLLOW_UP = re.compile(
    r"^(yes|yeah|yep|no|nope|nah|right|well|sure|go ahead|do it|continue|again|show it|that'?s|and|but|so|here are|here is|here's|i meant|i mean|i'?m referencing|i was referring)\b"
)
_PROBE = re.compile(
    r"^(say|reply( with)?|respond( with)?|repeat|echo|print|ping|test)\b|\b(answer with|one line|nothing else|reply with exactly)\b"
)
_BARE_URL = re.compile(r"^https?://\S+$")


def is_trivial(prompt: str) -> bool:
    n = normalize(prompt)
    words = word_count(n)
    if words < 3:
        return True
    if _BARE_URL.match(prompt.strip()):
        return True
    # JS RegExp.test() searches anywhere; re.search is the equivalent.
    if _GREETING.search(n) and words <= 10 and not _GREETING_REAL_ASK.search(n):
        return True
    if _FOLLOW_UP.search(n) and words <= 20:
        return True
    if _PROBE.search(n) and words <= 16:
        return True
    return False


_SYNTHETIC_CONV = re.compile(r"^(bulk|grow|seed|verify)[-_]", re.I)


def source_of(conversation_id: str) -> str:
    """'synthetic' for the retired seeding scripts' conversation ids, else 'organic'."""
    return "synthetic" if _SYNTHETIC_CONV.match(conversation_id or "") else "organic"
