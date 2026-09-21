# MiniMax local changes for pi-mono

This directory vendors `pi-mono` as source so MiniMax can patch, validate, and ship agent-loop fixes without waiting on upstream release cadence.

## Import baseline

- Upstream: `https://github.com/earendil-works/pi-mono.git`
- Ref: `refs/tags/v0.79.1`
- Commit: `28df940f0d07b65284849a483be7b06e2ca046ee`
- Imported at: 2026-06-16

## Local patch ledger

No upstream source files are changed in the baseline import.

### 2026-09-19 — preserve the system role for Mistral Chat Completions

- Reason: thinking-enabled custom OpenAI-compatible connections to `api.mistral.ai` emitted `developer`, which is absent from the [Mistral Chat Completions message contract](https://docs.mistral.ai/api/endpoint/chat). [OpenClaw's compatibility defaults](https://github.com/openclaw/openclaw/blob/e2bcb1614de060927121bd72de850cee3a08d308/packages/ai/src/transports/openai-completions-compat.ts#L184-L210) also disable this role for the Mistral public endpoint.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), OpenAI Completions compatibility detection.
- Change: default to `system` only on the exact Mistral API host. Preserve thinking, explicit compatibility overrides, all other request options, and other endpoints. Native Mistral transport is unchanged.
- Upstream PR: not opened.
- Validation: outgoing-payload regressions in `packages/local-runtime-v2/src/service/model-system/resolution/local-model-resolver.test.ts`; the endpoint regression fails before the fix. No live Mistral requests or full CLI acceptance were performed; the decision is based on the official contract and current upstream implementation.

### 2026-09-19 — preserve the system role for SiliconFlow

- Reason: thinking-enabled OpenAI-compatible requests sent the `developer` role, which is absent from SiliconFlow's documented message schema.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), OpenAI Completions compatibility detection.
- Change: default to the `system` role on the exact `api.siliconflow.cn` and `api.siliconflow.com` hosts. Preserve thinking, explicit compatibility overrides, other request options, and other endpoints.
- References: [official Chat Completions schema](https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions) and [pi's SiliconFlow provider proposal](https://github.com/earendil-works/pi/pull/8113) (closed without merging).
- Upstream PR: not opened.
- Validation: outgoing-payload regressions in `packages/local-runtime-v2/src/service/model-system/resolution/local-model-resolver.test.ts`, including both official hosts, unrelated hosts, and explicit compatibility overrides.

### 2026-09-19 — preserve the system role for DashScope

- Reason: DashScope endpoints were treated as supporting the `developer` role, causing thinking-enabled OpenAI-compatible conversations to send an unsupported system-prompt role.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), OpenAI Completions compatibility detection.
- Change: default to the `system` role for official DashScope regional and Coding Plan hosts, plus workspace, trial, and Token Plan hosts under the documented regional `maas.aliyuncs.com` domains. Preserve thinking, other request options, explicit compatibility overrides, and other providers.
- References: [official endpoint list](https://help.aliyun.com/en/model-studio/base-url), [Coding Plan role rejection](https://github.com/openclaw/openclaw/issues/23575), [Token Plan role rejection](https://github.com/earendil-works/pi/issues/7723), and [merged OpenClaw DashScope fix](https://github.com/openclaw/openclaw/pull/24675).
- Upstream PR: not opened.
- Validation: request-payload regressions in `packages/local-runtime-v2/src/service/model-system/resolution/local-model-resolver.test.ts`, including official endpoints, unrelated hosts, and explicit compatibility overrides.

### 2026-09-19 — preserve the system role for Kimi Coding

- Reason: Kimi Coding endpoints were treated as supporting the `developer` role, causing thinking-enabled OpenAI-compatible conversations to send an unsupported system-prompt role.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), OpenAI Completions compatibility detection.
- Change: default to the `system` role for `api.kimi.com` and `api.kimi.ai`. Preserve thinking, other request options, explicit compatibility overrides, and other providers.
- Upstream PR: not opened.
- Validation: offline request-payload regressions in `packages/local-runtime-v2/src/service/model-system/resolution/local-model-resolver.test.ts`. Live Kimi Coding validation requires a Coding Plan key and remains untested.

### 2026-08-31 — Windows PowerShell ConstrainedLanguage compatibility

- Reason: the Windows PowerShell 5.1 stdin wrapper called `Parser.ParseInput`, `ScriptBlock.Create`, and other restricted .NET APIs before user commands. Under enterprise App Control / AppLocker `ConstrainedLanguage`, the wrapper therefore failed before commands such as Python could run.
- Affected package: local Bash / PowerShell execution backend and focused regressions in `packages/coding-agent` (`@earendil-works/pi-coding-agent`).
- Change type: generic, upstreamable PowerShell compatibility fix. Probe and cache `LanguageMode` on first execution per PowerShell executable. `FullLanguage` retains UTF-8, `#requires`, and the full script-block path. `ConstrainedLanguage` transfers the original command through a one-use Unicode environment variable, removes it from the child environment, then uses `Invoke-Expression` within the same restricted language mode, without restricted .NET APIs.
- Upstream PR: not created.
- Validation in the source monorepo: `cd third_party/pi-mono/packages/coding-agent && node ../../../../node_modules/vitest/dist/cli.js --run test/graceful-terminate.test.ts` covers preserved `FullLanguage` behavior and restricted-API avoidance, long commands, and Chinese command transport in `ConstrainedLanguage`; `pnpm --filter @earendil-works/pi-coding-agent... build` validates the affected vendor build; `node scripts/test/focused-vitest.mjs --package @mavis/local-runtime packages/local-runtime/test/unit/local-background-bash-runner.test.ts packages/local-runtime/test/unit/local-background-bash-executor.test.ts` checks runtime consumers. Real Windows App Control / AppLocker acceptance remains external.

### 2026-08-27 — omit explicit thinking for Claude default-thinking models

- Reason: Claude Opus 5, Sonnet 5, Fable 5, Mythos 5, and Mythos Preview enable thinking by default. Custom Anthropic-compatible models must preserve `output_config.effort` without falling back to legacy `thinking.type=enabled` plus `budget_tokens`.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`).
- Change type: Anthropic request adaptation plus one exported model-family matcher shared by both local runtimes. The matcher ignores only an exact trailing `[1m]` for thinking classification; BYOK context configuration and the wire model ID remain untouched.
- Host boundary: the Anthropic adapter classifies the final model ID itself and suppresses only the active-thinking field. Explicit disabled-thinking behavior remains controlled by the caller and the upstream model's supported configuration.
- Upstream PR: not opened.
- Validation: focused Anthropic provider tests and package build, plus local-runtime v1/v2 resolver, connection, payload, and subagent regression suites.

### 2026-08-26 — allow slower Codex SSE response headers

- Reason: Desktop injects a host fetch implementation for Codex, which selects the SSE transport. The provider aborted requests when response headers took more than 10 seconds, interrupting otherwise healthy long-running tasks during transient upstream latency.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), Codex Responses SSE transport and focused regression coverage.
- Change type: generic upstreamable transport fix. Increase the response-header deadline to 30 seconds while preserving caller cancellation and the existing body-read timeout behavior.
- Upstream PR: not opened.
- Validation: focused `packages/ai/test/openai-codex-stream.test.ts` (28 passed); downstream shared (178 passed), Agent Core (151 passed), and Cloud Runtime (10 passed) error-classification tests; targeted Biome, pinned-dependency, TypeScript-import, and browser-smoke checks passed. Full vendored `npm run check` remains blocked by the ignored canonical `package-lock.json` input and existing unrelated test type errors; `pnpm check:pi-vendor-resolution` remains blocked by the existing Local Runtime V2 Pi dependency allow-list drift.

### 2026-08-22 — retain exact built-in Bash and Read execution facts

- Reason: post-execution integrations cannot safely reconstruct separate stdout/stderr or an explicit-limit file page from Pi's decorated, model-facing text. Preserve those facts while the built-in tools still own them so downstream consumers can adapt protocols without parsing truncation and continuation notices.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), built-in Bash and Read result details.
- Change type: generic upstreamable result metadata. Local Bash backends may declare exact split-stream callbacks; Read records its resolved path, undecorated returned page, line range, total lines, and automatic output-cap signal.
- Upstream PR: not opened.
- Validation: focused `packages/coding-agent/test/tools.test.ts`; downstream `@mavis/agent-tools` Desktop Bash/Read and Local Runtime v2 vendor PostToolUse tests.

### 2026-08-22 — agent: graceful stop after steering admission

- Reason: a queued `UserPromptSubmit` Plugin Hook can return `continue: false` after the ordinary `turn_end` stop check. Added a dedicated post-steering admission seam so the active run emits `agent_end` without issuing another provider request or reporting a failed turn.
- Affected package: `packages/agent` (`@earendil-works/pi-agent-core`).
- Change type: MiniMax-specific host glue.
- Upstream PR: not opened.
- Validation: focused agent-loop and local/cloud Plugin Hook tests listed in MR validation.

### 2026-08-22 — expose explicit whole-agent termination from tool hooks

- Reason: host lifecycle hooks need a protocol-level stop to end the active agent after a before/after-tool decision. The existing tool-result `terminate` hint intentionally stops only when every result in a batch opts in, so it cannot represent a global Hook decision in a mixed parallel batch.
- Affected package: `packages/agent` (`@earendil-works/pi-agent-core`), tool-hook result contracts and agent-loop batch termination.
- Change type: generic upstreamable control seam. Add optional `terminateAgent` to before/after-tool results. Sequential execution stops immediately after publishing the current call result; parallel preflight stops admitting later calls. Calls that never execute receive synthetic error ToolResults so provider history remains fully paired. An already-started parallel batch stops after publishing that batch. The existing every-result `terminate` behavior remains unchanged.
- Upstream PR: not opened.
- Validation: focused `packages/agent/test/agent-loop.test.ts`; downstream `@mavis/agent-core` and Local Runtime v2 Hook tests.

### 2026-08-22 — expose the admitted tool execution boundary

- Reason: Claude-compatible `PostToolUse.duration_ms` measures tool execution only and excludes PreToolUse and permission latency. The existing `tool_execution_start` event intentionally fires before admission, so it cannot provide that timestamp.
- Affected package: `packages/agent` (`@earendil-works/pi-agent-core`), loop config and Agent forwarding.
- Change type: generic upstreamable lifecycle seam. Add a synchronous `onToolExecutionStart` observation after argument validation and all before-tool admission succeeds, immediately before `tool.execute`; blocked calls never fire it.
- Upstream PR: not opened.
- Validation: focused `packages/agent/test/agent-loop.test.ts`; downstream Cloud root/child Plugin Hook timing tests.

### 2026-08-18 — expose parsed provider stream events to host observability

- Reason: the development-only LLM Context Inspector needs the final provider-native response shape without cloning/teeing HTTP response bodies or persisting Pi's semantic `AssistantMessage` projection.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), the shared stream option plus Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, and Codex Responses parsed-event loops.
- Change type: generic upstreamable observability seam. The optional callback is synchronous and exception-isolated; when absent, providers iterate their original stream directly with no added per-event work.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-ai build`; focused provider-observer and Local Runtime Inspector tests.

### 2026-08-18 — route initial Codex OAuth exchange through host fetch

- Reason: the existing OAuth fetch injection covered model requests and token refresh, while the browser-login authorization-code exchange still used Node's global fetch. Electron hosts with Chromium proxy, PAC, or enterprise certificate handling could therefore show a successful browser callback and fail before credentials were persisted.
- Affected packages: `packages/ai` (`@earendil-works/pi-ai`), `packages/coding-agent` (`@earendil-works/pi-coding-agent`), `packages/local-runtime` (legacy Codex OAuth owner removed), and `packages/local-runtime-v2` (sole Runtime OAuth owner).
- Change type: generic upstreamable OAuth transport behavior plus Runtime ownership cleanup. Thread the host fetch implementation through login callbacks and use it for Codex browser and device-code login requests; keep the global fetch as the fallback for standalone callers. Remove the legacy V1 Codex OAuth manager and route so Runtime V2 is the only login owner.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-ai exec vitest --run test/openai-codex-oauth.test.ts` (10 passed); `pnpm --filter @earendil-works/pi-coding-agent exec vitest --run test/auth-storage-fetch.test.ts` (1 passed); local-runtime-v2 Codex OAuth focused test (17 passed); local-runtime-v2 typecheck; Pi AI, TUI, Agent, and Coding Agent builds.

### 2026-08-15 — return already-safe images when Photon is unavailable

- Reason: Pi had already read the original image bytes before attempting Photon, but a missing image processor always produced a text-only omission. The Local Runtime workaround had to parse that user-visible English text and reread the file, which could misclassify ordinary text and duplicated Pi's image limits.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), specifically the image resize boundary and its PNG, JPEG, GIF, and WebP header checks.
- Change type: generic upstreamable image-processing behavior. When Photon cannot load, return the original image only if header dimensions and encoded size already satisfy the caller's limits; continue throwing `ImageProcessorUnavailableError` when resizing, recompression, or full decoding is required. This benefits the read tool and CLI image attachment path without host-specific result parsing.
- Upstream PR: not opened.
- Validation: Pi missing-processor regression 8/8; complete coding-agent Vitest 140 files / 1,434 tests with the standalone copy-assets tests 2/2; coding-agent build; downstream agent-tools 70 files / 881 tests plus typecheck/build; Local Runtime read E2E; and a self-contained darwin-arm64 MCode pack smoke that removes both packaged Photon WASM copies before verifying safe-image passthrough and oversized-image rejection.

### 2026-08-14 — declare CancellableLoader constructor callback types at the source

- Reason: the vendored `CancellableLoader` omitted an explicit constructor declaration, so the emitted declaration exposed untyped callback parameters to strict workspace typechecking. `BorderedLoader` passed the two theme callbacks contextually and was rejected for implicit `any` parameters.
- Affected package: `packages/tui` (`@earendil-works/pi-tui`), `CancellableLoader` component.
- Change type: generic upstreamable type-safety fix. Declare `CancellableLoader` constructor parameters explicitly (`TUI`, `(str: string) => string` color callbacks, optional message and indicator options) and forward them to the `Loader` superclass; runtime behavior is unchanged. The caller-side `string` annotations are not needed, keeping the vendored `packages/coding-agent` source at its imported baseline.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-tui build`; `pnpm --filter @earendil-works/pi-coding-agent build`; downstream `@mavis/cli` typecheck.

### 2026-08-12 — keep local image reads available in bundled MCode

- Reason: the source workspace could decode and resize local images, but the registry TUI bundle omitted Photon WASM and executed bundled CommonJS compatibility code without `__dirname`. As a result, `@image` could reach the read tool while returning text-only metadata instead of an image block; the loader also collapsed a missing processor into the same result as an image that exceeded the inline size limit.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), specifically the Photon loader, image-resize boundary, read tool, CLI file processor, and focused caller regressions.
- Change type: generic upstreamable image-processing behavior. Resolve Photon relative to the executing module and expose a typed processor-unavailable failure while preserving the existing null result for genuine resize-limit failures. MiniMax host packaging separately copies the WASM asset and provides the compatibility globals required by the ESM bundle; desktop/TUI adapters separately promote selected `@image` files to structured attachments and label terminal reads as `Read Image`.
- Upstream PR: not opened.
- Validation: coding-agent focused Vitest 4/4 and build; downstream UI focused Vitest 115 passed / 1 skipped and typecheck; downstream TUI focused Vitest 116/116 and typecheck; npm bundle profile tests 16/16; `pnpm release:mcode:test:dry-run`, including isolated tarball install, real read-tool image delivery, missing-processor classification, and uninstall smoke. `pnpm check:pi-vendor-resolution` remains blocked by the unchanged `packages/local-runtime-v2` Pi dependency allow-list drift already present on `origin/preview_train`.

