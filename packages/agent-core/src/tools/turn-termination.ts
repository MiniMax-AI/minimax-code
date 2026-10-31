/**
 * Durable canonical marker for a tool result that deliberately ended its Turn.
 *
 * `ToolResult.terminate` stops the Pi agent loop, but it is not persisted on
 * the canonical `toolResult` message — only `content` and `details` survive.
 * Everything that later reads canonical history therefore sees an ordinary
 * tool-result tail and cannot tell a Turn that ended on purpose apart from one
 * that was interrupted mid-execution. Turn continuation reads exactly that
 * tail, so without a durable marker it offers to resume finished work.
 *
 * Tools that end a Turn because they are waiting for the user (`ask_user`,
 * `request_feature_enable`, Plan mode) already publish `waiting_for_user`.
 * That marker keeps its own distinct meaning and must be read first; this one
 * is for terminations with nothing left to wait for and nothing to resume.
 */
export const TURN_TERMINATING_TOOL_RESULT_DETAIL = "terminates_turn";

/** True when tool-result details carry the durable Turn-termination marker. */
export function isTurnTerminatingToolResultDetails(details: unknown): boolean {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return false;
  return (details as Record<string, unknown>)[TURN_TERMINATING_TOOL_RESULT_DETAIL] === true;
}
