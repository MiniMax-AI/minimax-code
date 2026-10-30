import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type PathApi = Pick<typeof path, 'basename' | 'dirname' | 'join' | 'relative'>;

/** Resolves the Worker beside this module, preferring Electron's unpacked ASAR path. */
export function ptcWorkerUrl(moduleUrl: string = import.meta.url): URL {
  return pathToFileURL(resolvePtcWorkerPath(fileURLToPath(moduleUrl)));
}

/** @internal Exported for focused tests. */
export function resolvePtcWorkerPath(modulePath: string, pathApi: PathApi = path): string {
  const workerPath = pathApi.join(pathApi.dirname(modulePath), 'quickjs-worker.js');
  let directory = pathApi.dirname(modulePath);
  while (pathApi.dirname(directory) !== directory) {
    if (pathApi.basename(directory) === 'app.asar') {
      return pathApi.join(`${directory}.unpacked`, pathApi.relative(directory, workerPath));
    }
    directory = pathApi.dirname(directory);
  }
  return workerPath;
}
