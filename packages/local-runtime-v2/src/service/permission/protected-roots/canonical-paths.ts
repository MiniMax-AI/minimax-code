import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolves the deepest existing ancestor, so a link to a protected directory is
 * followed even when the target itself does not exist yet.
 */
export function canonicalPath(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    const parent = path.dirname(target);
    return parent === target ? target : path.join(canonicalPath(parent), path.basename(target));
  }
}

export function isInside(root: string, target: string): boolean {
  // `path.relative` compares Windows paths case-insensitively.
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Whether `root` protects a canonical write target; `root` is canonical too. */
export type Protects = (root: string, canonicalTarget: string) => boolean;
