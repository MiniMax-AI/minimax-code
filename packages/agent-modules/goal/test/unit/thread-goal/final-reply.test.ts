import { describe, expect, it } from 'vitest';

import {
  GOAL_COMPLETION_TOOL_REFUSAL,
  GOAL_FINAL_REPLY_RETRY_PROMPT,
  GOAL_FINAL_REPLY_RETRY_REASON,
  createGoalFinalReplyGate,
  isAcceptedGoalCompletionResult,
} from '../../../src/final-reply.js';
import { isInternalContextMessage } from '../../../src/internal-context-fragment.js';

const turn = { sessionId: 'sess_1', turnId: 'turn_1' };
// The agent run's context object that the before- and after-tool hooks share.
const run = { messages: [] };
const acceptedComplete = {
  toolName: 'update_goal',
  details: { proposal: { status: 'complete', accepted: true } },
  isError: false,
};
const empty = { stopReason: 'stop', content: [{ type: 'thinking' }] };

describe('Goal final reply gate', () => {
  it('recognizes only an accepted completion proposal result', () => {
    expect(isAcceptedGoalCompletionResult(acceptedComplete)).toBe(true);
    expect(
      isAcceptedGoalCompletionResult({
        ...acceptedComplete,
        details: { proposal: { status: 'blocked', accepted: true } },
      }),
    ).toBe(false);
    expect(isAcceptedGoalCompletionResult({ ...acceptedComplete, isError: true })).toBe(false);
    expect(isAcceptedGoalCompletionResult({ ...acceptedComplete, toolName: 'get_goal' })).toBe(
      false,
    );
    expect(
      isAcceptedGoalCompletionResult({ ...acceptedComplete, details: { error: 'stale' } }),
    ).toBe(false);
  });

  it('leaves tool calls and empty responses alone until the proposal is accepted', () => {
    const gate = createGoalFinalReplyGate();
    expect(gate.refuseToolCall(run)).toBeUndefined();
    expect(gate.reviewResponse(turn, empty)).toEqual({ type: 'continue' });

    gate.observeToolResult(turn, run, { toolName: 'bash', details: {}, isError: false });
    gate.observeToolResult(turn, run, {
      toolName: 'update_goal',
      details: { proposal: { status: 'blocked', accepted: true } },
      isError: false,
    });
    expect(gate.refuseToolCall(run)).toBeUndefined();
  });

  it('refuses every later tool call in the accepting agent run only', () => {
    const gate = createGoalFinalReplyGate();
    gate.observeToolResult(turn, run, acceptedComplete);

    expect(gate.refuseToolCall(run)).toEqual({ block: true, reason: GOAL_COMPLETION_TOOL_REFUSAL });
    expect(GOAL_COMPLETION_TOOL_REFUSAL).toContain('Do not call another tool');
    expect(GOAL_COMPLETION_TOOL_REFUSAL).toContain('write the final reply');
    expect(gate.refuseToolCall({ messages: [] })).toBeUndefined();

    gate.endTurn(turn);
    expect(gate.refuseToolCall(run)).toBeUndefined();
  });

  it('retries one empty response after the proposal, then lets the Turn end', () => {
    const gate = createGoalFinalReplyGate();
    gate.observeToolResult(turn, run, acceptedComplete);

    expect(gate.reviewResponse(turn, empty)).toEqual({
      type: 'retry',
      reason: GOAL_FINAL_REPLY_RETRY_REASON,
      prompt: GOAL_FINAL_REPLY_RETRY_PROMPT,
    });
    expect(gate.reviewResponse(turn, empty)).toEqual({ type: 'continue' });
    expect(gate.reviewResponse(turn, empty)).toEqual({ type: 'continue' });
  });

  it('does not retry a response with text, tool intent, or a provider failure', () => {
    const gate = createGoalFinalReplyGate();
    gate.observeToolResult(turn, run, acceptedComplete);

    expect(
      gate.reviewResponse(turn, { stopReason: 'stop', content: [{ type: 'text', text: 'Done.' }] }),
    ).toEqual({ type: 'continue' });
    expect(gate.reviewResponse(turn, { stopReason: 'toolUse', content: [{ type: 'toolCall' }] })).toEqual({
      type: 'continue',
    });
    expect(gate.reviewResponse(turn, { stopReason: 'error', content: [] })).toEqual({
      type: 'continue',
    });
    expect(gate.reviewResponse(turn, { stopReason: 'aborted', content: [] })).toEqual({
      type: 'continue',
    });
    // The single retry is still available for a genuinely empty response.
    expect(gate.reviewResponse(turn, empty).type).toBe('retry');
  });

  it('sends the retry as hidden Goal context', () => {
    expect(
      isInternalContextMessage({
        role: 'user',
        content: [{ type: 'text', text: GOAL_FINAL_REPLY_RETRY_PROMPT }],
        timestamp: 0,
      }),
    ).toBe(true);
    expect(GOAL_FINAL_REPLY_RETRY_PROMPT).toContain('Do not call any tools');
    expect(GOAL_FINAL_REPLY_RETRY_PROMPT).toContain('Do not claim that verification has passed');
  });
});
