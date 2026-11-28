import {
  bindTool,
  type ToolExecutionContext,
  type ToolImpl,
  type ToolResult,
} from '@mavis/agent-core/tools';

import { LocalAskUserToolDef, type LocalAskUserToolInput } from './defs.js';
import type {
  AskUserAdapter,
  LocalAskUserSyncOutcome,
  LocalAskUserV2BeginResult,
} from './types.js';

// Model-facing results for AskUser v2 questionnaires. Kept short: the tool
// description already explains sync/async; these only state what happened
// and what the model should do next. The async result repeats the assumption
// rule from the tool description's `async: true` line in the same words, so the
// model gets one rule rather than two: only an answer that decides the
// deliverable's direction must not be assumed, and proceeding on a likely
// answer for anything else must be stated as an assumption.
//
// In Goal mode with the `skip` policy a question waits at most 60 seconds; if
// nobody answers, the runtime selects each question's recommended option and
// the result opens with `goalAutoSelected`. Why not answer at once: in the
// 2026-10-22 local Desktop check, a Goal question that returned immediately
// with "proceed on the recommended option" led the model to report the
// recommended option as the user's choice and complete the Goal on it. Legacy
// Goal questionnaires adopted the recommendation only after a timeout, marked
// as not confirmed by the user; this follows them, and the text says outright
// that these are not the user's choices.
export const ASK_USER_RESULT_TEXT = {
  syncOverridden:
    "Note: the user's settings require questions in this context to wait for an answer, so this call waited even though async was requested.",
  syncDismissed:
    'The user did not answer this question (skipped or closed it). Do not ask it again; continue as if it is unanswered. The user may still answer later; the answer would arrive as a new message.',
  syncNewMessage:
    'The user did not answer this question and sent a new message instead. Handle the new message. The question stays open and may still be answered later.',
  syncNewMessageQueued:
    'The user did not answer this question and sent a new message instead, which will be handled after this turn. End this turn now instead of continuing. The question stays open and may still be answered later.',
  syncNewMessageQueuedNotAsked:
    'Question not asked: the user already sent a new message, which will be handled after this turn. End this turn now instead of continuing.',
  syncExpired:
    'This question expired before the user answered it and can no longer be answered. Do not ask it again; continue as if it is unanswered.',
  syncSuperseded:
    'A newer question replaced this one before the user answered it, so it can no longer be answered. Do not ask it again; continue as if it is unanswered.',
  asyncShown:
    "The question is shown to the user; this call did not wait for an answer. Keep doing work that does not depend on the answer. Never assume an answer that decides the deliverable's direction; if your next step depends on one, end this turn instead. Where you proceed on a likely answer for anything else, state it as an assumption. If the user answers, the answer arrives as a new message; do not ask again.",
  asyncOverridden:
    "The user's settings make questions in this context never wait, so this call did not wait even though it asked to.",
  goalAutoSelected:
    "The user did not answer within 60 seconds, so the recommended option for each question was selected automatically. These are not the user's choices: when you mention them, say they were selected automatically and the user can still change them; never say the user chose or replied. Proceed on them. Never take an irreversible, externally visible, authentication, or other safety-sensitive action on an automatically selected answer; leave that step undone and continue other work. If the user wants something else, they will tell you in a new message.",
} as const;

@bindTool(LocalAskUserToolDef)
export class LocalAskUserTool<TContext extends ToolExecutionContext> implements ToolImpl<
  typeof LocalAskUserToolDef.schema,
  TContext
