import { describe, expect, it, vi } from 'vitest';

import type { AgentEventContext } from '../events/contracts.js';
import {
  recordSharedPrefixFallbackBestEffort,
  resolveCheckpointRequestShape,
} from './checkpoint-request-shape.js';

const context: AgentEventContext = {
  sessionId: 'session-request-shape',
  turnId: 'turn-request-shape',
  turnSequence: 1,
};

describe('checkpoint request shape', () => {
  const shapeCases: ReadonlyArray<{
    readonly name: string;
    readonly llm: { readonly managedProvider?: boolean };
    readonly enabled: (() => boolean) | undefined;
    readonly expected: 'isolated' | 'shared_prefix';
  }> = [
    {
      name: 'managed MiniMax ignores the switch',
      llm: { managedProvider: true },
      enabled: () => true,
      expected: 'isolated',
    },
    {
      name: 'BYOK shares the prefix while the switch allows it',
      llm: {},
      enabled: () => true,
      expected: 'shared_prefix',
    },
    {
      name: 'BYOK keeps isolated when Apollo turns it off',
      llm: { managedProvider: false },
      enabled: () => false,
      expected: 'isolated',
    },
    { name: 'an absent switch keeps isolated', llm: {}, enabled: undefined, expected: 'isolated' },
    {
      name: 'an unreadable switch keeps isolated',
      llm: {},
      enabled: () => {
        throw new Error('config unavailable');
      },
      expected: 'isolated',
    },
  ];
  it.each(shapeCases)('$name', ({ llm, enabled, expected }) => {
    expect(resolveCheckpointRequestShape(llm, enabled)).toBe(expected);
  });

  it('reports unknown Provider APIs under a bounded label and drops unknown reasons', () => {
    const logger = { info: vi.fn() };
    const counter = vi.fn();
    const metrics = { counter, histogram: vi.fn() };
    const base = { context, attemptId: 'attempt-1', phase: 'manual' as const };

    recordSharedPrefixFallbackBestEffort(logger, metrics, {
      ...base,
      api: 'bedrock-converse-stream',
      reason: 'input_overflow',
    });
    recordSharedPrefixFallbackBestEffort(logger, metrics, {
      ...base,
      api: 'openai-responses',
      reason: 'unexpected' as never,
    });

    expect(counter).toHaveBeenCalledOnce();
    expect(counter).toHaveBeenCalledWith('compact_checkpoint_shared_prefix_fallback_total', 1, {
      api: 'other',
      reason: 'input_overflow',
    });
  });

  it('keeps logger and metrics failures inside the best-effort boundary', () => {
    const throwing = () => {
      throw new Error('diagnostics down');
    };
    expect(() =>
      recordSharedPrefixFallbackBestEffort(
        { info: throwing },
        { counter: throwing, histogram: vi.fn() },
        {
          context,
          attemptId: 'attempt-2',
          phase: 'initial',
          api: 'openai-responses',
          reason: 'tool_call',
        },
      ),
    ).not.toThrow();
  });
});
