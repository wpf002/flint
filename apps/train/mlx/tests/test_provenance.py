import json
import os
import unittest

from _path import SERVER_FIXTURES

from provenance import judge_target, prompt_origin, teacher_of_corpus_row

SELF = ["muse-glimmer", "flint-muse"]
TEACHERS = {"qwen3.8:27b": "apache-2.0", "some-model:1b": "llama-community"}
VERIFIED = {"passed": True, "verified": ["calculate-agrees"]}

# The server's training_status counts corpus rows with a port of these rules
# (apps/server/src/corpus-sources.ts); both are checked against this fixture.
with open(os.path.join(SERVER_FIXTURES, "corpus-provenance.json")) as _f:
    CORPUS_FIXTURE = json.load(_f)

# corpus-sources.ts TargetRefusal -> the provenance.py reasons it stands for. The
# port can't tell the two self-sample reasons apart: that takes the profile's base.
REFUSAL_REASONS = {
    "frontier-vendor-output": {"frontier-vendor-output"},
    "unknown-provenance": {"unknown-provenance"},
    "local-unverified": {"self-sample-unverified", "self-sample-from-another-model"},
}


class TargetPolicy(unittest.TestCase):
    def verdict(self, **teacher):
        return judge_target(teacher, SELF, TEACHERS)

    def test_frontier_vendor_outputs_are_never_targets(self):
        for model in [
            "claude-sonnet-4-6",
            "anthropic:claude-opus-5-5",
            "gpt-5",
            "openai:gpt-5",
            "o3",
            "o4-mini",
            "sonar-pro",
            "perplexity:sonar",
            "gemini-2.5-pro",
            "google:gemini-3",
            "nova-pro",
            "bedrock:anything",
            "grok-4",
        ]:
            for kind in ("frontier", "open-weight", "self", "human", "Human"):
                with self.subTest(model=model, kind=kind):
                    v = self.verdict(kind=kind, model=model, checks=VERIFIED)
                    self.assertFalse(v.ok)
                    self.assertEqual(v.reason, "frontier-vendor-output")

    def test_frontier_vendor_cant_be_listed_as_a_teacher(self):
        v = judge_target({"kind": "open-weight", "model": "gpt-5"}, SELF, {"gpt-5": "apache-2.0"})
        self.assertFalse(v.ok)

    def test_human(self):
        self.assertTrue(self.verdict(kind="human").ok)
        self.assertTrue(self.verdict(kind="human", model="will").ok)
        self.assertTrue(self.verdict(kind="human", model="Will").ok)

    def test_a_human_row_that_names_a_model_is_that_models_answer(self):
        # "human" is Will's own writing: a row naming any model is mislabelled,
        # open-weight or otherwise, and never a Will-written (repeated) target.
        for model in ["qwen3.8:27b", "muse-glimmer:30b", "some-new-model"]:
            with self.subTest(model=model):
                v = self.verdict(kind="human", model=model, checks=VERIFIED)
                self.assertFalse(v.ok)
                self.assertEqual(v.reason, "human-row-names-a-model")

    def test_self_needs_same_family_and_a_verified_check(self):
        self.assertTrue(self.verdict(kind="self", model="muse-glimmer:30b", checks=VERIFIED).ok)
        self.assertTrue(self.verdict(kind="self", model="ollama:flint-muse:c20261001-0230", checks=VERIFIED).ok)
        self.assertTrue(self.verdict(kind="self", model="mlx-community/Muse-Glimmer-30B-4bit", checks=VERIFIED).ok)
        self.assertEqual(self.verdict(kind="self", model="qwen2.5:7b", checks=VERIFIED).reason, "self-sample-from-another-model")
        self.assertEqual(self.verdict(kind="self", model="muse-glimmer:30b").reason, "self-sample-unverified")
        self.assertEqual(self.verdict(kind="self", model="muse-glimmer:30b", checks={"passed": True, "verified": []}).reason, "self-sample-unverified")
        self.assertEqual(self.verdict(kind="self", model="muse-glimmer:30b", checks={"passed": False, "verified": ["x"]}).reason, "self-sample-unverified")

    def test_open_weight_needs_a_listed_permissive_licence(self):
        self.assertTrue(self.verdict(kind="open-weight", model="qwen3.8:27b").ok)
        self.assertEqual(self.verdict(kind="open-weight", model="qwen3.6:35b").reason, "teacher-not-allowed")
        self.assertEqual(self.verdict(kind="open-weight", model="some-model:1b").reason, "teacher-licence-not-permissive")

    def test_unknown_kind_fails_closed(self):
        self.assertEqual(self.verdict(kind="", model="").reason, "unknown-provenance")
        self.assertEqual(self.verdict(kind="frontier", model="mystery-model").reason, "unknown-provenance")

    def test_corpus_rows(self):
        self.assertEqual(teacher_of_corpus_row({"brain": "frontier", "model": "claude-sonnet-4-6"})["kind"], "frontier")
        local = teacher_of_corpus_row({"brain": "local", "model": "muse-glimmer:30b"})
        # The then-live local model's answer, unverified: never a target as-is.
        self.assertFalse(judge_target(local, SELF, TEACHERS).ok)

    def test_prompts_written_by_a_vendor_model(self):
        self.assertEqual(prompt_origin("bulk-3"), "frontier-generated")
        self.assertEqual(prompt_origin("grow_20260801_4"), "frontier-generated")
        self.assertEqual(prompt_origin("seed-12"), "will-or-repo")
        self.assertEqual(prompt_origin("console"), "will-or-repo")


class CorpusRowsMatchTheServerPort(unittest.TestCase):
    """training_status's corpus counts (corpus-sources.ts) must be what this module decides."""

    def test_every_fixture_row_is_refused_for_the_ported_reason(self):
        for case in CORPUS_FIXTURE["corpus"] + CORPUS_FIXTURE["edge"]:
            with self.subTest(**case):
                row = {k: v for k, v in case.items() if k not in ("refusal", "vendorPrompt")}
                v = judge_target(teacher_of_corpus_row(row), SELF, TEACHERS)
                self.assertFalse(v.ok)
                self.assertIn(v.reason, REFUSAL_REASONS[case["refusal"]])
                self.assertEqual(prompt_origin(row["conversationId"]) == "frontier-generated", case["vendorPrompt"])

    def test_a_frontier_brain_row_is_refused_even_when_its_model_is_a_permitted_teacher(self):
        # qwen3.8:27b is an apache-2.0 teacher above, but a corpus row can't say it
        # was sampled as one: brain=frontier is kind "frontier", not "open-weight".
        v = judge_target(teacher_of_corpus_row({"brain": "frontier", "model": "ollama:qwen3.8:27b"}), SELF, TEACHERS)
        self.assertEqual(v.reason, "unknown-provenance")


if __name__ == "__main__":
    unittest.main()
