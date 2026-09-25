"""The shell scripts: syntax, and cycle.sh end to end on temp dirs (nothing under ~/.flint).

cycle.sh runs the real parity gate's --preflight-only (free: no server, model or
paid call). Everything that could reach the machine's real services is fenced
off: OLLAMA_HOST points at a closed port, pgrep / taskpolicy / ollama are stubs
on PATH, and a measured training peak far past any RAM makes memcheck defer, so
no test can start training even if cycle.sh regressed.
"""
import json
import os
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import unittest

from helpers import compliant_samples, corpus_row, eval_set, temp_dir, train_pool_cid, write_jsonl

from _path import MLX_DIR, REPO_ROOT

SCRIPTS = ["cycle.sh", "package_candidate.sh", "setup_train_env.sh"]
GATE_TSX = os.path.join(REPO_ROOT, "apps", "parity", "node_modules", ".bin", "tsx")
HAS_GATE = os.path.exists(GATE_TSX)

STUBS = {
    # No local parity run is "active" (a real bake-off on this machine must not skip the test).
    "pgrep": "exit 1",
    # Never train, never touch Ollama: record the attempt and fail.
    "taskpolicy": 'echo "taskpolicy $*" >> "$STUB_LOG"; exit 99',
    "ollama": 'echo "ollama $*" >> "$STUB_LOG"; exit 0',
}


