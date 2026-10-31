// Helpers extracted from `api/host.ts` to keep that file under the
// 2000-line block threshold enforced by `scripts/hooks/pre-commit`
// (see boy-scout warning trail on commits f2b4b14a / d7e454fe). Pure
// utilities + small interfaces + the SSE writer wrapper — no `this` dependencies.
import type { PromptSnapshotSource } from "@mavis/agent-core";
import type {
  PiLLMRequestFailureHook,
  PiLLMRequestObserver,
} from "@mavis/agent-core/pi-turn-runner";
import {
  RespDataType,
  Role,
  type AgentMessage,
  type RespData,
} from "@mavis/agent-core/protocol/agent-message";
import type { ToolDiagnosticLogger as MatrixToolLogger } from "../observability/tool-logger.js";
import type { LocalMavisCronAdapter } from "@mavis/agent-tools/desktop";
import type { RuntimeConversation } from "@mavis/conversation-contract";
import type { CronStorePort } from "@mavis/cron";
import type { PermissionRuleMatcher, ShellFamily } from "@mavis/permission";
import type { GlobalEventPayloadMap } from "@mavis/shared/global-events";
import type { AgentReferenceResolver } from "../agent/port.js";
import type { LocalAgentRuntimePort } from "../agent/runtime-port.js";
import type { LocalBrowserBroker } from "../browser/api.js";
import type { LocalAccessControlStore } from "../channels/access-control-store.js";
import type { LocalFeishuChannelStore } from "../channels/feishu.js";
import type { LocalChannelBridgeInfra } from "../channels/infra.js";
import type { LocalChannelOwnerStore } from "../channels/owner-store.js";
import type { LocalChannelRunner } from "../channels/runner.js";
import type { LocalTelegramChannelStore } from "../channels/telegram.js";
import type { WeChatRuntimeSdk } from "../channels/wechat-sdk-contract.js";
import type { LocalWeChatChannelStore } from "../channels/wechat.js";
import { logger } from "../common/logger.js";
import type { MetricsClient } from "../common/metrics.js";
import type { LocalRuntimeConfig } from "../config/types.js";
import type { LocalConfigUpdateResult } from "../config/update.js";
import type { DesktopErrorReporter } from "../error-reporting/index.js";
import type { LocalEvalReporterFactoryLike } from "../eval/types.js";
import type { GlobalEventPublisher } from "../events/global-events.js";
import type { LocalHookService } from "../hooks/api.js";
import type { LegacyHistoryReader } from "../legacy-opencode/legacy-history-reader.js";
import type { CliSunsetNoticeEvaluator } from "../memory/cli-sunset-notice.js";
import {
  hostDiagnosticsUnavailable,
  type LocalHostDiagnosticsProvider,
} from "../observability/diagnostics-provider.js";
import type {
  LocalCommunicationMessageStore,
  LocalRuntimeMessageStore,
  LocalRuntimeQueueStore,
  LocalTokenUsageStore,
  LocalTurnDiffStore,
} from "../persistence/ports.js";
import type { QuestionnaireRequestStore } from "../questionnaire/store.js";
import type { LocalBashCompletion } from "../runtime/bash-completion-correlation.js";
import type { LocalMcpRuntimeCapability } from "../runtime/mcp-capability.js";
import type {
  LocalRuntimeCapabilities,
  LocalRuntimeMode,
} from "../runtime/mode.js";
import type {
  LocalModelResolverLike,
  LocalRuntimeAuthContext,
} from "../runtime/model-resolver.js";
import type { ModuleMetricsReporter } from "../runtime/observability-host-wiring.js";
import type { LocalRuntimeRoutingContext } from "../runtime/routing-headers.js";
import type { LocalRuntimeStartupExecutionPolicy } from "../runtime/startup-execution-policy.js";
import type {
  LocalSessionController,
  LocalSessionRecord,
} from "../sessions/controller.js";
import type { LocalSessionLedgerStore } from "../sessions/ledger/index.js";
import type { LocalSessionProjectionStore } from "../sessions/projection/index.js";
import type { LocalRuntimeTelemetrySink } from "../sessions/router.js";
import type { LocalSessionSnapshotStore } from "../sessions/snapshot/index.js";
import type { SessionTurnStreamFrameInput } from "../sessions/turn-stream.js";
import type { LiveSessionWriter } from "../sessions/writer/index.js";
import type { LocalSkillHubStore } from "../skills/hub-api.js";
import type { LocalSkillEnabledStatePort } from "../skills/registry.js";
import type { ThreadGoalRuntimeEventSink } from "../thread-goal/events.js";
import type { LocalApiAgentRoutes } from "./routes/agents.js";

