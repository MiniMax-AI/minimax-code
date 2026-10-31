"""Threads and Turns. Mirrors ``packages/code-sdk/src/thread.ts`` and ``exec-process.ts``.

The SDK holds only the Session id: every Turn starts a new ``mcode exec`` process and continues
the Session with ``--session``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import signal
import sys
import tempfile
from collections.abc import AsyncIterator, Awaitable, Callable
from types import TracebackType
from typing import Any

from ._args import build_exec_args, validate_run_options
from ._cli import ResolvedCli
from ._items import ItemAccumulator
from ._protocol import parse_event_line
from .errors import (
    MCodeError,
    MCodeNotFoundError,
    MCodeProtocolError,
    ThreadBusyError,
    error_for_exit,
    error_for_result,
)
from .types import ExecResult, RunOptions, ThreadEvent, ThreadOptions, Turn

STDERR_TAIL_BYTES = 64 * 1024
CANCEL_GRACE_S = 10.0
BACKSTOP_EXTRA_S = 30.0
_STDOUT_LINE_LIMIT = 64 * 1024 * 1024


class ThreadHost:
    """What a Thread needs from its owning client."""

    def __init__(
        self,
        *,
        config_path: str | None,
        child_env: Callable[[], dict[str, str]],
        prepare_cli: Callable[[], Awaitable[ResolvedCli]],
    ) -> None:
        self.config_path = config_path
        self.child_env = child_env
        self.prepare_cli = prepare_cli


class StreamedTurn:
    """Events of one running Turn. Iterate with ``async for``; leaving the loop early (``break``,
    an exception, or task cancellation) cancels the Turn and waits for the CLI to exit."""

    def __init__(
        self,
        events: AsyncIterator[ThreadEvent],
        cancel: Callable[[], None],
        finalize: Callable[[], Awaitable[None]],
    ) -> None:
        self.events = events
        self._cancel = cancel
        self._finalize = finalize

    def __aiter__(self) -> AsyncIterator[ThreadEvent]:
        return self.events

    def cancel(self) -> None:
        """Asks the CLI to stop (SIGINT). The stream then ends with the CLI's final events."""
        self._cancel()

    async def aclose(self) -> None:
        """Stops the Turn if it is still running and releases the Thread."""
        aclose = getattr(self.events, "aclose", None)
        if aclose is not None:
            await aclose()
        # Covers a stream that was never iterated, whose generator body never ran.
        await self._finalize()

    async def __aenter__(self) -> StreamedTurn:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()


class _Exec:
    """One ``mcode exec`` child process."""

    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self.proc = proc
        self.stderr_tail = ""
        self._stderr_task = asyncio.ensure_future(self._drain_stderr())
        self._interrupted = False

    async def _drain_stderr(self) -> None:
        assert self.proc.stderr is not None
        while chunk := await self.proc.stderr.read(65536):
            text = self.stderr_tail + chunk.decode("utf-8", "replace")
            self.stderr_tail = text[-STDERR_TAIL_BYTES:]

    def interrupt(self) -> None:
        if self.proc.returncode is not None or self._interrupted:
            return
        self._interrupted = True
        with contextlib.suppress(ProcessLookupError):
            if sys.platform == "win32":
                self.proc.terminate()
            else:
                self.proc.send_signal(signal.SIGINT)

    async def shutdown(self, grace: float = CANCEL_GRACE_S) -> None:
        """Interrupts a live CLI, then kills it after ``grace`` seconds."""
        if self.proc.returncode is None:
            self.interrupt()
            try:
                await asyncio.wait_for(asyncio.shield(self.proc.wait()), timeout=grace)
            except asyncio.TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    self.proc.kill()
                await self.proc.wait()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(self._stderr_task), timeout=2)
        # Close the pipes now, while the loop is alive; asyncio has no public API for this.
        transport = getattr(self.proc, "_transport", None)
        if transport is not None:
            transport.close()


