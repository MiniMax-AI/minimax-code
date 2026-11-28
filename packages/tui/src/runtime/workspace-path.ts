/** Drive-letter (`D:\x`, `D:/x`, `D:`) or UNC (`\\server\share`) path. */
const WINDOWS_PATH = /^(?:[A-Za-z]:(?:[\\/]|$)|\\\\|\/\/)/u;

/**
 * Comparison key for a Session workspace path.
 *
 * On Windows the same folder reaches the Runtime as `D:\project` or `D:/project`
 * depending on which client created the Session, and those paths are
 * case-insensitive. Every Session list that scopes by workspace must compare
 * through this key so both spellings land in the same workspace.
 *
 * POSIX paths keep their backslashes: `/work/a\b` and `/work/a/b` are different
 * directories on Linux and macOS.
 */
export function workspacePathKey(value: string | undefined): string {
  const path = value ?? '';
  if (!WINDOWS_PATH.test(path)) {
    const key = path.replace(/\/+$/u, '');
    // The POSIX root must not collapse into the empty key of a Session without a workspace.
    return key === '' && path !== '' ? '/' : key;
  }
  return path.replaceAll('\\', '/').replace(/\/+$/u, '').toLocaleLowerCase();
}

export function isSameWorkspacePath(left: string | undefined, right: string | undefined): boolean {
  return workspacePathKey(left) === workspacePathKey(right);
}
