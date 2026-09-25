import unittest

import _path  # noqa: F401

from provenance import judge_target, prompt_origin, teacher_of_corpus_row

SELF = ["muse-glimmer", "flint-muse"]
TEACHERS = {"qwen3.8:27b": "apache-2.0", "some-model:1b": "llama-community"}
VERIFIED = {"passed": True, "verified": ["calculate-agrees"]}


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
            for kind in ("frontier", "open-weight", "self"):
                with self.subTest(model=model, kind=kind):
                    v = self.verdict(kind=kind, model=model, checks=VERIFIED)
                    self.assertFalse(v.ok)
                    self.assertEqual(v.reason, "frontier-vendor-output")

    def test_frontier_vendor_cant_be_listed_as_a_teacher(self):
        v = judge_target({"kind": "open-weight", "model": "gpt-5"}, SELF, {"gpt-5": "apache-2.0"})
        self.assertFalse(v.ok)

    def test_human(self):
        self.assertTrue(self.verdict(kind="human").ok)

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


if __name__ == "__main__":
    unittest.main()
