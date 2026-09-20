#!/usr/bin/env python3
"""Create one ChatGPT thread using the authenticated browser-harness session."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile


BH_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_create_bh.py")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--thinking-level", choices=("default", "low", "medium", "high"), default="default")
    args = parser.parse_args()
    config = {"project": {"name": args.project}, "prompt": args.prompt, "thinking_level": args.thinking_level}
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as handle:
        json.dump(config, handle, ensure_ascii=False)
        config_path = handle.name
    try:
        code = open(BH_SCRIPT, encoding="utf-8").read().replace("__CFG_PATH__", config_path)
        result = subprocess.run(["browser-harness"], input=code, text=True, timeout=180)
        return result.returncode
    finally:
        os.unlink(config_path)


if __name__ == "__main__":
    raise SystemExit(main())
