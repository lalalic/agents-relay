import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release_native", Path(__file__).with_name("release-native.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class MaintenanceGuard(unittest.TestCase):
    def test_pause_requires_no_generations(self):
        job = dict(id="738", state="ACTIVE", pause=dict(requestedAt="now"),
                   tasks=[dict(state="QUEUED")], plans=[])
        self.assertTrue(release.paused_and_quiescent(job))
        for change in (
            dict(pause=None), dict(tasks=None), dict(plans=None),
            dict(tasks=[dict(executionId="live")]),
            dict(tasks=[dict(pausedExecution={"id":"pending"})]),
            dict(plans=[dict(executionId="live")]),
            dict(plans=[dict(pausedExecutionId="pending")]),
        ):
            self.assertFalse(release.paused_and_quiescent(dict(job, **change)))

    def test_requires_explicit_matching_paused_job(self):
        listed = [{"id":"738","state":"ACTIVE"}]
        detail = dict(id="738", state="ACTIVE", pause=dict(requestedAt="now"),
                      tasks=[], plans=[])
        with patch.object(release, "run", side_effect=[json.dumps(listed)]):
            with self.assertRaises(RuntimeError):
                release.check_idle()
        with patch.object(release, "run", side_effect=[json.dumps(listed), json.dumps(detail)]):
            release.check_idle("738")
        with patch.object(release, "run", side_effect=[json.dumps(listed + [{"id":"739","state":"ACTIVE"}]), json.dumps(detail)]):
            with self.assertRaises(RuntimeError):
                release.check_idle("738")
        with patch.object(release, "run", side_effect=[json.dumps(listed), json.dumps(dict(detail,pause=None))]):
            with self.assertRaises(RuntimeError):
                release.check_idle("738")

if __name__ == "__main__":
    unittest.main()
