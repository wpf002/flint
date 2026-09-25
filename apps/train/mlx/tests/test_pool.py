import json
import os
import unittest

from _path import PARITY_FIXTURES

from pool import pool_key, pool_of

with open(os.path.join(PARITY_FIXTURES, "pool-cases.json")) as _f:
    FIXTURE = json.load(_f)


class PoolMatchesTypeScript(unittest.TestCase):
    def test_fixture(self):
        for c in FIXTURE["cases"]:
            with self.subTest(**c):
                self.assertEqual(pool_key(c["conversationId"], c["prompt"]), c["key"])
                self.assertEqual(pool_of(c["conversationId"], c["prompt"]), c["pool"])

    def test_both_pools_occur(self):
        self.assertEqual({c["pool"] for c in FIXTURE["cases"]}, {"eval", "train"})

    def test_shared_buckets_key_by_prompt(self):
        # Same question under two shared buckets: same pool. Real conversations key by id.
        self.assertEqual(pool_key("console", "Why is the sky blue?"), pool_key("generate", "why is the sky blue"))
        self.assertTrue(pool_key("c123", "x").startswith("conv:"))

    def test_eval_share_is_about_thirty_percent(self):
        n = 5000
        evals = sum(1 for i in range(n) if pool_of(f"c{i}", "x") == "eval")
        self.assertGreater(evals / n, 0.27)
        self.assertLess(evals / n, 0.33)


if __name__ == "__main__":
    unittest.main()
