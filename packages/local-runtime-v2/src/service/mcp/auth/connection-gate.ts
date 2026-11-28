import {
  findMcpAuthRequiredError,
  McpAuthRequiredError,
  type McpRequestAuthorizer,
} from '@mavis/mcp';
import type { GlobalEventInput } from '@mavis/shared/global-events';
import type { McpRuntimeLogger } from '@mavis/mcp/runtime/types';
import type { McpAuthTarget, McpOAuthBinding, McpOAuthService } from '../oauth/index.js';
import { publicAuthTarget } from './bindings.js';

const AUTH_REQUIRED_ERROR = 'MCP server requires authorization.';
const REAUTH_REQUIRED_ERROR =
  'MCP server authorization expired or is insufficient. Reauthorize to continue.';

/** Public status text; shared verbatim with the TUI `/mcp` allowlist. */
export function publicAuthRequiredError(error: McpAuthRequiredError): string {
  return error.reason === 'auth_required' ? AUTH_REQUIRED_ERROR : REAUTH_REQUIRED_ERROR;
}

/**
 * One connection attempt. Remembers an authorization failure raised by the
 * authorizer so a timeout that wins the race after a 401 still classifies as
 * authorization (plan §5.4).
 */
export class McpAuthAttempt {
  readonly authorizer: McpRequestAuthorizer | undefined;
  private failure: McpAuthRequiredError | undefined;

  constructor(inner: McpRequestAuthorizer | undefined) {
    this.authorizer = inner && {
      authorize: (signal) => inner.authorize(signal),
      onChallenge: async (input) => {
        try {
          return await inner.onChallenge(input);
        } catch (error) {
          this.failure ??= findMcpAuthRequiredError(error);
          throw error;
        }
      },
    };
  }

  classify(error: unknown): McpAuthRequiredError | undefined {
    return findMcpAuthRequiredError(error) ?? this.failure;
  }
}

interface McpConnectionAuthGateOptions {
  readonly oauth?: McpOAuthService;
  readonly publish?: (event: GlobalEventInput<'mcp.auth_required'>) => void;
  readonly logger?: McpRuntimeLogger;
}

/**
 * Background and interactive connection policy for user/project servers:
 * background paths never connect while authorization is needed, every outcome
 * is reported to the OAuth state, and Turn discovery announces once per
 * Session and target.
 */
export class McpConnectionAuthGate {
  private readonly announced = new Set<string>();

  constructor(private readonly options: McpConnectionAuthGateOptions) {}

  get enabled(): boolean {
    return this.options.oauth !== undefined;
  }

  begin(binding: McpOAuthBinding | undefined): McpAuthAttempt {
    return new McpAuthAttempt(binding && this.options.oauth?.authorizerFor(binding));
  }

  /** Error to report when a background path must not connect, otherwise undefined. */
  async skipBackground(
    binding: McpOAuthBinding | undefined,
  ): Promise<McpAuthRequiredError | undefined> {
    const oauth = this.options.oauth;
    if (!binding || !oauth || !(await oauth.shouldSkipBackground(binding))) return undefined;
    const state = await oauth.getState(binding);
    return new McpAuthRequiredError(
      state.authState === 'needs_reauth' ? 'reauth_required' : 'auth_required',
    );
  }

  /** Best effort: a failed state write must not turn a working connection into a failure. */
  async observe(
    binding: McpOAuthBinding | undefined,
    outcome: 'connected' | McpAuthRequiredError,
  ): Promise<void> {
    const oauth = this.options.oauth;
    if (!binding || !oauth || binding.staticAuthorization) return;
    try {
      await oauth.markObserved(binding, outcome);
    } catch {
      this.options.logger?.warn('mcp.oauth.observe_failed', { kind: binding.target.kind });
    }
  }

  announce(
    binding: McpOAuthBinding,
    error: McpAuthRequiredError,
    turn: { sessionId?: string; turnId?: string },
  ): void {
    if (!turn.sessionId || !this.options.publish) return;
    const key = announcementKey(turn.sessionId, binding.target);
    if (this.announced.has(key)) return;
    this.announced.add(key);
    try {
      this.options.publish({
        type: 'mcp.auth_required',
        payload: {
          target: publicAuthTarget(binding.target),
          reason: error.reason,
          sessionId: turn.sessionId,
          ...(turn.turnId ? { turnId: turn.turnId } : {}),
        },
      });
    } catch {
      this.options.logger?.warn('mcp.oauth.announce_failed', { kind: binding.target.kind });
    }
  }

  /** A committed state change re-arms the announcement in every Session. */
  forgetTarget(target: McpAuthTarget): void {
    const suffix = targetKey(target);
    for (const key of this.announced) {
      if (key.endsWith(suffix)) this.announced.delete(key);
    }
  }

  forgetSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.announced) {
      if (key.startsWith(prefix)) this.announced.delete(key);
    }
  }
}

function announcementKey(sessionId: string, target: McpAuthTarget): string {
  return `${sessionId}${targetKey(target)}`;
}

/** Session-independent: one project server is the same target in every Session. */
function targetKey(target: McpAuthTarget): string {
  return `\u0000${target.kind}\u0000${target.serverName}`;
}
