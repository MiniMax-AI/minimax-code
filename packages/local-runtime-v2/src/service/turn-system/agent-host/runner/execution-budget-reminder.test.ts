import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  PiBeforeLlmCallAppendMessage,
  PiBeforeLlmCallHook,
  PiBeforeLlmCallHookDecision,
  PiBeforeLlmCallHookInput,
} from '@mavis/agent-core/pi-turn-runner';
import { resolveCompactionTokenBudget } from '@mavis/context-manager';
import { describe, expect, it, vi } from 'vitest';

import { createAutomaticFootprintMeasurer } from '../../compaction/automatic-context-compactor.js';
import { ContextUsageAnchorState } from '../../compaction/execution/usage-anchor.js';
import { fitsReminderInFinalRequest } from '../../execution/reminder/reminder-admission.js';
import { validateCanonicalHistoryMessages } from '../history/canonical-history-validation.js';
import { createExecutionBudgetReminder } from './execution-budget-reminder.js';

const EXECUTION_BUDGET_REMINDER_CUSTOM_TYPE = 'execution_budget_reminder';

/** The reminder is durable hidden context: it must only ask for a tail append. */
function appended(
  decision: PiBeforeLlmCallHookDecision | undefined,
): PiBeforeLlmCallAppendMessage | undefined {
  if (!decision) return undefined;
  if (decision.type !== 'appendMessage') {
    throw new Error(`Expected appendMessage, received ${decision.type}`);
  }
  expect(decision.reason).toBe(EXECUTION_BUDGET_REMINDER_CUSTOM_TYPE);
  expect(decision).not.toHaveProperty('placement');
  return decision.message;
}

/** Runs one request and commits its marker the way PiTurnRunner does. */
async function request(
  reminder: PiBeforeLlmCallHook,
  input: PiBeforeLlmCallHookInput,
): Promise<PiBeforeLlmCallAppendMessage | undefined> {
  const marker = appended(await reminder(input));
  if (marker) {
    input.messages = [...input.messages, marker];
    input.canonicalMessages = [...input.canonicalMessages, marker];
  }
  return marker;
}

function reminderText(text: string): string {
  return `<system-reminder>Execution time remaining: ${text}</system-reminder>`;
}

function hookInput(): PiBeforeLlmCallHookInput {
  const messages: AgentMessage[] = [{ role: 'user', content: 'hello', timestamp: 1 }];
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    phase: 'initial',
    messages,
    canonicalMessages: messages,
    model: {
      id: 'test-model',
      name: 'test-model',
      api: 'anthropic-messages',
      provider: 'test',
      baseUrl: 'https://example.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
    thinkingLevel: 'off',
    tools: [],
  };
}

function tokenFullRequest(usageAnchor: ContextUsageAnchorState): PiBeforeLlmCallHookInput {
  const input = hookInput();
  const { providerInputLimit } = resolveCompactionTokenBudget({
    contextWindow: input.model.contextWindow,
    configuredMaxOutputTokens: input.model.maxTokens,
  });
  const anchor: AgentMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'usage anchor' }],
    api: input.model.api,
    provider: input.model.provider,
    model: input.model.id,
    responseId: 'budget-anchor',
    timestamp: 2,
    stopReason: 'stop',
    usage: {
      input: providerInputLimit - 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: providerInputLimit,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const binding = usageAnchor.bind({
    scope: input.sessionId,
    provider: input.model.provider,
    api: input.model.api,
    model: input.model.id,
    tools: input.tools,
  });
  expect(
    usageAnchor.record({
      key: binding.key,
      historyEpoch: binding.historyEpoch,
      assistant: anchor,
    }),
  ).toBe(true);
  input.messages = [anchor];
  input.canonicalMessages = input.messages;
  expect(
    createAutomaticFootprintMeasurer(input, usageAnchor).measure(input.messages).inputTokens,
  ).toBe(providerInputLimit);
  return input;
}

function byteFullRequest(usageAnchor: ContextUsageAnchorState): PiBeforeLlmCallHookInput {
  const input = hookInput();
  const footprint = createAutomaticFootprintMeasurer(input, usageAnchor).measure(input.messages);
  input.maxSerializedInputBytes = footprint.serializedBytes;
  return input;
}

