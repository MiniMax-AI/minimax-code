---
name: cli-guide
description: Navigate and change the MiniMax Code command tree, interactive TUI, headless exec, ACP adapters, or their in-process runtime connection. Use when implementing or debugging CLI behavior in this repository.
---

# CLI Architecture Guide

Read `docs/architecture.md` and the current command registration before proposing
a change. The standalone entry point lives in `packages/tui`.

## Entry points

| Path | Responsibility |
| --- | --- |
| `packages/tui/src/index.ts` | Process bootstrap and runtime environment |
| `packages/tui/src/cli/main.ts` | Command execution and process lifecycle |
| `packages/tui/src/cli/program.ts` | Commander command registration |
| `packages/tui/src/cli/contract.ts` | Interactive and exec option contracts |
| `packages/tui/src/tui/` | Interactive terminal UI |
| `packages/tui/src/headless/` | Exec invocation, output, cancellation and settlement |
| `packages/tui/src/acp/` | ACP protocol adapter |
| `packages/tui/src/runtime/adapter.ts` | Adapter to the in-process CliService |
| `packages/local-runtime-v2/src/local/` | Local product service entry points |
| `packages/protocol/src/local.ts` | Shared CLI data structures |

The execution path is:

```text
TUI / exec / ACP
  -> CliService
  -> local applications
  -> session / turn / agent services
  -> model providers and tools
```

Preserve that in-process boundary. Shared behavior belongs in the relevant
application or service; presentation and transport behavior belong in their
adapters. Trace callers before assuming a fix to one adapter covers the others.

## Implementing changes

- For commands and flags, inspect `cli/program.ts`, `cli/contract.ts`, and the
  affected command handler together. Check parsing, help, dispatch and errors.
- For interactive behavior, follow the controller and rendering path under
  `tui/`. Check session selection, queued input and interruption where affected.
- For exec, follow invocation through output and settlement. Verify stdout,
  stderr, exit code and cancellation; help output alone is insufficient.
- For ACP, check protocol updates and the underlying runtime operation together.
- For shared runtime changes, identify all affected TUI, exec and ACP consumers.

## Verification

Use [testing-workflow](../testing-workflow/SKILL.md) to select declared tests.
Build the standalone artifact before inspecting its actual help:

```bash
pnpm build
node dist/cli.js --help
node dist/cli.js exec --help
node dist/cli.js acp --help
```

Read current help before documenting flags. Use temporary data directories and
synthetic inputs for behavior checks, following the existing smoke/BYOK tests.
Report offline protocol tests separately from live-provider acceptance.
