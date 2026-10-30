import type { ProgrammaticToolResult, ToolResult } from '@mavis/agent-core/tools';
import { describeMcpCallError } from '@mavis/mcp';
import type { LocalMcpCallResult } from '../contracts.js';
import { readRecord } from '../runtime/config.js';

/**
 * Raw transport/protocol error behind a synthesized `isError` call result.
 * Kept under a non-enumerable symbol so `details.mcp`, history, logs and
 * persistence see the unchanged result; only programmatic callers read it.
 */
const LOCAL_MCP_CALL_ERROR_RAW = Symbol('mavis.localMcp.callErrorRaw');

/** Returns `result` with the described error attached; the visible fields are untouched. */
function withLocalMcpCallErrorRaw(result: LocalMcpCallResult, error: unknown): LocalMcpCallResult {
  const raw = describeMcpCallError(error);
  if (raw !== undefined) {
    Object.defineProperty(result, LOCAL_MCP_CALL_ERROR_RAW, {
      value: raw,
      enumerable: false,
    });
  }
  return result;
}

/**
 * The failed-call result the model sees, with the raw error attached for PTC `error.raw`.
 * The model keeps seeing the same error text; the JSON-RPC or connection error
 * itself rides along invisibly.
 */
export function localMcpCallFailureResult(error: unknown): LocalMcpCallResult {
  return withLocalMcpCallErrorRaw(
    {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    },
    error,
  );
}

/**
 * The PTC payload of an MCP call result: `structuredContent` as `data` (on
 * success and on `isError`) and the raw protocol error when the call failed
 * below the tool. Model calls ignore it.
 */
function mcpProgrammaticResult(result: LocalMcpCallResult): ProgrammaticToolResult | undefined {
  const raw: unknown = Reflect.get(result, LOCAL_MCP_CALL_ERROR_RAW);
  const data = readRecord(result.structuredContent);
  if (data === undefined && raw === undefined) return undefined;
  return {
    ...(data === undefined ? {} : { data }),
    ...(raw === undefined ? {} : { errorRaw: raw }),
  };
}

/**
 * `toolResult` with the PTC payload of `result` added as its last field. The
 * model-visible content and details are unchanged; without a payload it is
 * returned as is.
 */
export function withMcpProgrammatic(
  result: LocalMcpCallResult,
  toolResult: ToolResult,
): ToolResult {
  const programmatic = mcpProgrammaticResult(result);
  return programmatic ? { ...toolResult, programmatic } : toolResult;
}
