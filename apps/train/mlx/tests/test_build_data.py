import io
import json
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout

from helpers import LONG, corpus_row, eval_pool_cid, eval_set, sample_row, small_profile, temp_dir, train_pool_cid, write_jsonl

import build_data
from build_data import Row, build, load_corpus, load_samples, render, repeat_factor
from contamination import ContaminationGuard
from parity_text import is_near_duplicate, prompt_id, word_set

EVAL_PROMPTS = ["Explain the birthday paradox.", "How does a transistor work?", "Compare postgres mysql performance"]

# Distinct, non-trivial prompts that don't collide with the eval set or each other.
TOPICS = [
    "Draft a packing list for a week of hiking in Colorado",
    "Outline a migration plan from REST endpoints to gRPC services",
    "Summarize the tradeoffs of index funds versus picking stocks",
    "Plan a birthday dinner menu for eight vegetarian guests",
    "Describe a morning routine that improves deep focus at work",
    "Suggest names for a golden retriever puppy with a calm temperament",
    "Compare heat pumps against gas furnaces for north Texas winters",
    "Write a polite follow-up note to a contractor who missed a deadline",
    "Give me a weekly strength training split for a busy founder",
    "Estimate how long a cross country drive from Dallas to Seattle takes",
]


class BuildBase(unittest.TestCase):
    def setUp(self):
        self.dir = temp_dir()
        self.eval_path = eval_set(self.dir, EVAL_PROMPTS)
        self.guard = ContaminationGuard.from_paths([self.eval_path])
        self.cids = train_pool_cid()

    def human(self, prompt, **kw):
        kw.setdefault("cid", next(self.cids))
        return self._rows([sample_row(prompt, **kw)])[0]

    def _rows(self, raw):
        path = write_jsonl(os.path.join(self.dir, f"s{len(os.listdir(self.dir))}.jsonl"), raw)
        return load_samples([path])

    def run_build(self, rows, profile=None, corpus=(), local_prompt=None):
        return build(profile=profile or small_profile(), guard=self.guard, corpus_rows=list(corpus), sample_rows=list(rows), local_prompt=local_prompt)


