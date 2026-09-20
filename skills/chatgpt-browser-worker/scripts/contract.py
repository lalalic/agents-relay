"""Pure contract helpers for a ChatGPT browser-worker adapter.

This module deliberately has no browser, network, or ChatGPT API dependency.
An adapter built on browser-harness can use these helpers at its boundary and
unit-test them with ordinary dictionaries.
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any

THINKING_LEVELS = frozenset({"default", "low", "medium", "high"})
EFFECTIVE_LEVELS = THINKING_LEVELS | {"unknown"}
STATUSES = frozenset(
    {"created", "running", "awaiting_result", "completed", "failed", "blocked", "deleted"}
)
OPERATIONS = frozenset({"create", "resume", "status", "result", "delete"})


class ContractError(ValueError):
    """Raised when an input crosses the worker boundary incorrectly."""


def _text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ContractError(f"{field} must be a non-empty string")
    return value.strip()


def validate_project(project: Any) -> dict[str, str]:
    if not isinstance(project, dict):
        raise ContractError("project must be an object")
    result = {"name": _text(project.get("name"), "project.name")}
    if project.get("id") is not None:
        result["id"] = _text(project["id"], "project.id")
    return result


def validate_request(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ContractError("request must be an object")
    operation = _text(request.get("operation"), "operation")
    if operation not in OPERATIONS:
        raise ContractError(f"unsupported operation: {operation}")
    result: dict[str, Any] = {"operation": operation}
    if operation in {"create", "resume"}:
        result["project"] = validate_project(request.get("project"))
    if operation == "create":
        result["prompt"] = _text(request.get("prompt"), "prompt")
        level = _text(request.get("thinking_level"), "thinking_level")
        if level not in THINKING_LEVELS:
            raise ContractError(f"unsupported thinking_level: {level}")
        result["thinking_level"] = level
    elif operation == "resume" and request.get("thinking_level") is not None:
        level = _text(request["thinking_level"], "thinking_level")
        if level not in THINKING_LEVELS:
            raise ContractError(f"unsupported thinking_level: {level}")
        result["thinking_level"] = level
    if operation != "create":
        result["thread_id"] = _text(request.get("thread_id"), "thread_id")
    return result


def validate_state(state: Any) -> dict[str, Any]:
    if not isinstance(state, dict):
        raise ContractError("state must be an object")
    if state.get("schema_version") != 1:
        raise ContractError("schema_version must be 1")
    result = deepcopy(state)
    result["thread_id"] = _text(state.get("thread_id"), "thread_id")
    result["project"] = validate_project(state.get("project"))
    status = _text(state.get("status"), "status")
    if status not in STATUSES:
        raise ContractError(f"unsupported status: {status}")
    result["status"] = status
    requested = _text(state.get("requested_thinking_level"), "requested_thinking_level")
    if requested not in THINKING_LEVELS:
        raise ContractError(f"unsupported requested_thinking_level: {requested}")
    result["requested_thinking_level"] = requested
    effective = _text(state.get("effective_thinking_level"), "effective_thinking_level")
    if effective not in EFFECTIVE_LEVELS:
        raise ContractError(f"unsupported effective_thinking_level: {effective}")
    result["effective_thinking_level"] = effective
    return result


def validate_result(result: Any, *, thread_id: str | None = None) -> dict[str, Any]:
    """Accept only a normalized, observed assistant result."""
    if not isinstance(result, dict):
        raise ContractError("result must be an object")
    result_thread_id = _text(result.get("thread_id"), "result.thread_id")
    if thread_id is not None and result_thread_id != _text(thread_id, "thread_id"):
        raise ContractError("result belongs to a different thread")
    if result.get("status") != "completed":
        raise ContractError("only a completed observed result is reportable")
    normalized = deepcopy(result)
    normalized["thread_id"] = result_thread_id
    normalized["text"] = _text(result.get("text"), "result.text")
    normalized["message_id"] = _text(result.get("message_id"), "result.message_id")
    if result.get("observed_at") is not None:
        normalized["observed_at"] = _text(result["observed_at"], "result.observed_at")
    return normalized


def validate_cleanup_observation(observation: Any, *, thread_id: str) -> dict[str, Any]:
    """Accept browser evidence that exactly one requested thread is gone."""
    if not isinstance(observation, dict):
        raise ContractError("cleanup observation must be an object")
    expected_id = _text(thread_id, "thread_id")
    observed_id = observation.get("thread_id")
    if observed_id is not None and _text(observed_id, "cleanup.thread_id") != expected_id:
        raise ContractError("cleanup observation belongs to a different thread")
    outcome = _text(observation.get("outcome"), "cleanup.outcome")
    if outcome not in {"deleted", "not_found"}:
        raise ContractError("cleanup was not verified")
    if observation.get("verified") is not True:
        raise ContractError("cleanup observation is not verified")
    return deepcopy(observation)


def project_matches(expected: Any, observed: Any) -> bool:
    expected_project = validate_project(expected)
    observed_project = validate_project(observed)
    if expected_project["name"] != observed_project["name"]:
        return False
    # A browser boundary may expose only the visible Project name. Compare
    # opaque IDs only when both sides actually observed one.
    return not (expected_project.get("id") and observed_project.get("id")) or expected_project["id"] == observed_project["id"]


def transition(state: Any, new_status: str, *, observed_project: Any | None = None) -> dict[str, Any]:
    current = validate_state(state)
    new_status = _text(new_status, "status")
    if new_status not in STATUSES:
        raise ContractError(f"unsupported status: {new_status}")
    if current["status"] == "deleted":
        raise ContractError("deleted thread is terminal")
    if observed_project is not None and not project_matches(current["project"], observed_project):
        raise ContractError("observed Project does not match durable Project binding")
    allowed = {
        "created": {"running", "blocked", "failed", "deleted"},
        "running": {"awaiting_result", "completed", "blocked", "failed", "deleted"},
        "awaiting_result": {"completed", "running", "blocked", "failed", "deleted"},
        "completed": {"running", "blocked", "deleted"},
        "failed": {"running", "blocked", "deleted"},
        "blocked": {"running", "blocked", "failed", "deleted"},
    }
    if new_status not in allowed[current["status"]]:
        raise ContractError(f"invalid transition: {current['status']} -> {new_status}")
    current["status"] = new_status
    return current
