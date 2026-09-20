from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest


HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("chatgpt_browser_worker_contract", HERE / "scripts/contract.py")
assert spec and spec.loader
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)
sys.modules["contract"] = contract

create_spec = importlib.util.spec_from_file_location("chatgpt_browser_worker_create", HERE / "scripts/create.py")
assert create_spec and create_spec.loader
create = importlib.util.module_from_spec(create_spec)
create_spec.loader.exec_module(create)

operations_spec = importlib.util.spec_from_file_location("chatgpt_browser_worker_operations", HERE / "scripts/operations.py")
assert operations_spec and operations_spec.loader
operations = importlib.util.module_from_spec(operations_spec)
operations_spec.loader.exec_module(operations)


def state(status="created", project=None):
    return {
        "schema_version": 1,
        "thread_id": "thread-1",
        "project": project or {"id": "project-1", "name": "neo"},
        "status": status,
        "requested_thinking_level": "high",
        "effective_thinking_level": "unknown",
    }


def test_create_and_resume_require_verified_project_and_preserve_level_request():
    created = contract.validate_request(
        {"operation": "create", "project": {"name": "neo"}, "prompt": "hello", "thinking_level": "high"}
    )
    resumed = contract.validate_request(
        {"operation": "resume", "thread_id": "thread-1", "project": {"id": "project-1", "name": "neo"}}
    )
    assert created["project"] == {"name": "neo"}
    assert created["thinking_level"] == "high"
    assert resumed["thread_id"] == "thread-1"
    with pytest.raises(contract.ContractError):
        contract.validate_request({"operation": "create", "prompt": "hello", "thinking_level": "high"})


def test_project_mismatch_is_rejected_and_unknown_effective_level_is_valid():
    current = contract.validate_state(state())
    assert current["effective_thinking_level"] == "unknown"
    with pytest.raises(contract.ContractError, match="Project"):
        contract.transition(current, "running", observed_project={"id": "other", "name": "other"})


def test_project_id_is_optional_at_a_browser_boundary():
    assert contract.project_matches({"id": "project-1", "name": "neo"}, {"name": "neo"})
    assert not contract.project_matches({"id": "project-1", "name": "neo"}, {"id": "other", "name": "neo"})


def test_completion_requires_explicit_transition_and_delete_is_terminal():
    running = contract.transition(state(), "running")
    waiting = contract.transition(running, "awaiting_result")
    completed = contract.transition(waiting, "completed")
    assert completed["status"] == "completed"
    deleted = contract.transition(completed, "deleted")
    assert deleted["status"] == "deleted"
    with pytest.raises(contract.ContractError, match="terminal"):
        contract.transition(deleted, "running")


def test_result_requires_observed_assistant_message_and_matching_identity():
    result = contract.validate_result(
        {
            "thread_id": "thread-1",
            "status": "completed",
            "text": "normalized answer",
            "message_id": "message-1",
        },
        thread_id="thread-1",
    )
    assert result["message_id"] == "message-1"
    with pytest.raises(contract.ContractError):
        contract.validate_result(
            {"thread_id": "thread-1", "status": "completed", "text": "answer"},
            thread_id="thread-1",
        )
    with pytest.raises(contract.ContractError, match="different thread"):
        contract.validate_result(
            {
                "thread_id": "other",
                "status": "completed",
                "text": "answer",
                "message_id": "message-1",
            },
            thread_id="thread-1",
        )


def test_contract_module_has_no_browser_runtime_dependency():
    source = (HERE / "scripts/contract.py").read_text()
    assert "import browser_harness" not in source
    assert "import macbridge" not in source.lower()


class FakePort:
    def __init__(self, project=None, sent=None):
        self.project = project or {"id": "project-1", "name": "neo"}
        self.sent = sent or {"thread_id": "thread-42", "conversation_url": "https://chatgpt.com/c/thread-42", "prompt_sent": True}
        self.calls = []

    def select_project(self, project):
        self.calls.append(("select_project", project))
        return self.project

    def set_thinking_level(self, level):
        self.calls.append(("set_thinking_level", level))
        return {"effective_thinking_level": level, "label": level.title()}

    def send_prompt(self, prompt):
        self.calls.append(("send_prompt", prompt))
        return self.sent


class ExistingThreadPort:
    def __init__(self, project=None, status="awaiting_result", result=None):
        self.project = project or {"id": "project-1", "name": "neo"}
        self.status = status
        self.result = result or {
            "thread_id": "thread-1",
            "status": "completed",
            "text": "done",
            "message_id": "message-1",
        }
        self.calls = []

    def open_thread(self, thread_id):
        self.calls.append(("open_thread", thread_id))
        return {"thread_id": thread_id, "project": self.project, "status": self.status}

    def send_prompt(self, prompt):
        self.calls.append(("send_prompt", prompt))
        return {"prompt_sent": True}

    def read_status(self):
        self.calls.append(("read_status",))
        return {"status": self.status, "progress": "visible"}

    def read_result(self):
        self.calls.append(("read_result",))
        return self.result

    def delete_thread(self):
        self.calls.append(("delete_thread",))
        return {"thread_id": "thread-1", "outcome": "deleted", "verified": True}


def test_create_returns_durable_identity_project_binding_and_evidence():
    port = FakePort()
    persisted = []
    result = create.create_thread(
        port,
        {"operation": "create", "project": {"name": "neo"}, "prompt": "hello", "thinking_level": "high"},
        persist=persisted.append,
        now=lambda: "2026-09-19T12:00:00Z",
    )
    assert result["thread_id"] == "thread-42"
    assert result["project"] == port.project
    assert result["effective_thinking_level"] == "high"
    assert result["evidence"]["thread"]["prompt_sent"] is True
    assert persisted == [result]
    assert [call[0] for call in port.calls] == ["select_project", "set_thinking_level", "send_prompt"]


