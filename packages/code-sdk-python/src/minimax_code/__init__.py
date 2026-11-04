"""Python SDK for driving the local MiniMax Code (``mcode``) agent."""

from .client import MCode
from .errors import (
    MCODE_EXEC_EXIT_CODES,
    MCodeAbortError,
    MCodeError,
    MCodeInvocationError,
    MCodeNotFoundError,
    MCodeProtocolError,
    MCodeRunError,
    MCodeVersionError,
    ThreadBusyError,
)
from .sync import SyncMCode, SyncThread
from .thread import StreamedTurn, Thread
from .types import (
    AgentMessageItem,
    ExecError,
    ExecItem,
    ExecResult,
    MCodeOptions,
    ModelIdentity,
    ReasoningItem,
    RunOptions,
    ThreadEvent,
    ThreadItem,
    ThreadOptions,
    ToolCallItem,
    Turn,
    Usage,
)

__version__ = "0.1.0"

__all__ = [
    "MCODE_EXEC_EXIT_CODES",
    "AgentMessageItem",
    "ExecError",
    "ExecItem",
    "ExecResult",
    "MCode",
    "MCodeAbortError",
    "MCodeError",
    "MCodeInvocationError",
    "MCodeNotFoundError",
    "MCodeOptions",
    "MCodeProtocolError",
    "MCodeRunError",
    "MCodeVersionError",
    "ModelIdentity",
    "ReasoningItem",
    "RunOptions",
    "StreamedTurn",
    "SyncMCode",
    "SyncThread",
    "Thread",
    "ThreadBusyError",
    "ThreadEvent",
    "ThreadItem",
    "ThreadOptions",
    "ToolCallItem",
    "Turn",
    "Usage",
    "__version__",
]