export {
  buildLocalHardDenyReason,
  buildLocalPermissionRuleContents,
  localPermissionRuleToolName,
} from "./host-permission-rules.js";

// ─── LocalRuntimeApiHost constructor options ──────────────────────────
// Lifted here to keep the host file under the 2000-line block threshold.
export interface LocalRuntimeApiHostOptions {
  readonly reviewPromptDir?: string;
  controller?: LocalSessionController;
  legacyOpencodeRuntime?: LegacyHistoryReader;
  legacyOpencodeEnabled?: boolean;
  runtimeMode?: LocalRuntimeMode;
  startupExecutionPolicy?: LocalRuntimeStartupExecutionPolicy;
  capabilityProfile?: "cli";
  capabilities?: Partial<LocalRuntimeCapabilities>;
  /** Explicit shell provenance supplied by the local executor; unknown remains fail-closed on Windows native delete. */
  shellFamily?: ShellFamily;
  /** Composition overrides injected by the Cron v2 owner for legacy Local Mavis commands. */
  mavisCronAdapterProvider?: () => LocalMavisCronAdapter | undefined;
  /** Host boundary for cleaning up Cron definitions when an Agent is deleted. */
  deleteAgentCronTasks?: (agentName: string) => Promise<void>;
  /** Construction-time switch for legacy Cron consumers; false prevents legacy writers from starting. */
  cronConsumerEnabled?: boolean;
  /**
   * V2-owned Conversation boundary. A non-owner diagnostic shell may omit it;
   * omission means Conversation is unavailable and never enables a V1 fallback.
   */
  runtimeConversation?: RuntimeConversation;
  /** Owner-injected write-only publisher; pure v1 defaults to its local event source. */
  globalEventPublisher?: GlobalEventPublisher;
  /** Fail closed instead of invoking legacy conversation writers. */
  disableLegacyConversation?: boolean;
  /** Skip constructor-time recovery until the owning runtime has bound owned actions. */
  deferQuestionnaireRecovery?: boolean;
  telemetry?: LocalRuntimeTelemetrySink;
  /** Existing Session Clio reporter used for non-message runtime observations. */
  evalReporterFactory?: LocalEvalReporterFactoryLike;
  /** Complete host-owned Goal event projection; when present it also owns Clio mirroring. */
  threadGoalRuntimeEventSink?: ThreadGoalRuntimeEventSink;
  matrixLogger?: MatrixToolLogger;
  metricsReporter?: ModuleMetricsReporter;
  /**
   * Optional metrics sink (bare metric names; the server-side pipeline owns
   * the `local_runtime_` prefix). Absent = noop, zero behavior change.
   */
  metricsClient?: MetricsClient;
  configGetter?: () => LocalRuntimeConfig;
  /** Owner-injected neutral Agent resolver; V2 supplies the sole production owner. */
  agentResolver?: AgentReferenceResolver;
  /** Owner-injected Agent runtime port for legacy HTTP/Desktop consumers. */
  agentRuntimePort?: LocalAgentRuntimePort;
  /** Read-only prompt source bound by the V2 owner after prompt-config starts. */
  promptSnapshots?: PromptSnapshotSource;
  modelResolver?: LocalModelResolverLike;
  authContextGetter?: () => LocalRuntimeAuthContext | undefined;
  /** Owner-side generation-aware recovery for rejected managed OAuth requests. */
  authContextInvalidator?: (
    rejectedAccessToken?: string,
    loginEpoch?: string,
  ) => void | Promise<void>;
  routingContextGetter?: () => LocalRuntimeRoutingContext | undefined;
  /** Live host-owned gate; absent means Context Usage estimation is disabled. */
  isContextWindowUsageEnabled?: () => boolean;
  /** Electron: pass `net.fetch` for VPN proxy / enterprise CA trust. */
  fetchImpl?: typeof fetch;
  /** Process-level desktop error reporter, shut down by API Host and exposed to v2 through a narrow callback. */
  errorReporter?: DesktopErrorReporter;
  /** Failure callback shared with the v1 runner and supplied to v2. */
  llmRequestFailureHook?: PiLLMRequestFailureHook;
  bashCompletionCorrelation?: {
    record(sessionId: string, completion: LocalBashCompletion): void;
    observeLLMRequest: PiLLMRequestObserver;
  };
  configUpdater?: (
    body: Record<string, unknown>,
  ) => Promise<LocalConfigUpdateResult>;
  messageStore?: LocalRuntimeMessageStore;
  ledgerStore?: LocalSessionLedgerStore | false;
  projectionStore?: LocalSessionProjectionStore;
  snapshotStore?: LocalSessionSnapshotStore;
  sessionWriter?: LiveSessionWriter;
  queuedMessageStore?: LocalRuntimeQueueStore;
  runLegacyImCredentialMigration?: (
    action: () => Promise<void>,
  ) => Promise<void>;
  communicationMessageStore?: LocalCommunicationMessageStore;
  tokenUsageStore?: LocalTokenUsageStore;
  turnDiffStore?: LocalTurnDiffStore;
  cronStore?: CronStorePort;
  questionnaireStore?: QuestionnaireRequestStore;
  mcpService?: LocalMcpRuntimeCapability;
  hookService?: LocalHookService;
  browserBroker?: LocalBrowserBroker;
  skillHubStore?: LocalSkillHubStore;
  skillRegistryRoots?: import("@mavis/skills").SkillSourceRoot[];
  skillEnabledState?: LocalSkillEnabledStatePort;
  /** V2-owned bounded CLI-sunset state evaluator; V1 only supplies Memory files. */
  cliSunsetNotice?: CliSunsetNoticeEvaluator;
  /** Low-volume, fail-open Skill registry LRU-close diagnostics. */
  skillRegistryDiagnostics?: import("../skills/registry.js").LocalSkillRegistryDiagnosticSink;
  /**
   * Optional override for the per-channel owner store. The default wires
   * a fresh `LocalChannelOwnerStore` rooted at `<dataDir>/channel-owner.yaml`
   * with `chmod 0o600`. Tests can inject a pre-seeded / spy instance.
   */
  channelOwnerStore?: LocalChannelOwnerStore;
  /**
   * Optional override for the per-channel Access Control store. The
   * default wires a fresh `LocalAccessControlStore` rooted at
   * `<dataDir>/access-control.yaml`. Tests can inject a pre-seeded
   * instance to exercise specific policy shapes without touching the
   * real on-disk file.
   */
  channelAccessControlStore?: LocalAccessControlStore;
  channelBridgeInfra?: LocalChannelBridgeInfra;
  channelRunner?: LocalChannelRunner;
  feishuChannelStore?: LocalFeishuChannelStore;
  telegramChannelStore?: LocalTelegramChannelStore;
  wechatChannelStore?: LocalWeChatChannelStore;
  /**
   * Production WeChat SDK injection point. When provided (typically by the
   * Electron main process after dynamically importing the bundled iLink SDK
   * from `@mavis/local-runtime` so the SDK does not enter the Electron main
   * static-import graph), the registered `LocalWeChatChannelAdapter` talks to
   * iLink for outbound + attachment downloads. When omitted, the channel
   * subsystem falls back to `stubWeChatRuntimeSdk` so unit tests and offline
   * runs keep working without iLink credentials.
   */
  wechatRuntimeSdk?: WeChatRuntimeSdk;
  /** Test-only: stub token/device-code HTTP calls so binds do no network I/O. */
  telegramTokenVerifyFetcher?: typeof fetch;
  /** Test-only: stub the WeChat iLink onboard fetch (`get_bot_qrcode` / `get_qrcode_status`). */
  wechatOnboardFetcher?: import("../channels/adapters/wechat/wechat-onboard.js").WeChatFetch;
  feishuOnboardFetch?: typeof fetch;
  feishuWsEnabled?: boolean;
  /**
   * @internal Defer the channel subsystem startup (legacy IM import →
   * pre-restore steps → the single `restoreInboundLoops`) to an explicit
   * `startChannelSubsystem()` call. Local Runtime V2 sets it so no transport
   * comes up before its Session/Agent services are ready; every other caller
   * keeps the construction-time start.
   */
  deferChannelStartup?: boolean;
  hostDiagnosticsProvider?: LocalHostDiagnosticsProvider;
  agentName?: string;
  agentDisplayName?: string;
  defaultWorkspaceDir?: string;
  runtimeOwnerId?: string;
  runtimeOwnerKind?: string;
  runtimeStartupToken?: string;
  sessionLockRenewalIntervalMs?: number;
  nowMs?: () => number;
}

