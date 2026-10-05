import {
  classifyLLMRequestRejectionMessage,
  LLM_ERROR_CODES,
} from '@mavis/shared/llm-error-classifier';
import { tuiErrorDiagnostic } from '../../../user-facing-failure.js';

const AUTH_ERROR_CODES = new Set<number>([401, LLM_ERROR_CODES.LLM_AUTH_ERROR]);
const RATE_LIMIT_ERROR_CODES = new Set<number>([
  429,
  LLM_ERROR_CODES.LLM_RATE_LIMITED,
  LLM_ERROR_CODES.LLM_TPM_RATE_LIMITED,
]);
const QUOTA_ERROR_CODES = new Set<number>([
  402,
  LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED,
  LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED,
]);
const PROVIDER_RETRY_ERROR_CODES = new Set<number>([
  LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
  LLM_ERROR_CODES.LLM_CLUSTER_OVERLOADED,
]);
const FORCE_RETRY_ERROR_CODES = new Set<number>([
  50_001,
  LLM_ERROR_CODES.LLM_RATE_LIMITED,
  LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
  LLM_ERROR_CODES.LLM_TPM_RATE_LIMITED,
  LLM_ERROR_CODES.LLM_CLUSTER_OVERLOADED,
]);
const CONTENT_SAFETY_ERROR_CODES = new Set<number>([50_200, 50_201]);

export interface TuiRuntimeFailurePresentation {
  readonly content: string;
  readonly retryable: boolean;
}

export interface TuiRuntimeFailureMetadata {
  readonly retryable?: boolean;
  readonly errorSource?: string;
  readonly errorDetail?: string;
  readonly errorProviderId?: string;
}

export function formatTuiRuntimeFailure(
  rawMessage: string | undefined,
  errorCode?: number,
  metadata: TuiRuntimeFailureMetadata = {},
): string {
  return resolveTuiRuntimeFailure(rawMessage, errorCode, metadata).content;
}

