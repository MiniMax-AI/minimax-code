"""Parses stdout lines. Mirrors ``packages/code-sdk/src/protocol.ts``."""

from __future__ import annotations

import json
from typing import Any, cast

from .errors import MCodeProtocolError, MCodeVersionError
from .types import ThreadEvent

SUPPORTED_SCHEMA_VERSION = 1


def _truncate(text: str) -> str:
    return text if len(text) <= 200 else text[:200] + "…"


def parse_event_line(line: str) -> ThreadEvent | None:
    text = line.strip()
    if not text:
        return None
    try:
        value: Any = json.loads(text)
    except json.JSONDecodeError as error:
        raise MCodeProtocolError(f"mcode stdout is not JSON: {_truncate(text)}") from error
    if not isinstance(value, dict):
        raise MCodeProtocolError(f"mcode stdout line is not a JSON object: {_truncate(text)}")
    if value.get("schemaVersion") != SUPPORTED_SCHEMA_VERSION:
        raise MCodeVersionError(
            f"Unsupported mcode event schemaVersion {value.get('schemaVersion')!r}; "
            f"this SDK supports {SUPPORTED_SCHEMA_VERSION}."
        )
    if not isinstance(value.get("type"), str) or not isinstance(value.get("sessionId"), str):
        raise MCodeProtocolError(f"mcode event is missing type or sessionId: {_truncate(text)}")
    kind: str = value["type"]
    if kind.startswith("item."):
        item = value.get("item")
        if not (
            isinstance(item, dict)
            and isinstance(item.get("id"), str)
            and isinstance(item.get("type"), str)
        ):
            raise MCodeProtocolError(f"mcode {kind} event has an invalid item: {_truncate(text)}")
    if kind == "exec.completed":
        result = value.get("result")
        if not (
            isinstance(result, dict)
            and result.get("schemaVersion") == SUPPORTED_SCHEMA_VERSION
            and isinstance(result.get("status"), str)
            and isinstance(result.get("sessionId"), str)
            and isinstance(result.get("turnId"), str)
        ):
            raise MCodeProtocolError(
                f"mcode exec.completed has an invalid result: {_truncate(text)}"
            )
    return cast(ThreadEvent, value)
