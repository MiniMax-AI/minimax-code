import type { PiBeforeLlmCallHook } from '@mavis/agent-core/pi-turn-runner';

import {
  SESSION_IDENTITY_REMINDER_CUSTOM_TYPE,
  messagesCarrySessionId,
} from '../../agent-host/compaction/session-identity.js';
import type { ContextUsageAnchorState } from '../../compaction/execution/usage-anchor.js';
import { fitsReminderInFinalRequest } from './reminder-admission.js';

/**
 * The turn reminder omits the session ID while earlier history still shows it,
 * so compaction that summarizes that history away must restore the ID.
 */
export function createSessionIdentityReminderHook(
  usageAnchor: ContextUsageAnchorState,
): PiBeforeLlmCallHook {
  return (input) => {
    if (!input.sessionId || messagesCarrySessionId(input.messages, input.sessionId)) {
      return undefined;
    }
    const marker = {
      role: 'custom' as const,
      customType: SESSION_IDENTITY_REMINDER_CUSTOM_TYPE,
      content: `<system-reminder>\nYOUR SESSION ID: ${input.sessionId}\n</system-reminder>`,
      display: false as const,
      timestamp: Date.now(),
    };
    if (!fitsReminderInFinalRequest(input, marker, usageAnchor)) return undefined;
    return {
      type: 'appendMessage',
      reason: SESSION_IDENTITY_REMINDER_CUSTOM_TYPE,
      message: marker,
      ...(input.phase === 'initial' ? { placement: 'before-current-user' as const } : {}),
    };
  };
}
