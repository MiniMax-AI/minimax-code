import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import type { RuntimeTool, ToolExecutionContext } from '@mavis/agent-core/tools';
import {
  ThreadGoalBudgetLimitedError,
  ThreadGoalEpochConflictError,
  ThreadGoalTokenBudgetExhaustedError,
  type ThreadGoalCreateInput,
  type ThreadGoalPatchInput,
  type ThreadGoalSignalCollector,
  type ThreadGoalState,
  type ThreadGoalStore,
  type ThreadGoalTokenBudgetMutationInput,
  type ThreadGoalTokenBudgetMutationResult,
} from '@mavis/goal';
import type { TSchema } from '@sinclair/typebox';

import type { GlobalEventPublisher } from '../events/global-events.js';
import type {
  LocalActiveTurnTiming,
  LocalActiveTurnTimingReader,
} from '../turns/active-turn-timing.js';
import { sumPiTurnUsageTokens } from '../usage/api.js';
import type { GoalContinuation } from './continuation.js';
import type { GoalDependencyGates } from './dependency-gates.js';
import type { ThreadGoalChangedEvent, ThreadGoalRuntimeEventSink } from './events.js';
import { ThreadGoalAutomationOwnerConflictError } from './gate.js';
import type { GoalTimeAccounting } from './time-accounting.js';
import type { GoalTurnContextRegistry } from './turn-context.js';
import { buildThreadGoalRuntimeTools, publishThreadGoalEvent } from './wiring.js';
import type { DataDirInput } from '../persistence/db.js';
import { withPreparedGoalResources } from './objective-resources.js';

type GoalLifecycleStore = ThreadGoalStore & {
  patchByUser(goalId: string, input: ThreadGoalPatchInput): Promise<ThreadGoalState>;
  pauseActiveBySession(
    sessionId: string,
    reason: NonNullable<ThreadGoalState['statusReason']>,
  ): Promise<ThreadGoalState | undefined>;
};

interface GoalLifecycleRuntime {
  readonly isEnabled: () => boolean;
  readonly nowMs: () => number;
  readonly publishGlobalEvent: GlobalEventPublisher;
  readonly emitRuntimeEvent: ThreadGoalRuntimeEventSink;
  readonly emitStateTransition: (from: ThreadGoalState['status'], goal: ThreadGoalState) => void;
  readonly abortVerification: (sessionId: string, reason: string) => void;
  readonly handleChanged: (event: ThreadGoalChangedEvent) => void;
  readonly reportFailure: (sessionId: string, message: string) => void;
  readonly formatError: (error: unknown) => string;
}

interface GoalLifecycleDeps {
  readonly dataDir: DataDirInput;
  readonly store: () => GoalLifecycleStore;
  readonly gates: GoalDependencyGates;
  readonly timeAccounting: GoalTimeAccounting;
  readonly turnContext: GoalTurnContextRegistry;
  readonly turnTimingReader: LocalActiveTurnTimingReader;
  readonly continuation: GoalContinuation;
  readonly abortThreadGoalTurn?: (sessionId: string, turnId: string) => Promise<boolean>;
  readonly signalCollector: ThreadGoalSignalCollector;
  readonly runtime: GoalLifecycleRuntime;
}

/** Owns CRUD, pause/resume, tool exposure, and live response projection. */
export class GoalLifecycle {
  constructor(private readonly deps: GoalLifecycleDeps) {}

  async createGoal(
    input: ThreadGoalCreateInput,
    options: { readonly requireKickoffAdmission?: boolean } = {},
  ): Promise<ThreadGoalState> {
    if (await this.deps.gates.hasAutomationOwnerConflict(input.sessionId)) {
      throw new ThreadGoalAutomationOwnerConflictError(input.sessionId);
    }
    const created = await withPreparedGoalResources(
      this.deps.dataDir,
      input.sessionId,
      input.objectiveResources,
      (objectiveResources) => this.deps.store().create({ ...input, objectiveResources }),
    );
    this.deps.runtime.emitRuntimeEvent({
      type: 'goal.created',
      at: this.deps.runtime.nowMs(),
      payload: {
        goalId: created.goalId,
        sessionId: created.sessionId,
      },
    });
    if (!options.requireKickoffAdmission) {
      await this.handleCreated(created);
      return created;
    }
    try {
      await this.deps.continuation.reconcileInitial(created, false);
    } catch (error) {
      await this.deps.continuation.rollbackFailedCreation(created);
      throw error;
    }
    publishThreadGoalEvent(this.deps.runtime.publishGlobalEvent, {
      type: 'created',
      goal: created,
    });
    this.deps.continuation.requestQueueDispatch(created.sessionId);
    return created;
  }

