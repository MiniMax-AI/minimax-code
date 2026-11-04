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
#: CLI runtime shutdown budget. Cancellation waits at least this long before SIGKILL so a CLI that
#: is already shutting down can still persist the Turn and write ``exec.completed``.
CLI_SHUTDOWN_BUDGET_S = 60.0
#: Slack for work the CLI does (access, Session and model resolution) before it starts its own
#: ``timeout_ms`` timer; the SDK's timer starts at spawn.
CLI_STARTUP_SLACK_S = 30.0
#: Cancel signal → SIGKILL. Read at call time so tests can shorten it.
CANCEL_GRACE_S = CLI_SHUTDOWN_BUDGET_S
#: Extra time after ``timeout_ms`` before the SDK force-kills a CLI that did not stop itself.
BACKSTOP_EXTRA_S = CLI_SHUTDOWN_BUDGET_S + CLI_STARTUP_SLACK_S
#: After ``exec.completed``, how long a lingering CLI may take to exit before SIGKILL.
TERMINATE_GRACE_S = 5.0
#: After the CLI exits, how long to keep reading stdout. A grandchild process that inherited the
#: pipe can keep it open indefinitely.
EXIT_DRAIN_S = 2.0
_EXIT_POLL_S = 0.05
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


# Strong references to background cleanups of abandoned Turns, so they are not garbage collected.
_BACKGROUND_CLOSES: set[asyncio.Task[None]] = set()


class _TurnIterator:
    """What ``async for`` iterates. Python never calls ``aclose()`` on an iterator left by
    ``break`` or by an exception in the loop body (PEP 525), so the Turn is closed in the
    background as soon as this iterator is dropped without being exhausted."""

    def __init__(self, turn: StreamedTurn) -> None:
        self._turn = turn
        self._done = False

    def __aiter__(self) -> _TurnIterator:
        return self

    async def __anext__(self) -> ThreadEvent:
        if self._done:
            raise StopAsyncIteration
        try:
            return await self._turn.events.__anext__()
        except BaseException:
            # End of stream or a failure: the event generator has already cleaned up.
            self._done = True
            raise

    def __del__(self) -> None:
        if not self._done:
            self._done = True
            # Never raise from a finalizer, for example during interpreter shutdown.
            with contextlib.suppress(Exception):
                self._turn._close_in_background()


