"""Bounded polling helpers for ChatGPT submit readiness."""
from __future__ import annotations

import time
from collections.abc import Callable, Mapping


def wait_until_stable(
    read_state: Callable[[], Mapping[str, object]],
    ready: Callable[[Mapping[str, object]], bool],
    *,
    timeout: float,
    interval: float = 0.25,
    stable_samples: int = 2,
    phase: str,
) -> Mapping[str, object]:
    """Return only after the observable state is ready for stable_samples polls."""
    deadline = time.monotonic() + timeout
    stable = 0
    last_state: Mapping[str, object] = {}
    while time.monotonic() < deadline:
        last_state = read_state()
        if ready(last_state):
            stable += 1
            if stable >= stable_samples:
                return last_state
        else:
            stable = 0
        time.sleep(interval)
    raise RuntimeError(f"Temporary Chat {phase} was not observed ready")
