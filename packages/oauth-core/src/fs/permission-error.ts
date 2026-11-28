import { CredentialStorePermissionError } from '../credential-store/types.js';

/**
 * On POSIX, EACCES/EPERM on the auth entries (auth.json, auth-state.json, auth.lock)
 * comes from ownership, modes or file flags, for example files left behind by
 * `sudo mcode`, and persists until someone changes them, so it needs a local reset.
 * Windows scanners and indexers deny access transiently, so native errors stay
 * unchanged there.
 */
export function toPosixPermissionError(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return process.platform !== 'win32' && (code === 'EACCES' || code === 'EPERM')
    ? new CredentialStorePermissionError({ cause: error })
    : error;
}
