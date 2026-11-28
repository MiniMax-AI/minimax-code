import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { CredentialStorePermissionError } from '../credential-store/types.js';
import { toPosixPermissionError } from './permission-error.js';

interface DirectoryOptions {
  /** First app-managed directory below the caller's trusted dataDir. */
  root?: string;
  create?: boolean;
}

async function inspectDirectory(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw toPosixPermissionError(error);
  }
}

/**
 * Walk top down: each parent is owned and private before resolving its children.
 * The caller-selected dataDir (the parent of root) can itself be a relocated profile.
 * A read or clear of a missing store must not create it.
 */
export async function prepareAuthDirectory(
  directory: string,
  { root = directory, create = false }: DirectoryOptions = {},
): Promise<boolean> {
  let path = resolve(root);
  const suffix = relative(path, resolve(directory));
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new CredentialStorePermissionError();
  }

  for (const part of ['', ...(suffix ? suffix.split(sep) : [])]) {
    path = join(path, part);
    let entry = await inspectDirectory(path);
    if (!entry) {
      if (!create) return false;
      try {
        // Only the configured profile above root may also need to be created.
        await mkdir(path, { recursive: part === '', mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      entry = await lstat(path);
    }
    if (!entry.isDirectory()) throw new CredentialStorePermissionError();
    if (process.platform === 'win32') continue;
    if (entry.uid !== process.getuid?.()) throw new CredentialStorePermissionError();
    if ((entry.mode & 0o777) === 0o700) continue;

    try {
      if ((entry.mode & 0o400) === 0) {
        // An owner can restore a directory without read access. Its parent was
        // already secured above (or is the caller's trusted profile).
        await chmod(path, 0o700);
      } else {
        const handle = await open(
          path,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          const opened = await handle.stat();
          if (opened.uid !== entry.uid || opened.dev !== entry.dev || opened.ino !== entry.ino) {
            throw new CredentialStorePermissionError();
          }
          await handle.chmod(0o700);
        } finally {
          await handle.close();
        }
      }
      const repaired = await lstat(path);
      if (
        !repaired.isDirectory() ||
        repaired.dev !== entry.dev ||
        repaired.ino !== entry.ino ||
        (repaired.mode & 0o777) !== 0o700 ||
        repaired.uid !== entry.uid
      ) {
        throw new CredentialStorePermissionError();
      }
    } catch (error) {
      if (error instanceof CredentialStorePermissionError) throw error;
      throw new CredentialStorePermissionError({ cause: error });
    }
  }
  return true;
}
