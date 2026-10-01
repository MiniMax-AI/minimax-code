import { GOAL_COMPLETION_TOOL_REFUSAL, GOAL_FINAL_REPLY_RETRY_PROMPT } from '@mavis/goal';
import { describe, expect, it } from 'vitest';

import {
  combineLocalTurnToolPolicyGuards,
  createGoalBudgetToolPolicyGuard,
} from './goal-budget-tool-policy.js';
import { createGoalFinalReply } from './goal-final-reply.js';

type Handler = (...args: never[]) => unknown;

function install() {
  const finalReply = createGoalFinalReply();
  const handlers = new Map<string, Handler>();
  finalReply.extension.init({
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as never);
  const call = (event: string, ...args: unknown[]) =>
    (handlers.get(event) as (...values: unknown[]) => unknown)(...args);
  return { finalReply, handlers, call };
}

const turn = { sessionId: 'sess_1', turnId: 'turn_1' };
// The agent run's context object: the same object reaches every tool hook of one run.
const run = { messages: [] };
const otherRun = { messages: [] };

function toolResult(name: string, details: unknown, isError = false, context: object = run) {
  return { toolCall: { name }, result: { details }, isError, context };
}

function acceptedCompletion() {
  return toolResult('update_goal', { proposal: { status: 'complete', accepted: true } });
}

function response(content: unknown[], stopReason = 'stop') {
  return { message: { role: 'assistant', content, stopReason } };
}

function policyInput(
  context: object,
  name: string,
  args: Record<string, unknown> = {},
  genuineUserQueryText = '',
) {
  return {
    genuineUserQueryText,
    toolContext: { toolCall: { id: 'call_1', name }, args, context } as never,
  };
}

describe('Goal final reply', () => {
  it('registers only result, response and Turn-end hooks on the extension', () => {
    const { handlers } = install();
    expect([...handlers.keys()].sort()).toEqual(['after_llm_call', 'after_tool_call', 'turn_end']);
  });

  it('refuses tools and retries one empty response only after this Turn accepted completion', async () => {
    const { finalReply, call } = install();
    const guard = finalReply.toolPolicyGuard;
    const empty = response([{ type: 'thinking', thinking: 'done' }]);

    // Before the proposal: tools run and empty responses are left alone.
    await expect(guard.beforeToolCall(policyInput(run, 'write'))).resolves.toBeUndefined();
    expect(await call('after_llm_call', empty, turn)).toEqual({ type: 'continue' });

    await call('after_tool_call', acceptedCompletion(), undefined, turn);

    await expect(guard.beforeToolCall(policyInput(run, 'write'))).resolves.toEqual({
      block: true,
      reason: GOAL_COMPLETION_TOOL_REFUSAL,
    });
    await expect(guard.beforeToolCall(policyInput(otherRun, 'write'))).resolves.toBeUndefined();
    expect(await call('after_llm_call', empty, turn)).toMatchObject({
      type: 'retry',
      prompt: GOAL_FINAL_REPLY_RETRY_PROMPT,
    });
    expect(await call('after_llm_call', empty, turn)).toEqual({ type: 'continue' });

    await call('turn_end', {}, turn);
    await expect(guard.beforeToolCall(policyInput(run, 'write'))).resolves.toBeUndefined();
  });

  it('ignores accepted blocks, rejected proposals and other tools', async () => {
    const { finalReply, call } = install();
    await call(
      'after_tool_call',
      toolResult('update_goal', { proposal: { status: 'blocked', accepted: true } }),
      undefined,
      turn,
    );
    await call(
      'after_tool_call',
      toolResult('update_goal', { error: 'objective changed' }, true),
      undefined,
      turn,
    );
    await call('after_tool_call', toolResult('bash', {}), undefined, turn);

    await expect(
      finalReply.toolPolicyGuard.beforeToolCall(policyInput(run, 'write')),
    ).resolves.toBeUndefined();
  });

  it('answers ahead of the budget policy, so every refused call asks for the final reply', async () => {
    // Same order as the production turn-system composition: Goal final reply
    // first, then the existing policies, including the budget-mode guard that
    // refuses budget updates on autonomous Turns for a different reason.
    const { finalReply, call } = install();
    const chain = combineLocalTurnToolPolicyGuards(
      finalReply.toolPolicyGuard,
      createGoalBudgetToolPolicyGuard(),
    );
    const budgetUpdate = { mode: 'token_budget', token_budget: 1_000 };

    await expect(
      chain.beforeToolCall(policyInput(run, 'update_goal', budgetUpdate)),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('explicit user request'),
    });

    await call('after_tool_call', acceptedCompletion(), undefined, turn);

    for (const [name, args] of [
      ['update_goal', budgetUpdate],
      ['update_goal', { mode: 'status', status: 'complete' }],
      ['update_goal', { mode: 'status', status: 'blocked' }],
      ['bash', { command: 'touch after.txt' }],
    ] as const) {
      await expect(chain.beforeToolCall(policyInput(run, name, args))).resolves.toEqual({
        block: true,
        reason: GOAL_COMPLETION_TOOL_REFUSAL,
      });
    }
  });
});
