import { LLM_ERROR_CODES } from '@mavis/shared/llm-error-classifier';
import { describe, expect, it } from 'vitest';

import { resolveTuiRuntimeFailure } from '../../src/tui/controller/runtime/runtime-error-presentation.js';

// #425: a provider that rejects the conversation for carrying too many images
// used to surface as "temporarily unavailable … Run /retry", which can never
// succeed because every resend carries the same history.

const PROVIDER = 'custom_provider:fixture';
const IMAGE_LIMIT_DETAIL =
  '400 Upstream [invalid_request_error] Too many images in request: 31 > 30';

describe('deterministic provider rejection presentation', () => {
  it('explains an image-count rejection with the upstream reason and a real next step', () => {
    const failure = resolveTuiRuntimeFailure(
      `BYOK provider ${PROVIDER} upstream error: ${IMAGE_LIMIT_DETAIL}`,
      LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
      { errorSource: 'byok_upstream', errorDetail: IMAGE_LIMIT_DETAIL, errorProviderId: PROVIDER },
    );

    expect(failure.retryable).toBe(false);
    expect(failure.content).toContain('too many images');
    expect(failure.content).toContain(`Reason: ${IMAGE_LIMIT_DETAIL}`);
    expect(failure.content).toContain(`Provider: ${PROVIDER}`);
    expect(failure.content).toContain('/compact');
    expect(failure.content).toContain('/new');
    expect(failure.content).not.toContain('/retry');
    expect(failure.content).not.toContain('temporarily unavailable');
  });

  it('strips the BYOK attribution prefix when only the message carries the reason', () => {
    const failure = resolveTuiRuntimeFailure(
      `BYOK provider ${PROVIDER} upstream error: ${IMAGE_LIMIT_DETAIL}`,
      LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
    );

    expect(failure.retryable).toBe(false);
    expect(failure.content).toContain(`Reason: ${IMAGE_LIMIT_DETAIL}`);
    expect(failure.content).not.toContain('BYOK provider');
  });

  it('treats an HTTP 400 invalid_request_error as terminal with the same guidance', () => {
    const detail = '400 {"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}';
    const failure = resolveTuiRuntimeFailure(
      `BYOK provider ${PROVIDER} upstream error: ${detail}`,
      LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
      { errorSource: 'byok_upstream', errorDetail: detail, errorProviderId: PROVIDER },
    );

    expect(failure.retryable).toBe(false);
    expect(failure.content).toContain('rejected the request as invalid');
    expect(failure.content).toContain('text content blocks must be non-empty');
    expect(failure.content).toContain('/compact');
    expect(failure.content).not.toContain('/retry');
  });

  it('keeps the retry guidance for an unclassified upstream failure', () => {
    const failure = resolveTuiRuntimeFailure(
      `BYOK provider ${PROVIDER} upstream error: 502 Bad Gateway`,
      LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
      { errorSource: 'byok_upstream', errorDetail: '502 Bad Gateway', errorProviderId: PROVIDER },
    );

    expect(failure.retryable).toBe(true);
    expect(failure.content).toContain('temporarily unavailable');
    expect(failure.content).toContain('/retry');
  });
});
