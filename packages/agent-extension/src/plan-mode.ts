import {
  defineRuntimeTool,
  type AfterLlmCallHandler,
  type AfterToolCallHandler,
  type AgentExtension,
  type ModelContextAssemblyCtx,
  PromptSnapshotInvalidError,
  type ToolExecutionContext,
  type TurnAssemblyCtx,
  type TurnEndHandler,
} from '@mavis/agent-runtime';
import { Type } from '@sinclair/typebox';

export const PLAN_MODE_GUIDANCE = `<plan-mode-guidance>
You can request Plan Mode by calling EnterPlanMode; inside Plan Mode,
ExitPlanMode submits the finished plan for the user's review.

Call EnterPlanMode as your first tool action when either trigger below
applies. Entry precedes all intake for that request: do not locate, unpack,
list, read, or view any attachment, archive, screenshot, or workspace content,
do not call ask_user or any research tool, and do not draft the plan inline or
into a file in Default Mode. When the user sequences the request as "first
investigate, verify, or clarify, then give me the plan", or authorizes only
read-only investigation before approval, that investigation is exactly what
Plan Mode is for: enter first, then perform it inside Plan Mode. Instructions
about how to produce the plan do not bypass entry either: when the user names
an output path for the plan document or asks for the plan as a file in the
workspace, enter first, draft the canonical Plan file inside Plan Mode, and
produce the file at their requested path only after the plan is approved.
Producing a plan document, running clarification rounds, or collecting
approval through ask_user never substitutes for calling EnterPlanMode.

1. Software implementation planning: the requested planning deliverable is a
concrete plan, design, proposal, rollout strategy, or implementation-ready
reference for software, codebase, data-analysis, or other technical work, even
when they are not asking you to implement it in this turn. Also enter when a
non-trivial implementation request requires investigation, clarification, or
architectural decisions before editing, including when that need only becomes
clear mid-task.

2. Approval-gated planning in any domain: the user requests a concrete plan as
the deliverable and asks you to hold implementation, final file generation, or
delivery until they review, approve, or confirm it.

First tool action is the aim, not a one-shot window. If you recognize only
mid-task that a trigger applies — because intake happened before you judged
it, because investigation reveals the real scope, or because a follow-up
message turns the plan into the gated deliverable — call EnterPlanMode at
that moment. Late entry is always better than no entry: having already read
files, called ask_user, or drafted content never disqualifies entry.

The dividing line is whose decisions shape the plan. Enter when the user asks
you to determine how the work should land — dependencies, ordering, gates,
risks, or design choices you must investigate and settle before they approve.
A requested planning deliverable is never merely informational because the
user asks for the plan rather than immediate implementation. Do not enter
when nothing is delegated to your judgment — including simple, trivially
scoped, or purely informational requests — and never while Plan Mode is
already active. Specifically:

- The user supplies the complete change specification — exact edits, files,
tests, and order — and asks for direct execution without questions. Execute it
directly regardless of change size; their checklist is the plan. Upgrade to
Plan Mode only if execution reveals the work is fundamentally different or
riskier than they described.
- Every decision that shapes the outcome is already made by the user; you are
only assembling their decisions or executing the settled direction. Stay in
Default Mode, even when they will review or sign off on the result at the end.
The moment any shaping item is delegated to you — audience, format, schedule,
batching, ordering, risks, gates, or acceptance criteria — this exception no
longer applies: a plan you must shape and then hold for the user's
confirmation is trigger 2.
- The deliverable is personal or leisure content the user will follow
themselves, such as a travel itinerary. Present the content directly in your
reply and iterate in conversation, even when they will approve it before you
write final files.

Only after EnterPlanMode was actually called and declined, or entry is
unavailable, may you fall back to Default Mode planning: present the plan and
obtain the user's explicit approval through ask_user before treating the task
as complete, and never end such a turn without giving them that decision.

When Plan Mode is active, a per-turn Plan Mode system reminder governs
planning conduct and exit; follow it.
</plan-mode-guidance>`;

export const PLAN_MODE_GUIDANCE_KEY = 'workflow/plan-mode/agent-entry.md';
export interface PlanModeActionInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId?: string;
  readonly assistantMessageId?: string;
  readonly signal?: AbortSignal;
}

export interface PlanModeExtensionOptions {
  readonly actions: {
    enter(input: PlanModeActionInput): Promise<{ readonly requestId: string }>;
    exit(
      input: PlanModeActionInput,
    ): Promise<{ readonly requestId: string; readonly planPath: string }>;
  };
  /** Agent-initiated entry rollback switch (`beta.desktopPlanModeAgentEntry`). */
  readonly agentEntryEnabled: () => boolean;
  /**
   * Receives a fallback Review submission the Plan owner rejected (for example
   * queued work or another pending Questionnaire). The turn still completes.
   */
  readonly onReviewFallbackFailed?: (error: unknown) => void;
}

const EmptyInput = Type.Object({}, { additionalProperties: false });

