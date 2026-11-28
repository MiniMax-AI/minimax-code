import fs from 'node:fs';

/**
 * Identity of the config file on disk. Another runtime sharing the profile (Desktop and TUI)
 * may rewrite config.yaml; a changed signature makes the in-process cache re-read it.
 */
export function configFileSignature(configPath: string): string {
  try {
    const value = fs.statSync(configPath);
    return `${configPath}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
  } catch {
    return 'missing';
  }
}
