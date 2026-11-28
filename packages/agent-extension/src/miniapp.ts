import {
  defineRuntimeTool,
  type AgentExtension,
  type ModelContextAssemblyCtx,
} from '@mavis/agent-runtime';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import {
  projectMiniAppFailure,
  type MiniAppFailureDiagnostic,
  type MiniAppFailureReasonCode,
  type MiniAppInspectDiagnostics,
} from './miniapp-diagnostics.js';

export type {
  MiniAppFailureDiagnostic,
  MiniAppFailureReasonCode,
  MiniAppFailureRecovery,
  MiniAppFailureStage,
  MiniAppInspectDiagnostics,
} from './miniapp-diagnostics.js';

const TARGET_ACTIONS = ['init', 'open', 'inspect', 'publish', 'restart', 'stop'] as const;
const MINIAPP_ACTIONS = ['list', ...TARGET_ACTIONS] as const;
const PluginId = Type.String({
  minLength: 1,
  maxLength: 80,
  pattern: '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$',
  description: 'Required for every Mini App action except list.',
});
const OpenPath = Type.String({
  minLength: 1,
  maxLength: 4096,
  pattern: String.raw`^/(?!/)(?:[^\u0000-\u0020\u007f\\#%]|%[0-9a-fA-F]{2})*(?![\s\S])`,
  description:
    'Only for open. An origin-relative path, optionally including a query string, such as /items/42?tab=details. Omit to open the default surface. Must start with a single /; URLs, backslashes, ASCII whitespace and control characters, fragments, and malformed percent escapes are forbidden.',
});
const SourcePath = Type.String({
  minLength: 1,
  maxLength: 4096,
  pattern: '^[^\\u0000]*$',
  description:
    'Publish only: path to a finished Mini App package directory, absolute or relative to the current Session workspace. Omit to publish the workspace package.',
});
// Keep the provider-facing input as one concrete object. Exact action/input pairing
// remains a runtime concern below; exposing the action contracts as a root object
// union produces a top-level anyOf that some OpenAI-compatible providers reject.
const MiniAppProviderInputSchema = Type.Object(
  {
    action: Type.String({
      enum: [...MINIAPP_ACTIONS],
      pattern: `^(?:${MINIAPP_ACTIONS.join('|')})$`,
      description: 'Mini App lifecycle action.',
    }),
    pluginId: Type.Optional(PluginId),
    path: Type.Optional(OpenPath),
    sourcePath: Type.Optional(SourcePath),
  },
  {
    additionalProperties: false,
    description:
      'pluginId is required for every Mini App action except list. path is accepted only for open. sourcePath is accepted only for publish.',
  },
);

const MiniAppActionInputSchema = Type.Union([
  Type.Object({ action: Type.Literal('list') }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal('open'), pluginId: PluginId, path: Type.Optional(OpenPath) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal('publish'),
      pluginId: PluginId,
      sourcePath: Type.Optional(SourcePath),
    },
    { additionalProperties: false },
  ),
  ...TARGET_ACTIONS.filter((action) => action !== 'open' && action !== 'publish').map((action) =>
    Type.Object(
      { action: Type.Literal(action), pluginId: PluginId },
      { additionalProperties: false },
    ),
  ),
]);

export interface MiniAppSummary {
  readonly pluginId: string;
  /** Installation source reported by the Host, not declared by the package. */
  readonly source: 'official' | 'local';
  readonly displayName?: string;
  readonly runtime: {
    readonly kind: 'process';
    readonly status: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
    readonly errorCode?: string;
  };
}

export interface MiniAppListResult {
  readonly miniApps: readonly MiniAppSummary[];
}

export interface MiniAppInitResult {
  readonly pluginId: string;
  readonly mode: 'create' | 'update';
  readonly packagePath: `miniapps/${string}` | `liveboards/${string}`;
}

export interface MiniAppTargetResult {
  readonly miniApp: MiniAppSummary;
}