class Thread:
    """A conversation with the Agent."""

    def __init__(self, host: ThreadHost, options: ThreadOptions, thread_id: str | None) -> None:
        self._host = host
        self._options = options
        self._session_id = thread_id
        self._busy = False

    @property
    def id(self) -> str | None:
        """Session id. Available after the first event of the first Turn, even if it fails."""
        return self._session_id

    async def run(self, input: str, options: RunOptions | None = None) -> Turn:
        """Runs one Turn. Returns only when it succeeds; otherwise raises an ``MCodeError``."""
        state: dict[str, Any] = {}
        result: ExecResult | None = None
        streamed = await self._start(input, options or RunOptions(), state)
        async with streamed:
            async for event in streamed:
                if event["type"] == "exec.completed" and "result" in event:
                    result = event["result"]
        if result is None:
            raise MCodeProtocolError("mcode finished without exec.completed.")
        acc: ItemAccumulator = state["items"]
        items = acc.items()
        if result["status"] != "succeeded":
            raise error_for_result(
                result, items, exit_code=state.get("exit_code"), stderr=state.get("stderr", "")
            )
        output = result.get("output")
        final = output if isinstance(output, str) else "" if output is None else json.dumps(output)
        return Turn(
            final_response=final,
            items=items,
            session_id=result["sessionId"],
            turn_id=result["turnId"],
            duration_ms=result["durationMs"],
            result=result,
            usage=result.get("usage"),
            model=result.get("model"),
        )

    async def run_streamed(self, input: str, options: RunOptions | None = None) -> StreamedTurn:
        """Runs one Turn and yields CLI events as they arrive. ``turn.failed`` is an ordinary
        event; iteration raises only for process or protocol failures."""
        return await self._start(input, options or RunOptions(), {})

    async def _start(self, input: str, options: RunOptions, state: dict[str, Any]) -> StreamedTurn:
        if self._busy:
            raise ThreadBusyError(self._session_id)
        if not isinstance(input, str):
            raise TypeError("input must be a string.")
        validate_run_options(options)
        self._busy = True
        temp_dir: str | None = None
        try:
            cli = await self._host.prepare_cli()
            prompt_files: dict[str, str] = {}
            if self._options.system_prompt is not None or (
                self._options.append_system_prompt is not None
            ):
                temp_dir = tempfile.mkdtemp(prefix="mcode-sdk-")
                for key, text in (
                    ("system_prompt_file", self._options.system_prompt),
                    ("append_system_prompt_file", self._options.append_system_prompt),
                ):
                    if text is not None:
                        path = os.path.join(temp_dir, key.replace("_file", "") + ".txt")
                        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                        with os.fdopen(fd, "w", encoding="utf-8") as fh:
                            fh.write(text)
                        prompt_files[key] = path
            args = build_exec_args(
                thread=self._options,
                session_id=self._session_id,
                run=options,
                config_path=self._host.config_path,
                **prompt_files,
            )
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cli.command(args),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=self._host.child_env(),
                    limit=_STDOUT_LINE_LIMIT,
                )
            except OSError as error:
                raise MCodeNotFoundError(f"Could not start mcode at {cli.path}: {error}") from error
        except BaseException:
            self._release(temp_dir)
            raise
        child = _Exec(proc)
        released = False

        def release() -> None:
            nonlocal released
            if not released:
                released = True
                self._release(temp_dir)

        events = self._events(child, input, options, state, release)

        async def finalize() -> None:
            await _quiet_shutdown(child)
            release()

        return StreamedTurn(events, child.interrupt, finalize)

    async def _events(
        self,
        child: _Exec,
        prompt: str,
        options: RunOptions,
        state: dict[str, Any],
        release: Callable[[], None],
    ) -> AsyncIterator[ThreadEvent]:
        items = ItemAccumulator()
        state["items"] = items
        completed = False
        backstop: asyncio.TimerHandle | None = None
        if options.timeout_ms is not None:
            delay = options.timeout_ms / 1000 + BACKSTOP_EXTRA_S
            backstop = asyncio.get_running_loop().call_later(delay, _kill, child.proc)
        try:
            assert child.proc.stdin is not None and child.proc.stdout is not None
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                child.proc.stdin.write(json.dumps({"prompt": prompt}).encode("utf-8"))
                await child.proc.stdin.drain()
                child.proc.stdin.close()
            line_no = 0
            while True:
                try:
                    raw = await child.proc.stdout.readline()
                except ValueError as error:
                    raise MCodeProtocolError("mcode stdout line exceeds the size limit.") from error
                if not raw:
                    break
                line_no += 1
                try:
                    event = parse_event_line(raw.decode("utf-8", "replace"))
                except MCodeError as error:
                    error.stderr = child.stderr_tail
                    raise
                if event is None:
                    continue
                if self._session_id is None:
                    self._session_id = event["sessionId"]
                if event["type"] == "exec.completed":
                    completed = True
                if items.apply(event):
                    yield event
            await child.proc.wait()
            await child.shutdown()
            state["exit_code"] = child.proc.returncode
            state["stderr"] = child.stderr_tail
            if not completed:
                raise error_for_exit(
                    exit_code=child.proc.returncode,
                    stderr=child.stderr_tail,
                    items=items.items(),
                    session_id=self._session_id,
                )
        except BaseException:
            await _quiet_shutdown(child)
            raise
        finally:
            if backstop is not None:
                backstop.cancel()
            release()

    def _release(self, temp_dir: str | None) -> None:
        self._busy = False
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)


def _kill(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is None:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()


async def _quiet_shutdown(child: _Exec) -> None:
    with contextlib.suppress(Exception):
        await asyncio.shield(child.shutdown())


__all__ = ["StreamedTurn", "Thread", "ThreadHost"]
