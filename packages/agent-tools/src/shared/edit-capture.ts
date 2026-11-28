import type { CoreToolFs } from '../core-tools/ports.js';
import { physicalToolFs } from './physical-fs.js';

import type { EditOperations } from '@earendil-works/pi-coding-agent';

export interface EditCapture {
  readonly path: string;
  readonly originalFile: string;
}

/**
 * Optional hooks for hosts that guard overwrites. All run inside Pi's
 * mutation-queue slot; only `beforeWrite` may throw.
 */
export interface EditReadTracking {
  /** Before Pi reads the file: whether the session's record matches it. */
  isRecordCurrent(absolutePath: string): Promise<boolean>;
  /** Before any byte is written. Throw to refuse. */
  beforeWrite?(absolutePath: string): void;
  /** After the edit is on disk: record the new version for the session. */
  refresh(absolutePath: string): Promise<void>;
}

type EditCaptureFs = Pick<CoreToolFs, 'access' | 'readFile' | 'realpath' | 'writeFile'>;

type EditCaptureOptions =
  | (EditCaptureFs & { tracking?: EditReadTracking })
  | { tracking?: EditReadTracking };

/**
 * Captures the exact pre-edit file inside Pi's mutation-queue critical section.
 * The helper is created per execute, so concurrent agents cannot exchange
 * captures even when they edit the same path.
 *
 * With `tracking`, a session's record is refreshed after the edit only if it
 * matched the file before Pi read it; otherwise the record stays stale (or
 * absent) and a later overwrite asks for a fresh read. Edit itself never
 * requires a read.
 *
 * Core tools pass their host fs port, on which the desktop host also carries
 * `tracking`; without a port the physical filesystem is used.
 */
export function createCapturingEditOperations(options: EditCaptureOptions = {}): {
  readonly operations: EditOperations;
  takeCapture(absoluteHint: string): EditCapture | undefined;
} {
  const { tracking } = options;
  const fs = 'writeFile' in options ? options : physicalToolFs;
  const pendingReads = new Map<string, Buffer>();
  const recordCurrent = new Map<string, boolean>();
  const captures = new Map<string, EditCapture>();
  const operations: EditOperations = {
    realpath: (path) => fs.realpath(path),
    access: (path) => fs.access(path),
    async readFile(path) {
      if (tracking) recordCurrent.set(path, await tracking.isRecordCurrent(path));
      const buffer = await fs.readFile(path);
      pendingReads.set(path, buffer);
      return buffer;
    },
    async writeFile(path, content) {
      tracking?.beforeWrite?.(path);
      await fs.writeFile(path, content);
      if (tracking && recordCurrent.get(path) === true) await tracking.refresh(path);
      const original = pendingReads.get(path);
      if (original) {
        const decoded = original.toString('utf8');
        captures.set(path, {
          path,
          originalFile: decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded,
        });
      }
    },
  };
  return {
    operations,
    takeCapture(absoluteHint) {
      const exact = captures.get(absoluteHint);
      if (exact) return exact;
      if (captures.size !== 1) return undefined;
      return captures.values().next().value as EditCapture | undefined;
    },
  };
}
