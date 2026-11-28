import path from 'node:path';

import type { PathValue, ShellFamily } from './permission-core.js';

export type PermissionPathResolutionContext = {
  workingDirectory?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  /** Trusted lexer facts; never supplied by tool input. */
  pathSyntax?: { dynamic: boolean; glob: boolean; expandHome: boolean };
};

/**
 * Resolve a literal path without applying the host process platform to a
 * Windows-shaped value. This keeps permission candidate generation safe when
 * a POSIX daemon inspects a Windows shell command.
 */
export function resolvePermissionPath(
  raw: string,
  context: PermissionPathResolutionContext = {},
  shell: ShellFamily = 'unknown',
): PathValue {
  if (context.pathSyntax?.dynamic ?? (raw.includes('$') || raw.includes('`'))) {
    return { raw, dynamic: true, resolution: 'environment' };
  }
  if (context.pathSyntax?.glob ?? (raw.includes('?') || raw.includes('*') || raw.includes('['))) {
    return { raw, dynamic: true, resolution: 'glob' };
  }

  // MSYS drive mounts are absolute Windows paths only for a trusted POSIX
  // shell on Windows. Preserve raw for execution and normalize the identity.
  if (context.platform === 'win32' && shell === 'posix') {
    const msys = /^\/(?:proc\/cygdrive\/)?([A-Za-z])(?:\/(.*))?$/.exec(raw);
    if (msys) {
      return {
        raw,
        resolved: path.win32.normalize(`${msys[1]}:/${msys[2] ?? ''}`),
        dynamic: false,
        resolution: 'absolute',
      };
    }
    // /usr, /etc, /tmp, and other MSYS mounts depend on the selected Git
    // installation. Do not invent a Windows drive-root mapping for them.
    if (raw.startsWith('/') && !raw.startsWith('//')) {
      return { raw, dynamic: true, resolution: 'unknown' };
    }
  }

  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\');
  if (windowsAbsolute) {
    return {
      raw,
      resolved: path.win32.normalize(raw),
      dynamic: false,
      resolution: 'absolute',
    };
  }

  if ((raw === '~' || raw.startsWith('~/')) && context.pathSyntax?.expandHome !== false) {
    if (!context.homeDir) return { raw, dynamic: true, resolution: 'home' };
    return {
      raw,
      resolved: (context.platform === 'win32' ? path.win32 : path).resolve(
        context.homeDir,
        raw === '~' ? '.' : raw.slice(2),
      ),
      dynamic: false,
      resolution: 'home',
    };
  }

  if (path.isAbsolute(raw)) {
    return { raw, resolved: path.normalize(raw), dynamic: false, resolution: 'absolute' };
  }

  const windowsContext =
    shell === 'cmd' ||
    shell === 'powershell' ||
    /^[A-Za-z]:[\\/]/.test(context.workingDirectory ?? '');
  if (windowsContext && context.workingDirectory) {
    return {
      raw,
      resolved: path.win32.resolve(context.workingDirectory, raw),
      dynamic: false,
      resolution: 'relative',
    };
  }

  return {
    raw,
    ...(context.workingDirectory ? { resolved: path.resolve(context.workingDirectory, raw) } : {}),
    dynamic: false,
    resolution: 'relative',
  };
}
