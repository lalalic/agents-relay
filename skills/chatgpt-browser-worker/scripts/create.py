"""Create a ChatGPT thread through an injected browser-harness port."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Protocol

try:
    from .contract import ContractError, project_matches, validate_request
except ImportError:  # Loaded directly by the lightweight skill test harness.
    from contract import ContractError, project_matches, validate_request


class BrowserPort(Protocol):
    def select_project(self, project: dict[str, str]) -> dict[str, Any]: ...
    def set_thinking_level(self, level: str) -> dict[str, Any]: ...
    def send_prompt(self, prompt: str) -> dict[str, Any]: ...


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _effective_level(observation: Any) -> str:
    if not isinstance(observation, dict):
        return "unknown"
    value = observation.get("effective_thinking_level", observation.get("level"))
    return value if value in {"default", "low", "medium", "high"} else "unknown"


def create_thread(
    port: BrowserPort,
    request: Any,
    *,
    persist: Callable[[dict[str, Any]], None] | None = None,
    now: Callable[[], str] = _now,
) -> dict[str, Any]:
    """Select the requested Project, send the first prompt, and return state.

    The port returns observations from the browser.  It is deliberately not
    responsible for durable state or contract validation.
    """
    request = validate_request(request)
    if request["operation"] != "create":
        raise ContractError("create_thread requires operation=create")

    selected = port.select_project(request["project"])
    if not project_matches(request["project"], selected):
        raise ContractError("browser observed a different Project after selection")

    thinking_observation: dict[str, Any] = {"requested": "default", "changed": False}
    effective = "unknown"
    if request["thinking_level"] != "default":
        raw = port.set_thinking_level(request["thinking_level"])
        thinking_observation = dict(raw) if isinstance(raw, dict) else {"observed": raw}
        thinking_observation["requested"] = request["thinking_level"]
        thinking_observation["changed"] = True
        effective = _effective_level(raw)

    sent = port.send_prompt(request["prompt"])
    if not isinstance(sent, dict) or not isinstance(sent.get("thread_id"), str) or not sent["thread_id"].strip():
        raise ContractError("browser did not return an observed thread_id")

    timestamp = now()
    state: dict[str, Any] = {
        "schema_version": 1,
        "thread_id": sent["thread_id"].strip(),
        "project": dict(selected),
        "status": "running",
        "requested_thinking_level": request["thinking_level"],
        "effective_thinking_level": effective,
        "created_at": timestamp,
        "updated_at": timestamp,
        "last_error": None,
        "evidence": {
            "project": dict(selected),
            "thinking": thinking_observation,
            "thread": {key: value for key, value in sent.items() if key != "text"},
        },
    }
    if "conversation_url" in sent:
        state["conversation_url"] = sent["conversation_url"]
    if persist is not None:
        persist(state)
    return state