class Filters(BuildBase):
    def test_claudes_answers_are_never_targets_but_wills_prompts_are_kept_for_sampling(self):
        path = write_jsonl(os.path.join(self.dir, "corpus.jsonl"), [corpus_row(t, cid=next(self.cids), ts=i) for i, t in enumerate(TOPICS[:4])])
        res = self.run_build([], corpus=load_corpus(path))
        self.assertEqual(res.manifest["counts"]["targets"], 0)
        self.assertEqual(res.manifest["drops"]["target:frontier-vendor-output"], 4)
        self.assertEqual(len(res.sampling_prompts), 4)
        self.assertEqual(res.status, "NO_DATA")

    def test_a_vendor_answer_labelled_human_is_still_a_vendor_answer(self):
        # e.g. a correction flow that records "Will edited Claude's reply" as kind human.
        rows = self._rows([sample_row(TOPICS[i], kind="human", model="claude-opus-5-5", cid=next(self.cids), ts=i) for i in range(8)])
        res = self.run_build(rows)
        self.assertEqual(res.manifest["counts"]["targets"], 0)
        self.assertEqual(res.manifest["drops"]["target:frontier-vendor-output"], 8)
        self.assertEqual(res.status, "NO_DATA")
        self.assertEqual(res.train, [])

    def test_vendor_written_prompts_are_dropped_entirely(self):
        path = write_jsonl(os.path.join(self.dir, "corpus.jsonl"), [corpus_row(TOPICS[0], cid="bulk-1"), corpus_row(TOPICS[1], cid="grow_2")])
        res = self.run_build([], corpus=load_corpus(path))
        self.assertEqual(res.manifest["drops"]["prompt:frontier-generated"], 2)
        self.assertEqual(res.sampling_prompts, [])

    def test_eval_overlap_and_eval_pool_are_dropped_before_anything_else(self):
        rows = self._rows(
            [
                sample_row("explain the BIRTHDAY paradox", cid=next(self.cids)),
                sample_row("Compare postgres sqlite performance", cid=next(self.cids)),  # guard-only (Jaccard 0.6)
                sample_row(TOPICS[0], cid=eval_pool_cid()),
                sample_row(TOPICS[1], cid=next(self.cids)),
            ]
        )
        res = self.run_build(rows)
        self.assertEqual(res.manifest["drops"]["eval-overlap"], 2)
        self.assertEqual(res.manifest["drops"]["eval-pool"], 1)
        self.assertEqual(res.manifest["counts"]["targets"], 1)
        self.assertEqual(res.manifest["guard"]["droppedByEvalSet"], {self.eval_path: 2})

    def test_eval_prompt_in_an_earlier_turn_is_caught(self):
        msgs = [
            {"role": "user", "content": "Explain the birthday paradox."},
            {"role": "assistant", "content": LONG},
            {"role": "user", "content": TOPICS[2]},
            {"role": "assistant", "content": LONG},
        ]
        res = self.run_build(self._rows([sample_row(TOPICS[2], messages=msgs, cid=next(self.cids))]))
        self.assertEqual(res.manifest["drops"].get("eval-overlap"), 1)

    def test_target_filters(self):
        rows = self._rows(
            [
                sample_row(TOPICS[0], output="I can't get you an answer on that one: the model I asked declined it.", cid=next(self.cids)),
                sample_row(TOPICS[1], output="Too short.", cid=next(self.cids)),
                sample_row(TOPICS[2], output="He has 24 sheep. Wait, I made a calculation error, it is 36 sheep in total here.", cid=next(self.cids)),
                sample_row(TOPICS[3], kind="self", model="muse-glimmer:30b", cid=next(self.cids)),
                sample_row(TOPICS[4], kind="self", model="muse-glimmer:30b", checks={"passed": True, "verified": ["tests-pass"]}, cid=next(self.cids)),
            ]
        )
        res = self.run_build(rows)
        d = res.manifest["drops"]
        self.assertEqual(d["target:unanswered"], 1)
        self.assertEqual(d["target:too-short"], 1)
        self.assertEqual(d["target:visible-reasoning"], 1)
        self.assertEqual(d["target:self-sample-unverified"], 1)
        self.assertEqual(res.manifest["counts"]["byKind"], {"self": 1})

    def test_tool_answers_without_their_trajectory_teach_fabrication(self):
        path = write_jsonl(
            os.path.join(self.dir, "corpus.jsonl"),
            [corpus_row(TOPICS[0], brain="local", model="muse-glimmer:30b", cid=next(self.cids), tools=[{"tool": "web.web_search", "outcome": "ok"}])],
        )
        # Make the local row pass provenance so the tool rule is what drops it.
        rows = load_corpus(path)
        rows[0].teacher = {"kind": "self", "model": "muse-glimmer:30b", "checks": {"passed": True, "verified": ["x"]}}
        res = self.run_build([], corpus=rows)
        self.assertEqual(res.manifest["drops"]["target:tools-without-trajectory"], 1)

    def test_tool_call_arguments_become_mappings(self):
        msgs = [
            {"role": "user", "content": TOPICS[5]},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "web.web_search", "arguments": '{"query": "calm puppy names"}'}}]},
            {"role": "tool", "tool_call_id": "t1", "content": "Results: Bodhi, Maple, Sage"},
            {"role": "assistant", "content": "Calm names that fit a golden: Bodhi, Maple, Sage, Juniper, Willow, Atlas. " * 2},
        ]
        rows = self._rows([sample_row(TOPICS[5], messages=msgs, cid=next(self.cids), tools=[{"name": "web.web_search"}])])
        res = self.run_build(rows, profile=small_profile(min_train=1, valid_n=0, min_valid=0))
        calls = [m for x in res.train for m in x["messages"] if m.get("tool_calls")]
        self.assertTrue(calls)
        self.assertEqual(calls[0]["tool_calls"][0]["function"]["arguments"], {"query": "calm puppy names"})
        # One rendered row per assistant turn: the tool call, then the final answer.
        self.assertEqual(len(res.train), 2)
        self.assertEqual(res.train[0]["messages"][-1]["tool_calls"][0]["function"]["name"], "web.web_search")
        self.assertTrue(all(x["tools"] == [{"name": "web.web_search"}] for x in res.train))

    def test_only_the_last_exchange_is_a_target(self):
        # Earlier turns are history, possibly another model's answers: context, never targets.
        msgs = [
            {"role": "user", "content": TOPICS[7]},
            {"role": "assistant", "content": "An earlier answer by some other model. " * 3},
            {"role": "user", "content": TOPICS[8]},
            {"role": "assistant", "content": "The teacher's own answer to the follow-up. " * 3},
        ]
        rows = self._rows([sample_row(TOPICS[8], messages=msgs, cid=next(self.cids))])
        res = self.run_build(rows, profile=small_profile(min_train=1, valid_n=0, min_valid=0))
        self.assertEqual(len(res.train), 1)
        self.assertEqual(len(res.train[0]["messages"]), 4)
        self.assertTrue(res.train[0]["messages"][-1]["content"].startswith("The teacher's own answer"))

    def test_a_last_exchange_without_a_final_answer_is_too_short(self):
        msgs = [
            {"role": "user", "content": TOPICS[7]},
            {"role": "assistant", "content": LONG},
            {"role": "user", "content": TOPICS[9]},
        ]
        res = self.run_build(self._rows([sample_row(TOPICS[9], messages=msgs, cid=next(self.cids))]))
        self.assertEqual(res.manifest["drops"]["target:too-short"], 1)

    def test_bad_tool_call_json_is_dropped(self):
        msgs = [
            {"role": "user", "content": TOPICS[6]},
            {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "x", "arguments": "{not json"}}]},
            {"role": "assistant", "content": LONG},
        ]
        res = self.run_build(self._rows([sample_row(TOPICS[6], messages=msgs, cid=next(self.cids))]))
        self.assertEqual(res.manifest["drops"]["target:bad-tool-call"], 1)


