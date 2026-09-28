import {
  composePluginHookToolResultContent,
  mergePluginHookContext,
  PluginHookCoordinator,
  PluginHookRunner,
  renderPluginHookRejectionReminder,
} from '@mavis/plugin-hooks';
import { buildRuntimeWarningEvent } from '@mavis/agent-core/event-bridge';
import type { PiEventWriter, TurnEventReporter } from '@mavis/agent-core/pi-turn-runner';
import type {
  PluginHookAdmissionTransaction,
  PluginHookCommandHandler,
  PluginHookDecision,
  PluginHookEventName,
  PluginHookRunResult,
  PluginHookSessionEndFence,
} from '@mavis/plugin-hooks';

import type { AgentExecutionSnapshot } from '../preparation/contracts.js';
import type { LocalTurnExecutionInput } from '../runner/contracts.js';

export {
  composePluginHookToolResultContent,
  mergePluginHookContext,
  renderPluginHookRejectionReminder,
};

type LocalPluginHookEventReporter = TurnEventReporter & {
  readonly terminalSequenceSurface?: 'tui';
};
const sessionReporters = new Map<
  string,
  { readonly reporter: LocalPluginHookEventReporter; readonly turnId: string }
>();

/** Process-local lifecycle owner shared by Desktop turns, compaction, and session actions. */
export const localPluginHookCoordinator = new PluginHookCoordinator(new PluginHookRunner(), {
  onSessionEndResult: reportLocalPluginHookSessionEnd,
});
const SESSION_END_DRAIN_BUDGET_MS = 5_000;
const LOGOUT_FOREGROUND_BUDGET_MS = 5_000;
const MAX_PLUGIN_HOOK_WARNINGS_PER_EVENT = 8;
const warningEmissionStates = new WeakMap<object, WarningEmissionState>();

interface WarningEmissionState {
  readonly seen: Set<string>;
  lane?: Promise<void>;
}

interface LocalPluginHookWarning {
  readonly category: 'runtime-message' | 'system-message' | 'terminal-control' | 'diagnostic';
  readonly message: string;
  readonly code?: string;
  readonly pluginName?: string;
  readonly terminalSequence?: string;
}

export function createLocalPluginHookEventReporter(input: {
  readonly writer: PiEventWriter;
  readonly sessionId: string;
  readonly turnId: string;
  readonly terminalSequenceSurface?: 'tui';
}): LocalPluginHookEventReporter {
  let eventSequence = 0;
  let runtimeSequence = 0;
  return {
    nextEventId: (kind) => `evt_${input.turnId}_${kind}_${++eventSequence}`,
    nextRuntimeSeq: () => ++runtimeSequence,
    appendEvents: async (events) => input.writer.appendEvents(events),
    ...(input.terminalSequenceSurface
      ? { terminalSequenceSurface: input.terminalSequenceSurface }
      : {}),
  };
}

