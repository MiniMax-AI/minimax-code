import {
  BashExecutionError,
  type BashExecutionOutcome,
  type BashToolDetails,
} from '@earendil-works/pi-coding-agent/tools';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';

import type { LocalBackgroundBashExecutorResult } from './types.js';

export interface LocalBashExecutionOutcome extends Omit<BashExecutionOutcome, 'reason'> {
  reason: BashExecutionOutcome['reason'] | 'preflight_failed' | 'watchdog_timeout';
}

export function localBashResultFromPi(
  result: AgentToolResult<unknown>,
): LocalBackgroundBashExecutorResult {
  const details = (result.details ?? {}) as Record<string, unknown>;
  const execution = readBashExecutionOutcome(details);
  return {
    text: result.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n'),
    details,
    ...(execution && execution.status !== 'succeeded' ? { isError: true } : {}),
  };
}

export function localBashResultFromError(
  error: unknown,
  signal?: AbortSignal,
): LocalBackgroundBashExecutorResult {
  const details: BashToolDetails = error instanceof BashExecutionError ? error.details : {};
  const cause = error instanceof BashExecutionError ? error.cause : error;
  const causeRecord =
    cause && typeof cause === 'object' ? (cause as Record<string, unknown>) : undefined;
  const errorCode = typeof causeRecord?.code === 'string' ? causeRecord.code : undefined;
  const preflight =
    errorCode?.startsWith('SANDBOX_') &&
    (causeRecord?.stage === undefined ||
      ['init', 'parse', 'invocation', 'pre-spawn'].includes(String(causeRecord.stage)));
  const text = error instanceof Error ? error.message : String(error);
  const execution: LocalBashExecutionOutcome = {
    status: signal?.aborted ? 'canceled' : 'failed',
    reason: signal?.aborted ? 'canceled' : 'unknown',
    exitCode: null,
    message: text,
    ...(errorCode ? { errorCode } : {}),
    ...details.execution,
    ...(preflight ? { reason: 'preflight_failed' as const } : {}),
  };
  if (execution.status === 'canceled' && !execution.cancellationReason && signal?.aborted) {
    execution.cancellationReason =
      signal.reason instanceof Error
        ? signal.reason.message
        : typeof signal.reason === 'string'
          ? signal.reason
          : undefined;
  }
  return { text, details: { ...details, execution }, isError: true };
}

export function readBashExecutionOutcome(details: unknown): LocalBashExecutionOutcome | undefined {
  if (!details || typeof details !== 'object' || !('execution' in details)) return undefined;
  const execution = details.execution;
  if (!execution || typeof execution !== 'object') return undefined;
  const value = execution as Record<string, unknown>;
  if (
    typeof value.status !== 'string' ||
    !['succeeded', 'failed', 'canceled'].includes(value.status) ||
    typeof value.reason !== 'string' ||
    ![
      'exited',
      'signaled',
      'command_timeout',
      'canceled',
      'spawn_failed',
      'unknown',
      'preflight_failed',
      'watchdog_timeout',
    ].includes(value.reason) ||
    !(
      value.exitCode === null ||
      (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode))
    ) ||
    [value.signal, value.errorCode, value.message, value.cancellationReason].some(
      (field) => field !== undefined && typeof field !== 'string',
    )
  )
    return undefined;
  return execution as LocalBashExecutionOutcome;
}

export function formatBashExecutionOutcome(execution: LocalBashExecutionOutcome): string {
  if (execution.message) return execution.message;
  if (execution.signal) return `Command terminated by signal ${execution.signal}`;
  if (execution.exitCode !== null) return `Command exited with code ${execution.exitCode}`;
  return `Command ${execution.status} (${execution.reason})`;
}
