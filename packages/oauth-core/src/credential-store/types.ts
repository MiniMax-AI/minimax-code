import { MCODE_OAUTH_AUDIENCE, MCODE_OAUTH_CLIENT_ID, MCODE_OAUTH_SCOPES } from '../contracts.js';

export type CredentialStoreKind = 'file';
export type LegacyCredentialStoreKind = 'os-keyring';
export type PersistedCredentialStoreKind = CredentialStoreKind | LegacyCredentialStoreKind;

export const CREDENTIAL_SCHEMA_VERSION = 1 as const;
export const CREDENTIAL_MIN_SUPPORTED_SCHEMA_VERSION = 1 as const;

export interface CredentialKey {
  service: string;
  account: string;
}

export interface StoredCredential {
  schemaVersion: typeof CREDENTIAL_SCHEMA_VERSION | typeof CREDENTIAL_MIN_SUPPORTED_SCHEMA_VERSION;
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  clientId: typeof MCODE_OAUTH_CLIENT_ID;
  scopes: string[];
  audience: typeof MCODE_OAUTH_AUDIENCE;
  expiresAtMs: number;
  generation: number;
  subject?: string;
  accountId?: string;
  loginEpoch?: string;
}

export interface CredentialStore {
  readonly kind: CredentialStoreKind;
  get(key: CredentialKey): Promise<StoredCredential | null>;
  put(key: CredentialKey, credential: StoredCredential): Promise<void>;
  delete(key: CredentialKey): Promise<void>;
  healthCheck(): Promise<void>;
  /** Removes every stored record without reading them, so it works on unreadable or corrupt stores. */
  clear(): Promise<void>;
}

export class CredentialRecordCorruptError extends Error {
  readonly code = 'CREDENTIAL_RECORD_CORRUPT';

  constructor() {
    super('The stored OAuth credential record is invalid.');
    this.name = 'CredentialRecordCorruptError';
  }
}

export class CredentialStorePermissionError extends Error {
  readonly code = 'AUTH_CREDENTIAL_STORE_PERMISSION';

  constructor(options?: ErrorOptions) {
    super('The OAuth credential file permissions are not private.', options);
    this.name = 'CredentialStorePermissionError';
  }
}

/** Local store failures that signing in again cannot fix until the stored records are cleared. */
export function requiresLocalCredentialReset(error: unknown): boolean {
  return (
    error instanceof CredentialStorePermissionError || error instanceof CredentialRecordCorruptError
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export function parseStoredCredential(value: unknown): StoredCredential {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CredentialRecordCorruptError();
  }
  const candidate = value as Record<string, unknown>;
  const scopes = candidate.scopes;
  const validScopes = Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string');
  const valid =
    typeof candidate.schemaVersion === 'number' &&
    Number.isInteger(candidate.schemaVersion) &&
    candidate.schemaVersion >= CREDENTIAL_MIN_SUPPORTED_SCHEMA_VERSION &&
    candidate.schemaVersion <= CREDENTIAL_SCHEMA_VERSION &&
    typeof candidate.accessToken === 'string' &&
    candidate.accessToken.length > 0 &&
    typeof candidate.refreshToken === 'string' &&
    candidate.refreshToken.length > 0 &&
    candidate.tokenType === 'Bearer' &&
    candidate.clientId === MCODE_OAUTH_CLIENT_ID &&
    validScopes &&
    candidate.audience === MCODE_OAUTH_AUDIENCE &&
    typeof candidate.expiresAtMs === 'number' &&
    Number.isFinite(candidate.expiresAtMs) &&
    Number.isSafeInteger(candidate.generation) &&
    (candidate.generation as number) >= 0 &&
    isOptionalString(candidate.subject) &&
    isOptionalString(candidate.accountId) &&
    isOptionalString(candidate.loginEpoch);

  if (!valid) throw new CredentialRecordCorruptError();
  return candidate as unknown as StoredCredential;
}