describe('Execution budget durable context', () => {
  it('reminds only at budget thresholds and keeps every reminder in history', async () => {
    let nowMs = 1_000;
    const reminder = createExecutionBudgetReminder(
      601_000,
      () => nowMs,
      () => true,
    )!;
    const input = hookInput();
    const committed: PiBeforeLlmCallAppendMessage[] = [];
    for (const [now, expected, level] of [
      [
        1_000,
        'about 10 minutes of 10 minutes total. Model generation, tools, and waiting all count against it.',
        0,
      ],
      [100_000, undefined],
      [301_000, 'about 5 minutes of 10 minutes total.', 1],
      [400_000, undefined],
      [451_000, 'about 2 minutes of 10 minutes total.', 2],
      [481_000, 'about 120 seconds of 10 minutes total.', 4],
      [490_000, 'about 110 seconds of 10 minutes total.', 4],
      // Same 10-second step as the previous reminder: nothing new to say.
      [491_000, undefined],
      [495_000, 'about 100 seconds of 10 minutes total.', 4],
      [600_999, 'under 10 seconds of 10 minutes total.', 4],
    ] as const) {
      nowMs = now;
      const marker = await request(reminder, input);
      if (expected === undefined) {
        expect(marker).toBeUndefined();
        continue;
      }
      expect(marker).toEqual({
        role: 'custom',
        customType: EXECUTION_BUDGET_REMINDER_CUSTOM_TYPE,
        content: reminderText(expected),
        display: false,
        details: { deadlineAtMs: 601_000, level },
        timestamp: now,
      });
      committed.push(marker!);
    }
    expect(input.canonicalMessages).toEqual([hookInput().messages[0], ...committed]);
  });

  it('stores reminders that canonical history accepts', async () => {
    const marker = appended(
      await createExecutionBudgetReminder(
        601_000,
        () => 1_000,
        () => true,
      )!(hookInput()),
    );
    expect(() => validateCanonicalHistoryMessages([marker])).not.toThrow();
  });

  it('announces the budget again once compaction summarized earlier reminders away', async () => {
    let nowMs = 1_000;
    const reminder = createExecutionBudgetReminder(
      601_000,
      () => nowMs,
      () => true,
    )!;
    const input = hookInput();
    expect(await request(reminder, input)).toBeDefined();
    nowMs = 301_000;
    expect(await request(reminder, input)).toBeDefined();
    const summary: AgentMessage = { role: 'user', content: 'compacted summary', timestamp: 3 };
    input.messages = [summary];
    input.canonicalMessages = [summary];
    nowMs = 320_000;
    expect((await request(reminder, input))?.content).toBe(
      reminderText(
        'about 4 minutes of 10 minutes total. Model generation, tools, and waiting all count against it.',
      ),
    );
    nowMs = 330_000;
    expect(await request(reminder, input)).toBeUndefined();
  });

  it('ignores reminders of another budget and malformed reminder details', async () => {
    const reminder = createExecutionBudgetReminder(
      601_000,
      () => 2_000,
      () => true,
    )!;
    const input = hookInput();
    const earlier = {
      role: 'custom' as const,
      customType: EXECUTION_BUDGET_REMINDER_CUSTOM_TYPE,
      content: reminderText('about 1 minutes of 5 minutes total.'),
      display: false as const,
      timestamp: 2,
    };
    input.canonicalMessages = [
      ...input.canonicalMessages,
      { ...earlier, details: { deadlineAtMs: 300_000, level: 4 } },
      { ...earlier, details: { deadlineAtMs: '601000', level: 4 } },
      earlier,
    ];
    expect((await request(reminder, input))?.content).toContain(
      'Model generation, tools, and waiting all count against it.',
    );
  });
});