export function resolveTuiRuntimeFailure(
  rawMessage: string | undefined,
  errorCode?: number,
  metadata: TuiRuntimeFailureMetadata = {},
): TuiRuntimeFailurePresentation {
  const message = rawMessage?.trim();
  const detail = runtimeFailureDetail(message, metadata.errorDetail);
  const provider = runtimeFailureProvider(metadata);
  const diagnostics = `${detail}${provider}`;
  const code = errorCode === undefined ? '' : `\nCode: ${String(errorCode)}`;
  const retryable =
    (errorCode !== undefined && FORCE_RETRY_ERROR_CODES.has(errorCode)) ||
    metadata.retryable !== false;
  if (errorCode === 403) {
    return {
      content: `Access denied.${diagnostics}${code}\nCheck account and model permissions before sending again. Your prompt is preserved.`,
      retryable: false,
    };
  }
  if (
    (errorCode !== undefined && AUTH_ERROR_CODES.has(errorCode)) ||
    (errorCode === undefined &&
      message &&
      /\b(?:auth(?:entication|orization)?|credentials?)\b.*\b(?:expired|failed|invalid|required|missing)\b/iu.test(
        message,
      ))
  ) {
    return {
      content:
        metadata.errorSource === 'byok_upstream'
          ? `The model provider rejected its credentials.${diagnostics}${code}\nCheck the selected provider API key and endpoint, then resend the message. Your prompt is preserved.`
          : `The service rejected request authentication.${diagnostics}${code}\nIf the problem persists, report this error and its code. Your prompt is preserved.`,
      retryable: false,
    };
  }
  const rejection = requestRejection(message, metadata.errorDetail);
  if (rejection) {
    // Deterministic provider rejections (#425): the same history fails the
    // same way on every resend, so /retry is never the next step. Show the
    // upstream reason, which the generic branches below would hide.
    const reasonLine = rejection.reason ? `\nReason: ${rejection.reason}` : '';
    return {
      content:
        rejection.kind === 'image_limit'
          ? `The model provider rejected the request: the conversation carries too many images.${reasonLine}${provider}${code}\nResending fails the same way. Run /compact to summarize earlier history, or /new to start a fresh Session. Your prompt is preserved.`
          : `The model provider rejected the request as invalid.${reasonLine}${provider}${code}\nResending the same conversation fails the same way. Run /compact to summarize earlier history, or /new to start a fresh Session. Your prompt is preserved.`,
      retryable: false,
    };
  }
  if (
    (errorCode !== undefined && RATE_LIMIT_ERROR_CODES.has(errorCode)) ||
    (message && /\b(?:rate.?limit(?:ed)?|too many requests|HTTP\s*429)\b/iu.test(message))
  ) {
    return {
      content: `The model provider is rate limiting requests.${diagnostics}${code}\n${
        retryable ? 'Wait a moment, then run /retry.' : 'Wait a moment, then resend the message.'
      } Your prompt is preserved.`,
      retryable,
    };
  }
  if (errorCode !== undefined && QUOTA_ERROR_CODES.has(errorCode)) {
    return {
      content: `Usage limit reached.${diagnostics}${code}\nCheck /usage or switch provider, then resend the message. Your prompt is preserved.`,
      retryable: false,
    };
  }
  if (
    message &&
    /\b(?:usage limit|credits? exhausted|insufficient (?:credits?|balance))\b/iu.test(message)
  ) {
    return {
      content: `Usage limit reached.${diagnostics}${code}\nCheck /usage or switch provider, then resend the message. Your prompt is preserved.`,
      retryable: false,
    };
  }
  if (errorCode !== undefined && PROVIDER_RETRY_ERROR_CODES.has(errorCode)) {
    return {
      content: `The model provider is temporarily unavailable.${diagnostics}${code}\n${
        retryable
          ? 'Run /retry to resend your last message.'
          : 'Check the selected provider settings before sending again.'
      } Your prompt is preserved.`,
      retryable,
    };
  }
  if (message && /\b(?:provider|model)\b.*\bunavailable\b/iu.test(message)) {
    return {
      content: `The model provider is temporarily unavailable.${diagnostics}${code}\n${
        retryable
          ? 'Run /retry to resend your last message.'
          : 'Check the selected provider settings before sending again.'
      } Your prompt is preserved.`,
      retryable,
    };
  }
  if (message && /^(?:terminated|connection (?:closed|terminated))\.?$/iu.test(message)) {
    return {
      content: `The model connection ended before the response was completed.${diagnostics}${code}\n${
        retryable
          ? 'Run /retry to resend your last message.'
          : 'Check the connection before sending the message again.'
      } Your prompt is preserved.`,
      retryable,
    };
  }
  if (
    (errorCode !== undefined && CONTENT_SAFETY_ERROR_CODES.has(errorCode)) ||
    (message && /\b(?:content (?:filter|review)|safety|policy violation)\b/iu.test(message))
  ) {
    return {
      content: `The response was stopped by content safety checks.${diagnostics}${code}\nRevise the message before sending it again. Your prompt is preserved.`,
      retryable: false,
    };
  }
  if (errorCode === LLM_ERROR_CODES.LLM_MIGRATION_ERROR) {
    return {
      content: `The model did not respond for too long.${diagnostics}${code}\nWait a moment, then resend the message. Your prompt is preserved.`,
      retryable: false,
    };
  }
  const reason = metadata.errorDetail ?? message;
  const diagnostic = reason ? tuiErrorDiagnostic(reason) : undefined;
  return {
    content: diagnostic
      ? `The response failed.\nReason: ${diagnostic}${provider}${code}\n${
          retryable
            ? 'Run /retry to resend your last message.'
            : 'Check the error details or selected provider settings before sending again.'
        } Your prompt is preserved.`
      : `The response failed.${provider}${code}\n${
          retryable
            ? 'Run /retry to resend your last message.'
            : 'Check the selected provider settings before sending again.'
        } Your prompt is preserved.`,
    retryable,
  };
}

const BYOK_UPSTREAM_PREFIX_RE = /^BYOK provider .+? upstream error:\s*/u;

function requestRejection(
  message: string | undefined,
  rawDetail: string | undefined,
): { readonly kind: 'image_limit' | 'invalid_request'; readonly reason: string } | undefined {
  for (const candidate of [rawDetail, message]) {
    const kind = classifyLLMRequestRejectionMessage(candidate);
    if (!kind || !candidate) continue;
    return { kind, reason: tuiErrorDiagnostic(candidate.replace(BYOK_UPSTREAM_PREFIX_RE, '')) };
  }
  return undefined;
}

function runtimeFailureDetail(message: string | undefined, rawDetail: string | undefined): string {
  const detail = rawDetail ? tuiErrorDiagnostic(rawDetail) : '';
  return detail && detail !== message ? `\nReason: ${detail}` : '';
}

function runtimeFailureProvider(metadata: TuiRuntimeFailureMetadata): string {
  if (metadata.errorSource !== 'byok_upstream') return '';
  const providerId = metadata.errorProviderId
    ? tuiErrorDiagnostic(metadata.errorProviderId)
    : 'configured';
  return `\nProvider: ${providerId}`;
}
