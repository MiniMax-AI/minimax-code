import path from 'node:path';

import { bashWritesInside } from './bash-write-targets.js';
import { canonicalPath, type Protects } from './canonical-paths.js';

/** The directories a Session's relative write targets resolve from. */
export interface ProtectedRootSession {
  readonly workspaceDir?: string;
  readonly runLocation?: { readonly resolvedDir?: string };
}

export interface ProtectedRootRequest {
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  /** Exact files the turn's execution owner hands the Session to write, such as its Plan document. */
  readonly trustedExactWritePaths?: readonly string[];
}

const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'append']);

/** File write tools and bash are the only tools that write paths directly. */
export function writesPaths(toolName: string): boolean {
  return FILE_WRITE_TOOLS.has(toolName) || toolName === 'bash';
}

/** Whether a file write tool or a bash command writes a target `protects` covers inside `directory`. */
export function writesInside(
  directory: string,
  session: ProtectedRootSession | undefined,
  request: ProtectedRootRequest,
  protects: Protects,
): boolean {
  const isFileWrite = FILE_WRITE_TOOLS.has(request.toolName);
  if (!isFileWrite && request.toolName !== 'bash') return false;
  const bases = [session?.workspaceDir, session?.runLocation?.resolvedDir].filter(
    (base): base is string => Boolean(base),
  );
  const root = canonicalPath(path.resolve(directory));
  return isFileWrite
    ? fileToolWritesInside(root, bases, request, protects)
    : bashWritesInside(root, bases, request.toolInput, protects);
}

/**
 * Every path field a file write tool may carry, resolved from each directory a
 * relative path could be read against, and compared after resolving symlinks.
 */
function fileToolWritesInside(
  root: string,
  bases: readonly string[],
  request: ProtectedRootRequest,
  protects: Protects,
): boolean {
  return ['path', 'file_path', 'filePath'].some((field) => {
    const target = request.toolInput[field];
    if (typeof target !== 'string' || !target) return false;
    const candidates = path.isAbsolute(target)
      ? [target]
      : bases.map((base) => path.resolve(base, target));
    return candidates.some((candidate) => protects(root, canonicalPath(path.resolve(candidate))));
  });
}
