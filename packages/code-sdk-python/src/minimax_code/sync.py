"""Blocking wrappers around the async API, for code that has no running event loop.

They cannot be called where an event loop is already running, such as a Jupyter notebook cell or
an ``async def`` function (``RuntimeError: Cannot run the event loop while another loop is
running``); use the async API with ``await`` there.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Iterator
from typing import Any, TypeVar

from .client import MCode
from .thread import Thread
from .types import MCodeOptions, RunOptions, ThreadEvent, ThreadOptions, Turn

_T = TypeVar("_T")


def _in_running_loop() -> bool:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


def _run(loop: asyncio.AbstractEventLoop, coro: Awaitable[_T]) -> _T:
    """``loop.run_until_complete`` that closes ``coro`` when it cannot run, so a call from inside a
    running event loop raises one RuntimeError and leaves no "never awaited" warning."""
    if _in_running_loop():
        close = getattr(coro, "close", None)
        if close is not None:
            close()
        raise RuntimeError(
            "The blocking minimax_code API cannot run inside a running event loop; "
            "use the async API (MCode) with await."
        )
    return loop.run_until_complete(coro)


class SyncThread:
    def __init__(self, loop: asyncio.AbstractEventLoop, thread: Thread) -> None:
        self._loop = loop
        self._thread = thread

    @property
    def id(self) -> str | None:
        return self._thread.id

    def run(self, input: str, options: RunOptions | None = None) -> Turn:
        return _run(self._loop, self._thread.run(input, options))

    def run_streamed(self, input: str, options: RunOptions | None = None) -> Iterator[ThreadEvent]:
        """Yields events; closing the iterator early cancels the Turn."""
        streamed = _run(self._loop, self._thread.run_streamed(input, options))
        events = streamed.events
        try:
            while True:
                try:
                    yield _run(self._loop, events.__anext__())
                except StopAsyncIteration:
                    return
        finally:
            _run(self._loop, streamed.aclose())


class SyncMCode:
    """Blocking client. Owns a private event loop; call ``close()`` (or use ``with``) when done."""

    def __init__(self, options: MCodeOptions | None = None) -> None:
        self._loop = asyncio.new_event_loop()
        self._client = MCode(options)

    def start_thread(self, options: ThreadOptions | None = None) -> SyncThread:
        return SyncThread(self._loop, self._client.start_thread(options))

    def resume_thread(self, thread_id: str, options: ThreadOptions | None = None) -> SyncThread:
        """Continues an existing Session; pass the ``cwd`` it was created with (see
        ``MCode.resume_thread``)."""
        return SyncThread(self._loop, self._client.resume_thread(thread_id, options))

    def close(self) -> None:
        if self._loop.is_closed():
            return
        if _in_running_loop():
            # Called from async code (an unsupported use that already raised): the private loop
            # never ran a Turn to completion here, so close it without running it.
            self._loop.close()
            return
        # Let subprocess transports finish closing before the loop goes away.
        self._loop.run_until_complete(asyncio.sleep(0.05))
        self._loop.run_until_complete(self._loop.shutdown_asyncgens())
        self._loop.close()

    def __enter__(self) -> SyncMCode:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()
