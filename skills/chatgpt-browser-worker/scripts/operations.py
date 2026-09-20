"""Existing-thread operations for an injected browser-harness port."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Protocol

try:
    from .contract import ContractError, transition, validate_cleanup_observation, validate_project, validate_request, validate_result, validate_state
except ImportError:
    from contract import ContractError, transition, validate_cleanup_observation, validate_project, validate_request, validate_result, validate_state


class BrowserPort(Protocol):
    def open_thread(self, thread_id: str) -> dict[str, Any]: ...
    def send_prompt(self, prompt: str) -> dict[str, Any]: ...
    def read_status(self) -> dict[str, Any]: ...
    def read_result(self) -> dict[str, Any]: ...
    def delete_thread(self) -> dict[str, Any]: ...


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _project(observation: Any) -> dict[str, Any]:
    if not isinstance(observation, dict):
        raise ContractError("browser did not return an observed thread")
    project = observation.get("project", observation.get("selected_project"))
    if project is None:
        raise ContractError("browser did not expose the thread Project")
    return project


def _status(observation: Any, default: str = "awaiting_result") -> str:
    value = observation.get("status") if isinstance(observation, dict) else None
    return value if value in {"created", "running", "awaiting_result", "completed", "failed", "blocked"} else default


def _same_project(left: Any, right: Any) -> bool:
    """Compare names always; compare IDs only when both UI boundaries expose them."""
    expected = validate_project(left)
    observed = validate_project(right)
    return expected["name"] == observed["name"] and (
        "id" not in expected or "id" not in observed or expected["id"] == observed["id"]
    )


def _save(state: dict[str, Any], persist: Callable[[dict[str, Any]], None] | None, now: Callable[[], str]) -> dict[str, Any]:
    state["updated_at"] = now()
    if persist is not None:
        persist(state)
    return state


def _opened(port: BrowserPort, state: dict[str, Any], *, expected_project: dict[str, Any]) -> dict[str, Any]:
    opened = port.open_thread(state["thread_id"])
    if not isinstance(opened, dict):
        raise ContractError("browser did not return an observed thread")
    observed_id = opened.get("thread_id", state["thread_id"])
    if observed_id != state["thread_id"]:
        raise ContractError("browser opened a different thread")
    observed_project = _project(opened)
    if not _same_project(expected_project, observed_project):
        raise ContractError("observed Project does not match durable Project binding")
    return opened


def resume_thread(
    port: BrowserPort,
    request: Any,
    *,
    state: Any | None = None,
    persist: Callable[[dict[str, Any]], None] | None = None,
    now: Callable[[], str] = _now,
) -> dict[str, Any]:
    """Open and verify an existing thread without sending a new prompt."""
    request = validate_request(request)
    if request["operation"] != "resume":
        raise ContractError("resume_thread requires operation=resume")
    current = validate_state(state) if state is not None else {
        "schema_version": 1,
        "thread_id": request["thread_id"],
        "project": request["project"],
        "status": "created",
        "requested_thinking_level": request.get("thinking_level", "default"),
        "effective_thinking_level": "unknown",
    }
    if current["thread_id"] != request["thread_id"]:
        raise ContractError("resume request does not match durable thread identity")
    if current["status"] == "deleted":
        raise ContractError("deleted thread is terminal")
    if not _same_project(current["project"], request["project"]):
        raise ContractError("resume Project does not match durable Project binding")
    opened = _opened(port, current, expected_project=current["project"])
    observed_status = _status(opened)
    if current["status"] == "created":
        current = transition(current, "running")
    if observed_status != current["status"]:
        current = transition(current, observed_status)
    current["project"] = dict(_project(opened))
    current.setdefault("evidence", {})["open"] = opened
    return _save(current, persist, now)


def continue_thread(
    port: BrowserPort,
    state: Any,
    prompt: str,
    *,
    persist: Callable[[dict[str, Any]], None] | None = None,
    now: Callable[[], str] = _now,
) -> dict[str, Any]:
    """Open a durable thread, send one follow-up prompt, and persist running state."""
    current = validate_state(state)
    if not isinstance(prompt, str) or not prompt.strip():
        raise ContractError("prompt must be a non-empty string")
    _opened(port, current, expected_project=current["project"])
    if current["status"] != "running":
        current = transition(current, "running")
    sent = port.send_prompt(prompt.strip())
    if not isinstance(sent, dict):
        raise ContractError("browser did not acknowledge the follow-up prompt")
    current.setdefault("evidence", {})["prompt"] = sent
    return _save(current, persist, now)


def inspect_thread(
    port: BrowserPort,
    state: Any,
    *,
    persist: Callable[[dict[str, Any]], None] | None = None,
    now: Callable[[], str] = _now,
) -> dict[str, Any]:
    """Read the observable UI status/progress and persist its state transition."""
    current = validate_state(state)
    if current["status"] == "deleted":
        raise ContractError("deleted thread is terminal")
    observation = port.read_status()
    observed_status = _status(observation, default="awaiting_result")
    if observed_status != current["status"]:
        current = transition(current, observed_status)
    current.setdefault("evidence", {})["status"] = observation
    return _save(current, persist, now)


def result_thread(
    port: BrowserPort,
    state: Any,
    *,
    persist: Callable[[dict[str, Any]], None] | None = None,
    now: Callable[[], str] = _now,
) -> dict[str, Any]:
    """Return only an observed, normalized assistant result and persist completion."""
    current = validate_state(state)
    if current["status"] == "deleted":
        raise ContractError("deleted thread is terminal")
    result = validate_result(port.read_result(), thread_id=current["thread_id"])
    if current["status"] != "completed":
        current = transition(current, "completed")
    current.setdefault("evidence", {})["result"] = result
    _save(current, persist, now)
    return result


def delete_thread(
    port: BrowserPort,
    state: Any,
    *,
    persist: Callable[[dict[str, Any]], None] | None = None,
    now: Callable[[], str] = _now,
) -> dict[str, Any]:
    """Delete one durable thread and persist its terminal tombstone."""
    current = validate_state(state)
    if current["status"] == "deleted":
        return current
    observation = validate_cleanup_observation(port.delete_thread(), thread_id=current["thread_id"])
    current = transition(current, "deleted")
    current.setdefault("evidence", {})["cleanup"] = observation
    return _save(current, persist, now)
