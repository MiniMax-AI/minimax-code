import type { AssistantMessage } from '@earendil-works/pi-ai';
import { GOAL_VERIFIER_OFFLINE_TOOL_NAMES, GOAL_VERIFIER_READONLY_PROFILE } from '@mavis/config';
import type { PiBeforeToolCallHook } from '@mavis/agent-core/pi-turn-runner';
import { isReadOnlyCanonicalBlockedToolName } from '@mavis/agent-tools';
import type { AgentExtension } from '@mavis/agent-runtime';
import type { VerificationHostContext } from '@mavis/goal';

import { summarizeCommittedPiGoalUsage } from '../../service/session-system/index.js';
import { renderGoalVerifierReminder } from './goal-verifier-reminder.js';

/**
 * The network tools the builtin `verifier` role holds that a Goal verifier
 * child must not use. The child's tool catalog already withholds them; this set
 * is the fallback for a call that still arrives, for example a name the model
 * remembers from its role prompt.
 *
 * A refused network call is a recoverable model mistake: the child still holds
 * `read`, `grep`, `glob` and `bash` and can reach the same evidence locally.
 * Everything else outside the role's read-only ceiling — write, edit,
 * todowrite, delegation, memory, computer use — is a hard violation instead
 * and stops the run on its first call.
 */
const GOAL_VERIFIER_OFFLINE_TOOLS: ReadonlySet<string> = new Set(GOAL_VERIFIER_OFFLINE_TOOL_NAMES);

/**
 * Consecutive child turns that may reach for a network tool before the run is
 * stopped as a capability violation. Counting turns rather than calls keeps
 * several parallel calls from one model response to a single mistake; a child
 * that is refused and then tries again on its very next turn is looping.
 */
const MAX_CONSECUTIVE_OFFLINE_TOOL_TURNS = 2;

/**
 * Child turns in total that may reach for a network tool. Bounds a child that
 * alternates refused network calls with local work, independently of the
 * optional host turn cap.
 */
const MAX_OFFLINE_TOOL_TURNS = 3;

/** Structurally mirrors the v1 delegation runner's registry contract. */
export interface GoalVerifierChildRunIssue {
  readonly code: 'route_unavailable' | 'capability_violation' | 'child_budget_exhausted';
  readonly message: string;
}

/** Execution facts a settled child run reports back. Observation only. */
export interface GoalVerifierChildRunOutcome {
  readonly childTurns: number;
  readonly tokens: number;
  readonly usageIncomplete: boolean;
  readonly issue?: GoalVerifierChildRunIssue;
}

export interface GoalVerifierChildRunState {
  readonly runId: string;
  readonly maxTurns?: number;
  readonly maxTokens?: number;
  readonly workerRouteProvider: string;
  readonly hostContext: VerificationHostContext;
  childTurns: number;
  tokens: number;
  usageIncomplete: boolean;
  /** Child turn in which a network tool call was last refused. */
  lastOfflineToolTurn?: number;
  /** Consecutive child turns, ending at `lastOfflineToolTurn`, that called a network tool. */
  consecutiveOfflineToolTurns: number;
  /** Child turns in total that called a network tool. */
  offlineToolTurns: number;
  issue?: GoalVerifierChildRunIssue;
}

/**
 * Per-run counter for the Goal verifier child, and nothing more.
 *
 * The child runs on the ordinary delegation path under the builtin `verifier`
 * role, so this holds no authority: a Turn that claims a run id gains a
 * reminder, a narrow tool guard, and a hard turn/token ceiling — all of them
 * restrictions. There is nothing here worth forging.
 *
 * The ceiling still has to live somewhere: `pi-turn-runner` has no generic
 * iteration limit, so `beforeLlm` below is the only thing standing between a
 * looping child and the provider's context window.
 */
export class GoalVerifierChildCoordinator {
  private readonly runs = new Map<string, GoalVerifierChildRunState>();

  register(input: {
    readonly runId: string;
    readonly maxTurns?: number;
    readonly maxTokens?: number;
    readonly workerRouteProvider: string;
    readonly hostContext: VerificationHostContext;
  }): void {
    this.runs.set(input.runId, {
      ...input,
      childTurns: 0,
      tokens: 0,
      usageIncomplete: false,
      consecutiveOfflineToolTurns: 0,
      offlineToolTurns: 0,
    });
  }