export async function emitLocalPluginHookWarnings(input: {
  readonly reporter?: LocalPluginHookEventReporter;
  readonly sessionId: string;
  readonly turnId: string;
  readonly event: PluginHookEventName | 'SessionStart/UserPromptSubmit';
  readonly result?: PluginHookRunResult;
  readonly decision?: PluginHookDecision;
  readonly message?: string;
}): Promise<void> {
  if (!input.reporter) return;
  const reporter = input.reporter;
  await withWarningEmissionLane(reporter, async (seen) => {
    const decision = input.result?.decision ?? input.decision;
    const warningCandidates: LocalPluginHookWarning[] = [];
    if (input.message) {
      warningCandidates.push({ category: 'runtime-message', message: input.message });
    }
    if (decision?.systemMessage) {
      warningCandidates.push({ category: 'system-message', message: decision.systemMessage });
    }
    if (decision?.terminalSequence) {
      warningCandidates.push(
        reporter.terminalSequenceSurface === 'tui'
          ? {
              category: 'terminal-control',
              message: '',
              terminalSequence: decision.terminalSequence,
            }
          : {
              category: 'terminal-control',
              message:
                'A Plugin Hook requested terminal control output, but this runtime surface does not execute terminal control sequences.',
            },
      );
    }
    warningCandidates.push(
      ...(input.result?.diagnostics ?? []).map((diagnostic) => ({
        category: 'diagnostic' as const,
        message: diagnosticWarningMessage(diagnostic.pluginName, input.event, diagnostic.code),
        code: diagnostic.code,
        pluginName: diagnostic.pluginName,
      })),
    );
    const warnings = warningCandidates.filter(
      (warning) => warning.message.trim().length > 0 || Boolean(warning.terminalSequence),
    );
    const uniqueWarnings = [
      ...new Map(
        warnings.map((warning) => [
          `${warning.category}\u0000${warning.message}\u0000${warning.terminalSequence ?? ''}`,
          warning,
        ]),
      ).values(),
    ]
      // Each Hook invocation may intentionally repeat a user-facing message.
      // Only diagnostics/control notices are deduplicated across invocations.
      .filter(
        (warning) =>
          warning.category === 'system-message' || !seen.has(warningDedupeKey(input, warning)),
      )
      .slice(0, MAX_PLUGIN_HOOK_WARNINGS_PER_EVENT);
    if (uniqueWarnings.length === 0) return;
    try {
      await reporter.appendEvents(
        uniqueWarnings.map((warning) => {
          const eventId = reporter.nextEventId('runtime_warning');
          return buildRuntimeWarningEvent({
            sessionId: input.sessionId,
            turnId: input.turnId,
            eventId,
            runtimeSeq: reporter.nextRuntimeSeq(),
            message: warning.message,
            source: 'plugin-hook',
            category: warning.category,
            hookEvent: input.event,
            ...(warning.code ? { code: warning.code } : {}),
            ...(warning.pluginName ? { pluginName: warning.pluginName } : {}),
            ...(warning.terminalSequence ? { terminalSequence: warning.terminalSequence } : {}),
          });
        }),
      );
      for (const warning of uniqueWarnings.filter((item) => item.category !== 'system-message')) {
        seen.add(warningDedupeKey(input, warning));
      }
    } catch {
      // Warning delivery is best-effort and must not alter Hook control flow.
    }
  });
}

function warningDedupeKey(
  input: { readonly sessionId: string; readonly turnId: string; readonly event: string },
  warning: LocalPluginHookWarning,
): string {
  return [
    input.sessionId,
    input.turnId,
    warning.pluginName ?? '',
    input.event,
    warning.code ?? warning.category,
  ].join('\0');
}

function diagnosticWarningMessage(pluginName: string, event: string, code: string): string {
  const outcome =
    event === 'PreToolUse' || event === 'PermissionRequest' || event === 'PostToolUse'
      ? 'The tool execution and result were not changed by this Hook.'
      : 'The conversation continued without this Hook.';
  if (code === 'HOOK_INVALID_INPUT') {
    return `A compatibility-limited Hook from Plugin "${pluginName}" was skipped during ${event}. ${outcome}`;
  }
  if (code === 'HOOK_TIMEOUT') {
    return `Plugin "${pluginName}" Hook timed out and was skipped during ${event}. ${outcome}`;
  }
  return `Plugin "${pluginName}" Hook could not complete and was skipped during ${event}. ${outcome}`;
}

async function withWarningEmissionLane(
  reporter: object,
  emit: (seen: Set<string>) => Promise<void>,
): Promise<void> {
  let state = warningEmissionStates.get(reporter);
  if (!state) {
    state = { seen: new Set() };
    warningEmissionStates.set(reporter, state);
  }
  const previous = state.lane;
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.lane = current;
  if (previous) await previous;
  try {
    await emit(state.seen);
  } finally {
    release();
    if (state.lane === current) state.lane = undefined;
  }
}

export async function beginLocalPluginHookTurn<TAgent extends AgentExecutionSnapshot>(
  input: LocalTurnExecutionInput<TAgent>,
  runtimeContext: {
    readonly transcriptPath?: string | null;
    readonly codexTranscriptPath?: string | null;
    readonly model?: string;
    readonly permissionMode?: string;
    readonly promptId?: string;
    readonly transcriptCleanup?: () => Promise<void>;
    readonly sessionEndCleanup?: () => Promise<void>;
    readonly sessionOwnershipClaim?: string;
  } = {},
): Promise<
  | {
      readonly kind: 'continue';
      readonly input: LocalTurnExecutionInput<TAgent>;
      readonly transaction: PluginHookAdmissionTransaction;
    }
  | {
      readonly kind: 'stop' | 'deny';
      readonly reason: string;
      readonly transaction: PluginHookAdmissionTransaction;
    }
