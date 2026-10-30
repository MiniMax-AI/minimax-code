import type { TuiAccountStatus } from '../runtime/port.js';
import type { TuiAccountIdentity } from './matrix-account-client.js';

/**
 * Projects the account name shown by `/status`. `subUserName` is the editable
 * profile name (Desktop and the account settings write it); `userName` is the
 * name captured at registration, so it is only a fallback.
 */
export function projectAccountDisplayIdentity(
  identity: Pick<TuiAccountIdentity, 'userEmail' | 'userName' | 'subUserName'>,
): NonNullable<TuiAccountStatus['identity']> {
  const name = identity.subUserName?.trim() || identity.userName?.trim();
  const email = identity.userEmail?.trim();
  return {
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
  };
}
