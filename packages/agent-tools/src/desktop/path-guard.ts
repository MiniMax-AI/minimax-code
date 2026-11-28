/**
 * Workspace path boundary (desktop local version). Local tools must pass this check before fs
 * access to prevent the LLM escaping the working directory with `..`, absolute paths, or symlinks.
 *
 * NOTE(shared-logic): Equivalent to `../cloud/path-guard.ts`. Each side currently keeps a copy to
 * preserve local / cloud tool directory isolation (AGENTS.md §1). This is a prime candidate for
 * future shared-logic extraction.
 */

import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

async function assertWithinWorkspace(absolutePath: string, workspaceRoot: string): Promise<void> {
  const rootReal = await realpath(workspaceRoot);

  let candidate = resolve(absolutePath);
  const suffixParts: string[] = [];
  while (true) {
    let ancestorReal: string;
    try {
      ancestorReal = await realpath(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new Error(`Workspace path escapes local runtime root: ${absolutePath}`);
      }
      suffixParts.unshift(basename(candidate));
      candidate = parent;
      continue;
    }

    const finalPath =
      suffixParts.length === 0 ? ancestorReal : resolve(ancestorReal, ...suffixParts);
    const rel = relative(rootReal, finalPath);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Workspace path escapes local runtime root: ${absolutePath}`);
    }
    return;
  }
}

/**
 * Resolve a user-supplied, possibly relative path to an absolute path within the workspace
 * boundary. Return the `path.resolve` result for direct fs use.
 */
export async function resolveWithinWorkspace(
  inputPath: string,
  workspaceRoot: string,
): Promise<string> {
  const abs = isAbsolute(inputPath) ? inputPath : resolve(workspaceRoot, inputPath);
  await assertWithinWorkspace(abs, workspaceRoot);
  return abs;
}