export function planModeExtension(options: PlanModeExtensionOptions): AgentExtension {
  return {
    id: 'plan-mode',
    description: 'Provides Desktop Plan Mode guidance, lifecycle tools, and per-turn reminder.',
    init(pi): void {
      // Entry guidance is Default-turn material: while Plan Mode is active the
      // per-turn reminder owns conduct, so both guidance variants are
      // suppressed instead of spending context on entry rules.
      pi.contributeSystemPrompt(async (ctx) => {
        if (ctx.plan) return null;
        return options.agentEntryEnabled()
          ? readPlanModeGuidance(ctx, PLAN_MODE_GUIDANCE_KEY, PLAN_MODE_GUIDANCE)
          : null;
      });
      const enterTool = lifecycleTool('EnterPlanMode', (input) => options.actions.enter(input));
      const exitTool = lifecycleTool('ExitPlanMode', (input) => options.actions.exit(input));
      // EnterPlanMode only exists where entering is possible (Default turn,
      // rollback switch on); ExitPlanMode only where exiting is possible (Plan
      // turn, regardless of switches so pre-existing Plan Sessions can exit).
      pi.registerTool((ctx) => (!ctx.plan && options.agentEntryEnabled() ? enterTool : null));
      pi.registerTool((ctx) => (ctx.plan ? exitTool : null));
      pi.registerReminderProvider({
        name: 'plan-mode',
        compute: (ctx) =>
          ctx.plan
            ? {
                content: renderPlanModeReminder(ctx.plan.canonicalPath),
                priority: 1_000,
              }
            : null,
      });
      const reviewFallback = planReviewSubmissionFallback(options);
      pi.on('after_tool_call', reviewFallback.afterToolCall);
      pi.on('after_llm_call', reviewFallback.afterLlmCall);
      pi.on('turn_end', reviewFallback.turnEnd);
    },
  };
}

/**
 * Tools that can change the canonical Plan. The Plan tool guard rejects them
 * for every other path, so a successful call in a Plan turn updated the Plan.
 */
const PLAN_DOCUMENT_TOOLS = new Set(['write', 'edit']);

/**
 * A Plan turn that updated the Plan should end in ExitPlanMode or a question.
 * When it completes with a plain-text answer instead, the user would have no
 * Review to approve, so the runtime submits the canonical Plan for Review on
 * the Agent's behalf. The Agent's answer is delivered unchanged and the user
 * keeps every Review choice: approve, feedback, or skip.
 */
function planReviewSubmissionFallback(options: PlanModeExtensionOptions): {
  readonly afterToolCall: AfterToolCallHandler;
  readonly afterLlmCall: AfterLlmCallHandler;
  readonly turnEnd: TurnEndHandler;
} {
  const states = new Map<string, { planUpdated: boolean; closedInText: boolean }>();
  const keyOf = (ctx: Pick<TurnAssemblyCtx, 'sessionId' | 'turnId'>) =>
    `${ctx.sessionId}\u0000${ctx.turnId}`;
  const stateFor = (ctx: TurnAssemblyCtx) => {
    const key = keyOf(ctx);
    let state = states.get(key);
    if (!state) {
      state = { planUpdated: false, closedInText: false };
      states.set(key, state);
    }
    return state;
  };
  return {
    afterToolCall: (input, _signal, ctx) => {
      if (ctx.plan && !input.isError && PLAN_DOCUMENT_TOOLS.has(input.toolCall.name)) {
        stateFor(ctx).planUpdated = true;
      }
      return undefined;
    },
    afterLlmCall: (event, ctx) => {
      if (!ctx.plan) return undefined;
      // Only the last response of the turn matters; any tool call (including
      // ExitPlanMode or a question) or a truncated/failed response clears it.
      stateFor(ctx).closedInText =
        event.message.stopReason === 'stop' &&
        !event.message.content.some((block) => block.type === 'toolCall');
      return undefined;
    },
    // turn_end runs after every continuation has settled, so the closing
    // response observed above is final. It must never throw: a turn_end
    // failure would fail an otherwise completed turn.
    turnEnd: async (event, ctx) => {
      const state = states.get(keyOf(ctx));
      states.delete(keyOf(ctx));
      if (!ctx.plan || event.reason !== 'completed') return;
      if (!state?.planUpdated || !state.closedInText) return;
      try {
        await options.actions.exit({ sessionId: ctx.sessionId, turnId: ctx.turnId });
      } catch (error) {
        try {
          options.onReviewFallbackFailed?.(error);
        } catch {
          // Reporting must not change the completed turn.
        }
      }
    },
  };
}

async function readPlanModeGuidance(
  ctx: ModelContextAssemblyCtx,
  key: string,
  builtin: string,
): Promise<string> {
  const scope = ctx.promptRead;
  if (!scope) return builtin;
  const current = await scope.source.read(scope.snapshot, key);
  if (current.kind === 'found') return current.content;
  if (current.kind === 'missing') return builtin;
  throw new PromptSnapshotInvalidError(`Plan Mode prompt cannot be read: ${key}`);
}

