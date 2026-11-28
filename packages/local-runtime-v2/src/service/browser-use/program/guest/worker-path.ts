import path from 'node:path';

type PathApi = Pick<typeof path, 'basename' | 'dirname' | 'join' | 'relative'>;

const WORKER_FILE = 'browser-program-worker.js';

/**
 * The Browser program Worker beside the module that starts it
 * (program-executor): next to the compiled module, at the TUI bundle root
 * (that module being in `chunks/`), or in Electron's unpacked ASAR copy, where
 * a Worker can load only what electron-builder's `asarUnpack` copied out.
 */
export function resolveBrowserProgramWorkerPath(
  modulePath: string,
  pathApi: PathApi = path,
): string {
  let directory = pathApi.dirname(modulePath);
  if (pathApi.basename(directory) === 'chunks') directory = pathApi.dirname(directory);
  const workerPath = pathApi.join(directory, WORKER_FILE);
  while (pathApi.dirname(directory) !== directory) {
    if (pathApi.basename(directory) === 'app.asar') {
      return pathApi.join(`${directory}.unpacked`, pathApi.relative(directory, workerPath));
    }
    directory = pathApi.dirname(directory);
  }
  return workerPath;
}