### 2026-08-10 — use BEL-terminated OSC 8 hyperlinks for macOS hit testing

- Reason: macOS Terminal could display a long OSC 8 hyperlink while restricting full `Command-click` hit testing to only part of the wrapped link when the sequence used ST (`ESC \\`) terminators. BEL termination is recognized consistently, and the existing wrapping logic closes/reopens the active hyperlink on every physical line.
- Affected package: `packages/tui` (`@earendil-works/pi-tui`), `hyperlink()` output in `src/terminal-image.ts` plus regression coverage in `test/terminal-image.test.ts` and `test/wrap-ansi.test.ts`.
- Change type: generic upstreamable TUI behavior fix. No MiniMax-specific runtime dependency or adapter workaround is introduced.
- Upstream PR: not opened.
- Validation: `node --test --import tsx third_party/pi-mono/packages/tui/test/terminal-image.test.ts third_party/pi-mono/packages/tui/test/wrap-ansi.test.ts`; `pnpm --filter @earendil-works/pi-tui build`; local `@minimax/code` focused Markdown/foundation tests and build.

MiniMax integration files added in this spike:

- `.minimax-vendor.json` records the upstream source and local ownership metadata.
- `MINIMAX_CHANGES.md` tracks MiniMax-only changes and upstreaming status.
- `../AGENTS.md` defines the MiniMax vendored-code workflow for hotfixes, validation, and upstream sync.

