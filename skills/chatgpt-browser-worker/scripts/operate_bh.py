#!/usr/bin/env python3
"""Run one existing-thread operation through the authenticated browser-harness."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile


BH_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_operate_bh.py")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("resume", "continue", "status", "result", "delete"))
    parser.add_argument("--thread-id", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--prompt")
    args = parser.parse_args()
    if args.operation == "continue" and not args.prompt:
        parser.error("continue requires --prompt")
    config = {key: value for key, value in vars(args).items() if value is not None}
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as handle:
        json.dump(config, handle, ensure_ascii=False)
        config_path = handle.name
    try:
        code = open(BH_SCRIPT, encoding="utf-8").read().replace("__CFG_PATH__", config_path)
        return subprocess.run(["browser-harness"], input=code, text=True, timeout=180).returncode
    finally:
        os.unlink(config_path)


if __name__ == "__main__":
    raise SystemExit(main())