  reminder(runId: string): string | undefined {
    const hostContext = this.runs.get(runId)?.hostContext;
    return hostContext ? renderGoalVerifierReminder(hostContext) : undefined;
  }

  release(runId: string): GoalVerifierChildRunOutcome | undefined {
    const state = this.runs.get(runId);
    this.runs.delete(runId);
    if (!state) return undefined;
    return {
      childTurns: state.childTurns,
      tokens: state.tokens,
      usageIncomplete: state.usageIncomplete,
      ...(state.issue ? { issue: state.issue } : {}),
    };
  }

  /**
   * Host-clamped output cap for one provider request of this child run.
   *
   * `beforeLlm` / `afterLlm` can only compare what the child has already spent,
   * so a single response is free to blow past the run's cap before anything
   * notices. Binding the same clamp to each request is what makes that
   * impossible. An unknown run reports no cap; `beforeLlm` already aborts it
   * before a request is ever made.
   */
  outputTokenCap(runId: string): number | undefined {
    return this.runs.get(runId)?.maxTokens;
  }

  beforeLlm(
    runId: string,
    resolvedProvider: string | undefined,
  ): { readonly type: 'abort'; readonly reason: string } | undefined {
    const state = this.runs.get(runId);
    if (!state) {
      return { type: 'abort', reason: 'Goal verifier child run is no longer active.' };
    }
    if (state.issue) return { type: 'abort', reason: state.issue.message };
    if (!resolvedProvider || resolvedProvider !== state.workerRouteProvider) {
      const message = 'Goal verifier child resolved outside the settled worker data route.';
      this.latchIssue(state, { code: 'route_unavailable', message });
      return { type: 'abort', reason: message };
    }
    const turnsExceeded = state.maxTurns !== undefined && state.childTurns >= state.maxTurns;
    const tokensExceeded = state.maxTokens !== undefined && state.tokens >= state.maxTokens;
    if (turnsExceeded || tokensExceeded) {
      const message = 'Goal verifier child exceeded its host-owned execution cap.';
      this.latchIssue(state, { code: 'child_budget_exhausted', message });
      return { type: 'abort', reason: message };
    }
    state.childTurns += 1;
    return undefined;
  }

  afterLlm(
    runId: string,
    message: AssistantMessage,
  ): { readonly type: 'fail'; readonly reason: string } | undefined {
    const state = this.runs.get(runId);
    if (!state) return { type: 'fail', reason: 'Goal verifier child run is no longer active.' };
    const usage = summarizeCommittedPiGoalUsage([message]);
    state.tokens += usage.tokens;
    // An unusable usage sample is now only an observation gap: nothing is
    // charged to the Goal, so it no longer has to stop the run.
    state.usageIncomplete ||= usage.incomplete;
    if (state.maxTokens !== undefined && state.tokens > state.maxTokens) {
      this.latchIssue(state, {
        code: 'child_budget_exhausted',
        message: 'Goal verifier child exceeded its host-owned token cap.',
      });
    }
    return state.issue ? { type: 'fail', reason: state.issue.message } : undefined;
  }

  beforeTool(
    runId: string,
    toolContext: Parameters<PiBeforeToolCallHook>[0],
  ): { readonly block: true; readonly reason: string } | undefined {
    const state = this.runs.get(runId);
    if (!state) {
      return {
        block: true,
        reason: 'GOAL_VERIFIER_CAPABILITY_VIOLATION: child run is no longer active.',
      };
    }
    const toolName = toolContext.toolCall.name;
    if (GOAL_VERIFIER_OFFLINE_TOOLS.has(toolName)) return this.refuseOfflineTool(state, toolName);
    if (!isReadOnlyCanonicalBlockedToolName(toolName)) return undefined;
    const reason = `GOAL_VERIFIER_CAPABILITY_VIOLATION: readonly Goal verification blocked tool "${toolName}".`;
    // Latched, not aborted here: the blocked result goes back to the model and
    // the next `beforeLlm` stops the run on the latched issue.
    this.latchIssue(state, { code: 'capability_violation', message: reason });
    return { block: true, reason };
  }

