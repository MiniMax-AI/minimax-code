
import {
  isOutputLimitExhaustedFailure,
  OUTPUT_LIMIT_EXHAUSTED_SUMMARY,
  tuiErrorDiagnostic,
} from '../user-facing-failure.js';
import type { ExecResult } from './contract.js';
import { TuiExecError } from './exit-policy.js';

const OUTPUT_LIMIT_EXHAUSTED_GUIDANCE = `${OUTPUT_LIMIT_EXHAUSTED_SUMMARY} Lower the effort level, then retry.`;

export function formatTuiExecFailure(error: TuiExecError): string {
  if (
    error.kind === 'invocation' ||
    error.kind === 'config' ||
    error.kind === 'cancelled' ||
    error.kind === 'brokenPipe'
  ) {
    return tuiErrorDiagnostic(error);
  }
  if (error.kind === 'runtime') {
    if (isOutputLimitExhaustedFailure(error.message)) return OUTPUT_LIMIT_EXHAUSTED_GUIDANCE;
    return `The run failed: ${tuiErrorDiagnostic(error)}. Retry after the connection recovers.`;
  }
  return `MCode encountered an internal error: ${tuiErrorDiagnostic(error)}. Retry; if it keeps happening, report it through an available support channel.`;
}

export function formatTuiExecResultFailure(result: ExecResult): string {
  if (result.status === 'timeout') {
    return 'The run timed out. Increase --timeout or retry.';
  }
  if (result.status === 'limit_exceeded') {
    return 'The run reached its step limit. Increase --max-steps or narrow the task.';
  }
  if (result.status === 'cancelled') return 'The run was cancelled.';
  if (result.error?.category === 'config') {
    const reason = result.error.message ? `: ${tuiErrorDiagnostic(result.error.message)}` : '';
    return `The run could not start with the current configuration${reason}. Open MCode and run /doctor.`;
  }
  if (result.error?.category === 'internal') {
    const reason = result.error.message ? `: ${tuiErrorDiagnostic(result.error.message)}` : '';
    return `MCode encountered an internal error${reason}. Retry; if it keeps happening, report it through an available support channel.`;
  }
  if (isOutputLimitExhaustedFailure(result.error?.message)) return OUTPUT_LIMIT_EXHAUSTED_GUIDANCE;
  const reason = result.error?.message ? `: ${tuiErrorDiagnostic(result.error.message)}` : '';
  return `The run failed${reason}. Retry after the connection recovers.`;
}
