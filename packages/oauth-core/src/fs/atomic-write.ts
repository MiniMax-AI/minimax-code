import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareAuthDirectory } from './owned-directory.js';
import { recordAuthWriteRetry } from '../diagnostics.js';

export async function atomicWritePrivateFile(
  path: string,
  content: string,
  root?: string,
): Promise<void> {
  await prepareAuthDirectory(dirname(path), { root, create: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx', 0o600);

  try {
    try {
      await handle.writeFile(content, { encoding: 'utf8' });
      if (process.platform !== 'win32') await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Windows readers/security scanners may temporarily deny replacement. Retry
    // the same closed, synced file; never unlink/truncate the committed target.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporaryPath, path);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error;
        recordAuthWriteRetry(error, attempt + 1);
        await delay(40 * 2 ** attempt);
      }
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
