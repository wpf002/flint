import json
import os
import unittest

from helpers import temp_dir

from memcheck import decide, measured_peaks
from profiles import load_profile

MUSE = load_profile("muse-glimmer-30b")
STUDIO = {"ram_gb": 68.7, "wired_limit_gb": 60.1}  # 64 GiB M5 Max, iogpu.wired_limit_mb=57344


class Decide(unittest.TestCase):
    def test_the_studio_fits_the_default_footprint_next_to_the_live_model(self):
        r = decide(MUSE, **STUDIO, ollama_now_gb=18.5, pressure="normal", measured={})
        self.assertEqual(r["decision"], "coexist")
        self.assertEqual(r["footprint"], "2048x16")
        self.assertEqual((r["maxSeqLength"], r["numLayers"]), (2048, 16))
        # Live model at its worst case (20) + a 30 GB run + 10 GB headroom <= 68.7; 20 + 30 <= 58.1.
        self.assertEqual(r["ollamaGb"], 20.0)
        self.assertLessEqual(r["memBudgetGb"], STUDIO["wired_limit_gb"] - 2 - 20)

    def test_an_idle_unloaded_model_still_counts(self):
        # Ollama unloaded muse after keep_alive: /api/ps says 0, but the next chat reloads it.
        r = decide(MUSE, **STUDIO, ollama_now_gb=0.0, pressure="normal", measured={})
        self.assertEqual(r["ollamaGb"], 20.0)

    def test_falls_back_to_a_smaller_footprint(self):
        # A bake-off candidate is also loaded: 38 GB resident.
        r = decide(MUSE, **STUDIO, ollama_now_gb=38.0, pressure="normal", measured={})
        self.assertEqual(r["decision"], "defer")
        # 29 + 30 + 10 > 68.7 GB RAM, but 29 + 27 + 10 fits and 29 + 27 <= 58.1 wired.
        r = decide(MUSE, **STUDIO, ollama_now_gb=29.0, pressure="normal", measured={})
        self.assertEqual(r["decision"], "coexist")
        self.assertEqual(r["footprint"], "2048x8")
        self.assertFalse(r["tried"][0]["fitsWired"] and r["tried"][0]["fitsRam"])

    def test_measured_peaks_replace_estimates(self):
        r = decide(MUSE, **STUDIO, ollama_now_gb=None, pressure="normal", measured={"2048x16": 45.0})
        self.assertEqual(r["footprint"], "2048x8")
        self.assertEqual(r["tried"][0]["source"], "measured")

    def test_memory_pressure_defers(self):
        r = decide(MUSE, **STUDIO, ollama_now_gb=18.0, pressure="warn", measured={})
        self.assertEqual(r["decision"], "defer")
        self.assertIn("pressure", r["reason"])

    def test_a_32gb_machine_defers(self):
        r = decide(MUSE, ram_gb=34.4, wired_limit_gb=25.8, ollama_now_gb=18.0, pressure="normal", measured={})
        self.assertEqual(r["decision"], "defer")


class MeasuredPeaks(unittest.TestCase):
    def test_reads_early_stop_json_for_this_profile_only(self):
        d = temp_dir()
        for cycle, prof, fp, peak in [("a", "muse-glimmer-30b", "2048x16", 27.0), ("b", "muse-glimmer-30b", "2048x16", 29.5), ("c", "qwen3.8-27b", "2048x16", 40.0)]:
            os.makedirs(os.path.join(d, cycle, "adapter"))
            with open(os.path.join(d, cycle, "adapter", "early_stop.json"), "w") as f:
                json.dump({"profile": prof, "footprint": fp, "peak_memory_gb": peak - 1, "peakMemoryGbMlx": peak}, f)
        self.assertEqual(measured_peaks(d, "muse-glimmer-30b"), {"2048x16": 29.5})


if __name__ == "__main__":
    unittest.main()
