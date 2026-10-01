import type { AgentExtension } from '@mavis/agent-runtime';
import { createGoalFinalReplyGate } from '@mavis/goal';

import type { LocalTurnToolPolicyGuard } from '../../service/turn-system/index.js';

export interface GoalFinalReply {
  /** Goal's own pre-tool check; compose it first so its refusal reason wins. */
  readonly toolPolicyGuard: LocalTurnToolPolicyGuard;
  /** Records the accepted proposal, retries one empty reply, clears state at Turn end. */
  readonly extension: AgentExtension;
}

/**
 * The last step of a Turn whose Goal completion proposal was accepted: every
 * later tool call is refused and one empty response is retried. Nothing
 * changes before the proposal, in other Turns, or in ordinary conversations.
 * Both parts share one gate, so compose them from one instance. The guard has
 * no Turn identity; it finds the Turn by the agent run's context object, which
 * the extension's `after_tool_call` receives as `input.context`.
 */
export function createGoalFinalReply(): GoalFinalReply {
  const gate = createGoalFinalReplyGate();
  return {
    toolPolicyGuard: {
      async beforeToolCall(input) {
        return gate.refuseToolCall(input.toolContext.context);
      },
    },
    extension: {
      id: 'local-goal-final-reply',
      description:
        'After an accepted Goal completion proposal, track the Turn for the tool guard and retry one empty final reply.',
      init(pi) {
        pi.on('after_tool_call', (input, _signal, turn) => {
          gate.observeToolResult(turn, input.context, {
            toolName: input.toolCall.name,
            details: input.result.details,
            isError: input.isError,
          });
          return undefined;
        });
        pi.on('after_llm_call', (event, turn) => gate.reviewResponse(turn, event.message));
        pi.on('turn_end', (_event, turn) => gate.endTurn(turn));
      },
    },
  };
}
