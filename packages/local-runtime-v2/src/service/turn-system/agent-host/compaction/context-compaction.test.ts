import type { LLMModelConfig, PiBeforeLlmCallHookInput } from '@mavis/agent-core/pi-turn-runner';
import { describe, expect, it, vi } from 'vitest';

import type { AgentEventContext } from '../events/contracts.js';
import type {
  AutomaticContextCompactionInput,
  ContextCompactionHooks,
  ContextCompactionLifecycle,
  ManualContextCompactionInput,
} from './contracts.js';
import {
  ContextCompactionResultValidationError,
  captureContextCompactionResult,
  createCompactionTokenUsageAccumulator,
  createCompactionReplaceMetadata,
  createAutomaticContextCompactionHook,
  logCompactionFailureBestEffort,
  readCompactionCommitMetadata,
  readCompactionLifecycleMetadata,
  readCompactionTokenUsage,
} from './context-compaction.js';
import { createManualCompactionChange } from './compaction-history.js';
import { ContextCompactionError } from '../../compaction/contracts.js';

const context: AgentEventContext = {
  sessionId: 'session-compaction-hook',
  turnId: 'turn-compaction-hook',
  turnSequence: 1,
};

describe('compaction Provider token usage', () => {
  it('sums physical requests and preserves partial usage as incomplete', () => {
    const usage = createCompactionTokenUsageAccumulator();

    expect(usage.snapshot()).toBeUndefined();
    usage.observe({
      requestAttempt: 1,
      outcome: 'error',
      usage: { input: 11, output: 2, cacheRead: 0, cacheWrite: 4 },
      usageComplete: false,
    });
    usage.observe({
      requestAttempt: 2,
      outcome: 'success',
      usage: { input: 17, output: 3, cacheRead: 5, cacheWrite: 7 },
      usageComplete: true,
    });

    expect(usage.snapshot()).toEqual({
      inputTokens: 28,
      outputTokens: 5,
      cacheReadTokens: 5,
      cacheWriteTokens: 11,
      totalTokens: 49,
      incomplete: true,
    });
  });

  it('marks a request without usage incomplete and rejects invalid snapshots', () => {
    const usage = createCompactionTokenUsageAccumulator();

    usage.observe({ requestAttempt: 1, outcome: 'abort', usageComplete: false });

    expect(usage.snapshot()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      incomplete: true,
    });
    expect(readCompactionTokenUsage(undefined)).toBeUndefined();
    expect(
      readCompactionTokenUsage({
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        totalTokens: 0,
        incomplete: false,
      }),
    ).toBeUndefined();
  });

  it('ignores invalid Provider buckets and protects accumulator overflow', () => {
    const usage = createCompactionTokenUsageAccumulator();
    const completeUsage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };

    for (const input of ['invalid' as unknown as number, Infinity, -1]) {
      usage.observe({
        requestAttempt: 1,
        outcome: 'success',
        usage: { ...completeUsage, input },
        usageComplete: true,
      });
    }
    usage.observe({
      requestAttempt: 4,
      outcome: 'success',
      usage: { ...completeUsage, input: Number.MAX_VALUE },
      usageComplete: true,
    });
    usage.observe({
      requestAttempt: 5,
      outcome: 'success',
      usage: { ...completeUsage, input: Number.MAX_VALUE },
      usageComplete: true,
    });

    expect(usage.snapshot()).toEqual({
      inputTokens: Number.MAX_VALUE,
      outputTokens: 10,
      cacheReadTokens: 15,
      cacheWriteTokens: 20,
      totalTokens: Number.MAX_VALUE,
      incomplete: true,
    });
  });

  it('rejects non-finite and negative usage snapshots', () => {
    const snapshot = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      totalTokens: 10,
      incomplete: false,
    };

    expect(readCompactionTokenUsage({ ...snapshot, inputTokens: '1' })).toBeUndefined();
    expect(readCompactionTokenUsage({ ...snapshot, outputTokens: Infinity })).toBeUndefined();
    expect(readCompactionTokenUsage({ ...snapshot, cacheReadTokens: -1 })).toBeUndefined();
  });
});

function rejectWithoutError(value: unknown): Promise<never> {
  return Reflect.apply(Promise.reject, Promise, [value]) as Promise<never>;
}

function model(): LLMModelConfig['model'] {
  return {
    id: 'model',
    name: 'Model',
    api: 'openai-completions',
    provider: 'test',
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4_096,
    maxTokens: 1_024,
  };
}

function hookInput(overrides: Partial<PiBeforeLlmCallHookInput> = {}): PiBeforeLlmCallHookInput {
  const messages = overrides.messages ?? [
    { role: 'user' as const, content: 'long context', timestamp: 1 },
  ];
  return {
    sessionId: context.sessionId,
    turnId: context.turnId,
    phase: 'initial',
    messages,
    canonicalMessages: overrides.canonicalMessages ?? messages,
    model: model(),
    thinkingLevel: 'off',
    ...overrides,
  };
}

