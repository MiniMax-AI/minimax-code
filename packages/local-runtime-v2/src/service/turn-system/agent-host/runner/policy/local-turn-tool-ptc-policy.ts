import {
  getMcpInvokeRegistries,
  isPtcMavisDirectCommand,
  ptcMavisChildToolName,
  ptcMavisRunCodeCall,
  resolveMcpInvokeTarget,
} from '@mavis/agent-tools';
import type { RuntimeTool } from '@mavis/agent-core/tools';
import type { PiBeforeToolCallHook } from '@mavis/agent-core/pi-turn-runner';

type BeforeToolCallContext = Parameters<PiBeforeToolCallHook>[0];

const PTC_DIRECT_ONLY_TOOL_NAMES = new Set([
  'ask_user',
  'request_feature_enable',
  'EnterPlanMode',
  'ExitPlanMode',
  'create_goal',
  'get_goal',
  'update_goal',
  'skill',
  // Its hits are definitions the model reads before writing the next program,
  // so inside run_code it could only be returned verbatim. Kept top-level like
  // skill, and the Tool Search hint keeps saying "call tool_search" in both modes.
  'tool_search',
  'website_deploy',
  'task',
  'task_append',
  'code_review',
  'run_code',
]);

export interface PtcChildToolPolicyInput {
  readonly originalContext: BeforeToolCallContext;
  readonly context: BeforeToolCallContext;
  readonly tools: readonly RuntimeTool[];
  /** Original final child catalog carried by the visible run_code tool. */
  readonly ptcChildTools?: readonly RuntimeTool[];
  readonly delegatedTarget?: RuntimeTool;
}

export function isPtcDirectTool(tool: RuntimeTool): boolean {
  if (tool.def.name === 'mcp_invoke') return hasPtcDirectMcpTarget(tool);
  return PTC_DIRECT_ONLY_TOOL_NAMES.has(tool.def.name) || tool.def.name === 'mavis';
}

/**
 * Known gap, ignored for now: a PTC turn without bash.
 *
 * The run_code child catalog is whatever this Agent enabled, minus the direct
 * tools above, so it has no bash when a user-built (Custom) Agent drops bash
 * from its tool list and the user talks to that Agent directly
 * (`isPtcTurnEnabled` in packages/config/src/ptc-turn.ts does not exclude
 * Custom Agents). The run_code description still names bash in such a turn:
 * "Bash commands belong in tools.bash(...)", the tools.bash git status example
 * and "Bash exit codes are in data.exitCode", the timeout_ms / tools.bash
 * sentences of WALL_CLOCK_HINT, the explicit background Bash line, the shell
 * quoting advice, and "shell commands" in PROMISE_ALL_SCHEDULING
 * (runner/ptc/run-code-tool.ts, runCodeDescription). A model may follow them,
 * call tools.bash, get it rejected and spend one more step; nothing breaks.
 * The PTC section (_v2/PTC_TOOL_CALLS.md.hbs) already prints its bash lines
 * only when bash is enabled; the run_code description does not yet.
 *
 * Not handled because it only appears for a Custom Agent without bash in a
 * direct conversation; the built-in Agents (mavis, worker, verifier,
 * explore) and the evals all have bash. The user decided on 2026-10-15 to
 * ignore it for now. To fix it, make those passages in runCodeDescription
 * depend on whether childTools contains bash, keeping the text byte for
 * byte unchanged when it does.
 *
 * Browser (the native `browser` tool and the Plugin-bound `mcp_browser`) is an
 * ordinary child, so an action and the reads that verify it run in one
 * program instead of one model round trip each. Its stateful-page safety
 * stays with the Browser owner: the tool is sequential, the Skill receipt is
 * per session (children inherit the Session), the Browser turn guard refuses
 * the remaining Browser children of a program after one fails
 * (`BROWSER_PTC_STOPPED`), and `safety.requiredNextTool` still forces a
 * direct `ask_user` next.
 *
 * Computer Use (`computer_*`) is an ordinary child for the same reason: a
 * bounded step (find the window, read it, act, read back) is one program.
 * The shared desktop stays safe the same way: the tools declare no
 * executionMode, so the scheduler runs them one at a time even inside
 * Promise.all, and the Computer Use turn guard refuses the remaining
 * Computer Use children of a program after one fails
 * (`COMPUTER_USE_PTC_STOPPED`).
 */
export function isPtcChildTool(tool: RuntimeTool): boolean {
  return !PTC_DIRECT_ONLY_TOOL_NAMES.has(tool.def.name);
}

