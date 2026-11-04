# `minimax-code-sdk` Changelog

All notable changes to the `minimax-code-sdk` Python package are documented here. The SDK is
versioned independently of the MiniMax Code CLI and of the TypeScript SDK. The first
`## X.Y.Z · YYYY-MM-DD` heading is the version being released; see [RELEASING.md](RELEASING.md).

## 0.1.0 · 2026-11-04

First stable release. `pip install minimax-code-sdk` installs it without `--pre`. The public
API is the same as `0.1.0b1`; the changes below fix process handling, errors and Windows support.

### Fixed

- Leaving `async for event in streamed` early with `break` or an exception in the loop body now
  stops the CLI and releases the Thread, as documented. Previously the CLI kept running and every
  later Turn on the Thread raised `ThreadBusyError` until `streamed.aclose()` was called. The
  next Turn waits for the previous CLI to shut down.
- When the `timeout_ms` backstop kills a CLI that did not stop on its own, the Turn raises
  `MCodeRunError` with `status="timeout"` instead of `MCodeAbortError` ("cancelled").
- An `exec.completed` result without `durationMs` now raises `MCodeProtocolError`, and a failed
  result whose `error` lacks `message` or `category` raises `MCodeRunError`, instead of a bare
  `KeyError`.
- SDK errors survive pickling: `MCodeRunError` can be unpickled, and `ThreadBusyError` keeps its
  message instead of repeating it.
- `repr(MCodeOptions(...))` no longer prints `env` values, which could expose secrets in logs.
- Cancellation sends SIGTERM instead of SIGINT. After Ctrl+C in a terminal had already delivered
  SIGINT to the CLI, the SDK's second SIGINT hit the CLI's default action and killed it before it
  could persist the Turn and write `exec.completed`.
- Cancellation waits for the CLI's 60 second shutdown budget before SIGKILL (was 10 seconds), and
  the `timeout_ms` backstop fires 90 seconds after `timeout_ms` (was 30), matching the
  TypeScript SDK. The shorter values could kill a CLI that was still shutting down cleanly.
- `exec.completed` ends the Turn: later output is ignored and a CLI that does not exit within
  5 seconds is killed. A background process that inherited the CLI's stdout or stderr no longer
  keeps `thread.run()` waiting until it exits; after the CLI exits, remaining output is read for
  at most 2 seconds.
- A Thread pins `ThreadOptions.cwd` (default: the current directory) when it is created. A later
  `os.chdir()` used to move the next Turn to another workspace, which the CLI rejects for an
  existing Session.
- Windows: `mcode.cmd` launchers from the official installer and npm / pnpm are no longer run
  through cmd.exe. The SDK runs the JS entry and Node runtime behind them, so arguments are not
  reinterpreted by cmd.exe and cancelling stops the CLI itself rather than only cmd.exe.
  `MCODE_BIN` and `PATH` are looked up case-insensitively on Windows.

### Documentation

- The README states that identical repeated `item.updated` snapshots are skipped, and that the
  blocking API cannot run where an event loop is already running (for example Jupyter).

## 0.1.0b1 · 2026-11-03

First public beta. Install it with `pip install --pre minimax-code-sdk`; the API may still
change before `0.1.0`.

### Added

- `MCode`, `start_thread()`, `resume_thread()`, `thread.run()` and `thread.run_streamed()` drive
  `mcode exec --output-format=stream-json`, one CLI process per Turn, continuing the Session with
  `--session`.
- `SyncMCode` and `SyncThread`, a blocking API for code without a running event loop. It does
  not work where a loop is already running, such as Jupyter notebooks; use the async API there.
- CLI resolution: explicit `MCodeOptions(bin=...)`, then `$MCODE_BIN`, then `mcode` on `PATH`.
  Requires MiniMax Code CLI `0.6.3` or later and Python `3.10` or later.
- Stream events are passed through unchanged as typed dicts (event `schemaVersion` 1), including
  unknown event types, except that identical repeated `item.updated` snapshots are skipped;
  `thread.run()` folds them into `Turn.items`.
- Typed errors for invocation, run, cancellation, protocol, missing CLI, version and busy Thread
  failures, mapped from the CLI exit codes.
- Cancellation through `StreamedTurn.cancel()`, early loop exit or task cancellation (`SIGINT`,
  then `SIGKILL` after 10 seconds) and a `timeout_ms` backstop of `timeout_ms + 30s`.
- `system_prompt` and `append_system_prompt` are passed through private temporary files.
- Ships `py.typed`; the only runtime dependency is `typing_extensions`.

### Not yet available

- Interactive permission prompts (`permission="ask"`), custom in-process tools and a long-lived
  ACP transport.
