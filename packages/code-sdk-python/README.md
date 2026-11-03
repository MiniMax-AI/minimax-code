# minimax-code-sdk

Python SDK for driving the local [MiniMax Code](https://agent.minimax.io) agent (`mcode`).

It mirrors the TypeScript SDK
[`@minimax-ai/code-sdk`](https://github.com/MiniMax-AI/minimax-code/tree/main/packages/code-sdk): every Turn runs
`mcode exec --output-format=stream-json` and continues the Session with `--session`.

## Requirements

- Python 3.10+
- The `mcode` CLI (0.6.3 or newer): `npm install -g @minimax-ai/code`

## Install

```bash
pip install --pre minimax-code-sdk   # or: uv add --prerelease=allow minimax-code-sdk
```

The SDK is in beta, so installers need `--pre` (or an exact version such as
`minimax-code-sdk==0.1.0b1`) until `0.1.0` is released. Import it as `minimax_code`.

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

    # Persist thread.id and continue later, in the same workspace.
    later = client.resume_thread(thread.id, ThreadOptions(cwd="."))
    print((await later.run("What did I ask first?")).final_response)


asyncio.run(main())
```

### Resuming a Session

A Session belongs to the workspace it was created in. Pass the same `cwd` to `resume_thread()`;
when `cwd` is omitted, the current working directory is used. A different workspace fails with
`MCodeRunError` ("Session ... belongs to workspace ..."), and retrying does not help.

```python
thread = client.start_thread(ThreadOptions(cwd="/path/to/project"))
await thread.run("...")
later = client.resume_thread(thread.id, ThreadOptions(cwd="/path/to/project"))
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

Events are the CLI's stream-json events, passed through unchanged (unknown types included),
with one exception: an `item.updated` snapshot (no `contentDelta`) identical to the previous
snapshot of the same item is skipped. Text deltas are never skipped. `turn.failed` is an ordinary
event; iteration raises only for process or protocol failures.

### Cancellation

- `streamed.cancel()` sends SIGINT; the stream ends with the CLI's final events.
- Leaving the `async for` early (`break` or an exception in the loop body), or cancelling the
  task running `thread.run()`, stops the CLI (SIGINT, then SIGKILL after a grace period). The
  next Turn on the same Thread waits for that shutdown instead of raising `ThreadBusyError`;
  `async with streamed:` or `await streamed.aclose()` stops it deterministically.
- `RunOptions(timeout_ms=...)` is enforced by the CLI. If the CLI is still running 30 seconds
  after `timeout_ms`, the SDK kills it and raises `MCodeRunError` with `status="timeout"`.

### Blocking API

```python
from minimax_code import SyncMCode

with SyncMCode() as client:
    thread = client.start_thread()
    print(thread.run("hello").final_response)
    for event in thread.run_streamed("again"):
        print(event["type"])
```

The blocking API runs its own event loop, so it cannot be used where a loop is already running,
such as a Jupyter notebook or an `async def` function. Use the async API with `await` there.

## Options

| Object | Fields |
| --- | --- |
| `MCodeOptions` | `bin`, `data_dir` (`MINIMAX_DATA_DIR`), `env` (replaces `os.environ`; values hidden in `repr()`), `config_path` |
| `ThreadOptions` | `cwd`, `model` (`provider/model`), `effort`, `permission` (`smart`/`full`/`off`), `mode`, `prompt_mode`, `system_prompt`, `append_system_prompt` |
| `RunOptions` | `files`, `timeout_ms`, `max_steps` |

## Errors

All errors subclass `MCodeError` (with `exit_code`, `stderr`, `session_id`, `result`, `items`):
`MCodeNotFoundError`, `MCodeVersionError`, `MCodeInvocationError`, `MCodeRunError`
(`status`, `category`), `MCodeAbortError`, `MCodeProtocolError`, `ThreadBusyError`.
Errors can be pickled, for example to return them from a `ProcessPoolExecutor` worker.

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

Release notes are in
[CHANGELOG.md](https://github.com/MiniMax-AI/minimax-code/blob/main/packages/code-sdk-python/CHANGELOG.md);
maintainers publish with
[RELEASING.md](https://github.com/MiniMax-AI/minimax-code/blob/main/packages/code-sdk-python/RELEASING.md).

## License

MIT
