import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsFailures = vi.hoisted(() => ({
  readFilePath: undefined as string | undefined,
  openPath: undefined as string | undefined,
  chmodPath: undefined as string | undefined,
  mkdirPath: undefined as string | undefined,
  unlinkPath: undefined as string | undefined,
  renamePath: undefined as string | undefined,
  error: undefined as NodeJS.ErrnoException | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      if (fsFailures.error && String(args[0]) === fsFailures.openPath) throw fsFailures.error;
      const handle = await actual.open(...args);
      if (fsFailures.error && String(args[0]) === fsFailures.chmodPath) {
        handle.chmod = async () => {
          throw fsFailures.error;
        };
      }
      return handle;
    }) as typeof actual.open,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (fsFailures.error && String(args[0]) === fsFailures.readFilePath) throw fsFailures.error;
      return actual.readFile(...args);
    }) as typeof actual.readFile,
    chmod: (async (...args: Parameters<typeof actual.chmod>) => {
      if (fsFailures.error && String(args[0]) === fsFailures.chmodPath) throw fsFailures.error;
      return actual.chmod(...args);
    }) as typeof actual.chmod,
    mkdir: (async (...args: Parameters<typeof actual.mkdir>) => {
      if (fsFailures.error && String(args[0]) === fsFailures.mkdirPath) throw fsFailures.error;
      return actual.mkdir(...args);
    }) as typeof actual.mkdir,
    unlink: (async (...args: Parameters<typeof actual.unlink>) => {
      if (fsFailures.error && String(args[0]) === fsFailures.unlinkPath) throw fsFailures.error;
      return actual.unlink(...args);
    }) as typeof actual.unlink,
    rename: (async (...args: Parameters<typeof actual.rename>) => {
      if (fsFailures.error && String(args[1]) === fsFailures.renamePath) throw fsFailures.error;
      return actual.rename(...args);
    }) as typeof actual.rename,
  };
});

import { CrossProcessAuthLock } from '../../src/cross-process-lock.js';
import {
  CredentialRecordCorruptError,
  CredentialStorePermissionError,
} from '../../src/credential-store/types.js';
import { AuthStateStore } from '../../src/state-store.js';
import { createLocalAuthFixture } from '../helpers/local-auth.js';

/** Denies one path the way a root-owned 0600 file (for example after `sudo mcode`) would. */
function denyAccess(
  paths: Partial<Record<'readFile' | 'open' | 'chmod' | 'mkdir' | 'unlink' | 'rename', string>>,
  code = 'EACCES',
) {
  const error = Object.assign(new Error(`${code}: permission denied`), { code });
  fsFailures.readFilePath = paths.readFile;
  fsFailures.openPath = paths.open;
  fsFailures.chmodPath = paths.chmod;
  fsFailures.mkdirPath = paths.mkdir;
  fsFailures.unlinkPath = paths.unlink;
  fsFailures.renamePath = paths.rename;
  fsFailures.error = error;
  return error;
}

function allowAccess() {
  fsFailures.readFilePath = undefined;
  fsFailures.openPath = undefined;
  fsFailures.chmodPath = undefined;
  fsFailures.mkdirPath = undefined;
  fsFailures.unlinkPath = undefined;
  fsFailures.renamePath = undefined;
  fsFailures.error = undefined;
}

const tokenOptions = { requiredScopes: ['agent.default'], minValidityMs: 60_000 };

const originalPlatform = process.platform;

function usePlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('auth entries denied by file permissions', () => {
  afterEach(() => {
    allowAccess();
    usePlatform(originalPlatform);
  });

  it.each(['EACCES', 'EPERM'])(
    'reports %s on auth-state.json as a permission error on POSIX',
    async (code) => {
      usePlatform('linux');
      const statePath = join(tmpdir(), 'mcode-denied-state', 'auth-state.json');
      const denied = denyAccess({ readFile: statePath }, code);

      const error = await new AuthStateStore(statePath).read().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CredentialStorePermissionError);
      expect((error as Error).cause).toBe(denied);
    },
  );

  it('keeps native auth-state.json read errors on Windows', async () => {
    usePlatform('win32');
    const statePath = join(tmpdir(), 'mcode-denied-state', 'auth-state.json');
    const denied = denyAccess({ readFile: statePath }, 'EPERM');

    await expect(new AuthStateStore(statePath).read()).rejects.toBe(denied);
  });

  it('reports an auth.lock that cannot be opened as a permission error on POSIX', async () => {
    usePlatform('linux');
    const authHome = await mkdtemp(join(tmpdir(), 'mcode-denied-lock-'));
    const lockPath = join(authHome, 'auth.lock');
    const denied = denyAccess({ open: lockPath });
    const operation = vi.fn(async () => 'done');

    const error = await new CrossProcessAuthLock(lockPath)
      .withLock(operation)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CredentialStorePermissionError);
    expect((error as Error).cause).toBe(denied);
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    ['chmod', 'EPERM'],
    ['mkdir', 'EACCES'],
  ] as const)(
    'reports a lock directory denied by %s as a permission error on POSIX',
    async (call, code) => {
      usePlatform('linux');
      const authHome = await mkdtemp(join(tmpdir(), 'mcode-denied-lock-dir-'));
      const lockDirectory = call === 'mkdir' ? join(authHome, 'namespace') : authHome;
      if (call === 'chmod') await chmod(lockDirectory, 0o755);
      const denied = denyAccess({ [call]: lockDirectory }, code);
      const operation = vi.fn(async () => 'done');

      const error = await new CrossProcessAuthLock(join(lockDirectory, 'auth.lock'))
        .withLock(operation)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CredentialStorePermissionError);
      expect((error as Error).cause).toBe(denied);
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it('keeps native lock directory errors on Windows', async () => {
    usePlatform('win32');
    const authHome = await mkdtemp(join(tmpdir(), 'mcode-denied-lock-dir-'));
    const lockDirectory = join(authHome, 'namespace');
    const denied = denyAccess({ mkdir: lockDirectory }, 'EPERM');

    await expect(
      new CrossProcessAuthLock(join(lockDirectory, 'auth.lock')).withLock(async () => 'done'),
    ).rejects.toBe(denied);
  });

  it.skipIf(process.platform === 'win32')(
    'offers a local reset when auth-state.json cannot be read, then signs in again',
    async () => {
      const fixture = await createLocalAuthFixture();
      try {
        const core = fixture.createCore();
        const before = await core.login();
        denyAccess({ readFile: fixture.namespace.statePath });

        await expect(core.getStatus()).rejects.toBeInstanceOf(CredentialStorePermissionError);
        await expect(core.login()).rejects.toBeInstanceOf(CredentialStorePermissionError);
        const reset = await core.logout({ revoke: true });
        expect(reset.status).toBe('anonymous');
        // Holders of the old lease must see the next login as newer, not older.
        expect(reset.generation).toBeGreaterThan(before.generation);
        // auth.json is still readable, so the fallback reset revokes its refresh token.
        expect(fixture.calls.revoke).toBe(1);
        await expect(stat(fixture.namespace.credentialPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });

        allowAccess();
        await expect(fixture.createCore().getStatus()).resolves.toMatchObject({
          status: 'anonymous',
        });
        const relogin = await fixture.createCore().login();
        expect(relogin.status).toBe('authenticated');
        expect(relogin.generation).toBeGreaterThan(reset.generation);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.skipIf(process.platform === 'win32').each([
    ['auth-state.json', 'readFile'],
    ['auth.lock', 'open'],
  ] as const)(
    'skips migrating a legacy root %s that cannot be accessed and keeps sign-in working',
    async (_entry, call) => {
      const fixture = await createLocalAuthFixture({ migrateLegacyNamespace: true });
      try {
        const { legacyStatePath, legacyLockPath } = fixture.namespace;
        denyAccess(call === 'readFile' ? { readFile: legacyStatePath } : { open: legacyLockPath });
        const core = fixture.createCore();

        await expect(core.getStatus()).resolves.toMatchObject({ status: 'anonymous' });
        await expect(core.login()).resolves.toMatchObject({ status: 'authenticated' });
        await expect(core.logout({ revoke: true })).resolves.toMatchObject({
          status: 'anonymous',
        });
        await expect(fixture.createCore().login()).resolves.toMatchObject({
          status: 'authenticated',
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'fails the local reset while the namespace directory stays locked, then recovers',
    async () => {
      const fixture = await createLocalAuthFixture({ migrateLegacyNamespace: true });
      try {
        await fixture.createCore().login();
        await chmod(fixture.namespace.namespaceHome, 0o755);
        denyAccess({ chmod: fixture.namespace.namespaceHome }, 'EPERM');
        const core = fixture.createCore();

        await expect(core.login()).rejects.toBeInstanceOf(CredentialStorePermissionError);
        await expect(core.resetLocalCredentials()).rejects.toBeInstanceOf(
          CredentialStorePermissionError,
        );

        allowAccess();
        await expect(core.resetLocalCredentials()).resolves.toMatchObject({
          status: 'anonymous',
        });
        // The explicit reset does not read or revoke the stored credential.
        expect(fixture.calls.revoke).toBe(0);
        await expect(core.login()).resolves.toMatchObject({ status: 'authenticated' });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'requires a local reset when other users could write auth.json, even in a repaired directory',
    async () => {
      const fixture = await createLocalAuthFixture({ migrateLegacyNamespace: true });
      try {
        await fixture.createCore().login();
        await chmod(fixture.namespace.namespaceHome, 0o777);
        await chmod(fixture.namespace.credentialPath, 0o666);
        const core = fixture.createCore();

        await expect(core.getStatus()).rejects.toBeInstanceOf(CredentialStorePermissionError);
        await expect(core.getAccessToken(tokenOptions)).rejects.toBeInstanceOf(
          CredentialStorePermissionError,
        );
        await expect(core.login()).rejects.toBeInstanceOf(CredentialStorePermissionError);

        await expect(core.resetLocalCredentials()).resolves.toMatchObject({ status: 'anonymous' });
        await expect(core.login()).resolves.toMatchObject({ status: 'authenticated' });
        await expect(core.getAccessToken(tokenOptions)).resolves.toMatchObject({
          accessToken: 'test-access-2',
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'fails the local reset while a corrupt refresh journal cannot be removed, then recovers',
    async () => {
      const fixture = await createLocalAuthFixture();
      try {
        const core = fixture.createCore();
        await core.login();
        const journalPath = join(fixture.namespace.namespaceHome, 'refresh', 'auth.json');
        await mkdir(join(fixture.namespace.namespaceHome, 'refresh'), { mode: 0o700 });
        await writeFile(journalPath, '{', { mode: 0o600 });
        fixture.advanceTime(3_600_000);
        await expect(core.getAccessToken(tokenOptions)).rejects.toBeInstanceOf(
          CredentialRecordCorruptError,
        );

        const denied = denyAccess({ unlink: journalPath }, 'EPERM');
        const failure = await core.resetLocalCredentials().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(CredentialStorePermissionError);
        expect((failure as Error).cause).toBe(denied);
        // Nothing is reported as reset. auth.json held a token this refresh already rotated.
        const state = await new AuthStateStore(fixture.namespace.statePath).read();
        expect(state?.status).toBe('refreshing');

        allowAccess();
        await expect(core.resetLocalCredentials()).resolves.toMatchObject({ status: 'anonymous' });
        await expect(stat(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(core.login()).resolves.toMatchObject({ status: 'authenticated' });
        fixture.advanceTime(3_600_000);
        await expect(core.getAccessToken(tokenOptions)).resolves.toMatchObject({
          accessToken: expect.any(String),
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.skipIf(process.platform === 'win32').each(['state', 'credential'] as const)(
    'retries a partial reset after the %s file becomes accessible and signs in with a new lease',
    async (deniedFile) => {
      const fixture = await createLocalAuthFixture();
      try {
        const { credentialPath, statePath } = fixture.namespace;
        const core = fixture.createCore();
        await core.login();
        if (deniedFile === 'credential') {
          fixture.advanceTime(3_600_000);
          denyAccess({ rename: credentialPath }, 'EPERM');
          await expect(core.getAccessToken(tokenOptions)).rejects.toThrow();
          denyAccess({ readFile: statePath, unlink: credentialPath });
        } else {
          denyAccess({ readFile: statePath, rename: statePath });
        }
        await expect(core.resetLocalCredentials()).rejects.toThrow();
        allowAccess();

        const restarted = fixture.createCore();
        const reset = await restarted.resetLocalCredentials();
        expect(reset.status).toBe('anonymous');
        await expect(restarted.getStatus()).resolves.toMatchObject({ status: 'anonymous' });
        const login = await restarted.login();
        expect(login.generation).toBeGreaterThan(reset.generation);
        await expect(restarted.getAccessToken(tokenOptions)).resolves.toMatchObject({
          generation: login.generation,
        });
        expect(fixture.calls.device).toBe(2);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'finishes a local reset during a refresh by removing both credential files',
    async () => {
      const fixture = await createLocalAuthFixture();
      try {
        const core = fixture.createCore();
        const { credentialPath, namespaceHome } = fixture.namespace;
        await core.login();
        fixture.advanceTime(3_600_000);
        denyAccess({ rename: credentialPath }, 'EPERM');
        await expect(core.getAccessToken(tokenOptions)).rejects.toThrow();
        allowAccess();

        await expect(fixture.createCore().resetLocalCredentials()).resolves.toMatchObject({
          status: 'anonymous',
        });
        for (const path of [credentialPath, join(namespaceHome, 'refresh', 'auth.json')]) {
          await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        }
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'removes only the link when the refresh directory is a symbolic link',
    async () => {
      const fixture = await createLocalAuthFixture();
      try {
        const core = fixture.createCore();
        await core.login();
        const target = await mkdtemp(join(tmpdir(), 'mcode-linked-refresh-'));
        await writeFile(join(target, 'auth.json'), 'unrelated', { mode: 0o600 });
        await chmod(target, 0o755);
        const refreshHome = join(fixture.namespace.namespaceHome, 'refresh');
        await symlink(target, refreshHome);

        await expect(core.resetLocalCredentials()).resolves.toMatchObject({ status: 'anonymous' });

        await expect(lstat(refreshHome)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(join(target, 'auth.json'), 'utf8')).resolves.toBe('unrelated');
        expect((await stat(target)).mode & 0o777).toBe(0o755);
        await expect(core.login()).resolves.toMatchObject({ status: 'authenticated' });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  describe.each([...new Set([originalPlatform, 'win32'] as const)])(
    '%s managed directories',
    (platform) => {
      it.each(['auth', 'env', 'region', 'client'] as const)(
        'rejects a linked %s directory before acquiring the lock or changing stored files',
        async (level) => {
          const fixture = await createLocalAuthFixture({ migrateLegacyNamespace: true });
          try {
            const { authHome, namespaceHome, lockPath } = fixture.namespace;
            usePlatform(platform);
            const warm = fixture.createCore();
            await warm.login();
            const region = dirname(namespaceHome);
            const directory = {
              auth: authHome,
              env: dirname(region),
              region,
              client: namespaceHome,
            }[level];
            const moved = directory + '-moved';
            await unlink(lockPath);
            await rename(directory, moved);
            const movedNamespace = join(moved, relative(directory, namespaceHome));
            if (platform !== 'win32') await chmod(movedNamespace, 0o755);
            await symlink(moved, directory, 'junction');
            const cold = fixture.createCore();

            await expect(warm.getAccessToken(tokenOptions)).rejects.toBeInstanceOf(
              CredentialStorePermissionError,
            );
            await expect(cold.login()).rejects.toBeInstanceOf(CredentialStorePermissionError);
            await expect(cold.resetLocalCredentials()).rejects.toBeInstanceOf(
              CredentialStorePermissionError,
            );
            await expect(cold.logout({ revoke: false })).rejects.toBeInstanceOf(
              CredentialStorePermissionError,
            );
            if (platform !== 'win32') expect((await stat(movedNamespace)).mode & 0o777).toBe(0o755);
            await expect(stat(join(movedNamespace, 'auth.lock'))).rejects.toMatchObject({
              code: 'ENOENT',
            });
            expect((await stat(join(movedNamespace, 'auth.json'))).isFile()).toBe(true);

            await unlink(directory);
            await rename(moved, directory);
            await expect(cold.resetLocalCredentials()).resolves.toMatchObject({
              status: 'anonymous',
            });
            const login = await cold.login();
            expect(login.status).toBe('authenticated');
            await expect(cold.getAccessToken(tokenOptions)).resolves.toMatchObject({
              generation: login.generation,
              accessToken: 'test-access-2',
            });
          } finally {
            await fixture.cleanup();
          }
        },
      );
    },
  );
});
