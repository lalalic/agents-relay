#!/usr/bin/env python3
"""Opt-in real provider canary. Never targets production Relay SQLite or a Relay Job."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

REPO = Path(__file__).resolve().parents[2]


def read_json(port, path, timeout=4):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=timeout) as response:
        return json.loads(response.read())


def last_json(output):
    for line in reversed(output.splitlines()):
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                return value
        except json.JSONDecodeError:
            continue
    raise RuntimeError("WebHelm readiness did not return JSON")


def local_webhelm():
    cli = shutil.which("webhelm")
    if not cli:
        raise RuntimeError("Global WebHelm CLI not found")
    output = subprocess.run([cli, "status"], check=True, capture_output=True,
                            text=True, timeout=25)
    status = last_json(output.stdout)
    daemon = status.get("daemon") or {}
    path = Path(str(daemon.get("socket", "")))
    if daemon.get("running") is not True or not path.is_socket():
        raise RuntimeError("Real WebHelm daemon is not available")
    profile = subprocess.run([cli, "platform", "profile", "chatgpt"],
                             check=True, capture_output=True, text=True, timeout=25)
    if last_json(profile.stdout).get("platform") != "chatgpt":
        raise RuntimeError("ChatGPT WebHelm profile not ready")
    return Path(cli).resolve(), path.resolve()


def event_history():
    config = Path.home() / "Library/Application Support/EventsBus/runtime.json"
    data = json.loads(config.read_text())
    api = urllib.parse.urlsplit(str(data.get("apiUrl", "")))
    nats = urllib.parse.urlsplit(str(data.get("natsUrl", "")))
    if (data.get("subjectPrefix") != "relay.events.job" or
        api.hostname not in ("localhost", "127.0.0.1", "::1") or
        nats.hostname not in ("localhost", "127.0.0.1", "::1") or
        api.scheme != "http" or api.port is None or nats.port is None or
        api.username or api.password or nats.username or nats.password):
        raise RuntimeError("Canary requires the verified local Events Bus namespace")
    return f"http://127.0.0.1:{api.port}/"


def seed(root, job_id):
    env = dict(os.environ, RUST2_CANARY_ROOT=str(root), RUST2_CANARY_JOB_ID=job_id)
    code = r"""
