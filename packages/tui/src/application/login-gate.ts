import { TuiFailure } from '../failure.js';
import type {
  TuiAccountStatus,
  TuiAccountStatusOptions,
  TuiConfigurationPort,
} from '../runtime/port.js';

export const MINIMAX_CODE_TUI_LOGIN_REQUIRED_MESSAGE =
  'Sign in to MiniMax to use Agent features. Run /login, then retry.';

export const MINIMAX_CODE_HEADLESS_LOGIN_REQUIRED_MESSAGE =
  'Sign in to MiniMax to use Agent features. Run `mcode login`, then retry.';

type TuiLoginStatusPort = Pick<TuiConfigurationPort, 'getAccountStatus'>;

export class TuiLoginRequiredError extends TuiFailure {
  constructor(
    readonly account: TuiAccountStatus,
    message = MINIMAX_CODE_HEADLESS_LOGIN_REQUIRED_MESSAGE,
  ) {
    super('config', message, {
      code: 'auth.login_required',
      retryable: false,
    });
    this.name = 'TuiLoginRequiredError';
  }
}

export function tuiAgentRequiresLogin(account: TuiAccountStatus): boolean {
  if (account.modelSource) return account.modelSource === 'token-plan';
  return account.authMode === 'managed-login';
}

export function tuiAgentAccessNeedsLogin(account: TuiAccountStatus): boolean {
  return (
    account.status === 'needs-login' ||
    (tuiAgentRequiresLogin(account) && account.managedTokenPresent !== true)
  );
}

export function tuiAccountNeedsLoginPrompt(account: TuiAccountStatus): boolean {
  // A missing MiniMax account does not block the selected BYOK route.
  return tuiAgentAccessNeedsLogin(account);
}

async function readTuiAccount(
  runtime: TuiLoginStatusPort,
  sessionId?: string,
  onAccount?: (account: TuiAccountStatus) => void,
  options?: TuiAccountStatusOptions,
): Promise<TuiAccountStatus> {
  const account = await runtime.getAccountStatus(sessionId, options);
  onAccount?.(account);
  return account;
}

export async function requireTuiAgentAccess(
  runtime: TuiLoginStatusPort,
  sessionId?: string,
  message = MINIMAX_CODE_HEADLESS_LOGIN_REQUIRED_MESSAGE,
  onAccount?: (account: TuiAccountStatus) => void,
  options?: TuiAccountStatusOptions,
): Promise<TuiAccountStatus> {
  const account = await readTuiAccount(runtime, sessionId, onAccount, options);
  if (tuiAgentAccessNeedsLogin(account)) {
    throw new TuiLoginRequiredError(account, message);
  }
  return account;
}

export async function requireTuiAccountLogin(
  runtime: TuiLoginStatusPort,
  sessionId?: string,
  message = MINIMAX_CODE_HEADLESS_LOGIN_REQUIRED_MESSAGE,
  onAccount?: (account: TuiAccountStatus) => void,
): Promise<TuiAccountStatus> {
  const account = await readTuiAccount(runtime, sessionId, onAccount, { requireManagedAuth: true });
  if (account.managedTokenPresent !== true) {
    throw new TuiLoginRequiredError(account, message);
  }
  return account;
}

export async function requireTuiInteractiveAgentAccess(
  runtime: Partial<TuiLoginStatusPort>,
  sessionId: string | undefined,
  onAccount: (account: TuiAccountStatus) => void,
): Promise<void> {
  const getAccountStatus = runtime.getAccountStatus;
  if (!getAccountStatus) return;
  await requireTuiAgentAccess(
    { getAccountStatus: getAccountStatus.bind(runtime) },
    sessionId,
    MINIMAX_CODE_TUI_LOGIN_REQUIRED_MESSAGE,
    onAccount,
  );
}

export async function requireTuiInteractiveAccountLogin(
  runtime: Partial<TuiLoginStatusPort>,
  sessionId: string | undefined,
  onAccount: (account: TuiAccountStatus) => void,
): Promise<void> {
  const getAccountStatus = runtime.getAccountStatus;
  if (!getAccountStatus) return;
  await requireTuiAccountLogin(
    { getAccountStatus: getAccountStatus.bind(runtime) },
    sessionId,
    MINIMAX_CODE_TUI_LOGIN_REQUIRED_MESSAGE,
    onAccount,
  );
}
