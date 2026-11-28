import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface AtomicWriteOptions {
  /** Created with, and re-applied against the umask to, this mode. */
  readonly mode?: number;
  /** fsync before the rename. */
  readonly sync?: boolean;
  /** Temp file name prefix in the target's directory; defaults to `.<name>.tmp-`. */
  readonly tempPrefix?: string;
}

/**
 * Writes a temp file next to the target and renames it over the target, so readers see either
 * the old or the new content. The original write error is rethrown; the temp file is removed.
 */
export async function writeFileAtomically(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const prefix = options.tempPrefix ?? `.${basename(filePath)}.tmp-`;
  const tempPath = join(dirname(filePath), `${prefix}${randomBytes(6).toString('hex')}`);
  const temporary = await fs.promises.open(tempPath, 'wx', options.mode);
  try {
    try {
      await temporary.writeFile(content, 'utf8');
      if (options.mode !== undefined) await temporary.chmod(options.mode);
      if (options.sync) await temporary.sync();
    } finally {
      await temporary.close();
    }
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // The original write error wins; removing the temp file is best effort.
    }
    throw error;
  }
}