### 2026-08-11 — copy coding-agent runtime assets without nested shell binaries

- Reason: Windows Electron builds run the coding-agent build through pnpm, then enter `npm run copy-assets`. The nested npm script can lose pnpm's package-local `.bin` path, so `shx` is not found even though the preceding `shx chmod` succeeds.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), build-time asset copying only.
- Change type: generic upstream material. Replace the `shx` glob/copy pipeline with a Node.js script that preserves the same JSON, PNG, HTML, CSS, and JavaScript asset set on every platform.
- Upstream PR: not opened.
- Validation: `node --test scripts/copy-assets.test.mjs`; `pnpm --filter @earendil-works/pi-coding-agent build`; downstream Electron build remains covered by the Windows Jenkins job.

### 2026-08-08 — Raw provider error observation for hosts

- Reason: providers converted original SDK exceptions to `errorMessage` inside `catch`, leaving hosts with generic text such as `Connection error.` and no access to `cause`, DNS codes, HTTP status, or SDK-specific fields.
- Affected package: generic `StreamOptions`, built-in text providers, and the faux provider in `packages/ai` (`@earendil-works/pi-ai`).
- Change type: generic, upstreamable capability. Add synchronous `onProviderError(error, model)` before error formatting. Providers isolate callback exceptions so they cannot replace the original result. Serialization, encryption, and network reporting remain host-owned; third-party code does not depend on the MiniMax runtime.
- Upstream PR: not created.
- Validation: `pnpm --filter @earendil-works/pi-ai exec vitest --run test/openai-completions-retry.test.ts --reporter=dot`; `pnpm --filter @earendil-works/pi-ai build`; focused tests and builds for downstream agent-core and local-runtime.

