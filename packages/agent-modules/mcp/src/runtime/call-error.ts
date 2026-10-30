/**
 * Describes why an MCP tool call failed below the tool itself, for callers
 * that hand the original error to scripts (PTC `error.raw`). It never decides
 * anything for the host: it only copies what the SDK or the transport said.
 *
 * - JSON-RPC errors (the SDK's McpError) become `{ code, message, data }`
 *   with the peer's own message (the SDK prefixes "MCP error <code>: ").
 * - Connection and timeout errors become `{ name, message, code }`, taking
 *   the innermost error of the `cause` chain (for example the
 *   `connect ECONNREFUSED` error behind a `fetch failed`).
 */
export type McpCallErrorRaw =
  | { readonly code: number; readonly message: string; readonly data?: unknown }
  | { readonly name?: string; readonly message?: string; readonly code?: string };

const MAX_CAUSE_DEPTH = 4;

export function describeMcpCallError(error: unknown): McpCallErrorRaw | undefined {
  const chain = errorChain(error);
  const innermost = chain.at(-1);
  if (innermost === undefined) return undefined;
  const rpc = chain.find((entry) => Number.isInteger(Reflect.get(entry, 'code')));
  if (rpc) {
    const code = Reflect.get(rpc, 'code') as number;
    const message = stringField(rpc, 'message') ?? '';
    const data = Reflect.get(rpc, 'data');
    return {
      code,
      message: message.startsWith(`MCP error ${code}: `)
        ? message.slice(`MCP error ${code}: `.length)
        : message,
      ...(data === undefined ? {} : { data }),
    };
  }
  const code = chain.map((entry) => stringField(entry, 'code')).find((value) => value);
  const name = stringField(innermost, 'name');
  const message = stringField(innermost, 'message');
  return {
    ...(name ? { name } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(code ? { code } : {}),
  };
}

function errorChain(error: unknown): object[] {
  const chain: object[] = [];
  let current: unknown = error;
  while (current !== null && typeof current === 'object' && chain.length < MAX_CAUSE_DEPTH) {
    if (chain.includes(current)) break;
    chain.push(current);
    current = Reflect.get(current, 'cause');
  }
  return chain;
}

function stringField(value: object, key: string): string | undefined {
  const field = Reflect.get(value, key);
  return typeof field === 'string' ? field : undefined;
}
