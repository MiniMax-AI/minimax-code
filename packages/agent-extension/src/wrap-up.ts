import {
  defineRuntimeTool,
  NEXT_STEP_APP_ACTIONS,
  NEXT_STEP_ASK_MAX,
  NEXT_STEP_ASK_TARGET,
  NEXT_STEP_MAX_ACTIONS,
  NEXT_STEP_RECAP_MAX,
  isBackgroundTaskUserMessage,
  isHostSubmittedUserInput,
  isNextStepAction,
  readNextStepCard,
  readMiniAppSuggestion,
  type MiniAppSuggestionBrief,
  trimNextStepActions,
  TURN_STOPPING_TOOL_RESULT_DETAIL,
  TURN_TERMINATING_TOOL_RESULT_DETAIL,
  type NextStepAction,
  type NextStepAppAction,
  type AgentExtension,
  type ModelContextAssemblyCtx,
} from '@mavis/agent-runtime';
import { Type } from '@sinclair/typebox';

export const WRAP_UP_GUIDANCE = `<next-step-box>
Write your complete answer as normal text first: the user must be able to read the findings, draft, options or plan there. Then, if a specific decision or unknown remains for the user, call wrap_up once, alone, as the last step. Calling it ends the turn at once, nothing comes back to you, and it never replaces your answer.

If you were about to end your reply by asking the user to decide, confirm or supply something about this result, make it the ask of your wrap_up tool call instead of writing it at the end of your text. The user clicks an answer; typing stays available. wrap_up is a tool call: never write wrap_up, its fields or these tags into your reply text.

Ask only if all of these hold:
- It comes from this turn's actual result, and the conversation has not answered, refused or delegated it.
- Different answers would change your assessment, recommendation or next action.
- It is not a request to continue authorized work (do that now), an acknowledgement, "anything else?", or an offer of extras such as more tests, docs, exports or estimates. Do not offer those in text either.
With no such question, skip wrap_up unless another enabled option explicitly applies.

If the user explicitly asked you to confirm a decision after this stage, that confirmation can be the question in wrap_up.

Routing: if missing information stops the work you were asked to do, use ask_user before acting; never guess a recipient, path or value and ask afterwards. If the user asked to finish a stage first and then decide or confirm, finish it and ask here. Several independent decisions go to ask_user with async=true, not here.

Declare decision: user_requested (the user asked to confirm this afterwards), unresolved_choice (alternatives within the goal differ materially and the user has not chosen or delegated), permission_boundary (a required next operation needs authorization), contextual_follow_up (an unknown about the user's situation or preference would change your advice; never blocks).

Writing, in the conversation's language:
- recap: at most 96 characters; a longer recap is not shown. The result and what is not done or not verified. It must make sense alone, never "see above".
- ask: at most ${NEXT_STEP_ASK_TARGET} characters, one decision.
- actions: 0-4; with none, the user answers in the composer. A reply label is sent verbatim as the user's message, so it states the full answer to this question in the user's voice, at most 24 characters, and nothing beyond it. Put a recommended option first with recommended=true only when your answer argues for it, never for facts about the user.
- app_action opens a built-in operation and never runs it by itself: commit opens the commit dialog, review_changes opens this turn's diff, new_session creates a session, archive_session archives this one. Use at most 2 buttons when one of them is an app_action. One that is unavailable right now is left off the card.
Example: two drafted documents still lack a table of contents. Ask 两份文档都加目录吗？ with the replies 都加目录 (recommended) and 暂不加.
Example: whether to keep a Cursor subscription depends on the user's habits. Ask 你平时还打开 Cursor 写代码吗？ with the replies 基本不用 and 还在用, none recommended.
Set blocked=true only if work cannot proceed without the answer. A new user message replaces an unanswered card; treat the card as context, not approval.
</next-step-box>`;

