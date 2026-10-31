"""Blocking wrappers around the async API, for scripts and notebooks without an event loop."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any

from .client import MCode
from .thread import Thread
from .types import MCodeOptions, RunOptions, ThreadEvent, ThreadOptions, Turn


class SyncThread:
    def __init__(self, loop: asyncio.AbstractEventLoop, thread: Thread) -> None:
        self._loop = loop
        self._thread = thread

    @property
    def id(self) -> str | None:
        return self._thread.id

    def run(self, input: str, options: RunOptions | None = None) -> Turn:
        return self._loop.run_until_complete(self._thread.run(input, options))

    def run_streamed(self, input: str, options: RunOptions | None = None) -> Iterator[ThreadEvent]:
        """Yields events; closing the iterator early cancels the Turn."""
        streamed = self._loop.run_until_complete(self._thread.run_streamed(input, options))
        events = streamed.events
        try:
            while True:
                try:
                    yield self._loop.run_until_complete(events.__anext__())
                except StopAsyncIteration:
                    return
        finally:
            self._loop.run_until_complete(streamed.aclose())


class SyncMCode:
    """Blocking client. Owns a private event loop; call ``close()`` (or use ``with``) when done."""

    def __init__(self, options: MCodeOptions | None = None) -> None:
        self._loop = asyncio.new_event_loop()
        self._client = MCode(options)

    def start_thread(self, options: ThreadOptions | None = None) -> SyncThread:
        return SyncThread(self._loop, self._client.start_thread(options))

    def resume_thread(self, thread_id: str, options: ThreadOptions | None = None) -> SyncThread:
        return SyncThread(self._loop, self._client.resume_thread(thread_id, options))

    def close(self) -> None:
        if not self._loop.is_closed():
            # Let subprocess transports finish closing before the loop goes away.
            self._loop.run_until_complete(asyncio.sleep(0.05))
            self._loop.run_until_complete(self._loop.shutdown_asyncgens())
            self._loop.close()

    def __enter__(self) -> SyncMCode:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()
