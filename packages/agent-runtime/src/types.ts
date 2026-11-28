/**
 * `@mavis/agent-runtime` — pluggable extension SPI + per-turn assembler
 * on top of `@mavis/agent-core`.
 *
 * 设计对齐 `packages/agent-runtime` 飞书设计文档 v1.0（吸收 review 后）。
 * 关键约束：
 *   - Extension 之间不允许相互 import；顺序仅由 host 装配加载顺序决定。
 *   - `assembleTurn(ctx)` 只做装配，不越界造 `RunTurnInput`——host 拿结果自己拼。
 *   - Registry 只做 in-memory 状态；持久化（例如 `extensionOverrides`）由 host 负责。
 *
 * 事件名沿用文档 §4.2 的新命名（含 `on_step_end` 对齐 pi 当前的 step completion 语义）；
 * `AssemblyResult.hooks` 映射到 `agent-core` 的 `PiTurnHooks.onStepEndHook`（§11.6
 * Step A 引入的首选名）。agent-core 侧仍兼容读取 deprecated per-step slot
 * `onTurnEndHook`，但 agent-runtime 单一写入语义明确的新字段——见 `registry.ts`
 * 的 `HOOK_MAPPINGS`。
 */

import type {
  PiAfterLlmCallHook,
  PiAfterLlmCallHookDecision,
  PiAfterLlmCallHookInput,
  PiAfterToolCallHook,
  PiBeforeLlmCallHook,
  PiBeforeLlmCallHookDecision,
  PiBeforeLlmCallHookInput,
  PiBeforeToolCallHook,
  PiHistoryChangedHookInput,
  PiLlmCallPreparedHookInput,
  PiOnHistoryChangedHook,
  PiOnStepEndHook,
  PiStepEndHookInput,
  PiTurnHooks,
} from '@mavis/agent-core/pi-turn-runner';
import type { RuntimeTool, ToolExecutionContext } from '@mavis/agent-core/tools';
import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import type { TSchema } from '@sinclair/typebox';
import type { PromptReadScope } from './prompt-read.js';

/**
 * Pi runtime history projection used by both `TurnAssemblyCtx` and
 * `TurnStartEvent`. Matches what `PiTurnRunner.runTurn` consumes as `history`
 * and what pi's `on_history_changed` payload carries — pi's `AgentMessage`
 * union (User / Assistant / ToolResult with `role`-discriminated content),
 * NOT the flat `@mavis/agent-core/protocol` wire shape.
 */
export type TurnHistoryProjection = readonly PiAgentMessage[];

// ─────────────────────────── Utility types ────────────────────────────

export type MaybePromise<T> = T | Promise<T>;

// ─────────────────────────── Turn assembly ctx ────────────────────────

/**
 * Extension 端拿到的 per-turn 只读上下文。**故意不含 **`eventWriter`、
 * `llm`、`signal`、`toolContext`——这些是 host 所有物。字段最小集见文档 §6.2。
 *
 * `agentConfig` / `model` 只声明为 `Readonly<unknown>` 是为了保持 agent-runtime
 * 对具体 host schema（local-runtime 的 `AgentConfigRecord`、cloud-runtime 的
 * `ResolvedModel`）中立——extension 需要具体字段时自行断言。
 */
export interface UserMessageContribution {
  readonly text: string;
}

/**
 * Secret-free, host-validated product intent for the current Turn. Extensions
 * may use it to activate an explicit workflow without receiving raw ingress
 * provenance or transport-owned metadata.
 */