### 2026-08-04 — update packaged CLI network and glob dependencies

- Reason: the MCode production tarball included `undici 8.3.0` advisories affecting TLS proxying, WebSocket fragmentation, cache parsing, response synchronization, header/cookie handling, and process stability. Its `minimatch 10.2.5` closure also resolved a vulnerable `brace-expansion` release with an unbounded-expansion OOM path.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), dependency metadata only.
- Change type: generic dependency maintenance. Pin `undici 8.10.0` and `minimatch 10.2.6`; no MiniMax product logic is added to the vendored source.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-coding-agent build`; published `npm-shrinkwrap.json` audit 0 vulnerabilities; MCode Unit + coverage 113 files / 1125 tests; compiled CLI 26/26; embedded Runtime 4/4; PTY 16/16; release contracts 73/73; Agent Tools 686/686; MCP module 14/14; fresh MCode tarball `npm audit --omit=dev` 0 vulnerabilities and offline install smoke PASS.

### 2026-07-31 — preserve signature-only Anthropic thinking blocks

- Reason: Anthropic can return a valid thinking signature with an empty thinking string. The v0.79.1 serializer skipped every empty thinking block before checking its signature, so replay dropped the signed block and could make a later Anthropic request fail signature validation or lose the model's protected reasoning continuity.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), Anthropic Messages history serialization only.
- Change type: selective generic upstream material from `6731a0ba9e499d71916dd69200c05dfcbc0fa3e6` / [upstream PR #6457](https://github.com/earendil-works/pi-mono/pull/6457). Adapt the predicate to the vendored v0.79.1 `src/providers/anthropic.ts` path without migrating later Pi package structure, versions, lockfile, or `.minimax-vendor.json` baseline.
- Upstream PR: already merged as #6457; no additional upstream PR needed.
- Validation: `pnpm --filter @earendil-works/pi-ai test` (349 passed, 727 skipped); `pnpm --filter @mavis/agent-core exec vitest run --config vitest.config.ts test/unit/pi-ai-thinking-tiered.test.ts --reporter verbose` (18 passed); `pnpm --filter @earendil-works/pi-ai build`; `pnpm check:pi-vendor-resolution`.

### 2026-07-29 — harden Windows taskkill resolution and spawn failures

- Reason: A foreground Bash timeout in the Windows Electron UtilityRuntime called `spawn("taskkill", ...)`. When the utility process could not resolve the bare command, Node emitted an asynchronous `error` event that was not handled by the surrounding synchronous `try/catch`, crashing and reforking the runtime and leaving the active turn `interrupted`.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), `src/utils/shell.ts` process-tree termination paths.
- Change type: generic upstream material. Resolve `taskkill.exe` from `SystemRoot` / `windir`, attach an `error` listener to every graceful, forced, and emergency taskkill spawn, and fall back to killing the root shell so the Bash timeout/abort can settle even if the native tree killer is unavailable.
- Upstream PR: not opened.
- Validation: `node ../../../../node_modules/vitest/vitest.mjs --run test/windows-taskkill.test.ts test/graceful-terminate.test.ts test/bash-close-hang-windows.test.ts`; `pnpm --filter @earendil-works/pi-coding-agent build`; downstream `pnpm --filter @mavis/agent-tools exec vitest run test/desktop/local-bash-timeout.test.ts`.

### 2026-07-28 — allow hosts to inject fetch for OAuth token refresh

- Reason: MiniMax Electron can rely on Chromium `net.fetch` for enterprise CA, PAC, packet-capture proxy, and system proxy behavior, but expired OAuth credentials were refreshed from pi-coding-agent through provider defaults that could fall back to Node/global fetch. This left Codex/Anthropic/GitHub Copilot refresh requests vulnerable to the same runtime proxy failure after the user had already logged in successfully.
- Affected packages: `packages/ai` (`@earendil-works/pi-ai`) and `packages/coding-agent` (`@earendil-works/pi-coding-agent`).
- Change type: generic upstream material. Add optional `OAuthRequestOptions.fetch`, pass it through `refreshOAuthToken` / `getOAuthApiKey`, and thread it through `AuthStorage.getApiKey` into OpenAI Codex, Anthropic, and GitHub Copilot refresh providers.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-ai exec vitest --run test/openai-codex-oauth.test.ts test/openai-codex-stream.test.ts`; `pnpm --filter @earendil-works/pi-coding-agent exec vitest --run test/auth-storage-fetch.test.ts`; `pnpm --filter @earendil-works/pi-ai build`; `pnpm --filter @earendil-works/pi-coding-agent build`.

