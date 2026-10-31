#!/usr/bin/env python3
"""Fake ``mcode`` for unit tests. Behaviour is selected with FAKE_MCODE_SCENARIO."""

from __future__ import annotations

import json
import os
import signal
import sys
import time

scenario = os.environ.get("FAKE_MCODE_SCENARIO", "ok")
args = sys.argv[1:]

if args == ["--version"]:
    print(os.environ.get("FAKE_MCODE_VERSION", "0.7.2"))
    sys.exit(0)

prompt = json.loads(sys.stdin.read())["prompt"]
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
    cancelled = False

    def on_sigint(_sig: int, _frame: object) -> None:
        global cancelled
        cancelled = True

    signal.signal(signal.SIGINT, on_sigint)
    for _ in range(200):
        if cancelled:
            break
        time.sleep(0.05)
    emit("turn.failed", status="cancelled", durationMs=5)
    emit("exec.completed", result=result("cancelled"))
    sys.exit(130)

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