export interface MiniAppInspectResult extends MiniAppTargetResult {
  readonly diagnostics: MiniAppInspectDiagnostics;
  /**
   * The Host memory manager's view: when the user last attended this Mini App (Unix ms), why
   * it is protected from sleep right now, and when and why it last slept. Absent when the Host
   * has no memory manager.
   */
  readonly memory?: {
    readonly lastAttendedAtMs?: number;
    readonly protection?: string;
    readonly lastSleep?: {
      readonly atMs: number;
      readonly reason: string;
      readonly unit: 'page' | 'app';
    };
  };
}

export type MiniAppRunningSummary = Omit<MiniAppSummary, 'runtime'> & {
  readonly runtime: {
    readonly kind: 'process';
    readonly status: 'running';
  };
};

export interface MiniAppOpenResult extends MiniAppTargetResult {
  readonly miniApp: MiniAppRunningSummary;
  readonly opened: true;
}

export interface MiniAppActionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
}

export interface MiniAppTargetActionContext extends MiniAppActionContext {
  readonly pluginId: string;
}

export interface MiniAppOpenActionContext extends MiniAppTargetActionContext {
  readonly path?: string;
}

export interface MiniAppPublishActionContext extends MiniAppTargetActionContext {
  readonly sourcePath?: string;
}

/** Consumer-owned seam implemented only by a Host that owns a real Mini App lifecycle. */
export interface MiniAppLifecycle {
  /** Returns accepted, enabled Mini Apps with their current runtime state. */
  list(input: MiniAppActionContext): Promise<MiniAppListResult>;
  /** Scaffolds or binds the deterministic package root in the current Session workspace for authoring. */
  init(input: MiniAppTargetActionContext): Promise<MiniAppInitResult>;
  open(input: MiniAppOpenActionContext): Promise<MiniAppOpenResult>;
  /** Reads the current or latest run and bounded Host diagnostics without starting its runtime. */
  inspect(input: MiniAppTargetActionContext): Promise<MiniAppInspectResult>;
  /** Accepts the specified finished package directory or current Session workspace package and starts its runtime. */
  publish(input: MiniAppPublishActionContext): Promise<MiniAppTargetResult>;
  /** Restarts an already installed Mini App runtime without adopting workspace changes. */
  restart(input: MiniAppTargetActionContext): Promise<MiniAppTargetResult>;
  /** Stops an installed Mini App runtime without deleting its package. */
  stop(input: MiniAppTargetActionContext): Promise<MiniAppTargetResult>;
}

export type MiniAppLifecycleErrorCode =
  | 'NOT_FOUND'
  | 'NOT_ENABLED'
  | 'PLUGIN_ALREADY_EXISTS'
  | 'BUSY'
  | 'SERVICE_RESTARTED'
  | 'PREPARATION_FAILED'
  | 'RUNTIME_FAILED'
  | 'OPEN_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'CANCELLED';

export type MiniAppBusyReason = 'operation_busy' | 'capacity_busy';

export interface MiniAppRuntimeErrorDetail {
  readonly errorText: string;
  readonly stderr?: string;
}

type MiniAppLifecycleErrorInput = {
  readonly message: string;
  readonly retryable: boolean;
  readonly diagnosticReason?: MiniAppFailureReasonCode;
  readonly runtimeError?: MiniAppRuntimeErrorDetail;
} & (
  | { readonly code: 'BUSY'; readonly busyReason: MiniAppBusyReason }
  | {
      readonly code: 'INTERNAL_ERROR';
      readonly busyReason?: never;
      readonly diagnosticId: string;
      readonly lastGoodAvailable?: boolean;
    }
  | {
      readonly code: Exclude<MiniAppLifecycleErrorCode, 'BUSY' | 'INTERNAL_ERROR'>;
      readonly busyReason?: never;
      readonly diagnosticId?: never;
      readonly lastGoodAvailable?: never;
    }
);

export class MiniAppLifecycleError extends Error {
  override readonly name = 'MiniAppLifecycleError';
  readonly code: MiniAppLifecycleErrorCode;
  readonly retryable: boolean;
  readonly busyReason?: MiniAppBusyReason;
  readonly diagnosticReason?: MiniAppFailureReasonCode;
  readonly runtimeError?: MiniAppRuntimeErrorDetail;
  readonly diagnosticId?: string;
  readonly lastGoodAvailable?: boolean;

