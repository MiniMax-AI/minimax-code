import { randomUUID } from 'node:crypto';

import {
  MiniAppLifecycleError,
  type MiniAppActionContext,
  type MiniAppTargetResult,
  type MiniAppBusyReason,
  type MiniAppFailureReasonCode,
  type MiniAppInitResult,
  type MiniAppLifecycle,
  type MiniAppListResult,
  type MiniAppOpenResult,
  type MiniAppPublishActionContext,
  type MiniAppRuntimeErrorDetail,
  type MiniAppSummary,
  type MiniAppTargetActionContext,
} from '@mavis/agent-extension';

import {
  MiniAppError,
  miniAppBusyReason,
  readMiniAppRuntimeErrorDetail,
  type MiniAppSupervisor,
} from '../../service/miniapp/index.js';
import {
  PluginSystemError,
  type AcceptedMiniApp,
  type AvailableMiniAppDefinition,
  type MiniAppPluginControl,
} from '../../service/plugin-system/index.js';
import type { MiniAppPresenter } from './process-local-application-contract.js';

type MiniAppStatus = ReturnType<MiniAppSupervisor['inspect']>[number];

interface SessionWorkspaceRepository {
  get(sessionId: string): Promise<{ readonly workspaceDir: string } | undefined>;
}

interface MiniAppActionDiagnosticRecord {
  readonly diagnosticId: string;
  readonly action: 'init' | 'publish';
  readonly sessionId: string;
  readonly turnId: string;
  readonly pluginId: string;
  readonly lastGoodAvailable?: boolean;
  readonly failureChain: readonly {
    readonly name: 'PluginSystemError' | 'MiniAppError';
    readonly code: string;
    readonly reasonCode?: string;
  }[];
}

interface MiniAppActionDiagnostics {
  record(input: MiniAppActionDiagnosticRecord): void;
}

interface SessionMiniAppLifecycleOptions {
  readonly surface?: MiniAppPresenter;
  readonly diagnostics?: MiniAppActionDiagnostics;
}