describe('automatic ContextCompactor trigger probe', () => {
  it('returns unchanged history without taking a semantic snapshot', async () => {
    const probeBeforeLlm = vi.fn(() => ({ shouldStart: false }));
    const compactBeforeLlm = vi.fn();
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: { probeBeforeLlm, compactBeforeLlm },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory: vi.fn(async () => undefined),
        },
      },
      context,
      'lease-trigger-probe',
    );
    const input = hookInput();
    const structuredCloneSpy = vi.spyOn(globalThis, 'structuredClone');

    try {
      await expect(hook(input)).resolves.toEqual({ type: 'continue' });
      expect(probeBeforeLlm).toHaveBeenCalledWith(
        expect.objectContaining({ messages: input.messages }),
      );
      expect(compactBeforeLlm).not.toHaveBeenCalled();
      expect(structuredCloneSpy).not.toHaveBeenCalled();
    } finally {
      structuredCloneSpy.mockRestore();
    }
  });

  it('detaches triggered compaction from the borrowed History before any await', async () => {
    const probeBeforeLlm = vi.fn((_input: AutomaticContextCompactionInput) => ({
      shouldStart: true,
    }));
    let releaseCompactor: (() => void) | undefined;
    const compactorGate = new Promise<void>((resolve) => {
      releaseCompactor = resolve;
    });
    let capturedMessages: PiBeforeLlmCallHookInput['messages'] | undefined;
    const compactBeforeLlm = vi.fn(async (compactionInput: AutomaticContextCompactionInput) => {
      capturedMessages = compactionInput.messages;
      await compactorGate;
      return { status: 'unchanged' as const, reason: 'nothing-to-compact' as const };
    });
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: { probeBeforeLlm, compactBeforeLlm },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory: vi.fn(async () => undefined),
        },
      },
      context,
      'lease-triggered-snapshot',
    );
    const input = hookInput({
      messages: [{ role: 'user', content: 'stable content', timestamp: 1 }],
    });

    const pending = hook(input);
    try {
      expect(probeBeforeLlm.mock.calls[0]?.[0].messages).toBe(input.messages);
      expect(capturedMessages).not.toBe(input.messages);
      expect(capturedMessages).toEqual(input.messages);
      expect(Object.isFrozen(capturedMessages)).toBe(true);
      expect(Object.isFrozen(capturedMessages?.[0])).toBe(true);
      Reflect.set(input.messages[0] as object, 'content', 'caller mutation');
      expect(capturedMessages?.[0]).toEqual(expect.objectContaining({ content: 'stable content' }));
    } finally {
      releaseCompactor?.();
    }
    await expect(pending).resolves.toEqual({ type: 'continue' });
  });

  it('isolates a probe failure through the existing automatic failure path', async () => {
    const root = new Error('probe measurement failed');
    const compactBeforeLlm = vi.fn();
    const failCommittedHistory = vi.fn(async () => undefined);
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: {
          probeBeforeLlm: () => {
            throw root;
          },
          compactBeforeLlm,
        },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory,
        },
      },
      context,
      'lease-probe-failure',
    );

    await expect(hook(hookInput())).resolves.toEqual({
      type: 'skip',
      reason: 'context_compaction_failed',
    });
    expect(compactBeforeLlm).not.toHaveBeenCalled();
    expect(failCommittedHistory).toHaveBeenCalledWith({
      context,
      attemptId: expect.any(String),
      error: root,
    });
  });
});

