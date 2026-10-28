# `@minimax-ai/code-sdk`

A TypeScript SDK for driving the local MiniMax Code (`mcode`) agent programmatically from Node.js,
modeled after the [Codex TypeScript SDK](https://learn.chatgpt.com/docs/codex-sdk). Use it to run
MiniMax Code in CI/CD (fixes, reviews, code generation), embed it in internal tools or your own
agents, or orchestrate multi-turn conversations from code.

> [!NOTE]
>
> The SDK is in Phase 1 (`0.x`): the API may change between minor versions until `1.0`. It is
> versioned independently of the CLI; see [CHANGELOG.md](CHANGELOG.md).

## How it works

- Each `run()` / `runStreamed()` starts one
  `mcode exec --output-format stream-json --input - --input-format json` process, writes the prompt
  to its stdin as `{"prompt": "..."}`, and closes stdin. **One run = one CLI process = one Turn.**
- A `Thread` only holds the Session id inside the SDK; later Turns continue the Session with
  `--session <id>`. The CLI's embedded runtime persists Sessions in its data directory, so a
  crashed host can resume a Thread from its id with `resumeThread`.
- The SDK consumes only the public `mcode exec` contract (stdout JSONL plus exit code) and never
  reads runtime-internal data.
- No runtime dependencies; ESM with a `require()`-compatible export condition.

## Installation and CLI resolution

The SDK does not hard-depend on the CLI, which is large and ships native dependencies.
`@minimax-ai/code` is an optional peer dependency:

```bash
npm install @minimax-ai/code-sdk
npm install @minimax-ai/code   # optional; a globally installed mcode works too
```

The SDK looks for the CLI in this order:

1. The `bin` constructor option (an executable, a JS entry, or a command name on `PATH`).
2. An installed `@minimax-ai/code`: resolved first from the SDK's own location (where peer
   dependencies are installed), then from `process.cwd()`. The SDK reads `bin.mcode` from its
   `package.json` and runs that JS entry with `process.execPath`.
3. Any project-local MiniMax Code CLI: the nearest `node_modules/.bin/mcode` (`mcode.cmd` /
   `mcode.ps1` on Windows) found walking up from `process.cwd()`. The SDK prefers the JS entry behind
   the symlink or npm/pnpm shim and runs it with `process.execPath`, so the CLI package name does
   not matter.
4. `mcode` on `PATH` (`mcode.cmd` on Windows: the JS entry behind an npm/pnpm shim is preferred;
   otherwise it is started through `cmd.exe` with strictly escaped arguments).

Before the first run, each `MCode` instance runs `mcode --version` once and caches the result. A
CLI older than `MIN_CLI_VERSION` (currently `0.7.0`) fails with `MCodeVersionError`. Only
`major.minor.patch` is compared, so `0.7.0-preview.N` satisfies `0.7.0`.

### Compatibility

| `@minimax-ai/code-sdk` | MiniMax Code CLI (`mcode`)     | Node.js                       | Event `schemaVersion` |
| ---------------------- | ------------------------------ | ----------------------------- | --------------------- |
| `0.1.x`                | `>=0.7.0` (`MIN_CLI_VERSION`)  | `>=22.19 <23 \|\| >=24.2 <27` | `1`                   |

The SDK and the CLI are released separately. Upgrading the SDK does not require upgrading the CLI
as long as the CLI meets `MIN_CLI_VERSION`. If the CLI ever emits a new event `schemaVersion`,
upgrade to an SDK release that supports it. The Node.js range matches the CLI's.

## Quick start

```ts
import { MCode } from '@minimax-ai/code-sdk';

const mcode = new MCode({ dataDir: '/srv/mcode-data' });
const thread = mcode.startThread({
  cwd: '/path/to/repo',
  model: 'minimax/MiniMax-M3',
  permission: 'smart',
});

const turn = await thread.run('Diagnose and fix the failing CI job', {
  files: ['./ci.log'],
  timeoutMs: 10 * 60_000,
});
console.log(thread.id, turn.finalResponse, turn.usage);

// Continue the same Thread
await thread.run('Add unit tests for the fix');

// Resume an earlier Session
const resumed = mcode.resumeThread('mvs_xxx', { cwd: '/path/to/repo' });
await resumed.run('Continue where you left off');
```

Streaming:

```ts
const { events } = await thread.runStreamed('Implement the plan');
for await (const event of events) {
  switch (event.type) {
    case 'item.completed':
      console.log(event.item);
      break;
    case 'turn.failed':
      console.error(event.status, event.error);
      break;
    default:
      // Newer CLIs may add event types; the SDK passes them through unchanged.
      break;
  }
}
```

