import { mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { SandboxSessionTempManager, isNodeError } from './invocation-context.js';

/**
 * The file access the PTC session store needs. Declared here rather than
 * imported from the store so this service does not depend on Turn System (the
 * store's own `PtcStoreFilePort` has exactly these members; the two are
 * checked against each other where
 * `service/turn-system/lifecycle/ptc-session-store-composition.ts` passes a
 * `createPtcStoreTempFiles()` port into `new PtcSessionStore({ files })`).
 */
interface PtcStoreFiles {
  ensureDirectory(sessionId: string): Promise<void>;
  /** Writes every byte of `chunk` at the end of the file, or throws. */
  append(sessionId: string, chunk: Uint8Array): Promise<void>;
  /** Bytes the file currently holds; 0 when it does not exist. */
  size(sessionId: string): Promise<number>;
  read(sessionId: string, offset: number, length: number): Promise<string>;
  /**
   * Cuts the file back to `length`, discarding a failed or abandoned append. A
   * file that was never created already holds 0 bytes, so cutting it back to 0
   * succeeds without one.
   */
  truncate(sessionId: string, length: number): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
}

/** The store lives in its own directory so removing it never touches sandbox files. */
const STORE_DIRECTORY = 'ptc-var';
const STORE_FILE = 'store.jsonl';

export interface PtcStoreTempFilesOptions {
  /** Shared with the sandbox when one is running; otherwise this port owns it. */
  readonly tempManager?: SandboxSessionTempManager;
  readonly totalRoot?: string;
}

export interface PtcStoreTempFiles extends PtcStoreFiles {
  /** Removes this runtime instance's whole temp tree. */
  close(): Promise<void>;
}

/**
 * The PTC session store's file access, over the same per-Session temp
 * directory the sandbox uses.
 *
 * The sandbox only initializes its temp manager when the sandbox itself is
 * enabled, and most Sessions run with it off, so this port owns an instance of
 * its own and initializes it on first use. That keeps one layout
 * (`$TMPDIR/mcode-sandbox/runtime-<instance>/session-<hmac>/ptc-var/store.jsonl`),
 * one permission set (0700 directories, 0600 file) and one cleanup rule: the
 * instance directory is removed when the runtime closes. A directory left by a
 * crash is not swept at startup: the manager scans the shared root for orphans
 * while it initializes, and this port only initializes on first use, so the
 * leftover goes away the next time any runtime initializes a temp directory
 * under that root, and only once its owner process has exited and it is more
 * than 24 hours old. A runtime that never initializes one again leaves it
 * behind.
 */
export function createPtcStoreTempFiles(options: PtcStoreTempFilesOptions = {}): PtcStoreTempFiles {
  const manager =
    options.tempManager ??
    new SandboxSessionTempManager(
      options.totalRoot === undefined ? {} : { totalRoot: options.totalRoot },
    );
  let initializing: Promise<void> | undefined;
  /**
   * True once the instance directory really exists. Cleanup paths read it
   * instead of initializing: a Session that never used the store has no
   * directory, and asking the manager for one would create it.
   */
  let initialized = false;
  const initialize = async (): Promise<void> => {
    const attempt = (initializing ??= manager.initialize());
    try {
      await attempt;
      initialized = true;
    } catch (error) {
      // A failed attempt is not remembered: the next call initializes again, so
      // one transient failure does not disable the store for the whole runtime.
      if (initializing === attempt) initializing = undefined;
      throw error;
    }
  };
  const directory = async (sessionId: string): Promise<string> => {
    await initialize();
    return join(await manager.sessionDir(sessionId), STORE_DIRECTORY);
  };
  const file = async (sessionId: string): Promise<string> =>
    join(await directory(sessionId), STORE_FILE);
  return {
    async ensureDirectory(sessionId) {
      await mkdir(await directory(sessionId), { recursive: true, mode: 0o700 });
    },
    async append(sessionId, chunk) {
      const handle = await open(await file(sessionId), 'a', 0o600);
      try {
        // A single write may stop short; the store's byte offsets are only
        // correct if every byte of the chunk reached the file.
        let written = 0;
        while (written < chunk.byteLength) {
          const result = await handle.write(chunk, written, chunk.byteLength - written);
          if (result.bytesWritten <= 0) {
            throw new Error(`PTC store append made no progress at ${written} bytes.`);
          }
          written += result.bytesWritten;
        }
      } finally {
        // A failing close still leaves the bytes on disk, so the caller rolls
        // the file back rather than assuming nothing was written.
        await handle.close();
      }
    },
    async size(sessionId) {
      try {
        const { size } = await stat(await file(sessionId));
        return size;
      } catch (error) {
        // A file that was never created, or one a temp-directory cleaner
        // removed, holds no bytes; the store treats both as an empty file and
        // continues from 0. Every other failure is a real read error.
        if (isNodeError(error, 'ENOENT')) return 0;
        throw error;
      }
    },
    async truncate(sessionId, length) {
      let handle: FileHandle;
      try {
        handle = await open(await file(sessionId), 'r+', 0o600);
      } catch (error) {
        // The append being rolled back failed before the file was created (a
        // Session's very first commit can fail at `open`), so there is nothing
        // to cut: a file that does not exist already holds 0 bytes, which is
        // exactly the length the rollback wants. Every other failure still
        // reaches the store, which then refuses the whole Session rather than
        // guessing what its offsets mean.
        if (length === 0 && isNodeError(error, 'ENOENT')) return;
        throw error;
      }
      try {
        await handle.truncate(length);
      } finally {
        await handle.close();
      }
    },
    async read(sessionId, offset, length) {
      const handle = await open(await file(sessionId), 'r');
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead !== length) {
          // A short read is truncated JSON the caller cannot tell from a real
          // value, so it fails the read instead of handing it back.
          throw new Error(
            `PTC store read ${bytesRead} of ${length} bytes at offset ${offset}.`,
          );
        }
        return buffer.toString('utf8');
      } finally {
        await handle.close();
      }
    },
    async removeSession(sessionId) {
      // Never initialized, so there is nothing on disk to remove and no reason
      // to create a Session directory just to delete it again.
      if (!initialized) return;
      await rm(await directory(sessionId), { recursive: true, force: true });
    },
    async close() {
      // Same rule for the whole tree: an instance directory that was never
      // created has nothing to remove. A failed attempt removes the directory
      // it created itself, so there is nothing left on disk here either.
      if (!initialized) return;
      await manager.close();
    },
  };
}
