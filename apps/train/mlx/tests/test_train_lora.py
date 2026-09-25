import io
import json
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout

from helpers import small_profile, temp_dir, write_jsonl

import train_lora
from profiles import ProfileError, load_profile
from train_lora import check_mask_offsets, resolve_config


class ResolveConfig(unittest.TestCase):
    def test_muse_defaults_for_800_rows(self):
        cfg = resolve_config(load_profile("muse-glimmer-30b"), 800, 120)
        m, es = cfg["mlx"], cfg["early_stop"]
        self.assertEqual(m["iters"], 1600)  # 2 epochs at batch 1
        self.assertEqual(cfg["updates"], 200)  # 8-step accumulation
        self.assertEqual(m["steps_per_eval"], 200)  # 4 evals per epoch
        self.assertEqual(m["val_batches"], -1)  # the whole valid set, every eval
        self.assertEqual(m["save_every"], 10**9)  # only the callback saves
        self.assertEqual(m["max_seq_length"], 2048)
        self.assertTrue(m["mask_prompt"])
        self.assertEqual(es["min_iter"], 400)  # half an epoch
        sched = m["lr_schedule"]
        self.assertEqual(sched["name"], "cosine_decay")
        # The cosine runs over optimizer updates after warmup, not over steps.
        self.assertEqual(sched["arguments"], [1e-4, 190, 1e-5])
        self.assertEqual(sched["warmup"], 10)

    def test_small_sets_still_eval_at_least_every_min_steps(self):
        cfg = resolve_config(load_profile("muse-glimmer-30b"), 200, 50)
        self.assertEqual(cfg["mlx"]["steps_per_eval"], 50)
        cfg = resolve_config(small_profile(min_steps_per_eval=40), 100, 50)
        self.assertEqual(cfg["mlx"]["steps_per_eval"], 40)

    def test_memcheck_footprint_overrides(self):
        cfg = resolve_config(load_profile("muse-glimmer-30b"), 800, 120, max_seq_length=1536, num_layers=8, mem_budget_gb=27.5, max_hours=2.5)
        self.assertEqual((cfg["mlx"]["max_seq_length"], cfg["mlx"]["num_layers"]), (1536, 8))
        self.assertEqual(cfg["early_stop"]["mem_budget_gb"], 27.5)
        self.assertEqual(cfg["early_stop"]["max_hours"], 2.5)

    def test_refuses_too_little_data(self):
        with self.assertRaises(ProfileError):
            resolve_config(load_profile("muse-glimmer-30b"), 199, 120)
        with self.assertRaises(ProfileError):
            resolve_config(load_profile("muse-glimmer-30b"), 800, 49)


class DryRun(unittest.TestCase):
    def test_dry_run_resolves_without_mlx(self):
        d = temp_dir()
        write_jsonl(os.path.join(d, "train.jsonl"), [{"messages": []}] * 300)
        write_jsonl(os.path.join(d, "valid.jsonl"), [{"messages": []}] * 60)
        with redirect_stdout(io.StringIO()) as out:
            code = train_lora.main(["--data", d, "--out", os.path.join(d, "adapter"), "--dry-run"])
        self.assertEqual(code, 0)
        text = out.getvalue()
        self.assertIn("train_n=300 iters=600", text)  # the header training_status parses
        self.assertEqual(json.loads(text[text.index("{"):])["model"], "mlx-community/Muse-Glimmer-30B-4bit")
        self.assertNotIn("mlx.core", sys.modules)
        self.assertFalse(os.path.exists(os.path.join(d, "adapter")))

    def test_too_little_data_is_a_config_error(self):
        d = temp_dir()
        write_jsonl(os.path.join(d, "train.jsonl"), [{"messages": []}] * 10)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(train_lora.main(["--data", d, "--out", os.path.join(d, "a"), "--dry-run"]), 2)


class FakeTokenizer:
    """Renders messages as '<role>content' tokens (one token per char), like a chat template."""

    def __init__(self, break_prefix=False):
        self.break_prefix = break_prefix

    def apply_chat_template(self, messages, tools=None, add_generation_prompt=False, return_dict=False):
        s = "".join(f"<{m['role']}>{m.get('content', '')}" for m in messages)
        if add_generation_prompt:
            s += "<assistant>" if not self.break_prefix else "<ASSISTANT>"
        return list(s)


class FakeChatDataset:
    """mlx_lm.tuner.datasets.ChatDataset with mask_prompt=True, over FakeTokenizer."""

    def __init__(self, rows, tok):
        self.rows, self.tok = rows, tok

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        return self.rows[i]

    def process(self, d):
        tokens = self.tok.apply_chat_template(d["messages"])
        offset = len(self.tok.apply_chat_template(d["messages"][:-1], add_generation_prompt=True))
        return tokens, offset


def chat(user, answer):
    return {"messages": [{"role": "user", "content": user}, {"role": "assistant", "content": answer}]}


class MaskOffsets(unittest.TestCase):
    def test_a_template_whose_prompt_is_a_prefix_passes(self):
        tok = FakeTokenizer()
        # "<user>q<assistant>" is a prefix of "<user>q<assistant>answer": fine.
        self.assertEqual(check_mask_offsets(FakeChatDataset([chat("q", "a long answer")] * 3, tok), tok, 2048), [])

    def test_a_template_that_renders_the_prompt_differently_is_caught(self):
        tok = FakeTokenizer(break_prefix=True)
        problems = check_mask_offsets(FakeChatDataset([chat("q", "a long answer")], tok), tok, 2048)
        self.assertTrue(any("not a prefix" in p for p in problems))

    def test_answers_past_max_seq_length_are_caught(self):
        tok = FakeTokenizer()
        rows = [chat("x" * 100, "answer")] * 5
        problems = check_mask_offsets(FakeChatDataset(rows, tok), tok, 50)
        self.assertTrue(any("past max_seq_length" in p for p in problems))


if __name__ == "__main__":
    unittest.main()
