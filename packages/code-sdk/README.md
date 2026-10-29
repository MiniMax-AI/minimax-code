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
- No runtime dependencies. The package is ESM; its `exports` have `import` and `default`
  conditions and no separate CommonJS build. CommonJS callers can still `require()` it, because
  every Node.js version in the supported range loads ES modules through `require(esm)`.

## Installation and CLI resolution

The SDK does not hard-depend on the CLI, which is large and ships native dependencies.
`@minimax-ai/code` is an optional peer dependency:

```bash
npm install @minimax-ai/code-sdk
npm install @minimax-ai/code   # optional; a globally installed mcode works too
```

`@minimax-ai/code` runs install scripts for its native dependencies. npm 11 rejects
`--allow-scripts` for project-scoped installs (`EALLOWSCRIPTS`), so approve them in the project's
`package.json` before installing the CLI into the project:

```json
{
  "allowScripts": {
    "@minimax-ai/code": true,
    "better-sqlite3": true
  }
}
```

Other package managers that gate install scripts need the equivalent approval for the same two
packages.

The SDK looks for the CLI in this order:

1. The `bin` constructor option (an executable, a JS entry, or a command name on `PATH`).
2. An installed `@minimax-ai/code` resolved from the SDK's own location (where the optional peer
   dependency is installed). The SDK reads `bin.mcode` from that `package.json` and runs the JS
   entry with `process.execPath`.
3. `mcode` on `PATH`.

Set `resolveFromCwd: true` to also search the host's working directory, after the SDK-local package
and before `PATH`:

- `@minimax-ai/code` resolved from `process.cwd()/package.json`.
- The nearest `node_modules/.bin/mcode` (`mcode.cmd` / `mcode.ps1` on Windows) found walking up from
  `process.cwd()`. The SDK prefers the JS entry behind the symlink or npm/pnpm shim and runs it with
  `process.execPath`, so the CLI package name does not matter.

Leave `resolveFromCwd` off (the default) when the working directory may be untrusted, for example a
CI job checking out a pull request. A checkout can contain `node_modules/.bin/mcode`, and the SDK
would execute it with the host environment. Pass `bin`, or install the CLI next to the SDK or on
`PATH`, instead.

The SDK never starts the CLI through a shell. On Windows, `mcode.cmd` is followed to the JS entry it
runs, which the SDK then starts with `process.execPath`. Supported Windows installations:

- the official installer (`install.ps1`): `mcode.cmd` reads the `current` release pointer and calls
  `releases\<release>\.mcode-launcher.cmd`. The pointer is read again before every run, so a CLI
  self-update between Turns is picked up;
- npm and pnpm installs, global or project-local, through their generated `.cmd` / `.ps1` shims.

If a `.cmd` launcher is found but its JS entry cannot be determined, resolution fails with
`MCodeNotFoundError`; pass the CLI's JS entry as `bin`.

Before the first run, each `MCode` instance runs `mcode --version` once and caches the result. A
CLI older than `MIN_CLI_VERSION` (currently `0.6.3`) fails with `MCodeVersionError`. Only
`major.minor.patch` is compared, so `0.6.3-preview.N` satisfies `0.6.3`. `0.6.3` is the first CLI
release that includes every `mcode exec` flag the SDK passes (`--system-prompt-file`,
`--append-system-prompt-file` and `--mode` landed there; `stream-json` was already present). A
source build of this repository reports `0.6.5` and meets the minimum.

### Compatibility

| `@minimax-ai/code-sdk` | MiniMax Code CLI (`mcode`)    | Node.js                       | Event `schemaVersion` |
| ---------------------- | ----------------------------- | ----------------------------- | --------------------- |
| `0.1.x`                | `>=0.6.3` (`MIN_CLI_VERSION`) | `>=22.19 <23 \|\| >=24.2 <27` | `1`                   |

