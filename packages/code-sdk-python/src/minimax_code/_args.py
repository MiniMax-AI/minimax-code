"""Builds ``mcode exec`` argv. Mirrors ``packages/code-sdk/src/args.ts``."""

from __future__ import annotations

import os

from .errors import MCodeInvocationError
from .types import RunOptions, ThreadOptions

_PERMISSIONS = {"smart", "full", "off"}
_MODES = {"standard", "lightweight"}
_PROMPT_MODES = {"tui", "coding", "work"}
MAX_TIMEOUT_MS = 2**31 - 1


def validate_thread_options(options: ThreadOptions, resuming: bool) -> None:
    if options.permission is not None and options.permission not in _PERMISSIONS:
        raise MCodeInvocationError(
            f"permission must be smart, full or off; received {options.permission!r}."
        )
    if options.mode is not None and options.mode not in _MODES:
        raise MCodeInvocationError(
            f"mode must be standard or lightweight; received {options.mode!r}."
        )
    if resuming and options.mode == "lightweight":
        raise MCodeInvocationError(
            'mode "lightweight" requires a new Thread; it cannot be resumed.'
        )
    if options.prompt_mode is not None and options.prompt_mode not in _PROMPT_MODES:
        raise MCodeInvocationError(
            f"prompt_mode must be tui, coding or work; received {options.prompt_mode!r}."
        )


def _positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def validate_run_options(options: RunOptions) -> None:
    if options.timeout_ms is not None and (
        not _positive_int(options.timeout_ms) or options.timeout_ms > MAX_TIMEOUT_MS
    ):
        raise MCodeInvocationError(
            f"timeout_ms must be a positive integer no greater than {MAX_TIMEOUT_MS}."
        )
    if options.max_steps is not None and not _positive_int(options.max_steps):
        raise MCodeInvocationError("max_steps must be a positive integer.")


def build_exec_args(
    *,
    thread: ThreadOptions,
    session_id: str | None,
    run: RunOptions,
    config_path: str | None = None,
    system_prompt_file: str | None = None,
    append_system_prompt_file: str | None = None,
) -> list[str]:
    """The prompt travels over stdin and system prompts through temp files; values use the
    ``--flag=value`` form so a value starting with ``-`` is never parsed as a flag."""
    args = [
        "exec",
        "--output-format=stream-json",
        "--input=-",
        "--input-format=json",
        f"--cwd={os.path.abspath(thread.cwd or os.getcwd())}",
    ]

    def push(flag: str, value: str | None) -> None:
        if value is not None:
            args.append(f"{flag}={value}")

    push("--model", thread.model)
    push("--effort", thread.effort)
    push("--permission", thread.permission)
    push("--prompt-mode", thread.prompt_mode)
    push("--config", config_path)
    if session_id is None:
        push("--mode", thread.mode)
    else:
        push("--session", session_id)
    push("--system-prompt-file", system_prompt_file)
    push("--append-system-prompt-file", append_system_prompt_file)
    for file in run.files:
        push("--file", file)
    if run.timeout_ms is not None:
        push("--timeout", f"{run.timeout_ms}ms")
    if run.max_steps is not None:
        push("--max-steps", str(run.max_steps))
    return args