describe('automatic ContextCompactor diagnostics', () => {
  it('logs only bounded checkpoint metadata with Host correlation', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const counter = vi.fn();
    const histogram = vi.fn();
    const compactBeforeLlm = vi.fn(async (_input: unknown, hooks?: ContextCompactionHooks) => {
      hooks?.onStarted();
      hooks?.onCheckpointGenerated?.({
        responseContentKinds: ['thinking', 'text', 'thinking'],
        stopReason: 'stop',
        outputTokens: 17,
      });
      hooks?.onCheckpointAttemptSettled?.({
        candidate: 'hmin',
        attemptNumber: 6,
        outcome: 'generated',
        durationMs: 23,
        inputMessageCount: 1,
      });
      return {
        status: 'completed' as const,
        compactionId: 'automatic-diagnostics',
        strategyVersion: 'test-v1',
        method: 'llm_checkpoint' as const,
        summary: 'private checkpoint text',
        replacementMessages: [{ role: 'user' as const, content: 'summary', timestamp: 2 }],
        messagesBefore: 1,
        messagesAfter: 1,
        tokensBefore: 100,
        tokensAfter: 20,
        serializedBytesBefore: 400,
        serializedBytesAfter: 80,
      };
    });
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: { compactBeforeLlm },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory: vi.fn(async () => undefined),
        },
        metricsClient: { counter, histogram },
      },
      context,
      'lease-diagnostics',
      { logger },
    );

    await expect(
      hook(
        hookInput({
          thinkingLevel: 'medium',
          apiKey: 'private-provider-key',
          systemPrompt: 'private prompt',
        }),
      ),
    ).resolves.toMatchObject({ type: 'replaceMessages' });

    expect(logger.info).toHaveBeenCalledWith(
      {
        event: 'context_compaction_checkpoint_generated',
        session_id: context.sessionId,
        turn_id: context.turnId,
        turn_sequence: context.turnSequence,
        attempt_id: expect.any(String),
        phase: 'initial',
        thinking_level: 'medium',
        response_content_kinds: ['thinking', 'text'],
        stop_reason: 'stop',
        output_tokens: 17,
      },
      '[local-runtime-v2] context compaction checkpoint generated',
    );
    expect(logger.info).toHaveBeenCalledWith(
      {
        event: 'context_compaction_checkpoint_attempt_settled',
        session_id: context.sessionId,
        turn_id: context.turnId,
        turn_sequence: context.turnSequence,
        attempt_id: expect.any(String),
        phase: 'initial',
        thinking_level: 'medium',
        checkpoint_candidate: 'hmin',
        checkpoint_attempt: 6,
        input_message_count: 1,
        outcome: 'generated',
        duration_ms: 23,
      },
      '[local-runtime-v2] context compaction checkpoint attempt settled',
    );
    expect(counter).toHaveBeenCalledWith('compact_checkpoint_candidate_total', 1, {
      candidate: 'hmin',
      outcome: 'generated',
    });
    expect(histogram).toHaveBeenCalledWith('compact_checkpoint_candidate_duration_ms', 23, {
      candidate: 'hmin',
    });
    expect(counter).not.toHaveBeenCalledWith(
      'compact_hmid_overflow_recovery_total',
      expect.anything(),
      expect.anything(),
    );
    expect(logger.error).not.toHaveBeenCalled();
    const diagnostic = JSON.stringify(logger.info.mock.calls);
    for (const secret of [
      'private-provider-key',
      'private prompt',
      'private checkpoint text',
      'private reasoning',
      'payload',
    ]) {
      expect(diagnostic).not.toContain(secret);
    }
  });

  it('keeps hostile checkpoint metadata inside best-effort diagnostics', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const compactBeforeLlm = vi.fn(async (_input: unknown, hooks?: ContextCompactionHooks) => {
      hooks?.onStarted();
      hooks?.onCheckpointGenerated?.({
        get responseContentKinds(): readonly ['text'] {
          throw new Error('private getter detail');
        },
        stopReason: 'stop',
        outputTokens: 17,
      });
      return {
        status: 'completed' as const,
        compactionId: 'automatic-hostile-metadata',
        strategyVersion: 'test-v1',
        method: 'llm_checkpoint' as const,
        summary: 'checkpoint',
        replacementMessages: [{ role: 'user' as const, content: 'summary', timestamp: 2 }],
        messagesBefore: 1,
        messagesAfter: 1,
        tokensBefore: 100,
        tokensAfter: 20,
        serializedBytesBefore: 400,
        serializedBytesAfter: 80,
      };
    });
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: { compactBeforeLlm },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory: vi.fn(async () => undefined),
        },
      },
      context,
      'lease-hostile-metadata',
      { logger },
    );

    await expect(hook(hookInput())).resolves.toMatchObject({ type: 'replaceMessages' });
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('automatic ContextCompactor failure diagnostics', () => {
  it('logs a stable checkpoint rejection without sensitive error text', async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(() => {
        throw new Error('diagnostic logger unavailable');
      }),
    };
    const rejection = new ContextCompactionError(
      'INVALID_CHECKPOINT',
      'llm_checkpoint',
      'private Provider response detail',
    );
    const compactBeforeLlm = vi.fn(async (_input: unknown, hooks?: ContextCompactionHooks) => {
      hooks?.onStarted();
      hooks?.onCheckpointGenerated?.({
        responseContentKinds: ['thinking', 'toolCall'],
        stopReason: 'toolUse',
        outputTokens: 9,
      });
      throw rejection;
    });
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: { compactBeforeLlm },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory: vi.fn(async () => undefined),
        },
      },
      context,
      'lease-diagnostics-failure',
      { logger },
    );

    await expect(hook(hookInput({ thinkingLevel: 'high' }))).resolves.toEqual({
      type: 'skip',
      reason: 'context_compaction_failed',
    });

    const generatedFields = logger.info.mock.calls[0]?.[0];
    expect(logger.error).toHaveBeenCalledWith(
      {
        event: 'context_compaction_failed',
        session_id: context.sessionId,
        turn_id: context.turnId,
        turn_sequence: context.turnSequence,
        attempt_id: Reflect.get(generatedFields ?? {}, 'attempt_id'),
        phase: 'initial',
        thinking_level: 'high',
        response_content_kinds: ['thinking', 'toolCall'],
        stop_reason: 'toolUse',
        output_tokens: 9,
        error_code: 'INVALID_CHECKPOINT',
        error_stage: 'llm_checkpoint',
      },
      '[local-runtime-v2] context compaction failed',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      'private Provider response detail',
    );
  });

  it('fails open with a skip when the Provider admission rejects the checkpoint', async () => {
    const failCommittedHistory = vi.fn(async () => undefined);
    const rejection = new ContextCompactionError(
      'POST_ADMISSION_FAILED',
      'post_admission',
      'hard Provider limit',
    );
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: {
          compactBeforeLlm: vi.fn(async () => {
            throw rejection;
          }),
        },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory,
        },
      },
      context,
      'lease-provider-admission-failure',
    );

    await expect(hook(hookInput())).resolves.toEqual({
      type: 'skip',
      reason: 'context_compaction_failed',
    });
    expect(failCommittedHistory).toHaveBeenCalledWith({
      context,
      attemptId: expect.any(String),
      error: rejection,
    });
  });

  it('fails open with a skip when local estimates reject every checkpoint candidate', async () => {
    const failCommittedHistory = vi.fn(async () => undefined);
    const rejection = new ContextCompactionError(
      'COMPACTION_INPUT_TOO_LARGE',
      'llm_checkpoint',
      'Context is too large for bounded checkpoint generation.',
    );
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: {
          compactBeforeLlm: vi.fn(async () => {
            throw rejection;
          }),
        },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory,
        },
      },
      context,
      'lease-local-estimate-rejection',
    );

    await expect(hook(hookInput())).resolves.toEqual({
      type: 'skip',
      reason: 'context_compaction_failed',
    });
    expect(failCommittedHistory).toHaveBeenCalledWith({
      context,
      attemptId: expect.any(String),
      error: rejection,
    });
  });
});

