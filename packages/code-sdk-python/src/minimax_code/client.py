"""Entry point. Mirrors ``packages/code-sdk/src/mcode.ts``."""

from __future__ import annotations

import asyncio
import os

from ._args import validate_thread_options
from ._cli import ResolvedCli, check_cli_version, resolve_cli
from .errors import MCodeInvocationError
from .thread import Thread, ThreadHost
from .types import MCodeOptions, ThreadOptions


class MCode:
    """One client resolves and version-checks the CLI once, then starts Threads."""

    def __init__(self, options: MCodeOptions | None = None) -> None:
        self._options = options or MCodeOptions()
        self._cli: ResolvedCli | None = None
        self._lock: asyncio.Lock | None = None
        config = self._options.config_path
        self._host = ThreadHost(
            config_path=os.path.abspath(config) if config else None,
            child_env=self._child_env,
            prepare_cli=self._prepare_cli,
        )

    def start_thread(self, options: ThreadOptions | None = None) -> Thread:
        """Starts a new Thread. The Session is created by its first Turn."""
        options = options or ThreadOptions()
        validate_thread_options(options, resuming=False)
        return Thread(self._host, options, None)

    def resume_thread(self, thread_id: str, options: ThreadOptions | None = None) -> Thread:
        """Continues an existing Session, for example one persisted from ``thread.id``."""
        if not isinstance(thread_id, str) or not thread_id.strip():
            raise MCodeInvocationError("resume_thread requires a non-empty Session id.")
        options = options or ThreadOptions()
        validate_thread_options(options, resuming=True)
        return Thread(self._host, options, thread_id.strip())

    def _child_env(self) -> dict[str, str]:
        env = dict(self._options.env if self._options.env is not None else os.environ)
        if self._options.data_dir is not None:
            env["MINIMAX_DATA_DIR"] = os.path.abspath(self._options.data_dir)
        return env

    async def _prepare_cli(self) -> ResolvedCli:
        if self._cli is not None:
            return self._cli
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            if self._cli is None:
                env = self._child_env()
                cli = resolve_cli(self._options.bin, env)
                await check_cli_version(cli, env)
                # Only cached on success, so a later run works after installing the CLI.
                self._cli = cli
            return self._cli