/** Declared reasons a question is needed; omitted or 'none' closes the turn without a card. */
const WRAP_UP_DECISIONS = [
  'user_requested',
  'unresolved_choice',
  'permission_boundary',
  'contextual_follow_up',
] as const;
type WrapUpDecision = (typeof WRAP_UP_DECISIONS)[number];

const recommended = Type.Optional(
  Type.Boolean({ description: 'Evidence-backed only. Never for facts about the user.' }),
);

// Length limits live in the descriptions, not as schema keywords: the schema counts UTF-16
// units and the card counts code points, and prepareWrapUpArguments enforces the latter.
export const WrapUpSchema = Type.Object(
  {
    recap: Type.String({
      description: `Result and what is not done or not verified. At most ${NEXT_STEP_RECAP_MAX} characters; a longer one is not shown. Must make sense alone.`,
    }),
    decision: Type.Optional(
      Type.Union(
        [Type.Literal('none'), ...WRAP_UP_DECISIONS.map((decision) => Type.Literal(decision))],
        {
          description:
            'Why a question is needed. Omit or none when no question remains: the turn closes without a card.',
        },
      ),
    ),
    ask: Type.Optional(
      Type.String({ description: `One question, at most ${NEXT_STEP_ASK_TARGET} characters.` }),
    ),
    actions: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Object(
            {
              kind: Type.Literal('reply'),
              label: Type.String({
                description: "The user's full answer, sent verbatim. Prefer at most 24 characters.",
              }),
              recommended,
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              kind: Type.Literal('app_action'),
              action: Type.Union(NEXT_STEP_APP_ACTIONS.map((action) => Type.Literal(action))),
              payload: Type.Optional(Type.String()),
              recommended,
            },
            { additionalProperties: false },
          ),
        ]),
        {
          maxItems: NEXT_STEP_MAX_ACTIONS,
          description: `0-${NEXT_STEP_MAX_ACTIONS} answers to ask, or App actions; with none, the user answers in the composer.`,
        },
      ),
    ),
    selectionMode: Type.Optional(Type.Union([Type.Literal('single'), Type.Literal('multiple')])),
    allowOther: Type.Optional(Type.Boolean()),
    blocked: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const miniAppFields = Type.Object(
  {
    title: Type.String(),
    reason: Type.String(),
    accepted: Type.String(),
    rules: Type.String(),
    inputs: Type.String(),
    outputs: Type.String(),
  },
  { additionalProperties: false },
);
const miniAppOnlySchema = Type.Object(
  { miniapp_suggestion: Type.Optional(miniAppFields) },
  { additionalProperties: false },
);
const combinedSchema = Type.Object(
  {
    ...WrapUpSchema.properties,
    recap: Type.Optional(WrapUpSchema.properties.recap),
    miniapp_suggestion: Type.Optional(miniAppFields),
  },
  { additionalProperties: false },
);

