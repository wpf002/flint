"""The shell scripts: syntax, and cycle.sh's dry run end to end on temp dirs (nothing under ~/.flint)."""
import os
import plistlib
import re
import shutil
import subprocess
import sys
import unittest

from helpers import corpus_row, eval_set, temp_dir, write_jsonl

from _path import MLX_DIR

SCRIPTS = ["cycle.sh", "package_candidate.sh", "setup_train_env.sh"]


@unittest.skipUnless(shutil.which("zsh"), "zsh not installed")
class Scripts(unittest.TestCase):
    def test_syntax(self):
        for s in SCRIPTS:
            with self.subTest(script=s):
                r = subprocess.run(["zsh", "-n", os.path.join(MLX_DIR, s)], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, r.stderr)

    def env(self, d):
        return {
            **os.environ,
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

    def test_cycle_dry_run_force_prints_the_plan(self):
        d = self.fixture()
        r = subprocess.run(["zsh", os.path.join(MLX_DIR, "cycle.sh"), "--dry-run", "--force"], capture_output=True, text=True, env=self.env(d), timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("dry run: would build data", r.stdout)
        self.assertFalse(os.path.exists(os.path.join(d, "brain")))

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
