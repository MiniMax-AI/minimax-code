"""Windows launcher resolution. Runs on every platform with synthetic launchers."""

from __future__ import annotations

from pathlib import Path

import pytest

from minimax_code import MCodeNotFoundError
from minimax_code._cli import resolve_cli

NPM_SHIM = """@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \
"%_prog%"  "%dp0%\\node_modules\\@minimax-ai\\code\\dist\\cli.js" %*
"""

ROOT_LAUNCHER = (
    '@ECHO off\r\nSETLOCAL\r\nSET /P MCODE_RELEASE=<"%~dp0current"\r\n'
    'ECHO(%MCODE_RELEASE%| %SystemRoot%\\System32\\findstr.exe /R /X "[0-9A-Za-z][0-9A-Za-z._-]*" '
    ">NUL || EXIT /B 1\r\n"
    'CALL "%~dp0releases\\%MCODE_RELEASE%\\.mcode-launcher.cmd" %*\r\nEXIT /B %ERRORLEVEL%\r\n'
)


def touch(path: Path, text: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def npm_install(root: Path, *, adjacent_node: bool) -> tuple[Path, Path]:
    shim = touch(root / "mcode.cmd", NPM_SHIM)
    entry = touch(root / "node_modules" / "@minimax-ai" / "code" / "dist" / "cli.js")
    if adjacent_node:
        touch(root / "node.exe")
    return shim, entry


def installer_release(root: Path, release: str) -> tuple[Path, Path]:
    node = touch(root / "runtime" / release / "node.exe")
    entry = touch(root / "releases" / release / "dist" / "cli.js")
    touch(
        root / "releases" / release / ".mcode-launcher.cmd",
        f'@ECHO off\r\n"{node}" "%~dp0dist\\cli.js" %*\r\nEXIT /B %ERRORLEVEL%\r\n',
    )
    return node, entry


def test_npm_cmd_shim_runs_its_js_entry_with_path_node(tmp_path: Path) -> None:
    shim, entry = npm_install(tmp_path, adjacent_node=False)
    cli = resolve_cli(str(shim), {}, platform="win32")
    assert cli.path == str(entry) and cli.node is None
    assert cli.command(["--version"])[1:] == [str(entry), "--version"]


def test_npm_cmd_shim_prefers_adjacent_node(tmp_path: Path) -> None:
    shim, entry = npm_install(tmp_path, adjacent_node=True)
    cli = resolve_cli(str(shim), {}, platform="win32")
    assert cli.command(["exec"]) == [str(tmp_path / "node.exe"), str(entry), "exec"]


def test_installer_launcher_follows_the_current_release_on_every_run(tmp_path: Path) -> None:
    launcher = touch(tmp_path / "mcode.cmd", ROOT_LAUNCHER)
    node_a, entry_a = installer_release(tmp_path, "0.7.4")
    node_b, entry_b = installer_release(tmp_path, "0.7.5")
    touch(tmp_path / "current", "0.7.4\r\n")
    cli = resolve_cli(str(launcher), {}, platform="win32")
    assert cli.command(["exec"]) == [str(node_a), str(entry_a), "exec"]
    touch(tmp_path / "current", "0.7.5")  # CLI self-update between Turns
    assert cli.command(["exec"]) == [str(node_b), str(entry_b), "exec"]
    touch(tmp_path / "current", "..\\evil")
    with pytest.raises(MCodeNotFoundError, match="no longer points"):
        cli.command(["exec"])


def test_unknown_batch_file_is_rejected_instead_of_run_through_cmd(tmp_path: Path) -> None:
    launcher = touch(tmp_path / "mcode.bat", "@echo off\r\nsomething-else %*\r\n")
    with pytest.raises(MCodeNotFoundError, match="JS entry"):
        resolve_cli(str(launcher), {}, platform="win32")


def test_windows_shell_shim_and_native_executable(tmp_path: Path) -> None:
    entry = touch(tmp_path / "node_modules" / "@minimax-ai" / "code" / "dist" / "cli.js")
    shim = touch(
        tmp_path / "mcode",
        '#!/bin/sh\nexec node  "$basedir/node_modules/@minimax-ai/code/dist/cli.js" "$@"\n',
    )
    assert resolve_cli(str(shim), {}, platform="win32").path == str(entry)
    native = touch(tmp_path / "mcode.exe")
    assert resolve_cli(str(native), {}, platform="win32").command(["x"]) == [str(native), "x"]


def test_windows_environment_names_are_case_insensitive(tmp_path: Path) -> None:
    shim, entry = npm_install(tmp_path, adjacent_node=False)
    assert resolve_cli(None, {"Mcode_Bin": str(shim)}, platform="win32").path == str(entry)


def test_posix_launchers_run_directly(tmp_path: Path) -> None:
    launcher = touch(tmp_path / "mcode.cmd", NPM_SHIM)
    assert resolve_cli(str(launcher), {}, platform="linux").command(["x"]) == [str(launcher), "x"]