  constructor(input: MiniAppLifecycleErrorInput) {
    super(input.message);
    this.code = input.code;
    const projection = projectMiniAppFailure(input.code, input.diagnosticReason);
    this.retryable =
      input.busyReason === 'capacity_busy' ? false : (projection?.retryable ?? input.retryable);
    if (input.code === 'BUSY') this.busyReason = input.busyReason;
    if (input.code === 'INTERNAL_ERROR') {
      this.diagnosticId = input.diagnosticId;
      if (input.lastGoodAvailable !== undefined) {
        this.lastGoodAvailable = input.lastGoodAvailable;
      }
    }
    if (projection) this.diagnosticReason = projection.diagnostic.reasonCode;
    if (input.runtimeError) this.runtimeError = input.runtimeError;
  }
}

type MiniAppInput = Static<typeof MiniAppActionInputSchema>;
type MiniAppAction = MiniAppInput['action'];
type MiniAppReportedAction = MiniAppAction | 'unknown';

/** Creates the host extension only when a real Mini App lifecycle adapter is available. */
export function createMiniAppControlExtension(lifecycle: MiniAppLifecycle): AgentExtension {
  const tool = createMiniAppTool(lifecycle);
  return {
    id: 'miniapp-control',
    description: 'Host-owned Mini App bootstrap and runtime lifecycle control.',
    init(api) {
      api.registerTool((context) => (exposesMiniAppControl(context) ? tool : null));
    },
  };
}

/**
 * The model-facing `miniapp` definition. Hosts without a Mini App runtime reuse
 * it for a refusal tool, so every surface lists the same name and schema.
 */
export const MINIAPP_TOOL_DEFINITION = {
  name: 'miniapp',
  description:
    "Initialize, list, open, inspect, publish, restart, or stop a Mini App. Init scaffolds or binds the package root in the current Session workspace for authoring without publishing it. Open accepts an optional origin-relative path with a query string to select a page in the current Session's Mini App tab. Inspect returns the installed Mini App's source (official or local) and runtime state. Inspect reads the current or latest run and bounded Host diagnostics without starting the runtime; diagnostics are kept in Host memory and exclude business logs and raw stdout/stderr. Before editing an installed Mini App, inspect its source; official Plugin implementations do not support local editing or republishing. Use miniapp-creator for authoring and recovery guidance. Publish starts or replaces the runtime. Init is not required for a complete package directory. Restart restarts an installed runtime. Stop releases an installed runtime without deleting its Mini App package; use the Mini App Plugin's own Skills, MCP servers, and Connectors for business operations.",
  schema: MiniAppProviderInputSchema,
} as const;

function createMiniAppTool(lifecycle: MiniAppLifecycle) {
  return defineRuntimeTool({
    ...MINIAPP_TOOL_DEFINITION,
    source: 'builtin',
    operationClassifier: {
      allowedValues: MINIAPP_ACTIONS,
      classify: (input) => readRecord(input).action as string | undefined,
    },
    execute: async (context, rawInput, signal) => {
      const action = readMiniAppAction(rawInput);
      if (signal?.aborted) return errorResult(action, cancelledError());
      if (!Value.Check(MiniAppActionInputSchema, rawInput)) {
        return errorResult(action, invalidArgumentsError(action, rawInput));
      }
      const input = rawInput as MiniAppInput;
      try {
        const result = await untilAborted(
          dispatch(lifecycle, input, {
            sessionId: context.sessionId,
            turnId: context.turnId,
            ...(signal ? { signal } : {}),
          }),
          signal,
        );
        return successResult(input.action, result);
      } catch (error) {
        return errorResult(input.action, normalizeError(error, signal));
      }
    },
  });
}

/**
 * Ends the call as soon as the Turn is stopped. A Host step that has not reached its own
 * cancellation check (a Mini App runtime that never answers) would otherwise hold the Turn
 * open after the user pressed stop. The step keeps the same signal and settles on its own;
 * its late outcome is dropped.
 */
function untilAborted<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

