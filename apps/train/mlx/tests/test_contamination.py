import hashlib
import io
import json
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout

from helpers import eval_set, temp_dir, write_jsonl

import contamination
from contamination import ContaminationGuard, MissingEvalSet, load_eval_set
from parity_text import prompt_id

def sha256_of(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


EVAL = [
    "Explain the birthday paradox.",
    "Who is fighting in the UFC 329 main event? Search the web.",
    "Compare postgres mysql performance",
]


class Guard(unittest.TestCase):
    def setUp(self):
        self.dir = temp_dir()
        self.path = eval_set(self.dir, EVAL)
        self.guard = ContaminationGuard.from_paths([self.path])

    def test_exact_after_normalization(self):
        m = self.guard.match("  explain THE birthday   paradox!! ")
        self.assertIsNotNone(m)
        self.assertEqual(m.reason, "exact")

    def test_parity_id_in_file_counts_as_exact(self):
        # A set whose rows carry parity ids: the id itself is part of the guard.
        p = write_jsonl(os.path.join(self.dir, "ids.jsonl"), [{"id": prompt_id("What is a monad?"), "prompt": "What is a monad?"}])
        g = ContaminationGuard.from_paths([p])
        self.assertEqual(g.match("what is a monad").reason, "exact")

    def test_containment(self):
        m = self.guard.match("who is fighting at UFC 329?")
        self.assertIsNotNone(m)
        self.assertIn(m.reason, {"jaccard", "containment"})

    def test_guard_is_stricter_than_dedupe(self):
        # Jaccard 0.6 without containment: not a duplicate for dedupe (0.8), but contaminated.
        m = self.guard.match("Compare postgres sqlite performance")
        self.assertIsNotNone(m)
        self.assertEqual(m.reason, "jaccard")

    def test_unrelated_is_clean(self):
        self.assertIsNone(self.guard.match("Write a haiku about Dallas in September."))

    def test_required_set_missing_fails_closed(self):
        with self.assertRaises(MissingEvalSet):
            ContaminationGuard.from_paths([os.path.join(self.dir, "nope.jsonl")])

    def test_optional_set_missing_is_recorded_absent(self):
        g = ContaminationGuard.from_paths([self.path], [os.path.join(self.dir, "flint_tasks.jsonl")])
        sets = g.describe()["evalSets"]
        self.assertEqual([s["present"] for s in sets], [True, False])
        self.assertEqual(sets[0]["sha256"], sha256_of(self.path))
        self.assertEqual(sets[0]["n"], 3)

    def test_no_present_set_is_an_error(self):
        with self.assertRaises(MissingEvalSet):
            ContaminationGuard([load_eval_set(os.path.join(self.dir, "absent.jsonl"), False)])

    def test_torn_eval_set_is_an_error(self):
        p = os.path.join(self.dir, "torn.jsonl")
        with open(p, "w") as f:
            f.write('{"prompt": "ok"}\n{"prompt": "tor')
        with self.assertRaises(MissingEvalSet):
            load_eval_set(p, True)

    def test_cli_exit_codes(self):
        rows = write_jsonl(os.path.join(self.dir, "rows.jsonl"), [{"prompt": "explain the birthday paradox"}, {"messages": [{"role": "user", "content": "unrelated thing about gardening tools"}]}])
        clean = write_jsonl(os.path.join(self.dir, "clean.jsonl"), [{"prompt": "unrelated thing about gardening tools"}])
        with redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()):
            self.assertEqual(contamination.main(["--eval-set", self.path, rows]), 3)
        self.assertEqual(json.loads(out.getvalue().splitlines()[0])["reason"], "exact")
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(contamination.main(["--eval-set", self.path, clean]), 0)
            self.assertEqual(contamination.main(["--eval-set", os.path.join(self.dir, "missing.jsonl"), clean]), 2)


if __name__ == "__main__":
    unittest.main()
