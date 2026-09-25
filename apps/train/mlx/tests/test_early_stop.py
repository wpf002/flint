import json
import math
import os
import unittest

from helpers import temp_dir

from early_stop import EarlyStop, EarlyStopConfig, Preempt, StopTraining


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def make(cfg=None, pressure="normal", **kw):
    saved = []
    clock = Clock()
    cb = EarlyStop(cfg or EarlyStopConfig(patience=2, min_delta=0.01, min_iter=0), saved.append, pressure_fn=lambda: pressure, clock=clock, log=lambda m: None, **kw)
    return cb, saved, clock


def feed(cb, losses, every=40):
    """Report val losses as mlx-lm does: iteration 0 is the base, then every `every` steps."""
    for i, loss in enumerate(losses):
        cb.on_val_loss_report({"iteration": i * every, "val_loss": loss})


class Patience(unittest.TestCase):
    def test_first_report_is_the_base_and_saves_nothing(self):
        cb, saved, _ = make()
        feed(cb, [2.0])
        self.assertEqual(cb.state.base_val, 2.0)
        self.assertEqual(saved, [])
        self.assertFalse(cb.improved)

    def test_improvement_saves_the_exact_step(self):
        cb, saved, _ = make()
        feed(cb, [2.0, 1.8, 1.7])
        self.assertEqual(saved, [40, 80])
        self.assertEqual((cb.state.best_val, cb.state.best_iter), (1.7, 80))
        self.assertTrue(cb.improved)

    def test_patience_stops_after_n_evals_without_min_delta(self):
        cb, saved, _ = make()
        with self.assertRaises(StopTraining) as e:
            # 1.795 is not a min_delta (0.01) improvement on 1.8.
            feed(cb, [2.0, 1.8, 1.795, 1.81])
        self.assertIn("patience", e.exception.reason)
        self.assertEqual(saved, [40])
        self.assertEqual(cb.state.best_iter, 40)

    def test_a_new_best_resets_patience(self):
        cb, _, _ = make()
        feed(cb, [2.0, 1.8, 1.85, 1.7, 1.75])  # bad, best, bad: never two bad in a row
        self.assertEqual(cb.state.bad_evals, 1)

    def test_patience_waits_for_min_iter(self):
        cb, _, _ = make(EarlyStopConfig(patience=1, min_delta=0.01, min_iter=200))
        feed(cb, [2.0, 1.9, 1.95, 1.96])  # steps 0..120, all before min_iter
        self.assertIsNone(cb.state.stop_reason)
        with self.assertRaises(StopTraining):
            cb.on_val_loss_report({"iteration": 200, "val_loss": 1.97})

    def test_divergence_stops_at_once(self):
        cb, _, _ = make(EarlyStopConfig(patience=10, min_delta=0.01, min_iter=10_000, diverge=1.25))
        with self.assertRaises(StopTraining) as e:
            feed(cb, [2.0, 1.6, 2.1])
        self.assertIn("diverged", e.exception.reason)

    def test_non_finite_loss_stops(self):
        cb, _, _ = make()
        with self.assertRaises(StopTraining) as e:
            feed(cb, [2.0, math.nan])
        self.assertIn("non-finite", e.exception.reason)

    def test_never_beating_the_base_is_no_candidate(self):
        cb, saved, _ = make()
        with self.assertRaises(StopTraining):
            feed(cb, [2.0, 1.995, 2.01, 2.02])
        self.assertFalse(cb.improved)
        self.assertEqual(saved, [])


class Guards(unittest.TestCase):
    def test_memory_budget_preempts(self):
        cb, _, _ = make(EarlyStopConfig(mem_budget_gb=30.0))
        cb.on_train_loss_report({"iteration": 10, "peak_memory": 29.0})
        with self.assertRaises(Preempt) as e:
            cb.on_train_loss_report({"iteration": 20, "peak_memory": 31.5})
        self.assertIn("31.5", e.exception.reason)
        self.assertEqual(cb.state.peak_memory_gb, 31.5)
        self.assertTrue(cb.state.stop_reason.startswith("preempted"))

    def test_critical_memory_pressure_preempts(self):
        cb, _, _ = make(pressure="critical")
        with self.assertRaises(Preempt):
            cb.on_train_loss_report({"iteration": 10, "peak_memory": 1.0})

    def test_warn_pressure_does_not(self):
        cb, _, _ = make(pressure="warn")
        cb.on_train_loss_report({"iteration": 10, "peak_memory": 1.0})

    def test_time_limit_stops_and_keeps_the_best(self):
        cb, saved, clock = make(EarlyStopConfig(max_hours=1.0))
        feed(cb, [2.0, 1.5])
        clock.t = 3601
        with self.assertRaises(StopTraining) as e:
            cb.on_train_loss_report({"iteration": 50, "peak_memory": 1.0})
        self.assertIn("time limit", e.exception.reason)
        self.assertEqual(saved, [40])


class StateFile(unittest.TestCase):
    def test_written_after_every_eval_and_on_stop(self):
        path = os.path.join(temp_dir(), "early_stop.json")
        cb, _, _ = make(state_path=path)
        feed(cb, [2.0, 1.8])
        with open(path) as f:
            s = json.load(f)
        self.assertEqual([h["iteration"] for h in s["history"]], [0, 40])
        self.assertTrue(s["improved"])
        with self.assertRaises(StopTraining):
            feed(cb, [2.0, 1.8, 1.9, 1.95])
        with open(path) as f:
            self.assertIn("patience", json.load(f)["stop_reason"])


if __name__ == "__main__":
    unittest.main()