> {
  const handlers = localPluginHookCoordinator.handlersForTurn(
    input.lease.sessionId,
    input.pluginHooks ?? [],
  );
  const effectiveInput = withEffectivePluginHookHandlers(input, handlers);
  const admitted = await runCoordinatorPluginHookAdmission(input, runtimeContext, handlers);
  const reporterEntry = localAdmissionReporter(input, handlers);
  const transaction = bindLocalAdmissionTransaction(
    input.lease.sessionId,
    admitted.transaction,
    reporterEntry,
  );
  await emitLocalPluginHookWarnings({
    reporter: input.pluginHookEventReporter,
    sessionId: input.lease.sessionId,
    turnId: input.lease.turnId,
    event: 'SessionStart/UserPromptSubmit',
    result: admitted.result,
  });
  if (admitted.result.decision.continue === false) {
    return {
      kind: 'stop',
      reason: admitted.result.decision.stopReason ?? 'Turn stopped by Plugin Hook.',
      transaction,
    };
  }
  if (admitted.result.decision.decision === 'deny') {
    return {
      kind: 'deny',
      reason: admitted.result.decision.reason ?? 'User prompt was rejected by a Plugin Hook.',
      transaction,
    };
  }
  return {
    kind: 'continue',
    transaction,
    input: admitted.result.decision.additionalContext
      ? { ...effectiveInput, pluginHookContext: admitted.result.decision.additionalContext }
      : effectiveInput,
  };
}

function withEffectivePluginHookHandlers<TAgent extends AgentExecutionSnapshot>(
  input: LocalTurnExecutionInput<TAgent>,
  handlers: readonly PluginHookCommandHandler[],
): LocalTurnExecutionInput<TAgent> {
  return handlers === input.pluginHooks ? input : { ...input, pluginHooks: handlers };
}

function localAdmissionReporter<TAgent extends AgentExecutionSnapshot>(
  input: LocalTurnExecutionInput<TAgent>,
  handlers: readonly PluginHookCommandHandler[],
): { readonly reporter: LocalPluginHookEventReporter; readonly turnId: string } | undefined {
  if (input.session.parentSessionId || handlers.length === 0 || !input.pluginHookEventReporter) {
    return undefined;
  }
  return { reporter: input.pluginHookEventReporter, turnId: input.lease.turnId };
}

async function runCoordinatorPluginHookAdmission<TAgent extends AgentExecutionSnapshot>(
  input: LocalTurnExecutionInput<TAgent>,
  runtimeContext: {
    readonly transcriptPath?: string | null;
    readonly codexTranscriptPath?: string | null;
    readonly model?: string;
    readonly permissionMode?: string;
    readonly promptId?: string;
    readonly transcriptCleanup?: () => Promise<void>;
    readonly sessionEndCleanup?: () => Promise<void>;
    readonly sessionOwnershipClaim?: string;
  },
  handlers: readonly PluginHookCommandHandler[],
): Promise<{
  readonly result: PluginHookRunResult;
  readonly transaction?: PluginHookAdmissionTransaction;
}> {
  let transaction: PluginHookAdmissionTransaction | undefined;
  try {
    const result = await localPluginHookCoordinator.beginTurn({
      handlers,
      sessionId: input.lease.sessionId,
      turnId: input.lease.turnId,
      cwd: input.session.workspaceDir,
      ...runtimeContext,
      prompt: input.canonicalUserInput.text,
      resumeExistingSession: input.history.messages.length > 0,
      ...(input.session.parentSessionId ? { sessionStartSource: 'fork' as const } : {}),
      captureAdmissionTransaction: (captured) => {
        transaction = captured;
      },
      signal: input.lease.signal,
    });
    return { result, ...(transaction ? { transaction } : {}) };
  } catch (error) {
    await transaction?.rollback();
    throw error;
  }
}

function bindLocalAdmissionTransaction(
  sessionId: string,
  coordinatorTransaction: PluginHookAdmissionTransaction | undefined,
  reporterEntry:
    | { readonly reporter: LocalPluginHookEventReporter; readonly turnId: string }
    | undefined,
): PluginHookAdmissionTransaction {
  const previousReporter = sessionReporters.get(sessionId);
  if (reporterEntry) sessionReporters.set(sessionId, reporterEntry);
  let settled = false;
  return {
    commit: async () => {
      if (settled) return;
      settled = true;
      await coordinatorTransaction?.commit();
    },
    rollback: async () => {
      if (settled) return;
      settled = true;
      await coordinatorTransaction?.rollback();
      if (!reporterEntry || sessionReporters.get(sessionId) !== reporterEntry) return;
      if (previousReporter) sessionReporters.set(sessionId, previousReporter);
      else sessionReporters.delete(sessionId);
    },
  };
}

