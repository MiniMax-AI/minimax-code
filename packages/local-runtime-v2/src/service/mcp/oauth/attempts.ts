/**
 * In-memory authorization attempts (plan §5.3). PKCE verifier, state, registration and the
 * discovery snapshot never leave process memory; at most one attempt exists per credential key.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { OAuthClientInformationMixed } from '@mavis/mcp/oauth';
import type { CallbackLease } from './callback-server.js';
import type { McpAuthStartResult, McpOAuthBinding, McpOAuthErrorCode } from './contracts.js';
import type { StoredRegistration } from './credential-store.js';
import type { DiscoveryResult } from './discovery.js';

export const ATTEMPT_TIMEOUT_MS = 10 * 60_000;

export interface AuthorizationAttempt {
  readonly id: string;
  readonly credentialKey: string;
  readonly binding: McpOAuthBinding;
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly callbackPath: string;
  readonly clientInformation: OAuthClientInformationMixed;
  readonly registration: StoredRegistration;
  readonly discovery: DiscoveryResult;
  readonly requestedScope: string | undefined;
  readonly pending: Extract<McpAuthStartResult, { status: 'pending' }>;
  readonly lease: CallbackLease;
  readonly timer: NodeJS.Timeout;
  /** Settles when the attempt commits, fails, is cancelled or times out. */
  readonly settled: Deferred<{ errorCode?: McpOAuthErrorCode }>;
  /** Set once the callback (loopback or manual) has been accepted; state is single-use. */
  consumed: boolean;
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function newAttemptSecrets(): { id: string; state: string } {
  return { id: randomUUID(), state: randomBytes(32).toString('base64url') };
}

export class AttemptRegistry {
  private readonly byId = new Map<string, AuthorizationAttempt>();
  private readonly byKey = new Map<string, AuthorizationAttempt>();
  private readonly byState = new Map<string, AuthorizationAttempt>();

  add(attempt: AuthorizationAttempt): void {
    this.byId.set(attempt.id, attempt);
    this.byKey.set(attempt.credentialKey, attempt);
    this.byState.set(attempt.state, attempt);
  }

  get(id: string): AuthorizationAttempt | undefined {
    return this.byId.get(id);
  }

  forKey(credentialKey: string): AuthorizationAttempt | undefined {
    return this.byKey.get(credentialKey);
  }

  forState(state: string): AuthorizationAttempt | undefined {
    return this.byState.get(state);
  }

  all(): AuthorizationAttempt[] {
    return [...this.byId.values()];
  }

  /** Removes the attempt everywhere so late callbacks for it are rejected as unknown state. */
  remove(attempt: AuthorizationAttempt): boolean {
    if (this.byId.get(attempt.id) !== attempt) return false;
    this.byId.delete(attempt.id);
    if (this.byKey.get(attempt.credentialKey) === attempt) this.byKey.delete(attempt.credentialKey);
    if (this.byState.get(attempt.state) === attempt) this.byState.delete(attempt.state);
    clearTimeout(attempt.timer);
    attempt.lease.release();
    return true;
  }
}

/** Callback URL belongs to this attempt: same redirect path and port, matching state. */
export function callbackMatches(
  attempt: AuthorizationAttempt,
  url: URL,
  listenPort?: number,
): boolean {
  const redirect = new URL(attempt.redirectUri);
  const port = listenPort ?? Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return (
    url.searchParams.get('state') === attempt.state &&
    url.pathname === attempt.callbackPath &&
    port === Number(redirect.port || attempt.lease.port)
  );
}

export type CallbackVerdict =
  | { ok: true; code: string }
  | { ok: false; errorCode: McpOAuthErrorCode; oauthError?: string };

/**
 * RFC 9207 decision table, then the authorization response itself. `error_description` is never
 * read; only a sanitised OAuth error code is kept.
 */
export function evaluateCallback(
  attempt: AuthorizationAttempt,
  params: URLSearchParams,
): CallbackVerdict {
  const iss = params.get('iss');
  const issSupported =
    attempt.discovery.metadata.authorization_response_iss_parameter_supported === true;
  if (iss !== null ? iss !== attempt.discovery.issuer : issSupported) {
    return { ok: false, errorCode: 'MCP_OAUTH_ISSUER_MISMATCH' };
  }
  const error = params.get('error');
  if (error !== null) {
    const oauthError = /^[\w.-]{1,64}$/.test(error) ? error : 'invalid_response';
    return { ok: false, errorCode: 'MCP_OAUTH_ACCESS_DENIED', oauthError };
  }
  const code = params.get('code');
  if (!code) return { ok: false, errorCode: 'MCP_OAUTH_TOKEN_EXCHANGE_FAILED' };
  return { ok: true, code };
}