import {SQLiteRelayStore} from './dist/relay-store.js';
import {join} from 'node:path';
const root=process.env.RUST2_CANARY_ROOT, id=process.env.RUST2_CANARY_JOB_ID;
const at=new Date().toISOString();
const store=new SQLiteRelayStore(join(root,'relay.sqlite'), id);
await store.saveJob({
  id, repository:'project', projectRoot:join(root,'project'),
  title:'Rust2 real WebHelm canary - no file changes',
  objective:'TEST-ONLY: verify real Model Worker event delivery. No repository or file edits.',
  state:'ACTIVE', prNumber:0, priority:'P2', reviewEnabled:false, autoMerge:false,
  createdAt:at, updatedAt:at, plans:[],
  tasks:[{
    id:'2',jobId:id,kind:'work',adapter:'chatgpt',
    agentName:'implementation',title:'Test only: publish verified start and terminal events',
    state:'QUEUED',executionId:null,leaseOwner:null,leaseExpiresAt:null,
    attempt:0,maxAttempts:1,priority:'P2',dependencies:[],
    routing:{adapter:'chatgpt',provider:'chatgpt'},
    input:'[Relay agent: implementation; adapter: chatgpt]\nTest-only no file edits. Publish the execution-scoped task.started then task.completed Events Bus events, and report RUST2_CANARY_PASS. Do not interact with any other Job.',
    timeoutMs:90000, output:{kind:'file',path:join(root,'output.json')},
    createdAt:at,updatedAt:at
  }]
});
store.close();
"""
    subprocess.run(["node", "--input-type=module", "-e", code], cwd=REPO, env=env,
                   check=True, stdout=subprocess.DEVNULL, timeout=25)
    # Confirm the canonical repository/projectRoot fence before the daemon
    # opens the fixture. Never alter this production-side safety check.
    # This is the disposable, caller-owned fixture, NOT production SQLite.
    # Open it normally for the preflight SELECT. Production isolation below
    # always opens the actual live store strictly read-only.
    checked = False
    for _ in range(80):
        try:
            db = sqlite3.connect(str(root / "relay.sqlite"))
            try:
                raw = db.execute("SELECT json FROM job_snapshot WHERE job_id=?", (job_id,)).fetchone()
                if raw is None:
                    raise RuntimeError("Canary fixture source Job was not seeded")
                job = json.loads(raw[0])
                if job.get("repository") != (root / "project").name or not (root / "project/.git").is_dir():
                    raise RuntimeError("Canary repository must match its own isolated Git directory")
                checked = True
                break
            finally:
                db.close()
        except sqlite3.OperationalError:
            time.sleep(.15)
    if not checked:
        raise RuntimeError("Canary SQLite source is not readable after bounded read-only retries")


def event_count(database, job_id):
    db = sqlite3.connect(str(database))
    try:
        if not db.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='workflow_event_outbox'").fetchone()[0]:
            return 0
        return db.execute("SELECT count(*) FROM workflow_event_outbox WHERE event_key LIKE ?",
                          (f"model-event/{job_id}/2/%",)).fetchone()[0]
    finally:
        db.close()


def live_store_absent(job_id):
    store = Path(os.environ.get("AGENTS_RELAY_STORE_DIR",
                              str(Path.home() / ".agents-relay/stores")))
    live = store.parent / "relay.sqlite"
    if not live.is_file():
        return True
    conn = sqlite3.connect("file:" + str(live) + "?mode=ro", uri=True)
    try:
        return conn.execute("SELECT count(*) FROM job_snapshot WHERE job_id=?",
                            (job_id,)).fetchone()[0] == 0
    finally:
        conn.close()


def daemon_sessions(socket_path, workspace):
    def send(payload):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(5)
            sock.connect(str(socket_path))
            sock.sendall((json.dumps(payload) + "\n").encode())
            chunks = bytearray()
            while not chunks.endswith(b"\n"):
                data = sock.recv(8192)
                if not data:
                    break
                chunks.extend(data)
            return json.loads(chunks.decode()) if chunks else {}
    try:
        sessions = send({"op": "list"}).get("sessions", [])
        if not isinstance(sessions, list):
            return 0
        closed = 0
        for entry in sessions:
            if isinstance(entry, dict) and entry.get("workspace") == workspace:
                ident = entry.get("session_id")
                if isinstance(ident, str) and ident:
                    send({"op": "stop", "session_id": ident})
                    closed += 1
        return closed
    except Exception:
        return -1


def main():
    parser = argparse.ArgumentParser(description="Test-owned real ChatGPT/WebHelm canary")
    parser.add_argument("--execute", action="store_true", help="Explicitly create one real test thread")
    parser.add_argument("--deadline", type=int, default=100)
    options = parser.parse_args()
    if not options.execute:
        parser.error("Real WebHelm interaction requires explicit --execute")
    webhelm, webhelm_socket = local_webhelm()
    events_api = event_history()
    # Refuse to use an existing Relay source root or active Job identity.
    suffix = secrets.token_hex(4)
    job_id = str(900000000 + secrets.randbelow(90000000))
    workspace = "Rust2Canary" + suffix
    if not live_store_absent(job_id):
        raise RuntimeError("Canary Job collides with an existing production Job")
    exe = REPO / "rust/target/debug/agents-relayd-rust"
    if not exe.is_file():
        raise RuntimeError("Native Rust daemon binary is not built")
    with tempfile.TemporaryDirectory(prefix="r2canary-", dir="/tmp") as temporary:
        root = Path(temporary)
        (root / "stores").mkdir()
        (root / "project").mkdir()
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=root / "project",
                       check=True, timeout=15)
        seed(root, job_id)
        with socket.socket() as free:
            free.bind(("127.0.0.1", 0))
            port = free.getsockname()[1]
        command = [
            str(exe), "--isolated-write-store-dir", str(root / "stores"),
            "--port", str(port), "--interval", "150",
            "--event-history-api", events_api, "--trust-isolated-model-events",
            "--canary-webhelm-socket", str(webhelm_socket),
            "--canary-webhelm-executable", str(webhelm),
            "--canary-webhelm-workspace", workspace,
        ]
        log_path = root / "daemon.log"
        print("Real canary started: isolated SQLite, isolated Git, unique workspace.", flush=True)
        with log_path.open("wb") as log:
            daemon = subprocess.Popen(command, cwd=REPO, stdout=subprocess.DEVNULL,
                                      stderr=log, env=os.environ.copy())
            result = None
            try:
                until = time.monotonic() + 35
                while time.monotonic() < until:
                    try:
                        status = read_json(port, "/api/status")
                        if status.get("runtime") == "native-rust":
                            break
                    except Exception:
                        pass
                    if daemon.poll() is not None:
                        raise RuntimeError("Native canary daemon failed to launch")
                    time.sleep(.2)
                else:
                    raise RuntimeError("Native canary daemon not HTTP ready")
                limit = time.monotonic() + options.deadline
                last = ("", "")
                consecutive_errors = 0
                while time.monotonic() < limit:
                    try:
                        record = read_json(port, "/api/job?id=" + job_id)
                        consecutive_errors = 0
                        tasks = record.get("tasks") or []
                        if not tasks:
                            raise RuntimeError("Canary Task disappeared")
                        task = tasks[0]
                        state = (str(record.get("state")), str(task.get("state")))
                        if state != last:
                            print("Canary Graph state:", "/".join(state), flush=True)
                            last = state
                        if task.get("state") == "SUCCEEDED":
                            count = event_count(root / "relay.sqlite", job_id)
                            result = count >= 2
                            print("Durable Worker outbox events:", count, flush=True)
                            break
                        if task.get("state") in ("FAILED", "CANCELLED"):
                            result = False
                            break
                    except Exception as error:
                        consecutive_errors += 1
                        if consecutive_errors == 1:
                            print("Canary observation:", type(error).__name__, flush=True)
                        if consecutive_errors >= 12:
                            raise RuntimeError("Canary repeatedly failed its own Job lookup")
                    time.sleep(.7)
                if result is None:
                    result = False
                    print("Canary did not reach Graph/SQLite terminal within bounded test window.",
                          flush=True)
            finally:
                if daemon.poll() is None:
                    daemon.send_signal(signal.SIGTERM)
                    try:daemon.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        daemon.kill();daemon.wait(timeout=8)
                closed = daemon_sessions(webhelm_socket, workspace)
                print("Canary session cleanup:", closed, flush=True)
                print("Production Relay Job ID isolation:",
                      "PASS" if live_store_absent(job_id) else "FAILED", flush=True)
                print("Native daemon clean shutdown:", daemon.returncode == 0, flush=True)
                if not result:
                    # Errors only; do not print user-created prompt/credentials.
                    messages = log_path.read_text(errors="replace").splitlines()
                    interesting = [line for line in messages
                                   if "error" in line.lower() or "warn" in line.lower()]
                    print("Canary daemon error categories:",
                          [line[:120] for line in interesting[-4:]], flush=True)
        if result:
            print("REAL WEBHELM CANARY: PASS", flush=True)
            return 0
        print("REAL WEBHELM CANARY: NOT VERIFIED", flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