describe('automatic ContextCompactor diagnostic error normalization', () => {
  it.each([
    ['INVALID_HISTORY', 'tool_trim'],
    ['INVALID_CHECKPOINT', 'llm_checkpoint'],
    ['CHECKPOINT_PROVIDER_FAILED', 'llm_checkpoint'],
    ['COMPACTION_INPUT_TOO_LARGE', 'llm_checkpoint'],
    ['POST_ADMISSION_FAILED', 'post_admission'],
  ] as const)('preserves the stable %s/%s pair', (code, stage) => {
    const logger = { error: vi.fn() };

    logCompactionFailureBestEffort(logger, {
      context,
      attemptId: 'attempt-stable-error',
      phase: 'initial',
      thinkingLevel: 'medium',
      error: new ContextCompactionError(code, stage, 'private failure detail'),
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: code, error_stage: stage }),
      '[local-runtime-v2] context compaction failed',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private failure detail');
  });

  it('logs content-free sizing diagnostics attached to an input-too-large failure', () => {
    const logger = { error: vi.fn() };

    logCompactionFailureBestEffort(logger, {
      context,
      attemptId: 'attempt-size-diagnostics',
      phase: 'initial',
      thinkingLevel: 'medium',
      error: new ContextCompactionError(
        'COMPACTION_INPUT_TOO_LARGE',
        'llm_checkpoint',
        'Context is too large for bounded checkpoint generation.',
        {
          diagnostics: {
            historyMessageCount: 818,
            protectedMessageCount: 412,
            protectedInputTokens: 400_123,
            protectedSerializedBytes: 1_204_000,
            providerInputLimit: 381_952,
            maxSerializedInputBytes: 67_108_864,
            hminAvailable: true,
          },
        },
      ),
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        error_code: 'COMPACTION_INPUT_TOO_LARGE',
        history_message_count: 818,
        protected_message_count: 412,
        protected_input_tokens: 400_123,
        protected_serialized_bytes: 1_204_000,
        provider_input_limit: 381_952,
        max_serialized_input_bytes: 67_108_864,
        hmin_available: true,
      }),
      '[local-runtime-v2] context compaction failed',
    );
  });

  it('logs content-free before/after sizing attached to a post-admission failure', () => {
    const logger = { error: vi.fn() };

    logCompactionFailureBestEffort(logger, {
      context,
      attemptId: 'attempt-post-admission-diagnostics',
      phase: 'initial',
      thinkingLevel: 'medium',
      error: new ContextCompactionError(
        'POST_ADMISSION_FAILED',
        'post_admission',
        'Generated checkpoint does not fit the next Provider request.',
        {
          diagnostics: {
            historyMessageCount: 42,
            providerInputLimit: 167_232,
            maxSerializedInputBytes: 67_108_864,
            beforeInputTokens: 180_000,
            beforeSerializedBytes: 720_000,
            afterInputTokens: 170_001,
            afterSerializedBytes: 91_000,
          },
        },
      ),
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        error_code: 'POST_ADMISSION_FAILED',
        history_message_count: 42,
        provider_input_limit: 167_232,
        max_serialized_input_bytes: 67_108_864,
        before_input_tokens: 180_000,
        before_serialized_bytes: 720_000,
        after_input_tokens: 170_001,
        after_serialized_bytes: 91_000,
      }),
      '[local-runtime-v2] context compaction failed',
    );
  });

  it('drops malformed sizing diagnostics without failing the log', () => {
    const logger = { error: vi.fn() };
    const error = new ContextCompactionError(
      'COMPACTION_INPUT_TOO_LARGE',
      'llm_checkpoint',
      'Context is too large for bounded checkpoint generation.',
    );
    Reflect.set(error, 'diagnostics', {
      historyMessageCount: Number.NaN,
      protectedMessageCount: -1,
      providerInputLimit: 'private text' as unknown as number,
      hminAvailable: 'yes' as unknown as boolean,
    });

    expect(() =>
      logCompactionFailureBestEffort(logger, {
        context,
        attemptId: 'attempt-malformed-diagnostics',
        phase: 'initial',
        thinkingLevel: 'off',
        error,
      }),
    ).not.toThrow();
    const fields = logger.error.mock.calls[0]?.[0] ?? {};
    expect(fields).not.toHaveProperty('history_message_count');
    expect(fields).not.toHaveProperty('protected_message_count');
    expect(fields).not.toHaveProperty('provider_input_limit');
    expect(fields).not.toHaveProperty('hmin_available');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private text');
  });

  it('keeps a throwing error getter inside the best-effort boundary', () => {
    const logger = { error: vi.fn() };
    const error = Object.defineProperty({}, 'code', {
      get: () => {
        throw new Error('private getter detail');
      },
    });

    expect(() =>
      logCompactionFailureBestEffort(logger, {
        context,
        attemptId: 'attempt-hostile-error',
        phase: 'initial',
        thinkingLevel: 'off',
        error,
      }),
    ).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: 'UNKNOWN_ERROR', error_stage: 'unknown' }),
      '[local-runtime-v2] context compaction failed',
    );
  });

  it('classifies an aborted checkpoint without exposing the abort error', () => {
    const logger = { error: vi.fn() };

    logCompactionFailureBestEffort(logger, {
      context,
      attemptId: 'attempt-aborted',
      phase: 'iteration',
      thinkingLevel: 'off',
      checkpoint: {
        responseContentKinds: [],
        stopReason: 'aborted',
        outputTokens: 0,
      },
      error: new Error('private cancellation detail'),
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        error_code: 'COMPACTION_ABORTED',
        error_stage: 'llm_checkpoint',
      }),
      '[local-runtime-v2] context compaction failed',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private cancellation detail');
  });
});