## API

### `new MCode(options?)`

| Option       | Description                                                                         |
| ------------ | ----------------------------------------------------------------------------------- |
| `bin`        | Explicit `mcode` path or command name; skips package and `PATH` lookup              |
| `dataDir`    | Data directory, passed to the CLI as the `MINIMAX_DATA_DIR` environment variable    |
| `env`        | Child process environment. **Replaces** `process.env` when set (no merge); defaults to `process.env` |
| `configPath` | Runtime config file, passed as `--config`                                           |

`env` replaces the environment entirely: passing only custom variables drops `PATH`, `HOME` and so
on, so the CLI may fail to find Node.js or tools, or to read its credentials. To add variables,
spread `process.env`:

```ts
const mcode = new MCode({ env: { ...process.env, FOO: 'bar' } });
```

### `startThread(options?)` / `resumeThread(id, options?)`

Thread options are passed to the CLI on every Turn of the Thread:

| Option               | CLI flag                                                                 |
| -------------------- | ------------------------------------------------------------------------ |
| `cwd`                | `--cwd` (defaults to the host process working directory)                 |
| `model` / `effort`   | `--model` / `--effort`                                                   |
| `permission`         | `--permission`: `smart` / `full` / `off`                                 |
| `mode`               | `--mode`: `standard` / `lightweight`, only on the Turn that creates the Session |
| `promptMode`         | `--prompt-mode`: `tui` / `coding` / `work`                               |
| `systemPrompt`       | `--system-prompt-file` (the SDK writes a temporary file)                 |
| `appendSystemPrompt` | `--append-system-prompt-file` (the SDK writes a temporary file)          |

- `mode: 'lightweight'` is only valid for a new Thread; passing it to `resumeThread` throws
  `MCodeInvocationError` immediately.
- There is no `ask` permission: headless runs cannot ask for approval. MiniMax Code's
  `smart` / `full` / `off` policies are not equivalent to Codex's OS-level sandbox modes, and the
  SDK does not map between them.
- `thread.id` becomes available once the first Turn emits its first event, even if that Turn fails.

### `thread.run(input, options?)` / `thread.runStreamed(input, options?)`

