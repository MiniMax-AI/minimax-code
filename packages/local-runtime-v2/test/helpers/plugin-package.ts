import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Writes a plugin package tree from a `relative/path -> content` map, creating
 * the intermediate directories. Keys always use forward slashes so a fixture
 * reads the same on every platform.
 */
export async function writePluginTree(
  root: string,
  files: Readonly<Record<string, string | Buffer>>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, ...relativePath.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}
