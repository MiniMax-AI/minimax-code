import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { resolveAuthLeaseEndpoint, type AuthLeaseEndpoint } from '@mavis/oauth-lease-protocol';

import { createPrivateBrokerInstance } from './runtime-directory.js';

interface AllocatedBrokerEndpoint extends AuthLeaseEndpoint {
  cleanup(): Promise<void>;
}

// Leave room for the terminating NUL in sockaddr_un.sun_path.
function unixSocketByteLimit(platform: NodeJS.Platform): number {
  return platform === 'linux' ? 107 : 103;
}

export async function allocateBrokerEndpoint(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  isolateInstance = false,
): Promise<AllocatedBrokerEndpoint> {
  const original = resolveAuthLeaseEndpoint(dataDir, platform);
  const limit = unixSocketByteLimit(platform);
  if (
    !isolateInstance &&
    (original.transport === 'pipe' || Buffer.byteLength(original.endpoint, 'utf8') <= limit)
  ) {
    return { ...original, cleanup: async () => undefined };
  }

  const paths = platform === 'win32' ? path.win32 : path;
  const socketName = paths.basename(original.endpoint);
  const capabilityName = paths.basename(original.capabilityFile);
  const fits = (root: string): boolean =>
    original.transport === 'pipe' ||
    Buffer.byteLength(paths.join(root, 'mt-XXXXXX', socketName), 'utf8') <= limit;
  let root = paths.dirname(original.capabilityFile);
  if (!fits(root)) root = path.join(homedir(), '.minimax', 'run');
  if (!paths.isAbsolute(root) || !fits(root)) {
    throw new Error('The MCode home directory is too long for an OAuth lease socket.');
  }

  // Exclusive creation isolates instances; a separate random capability
  // authenticates clients.
  const directory = await createPrivateBrokerInstance(root, 'mt-');
  const endpoint =
    original.transport === 'pipe'
      ? resolveAuthLeaseEndpoint(directory, platform).endpoint
      : paths.join(directory, socketName);
  return {
    transport: original.transport,
    endpoint,
    capabilityFile: paths.join(directory, capabilityName),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
