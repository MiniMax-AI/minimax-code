# `@minimax-ai/code-sdk` Changelog

All notable changes to `@minimax-ai/code-sdk` are documented here. The SDK is versioned
independently of the MiniMax Code CLI; see the README compatibility table for supported CLI
versions. The first `## X.Y.Z · YYYY-MM-DD` heading is the version being released.

## 0.1.0 · 2026-10-28

First public release.

### Added

- `MCode`, `startThread`, `resumeThread`, `thread.run()` and `thread.runStreamed()` drive
  `mcode exec --output-format stream-json`, one CLI process per Turn.
- CLI resolution: explicit `bin`, `@minimax-ai/code` installed next to the SDK, then `mcode` on
  `PATH`. `resolveFromCwd` (default off) also searches `process.cwd()` and parent
  `node_modules/.bin/mcode` directories.
- Requires MiniMax Code CLI `0.6.3` or later (a source build of this repository is `0.6.5`) and
  Node.js `>=22.19 <23 || >=24.2 <27`.
- Typed errors for invocation, run, cancellation, protocol, missing CLI, version and busy Thread
  failures, mapped from the CLI exit codes.
- Cancellation through `AbortSignal` (`SIGTERM`, then `SIGKILL` after the CLI's 60 second shutdown
  budget) and a `timeoutMs` backstop of `timeoutMs + 90s`.
- ESM with a `require()`-compatible export condition; no runtime dependencies.

### Not yet available

- `outputSchema`, approvals, steering and forking.