async function dispatch(
  lifecycle: MiniAppLifecycle,
  input: MiniAppInput,
  context: MiniAppActionContext,
): Promise<MiniAppListResult | MiniAppInitResult | MiniAppOpenResult | MiniAppTargetResult> {
  if (input.action === 'list') return lifecycle.list(context);
  const target = { ...context, pluginId: input.pluginId };
  switch (input.action) {
    case 'init':
      return lifecycle.init(target);
    case 'open':
      return lifecycle.open({
        ...target,
        ...(input.path !== undefined ? { path: input.path } : {}),
      });
    case 'inspect':
      return lifecycle.inspect(target);
    case 'publish':
      return lifecycle.publish({
        ...target,
        ...(input.sourcePath !== undefined ? { sourcePath: input.sourcePath } : {}),
      });
    case 'restart':
      return lifecycle.restart(target);
    case 'stop':
      return lifecycle.stop(target);
  }
}

function successResult(
  action: MiniAppAction,
  result: MiniAppListResult | MiniAppInitResult | MiniAppOpenResult | MiniAppTargetResult,
) {
  const response = { ok: true as const, action, result };
  const text = JSON.stringify(response);
  return {
    tool_name: 'miniapp',
    text,
    content: [{ type: 'text' as const, text }],
    details: response,
  };
}

interface StableToolError {
  readonly code: MiniAppLifecycleErrorCode | 'INVALID_ARGUMENTS';
  readonly message: string;
  readonly retryable: boolean;
  readonly busyReason?: MiniAppBusyReason;
  readonly diagnostic?: MiniAppFailureDiagnostic;
  readonly runtimeError?: MiniAppRuntimeErrorDetail;
  readonly diagnosticId?: string;
  readonly lastGoodAvailable?: boolean;
}

function errorResult(action: MiniAppReportedAction, error: StableToolError) {
  const response = { ok: false as const, action, error };
  const text = JSON.stringify(response);
  return {
    tool_name: 'miniapp',
    text,
    content: [{ type: 'text' as const, text }],
    details: response,
    isError: true as const,
  };
}

function normalizeError(error: unknown, signal: AbortSignal | undefined): StableToolError {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return cancelledError();
  }
  if (isKnownLifecycleError(error)) {
    const projection = projectMiniAppFailure(error.code, error.diagnosticReason);
    const runtimeError = error instanceof MiniAppLifecycleError ? error.runtimeError : undefined;
    if (projection) {
      return {
        code: error.code,
        ...projection,
        ...(runtimeError ? { runtimeError } : {}),
      };
    }
    if (error.code === 'INTERNAL_ERROR') {
      return {
        code: error.code,
        message: MINIAPP_RECORDED_INTERNAL_ERROR_MESSAGE,
        retryable: false,
        diagnosticId: error.diagnosticId,
        ...(error.lastGoodAvailable !== undefined
          ? { lastGoodAvailable: error.lastGoodAvailable }
          : {}),
      };
    }
    return {
      code: error.code,
      message: MINIAPP_PUBLIC_ERROR_MESSAGES[error.code],
      retryable:
        error.busyReason === 'capacity_busy'
          ? false
          : stableRetryability(error.code, error.retryable),
      ...(error.busyReason ? { busyReason: error.busyReason } : {}),
      ...(runtimeError ? { runtimeError } : {}),
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: MINIAPP_PUBLIC_ERROR_MESSAGES.INTERNAL_ERROR,
    retryable: false,
  };
}

const MINIAPP_PUBLIC_ERROR_MESSAGES: Readonly<Record<MiniAppLifecycleErrorCode, string>> = {
  NOT_FOUND: 'Mini App was not found.',
  NOT_ENABLED: 'Mini App is not enabled.',
  PLUGIN_ALREADY_EXISTS: 'Mini App Plugin is already installed.',
  BUSY: 'Mini App is busy.',
  SERVICE_RESTARTED: 'Mini App service restarted.',
  PREPARATION_FAILED: 'Mini App preparation failed.',
  RUNTIME_FAILED: 'Mini App runtime failed.',
  OPEN_UNAVAILABLE: 'Mini App open is unavailable.',
  INTERNAL_ERROR: 'The Mini App host could not complete the action.',
  CANCELLED: 'The Mini App action was cancelled.',
};