describe('automatic ContextCompactor adapter', () => {
  it('returns a bounded skip when the Plugin Hook defers an admitted compaction', async () => {
    const beforeCompaction = vi.fn(async () => false);
    const compactBeforeLlm = vi.fn(async (_input: unknown, hooks?: ContextCompactionHooks) => {
      await hooks?.onStarted();
      throw new Error('compaction must not continue after defer');
    });
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: { compactBeforeLlm },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory: vi.fn(async () => undefined),
        },
      },
      context,
      'lease-plugin-defer',
      { beforeCompaction },
    );

    await expect(hook(hookInput())).resolves.toEqual({
      type: 'skip',
      reason: 'context_compaction_deferred_by_plugin_hook',
    });
    expect(beforeCompaction).toHaveBeenCalledOnce();
  });

  it('aborts before compaction when a Plugin Hook stops the turn', async () => {
    const failCommittedHistory = vi.fn(async () => undefined);
    const beforeCompaction = vi.fn(async () => ({
      abort: true as const,
      reason: 'context_compaction_stopped_by_plugin_hook',
    }));
    const compactBeforeLlm = vi.fn(async (_input: unknown, hooks?: ContextCompactionHooks) => {
      await hooks?.onStarted();
      throw new Error('compaction must not continue after a Hook stop');
    });
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: { compactBeforeLlm },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory,
        },
      },
      context,
      'lease-plugin-stop',
      { beforeCompaction },
    );

    await expect(hook(hookInput())).resolves.toEqual({
      type: 'abort',
      reason: 'context_compaction_stopped_by_plugin_hook',
    });
    expect(failCommittedHistory).not.toHaveBeenCalled();
  });

  it('forwards detached history and every optional transport fact into a replacement', async () => {
    const signal = new AbortController().signal;
    const streamFn = vi.fn();
    const payloadTransform = vi.fn((payload: unknown) => payload);
    const auxiliaryPayloadTransform = vi.fn((payload: unknown) => payload);
    const tools: PiBeforeLlmCallHookInput['tools'] = [
      {
        name: 'search',
        description: 'Search',
        parameters: { type: 'object', properties: {} },
      },
    ];
    const compactBeforeLlm = vi.fn(async (_input: unknown, hooks?: ContextCompactionHooks) => {
      hooks?.onStarted();
      return {
        status: 'completed' as const,
        compactionId: 'automatic-1',
        strategyVersion: 'test-v1',
        method: 'llm_checkpoint' as const,
        summary: 'summary',
        replacementMessages: [{ role: 'user' as const, content: 'summary', timestamp: 2 }],
        messagesBefore: 1,
        messagesAfter: 1,
        tokensBefore: 100,
        tokensAfter: 20,
        serializedBytesBefore: 400,
        serializedBytesAfter: 80,
        contextUsage: {
          contextWindowTokens: 4_096,
          usedTokens: 20.4,
          totalCountSource: 'LOCAL_ESTIMATE' as const,
          components: [
            { kind: 'SYSTEM_PROMPT' as const, tokens: 1.4 },
            { kind: 'MEMORY' as const, tokens: 1.4 },
            { kind: 'TOOLS' as const, tokens: 2.4 },
            { kind: 'SKILLS' as const, tokens: 1.4 },
            { kind: 'MESSAGES' as const, tokens: 13.4 },
            { kind: 'OTHER' as const, tokens: 0.4 },
          ],
        },
      };
    });
    const manualCompact = vi.fn(async (_input: ManualContextCompactionInput) => ({
      status: 'unchanged' as const,
      reason: 'nothing-to-compact' as const,
    }));
    const observe = vi.fn(async () => undefined);
    const dependencies = {
      automatic: { compactBeforeLlm },
      manual: { compactManual: manualCompact },
      lifecycle: {
        completeCommittedHistory: vi.fn(async () => undefined),
        failCommittedHistory: vi.fn(async () => undefined),
      },
      observer: { observe },
    };
    const hook = createAutomaticContextCompactionHook(dependencies, context, 'lease-automatic');

    const input = hookInput({
      apiKey: 'credential',
      headers: { authorization: 'runner-only' },
      streamFn,
      maxTokens: 512,
      cacheRetention: 'short',
      payloadTransform,
      auxiliaryPayloadTransform,
      systemPrompt: 'system prompt',
      tools,
      thinkingLevel: 'medium',
      signal,
    });
    const decision = await hook(input);
    expect(decision).toMatchObject({
      type: 'replaceMessages',
      metadata: {
        replacementId: 'automatic-1',
        compactionPhase: 'initial',
        contextUsage: expect.objectContaining({ usedTokens: 20.4 }),
      },
    });
    if (!decision || decision.type !== 'replaceMessages') {
      throw new Error('Expected replacement metadata.');
    }
    expect(Object.isFrozen(decision.metadata)).toBe(true);
    expect(Object.isFrozen(decision.metadata?.compactedMessages)).toBe(true);
    expect(Object.isFrozen(decision.metadata?.keptMessages)).toBe(true);
    expect(readCompactionLifecycleMetadata(decision.metadata)?.contextUsage).toEqual(
      expect.objectContaining({ usedTokens: 20.4 }),
    );
    expect(compactBeforeLlm).toHaveBeenCalledWith(
      {
        sessionId: context.sessionId,
        phase: 'initial',
        messages: input.messages,
        model: input.model,
        streamFn,
        apiKey: 'credential',
        headers: { authorization: 'runner-only' },
        maxTokens: 512,
        cacheRetention: 'short',
        payloadTransform: auxiliaryPayloadTransform,
        systemPrompt: 'system prompt',
        tools,
        thinkingLevel: 'medium',
        signal,
      },
      expect.objectContaining({ onStarted: expect.any(Function) }),
    );
    expect(manualCompact).not.toHaveBeenCalled();
    const captured = compactBeforeLlm.mock.calls[0]?.[0] as
      | { readonly messages: readonly object[] }
      | undefined;
    expect(Object.isFrozen(captured?.messages)).toBe(true);
    expect(Object.isFrozen(captured?.messages[0])).toBe(true);
    expect(observe).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: 'started', reason: 'automatic' }),
    );
  });
});

describe('automatic ContextCompactor continuation', () => {
  it('returns continue for an unchanged result and keeps observation best-effort', async () => {
    const observe = vi.fn(async () => {
      throw new Error('live observer unavailable');
    });
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: {
          compactBeforeLlm: vi.fn(async () => ({
            status: 'unchanged' as const,
            reason: 'nothing-to-compact' as const,
          })),
        },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory: vi.fn(async () => undefined),
        },
        observer: { observe },
      },
      context,
      'lease-automatic',
    );

    await expect(hook(hookInput())).resolves.toEqual({ type: 'continue' });
    expect(observe).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'unchanged', reason: 'nothing-to-compact' }),
    );
  });

  it('maps filter-only replacement without retaining message bodies in metadata', async () => {
    const lifecycle = {
      completeCommittedHistory: vi.fn(async () => undefined),
      failCommittedHistory: vi.fn(async () => undefined),
    };
    const inputMessages = [
      {
        role: 'user' as const,
        content: '<html>SENTINEL_HTML</html> base64-SENTINEL_BASE64',
        timestamp: 1,
      },
      {
        role: 'toolResult' as const,
        toolCallId: 'tool-sentinel',
        toolName: 'test-tool',
        content: [{ type: 'text' as const, text: 'SENTINEL_TOOL_RESULT' }],
        isError: false,
        timestamp: 2,
      },
    ];
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: {
          compactBeforeLlm: vi.fn(async (input) => ({
            status: 'replaced' as const,
            reason: 'internal-context-filter' as const,
            replacementId: 'filter-1',
            strategyVersion: 'filter-v1',
            replacementMessages: input.messages.slice(1),
            messagesBefore: input.messages.length,
            messagesAfter: input.messages.length - 1,
          })),
        },
        lifecycle,
      },
      context,
      'lease-automatic',
    );

    const decision = await hook(hookInput({ messages: inputMessages }));

    expect(decision).toMatchObject({
      type: 'replaceRequestMessages',
      reason: 'internal-context-filter',
    });
    if (!decision || decision.type !== 'replaceRequestMessages') {
      throw new Error('Expected filter-only replacement.');
    }
    expect(decision.messages).toEqual(inputMessages.slice(1));
    expect(decision.messages).not.toEqual(inputMessages);
    expect(Reflect.has(decision, 'metadata')).toBe(false);
    expect(lifecycle.completeCommittedHistory).not.toHaveBeenCalled();
    expect(lifecycle.failCommittedHistory).not.toHaveBeenCalled();
  });
});

