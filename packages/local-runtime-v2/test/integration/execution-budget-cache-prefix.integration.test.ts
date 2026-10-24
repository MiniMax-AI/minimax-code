import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { PiTurnRunner } from '@mavis/agent-core/pi-turn-runner';
import type { RuntimeTool } from '@mavis/agent-core/tools';

import { createExecutionBudgetReminder } from '../../src/service/turn-system/agent-host/runner/execution-budget-reminder.js';

const model: Model<Api> = {
  id: 'prefix-model',
  name: 'prefix-model',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

const DEADLINE_MS = 601_000;
/**
 * Clock at which each provider request of one budgeted tool loop is prepared:
 * the first announcement, quiet requests, the 50% and 25% thresholds, and the
 * final two minutes, including two requests inside the same 10-second step.
 */
const REQUEST_TIMES_MS = [
  1_000, 60_000, 302_000, 320_000, 452_000, 470_000, 482_000, 485_000, 492_000, 590_000,
];

describe('execution budget reminder and the provider prompt cache', () => {
  it('keeps every provider request an append-only extension of the previous one', async () => {
    // A prompt cache entry is written at the last user message of a request.
    // The next request only reads it back when that message is still in the
    // same place, so the provider request must never drop or reorder earlier
    // messages, including reminders, within one turn.
    const clock = { nowMs: REQUEST_TIMES_MS[0]! };
    const reminder = createExecutionBudgetReminder(
      DEADLINE_MS,
      () => clock.nowMs,
      () => true,
    );
    const requests: Message[][] = [];

    await new PiTurnRunner().runTurn({
      sessionId: 'session-budget-prefix',
      turnId: 'turn-budget-prefix',
      workspaceDir: '/workspace',
      systemPrompt: 'Use the probe tool until told to stop.',
      userMessage: { text: 'run the probe loop' },
      llm: { model, streamFn: probeLoopStream(requests, clock) },
      eventWriter: { pushRuntime: async () => undefined, appendEvents: async () => undefined },
      toolConfig: {
        tools: [probeTool()],
        disableBuiltinToolFallback: true,
        context: { sessionId: 'session-budget-prefix', turnId: 'turn-budget-prefix' },
      },
      hooks: { beforeLlmCallHook: reminder ? [reminder] : [] },
    });

    // The loop reached its final, tool-free request.
    expect(requests).toHaveLength(REQUEST_TIMES_MS.length);
    requests.slice(1).forEach((request, index) => {
      const previous = requests[index]!;
      expect(
        request.slice(0, previous.length),
        `request ${index + 1} must start with request ${index}`,
      ).toEqual(previous);
    });
    // Every emitted reminder stays in place, and identical final-window text
    // is not repeated.
    expect(JSON.stringify(requests.at(-1)).match(/Execution time remaining: [^<]*/gu)).toEqual([
      'Execution time remaining: about 10 minutes of 10 minutes total. Model generation, tools, and waiting all count against it.',
      'Execution time remaining: about 4 minutes of 10 minutes total.',
      'Execution time remaining: about 2 minutes of 10 minutes total.',
      'Execution time remaining: about 110 seconds of 10 minutes total.',
      'Execution time remaining: about 100 seconds of 10 minutes total.',
      'Execution time remaining: about 10 seconds of 10 minutes total.',
    ]);
  });
});

function probeLoopStream(requests: Message[][], clock: { nowMs: number }): StreamFn {
  return async (_model, context) => {
    requests.push(structuredClone(context.messages));
    const call = requests.length;
    clock.nowMs = REQUEST_TIMES_MS[call] ?? clock.nowMs;
    const final =
      call < REQUEST_TIMES_MS.length
        ? assistant(
            [{ type: 'toolCall', id: `probe-${call}`, name: 'probe', arguments: {} }],
            'toolUse',
          )
        : assistant([{ type: 'text', text: 'done' }], 'stop');
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: final.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: final });
    return stream;
  };
}

function probeTool(): RuntimeTool {
  let calls = 0;
  return {
    def: { name: 'probe', description: 'Returns a probe result.', schema: Type.Object({}) },
    impl: {
      async execute() {
        calls += 1;
        const text = `probe result ${calls}`;
        return { tool_name: 'probe', text, content: [{ type: 'text', text }] };
      },
    },
  };
}

function assistant(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}
