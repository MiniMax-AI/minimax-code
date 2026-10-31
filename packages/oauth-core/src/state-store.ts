import { readFile } from 'node:fs/promises';

import { atomicWritePrivateFile } from './fs/atomic-write.js';
import type { AuthBuildEnv, AuthRegion } from './contracts.js';
import type { PersistedCredentialStoreKind } from './credential-store/types.js';
import type { RefreshOwner } from './refresh-owner.js';

export const AUTH_STATE_SCHEMA_VERSION = 2 as const;
export const AUTH_STATE_MIN_SUPPORTED_SCHEMA_VERSION = 1 as const;

export type AuthStatus =
  | 'anonymous'
  | 'authorizing'
  | 'authenticated'
  | 'refreshing'
  | 'scope_upgrade_required'
  | 'logging_out'
  | 'logout_pending'
  | 'expired'
  | 'error';

export interface AuthState {
  schemaVersion: typeof AUTH_STATE_SCHEMA_VERSION | typeof AUTH_STATE_MIN_SUPPORTED_SCHEMA_VERSION;
  status: AuthStatus;
  storeKind: PersistedCredentialStoreKind;
  clientId: 'mcode-public';
  scopes: string[];
  audience: 'agent-backend';
  buildEnv?: AuthBuildEnv;
  region?: AuthRegion;
  expiresAtMs?: number;
  generation: number;
  /** Non-secret fence: this generation's predecessor must never be refreshed again. */
  refresh?: { id: string; owner?: RefreshOwner };
  authorization?: {
    leaseId: string;
    leaseExpiresAtMs: number;
    userCode?: string;
    verificationUri?: string;
    verificationUriComplete?: string;
  };
}

const SENSITIVE_KEY_PATTERN =
  /access[_-]?token|refresh[_-]?token|device[_-]?code|code[_-]?verifier/iu;

function assertNoSensitiveKeys(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new TypeError('Sensitive OAuth fields cannot be persisted in auth-state.json.');
    }
    assertNoSensitiveKeys(child);
  }
}

function parseState(value: unknown): AuthState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid OAuth state.');
  }
  const state = value as Record<string, unknown>;
  const valid =
    typeof state.schemaVersion === 'number' &&
    Number.isInteger(state.schemaVersion) &&
    state.schemaVersion >= AUTH_STATE_MIN_SUPPORTED_SCHEMA_VERSION &&
    state.schemaVersion <= AUTH_STATE_SCHEMA_VERSION &&
    [
      'anonymous',
      'authorizing',
      'authenticated',
      'refreshing',
      'scope_upgrade_required',
      'logging_out',
      'logout_pending',
      'expired',
      'error',
    ].includes(state.status as string) &&
    ((state.schemaVersion === 1 &&
      (state.storeKind === 'os-keyring' || state.storeKind === 'file')) ||
      (state.schemaVersion === AUTH_STATE_SCHEMA_VERSION && state.storeKind === 'file')) &&
    state.clientId === 'mcode-public' &&
    Array.isArray(state.scopes) &&
    state.scopes.every((scope) => typeof scope === 'string') &&
    state.audience === 'agent-backend' &&
    isOptionalAuthScope(state.buildEnv, state.region) &&
    (state.expiresAtMs === undefined ||
      (typeof state.expiresAtMs === 'number' && Number.isFinite(state.expiresAtMs))) &&
    Number.isSafeInteger(state.generation) &&
    (state.generation as number) >= 0 &&
    (state.authorization === undefined || isAuthorizationLease(state.authorization)) &&
    (state.refresh === undefined || isRefreshTransaction(state.refresh));
  if (!valid) throw new TypeError('Invalid OAuth state.');
  assertNoSensitiveKeys(state);
  return state as unknown as AuthState;
}

function isOptionalAuthScope(buildEnv: unknown, region: unknown): boolean {
  if (buildEnv === undefined && region === undefined) return true;
  return (
    (buildEnv === 'dev' || buildEnv === 'test' || buildEnv === 'staging' || buildEnv === 'prod') &&
    (region === 'cn' || region === 'en')
  );
}

function isRefreshTransaction(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const transaction = value as Record<string, unknown>;
  if (typeof transaction.id !== 'string' || !transaction.id.length) return false;
  if (transaction.owner === undefined) return true;
  if (typeof transaction.owner !== 'object' || transaction.owner === null) return false;
  const owner = transaction.owner as Record<string, unknown>;
  return (
    Number.isSafeInteger(owner.pid) &&
    (owner.pid as number) > 0 &&
    Number.isSafeInteger(owner.startedAtMs) &&
    (owner.startedAtMs as number) > 0
  );
}

function isAuthorizationLease(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const lease = value as Record<string, unknown>;
  return (
    typeof lease.leaseId === 'string' &&
    lease.leaseId.length > 0 &&
    typeof lease.leaseExpiresAtMs === 'number' &&
    Number.isFinite(lease.leaseExpiresAtMs) &&
    isOptionalString(lease.userCode) &&
    isOptionalString(lease.verificationUri) &&
    isOptionalString(lease.verificationUriComplete)
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export class AuthStateStore {
  constructor(private readonly path: string) {}

  async read(): Promise<AuthState | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      return parseState(JSON.parse(raw));
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw new TypeError('Invalid OAuth state.');
    }
  }

  async write(state: AuthState): Promise<void> {
    const validated = parseState(state);
    await atomicWritePrivateFile(this.path, `${JSON.stringify(validated, null, 2)}\n`);
  }
}