  /**
   * Pause the Goal a user is explicitly leaving, as one atomic transition.
   *
   * This is deliberately a separate entry point rather than a shape match
   * inside `patchGoal`. "The user pressed stop" is an intent, and inferring it
   * from which patch fields happen to be absent fails silently: any layer that
   * adds one more field (a derived `statusReason`, an optimistic-concurrency
   * guard) downgrades the caller to a plain field patch with no error and no
   * log. Routing on the intent at the wire boundary keeps that impossible.
   *
   * `pauseActiveBySession` only touches an `active` row, so a Goal that already
   * settled into `complete`, `blocked`, or `budget_limited` is reported back
   * unchanged instead of being rewritten to `paused`.
   */
  async pauseGoalByUser(sessionId: string): Promise<ThreadGoalState | undefined> {
    const existing = await this.deps.store().getBySession(sessionId);
    if (!existing) return undefined;
    this.deps.runtime.abortVerification(sessionId, 'paused(user_requested)');
    const paused = await this.deps
      .store()
      .pauseActiveBySession(sessionId, 'paused(user_requested)');
    // A CAS miss proves `existing` is stale: the row was `active` when we read
    // it and is not now. Passing it as `persistedState` would suppress the
    // re-read and report the concurrent winner's Goal back as `active`.
    if (!paused) return this.getGoalForResponse(sessionId);
    this.deps.runtime.emitStateTransition(existing.status, paused);
    const projected = (await this.getGoalForResponse(sessionId, paused)) ?? paused;
    this.deps.runtime.handleChanged({ type: 'updated', goal: projected, userPatch: true });
    await this.abortPausedThreadGoalTurn(sessionId);
    // Aborting settles usage and advances the decision epoch. Return the
    // durable post-abort snapshot so the next objective edit has a valid CAS.
    return this.getGoalForResponse(sessionId);
  }

  async patchGoal(
    sessionId: string,
    patch: ThreadGoalPatchInput,
  ): Promise<ThreadGoalState | undefined> {
    const existing = await this.deps.store().getBySession(sessionId);
    if (!existing) return undefined;
    if (patch.expectedGoalId !== undefined && patch.expectedGoalId !== existing.goalId) {
      throw Object.assign(new Error('Goal changed before the objective could be saved.'), {
        statusCode: 409,
        code: 'GOAL_CHANGED',
      });
    }
    if (patch.status === 'active' && existing.status === 'paused') {
      await this.getGoalForResponse(sessionId, existing);
    }
    const updated = await withPreparedGoalResources(
      this.deps.dataDir,
      sessionId,
      patch.objectiveResources,
      (objectiveResources) =>
        this.deps.store().patchByUser(
          existing.goalId,
          withUserStatusReason({
            ...patch,
            ...(objectiveResources !== undefined
              ? {
                  objectiveResources,
                  rejectIfUpdatedAtChangedFrom:
                    patch.rejectIfUpdatedAtChangedFrom ?? existing.updatedAt,
                }
              : {}),
          }),
        ),
    );
    this.deps.runtime.emitStateTransition(existing.status, updated);
    const shouldProjectRunningTime = patch.status === 'paused' || patch.status === 'active';
    const projected = shouldProjectRunningTime
      ? ((await this.getGoalForResponse(sessionId, updated)) ?? updated)
      : updated;
    this.deps.runtime.handleChanged({
      type: 'updated',
      goal: projected,
      userPatch: true,
      ...(patch.status === 'active' && existing.status === 'paused' && existing.statusReason
        ? { resumedFromReason: existing.statusReason }
        : {}),
      ...((patch.objective !== undefined && patch.objective !== existing.objective) ||
      JSON.stringify(updated.objectiveResources ?? []) !==
        JSON.stringify(existing.objectiveResources ?? [])
        ? { objectiveChanged: true }
        : {}),
    });
    if (patch.status === 'paused') {
      await this.abortPausedThreadGoalTurn(sessionId);
    }
    return projected;
  }

