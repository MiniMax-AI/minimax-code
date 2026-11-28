/**
 * `McpRequestAuthorizer` implementation backed by the credential store (plan §5.4).
 *
 * Every read goes to disk so tokens rotated by another process are picked up. Pre-expiry
 * refresh and 401 handling run inside the per-key cross-process lock: whoever holds the lock
 * re-reads, reuses a token another process already rotated, or refreshes exactly once.
 */
import {
  McpAuthRequiredError,
  type McpRuntimeLogger,
  type McpAuthChallenge,
  type McpChallengeInput,
  type McpRequestAuthorizer,
} from '@mavis/mcp';
import {
  refreshAuthorization,
  type AuthorizationServerMetadata,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from '@mavis/mcp/oauth';
import type { McpOAuthBinding } from './contracts.js';
import {
  LOCKED_REQUEST_TIMEOUT_MS,
  type McpCredentialRecord,
  type McpCredentialStore,
  type RecordMutation,
  type StoredAuthState,
  type StoredRegistration,
  type StoredTokens,
} from './credential-store.js';
import { createGuardedFetch } from './discovery.js';

const REFRESH_SKEW_MS = 60_000;
const RECENT_REFRESH_MS = 60_000;
const LAST_USED_WRITE_INTERVAL_MS = 60 * 60_000;

/**
 * Classification keys off the OAuth `error` code (the SDK error classes' static `errorCode`,
 * which survives minification) — never SDK class names, which bundlers rename. Errors without
 * an OAuth code (fetch network failures, aborts, timeouts, malformed responses) are transient.
 */
const TRANSIENT_OAUTH_CODES: Record<string, true> = {
  server_error: true,
  temporarily_unavailable: true,
  too_many_requests: true,
};

export interface AuthorizerDeps {
  store: McpCredentialStore;
  now: () => number;
  fetchImpl: typeof fetch;
  logger?: McpRuntimeLogger;
  /** Aborts in-flight refreshes when the owning service closes. */
  signal?: AbortSignal;
  clientSecretFor(binding: McpOAuthBinding): Promise<string | undefined>;
  /** Called after this authorizer persisted a state change (needs_reauth / failed). */
  onRecordChanged(binding: McpOAuthBinding, record: McpCredentialRecord | undefined): void;
}

type LockedOutcome =
  | { kind: 'token'; token: string }
  | { kind: 'auth'; error: McpAuthRequiredError }
  | { kind: 'transient'; error: Error };

interface LockedStep {
  mutation: RecordMutation;
  result: LockedOutcome;
}

/** Refresh failure that must not mark the server as needing authorization (network / 5xx). */
class McpOAuthRefreshUnavailableError extends Error {
  override readonly name = 'McpOAuthRefreshUnavailableError';

  constructor(options?: ErrorOptions) {
    super('MCP OAuth token refresh is temporarily unavailable', options);
  }
}

export function clientInformationFor(
  registration: StoredRegistration,
  userClientSecret: string | undefined,
): OAuthClientInformationMixed {
  const secret = registration.method === 'pre' ? userClientSecret : registration.client_secret;
  return {
    client_id: registration.client_id,
    ...(secret ? { client_secret: secret } : {}),
    ...(registration.token_endpoint_auth_method
      ? { token_endpoint_auth_method: registration.token_endpoint_auth_method }
      : {}),
  };
}

export class StoredCredentialAuthorizer implements McpRequestAuthorizer {
  constructor(
    private readonly deps: AuthorizerDeps,
    readonly binding: McpOAuthBinding,
    readonly credentialKey: string,
  ) {}

  async authorize(): Promise<string | undefined> {
    const record = await this.deps.store.read(this.credentialKey);
    const tokens = record?.tokens;
    if (!record || !tokens) return undefined;
    if (!this.needsRefresh(tokens)) {
      await this.touchLastUsed(record);
      return tokens.access_token;
    }
    const stillValid = () => tokens.expires_at !== undefined && tokens.expires_at > this.deps.now();
    let outcome: LockedOutcome;
    try {
      outcome = await this.locked(async (current) => {
        const fresh = current?.tokens;
        if (!current || !fresh) {
          return keep({ kind: 'auth', error: new McpAuthRequiredError('auth_required') });
        }
        if (fresh.access_token !== tokens.access_token && !this.needsRefresh(fresh)) {
          return keep({ kind: 'token', token: fresh.access_token });
        }
        return this.refresh(current);
      });
    } catch (error) {
      // Another request has been refreshing for the whole lock wait (stuck token endpoint).
      // This is only a pre-expiry refresh: keep using the token while it is valid.
      if (isLockBusy(error) && stillValid()) return tokens.access_token;
      throw error;
    }
    if (outcome.kind === 'token') return outcome.token;
    if (outcome.kind === 'auth') throw outcome.error;
    // Transient refresh failure: a still-valid token keeps working until it actually expires.
    if (stillValid()) return tokens.access_token;
    throw outcome.error;
  }

  async onChallenge(input: McpChallengeInput): Promise<string> {
    const outcome = await this.locked(async (current) => this.challengeLocked(current, input));
    if (outcome.kind === 'token') return outcome.token;
    throw outcome.error;
  }

  /** Best-effort usage stamp for the 90-day sweep; never fails a request holding a valid token. */
  private async touchLastUsed(record: McpCredentialRecord): Promise<void> {
    const now = this.deps.now();
    if (now - record.lastUsedAt < LAST_USED_WRITE_INTERVAL_MS) return;
    try {
      await this.deps.store.update(this.credentialKey, async (current) => ({
        mutation: current
          ? { kind: 'write', record: { ...current, lastUsedAt: now }, bumpRevision: false }
          : { kind: 'keep' },
        result: undefined,
      }));
    } catch (error) {
      this.deps.logger?.warn('MCP OAuth credential usage stamp failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  private needsRefresh(tokens: StoredTokens): boolean {
    return (
      tokens.refresh_token !== undefined &&
      tokens.expires_at !== undefined &&
      tokens.expires_at - this.deps.now() <= REFRESH_SKEW_MS
    );
  }

  /** Runs inside the lock with the freshest record. */
  private async challengeLocked(
    current: McpCredentialRecord | undefined,
    input: McpChallengeInput,
  ): Promise<LockedStep> {
    const tokens = current?.tokens;
    if (!current || !tokens) {
      return keep({
        kind: 'auth',
        error: new McpAuthRequiredError('auth_required', input.challenge),
      });
    }
    if (tokens.access_token !== input.usedToken) return rotatedElsewhere(tokens, input);
    if (input.status === 403) return insufficientScope(current, tokens, input);
    const refreshedRecently =
      tokens.tokenSource === 'refresh' &&
      this.deps.now() - tokens.tokenIssuedAt < RECENT_REFRESH_MS;
    if (input.replayed || refreshedRecently) {
      return reauth(current, 'rejected_after_refresh', input.challenge);
    }
    if (!tokens.refresh_token) return reauth(current, 'invalid_token', input.challenge);
    return this.refresh(current);
  }

  private async locked(
    mutate: (current: McpCredentialRecord | undefined) => Promise<LockedStep>,
  ): Promise<LockedOutcome> {
    const { record, result } = await this.deps.store.update(this.credentialKey, async (current) => {
      const step = await mutate(current);
      return {
        mutation: step.mutation,
        result: { outcome: step.result, changed: step.mutation.kind !== 'keep' },
      };
    });
    if (result.changed && result.outcome.kind !== 'token') {
      this.deps.onRecordChanged(this.binding, record);
    }
    return result.outcome;
  }

  /** Runs inside the lock with the freshest record. */
  private async refresh(current: McpCredentialRecord): Promise<LockedStep> {
    const tokens = current.tokens;
    const registration = current.registration;
    const metadata = current.authorizationServerMetadata as AuthorizationServerMetadata | undefined;
    if (!tokens?.refresh_token || !registration || !current.issuer || !metadata) {
      return reauth(current, 'invalid_token');
    }
    let status: number | undefined;
    const fetchFn = createGuardedFetch({
      fetchImpl: this.deps.fetchImpl,
      privateNetwork: this.binding.privateNetwork,
      timeoutMs: LOCKED_REQUEST_TIMEOUT_MS,
      ...(this.deps.signal ? { signal: this.deps.signal } : {}),
      onStatus: (value) => {
        status = value;
      },
    });
    try {
      const refreshed = await refreshAuthorization(current.issuer, {
        metadata,
        clientInformation: clientInformationFor(
          registration,
          await this.deps.clientSecretFor(this.binding),
        ),
        refreshToken: tokens.refresh_token,
        resource: new URL(current.resource),
        fetchFn,
      });
      const now = this.deps.now();
      const nextTokens = refreshedTokens(refreshed, tokens.scope, now);
      return write(
        { ...current, tokens: nextTokens, lastUsedAt: now },
        { kind: 'token', token: nextTokens.access_token },
      );
    } catch (error) {
      return classifyRefreshFailure(current, registration, error, status);
    }
  }
}

/**
 * Another process rotated the token after this request was sent. A first rejection replays with
 * it; a rejected replay gives up without touching the newer credentials.
 */
function rotatedElsewhere(tokens: StoredTokens, input: McpChallengeInput): LockedStep {
  if (!input.replayed) return keep({ kind: 'token', token: tokens.access_token });
  const reason = input.status === 403 ? 'insufficient_scope' : 'reauth_required';
  return keep({ kind: 'auth', error: new McpAuthRequiredError(reason, input.challenge) });
}

/** proper-lockfile gave up waiting for a lock another request holds. */
function isLockBusy(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ELOCKED';
}

/** Plan §5.4 refresh error classification. */
function classifyRefreshFailure(
  current: McpCredentialRecord,
  registration: StoredRegistration,
  error: unknown,
  status: number | undefined,
): LockedStep {
  const code = oauthErrorCodeOf(error);
  if (code === 'invalid_grant') return reauth(current, 'invalid_grant', undefined, error);
  if (isClientRejection(code)) {
    if (registration.method === 'pre') {
      return write(
        withState(current, {
          authState: 'failed',
          reason: 'invalid_client',
          lastErrorCode: 'MCP_OAUTH_CLIENT_REJECTED',
        }),
        authFailure(undefined, error),
      );
    }
    // DCR / CIMD registrations are discarded so the next authorization registers again.
    const next = withState(current, { authState: 'needs_reauth', reason: 'invalid_client' });
    delete next.registration;
    return write(next, authFailure(undefined, error));
  }
  const transient =
    code === undefined ||
    TRANSIENT_OAUTH_CODES[code] === true ||
    (status !== undefined && status >= 500);
  if (transient) {
    return keep({
      kind: 'transient',
      error: new McpOAuthRefreshUnavailableError({ cause: error }),
    });
  }
  return reauth(current, code, undefined, error);
}

/** RFC 6749 client authentication / authorization rejection. */
export function isClientRejection(code: string | undefined): boolean {
  return code === 'invalid_client' || code === 'unauthorized_client';
}

function refreshedTokens(
  refreshed: OAuthTokens,
  previousScope: string | undefined,
  now: number,
): StoredTokens {
  const scope = refreshed.scope ?? previousScope;
  return {
    access_token: refreshed.access_token,
    ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
    ...(refreshed.expires_in !== undefined
      ? { expires_at: now + refreshed.expires_in * 1000 }
      : {}),
    ...(scope ? { scope } : {}),
    tokenSource: 'refresh',
    tokenIssuedAt: now,
  };
}

/** 403 insufficient_scope: keep the token (valid for granted scopes) and record the step-up. */
function insufficientScope(
  current: McpCredentialRecord,
  tokens: StoredTokens,
  input: McpChallengeInput,
): LockedStep {
  const challengeScope = input.challenge.scope;
  const granted = new Set((tokens.scope ?? current.requestedScope ?? '').split(/\s+/));
  const missingScopes = (challengeScope ?? '')
    .split(/\s+/)
    .filter((scope) => scope && !granted.has(scope));
  return write(
    {
      ...current,
      state: {
        authState: 'needs_reauth',
        reason: 'insufficient_scope',
        ...(challengeScope ? { challengeScope } : {}),
        ...(missingScopes.length > 0 ? { missingScopes } : {}),
      },
    },
    { kind: 'auth', error: new McpAuthRequiredError('insufficient_scope', input.challenge) },
  );
}

function reauth(
  current: McpCredentialRecord,
  reason: string,
  challenge?: McpAuthChallenge,
  cause?: unknown,
): LockedStep {
  return write(
    withState(current, { authState: 'needs_reauth', reason }),
    authFailure(challenge, cause),
  );
}

function authFailure(challenge: McpAuthChallenge | undefined, cause: unknown): LockedOutcome {
  return {
    kind: 'auth',
    error: new McpAuthRequiredError(
      'reauth_required',
      challenge,
      cause === undefined ? undefined : { cause },
    ),
  };
}

function keep(result: LockedOutcome): LockedStep {
  return { mutation: { kind: 'keep' }, result };
}

function write(record: McpCredentialRecord, result: LockedOutcome): LockedStep {
  return { mutation: { kind: 'write', record }, result };
}

/** Rejected credentials: drop the tokens and record why. */
function withState(record: McpCredentialRecord, state: StoredAuthState): McpCredentialRecord {
  const next: McpCredentialRecord = { ...record, state };
  delete next.tokens;
  return next;
}

/** OAuth error code from SDK `OAuthError` subclasses (`errorCode` getter), matched structurally. */
export function oauthErrorCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('errorCode' in error)) return undefined;
  const code = error.errorCode;
  return typeof code === 'string' && /^[\w.-]{1,64}$/.test(code) ? code : undefined;
}