/** Host-owned adapter from Agent actions to the accepted Plugin/Supervisor projection. */
export function createSessionMiniAppLifecycle(
  plugins: MiniAppPluginControl,
  supervisor: Pick<MiniAppSupervisor, 'inspect'> | undefined,
  sessions: SessionWorkspaceRepository,
  options: SessionMiniAppLifecycleOptions = {},
): MiniAppLifecycle | undefined {
  if (!supervisor) return undefined;
  const { surface, diagnostics } = options;
  const definition = async (pluginId: string): Promise<AvailableMiniAppDefinition> => {
    const miniApp = (await plugins.listAvailableMiniApps()).find(
      (candidate) => candidate.pluginId === pluginId,
    );
    if (!miniApp) throw lifecycleError('NOT_FOUND');
    return miniApp;
  };
  const inspectDefinition = (miniApp: AvailableMiniAppDefinition): MiniAppTargetResult => ({
    miniApp: summary(miniApp, statusByPlugin(supervisor.inspect()).get(miniApp.pluginId)),
  });
  const publishFromSession = async (
    context: MiniAppPublishActionContext,
  ): Promise<MiniAppTargetResult> => {
    try {
      const session = await sessions.get(context.sessionId);
      if (!session?.workspaceDir) throw lifecycleError('NOT_FOUND');
      const acceptedMiniApp = await plugins.publishWorkspaceMiniApp({
        workspaceRoot: session.workspaceDir,
        pluginId: context.pluginId,
        ...(context.sourcePath !== undefined ? { sourcePath: context.sourcePath } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      return {
        miniApp: summary(
          definitionFromAccepted(acceptedMiniApp),
          statusByPlugin(supervisor.inspect()).get(acceptedMiniApp.candidate.pluginId),
        ),
      };
    } catch (error) {
      throw normalizeLifecycleError(error, context.signal, () =>
        internalLifecycleError(
          recordInternalFailure(diagnostics, {
            action: 'publish',
            context,
            error,
            lastGoodAvailable: plugins.isAcceptedMiniAppRunning(context.pluginId),
          }),
        ),
      );
    }
  };
  const initializeFromSessionWorkspace = async (
    context: MiniAppTargetActionContext,
  ): Promise<MiniAppInitResult> => {
    try {
      const session = await sessions.get(context.sessionId);
      if (!session?.workspaceDir) throw lifecycleError('NOT_FOUND');
      return await plugins.initializeWorkspaceMiniApp({
        workspaceRoot: session.workspaceDir,
        pluginId: context.pluginId,
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      throw normalizeLifecycleError(error, context.signal, () =>
        internalLifecycleError(
          recordInternalFailure(diagnostics, {
            action: 'init',
            context,
            error,
          }),
        ),
      );
    }
  };

  return {
    list: async (_context: MiniAppActionContext): Promise<MiniAppListResult> => {
      const definitions = await plugins.listAvailableMiniApps();
      const statuses = statusByPlugin(supervisor.inspect());
      return {
        miniApps: definitions.map((miniApp) => summary(miniApp, statuses.get(miniApp.pluginId))),
      };
    },
    init: initializeFromSessionWorkspace,
    inspect: async (context: MiniAppTargetActionContext) => ({
      ...(await inspectDefinition(await definition(context.pluginId))),
      diagnostics: { scope: 'host' as const, retention: 'runtime-memory' as const, logs: { entries: [], truncated: false, omittedCount: 0 } },
    }),
    open: async (context: MiniAppTargetActionContext): Promise<MiniAppOpenResult> => {
      if (!surface) throw lifecycleError('OPEN_UNAVAILABLE');
      const miniApp = await definition(context.pluginId);
      try {
        await plugins.activateMiniApp({
          pluginId: context.pluginId,
          ...(context.signal ? { signal: context.signal } : {}),
        });
      } catch (error) {
        throw normalizeRuntimeError(error, context.signal);
      }
      try {
        await surface.open({
          sessionId: context.sessionId,
          pluginId: context.pluginId,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { miniApp: runningSummary(miniApp), opened: true };
      } catch (error) {
        throw normalizeSurfaceError(error, context.signal);
      }
    },
    publish: publishFromSession,
    restart: async (context: MiniAppTargetActionContext) => {
      const miniApp = await definition(context.pluginId);
      try {
        const accepted = plugins
          .listAcceptedMiniApps()
          .some(({ candidate }) => candidate.pluginId === context.pluginId);
        await (accepted ? plugins.restartMiniApp : plugins.activateMiniApp)({
          pluginId: context.pluginId,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return inspectDefinition(miniApp);
      } catch (error) {
        throw normalizeRuntimeError(error, context.signal);
      }
    },
    stop: async (context: MiniAppTargetActionContext) => {
      const miniApp = await definition(context.pluginId);
      try {
        await plugins.stopMiniApp({
          pluginId: context.pluginId,
          ...(context.signal ? { signal: context.signal } : {}),
        });
      } catch (error) {
        throw normalizeRuntimeError(error, context.signal);
      }
      // PluginSystem has committed the stopped runtime projection. Surface cleanup is an awaited,
      // best-effort consequence and must not turn a committed stop into a false failure.
      try {
        await surface?.close({ pluginId: context.pluginId });
      } catch {
        // Generation loss also performs plugin-global managed-surface cleanup.
      }
      return { miniApp: stoppedSummary(miniApp) };
    },
  };
}

function statusByPlugin(statuses: readonly MiniAppStatus[]): ReadonlyMap<string, MiniAppStatus> {
  return new Map(statuses.map((status) => [status.pluginId, status]));
}

function summary(
  miniApp: AvailableMiniAppDefinition,
  status: MiniAppStatus | undefined,
): MiniAppSummary {
  const runtimeStatus = mapRuntimeStatus(status?.phase);
  return {
    pluginId: miniApp.pluginId,
    source: miniApp.source,
    ...(miniApp.displayName ? { displayName: miniApp.displayName } : {}),
    runtime: {
      kind: 'process',
      status: runtimeStatus,
      ...(runtimeStatus === 'failed' && status?.failureCode
        ? { errorCode: status.failureCode }
        : {}),
    },
  };
}

function runningSummary(miniApp: AvailableMiniAppDefinition): MiniAppOpenResult['miniApp'] {
  return {
    pluginId: miniApp.pluginId,
    source: miniApp.source,
    ...(miniApp.displayName ? { displayName: miniApp.displayName } : {}),
    runtime: { kind: 'process', status: 'running' },
  };
}

function stoppedSummary(miniApp: AvailableMiniAppDefinition): MiniAppSummary {
  return {
    pluginId: miniApp.pluginId,
    source: miniApp.source,
    ...(miniApp.displayName ? { displayName: miniApp.displayName } : {}),
    runtime: { kind: 'process', status: 'stopped' },
  };
}

function definitionFromAccepted(miniApp: AcceptedMiniApp): AvailableMiniAppDefinition {
  return {
    pluginId: miniApp.candidate.pluginId,
    source: miniApp.source,
    ...(miniApp.displayName ? { displayName: miniApp.displayName } : {}),
    ...(miniApp.description ? { description: miniApp.description } : {}),
    ...(miniApp.iconPath ? { iconPath: miniApp.iconPath } : {}),
  };
}

function mapRuntimeStatus(
  phase: MiniAppStatus['phase'] | undefined,
): MiniAppSummary['runtime']['status'] {
  if (phase === 'active') return 'running';
  if (phase === 'starting' || phase === 'preparing') return 'starting';
  if (phase === 'failed' || phase === 'quarantined') return 'failed';
  return 'stopped';
}

function recordInternalFailure(
  diagnostics: MiniAppActionDiagnostics | undefined,
  input: {
    readonly action: 'init' | 'publish';
    readonly context: MiniAppTargetActionContext;
    readonly error: unknown;
    readonly lastGoodAvailable?: boolean;
  },
): { readonly diagnosticId: string; readonly lastGoodAvailable?: boolean } {
  const diagnosticId = `miniapp_${randomUUID().replaceAll('-', '')}`;
  const record = {
    diagnosticId,
    action: input.action,
    sessionId: input.context.sessionId,
    turnId: input.context.turnId,
    pluginId: input.context.pluginId,
    ...(input.lastGoodAvailable !== undefined
      ? { lastGoodAvailable: input.lastGoodAvailable }
      : {}),
    failureChain: hostOwnedFailureChain(input.error),
  } as const;
  try {
    diagnostics?.record(record);
  } catch {
    // Diagnostics are best-effort and must not replace the original action outcome.
  }
  return {
    diagnosticId,
    ...(input.lastGoodAvailable !== undefined
      ? { lastGoodAvailable: input.lastGoodAvailable }
      : {}),
  };
}

function hostOwnedFailureChain(error: unknown): readonly {
  readonly name: 'PluginSystemError' | 'MiniAppError';
  readonly code: string;
  readonly reasonCode?: string;
}[] {
  const chain: {
    name: 'PluginSystemError' | 'MiniAppError';
    code: string;
    reasonCode?: string;
  }[] = [];
  const visited = new Set<unknown>();
  let current = error;
  while (
    chain.length < 8 &&
    (current instanceof PluginSystemError || current instanceof MiniAppError) &&
    !visited.has(current)
  ) {
    visited.add(current);
    const reasonCode = current.reasonCode;
    chain.push({
      name: current instanceof PluginSystemError ? 'PluginSystemError' : 'MiniAppError',
      code: current.code,
      ...(reasonCode ? { reasonCode } : {}),
    });
    current = current.cause;
  }
  return chain;
}

function internalLifecycleError(input: {
  readonly diagnosticId: string;
  readonly lastGoodAvailable?: boolean;
}): MiniAppLifecycleError {
  return new MiniAppLifecycleError({
    code: 'INTERNAL_ERROR',
    message: 'Mini App action failed inside the Host',
    retryable: false,
    diagnosticId: input.diagnosticId,
    ...(input.lastGoodAvailable !== undefined
      ? { lastGoodAvailable: input.lastGoodAvailable }
      : {}),
  });
}

function normalizeLifecycleError(
  error: unknown,
  signal: AbortSignal | undefined,
  internalFailure: () => MiniAppLifecycleError,
): MiniAppLifecycleError {
  return classifyLifecycleError(error, signal) ?? internalFailure();
}

function classifyLifecycleError(
  error: unknown,
  signal: AbortSignal | undefined,
): MiniAppLifecycleError | undefined {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return lifecycleError('CANCELLED');
  }
  if (error instanceof MiniAppLifecycleError) return error;
  const code = hostErrorCode(error);
  return (
    (error instanceof PluginSystemError ? publicationPluginError(error) : undefined) ??
    stableRunError(code, error) ??
    stablePreparationRunError(error) ??
    preparationLifecycleError(error)
  );
}

function preparationLifecycleError(error: unknown): MiniAppLifecycleError | undefined {
  const runtimeError = preparationRuntimeError(error);
  const diagnosticReason =
    preparationFailureReason(error) ?? (runtimeError ? 'RUNTIME_START_FAILED' : undefined);
  if (!diagnosticReason) return undefined;
  return lifecycleError('PREPARATION_FAILED', diagnosticReason, undefined, runtimeError);
}

function normalizeRuntimeError(
  error: unknown,
  signal: AbortSignal | undefined,
): MiniAppLifecycleError {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return lifecycleError('CANCELLED');
  }
  if (error instanceof MiniAppLifecycleError) return error;
  const code = hostErrorCode(error);
  const pluginError = error instanceof PluginSystemError ? runtimePluginError(code) : undefined;
  return (
    pluginError ??
    stableRunError(code, error) ??
    lifecycleError('RUNTIME_FAILED', undefined, undefined, readMiniAppRuntimeErrorDetail(error))
  );
}

function normalizeSurfaceError(
  error: unknown,
  signal: AbortSignal | undefined,
): MiniAppLifecycleError {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return lifecycleError('CANCELLED');
  }
  if (error instanceof MiniAppLifecycleError) return error;
  const code = hostErrorCode(error);
  if (code === 'not_found') return lifecycleError('NOT_FOUND');
  if (code === 'busy') return lifecycleBusyError(error);
  return lifecycleError('RUNTIME_FAILED');
}

function hostErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Error & { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

const PREPARATION_REASON_BY_HOST_CODE: Readonly<Record<string, MiniAppFailureReasonCode>> = {
  PLUGIN_MANIFEST_MISSING: 'WORKSPACE_PLUGIN_INVALID',
  MANIFEST_SCHEMA_INVALID: 'WORKSPACE_PLUGIN_INVALID',
  PLUGIN_JSON_INVALID: 'WORKSPACE_PLUGIN_INVALID',
  PLUGIN_ROOT_INVALID: 'WORKSPACE_PLUGIN_INVALID',
  PLUGIN_ROOT_SYMLINK: 'WORKSPACE_PLUGIN_INVALID',
  PLUGIN_FILE_INVALID: 'WORKSPACE_PLUGIN_INVALID',
  PLUGIN_FILE_NOT_FOUND: 'WORKSPACE_PLUGIN_INVALID',
  PLUGIN_FILE_TOO_LARGE: 'WORKSPACE_PLUGIN_INVALID',
  PLUGIN_DIRECTORY_INVALID: 'WORKSPACE_PLUGIN_INVALID',
  PLUGIN_DIRECTORY_NOT_FOUND: 'WORKSPACE_PLUGIN_INVALID',
  PLUGIN_PATH_NOT_FOUND: 'WORKSPACE_PLUGIN_INVALID',
  PLUGIN_FILE_CHANGED: 'WORKSPACE_CHANGED',
  PLUGIN_TEXT_BOM_NOT_ALLOWED: 'WORKSPACE_PLUGIN_INVALID',
  PLUGIN_TEXT_INVALID_UTF8: 'WORKSPACE_PLUGIN_INVALID',
  WORKSPACE_CANDIDATE_INVALID: 'WORKSPACE_PLUGIN_INVALID',
  MINIAPP_SOURCE_UNAVAILABLE: 'MINIAPP_SOURCE_UNAVAILABLE',
  MINIAPP_SOURCE_INVALID: 'MINIAPP_SOURCE_INVALID',
  MINIAPP_SOURCE_IDENTITY_MISMATCH: 'MINIAPP_SOURCE_IDENTITY_MISMATCH',
  MINIAPP_SOURCE_OVERLAP: 'MINIAPP_SOURCE_OVERLAP',
  MINIAPP_WORKSPACE_CANDIDATE_MISSING: 'MINIAPP_WORKSPACE_CANDIDATE_MISSING',
  MINIAPP_MCODE_SCHEMA_INVALID: 'MINIAPP_REFERENCE_INVALID',
  MINIAPP_MANIFEST_INVALID: 'MINIAPP_MANIFEST_INVALID',
  MINIAPP_MANIFEST_SCHEMA_INVALID: 'MINIAPP_MANIFEST_INVALID',
  MINIAPP_CONTRIBUTION_MISSING: 'MINIAPP_MANIFEST_INVALID',
  MINIAPP_PATH_INVALID: 'MINIAPP_MANIFEST_INVALID',
  MINIAPP_ROUTE_PATH_INVALID: 'MINIAPP_MANIFEST_INVALID',
  MINIAPP_ARTIFACTS_INVALID: 'MINIAPP_ARTIFACTS_INVALID',
  MINIAPP_ARTIFACTS_EXCLUDED: 'MINIAPP_ARTIFACTS_INVALID',
  MINIAPP_RUNTIME_INVALID: 'MINIAPP_RUNTIME_INVALID',
  MINIAPP_RUNTIME_ENTRY_NOT_ARTIFACT: 'MINIAPP_RUNTIME_ENTRY_INVALID',
  MINIAPP_SURFACE_INVALID: 'MINIAPP_SURFACE_INVALID',
  MINIAPP_MCP_ENDPOINTS_INVALID: 'MINIAPP_MCP_ENDPOINTS_INVALID',
  MINIAPP_HOST_CONNECTOR_ACCESS_INVALID: 'MINIAPP_CONNECTOR_ACCESS_INVALID',
  WORKSPACE_INSTALL_FAILED: 'WORKSPACE_INSTALL_FAILED',
  CANDIDATE_CHANGED: 'WORKSPACE_CHANGED',
  RUNNER_START_FAILED: 'RUNTIME_START_FAILED',
  ENTRY_OUTSIDE_ARTIFACT: 'MINIAPP_RUNTIME_ENTRY_INVALID',
  START_EXPORT_MISSING: 'RUNTIME_START_EXPORT_MISSING',
  RUNNER_LIFECYCLE_INVALID: 'RUNTIME_LIFECYCLE_INVALID',
  READINESS_TIMEOUT: 'RUNTIME_NOT_READY',
  TCP_CONNECT_TIMEOUT: 'RUNTIME_NOT_READY',
  RUNNER_EXITED: 'RUNTIME_NOT_READY',
  MINIAPP_MCP_RUNTIME_NOT_READY: 'MCP_PUBLICATION_INVALID',
  MINIAPP_MCP_SERVER_MISSING: 'MCP_PUBLICATION_INVALID',
  HOST_CONNECTOR_UNAVAILABLE: 'HOST_CONNECTOR_UNAVAILABLE',
  HOST_CONNECTOR_PROTOCOL_VIOLATION: 'HOST_CONNECTOR_PROTOCOL_INVALID',
  NO_CANDIDATE_PORT: 'HOST_CAPACITY_UNAVAILABLE',
};

const PREPARATION_DIAGNOSTIC_ERROR_CODES = new Set([
  'WORKSPACE_CANDIDATE_INVALID',
  'WORKSPACE_INSTALL_FAILED',
  'MINIAPP_PREPARATION_FAILED',
]);

function preparationFailureReason(error: unknown): MiniAppFailureReasonCode | undefined {
  const code = hostErrorCode(error);
  if (!isPluginSystemErrorLike(error, code)) return undefined;
  const reasonCode = hostErrorReasonCode(error);
  return reasonCode ? PREPARATION_REASON_BY_HOST_CODE[reasonCode] : undefined;
}

function isPluginSystemErrorLike(error: unknown, code: string | undefined): error is Error {
  return (
    error instanceof Error &&
    (error instanceof PluginSystemError || error.name === 'PluginSystemError') &&
    code !== undefined &&
    PREPARATION_DIAGNOSTIC_ERROR_CODES.has(code)
  );
}

function hostErrorReasonCode(error: Error): string | undefined {
  const reasonCode = (error as Error & { readonly reasonCode?: unknown }).reasonCode;
  return typeof reasonCode === 'string' ? reasonCode : undefined;
}

function preparationRuntimeError(error: unknown): MiniAppRuntimeErrorDetail | undefined {
  if (!(error instanceof PluginSystemError) || error.code !== 'MINIAPP_PREPARATION_FAILED') {
    return undefined;
  }
  return readMiniAppRuntimeErrorDetail(error.cause);
}

function publicationPluginError(error: PluginSystemError): MiniAppLifecycleError | undefined {
  const { code } = error;
  if (code === 'PLUGIN_NOT_FOUND') return lifecycleError('NOT_FOUND');
  if (code === 'PLUGIN_NOT_ENABLED') return lifecycleError('NOT_ENABLED');
  if (code === 'PLUGIN_ALREADY_EXISTS') {
    return lifecycleError(
      'PLUGIN_ALREADY_EXISTS',
      error.reasonCode === 'OFFICIAL_PLUGIN_READ_ONLY' ? error.reasonCode : undefined,
    );
  }
  return undefined;
}

function runtimePluginError(code: string | undefined): MiniAppLifecycleError | undefined {
  if (code === 'PLUGIN_NOT_FOUND' || code === 'MINIAPP_NOT_AVAILABLE') {
    return lifecycleError('NOT_FOUND');
  }
  if (code === 'PLUGIN_NOT_ENABLED') return lifecycleError('NOT_ENABLED');
  return undefined;
}

function stableRunError(
  code: string | undefined,
  error: unknown,
): MiniAppLifecycleError | undefined {
  if (code === 'BUSY') return lifecycleBusyError(error);
  if (code === 'PUBLICATION_SUPERSEDED' || code === 'SERVICE_RESTARTED') {
    return lifecycleError('SERVICE_RESTARTED');
  }
  return undefined;
}

function stablePreparationRunError(error: unknown): MiniAppLifecycleError | undefined {
  if (!(error instanceof Error)) return undefined;
  const reasonCode = hostErrorReasonCode(error);
  return reasonCode === 'PUBLICATION_SUPERSEDED' ? lifecycleError('SERVICE_RESTARTED') : undefined;
}

function lifecycleBusyError(error: unknown): MiniAppLifecycleError {
  return lifecycleError('BUSY', undefined, miniAppBusyReason(error) ?? 'operation_busy');
}

function lifecycleError(
  code:
    | 'NOT_FOUND'
    | 'NOT_ENABLED'
    | 'PLUGIN_ALREADY_EXISTS'
    | 'BUSY'
    | 'SERVICE_RESTARTED'
    | 'PREPARATION_FAILED'
    | 'RUNTIME_FAILED'
    | 'OPEN_UNAVAILABLE'
    | 'CANCELLED',
  diagnosticReason?: MiniAppFailureReasonCode,
  busyKind?: MiniAppBusyReason,
  runtimeError?: MiniAppRuntimeErrorDetail,
): MiniAppLifecycleError {
  const retryable = code === 'BUSY' || code === 'SERVICE_RESTARTED' || code === 'RUNTIME_FAILED';
  if (code === 'BUSY') {
    return new MiniAppLifecycleError({
      code,
      message: 'Mini App action failed',
      retryable,
      busyReason: busyKind ?? 'operation_busy',
      ...(diagnosticReason ? { diagnosticReason } : {}),
      ...(runtimeError ? { runtimeError } : {}),
    });
  }
  return new MiniAppLifecycleError({
    code,
    message: 'Mini App action failed',
    retryable,
    ...(diagnosticReason ? { diagnosticReason } : {}),
    ...(runtimeError ? { runtimeError } : {}),
  });
}
