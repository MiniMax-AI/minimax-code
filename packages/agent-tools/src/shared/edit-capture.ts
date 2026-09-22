import { access, readFile, writeFile } from 'node:fs/promises';

import type { EditOperations } from '@earendil-works/pi-coding-agent';

export interface EditCapture {
  readonly path: string;
  readonly originalFile: string;
}

/**
 * Captures the exact pre-edit file inside Pi's mutation-queue critical section.
 * The helper is created per execute, so concurrent agents cannot exchange
 * captures even when they edit the same path.
 */
export function createCapturingEditOperations(): {
  readonly operations: EditOperations;
  takeCapture(absoluteHint: string): EditCapture | undefined;
} {
  const pendingReads = new Map<string, Buffer>();
  const captures = new Map<string, EditCapture>();
  const operations: EditOperations = {
    access,
    async readFile(path) {
      const buffer = await readFile(path);
      pendingReads.set(path, buffer);
      return buffer;
    },
    async writeFile(path, content) {
      await writeFile(path, content, 'utf8');
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
