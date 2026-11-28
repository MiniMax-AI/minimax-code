/**
 * File-backed MCP OAuth credential store (plan §6.3–§6.4).
 *
 * One private JSON file per credential key under `<dataDir>/mcp-oauth/` (0600 files, 0700
 * directory), written atomically and mutated only under a cross-process `proper-lockfile` lock so
 * Desktop and TUI sharing a dataDir never lose a rotated refresh token.
 */
import { chmod, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { McpRuntimeLogger } from '@mavis/mcp';
import lockfile from 'proper-lockfile';
import { replaceFileAtomically } from '../../../infra/file/jsonl.js';
import type { McpAuthTarget } from './contracts.js';

const RECORD_VERSION = 1;
const CLIENT_SECRETS_FILE = 'client-secrets.json';
/**
 * Waiters poll for ~15s (300 × 50ms). `stale` is a liveness bound, not a hold limit: the holder
 * refreshes the lock mtime every stale/2, so a live holder is never taken over however long it
 * holds the lock.
 * @internal Exported only for focused tests.
 */
export const LOCK_OPTIONS = {
  realpath: false,
  stale: 15_000,
  retries: { retries: 300, factor: 1, minTimeout: 50, maxTimeout: 50 },
} as const;

/**
 * Upper bound for network work done while holding a credential lock (token refresh). It must
 * stay well below the ~15s waiters poll for, so a slow token endpoint makes the holder time out
 * (a transient refresh failure) instead of making every concurrent request fail with ELOCKED.
 */
export const LOCKED_REQUEST_TIMEOUT_MS = 10_000;

type StoredRegistrationMethod = 'pre' | 'cimd' | 'dcr';

export interface StoredRegistration {
  method: StoredRegistrationMethod;
  client_id: string;
  /** Only DCR responses may carry a secret; pre-registered secrets live in client-secrets.json. */
  client_secret?: string;
  token_endpoint_auth_method?: string;
  redirect_uri: string;
  issuer: string;
}

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  tokenSource: 'exchange' | 'refresh';
  tokenIssuedAt: number;
}

export interface StoredAuthState {
  authState: 'needs_reauth' | 'failed';
  reason?: string;
  lastErrorCode?: string;
  /** Scope from the last 403 insufficient_scope challenge (step-up). */
  challengeScope?: string;
  missingScopes?: string[];
}

/** Target without session identity: credentials outlive sessions. */
export type StoredTarget =
  | { kind: 'user'; serverName: string }
  | { kind: 'project'; serverName: string; workspaceRoot: string }
  | Extract<McpAuthTarget, { kind: 'plugin' }>;

export interface McpCredentialRecord {
  version: typeof RECORD_VERSION;
  credentialKey: string;
  namespace: string;
  fingerprint: string;
  target: StoredTarget;
  serverUrl: string;
  resource: string;
  issuer?: string;
  authorizationServerMetadata?: Record<string, unknown>;
  resourceMetadataUrl?: string;
  registration?: StoredRegistration;
  tokens?: StoredTokens;
  requestedScope?: string;
  state?: StoredAuthState;
  revision: number;
  updatedAt: number;
  lastUsedAt: number;
}

/** Fields a mutation may set; bookkeeping (version/revision/updatedAt) is owned by the store. */
type McpCredentialRecordInput = Omit<McpCredentialRecord, 'version' | 'revision' | 'updatedAt'>;

export type RecordMutation =
  | { kind: 'keep' }
  | { kind: 'delete' }
  /** `bumpRevision: false` for bookkeeping (lastUsedAt) other processes need not react to. */
  | { kind: 'write'; record: McpCredentialRecordInput; bumpRevision?: boolean };

export class McpCredentialStore {
  readonly directory: string;

  constructor(
    dataDir: string,
    private readonly now: () => number,
    private readonly logger?: McpRuntimeLogger,
  ) {
    this.directory = path.join(path.resolve(dataDir), 'mcp-oauth');
  }

  async read(credentialKey: string): Promise<McpCredentialRecord | undefined> {
    return this.readFile(this.recordPath(credentialKey));
  }

  /**
   * Runs `mutate` under the per-key cross-process lock with the freshest record. Network calls
   * that must not race other processes (refresh) run inside `mutate`.
   */
  async update<T>(
    credentialKey: string,
    mutate: (
      current: McpCredentialRecord | undefined,
    ) => Promise<{ mutation: RecordMutation; result: T }>,
  ): Promise<{ record: McpCredentialRecord | undefined; result: T }> {
    const filePath = this.recordPath(credentialKey);
    return this.withLock(filePath, async (assertHeld) => {
      const current = await this.readFile(filePath);
      const { mutation, result } = await mutate(current);
      if (mutation.kind === 'keep') return { record: current, result };
      assertHeld();
      if (mutation.kind === 'delete') {
        await rm(filePath, { force: true });
        return { record: undefined, result };
      }
      const record: McpCredentialRecord = {
        ...mutation.record,
        version: RECORD_VERSION,
        credentialKey,
        revision: (current?.revision ?? 0) + (mutation.bumpRevision === false ? 0 : 1),
        updatedAt: this.now(),
      };
      await replaceFileAtomically(filePath, `${JSON.stringify(record, null, 2)}\n`);
      return { record, result };
    });
  }