### 2026-07-26 — prefer Codex SSE when host fetch is injected

- Reason: the 2026-07-22 fetch-injection patch covered the Codex SSE request, but the provider's default `auto` transport still tried WebSocket first. WebSocket construction cannot use the host's injected `fetch`, so enterprise proxy / CA handling was bypassed in the default Codex path.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`).
- Change type: generic upstream material. When `OpenAICodexResponsesOptions.fetch` is provided and transport is left at `auto`, route Codex through SSE so the host-owned fetch implementation handles egress. Explicit `transport: "websocket"` / `"websocket-cached"` remains unchanged for callers that intentionally choose WebSocket.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-ai exec vitest --run test/openai-codex-stream.test.ts`; `pnpm --filter @earendil-works/pi-ai build`; downstream `pnpm --filter @mavis/local-runtime exec vitest run --config vitest.config.ts test/e2e/provider-headers.e2e.test.ts`.

### 2026-07-22 — allow hosts to inject fetch for model provider egress

- Reason: MiniMax Electron hosts can resolve enterprise/system proxy behavior in the utility process, but several model provider requests were still created with SDK/global default transports. In company LANs where Chromium can use a proxy but Node/undici direct connections cannot reach `agent.minimaxi.com` or BYOK-compatible endpoints, local turns fail before an upstream trace/request id is issued.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`).
- Change type: generic upstream material. Add optional `fetch` to stream/image options, copy it through simple provider options, pass it to internally constructed Anthropic/OpenAI SDK clients, and use it for the OpenAI Codex Responses SSE fallback request.
- Upstream PR: not opened.
- Validation: `corepack pnpm --filter @earendil-works/pi-ai exec vitest --run test/fireworks-models.test.ts test/openai-completions-retry.test.ts test/openai-codex-stream.test.ts test/openrouter-images.test.ts`; `corepack pnpm --filter @earendil-works/pi-ai build`.

### 2026-07-15 — expose the existing turn-boundary stop hook on `Agent`

- Reason: `AgentLoopConfig.shouldStopAfterTurn` already stops before polling steering and follow-up queues, but the stateful `Agent` wrapper did not expose or forward it. Hosts therefore could not terminate a rejected response at the same step boundary and a queued message could start another provider call first.
- Affected package: `packages/agent` (`@earendil-works/pi-agent-core`).
- Change type: generic upstream material. Add `shouldStopAfterTurn` to `AgentOptions` and the mutable wrapper callback surface, then forward it into the existing low-level loop config.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-agent-core test -- agent.test.ts -t 'should stop after a turn'`; `pnpm --filter @earendil-works/pi-agent-core build`; downstream `pnpm --filter @mavis/agent-core test -- pi-turn-runner.test.ts -t 'stops before consuming'`.

### 2026-07-31 — make coding-agent tests robust to composition and scheduler changes

- Reason: the compact resource assertion required an unwrapped absolute path, so it failed in the mandatory long feature-worktree path even though the TUI rendered the complete path across lines. The spawn-error mock also used a one-shot shell response that the newer constructor-time description probe consumed before execution. The different-file mutation queue test used a fixed 30 ms overlap window, so unrelated root-suite I/O scheduling could end the first callback before the second `realpath` completed even though the keys were independent. The reftable watcher tests waited for the transient state `execFile.mock.calls.length === 1`, which could be skipped under root-suite load and turn a real duplicate into a timeout instead of reaching the exact-count assertion.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), tests only.
- Change type: generic upstreamable test robustness. Normalize whitespace only for the compact-label assertion, keep the mocked invalid shell active through both shell probes, prove different-file concurrency with an explicit two-callback barrier instead of a timing window, and wait for at least one reftable refresh before retaining the existing exact-one debounce assertion.
- Upstream PR: not opened.
- Validation: `node ../../node_modules/vitest/dist/cli.js --run test/tool-execution-component.test.ts test/tools.test.ts test/file-mutation-queue.test.ts test/footer-data-provider.test.ts`; five consecutive isolated `footer-data-provider.test.ts` runs; complete `@earendil-works/pi-coding-agent` package test.