export async function routeDiagnosticsApi(
  hostDiagnosticsProvider: LocalHostDiagnosticsProvider | undefined,
  request: Request,
  parts: string[],
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "POST" && parts[1] === "upload") {
    return json(
      hostDiagnosticsProvider?.uploadDiagnosticBundle
        ? await hostDiagnosticsProvider.uploadDiagnosticBundle(
            await readJsonBody(request),
          )
        : hostDiagnosticsUnavailable("diagnostic-upload"),
    );
  }
  return notFound(`/diagnostics/${parts.slice(1).join("/")}`);
}

// ─── HTTP response header constants ─────────────────────────────────────
export const JSON_HEADERS = { "Content-Type": "application/json" } as const;
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

// ─── Permission enums + request types ──────────────────────────────────
export type LocalPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "auto"
  | "off";

export type LocalPermissionDecision = "allowAlways" | "allowOnce" | "deny";

export interface LocalResumeRequest {
  msgId?: string;
  afterCursor?: string;
  turnId?: string;
  drainQueued?: boolean;
}

export interface LocalPermissionRequest {
  requestId: string;
  sessionId: string;
  turnId: string;
  agentName: string;
  toolName: string;
  ruleContents: string[];
  ruleMatchers?: readonly PermissionRuleMatcher[];
  persistWholeToolRuleOnReply?: boolean;
  toolInput?: string;
  toolDescription?: string;
  /** PTC only: the run_code child call this approval belongs to. */
  parentToolCallId?: string;
  parentToolDescription?: string;
  /** PTC only: denying this child call stops the whole program instead of failing one call. */
  stopPtcOnDeny?: boolean;
  reason: string;
  createdAt: number;
  /**
   * In-process waiters sharing this pending request (fingerprint dedupe). A
   * reply settles all of them at once; a single waiter's abort settles only
   * that waiter.
   */
  waiters: Set<LocalPermissionRequestWaiter>;
  /** Set once `permission.ask` was actually emitted — an already-aborted
   * signal removes the record before announce, and such never-shown asks
   * must not contribute `permission_ask_wait_ms` samples. */
  announced?: boolean;
  resolve(decision: LocalPermissionDecision): void;
  cleanup(): void;
}

