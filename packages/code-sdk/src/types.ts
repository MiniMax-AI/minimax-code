/**
 * Public types for the `mcode exec --output-format stream-json` contract (schemaVersion 1).
 *
 * The SDK owns these types so the published package does not depend on CLI internals. A
 * repository contract test keeps them aligned with the events the CLI actually emits.
 */

export type ExecResultStatus = 'succeeded' | 'failed' | 'timeout' | 'cancelled' | 'limit_exceeded';

export type ExecErrorCategory = 'config' | 'runtime' | 'internal';

export interface ExecError {
  readonly category: ExecErrorCategory;
  readonly code?: string;
  readonly message: string;
  readonly retryable?: boolean;
}

export interface ModelIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly providerSource?: string;
  readonly providerKind?: string;
  readonly protocol?: string;
}

/**
 * Token usage. `totalTokens = inputTokens + outputTokens`; cache buckets are reported separately
 * and are not included in `totalTokens`. `reasoningTokens` may overlap `outputTokens`.
 */
export interface Usage {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export type UsageSource = 'completed_responses' | 'analytics_fallback' | 'unavailable';

/** Final result of one `mcode exec` run (`exec.completed.result`). */
export interface ExecResult {
  readonly schemaVersion: 1;
  readonly type: 'exec.result';
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly status: ExecResultStatus;
  /** Final answer. Phase 1 does not support output schemas, so this is a string when present. */
  readonly output?: unknown;
  readonly error?: ExecError;
  readonly model?: ModelIdentity;
  readonly usage?: Usage;
  readonly usageSource?: UsageSource;
  readonly usageIncomplete?: boolean;
  readonly durationMs: number;
}

/**
 * Raw tool call snapshot forwarded from the Runtime.
 *
 * @experimental `status` is an internal numeric enum and `input` / `output` are tool-specific
 * structures. Neither is covered by the SDK compatibility promise.
 */
export interface RawToolCall {
  readonly id?: string;
  readonly name?: string;
  readonly status?: number;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly durationMs?: number;
  readonly [key: string]: unknown;
}

export type ExecItemType = 'agent_message' | 'reasoning' | 'tool_call';

/** Item payload carried by `item.*` events exactly as the CLI emits it. */
export interface ExecItem {
  readonly id: string;
  readonly type: ExecItemType;
  /** Full text, present on `item.completed` for messages and reasoning. */
  readonly content?: string;
  /** Incremental text, present on `item.started` / `item.updated` for messages and reasoning. */
  readonly contentDelta?: string;
  /** @experimental See {@link RawToolCall}. */
  readonly toolCall?: RawToolCall;
}

interface ThreadEventBase {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly timestampMs: number;
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export type ExecStartedEvent = ThreadEventBase & { readonly type: 'exec.started' };
export type SessionStartedEvent = ThreadEventBase & {
  readonly type: 'session.started' | 'session.resumed';
};
export type TurnStartedEvent = ThreadEventBase & { readonly type: 'turn.started' };
export type ItemEvent = ThreadEventBase & {
  readonly type: 'item.started' | 'item.updated' | 'item.completed';
  readonly item: ExecItem;
};
export type TurnCompletedEvent = ThreadEventBase & {
  readonly type: 'turn.completed';
  readonly model?: ModelIdentity;
  readonly usage?: Usage;
  readonly usageSource?: UsageSource;
  readonly usageIncomplete?: boolean;
  readonly durationMs: number;
};
export type TurnFailedEvent = ThreadEventBase & {
  readonly type: 'turn.failed';
  readonly status: Exclude<ExecResultStatus, 'succeeded'>;
  readonly error?: ExecError;
  readonly durationMs: number;
};
export type ExecCompletedEvent = ThreadEventBase & {
  readonly type: 'exec.completed';
  readonly result: ExecResult;
};

/**
 * Events yielded by `runStreamed()`, unchanged from the CLI stream.
 *
 * Event types added by newer CLI versions are passed through at runtime as well; keep a
 * `default` branch when switching on `event.type`.
 */
export type ThreadEvent =
  | ExecStartedEvent
  | SessionStartedEvent
  | TurnStartedEvent
  | ItemEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ExecCompletedEvent;

interface ThreadItemBase {
  readonly id: string;
  /** True when the run ended before the CLI sent `item.completed` for this item. */
  readonly incomplete?: true;
}

export interface AgentMessageItem extends ThreadItemBase {
  readonly type: 'agent_message';
  readonly text: string;
}

export interface ReasoningItem extends ThreadItemBase {
  readonly type: 'reasoning';
  readonly text: string;
}

export interface ToolCallItem extends ThreadItemBase {
  readonly type: 'tool_call';
  /** @experimental See {@link RawToolCall}. */
  readonly toolCall: RawToolCall;
}

/** SDK-normalized item, merged by `id` across all `item.*` events of one Turn. */
export type ThreadItem = AgentMessageItem | ReasoningItem | ToolCallItem;

/** Result of a successful `thread.run()`. */
export interface Turn {
  readonly status: 'succeeded';
  readonly finalResponse: string;
  readonly items: ThreadItem[];
  readonly usage?: Usage;
  readonly model?: ModelIdentity;
  readonly sessionId: string;
  readonly turnId: string;
  readonly durationMs: number;
  readonly result: ExecResult;
}

export type PermissionPolicy = 'smart' | 'full' | 'off';
export type ContextMode = 'standard' | 'lightweight';
export type PromptMode = 'tui' | 'coding' | 'work';

export interface MCodeOptions {
  /** Explicit `mcode` executable or JS entry. Skips package and PATH lookup. */
  readonly bin?: string;
  /** Data directory for Sessions and config; passed to the CLI as `MINIMAX_DATA_DIR`. */
  readonly dataDir?: string;
  /** Child process environment. Replaces `process.env` when provided. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Runtime config file, passed as `--config`. */
  readonly configPath?: string;
}

export interface ThreadOptions {
  /** Workspace directory, passed as `--cwd`. Defaults to the host process cwd. */
  readonly cwd?: string;
  /** Model as `provider/model`, for example `minimax/MiniMax-M3`. */
  readonly model?: string;
  readonly effort?: string;
  readonly permission?: PermissionPolicy;
  /** Context mode for a new Thread. `lightweight` cannot be used with `resumeThread`. */
  readonly mode?: ContextMode;
  readonly promptMode?: PromptMode;
  /** Replaces the main Agent identity prompt for each Turn. */
  readonly systemPrompt?: string;
  /** Appended after the main Agent identity prompt for each Turn. */
  readonly appendSystemPrompt?: string;
}

export interface RunOptions {
  /** Files attached to this Turn (`--file`). Relative paths resolve against `cwd`. */
  readonly files?: readonly string[];
  readonly signal?: AbortSignal;
  /** Run timeout handled by the CLI (`--timeout <n>ms`). */
  readonly timeoutMs?: number;
  /** Maximum assistant steps (`--max-steps`). */
  readonly maxSteps?: number;
}

export interface StreamedTurn {
  readonly events: AsyncGenerator<ThreadEvent, void, undefined>;
}