### 2026-07-08 — export OpenAI Responses conversion helpers

- Reason: MiniMax local-runtime needs to build Responses `/input_tokens` count bodies from the same Pi message/tool conversion helpers used by the OpenAI Responses generator, without importing unexported source paths from outside the package boundary.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`).
- Change type: generic upstream material. Re-export `convertResponsesMessages` / `convertResponsesTools` and their option types from the package root.
- Upstream PR: not opened.
- Validation: `pnpm --filter @mavis/local-runtime typecheck`; `pnpm --filter @mavis/local-runtime exec vitest run test/unit/local-remote-token-counter.test.ts test/unit/local-context-auto-compaction-remote-token-gate.test.ts test/unit/local-context-auto-compaction-token-gate.test.ts test/unit/local-dynamic-max-tokens.test.ts`; `pnpm --filter @mavis/local-runtime exec vitest run test/e2e/local-context-auto-compaction-gate.e2e.test.ts`.

### 2026-07-15 — backport GPT-5.6 catalog and Max thinking

- Reason: v0.79.1 lacks the three suffixed GPT-5.6 models, so local-runtime can fall back to `anthropic-messages`; the product also needs GPT-5.6's independent `max` effort without importing a later Pi release wholesale.
- Affected packages: `packages/ai`, `packages/agent`, and the minimum `packages/coding-agent` type/build adapters. MiniMax resolver and token-budget glue remains in `packages/local-runtime`.
- Change type: selective generic upstream material from `7df2a94e0fb1606aace92e662a176d668b93d20d` (GPT-5.6 metadata), `fbdd46389c3a0c03b62f5e9eabe31a85044ef8ce` (first-class Max), `6c735db0605a9f453ecea793d2ff9524c6416448` (remove the nonexistent bare alias), and `a9ecf301fb56c688570e0db0299926ce9009dbb8` (final limits and pricing metadata). Baseline, package versions, lockfile, and `.minimax-vendor.json` remain v0.79.1.
- Upstream context: issue `earendil-works/pi#6097` was closed as completed after maintainer confirmation that Max had landed. The v0.79.1 `Cost` type has no pricing tiers, so this backport keeps base costs and omits the later tiered pricing shape.
- Host boundary: local-runtime treats the IDL thinking toggle as the master switch, reads the typed canonical `thinking.effort`, and copies only the catalog's string `thinkingLevelMap.max` for an explicitly Max-capable model. Provider dispatch remains keyed by provider/API/model metadata rather than request payload presence.
- Upstream PR: not opened; the generic behavior is already upstream.
- Validation: `pnpm --filter @earendil-works/pi-ai exec vitest --run test/gpt-5-6-max-thinking.test.ts`; `pnpm --filter @earendil-works/pi-coding-agent... build`; focused local-runtime resolver, token-budget, remote-counter, and GPT-5.6 wire E2E suites. `pnpm check:pi-vendor-resolution` remains blocked by the baseline `packages/agent-runtime` dependency guard, outside this patch.

### 2026-06-16 — deterministic `@earendil-works/pi-ai` build

- Reason: MiniMax CI and Docker builds run without reliable access to external model metadata endpoints (`models.dev`, OpenRouter, Vercel AI Gateway). The upstream `build` script regenerated model files before compiling, which made routine workspace builds non-deterministic and could leave generated files in a TypeScript-incompatible fallback shape when DNS failed.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`).
- Change type: generic upstream material. Keep model metadata refresh available as an explicit `refresh-models` script, but make `build` compile the committed generated baselines only.
- Upstream PR: not opened during the spike.
- Validation: `pnpm --filter @earendil-works/pi-ai build`; `pnpm --filter @mavis/local-runtime... build`; `pnpm test:archon-guards`.

### 2026-06-19 — accept Claude Fable 5 adaptive thinking metadata

- Reason: Claude Fable 5 is expected to use Anthropic adaptive thinking metadata. The local metadata regression test still rejected `claude-fable-5` entries because its allow-list only covered Opus 4.6/4.7/4.8 and Sonnet 4.6.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`).
- Change type: generic upstream material. Update the adaptive-thinking model assertion to include Fable 5 provider variants.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-ai exec vitest --run test/anthropic-adaptive-thinking-models.test.ts --reporter verbose`; `pnpm --filter @earendil-works/pi-ai build`.

### 2026-06-19 — remove unstable fork target session-id assertion

- Reason: The `--session-id` read-only regression file had one fork-target collision assertion that failed before reaching collision handling when the local test environment has no selected-model API key. Keep the metadata/read-only coverage in the same file and remove this unstable assertion.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`).
- Change type: generic upstream material. Test-only adjustment.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-coding-agent exec vitest --run test/session-id-readonly.test.ts --reporter verbose`; `pnpm --filter @earendil-works/pi-coding-agent build`.

### 2026-07-04 — edit tool: scope fuzzy-match normalization to the matched span

- Reason: In `applyEditsToNormalizedContent`, when any edit fell back to fuzzy matching, the whole file was rewritten with `normalizeForFuzzyMatch` before saving. A single fuzzy edit silently ASCII-folded every smart quote, Unicode dash, special space (including U+3000) and stripped all trailing whitespace across the entire file — a data-fidelity bug that is especially harmful for CJK / full-width content. Fuzzy matching now only locates the target: the normalized-space hit is mapped back to a span of the original content (per-line NFKC column mapping with monotonic prefix binary search) and the replacement splices that span only; bytes outside matched spans are never rewritten. Also adds a disproportionate-match guard for fuzzy hits (opencode thresholds) and improves self-correction hints in error messages (not-found suggests re-reading the file; duplicate errors list the first match line numbers).
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), `src/core/tools/edit-diff.ts` only; public `fuzzyFindText` result now always reports original-content coordinates and no longer exposes `contentForReplacement` (no other in-repo consumers).
- Change type: generic upstream material. Behavior fix + regression tests in `test/edit-diff-fuzzy-span.test.ts`.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-coding-agent exec vitest --run test/edit-diff-fuzzy-span.test.ts test/edit-tool-legacy-input.test.ts test/edit-tool-no-full-redraw.test.ts test/file-mutation-queue.test.ts`; `pnpm --filter @earendil-works/pi-coding-agent build`.

