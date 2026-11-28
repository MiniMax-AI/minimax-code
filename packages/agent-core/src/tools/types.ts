/**
 * Tool 体系核心契约。
 *
 * `ToolDefinition` —— 工具的公开 contract。schema 是 typebox 形态
 * (`TSchema`),既被 PiTurnRunner 透传给 pi 作为 `AgentTool.parameters`,
 * 也用 `Static<S>` 推导 `ToolImpl.execute(input)` 的入参强类型。
 * `prepareArguments` / `executionMode` 直接映射到 Pi 0.79.1 `AgentTool`
 * 对应字段。
 *
 * `ToolExecutionContext` —— 每轮 turn 由 host 构造、闭包到 pi `AgentTool`
 * wrapper 里的最小 ctx。host 可以扩出自己的 ctx 子类型(cloud-runtime 的
 * `CloudRuntimeContext` 加了 reporter / bizId / workspaceRoot 等),
 * 在 `ToolImpl<S, TCtx>` 上声明对应 TCtx 即可。**严禁** 用 `AsyncLocalStorage`
 * 把 per-turn 状态注进 tool —— wrapper closure 是唯一注入点。
 *
 * `ToolImpl<S, TCtx>` —— 工具的实现。`execute(ctx, input, signal?, onUpdate?)` 第一个
 * 参数是 per-turn ctx,host 在 `assembleAgentTools` 里把 ctx 闭包 baked-in;
 * 同一个 ToolDefinition 可以有多个 ToolImpl 实现(cloud / local / mock),
 * 都走相同的 execute 签名。
 *
 * `RuntimeTool<S, TCtx>` —— the `(def, impl)` pair consumed by
 * PiTurnRunner. New platform-owned tools should prefer declaring this
 * object directly with `defineRuntimeTool(...)`, keeping the LLM-facing
 * definition and runtime implementation co-located.
 *
 * `bindTool(def)` / `toRuntimeTool(instance)` remain available for decorated
 * class implementations, but new code should prefer `defineRuntimeTool(...)`.
 */

import type { AgentToolUpdateCallback, ToolExecutionMode } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import type { Static, TSchema } from '@sinclair/typebox';
import type { IPluginCapabilityProvenance } from '@mavis/protocol';
import type {
  PtcChildDeadline,
  PtcChildDisplayResultShaper,
  PtcToolExecutor,
  PtcToolFactCollector,
  PtcToolResultProjection,
} from './ptc.js';

export type RuntimeToolSource = 'builtin' | 'builtin-matrix' | 'configured';

export interface ToolCallProvenanceResolutionInput {
  readonly phase: 'start' | 'end';
  readonly toolName: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly result?: unknown;
  readonly isError?: boolean;
}

export type ToolCallProvenanceResolver = (
  input: ToolCallProvenanceResolutionInput,
) => readonly IPluginCapabilityProvenance[] | undefined;

export interface VideoContent {
  type: 'video';
  data: string;
  mimeType: string;
}

export type ToolResultContent = TextContent | ImageContent | VideoContent;

/**
 * Source-owned, bounded operation classification for observability.
 *
 * The tool owns its operation vocabulary; PiTurnRunner accepts a classifier
 * result only when it belongs to this fixed allowlist. Unknown, malformed, or
 * throwing classifications collapse to the shared `unknown` metric value.
 */
export interface ToolOperationClassifier {
  readonly allowedValues: readonly string[];
  classify(args: unknown): string | undefined;
}

export interface ToolDefinition<S extends TSchema = TSchema> {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly schema: S;
  /** Controls definition disclosure after availability and permission filtering. */
  readonly loading?: 'default' | 'on_demand';
  /**
   * Group this builtin tool belongs to; see `BUILTIN_TOOL_NAMESPACES` in
   * `@mavis/agent-tools/shared/builtin-tool-namespaces`. Each namespace binds one
   * Skill, so the host can gate the tool on that Skill's receipt and append the
   * whole group's definitions when the model loads it. Builtin tools only.
   */
  readonly namespace?: string;
  readonly promptGuidelines?: readonly string[];
  readonly prepareArguments?: (args: unknown) => Static<S>;
  readonly executionMode?: ToolExecutionMode;
  readonly operationClassifier?: ToolOperationClassifier;
  /**
   * Opt-in: a new user message (Steer) interrupts this tool while it runs. The signal passed
   * to `execute` then aborts with a reason `isToolSteerInterruption` recognises, already
   * aborted when the message arrived before the call started. The tool still returns its own
   * result and the Turn continues; the message is injected at the next boundary as usual.
   * Needs `ToolExecutionContext.userSteering`; without it the tool runs as if unflagged.
   */
  readonly interruptOnSteer?: true;
}

/**
 * Host-owned view of user steering in the running Turn, used for `interruptOnSteer` tools.
 * Only messages a user steered in count; machine delivery (plugins, system) does not.
 */
export interface ToolUserSteering {
  /** Whether user steering is waiting for the next boundary. */
  pending(): boolean;
  /**
   * A not-yet-aborted signal that aborts when the next steering message of any producer is
   * admitted, or undefined when the host can no longer report any.
   */
  changed(): AbortSignal | undefined;
}

/**
 * A tool's own statement about whether its text output is complete on this
 * return path. Programmatic (PTC) hosts trust it only from verified native
 * tools; a missing statement means "unknown", never "complete".
 */
export interface ProgrammaticToolCompleteness {
  /** True when this output dropped content (page, byte cap, match limit, cut lines, ...). */
  readonly truncated: boolean;
  /**
   * The source has more beyond this page although nothing was cut, for
   * example a `read` that stopped at the caller's `limit`.
   */
  readonly hasMore?: boolean;
  readonly nextOffset?: number;
  readonly offsetUnit?: 'line' | 'match' | 'file';
}

