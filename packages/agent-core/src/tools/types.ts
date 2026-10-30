/**
 * Core tool contracts.
 *
 * `ToolDefinition`: The public tool contract. Its typebox schema (`TSchema`) is forwarded by
 * PiTurnRunner to pi as `AgentTool.parameters` and used with `Static<S>` to infer strongly typed
 * `ToolImpl.execute(input)` arguments. `prepareArguments` / `executionMode` map directly to the
 * corresponding Pi 0.79.1 `AgentTool` fields.
 *
 * `ToolExecutionContext`: Minimal context built by the host each turn and captured by the pi
 * `AgentTool` wrapper. Hosts can extend it (cloud-runtime's `CloudRuntimeContext` adds reporter /
 * bizId / workspaceRoot, etc.) and declare their TCtx in `ToolImpl<S, TCtx>`. **Never** inject
 * per-turn tool state through `AsyncLocalStorage`; the wrapper closure is the only injection point.
 *
 * `ToolImpl<S, TCtx>`: Tool implementation. The first argument to `execute(ctx, input, signal?,
 * onUpdate?)` is per-turn context, captured by the host in `assembleAgentTools`. One ToolDefinition
 * may have multiple ToolImpl implementations (cloud / local / mock), all sharing the same execute
 * signature.
 *
 * `RuntimeTool<S, TCtx>` — the `(def, impl)` pair consumed by PiTurnRunner. New platform-owned
 * tools should prefer declaring this object directly with `defineRuntimeTool(...)`, keeping the
 * LLM-facing definition and runtime implementation co-located.
 *
 * `bindTool(def)` / `toRuntimeTool(instance)` remain available for decorated class implementations,
 * but new code should prefer `defineRuntimeTool(...)`.
 */

import type { AgentToolUpdateCallback, ToolExecutionMode } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import type { Static, TSchema } from '@sinclair/typebox';
import type { IPluginCapabilityProvenance } from '@mavis/protocol';
import type {
  PtcChildDeadline,
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
  readonly promptGuidelines?: readonly string[];
  readonly prepareArguments?: (args: unknown) => Static<S>;
  readonly executionMode?: ToolExecutionMode;
  readonly operationClassifier?: ToolOperationClassifier;
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
}

/**
 * Tool result. `content` stays compatible with pi `AgentToolResult` (a single text segment is
 * sufficient); `details` holds structured byproducts (read by the UI / caller, not the LLM);
 * `terminate` maps to Pi `AgentToolResult.terminate`; `output` is a legacy field retained only for
 * migration compatibility. New code should use `details`.
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
 * Per-turn execution context, captured by the host in each `AgentTool.execute` wrapper in
 * `assembleAgentTools`. The minimal fields are sessionId / turnId. Hosts may extend it
 * (cloud-runtime's `CloudRuntimeContext` adds `bizId` / `reporter` / `workspaceRoot`, etc.) and
 * declare the corresponding TCtx in their `ToolImpl<S, TCtx>`.
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
  /** Turn-local host fact collector for PTC plugin and approval outcomes. */
  readonly ptcFactCollector?: PtcToolFactCollector;
}

/**
 * Tool implementation.
 *
 * `ctx` is host-built per-turn context injected via a closure in `assembleAgentTools`, not
 * `AsyncLocalStorage`. `input` fields are strongly typed from ToolDefinition.schema using
 * `Static<typeof schema>`.
 *
 * `signal` is an optional turn-level abort channel passed by pi `AgentTool.execute` and triggered
 * when SessionController aborts. Potentially blocking implementations (HTTP, long-running sandbox
 * shell, external resource IO) should forward it to fetch or check `signal.aborted` at key points,
 * allowing SessionController to interrupt inflight operations instead of waiting for natural
 * timeouts.
 *
 * `onUpdate` is Pi's partial tool result callback for streaming long-task progress. Implementations
 * may ignore it; when used, partial results must share the semantics of the final
 * `ToolResult.content/details`.
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
