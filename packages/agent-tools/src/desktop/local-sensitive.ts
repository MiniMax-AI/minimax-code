import { realpath } from '../shared/physical-fs.js';

import { isSensitivePath, LOCAL_SENSITIVE_GLOB_EXCLUDES } from '@mavis/shared/sensitive-paths';

export function sensitiveExcludeArgs(): string[] {
  return LOCAL_SENSITIVE_GLOB_EXCLUDES.map((pattern) => `--iglob=${pattern}`);
}

export function isSensitiveSearchPath(path: string): boolean {
  return isSensitivePath(path);
}

export async function isSensitiveSearchRoot(
  path: string,
  realpathFn: (path: string) => Promise<string> = realpath,
): Promise<boolean> {
  if (isSensitiveSearchPath(path)) return true;
  try {
    return isSensitiveSearchPath(await realpathFn(path));
  } catch {
    return false;
  }
}
