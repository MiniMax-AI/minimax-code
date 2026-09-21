import { parentPort, workerData } from 'node:worker_threads';
import { resizeImage } from '@earendil-works/pi-coding-agent/image-resize';

const input: unknown = workerData;
if (
  typeof input !== 'object' ||
  input === null ||
  !('bytes' in input) ||
  !(input.bytes instanceof Uint8Array) ||
  !('mimeType' in input) ||
  typeof input.mimeType !== 'string' ||
  !('maxWidth' in input) ||
  typeof input.maxWidth !== 'number'
) {
  throw new Error('Invalid image preview input');
}

// The outer worker also isolates Pi's in-process fallback in standalone bundles.
const result = await resizeImage(input.bytes, input.mimeType, {
  maxWidth: input.maxWidth,
  maxHeight: 640,
  maxBytes: 4 * 1024 * 1024,
});
parentPort?.postMessage(result?.mimeType === 'image/png' ? result.data : undefined);
