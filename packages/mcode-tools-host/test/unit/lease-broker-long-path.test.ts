import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';

import { createNodeAuthLeaseClient, resolveAuthLeaseEndpoint } from '@mavis/oauth-lease-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McodeToolsHostAuthSession } from '../../src/contracts.js';
import { startMcodeToolsAuthLeaseBroker } from '../../src/lease-broker.js';

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: vi.fn(),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => {
  vi.mocked(os.homedir).mockReturnValue(await createDataDir());
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function session(): McodeToolsHostAuthSession {
  return {
    getStatus: async () => ({ status: 'authenticated', generation: 3 }),
    getAccessToken: async () => ({
      accessToken: 'synthetic-lease',
      expiresAtMs: Date.now() + 120_000,
      generation: 3,
      audience: 'agent-backend',
      scopes: ['agent.default'],
    }),
    handleUnauthorized: async () => 'retry',
    watch: () => () => undefined,
  };
}

async function createDataDir(): Promise<string> {
  const root = await mkdtemp('/tmp/mcl-test-');
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe.skipIf(process.platform === 'win32')('long-profile broker transport', () => {
  it('keeps normal profiles at their original addresses and preserves user files', async () => {
    const dataDir = await createDataDir();
    const broker = await startMcodeToolsAuthLeaseBroker({ dataDir, session: session() });
    cleanups.push(() => broker.dispose());
    const original = resolveAuthLeaseEndpoint(dataDir);
    expect(broker.endpoint).toBe(original.endpoint);
    expect(broker.capabilityFile).toBe(original.capabilityFile);
    const userFile = path.join(dataDir, 'run', 'keep.txt');
    await writeFile(userFile, 'user data');
    await broker.dispose();
    expect(await stat(userFile)).toBeDefined();
  });

  it('serves status, leases and 401 recovery through the unchanged protocol', async () => {
    const root = await createDataDir();
    const dataDir = path.join(root, '用户'.repeat(40), '.minimax');
    const broker = await startMcodeToolsAuthLeaseBroker({ dataDir, session: session() });
    cleanups.push(() => broker.dispose());
    const client = createNodeAuthLeaseClient(broker);
    cleanups.push(async () => client.close());
    expect(path.dirname(path.dirname(broker.endpoint))).toBe(
      path.join(os.homedir(), '.minimax', 'run'),
    );
    expect(Buffer.byteLength(broker.endpoint)).toBeLessThanOrEqual(103);
    await expect(client.getStatus()).resolves.toMatchObject({ status: 'authenticated' });
    await expect(client.getLease(30_000)).resolves.toMatchObject({
      accessToken: 'synthetic-lease',
    });
    await expect(client.handleUnauthorized(3)).resolves.toMatchObject({ action: 'retry' });
    for (const file of [broker.endpoint, broker.capabilityFile]) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
    client.close();
    await broker.dispose();
    await expect(stat(path.dirname(broker.endpoint))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['short', 'long'] as const)(
    'isolates concurrent instances and cleanup for the same %s profile',
    async (length) => {
      const root = await createDataDir();
      const dataDir = length === 'short' ? root : path.join(root, 'long-profile-'.repeat(12));
      const first = await startMcodeToolsAuthLeaseBroker({
        dataDir,
        isolateInstance: true,
        session: session(),
      });
      const second = await startMcodeToolsAuthLeaseBroker({
        dataDir,
        isolateInstance: true,
        session: session(),
      });
      cleanups.push(
        () => first.dispose(),
        () => second.dispose(),
      );
      expect(first.endpoint).not.toBe(second.endpoint);
      const parent =
        length === 'short' ? path.join(dataDir, 'run') : path.join(os.homedir(), '.minimax', 'run');
      expect(path.dirname(path.dirname(first.endpoint))).toBe(parent);
      expect(path.basename(path.dirname(first.endpoint))).toMatch(/^mt-[A-Za-z0-9]{6}$/u);
      expect((await stat(path.dirname(first.endpoint))).mode & 0o777).toBe(0o700);
      const firstClient = createNodeAuthLeaseClient(first);
      const secondClient = createNodeAuthLeaseClient(second);
      cleanups.push(
        async () => firstClient.close(),
        async () => secondClient.close(),
      );
      await expect(firstClient.getLease(0)).resolves.toMatchObject({
        accessToken: 'synthetic-lease',
      });
      await first.dispose();
      await expect(stat(path.dirname(first.endpoint))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(secondClient.getLease(0)).resolves.toMatchObject({
        accessToken: 'synthetic-lease',
      });
      await first.dispose();
      expect(await stat(second.capabilityFile)).toBeDefined();
    },
  );

  it('rejects another instance capability rather than falling back to a different profile', async () => {
    const dataDir = path.join(await createDataDir(), 'profile-'.repeat(18));
    const broker = await startMcodeToolsAuthLeaseBroker({ dataDir, session: session() });
    cleanups.push(() => broker.dispose());
    await writeFile(broker.capabilityFile, 'a'.repeat(43), { mode: 0o600 });
    const client = createNodeAuthLeaseClient(broker);
    cleanups.push(async () => client.close());
    await expect(client.getLease(0)).rejects.toMatchObject({ code: 'CAPABILITY_REJECTED' });
  });

  it.each(['short', 'long'] as const)(
    'cleans the %s instance when initialization fails after listen',
    async (length) => {
      const root = await createDataDir();
      vi.mocked(os.homedir).mockReturnValue(root);
      const auth = session();
      auth.watch = vi.fn(() => {
        throw new Error('watch initialization failed');
      });
      await expect(
        startMcodeToolsAuthLeaseBroker({
          dataDir: length === 'short' ? root : path.join(root, 'profile-'.repeat(18)),
          isolateInstance: true,
          session: auth,
        }),
      ).rejects.toThrow('watch initialization failed');
      expect(
        await readdir(
          length === 'short' ? path.join(root, 'run') : path.join(root, '.minimax', 'run'),
        ),
      ).toEqual([]);
    },
  );

  it.each(['short', 'long'] as const)(
    'cleans the %s instance when capability creation fails before listen',
    async (length) => {
      const root = await createDataDir();
      vi.mocked(os.homedir).mockReturnValue(root);
      vi.mocked(fs.open).mockRejectedValueOnce(new Error('capability write denied'));
      await expect(
        startMcodeToolsAuthLeaseBroker({
          dataDir: length === 'short' ? root : path.join(root, 'profile-'.repeat(18)),
          isolateInstance: true,
          session: session(),
        }),
      ).rejects.toThrow('capability write denied');
      expect(
        await readdir(
          length === 'short' ? path.join(root, 'run') : path.join(root, '.minimax', 'run'),
        ),
      ).toEqual([]);
    },
  );
});
