from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from minimax_code import (
    AgentMessageItem,
    MCode,
    MCodeAbortError,
    MCodeInvocationError,
    MCodeNotFoundError,
    MCodeOptions,
    MCodeProtocolError,
    MCodeRunError,
    MCodeVersionError,
    RunOptions,
    SyncMCode,
    ThreadBusyError,
    ThreadOptions,
    ToolCallItem,
)


def calls(env: dict[str, str]) -> list[dict[str, Any]]:
    text = Path(env["FAKE_MCODE_RECORD"]).read_text()
    return [json.loads(line) for line in text.splitlines()]


async def test_run_returns_turn_and_builds_args(fake_env: dict[str, str], tmp_path: Path) -> None:
    client = MCode(MCodeOptions(env=fake_env, data_dir=str(tmp_path / "data")))
    thread = client.start_thread(
        ThreadOptions(cwd=str(tmp_path), model="minimax/MiniMax-M3", permission="full")
    )
    turn = await thread.run("hi", RunOptions(timeout_ms=1000, max_steps=3, files=["a.txt"]))
    assert turn.final_response == "Hello: hi"
    assert turn.session_id == "sess-new" and thread.id == "sess-new"
    assert turn.usage == {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5}
    assert turn.items == [
        AgentMessageItem(id="m1", text="Hello: hi"),
        ToolCallItem(id="t1", tool_call={"id": "t1", "name": "bash", "status": 2}),
    ]
    (call,) = calls(fake_env)
    assert call["prompt"] == "hi"
    assert call["args"] == [
        "exec",
        "--output-format=stream-json",
        "--input=-",
        "--input-format=json",
        f"--cwd={tmp_path}",
        "--model=minimax/MiniMax-M3",
        "--permission=full",
        "--file=a.txt",
        "--timeout=1000ms",
        "--max-steps=3",
    ]


async def test_multi_turn_and_resume_use_session(fake_env: dict[str, str]) -> None:
    client = MCode(MCodeOptions(env=fake_env))
    thread = client.start_thread()
    await thread.run("one")
    await thread.run("two")
    resumed = client.resume_thread("sess-old")
    await resumed.run("three")
    args = [c["args"] for c in calls(fake_env)]
    assert not any(a.startswith("--session") for a in args[0])
    assert "--session=sess-new" in args[1]
    assert "--session=sess-old" in args[2]


async def test_system_prompt_files_are_written_and_removed(fake_env: dict[str, str]) -> None:
    thread = MCode(MCodeOptions(env=fake_env)).start_thread(
        ThreadOptions(system_prompt="be brief", append_system_prompt="extra")
    )
    await thread.run("x")
    args: list[str] = calls(fake_env)[0]["args"]
    paths = [a.split("=", 1)[1] for a in args if "system-prompt-file" in a]
    assert len(paths) == 2
    assert all(not Path(p).exists() for p in paths)


async def test_run_streamed_yields_events_and_dedupes(fake_env: dict[str, str]) -> None:
    thread = MCode(MCodeOptions(env=fake_env)).start_thread()
    streamed = await thread.run_streamed("hi")
    types = [event["type"] async for event in streamed]
    assert types[0] == "exec.started" and types[-1] == "exec.completed"
    assert "future.event" in types  # unknown events pass through
    assert types.count("item.updated") == 2  # one text delta + one tool snapshot


async def test_failed_turn_raises_run_error(fake_env: dict[str, str]) -> None:
    fake_env["FAKE_MCODE_SCENARIO"] = "failed"
    thread = MCode(MCodeOptions(env=fake_env)).start_thread()
    with pytest.raises(MCodeRunError) as info:
        await thread.run("x")
    assert info.value.status == "failed" and info.value.category == "runtime"
    assert "model unavailable" in str(info.value)
    assert info.value.exit_code == 4
    assert thread.id == "sess-new"


