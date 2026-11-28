/**
 * MCP request authorization contract.
 *
 * The host (local-runtime-v2 OAuth service) implements `McpRequestAuthorizer`; the transport's
 * authorized fetch layer calls it to inject Bearer tokens and to classify 401/403 challenges.
 * This module only defines protocol-level types — storage and product state live in the host.
 */

export type McpAuthRequiredReason = 'auth_required' | 'insufficient_scope' | 'reauth_required';

/** Parameters parsed from a `WWW-Authenticate: Bearer` challenge. Never carries tokens. */
export interface McpAuthChallenge {
  readonly resourceMetadataUrl?: string;
  readonly scope?: string;
  readonly error?: string;
}

const MCP_AUTH_REQUIRED_ERROR_NAME = 'McpAuthRequiredError';

export class McpAuthRequiredError extends Error {
  override readonly name = MCP_AUTH_REQUIRED_ERROR_NAME;

  constructor(
    readonly reason: McpAuthRequiredReason,
    readonly challenge?: McpAuthChallenge,
    options?: ErrorOptions,
  ) {
    super(`MCP server requires authorization (${reason})`, options);
  }
}

/**
 * Walks the cause chain, matching by `name` so errors created by another module instance
 * (SDK / zod dual installs, bundled copies) are still recognised.
 */
export function findMcpAuthRequiredError(error: unknown): McpAuthRequiredError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current.name === MCP_AUTH_REQUIRED_ERROR_NAME && 'reason' in current) {
      return current as McpAuthRequiredError;
    }
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

export interface McpChallengeInput {
  readonly status: 401 | 403;
  readonly challenge: McpAuthChallenge;
  /** Access token the rejected request carried. */
  readonly usedToken?: string;
  /**
   * True when the rejected request was already the single replay with a token returned by a
   * previous `onChallenge`. The authorizer must not refresh again; it records the rejection and
   * throws `McpAuthRequiredError`.
   */
  readonly replayed?: boolean;
}

export interface McpRequestAuthorizer {
  /** Bearer for the MCP origin, or undefined when nothing is stored (no network). */
  authorize(signal?: AbortSignal): Promise<string | undefined>;
  /**
   * 401 or 403(insufficient_scope) from the MCP origin. Return a fresh token to replay once, or
   * throw McpAuthRequiredError / a plain connection error (network/5xx during refresh).
   */
  onChallenge(input: McpChallengeInput): Promise<string>;
}

/** Per-connection callback raised when the authorized fetch layer gives up on authorization. */
export type McpAuthRequiredListener = (error: McpAuthRequiredError) => void;