export interface LocalPermissionRequestWaiter {
  settle(decision: LocalPermissionDecision): void;
  detach(): void;
}

// ─── SSE writer wrapper used by the streaming routes ───────────────────
export class SseWriter {
  private readonly encoder = new TextEncoder();
  private closed = false;

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
  ) {}

  write(data: string): void {
    if (this.closed) return;
    try {
      this.controller.enqueue(this.encoder.encode(encodeSSEData(data)));
    } catch {
      this.closed = true;
    }
  }

  writeJson(value: unknown): void {
    this.write(JSON.stringify(value));
  }

  writeEvent(data: string, options?: { id?: string; event?: string }): void {
    if (this.closed) return;
    try {
      this.controller.enqueue(
        this.encoder.encode(encodeSSEEvent(data, options)),
      );
    } catch {
      this.closed = true;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      // Consumer may have cancelled the stream.
    }
  }
}

// ─── Pure URL/path helpers ─────────────────────────────────────────────
export function splitPath(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

export function buildLegacyDaemonProxyPath(
  rawPathname: string,
  decodedApiPath: string,
  search: string,
  root:
    | "goal"
    | "team"
    | "browser"
    | "channel-bridge"
    | "im-bridge"
    | "skill-hub"
    | "skill"
    | "skill-evolve"
    | "agent",
): string | undefined {
  const rawApiPath = rawPathname.slice("/mavis/api".length);
  const rawPrefix = `/${root}`;
  if (rawApiPath !== rawPrefix && !rawApiPath.startsWith(`${rawPrefix}/`))
    return undefined;
  if (/%2f|%5c/iu.test(rawApiPath)) return undefined;
  const decodedParts = splitPath(decodedApiPath);
  if (decodedParts.some((part) => part === "." || part === ".."))
    return undefined;
  return `${rawApiPath}${search}`;
}

// ─── Response factories ────────────────────────────────────────────────
export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers: { ...JSON_HEADERS, ...(init?.headers ?? {}) },
  });
}