  /**
   * Refuses a network tool call and tells the child how to continue offline.
   *
   * Only a child that keeps reaching for the network after being refused is a
   * capability violation; every call made in one model response shares that
   * response's turn, so parallel calls count once.
   */
  private refuseOfflineTool(
    state: GoalVerifierChildRunState,
    toolName: string,
  ): { readonly block: true; readonly reason: string } {
    const turn = state.childTurns;
    if (state.lastOfflineToolTurn !== turn) {
      state.consecutiveOfflineToolTurns =
        state.lastOfflineToolTurn === turn - 1 ? state.consecutiveOfflineToolTurns + 1 : 1;
      state.offlineToolTurns += 1;
      state.lastOfflineToolTurn = turn;
    }
    if (
      state.consecutiveOfflineToolTurns >= MAX_CONSECUTIVE_OFFLINE_TOOL_TURNS ||
      state.offlineToolTurns >= MAX_OFFLINE_TOOL_TURNS
    ) {
      const reason = `GOAL_VERIFIER_CAPABILITY_VIOLATION: readonly Goal verification kept calling network tool "${toolName}" after it was refused.`;
      this.latchIssue(state, { code: 'capability_violation', message: reason });
      return { block: true, reason };
    }
    return {
      block: true,
      reason:
        `"${toolName}" is unavailable: Goal verification runs offline. ` +
        'Verify the objective from local evidence instead: read the files, search the tree, ' +
        'and inspect the repository with git. If the evidence you need is not available ' +
        'locally, judge the objective PARTIAL. Do not call web_fetch or web_search again.',
    };
  }

  private latchIssue(state: GoalVerifierChildRunState, issue: GoalVerifierChildRunIssue): void {
    state.issue ??= issue;
  }
}

/**
 * Reads the per-request output cap the Goal verifier child must obey.
 *
 * Structurally satisfies the AgentHost's `LocalTurnOutputTokenCapResolver`; the
 * Goal side owns the value and the host owns where it is bound.
 */
export interface GoalVerifierOutputTokenCapResolver {
  resolveOutputTokenCap(input: {
    readonly turnIntent?: {
      readonly kind?: string;
      readonly attributes?: Readonly<Record<string, string>>;
    };
  }): number | undefined;
}

export function createGoalVerifierOutputTokenCapResolver(
  coordinator: GoalVerifierChildCoordinator,
): GoalVerifierOutputTokenCapResolver {
  return {
    resolveOutputTokenCap({ turnIntent }) {
      const runId = goalVerifierRunId(turnIntent);
      return runId ? coordinator.outputTokenCap(runId) : undefined;
    },
  };
}

export function createGoalVerifierChildExtension(
  coordinator: GoalVerifierChildCoordinator,
): AgentExtension {
  return {
    id: 'local-goal-verifier-readonly',
    description: 'Adds the Goal verification contract and execution caps to a verifier child.',
    init(pi) {
      pi.registerReminderProvider({
        name: 'goal-verifier-contract',
        compute: (ctx) => {
          const runId = goalVerifierRunId(ctx.turnIntent);
          const content = runId ? coordinator.reminder(runId) : undefined;
          return content ? { content, priority: 1_000 } : null;
        },
      });
      pi.on('before_llm_call', (input, turn) => {
        const runId = goalVerifierRunId(turn.turnIntent);
        return runId ? coordinator.beforeLlm(runId, input.model.provider) : undefined;
      });
      pi.on('after_llm_call', (input, turn) => {
        const runId = goalVerifierRunId(turn.turnIntent);
        return runId ? coordinator.afterLlm(runId, input.message) : undefined;
      });
      pi.on('before_tool_call', (input, _signal, turn) => {
        const runId = goalVerifierRunId(turn.turnIntent);
        return runId ? coordinator.beforeTool(runId, input) : undefined;
      });
    },
  };
}

function goalVerifierRunId(
  intent:
    | { readonly kind?: string; readonly attributes?: Readonly<Record<string, string>> }
    | undefined,
): string | undefined {
  if (
    intent?.kind !== 'goal-verifier' ||
    intent.attributes?.profile !== GOAL_VERIFIER_READONLY_PROFILE
  ) {
    return undefined;
  }
  return intent.attributes.runId?.trim() || undefined;
}
