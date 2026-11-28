import fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { createRequire } from 'node:module';

import type { CoreToolFs } from '../core-tools/ports.js';

/**
 * User file operations must see the physical filesystem, not Electron's ASAR
 * virtual directories. Even an access/stat of `app.asar/file` can cache an
 * archive handle for the life of the process and prevent Windows recycling it.
 *
 * Keep this boundary local to tool I/O: Node module loading and application
 * assets still need Electron's regular fs. Never toggle the process-global
 * noAsar flag around asynchronous work. original-fs is an Electron built-in,
 * not an npm dependency; ordinary Node (TUI/cloud) retains its normal fs.
 */
const physicalFs: typeof fs = process.versions.electron
  ? (createRequire(process.execPath)('original-fs') as typeof fs)
  : fs;
const physicalPromises = process.versions.electron ? physicalFs.promises : fsPromises;

export const { existsSync, statSync } = physicalFs;
export const { access, mkdir, open, readFile, realpath, stat, writeFile } = physicalPromises;

/** The core tool fs port backed by the physical filesystem (desktop and v1 cloud default). */
export const physicalToolFs: CoreToolFs = {
  access,
  open,
  readFile,
  realpath,
  stat,
  writeFile,
  mkdir,
};