describe('automatic ContextCompactor observer and failure isolation', () => {
  it('does not let a never-settling observer gate automatic compaction', async () => {
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: {
          compactBeforeLlm: vi.fn(async () => ({
            status: 'unchanged' as const,
            reason: 'nothing-to-compact' as const,
          })),
        },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory: vi.fn(async () => undefined),
        },
        observer: { observe: () => new Promise<void>(() => undefined) },
      },
      context,
      'lease-automatic',
    );

    await expect(
      Promise.race([
        hook(hookInput()),
        new Promise((resolve) => {
          setTimeout(() => resolve({ type: 'observer-timeout' as const }), 100);
        }),
      ]),
    ).resolves.toEqual({ type: 'continue' });
  });

  it('isolates retained observer context from required automatic failure lifecycle', async () => {
    const root = new Error('summary transport failed');
    const mutableContext = { ...context };
    const failCommittedHistory = vi.fn(async () => undefined);
    const observed: AgentEventContext[] = [];
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: {
          compactBeforeLlm: vi.fn(async () => {
            throw root;
          }),
        },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory,
        },
        observer: {
          observe: (fact) => {
            observed.push(fact.context);
            Reflect.set(fact.context, 'sessionId', 'observer-mutation');
            Reflect.set(fact.context, 'turnSequence', 99);
          },
        },
      },
      mutableContext,
      'lease-automatic',
    );
    Reflect.set(mutableContext, 'sessionId', 'caller-mutation');

    await expect(hook(hookInput())).resolves.toEqual({
      type: 'skip',
      reason: 'context_compaction_failed',
    });
    expect(observed.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(failCommittedHistory).toHaveBeenCalledWith({
      context: expect.objectContaining({
        sessionId: context.sessionId,
        turnSequence: context.turnSequence,
      }),
      attemptId: expect.any(String),
      error: root,
    });
  });

  it('keeps a required failure lifecycle rejection isolated from the parent Turn', async () => {
    const root = new Error('summary transport failed');
    const lifecycle = new Error('failure fact failed');
    const failCommittedHistory = vi.fn(async () => {
      throw lifecycle;
    });
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: {
          compactBeforeLlm: vi.fn(async () => {
            throw root;
          }),
        },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory,
        },
      },
      context,
      'lease-automatic',
    );

    await expect(hook(hookInput())).resolves.toEqual({
      type: 'skip',
      reason: 'context_compaction_failure_record_failed',
    });
    expect(failCommittedHistory).toHaveBeenCalledWith({
      context,
      attemptId: expect.any(String),
      error: root,
    });
  });

  it('does not project a compaction failure when the parent Turn aborts before start', async () => {
    const controller = new AbortController();
    controller.abort('user-stop');
    const root = new Error('Local context compaction was aborted.');
    const failCommittedHistory = vi.fn(async () => undefined);
    const observe = vi.fn(async () => undefined);
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: {
          compactBeforeLlm: vi.fn(async () => {
            throw root;
          }),
        },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory,
        },
        observer: { observe },
      },
      context,
      'lease-automatic',
    );

    await expect(hook(hookInput({ signal: controller.signal }))).resolves.toEqual({
      type: 'skip',
      reason: 'context_compaction_aborted_before_start',
    });
    expect(failCommittedHistory).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it('projects a terminal abort when the parent Turn aborts after start', async () => {
    const controller = new AbortController();
    const root = new Error('Local context compaction was aborted.');
    const failCommittedHistory = vi.fn(async () => undefined);
    const observe = vi.fn(async () => undefined);
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: {
          compactBeforeLlm: vi.fn(async (_input, hooks) => {
            hooks?.onStarted();
            controller.abort('user-stop');
            throw root;
          }),
        },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory,
        },
        observer: { observe },
      },
      context,
      'lease-automatic',
    );

    await expect(hook(hookInput({ signal: controller.signal }))).resolves.toEqual({
      type: 'skip',
      reason: 'context_compaction_failed',
    });
    expect(failCommittedHistory).toHaveBeenCalledWith({
      context,
      attemptId: expect.any(String),
      error: root,
    });
    expect(observe).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: 'started', reason: 'automatic' }),
    );
    expect(observe).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        status: 'aborted',
        reason: 'Local context compaction was aborted.',
      }),
    );
  });
});

describe('automatic ContextCompactor attempt settlement', () => {
  it('isolates an undefined failure-lifecycle rejection from the parent Turn', async () => {
    const root = new Error('summary transport failed');
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: {
          compactBeforeLlm: vi.fn(async () => {
            throw root;
          }),
        },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory: vi.fn(() => rejectWithoutError(undefined)),
        },
      },
      context,
      'lease-automatic',
    );

    await expect(hook(hookInput())).resolves.toEqual({
      type: 'skip',
      reason: 'context_compaction_failure_record_failed',
    });
  });

  it('settles a malformed completed attempt with its pre-result lifecycle identity', async () => {
    let automaticInput: unknown;
    const failCommittedHistory = vi.fn<ContextCompactionLifecycle['failCommittedHistory']>(
      async () => undefined,
    );
    const hook = createAutomaticContextCompactionHook(
      {
        automatic: {
          compactBeforeLlm: vi.fn(async (input) => {
            automaticInput = input;
            return {
              status: 'completed' as const,
              compactionId: 'malformed-automatic',
              strategyVersion: 'test-v1',
              method: 'llm_checkpoint' as const,
              summary: 'summary',
              replacementMessages: [{ role: 'bogus', content: 'bad', timestamp: 2 }],
              messagesBefore: 1,
              messagesAfter: 1,
              tokensBefore: 100,
              tokensAfter: 20,
              serializedBytesBefore: 400,
              serializedBytesAfter: 80,
            } as never;
          }),
        },
        lifecycle: {
          completeCommittedHistory: vi.fn(async () => undefined),
          failCommittedHistory,
        },
      },
      context,
      'lease-automatic',
    );

    await expect(hook(hookInput())).resolves.toEqual({
      type: 'skip',
      reason: 'context_compaction_failed',
    });
    expect(Reflect.has(automaticInput as object, 'attemptId')).toBe(false);
    expect(failCommittedHistory).toHaveBeenCalledOnce();
    const attemptedId = failCommittedHistory.mock.calls[0]?.[0].attemptId;
    expect(attemptedId).toEqual(expect.any(String));
    expect(failCommittedHistory).toHaveBeenCalledWith({
      context,
      attemptId: attemptedId,
      error: expect.objectContaining({ name: 'CanonicalHistoryValidationError' }),
    });
  });
});

