"""Opt-in end-to-end tests against a real mcode CLI and model (MCODE_SDK_E2E=1)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from minimax_code import MCode, MCodeOptions, ThreadOptions

pytestmark = [
    pytest.mark.e2e,
    pytest.mark.skipif(os.environ.get("MCODE_SDK_E2E") != "1", reason="set MCODE_SDK_E2E=1"),
]


def client() -> MCode:
    return MCode(MCodeOptions(config_path=os.environ.get("MCODE_SDK_E2E_CONFIG") or None))


def options(tmp_path: Path) -> ThreadOptions:
    return ThreadOptions(cwd=str(tmp_path), model=os.environ.get("MCODE_SDK_E2E_MODEL"))


async def test_single_run(tmp_path: Path) -> None:
    turn = await client().start_thread(options(tmp_path)).run("Reply with exactly: PONG")
    assert "PONG" in turn.final_response
    assert turn.session_id


async def test_streamed_run(tmp_path: Path) -> None:
    thread = client().start_thread(options(tmp_path))
    streamed = await thread.run_streamed("Reply with exactly: STREAMED")
    types = [event["type"] async for event in streamed]
    assert types[0] == "exec.started" and types[-1] == "exec.completed"
    assert "item.completed" in types


async def test_multi_turn_resume(tmp_path: Path) -> None:
    mc = client()
    thread = mc.start_thread(options(tmp_path))
    await thread.run("Remember the code word ZEBRA42. Reply only: OK")
    assert thread.id
    resumed = mc.resume_thread(thread.id, options(tmp_path))
    turn = await resumed.run("What was the code word? Reply with just the word.")
    assert "ZEBRA42" in turn.final_response
    assert turn.session_id == thread.id
