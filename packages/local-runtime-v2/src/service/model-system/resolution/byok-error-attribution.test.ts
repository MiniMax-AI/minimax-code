import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { isRequestMediaRejection } from '@mavis/context-manager';
import {
  isLLMDeterministicRequestRejection,
  LLM_ERROR_CODES,
  normalizeLLMError,
} from '@mavis/shared/llm-error-classifier';
import { describe, expect, it } from 'vitest';

import { withByokErrorAttribution } from './byok-error-attribution.js';

const JSON_BODY_413 =
  '413 {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum allowed number of bytes."}}';

function failedWith(errorMessage: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'custom',
    model: 'm',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage,
    timestamp: 0,
  };
}

async function attributed(errorMessage: string): Promise<AssistantMessage> {
  const base: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    const final = failedWith(errorMessage);
    stream.push({ type: 'error', reason: 'error', error: final });
    stream.end();
    return stream;
  };
  const streamFn = withByokErrorAttribution({ streamFn: base, providerId: 'custom_provider:p' });
  const stream = await streamFn({} as never, { messages: [] }, {});
  return stream.result();
}

function payloadOf(message: AssistantMessage): Record<string, unknown> {
  const text = message.errorMessage ?? '';
  return JSON.parse(text.slice(text.indexOf('{'))) as Record<string, unknown>;
}

describe('withByokErrorAttribution', () => {
  it('keeps the HTTP status of a JSON error body so a 413 stays a request-size rejection', async () => {
    const message = await attributed(JSON_BODY_413);

    expect(payloadOf(message)).toMatchObject({
      errorDetail: '413 Request exceeds the maximum allowed number of bytes.',
      errorProviderId: 'custom_provider:p',
      errorSource: 'byok_upstream',
    });
    expect(isRequestMediaRejection(message)).toBe(true);
    expect(
      isLLMDeterministicRequestRejection(
        normalizeLLMError({ finishReason: 'error', errorMessage: message.errorMessage }),
      ),
    ).toBe(true);
  });

  it('keeps the error code and only prefixes the status of other JSON error bodies', async () => {
    const message = await attributed(
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    );

    expect(payloadOf(message)).toMatchObject({
      errorCode: LLM_ERROR_CODES.LLM_AUTH_ERROR,
      errorDetail: '401 invalid x-api-key',
    });
  });

  it('leaves a message that already starts with its status unchanged', async () => {
    const message = await attributed('413 Request exceeds the maximum allowed number of bytes.');

    expect(payloadOf(message).errorDetail).toBe(
      '413 Request exceeds the maximum allowed number of bytes.',
    );
  });

  it('adds nothing to a message without a status', async () => {
    const message = await attributed('Connection error.');

    expect(payloadOf(message).errorDetail).toBe('Connection error.');
  });
});
