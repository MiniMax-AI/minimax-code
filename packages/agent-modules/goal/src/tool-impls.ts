/**
 * Thread Goal tool implementations — `@bindTool`ed concrete classes that
 * back `create_goal` / `update_goal` / `get_goal`. They are host-agnostic:
 * they only depend on the `ThreadGoalStore` port, so the same impls work
 * in local-runtime today and could be reused by cloud-runtime later.
 *
 * `create_goal` accepts an optional `onChanged` callback for hosts that expose
 * model-owned creation. `update_goal` is deliberately asymmetric: terminal
 * status is only a turn-local proposal, while a user-requested token-budget
 * edit goes through a separate host-owned durable mutation port.
 */

import { bindTool } from '@mavis/agent-core/tools';
import type { ToolExecutionContext, ToolImpl, ToolResult } from '@mavis/agent-core/tools';

import { ThreadGoalAlreadyExistsError, type ThreadGoalStore } from './store-port.js';
import {
  CreateGoalToolDef,
  GetGoalToolDef,
  UpdateGoalToolDef,
  resolveUpdateGoalMode,
  type CreateGoalToolInput,
  type GetGoalToolInput,
  type UpdateGoalToolInput,
} from './tool-defs.js';
import {
  validateThreadGoalObjective,
  type GoalTurnSignal,
  type ThreadGoalSignalCollectionResult,
  type ThreadGoalState,
  type ThreadGoalStatus,
} from './types.js';
import { digestThreadGoalObjective } from './objective-digest.js';

/**
 * Host hook invoked after a successful mutation. local-runtime wires
 * this to its SSE bus (`thread_goal.updated`) so the banner re-renders
 * live when the model creates or closes a goal mid-turn.
 */
export type ThreadGoalToolMutationListener = (
  goal: ThreadGoalState,
  previousStatus?: ThreadGoalStatus,
) => void;

/** Host-owned turn-local sink. Collection never mutates the durable Goal row. */
export interface ThreadGoalSignalCollector {
  collect(context: ToolExecutionContext, signal: GoalTurnSignal): ThreadGoalSignalCollectionResult;
}

export interface ThreadGoalTokenBudgetMutationInput {
  readonly tokenBudget: number | null;
  readonly expectedGoalId: string;
  readonly expectedUpdatedAt: number;
}

export type ThreadGoalTokenBudgetMutationResult =
  | {
      readonly updated: true;
      readonly goal: ThreadGoalState;
      readonly previousTokenBudget: number | null;
      readonly resumed: boolean;
    }
  | {
      readonly updated: false;
      readonly error: string;
      readonly currentGoal?: ThreadGoalState;
    };

/** Host-owned durable mutation seam; tool code never writes Goal state directly. */
export interface ThreadGoalTokenBudgetMutationPort {
  updateTokenBudget(
    context: ToolExecutionContext,
    input: ThreadGoalTokenBudgetMutationInput,
  ): Promise<ThreadGoalTokenBudgetMutationResult>;
}

/** Build the canonical text+content payload returned to the model. */
function ok(toolName: string, body: Record<string, unknown>): ToolResult {
  const text = JSON.stringify(body);
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    details: body,
  };
}

/**
 * Build the canonical rejection payload returned to the model.
 *
 * `isError` is part of the contract, not decoration: without it a refused
 * proposal reaches the model as ordinary tool output, so "your goal is stale /
 * paused / has no goal" reads like a normal result. GOAL-09 requires those
 * rejections to be legible as failures.
 */
function err(toolName: string, message: string, body: Record<string, unknown> = {}): ToolResult {
  const payload = { error: message, ...body };
  const text = JSON.stringify(payload);
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    isError: true,
    details: payload,
  };
}

function serializeGoal(goal: ThreadGoalState): Record<string, unknown> {
  return {
    goalId: goal.goalId,
    sessionId: goal.sessionId,
    objective: goal.objective,
    ...(goal.objectiveResources?.length ? { objectiveResources: goal.objectiveResources } : {}),
    status: goal.status,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    tokenBudget: goal.tokenBudget,
  };
}

// ─── create_goal ───────────────────────────────────────────────────────

