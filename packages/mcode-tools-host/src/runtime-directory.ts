import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

export async function createPrivateBrokerInstance(parent: string, prefix: string): Promise<string> {
  await ensurePrivateBrokerDirectory(parent);
  const directory = await mkdtemp(path.join(parent, prefix));
  try {
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function ensurePrivateBrokerDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    (process.platform !== 'win32' && (uid === undefined || metadata.uid !== uid))
  ) {
    throw new Error(
      `Broker directory must be a real directory owned by the current user: ${directory}`,
    );
  }
  if (process.platform !== 'win32') {
    await chmod(directory, 0o700);
    if (((await lstat(directory)).mode & 0o7777) !== 0o700) {
      throw new Error(`Broker directory requires effective 0700 permissions: ${directory}`);
    }
  }
}
