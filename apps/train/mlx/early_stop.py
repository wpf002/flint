"""Early stopping with patience, from inside the training process.

The old pipeline picked a checkpoint after the fact (pick_best.py): it ran the
whole schedule, then copied the saved checkpoint NEAREST to the best val loss.
The first 72B run went 8,000 iterations with its best at 800 (about seven
wasted hours), and "nearest checkpoint" was never the weights that scored best.
It also scored each eval on a different random 25 of the 40 valid rows, so the
curve partly measured which rows were drawn.

This callback plugs into mlx-lm's trainer (it has the two methods
mlx_lm.tuner.callbacks.TrainingCallback defines; the trainer only calls them):

- on_val_loss_report: mlx-lm computes val loss BEFORE step `it`, with the
  weights after `it - 1` steps, and reports iteration = it - 1. Saving here
  saves exactly the weights that produced the number. The first report is the
  base model (iteration 0).
- A new best (lower than best - min_delta) saves best_adapters.safetensors and
  resets patience. Otherwise one more bad eval. After min_iter, `patience` bad
  evals in a row stop the run; a val loss above best x `diverge`, or a
  non-finite one, stops it at once.
- on_train_loss_report (every steps_per_report): tracks peak memory, preempts
  the run (Preempt) if it exceeds the memory budget or macOS reports critical
  memory pressure, and stops it at the wall-clock limit.

Stopping is an exception raised between steps, which leaves train() cleanly.
Nothing here imports mlx: save_fn / pressure_fn / clock are injected, so the
logic is unit-tested without a GPU (tests/test_early_stop.py).
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import time
from dataclasses import asdict, dataclass, field
from typing import Callable, Dict, List, Optional


class StopTraining(Exception):
    """Stop cleanly and keep the best weights (patience, divergence, NaN, time limit)."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class Preempt(Exception):
    """Yield to the live model: memory budget or system memory pressure. Keeps nothing new."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass
class EarlyStopConfig:
    patience: int = 3
    min_delta: float = 0.005
    # Patience can't stop the run before this many steps (half an epoch by default).
    min_iter: int = 0
    diverge: float = 1.25
    max_hours: Optional[float] = None
    # Peak memory (GB, as mlx reports it) above which the run yields to the live model.
    mem_budget_gb: Optional[float] = None


@dataclass
class EarlyStopState:
    base_val: Optional[float] = None
    best_val: Optional[float] = None
    best_iter: Optional[int] = None
    bad_evals: int = 0
    history: List[Dict[str, float]] = field(default_factory=list)
    stop_reason: Optional[str] = None
    peak_memory_gb: float = 0.0
    last_train_iter: int = 0
    saves: int = 0


def macos_memory_pressure() -> str:
    """'normal' | 'warn' | 'critical' from kern.memorystatus_vm_pressure_level (1/2/4)."""
    try:
        out = subprocess.run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], capture_output=True, text=True, timeout=5).stdout.strip()
        level = int(out)
    except (OSError, ValueError, subprocess.SubprocessError):
        return "normal"
    return {1: "normal", 2: "warn", 4: "critical"}.get(level, "normal")


class EarlyStop:
    def __init__(
        self,
        cfg: EarlyStopConfig,
        save_fn: Callable[[int], None],
        state_path: Optional[str] = None,
        pressure_fn: Callable[[], str] = macos_memory_pressure,
        clock: Callable[[], float] = time.monotonic,
        log: Callable[[str], None] = print,
    ):
        self.cfg = cfg
        self.save_fn = save_fn
        self.state_path = state_path
        self.pressure_fn = pressure_fn
        self.clock = clock
        self.log = log
        self.started = clock()
        self.state = EarlyStopState()

    # -- mlx-lm TrainingCallback interface ------------------------------------

    def on_val_loss_report(self, info: Dict[str, float]) -> None:
        it = int(info["iteration"])
        loss = float(info["val_loss"])
        s = self.state
        s.history.append({"iteration": it, "val_loss": loss})
        try:
            if not math.isfinite(loss):
                self._stop(f"non-finite val loss at step {it}")
            if s.base_val is None:
                # The first report is the untrained base: the bar every checkpoint must clear.
                s.base_val = s.best_val = loss
                s.best_iter = it
                self.log(f"early_stop: base val {loss:.4f}")
                return
            assert s.best_val is not None
            if loss < s.best_val - self.cfg.min_delta:
                s.best_val, s.best_iter, s.bad_evals = loss, it, 0
                self.save_fn(it)
                s.saves += 1
                self.log(f"early_stop: step {it} val {loss:.4f} (new best, saved)")
                return
            s.bad_evals += 1
            self.log(f"early_stop: step {it} val {loss:.4f} (best {s.best_val:.4f} @ {s.best_iter}, {s.bad_evals}/{self.cfg.patience} without improvement)")
            if loss > s.best_val * self.cfg.diverge:
                self._stop(f"diverged: val {loss:.4f} > {self.cfg.diverge} x best {s.best_val:.4f}")
            if it >= self.cfg.min_iter and s.bad_evals >= self.cfg.patience:
                self._stop(f"patience: {s.bad_evals} evals without a {self.cfg.min_delta} improvement (best {s.best_val:.4f} @ step {s.best_iter})")
        finally:
            self._write_state()

    def on_train_loss_report(self, info: Dict[str, float]) -> None:
        s = self.state
        s.last_train_iter = int(info.get("iteration", s.last_train_iter))
        s.peak_memory_gb = max(s.peak_memory_gb, float(info.get("peak_memory", 0.0)))
        if self.cfg.mem_budget_gb is not None and s.peak_memory_gb > self.cfg.mem_budget_gb:
            self._preempt(f"peak memory {s.peak_memory_gb:.1f} GB over the {self.cfg.mem_budget_gb:.1f} GB budget")
        if self.pressure_fn() == "critical":
            self._preempt("macOS reports critical memory pressure")
        if self.cfg.max_hours is not None and (self.clock() - self.started) / 3600 >= self.cfg.max_hours:
            self._stop(f"time limit: {self.cfg.max_hours:g} h")

    # -- results --------------------------------------------------------------

    @property
    def improved(self) -> bool:
        """Did any checkpoint beat the base by min_delta? If not there is no candidate."""
        return self.state.saves > 0

    def summary(self) -> Dict[str, object]:
        return {"config": asdict(self.cfg), **asdict(self.state), "improved": self.improved}

    def _stop(self, reason: str) -> None:
        self.state.stop_reason = reason
        self._write_state()
        raise StopTraining(reason)

    def _preempt(self, reason: str) -> None:
        self.state.stop_reason = f"preempted: {reason}"
        self._write_state()
        raise Preempt(reason)

    def _write_state(self) -> None:
        if not self.state_path:
            return
        tmp = f"{self.state_path}.tmp-{os.getpid()}"
        with open(tmp, "w") as f:
            json.dump(self.summary(), f, indent=2)
        os.replace(tmp, self.state_path)