> {
  constructor(private readonly adapter: AskUserAdapter<TContext>) {}

  async execute(
    ctx: TContext,
    input: LocalAskUserToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    // A sync v2 questionnaire waits inside this call. Stop rejects the wait
    // with the "stopped while waiting" message, which pi-agent-core records as
    // this call's error result; nothing else is injected.
    const result = await this.adapter.begin(ctx, input, signal);
    if ('suppressed' in result) {
      // Decision v3: a question raised while the user already has an
      // instruction in flight is superseded, not asked. No questionnaire
      // exists, nothing renders, and the turn keeps running (no terminate).
      const text =
        'Question not asked: the user already sent a new instruction while this question was being raised. Follow the incoming user message instead.';
      return {
        tool_name: LocalAskUserToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: {
          suppressed: true,
          reason: result.reason,
          waiting_for_user: false,
        },
      };
    }
    if ('responseMode' in result) return v2Result(result);
    // Legacy questionnaire (CLI/TUI runtime, feature-enable): unchanged
    // turn-ending protocol; the answer arrives later as a user message. An
    // IM-originated Turn inside the Desktop runtime asks a v2 questionnaire like
    // any other Turn, so it takes the branch above and never terminates.
    const text = `Questionnaire ${result.requestId} is waiting for the local user. Stop this turn until the user replies.`;
    return {
      tool_name: LocalAskUserToolDef.name,
      text,
      content: [{ type: 'text', text }],
      details: {
        request_id: result.requestId,
        schema_version: result.schemaVersion,
        step_count: result.stepCount,
        waiting_for_user: true,
      },
      terminate: true,
    };
  }
}

/**
 * v2 questionnaires never terminate the Turn, so `waiting_for_user` is always
 * false: the Goal orchestrator must not treat the Turn as parked on the user.
 */
function v2Result(result: LocalAskUserV2BeginResult): ToolResult {
  const text = v2Text(result);
  const answered = result.outcome?.kind === 'answered' ? result.outcome : undefined;
  return {
    tool_name: LocalAskUserToolDef.name,
    text,
    content: [{ type: 'text', text }, ...(answered?.imageContent ?? [])],
    details: {
      request_id: result.requestId,
      schema_version: result.schemaVersion,
      step_count: result.stepCount,
      waiting_for_user: false,
      response_mode: result.responseMode,
      policy_overridden: result.policyOverridden,
      answered: result.outcome?.kind === 'answered',
      ...(answered?.autoSelected ? { auto_selected: true } : {}),
      ...(answered?.contextImages?.length ? { context_images: answered.contextImages } : {}),
      ...((result.outcome?.kind === 'answered' || result.outcome?.kind === 'dismissed') &&
      result.outcome.answers
        ? { answers: result.outcome.answers }
        : {}),
    },
  };
}

function v2Text(result: LocalAskUserV2BeginResult): string {
  if (result.responseMode === 'async') {
    const shown = `Question ${result.requestId}: ${ASK_USER_RESULT_TEXT.asyncShown}`;
    return result.policyOverridden ? `${ASK_USER_RESULT_TEXT.asyncOverridden} ${shown}` : shown;
  }
  switch (result.outcome?.kind) {
    case 'answered':
      // Flagged by the runtime, never inferred from the answer text.
      if (result.outcome.autoSelected) {
        return `${ASK_USER_RESULT_TEXT.goalAutoSelected}\n\n${result.outcome.content}`;
      }
      return result.policyOverridden
        ? `${result.outcome.content}\n\n${ASK_USER_RESULT_TEXT.syncOverridden}`
        : result.outcome.content;
    case 'new_message':
      return ASK_USER_RESULT_TEXT.syncNewMessage;
    // A queued message only reaches the model after this Turn ends, so the
    // model must stop instead of continuing on stale intent.
    case 'new_message_queued':
      return result.outcome.notAsked
        ? ASK_USER_RESULT_TEXT.syncNewMessageQueuedNotAsked
        : ASK_USER_RESULT_TEXT.syncNewMessageQueued;
    case 'dismissed':
      return dismissedText(result.outcome);
    default:
      return ASK_USER_RESULT_TEXT.syncDismissed;
  }
}

const CLOSED_TEXT = {
  expired: ASK_USER_RESULT_TEXT.syncExpired,
  superseded: ASK_USER_RESULT_TEXT.syncSuperseded,
} as const;

/** A closed question can no longer be answered, so it says why first and never says "may still answer later". */
function dismissedText(outcome: Extract<LocalAskUserSyncOutcome, { kind: 'dismissed' }>): string {
  if (outcome.closed) {
    const note = CLOSED_TEXT[outcome.closed];
    return outcome.content ? `${note}\n\n${outcome.content}` : note;
  }
  return outcome.content
    ? `${outcome.content}\n\n${ASK_USER_RESULT_TEXT.syncDismissed}`
    : ASK_USER_RESULT_TEXT.syncDismissed;
}
