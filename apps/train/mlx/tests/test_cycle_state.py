import datetime as dt
import io
import json
import os
import unittest
from contextlib import redirect_stdout

from helpers import temp_dir

import cycle_state
from cycle_state import is_due

NOW = dt.datetime(2026, 10, 20, 7, 30, tzinfo=dt.timezone.utc)


def rec(id_, result, days_ago, targets=300, sha="p1"):
    t = (NOW - dt.timedelta(days=days_ago)).isoformat()
    return {"id": id_, "result": result, "startedAt": t, "endedAt": t, "targets": targets, "profileSha": sha}


def due(cycles, targets=500, sha="p1"):
    return is_due({"cycles": cycles}, targets=targets, profile_sha=sha, now=NOW, min_train=200)


class Due(unittest.TestCase):
    def test_not_enough_data(self):
        ok, why = due([], targets=40)
        self.assertFalse(ok)
        self.assertIn("40 compliant", why)

    def test_first_cycle(self):
        self.assertTrue(due([])[0])

    def test_min_days_since_the_last_training_cycle(self):
        self.assertFalse(due([rec("a", "HOLD", 3)])[0])
        self.assertTrue(due([rec("a", "HOLD", 8)])[0])

    def test_cycles_that_did_not_train_dont_start_the_clock(self):
        self.assertTrue(due([rec("a", "HOLD", 10), rec("b", "NO_DATA", 1), rec("c", "DEFER", 0)])[0])

    def test_needs_new_data_or_a_new_profile(self):
        self.assertFalse(due([rec("a", "HOLD", 10, targets=450)], targets=500)[0])
        self.assertTrue(due([rec("a", "HOLD", 10, targets=300)], targets=500)[0])
        self.assertTrue(due([rec("a", "HOLD", 10, targets=500, sha="old")], targets=500)[0])

    def test_kill_switch_after_two_failures_in_a_row(self):
        ok, why = due([rec("a", "REJECT", 20), rec("b", "NO_CANDIDATE", 10)], targets=5000)
        self.assertFalse(ok)
        self.assertIn("kill switch", why)
        # Non-decisions in between don't reset it; a HOLD or PROMOTE does.
        self.assertFalse(due([rec("a", "REJECT", 30), rec("x", "DEFER", 25), rec("b", "REJECT", 20)], targets=5000)[0])
        self.assertTrue(due([rec("a", "REJECT", 30), rec("b", "HOLD", 20), rec("c", "REJECT", 10)], targets=5000)[0])


class Cli(unittest.TestCase):
    def test_record_and_last(self):
        state = os.path.join(temp_dir(), "cycles", "state.json")
        self.assertEqual(cycle_state.main(["--state", state, "record", "--id", "20261001-0230", "--result", "STARTED", "--set", 'profile="muse-glimmer-30b"']), 0)
        self.assertEqual(cycle_state.main(["--state", state, "record", "--id", "20261001-0230", "--result", "REJECT", "--set", "targets=312", "--set", 'candidate="flint-muse:c1"']), 0)
        with redirect_stdout(io.StringIO()) as out:
            cycle_state.main(["--state", state, "last"])
        last = json.loads(out.getvalue())
        self.assertEqual((last["result"], last["targets"], last["candidate"], last["profile"]), ("REJECT", 312, "flint-muse:c1", "muse-glimmer-30b"))
        self.assertIn("endedAt", last)

    def test_due_exit_codes(self):
        state = os.path.join(temp_dir(), "state.json")
        with redirect_stdout(io.StringIO()):
            self.assertEqual(cycle_state.main(["--state", state, "due", "--count-json", '{"targets": 10}', "--profile-sha", "x", "--min-train", "200"]), 10)
            self.assertEqual(cycle_state.main(["--state", state, "due", "--count-json", '{"targets": 300}', "--profile-sha", "x", "--min-train", "200"]), 0)


if __name__ == "__main__":
    unittest.main()
