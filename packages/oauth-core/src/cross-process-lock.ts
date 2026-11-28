import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import lockfile from 'proper-lockfile';

import { prepareAuthDirectory } from './fs/owned-directory.js';
import { CredentialStorePermissionError } from './credential-store/types.js';
import { toPosixPermissionError } from './fs/permission-error.js';
import { dirname } from 'node:path';

export interface CrossProcessAuthLockOptions {
  root?: string;
  staleMs?: number;
  retries?: number;
}

export class CrossProcessAuthLock {
  private readonly root?: string;
  private readonly staleMs: number;
  private readonly retries: number;

  constructor(
    private readonly lockPath: string,
    options: CrossProcessAuthLockOptions = {},
  ) {
    this.root = options.root;
    this.staleMs = options.staleMs ?? 30_000;
    this.retries = options.retries ?? 120;
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    // The lock directory is the auth home or a namespace under it. Report a denied
    // mkdir or chmod as a credential permission problem, so Desktop explains it and
    // offers Reset sign-in instead of a generic sign-in error.
    await prepareAuthDirectory(dirname(this.lockPath), { root: this.root, create: true }).catch(
      (error: unknown) => {
        throw toPosixPermissionError(error);
      },
    );
    const flags =
      process.platform === 'win32'
        ? 'a'
        : constants.O_APPEND |
          constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK;
    const handle = await open(this.lockPath, flags, 0o600).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP')
        throw new CredentialStorePermissionError({ cause: error });
      throw toPosixPermissionError(error);
    });
    await handle.close();
    let compromise: Error | undefined;
    const release = await lockfile.lock(this.lockPath, {
      realpath: false,
      stale: this.staleMs,
      retries: {
        retries: this.retries,
        factor: 1.15,
        minTimeout: 5,
        maxTimeout: 250,
      },
      onCompromised: (error) => {
        compromise ??= error;
      },
    });
    try {
      return await operation();
    } finally {
      try {
        await release();
      } catch (error) {
        if (!compromise) throw error;
      }
      if (compromise) throw compromise;
    }
  }
}