The SDK and the CLI are released separately. Upgrading the SDK does not require upgrading the CLI
as long as the CLI meets `MIN_CLI_VERSION`. If the CLI ever emits a new event `schemaVersion`,
upgrade to an SDK release that supports it. The Node.js range matches the CLI's.

## Quick start

```ts
import { MCode } from "@minimax-ai/code-sdk";

const mcode = new MCode({ dataDir: "/srv/mcode-data" });
const thread = mcode.startThread({
  cwd: "/path/to/repo",
  model: "minimax/MiniMax-M3",
  permission: "smart",
});

const turn = await thread.run("Diagnose and fix the failing CI job", {
  files: ["./ci.log"],
  timeoutMs: 10 * 60_000,
});
console.log(thread.id, turn.finalResponse, turn.usage);

// Continue the same Thread
await thread.run("Add unit tests for the fix");

// Resume an earlier Session
const resumed = mcode.resumeThread("mvs_xxx", { cwd: "/path/to/repo" });
await resumed.run("Continue where you left off");
```

Streaming:

```ts
const { events } = await thread.runStreamed("Implement the plan");
for await (const event of events) {
  switch (event.type) {
    case "item.completed":
      console.log(event.item);
      break;
    case "turn.failed":
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

| Option           | Description                                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin`            | Explicit `mcode` path or command name; skips package and `PATH` lookup                                                                                                          |
| `resolveFromCwd` | Also search `process.cwd()` for `@minimax-ai/code` and for `node_modules/.bin/mcode` in parent directories. Default `false`. See [CLI resolution](#installation-and-cli-resolution) |
| `dataDir`        | Data directory, passed to the CLI as the `MINIMAX_DATA_DIR` environment variable                                                                                                |
| `env`            | Child process environment. **Replaces** `process.env` when set (no merge); defaults to `process.env`                                                                            |
| `configPath`     | Runtime config file, passed as `--config`                                                                                                                                        |

`env` replaces the environment entirely: passing only custom variables drops `PATH`, `HOME` and so
on, so the CLI may fail to find Node.js or tools, or to read its credentials. To add variables,
spread `process.env`:

```ts
const mcode = new MCode({ env: { ...process.env, FOO: "bar" } });
```

### `startThread(options?)` / `resumeThread(id, options?)`

Thread options are passed to the CLI on every Turn of the Thread:

| Option               | CLI flag                                                                        |
| -------------------- | ------------------------------------------------------------------------------- |
| `cwd`                | `--cwd` (defaults to the host process working directory)                        |
| `model` / `effort`   | `--model` / `--effort`                                                          |
| `permission`         | `--permission`: `smart` / `full` / `off`                                        |
| `mode`               | `--mode`: `standard` / `lightweight`, only on the Turn that creates the Session |
| `promptMode`         | `--prompt-mode`: `tui` / `coding` / `work`                                      |
| `systemPrompt`       | `--system-prompt-file` (the SDK writes a temporary file)                        |
| `appendSystemPrompt` | `--append-system-prompt-file` (the SDK writes a temporary file)                 |

- `mode: 'lightweight'` is only valid for a new Thread; passing it to `resumeThread` throws
  `MCodeInvocationError` immediately.
- There is no `ask` permission: headless runs cannot ask for approval. MiniMax Code's
  `smart` / `full` / `off` policies are not equivalent to Codex's OS-level sandbox modes, and the
  SDK does not map between them.
- `thread.id` becomes available once the first Turn emits its first event, even if that Turn fails.

### `thread.run(input, options?)` / `thread.runStreamed(input, options?)`

| Option      | Description                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files`     | Attachments, `--file` (repeatable); relative paths resolve against `cwd`                                                                                                                                |
| `signal`    | `AbortSignal`; see [Cancellation](#cancellation-timeouts-and-process-cleanup)                                                                                                                           |
| `timeoutMs` | Passed to the CLI as `--timeout <n>ms`; the SDK force-stops the CLI at `timeoutMs + 90s` (60s CLI shutdown plus 30s startup slack). At most `MAX_TIMEOUT_MS` (about 24.8 days, a Node.js timer limit); larger values throw `MCodeInvocationError` |
| `maxSteps`  | `--max-steps`                                                                                                                                                                                           |

- `run()` resolves only when the status is `succeeded`, with a `Turn` (`finalResponse`, normalized
  `items`, `usage`, `model`, `sessionId`, `turnId`, `durationMs` and the full `result`). Every other
  outcome rejects; see [Errors](#errors).
- `runStreamed()` yields the CLI events unchanged. `turn.failed` is an ordinary event; the iterator
  throws only for process or protocol failures. Breaking out of the loop cancels the Turn.
- A Thread runs one Turn at a time. A concurrent call throws `ThreadBusyError`; Turns are not queued.
- After breaking out of the iterator, or after a protocol error, the SDK sends the CLI a cancel
  signal. Until the process exits (about one second for a cooperating CLI, at most the CLI's 60
  second shutdown budget: SIGTERM, then SIGKILL), the Thread stays busy and further `run()` /
  `runStreamed()` calls throw `ThreadBusyError`. The `for await` loop you broke out of also waits
  for the process to exit.
- The prompt only travels over stdin, and system prompts through temporary files (mode `0600`).
  The files are removed before `run()` settles and before a `runStreamed()` iterator ends. If the
  host calls `process.exit()` during a Turn, the SDK's `exit` hook deletes those directories with
  `rmSync`. argv contains only SDK-generated flags, identifiers and paths.

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
- `tool_call.toolCall` is an `@experimental` `RawToolCall`: `status` is `string | number` (often an
  internal numeric enum) and `input` / `output` are tool-specific structures. Neither is covered by
  the compatibility promise.

`usage.totalTokens = inputTokens + outputTokens` and **excludes** `cacheReadTokens` /
`cacheWriteTokens`; `reasoningTokens` may overlap `outputTokens`.

## Errors

Every error extends `MCodeError` and carries `exitCode`, `signal` and the last 64 KiB of the CLI
stderr (`stderr`, for diagnostics only).

When the CLI emits `exec.completed`, its `result.status` decides the error:

| `result.status`  | Error                                                                               |
| ---------------- | ----------------------------------------------------------------------------------- |
| `failed`         | `MCodeRunError` with `category` from the result (`config` / `runtime` / `internal`) |
| `timeout`        | `MCodeRunError` with `status === 'timeout'`                                         |
| `limit_exceeded` | `MCodeRunError` with `status === 'limit_exceeded'`                                  |
| `cancelled`      | `MCodeAbortError` with `name === 'AbortError'`                                      |

When the CLI exits without `exec.completed`, the exit code decides:

| Exit code                              | Error                                                       |
| -------------------------------------- | ----------------------------------------------------------- |
| `2` (invalid invocation)               | `MCodeInvocationError`                                      |
| `3`                                    | `MCodeRunError`, `status: 'failed'`, `category: 'config'`   |
| `4`                                    | `MCodeRunError`, `status: 'failed'`, `category: 'runtime'`  |
| `6`                                    | `MCodeRunError`, `status: 'timeout'`                        |
| `7`                                    | `MCodeRunError`, `status: 'limit_exceeded'`                 |
| `70`                                   | `MCodeRunError`, `status: 'failed'`, `category: 'internal'` |
| `130`                                  | `MCodeAbortError`                                           |
| `141` (broken pipe)                    | `MCodeProtocolError`                                        |
| `0` (success without a result)         | `MCodeProtocolError`                                        |
| Any other code (e.g. `1`), or a signal | `MCodeRunError`, `status: 'failed'`, `category: 'internal'` |

If the SDK itself cancelled the run (`signal`, or breaking out of `runStreamed()`), a missing
result is reported as `MCodeAbortError` unless the CLI exited with `2`. If the SDK force-stopped the
CLI after `timeoutMs + 90s`, it is `MCodeRunError` with `status === 'timeout'`.

Errors raised by the SDK itself:

| Source                                                                                                                | Error                  |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| An option the SDK rejects before starting the CLI                                                                     | `MCodeInvocationError` |
| Non-JSON stdout or an event missing required fields                                                                   | `MCodeProtocolError`   |
| No CLI found (includes the install command), or a found launcher whose JS entry cannot be determined (asks for `bin`) | `MCodeNotFoundError`   |
| CLI older than `MIN_CLI_VERSION`, or an unsupported event `schemaVersion`                                             | `MCodeVersionError`    |
| Concurrent Turn on the same Thread                                                                                    | `ThreadBusyError`      |

`MCodeRunError` carries `result` (the full `ExecResult` when `exec.completed` was received),
`items`, `retryable` (from `result.error.retryable`) and `sessionId`; `MCodeAbortError` also carries
`sessionId`. `sessionId` is set whenever the CLI emitted at least one event (or the Thread came from
`resumeThread`), even without `exec.completed`. The SDK never retries automatically, to avoid
replaying writes with unknown outcomes; call `resumeThread(error.sessionId)` to continue.

## Cancellation, timeouts and process cleanup

- When `signal` aborts, the SDK sends `SIGTERM`. The CLI treats `SIGTERM` the same way as `SIGINT`:
  it cancels the Turn, shuts the runtime down (budget 60 seconds), then writes `exec.completed`
  with status `cancelled`. If the process is still running after that budget, the SDK sends
  `SIGKILL`. It does not send `SIGINT`.
- **Ctrl+C.** The CLI stays in the host's process group, so Ctrl+C delivers `SIGINT` to the host and
  the CLI together. That `SIGINT` already starts the CLI's cancel path and consumes its one-shot
  `SIGINT` handler. If the host also aborts the `AbortSignal` from its own `SIGINT` handler, the
  SDK follows with `SIGTERM`, which the CLI still handles as a cancel (`SIGTERM` is a separate
  handler). A second `SIGINT` would take the default action and kill the CLI before it writes
  `exec.completed`. The README example below aborts on `SIGTERM`, which does not collide with
  Ctrl+C.
- `timeoutMs` is enforced by the CLI. The CLI starts that timer after its access check, session
  resolution and model selection, then ends the run with status `timeout` and may spend the same 60
  second shutdown budget before writing the result. The SDK's timer starts at spawn and force-stops
  the process at `timeoutMs + 90s` (60s shutdown plus 30s of startup slack).
- **Only normal host exits are covered**: when the host emits `exit` (the event loop drains or
  `process.exit()` is called), the SDK sends `SIGTERM` to any running CLI process, which the CLI
  treats as a cancel, and deletes temporary prompt directories with `rmSync`. A host killed by a
  signal such as `SIGTERM` or `SIGINT` does not emit `exit`, and its CLI processes keep running as
  orphans. The SDK installs no signal handlers and Phase 1 has no `close()` / `dispose()`. Hosts
  that need reliable cleanup should abort in-flight runs from their own signal handlers and wait
  for them, for example:

  ```ts
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  await thread
    .run(prompt, { signal: controller.signal })
    .catch(() => undefined);
  ```

- After the CLI exits, the SDK keeps reading stdout / stderr for at most about two seconds. If a
  grandchild process inherited and holds the pipes, the SDK closes them and settles the Turn from
  the events already received instead of waiting for the grandchild.
- An unconsumed `runStreamed()` stream still runs to completion and frees the Thread.

> [!WARNING]
>
> **Windows**: Node.js cannot deliver a catchable signal to a child process, so `SIGTERM` is a hard
> kill and the runtime may leave the Turn unfinished. Phase 1 only supports the hard kill; graceful
> cancellation needs a signal-independent cancel channel in the CLI.

## Concurrency and data directories

Concurrent `exec` processes sharing one data directory have had limited testing. Prefer a separate
`dataDir` per SDK instance (or per concurrent task), with authentication configured in that
directory beforehand.

## Not available in Phase 1

- `outputSchema` (MiniMax-hosted models do not reliably follow the schema yet).
- Approval callbacks, steering a running Turn, continuing after an interrupt, and forking.
- A Python SDK.

## 中文

SDK 在 Node.js 里驱动本机 MiniMax Code（`mcode`）。下面只覆盖本次行为；完整说明见上文英文。

### CLI 查找

默认顺序：

1. 构造参数 `bin`（可执行文件、JS 入口，或 `PATH` 上的命令名）。
2. 安装在 SDK 旁边的 `@minimax-ai/code`（可选 peer dependency）。SDK 读取其 `bin.mcode`，并用 `process.execPath` 运行该 JS 入口。
3. `PATH` 上的 `mcode`。

`resolveFromCwd` 默认为 `false`。设为 `true` 后，还会在 SDK 本地安装之后、`PATH` 之前搜索宿主的工作目录：先从 `process.cwd()/package.json` 解析 `@minimax-ai/code`，再从 `process.cwd()` 向上查找最近的 `node_modules/.bin/mcode`（Windows 上为 `mcode.cmd` / `mcode.ps1`）。工作目录不可信时（例如 CI 检出的拉取请求）请保持关闭：检出内容可以自带 `node_modules/.bin/mcode`，SDK 会带着宿主环境执行它。此时应传入 `bin`，或把 CLI 装在 SDK 旁边 / `PATH` 上。

SDK 从不通过 shell 启动 CLI。要求的最低 CLI 版本是 `0.6.3`（`MIN_CLI_VERSION`）：该版本起具备 SDK 传入的全部 `mcode exec` 参数。本仓库源码构建的 CLI 是 `0.6.5`，满足该下限。只比较 `major.minor.patch`，因此 `0.6.3-preview.N` 视为满足 `0.6.3`。

### 取消、超时和退出

- `AbortSignal` 中止时，SDK 发送 `SIGTERM`。CLI 把 `SIGTERM` 与 `SIGINT` 同样视为取消：结束本轮、在 60 秒运行时关闭预算内收尾，然后写出 `exec.completed`（`cancelled`）。超过该预算进程仍在，SDK 才发送 `SIGKILL`。SDK 不发送 `SIGINT`。
- 终端里的 Ctrl+C 会把 `SIGINT` 发给整个进程组，CLI 自己的一次性 `SIGINT` 处理函数会被用掉。若宿主也因此中止 `AbortSignal`，SDK 随后发送的 `SIGTERM` 仍走 CLI 的取消路径。再发一次 `SIGINT` 会直接杀死 CLI，来不及写出 `exec.completed`。
- `timeoutMs` 由 CLI 在访问检查、会话解析和模型选择之后开始计时。SDK 从进程启动起计时，在 `timeoutMs + 90s`（60 秒关闭预算加 30 秒启动余量）时强制结束。
- 宿主正常退出（事件循环排空或调用 `process.exit()`）时，SDK 向仍在运行的 CLI 发送 `SIGTERM`，并用 `rmSync` 删除临时 system prompt 目录。宿主被 `SIGTERM` / `SIGINT` 杀死时不会发出 `exit`，子进程会留下。Windows 上 `SIGTERM` 是硬终止，无法优雅取消。

### 发布

`@minimax-ai/code-sdk` 是本仓库里第一个非 `private` 的工作区包。不要在包目录里直接 `npm publish`：`prepublishOnly` 会拒绝。在最新的 `main` 上运行 `pnpm --filter @minimax-ai/code-sdk run release:check`，再发布它打印出的、已经检查过的 tarball。见 `RELEASING.md`。