class SplitAndRender(BuildBase):
    def many(self, n, **kw):
        return self._rows([sample_row(TOPICS[i], cid=next(self.cids), ts=i, **kw) for i in range(n)])

    def test_dedupe_keeps_human_over_self_over_open_weight(self):
        p = small_profile(min_train=1, valid_n=0, min_valid=0)
        p["teachers"] = {"qwen3.8:27b": "apache-2.0"}
        rows = self._rows(
            [
                sample_row(TOPICS[0], kind="open-weight", model="qwen3.8:27b", cid=next(self.cids), ts=1),
                sample_row(TOPICS[0] + "!", kind="self", model="muse-glimmer:30b", checks={"passed": True, "verified": ["x"]}, cid=next(self.cids), ts=2),
                sample_row(TOPICS[0].lower(), kind="human", cid=next(self.cids), ts=3),
            ]
        )
        res = self.run_build(rows, profile=p)
        self.assertEqual(res.manifest["counts"]["byKind"], {"human": 1})
        self.assertEqual(res.manifest["drops"]["duplicate"], 2)

    def test_greetings_and_near_duplicates_are_dropped_before_the_split(self):
        near = TOPICS[0] + " mountains"  # not the same text after normalize, but parity's near-duplicate
        self.assertTrue(is_near_duplicate(word_set(TOPICS[0]), word_set(near)))
        greetings = ["hey there", "thanks, that works great"]
        rows = self._rows(
            [sample_row(g, cid=next(self.cids), ts=i) for i, g in enumerate(greetings)]
            + [sample_row(TOPICS[0], cid=next(self.cids), ts=10), sample_row(near, cid=next(self.cids), ts=11)]
            + [sample_row(TOPICS[i], cid=next(self.cids), ts=20 + i) for i in range(1, 5)]
        )
        res = self.run_build(rows, profile=small_profile(min_train=1, valid_n=2, min_valid=1))
        self.assertEqual(res.manifest["drops"]["trivial-prompt"], 2)
        self.assertEqual(res.manifest["drops"]["duplicate"], 1)
        self.assertEqual(res.manifest["counts"]["targets"], 5)
        ids = res.manifest["promptIds"]["train"] + res.manifest["promptIds"]["valid"]
        self.assertFalse({prompt_id(g) for g in greetings} & set(ids))
        # The older copy is kept, and only one of the pair is anywhere in train or valid.
        self.assertIn(prompt_id(TOPICS[0]), ids)
        self.assertNotIn(prompt_id(near), ids)
        self.assertEqual([p for p in res.sampling_prompts if p["prompt"] in greetings], [])

    def test_valid_is_fixed_and_has_no_near_duplicate_in_train(self):
        rows = self.many(10)
        a = self.run_build(rows, profile=small_profile(valid_n=2))
        b = self.run_build(self.many(10), profile=small_profile(valid_n=2))
        self.assertEqual(a.manifest["promptIds"]["valid"], b.manifest["promptIds"]["valid"])
        self.assertEqual(len(a.valid), 2)
        train_words = [word_set(x["messages"][-2]["content"]) for x in a.train]
        for v in a.valid:
            vw = word_set(v["messages"][-2]["content"])
            self.assertFalse(any(is_near_duplicate(vw, tw) for tw in train_words))

    def test_system_prompt_and_reasoning_are_rendered(self):
        rows = self._rows([sample_row(TOPICS[i], cid=next(self.cids), reasoning="Think it through step by step first.") for i in range(4)])
        res = self.run_build(rows, local_prompt={"system": "You are Flint.", "sha": "abc"})
        x = res.train[0]["messages"]
        self.assertEqual(x[0], {"role": "system", "content": "You are Flint."})
        self.assertEqual(x[-1]["reasoning_content"], "Think it through step by step first.")
        self.assertEqual(res.manifest["localPrompt"]["sha"], "abc")
        self.assertEqual(res.manifest["reasoningShare"], 1.0)

    def test_a_samples_own_system_prompt_wins(self):
        r = Row(prompt="q", source="s", conversation_id="c", ts=0, teacher={}, messages=[{"role": "system", "content": "exact"}, {"role": "user", "content": "q"}, {"role": "assistant", "content": LONG}])
        out = render(r, "live", "reasoning_content")
        self.assertEqual(out[0]["messages"][0]["content"], "exact")
        self.assertEqual(sum(1 for m in out[0]["messages"] if m["role"] == "system"), 1)

    def test_human_rows_are_repeated_but_capped(self):
        self.assertEqual(repeat_factor(0, 10, 0.3), 1)
        self.assertEqual(repeat_factor(10, 0, 0.3), 1)
        self.assertEqual(repeat_factor(1, 100, 0.3), 2)  # at most twice
        self.assertEqual(repeat_factor(30, 50, 0.3), 1)  # 30 of 80 is already past 30%

    def test_no_data_reasons(self):
        self.assertIn("min_train", self.run_build(self.many(2)).manifest["statusReason"])
        p = small_profile(min_reasoning_share=0.3)
        p["serve"]["think"] = True
        res = self.run_build(self.many(6), profile=p)
        self.assertEqual(res.status, "NO_DATA")
        self.assertIn("reasoning channel", res.manifest["statusReason"])

    def test_ok_build(self):
        res = self.run_build(self.many(8))
        self.assertEqual(res.status, "ok")
        self.assertEqual(res.manifest["guard"]["overlap"], {"train": 0, "valid": 0})
        self.assertEqual(res.manifest["counts"]["trainTargets"] + res.manifest["counts"]["validTargets"], 8)

    def test_backstop_catches_what_the_first_pass_missed(self):
        guard = self.guard

        class LateGuard:
            """Blind on the first pass (a bug upstream), sighted on the re-check."""

            calls = 0

            def match(self, p):
                LateGuard.calls += 1
                return guard.match("Explain the birthday paradox.") if LateGuard.calls > 8 else None

            def describe(self):
                return guard.describe()

        res = build(profile=small_profile(), guard=LateGuard(), corpus_rows=[], sample_rows=self.many(8), local_prompt=None)
        self.assertEqual(res.status, "CONTAMINATED")