@bindTool(CreateGoalToolDef)
export class CreateGoalTool implements ToolImpl<
  typeof CreateGoalToolDef.schema,
  ToolExecutionContext
> {
  constructor(
    private readonly store: ThreadGoalStore,
    private readonly onChanged?: ThreadGoalToolMutationListener,
  ) {}

  async execute(ctx: ToolExecutionContext, input: CreateGoalToolInput): Promise<ToolResult> {
    const objective = (input.objective ?? '').trim();
    const invalid = validateThreadGoalObjective(objective);
    if (invalid) {
      return err(CreateGoalToolDef.name, invalid);
    }

    // Give the model an explicit, actionable rejection before attempting the
    // write when work is already active or intentionally paused. The store's
    // uniqueness guard remains the race-safe backstop for concurrent creates
    // and for other unfinished statuses.
    const existing = await this.store.getBySession(ctx.sessionId);
    if (existing && (existing.status === 'active' || existing.status === 'paused')) {
      return err(
        CreateGoalToolDef.name,
        `this thread already has a goal with status ${existing.status}; do not create another goal`,
        {
          existingGoalId: existing.goalId,
          existingStatus: existing.status,
        },
      );
    }

    // Pass through the optional token_budget verbatim. Schema already
    // enforced `minimum: 1`; the store treats `undefined` as "no cap".
    const createInput: { sessionId: string; objective: string; tokenBudget?: number } = {
      sessionId: ctx.sessionId,
      objective,
    };
    if (typeof input.token_budget === 'number') {
      createInput.tokenBudget = input.token_budget;
    }

    try {
      const goal = await this.store.create(createInput);
      this.onChanged?.(goal);
      return ok(CreateGoalToolDef.name, { goal: serializeGoal(goal) });
    } catch (e) {
      if (e instanceof ThreadGoalAlreadyExistsError) {
        // codex-verbatim rejection (tool.rs handle_create).
        return err(
          CreateGoalToolDef.name,
          'cannot create a new goal because this thread has an unfinished goal; complete the existing goal first',
          { existingGoalId: e.existingGoalId },
        );
      }
      throw e;
    }
  }
}

// ─── update_goal ───────────────────────────────────────────────────────

@bindTool(UpdateGoalToolDef)
export class UpdateGoalTool implements ToolImpl<
  typeof UpdateGoalToolDef.schema,
  ToolExecutionContext
