import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  streamSimple,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { classifyLLMErrorToCode, LLM_ERROR_CODES } from '@mavis/shared/llm-error-classifier';

const BYOK_ERROR_PREFIX = 'BYOK upstream error';
const MAX_ERROR_MESSAGE_LENGTH = 1_200;

export function withByokErrorAttribution(input: {
  readonly streamFn?: StreamFn;
  readonly providerId: string;
}): StreamFn {
  const base = input.streamFn ?? streamSimple;
  return (async (model, context, options) => {
    try {
      const stream = await base(model, context, options);
      return wrapStream(stream, input.providerId, options?.signal);
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      throw new Error(formatByokErrorMessage(error, input.providerId));
    }
  }) as StreamFn;
}

function formatByokErrorMessage(raw: unknown, providerId: string): string {
  const rawMessage = errorText(raw);
  if (rawMessage.startsWith(BYOK_ERROR_PREFIX)) return rawMessage;
  const classified = classifyLLMErrorToCode(raw);
  const detail = redactByokErrorMessage(
    withHttpStatus(classified?.message ?? rawMessage, rawMessage) || 'LLM provider request failed',
  );
  return `${BYOK_ERROR_PREFIX}: ${JSON.stringify({
    errorCode: classified?.status_code ?? LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
    message: `BYOK provider ${providerId} upstream error: ${detail}`,
    errorSource: 'byok_upstream',
    errorDetail: detail,
    errorProviderId: providerId,
  })}`;
}

/**
 * A JSON error body reduces to its inner `message`, which drops the HTTP status
 * (`413 {"type":"error",…}` becomes the bare sentence). Request-size recovery and
 * retry classification read this text and recognize the status, so keep it.
 */
function withHttpStatus(detail: string, rawMessage: string): string {
  const status = /^([1-5]\d\d) /u.exec(rawMessage)?.[1];
  return status && detail && !detail.startsWith(`${status} `) ? `${status} ${detail}` : detail;
}

function redactByokErrorMessage(message: string): string {
  return message
    .slice(0, MAX_ERROR_MESSAGE_LENGTH)
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/gu, 'sk-***')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"',}]+/giu, '$1***')
    .replace(/((?:api[_-]?key|x-api-key)\s*[:=]\s*)[^\s"',}]+/giu, '$1***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/giu, '$1***');
}

function wrapStream(
  stream: AssistantMessageEventStream,
  providerId: string,
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const wrapped: AssistantMessageEventStream = Object.create(stream);
  Object.defineProperty(wrapped, Symbol.asyncIterator, {
    value: () => attributedEvents(stream, providerId, signal),
  });
  Object.defineProperty(wrapped, 'result', {
    value: () => attributedResult(stream, providerId, signal),
  });
  return wrapped;
}

async function* attributedEvents(
  stream: AssistantMessageEventStream,
  providerId: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<AssistantMessageEvent> {
  try {
    for await (const event of stream) {
      yield attributeEvent(event, providerId);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(formatByokErrorMessage(error, providerId));
  }
}

async function attributedResult(
  stream: AssistantMessageEventStream,
  providerId: string,
  signal: AbortSignal | undefined,
): Promise<AssistantMessage> {
  try {
    return attributeMessage(await stream.result(), providerId);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(formatByokErrorMessage(error, providerId));
  }
}

function attributeEvent(event: AssistantMessageEvent, providerId: string): AssistantMessageEvent {
  return event.type === 'error' && event.reason === 'error'
    ? { ...event, error: attributeMessage(event.error, providerId) }
    : event;
}

function attributeMessage(message: AssistantMessage, providerId: string): AssistantMessage {
  return message.stopReason === 'error' && message.errorMessage
    ? {
        ...message,
        errorMessage: formatByokErrorMessage(message.errorMessage, providerId),
      }
    : message;
}

function errorText(raw: unknown): string {
  if (raw instanceof Error) return raw.message;
  return typeof raw === 'string' ? raw : '';
}
