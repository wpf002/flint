import os
import unittest

from helpers import temp_dir

from profiles import DEFAULT_PROFILE, PROFILES_DIR, ProfileError, load_profile, parse_footprint


class Profiles(unittest.TestCase):
    def test_every_shipped_profile_loads(self):
        names = sorted(f[:-5] for f in os.listdir(PROFILES_DIR) if f.endswith(".toml"))
        self.assertEqual(names, ["muse-glimmer-30b", "qwen3.6-35b-a3b", "qwen3.8-27b"])
        for n in names:
            with self.subTest(profile=n):
                p = load_profile(n)
                self.assertEqual(p["name"], n)
                self.assertEqual(p["base"]["licence"], "apache-2.0")
                self.assertTrue(p["base"]["mlx_revision"])
                # A shipped profile never lists a teacher: adding one is a deliberate act.
                self.assertEqual(p["teachers"], {})
                # Memory-safe next to the live model (research: >= 4096 stalls it).
                self.assertLessEqual(p["train"]["max_seq_length"], 3072)

    def test_default_is_the_research_recommendation(self):
        self.assertEqual(DEFAULT_PROFILE, "muse-glimmer-30b")
        p = load_profile(None) if not os.environ.get("FLINT_BRAIN_PROFILE") else load_profile(DEFAULT_PROFILE)
        self.assertEqual(p["base"]["ollama_live"], "muse-glimmer:30b")
        self.assertEqual(p["toolchain"]["mlx_lm_git"], "1b3594b9c3a252b1c5d386424543b4cd6519d47c")

    def test_bad_profiles(self):
        d = temp_dir()
        bad = os.path.join(d, "bad.toml")
        with open(bad, "w") as f:
            f.write('name = "bad"\n[base]\nfamily = "x"\n')
        with self.assertRaises(ProfileError):
            load_profile(bad)
        with self.assertRaises(ProfileError):
            load_profile("no-such-profile")
        with self.assertRaises(ProfileError):
            parse_footprint("2048")
        self.assertEqual(parse_footprint("1536x8"), (1536, 8))


if __name__ == "__main__":
    unittest.main()