describe('Execution budget request admission', () => {
  it.each([
    ['provider token limit', tokenFullRequest],
    ['serialized byte limit', byteFullRequest],
  ] as const)('preserves final request admission for its %s', async (_name, fullRequest) => {
    const usageAnchor = new ContextUsageAnchorState();
    const reminder = createExecutionBudgetReminder(
      601_000,
      () => 1_000,
      (input, marker) => fitsReminderInFinalRequest(input, marker, usageAnchor),
    )!;
    expect(await reminder(fullRequest(usageAnchor))).toBeUndefined();
    expect(appended(await reminder(hookInput()))).toBeDefined();
  });

  it.each(['deny', 'throw'] as const)(
    'retries a threshold reminder that admission skipped (%s)',
    async (failure) => {
      let nowMs = 1_000;
      let skip = false;
      const logger = { info: vi.fn() };
      const reminder = createExecutionBudgetReminder(
        601_000,
        () => nowMs,
        () => {
          if (skip && failure === 'throw') throw new Error('Measurement unavailable');
          return !skip;
        },
        logger,
      )!;
      const input = hookInput();
      expect(await request(reminder, input)).toBeDefined();
      skip = true;
      nowMs = 301_000;
      expect(await request(reminder, input)).toBeUndefined();
      expect(logger.info).toHaveBeenCalledOnce();
      skip = false;
      nowMs = 311_000;
      expect((await request(reminder, input))?.content).toBe(
        reminderText('about 4 minutes of 10 minutes total.'),
      );
      nowMs = 321_000;
      expect(await request(reminder, input)).toBeUndefined();
    },
  );

  it('keeps the first reminder pending until admitted and collapses skipped thresholds', async () => {
    let nowMs = 1_000;
    let admit = false;
    const reminder = createExecutionBudgetReminder(
      1_000 + 1_800_000,
      () => nowMs,
      () => admit,
    )!;
    const input = hookInput();
    expect(await request(reminder, input)).toBeUndefined();
    admit = true;
    nowMs = 2_000;
    expect((await request(reminder, input))?.content).toBe(
      reminderText(
        'about 29 minutes of 30 minutes total. Model generation, tools, and waiting all count against it.',
      ),
    );
    nowMs = 1_000 + 1_800_000 - 899_000;
    expect((await request(reminder, input))?.content).toBe(
      reminderText('about 14 minutes of 30 minutes total.'),
    );
    // Jumping straight past 25% and 10% emits once for the deepest threshold.
    nowMs = 1_000 + 1_800_000 - 179_000;
    expect((await request(reminder, input))?.content).toBe(
      reminderText('about 2 minutes of 30 minutes total.'),
    );
    nowMs += 1_000;
    expect(await request(reminder, input)).toBeUndefined();
  });

  it('reports the sampled budget level in diagnostics', async () => {
    let nowMs = 1_000;
    const logger = { info: vi.fn() };
    const reminder = createExecutionBudgetReminder(
      601_000,
      () => nowMs,
      () => true,
      logger,
    )!;
    const input = hookInput();
    expect(await request(reminder, input)).toMatchObject({ timestamp: 1_000 });
    expect(logger.info).toHaveBeenLastCalledWith(
      {
        session_id: 'session-1',
        turn_id: 'turn-1',
        sampled_at_ms: 1_000,
        remaining_ms: 600_000,
        total_ms: 600_000,
        budget_level: 0,
      },
      'execution budget context sampled',
    );
    nowMs = 451_000;
    expect(await request(reminder, input)).toMatchObject({ timestamp: 451_000 });
    expect(logger.info).toHaveBeenLastCalledWith(
      {
        session_id: 'session-1',
        turn_id: 'turn-1',
        sampled_at_ms: 451_000,
        remaining_ms: 150_000,
        total_ms: 600_000,
        budget_level: 2,
      },
      'execution budget context sampled',
    );
  });

  it('keeps admitted context when diagnostics fail', async () => {
    const reminder = createExecutionBudgetReminder(
      601_000,
      () => 1_000,
      () => true,
      {
        info: () => {
          throw new Error('Logger unavailable');
        },
      },
    )!;
    expect(appended(await reminder(hookInput()))).toBeDefined();
  });

  it('ignores a clock that moves backwards and isolates thresholds per turn', async () => {
    let nowMs = 1_000;
    const reminder = createExecutionBudgetReminder(
      601_000,
      () => nowMs,
      () => true,
    )!;
    const input = hookInput();
    expect(await request(reminder, input)).toBeDefined();
    nowMs = 500;
    expect(await request(reminder, input)).toBeUndefined();
    const nextTurn = createExecutionBudgetReminder(
      602_000,
      () => 2_000,
      () => true,
    )!;
    expect((await request(nextTurn, input))?.content).toContain(
      'Model generation, tools, and waiting all count against it.',
    );
  });

  it('skips unbudgeted, aborted and expired requests', async () => {
    expect(
      createExecutionBudgetReminder(
        undefined,
        () => 1_000,
        () => true,
      ),
    ).toBeUndefined();
    expect(createExecutionBudgetReminder(601_000)).toBeUndefined();
    let nowMs = 1_000;
    const logger = { info: vi.fn() };
    const admission = vi.fn(() => true);
    const reminder = createExecutionBudgetReminder(601_000, () => nowMs, admission, logger)!;
    expect(await reminder({ ...hookInput(), signal: AbortSignal.abort() })).toBeUndefined();
    nowMs = 601_000;
    expect(await reminder(hookInput())).toBeUndefined();
    nowMs += 1;
    expect(await reminder(hookInput())).toBeUndefined();
    expect(admission).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