interface WrapUpInput {
  miniapp_suggestion?: MiniAppSuggestionBrief;
  recap: string;
  decision?: WrapUpDecision;
  ask?: string;
  actions?: NextStepAction[];
  selectionMode?: 'single' | 'multiple';
  allowOther?: boolean;
  blocked?: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Keeps only the fields the card reads; an answer the card cannot draw is left out. */
function readAction(value: unknown): NextStepAction[] {
  if (!record(value)) return [];
  const flag = typeof value.recommended === 'boolean' ? { recommended: value.recommended } : {};
  const action =
    value.kind === 'reply'
      ? { kind: 'reply', label: value.label, ...flag }
      : {
          kind: value.kind,
          action: value.action,
          ...(value.payload !== undefined ? { payload: value.payload } : {}),
          ...flag,
        };
  return isNextStepAction(action) ? [action] : [];
}

/**
 * The one place a call is made to fit the card, so no call is ever refused: a refusal goes
 * back to the model, which writes another text that history takes as the Turn's answer.
 * Whatever the card cannot hold is dropped; without a question there is no card. Runs before
 * schema validation, and again in execute for callers that skip it. Idempotent.
 */
export function prepareWrapUpArguments(raw: unknown): WrapUpInput {
  const value = record(raw) ? raw : {};
  const decision = WRAP_UP_DECISIONS.find((item) => item === value.decision);
  const ask =
    typeof value.ask === 'string' && value.ask.trim() && [...value.ask].length <= NEXT_STEP_ASK_MAX
      ? value.ask
      : undefined;
  let actions = Array.isArray(value.actions)
    ? value.actions.flatMap(readAction).slice(0, NEXT_STEP_MAX_ACTIONS)
    : undefined;
  let selectionMode: WrapUpInput['selectionMode'] =
    value.selectionMode === 'single' || value.selectionMode === 'multiple'
      ? value.selectionMode
      : undefined;
  let allowOther = typeof value.allowOther === 'boolean' ? value.allowOther : undefined;
  // A card with an App action is a single choice of at most two buttons with no free answer.
  if (actions?.some((action) => action.kind === 'app_action')) {
    actions = actions.slice(0, 2);
    selectionMode = undefined;
    allowOther = undefined;
  }
  // One recommendation in a single choice: the first one the model marked.
  if (selectionMode !== 'multiple' && actions) {
    const first = actions.findIndex((action) => action.recommended === true);
    actions = actions.map((action, index) => {
      if (action.recommended !== true || index === first) return action;
      const rest: NextStepAction = { ...action };
      delete rest.recommended;
      return rest;
    });
  }
  const proposal = readMiniAppSuggestion(value.miniapp_suggestion);
  return {
    ...(proposal ? { miniapp_suggestion: proposal } : {}),
    recap: typeof value.recap === 'string' ? value.recap : '',
    ...(decision ? { decision } : {}),
    ...(ask ? { ask } : {}),
    ...(actions ? { actions } : {}),
    ...(selectionMode ? { selectionMode } : {}),
    ...(allowOther !== undefined ? { allowOther } : {}),
    ...(typeof value.blocked === 'boolean' ? { blocked: value.blocked } : {}),
  };
}

// Normalize before persistence so history, draft indices and submitted answers share one order.
function orderRecommendedActions<T extends { recommended?: boolean }>(actions: T[]): T[] {
  return [...actions].sort(
    (a, b) => Number(b.recommended === true) - Number(a.recommended === true),
  );
}

/** The recap the card shows, or undefined when it is blank or longer than the card allows. */
function shownRecap(recap: string): string | undefined {
  return recap.trim() && [...recap].length <= NEXT_STEP_RECAP_MAX ? recap : undefined;
}

/** True when an assistant message carries visible answer text, not only tool calls or thinking. */
function hasAnswerText(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const { role, content } = message as { role?: unknown; content?: unknown };
  return (
    role === 'assistant' &&
    Array.isArray(content) &&
    content.some((block: unknown) => {
      if (typeof block !== 'object' || block === null) return false;
      const { type, text } = block as { type?: unknown; text?: unknown };
      return type === 'text' && typeof text === 'string' && text.trim().length > 0;
    })
  );
}

/**
 * Reads only this turn: the messages after the latest input (see isUserWritten), which is
 * also where a steering message starts the part the model must answer. In an unattended turn
 * a background-task notice also marks the start, since it may be what started the turn.
 */
function answeredThisTurn(messages: readonly unknown[], noticeStartsTurn: boolean): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isUserWritten(message)) return false;
    if (noticeStartsTurn && isBackgroundTaskUserMessage(message)) return false;
    if (hasAnswerText(message)) return true;
  }
  return false;
}

/**
 * Input that starts the part of a turn the model must answer: a user message the Host
 * submitted, other than a background-task notice. Reminders other extensions steer into the
 * turn (for example the runaway guard) are not input. An empty query text is not a host marker:
 * questionnaire answers, edited resends and attachment-only messages also carry one.
 */
function isUserWritten(message: unknown): boolean {
  return isHostSubmittedUserInput(message) && !isBackgroundTaskUserMessage(message);
}

