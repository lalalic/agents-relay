#!/usr/bin/env python3
"""Submit one isolated Temporary Chat task through browser-harness."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile


BH_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_temporary_bh.py")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--file", action="append", default=[])
    parser.add_argument("--release-file", required=True)
    parser.add_argument("--close-policy", choices=["after-start", "never", "after-terminal"], default="after-start")
    args = parser.parse_args()
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as handle:
        json.dump(vars(args), handle, ensure_ascii=False)
        config_path = handle.name
    try:
        code = open(BH_SCRIPT, encoding="utf-8").read().replace("__CFG_PATH__", config_path)
        return subprocess.run(["browser-harness"], input=code, text=True, timeout=180).returncode
    finally:
        os.unlink(config_path)


if __name__ == "__main__":
    raise SystemExit(main())
