"""Print the agent's answer as it streams, and tool calls as they finish."""

import asyncio
import sys

from minimax_code import MCode


async def main() -> None:
    thread = MCode().start_thread()
    streamed = await thread.run_streamed(sys.argv[1] if len(sys.argv) > 1 else "List files here.")
    async for event in streamed:
        item = event.get("item")
        if item and item["type"] == "agent_message":
            print(item.get("contentDelta", ""), end="", flush=True)
        elif item and item["type"] == "tool_call" and event["type"] == "item.completed":
            print(f"\n[tool] {item.get('toolCall', {}).get('name')}")
        elif event["type"] == "turn.failed":
            print("\nturn failed:", event.get("error"))
    print()


if __name__ == "__main__":
    asyncio.run(main())