### 2026-07-07 — bash: graceful SIGTERM→grace→SIGKILL on stop/timeout so cleanup traps run

- Reason: Background bash `task_stop` (and the per-command timeout) aborted through `createLocalBashOperations`'s `onAbort` → `killProcessTree`, which sent an immediate `SIGKILL` (signal 9, uncatchable) to the process group. A script's `trap ... TERM/INT` cleanup handler therefore never ran — cleanup logic was silently skipped and its artifacts (marker/temp files) leaked. Confirmed by the mcode-test E2E harness (case L7) driving the real CLI TUI LOG runtime. This is the `abort()`-one-stage limitation deferred in `.harness/docs/design/tools-optimize/bash-tool-optimization.md` §5.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), `src/utils/shell.ts` (new `terminateProcessTreeGracefully` + `PROCESS_TREE_TERM_GRACE_MS`) and `src/core/tools/bash.ts` (abort + timeout paths call the graceful variant). The pending SIGKILL escalation is cancelled only once the process GROUP is empty (`kill(-pid, 0)` throws ESRCH); if a command backgrounded a SIGTERM-ignoring descendant that outlives the shell, the escalation stays armed so the grace-window SIGKILL still reaps it (`waitForChildProcess` resolving on shell exit is not proof the group is gone). The emergency node-exit cleanup (`killTrackedDetachedChildren` → `killProcessTree`) intentionally keeps immediate SIGKILL.
- Change type: generic upstream material. Behavior fix + regression tests in `test/graceful-terminate.test.ts` (Unix-guarded: SIGTERM lets a TERM trap run; ignored-SIGTERM escalates to SIGKILL; canceller disarms escalation; abort with a SIGTERM-ignoring backgrounded descendant still SIGKILLs it — no early cancel).
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-coding-agent exec vitest --run test/graceful-terminate.test.ts`; `pnpm --filter @earendil-works/pi-coding-agent build`; downstream `pnpm --filter @mavis/local-runtime exec vitest run --config vitest.config.ts test/unit/local-background-bash-runner.test.ts` (L7 regression) + mcode-test `node bin/run-case.mjs L7`.

### 2026-07-09 — edit tool: fidelity guard rejecting a widened fuzzy span that swallows a compat character

- Reason: The span back-map in `fuzzyFindText` widens outward (start rounds down, end rounds up) so a replacement never splits an original code point. That widening could otherwise SWALLOW a whole compatibility character the model only partly named — e.g. `oldText` `"ix"` against a line `"ﬁx"` (NFKC `ﬁ`→`fi`) matches in normalized space starting inside the ligature, then the back-map maps onto the entire `"ﬁx"` and the replacement silently destroys the `ﬁ`. Added a fidelity guard: after mapping, `normalizeForFuzzyMatch(content.slice(start, end))` must reproduce exactly the located `fuzzyOldText`; if widening pulled in extra characters it won't, so the match fails closed (returns not-found) and the model retries with an unambiguous `oldText` instead of clobbering bytes it never named. Legitimate fuzzy matches (whose mapped span re-normalizes to exactly the located text) are unaffected.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), `src/core/tools/edit-diff.ts` only (`fuzzyFindText`). Extends the 2026-07-04 span-mapping change.
- Change type: generic upstream material. Behavior fix + regression tests in `test/edit-diff-fuzzy-span.test.ts` (ligature-partial-name fails closed; a full-width run named cleanly still applies — guard not over-strict).
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-coding-agent exec vitest --run test/edit-diff-fuzzy-span.test.ts test/edit-tool-legacy-input.test.ts test/edit-tool-no-full-redraw.test.ts test/file-mutation-queue.test.ts`; `pnpm --filter @earendil-works/pi-coding-agent build`.

### 2026-08-20 — bash: opt-in parent-death guardian for detached command trees

