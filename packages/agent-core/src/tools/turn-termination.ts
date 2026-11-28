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
export const TURN_TERMINATING_TOOL_RESULT_DETAIL = 'terminates_turn';

/**
 * Durable form of pi `terminateAgent`: this result stopped the run whatever
 * else shared its batch. pi skips the calls after it and runs no more steps,
 * so a batch holding such a result ended there even though its other results
 * carry no marker. Written with {@link TURN_TERMINATING_TOOL_RESULT_DETAIL}
 * when nothing is left to wait for, or with `waiting_for_user` when the Turn
 * waits for the user; it never turns a wait into a finished Turn.
 */
export const TURN_STOPPING_TOOL_RESULT_DETAIL = 'stops_turn';

/** True when tool-result details carry the durable run-stop marker. */
export function isTurnStoppingToolResultDetails(details: unknown): boolean {
  if (!isRecord(details)) return false;
  return details[TURN_STOPPING_TOOL_RESULT_DETAIL] === true;
}

/** True when tool-result details carry the durable Turn-termination marker. */
export function isTurnTerminatingToolResultDetails(details: unknown): boolean {
  if (!isRecord(details)) return false;
  return details[TURN_TERMINATING_TOOL_RESULT_DETAIL] === true;
}

/**
 * True when an assistant message's tool batch ended its Turn on purpose: the
 * message called at least one tool, and either every call has a result
 * carrying the durable marker, or one of its results stopped the run and
 * carries it while no result of the batch waits for the user. These are pi's
 * two rules, `terminate` on every result of the batch or `terminateAgent`
 * on one, read back from what survives in history.
 *
 * Such a Turn ends on an assistant message whose stopReason is `toolUse`,
 * because the loop never asks the model again. Readers that look for a normal
 * finish (`stopReason === 'stop'`) use this to treat it the same way.
 * `toolResults` holds canonical `toolResult` messages or anything with the
 * same `toolCallId` / `details` fields.
 */
export function isTurnClosedByTerminatingTools(
  assistant: unknown,
  toolResults: readonly unknown[],
): boolean {
  if (!isRecord(assistant) || assistant.role !== 'assistant' || !Array.isArray(assistant.content))
    return false;
  const callIds = assistant.content.flatMap((block: unknown) =>
    isRecord(block) && block.type === 'toolCall' && typeof block.id === 'string' ? [block.id] : [],
  );
  const resultOf = (id: string) =>
    toolResults.find((result) => isRecord(result) && result.toolCallId === id) as
      | Record<string, unknown>
      | undefined;
  const results = callIds.map(resultOf);
  const terminating = (result: Record<string, unknown> | undefined) =>
    isTurnTerminatingToolResultDetails(result?.details);
  // A result that stopped the run closes the batch only when nothing in it waits for the user.
  const waits = results.some(
    (result) => isRecord(result?.details) && result.details.waiting_for_user === true,
  );
  return (
    callIds.length > 0 &&
    (results.every(terminating) ||
      (!waits &&
        results.some(
          (result) => terminating(result) && isTurnStoppingToolResultDetails(result?.details),
        )))
  );
}

/**
 * Canonical-history form of {@link isTurnClosedByTerminatingTools}: the
 * assistant message at `index` and the tool results stored right after it.
 */
export function isTurnClosedByTerminatingToolsAt(
  messages: readonly unknown[],
  index: number,
): boolean {
  const assistant = messages[index];
  if (!isRecord(assistant) || assistant.role !== 'assistant') return false;
  const toolResults: unknown[] = [];
  for (let next = index + 1; next < messages.length; next += 1) {
    const message = messages[next];
    if (!isRecord(message) || message.role !== 'toolResult') break;
    toolResults.push(message);
  }
  return isTurnClosedByTerminatingTools(assistant, toolResults);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
