import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McodeUpdateService, type McodeUpdateDependencies } from '../../src/update/service.js';
import { resolveMcodeNpmDistribution } from '../../src/update/install-source.js';
import type { McodeReleaseManifestV1 } from '../../src/update/release.js';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mcode-update-test-'));
  temporaryRoots.push(root);
  return root;
}

function releaseFixture(version = '1.2.4', artifact = Buffer.from('signed artifact bytes')) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const manifest: McodeReleaseManifestV1 = {
    schemaVersion: 1,
    product: 'minimax-code',
    channel: 'stable',
    version,
    publishedAt: '2026-07-27T00:00:00.000Z',
    minNodeVersion: '22.19.0',
    registry: 'https://registry.example.test/',
    installArtifact: {
      url: `https://downloads.example.test/releases/${version}/mcode.tgz`,
      sha256: createHash('sha256').update(artifact).digest('hex'),
      size: artifact.length,
    },
    targets: {
      'darwin-arm64': { sha256: 'a'.repeat(64), size: 1 },
      'darwin-x64': { sha256: 'b'.repeat(64), size: 1 },
      'linux-x64': { sha256: 'c'.repeat(64), size: 1 },
      'windows-x64': { sha256: 'd'.repeat(64), size: 1 },
      'windows-arm64': { sha256: 'e'.repeat(64), size: 1 },
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return {
    manifest,
    manifestBytes,
    signature: sign(null, manifestBytes, privateKey).toString('base64'),
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    artifact,
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('McodeUpdateService', () => {
  it
    .skipIf(process.platform !== 'win32')
    .each(['standard npm', 'custom npm wrapper', 'custom npm wrapper with adjacent CLI'])(
    'installs and validates a managed update in a complex path with %s',
    async (npmLayout) => {
      const root = temporaryRoot();
      const fixtureRoot = path.join(root, 'package');
      mkdirSync(fixtureRoot);
      writeFileSync(
        path.join(fixtureRoot, 'package.json'),
        JSON.stringify({
          name: resolveMcodeNpmDistribution().packageName,
          version: '1.2.4',
          bin: { mcode: 'cli.cjs' },
        }),
      );
      writeFileSync(
        path.join(fixtureRoot, 'cli.cjs'),
        "#!/usr/bin/env node\nconsole.log('1.2.4');\n",
      );
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        npm_config_offline: 'true',
        npm_config_update_notifier: 'false',
        npm_config_bin_links: 'true',
        npm_config_cache: path.join(root, 'cache'),
        npm_config_userconfig: path.join(root, 'npmrc'),
      };
      writeFileSync(path.join(root, 'npmrc'), '');
      const npmCli = path.join(
        path.dirname(process.execPath),
        'node_modules',
        'npm',
        'bin',
        'npm-cli.js',
      );
      const packed = JSON.parse(
        execFileSync(
          process.execPath,
          [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', root],
          { cwd: fixtureRoot, env: environment, encoding: 'utf8', timeout: 30_000 },
        ),
      );
      if (npmLayout !== 'standard npm') {
        const wrapperRoot = path.join(root, 'npm-wrapper');
        mkdirSync(wrapperRoot);
        let wrapperCli = npmCli;
        if (npmLayout === 'custom npm wrapper with adjacent CLI') {
          wrapperCli = path.join(wrapperRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js');
          mkdirSync(path.dirname(wrapperCli), { recursive: true });
          writeFileSync(wrapperCli, `require(${JSON.stringify(npmCli)});\n`);
        }
        environment.npm_config_bin_links = 'false';
        writeFileSync(
          path.join(wrapperRoot, 'npm.cmd'),
          `@echo off\r\nset "npm_config_bin_links=true"\r\necho used> "%~dp0invoked"\r\n"${process.execPath}" "${wrapperCli}" %*\r\n`,
        );
        const pathKey = Object.keys(environment)
          .filter((key) => key.toLowerCase() === 'path')
          .sort()[0];
        const inheritedPath = pathKey ? environment[pathKey] : undefined;
        for (const key of Object.keys(environment)) {
          if (key.toLowerCase() === 'path') delete environment[key];
        }
        environment.PATH = [wrapperRoot, inheritedPath].filter(Boolean).join(path.delimiter);
      }
      const artifact = readFileSync(path.join(root, packed[0].filename));
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const manifest = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          product: 'minimax-code',
          channel: 'stable',
          version: '1.2.4',
          publishedAt: '2026-09-24T00:00:00.000Z',
          minNodeVersion: '22.19.0',
          registry: 'https://registry.npmjs.org/',
          installArtifact: {
            url: 'https://updates.example.invalid/mcode.tgz',
            sha256: createHash('sha256').update(artifact).digest('hex'),
            size: artifact.length,
          },
          targets: Object.fromEntries(
            ['darwin-arm64', 'darwin-x64', 'linux-x64', 'windows-x64', 'windows-arm64'].map(
              (target) => [target, { sha256: 'a'.repeat(64), size: 1 }],
            ),
          ),
        }),
      );
      const signature = Buffer.from(sign(null, manifest, privateKey).toString('base64'));
      const installRoot = path.join(root, '用户 files & (test)');
      mkdirSync(installRoot);
      writeFileSync(path.join(installRoot, 'current'), '1.2.3\n');
      const service = new McodeUpdateService({
        currentVersion: '1.2.3',
        installRoot,
        environment,
        publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        releaseBaseUrl: 'https://updates.example.invalid',
        dependencies: {
          fetchBytes: async (url) =>
            url.endsWith('.sig') ? signature : url.endsWith('.tgz') ? artifact : manifest,
        },
      });
      const result = await service.apply({ channel: 'stable' });
      expect(result.applied).toBe(true);
      expect(readFileSync(path.join(installRoot, 'current'), 'utf8')).toBe('1.2.4\n');
      if (npmLayout !== 'standard npm') {
        expect(readFileSync(path.join(root, 'npm-wrapper', 'invoked'), 'utf8')).toMatch(/^used/);
      }
    },
    60_000,
  );

  it.each(['HTTP_PROXY', 'ALL_PROXY', 'all_proxy'])(
    'routes release downloads through %s',
    async (variable) => {
      const connects: string[] = [];
      const proxy = createServer();
      proxy.on('connect', (request, socket) => {
        connects.push(request.url ?? '');
        socket.end('HTTP/1.1 502 Fixture Proxy\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      try {
        const address = proxy.address();
        if (!address || typeof address === 'string') throw new Error('Expected TCP proxy');
        const service = new McodeUpdateService({
          currentVersion: '1.2.3',
          installRoot: temporaryRoot(),
          releaseBaseUrl: 'https://updates.example.invalid',
          publicKey: releaseFixture().publicKey,
          environment: { [variable]: `http://127.0.0.1:${address.port}` },
        });
        await expect(service.check({ timeoutMs: 1_000 })).rejects.toThrow();
        expect(connects.length).toBeGreaterThan(0);
        expect(connects.every((target) => target === 'updates.example.invalid:443')).toBe(true);
      } finally {
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    },
  );

  it('checks a signed channel manifest without mutating the install root', async () => {
    const root = temporaryRoot();
    const fixture = releaseFixture();
    const fetchBytes = vi.fn(async (url: string) =>
      url.endsWith('.sig') ? Buffer.from(fixture.signature) : fixture.manifestBytes,
    );
    const service = new McodeUpdateService({
      currentVersion: '1.2.3',
      installRoot: root,
      publicKey: fixture.publicKey,
      dependencies: { fetchBytes },
    });

    await expect(service.check({ channel: 'stable' })).resolves.toMatchObject({
      status: 'available',
      currentVersion: '1.2.3',
      latestVersion: '1.2.4',
      channel: 'stable',
    });
    expect(fetchBytes).toHaveBeenCalledTimes(2);
    expect(existsSync(path.join(root, 'update.json'))).toBe(false);
  });

  it.each([
    new Error('offline'),
    Object.assign(new Error('timed out'), { name: 'AbortError' }),
    new Error('release server returned HTTP 503'),
  ])(
    'reports network and service failures without changing the active version',
    async (failure) => {
      const root = temporaryRoot();
      const currentFile = path.join(root, 'current');
      const dependencies: Partial<McodeUpdateDependencies> = {
        fetchBytes: vi.fn(async () => {
          throw failure;
        }),
      };
      const service = new McodeUpdateService({
        currentVersion: '1.2.3',
        installRoot: root,
        dependencies,
      });

      await expect(service.check({ channel: 'stable', timeoutMs: 100 })).rejects.toThrow();
      expect(() => readFileSync(currentFile, 'utf8')).toThrow();
    },
  );

  it('keeps the previous current pointer when install validation fails', async () => {
    const root = temporaryRoot();
    const fixture = releaseFixture();
    const dependencies: Partial<McodeUpdateDependencies> = {
      fetchBytes: vi.fn(async (url: string) =>
        url.endsWith('.sig')
          ? Buffer.from(fixture.signature)
          : url.endsWith('.tgz')
            ? Buffer.from('wrong bytes')
            : fixture.manifestBytes,
      ),
      installArtifact: vi.fn(async () => undefined),
      validateInstalledVersion: vi.fn(async () => undefined),
    };
    const service = new McodeUpdateService({
      currentVersion: '1.2.3',
      installRoot: root,
      publicKey: fixture.publicKey,
      dependencies,
    });

    await expect(service.apply({ channel: 'stable' })).rejects.toThrow(/checksum/i);
    expect(() => readFileSync(path.join(root, 'current'), 'utf8')).toThrow();
    expect(dependencies.installArtifact).not.toHaveBeenCalled();
  });

  it('activates only after staging installation and validation succeed', async () => {
    const root = temporaryRoot();
    const fixture = releaseFixture();
    const installArtifact = vi.fn(async () => undefined);
    const validateInstalledVersion = vi.fn(async () => undefined);
    const service = new McodeUpdateService({
      currentVersion: '1.2.3',
      installRoot: root,
      publicKey: fixture.publicKey,
      dependencies: {
        fetchBytes: vi.fn(async (url: string) =>
          url.endsWith('.sig')
            ? Buffer.from(fixture.signature)
            : url.endsWith('.tgz')
              ? fixture.artifact
              : fixture.manifestBytes,
        ),
        installArtifact,
        validateInstalledVersion,
      },
    });

    await expect(service.apply({ channel: 'stable' })).resolves.toMatchObject({
      applied: true,
      latestVersion: '1.2.4',
    });
    expect(installArtifact).toHaveBeenCalledOnce();
    expect(validateInstalledVersion).toHaveBeenCalled();
    expect(readFileSync(path.join(root, 'current'), 'utf8')).toBe('1.2.4\n');
    expect(existsSync(path.join(root, 'versions', '1.2.4'))).toBe(true);
  });

  it('preserves an existing active pointer when staged install validation fails', async () => {
    const root = temporaryRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'current'), '1.2.3\n');
    const fixture = releaseFixture();
    const service = new McodeUpdateService({
      currentVersion: '1.2.3',
      installRoot: root,
      publicKey: fixture.publicKey,
      dependencies: {
        fetchBytes: vi.fn(async (url: string) =>
          url.endsWith('.sig')
            ? Buffer.from(fixture.signature)
            : url.endsWith('.tgz')
              ? fixture.artifact
              : fixture.manifestBytes,
        ),
        installArtifact: vi.fn(async () => undefined),
        validateInstalledVersion: vi.fn(async () => {
          throw new Error('installed binary smoke failed');
        }),
      },
    });

    await expect(service.apply({ channel: 'stable' })).rejects.toThrow(/previous version/i);
    expect(readFileSync(path.join(root, 'current'), 'utf8')).toBe('1.2.3\n');
    expect(existsSync(path.join(root, 'versions', '1.2.4'))).toBe(false);
  });

  it('requires the explicit --to option before downgrading from a channel', async () => {
    const root = temporaryRoot();
    const fixture = releaseFixture('1.2.2');
    const service = new McodeUpdateService({
      currentVersion: '1.2.3',
      installRoot: root,
      publicKey: fixture.publicKey,
      dependencies: {
        fetchBytes: vi.fn(async (url: string) =>
          url.endsWith('.sig') ? Buffer.from(fixture.signature) : fixture.manifestBytes,
        ),
      },
    });

    await expect(service.apply({ channel: 'stable' })).rejects.toThrow(/--to/);
  });

  it('cancels before activation and keeps the previous active version unchanged', async () => {
    const root = temporaryRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'current'), '1.2.3\n');
    const fixture = releaseFixture();
    const controller = new AbortController();
    const phases: string[] = [];
    const service = new McodeUpdateService({
      currentVersion: '1.2.3',
      installRoot: root,
      publicKey: fixture.publicKey,
      dependencies: {
        fetchBytes: vi.fn(async (url: string) =>
          url.endsWith('.sig')
            ? Buffer.from(fixture.signature)
            : url.endsWith('.tgz')
              ? fixture.artifact
              : fixture.manifestBytes,
        ),
      },
    });

    await expect(
      service.apply({
        channel: 'stable',
        signal: controller.signal,
        onPhase: (event) => {
          phases.push(`${event.phase}:${String(event.cancellable)}`);
          if (event.phase === 'downloading') controller.abort();
        },
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(phases).toContain('downloading:true');
    expect(phases).not.toContain('activating:false');
    expect(readFileSync(path.join(root, 'current'), 'utf8')).toBe('1.2.3\n');
    expect(existsSync(path.join(root, 'versions', '1.2.4'))).toBe(false);
  });

  it('locks cancellation at atomic activation and completes the pointer swap', async () => {
    const root = temporaryRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'current'), '1.2.3\n');
    const fixture = releaseFixture();
    const controller = new AbortController();
    const service = new McodeUpdateService({
      currentVersion: '1.2.3',
      installRoot: root,
      publicKey: fixture.publicKey,
      dependencies: {
        fetchBytes: vi.fn(async (url: string) =>
          url.endsWith('.sig')
            ? Buffer.from(fixture.signature)
            : url.endsWith('.tgz')
              ? fixture.artifact
              : fixture.manifestBytes,
        ),
        installArtifact: vi.fn(async () => undefined),
        validateInstalledVersion: vi.fn(async () => undefined),
      },
    });

    await expect(
      service.apply({
        channel: 'stable',
        signal: controller.signal,
        onPhase: (event) => {
          if (event.phase === 'activating') {
            expect(event.cancellable).toBe(false);
            controller.abort();
          }
        },
      }),
    ).resolves.toMatchObject({ applied: true, latestVersion: '1.2.4' });
    expect(readFileSync(path.join(root, 'current'), 'utf8')).toBe('1.2.4\n');
  });

  it('waits for installation to finish naturally before honoring cancellation', async () => {
    const root = temporaryRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'current'), '1.2.3\n');
    const fixture = releaseFixture();
    const controller = new AbortController();
    let finishInstall: (() => void) | undefined;
    const installArtifact = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishInstall = resolve;
        }),
    );
    const service = new McodeUpdateService({
      currentVersion: '1.2.3',
      installRoot: root,
      publicKey: fixture.publicKey,
      dependencies: {
        fetchBytes: vi.fn(async (url: string) =>
          url.endsWith('.sig')
            ? Buffer.from(fixture.signature)
            : url.endsWith('.tgz')
              ? fixture.artifact
              : fixture.manifestBytes,
        ),
        installArtifact,
        validateInstalledVersion: vi.fn(async () => undefined),
      },
    });

    const apply = service.apply({
      channel: 'stable',
      signal: controller.signal,
      onPhase: (event) => {
        if (event.phase === 'installing') {
          expect(event.cancellable).toBe(false);
          controller.abort();
        }
      },
    });
    await vi.waitFor(() => expect(installArtifact).toHaveBeenCalledOnce());
    expect(installArtifact).toHaveBeenCalledWith(
      expect.not.objectContaining({ signal: expect.anything() }),
    );
    expect(readFileSync(path.join(root, 'current'), 'utf8')).toBe('1.2.3\n');

    finishInstall?.();
    await expect(apply).rejects.toThrow(/cancelled/i);
    expect(readFileSync(path.join(root, 'current'), 'utf8')).toBe('1.2.3\n');
    expect(existsSync(path.join(root, 'versions', '1.2.4'))).toBe(false);
  });
});
