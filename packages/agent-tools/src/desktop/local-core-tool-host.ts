import { homedir } from 'node:os';

import type { CoreToolHost } from '../core-tools/ports.js';
import { physicalToolFs } from '../shared/physical-fs.js';
import { runRg } from './local-rg-runner.js';

/** Desktop host of the core tools: the physical filesystem, bundled ripgrep and the OS home. */
export const localCoreToolHost: CoreToolHost = {
  fs: physicalToolFs,
  runRg,
  homedir: () => homedir(),
};
