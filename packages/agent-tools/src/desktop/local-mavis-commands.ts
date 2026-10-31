/**
 * Desktop mavis subcommand vocabulary: single source of truth.
 *
 * A separate module lets `builtin-defs.ts` (definitions) and `local-mavis.ts` (dispatcher) share
 * the command list without an import cycle. `local-mavis.ts` depends on `LocalMavisToolDef` in
 * builtin-defs.ts, so the vocabulary cannot live in the dispatcher.
 *
 * When adding a subcommand, update:
 * 1. `LOCAL_MAVIS_COMMANDS` here.
 * 2. `LOCAL_MAVIS_COMMAND_SCHEMAS` and `HANDLERS` in `local-mavis.ts`.
 * 3. The command list in `LocalMavisToolDef.schema.properties.command.description` in
 *   `builtin-defs.ts`.
 * 4. Its PTC routing: add an entry to `PTC_MAVIS_CHILD_TOOLS` and describe it in
 *   `local-mavis-ptc.ts`, or keep it top-level (`PTC_MAVIS_DIRECT_COMMANDS`, and
 *   update the top-level description).
 *
 * Type constraints in `local-mavis.ts` cause compilation to fail if 1 and 2 drift, and
 * `local-mavis-ptc.ts`'s unit test fails when 4 is missed.
 */

import type { ToolExecutionContext } from '@mavis/agent-core/tools';

import { normalizeMavisCommand } from '../shared/mavis-operation-classifier.js';

export const LOCAL_MAVIS_COMMANDS = [
  'agent list',
  'agent get',
  'agent create',
  'agent update',
  'agent delete',
  'agent help',

  'cron list',
  'cron get',
  'cron resolve-model',
  'cron create',
  'cron self',
  'cron once',
  'cron update',
  'cron delete',
  'cron trigger',
  'cron sessions',
  'cron help',

  'session list',
  'session get',
  'session send',
  'session update',
  'session delete',
  'session messages',
  'session help',

  'mcp list',
  'mcp get',
  'mcp create',
  'mcp update',
  'mcp delete',
  'mcp help',
] as const;

/** Internal command vocabulary reused by the standalone Cron adapters. */
export const LOCAL_CRON_COMMANDS = [
  'cron list',
  'cron get',
  'cron resolve-model',
  'cron create',
  'cron self',
  'cron once',
  'cron update',
  'cron delete',
  'cron trigger',
  'cron sessions',
  'cron help',
] as const;
export type LocalMavisCommandName =
  | (typeof LOCAL_MAVIS_COMMANDS)[number]
  | (typeof LOCAL_CRON_COMMANDS)[number];

/**
 * On a PTC Turn every Desktop mavis command except these becomes a run_code
 * tool of its own (`PTC_MAVIS_CHILD_TOOLS`). These two start or continue other
 * work: agent create makes a new Agent with its root Session, session send
 * triggers or continues another Session's Turn. Such spawn and continue calls
 * stay top-level: when v8 kept task and task_append inside run_code only,
 * evals delegated clearly less and never continued a delegated Session, with
 * no score gain, and v9 put them back. session delete is not a command; the
 * mavis tool answers it with a refusal, which is harmless at the top level.
 */
const PTC_MAVIS_DIRECT_COMMANDS = new Set<string>([
  'agent create',
  'session send',
  'session delete',
]);

/**
 * The run_code tools of a PTC Turn with the Desktop mavis tool: one per
 * command, each with that command's own argument schema (local-mavis-ptc.ts),
 * so a program sees and is checked against what each command takes instead
 * of one `mavis({ command, args })`. The help commands are not flattened.
 */
export const PTC_MAVIS_CHILD_TOOLS = [
  { name: 'mavis_agent_list', command: 'agent list' },
  { name: 'mavis_agent_get', command: 'agent get' },
  { name: 'mavis_agent_update', command: 'agent update' },
  { name: 'mavis_agent_delete', command: 'agent delete' },
  { name: 'mavis_session_list', command: 'session list' },
  { name: 'mavis_session_get', command: 'session get' },
  { name: 'mavis_session_update', command: 'session update' },
  { name: 'mavis_session_messages', command: 'session messages' },
  { name: 'mavis_mcp_list', command: 'mcp list' },
  { name: 'mavis_mcp_get', command: 'mcp get' },
  { name: 'mavis_mcp_create', command: 'mcp create' },
  { name: 'mavis_mcp_update', command: 'mcp update' },
  { name: 'mavis_mcp_delete', command: 'mcp delete' },
] as const satisfies readonly { readonly name: string; readonly command: LocalMavisCommandName }[];

export type PtcMavisChildToolName = (typeof PTC_MAVIS_CHILD_TOOLS)[number]['name'];

