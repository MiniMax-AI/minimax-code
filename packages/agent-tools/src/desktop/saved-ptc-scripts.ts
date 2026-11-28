import { ptcScriptDescriptionLine } from './ptc-script-text.js';

/**
 * PTC scripts a child Agent saved during one task Turn.
 *
 * The runtime records them from the `save_run_code_script` tool results, because a
 * child Agent writing them into its own final reply is not reliable. The parent
 * Agent's script catalog is frozen for the whole context window, so this report
 * is the only way it learns about a new script during the same window.
 */

export interface SavedPtcScript {
  /** Absolute path, exactly as the save tool returned it. */
  readonly path: string;
  readonly scope: 'project' | 'user';
  readonly description?: string;
  /** True when the save replaced an existing file. */
  readonly overwritten: boolean;
}

/** Recommendation from the proposal; a task that saves more is still reported. */
const SAVED_PTC_SCRIPT_MAX_ENTRIES = 20;
const SAVED_PTC_SCRIPT_DESCRIPTION_MAX_CHARS = 120;

/** Fixed wording the parent Agent reads at the end of a task result. */
export const SAVED_PTC_SCRIPTS_USAGE =
  'The subagent saved these run_code scripts during this task. Run one with run_code({ path, args, description }). Mention them to the user when you report the result.';

/**
 * Renders the `<saved-run-code-scripts>` block, or undefined when the task saved
 * nothing. Callers append it so a task without scripts reports byte-identical
 * text.
 */
export function formatSavedPtcScripts(
  scripts: readonly SavedPtcScript[] | undefined,
): string | undefined {
  const all = scripts ?? [];
  const listed = all.slice(0, SAVED_PTC_SCRIPT_MAX_ENTRIES);
  if (listed.length === 0) return undefined;
  const remaining = all.length - listed.length;
  return [
    '<saved-run-code-scripts>',
    SAVED_PTC_SCRIPTS_USAGE,
    ...listed.map(savedPtcScriptLine),
    ...(remaining > 0 ? [`- ... and ${remaining} more`] : []),
    '</saved-run-code-scripts>',
  ].join('\n');
}

function savedPtcScriptLine(script: SavedPtcScript): string {
  const state = script.overwritten ? 'overwritten' : 'created';
  const description = script.description
    ? ptcScriptDescriptionLine(script.description, SAVED_PTC_SCRIPT_DESCRIPTION_MAX_CHARS)
    : '';
  return `- ${script.path} (${script.scope}, ${state})${description ? `: ${description}` : ''}`;
}
