import { createHash } from 'node:crypto';
import path from 'node:path';

import { AuthLeaseProtocolError } from './contracts.js';

const SOCKET_FILE = 'mcode-auth-lease-v1.sock';
const CAPABILITY_FILE = 'mcode-auth-lease-v1.cap';
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\mcode-auth-lease-';

export interface AuthLeaseEndpoint {
  transport: 'unix' | 'pipe';
  endpoint: string;
  capabilityFile: string;
}

export function resolveAuthLeaseEndpoint(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): AuthLeaseEndpoint {
  if (platform === 'win32') {
    if (!path.win32.isAbsolute(dataDir)) {
      throw new TypeError('OAuth lease dataDir must be absolute.');
    }
    const canonical = trimTrailingSeparators(path.win32.normalize(dataDir), path.win32);
    const digest = createHash('sha256').update(canonical.toLowerCase()).digest('hex').slice(0, 16);
    return {
      transport: 'pipe',
      endpoint: `${WINDOWS_PIPE_PREFIX}${digest}`,
      capabilityFile: path.win32.join(canonical, 'run', CAPABILITY_FILE),
    };
  }
  if (!path.isAbsolute(dataDir)) throw new TypeError('OAuth lease dataDir must be absolute.');
  const canonical = trimTrailingSeparators(path.normalize(dataDir), path);
  return {
    transport: 'unix',
    endpoint: path.join(canonical, 'run', SOCKET_FILE),
    capabilityFile: path.join(canonical, 'run', CAPABILITY_FILE),
  };
}

export function assertAuthLeaseClientEndpoint(
  endpoint: string,
  capabilityFile: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') {
    if (
      !endpoint.startsWith(WINDOWS_PIPE_PREFIX) ||
      endpoint.length !== WINDOWS_PIPE_PREFIX.length + 16 ||
      !/^[a-f0-9]{16}$/u.test(endpoint.slice(WINDOWS_PIPE_PREFIX.length)) ||
      !path.win32.isAbsolute(capabilityFile) ||
      path.win32.basename(capabilityFile) !== CAPABILITY_FILE
    ) {
      throw new AuthLeaseProtocolError('INVALID_REQUEST');
    }
    return;
  }
  if (
    !path.isAbsolute(endpoint) ||
    !path.isAbsolute(capabilityFile) ||
    path.basename(endpoint) !== SOCKET_FILE ||
    path.basename(capabilityFile) !== CAPABILITY_FILE
  ) {
    throw new AuthLeaseProtocolError('INVALID_REQUEST');
  }
  if (path.dirname(endpoint) !== path.dirname(capabilityFile)) {
    throw new TypeError('OAuth lease endpoint and capability file must share one run directory.');
  }
}

function trimTrailingSeparators(
  value: string,
  pathImplementation: typeof path | typeof path.win32,
): string {
  const root = pathImplementation.parse(value).root;
  if (value === root) return value;
  let end = value.length;
  while (end > 0 && (value[end - 1] === '/' || value[end - 1] === '\\')) {
    end -= 1;
  }
  return value.slice(0, end);
}
