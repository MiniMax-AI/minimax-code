/**
 * Goal wrap-up after an accepted completion proposal.
 *
 * An accepted `update_goal(status=complete)` no longer ends the Turn: the
 * worker writes one final reply to the user in the same Turn, and the Host
 * settles and verifies afterwards. This module owns the Goal side of that
 * last step, host-agnostic like the tool impls:
 *
 *  - the instruction returned with the accepted proposal;
 *  - the refusal for every later tool call in the same Turn, `update_goal`
 *    included, so the accepted proposal cannot be replaced and no more work
 *    runs after the worker claimed completion;
 *  - one retry when the response after the proposal is empty. A second empty
 *    response ends the Turn normally; the proposal still goes to settlement.
 *
 * State only exists after this Turn's proposal was accepted, so other Turns,
 * ordinary chats and Goal Turns before the proposal are never affected. The
 * refusal is keyed by the agent run's context object — the `context` both the
 * before- and after-tool hooks of one agent run receive — so a pre-tool check
 * that has no Turn identity still finds its run. The retry is keyed by
 * (sessionId, turnId); hosts must call `endTurn` when a Turn ends.
 */

import { wrapInternalContext } from './internal-context-fragment.js';

/** Returned with an accepted completion proposal; the worker's last step in this Turn. */
export const GOAL_FINAL_REPLY_INSTRUCTION =
  'The completion proposal was accepted. Do not call any more tools in this turn: every further tool call, including update_goal, will be refused. ' +
  'Now write one final reply to the user: say what was accomplished, where each deliverable file is, and how to use it when that is not obvious. ' +
  'Declare every deliverable file of this goal, including files produced in earlier turns, with delivery markup (<media /> tags inside <deliver-assets>...</deliver-assets>), and also write each file path in the reply text. ' +
  'The host verifies the goal only after this reply, so do not claim that verification has passed or that the result is verified or confirmed; describe checks you ran yourself as checks you ran, not as verification.';

/** Result of every tool call refused after this Turn's completion proposal was accepted. */
export const GOAL_COMPLETION_TOOL_REFUSAL =
  'GOAL_COMPLETION_PROPOSED: This turn already proposed completion and the proposal was accepted. Do not call another tool; write the final reply to the user now.';

/** Hidden follow-up sent once when the response after the accepted proposal is empty. */
export const GOAL_FINAL_REPLY_RETRY_PROMPT = wrapInternalContext(
  'goal',
  'Your completion proposal was accepted, but your last response was empty. Do not call any tools. ' +
    'Write the final reply to the user now: what was accomplished, where each deliverable file is (with delivery markup and the file path), and how to use it when that is not obvious. ' +
    'Do not claim that verification has passed or that the result is verified.',
);

export const GOAL_FINAL_REPLY_RETRY_REASON = 'goal_final_reply_empty';

export interface GoalFinalReplyTurn {
  readonly sessionId: string;
  readonly turnId: string;
}

/** The parts of an assistant response the gate reads. */
export interface GoalFinalReplyResponse {
  readonly stopReason?: string;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

export type GoalFinalReplyResponseDecision =
  | { readonly type: 'continue' }
  | { readonly type: 'retry'; readonly reason: string; readonly prompt: string };

export interface GoalFinalReplyGate {
  /**
   * Record an executed tool result; only an accepted completion proposal
   * changes state. `run` is the agent context object the tool hooks received.
   */
  observeToolResult(
    turn: GoalFinalReplyTurn,
    run: object,
    result: { readonly toolName: string; readonly details: unknown; readonly isError: boolean },
  ): void;
  /** Refusal for a tool call in an agent run whose completion proposal was accepted. */
  refuseToolCall(run: object): { readonly block: true; readonly reason: string } | undefined;
  /** Retry once when the response after the accepted proposal has neither text nor tool calls. */
  reviewResponse(
    turn: GoalFinalReplyTurn,
    response: GoalFinalReplyResponse,
  ): GoalFinalReplyResponseDecision;
  endTurn(turn: GoalFinalReplyTurn): void;
}

/** True for the result `update_goal` returns when this Turn's completion proposal was accepted. */
export function isAcceptedGoalCompletionResult(result: {
  readonly toolName: string;
  readonly details: unknown;
  readonly isError: boolean;
}): boolean {
  if (result.isError || result.toolName !== 'update_goal') return false;
  const details = result.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return false;
  const proposal = (details as { proposal?: unknown }).proposal;
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return false;
  const { status, accepted } = proposal as { status?: unknown; accepted?: unknown };
  return status === 'complete' && accepted === true;
}

interface TurnState {
  retried: boolean;
  readonly runs: Set<object>;
}

export function createGoalFinalReplyGate(): GoalFinalReplyGate {
  const turns = new Map<string, TurnState>();
  const acceptedRuns = new WeakSet<object>();
  const keyOf = (turn: GoalFinalReplyTurn) => `${turn.sessionId}\u0000${turn.turnId}`;

  return {
    observeToolResult(turn, run, result) {
      if (!isAcceptedGoalCompletionResult(result)) return;
      acceptedRuns.add(run);
      const state = turns.get(keyOf(turn)) ?? { retried: false, runs: new Set<object>() };
      state.runs.add(run);
      turns.set(keyOf(turn), state);
    },
    refuseToolCall(run) {
      return acceptedRuns.has(run)
        ? { block: true, reason: GOAL_COMPLETION_TOOL_REFUSAL }
        : undefined;
    },
    reviewResponse(turn, response) {
      const state = turns.get(keyOf(turn));
      if (!state || state.retried) return { type: 'continue' };
      if (response.stopReason === 'error' || response.stopReason === 'aborted') {
        return { type: 'continue' };
      }
      const hasText = response.content.some(
        (block) => block.type === 'text' && (block.text ?? '').trim().length > 0,
      );
      const hasToolCall = response.content.some((block) => block.type === 'toolCall');
      if (hasText || hasToolCall) return { type: 'continue' };
      state.retried = true;
      return {
        type: 'retry',
        reason: GOAL_FINAL_REPLY_RETRY_REASON,
        prompt: GOAL_FINAL_REPLY_RETRY_PROMPT,
      };
    },
    endTurn(turn) {
      for (const run of turns.get(keyOf(turn))?.runs ?? []) acceptedRuns.delete(run);
      turns.delete(keyOf(turn));
    },
  };
}
