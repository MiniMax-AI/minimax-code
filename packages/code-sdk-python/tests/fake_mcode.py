#!/usr/bin/env python3
"""Fake ``mcode`` for unit tests. Behaviour is selected with FAKE_MCODE_SCENARIO."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time

scenario = os.environ.get("FAKE_MCODE_SCENARIO", "ok")
args = sys.argv[1:]

if args == ["--version"]:
    print(os.environ.get("FAKE_MCODE_VERSION", "0.7.2"))
    sys.exit(0)

prompt = json.loads(sys.stdin.read())["prompt"]
pid_file = os.environ.get("FAKE_MCODE_PID")
if pid_file:
    with open(pid_file, "w", encoding="utf-8") as fh:
        fh.write(str(os.getpid()))


def note(text: str) -> None:
    """Appends to FAKE_MCODE_LOG, for assertions about how the SDK stopped the CLI."""
    path = os.environ.get("FAKE_MCODE_LOG")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(text + "\n")


record = os.environ.get("FAKE_MCODE_RECORD")
if record:
    with open(record, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"args": args, "prompt": prompt}) + "\n")

session = next((a.split("=", 1)[1] for a in args if a.startswith("--session=")), "sess-new")
seq = 0


def emit(kind: str, **extra: object) -> None:
    global seq
    seq += 1
    base = {
        "schemaVersion": 1,
        "type": kind,
        "sequence": seq,
        "timestampMs": 0,
        "runId": "run-1",
        "sessionId": session,
        "turnId": f"turn-{seq}",
    }
    print(json.dumps({**base, **extra}), flush=True)


def result(status: str, **extra: object) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "type": "exec.result",
        "runId": "run-1",
        "sessionId": session,
        "turnId": "turn-1",
        "status": status,
        "durationMs": 5,
        **extra,
    }


if scenario == "invocation":
    print("Error: --model is invalid", file=sys.stderr)
    sys.exit(2)
if scenario == "garbage":
    print("not json", flush=True)
    sys.exit(0)
if scenario == "crash":
    emit("exec.started")
    print("boom: internal failure", file=sys.stderr)
    sys.exit(70)

emit("exec.started")
emit("session.resumed" if "--session=" in " ".join(args) else "session.started")
emit("turn.started")
msg = {"id": "m1", "type": "agent_message"}
emit("item.started", item={**msg, "contentDelta": "Hel"})
emit("item.updated", item={**msg, "contentDelta": "lo"})
tool = {"id": "t1", "type": "tool_call", "toolCall": {"id": "t1", "name": "bash", "status": 1}}
emit("item.updated", item=tool)
emit("item.updated", item=tool)  # duplicate snapshot: dropped by the SDK
emit("item.completed", item={**tool, "toolCall": {"id": "t1", "name": "bash", "status": 2}})
emit("future.event", payload=True)

if scenario == "slow":
    # Like the CLI: SIGINT and SIGTERM each have a one-shot cancel handler; a repeated signal hits
    # the default action and kills the process before exec.completed.
    cancelled = False

    def on_signal(sig: int, _frame: object) -> None:
        global cancelled
        note(f"signal {signal.Signals(sig).name}")
        signal.signal(sig, signal.SIG_DFL)
        cancelled = True

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    for _ in range(200):
        if cancelled:
            break
        time.sleep(0.05)
    time.sleep(float(os.environ.get("FAKE_MCODE_SHUTDOWN_S", "0")))
    emit("turn.failed", status="cancelled", durationMs=5)
    emit("exec.completed", result=result("cancelled"))
    note("completed")
    sys.exit(130)

if scenario == "hang":  # ignores cancel signals and never finishes: only SIGKILL stops it
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(60)
    sys.exit(0)

if scenario in ("grandchild", "grandchild_crash"):
    # A background process inherits stdout and stderr and outlives the CLI.
    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(10)"])
    if scenario == "grandchild_crash":
        sys.exit(4)
    emit("exec.completed", result=result("succeeded", output="ok"))
    sys.exit(0)

if scenario == "linger":  # exec.completed, then the CLI never exits on its own
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    emit("exec.completed", result=result("succeeded", output="ok"))
    emit("after.completed")
    time.sleep(60)
    sys.exit(0)

if scenario == "no_duration":
    bad = result("succeeded", output="ok")
    del bad["durationMs"]
    emit("exec.completed", result=bad)
    sys.exit(0)

if scenario == "error_no_message":
    emit("exec.completed", result=result("failed", error={"category": "runtime"}))
    sys.exit(4)

if scenario == "failed":
    err = {"category": "runtime", "message": "model unavailable"}
    emit("turn.failed", status="failed", error=err, durationMs=5)
    emit("exec.completed", result=result("failed", error=err))
    sys.exit(4)

emit("item.completed", item={**msg, "content": f"Hello: {prompt}"})
usage = {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5}
emit("turn.completed", usage=usage, durationMs=5)
emit(
    "exec.completed",
    result=result("succeeded", output=f"Hello: {prompt}", usage=usage),
)