export function configureLocalPluginHookObservability(input: {
  readonly logger?: { warn(fields: Readonly<Record<string, unknown>>, message: string): void };
  readonly metrics?: {
    counter(name: string, delta?: number, labels?: Record<string, string>): void;
    histogram(name: string, value: number, labels?: Record<string, string>): void;
  };
}): void {
  localPluginHookCoordinator.configureObservability({
    ...(input.logger ? { logger: input.logger } : {}),
    ...(input.metrics
      ? {
          observer: {
            onHandler: (event) => {
              const labels = {
                runtime: 'desktop',
                event: event.event,
                format: event.format,
                outcome: event.outcome,
              };
              input.metrics?.counter('plugin_hook_handler_total', 1, labels);
              input.metrics?.histogram('plugin_hook_handler_duration_ms', event.durationMs, labels);
              if (event.processKilled) {
                input.metrics?.counter('plugin_hook_process_killed_total', 1, {
                  runtime: 'desktop',
                  reason: event.outcome,
                });
              }
            },
            onEvent: (event) => {
              const labels = { runtime: 'desktop', event: event.event, outcome: event.outcome };
              input.metrics?.counter('plugin_hook_event_total', 1, labels);
              input.metrics?.histogram('plugin_hook_event_duration_ms', event.durationMs, labels);
            },
          },
        }
      : {}),
  });
}

export function configureLocalPluginHookEnabledResolver(resolve: () => ReadonlySet<string>): void {
  localPluginHookCoordinator.setEnabledPluginResolver(resolve);
}

export function configureLocalPluginHookSessionEndFence(
  fence: PluginHookSessionEndFence | undefined,
): void {
  localPluginHookCoordinator.setSessionEndFence(fence);
}

export function deactivateLocalPluginHooks(pluginName: string): void {
  localPluginHookCoordinator.deactivatePlugin(pluginName);
}

export function markNextLocalPluginHookSessionStart(
  sessionId: string,
  source: 'clear' | 'fork',
): void {
  localPluginHookCoordinator.markNextSessionStart(sessionId, source);
}

export async function endLocalPluginHookSession(
  sessionId: string,
  reason: 'archive' | 'clear' | 'resume_other',
  enabledPluginNames?: ReadonlySet<string>,
): Promise<void> {
  await localPluginHookCoordinator.endSession(sessionId, reason, undefined, enabledPluginNames);
}

export async function abortLocalPluginHookSessionTurn(
  sessionId: string,
  abortSession: (sessionId: string) => Promise<unknown>,
): Promise<void> {
  await settleWithin(
    Promise.allSettled(
      localPluginHookCoordinator
        .activeExecutionSessionIds(sessionId)
        .map((executionSessionId) => abortSession(executionSessionId)),
    ),
    SESSION_END_DRAIN_BUDGET_MS,
  );
}

export function endAllLocalPluginHookSessionsForLogout(
  enabledPluginNames?: ReadonlySet<string>,
  abortSession?: (sessionId: string) => Promise<unknown>,
): Promise<void> {
  return settleWithin(
    endAllAfterBoundedAbort(enabledPluginNames, abortSession),
    LOGOUT_FOREGROUND_BUDGET_MS,
  );
}

export function disposeLocalPluginHookSessions(): Promise<void> {
  sessionReporters.clear();
  return localPluginHookCoordinator.dispose();
}

function reportLocalPluginHookSessionEnd(input: {
  readonly sessionId: string;
  readonly result?: PluginHookRunResult;
}): Promise<void> | void {
  const retained = sessionReporters.get(input.sessionId);
  sessionReporters.delete(input.sessionId);
  if (!retained || !input.result) return;
  return emitLocalPluginHookWarnings({
    reporter: retained.reporter,
    sessionId: input.sessionId,
    turnId: retained.turnId,
    event: 'SessionEnd',
    result: input.result,
  });
}

async function endAllAfterBoundedAbort(
  enabledPluginNames: ReadonlySet<string> | undefined,
  abortSession: ((sessionId: string) => Promise<unknown>) | undefined,
): Promise<void> {
  if (abortSession) {
    await settleWithin(
      Promise.allSettled(
        localPluginHookCoordinator
          .activeExecutionSessionIds()
          .map((sessionId) => abortSession(sessionId)),
      ),
      SESSION_END_DRAIN_BUDGET_MS,
    );
  }
  await localPluginHookCoordinator.endAllSessions('logout', undefined, enabledPluginNames);
}

async function settleWithin(value: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    settle(value),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

async function settle(value: Promise<unknown>): Promise<void> {
  try {
    await value;
  } catch {
    // SessionEnd is best-effort; the original lifecycle action must continue.
  }
}
