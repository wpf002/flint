"""Whose answer is this, and may Flint's local model be trained on it?

The old pipeline distilled Claude: 757 of the corpus's 827 targets are
claude-sonnet-4-6 answers. Anthropic's terms prohibit using outputs "as
training targets for models" and to train general-purpose chatbots; OpenAI's
bar using output to develop competing models; Perplexity and Google have
equivalent clauses. So a target answer written by a frontier vendor's model is
never trained on here, whatever else is true of the row. There is no switch
for it: changing that is a deliberate code change, not a config flag.
(This is policy for this repo, not legal advice.)

What a target may come from, and nothing else (allow-list, fail closed):

- human       Will wrote the answer himself (a correction, a rewrite). Its
              `model` is empty or "will": a human row naming a model is refused.
- self        the base model's own answer (profile [base].self_models), and
              only if it passed at least one verifiable check (tests ran, the
              calculator agreed, the tool call matched its schema...) recorded
              in `checks`. Unfiltered self-samples teach nothing.
- open-weight a model listed in the profile's [teachers] table with a licence
              that permits training on its outputs (apache-2.0, mit). The
              licence comes from the profile, never from the row.

Prompts are different: Will's own prompts are his, whoever answered them, so a
row whose target is refused still contributes its prompt to
prompts_for_sampling.jsonl for a compliant teacher to answer. The exception is
prompts a vendor model wrote (the retired bulk_seed/auto_grow scripts had
Claude generate their questions): those are outputs too, and are dropped.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Mapping, Optional

PERMISSIVE_LICENCES = frozenset({"apache-2.0", "mit"})
# The `model` a human row may carry: nothing, or Will himself.
HUMAN_AUTHORS = frozenset({"", "will"})

# Model names that are a frontier vendor's hosted model. Checked BEFORE the
# allow-list, so a profile can't accidentally list one as a teacher.
FRONTIER_VENDOR = re.compile(
    r"^(anthropic|openai|perplexity|google|gemini|vertex|bedrock|amazon|xai|azure)[:/]"
    r"|^(claude|gpt-|chatgpt|o[1-9]\b|o[1-9]-|sonar|gemini|nova-|grok|command-r)",
    re.I,
)


@dataclass(frozen=True)
class Verdict:
    ok: bool
    kind: str  # 'human' | 'self' | 'open-weight' | 'refused'
    reason: str  # why it was refused ('' when ok)


def _family_match(model: str, prefixes: Iterable[str]) -> bool:
    m = model.lower()
    # Ollama tags ("muse-glimmer:30b"), HF repos ("mlx-community/Muse-Glimmer-30B-4bit"),
    # and the server's "provider:model" labels ("ollama:muse-glimmer:30b").
    tail = m.split("/")[-1]
    if m.startswith("ollama:"):
        tail = m[len("ollama:"):]
    return any(tail.startswith(p.lower()) for p in prefixes)


def judge_target(teacher: Mapping[str, object], self_models: Iterable[str], teachers: Mapping[str, str]) -> Verdict:
    """Decide one row's target. `teacher` is {kind, model, checks?}."""
    kind = str(teacher.get("kind") or "").strip().lower()
    model = str(teacher.get("model") or "").strip()
    # First, for every kind: a row can't launder a vendor's answer by calling it
    # "human" (say, a correction flow that records "Will edited Claude's reply").
    if model and FRONTIER_VENDOR.search(model):
        return Verdict(False, "refused", "frontier-vendor-output")
    if kind == "human":
        # Will wrote it, so no model did. A human row that names one is another
        # model's answer under the wrong label.
        if model.lower() not in HUMAN_AUTHORS:
            return Verdict(False, "refused", "human-row-names-a-model")
        return Verdict(True, "human", "")
    if kind == "self":
        if not model or not _family_match(model, self_models):
            return Verdict(False, "refused", "self-sample-from-another-model")
        checks = teacher.get("checks")
        passed = isinstance(checks, Mapping) and checks.get("passed") is True and bool(checks.get("verified"))
        if not passed:
            return Verdict(False, "refused", "self-sample-unverified")
        return Verdict(True, "self", "")
    if kind == "open-weight":
        licence = _teacher_licence(model, teachers)
        if licence is None:
            return Verdict(False, "refused", "teacher-not-allowed")
        if licence not in PERMISSIVE_LICENCES:
            return Verdict(False, "refused", "teacher-licence-not-permissive")
        return Verdict(True, "open-weight", "")
    return Verdict(False, "refused", "unknown-provenance")


def _teacher_licence(model: str, teachers: Mapping[str, str]) -> Optional[str]:
    for name, licence in teachers.items():
        if model.lower() == name.lower():
            return str(licence).lower()
    return None


# The retired seeding scripts' conversation ids. bulk_seed.py and auto_grow.py
# had claude-sonnet-4-6 WRITE the questions, so those prompts are a vendor's
# output too; seed_corpus.py's were a hand-written list in this repo.
_FRONTIER_WRITTEN_PROMPT = re.compile(r"^(bulk|grow)[-_]", re.I)


def prompt_origin(conversation_id: str) -> str:
    """'frontier-generated' for prompts a vendor model wrote, else 'will-or-repo'."""
    return "frontier-generated" if _FRONTIER_WRITTEN_PROMPT.match(conversation_id or "") else "will-or-repo"


def teacher_of_corpus_row(row: Mapping[str, object]) -> dict:
    """A corpus.jsonl row has no teacher block: infer it from brain/model.

    brain=frontier rows are a vendor model's answer. brain=local rows are the
    then-live local model's answer, unverified; they count as a self-sample
    only for the same family and still fail the verified-check rule.
    """
    model = str(row.get("model") or "")
    if row.get("brain") == "frontier":
        # The server labels some frontier answers "anthropic:claude-...", some bare "claude-...".
        return {"kind": "frontier", "model": model}
    return {"kind": "self", "model": model, "checks": None}
