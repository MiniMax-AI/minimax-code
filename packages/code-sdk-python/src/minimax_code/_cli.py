"""Locates and version-checks the ``mcode`` CLI. Mirrors ``packages/code-sdk/src/cli-resolver.ts``
and the Windows launcher handling of ``project-bin.ts``: the SDK never starts the CLI through a
shell, so Windows ``.cmd`` launchers are followed to the JS entry and Node runtime they run.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import sys
from collections.abc import Mapping
from dataclasses import dataclass

from .errors import MCODE_INSTALL_HINT, MCodeNotFoundError, MCodeVersionError

MIN_CLI_VERSION = (0, 6, 3)
_JS_SUFFIXES = (".js", ".mjs", ".cjs")
#: Windows files that CreateProcess runs directly, without cmd.exe.
_WINDOWS_NATIVE = (".exe", ".com")
#: Lines of the Windows root launcher written by the official installer and CLI self-update.
_VERSIONED_POINTER_LINE = 'SET /P MCODE_RELEASE=<"%~dp0current"'
_VERSIONED_CALL_LINE = 'CALL "%~dp0releases\\%MCODE_RELEASE%\\.mcode-launcher.cmd"'
#: Same release-key rule the root launcher enforces before following the pointer.
_RELEASE_KEY = re.compile(r"[0-9A-Za-z][0-9A-Za-z._-]*")
#: JS entry in an npm / pnpm ``.cmd`` shim or an installer release launcher.
_CMD_SHIM_ENTRY = re.compile(r'"%~?dp0%?\\?([^"%]+\.(?:c|m)?js)"', re.IGNORECASE)
#: JS entry in an npm / pnpm POSIX shell or PowerShell shim.
_SHELL_SHIM_ENTRY = re.compile(r'"\$basedir[\\/]([^"$]+\.(?:c|m)?js)"')
#: The pinned runtime of an installer release launcher: ``"<node>" "%~dp0<entry>" %*``.
_CMD_RUNTIME = re.compile(r'^"([^"%]+)"[ \t]+"%~dp0', re.MULTILINE)
_SHIM_HEAD_BYTES = 4096


@dataclass(frozen=True)
class ResolvedCli:
    """How to start the CLI."""

    path: str
    """The executable, or the JS entry that runs with Node."""
    node: str | None = None
    """Node runtime for a JS entry; ``None`` uses ``node`` from ``PATH``."""
    launcher: str | None = None
    """Windows installer root launcher. Its release pointer is followed again before every run, so
    a CLI self-update between Turns is picked up."""

    def command(self, args: list[str]) -> list[str]:
        if self.launcher is not None:
            current = _follow_versioned_launcher(self.launcher)
            if current is None:
                raise MCodeNotFoundError(
                    f"{self.launcher} no longer points to a usable release. "
                    "Pass the CLI's JS entry as MCodeOptions(bin=...)."
                )
            return current.command(args)
        if self.path.lower().endswith(_JS_SUFFIXES):
            return [self.node or shutil.which("node") or "node", self.path, *args]
        return [self.path, *args]


def resolve_cli(
    bin: str | None, env: Mapping[str, str], platform: str = sys.platform
) -> ResolvedCli:
    """Explicit ``bin`` → ``$MCODE_BIN`` → ``mcode`` on ``PATH``."""
    explicit = bin or _env(env, "MCODE_BIN", platform) or None
    if explicit:
        path = os.path.abspath(os.path.expanduser(explicit))
        if not os.path.isfile(path):
            source = "bin" if bin else "MCODE_BIN"
            raise MCodeNotFoundError(f"mcode CLI from {source} does not exist: {path}")
        return _from_executable(path, platform)
    found = shutil.which("mcode", path=_env(env, "PATH", platform) or os.defpath)
    if not found:
        raise MCodeNotFoundError(
            "Could not find the mcode CLI on PATH. Install it with "
            f"`{MCODE_INSTALL_HINT}`, set MCODE_BIN, or pass MCodeOptions(bin=...)."
        )
    return _from_executable(found, platform)


def _from_executable(path: str, platform: str) -> ResolvedCli:
    extension = os.path.splitext(path)[1].lower()
    if extension in _JS_SUFFIXES or platform != "win32" or extension in _WINDOWS_NATIVE:
        return ResolvedCli(path)
    # A batch file or shell shim would need cmd.exe and its quoting rules, and cancelling it would
    # stop only cmd.exe and leave the CLI running. Run the JS entry behind it instead.
    try:
        head = _read_head(path)
    except OSError:
        head = ""
    if extension in (".cmd", ".bat"):
        resolved = resolve_cmd_launcher(head, path)
    else:
        entry = _parse_shim(_SHELL_SHIM_ENTRY, head, path)
        resolved = ResolvedCli(entry, node=_adjacent_node(path)) if entry else None
    if resolved is None:
        raise MCodeNotFoundError(
            f"Found {path}, but could not determine the JS entry it runs. "
            "Pass the CLI's JS entry as MCodeOptions(bin=...) or MCODE_BIN."
        )
    return resolved


def resolve_cmd_launcher(content: str, launcher: str) -> ResolvedCli | None:
    """Resolves a Windows ``.cmd`` launcher: an npm / pnpm shim, or the installer's root
    launcher, whose release is looked up again before every run."""
    entry = _parse_shim(_CMD_SHIM_ENTRY, content, launcher)
    if entry:
        return ResolvedCli(entry, node=_adjacent_node(launcher))
    versioned = _VERSIONED_POINTER_LINE in content and _VERSIONED_CALL_LINE in content
    if versioned and _follow_versioned_launcher(launcher) is not None:
        return ResolvedCli(launcher, launcher=launcher)
    return None


def _follow_versioned_launcher(launcher: str) -> ResolvedCli | None:
    """``<prefix>\\mcode.cmd`` reads the release key from ``<prefix>\\current`` and calls
    ``<prefix>\\releases\\<release>\\.mcode-launcher.cmd``, which runs a pinned Node runtime."""
    prefix = os.path.dirname(launcher)
    try:
        with open(os.path.join(prefix, "current"), encoding="utf-8") as handle:
            release = handle.read().strip()
        if not _RELEASE_KEY.fullmatch(release):
            return None
        release_launcher = os.path.join(prefix, "releases", release, ".mcode-launcher.cmd")
        content = _read_head(release_launcher)
    except OSError:
        return None
    entry = _parse_shim(_CMD_SHIM_ENTRY, content, release_launcher)
    if entry is None:
        return None
    runtime = _CMD_RUNTIME.search(content)
    node = runtime.group(1) if runtime and os.path.isfile(runtime.group(1)) else None
    return ResolvedCli(entry, node=node)


def _parse_shim(pattern: re.Pattern[str], content: str, shim: str) -> str | None:
    match = pattern.search(content)
    if not match:
        return None
    parts = [part for part in re.split(r"[\\/]", match.group(1)) if part]
    entry = os.path.normpath(os.path.join(os.path.dirname(shim), *parts))
    return entry if os.path.isfile(entry) else None


def _adjacent_node(shim: str) -> str | None:
    """npm shims prefer a ``node.exe`` next to them over ``PATH``."""
    candidate = os.path.join(os.path.dirname(shim), "node.exe")
    return candidate if os.path.isfile(candidate) else None


def _read_head(path: str) -> str:
    with open(path, "rb") as handle:
        return handle.read(_SHIM_HEAD_BYTES).decode("utf-8", "replace")


def _env(env: Mapping[str, str], key: str, platform: str) -> str | None:
    """Environment names are case-insensitive on Windows (``Path``)."""
    if platform != "win32":
        return env.get(key)
    return next((value for name, value in env.items() if name.upper() == key), None)


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


__all__ = ["ResolvedCli", "check_cli_version", "resolve_cli", "resolve_cmd_launcher"]
