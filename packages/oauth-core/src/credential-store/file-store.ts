import { constants, type Stats } from 'node:fs';
import { type FileHandle, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWritePrivateFile } from '../fs/atomic-write.js';
import { prepareAuthDirectory } from '../fs/owned-directory.js';
import { toPosixPermissionError } from '../fs/permission-error.js';
import {
  type CredentialKey,
  CredentialRecordCorruptError,
  type CredentialStore,
  CredentialStorePermissionError,
  parseStoredCredential,
  type StoredCredential,
} from './types.js';

const FILE_SCHEMA_VERSION = 1;
const PRIVATE_FILE_MODE = 0o600;
/** Reading needs owner read only: writes replace auth.json by rename and clear() unlinks it. */
const REQUIRED_FILE_ACCESS = 0o400;
const GROUP_OR_OTHER_WRITE = 0o022;
/** Never follows a link; O_NONBLOCK keeps a FIFO from blocking the open. */
const OPEN_PRIVATE_FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

interface CredentialFilePayload {
  schemaVersion: 1;
  records: Record<string, StoredCredential>;
}

export interface FileStoreOptions {
  root?: string;
  authHome: string;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function recordKey(key: CredentialKey): string {
  return `${key.service}\0${key.account}`;
}

function parsePayload(value: unknown): CredentialFilePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CredentialRecordCorruptError();
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.schemaVersion !== FILE_SCHEMA_VERSION ||
    typeof payload.records !== 'object' ||
    payload.records === null ||
    Array.isArray(payload.records)
  ) {
    throw new CredentialRecordCorruptError();
  }
  const records = Object.fromEntries(
    Object.entries(payload.records).map(([key, credential]) => [
      key,
      parseStoredCredential(credential),
    ]),
  );
  return { schemaVersion: FILE_SCHEMA_VERSION, records };
}

/** No group/other access, and the owner keeps the access the store needs. */
function isPrivateMode(actual: number, required: number): boolean {
  return (actual & 0o077) === 0 && (actual & required) === required;
}

/**
 * Restores owner-only modes changed by other tools (for example a recursive chmod)
 * instead of locking the user out. Callers check ownership first. Modes that cannot
 * be changed fail closed with CredentialStorePermissionError so the user resets the
 * local sign-in.
 */
async function ensurePrivateMode(
  current: Stats,
  target: FileHandle,
  modes: { required: number; repaired: number },
): Promise<void> {
  if (isPrivateMode(current.mode, modes.required)) return;
  try {
    await target.chmod(modes.repaired);
  } catch (error) {
    throw new CredentialStorePermissionError({ cause: error });
  }
  // Some file systems or ACLs accept chmod without applying it.
  if (!isPrivateMode((await target.stat()).mode, modes.required)) {
    throw new CredentialStorePermissionError();
  }
}

export class FileStore implements CredentialStore {
  readonly kind = 'file' as const;

  private readonly authHome: string;
  private readonly path: string;
  private readonly root?: string;

  constructor(options: FileStoreOptions) {
    this.authHome = options.authHome;
    this.root = options.root;
    this.path = join(options.authHome, 'auth.json');
  }

  async get(key: CredentialKey): Promise<StoredCredential | null> {
    const payload = await this.readPayload();
    return payload.records[recordKey(key)] ?? null;
  }

  async put(key: CredentialKey, credential: StoredCredential): Promise<void> {
    const payload = await this.readPayload();
    payload.records[recordKey(key)] = parseStoredCredential(credential);
    await this.writePayload(payload);
  }

  async delete(key: CredentialKey): Promise<void> {
    const payload = await this.readPayload();
    delete payload.records[recordKey(key)];
    await this.writePayload(payload);
  }

  async healthCheck(): Promise<void> {
    await prepareAuthDirectory(this.authHome, { root: this.root, create: true });
    if (process.platform !== 'win32') await (await this.openPrivateFile())?.close();
  }

  async clear(): Promise<void> {
    if (!(await prepareAuthDirectory(this.authHome, { root: this.root }))) return;
    try {
      await unlink(this.path);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw toPosixPermissionError(error);
    }
  }

  private async readPayload(): Promise<CredentialFilePayload> {
    let raw: string | null;
    try {
      raw = await this.readPrivateFile();
    } catch (error) {
      throw toPosixPermissionError(error);
    }
    if (raw === null) return { schemaVersion: FILE_SCHEMA_VERSION, records: {} };

    try {
      return parsePayload(JSON.parse(raw));
    } catch (error) {
      if (error instanceof CredentialRecordCorruptError) throw error;
      throw new CredentialRecordCorruptError();
    }
  }

  /** auth.json contents, or null when it does not exist. */
  private async readPrivateFile(): Promise<string | null> {
    if (!(await prepareAuthDirectory(this.authHome, { root: this.root }))) return null;
    if (process.platform === 'win32') {
      try {
        return await readFile(this.path, 'utf8');
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      }
    }
    const handle = await this.openPrivateFile();
    if (!handle) return null;
    try {
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  }

  /**
   * Opens auth.json without following links, then checks, repairs and reads that one
   * handle, so a link swapped in cannot redirect the chmod or the read. Symbolic links
   * and non-regular files fail closed. So does a file that another account owns (an ACL
   * can make a private one readable here) or that group or other users could write: it
   * may hold another account's credential. A reset removes all of these.
   */
  private async openPrivateFile(): Promise<FileHandle | null> {
    let handle: FileHandle;
    try {
      handle = await open(this.path, OPEN_PRIVATE_FILE_FLAGS);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      if (errorCode(error) === 'ELOOP') throw new CredentialStorePermissionError({ cause: error });
      throw toPosixPermissionError(error);
    }
    try {
      const current = await handle.stat();
      if (
        !current.isFile() ||
        current.uid !== process.getuid?.() ||
        (current.mode & GROUP_OR_OTHER_WRITE) !== 0
      ) {
        throw new CredentialStorePermissionError();
      }
      // Other names of the same file would change with it. A concurrent replacement
      // leaves 0 links, which is fine.
      if (current.nlink > 1 && !isPrivateMode(current.mode, REQUIRED_FILE_ACCESS)) {
        throw new CredentialStorePermissionError();
      }
      await ensurePrivateMode(current, handle, {
        required: REQUIRED_FILE_ACCESS,
        repaired: PRIVATE_FILE_MODE,
      });
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw toPosixPermissionError(error);
    }
  }

  private async writePayload(payload: CredentialFilePayload): Promise<void> {
    const validated = parsePayload(payload);
    await atomicWritePrivateFile(this.path, `${JSON.stringify(validated, null, 2)}\n`, this.root);
  }
}