| Option      | Description                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `files`     | Attachments, `--file` (repeatable); relative paths resolve against `cwd`                                                                                                 |
| `signal`    | `AbortSignal`; see [Cancellation](#cancellation-timeouts-and-process-cleanup)                                                                                            |
| `timeoutMs` | Passed to the CLI as `--timeout <n>ms`; the SDK force-stops the CLI at `timeoutMs + 30s`. At most `MAX_TIMEOUT_MS` (about 24.8 days, a Node.js timer limit); larger values throw `MCodeInvocationError` |
| `maxSteps`  | `--max-steps`                                                                                                                                                            |

- `run()` resolves only when the status is `succeeded`, with a `Turn` (`finalResponse`, normalized
  `items`, `usage`, `model`, `sessionId`, `turnId`, `durationMs` and the full `result`). Every other
  outcome rejects; see [Errors](#errors).
- `runStreamed()` yields the CLI events unchanged. `turn.failed` is an ordinary event; the iterator
  throws only for process or protocol failures. Breaking out of the loop cancels the Turn.
- A Thread runs one Turn at a time. A concurrent call throws `ThreadBusyError`; Turns are not queued.
- After breaking out of the iterator, or after a protocol error, the SDK sends the CLI a cancel
  signal. Until the process exits (about one second for a cooperating CLI, at most about 15 seconds:
  SIGINT → 10s → SIGTERM → 5s → SIGKILL), the Thread stays busy and further `run()` /
  `runStreamed()` calls throw `ThreadBusyError`. The `for await` loop you broke out of also waits
  for the process to exit.
- The prompt only travels over stdin, and system prompts through temporary files (mode `0600`).
  The files are removed before `run()` settles and before a `runStreamed()` iterator ends. argv
  contains only SDK-generated flags, identifiers and paths.

### Events and items

Event types match the CLI: `exec.started`, `session.started` / `session.resumed`, `turn.started`,
`item.started` / `item.updated` / `item.completed`, `turn.completed`, `turn.failed` and
`exec.completed`. Every stdout line must be JSON with `schemaVersion === 1`; anything else is a
protocol error.

`Turn.items` are SDK-normalized items (`agent_message`, `reasoning`, `tool_call`):

- Items are merged by `item.id` without assuming any order (events of different items interleave);
  the list is in order of first appearance.
- While streaming, an `item.updated` identical to the previous snapshot of the same item is dropped.
  This applies to snapshots only, never to text deltas (`contentDelta`).
- Items without an `item.completed` when the Turn ends are marked `incomplete: true` (for example,
  a tool that was running when the Turn was cancelled).
- `tool_call.toolCall` is an `@experimental` `RawToolCall`: `status` is an internal numeric enum and
  `input` / `output` are tool-specific structures. Neither is covered by the compatibility promise.

`usage.totalTokens = inputTokens + outputTokens` and **excludes** `cacheReadTokens` /
`cacheWriteTokens`; `reasoningTokens` may overlap `outputTokens`.

## Errors

Every error extends `MCodeError` and carries `exitCode`, `signal` and the last 64 KiB of the CLI
stderr (`stderr`, for diagnostics only).

| Source                                                     | Error                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Exit 2, or an option the SDK rejects                       | `MCodeInvocationError`                                             |
| Status `failed` (exit 3 / 4 / 70)                          | `MCodeRunError` with `category` `config` / `runtime` / `internal`  |
| Status `timeout` (exit 6) or the SDK timeout backstop      | `MCodeRunError` with `status === 'timeout'`                        |
| Status `limit_exceeded` (exit 7)                           | `MCodeRunError` with `status === 'limit_exceeded'`                 |
| Status `cancelled` (exit 130) or SDK cancellation          | `MCodeAbortError` with `name === 'AbortError'`                     |
| Exit 141, non-JSON stdout, or exit without `exec.completed` | `MCodeProtocolError`                                              |
| No CLI found                                               | `MCodeNotFoundError` (includes the install command)                |
| CLI too old, or an unsupported event `schemaVersion`       | `MCodeVersionError`                                                |
| Concurrent Turn on the same Thread                         | `ThreadBusyError`                                                  |

`MCodeRunError` carries `result` (the full `ExecResult` when `exec.completed` was received),
`items`, `retryable` (from `result.error.retryable`) and `sessionId`; `MCodeAbortError` also carries
`sessionId`. `sessionId` is set whenever the CLI emitted at least one event (or the Thread came from
`resumeThread`), even without `exec.completed`. The SDK never retries automatically, to avoid
replaying writes with unknown outcomes; call `resumeThread(error.sessionId)` to continue.

## Cancellation, timeouts and process cleanup

- When `signal` aborts, the SDK sends `SIGINT` and the CLI ends the Turn as `cancelled`. If the
  process has not exited after 10 seconds it receives `SIGTERM`, and `SIGKILL` 5 seconds later.
- `timeoutMs` is enforced by the CLI, which ends the run gracefully with status `timeout`; the SDK
  only force-stops it at `timeoutMs + 30s`.
- **Only normal host exits are covered**: when the host emits `exit` (the event loop drains or
  `process.exit()` is called), the SDK sends `SIGTERM` to any running CLI process, which the CLI
  treats as a cancel. A host killed by a signal such as `SIGTERM` or `SIGINT` does not emit `exit`,
  and its CLI processes keep running as orphans. The SDK installs no signal handlers and Phase 1 has
  no `close()` / `dispose()`. Hosts that need reliable cleanup should abort in-flight runs from their
  own signal handlers and wait for them, for example:

  ```ts
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  await thread.run(prompt, { signal: controller.signal }).catch(() => undefined);
  ```

- After the CLI exits, the SDK keeps reading stdout / stderr for at most about two seconds. If a
  grandchild process inherited and holds the pipes, the SDK closes them and settles the Turn from
  the events already received instead of waiting for the grandchild.
- An unconsumed `runStreamed()` stream still runs to completion and frees the Thread.

> [!WARNING]
>
> **Windows**: Node.js cannot send a catchable `SIGINT` to a child process on Windows, so
> cancellation is a hard kill and the runtime may leave the Turn unfinished. Phase 1 only supports
> the hard kill; graceful cancellation needs a signal-independent cancel channel in the CLI.

## Concurrency and data directories

Concurrent `exec` processes sharing one data directory have had limited testing. Prefer a separate
`dataDir` per SDK instance (or per concurrent task), with authentication configured in that
directory beforehand.

## Not available in Phase 1

- `outputSchema` (MiniMax-hosted models do not reliably follow the schema yet).
- Approval callbacks, steering a running Turn, continuing after an interrupt, and forking.
- A Python SDK.
