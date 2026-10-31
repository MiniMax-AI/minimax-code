"""Locates and version-checks the ``mcode`` CLI."""

from __future__ import annotations

import asyncio
import os
import re
import shutil
from collections.abc import Mapping
from dataclasses import dataclass

from .errors import MCODE_INSTALL_HINT, MCodeNotFoundError, MCodeVersionError

MIN_CLI_VERSION = (0, 6, 3)
_JS_SUFFIXES = (".js", ".mjs", ".cjs")


@dataclass(frozen=True)
class ResolvedCli:
    path: str

    def command(self, args: list[str]) -> list[str]:
        if self.path.endswith(_JS_SUFFIXES):
            node = shutil.which("node") or "node"
            return [node, self.path, *args]
        return [self.path, *args]


def resolve_cli(bin: str | None, env: Mapping[str, str]) -> ResolvedCli:
    """Explicit ``bin`` → ``$MCODE_BIN`` → ``mcode`` on ``PATH``."""
    explicit = bin or env.get("MCODE_BIN") or None
    if explicit:
        path = os.path.abspath(os.path.expanduser(explicit))
        if not os.path.isfile(path):
            source = "bin" if bin else "MCODE_BIN"
            raise MCodeNotFoundError(f"mcode CLI from {source} does not exist: {path}")
        return ResolvedCli(path)
    found = shutil.which("mcode", path=env.get("PATH", os.defpath))
    if not found:
        raise MCodeNotFoundError(
            "Could not find the mcode CLI on PATH. Install it with "
            f"`{MCODE_INSTALL_HINT}`, set MCODE_BIN, or pass MCodeOptions(bin=...)."
        )
    return ResolvedCli(found)


def parse_version(text: str) -> tuple[int, int, int] | None:
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", text)
    if not match:
        return None
    major, minor, patch = (int(part) for part in match.groups())
    return (major, minor, patch)


async def check_cli_version(cli: ResolvedCli, env: Mapping[str, str]) -> str:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cli.command(["--version"]),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=dict(env),
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=30)
    except (OSError, asyncio.TimeoutError) as error:
        raise MCodeNotFoundError(f"Could not run `{cli.path} --version`: {error}") from error
    if proc.returncode != 0:
        raise MCodeVersionError(
            f"`mcode --version` failed ({proc.returncode}); cannot verify CLI compatibility.",
            exit_code=proc.returncode,
            stderr=err.decode("utf-8", "replace"),
        )
    text = out.decode("utf-8", "replace")
    version = parse_version(text)
    if version is None:
        raise MCodeVersionError(f"Could not read the mcode version from: {text.strip()!r}.")
    if version < MIN_CLI_VERSION:
        minimum = ".".join(map(str, MIN_CLI_VERSION))
        found = ".".join(map(str, version))
        raise MCodeVersionError(
            f"mcode {found} is older than the minimum {minimum} required by minimax-code-sdk. "
            f"Upgrade with `{MCODE_INSTALL_HINT}`."
        )
    return ".".join(map(str, version))


__all__ = ["ResolvedCli", "check_cli_version", "resolve_cli"]