const MINIAPP_RECORDED_INTERNAL_ERROR_MESSAGE =
  'The Mini App Host could not complete this action. A diagnostic ID was created automatically.';

function stableRetryability(code: MiniAppLifecycleErrorCode, fallback: boolean): boolean {
  if (code === 'BUSY' || code === 'SERVICE_RESTARTED') return true;
  if (code === 'PLUGIN_ALREADY_EXISTS' || code === 'PREPARATION_FAILED') return false;
  return fallback;
}

function cancelledError(): StableToolError {
  return {
    code: 'CANCELLED',
    message: 'The Mini App action was cancelled.',
    retryable: false,
  };
}

function invalidArgumentsError(action: MiniAppReportedAction, input: unknown): StableToolError {
  const record = readRecord(input);
  let message = 'Mini App arguments are invalid for the selected action.';
  if (action === 'list' && Object.prototype.hasOwnProperty.call(record, 'pluginId')) {
    message = 'pluginId must be omitted for the list action.';
  } else if (
    action !== 'unknown' &&
    action !== 'publish' &&
    Object.prototype.hasOwnProperty.call(record, 'sourcePath')
  ) {
    message = 'sourcePath is only accepted for the publish action.';
  } else if (
    action !== 'unknown' &&
    action !== 'list' &&
    !Object.prototype.hasOwnProperty.call(record, 'pluginId')
  ) {
    message = 'pluginId is required for this Mini App action.';
  }
  return {
    code: 'INVALID_ARGUMENTS',
    message,
    retryable: false,
  };
}

function readMiniAppAction(input: unknown): MiniAppReportedAction {
  const action = readRecord(input).action;
  return typeof action === 'string' && (MINIAPP_ACTIONS as readonly string[]).includes(action)
    ? (action as MiniAppAction)
    : 'unknown';
}

/** Interactive turns get the `miniapp` control tool, except inside a session a Mini App started. */
function exposesMiniAppControl(context: ModelContextAssemblyCtx): boolean {
  // Such a session must not init / publish / open Mini Apps (including itself).
  if (context.sessionOrigin?.miniApp) return false;
  const config = readRecord(context.agentConfig);
  const profile = readRecord(config.agent_profile);
  return profile.surface === 'interactive';
}

function isKnownLifecycleError(error: unknown): error is {
  readonly code: MiniAppLifecycleErrorCode;
  readonly retryable: boolean;
  readonly busyReason?: MiniAppBusyReason;
  readonly diagnosticReason?: unknown;
  readonly diagnosticId?: string;
  readonly lastGoodAvailable?: boolean;
} {
  if (!(error instanceof Error) || error.name !== 'MiniAppLifecycleError') return false;
  const candidate = error as Error & {
    readonly code?: unknown;
    readonly retryable?: unknown;
    readonly busyReason?: unknown;
    readonly diagnosticReason?: unknown;
    readonly diagnosticId?: unknown;
    readonly lastGoodAvailable?: unknown;
  };
  return (
    typeof candidate.code === 'string' &&
    candidate.code in MINIAPP_PUBLIC_ERROR_MESSAGES &&
    typeof candidate.retryable === 'boolean' &&
    validBusyReason(candidate.code, candidate.busyReason) &&
    validInternalDiagnostic(candidate.code, candidate.diagnosticId, candidate.lastGoodAvailable)
  );
}

function validBusyReason(code: string, value: unknown): value is MiniAppBusyReason | undefined {
  if (code === 'BUSY') return value === 'operation_busy' || value === 'capacity_busy';
  return value === undefined;
}

function validInternalDiagnostic(
  code: string,
  diagnosticId: unknown,
  lastGoodAvailable: unknown,
): boolean {
  if (code === 'INTERNAL_ERROR') {
    return (
      typeof diagnosticId === 'string' &&
      diagnosticId.length > 0 &&
      (lastGoodAvailable === undefined || typeof lastGoodAvailable === 'boolean')
    );
  }
  return diagnosticId === undefined && lastGoodAvailable === undefined;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}