export function notFound(pathname: string): Response {
  return json(
    { error: `Local runtime route not found: ${pathname}` },
    { status: 404 },
  );
}

export function notImplemented(feature: string): Response {
  return json(
    {
      success: false,
      error: `Local runtime route is not implemented: ${feature}`,
    },
    { status: 501 },
  );
}

export async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const data = (await request.json()) as unknown;
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function readResumeRequest(
  request: Request,
  url: URL,
): Promise<LocalResumeRequest> {
  const body = await readJsonBody(request);
  const msgId =
    url.searchParams.get("msgId") ??
    readFirstString(body, [
      "msgId",
      "msg_id",
      "after_message_id",
      "after_msg_id",
    ]);
  const afterCursor =
    url.searchParams.get("afterCursor") ??
    url.searchParams.get("after_cursor") ??
    readFirstString(body, ["afterCursor", "after_cursor"]) ??
    request.headers.get("Last-Event-ID") ??
    undefined;
  const turnId =
    url.searchParams.get("turnId") ??
    readFirstString(body, ["turnId", "turn_id"]);
  const drainQueued =
    url.searchParams.get("drainQueued") === "true" ||
    url.searchParams.get("drain_queued") === "true" ||
    body.drainQueued === true ||
    body.drain_queued === true;
  return {
    ...(msgId ? { msgId } : {}),
    ...(afterCursor ? { afterCursor } : {}),
    ...(turnId ? { turnId } : {}),
    ...(drainQueued ? { drainQueued } : {}),
  };
}