@pytest.mark.parametrize(
    ("scenario", "error", "text"),
    [
        ("invocation", MCodeInvocationError, "--model is invalid"),
        ("crash", MCodeRunError, "boom: internal failure"),
        ("garbage", MCodeProtocolError, "not JSON"),
    ],
)
async def test_process_failures(
    fake_env: dict[str, str], scenario: str, error: type[Exception], text: str
) -> None:
    fake_env["FAKE_MCODE_SCENARIO"] = scenario
    with pytest.raises(error, match=text):
        await MCode(MCodeOptions(env=fake_env)).start_thread().run("x")


async def test_missing_cli(tmp_path: Path) -> None:
    client = MCode(MCodeOptions(env={"PATH": str(tmp_path)}))
    with pytest.raises(MCodeNotFoundError, match="Could not find the mcode CLI"):
        await client.start_thread().run("x")
    bad = MCode(MCodeOptions(bin=str(tmp_path / "nope"), env={}))
    with pytest.raises(MCodeNotFoundError, match="does not exist"):
        await bad.start_thread().run("x")


async def test_old_cli_is_rejected(fake_env: dict[str, str]) -> None:
    fake_env["FAKE_MCODE_VERSION"] = "0.5.0"
    with pytest.raises(MCodeVersionError, match="older than the minimum"):
        await MCode(MCodeOptions(env=fake_env)).start_thread().run("x")


async def test_cancel_via_stream_and_task(fake_env: dict[str, str]) -> None:
    fake_env["FAKE_MCODE_SCENARIO"] = "slow"
    thread = MCode(MCodeOptions(env=fake_env)).start_thread()
    streamed = await thread.run_streamed("x")
    seen = []
    async for event in streamed:
        seen.append(event["type"])
        if event["type"] == "future.event":
            streamed.cancel()
    assert seen[-2:] == ["turn.failed", "exec.completed"]

    task = asyncio.create_task(thread.run("y"))
    await asyncio.sleep(0.5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    # The Thread is free again after cancellation; a CLI-reported cancel raises MCodeAbortError.
    run = asyncio.create_task(thread.run("z"))
    await asyncio.sleep(0.5)
    with pytest.raises(MCodeAbortError):
        await asyncio.gather(run, _interrupt_children())


async def _interrupt_children() -> None:
    proc = await asyncio.create_subprocess_exec("pkill", "-INT", "-f", "fake_mcode.py")
    await proc.wait()


async def test_break_releases_thread(fake_env: dict[str, str]) -> None:
    fake_env["FAKE_MCODE_SCENARIO"] = "slow"
    thread = MCode(MCodeOptions(env=fake_env)).start_thread()
    async with await thread.run_streamed("x") as streamed:
        async for _event in streamed:
            break
    fake_env["FAKE_MCODE_SCENARIO"] = "ok"
    assert (await thread.run("again")).final_response == "Hello: again"


async def test_busy_thread(fake_env: dict[str, str]) -> None:
    fake_env["FAKE_MCODE_SCENARIO"] = "slow"
    thread = MCode(MCodeOptions(env=fake_env)).start_thread()
    streamed = await thread.run_streamed("x")
    with pytest.raises(ThreadBusyError):
        await thread.run_streamed("y")
    await streamed.aclose()


def test_option_validation() -> None:
    client = MCode(MCodeOptions(env={}))
    with pytest.raises(MCodeInvocationError):
        client.start_thread(ThreadOptions(permission="ask"))  # type: ignore[arg-type]
    with pytest.raises(MCodeInvocationError):
        client.resume_thread("s", ThreadOptions(mode="lightweight"))
    with pytest.raises(MCodeInvocationError):
        client.resume_thread("  ")


def test_sync_client(fake_env: dict[str, str]) -> None:
    with SyncMCode(MCodeOptions(env=fake_env)) as client:
        thread = client.start_thread()
        assert thread.run("a").final_response == "Hello: a"
        types = [e["type"] for e in thread.run_streamed("b")]
        assert types[-1] == "exec.completed"
        assert thread.id == "sess-new"
