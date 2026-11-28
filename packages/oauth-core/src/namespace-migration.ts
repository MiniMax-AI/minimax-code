import { CredentialStorePermissionError } from './credential-store/types.js';
import { CrossProcessAuthLock } from './cross-process-lock.js';
import type { AuthNamespace } from './namespace.js';
import { AUTH_STATE_SCHEMA_VERSION, AuthStateStore, type AuthState } from './state-store.js';

export async function migrateLegacyAuthNamespace(namespace: AuthNamespace): Promise<void> {
  // Legacy root entries owned by another account are not this client's to retire,
  // and a local reset cannot change them either. An older client run by the same
  // user cannot read them, so skipping the migration is safe.
  const legacyState = await retireMatchingLegacyRootState(namespace).catch((error: unknown) => {
    if (error instanceof CredentialStorePermissionError) return null;
    throw error;
  });
  const targetStore = new AuthStateStore(namespace.statePath, namespace.authHome);
  const targetLock = new CrossProcessAuthLock(namespace.lockPath, { root: namespace.authHome });

  await targetLock.withLock(async () => {
    const targetState = await targetStore.read();
    if (targetState?.schemaVersion === AUTH_STATE_SCHEMA_VERSION) return;
    const sourceState = targetState ?? legacyState;
    if (!sourceState) return;
    await targetStore.write(toFileStoreAnonymousState(sourceState, namespace));
  });
}

async function retireMatchingLegacyRootState(namespace: AuthNamespace): Promise<AuthState | null> {
  const legacyStore = new AuthStateStore(namespace.legacyStatePath, namespace.authHome);
  const legacyLock = new CrossProcessAuthLock(namespace.legacyLockPath);

  return legacyLock.withLock(async () => {
    const legacyState = await legacyStore.read();
    if (!isMatchingLegacyState(legacyState, namespace)) return null;

    const { authorization: _authorization, ...stableState } = legacyState;
    await legacyStore.write({ ...stableState, status: 'error' });
    return legacyState;
  });
}

function isMatchingLegacyState(
  state: AuthState | null,
  namespace: AuthNamespace,
): state is AuthState {
  return (
    state !== null &&
    state.status !== 'error' &&
    state.buildEnv === namespace.buildEnv &&
    state.region === namespace.region
  );
}

function toFileStoreAnonymousState(state: AuthState, namespace: AuthNamespace): AuthState {
  return {
    schemaVersion: AUTH_STATE_SCHEMA_VERSION,
    status: 'anonymous',
    storeKind: 'file',
    clientId: 'mcode-public',
    scopes: ['agent.default'],
    audience: 'agent-backend',
    buildEnv: namespace.buildEnv,
    region: namespace.region,
    generation: state.generation + 1,
  };
}