  async updateTokenBudget(
    context: ToolExecutionContext,
    input: ThreadGoalTokenBudgetMutationInput,
  ): Promise<ThreadGoalTokenBudgetMutationResult> {
    const existing = await this.deps.store().getBySession(context.sessionId);
    if (!existing) {
      return { updated: false, error: 'cannot update goal because this thread has no goal' };
    }
    if (
      existing.goalId !== input.expectedGoalId ||
      existing.updatedAt !== input.expectedUpdatedAt
    ) {
      return {
        updated: false,
        error: 'goal changed; call get_goal again before updating the token budget',
        currentGoal: existing,
      };
    }
    if (existing.status === 'complete') {
      return {
        updated: false,
        error: 'cannot update the token budget of a complete goal',
        currentGoal: existing,
      };
    }
    if (typeof input.tokenBudget === 'number' && input.tokenBudget <= existing.tokensUsed) {
      return {
        updated: false,
        error: `token_budget must be greater than the goal's ${existing.tokensUsed} accounted tokens`,
        currentGoal: existing,
      };
    }

    const resumed = existing.status === 'budget_limited';
    if (resumed && existing.statusReason !== 'budget_limited(token)') {
      return {
        updated: false,
        error: `cannot resume ${existing.statusReason ?? 'budget_limited'} by changing the token budget`,
        currentGoal: existing,
      };
    }

    let updated: ThreadGoalState;
    try {
      updated = await this.deps.store().patchByUser(existing.goalId, {
        tokenBudget: input.tokenBudget,
        rejectIfUpdatedAtChangedFrom: input.expectedUpdatedAt,
        ...(resumed ? { status: 'active', statusReason: null } : {}),
      });
    } catch (error) {
      const currentGoal = await this.deps.store().getBySession(context.sessionId);
      if (error instanceof ThreadGoalEpochConflictError) {
        return {
          updated: false,
          error: 'goal changed; call get_goal again before updating the token budget',
          ...(currentGoal ? { currentGoal } : {}),
        };
      }
      if (error instanceof ThreadGoalTokenBudgetExhaustedError) {
        return {
          updated: false,
          error: `token_budget must be greater than the goal's ${error.tokensUsed} accounted tokens`,
          ...(currentGoal ? { currentGoal } : {}),
        };
      }
      if (error instanceof ThreadGoalBudgetLimitedError) {
        return {
          updated: false,
          error: 'cannot resume this budget-limited goal by changing the token budget',
          ...(currentGoal ? { currentGoal } : {}),
        };
      }
      throw error;
    }

    this.deps.runtime.emitStateTransition(existing.status, updated);
    this.deps.runtime.handleChanged({ type: 'updated', goal: updated, userPatch: true });
    this.deps.runtime.emitRuntimeEvent({
      type: 'goal.budget_updated',
      at: this.deps.runtime.nowMs(),
      payload: {
        goalId: updated.goalId,
        sessionId: updated.sessionId,
        turnId: context.turnId,
        ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
        oldTokenBudget: existing.tokenBudget,
        newTokenBudget: updated.tokenBudget,
        status: updated.status,
        resumed,
      },
    });
    return {
      updated: true,
      goal: updated,
      previousTokenBudget: existing.tokenBudget,
      resumed,
    };
  }

  async deleteGoal(sessionId: string): Promise<boolean> {
    const existing = await this.deps.store().getBySession(sessionId);
    if (!existing) return false;
    await this.deps.continuation.cancelInitial(existing);
    await this.deps.store().delete(existing.goalId);
    this.deps.runtime.handleChanged({
      type: 'deleted',
      goalId: existing.goalId,
      sessionId,
      kickoffCancelled: true,
    });
    return true;
  }

  async pauseActiveGoalForAbort(sessionId: string): Promise<void> {
    await this.pauseActiveGoal(
      sessionId,
      'paused(user_requested)',
      'thread_goal_abort_pause_failed',
    );
  }

  async pauseActiveGoalForRetraction(sessionId: string): Promise<ThreadGoalState | undefined> {
    return this.pauseActiveGoal(
      sessionId,
      'paused(retracted)',
      'thread_goal_retraction_pause_failed',
    );
  }

  private async abortPausedThreadGoalTurn(sessionId: string): Promise<void> {
    const timing = this.deps.turnTimingReader.getBySession(sessionId);
    if (timing?.source !== 'thread-goal' || !this.deps.abortThreadGoalTurn) return;
    try {
      await this.deps.abortThreadGoalTurn(sessionId, timing.turnId);
    } catch (error) {
      this.deps.runtime.reportFailure(
        sessionId,
        `thread_goal_pause_abort_failed:${this.deps.runtime.formatError(error)}`,
      );
    }
  }

