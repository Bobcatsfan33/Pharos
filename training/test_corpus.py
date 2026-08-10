"""Deterministic unit checks for the train-only corpus recipe."""

import unittest

from corpus import FUNDS_META_FRAMES, generate


def is_meta_framed(text: str) -> bool:
    for frame in FUNDS_META_FRAMES:
        prefix, suffix = frame.split("{t}")
        if text.startswith(prefix) and text.endswith(suffix):
            return True
    return False


class CorpusRecipeTest(unittest.TestCase):
    def test_generation_is_deterministic(self):
        self.assertEqual(generate("funds-movement-intent"), generate("funds-movement-intent"))

    def test_funds_meta_frames_are_balanced_across_labels(self):
        rows = generate("funds-movement-intent")
        framed = [row for row in rows if is_meta_framed(row["text"])]

        self.assertEqual(len(framed), 600)
        self.assertEqual(sum(row["label"] == 1 for row in framed), 360)
        self.assertEqual(sum(row["label"] == 0 for row in framed), 240)
        self.assertTrue(all(row["lang"] == "en" for row in framed))

    def test_meta_frame_recipe_does_not_copy_dev_transform(self):
        lowered = [frame.lower() for frame in FUNDS_META_FRAMES]
        self.assertTrue(all("what this really means is that" not in frame for frame in lowered))
        self.assertTrue(all("that is the bottom line" not in frame for frame in lowered))

    def test_meta_frames_are_funds_specific(self):
        for concern in ("finra-promissory", "phi-in-context"):
            self.assertFalse(any(is_meta_framed(row["text"]) for row in generate(concern)))


if __name__ == "__main__":
    unittest.main()
