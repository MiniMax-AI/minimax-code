import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';

import { resolveAuthLeaseEndpoint } from '@mavis/oauth-lease-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { allocateBrokerEndpoint } from '../../src/broker-endpoint.js';

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: vi.fn(),
  tmpdir: vi.fn(() => '/tmp'),
}));

const cleanups: Array<() => Promise<void>> = [];
let home: string;
beforeEach(async () => {
  home = await mkdtemp('/tmp/mcl-home-');
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  vi.mocked(os.homedir).mockReturnValue(home);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.mocked(os.tmpdir).mockReturnValue('/tmp');
  vi.clearAllMocks();
});

function dataDirForBytes(bytes: number): string {
  const suffixBytes = Buffer.byteLength('/run/mcode-auth-lease-v1.sock');
  return `/${'x'.repeat(bytes - suffixBytes - 1)}`;
}

describe.skipIf(process.platform === 'win32')('broker endpoint allocation', () => {
  it.each([
    ['darwin', 103],
    ['linux', 107],
  ] as const)('preserves the profile address at the %s byte boundary', async (platform, bytes) => {
    const dataDir = dataDirForBytes(bytes);
    const allocated = await allocateBrokerEndpoint(dataDir, platform);
    cleanups.push(allocated.cleanup);
    expect(allocated.endpoint).toBe(resolveAuthLeaseEndpoint(dataDir, platform).endpoint);
    expect(allocated.capabilityFile).toBe(
      resolveAuthLeaseEndpoint(dataDir, platform).capabilityFile,
    );
    expect(os.tmpdir).not.toHaveBeenCalled();
  });

  it.each([
    ['darwin', 104],
    ['linux', 108],
  ] as const)('relocates only addresses exceeding the %s budget', async (platform, bytes) => {
    const allocated = await allocateBrokerEndpoint(dataDirForBytes(bytes), platform);
    cleanups.push(allocated.cleanup);
    expect(Buffer.byteLength(allocated.endpoint)).toBeLessThan(bytes);
    expect(path.dirname(allocated.endpoint)).toBe(path.dirname(allocated.capabilityFile));
    expect(path.basename(allocated.endpoint)).toBe('mcode-auth-lease-v1.sock');
    expect(path.basename(allocated.capabilityFile)).toBe('mcode-auth-lease-v1.cap');
    expect(path.dirname(path.dirname(allocated.endpoint))).toBe(path.join(home, '.minimax', 'run'));
    expect((await stat(path.dirname(allocated.endpoint))).mode & 0o777).toBe(0o700);
    expect(os.tmpdir).not.toHaveBeenCalled();
  });

  it.each([
    ['darwin', 103],
    ['linux', 107],
  ] as const)('includes the instance directory in the %s byte budget', async (platform, limit) => {
    const allocated = await allocateBrokerEndpoint(dataDirForBytes(limit), platform, true);
    cleanups.push(allocated.cleanup);
    expect(path.dirname(path.dirname(allocated.endpoint))).toBe(path.join(home, '.minimax', 'run'));
    expect(Buffer.byteLength(allocated.endpoint)).toBeLessThanOrEqual(limit);
    expect(path.basename(path.dirname(allocated.endpoint))).toMatch(/^mt-[A-Za-z0-9]{6}$/u);
    expect(os.tmpdir).not.toHaveBeenCalled();
  });

  it('counts UTF-8 bytes instead of characters', async () => {
    const dataDir = `/${'用户'.repeat(20)}`;
    const original = resolveAuthLeaseEndpoint(dataDir);
    expect(original.endpoint.length).toBeLessThan(103);
    expect(Buffer.byteLength(original.endpoint)).toBeGreaterThan(107);
    const allocated = await allocateBrokerEndpoint(dataDir, 'darwin');
    cleanups.push(allocated.cleanup);
    expect(Buffer.byteLength(allocated.endpoint)).toBeLessThanOrEqual(103);
  });

  it('uses the private application directory regardless of TMPDIR', async () => {
    vi.mocked(os.tmpdir).mockReturnValue(`/tmp/${'long'.repeat(40)}`);
    const first = await allocateBrokerEndpoint(dataDirForBytes(117), 'darwin');
    const second = await allocateBrokerEndpoint(dataDirForBytes(117), 'darwin');
    cleanups.push(first.cleanup, second.cleanup);
    const root = path.join(home, '.minimax', 'run');
    expect(path.dirname(path.dirname(first.endpoint))).toBe(root);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect(Buffer.byteLength(first.endpoint)).toBeLessThanOrEqual(103);
    expect(first.endpoint).not.toBe(second.endpoint);
    await first.cleanup();
    expect(await readdir(root)).toEqual([path.basename(path.dirname(second.endpoint))]);
    expect(os.tmpdir).not.toHaveBeenCalled();
  });

  it('fails when the home path is too long without allocating a temporary endpoint', async () => {
    vi.mocked(os.homedir).mockReturnValue(path.join(home, 'long'.repeat(40)));
    await expect(allocateBrokerEndpoint(dataDirForBytes(117), 'darwin')).rejects.toThrow(
      /too long/,
    );
    expect(await readdir(home)).toEqual([]);
    expect(os.tmpdir).not.toHaveBeenCalled();
  });

  it.each(['profile', 'home'] as const)(
    'rejects a symlinked %s runtime root without changing its target',
    async (location) => {
      const target = path.join(home, 'shared');
      await mkdir(target);
      await chmod(target, 0o755);
      await writeFile(path.join(target, 'keep.txt'), 'user data');
      const dataDir = path.join(home, '.minimax');
      await mkdir(dataDir);
      await symlink(target, path.join(dataDir, 'run'));
      await expect(
        allocateBrokerEndpoint(
          location === 'profile' ? dataDir : dataDirForBytes(117),
          'darwin',
          true,
        ),
      ).rejects.toThrow(/real directory/);
      expect((await stat(target)).mode & 0o777).toBe(0o755);
      expect(await readdir(target)).toEqual(['keep.txt']);
      expect(os.tmpdir).not.toHaveBeenCalled();
    },
  );

  it('fails when the application directory cannot be created', async () => {
    await writeFile(path.join(home, '.minimax'), 'not a directory');
    await expect(allocateBrokerEndpoint(dataDirForBytes(117), 'darwin')).rejects.toThrow();
    expect(os.tmpdir).not.toHaveBeenCalled();
  });

  it('leaves Windows named pipes and capability paths unchanged for long profiles', async () => {
    const dataDir = `C:\\Users\\user\\${'long-profile-'.repeat(12)}`;
    const allocated = await allocateBrokerEndpoint(dataDir, 'win32');
    expect(allocated).toMatchObject(resolveAuthLeaseEndpoint(dataDir, 'win32'));
    expect(os.tmpdir).not.toHaveBeenCalled();
    await allocated.cleanup();
  });
});
