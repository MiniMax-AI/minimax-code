import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalizePluginRoot,
  readPluginTextFile,
  type CanonicalPluginRoot,
} from '../filesystem.js';

const PLUGIN_README_PREVIEW_MAX_BYTES = 128 * 1024;
const CHINESE_README_NAMES = ['README.zh-CN.md', 'README.zh-Hans.md', 'README.zh.md', 'README.md'];

export interface PluginReadmePreview {
  readonly markdown: string;
  /** Actual filename relative to the selected package root, never a staging path. */
  readonly relativePath: string;
}

/** Optional documentation of the selected package; unreadable docs never block its import. */
export async function readPluginReadmePreview(
  packageRoot: string,
  readmeLocale?: string,
): Promise<PluginReadmePreview | undefined> {
  try {
    const root = await canonicalizePluginRoot(packageRoot, { rejectSymlink: true });
    const entries = await readdir(root.path, { withFileTypes: true });
    const names = /^zh(?:-|$)/iu.test(readmeLocale ?? '') ? CHINESE_README_NAMES : ['README.md'];
    for (const name of names) {
      const candidates = entries.filter(
        (entry) => entry.isFile() && entry.name.toLowerCase() === name.toLowerCase(),
      );
      if (candidates.length !== 1) continue;
      const candidate = candidates[0];
      if (!candidate) continue;
      const readme = await readReadmeFile(root, candidate.name);
      if (readme) return readme;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function readReadmeFile(
  root: CanonicalPluginRoot,
  relativePath: string,
): Promise<PluginReadmePreview | undefined> {
  try {
    const snapshot = await lstat(path.join(root.path, relativePath));
    if (!snapshot.isFile() || snapshot.nlink !== 1) return undefined;
    const { content } = await readPluginTextFile(root, relativePath, {
      portable: true,
      maxBytes: PLUGIN_README_PREVIEW_MAX_BYTES,
    });
    return content.trim() ? { markdown: content, relativePath } : undefined;
  } catch {
    return undefined;
  }
}
