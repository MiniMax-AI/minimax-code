# `minimax-code-sdk` Changelog

All notable changes to the `minimax-code-sdk` Python package are documented here. The SDK is
versioned independently of the MiniMax Code CLI and of the TypeScript SDK. The first
`## X.Y.Z · YYYY-MM-DD` heading is the version being released; see [RELEASING.md](RELEASING.md).

## 0.1.0 · 2026-11-03

First public release.

### Added

- `MCode`, `start_thread()`, `resume_thread()`, `thread.run()` and `thread.run_streamed()` drive
  `mcode exec --output-format=stream-json`, one CLI process per Turn, continuing the Session with
  `--session`.
- `SyncMCode` and `SyncThread`, a blocking API for scripts and notebooks without an event loop.
- CLI resolution: explicit `MCodeOptions(bin=...)`, then `$MCODE_BIN`, then `mcode` on `PATH`.
  Requires MiniMax Code CLI `0.6.3` or later and Python `3.10` or later.
- Stream events are passed through unchanged as typed dicts (event `schemaVersion` 1), including
  unknown event types; `thread.run()` folds them into `Turn.items`.
- Typed errors for invocation, run, cancellation, protocol, missing CLI, version and busy Thread
  failures, mapped from the CLI exit codes.
- Cancellation through `StreamedTurn.cancel()`, early loop exit or task cancellation (`SIGINT`,
  then `SIGKILL` after 10 seconds) and a `timeout_ms` backstop of `timeout_ms + 30s`.
- `system_prompt` and `append_system_prompt` are passed through private temporary files.
- Ships `py.typed`; the only runtime dependency is `typing_extensions`.

### Not yet available

- Interactive permission prompts (`permission="ask"`), custom in-process tools and a long-lived
  ACP transport.
