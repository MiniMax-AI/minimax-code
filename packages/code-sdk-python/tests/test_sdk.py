from __future__ import annotations

import asyncio
import json
import os
import pickle
import signal
import time
from pathlib import Path
from typing import Any

import pytest

import minimax_code.thread as thread_module
from minimax_code import (
    AgentMessageItem,
    MCode,
    MCodeAbortError,
    MCodeError,
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


async def test_break_without_aclose_stops_cli_and_frees_thread(fake_env: dict[str, str]) -> None:
    fake_env["FAKE_MCODE_SCENARIO"] = "slow"
    thread = MCode(MCodeOptions(env=fake_env)).start_thread()
    streamed = await thread.run_streamed("x")
    async for _event in streamed:
        break  # no async with, no aclose(): the SDK must still stop the CLI
    fake_env["FAKE_MCODE_SCENARIO"] = "ok"
    # The next Turn waits for the abandoned one instead of raising ThreadBusyError.
    assert (await thread.run("again")).final_response == "Hello: again"
    with pytest.raises(StopAsyncIteration):
        await streamed.events.__anext__()  # the abandoned stream was closed


async def test_exception_in_loop_body_stops_cli_and_frees_thread(fake_env: dict[str, str]) -> None:
    fake_env["FAKE_MCODE_SCENARIO"] = "slow"
    thread = MCode(MCodeOptions(env=fake_env)).start_thread()
    streamed = await thread.run_streamed("x")
    with pytest.raises(RuntimeError, match="user code failed"):
        async for _event in streamed:
            raise RuntimeError("user code failed")
    fake_env["FAKE_MCODE_SCENARIO"] = "ok"
    assert (await thread.run("again")).final_response == "Hello: again"


async def test_timeout_backstop_raises_timeout_error(
    fake_env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("minimax_code.thread.BACKSTOP_EXTRA_S", 0.3)
    fake_env["FAKE_MCODE_SCENARIO"] = "hang"
    thread = MCode(MCodeOptions(env=fake_env)).start_thread()
    with pytest.raises(MCodeRunError, match="exceeded timeout_ms") as info:
        await thread.run("x", RunOptions(timeout_ms=100))
    assert info.value.status == "timeout"
    assert info.value.exit_code is not None and info.value.exit_code < 0


@pytest.mark.parametrize(
    ("scenario", "error", "text"),
    [
        ("no_duration", MCodeProtocolError, "durationMs"),
        ("error_no_message", MCodeRunError, "status failed"),
    ],
)
async def test_incomplete_results_raise_sdk_errors(
    fake_env: dict[str, str], scenario: str, error: type[MCodeError], text: str
) -> None:
    fake_env["FAKE_MCODE_SCENARIO"] = scenario
    with pytest.raises(error, match=text):
        await MCode(MCodeOptions(env=fake_env)).start_thread().run("x")


def test_errors_survive_pickling() -> None:
    run = MCodeRunError(
        "run failed", status="failed", category="runtime", exit_code=4, session_id="s1"
    )
    clone = pickle.loads(pickle.dumps(run))
    assert type(clone) is MCodeRunError and str(clone) == "run failed"
    assert (clone.status, clone.category, clone.exit_code, clone.session_id) == (
        "failed",
        "runtime",
        4,
        "s1",
    )
    busy = pickle.loads(pickle.dumps(ThreadBusyError("s1")))
    assert type(busy) is ThreadBusyError
    assert str(busy) == "Thread s1 already has a Turn in progress."
    abort = pickle.loads(pickle.dumps(MCodeAbortError("stopped", stderr="tail")))
    assert type(abort) is MCodeAbortError and abort.stderr == "tail"


def test_options_repr_hides_env_values() -> None:
    options = MCodeOptions(bin="/bin/mcode", env={"MINIMAX_API_KEY": "sk-SECRET-123"})
    text = repr(options)
    assert "sk-SECRET-123" not in text
    assert "MINIMAX_API_KEY" in text and "/bin/mcode" in text
    assert "None" in repr(MCodeOptions())


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


async def test_cancel_uses_sigterm_after_terminal_sigint(
    fake_env: dict[str, str], tmp_path: Path
) -> None:
    # Ctrl+C in a terminal delivers SIGINT to the CLI too. The SDK's own cancel must not send a
    # second SIGINT, which would hit the CLI's default action and skip exec.completed.
    log, pid_file = tmp_path / "cli.log", tmp_path / "cli.pid"
    fake_env.update(
        FAKE_MCODE_SCENARIO="slow",
        FAKE_MCODE_LOG=str(log),
        FAKE_MCODE_PID=str(pid_file),
        FAKE_MCODE_SHUTDOWN_S="0.5",
    )
    thread = MCode(MCodeOptions(env=fake_env)).start_thread()
    streamed = await thread.run_streamed("x")
    events = streamed.__aiter__()
    await events.__anext__()
    os.kill(int(pid_file.read_text()), signal.SIGINT)
    await asyncio.sleep(0.1)
    await streamed.aclose()
    assert log.read_text().splitlines() == ["signal SIGINT", "signal SIGTERM", "completed"]


def test_cancel_timings_cover_the_cli_shutdown_budget() -> None:
    assert thread_module.CANCEL_GRACE_S >= thread_module.CLI_SHUTDOWN_BUDGET_S == 60
    assert thread_module.BACKSTOP_EXTRA_S >= 90


async def test_completed_turn_does_not_wait_for_grandchild_holding_stdout(
    fake_env: dict[str, str],
) -> None:
    fake_env["FAKE_MCODE_SCENARIO"] = "grandchild"
    started = time.monotonic()
    turn = await MCode(MCodeOptions(env=fake_env)).start_thread().run("x")
    assert turn.final_response == "ok"
    assert time.monotonic() - started < 5


async def test_exit_without_result_does_not_wait_for_grandchild(
    fake_env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(thread_module, "EXIT_DRAIN_S", 0.2)
    fake_env["FAKE_MCODE_SCENARIO"] = "grandchild_crash"
    started = time.monotonic()
    with pytest.raises(MCodeRunError):
        await MCode(MCodeOptions(env=fake_env)).start_thread().run("x")
    assert time.monotonic() - started < 5


async def test_cli_lingering_after_exec_completed_is_stopped(
    fake_env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(thread_module, "TERMINATE_GRACE_S", 0.3)
    fake_env["FAKE_MCODE_SCENARIO"] = "linger"
    thread = MCode(MCodeOptions(env=fake_env)).start_thread()
    started = time.monotonic()
    assert (await thread.run("x")).final_response == "ok"
    types = [event["type"] async for event in await thread.run_streamed("y")]
    assert types[-1] == "exec.completed" and "after.completed" not in types
    assert time.monotonic() - started < 5


async def test_thread_cwd_is_pinned_when_the_thread_is_created(
    fake_env: dict[str, str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first, second = tmp_path / "first", tmp_path / "second"
    (first / "sub").mkdir(parents=True)
    second.mkdir()
    client = MCode(MCodeOptions(env=fake_env))
    monkeypatch.chdir(first)
    default = client.start_thread()
    relative = client.start_thread(ThreadOptions(cwd="sub"))
    monkeypatch.chdir(second)
    await default.run("a")
    await relative.run("b")
    assert [c["args"][4] for c in calls(fake_env)] == [f"--cwd={first}", f"--cwd={first / 'sub'}"]