export function evaluatePtcChildToolPolicy(
  input: PtcChildToolPolicyInput,
): { readonly block: true; readonly reason: string } | undefined {
  if (!input.ptcChildTools) return undefined;
  const resolved = resolveEffectivePtcTarget(input);
  if (!resolved) {
    return { block: true, reason: 'PTC could not resolve the requested tool in this turn.' };
  }
  if (!input.context.parentToolCallId) return evaluatePtcDirectToolPolicy(resolved);
  return evaluatePtcChildTargetPolicy(resolved);
}

function evaluatePtcChildTargetPolicy(
  resolved: NonNullable<ReturnType<typeof resolveEffectivePtcTarget>>,
): { readonly block: true; readonly reason: string } | undefined {
  if (
    (resolved.tool && !isPtcChildTool(resolved.tool)) ||
    PTC_DIRECT_ONLY_TOOL_NAMES.has(resolved.name) ||
    (resolved.fromMcpInvoke && resolved.name === 'mcp_invoke')
  ) {
    return { block: true, reason: `PTC cannot invoke ${resolved.name} programmatically.` };
  }
  // agent create and session send stay top-level (PTC_MAVIS_DIRECT_COMMANDS);
  // run_code reaches every other command through its mavis_* tool.
  if (resolved.name === 'mavis' && isPtcMavisDirectCommand(mavisCommand(resolved.args))) {
    return { block: true, reason: 'PTC cannot invoke this mavis command programmatically.' };
  }
  return undefined;
}

function evaluatePtcDirectToolPolicy(
  resolved: NonNullable<ReturnType<typeof resolveEffectivePtcTarget>>,
): { readonly block: true; readonly reason: string } | undefined {
  if (resolved.name === 'mavis') {
    // The top-level mavis of a PTC Turn lists only agent create, session send
    // and their help; the refusal names the run_code tool the model needs.
    const child = ptcMavisChildToolName(mavisCommand(resolved.args));
    return child
      ? {
          block: true,
          reason: `This mavis command runs inside run_code in a PTC turn: ${ptcMavisRunCodeCall(child)}.`,
        }
      : undefined;
  }
  if (resolved.fromMcpInvoke && isPtcChildTarget(resolved)) {
    return {
      block: true,
      reason: 'This mcp target must be called through run_code in a PTC turn.',
    };
  }
  return undefined;
}

function isPtcChildTarget(
  resolved: NonNullable<ReturnType<typeof resolveEffectivePtcTarget>>,
): boolean {
  return (
    resolved.name !== 'mavis' &&
    resolved.name !== 'mcp_invoke' &&
    (!resolved.tool || isPtcChildTool(resolved.tool))
  );
}

function hasPtcDirectMcpTarget(gateway: RuntimeTool): boolean {
  const registries = getMcpInvokeRegistries(gateway);
  if (!registries) return false;
  const targets = [
    ...registries.registry.values(),
    ...[...registries.referenceRegistry.values()].map((reference) => reference.tool),
  ];
  return targets.some(isPtcDirectMcpTarget);
}

/** An mcp_invoke target that a PTC Turn keeps behind the top-level gateway, never in run_code. */
export function isPtcDirectMcpTarget(target: RuntimeTool): boolean {
  return target.def.name === 'mavis' || !isPtcChildTool(target);
}

function resolveEffectivePtcTarget(input: PtcChildToolPolicyInput):
  | {
      readonly name: string;
      readonly args: unknown;
      readonly tool?: RuntimeTool;
      readonly fromMcpInvoke: boolean;
    }
  | undefined {
  if (input.originalContext.toolCall.name === 'mcp_invoke') {
    if (input.delegatedTarget) {
      return {
        name: input.delegatedTarget.def.name,
        args: input.context.args,
        tool: input.delegatedTarget,
        fromMcpInvoke: true,
      };
    }
    const gateway = input.tools.find((tool) => tool.def.name === 'mcp_invoke');
    if (!gateway) return undefined;
    const resolution = resolveMcpInvokeTarget(gateway, input.originalContext.args);
    return resolution?.kind === 'resolved'
      ? {
          name: resolution.target.def.name,
          args: resolution.arguments,
          tool: resolution.target,
          fromMcpInvoke: true,
        }
      : undefined;
  }
  const tool = input.tools.find((candidate) => candidate.def.name === input.context.toolCall.name);
  return {
    name: input.context.toolCall.name,
    args: input.context.args,
    ...(tool ? { tool } : {}),
    fromMcpInvoke: false,
  };
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function mavisCommand(value: unknown): unknown {
  return recordValue(value).command;
}