  async delete(credentialKey: string): Promise<boolean> {
    const { result } = await this.update(credentialKey, async (current) => ({
      mutation: { kind: current ? 'delete' : 'keep' },
      result: current !== undefined,
    }));
    return result;
  }

  async list(): Promise<McpCredentialRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
        .map((name) => this.readFile(path.join(this.directory, name))),
    );
    return records.filter((record): record is McpCredentialRecord => record !== undefined);
  }

  /** Deletes records whose stored namespace equals `namespace` exactly. Returns deleted keys. */
  async deleteNamespace(namespace: string): Promise<string[]> {
    return this.deleteWhere((record) => record.namespace === namespace);
  }

  /** Deletes records not used for `maxAgeMs` (no revocation). */
  async reapUnused(maxAgeMs: number): Promise<string[]> {
    const cutoff = this.now() - maxAgeMs;
    return this.deleteWhere((record) => record.lastUsedAt < cutoff);
  }

  async deleteWhere(predicate: (record: McpCredentialRecord) => boolean): Promise<string[]> {
    const deleted: string[] = [];
    for (const record of await this.list()) {
      if (!predicate(record)) continue;
      const { result } = await this.update(record.credentialKey, async (current) => {
        const matches = current !== undefined && predicate(current);
        return { mutation: { kind: matches ? 'delete' : 'keep' }, result: matches };
      });
      if (result) deleted.push(record.credentialKey);
    }
    return deleted;
  }

  async getClientSecret(serverName: string): Promise<string | undefined> {
    const secrets = await this.readSecrets();
    return Object.hasOwn(secrets, serverName) ? secrets[serverName] : undefined;
  }

  async setClientSecret(serverName: string, secret: string | undefined): Promise<void> {
    const filePath = path.join(this.directory, CLIENT_SECRETS_FILE);
    await this.withLock(filePath, async (assertHeld) => {
      const secrets = await this.readSecrets();
      if (secret) secrets[serverName] = secret;
      else delete secrets[serverName];
      assertHeld();
      await replaceFileAtomically(filePath, `${JSON.stringify({ secrets }, null, 2)}\n`);
    });
  }

  private async readSecrets(): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(
        await readFile(path.join(this.directory, CLIENT_SECRETS_FILE), 'utf8'),
      ) as { secrets?: unknown };
      const entries =
        parsed.secrets && typeof parsed.secrets === 'object' ? Object.entries(parsed.secrets) : [];
      const secrets: Record<string, string> = Object.create(null);
      for (const [name, value] of entries) if (typeof value === 'string') secrets[name] = value;
      return secrets;
    } catch (error) {
      if (isMissing(error)) return Object.create(null) as Record<string, string>;
      throw error;
    }
  }

  private recordPath(credentialKey: string): string {
    if (!/^[0-9a-f]{64}$/.test(credentialKey)) throw new Error('Invalid MCP credential key');
    return path.join(this.directory, `${credentialKey}.json`);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(this.directory, 0o700);
  }

  /**
   * `assertHeld` throws once proper-lockfile reports the lock compromised (e.g. its mtime refresh
   * failed and another process may own it), so no write happens without the lock.
   */
  private async withLock<T>(
    filePath: string,
    operation: (assertHeld: () => void) => Promise<T>,
  ): Promise<T> {
    await this.ensureDirectory();
    let compromised: Error | undefined;
    const release = await lockfile.lock(filePath, {
      ...LOCK_OPTIONS,
      lockfilePath: `${filePath}.lock`,
      // The default handler throws from a timer and would crash the process.
      onCompromised: (error) => {
        compromised = error;
        this.logger?.warn('MCP OAuth credential lock compromised', { code: errorCode(error) });
      },
    });
    try {
      return await operation(() => {
        if (compromised)
          throw new Error('MCP OAuth credential lock was lost', { cause: compromised });
      });
    } finally {
      try {
        await release();
      } catch {
        // A failed unlock must not mask the committed outcome; the lock goes stale.
      }
    }
  }

  private async readFile(filePath: string): Promise<McpCredentialRecord | undefined> {
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as Partial<McpCredentialRecord>;
      return parsed.version === RECORD_VERSION && typeof parsed.credentialKey === 'string'
        ? (parsed as McpCredentialRecord)
        : undefined;
    } catch {
      // A torn or foreign file is treated as absent; the next commit replaces it atomically.
      return undefined;
    }
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
