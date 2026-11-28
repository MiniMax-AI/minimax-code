import { scryptSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { retryWindowsFileSystemOperation } from '@mavis/shared';

import {
  normalizeLocalRuntimeAuthContext,
  type LocalRuntimeAuthContextSnapshot,
} from '@mavis/config';

import type { CliAuthScope } from './types.js';

const CLI_ACCOUNT_IDENTITY_FILE = 'account-identity.json';

interface CliAccountIdentityRecord {
  readonly version: 1;
  readonly region: CliAuthScope['region'];
  readonly buildEnv: CliAuthScope['buildEnv'];
  readonly status: 'verified' | 'rejected';
  readonly tokenFingerprint: string;
  readonly realUserID?: string;
  readonly userEmail?: string;
  readonly userName?: string;
  readonly subUserName?: string;
  readonly updatedAtMs: number;
}

export interface VerifiedCliAccountIdentity {
  readonly realUserID: string;
  readonly userEmail?: string;
  readonly userName?: string;
  readonly subUserName?: string;
  readonly verifiedAtMs: number;
}

export function resolveCliAccountIdentityPath(dataDir: string, scope: CliAuthScope): string {
  return path.join(dataDir, 'cli-auth', scope.buildEnv, scope.region, CLI_ACCOUNT_IDENTITY_FILE);
}

export function readVerifiedCliAccountIdentity(
  dataDir: string,
  scope: CliAuthScope,
  accessToken: string,
): VerifiedCliAccountIdentity | undefined {
  const record = readCliAccountIdentity(dataDir, scope, accessToken);
  const identity = normalizeLocalRuntimeAuthContext(record);
  const realUserID = identity.realUserID;
  if (record?.status !== 'verified' || !realUserID) return undefined;
  return {
    realUserID,
    ...(identity.userEmail ? { userEmail: identity.userEmail } : {}),
    ...(identity.userName ? { userName: identity.userName } : {}),
    ...(identity.subUserName ? { subUserName: identity.subUserName } : {}),
    verifiedAtMs: record.updatedAtMs,
  };
}

export function isCliAccessTokenRejected(
  dataDir: string,
  scope: CliAuthScope,
  accessToken: string,
): boolean {
  return readCliAccountIdentity(dataDir, scope, accessToken)?.status === 'rejected';
}

export function writeVerifiedCliAccountIdentity(
  dataDir: string,
  scope: CliAuthScope,
  accessToken: string,
  identityInput: string | LocalRuntimeAuthContextSnapshot,
  updatedAtMs = Date.now(),
): void {
  const identity = normalizeLocalRuntimeAuthContext(
    typeof identityInput === 'string' ? { realUserID: identityInput } : identityInput,
  );
  if (!identity.realUserID) throw new Error('MiniMax account identity is missing a user ID.');
  writeCliAccountIdentity(dataDir, scope, {
    version: 1,
    ...scope,
    status: 'verified',
    tokenFingerprint: fingerprintAccessToken(accessToken),
    realUserID: identity.realUserID,
    ...(identity.userEmail ? { userEmail: identity.userEmail } : {}),
    ...(identity.userName ? { userName: identity.userName } : {}),
    ...(identity.subUserName ? { subUserName: identity.subUserName } : {}),
    updatedAtMs,
  });
}

export function writeRejectedCliAccountIdentity(
  dataDir: string,
  scope: CliAuthScope,
  accessToken: string,
  updatedAtMs = Date.now(),
): void {
  writeCliAccountIdentity(dataDir, scope, {
    version: 1,
    ...scope,
    status: 'rejected',
    tokenFingerprint: fingerprintAccessToken(accessToken),
    updatedAtMs,
  });
}

export function clearCliAccountIdentity(dataDir: string, scope: CliAuthScope): void {
  fs.rmSync(resolveCliAccountIdentityPath(dataDir, scope), { force: true });
}

function readCliAccountIdentity(
  dataDir: string,
  scope: CliAuthScope,
  accessToken: string,
): CliAccountIdentityRecord | undefined {
  const normalizedToken = accessToken.trim();
  if (!normalizedToken) return undefined;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(resolveCliAccountIdentityPath(dataDir, scope), 'utf8'),
    ) as Partial<CliAccountIdentityRecord>;
    if (
      parsed.version !== 1 ||
      parsed.region !== scope.region ||
      parsed.buildEnv !== scope.buildEnv ||
      (parsed.status !== 'verified' && parsed.status !== 'rejected') ||
      parsed.tokenFingerprint !== fingerprintAccessToken(normalizedToken) ||
      typeof parsed.updatedAtMs !== 'number'
    ) {
      return undefined;
    }
    return parsed as CliAccountIdentityRecord;
  } catch {
    return undefined;
  }
}

function writeCliAccountIdentity(
  dataDir: string,
  scope: CliAuthScope,
  record: CliAccountIdentityRecord,
): void {
  const filePath = resolveCliAccountIdentityPath(dataDir, scope);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  retryWindowsFileSystemOperation(() => fs.renameSync(temporaryPath, filePath));
  retryWindowsFileSystemOperation(() => fs.chmodSync(filePath, 0o600));
}

function fingerprintAccessToken(accessToken: string): string {
  return `scrypt:${scryptSync(accessToken.trim(), 'mcode-cli-account-identity-v1', 16, { N: 1024 }).toString('hex')}`;
}