describe('ContextCompactor result identity', () => {
  it.each([
    ['expands', 1_081, 1_279],
    ['does not reduce', 1_081, 1_081],
  ])('accepts a completed result that %s the token count', (_label, tokensBefore, tokensAfter) => {
    expect(
      captureContextCompactionResult(
        {
          status: 'completed',
          compactionId: 'compaction-expanded',
          strategyVersion: 'test-v1',
          method: 'llm_checkpoint',
          summary: 'larger summary',
          replacementMessages: [],
          messagesBefore: 1,
          messagesAfter: 0,
          tokensBefore,
          tokensAfter,
          serializedBytesBefore: 4_000,
          serializedBytesAfter: 1_600,
        },
        1,
      ),
    ).toMatchObject({ status: 'completed', tokensBefore, tokensAfter });
  });

  it.each([
    [
      'unknown status',
      {
        status: 'unexpected',
        compactionId: 'compaction-1',
        strategyVersion: 'test-v1',
        summary: 'summary',
        replacementMessages: [],
        messagesBefore: 0,
        messagesAfter: 0,
        tokensBefore: 0,
        tokensAfter: 0,
      },
    ],
    [
      'mismatched input count',
      {
        status: 'completed',
        compactionId: 'compaction-1',
        strategyVersion: 'test-v1',
        summary: 'summary',
        replacementMessages: [],
        messagesBefore: 2,
        messagesAfter: 0,
        tokensBefore: 0,
        tokensAfter: 0,
      },
    ],
    [
      'mismatched replacement count',
      {
        status: 'completed',
        compactionId: 'compaction-1',
        strategyVersion: 'test-v1',
        summary: 'summary',
        replacementMessages: [],
        messagesBefore: 1,
        messagesAfter: 1,
        tokensBefore: 0,
        tokensAfter: 0,
      },
    ],
  ])('rejects a %s result', (_label, result) => {
    expect(() => captureContextCompactionResult(result as never, 1)).toThrow(
      ContextCompactionResultValidationError,
    );
  });

  it('rejects malformed identity and only reads complete lifecycle metadata', () => {
    expect(() =>
      captureContextCompactionResult(
        {
          status: 'completed',
          compactionId: '',
          strategyVersion: 'test-v1',
          method: 'llm_checkpoint',
          summary: 'summary',
          replacementMessages: [],
          messagesBefore: 0,
          messagesAfter: 0,
          tokensBefore: 0,
          tokensAfter: 0,
          serializedBytesBefore: 0,
          serializedBytesAfter: 0,
        },
        0,
      ),
    ).toThrow(ContextCompactionResultValidationError);
    expect(readCompactionLifecycleMetadata(null)).toBeUndefined();
    expect(
      readCompactionLifecycleMetadata({
        replacementId: 'compaction-1',
        strategyVersion: 'test-v1',
        compactionPhase: 'manual',
        messagesBefore: 1,
        messagesAfter: 1,
        tokensBefore: 100,
      }),
    ).toBeUndefined();
  });

  it.each([
    ['missing', undefined],
    ['unknown', 'recursive_reduce'],
  ])('rejects a completed result with a %s method', (_label, method) => {
    expect(() =>
      captureContextCompactionResult(
        {
          status: 'completed',
          compactionId: 'compaction-1',
          strategyVersion: 'test-v2',
          method,
          summary: 'checkpoint',
          replacementMessages: [],
          messagesBefore: 0,
          messagesAfter: 0,
          tokensBefore: 100,
          tokensAfter: 20,
          serializedBytesBefore: 400,
          serializedBytesAfter: 80,
        } as never,
        0,
      ),
    ).toThrow(ContextCompactionResultValidationError);
  });

  it('requires summary only for llm_checkpoint and validates serialized measurements', () => {
    const toolReplacement = {
      status: 'completed' as const,
      compactionId: 'archive-1',
      strategyVersion: 'test-v3',
      method: 'tool_archive' as const,
      replacementSourceIndexes: [],
      replacementMessages: [],
      messagesBefore: 0,
      messagesAfter: 0,
      tokensBefore: 100,
      tokensAfter: 20,
      serializedBytesBefore: 400,
      serializedBytesAfter: 80,
    };
    expect(captureContextCompactionResult(toolReplacement as never, 0)).toEqual(toolReplacement);
    expect(() =>
      captureContextCompactionResult({ ...toolReplacement, summary: 'must not exist' } as never, 0),
    ).toThrow(ContextCompactionResultValidationError);
    expect(() =>
      captureContextCompactionResult(
        { ...toolReplacement, compactionId: 'checkpoint-1', method: 'llm_checkpoint' } as never,
        0,
      ),
    ).toThrow(ContextCompactionResultValidationError);
    expect(() =>
      captureContextCompactionResult(
        { ...toolReplacement, serializedBytesAfter: Number.NaN } as never,
        0,
      ),
    ).toThrow(ContextCompactionResultValidationError);
  });
});

