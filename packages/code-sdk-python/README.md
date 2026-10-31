# minimax-code-sdk

Python SDK for driving the local [MiniMax Code](https://agent.minimax.io) agent (`mcode`).

It mirrors the TypeScript SDK [`@minimax-ai/code-sdk`](../code-sdk): every Turn runs
`mcode exec --output-format=stream-json` and continues the Session with `--session`.

## Requirements

- Python 3.10+
- The `mcode` CLI (0.6.3 or newer): `npm install -g @minimax-ai/code`

The CLI is found from `MCodeOptions(bin=...)`, then the `MCODE_BIN` environment variable,
then `PATH`.

## Quick start

```python
import asyncio
from minimax_code import MCode, ThreadOptions


async def main() -> None:
    client = MCode()
    thread = client.start_thread(ThreadOptions(cwd=".", permission="smart"))

    turn = await thread.run("Summarize this repository in one sentence.")
    print(turn.final_response, turn.usage)

    # Same Session, next Turn.
    turn = await thread.run("Now list its top-level directories.")

    # Persist thread.id and continue later.
    later = client.resume_thread(thread.id)
    print((await later.run("What did I ask first?")).final_response)


asyncio.run(main())
```

### Streaming

```python
streamed = await thread.run_streamed("Fix the failing test.")
async for event in streamed:
    if event["type"] == "item.updated" and event["item"]["type"] == "agent_message":
        print(event["item"].get("contentDelta", ""), end="")
    elif event["type"] == "turn.failed":
        print("failed:", event.get("error"))
```

Events are the CLI's stream-json events, passed through unchanged (unknown types included).
`turn.failed` is an ordinary event; iteration raises only for process or protocol failures.

### Cancellation

- `streamed.cancel()` sends SIGINT; the stream ends with the CLI's final events.
- Leaving the `async for` early, or cancelling the task running `thread.run()`, stops the CLI
  (SIGINT, then SIGKILL after a grace period).
- `RunOptions(timeout_ms=...)` is enforced by the CLI.

### Blocking API

```python
from minimax_code import SyncMCode

with SyncMCode() as client:
    thread = client.start_thread()
    print(thread.run("hello").final_response)
    for event in thread.run_streamed("again"):
        print(event["type"])
```

## Options

| Object | Fields |
| --- | --- |
| `MCodeOptions` | `bin`, `data_dir` (`MINIMAX_DATA_DIR`), `env` (replaces `os.environ`), `config_path` |
| `ThreadOptions` | `cwd`, `model` (`provider/model`), `effort`, `permission` (`smart`/`full`/`off`), `mode`, `prompt_mode`, `system_prompt`, `append_system_prompt` |
| `RunOptions` | `files`, `timeout_ms`, `max_steps` |

## Errors

All errors subclass `MCodeError` (with `exit_code`, `stderr`, `session_id`, `result`, `items`):
`MCodeNotFoundError`, `MCodeVersionError`, `MCodeInvocationError`, `MCodeRunError`
(`status`, `category`), `MCodeAbortError`, `MCodeProtocolError`, `ThreadBusyError`.

## Limitations

Each Turn is a separate process, so interactive permission prompts (`permission="ask"`) and
custom in-process tools are not supported yet. A long-lived ACP transport is planned.

## Development

```bash
uv sync
uv run pytest
uv run ruff check . && uv run ruff format --check . && uv run mypy
```

End-to-end tests against a real CLI and model are opt-in:
`MCODE_SDK_E2E=1 MCODE_BIN=/path/to/mcode uv run pytest -m e2e`.

## License

MIT
