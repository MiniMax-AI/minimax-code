import type { ToolResult } from './types.js';

/**
 * Whether a tool result reports a failure. An explicit `isError` takes the
 * place of `details.is_error`, and `details.ok === false` is a failure either
 * way. The Pi tool adapter applies the same rule, so a host that forwards a
 * result elsewhere (an MCP server, the PTC executor) reports the failure the
 * turn records.
 */
export function toolResultIsError(result: Pick<ToolResult, 'isError' | 'details'>): boolean {
  const isError = result.isError ?? result.details?.['is_error'];
  return isError === true || result.details?.['ok'] === false;
}
