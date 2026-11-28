import type { PiAfterLlmCallHook, PiBeforeLlmCallHook } from '@mavis/agent-core/pi-turn-runner';
import {
  compactionSummaryKey,
  compactionSummaryTimestamp,
  findLastCompactionSummary,
} from '../mcp-disclosure/compaction-summary.js';
import { isAnsweredResponse, isNewestNotice } from '../mcp-disclosure/window-notice.js';
import { SKILL_AVAILABILITY_NOTICE_TAG, userMessageText } from './notice.js';
import {
  confirmSkillCatalogAnnouncement,
  noteSkillCatalogCompaction,
  noteSkillCatalogNoticeInHistory,
  pendingSkillCatalogNotice,
  plannedSkillCatalogWindow,
  receiveSkillCatalogResponse,
} from './state.js';

/**
 * The before-LLM half of the skill-catalog window, created per Turn after its
 * catalog was planned and registered next to Tool Search's request hook (after
 * the compaction hook, so it sees the replaced history). It never changes the
 * request. Each request marks the Turn's planned window as sent, confirms the
 * Turn's pending skill-availability update once it is the newest update among
 * the user messages after the request's last assistant message, notes an update
 * of an earlier process in a Session's first request history, then reports the
 * latest compaction summary, which ends the window when it is new.
 */
export function createSkillCatalogContextHook(input: {
  readonly sessionId: string;
}): PiBeforeLlmCallHook {
  const { sessionId } = input;
  const planned = plannedSkillCatalogWindow(sessionId);
  return ({ messages }) => {
    try {
      if (planned) planned.sent = true;
      const notice = pendingSkillCatalogNotice(sessionId);
      if (notice && isNewestNotice(messages, notice, SKILL_AVAILABILITY_NOTICE_TAG, true)) {
        confirmSkillCatalogAnnouncement(sessionId);
      }
      noteSkillCatalogNoticeInHistory(sessionId, () =>
        messagesHaveSkillAvailabilityNotice(messages),
      );
      // After confirming: the update may sit in the kept recent tail.
      const summary = messages[findLastCompactionSummary(messages)];
      if (summary) {
        noteSkillCatalogCompaction(
          sessionId,
          compactionSummaryKey(summary),
          compactionSummaryTimestamp(summary),
        );
      }
    } catch {
      // Bookkeeping must not affect the request.
    }
    return undefined;
  };
}

/**
 * The after-LLM half, registered with the request hook: once a request of the
 * Turn is answered (the provider answered, or was stopped after streaming part
 * of an answer), the window the Turn planned becomes the Session's. A Turn with
 * no answered request wrote no prompt cache, so it freezes nothing.
 */
export function createSkillCatalogResponseHook(input: {
  readonly sessionId: string;
}): PiAfterLlmCallHook {
  const { sessionId } = input;
  const planned = plannedSkillCatalogWindow(sessionId);
  return ({ message }) => {
    try {
      if (isAnsweredResponse(message)) receiveSkillCatalogResponse(sessionId, planned);
    } catch {
      // Bookkeeping must not affect the response.
    }
    return undefined;
  };
}

/**
 * Whether a user message of `messages` carries a skill-availability update. Hosts
 * pass their stored history (Pi messages or envelopes of the same shape) at plan
 * time, so a Session's first Turn in this process can supersede an update an
 * earlier process (or the Session a side chat / fork copied) left behind.
 */
export function messagesHaveSkillAvailabilityNotice(messages: readonly unknown[]): boolean {
  return messages.some(
    (message) => userMessageText(message)?.includes(SKILL_AVAILABILITY_NOTICE_TAG) === true,
  );
}
