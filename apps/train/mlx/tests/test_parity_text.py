"""parity_text.py must agree with apps/parity/src/prompts.ts on every shared fixture case.

The fixture is generated from the TypeScript side; vitest checks TypeScript
still produces it (apps/parity/test/normalize-fixture.test.ts), this checks the
Python port does. A prompt id or near-duplicate call that differs between the
two would let an eval prompt through the contamination guard.
"""
import json
import os
import unittest

from _path import PARITY_FIXTURES

from parity_text import is_near_duplicate, is_trivial, jaccard, normalize, prompt_id, source_of, word_set
from contamination import GUARD_JACCARD

with open(os.path.join(PARITY_FIXTURES, "normalize-cases.json")) as _f:
    FIXTURE = json.load(_f)


class ParityTextMatchesTypeScript(unittest.TestCase):
    def test_normalize_id_words_trivial(self):
        for c in FIXTURE["cases"]:
            with self.subTest(input=c["input"]):
                self.assertEqual(normalize(c["input"]), c["normalized"])
                self.assertEqual(prompt_id(c["input"]), c["id"])
                self.assertEqual(sorted(word_set(c["input"])), c["words"])
                self.assertEqual(is_trivial(c["input"]), c["trivial"])

    def test_pairs(self):
        for p in FIXTURE["pairs"]:
            with self.subTest(a=p["a"], b=p["b"]):
                wa, wb = word_set(p["a"]), word_set(p["b"])
                self.assertAlmostEqual(jaccard(wa, wb), p["jaccard"], places=5)
                self.assertEqual(is_near_duplicate(wa, wb, 0.8), p["nearDuplicate"])
                self.assertEqual(is_near_duplicate(wa, wb, GUARD_JACCARD), p["guardMatch"])

    def test_fixture_covers_the_edges(self):
        # The cases that matter for a port: curly quotes, non-ASCII, whitespace, and
        # a guard-only match (Jaccard in [0.6, 0.8) without containment).
        inputs = [c["input"] for c in FIXTURE["cases"]]
        self.assertTrue(any("’" in i for i in inputs))
        self.assertTrue(any(not i.isascii() for i in inputs))
        self.assertTrue(any(p["guardMatch"] and not p["nearDuplicate"] for p in FIXTURE["pairs"]))

    def test_known_parity_id(self):
        # From ~/.flint/eval/parity_prompts.jsonl: the frozen set's id for this prompt.
        self.assertEqual(prompt_id("Explain the birthday paradox."), "00100cd7a076")

    def test_source_of(self):
        self.assertEqual(source_of("bulk-12"), "synthetic")
        self.assertEqual(source_of("grow_3"), "synthetic")
        self.assertEqual(source_of("console"), "organic")
        self.assertEqual(source_of(""), "organic")


if __name__ == "__main__":
    unittest.main()
