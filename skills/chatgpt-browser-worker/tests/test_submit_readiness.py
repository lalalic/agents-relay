import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

from _submit_readiness import wait_until_stable


class SubmitReadinessTests(unittest.TestCase):
    def test_slow_attachment_does_not_fail_on_visible_filename(self):
        states = iter([
            {"names": ["report.pdf"], "pending": True},
            {"names": ["report.pdf"], "pending": True},
            {"names": ["report.pdf"], "pending": False},
            {"names": ["report.pdf"], "pending": False},
        ])
        result = wait_until_stable(
            lambda: next(states),
            lambda state: state["names"] == ["report.pdf"] and not state["pending"],
            timeout=1,
            interval=0,
            phase="attachment upload readiness",
        )
        self.assertFalse(result["pending"])

    def test_delayed_send_enablement_is_polled_until_stable(self):
        states = iter([
            {"enabled": False},
            {"enabled": False},
            {"enabled": True},
            {"enabled": True},
        ])
        result = wait_until_stable(
            lambda: next(states),
            lambda state: state["enabled"],
            timeout=1,
            interval=0,
            phase="send readiness",
        )
        self.assertTrue(result["enabled"])


if __name__ == "__main__":
    unittest.main()