- Reason: `SIGKILL` is uncatchable, so an embedded CLI/TUI host could die before its JS abort and shutdown handlers reclaimed Pi's detached Bash process group. The B-A4 mcode-test left the long-running script alive after the CLI host was killed, allowing continued file, network, CPU, port, and lock side effects.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), `src/utils/shell.ts` (one shared detached IPC guardian per host process) and `src/core/tools/bash.ts` (opt-in `createLocalBashOperations({ parentDeathGuard: true })`). The default remains off; `packages/local-runtime` enables it only for managed local Bash, so cloud-runtime sandbox lifecycle is unchanged.
- Change type: generic upstreamable primitive plus MiniMax host opt-in. Every registration has a unique lease ID, so a stale disarm cannot remove a PID-reused target. Unix uses an absolute system `sh` gate independent of the command `PATH`, then `exec`s the real shell after ACK, preserving shell PID=PGID; Windows uses a minimal-environment Node launcher and sends the real shell environment with the post-ACK payload, so host `NODE_OPTIONS` cannot poison the launcher. PowerShell 5.1 encoding setup uses a short inline launcher and sends the untouched command over stdin into an in-memory ScriptBlock, preserving first-statement syntax without Base64 argv expansion, `.ps1` policy checks, or crash-persistent command files; it validates the parsed top-level `ScriptRequirements` before execution. Stdout/stderr use independent streaming decoders, including the truncated full-output file, so interleaved split UTF-8 bytes remain valid text. If the host IPC lease disappears, the guardian terminates every armed process group with `SIGTERM → 3s grace → SIGKILL`; Windows uses native `taskkill /T` then `/F /T`.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-coding-agent exec vitest --run test/graceful-terminate.test.ts test/windows-taskkill.test.ts test/bash-close-hang-windows.test.ts test/tools.test.ts`; `pnpm --filter @earendil-works/pi-coding-agent build`; `node scripts/test/focused-vitest.mjs --package @mavis/local-runtime packages/local-runtime/test/unit/local-background-bash-runner.test.ts packages/local-runtime/test/unit/local-background-bash-executor.test.ts packages/local-runtime/test/unit/local-background-task.test.ts`.

### 2026-09-05 — Optional Bash process-fact observation

- Reason: sandboxing must distinguish execution preparation, actual child spawn, guardian command delivery, and timer timeout. Preflight callbacks cannot prove startup, and error-string parsing cannot reliably identify timeouts.
- Affected package: optional `onProcessEvent` in `BashOperations.exec` of `@earendil-works/pi-coding-agent`. Default behavior is unchanged and observer exceptions are isolated. Guardian launchers and ordinary shells are explicitly distinguished.
- Type: generic, upstreamable execution interface without Archon configuration or reporting logic. Dependency checks also register the three existing direct Pi dependencies of `local-runtime-v2` and verify `workspace:*` and source resolution.
- Validation: `pnpm --filter @earendil-works/pi-coding-agent build`; `pnpm --filter @earendil-works/pi-coding-agent exec vitest --run test/bash-process-observation.test.ts test/bash-close-hang-windows.test.ts`; affected local-runtime-v2 sandbox focused tests. Windows-only tests were skipped on macOS; no real Windows validation is claimed.

For future changes, add one entry per MiniMax patch with:

- reason and affected package
- whether the change is generic upstream material or MiniMax-specific glue
- validation commands and results

## 2026-09-08: Explicit steering batches

- Reason: immediately submitted local user batches must be consumed in one provider hop while retaining each message identity.
- Affected package: `Agent.steerBatch` added to `@earendil-works/pi-agent-core`; individual `steer` / `followUp` and default modes remain compatible.
- Validation: `pnpm --filter @earendil-works/pi-agent-core build`; `node scripts/test/focused-vitest.mjs --package @earendil-works/pi-agent-core --skip-workspace-build third_party/pi-mono/packages/agent/test/agent.test.ts` (19 tests); agent-core focused `pi-turn-runner.test.ts` covers local batches and machine-only individual consumption.

## 2026-09-21: Propagate native exit codes through Windows PowerShell 5.1 wrappers

- Reason: `wrapWindowsPowerShellStdinCommand` ends with `& ([ScriptBlock]::Create($source))` and `wrapConstrainedWindowsPowerShellCommand` ends with `Invoke-Expression $source`. On Windows PowerShell 5.1, a `-Command` session whose final statement is a scriptblock invocation exits 0 regardless of `$LASTEXITCODE` set by native commands inside it, so every failing native command was reported as success (foreground tool result and background task status) on hosts without pwsh 7. Reproduced before the fix: a `node -e "…;process.exit(7)"` command produced its stderr yet the shell process exited 0.
- Affected package: `@earendil-works/pi-coding-agent` local bash operations, PowerShell 5.1 transport only (`src/core/tools/bash.ts`). pwsh 7 (native `-Command` path) and POSIX shells are untouched. PowerShell-internal terminating errors still exit non-zero via `throw` before the appended statement.
- Type: generic, upstreamable Windows fix using the same `exit $LASTEXITCODE` idiom already used by the first-party `packages/tui/src/update/versioned-prefix.ts` launchers.
- Change: append `exit $LASTEXITCODE` after the scriptblock invocation (stdin transport) and after `Invoke-Expression` (ConstrainedLanguage transport).
- Upstream PR: not opened.
- Validation (Windows 11 x64 build 26200, PowerShell 5.1 default, Node 24.18.0): `packages/local-runtime/test/unit/child-bash-lifecycle.test.ts` 'failure' mode fails before the fix (`expected 'succeeded' to be 'failed'`) and passes after; 'timeout' and 'cancel' modes unaffected. Focused re-run of the affected suites and full `pnpm test:capabilities` show no new failures. Not run: pwsh 7 host validation, ConstrainedLanguage host validation (launcher covered by structure assertions only), macOS/Linux regression runs.
