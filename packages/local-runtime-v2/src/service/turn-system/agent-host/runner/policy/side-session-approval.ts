/**
 * Mutation-approval policy for Desktop Peek Sessions. TUI `/btw` uses the ordinary permission policy.
 *
 * A side Session runs while the parent Turn may still be writing to the same
 * workspace. Following Codex, tools stay available under the ordinary
 * permission model instead of a hard read-only allowlist — but a
 * mutation-capable tool must never run silently just because the Session
 * inherited an auto-approving permission mode. The gate therefore requires
 * one explicit user approval for every tool that is not a trusted read-only
 * built-in, regardless of the current permission mode.
 *
 * The exemption is an allowlist, not a denylist: a tool nobody has classified
 * yet prompts instead of silently running unattended in a side Session.
 * Provenance is catalog-owned (`builtin` / `builtin-matrix`), so a configured
 * tool that merely reuses a built-in name still prompts.
 */
const SIDE_SESSION_PROMPT_EXEMPT_TOOLS: ReadonlySet<string> = new Set(['read', 'grep', 'glob']);

/**
 * The trusted run_code itself does nothing: every child it calls reaches this
 * gate on its own (run_code children go through the same beforeToolCall chain
 * with their own name and source), so read, grep and glob children run
 * unprompted and every other child still asks once. Prompting for the outer
 * call as well would add a confirmation the native catalog never asks for.
 */
const SIDE_SESSION_PTC_PROGRAM_TOOL = 'run_code';

export const SIDE_SESSION_APPROVAL_REASON =
  'This tool runs inside a temporary side conversation while the main task may still be working; confirm before running it here.';

/** True when the tool must be confirmed by the user before running in a side Session. */
export function sideSessionRequiresApproval(input: {
  readonly toolName: string;
  readonly toolSource: string;
}): boolean {
  const normalized = input.toolName.trim().toLowerCase();
  if (input.toolSource === 'builtin' && input.toolName === SIDE_SESSION_PTC_PROGRAM_TOOL) {
    return false;
  }
  const trustedBuiltin = input.toolSource === 'builtin' || input.toolSource === 'builtin-matrix';
  return !(trustedBuiltin && SIDE_SESSION_PROMPT_EXEMPT_TOOLS.has(normalized));
}