// ─── Field readers ─────────────────────────────────────────────────────
export function readString(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readVisibility(
  data: Record<string, unknown>,
): "visible" | "hidden" | undefined {
  const value = data.visibility;
  return value === "visible" || value === "hidden" ? value : undefined;
}

export function readPermissionDecision(
  data: Record<string, unknown>,
): LocalPermissionDecision | undefined {
  const value = data.decision;
  if (typeof value !== "string") return undefined;
  const aliases: Record<string, LocalPermissionDecision> = {
    allow: "allowOnce",
    "allow-always": "allowAlways",
    "allow-for-agent": "allowOnce",
    allowForAgent: "allowOnce",
    allowAlways: "allowAlways",
    allowOnce: "allowOnce",
    deny: "deny",
  };
  return aliases[value];
}

export function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readRequestedFramework(
  data: Record<string, unknown>,
): string | undefined {
  const raw = data.frameworkType ?? data.framework_type ?? data.engine;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

// ─── Agent name + model id helpers ─────────────────────────────────────
export function buildGeneratedAgentName(): string {
  const random =
    globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 12) ??
    `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.slice(
      0,
      12,
    );
  return `agent-${random}`;
}

export function isValidLocalAgentName(name: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(name);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function splitModelId(
  model: string,
): [string | undefined, string | undefined] {
  // Split at the FIRST slash only and keep the remainder as the model id:
  // custom model ids may themselves contain slashes (OpenRouter-style
  // vendor/model). Aligned with parseModelKey / parseSourceQualifiedModelKey;
  // behavior is unchanged for all zero- and one-slash inputs.
  const slash = model.indexOf("/");
  if (slash < 0) return [model || undefined, undefined];
  return [
    model.slice(0, slash) || undefined,
    model.slice(slash + 1) || undefined,
  ];
}

export function readLocalPermissionMode(value: unknown): LocalPermissionMode {
  return value === "default" ||
    value === "acceptEdits" ||
    value === "bypassPermissions" ||
    value === "auto" ||
    value === "off"
    ? value
    : "auto";
}

export function readFirstString(
  data: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

// ─── RespData parsing + Pi frame helpers ───────────────────────────────
export function parseRespData(raw: string): RespData | undefined {
  try {
    const parsed = JSON.parse(raw) as RespData;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function toSessionTurnFrameInput(
  data: string,
): SessionTurnStreamFrameInput {
  const resp = parseRespData(data);
  if (resp?.type === RespDataType.AgentMessage && resp.agent_message) {
    return {
      data,
      messageId: resp.agent_message.msg_id,
      completeMessage: true,
    };
  }
  if (
    resp?.type === RespDataType.AgentMessageChunk &&
    resp.agent_message_chunk
  ) {
    return {
      data,
      messageId: resp.agent_message_chunk.msg_id,
      ...(typeof resp.agent_message_chunk.chunk_index === "number"
        ? { chunkIndex: resp.agent_message_chunk.chunk_index }
        : {}),
      completeMessage: false,
    };
  }
  return { data, completeMessage: false };
}

/**
 * Build the in-band SSE terminal `{ type: 'error', ... }` frame the owner-turn
 * writer emits on failure. `errorCode` is included when defined so the UI SSE
 * consumer at `packages/ui/src/services/runtimeProjection.ts` reads it off
 * `raw.errorCode` and code-prefixes the message for downstream biz-status
 * parse (e.g. Token Plan 42212 / 2056 quota family).
 */
export function buildInBandErrorFrame(
  errorMessage: string,
  errorCode: number | undefined,
): Record<string, unknown> {
  return {
    type: "error",
    error: errorMessage,
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
}

/**
 * Build the `{ errorMessage, errorCode? }` update fields the owner-turn catch
 * branch (and other terminal-error persistence sites) spread into
 * `controller.updateSession` + `recordMemorySessionFinish` payloads.
 * Extracted so the catch branch stays compact under the layout gate.
 */
export function buildLocalTurnErrorFields(
  errorMessage: string,
  errorCode: number | undefined,
): { errorMessage: string; errorCode?: number } {
  return { errorMessage, ...(errorCode !== undefined ? { errorCode } : {}) };
}

/**
 * Owner-turn catch-branch terminal persistence: classify the raw thrown err,
 * write the session record + memory session finish record, and emit the
 * in-band SSE error frame. Kept out of `host.ts` because inlining the four
 * calls (classify + updateSession + recordMemorySessionFinish + writer) plus
 * shared errFields costs ~15 lines that push the file over budget.
 */
export interface PersistLocalTurnCatchTerminalDeps {
  session: { sessionId: string };
  turnId: string;
  err: unknown;
  writer: { writeJson: (data: unknown) => void };
  controller: {
    updateSession: (
      sessionId: string,
      patch: Record<string, unknown>,
    ) => Promise<unknown>;
  };
  memoryFacade?: unknown;
  emitBusEvent: (type: string, payload: Record<string, unknown>) => void;
  nowMs: () => number;
  // Injected so this helper stays free of a hard `event-bridge` import cycle
  // through `host-helpers.ts` (host-helpers is imported by many files).
  classifyLLMErrorToCode: (
    err: unknown,
  ) => { message: string; status_code: number } | null;
  recordMemorySessionFinish: (input: never) => Promise<void>;
}

export async function persistLocalTurnCatchTerminal(
  deps: PersistLocalTurnCatchTerminalDeps,
): Promise<{ errorMessage: string; errorCode?: number }> {
  const message =
    deps.err instanceof Error ? deps.err.message : String(deps.err);
  const classified = deps.classifyLLMErrorToCode(deps.err);
  const errFields = buildLocalTurnErrorFields(
    classified?.message ?? message,
    classified?.status_code,
  );
  await deps.controller.updateSession(deps.session.sessionId, {
    status: "error",
    ...errFields,
  });
  await deps.recordMemorySessionFinish({
    session: deps.session,
    turnId: deps.turnId,
    status: "error",
    ...errFields,
    nowMs: deps.nowMs,
    memoryFacade: deps.memoryFacade,
    emitBusEvent: deps.emitBusEvent,
  } as never);
  deps.writer.writeJson(
    buildInBandErrorFrame(errFields.errorMessage, errFields.errorCode),
  );
  return errFields;
}

// ─── SSE encoding + ID generation ──────────────────────────────────────
export function encodeSSEData(data: string): string {
  return `data: ${data.replace(/\r\n|\r|\n/g, "\ndata: ")}\n\n`;
}

export function encodeSSEEvent(
  data: string,
  options?: { id?: string; event?: string },
): string {
  const lines: string[] = [];
  if (options?.id) lines.push(`id: ${options.id}`);
  if (options?.event) lines.push(`event: ${options.event}`);
  lines.push(`data: ${data.replace(/\r\n|\r|\n/g, "\ndata: ")}`);
  return `${lines.join("\n")}\n\n`;
}

export function makeId(prefix: string): string {
  const random =
    globalThis.crypto?.randomUUID?.().replaceAll("-", "") ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

export function serializePermissionRequest(
  item: LocalPermissionRequest,
): GlobalEventPayloadMap["permission.ask"] {
  return {
    requestId: item.requestId,
    sessionId: item.sessionId,
    turnId: item.turnId,
    agentName: item.agentName,
    toolName: item.toolName,
    ruleContents: item.ruleContents,
    ...(item.toolInput ? { toolInput: item.toolInput } : {}),
    ...(item.toolDescription ? { toolDescription: item.toolDescription } : {}),
    reason: item.reason,
    allowAlwaysSupported:
      item.ruleContents.length > 0 || item.persistWholeToolRuleOnReply === true,
    createdAt: item.createdAt,
  };
}

export function formatPeekMessage(message: AgentMessage): string | undefined {
  const content =
    typeof message.msg_content === "string"
      ? message.msg_content
      : safeJsonStringify(message.msg_content);
  if (!content) return undefined;
  const role =
    message.role === Role.User
      ? "user"
      : message.role === Role.Assistant
        ? "assistant"
        : "system";
  return `${role}: ${content.slice(0, 2_000)}`;
}

export function isVisibleTreeSession(session: LocalSessionRecord): boolean {
  if (session.visibility === "hidden") return false;
  const purpose = session.purpose ?? "";
  return !purpose.startsWith("peek_") && !purpose.startsWith("peek:");
}

export function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

// ─── Config sanitization (mask secrets in API responses) ───────────────
// Generic over the runtime config shape so the helpers compile here
// without importing `LocalRuntimeConfig` (keeps this file dependency-free
// against the host's type surface).
export function sanitizeConfig<T extends { provider?: unknown }>(
  config: T,
): Record<string, unknown> {
  return {
    ...sanitizeRecord(config as unknown as Record<string, unknown>),
    provider: sanitizeProviderConfig(
      (config.provider ?? {}) as Record<string, unknown>,
    ),
  };
}

export async function hostCreateRootSession(deps: {
  agentName: string;
  createSession: LocalApiAgentRoutes["createSession"];
  replaceRootSession: LocalApiAgentRoutes["replaceRootSession"];
  deleteSession: (sessionId: string) => Promise<unknown>;
  resolveWorkspaceDir: () => string;
}): Promise<Awaited<ReturnType<LocalApiAgentRoutes["replaceRootSession"]>>> {
  const {
    agentName,
    createSession,
    replaceRootSession,
    deleteSession,
    resolveWorkspaceDir,
  } = deps;
  // Create the transient session as a branch, then let
  // `replaceRootSession` promote it to root (which also demotes the
  // previous root). If the promote
  // fails we must NOT return the branch masquerading as a root —
  // that was the original silent-bail bug that produced
  // `outcome:'ok'` while `sessionType='branch'`. Clean up the
  // transient row and return undefined so the caller surfaces the
  // failure to the user.
  const branch = await createSession({
    agentName,
    workspaceDir: resolveWorkspaceDir(),
    sessionType: "branch",
    sessionKind: "conversation",
    title: "Main",
    parentSessionId: null,
    isDefaultWorkspace: true,
    origin: "user",
  });
  const promoted = await replaceRootSession(agentName, branch.sessionId);
  if (!promoted) {
    logger.error(
      {
        scope: "host.createRootSession",
        agentName,
        transientBranchId: branch.sessionId,
      },
      "createRootSession: replaceRootSession returned undefined; cleaning up transient branch",
    );
    try {
      await deleteSession(branch.sessionId);
    } catch (err) {
      logger.warn(
        {
          scope: "host.createRootSession",
          agentName,
          transientBranchId: branch.sessionId,
          err: err instanceof Error ? err.message : String(err),
        },
        "createRootSession: cleanup of transient branch failed (non-fatal)",
      );
    }
    return undefined;
  }
  return promoted;
}

export function sanitizeProviderConfig(
  provider: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(provider).map(([providerId, providerConfig]) => [
      providerId,
      sanitizeRecord(providerConfig as Record<string, unknown>),
    ]),
  );
}

export function sanitizeRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      sanitizeConfigValue(key, value),
    ]),
  );
}

export function sanitizeConfigValue(key: string, value: unknown): unknown {
  if (
    key === "headers" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([headerKey, headerValue]) => [
          headerKey,
          typeof headerValue === "string" ? maskSecret(headerValue) : "****",
        ],
      ),
    );
  }
  if (isSensitiveKey(key)) {
    return typeof value === "string" ? maskSecret(value) : "****";
  }
  if (typeof value === "string") {
    return maskUrlCredentials(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeConfigValue(key, item));
  }
  if (value && typeof value === "object") {
    return sanitizeRecord(value as Record<string, unknown>);
  }
  return value;
}

export function isSensitiveKey(key: string): boolean {
  return /api[-_]?key|token|secret|authorization|password|credential/i.test(
    key,
  );
}

export function maskSecret(value: string): string {
  return value.length > 8
    ? `${value.slice(0, 4)}****${value.slice(-4)}`
    : "****";
}

export function maskUrlCredentials(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return value;
    if (url.username) url.username = "****";
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return value;
  }
}
