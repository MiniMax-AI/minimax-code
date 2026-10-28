/**
 * Contract between the SDK's self-held types and the mcode CLI source.
 *
 * Imports the CLI's exit-code policy and its real JSONL projector from `packages/tui` (both are
 * free of runtime dependencies) and checks that the SDK parses, normalizes and maps them as
 * documented. Excluded from `tsc` because the CLI sources type-check only inside their package.
 */
import { describe, expect, it } from 'vitest';

import { ExecEventProjector } from '../../tui/src/headless/events.js';
import {
  exitCodeForExecResult,
  MINIMAX_CODE_EXEC_EXIT_CODES,
} from '../../tui/src/headless/exit-policy.js';
import { errorForExit, errorForResult, MCODE_EXEC_EXIT_CODES } from '../src/errors.js';
import { MCodeAbortError, MCodeRunError } from '../src/index.js';
import { ItemAccumulator } from '../src/items.js';
import { parseEventLine } from '../src/protocol.js';
import type { ExecResult } from '../src/types.js';

const ids = { runId: 'exec_turn_1', sessionId: 'mvs_contract', turnId: 'turn_1' };

function result(overrides: Partial<ExecResult>): ExecResult {
  return {
    schemaVersion: 1,
    type: 'exec.result',
    ...ids,
    status: 'succeeded',
    durationMs: 5,
    ...overrides,
  };
}

describe('mcode exec contract', () => {
  it('uses the CLI exit codes', () => {
    expect(MCODE_EXEC_EXIT_CODES).toEqual(MINIMAX_CODE_EXEC_EXIT_CODES);
  });

  it.each([
    result({ status: 'failed', error: { category: 'config', message: 'bad config' } }),
    result({
      status: 'failed',
      error: { category: 'runtime', message: 'upstream', retryable: true },
    }),
    result({ status: 'failed', error: { category: 'internal', message: 'bug' } }),
    result({ status: 'timeout' }),
    result({ status: 'limit_exceeded' }),
    result({ status: 'cancelled' }),
  ])(
    'maps CLI result $status/$error.category and its exit code to the same SDK error',
    (cliResult) => {
      const fromResult = errorForResult(cliResult, [], {});
      const fromExit = errorForExit({ exitCode: exitCodeForExecResult(cliResult as never) });

      expect(fromExit.constructor).toBe(fromResult.constructor);
      if (fromResult instanceof MCodeRunError && fromExit instanceof MCodeRunError) {
        expect(fromExit.status).toBe(fromResult.status);
        expect(fromExit.category).toBe(fromResult.category);
      } else {
        expect(fromResult).toBeInstanceOf(MCodeAbortError);
      }
    },
  );

  it('parses and normalizes the events produced by the CLI projector', () => {
    const projector = new ExecEventProjector({ ...ids, resumed: false, nowMs: () => 1 });
    const toolStart = { id: 'call_1', name: 'bash', status: 1, input: { command: 'ls' } };
    const toolDone = { ...toolStart, status: 2, output: { content: [] } };
    const internal = [
      { type: 'delta', role: 'assistant', messageId: 'm1', thinking: 'plan', content: 'Hel' },
      { type: 'delta', role: 'assistant', messageId: 'm1', content: 'lo', toolCalls: [toolStart] },
      {
        type: 'message',
        message: {
          role: 'assistant',
          id: 'm1',
          thinking: 'plan',
          content: 'Hello',
          toolCalls: [toolDone],
        },
      },
    ];
    const finalResult = result({ status: 'succeeded', output: 'Hello', usage: { totalTokens: 3 } });
    const projected = [
      ...internal.flatMap((event) => projector.project(event as never)),
      ...projector.complete(finalResult as never),
    ];

    const items = new ItemAccumulator();
    const parsed = projected.map((event) => parseEventLine(JSON.stringify(event)));
    for (const event of parsed) if (event) items.apply(event);

    expect(parsed.map((event) => event?.type)).toEqual([
      'exec.started',
      'session.started',
      'turn.started',
      'item.started',
      'item.started',
      'item.updated',
      'item.started',
      'item.completed',
      'item.completed',
      'item.completed',
      'turn.completed',
      'exec.completed',
    ]);
    expect(items.items()).toEqual([
      { id: 'm1:reasoning', type: 'reasoning', text: 'plan' },
      { id: 'm1:message', type: 'agent_message', text: 'Hello' },
      { id: 'call_1', type: 'tool_call', toolCall: toolDone },
    ]);
    const completed = parsed.at(-1);
    expect(completed?.type === 'exec.completed' && completed.result).toEqual(finalResult);
  });
});