export function renderPlanModeReminder(canonicalPath: string): string {
  return `<system-reminder>
Plan Mode is active. Your task is to investigate and produce an
implementation-ready plan. Do not implement the plan.

For investigation, you may use any available investigation tool, including
repository inspection, read-only shell commands, external research, Browser
tools, Skills, configured tools, and delegated tasks. For a tool that
supports both reads and writes, select query, get, list, search, fetch,
inspect, or preview operations. If its operation is unclear, choose the
obviously read-only operation.

Clarification is part of planning. Prefer investigation for anything the
repository or references can answer. When a decision that shapes the plan
cannot be settled from evidence — a real trade-off or a user preference —
ask the user through an available question tool instead of guessing; if no
question tool is available, record it under the Plan's unresolved decisions.
Minor open points you can safely defer belong there too, not in questions.

Do not create, update, delete, publish, submit, deploy, send, or upload
files, messages, jobs, schedules, services, account actions, or external
objects. Reading or fetching remote content is investigation and is allowed;
persisting fetched content into the workspace is a mutation and is not.
Browser tools may navigate, search, filter, and inspect, but must not submit
a mutating form or account action. Delegated tasks must remain research-only
and follow the same mutation boundary. Shell commands may inspect but must
not modify files, Git state, installed packages, or other system state;
running existing builds or tests to verify current behavior counts as
investigation, while installing dependencies or modifying files to make them
run does not.

The sole mutation exception is writing or editing the canonical Plan file at
exactly this path:
${canonicalPath}
No other file may be created or modified, and Git state must not change.

If a tool is denied, switch to another read or investigation path. When two
distinct approaches to the same question have been blocked, stop pursuing
that question: converge on the evidence already available and record the
remaining uncertainty in the Plan; do not keep looping.

Keep the canonical Plan file up to date as you investigate and decisions
change. The Plan should contain only relevant sections and cover enough
detail for another agent to implement it safely, including:
- goal, scope, and important non-goals;
- current implementation and affected components or files;
- proposed architecture and end-to-end flow;
- relevant state, ownership, concurrency, failure, and recovery semantics;
- tests and acceptance criteria;
- unresolved decisions or risks, if any.

The Plan may begin with one title; its first body section must be a
non-empty \`## Summary\` stating the goal, scope, and key design decisions.

Before calling ExitPlanMode, use a file write or edit tool to create or
update the canonical Plan file at the exact path above. An inline response
does not count as completing the Plan, even if it contains the same content.

Call ExitPlanMode({}) only after the canonical Plan file is complete and
ready for user review, and call it in the same turn once it is. The user can
review and approve the Plan only through ExitPlanMode: a plain-text reply
that says the Plan is ready, invites review, or asks the user to confirm
before implementation does not open that review, even when the user asked
to confirm the Plan before you implement it. If a decision that shapes the
Plan still needs the user, ask it through an available question tool, then
update the Plan and call ExitPlanMode after the answer is incorporated. Do
not begin implementation after calling ExitPlanMode.
</system-reminder>`;
}

type PlanLifecycleToolName = 'EnterPlanMode' | 'ExitPlanMode';
type PlanLifecycleToolResult<Name extends PlanLifecycleToolName> = Name extends 'ExitPlanMode'
  ? { readonly requestId: string; readonly planPath: string }
  : { readonly requestId: string };

function lifecycleTool<Name extends PlanLifecycleToolName>(
  name: Name,
  action: (input: PlanModeActionInput) => Promise<PlanLifecycleToolResult<Name>>,
) {
  return defineRuntimeTool({
    name,
    description:
      name === 'EnterPlanMode'
        ? 'Ask the local user to confirm entering Plan Mode; the turn ends while they decide, and planning starts only after they confirm. Call this as the first tool action for a requested planning deliverable — software or technical implementation planning, or any plan the user wants to approve before implementation or delivery — before reading or unpacking attachments, clarification, research, or drafting. If you only realize mid-task that this applies, call it then: late entry is better than none.'
        : 'Freeze the canonical Plan file and ask the local user to review it; the turn ends while they decide. This is the only way the user can review and approve the Plan: call it as soon as the Plan is ready instead of ending the turn with a plain-text request for review or confirmation. Only valid while Plan Mode is active, after the canonical Plan file has been written to disk — write or update it first.',
    schema: EmptyInput,
    source: 'builtin',
    execute: async (ctx: ToolExecutionContext, _input, signal) => {
      const result = await action({
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
        ...(name === 'ExitPlanMode' && ctx.assistantMessageId
          ? { assistantMessageId: ctx.assistantMessageId }
          : {}),
        signal,
      });
      const text = `${name} is awaiting the local user's decision. This turn ends now; do not take further actions or produce further output.`;
      return {
        tool_name: name,
        text,
        content: [{ type: 'text' as const, text }],
        details: {
          waiting_for_user: true,
          requestId: result.requestId,
          ...(name === 'ExitPlanMode'
            ? { planPath: (result as PlanLifecycleToolResult<'ExitPlanMode'>).planPath }
            : {}),
        },
        terminate: true,
      };
    },
  });
}
