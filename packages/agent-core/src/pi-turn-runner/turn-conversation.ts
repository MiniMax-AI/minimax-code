/**
 * The `conversation` label of the turn-level first-output metrics: whether a
 * turn opens a conversation or continues one.
 *
 * A turn is `new` when the history before its own input holds no user,
 * assistant or compaction summary message. `prompt` appends the turn's input
 * after `history`, so all of `history` precedes it; `continue` and
 * `resume-tool-calls` append nothing and re-enter a loop the history already
 * holds, so all of it counts too. Hidden custom messages and tool results are
 * not a conversation.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { TurnConversationLabel } from '@mavis/shared/local-runtime-logging/metric-registry';

const CONVERSATION_ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'compactionSummary']);

export function turnConversation(
  history: readonly AgentMessage[] | undefined,
): TurnConversationLabel {
  return history?.some((message) => CONVERSATION_ROLES.has(message.role)) ? 'existing' : 'new';
}