/** The run_code tool standing for a Desktop mavis command; undefined for the top-level ones. */
export function ptcMavisChildToolName(command: unknown): PtcMavisChildToolName | undefined {
  if (typeof command !== 'string') return undefined;
  const normalized = normalizeMavisCommand(command);
  return PTC_MAVIS_CHILD_TOOLS.find((entry) => entry.command === normalized)?.name;
}

/** True for the names of the mavis_* run_code tools; metrics fold them into `mavis`. */
export function isPtcMavisChildToolName(name: string): boolean {
  return PTC_MAVIS_CHILD_TOOLS.some((entry) => entry.name === name);
}

/** Desktop mavis commands a PTC Turn runs only through their mavis_* run_code tool. */
export function isPtcMavisProgrammaticCommand(command: unknown): boolean {
  return ptcMavisChildToolName(command) !== undefined;
}

/** Desktop mavis commands that stay on the top-level mavis tool of a PTC Turn. */
export function isPtcMavisDirectCommand(command: unknown): boolean {
  return (
    typeof command === 'string' && PTC_MAVIS_DIRECT_COMMANDS.has(normalizeMavisCommand(command))
  );
}

/** The call a model writes inside run_code for a flattened command. */
export function ptcMavisRunCodeCall(toolName: string, args = '{ ... }'): string {
  return `await tools.${toolName}(${args})`;
}

/**
 * The run_code tool of `command` when this Turn's run_code lists it (the
 * executor resolves only names its run_code registered). Undefined on every
 * other Turn, so the mavis tool keeps its wording there byte for byte.
 */
export function ptcMavisRunCodeTool(
  ctx: Pick<ToolExecutionContext, 'ptcExecutor'>,
  command: string,
): PtcMavisChildToolName | undefined {
  const name = ptcMavisChildToolName(command);
  return name && ctx.ptcExecutor?.getToolExecutionMode(name) !== undefined ? name : undefined;
}

/**
 * Help output on a PTC Turn whose run_code lists the mavis_* tools: each
 * flattened command names its run_code call and its examples use it, so the
 * model does not copy a `mavis({ command })` call the top level refuses.
 * Every other Turn gets the output unchanged.
 */
export function ptcMavisHelpOutput<T extends { readonly ok: boolean; readonly command: string }>(
  ctx: Pick<ToolExecutionContext, 'ptcExecutor'>,
  output: T,
): T {
  if (!output.ok || !output.command.endsWith(' help') || !('response' in output)) return output;
  const response = output.response;
  if (!isRecord(response) || !Array.isArray(response.commands)) return output;
  let changed = false;
  const commands = response.commands.map((entry: unknown) => {
    const command = isRecord(entry) ? entry.command : undefined;
    const tool = typeof command === 'string' ? ptcMavisRunCodeTool(ctx, command) : undefined;
    if (!isRecord(entry) || !tool) return entry;
    changed = true;
    const examples = Array.isArray(entry.examples)
      ? entry.examples.map((example: unknown) =>
          typeof example === 'string'
            ? example.replace(/^mavis\(\{ command: "[^"]+", args: (.*) \}\)$/u, (_, args) =>
                ptcMavisRunCodeCall(tool, String(args)),
              )
            : example,
        )
      : undefined;
    return { ...entry, run_code: ptcMavisRunCodeCall(tool), ...(examples ? { examples } : {}) };
  });
  return changed ? { ...output, response: { ...response, commands } } : output;
}

/** How to archive a Session, in the form this Turn accepts. */
export function localMavisArchiveCall(ctx: Pick<ToolExecutionContext, 'ptcExecutor'>): string {
  const tool = ptcMavisRunCodeTool(ctx, 'session update');
  return tool
    ? `${ptcMavisRunCodeCall(tool, '{ session_id, archived: true }')} inside run_code`
    : 'session update (archived: true)';
}

const LOCAL_MAVIS_MUTATION_COMMANDS = new Set([
  'agent create',
  'agent update',
  'agent delete',
  'cron create',
  'cron self',
  'cron once',
  'cron update',
  'cron delete',
  'cron trigger',
  'session update',
  'session interrupt',
  'session send',
  'mcp create',
  'mcp update',
  'mcp delete',
]);

/** Recovery line of a truncated mavis response; a mutation is never replayed. */
export function mavisRecoveryInstruction(command: string, runCodeTool?: string): string {
  if (LOCAL_MAVIS_MUTATION_COMMANDS.has(command)) {
    return (
      `do not repeat the mutation command ${JSON.stringify(command)} automatically; ` +
      'inspect current state with the corresponding get/list command'
    );
  }
  // A PTC Turn runs this command as its mavis_* run_code tool, the only form it accepts there.
  const again = runCodeTool
    ? `tools.${runCodeTool} again inside run_code`
    : `mavis again with command=${JSON.stringify(command)}`;
  return (
    `call ${again} and narrower args ` +
    '(prefer a smaller limit, tighter search/filter, pagination cursor, or a specific get command); ' +
    'preserve the same logical query'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
