"""Public types for the ``mcode exec --output-format stream-json`` contract (schemaVersion 1).

Mirrors ``packages/code-sdk/src/types.ts``. Events are passed through as plain dicts typed with
``TypedDict`` so new fields or event types added by newer CLIs never break parsing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict

from typing_extensions import NotRequired

ExecResultStatus = Literal["succeeded", "failed", "timeout", "cancelled", "limit_exceeded"]
ExecErrorCategory = Literal["config", "runtime", "internal"]
UsageSource = Literal["completed_responses", "analytics_fallback", "unavailable"]
ExecItemType = Literal["agent_message", "reasoning", "tool_call"]
PermissionPolicy = Literal["smart", "full", "off"]
ContextMode = Literal["standard", "lightweight"]
PromptMode = Literal["tui", "coding", "work"]


class ExecError(TypedDict):
    category: ExecErrorCategory
    message: str
    code: NotRequired[str]
    retryable: NotRequired[bool]


class ModelIdentity(TypedDict):
    providerId: str
    modelId: str
    variant: NotRequired[str]
    providerSource: NotRequired[str]
    providerKind: NotRequired[str]
    protocol: NotRequired[str]


class Usage(TypedDict, total=False):
    """Token usage. ``totalTokens = inputTokens + outputTokens``; cache buckets are separate."""

    totalTokens: int
    inputTokens: int
    outputTokens: int
    reasoningTokens: int
    cacheReadTokens: int
    cacheWriteTokens: int


class ExecResult(TypedDict):
    """Final result of one ``mcode exec`` run (``exec.completed.result``)."""

    schemaVersion: Literal[1]
    type: Literal["exec.result"]
    runId: str
    sessionId: str
    turnId: str
    status: ExecResultStatus
    durationMs: int
    output: NotRequired[Any]
    error: NotRequired[ExecError]
    model: NotRequired[ModelIdentity]
    usage: NotRequired[Usage]
    usageSource: NotRequired[UsageSource]
    usageIncomplete: NotRequired[bool]


RawToolCall = dict[str, Any]
"""Experimental raw tool call snapshot (``id``, ``name``, ``status``, ``input``, ``output``...)."""


class ExecItem(TypedDict):
    id: str
    type: ExecItemType
    content: NotRequired[str]
    contentDelta: NotRequired[str]
    toolCall: NotRequired[RawToolCall]


class ThreadEvent(TypedDict):
    """One CLI stream event. Check ``type`` and read the fields specific to it.

    Known types: ``exec.started``, ``session.started``, ``session.resumed``, ``turn.started``,
    ``item.started``, ``item.updated``, ``item.completed`` (with ``item``), ``turn.completed``
    (``model``/``usage``/``durationMs``), ``turn.failed`` (``status``/``error``/``durationMs``),
    ``exec.completed`` (``result``). Unknown types are passed through; keep a default branch.
    """

    schemaVersion: Literal[1]
    type: str
    sequence: int
    timestampMs: int
    runId: str
    sessionId: str
    turnId: str
    item: NotRequired[ExecItem]
    result: NotRequired[ExecResult]
    model: NotRequired[ModelIdentity]
    usage: NotRequired[Usage]
    usageSource: NotRequired[UsageSource]
    usageIncomplete: NotRequired[bool]
    status: NotRequired[str]
    error: NotRequired[ExecError]
    durationMs: NotRequired[int]


@dataclass(frozen=True)
class AgentMessageItem:
    id: str
    text: str
    incomplete: bool = False
    type: Literal["agent_message"] = "agent_message"


@dataclass(frozen=True)
class ReasoningItem:
    id: str
    text: str
    incomplete: bool = False
    type: Literal["reasoning"] = "reasoning"


@dataclass(frozen=True)
class ToolCallItem:
    id: str
    tool_call: RawToolCall
    incomplete: bool = False
    type: Literal["tool_call"] = "tool_call"


ThreadItem = AgentMessageItem | ReasoningItem | ToolCallItem


@dataclass(frozen=True)
class Turn:
    """Result of a successful ``thread.run()``."""

    final_response: str
    items: list[ThreadItem]
    session_id: str
    turn_id: str
    duration_ms: int
    result: ExecResult
    usage: Usage | None = None
    model: ModelIdentity | None = None
    status: Literal["succeeded"] = "succeeded"


@dataclass(frozen=True)
class MCodeOptions:
    """Client options.

    ``bin``: explicit ``mcode`` executable (or JS entry). Otherwise ``$MCODE_BIN``, then ``PATH``.
    ``data_dir``: passed to the CLI as ``MINIMAX_DATA_DIR``.
    ``env``: child environment; replaces ``os.environ`` when provided.
    ``config_path``: runtime config file, passed as ``--config``.
    """

    bin: str | None = None
    data_dir: str | None = None
    env: dict[str, str] | None = None
    config_path: str | None = None


@dataclass(frozen=True)
class ThreadOptions:
    cwd: str | None = None
    model: str | None = None
    """Model as ``provider/model``, for example ``minimax/MiniMax-M3``."""
    effort: str | None = None
    permission: PermissionPolicy | None = None
    mode: ContextMode | None = None
    """Context mode for a new Thread. ``lightweight`` cannot be resumed."""
    prompt_mode: PromptMode | None = None
    system_prompt: str | None = None
    append_system_prompt: str | None = None


@dataclass(frozen=True)
class RunOptions:
    files: list[str] = field(default_factory=list)
    """Files attached to this Turn (``--file``). Relative paths resolve against ``cwd``."""
    timeout_ms: int | None = None
    max_steps: int | None = None