def test_create_default_leaves_platform_thinking_unchanged():
    port = FakePort()
    result = create.create_thread(
        port,
        {"operation": "create", "project": {"name": "neo"}, "prompt": "hello", "thinking_level": "default"},
    )
    assert result["requested_thinking_level"] == "default"
    assert result["effective_thinking_level"] == "unknown"
    assert [call[0] for call in port.calls] == ["select_project", "send_prompt"]


def test_create_rejects_unverified_project_and_missing_thread_identity():
    with pytest.raises(contract.ContractError, match="different Project"):
        create.create_thread(
            FakePort(project={"name": "other"}),
            {"operation": "create", "project": {"name": "neo"}, "prompt": "hello", "thinking_level": "default"},
        )
    with pytest.raises(contract.ContractError, match="thread_id"):
        create.create_thread(
            FakePort(sent={"prompt_sent": True}),
            {"operation": "create", "project": {"name": "neo"}, "prompt": "hello", "thinking_level": "default"},
        )


def test_resume_opens_durable_thread_and_requires_observed_project():
    port = ExistingThreadPort()
    persisted = []
    result = operations.resume_thread(
        port,
        {"operation": "resume", "thread_id": "thread-1", "project": {"name": "neo"}},
        state=state("running"),
        persist=persisted.append,
        now=lambda: "2026-09-19T12:03:00Z",
    )
    assert result["status"] == "awaiting_result"
    assert result["updated_at"] == "2026-09-19T12:03:00Z"
    assert persisted == [result]
    with pytest.raises(contract.ContractError, match="Project"):
        operations.resume_thread(
            ExistingThreadPort(project={"id": "other", "name": "other"}),
            {"operation": "resume", "thread_id": "thread-1", "project": {"name": "neo"}},
            state=state("running"),
        )


def test_continue_status_and_result_persist_observed_transitions():
    port = ExistingThreadPort(status="running")
    persisted = []
    running = operations.continue_thread(port, state("completed"), "continue", persist=persisted.append)
    assert running["status"] == "running"
    observed = operations.inspect_thread(port, running, persist=persisted.append)
    assert observed["status"] == "running"
    port.status = "completed"
    result = operations.result_thread(port, observed, persist=persisted.append)
    assert result["text"] == "done"
    assert [call[0] for call in port.calls] == ["open_thread", "send_prompt", "read_status", "read_result"]
    assert [item["status"] for item in persisted] == ["running", "running", "completed"]


def test_result_without_observed_assistant_message_does_not_complete_thread():
    port = ExistingThreadPort(result={"thread_id": "thread-1", "status": "awaiting_result"})
    with pytest.raises(contract.ContractError, match="completed"):
        operations.result_thread(port, state("running"))


def test_delete_persists_verified_tombstone_and_is_idempotent():
    port = ExistingThreadPort()
    persisted = []
    deleted = operations.delete_thread(
        port, state("completed"), persist=persisted.append,
        now=lambda: "2026-09-19T12:04:00Z",
    )
    assert deleted["status"] == "deleted"
    assert deleted["evidence"]["cleanup"]["verified"] is True
    assert deleted["updated_at"] == "2026-09-19T12:04:00Z"
    assert [call[0] for call in port.calls] == ["delete_thread"]

    again = operations.delete_thread(port, deleted, persist=persisted.append)
    assert again["status"] == "deleted"
    assert [call[0] for call in port.calls] == ["delete_thread"]


def test_delete_accepts_verified_not_found_for_retry_safety():
    class MissingPort(ExistingThreadPort):
        def delete_thread(self):
            return {"thread_id": "thread-1", "outcome": "not_found", "verified": True}

    deleted = operations.delete_thread(MissingPort(), state("failed"))
    assert deleted["status"] == "deleted"


def test_cleanup_rejects_unverified_or_unrelated_observations():
    with pytest.raises(contract.ContractError, match="verified"):
        contract.validate_cleanup_observation(
            {"thread_id": "thread-1", "outcome": "deleted", "verified": False},
            thread_id="thread-1",
        )
    with pytest.raises(contract.ContractError, match="different thread"):
        contract.validate_cleanup_observation(
            {"thread_id": "other", "outcome": "deleted", "verified": True},
            thread_id="thread-1",
        )


def test_agents_relay_fixture_drives_one_serial_browser_thread_lifecycle():
    fixture = json.loads((HERE / "tests" / "fixtures" / "relay_lifecycle.json").read_text())
    port = ExistingThreadPort(status="completed", result=fixture["result"])
    port.project = fixture["project"]
    persisted = []

    created = create.create_thread(
        FakePort(project=fixture["project"], sent=fixture["thread"]),
        fixture["create"],
        persist=persisted.append,
        now=lambda: "2026-09-19T12:00:00Z",
    )
    resumed = operations.resume_thread(
        port,
        {"operation": "resume", "thread_id": created["thread_id"], "project": fixture["project"]},
        state=created,
        persist=persisted.append,
        now=lambda: "2026-09-19T12:01:00Z",
    )
    result = operations.result_thread(
        port, resumed, persist=persisted.append, now=lambda: "2026-09-19T12:02:00Z"
    )
    deleted = operations.delete_thread(
        port, resumed, persist=persisted.append, now=lambda: "2026-09-19T12:03:00Z"
    )

    assert fixture["job_id"] and fixture["task_id"]
    assert created["thread_id"] == fixture["thread"]["thread_id"]
    assert result["text"] == fixture["result"]["text"]
    assert deleted["status"] == "deleted"
    assert [call[0] for call in port.calls] == ["open_thread", "read_result", "delete_thread"]
    assert [item["status"] for item in persisted] == ["running", "completed", "completed", "deleted"]
