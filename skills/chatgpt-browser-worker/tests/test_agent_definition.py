from pathlib import Path


AGENT = Path(__file__).parents[1] / "agents" / "browser-worker.agent.md"


def test_browser_worker_agent_defines_typed_lifecycle_and_verified_result():
    text = AGENT.read_text()

    for operation in ("create", "resume", "continue", "status", "result", "delete"):
        assert f"`{operation}`" in text
    for field in ("thread_id", "project", "message_id", "verified", "observed_at"):
        assert f'"{field}"' in text
    assert "browser-harness" in text
    assert "authentication_required" in text
    assert "Do not report success" in text


def test_callers_are_directed_to_launch_agent_not_helper_scripts():
    skill = (AGENT.parents[1] / "SKILL.md").read_text()
    orchestration = (AGENT.parents[1] / "references" / "orchestration.md").read_text()

    assert "Callers launch that" in skill
    assert "agent with a typed lifecycle intent" in skill
    assert "must not directly call" in skill
    assert "launches the `browser-worker` agent" in orchestration
    assert "must not directly invoke" in orchestration