class Cli(BuildBase):
    def test_main_writes_outputs_and_exit_codes(self):
        tdir = os.path.join(self.dir, "training")
        os.makedirs(os.path.join(tdir, "samples"))
        write_jsonl(os.path.join(tdir, "corpus.jsonl"), [corpus_row(TOPICS[0], cid=next(self.cids))])
        write_jsonl(os.path.join(tdir, "samples", "b1.jsonl"), [sample_row(TOPICS[i], cid=next(self.cids)) for i in range(1, 9)])
        out = os.path.join(self.dir, "out")
        args = ["--corpus", os.path.join(tdir, "corpus.jsonl"), "--samples-dir", os.path.join(tdir, "samples"), "--eval-set", self.eval_path, "--optional-eval-set", os.path.join(self.dir, "flint_tasks.jsonl")]
        # Real profile thresholds: 8 rows is NO_DATA (exit 4), manifest still written, no train file.
        with redirect_stderr(io.StringIO()):
            self.assertEqual(build_data.main(args + ["--out", out]), 4)
        self.assertTrue(os.path.exists(os.path.join(out, "manifest.json")))
        self.assertFalse(os.path.exists(os.path.join(out, "train.jsonl")))
        # --count-only writes nothing.
        out2 = os.path.join(self.dir, "out2")
        with redirect_stdout(io.StringIO()) as so, redirect_stderr(io.StringIO()):
            self.assertEqual(build_data.main(args + ["--count-only"]), 0)
        counts = json.loads(so.getvalue())
        self.assertEqual(counts["targets"], 8)
        self.assertFalse(os.path.exists(out2))
        # A missing required eval set is an error, not "clean".
        with redirect_stderr(io.StringIO()):
            self.assertEqual(build_data.main(args[:4] + ["--eval-set", os.path.join(self.dir, "missing.jsonl"), "--out", out]), 2)


if __name__ == "__main__":
    unittest.main()