@unittest.skipUnless(shutil.which("zsh"), "zsh not installed")
class Scripts(unittest.TestCase):
    def test_syntax(self):
        for s in SCRIPTS:
            with self.subTest(script=s):
                r = subprocess.run(["zsh", "-n", os.path.join(MLX_DIR, s)], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, r.stderr)

    def env(self, d):
        stubs = os.path.join(d, "stubs")
        os.makedirs(stubs, exist_ok=True)
        for name, body in STUBS.items():
            path = os.path.join(stubs, name)
            with open(path, "w") as f:
                f.write(f"#!/bin/sh\n{body}\n")
            os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
        env = {k: v for k, v in os.environ.items() if k not in ("FLINT_GATE_SETS", "FLINT_LOCAL_PROMPT")}
        return {
            **env,
            "PATH": f"{stubs}:{os.environ.get('PATH', '')}",
            "STUB_LOG": os.path.join(d, "stubs.log"),
            "OLLAMA_HOST": "http://127.0.0.1:9",
            "FLINT_BRAIN_DIR": os.path.join(d, "brain"),
            "FLINT_TRAINING_DIR": os.path.join(d, "training"),
            "PARITY_DIR": os.path.join(d, "eval"),
            "FLINT_TRAIN_PY": sys.executable,
            "FLINT_BRAIN_PROFILE": "muse-glimmer-30b",
        }

    def fixture(self):
        d = temp_dir()
        os.makedirs(os.path.join(d, "training"))
        os.makedirs(os.path.join(d, "eval"))
        eval_set(os.path.join(d, "eval"), ["Explain the birthday paradox."])
        write_jsonl(os.path.join(d, "training", "corpus.jsonl"), [corpus_row("Plan a birthday dinner menu for eight vegetarian guests", cid="c7")])
        return d

    def test_cycle_dry_run_if_due_is_not_due_and_writes_nothing(self):
        d = self.fixture()
        r = subprocess.run(["zsh", os.path.join(MLX_DIR, "cycle.sh"), "--dry-run", "--if-due"], capture_output=True, text=True, env=self.env(d), timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("not due: only 0 compliant target rows", r.stdout)
        self.assertFalse(os.path.exists(os.path.join(d, "brain")))

    @unittest.skipUnless(HAS_GATE, "apps/parity not installed (pnpm install)")
    def test_cycle_dry_run_force_prints_the_plan(self):
        d = self.fixture()
        r = subprocess.run(["zsh", os.path.join(MLX_DIR, "cycle.sh"), "--dry-run", "--force"], capture_output=True, text=True, env=self.env(d), timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("dry run: would build data", r.stdout)
        self.assertFalse(os.path.exists(os.path.join(d, "brain")))

    # ---- the gate's free preflight runs before any data is built or GPU used

    def trainable_fixture(self):
        """Enough compliant data for the real profile to build (status ok) and be due; memcheck would defer."""
        d = self.fixture()
        os.makedirs(os.path.join(d, "training", "samples"))
        write_jsonl(os.path.join(d, "training", "samples", "b1.jsonl"), compliant_samples(260, train_pool_cid()))
        for fp in ("2048x16", "2048x8", "1536x8"):
            adapter = os.path.join(d, "brain", "cycles", f"seed-{fp}", "adapter")
            os.makedirs(adapter)
            with open(os.path.join(adapter, "early_stop.json"), "w") as f:
                # A measured peak no machine has: memcheck defers every footprint.
                json.dump({"profile": "muse-glimmer-30b", "footprint": fp, "peakMemoryGbMlx": 999.0}, f)
        return d

    def cycle(self, d, *args):
        return subprocess.run(["zsh", os.path.join(MLX_DIR, "cycle.sh"), *args], capture_output=True, text=True, env=self.env(d), timeout=180)

    def state(self, d):
        path = os.path.join(d, "brain", "cycles", "state.json")
        if not os.path.exists(path):
            return None
        with open(path) as f:
            return json.load(f)

    def cycle_dirs(self, d):
        return sorted(x for x in os.listdir(os.path.join(d, "brain", "cycles")) if not x.startswith("seed-") and x not in ("state.json", "latest"))

    def stub_calls(self, d):
        path = os.path.join(d, "stubs.log")
        if not os.path.exists(path):
            return ""
        with open(path) as f:
            return f.read()

    @unittest.skipUnless(HAS_GATE, "apps/parity not installed (pnpm install)")
    def test_a_due_cycle_whose_gate_would_hold_builds_and_trains_nothing(self):
        # Due (260 compliant rows), but flint_tasks.jsonl, in the gate's default sets, doesn't exist.
        d = self.trainable_fixture()
        r = self.cycle(d, "--if-due")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("due: first cycle", r.stdout)
        # HOLD, not REJECT: the gate's exit code (3) reaches cycle.sh intact (pnpm run would make it 1).
        self.assertIn("not gateable: the gate would HOLD", r.stdout)
        self.assertIn("flint_tasks.jsonl", r.stderr)
        self.assertIsNone(self.state(d))
        self.assertEqual(self.cycle_dirs(d), [])
        self.assertEqual(self.stub_calls(d), "")

    @unittest.skipUnless(HAS_GATE, "apps/parity not installed (pnpm install)")
    def test_data_not_guarded_against_a_gate_set_is_ungateable_before_training(self):
        # other.jsonl is on disk (the first preflight passes) but build_data never guarded against it.
        d = self.trainable_fixture()
        eval_set(os.path.join(d, "eval"), ["Name three rivers in Oregon and their lengths"], name="other.jsonl")
        r = self.cycle(d, "--force", "--gate-sets", "parity_prompts.jsonl:100,other.jsonl")
        self.assertEqual(r.returncode, 0, r.stderr)
        last = self.state(d)["cycles"][-1]
        self.assertEqual(last["result"], "UNGATEABLE", r.stdout)
        cycle_dir = os.path.join(d, "brain", "cycles", last["id"])
        with open(os.path.join(cycle_dir, "gate.json")) as f:
            gate = json.load(f)
        self.assertEqual(gate["decision"]["verdict"], "HOLD")
        self.assertRegex(" ".join(gate["decision"]["reasons"]), "not guarded against this version of other")
        self.assertFalse(os.path.exists(os.path.join(cycle_dir, "memcheck.json")))
        self.assertEqual(self.stub_calls(d), "")

    @unittest.skipUnless(HAS_GATE, "apps/parity not installed (pnpm install)")
    def test_a_gateable_cycle_goes_on_to_memcheck(self):
        d = self.trainable_fixture()
        r = self.cycle(d, "--force", "--gate-sets", "parity_prompts.jsonl:100")
        self.assertEqual(r.returncode, 0, r.stderr)
        last = self.state(d)["cycles"][-1]
        # Past both preflights; memcheck defers (the fixture's measured peak), so nothing trains.
        self.assertEqual(last["result"], "DEFER", r.stdout)
        cycle_dir = os.path.join(d, "brain", "cycles", last["id"])
        self.assertTrue(os.path.exists(os.path.join(cycle_dir, "memcheck.json")))
        self.assertFalse(os.path.exists(os.path.join(cycle_dir, "gate.json")))
        self.assertEqual(self.stub_calls(d), "")

    def test_cycle_without_a_training_python_fails_loudly(self):
        d = self.fixture()
        env = {**self.env(d), "FLINT_TRAIN_PY": os.path.join(d, "no-python")}
        r = subprocess.run(["zsh", os.path.join(MLX_DIR, "cycle.sh"), "--if-due"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(r.returncode, 1)
        self.assertIn("setup_train_env.sh", r.stderr)

    def test_package_refuses_the_live_tag(self):
        d = temp_dir()
        os.makedirs(os.path.join(d, "adapter"))
        open(os.path.join(d, "adapter", "adapters.safetensors"), "w").close()
        env = {**os.environ, "FLINT_TRAIN_PY": sys.executable}
        r = subprocess.run(
            ["zsh", os.path.join(MLX_DIR, "package_candidate.sh"), "--adapter", os.path.join(d, "adapter"), "--out", os.path.join(d, "fused"), "--tag", "muse-glimmer:30b", "--dry-run"],
            capture_output=True, text=True, env=env, timeout=60,
        )
        self.assertEqual(r.returncode, 2)
        self.assertIn("never the live", r.stderr)

    def test_package_dry_run_plans_fuse_then_create(self):
        d = temp_dir()
        os.makedirs(os.path.join(d, "adapter"))
        open(os.path.join(d, "adapter", "adapters.safetensors"), "w").close()
        env = {**os.environ, "FLINT_TRAIN_PY": sys.executable}
        r = subprocess.run(
            ["zsh", os.path.join(MLX_DIR, "package_candidate.sh"), "--adapter", os.path.join(d, "adapter"), "--out", os.path.join(d, "fused"), "--tag", "flint-muse:c20261001-0230", "--dry-run"],
            capture_output=True, text=True, env=env, timeout=60,
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("mlx_lm fuse", r.stdout)
        self.assertIn("ollama create flint-muse:c20261001-0230", r.stdout)
        self.assertFalse(os.path.exists(os.path.join(d, "fused")))


class Plist(unittest.TestCase):
    def test_the_schedule_ships_disabled_and_runs_the_deploy_checkouts_cycle(self):
        with open(os.path.join(MLX_DIR, "com.flint.retrain.plist"), "rb") as f:
            p = plistlib.load(f)
        # Same label as the retired job: launchd's "disabled" override for it still applies.
        self.assertEqual(p["Label"], "com.flint.retrain")
        self.assertTrue(p["Disabled"])
        self.assertFalse(p["RunAtLoad"])
        self.assertEqual(p["ProgramArguments"][1:], ["/Users/willfoti/flint/apps/train/mlx/cycle.sh", "--if-due"])
        self.assertNotIn(".flint/brain/retrain.sh", " ".join(p["ProgramArguments"]))

    def test_no_script_takes_the_live_model_offline(self):
        # The old retrain.sh / ultimate_upgrade.sh ran `launchctl unload com.flint.ollama`,
        # which also took down the embeddings every frontier turn uses. No command here may.
        bad = re.compile(r"launchctl\s+(unload|load|bootout)|com\.flint\.ollama")
        for name in sorted(os.listdir(MLX_DIR)):
            if not name.endswith((".sh", ".py")):
                continue
            with open(os.path.join(MLX_DIR, name)) as f:
                lines = [ln for ln in f if not ln.lstrip().startswith("#")]
            if name.endswith(".py"):
                # Prose may mention the old commands; only what a .py file would execute counts.
                lines = [ln for ln in lines if "subprocess" in ln or "os.system" in ln]
            with self.subTest(file=name):
                self.assertEqual([ln.strip() for ln in lines if bad.search(ln)], [])


if __name__ == "__main__":
    unittest.main()
