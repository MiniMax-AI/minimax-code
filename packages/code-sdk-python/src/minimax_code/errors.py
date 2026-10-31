"""SDK errors. Mirrors ``packages/code-sdk/src/errors.ts``."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from .types import ExecResult, ThreadItem

#: Exit codes of ``mcode exec`` (``MINIMAX_CODE_EXEC_EXIT_CODES`` in the CLI).
MCODE_EXEC_EXIT_CODES: dict[str, int] = {
    "success": 0,
    "invocation": 2,
    "config": 3,
    "runtime": 4,
    "timeout": 6,
    "limit": 7,
    "internal": 70,
    "cancelled": 130,
    "broken_pipe": 141,
}

MCODE_INSTALL_HINT = "npm install -g @minimax-ai/code@latest"


class MCodeError(Exception):
    """Base class for every error raised by the SDK."""

    def __init__(
        self,
        message: str,
        *,
        exit_code: int | None = None,
        stderr: str = "",
        session_id: str | None = None,
        result: ExecResult | None = None,
        items: Sequence[ThreadItem] = (),
    ) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        #: Tail of the CLI stderr, for diagnostics only.
        self.stderr = stderr
        self.session_id = session_id
        self.result = result
        self.items = list(items)


class MCodeInvocationError(MCodeError):
    """Invalid SDK options, or the CLI rejected the invocation (exit code 2)."""


class MCodeRunError(MCodeError):
    """The Turn ended with ``failed``, ``timeout`` or ``limit_exceeded``."""

    def __init__(self, message: str, *, status: str, category: str | None = None, **kw: Any):
        super().__init__(message, **kw)
        self.status = status
        self.category = category


class MCodeAbortError(MCodeError):
    """The Turn was cancelled."""


class MCodeProtocolError(MCodeError):
    """The CLI produced output the SDK cannot understand."""


class MCodeNotFoundError(MCodeError):
    """The ``mcode`` CLI could not be found."""


class MCodeVersionError(MCodeError):
    """The CLI is too old or speaks an unsupported schema version."""


class ThreadBusyError(MCodeError):
    """A Thread already has a Turn in progress."""

    def __init__(self, thread_id: str | None) -> None:
        super().__init__(f"Thread {thread_id or '(new)'} already has a Turn in progress.")


_STATUS_BY_EXIT_CODE: dict[int, tuple[str, str | None]] = {
    3: ("failed", "config"),
    4: ("failed", "runtime"),
    6: ("timeout", None),
    7: ("limit_exceeded", None),
    70: ("failed", "internal"),
}


def error_for_result(
    result: ExecResult, items: Sequence[ThreadItem], *, exit_code: int | None, stderr: str
) -> MCodeError:
    common: dict[str, Any] = {
        "exit_code": exit_code,
        "stderr": stderr,
        "session_id": result["sessionId"],
        "result": result,
        "items": items,
    }
    if result["status"] == "cancelled":
        return MCodeAbortError("The MCode run was cancelled.", **common)
    status = "failed" if result["status"] == "succeeded" else result["status"]
    error = result.get("error")
    reason = error["message"] if error else f"status {result['status']}"
    category = error["category"] if error else None
    return MCodeRunError(
        f"The MCode run ended with {status}: {reason}", status=status, category=category, **common
    )


def error_for_exit(
    *, exit_code: int | None, stderr: str, items: Sequence[ThreadItem], session_id: str | None
) -> MCodeError:
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    reason = lines[-1] if lines else f"exit code {exit_code}"
    common: dict[str, Any] = {
        "exit_code": exit_code,
        "stderr": stderr,
        "items": items,
        "session_id": session_id,
    }
    if exit_code == MCODE_EXEC_EXIT_CODES["invocation"]:
        return MCodeInvocationError(f"mcode rejected the invocation: {reason}", **common)
    if exit_code == MCODE_EXEC_EXIT_CODES["cancelled"] or (exit_code is not None and exit_code < 0):
        return MCodeAbortError("The MCode run was cancelled.", **common)
    if exit_code == MCODE_EXEC_EXIT_CODES["broken_pipe"]:
        return MCodeProtocolError(f"mcode reported a broken output pipe: {reason}", **common)
    if exit_code == 0:
        return MCodeProtocolError("mcode exited without emitting exec.completed.", **common)
    status, category = _STATUS_BY_EXIT_CODE.get(exit_code or -1, ("failed", "internal"))
    return MCodeRunError(
        f"The MCode run ended without a result: {reason}",
        status=status,
        category=category,
        **common,
    )