describe('bounded compaction replacement metadata', () => {
  const rawHistory = [{ role: 'user' as const, content: 'SENTINEL_RAW_H0', timestamp: 1 }];
  const replacement = [
    { role: 'user' as const, content: 'SENTINEL_REPLACEMENT_BODY', timestamp: 2 },
  ];

  function completed(method: 'tool_archive' | 'tool_trim' | 'llm_checkpoint') {
    return {
      status: 'completed' as const,
      compactionId: `${method}-1`,
      strategyVersion: 'context-compaction-v2',
      method,
      ...(method === 'llm_checkpoint' ? { summary: 'checkpoint正文' } : {}),
      ...(method !== 'llm_checkpoint' ? { replacementSourceIndexes: [0] } : {}),
      replacementMessages: replacement,
      messagesBefore: 1,
      messagesAfter: 1,
      tokensBefore: 1_000,
      tokensAfter: 400,
      serializedBytesBefore: 4_000,
      serializedBytesAfter: 1_600,
    };
  }

  it.each(['tool_archive', 'tool_trim', 'llm_checkpoint'] as const)(
    'maps automatic %s through Pi-compatible but body-free metadata',
    async (method) => {
      const hook = createAutomaticContextCompactionHook(
        {
          automatic: { compactBeforeLlm: vi.fn(async () => completed(method) as never) },
          lifecycle: {
            completeCommittedHistory: vi.fn(async () => undefined),
            failCommittedHistory: vi.fn(async () => undefined),
          },
        },
        context,
        'lease-automatic',
      );

      const decision = await hook(hookInput({ messages: rawHistory }));

      expect(decision).toMatchObject({
        type: 'replaceMessages',
        metadata: {
          compactionMethod: method,
          summary: '',
          compactedMessages: [],
          keptMessages: [],
          tokensBefore: 1_000,
          tokensAfter: 400,
          serializedBytesBefore: 4_000,
          serializedBytesAfter: 1_600,
        },
      });
      if (!decision || decision.type !== 'replaceMessages') {
        throw new Error('Expected a durable replacement.');
      }
      expect(JSON.stringify(decision.metadata)).not.toContain('SENTINEL_RAW_H0');
      expect(JSON.stringify(decision.metadata)).not.toContain('SENTINEL_REPLACEMENT_BODY');
      expect(JSON.stringify(decision.metadata)).not.toContain('checkpoint正文');
    },
  );

  it.each(['tool_archive', 'tool_trim', 'llm_checkpoint'] as const)(
    'maps manual %s through the same bounded metadata contract',
    (method) => {
      const change = createManualCompactionChange(
        {
          lease: { sessionId: 'session-manual', turnId: 'turn-manual' },
        } as never,
        rawHistory,
        completed(method) as never,
        'attempt-manual',
      );

      expect(change.metadata).toMatchObject({
        compactionMethod: method,
        summary: '',
        compactedMessages: [],
        keptMessages: [],
        serializedBytesBefore: 4_000,
        serializedBytesAfter: 1_600,
      });
      expect(JSON.stringify(change.metadata)).not.toContain('SENTINEL_RAW_H0');
      expect(JSON.stringify(change.metadata)).not.toContain('SENTINEL_REPLACEMENT_BODY');
      expect(JSON.stringify(change.metadata)).not.toContain('checkpoint正文');
    },
  );

  it('reads only the bounded Host lifecycle fields', () => {
    const piMetadata = createCompactionReplaceMetadata(
      completed('llm_checkpoint') as never,
      'iteration',
      'attempt-1',
    );

    expect(readCompactionLifecycleMetadata(piMetadata)).toEqual({
      attemptId: 'attempt-1',
      compactionId: 'llm_checkpoint-1',
      method: 'llm_checkpoint',
      strategyVersion: 'context-compaction-v2',
      phase: 'iteration',
      messagesBefore: 1,
      messagesAfter: 1,
      tokensBefore: 1_000,
      tokensAfter: 400,
      serializedBytesBefore: 4_000,
      serializedBytesAfter: 1_600,
    });
    expect(JSON.stringify(readCompactionLifecycleMetadata(piMetadata))).not.toContain(
      'checkpoint正文',
    );
  });

  it('carries an Hmid overflow recovery marker into durable lifecycle metadata', () => {
    const piMetadata = createCompactionReplaceMetadata(
      { ...completed('llm_checkpoint'), hmidOverflowRecovered: true } as never,
      'iteration',
      'attempt-recovered',
    );

    expect(readCompactionLifecycleMetadata(piMetadata)).toMatchObject({
      attemptId: 'attempt-recovered',
      method: 'llm_checkpoint',
      hmidOverflowRecovered: true,
    });
    expect(JSON.stringify(piMetadata)).not.toContain('checkpoint正文');
  });

  it.each(['tool_archive', 'tool_trim'] as const)(
    'reads exact source lineage for a %s commit',
    (method) => {
      const piMetadata = createCompactionReplaceMetadata(
        completed(method) as never,
        'iteration',
        'attempt-1',
      );

      expect(readCompactionCommitMetadata(piMetadata)).toEqual({
        compactionId: `${method}-1`,
        method,
        summary: '',
        replacementSourceIndexes: [0],
      });
      expect(
        readCompactionCommitMetadata({ ...piMetadata, replacementSourceIndexes: [1] }),
      ).toBeUndefined();
    },
  );

  it.each(['llm_checkpoint', 'tool_archive', 'tool_trim'] as const)(
    'reads an exact current-user tail source for %s',
    (method) => {
      const piMetadata = {
        ...createCompactionReplaceMetadata(completed(method) as never, 'initial', 'attempt-1'),
        messagesBefore: 2,
        messagesAfter: method === 'llm_checkpoint' ? 3 : 3,
        currentUserSourceIndex: 1,
        ...(method !== 'llm_checkpoint' ? { replacementSourceIndexes: [0] } : {}),
      };

      expect(readCompactionCommitMetadata(piMetadata)).toMatchObject({
        method,
        currentUserSourceIndex: 1,
        ...(method !== 'llm_checkpoint' ? { replacementSourceIndexes: [0] } : {}),
      });
      expect(
        readCompactionCommitMetadata({ ...piMetadata, currentUserSourceIndex: 2 }),
      ).toBeUndefined();
    },
  );

  it.each([
    ['missing method', { compactionMethod: undefined }],
    ['unknown method', { compactionMethod: 'recursive_reduce' }],
    ['missing bytes', { serializedBytesAfter: undefined }],
    ['invalid bytes', { serializedBytesAfter: Number.POSITIVE_INFINITY }],
  ])('rejects lifecycle metadata with %s', (_label, override) => {
    expect(
      readCompactionLifecycleMetadata({
        compactionAttemptId: 'attempt-1',
        replacementId: 'compaction-1',
        strategyVersion: 'context-compaction-v2',
        compactionMethod: 'tool_trim',
        compactionPhase: 'initial',
        messagesBefore: 1,
        messagesAfter: 1,
        tokensBefore: 1_000,
        tokensAfter: 400,
        serializedBytesBefore: 4_000,
        serializedBytesAfter: 1_600,
        ...override,
      }),
    ).toBeUndefined();
  });
});