/** Why a call showed no card, kept in history so a trace says which rule applied. */
type NoCardReason =
  | 'disabled'
  | 'ineligible'
  | 'no_question'
  | 'no_valid_card'
  | 'superseded'
  | 'unreadable';

interface WrapUpOptions {
  enabled(): boolean;
  miniApp?: {
    available(ctx: ModelContextAssemblyCtx): Promise<boolean>;
    permitted(ctx: ModelContextAssemblyCtx): Promise<boolean>;
  };
  /** Input the model has not seen yet: pending steering or a queued user message. */
  hasPendingUserInput(sessionId: string): boolean | Promise<boolean>;
  availableActions(ctx: ModelContextAssemblyCtx): Promise<readonly NextStepAppAction[]>;
}

/**
 * Every call ends the Turn, and nothing it returns asks the model for more: any model request
 * after wrap_up writes a text that history takes as the Turn's answer, folding the real one.
 * Turn kinds and invalid fields only decide whether a card shows. The tool keeps no state.
 * The one refusal left is a call before any answer text: the text written then is the answer.
 */
export function wrapUpExtension(options: WrapUpOptions): AgentExtension {
  // Registered per Session, not per Turn, so every Turn of the Session sends the same prefix.
  const active = (ctx: ModelContextAssemblyCtx) =>
    options.enabled() && ctx.nextStepSessionEligible === true && !ctx.plan;
  return {
    id: 'wrap-up',
    description: 'Optional end-of-turn decision card.',
    init(pi) {
      const registered = new WeakSet<ModelContextAssemblyCtx>();
      pi.contributeSystemPrompt((ctx) => (active(ctx) ? WRAP_UP_GUIDANCE : null));
      pi.registerTool(async (ctx) => {
        registered.delete(ctx);
        if (!ctx.nextStepSessionEligible || ctx.plan) return null;
        const miniApp = await options.miniApp?.available(ctx);
        const questions = active(ctx);
        if (!questions && !miniApp) return null;
        registered.add(ctx);
        return defineRuntimeTool({
          name: 'wrap_up',
          source: 'builtin',
          executionMode: 'sequential',
          schema: miniApp ? (questions ? combinedSchema : miniAppOnlySchema) : WrapUpSchema,
          prepareArguments: (raw) => {
            const { miniapp_suggestion, ...question } = prepareWrapUpArguments(raw);
            return {
              ...(questions ? question : {}),
              ...(miniApp && miniapp_suggestion ? { miniapp_suggestion } : {}),
            };
          },
          description:
            'Ends the turn as soon as it is called; nothing comes back to you. Use only the enabled end-of-turn options in its schema. Usually not called. Call alone, last.',
          execute: async (toolCtx, rawInput, signal) => {
            signal?.throwIfAborted();
            const input = prepareWrapUpArguments(rawInput);
            const result = (text: string, details: Record<string, unknown>) => ({
              tool_name: 'wrap_up',
              text,
              content: [
                {
                  type: 'text' as const,
                  text:
                    details.schema_version === 1
                      ? `${text}\nUnanswered next-step questions are context only, not user approval. Follow the newest user message.\n${JSON.stringify({ recap: details.recap, ask: details.ask, actions: details.actions })}`
                      : text,
                },
              ],
              // terminate is not persisted. A Turn that ended with nothing to wait
              // for carries the durable marker, so history readers do not offer to
              // continue it and treat it as finished. The stop marker records that
              // this result ended its batch whatever else ran in it (terminateAgent).
              details: {
                ...details,
                ...(details.waiting_for_user !== true
                  ? { [TURN_TERMINATING_TOOL_RESULT_DETAIL]: true }
                  : {}),
                [TURN_STOPPING_TOOL_RESULT_DETAIL]: true,
              },
              terminate: true,
            });
            const noCard = (reason: NoCardReason) =>
              result(`Turn closed without a next-step card (${reason}).`, {
                kind: 'wrap_up',
                suppressed: true,
                reason,
                waiting_for_user: false,
              });
            // The tool is on every Turn of the Session; not every Turn may show a card.
            if (
              miniApp &&
              input.miniapp_suggestion &&
              !(active(ctx) && ctx.nextStepEligible && input.decision && input.ask)
            ) {
              if (!(await options.miniApp?.permitted(ctx))) return noCard('ineligible');
              if (await options.hasPendingUserInput(ctx.sessionId)) return noCard('superseded');
              signal?.throwIfAborted();
              return result('Mini App proposal submitted for review.', {
                kind: 'miniapp_suggestion',
                miniapp_suggestion: input.miniapp_suggestion,
                turn_id: toolCtx.turnId,
                waiting_for_user: false,
              });
            }
            if (miniApp && !questions) return noCard('no_valid_card');
            if (!questions || !active(ctx)) return noCard('disabled');
            if (ctx.nextStepEligible !== true) return noCard('ineligible');
            // No card holds only a recap: without a declared decision there is nothing to ask.
            const { decision, recap: rawRecap, miniapp_suggestion: _proposal, ...question } = input;
            if (!decision || !question.ask) return noCard('no_question');
            const requested = (question.actions ?? []).flatMap((action) =>
              action.kind === 'app_action' ? [action.action] : [],
            );
            // Only an App action needs the workspace read.
            const available =
              ctx.nextStepReplyOnly || requested.length === 0
                ? []
                : await options.availableActions(ctx);
            signal?.throwIfAborted();
            // The switch or newer input may have changed while the availability check ran.
            if (!active(ctx)) return noCard('disabled');
            if (await options.hasPendingUserInput(ctx.sessionId)) return noCard('superseded');
            // The question often lives only on the card: keep it, drop the buttons it cannot show.
            const card = requested.length ? trimNextStepActions(question, available) : question;
            const recap = shownRecap(rawRecap);
            // A waiting card keeps the queue asleep; with nobody waiting on this Turn, it
            // would stall later cron runs and queued messages until the user comes back.
            // An App action sends nothing back, so clicking it could never wake the queue.
            const blocked = Boolean(
              card.blocked &&
              decision !== 'contextual_follow_up' &&
              ctx.nextStepUnattended !== true &&
              !card.actions?.some((action) => action.kind === 'app_action'),
            );
            const details = {
              kind: 'wrap_up',
              schema_version: 1,
              ...(recap ? { recap } : {}),
              ...card,
              ...(card.actions ? { actions: orderRecommendedActions(card.actions) } : {}),
              blocked,
              waiting_for_user: blocked,
              turn_id: toolCtx.turnId,
            } as const;
            // Live events and history read the card with the shared reader; never report
            // a card it would refuse.
            return readNextStepCard({ details })
              ? result('Turn closed with a next-step card.', details)
              : noCard('unreadable');
          },
        });
      });
      pi.on('before_tool_call', (event, _signal, ctx) => {
        if (event.toolCall.name !== 'wrap_up' || !registered.has(ctx)) return;
        // The card closes an answer the user can already read; it never stands in for one.
        // Refusing here cannot fold an answer: there is none yet, so the text the model
        // writes next is the Turn's only answer.
        if (
          !hasAnswerText(event.assistantMessage) &&
          !answeredThisTurn(event.context.messages, ctx.nextStepUnattended === true)
        )
          return {
            block: true,
            reason:
              'Thinking and tool calls are not your answer, so this turn has none yet. Write your complete answer as normal text, then call wrap_up alone. This refusal is routine: do not mention it to the user.',
          };
      });
      // terminate stops the loop only when every result of the batch sets it, so a call that
      // shares a batch with another tool would run on; this stops it whatever else ran.
      pi.on('after_tool_call', (event, _signal, ctx) =>
        event.toolCall.name === 'wrap_up' && registered.has(ctx)
          ? { terminateAgent: true }
          : undefined,
      );
    },
  };
}