class StreamedTurn:
    """Events of one running Turn. Iterate with ``async for``; leaving the loop early (``break``,
    an exception, or task cancellation) cancels the Turn and stops the CLI (SIGINT, then SIGKILL
    after a grace period). The next Turn on the same Thread waits for that shutdown to finish."""

    def __init__(
        self,
        events: AsyncIterator[ThreadEvent],
        cancel: Callable[[], None],
        finalize: Callable[[], Awaitable[None]],
    ) -> None:
        self.events = events
        self._cancel = cancel
        self._finalize = finalize
        self._loop = asyncio.get_running_loop()
        self._closing: asyncio.Task[None] | None = None

    def __aiter__(self) -> AsyncIterator[ThreadEvent]:
        return _TurnIterator(self)

    def _start_close(self) -> asyncio.Task[None]:
        """Starts closing the Turn once; every caller shares the same task. Must run on the loop."""
        if self._closing is None:
            task = self._loop.create_task(self._close())
            self._closing = task
            _BACKGROUND_CLOSES.add(task)
            task.add_done_callback(_BACKGROUND_CLOSES.discard)
        return self._closing

    def _close_in_background(self) -> None:
        """Starts closing the Turn without waiting. Safe to call from ``__del__``."""
        if self._closing is not None or self._loop.is_closed():
            return
        try:
            running: asyncio.AbstractEventLoop | None = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        try:
            if running is self._loop:
                self._start_close()
            else:
                self._loop.call_soon_threadsafe(self._close_in_background)
        except RuntimeError:  # The loop closed meanwhile; nothing is left to clean up from here.
            pass

    async def _wait_closing(self) -> None:
        """Waits for a close that is already in progress, if any."""
        if self._closing is not None:
            await asyncio.shield(self._closing)

    def cancel(self) -> None:
        """Asks the CLI to stop (SIGINT). The stream then ends with the CLI's final events."""
        self._cancel()

    async def aclose(self) -> None:
        """Stops the Turn if it is still running and releases the Thread."""
        await asyncio.shield(self._start_close())

    async def _close(self) -> None:
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
        self._exit_task = asyncio.ensure_future(self._watch_exit())
        self._drain_deadline: float | None = None
        self._interrupted = False
        #: Set when the ``timeout_ms`` backstop had to kill the CLI.
        self.backstop_fired = False

    async def _watch_exit(self) -> None:
        # ``Process.wait()`` resolves only after every pipe is closed, so a grandchild that
        # inherited stdout or stderr would hold it. ``returncode`` is set once the CLI is reaped.
        while self.proc.returncode is None:
            await asyncio.sleep(_EXIT_POLL_S)

    async def wait_exited(self) -> None:
        await asyncio.shield(self._exit_task)

    async def _drain_stderr(self) -> None:
        assert self.proc.stderr is not None
        while chunk := await self.proc.stderr.read(65536):
            text = self.stderr_tail + chunk.decode("utf-8", "replace")
            self.stderr_tail = text[-STDERR_TAIL_BYTES:]

    def kill_for_timeout(self) -> None:
        """The ``timeout_ms`` backstop: the CLI did not stop on its own, so kill it."""
        if self.proc.returncode is None:
            self.backstop_fired = True
            with contextlib.suppress(ProcessLookupError):
                self.proc.kill()

    async def read_line(self) -> bytes:
        """Next stdout line, ``b""`` at the end. Once the CLI has exited, the rest of its output is
        read for at most ``EXIT_DRAIN_S``: a grandchild holding the pipe must not stall the Turn."""
        assert self.proc.stdout is not None
        loop = asyncio.get_running_loop()
        read = asyncio.ensure_future(self.proc.stdout.readline())
        try:
            if self._drain_deadline is None:
                await asyncio.wait({read, self._exit_task}, return_when=asyncio.FIRST_COMPLETED)
                if read.done():
                    return read.result()
                self._drain_deadline = loop.time() + EXIT_DRAIN_S
            remaining = max(0.0, self._drain_deadline - loop.time())
            done, _ = await asyncio.wait({read}, timeout=remaining)
            return read.result() if done else b""
        finally:
            if not read.done():
                read.cancel()

    def interrupt(self) -> None:
        """Asks the CLI to cancel. SIGTERM is the CLI's cancel signal, like SIGINT, but has its own
        one-shot handler: after a terminal Ctrl+C already delivered SIGINT to the CLI's process
        group, a second SIGINT would hit the default action and skip the graceful shutdown. On
        Windows this is a hard kill."""
        if self.proc.returncode is not None or self._interrupted:
            return
        self._interrupted = True
        with contextlib.suppress(ProcessLookupError):
            if sys.platform == "win32":
                self.proc.terminate()
            else:
                self.proc.send_signal(signal.SIGTERM)

    async def wait_exit(self, grace: float) -> None:
        """Waits up to ``grace`` seconds for the CLI to exit, then kills it."""
        try:
            await asyncio.wait_for(asyncio.shield(self._exit_task), timeout=grace)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                self.proc.kill()
            await asyncio.shield(self._exit_task)

    async def shutdown(self, grace: float | None = None) -> None:
        """Interrupts a live CLI, then kills it after ``grace`` seconds (``CANCEL_GRACE_S``)."""
        if self.proc.returncode is None:
            self.interrupt()
            await self.wait_exit(CANCEL_GRACE_S if grace is None else grace)
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(self._stderr_task), timeout=EXIT_DRAIN_S)
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
        self._current: StreamedTurn | None = None

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
        duration_ms = result.get("durationMs")
        if not isinstance(duration_ms, int) or isinstance(duration_ms, bool):
            raise MCodeProtocolError(
                "mcode exec.completed result has no valid durationMs.",
                exit_code=state.get("exit_code"),
                stderr=state.get("stderr", ""),
                session_id=result["sessionId"],
                result=result,
                items=items,
            )
        output = result.get("output")
        final = output if isinstance(output, str) else "" if output is None else json.dumps(output)
        return Turn(
            final_response=final,
            items=items,
            session_id=result["sessionId"],
            turn_id=result["turnId"],
            duration_ms=duration_ms,
            result=result,
            usage=result.get("usage"),
            model=result.get("model"),
        )

    async def run_streamed(self, input: str, options: RunOptions | None = None) -> StreamedTurn:
        """Runs one Turn and yields CLI events as they arrive. ``turn.failed`` is an ordinary
        event; iteration raises only for process or protocol failures."""
        return await self._start(input, options or RunOptions(), {})

    async def _start(self, input: str, options: RunOptions, state: dict[str, Any]) -> StreamedTurn:
        if self._busy and self._current is not None:
            # The previous Turn's loop was left early; let its CLI finish shutting down first.
            await self._current._wait_closing()
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

        streamed = StreamedTurn(events, child.interrupt, finalize)
        self._current = streamed
        return streamed

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
            backstop = asyncio.get_running_loop().call_later(delay, child.kill_for_timeout)
        try:
            assert child.proc.stdin is not None and child.proc.stdout is not None
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                child.proc.stdin.write(json.dumps({"prompt": prompt}).encode("utf-8"))
                await child.proc.stdin.drain()
                child.proc.stdin.close()
            line_no = 0
            while True:
                try:
                    raw = await child.read_line()
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
                if completed:
                    # exec.completed is terminal; anything the CLI prints afterwards is ignored.
                    break
            if completed:
                # A CLI that lingers after exec.completed is force-stopped.
                await child.wait_exit(TERMINATE_GRACE_S)
            else:
                await child.wait_exited()
            await child.shutdown()
            state["exit_code"] = child.proc.returncode
            state["stderr"] = child.stderr_tail
            if not completed:
                raise error_for_exit(
                    exit_code=child.proc.returncode,
                    stderr=child.stderr_tail,
                    items=items.items(),
                    session_id=self._session_id,
                    timed_out=child.backstop_fired,
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


async def _quiet_shutdown(child: _Exec) -> None:
    with contextlib.suppress(Exception):
        await asyncio.shield(child.shutdown())


__all__ = ["StreamedTurn", "Thread", "ThreadHost"]
