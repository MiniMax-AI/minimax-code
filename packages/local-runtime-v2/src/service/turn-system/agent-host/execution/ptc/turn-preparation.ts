import type { PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';
import {
  createPtcToolFactCollector,
  type RuntimeTool,
  type ToolExecutionContext,
} from '@mavis/agent-core/tools';

import type { AgentExecutionSnapshot } from '../../preparation/contracts.js';
import type { LocalTurnExecutionInput } from '../../runner/contracts.js';
import { applyProcessLocalToolResultPolicy } from '../../runner/policy/process-local-tool-result-policy.js';
import { observePtcAdmission } from '../../runner/policy/ptc-admission-observability.js';
import { createPtcToolLabeler, createPtcTurnObserver } from '../../runner/ptc/ptc-observability.js';
import type { LocalRuntimeTurnExecutorOptions } from '../contracts.js';
import { isNativeTaskOutputTool, readPtcChildTools, readPtcTurnReminder } from './catalog.js';
import {
  createPtcCompactionReminderRestorer,
  type PtcCompactionReminderHooks,
} from './compaction-reminder.js';

type PtcTurnExecutorOptions = Pick<
  LocalRuntimeTurnExecutorOptions<AgentExecutionSnapshot, ToolExecutionContext>,
  'canAppendExecutionBudgetReminder' | 'logger'
>;

/** The PTC reminder restorer for a Turn; undefined when the Turn has no PTC reminder. */
export function createPtcTurnCompactionReminder(
  input: Pick<LocalTurnExecutionInput, 'assembly' | 'lease'>,
  options: PtcTurnExecutorOptions,
): PtcCompactionReminderHooks | undefined {
  return createPtcCompactionReminderRestorer(
    readPtcReminderForRestore(input, options.logger),
    // Production binds this to fitsReminderInFinalRequest, a generic
    // "does this marker still fit the final request" check.
    options.canAppendExecutionBudgetReminder,
    options.logger,
  );
}

/**
 * buildPtcCatalog registers the reminder on the run_code it creates, and the
 * executor's own PTC wiring (readPtcChildTools) already relies on that object
 * reaching `assembly.tools` unchanged. A PTC Turn without a registered reminder
 * means that chain broke somewhere; say so instead of silently skipping the
 * restore.
 */
function readPtcReminderForRestore(
  input: Pick<LocalTurnExecutionInput, 'assembly' | 'lease'>,
  logger: Pick<PiTurnRunnerLogger, 'warn'> | undefined,
): string | undefined {
  const reminder = readPtcTurnReminder(input.assembly.tools);
  if (reminder === undefined && readPtcChildTools(input.assembly.tools) !== undefined) {
    try {
      logger?.warn?.(
        { session_id: input.lease.sessionId, turn_id: input.lease.turnId },
        'ptc reminder unavailable for compaction restore',
      );
    } catch {
      // Diagnostics must not affect the Turn.
    }
  }
  return reminder;
}

export function preparePtcExecution(
  tools: readonly RuntimeTool[],
  nativeTools: readonly RuntimeTool[],
  options: Pick<
    LocalRuntimeTurnExecutorOptions<AgentExecutionSnapshot, ToolExecutionContext>,
    'cliProductPolicy' | 'createPtcResultProjection' | 'logger' | 'ptcSurface' | 'metricsClient'
  >,
  input: Pick<
    LocalTurnExecutionInput,
    'lease' | 'request' | 'session' | 'assemblyContext' | 'desktopCapabilities'
  >,
) {
  const rawPtcTools = readPtcChildTools(tools);
  const ptcTools = rawPtcTools
    ? applyProcessLocalToolResultPolicy(rawPtcTools, options.cliProductPolicy === true)
    : undefined;
  // The catalog already decided; this records that decision for PTC-mode Session Turns.
  observePtcAdmission(input, ptcTools !== undefined, options);
  const ptcFactCollector = createPtcToolFactCollector();
  const ptcResultProjection = options.createPtcResultProjection?.(ptcFactCollector);
  // Only PTC Turns get an observer, so only they report program-level metrics.
  const ptcObserver = ptcTools ? createTurnObserver(input, options) : undefined;
  return {
    ptcTools,
    canConsumeNativeTaskOutput: (ptcTools ?? nativeTools).some(isNativeTaskOutputTool),
    ptcFactCollector,
    context: {
      ptcFactCollector,
      ...(ptcResultProjection ? { ptcResultProjection } : {}),
      // Only PTC turns get the logger: run_code and direct calls of its children use it.
      ...(ptcTools && options.logger ? { ptcLogger: options.logger } : {}),
      ...(ptcObserver ? { ptcObserver } : {}),
    },
  };
}

function createTurnObserver(
  input: Parameters<typeof preparePtcExecution>[3],
  options: Parameters<typeof preparePtcExecution>[2],
) {
  return createPtcTurnObserver({
    sessionId: input.lease.sessionId,
    turnId: input.lease.turnId,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.metricsClient ? { metricsClient: options.metricsClient } : {}),
    ...(options.ptcSurface ? { surface: options.ptcSurface } : {}),
    labelTool: createPtcToolLabeler(input.desktopCapabilities?.runtimeToolBindings),
  });
}