export interface TurnIntent {
  readonly kind: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface ModelContextAssemblyCtx {
  /**
   * Host-validated Session that carries wrap_up and its guidance on every Turn, so the
   * request prefix stays the same across Turn sources; absent means wrap_up is unavailable.
   */
  readonly nextStepSessionEligible?: boolean;
  /** Foreground user action (including a card reply or resend), excluding peer and channel input. */
  readonly directUserInput?: boolean;
  /** Host-validated Turn that may show a card; other Turns get no card. */
  readonly nextStepEligible?: boolean;
  /**
   * Nobody is waiting on this Turn (a cron run or a background-task notice). Its card never
   * holds the queue, and a notice that starts it counts as its first message.
   */
  readonly nextStepUnattended?: boolean;
  /** Interactive channel ingress may only offer textual replies, even on a Desktop-bound Session. */
  readonly nextStepReplyOnly?: boolean;
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  readonly agentConfig: Readonly<Record<string, unknown>>;
  readonly model: Readonly<Record<string, unknown>>;
  /**
   * pi runtime history for this turn — see `TurnHistoryProjection` for shape.
   */
  readonly history: TurnHistoryProjection;
  readonly userInput?: UserMessageContribution;
  readonly turnIntent?: TurnIntent;
  readonly plan?: {
    readonly active: true;
    readonly canonicalPath: string;
  };
  /**
   * Who created this session when it was not the user. Extensions use it to withhold
   * capabilities that must not recurse (a Mini App session must not control Mini Apps).
   */
  readonly sessionOrigin?: {
    readonly miniApp?: { readonly pluginId: string };
  };
  /**
   * Optional host-captured template snapshot for this model call. Extensions
   * use it only for their managed prompt keys; its absence preserves bundled
   * prompt behavior for hosts that have not opted into dynamic templates.
   */
  readonly promptRead?: PromptReadScope;
  // Per-profile config lives on `ExtensionAPI.params`（文档 §4.4 line 281 + §5 line 749），
  // 不放进 TurnAssemblyCtx——保持 §6.2 只读投影最小集。
}

export interface TurnAssemblyCtx extends ModelContextAssemblyCtx {
  readonly userInput: UserMessageContribution;
  /**
   * Whether the host delivers this Turn's user message, and with it any
   * `userPromptPrefix` the assembly produced. A continuation resumes the
   * interrupted loop without appending a message, so a prefix it renders would
   * never reach the model; a contributor that must land in context reads this
   * instead of assuming every Turn sends one.
   */
  readonly sendsUserMessage: boolean;
  /** Host-captured output requirements; no credentials or mutable Runtime configuration. */
  readonly outputContract?: {
    readonly schema?: Readonly<Record<string, unknown>>;
    readonly revisionInstruction?: string;
  };
}

// ─────────────────────────── Tool contribution ────────────────────────

/**
 * Per-turn 动态 tool 工厂——`registerTool(fn)` 的实现形态。
 * 返回 `null` 表示本 turn 不贡献 tool；返回数组用于一次贡献同一
 * domain catalog（例如本地 native + MCP progressive disclosure）。
 */
export type RuntimeToolFactory<
  S extends TSchema = TSchema,
  TCtx extends ToolExecutionContext = ToolExecutionContext,
> = (
  ctx: ModelContextAssemblyCtx,
) => MaybePromise<RuntimeTool<S, TCtx> | readonly RuntimeTool<S, TCtx>[] | null>;

export type RuntimeToolContribution<
  S extends TSchema = TSchema,
  TCtx extends ToolExecutionContext = ToolExecutionContext,
> = RuntimeTool<S, TCtx> | RuntimeToolFactory<S, TCtx>;

// ─────────────────────────── Prompt / reminder ────────────────────────

export type PromptContributor<TContext extends ModelContextAssemblyCtx = TurnAssemblyCtx> = (
  ctx: TContext,
) => MaybePromise<string | null | undefined>;

export type SystemPromptContributor = PromptContributor<ModelContextAssemblyCtx>;
export type UserPromptContributor = PromptContributor<TurnAssemblyCtx>;

export interface Reminder {
  /**
   * Exactly one non-empty rendered `<system-reminder>...</system-reminder>`
   * block. Raw, nested (including self-closing/attributed same-name tags),
   * prefixed, suffixed, or multiple blocks are malformed.
   * The host preserves provider order and must not add another wrapper.
   */
  readonly content: string;
  /** Attach to the provider request only; never append to canonical history. */
  readonly requestOnly?: boolean;
  readonly priority?: number;
  readonly cooldownKey?: string;
}

export interface ReminderProvider {
  readonly name: string;
  compute(ctx: TurnAssemblyCtx): MaybePromise<Reminder | null | undefined>;
}

// ─────────────────────────── Hook / event names ───────────────────────

export const HOOK_NAMES = [
  'turn_start',
  'turn_end',
  'on_history_changed',
  'before_llm_call',
  'on_llm_call_prepared',
  'after_llm_call',
  'before_tool_call',
  'after_tool_call',
  'on_step_end',
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

// ─────────────────────────── Turn / step events ───────────────────────

export interface TurnStartEvent {
  /** Host 判定的普通用户输入；自动续跑、恢复与重试为 false。 */
  readonly isOrdinaryInputTurn?: boolean;
  /**
   * 本轮输入由用户本人撰写：`api`、`code_review`、`channel*`，以及编辑重发自己消息的
   * `conversation-mutation`。其他 Agent 的 session send（`communication`）、`cron`、
   * `background-task` 与 `questionnaire` 为 false——它们照常触发 `isOrdinaryInputTurn`，
   * 但不应被当成用户的记忆写入授权。以 `api` 重排的问卷答复按 `api` 处理。
   */
  readonly isUserAuthoredInput?: boolean;
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  /**
   * pi runtime history for this turn — see `TurnHistoryProjection` for shape.
   */
  readonly history: TurnHistoryProjection;
  readonly userInput: UserMessageContribution;
}

export interface TurnEndEvent {
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  /** Terminal reason exposed by host; see `TurnResult` in pi-turn-runner. */
  readonly reason?: string;
}

// ─────────────────────────── Handler shapes ───────────────────────────

export type ExtensionHandler<E, R = void> = (event: E, ctx: TurnAssemblyCtx) => MaybePromise<R>;

export type TurnStartHandler = ExtensionHandler<TurnStartEvent, void>;
export type TurnEndHandler = ExtensionHandler<TurnEndEvent, void>;
export type HistoryChangedHandler = ExtensionHandler<PiHistoryChangedHookInput, void>;

/**
 * Step-level handlers reuse `agent-core` 现有 hook input 类型——保持一份契约，
 * 避免 SPI 里再重复定义"pi 每 step 前会传什么"。
 */
export type BeforeLlmCallHandler = ExtensionHandler<
  PiBeforeLlmCallHookInput,
  PiBeforeLlmCallHookDecision | void | undefined
>;
/** Observation only. Core isolates failures and invokes this once per logical agent call. */
export type LlmCallPreparedHandler = ExtensionHandler<PiLlmCallPreparedHookInput, void>;
export type AfterLlmCallHandler = ExtensionHandler<
  PiAfterLlmCallHookInput,
  PiAfterLlmCallHookDecision | void | undefined
>;
/**
 * Tool hook handlers receive the immutable per-turn assembly context as a
 * third argument. The registry closes it over when adapting back to Pi's
 * two-argument hook contract, so existing two-argument handlers remain
 * source-compatible while extensions that persist artifacts can identify the
 * owning session/turn without reaching into Pi internals.
 */
export type BeforeToolCallHandler = (
  input: Parameters<PiBeforeToolCallHook>[0],
  signal: Parameters<PiBeforeToolCallHook>[1],
  ctx: TurnAssemblyCtx,
) => ReturnType<PiBeforeToolCallHook>;
export type AfterToolCallHandler = (
  input: Parameters<PiAfterToolCallHook>[0],
  signal: Parameters<PiAfterToolCallHook>[1],
  ctx: TurnAssemblyCtx,
) => ReturnType<PiAfterToolCallHook>;
export type StepEndHandler = ExtensionHandler<PiStepEndHookInput, void>;

/**
 * Event name → handler type map. Consumed by `Registry` to type its internal
 * `Record<HookName, Array<HandlerFor<K>>>` storage so read-side casts to
 * per-event handler arrays remain type-safe end-to-end. Extending
 * `HOOK_NAMES` requires adding the matching entry here — TS enforces
 * exhaustiveness via `HookHandlerMap[HookName]`.
 */
export interface HookHandlerMap {
  turn_start: TurnStartHandler;
  turn_end: TurnEndHandler;
  on_history_changed: HistoryChangedHandler;
  before_llm_call: BeforeLlmCallHandler;
  on_llm_call_prepared: LlmCallPreparedHandler;
  after_llm_call: AfterLlmCallHandler;
  before_tool_call: BeforeToolCallHandler;
  after_tool_call: AfterToolCallHandler;
  on_step_end: StepEndHandler;
}

export type HandlerFor<K extends HookName> = HookHandlerMap[K];

// ─────────────────────────── ExtensionAPI ─────────────────────────────

export interface ExtensionAPI {
  /**
   * Per-profile params merged from `ProfileOverlay.param`（文档 §4.4 line 281 / §5 line 749
   * "per-profile config，传给 extension init 时读"）。Extension 在 `init` 里读取，例如
   * 决定内部行为或读取 host 传入的 flag。为空对象时表示当前 profile 无 overlay 或未定义 param。
   */
  readonly params: Readonly<Record<string, unknown>>;

  registerTool<
    S extends TSchema = TSchema,
    TCtx extends ToolExecutionContext = ToolExecutionContext,
  >(
    contribution: RuntimeToolContribution<S, TCtx>,
  ): void;

  contributeSystemPrompt(fn: SystemPromptContributor): void;
  contributeUserPromptPrefix(fn: UserPromptContributor): void;
  registerReminderProvider(provider: ReminderProvider): void;

  // Turn 级
  on(event: 'turn_start', handler: TurnStartHandler): void;
  on(event: 'turn_end', handler: TurnEndHandler): void;
  on(event: 'on_history_changed', handler: HistoryChangedHandler): void;

  // Step 级
  on(event: 'before_llm_call', handler: BeforeLlmCallHandler): void;
  on(event: 'on_llm_call_prepared', handler: LlmCallPreparedHandler): void;
  on(event: 'after_llm_call', handler: AfterLlmCallHandler): void;
  on(event: 'before_tool_call', handler: BeforeToolCallHandler): void;
  on(event: 'after_tool_call', handler: AfterToolCallHandler): void;
  on(event: 'on_step_end', handler: StepEndHandler): void;

  /**
   * Generic fallback overload—consumed by `wireHandlers` and any table-driven
   * caller that iterates `HOOK_NAMES`. Individual per-event overloads above
   * still apply for call sites that pass a literal event name (better error
   * messages). Type-safety is preserved by `HandlerFor<K>` throughout the
   * pipeline.
   */
  on<K extends HookName>(event: K, handler: HandlerFor<K>): void;
}

// ─────────────────────────── Extension shape ──────────────────────────

export interface AgentExtension {
  /** Open string identifier: extension sets are host/plugin-defined, not a closed enum. */
  readonly id: string;
  /** Control-plane label returned by `listExtensions`; never affects execution semantics. */
  readonly description?: string;
  init(pi: ExtensionAPI): MaybePromise<void>;
}

// ─────────────────────────── Assembly result ──────────────────────────

export interface ReminderEmission {
  readonly providerName: string;
  readonly reminder: Reminder;
}

export interface AssemblyDiagnostic {
  readonly loadedExtensions: readonly string[];
  readonly enabledExtensions: readonly string[];
  readonly disabledExtensions: readonly string[];
  readonly toolCount: number;
  readonly reminderCount: number;
}

/**
 * `PiTurnHooks` 覆盖 `agent-core` 已有的 step 级契约；turn lifecycle handlers
 * 作为 raw arrays 由 host 显式取用。这样 agent-runtime 不需要改动
 * `@mavis/agent-core` 就能落地（见文档 §11.6 迁移策略）。
 */
export interface AssemblyResult<TCtx extends ToolExecutionContext = ToolExecutionContext> {
  readonly systemPromptPrefix: string;
  readonly userPromptPrefix: string;
  readonly tools: readonly RuntimeTool<TSchema, TCtx>[];
  readonly hooks: PiTurnHooks;
  readonly reminders: readonly ReminderEmission[];
  readonly turnStartHandlers: readonly TurnStartHandler[];
  readonly turnEndHandlers: readonly TurnEndHandler[];
  readonly diagnostic: AssemblyDiagnostic;
}

export interface ModelContextAssemblyResult<
  TCtx extends ToolExecutionContext = ToolExecutionContext,
> {
  readonly systemPromptPrefix: string;
  readonly tools: readonly RuntimeTool<TSchema, TCtx>[];
}

export interface ModelContextAssemblySeed {
  readonly tools: readonly RuntimeTool[];
}

export interface TurnAssemblySeed extends ModelContextAssemblySeed {
  readonly userPromptPrefix: string;
}

// ─────────────────────────── Registry state view ──────────────────────

export interface ExtensionContributionStats {
  readonly tools: number;
  readonly promptContributors: number;
  readonly reminderProviders: number;
  readonly hooks: Readonly<Record<HookName, number>>;
}

export interface ExtensionState {
  readonly id: string;
  /** Human-readable control-plane metadata copied from `AgentExtension.description`. */
  readonly description?: string;
  readonly enabled: boolean;
  readonly contributions: ExtensionContributionStats;
}

export interface EnabledScope {
  readonly sessionId?: string;
}

// ─────────────────────────── Runtime API ──────────────────────────────

export interface AgentRuntime {
  assembleModelContext(
    ctx: ModelContextAssemblyCtx,
    seed?: ModelContextAssemblySeed,
  ): Promise<ModelContextAssemblyResult>;
  assembleTurn(ctx: TurnAssemblyCtx, seed?: TurnAssemblySeed): Promise<AssemblyResult>;
  setEnabled(extensionId: string, enabled: boolean, scope?: EnabledScope): void;
  listExtensions(scope?: EnabledScope): ExtensionState[];
  disposeSession(sessionId: string): void;
}

// ─────────────────────────── Runtime options ──────────────────────────

export interface ProfileOverlay {
  readonly enable?: readonly string[];
  readonly disable?: readonly string[];
  readonly replace?: Readonly<Record<string, string>>;
  readonly param?: Readonly<Record<string, unknown>>;
}

export interface RuntimeOptions {
  readonly base: readonly AgentExtension[];
  readonly additions?: readonly AgentExtension[];
  readonly overlays?: Readonly<Record<string, ProfileOverlay>>;
  readonly profile?: string;
}

// ─────────────────────────── Re-exports ───────────────────────────────

export type {
  PiAfterLlmCallHook,
  PiAfterLlmCallHookDecision,
  PiAfterLlmCallHookInput,
  PiAfterToolCallHook,
  PiBeforeLlmCallHook,
  PiBeforeLlmCallHookDecision,
  PiBeforeLlmCallHookInput,
  PiBeforeToolCallHook,
  PiHistoryChangedHookInput,
  PiOnHistoryChangedHook,
  PiOnStepEndHook,
  PiStepEndHookInput,
  PiTurnHooks,
};