  async runtimeToolsFor(
    disabled: boolean,
    sessionId: string,
  ): Promise<RuntimeTool<TSchema, ToolExecutionContext>[]> {
    if (!this.deps.runtime.isEnabled() || disabled) return [];
    // Goals are created by the user (`/goal` / REST), never by the model, so
    // a session without a goal record has nothing for the model to read or
    // update. Skip the ~800-token tool schemas in that case.
    const goal = await this.deps.store().getBySession(sessionId);
    if (!goal) return [];
    const tools = buildThreadGoalRuntimeTools(
      this.deps.store(),
      false,
      this.deps.signalCollector,
      { updateTokenBudget: (context, input) => this.updateTokenBudget(context, input) },
    );
    // A completed goal can still be inspected but no longer updated.
    return goal.status === 'complete'
      ? tools.filter((tool) => tool.def.name === 'get_goal')
      : tools;
  }

  tallyTurnUsage(messages: PiAgentMessage[]): number {
    return sumPiTurnUsageTokens(messages);
  }

  async getGoalForResponse(
    sessionId: string,
    persistedState?: ThreadGoalState,
  ): Promise<ThreadGoalState | undefined> {
    const persisted = persistedState ?? (await this.deps.store().getBySession(sessionId));
    if (!persisted) {
      this.deps.timeAccounting.clearSession(sessionId);
      return undefined;
    }
    const timing = this.deps.turnTimingReader.getBySession(sessionId);
    if (!timing) return persisted;
    const bound = this.deps.turnContext.getBinding(timing.turnId)?.binding;
    if (!bound || bound.goalId !== persisted.goalId) return persisted;
    if (this.deps.turnContext.hasAccounting(timing.turnId)) {
      const authoritative = await this.deps.store().getBySession(sessionId);
      if (!authoritative) this.deps.timeAccounting.clearSession(sessionId);
      return authoritative;
    }
    return this.deps.timeAccounting.project(persisted, timing);
  }

  handleTurnTimingFinished(timing: LocalActiveTurnTiming): void {
    this.deps.timeAccounting.finish(timing);
    this.deps.turnContext.finish(timing);
  }

  async handleCreated(goal: ThreadGoalState): Promise<void> {
    if (!this.deps.runtime.isEnabled()) return;
    publishThreadGoalEvent(this.deps.runtime.publishGlobalEvent, { type: 'created', goal });
    try {
      await this.deps.continuation.reconcileInitial(goal, true);
    } catch (error) {
      this.deps.runtime.reportFailure(
        goal.sessionId,
        `thread_goal_kickoff_materialize_failed:${this.deps.runtime.formatError(error)}`,
      );
    }
  }

  recoverInitialContinuation(goal: ThreadGoalState): Promise<void> {
    return this.deps.continuation.reconcileInitial(goal, false).then(() => undefined);
  }

  private async pauseActiveGoal(
    sessionId: string,
    reason: 'paused(user_requested)' | 'paused(retracted)',
    failureCode: string,
  ): Promise<ThreadGoalState | undefined> {
    if (!this.deps.runtime.isEnabled()) return undefined;
    this.deps.runtime.abortVerification(sessionId, reason);
    try {
      const paused = await this.deps.store().pauseActiveBySession(sessionId, reason);
      if (!paused) return undefined;
      this.deps.runtime.emitStateTransition('active', paused);
      const goalForResponse = (await this.getGoalForResponse(sessionId, paused)) ?? paused;
      const pausedForResponse = goalForResponse.goalId === paused.goalId ? goalForResponse : paused;
      this.deps.runtime.handleChanged({ type: 'updated', goal: pausedForResponse });
      return pausedForResponse;
    } catch (error) {
      this.deps.runtime.reportFailure(
        sessionId,
        `${failureCode}:${this.deps.runtime.formatError(error)}`,
      );
      return undefined;
    }
  }
}

/**
 * Derive the user-authored status reason a bare status patch implies.
 *
 * This lives in the domain rather than in the wire contract: a `PatchGoalReq`
 * carries no `status_reason` field, so a transport-layer translator that
 * invents one is writing domain state it does not own — and that invented
 * field is exactly what silently diverted user pauses away from
 * `pauseGoalByUser`. An explicit reason from an internal caller still wins.
 */
function withUserStatusReason(patch: ThreadGoalPatchInput): ThreadGoalPatchInput {
  if (patch.statusReason !== undefined) return patch;
  if (patch.status === 'paused') return { ...patch, statusReason: 'paused(user_requested)' };
  if (patch.status === 'complete') return { ...patch, statusReason: 'complete(user_requested)' };
  return patch;
}
