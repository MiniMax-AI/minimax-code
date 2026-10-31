import { stripVTControlCharacters } from 'node:util';

export interface TuiFailurePresentation {
  readonly message: string;
  readonly diagnostic?: string;
}

export interface PresentTuiFailureOptions {
  readonly summary: string;
  readonly nextStep?: string;
  readonly preservation?: string;
}

const NON_PRINTING_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

export function presentTuiFailure(
  error: unknown,
  options: PresentTuiFailureOptions,
): TuiFailurePresentation {
  const message = [options.summary, options.nextStep, options.preservation]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' ');
  const diagnostic = tuiErrorDiagnostic(error);
  return {
    message,
    ...(diagnostic && diagnostic !== message ? { diagnostic } : {}),
  };
}

export function formatTuiActionFailure(error: unknown, options: PresentTuiFailureOptions): string {
  const summary = options.summary.trim();
  const diagnostic = tuiErrorDiagnostic(error);
  const failure = diagnostic ? `${summary.replace(/[.:;!?]+$/u, '')}: ${diagnostic}` : summary;
  return [failure, options.nextStep, options.preservation]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .map(asSentence)
    .join(' ');
}

/**
 * Failure marker the runtime reports when a response kept hitting the output
 * limit before any visible reply, after its automatic retries.
 */
const OUTPUT_LIMIT_EXHAUSTED_MARKER = 'output_limit_exhausted';

export const OUTPUT_LIMIT_EXHAUSTED_SUMMARY =
  'The model ran out of output space while still thinking and did not finish after several automatic retries.';

export function isOutputLimitExhaustedFailure(message: string | undefined): boolean {
  return message?.trim() === OUTPUT_LIMIT_EXHAUSTED_MARKER;
}

export function tuiErrorDiagnostic(error: unknown): string {
  if (error === undefined || error === null) return '';
  const message = error instanceof Error ? error.message : String(error);
  return redactTuiSensitiveText(message).trim();
}

export function redactTuiSensitiveText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(NON_PRINTING_CONTROL_CHARACTERS, '')
    .replace(
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/giu,
      '[redacted private key]',
    )
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/gu, 'sk-[redacted]')
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/giu, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(
      /\b(Authorization)(\s*[:=]\s*)((?:Bearer|Basic|Token)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1$2$3[redacted]',
    )
    .replace(
      /\b(api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|password|secret)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1$2[redacted]',
    );
}

function asSentence(value: string): string {
  return /[.!?…]$/u.test(value) ? value : `${value}.`;
}
