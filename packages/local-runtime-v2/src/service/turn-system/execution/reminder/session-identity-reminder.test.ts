import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { PiBeforeLlmCallHookInput } from '@mavis/agent-core/pi-turn-runner';
import { describe, expect, it } from 'vitest';

import { validateCanonicalHistoryMessages } from '../../agent-host/history/canonical-history-validation.js';
import { ContextUsageAnchorState } from '../../compaction/execution/usage-anchor.js';
import { messagesCarrySessionId } from '../../agent-host/compaction/session-identity.js';
import { createSessionIdentityReminderHook } from './session-identity-reminder.js';

const SESSION_ID = 'ses_identity_1';
const MODEL = {
  id: 'test-model',
  name: 'test-model',
  api: 'anthropic-messages',
  provider: 'test-provider',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
} as Model<Api>;

const hook = createSessionIdentityReminderHook(new ContextUsageAnchorState());

function message(value: Record<string, unknown>): AgentMessage {
  return value as unknown as AgentMessage;
}

function user(text: string, timestamp: number): AgentMessage {
  return message({ role: 'user', content: [{ type: 'text', text }], timestamp });
}

const idBearingUser = user(
  `<system-reminder>\n  YOUR SESSION ID: ${SESSION_ID}\n</system-reminder>\nfirst ask`,
  1,
);
const checkpoint = message({
  role: 'compactionSummary',
  summary: '## Goal\nKeep going',
  tokensBefore: 100,
  timestamp: 2,
});
const currentUserWithoutId = user('<system-reminder>\n  date: today\n</system-reminder>\nnext', 3);

function hookInput(
  messages: AgentMessage[],
  phase: 'initial' | 'iteration' = 'iteration',
): PiBeforeLlmCallHookInput {
  return {
    sessionId: SESSION_ID,
    turnId: 'turn-1',
    phase,
    messages,
    canonicalMessages: messages,
    model: MODEL,
    thinkingLevel: 'off',
  } as PiBeforeLlmCallHookInput;
}

describe('Session identity reminder hook', () => {
  it('stays silent while the model-visible context still shows the session ID', async () => {
    expect(await hook(hookInput([idBearingUser, currentUserWithoutId]))).toBeUndefined();
  });

  it('restores the ID before the current user when initial compaction summarized it away', async () => {
    const decision = await hook(hookInput([checkpoint, currentUserWithoutId], 'initial'));

    expect(decision).toMatchObject({
      type: 'appendMessage',
      reason: 'session_identity_reminder',
      placement: 'before-current-user',
      message: {
        role: 'custom',
        customType: 'session_identity_reminder',
        display: false,
        content: expect.stringContaining(`YOUR SESSION ID: ${SESSION_ID}`),
      },
    });
    if (decision?.type !== 'appendMessage') throw new Error('Expected an append decision');
    expect(() => validateCanonicalHistoryMessages([decision.message])).not.toThrow();
  });

  it('appends at the tail mid-turn and does not repeat once the marker is in context', async () => {
    const decision = await hook(hookInput([checkpoint, currentUserWithoutId]));
    if (decision?.type !== 'appendMessage') throw new Error('Expected an append decision');
    expect(decision).not.toHaveProperty('placement');

    expect(
      await hook(hookInput([checkpoint, currentUserWithoutId, decision.message])),
    ).toBeUndefined();
  });
});

describe('messagesCarrySessionId', () => {
  it('only counts user messages or identity markers after the latest compaction', () => {
    expect(messagesCarrySessionId([idBearingUser, currentUserWithoutId], SESSION_ID)).toBe(true);
    expect(
      messagesCarrySessionId([idBearingUser, checkpoint, currentUserWithoutId], SESSION_ID),
    ).toBe(false);
    expect(
      messagesCarrySessionId(
        [
          message({
            role: 'assistant',
            content: [{ type: 'text', text: SESSION_ID }],
            timestamp: 4,
          }),
        ],
        SESSION_ID,
      ),
    ).toBe(false);
    expect(messagesCarrySessionId([idBearingUser], '')).toBe(false);
  });
});
