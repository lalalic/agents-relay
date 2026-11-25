#!/usr/bin/env python3
"""Release reviewed main to the configured native installation; no Job required."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "agents-relay"
SERVICE = "agents-relay/daemon"


def run(*args, capture=False):
    return subprocess.run(args, cwd=ROOT, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def git(*args):
    return run("git", *args, capture=True).strip()


def http(base, path, payload=None):
    req = urllib.request.Request(base + path,
                                 data=None if payload is None else json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as response:
        return response.read()


def read_json(base, path, payload=None):
    return json.loads(http(base, path, payload))


def local_url(value):
    p = urllib.parse.urlsplit(value)
    if (p.scheme != "http" or p.hostname not in ("127.0.0.1", "::1", "localhost")
            or p.port is None or p.username or p.password or p.path not in ("", "/")
            or p.query or p.fragment):
        raise argparse.ArgumentTypeError("expected explicit loopback HTTP URL with port")
    return value.rstrip("/")


def paused_and_quiescent(job):
    # Only an explicitly paused, fully fenced Job may survive a maintenance
    # restart. A pending pause/cancellation or claimed generation is not idle.
    if not isinstance(job.get("pause"), dict) or not job["pause"].get("requestedAt"):
        return False
    if not isinstance(job.get("tasks"), list) or not isinstance(job.get("plans"), list):
        return False
    return all(not t.get("executionId") and not t.get("pausedExecution")
               for t in job["tasks"]) and all(
        not p.get("executionId") and not p.get("pausedExecutionId")
        for p in job["plans"])


def check_idle(allow_paused_jobs=()):
    allowed = set(allow_paused_jobs)
    jobs = json.loads(run("agents-relay", "job", "list", capture=True))
    busy = []
    for job in jobs:
        if job["state"] in ("COMPLETED", "FAILED", "CANCELLED"):
            continue
        if job["id"] in allowed:
            detail = json.loads(run("agents-relay", "job", "show", "--id",
                                    job["id"], capture=True))
            if detail["id"] == job["id"] and paused_and_quiescent(detail):
                continue
        busy.append(job["id"])
    if busy:
        raise RuntimeError("Refusing deployment while nonterminal Jobs exist: " + ", ".join(busy))


def switch_link(link, target):
    stage = link.with_name(".live-release-" + str(os.getpid()))
    try:
        stage.symlink_to(target)
        os.replace(stage, link)
    finally:
        stage.unlink(missing_ok=True)


def wait_for_live(api, package, version=None, sha=None):
    for _ in range(30):
        try:
            info = read_json(api, "/api/version")
            if version and (info["version"] != version or info.get("sourceRef") != sha):
                raise ValueError("release identity mismatch")
            # Confirm the actual served bytes, not merely the selected symlink.
            for name in ("dashboard.js", "dashboard.css"):
                query = "?v=" + version + "-" + sha if version else ""
                if http(api, "/" + name + query) != (package / "dashboard" / name).read_bytes():
                    raise ValueError("served asset mismatch: " + name)
            return info
        except (OSError, ValueError, KeyError):
            time.sleep(1)
    raise RuntimeError("Live Dashboard failed package verification")


def release_event(version, sha, job_id=None):
    data = dict(package=PACKAGE, version=version, sha=sha, registry="native")
    if job_id is not None:
        data["jobId"] = job_id
    return dict(type="package.published", source=f"release/{PACKAGE}/{sha}", data=data)


def publish_verified(api, event):
    expected = "release:" + PACKAGE + ":" + event["data"]["sha"] + ":package.published"
    path = "/releases?package=" + PACKAGE + "&limit=500"

    def recorded():
        for row in read_json(api, path)["events"]:
            if row["event"]["event_id"] == expected:
                if row["event"]["data"] != event["data"]:
                    raise RuntimeError("Existing release receipt differs from requested metadata")
                return row

    if (row := recorded()) is not None:
        return row
    receipt = read_json(api, "/events", event)
    if not receipt.get("published") or receipt["event"]["event_id"] != expected:
        raise RuntimeError("Events Bus did not acknowledge release")
    for _ in range(20):
        if (row := recorded()) is not None:
            return row
        time.sleep(0.5)
    raise RuntimeError("Events Bus receipt not yet durable; retry same release command")


def release(args):
    if git("branch", "--show-current") != "main" or git("status", "--porcelain"):
        raise RuntimeError("Release requires a clean main checkout")
    sha = git("rev-parse", "HEAD")
    version = re.search(r'^version = "([^"]+)"', (ROOT / "rust/Cargo.toml").read_text(), re.M)[1]
    package = args.root / "versions" / sha
    link = args.root / "live"
    old = link.resolve(strict=True)
    if args.job_id:
        job = json.loads(run("agents-relay", "job", "show", "--id", args.job_id, capture=True))
        if job["state"] != "COMPLETED" or job.get("repository") != PACKAGE:
            raise RuntimeError("Optional Job must be completed and belong to Agents Relay")
        run("git", "merge-base", "--is-ancestor", job["localMerge"]["mergedCommitSha"], sha)
    # Confirm event recorder capability BEFORE mutating deployment.
    read_json(args.events_api, "/releases?package=" + PACKAGE)
    if git("remote", "get-url", "origin") != git("remote", "get-url", "--push", "--all", "origin"):
        raise RuntimeError("Origin fetch/push destinations differ")
    run("git", "fetch", "origin", "main")
    run("git", "merge-base", "--is-ancestor", "origin/main", sha)
    run("git", "push", "origin", sha + ":refs/heads/main")
    if git("ls-remote", "origin", "refs/heads/main").split()[0] != sha:
        raise RuntimeError("Origin main does not match reviewed release")
    if not package.exists():
        # Build from this exact clean committed checkout; no source mutations.
        run("cargo", "build", "--locked", "--manifest-path", "rust/Cargo.toml", "--bins")
        target = Path(os.environ.get("CARGO_TARGET_DIR", str(ROOT / "rust/target")))
        if not target.is_absolute():
            target = ROOT / target
        if git("rev-parse", "HEAD") != sha or git("status", "--porcelain"):
            raise RuntimeError("Checkout changed during build")
        run(str(ROOT / "scripts/package-rust-runtime.sh"), str(target / "debug"), str(package))
    if (package / "SOURCE_REVISION").read_text().strip() != sha:
        raise RuntimeError("Existing package has wrong revision")
    cli_version = run(str(package / "bin/agents-relay-rust"), "--version", capture=True)
    if cli_version.split()[1] != version:
        raise RuntimeError("Packaged CLI version mismatch")
    if old != package:
        check_idle(args.allow_paused_job)
        # Existing PM2 definition must use the stable packaged launcher.
        services = json.loads(run("npx", "pm2", "jlist", capture=True))
        service = next(x for x in services if x["name"] == SERVICE)
        launcher = Path(service["pm2_env"]["pm_exec_path"])
        if launcher.name != "agents-relayd" or launcher.is_relative_to(ROOT):
            raise RuntimeError("PM2 must use the installed agents-relayd launcher")
        check_idle(args.allow_paused_job)
        switch_link(link, package)
        try:
            run("serviceman", "restart", "--skill", PACKAGE, "--service", "daemon", "--apply")
            wait_for_live(args.api, package, version, sha)
            run("npx", "pm2", "save")
        except BaseException:
            switch_link(link, old)
            run("serviceman", "restart", "--skill", PACKAGE, "--service", "daemon", "--apply")
            wait_for_live(args.api, old)
            run("npx", "pm2", "save")
            raise
    else:
        wait_for_live(args.api, package, version, sha)
    # A healthy deployment is not rolled back just because event delivery failed.
    # Same SHA + same association can be retried without another restart.
    row = publish_verified(args.events_api, release_event(version, sha, args.job_id))
    receipts = args.root / "receipts"
    receipts.mkdir(mode=0o700, exist_ok=True)
    dest = receipts / (sha + ".json")
    temporary = dest.with_suffix(".tmp")
    temporary.write_text(json.dumps(row, indent=2) + "\n")
    os.replace(temporary, dest)
    print(json.dumps({"version": version, "sha": sha, "publication": row}, indent=2))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, default=Path.home()/".local/share/agents-relay")
    p.add_argument("--api", type=local_url, default="http://127.0.0.1:8787")
    p.add_argument("--events-api", type=local_url, default="http://127.0.0.1:4223")
    p.add_argument("--job-id", help="Optional completed Job association")
    p.add_argument("--allow-paused-job", action="append", default=[],
                   help="Explicitly paused Job with no claimed or pending generations (repeatable)")
    args = p.parse_args()
    args.root = args.root.resolve(strict=True)
    if args.job_id is not None and not re.fullmatch(r"[1-9][0-9]*", args.job_id):
        p.error("--job-id must be a positive decimal ID")
    if any(not re.fullmatch(r"[1-9][0-9]*", job_id) for job_id in args.allow_paused_job):
        p.error("--allow-paused-job must be a positive decimal ID")
    os.umask(0o077)
    with (args.root / ".release.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        release(args)


if __name__ == "__main__":
    main()
