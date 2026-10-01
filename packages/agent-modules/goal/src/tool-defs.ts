/**
 * Thread Goal tool definitions exposed to the LLM. Tool names are kept
 * verbatim from codex `ext/goal/src/spec.rs` — `create_goal`,
 * `update_goal`, `get_goal` — so a model trained against codex tooling
 * recognizes them immediately.
 *
 * Schemas are intentionally minimal: no metadata and no objective edits via
 * update_goal. That tool has two deliberately separate modes: a host-settled
 * terminal proposal, or a user-requested token-budget mutation guarded by a
 * fresh get_goal snapshot. `create_goal` exposes
 * an OPTIONAL `token_budget` (mirroring codex `spec.rs`); when set, the
 * runtime auto-transitions the goal to `budget_limited` once
 * `tokens_used >= token_budget` and injects a wrap-up steering prompt.
 */

import { Type, type Static } from '@sinclair/typebox';

import type { ToolDefinition } from '@mavis/agent-core/tools';

// ─── create_goal ───────────────────────────────────────────────────────

export const CreateGoalToolDef = {
  name: 'create_goal',
  executionMode: 'sequential',
  description:
    'Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. ' +
    'Fails if an unfinished goal exists; use update_goal for terminal proposals or an explicitly requested token-budget change.',
  schema: Type.Object({
    objective: Type.String({
      description:
        'Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.',
    }),
    token_budget: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          'Optional positive token budget for the goal. Omit unless the user explicitly asked for a cap. ' +
          'When set, the runtime automatically marks the goal as `budget_limited` and stops auto-continuation ' +
          'the moment cumulative model tokens reach this value.',
      }),
    ),
  }),
} as const satisfies ToolDefinition;
export type CreateGoalToolInput = Static<typeof CreateGoalToolDef.schema>;

// ─── update_goal ───────────────────────────────────────────────────────

export const UpdateGoalToolDef = {
  name: 'update_goal',
  executionMode: 'sequential',
  description:
    'Propose a terminal status for the existing goal, or—only when explicitly requested by the user—update its token budget. ' +
    'Always set `mode` to choose exactly one operation per call; fields belonging to the other mode are ignored.\n' +
    'Terminal mode (`mode: "status"`): pass `status` and optional `summary`; follow the rules documented on the `status` field. The host settles the proposal after this turn. An accepted `blocked` proposal ends the turn. ' +
    'After an accepted `complete` proposal, do not call any more tools (they are refused): write one final reply to the user in the same turn that says what was accomplished, where each deliverable file is, and how to use it when that is not obvious; declare every deliverable file with delivery markup (<media /> tags inside <deliver-assets>) and write its path in the text; do not claim that verification has passed or that the result is verified, because the host verifies after this reply; describe checks you ran as checks, not as verification.\n' +
    'Budget mode (`mode: "token_budget"`): call `get_goal` immediately before `update_goal`, then pass only `token_budget`, `expected_goal_id`, and `expected_updated_at`. Use a positive integer token count, or `null` to clear the cap. A successful update does not end the turn and may reactivate a token-limited goal.\n' +
    'Do not combine the two modes. This tool cannot directly pause, resume, or edit the objective.',
  schema: Type.Object({
    mode: Type.Optional(
      Type.Union([Type.Literal('status'), Type.Literal('token_budget')], {
        description:
          'Which single operation this call performs. Always set this field. ' +
          '`status`: propose a terminal status; every field other than `status` and `summary` is ignored. ' +
          '`token_budget`: update the token budget; every field other than `token_budget`, `expected_goal_id`, and `expected_updated_at` is ignored.',
      }),
    ),
    status: Type.Optional(
      Type.Union([Type.Literal('complete'), Type.Literal('blocked')], {
        description:
          'Terminal mode only. Set to `complete` only when the objective is achieved and no required work remains. ' +
          "When all executable work is finished and only a passive wait for the user's next arbitrary message remains, treat the wait as a stop condition and set `complete`. " +
          'An explicit safety or policy refusal may be set to `blocked` immediately and does not require the three-turn threshold. ' +
          'For every other blocker, set to `blocked` only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse. ' +
          'After a previously blocked goal is resumed, a safety/policy refusal remains immediate; every other blocker starts a fresh blocked audit.',
      }),
    ),
    summary: Type.Optional(
      Type.String({
        maxLength: 2_000,
        description:
          'Recommended when status is `complete`: briefly state what was accomplished and where the evidence lives. The host passes this claim to an independent verifier as untrusted data; it is not shown to the user and does not replace the final reply.',
      }),
    ),
    token_budget: Type.Optional(
      Type.Union([
        Type.Integer({
          minimum: 1,
          description:
            'Budget mode only. New positive integer token cap. Convert the explicit user request to an integer before calling; use null to clear the cap.',
        }),
        Type.Null({ description: 'Budget mode only. Clear the current token cap.' }),
      ]),
    ),
    expected_goal_id: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          'Budget mode only. Exact goalId returned by the immediately preceding get_goal call.',
      }),
    ),
    expected_updated_at: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          'Budget mode only. Exact updatedAt returned by the immediately preceding get_goal call.',
      }),
    ),
  }),
} as const satisfies ToolDefinition;
export type UpdateGoalToolInput = Static<typeof UpdateGoalToolDef.schema>;

/**
 * Whether an update_goal payload is attempting the durable token-budget mode.
 *
 * Some provider tool-call adapters materialize an omitted nullable property as
 * `null`. When a terminal status is present, that compatibility filler must not
 * turn the completion/block proposal into a budget mutation. A numeric budget
 * combined with a status remains a real (and invalid) mixed-mode attempt.
 */
export function hasUpdateGoalTokenBudgetIntent(
  input: Readonly<{ status?: unknown; token_budget?: unknown }>,
): boolean {
  if (!Object.hasOwn(input, 'token_budget')) return false;
  return input.status === undefined || input.token_budget !== null;
}

export type UpdateGoalResolvedMode = 'status' | 'token_budget' | 'mixed' | 'none';

/**
 * Resolve which update_goal operation a payload requests.
 *
 * An explicit `mode` value wins outright: models that materialize every schema
 * property (and therefore cannot express intent by omission) still select one
 * operation, and the dispatcher ignores the other mode's filler fields. Any
 * other `mode` value (absent or hallucinated) falls back to the legacy
 * field-presence inference, preserving historical behavior byte-for-byte —
 * including the mixed-mode rejection and the null-budget-filler exemption.
 */
export function resolveUpdateGoalMode(
  input: Readonly<{ mode?: unknown; status?: unknown; token_budget?: unknown }>,
): UpdateGoalResolvedMode {
  if (input.mode === 'status') return 'status';
  if (input.mode === 'token_budget') return 'token_budget';
  const hasBudget = hasUpdateGoalTokenBudgetIntent(input);
  const hasStatus = input.status !== undefined;
  if (hasBudget && hasStatus) return 'mixed';
  if (hasBudget) return 'token_budget';
  if (hasStatus) return 'status';
  return 'none';
}

// ─── get_goal ───────────────────────────────────────────────────────────

export const GetGoalToolDef = {
  name: 'get_goal',
  executionMode: 'parallel',
  description:
    'Get the current goal for this thread, including status, timestamps, token usage, and token budget. ' +
    'Returns an empty result if no goal is set.',
  schema: Type.Object({}),
} as const satisfies ToolDefinition;
export type GetGoalToolInput = Static<typeof GetGoalToolDef.schema>;
