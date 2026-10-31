"""Folds ``item.*`` events into SDK items. Mirrors ``packages/code-sdk/src/items.ts``."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .types import AgentMessageItem, ReasoningItem, ThreadEvent, ThreadItem, ToolCallItem


@dataclass
class _State:
    type: str
    text: str = ""
    tool_call: dict[str, Any] | None = None
    completed: bool = False
    snapshot: str = ""


class ItemAccumulator:
    def __init__(self) -> None:
        self._states: dict[str, _State] = {}

    def apply(self, event: ThreadEvent) -> bool:
        """Applies one event. Returns False for a duplicate snapshot ``item.updated``."""
        if event["type"] not in ("item.started", "item.updated", "item.completed"):
            return True
        item = event.get("item")
        if item is None:
            return True
        delta = item.get("contentDelta")
        snapshot = json.dumps(item, sort_keys=True) if delta is None else ""
        state = self._states.get(item["id"])
        if (
            state is not None
            and event["type"] == "item.updated"
            and snapshot
            and state.snapshot == snapshot
            and not state.completed
        ):
            return False
        if state is None:
            state = _State(type=item["type"])
            self._states[item["id"]] = state
        state.snapshot = snapshot
        if delta is not None:
            state.text += delta
        if "content" in item:
            state.text = item["content"]
        if "toolCall" in item:
            state.tool_call = item["toolCall"]
        if event["type"] == "item.completed":
            state.completed = True
        return True

    def items(self) -> list[ThreadItem]:
        out: list[ThreadItem] = []
        for item_id, s in self._states.items():
            incomplete = not s.completed
            if s.type == "agent_message":
                out.append(AgentMessageItem(id=item_id, text=s.text, incomplete=incomplete))
            elif s.type == "reasoning":
                out.append(ReasoningItem(id=item_id, text=s.text, incomplete=incomplete))
            elif s.type == "tool_call":
                out.append(
                    ToolCallItem(
                        id=item_id, tool_call=s.tool_call or {"id": item_id}, incomplete=incomplete
                    )
                )
        return out
