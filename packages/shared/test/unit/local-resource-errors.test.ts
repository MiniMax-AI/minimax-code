import { describe, expect, it } from 'vitest';

import {
  normalizeLLMError,
  toLLMFailureErrorKind,
  toLLMMetricErrorKind,
  toLLMRetryDecision,
} from '../../src/llm-error-classifier.js';
import { classifyLocalResourceError } from '../../src/local-resource-errors.js';

function systemError(code: string, message = `${code}: system call failed`): Error {
  return Object.assign(new Error(message), { code });
}

/** What undici and the provider SDKs throw when a socket cannot be opened. */
function connectionError(code: string): Error {
  return Object.assign(new Error('Connection error.'), {
    name: 'APIConnectionError',
    cause: new TypeError('fetch failed', { cause: systemError(code, `connect ${code} 10.0.0.1:443`) }),
  });
}

describe('classifyLocalResourceError', () => {
  it.each([
    ['ENOSPC', 'local_disk_full'],
    ['EDQUOT', 'local_disk_full'],
    ['EMFILE', 'local_fd_exhausted'],
    ['ENFILE', 'local_fd_exhausted'],
    ['ENOMEM', 'local_out_of_memory'],
  ] as const)('maps %s to %s', (code, kind) => {
    expect(classifyLocalResourceError(systemError(code))).toBe(kind);
  });

  it('follows cause chains and AggregateError members', () => {
    expect(classifyLocalResourceError(connectionError('EMFILE'))).toBe('local_fd_exhausted');
    expect(
      classifyLocalResourceError(
        new AggregateError([new Error('first'), systemError('ENOSPC')], 'history writes failed'),
      ),
    ).toBe('local_disk_full');
  });

  it('reads only the code, never the message', () => {
    expect(classifyLocalResourceError(new Error('ENOSPC: no space left on device'))).toBeUndefined();
    expect(classifyLocalResourceError(systemError('ECONNRESET'))).toBeUndefined();
    expect(classifyLocalResourceError(systemError('toString'))).toBeUndefined();
    expect(classifyLocalResourceError('ENOSPC')).toBeUndefined();
    expect(classifyLocalResourceError(undefined)).toBeUndefined();
  });

  it('stops on cycles and never runs getters', () => {
    const cyclic: Error & { cause?: unknown } = new Error('cycle');
    cyclic.cause = cyclic;
    expect(classifyLocalResourceError(cyclic)).toBeUndefined();

    const guarded = new Error('guarded');
    Object.defineProperty(guarded, 'code', {
      get() {
        throw new Error('getter ran');
      },
    });
    expect(() => classifyLocalResourceError(guarded)).not.toThrow();
    expect(classifyLocalResourceError(guarded)).toBeUndefined();
  });
});

describe('toLLMFailureErrorKind', () => {
  it('names the resource a provider reported through onProviderError, retry unchanged', () => {
    // Pi providers keep only the message in the final message.
    const normalized = normalizeLLMError({
      finishReason: 'error',
      errorMessage: 'Connection error.',
      providerError: connectionError('EMFILE'),
    });
    expect(toLLMFailureErrorKind(normalized.facts)).toBe('local_fd_exhausted');
    expect(toLLMMetricErrorKind(normalized.facts)).toBe('network');
    expect(toLLMRetryDecision(normalized)).toEqual({ retryable: true, reason: 'network' });
  });

  it('names the resource of a thrown error and keeps its terminal reason', () => {
    const normalized = normalizeLLMError({
      raw: systemError('ENOSPC', 'ENOSPC: no space left on device, write'),
    });
    expect(toLLMFailureErrorKind(normalized.facts)).toBe('local_disk_full');
    expect(toLLMMetricErrorKind(normalized.facts)).toBe('unknown');
    expect(toLLMRetryDecision(normalized)).toEqual({ retryable: false, reason: 'unknown' });
  });

  it('keeps cancellation and prefers the thrown error over the provider report', () => {
    expect(
      toLLMFailureErrorKind(
        normalizeLLMError({ explicitAbort: true, raw: systemError('ENOMEM') }).facts,
      ),
    ).toBe('abort');
    const timeout = Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
    expect(
      toLLMFailureErrorKind(
        normalizeLLMError({ raw: timeout, providerError: connectionError('EMFILE') }).facts,
      ),
    ).toBe('timeout');
  });
});