> {
  private readonly successfulBudgetUpdateTurns = new Set<string>();

  constructor(
    private readonly store: ThreadGoalStore,
    private readonly collector: ThreadGoalSignalCollector,
    private readonly budgetMutation?: ThreadGoalTokenBudgetMutationPort,
  ) {}

  async execute(ctx: ToolExecutionContext, input: UpdateGoalToolInput): Promise<ToolResult> {
    const mode = resolveUpdateGoalMode(input);
    if (mode === 'mixed') {
      return err(
        UpdateGoalToolDef.name,
        'cannot combine status and token_budget in one update; set mode to "status" or "token_budget" to disambiguate',
      );
    }
    if (mode === 'none') {
      return err(UpdateGoalToolDef.name, 'provide either status or token_budget');
    }
    if (mode === 'token_budget') return this.updateTokenBudget(ctx, input);
    return this.proposeTerminalStatus(ctx, input);
  }

  private async proposeTerminalStatus(
    ctx: ToolExecutionContext,
    input: UpdateGoalToolInput,
  ): Promise<ToolResult> {
    const status = input.status;
    if (status !== 'complete' && status !== 'blocked') {
      return err(
        UpdateGoalToolDef.name,
        'status must be "complete" or "blocked" when proposing a terminal status',
      );
    }

    const existing = await this.store.getBySession(ctx.sessionId);
    if (!existing) {
      // codex-verbatim rejection (tool.rs handle_update).
      return err(UpdateGoalToolDef.name, 'cannot update goal because this thread has no goal');
    }

    if (existing.status === 'paused') {
      return err(
        UpdateGoalToolDef.name,
        'cannot update goal because it is paused; resume the goal before completing or blocking it',
        { currentStatus: existing.status },
      );
    }

    const summary = input.summary?.trim();
    const collection = this.collector.collect(ctx, {
      type: status === 'complete' ? 'completion_proposed' : 'block_proposed',
      goalId: existing.goalId,
      objectiveDigest: digestThreadGoalObjective(existing.objective),
      ...(summary ? { summary } : {}),
    });
    if (collection === 'not_a_goal_turn') {
      return err(
        UpdateGoalToolDef.name,
        'cannot update goal because this turn is not bound to the goal; continue handling the user request in this turn without updating goal status. This tool cannot resume a goal',
        { reason: collection, currentGoal: serializeGoal(existing) },
      );
    }
    if (collection === 'stale') {
      return {
        ...err(
          UpdateGoalToolDef.name,
          'cannot update goal because the objective changed during this turn; stop the stale turn and continue with the updated goal before completing or blocking it',
          { currentGoal: serializeGoal(existing) },
        ),
        terminate: true,
      };
    }
    if (collection === 'no_goal') {
      return err(UpdateGoalToolDef.name, 'cannot update goal because this thread has no goal');
    }
    if (collection === 'paused') {
      return err(
        UpdateGoalToolDef.name,
        'cannot update goal because it is paused; resume the goal before completing or blocking it',
        { currentStatus: 'paused' },
      );
    }

    return {
      ...ok(UpdateGoalToolDef.name, {
        proposal: {
          status,
          ...(summary ? { summary } : {}),
          accepted: true,
          settlement: 'pending_host_validation',
        },
        goal: serializeGoal(existing),
        goalSnapshotPhase: 'before_host_settlement',
      }),
      terminate: true,
    };
  }

  private async updateTokenBudget(
    ctx: ToolExecutionContext,
    input: UpdateGoalToolInput,
  ): Promise<ToolResult> {
    if (
      input.token_budget !== null &&
      (typeof input.token_budget !== 'number' ||
        !Number.isInteger(input.token_budget) ||
        input.token_budget <= 0)
    ) {
      return err(UpdateGoalToolDef.name, 'token_budget must be a positive integer or null');
    }
    if (
      typeof input.expected_goal_id !== 'string' ||
      input.expected_goal_id.length === 0 ||
      typeof input.expected_updated_at !== 'number' ||
      !Number.isInteger(input.expected_updated_at) ||
      input.expected_updated_at < 0
    ) {
      return err(
        UpdateGoalToolDef.name,
        'expected_goal_id and expected_updated_at are required; call get_goal immediately before updating the token budget',
      );
    }
    if (!this.budgetMutation) {
      return err(UpdateGoalToolDef.name, 'token-budget updates are not available in this runtime');
    }

    const turnKey = `${ctx.sessionId}\u0000${ctx.turnId}`;
    if (this.successfulBudgetUpdateTurns.has(turnKey)) {
      return err(
        UpdateGoalToolDef.name,
        'already updated the token budget during this turn; start a new explicit user turn for another update',
      );
    }

    const result = await this.budgetMutation.updateTokenBudget(ctx, {
      tokenBudget: input.token_budget ?? null,
      expectedGoalId: input.expected_goal_id,
      expectedUpdatedAt: input.expected_updated_at,
    });
    if (!result.updated) {
      return err(UpdateGoalToolDef.name, result.error, {
        ...(result.currentGoal ? { currentGoal: serializeGoal(result.currentGoal) } : {}),
      });
    }
    this.successfulBudgetUpdateTurns.add(turnKey);
    return ok(UpdateGoalToolDef.name, {
      updated: true,
      previousTokenBudget: result.previousTokenBudget,
      goal: serializeGoal(result.goal),
      resumed: result.resumed,
    });
  }
}

// ─── get_goal ──────────────────────────────────────────────────────────

@bindTool(GetGoalToolDef)
export class GetGoalTool implements ToolImpl<typeof GetGoalToolDef.schema, ToolExecutionContext> {
  constructor(private readonly store: ThreadGoalStore) {}

  async execute(ctx: ToolExecutionContext, _input: GetGoalToolInput): Promise<ToolResult> {
    const goal = await this.store.getBySession(ctx.sessionId);
    if (!goal) {
      return ok(GetGoalToolDef.name, { goal: null });
    }
    return ok(GetGoalToolDef.name, { goal: serializeGoal(goal) });
  }
}
