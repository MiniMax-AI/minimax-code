import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

/** Config documents and their copies can contain plaintext credentials. */
export const PRIVATE_CONFIG_FILE_MODE = 0o600;

/** Remove non-owner access without changing an owner's read-only policy. */
export function restrictConfigFileSync(filePath: string): void {
  if (process.platform === 'win32') return;
  const mode = fs.statSync(filePath).mode;
  // Already-private files may live on read-only mounts or be immutable.
  if ((mode & 0o077) === 0) return;
  fs.chmodSync(filePath, mode & 0o700);
}

/** Restrict access before truncating or writing any secret-bearing content. */
export function writePrivateConfigFileSync(
  filePath: string,
  content: string | Buffer,
  exclusive = false,
): void {
  // Windows 的追加句柄不能用于 ftruncate；打开时也不能提前截断，
  // 必须等权限收紧成功后再清空已有内容。
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | (exclusive ? fs.constants.O_EXCL : 0);
  const fd = fs.openSync(filePath, flags, PRIVATE_CONFIG_FILE_MODE);
  try {
    fs.fchmodSync(fd, PRIVATE_CONFIG_FILE_MODE);
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

const TEMPORARY_SUFFIX = '.tmp';

/** A unique sibling of `target` for an atomic replace; see isPrivateTemporaryNameFor. */
export function privateTemporaryPath(target: string): string {
  return `${target}.${process.pid}.${randomUUID()}${TEMPORARY_SUFFIX}`;
}

const TEMPORARY_PART = /^\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/**
 * Whether `name` is exactly a privateTemporaryPath() of the file named
 * `targetName` (pid and UUID). Callers treat such files as the app's own, and
 * data-dir migration may delete them, so a user's look-alike (`….bak.tmp`)
 * must not match.
 */
export function isPrivateTemporaryNameFor(name: string, targetName: string): boolean {
  return name.startsWith(targetName) && TEMPORARY_PART.test(name.slice(targetName.length));
}

/**
 * Replaces `target` atomically with an owner-only file: the content goes to an
 * exclusively created temporary sibling first, so a reader sees either the old
 * or the new file, never a partial one. The temporary file is removed when any
 * step fails, and the error is rethrown. `retry` wraps the rename (Windows
 * reports sharing violations while another process has the target open).
 */
export function writePrivateFileAtomicSync(
  target: string,
  content: string | Buffer,
  retry: (operation: () => void) => void = (operation) => operation(),
): void {
  const temporary = privateTemporaryPath(target);
  try {
    // A brand-new file has nothing to truncate: exclusive creation applies the
    // owner-only mode before any byte is written.
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: PRIVATE_CONFIG_FILE_MODE });
    retry(() => fs.renameSync(temporary, target));
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Not created, or already renamed.
    }
    throw error;
  }
}
