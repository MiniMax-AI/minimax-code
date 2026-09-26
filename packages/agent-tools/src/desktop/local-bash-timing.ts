import type { ToolResult } from '@mavis/agent-core/tools';

export const DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS = 120;
export const MAX_FOREGROUND_BASH_TIMEOUT_SECONDS = 300;
export const MAX_MANAGED_BASH_TIMEOUT_SECONDS = 3_600;
export const MAX_BASH_TIMEOUT_SECONDS = 2_147_483;
export const DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS = 60_000;

export interface LocalBashTiming {
  commandTimeoutSeconds?: number;
  requestedTimeoutSeconds?: number;
  commandTimerStartedAt?: number;
  commandDeadlineAt?: number;
}

export function resolveLocalBashTiming(
  timeout: number | undefined,
  mode: 'direct_foreground' | 'managed_foreground' | 'explicit_background',
): LocalBashTiming {
  const normalizedTimeout =
    mode === 'managed_foreground' &&
    timeout !== undefined &&
    (!Number.isFinite(timeout) || timeout <= 0)
      ? undefined
      : timeout;
  if (
    normalizedTimeout !== undefined &&
    (!Number.isFinite(normalizedTimeout) ||
      normalizedTimeout <= 0 ||
      (mode !== 'managed_foreground' && normalizedTimeout > MAX_BASH_TIMEOUT_SECONDS))
  ) {
    throw new Error(
      `timeout must be a finite positive number of seconds, at most ${MAX_BASH_TIMEOUT_SECONDS}.`,
    );
  }
  const commandTimeoutSeconds =
    mode === 'explicit_background'
      ? normalizedTimeout
      : mode === 'managed_foreground'
        ? Math.min(
            normalizedTimeout ?? MAX_MANAGED_BASH_TIMEOUT_SECONDS,
            MAX_MANAGED_BASH_TIMEOUT_SECONDS,
          )
        : Math.min(
            normalizedTimeout ?? DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS,
            MAX_FOREGROUND_BASH_TIMEOUT_SECONDS,
          );
  return {
    commandTimeoutSeconds,
    ...(normalizedTimeout !== undefined && normalizedTimeout !== commandTimeoutSeconds
      ? { requestedTimeoutSeconds: normalizedTimeout }
      : {}),
  };
}

export function validateBashCommand(command: string): void {
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error('command must be a non-empty shell command.');
  }
}

export function withLocalBashTiming(result: ToolResult, timing: LocalBashTiming): ToolResult {
  const text =
    timing.requestedTimeoutSeconds !== undefined
      ? `${result.text}\n\n[bash timeout: requested ${timing.requestedTimeoutSeconds}s; effective ${timing.commandTimeoutSeconds}s command limit.]`
      : result.text;
  return {
    ...result,
    text,
    content: [{ type: 'text', text }],
    details: { ...result.details, timing: { ...(result.details?.timing as object), ...timing } },
  };
}