/**
 * Machine-readable side channel for programmatic (PTC) callers only. The Pi
 * tool adapter never copies it into `content` or `details`, so it reaches no
 * model history, display record or persisted detail; the PTC executor reads it
 * from the tool's own return value and drops it when a hook rewrote the result.
 */
export interface ProgrammaticToolResult {
  /** Structured value; always a JSON object and never more than the text output shows. */
  readonly data?: Readonly<Record<string, unknown>>;
  readonly completeness?: ProgrammaticToolCompleteness;
  /** Raw protocol or connection error of a third-party call; hosts never branch on it. */
  readonly errorRaw?: unknown;
  /**
   * PTC child calls only: a model-visible output cap that a direct call of the
   * same tool applies would have cut this output, and the tool returned it in
   * full instead. Hosts only count it for logs; it never changes the result.
   */
  readonly uncappedOutput?: boolean;
}

/**
 * 工具返回值。`content` 保持跟 pi `AgentToolResult` 兼容(单条 text 段即可);
 * `details` 是结构化的副产物(LLM 不读,UI / 调用方读);`terminate` 映射到
 * Pi `AgentToolResult.terminate`;`output` 是历史字段,仅保留以便迁移期兼容,
 * 新代码用 `details`。
 */
export interface ToolResult {
  tool_name: string;
  text: string;
  content: ToolResultContent[];
  isError?: boolean;
  details?: Record<string, unknown>;
  output?: Record<string, unknown>;
  terminate?: boolean;
  /** PTC-only payload; see `ProgrammaticToolResult`. Model calls ignore it. */
  programmatic?: ProgrammaticToolResult;
}

/**
 * Per-turn execution context — host 在 `assembleAgentTools` 把它闭包进每个
 * `AgentTool.execute` wrapper。最小字段只有 sessionId / turnId,具体 host
 * 可以扩出自己的子类型(cloud-runtime 的 `CloudRuntimeContext` 加了
 * `bizId` / `reporter` / `workspaceRoot` 等)然后让自家的 `ToolImpl<S, TCtx>`
 * 声明对应 TCtx。
 */
export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  /** Per-call id supplied by the provider loop; absent in older/direct test paths. */
  readonly toolCallId?: string;
  /** Assistant message carrying this tool call; supplied by the runtime bridge when available. */
  readonly assistantMessageId?: string;
  /** Parent run_code tool call for a PTC child invocation. */
  readonly parentToolCallId?: string;
  /** User-visible run_code description for a PTC child approval. */
  readonly ptcParentDescription?: string;
  /**
   * Set only on PTC child contexts. Foreground Bash bounds its timeout by the
   * time left until this deadline so a command cannot outlive its program;
   * ordinary top-level calls never carry it and keep their own timeouts.
   */
  readonly ptcDeadline?: PtcChildDeadline;
  /** Runner-owned PTC capability, available only while the turn is executing. */
  ptcExecutor?: PtcToolExecutor;
  /** Trusted host projection for PTC child facts; guest code cannot supply this. */
  readonly ptcResultProjection?: PtcToolResultProjection;
  /**
   * Host hook over the display copy of a PTC child result. Only the host sets
   * it; without it the executor emits the display copy unchanged.
   */
  readonly shapePtcChildDisplayResult?: PtcChildDisplayResultShaper;
  /** Turn-local host fact collector for PTC plugin and approval outcomes. */
  readonly ptcFactCollector?: PtcToolFactCollector;
  /** Present only when the host can observe user steering for this Turn. */
  readonly userSteering?: ToolUserSteering;
}

/**
 * 工具实现。
 *
 * `ctx` 是 host 构造的 per-turn 上下文,通过 `assembleAgentTools` 闭包注入,
 * 不走 `AsyncLocalStorage`。`input` 由 ToolDefinition.schema 通过
 * `Static<typeof schema>` 推导出强类型字段。
 *
 * `signal` 是可选的 turn 级 abort 通道:由 pi `AgentTool.execute` 传入,
 * SessionController 在 abort 时会触发它。任何有可能阻塞的 tool 实现(走
 * HTTP、长时间 sandbox shell、外部资源 IO)都应该在内部把 signal 透到 fetch
 * 或在关键节点检查 `signal.aborted`,以便 SessionController 的 abort 路径
 * 能真正打断 inflight 操作而不是等天然超时。
 *
 * `onUpdate` 是 Pi 的 partial tool result callback,用于长任务流式上报
 * 进度。实现可以忽略；需要上报时必须返回与最终 `ToolResult.content/details`
 * 相同语义的 partial result。
 */
export interface ToolImpl<
  S extends TSchema = TSchema,
  TCtx extends ToolExecutionContext = ToolExecutionContext,
> {
  execute(
    ctx: TCtx,
    input: Static<S>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>,
  ): Promise<ToolResult>;
}

/**
 * `(def, impl)` pair. PiTurnRunner only depends on this protocol shape; it
 * does not care whether a tool comes from cloud, desktop, mobile, or a test
 * host.
 */
export interface RuntimeTool<
  S extends TSchema = TSchema,
  TCtx extends ToolExecutionContext = ToolExecutionContext,
> {
  readonly def: ToolDefinition<S>;
  readonly impl: ToolImpl<S, TCtx>;
  readonly source?: RuntimeToolSource;
  /** Turn-local display attribution; never affects execution or permission semantics. */
  readonly toolCallProvenanceResolver?: ToolCallProvenanceResolver;
}

export type { ToolExecutionMode };
