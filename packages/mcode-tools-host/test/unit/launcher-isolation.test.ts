import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ensureMcodeToolsPlaceholderLaunchers,
  installMcodeToolsLauncher,
  isMcodeToolsLauncherOwnedBy,
  removeMcodeToolsLaunchers,
  resolveMcodeToolsHostBinDir,
  type McodeToolsBuildEnv,
} from '../../src/resource.js';

const PACKAGE_BY_ENV: Record<McodeToolsBuildEnv, string> = {
  test: '@minimax/mcode-tools-test',
  staging: '@minimax/mcode-tools-staging',
  prod: '@minimax/mcode-tools',
};

interface DesktopApp {
  name: string;
  buildEnv: McodeToolsBuildEnv;
  executable: string;
  resourceDir: string;
  hostBinDir: string;
}

function writeResource(root: string, buildEnv: McodeToolsBuildEnv): string {
  const resourceDir = path.join(root, 'Contents', 'Resources', 'resources', 'mcode-tools');
  mkdirSync(resourceDir, { recursive: true });
  const cli = `console.log(${JSON.stringify(buildEnv)})\n`;
  writeFileSync(path.join(resourceDir, 'cli.mjs'), cli);
  writeFileSync(
    path.join(resourceDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 3,
      packageName: PACKAGE_BY_ENV[buildEnv],
      version: `0.0.0-${buildEnv}`,
      gitSha: 'abc1234',
      buildEnv,
      bedrockLane: '',
      nodeRange: '>=20',
      entry: 'cli.mjs',
      auth: {
        mode: 'shared-broker',
        protocol: { name: '@mavis/oauth-lease-protocol', version: '0.1.0-beta.0', wireVersion: 1 },
      },
      nativePackages: [],
      resources: [{ path: 'cli.mjs', sha256: createHash('sha256').update(cli).digest('hex') }],
    }),
  );
  return resourceDir;
}

/** Two installed Desktop packages that, like Internal and Test, default to one dataDir. */
function sharedDataDirFixture(): { dataDir: string; internal: DesktopApp; test: DesktopApp } {
  const root = mkdtempSync(path.join(tmpdir(), 'mcode-tools-host-isolation-'));
  const dataDir = path.join(root, '.minimax');
  const app = (name: string, buildEnv: McodeToolsBuildEnv): DesktopApp => {
    const appRoot = path.join(root, 'Applications', `${name}.app`);
    const executable = path.join(appRoot, 'Contents', 'MacOS', name);
    // Stands in for the App binary the launcher `exec`s: it reports which App actually ran.
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, `#!/bin/sh\necho "RAN=${name} BROKER=$MCODE_AUTH_BROKER_ENDPOINT"\n`);
    chmodSync(executable, 0o755);
    return {
      name,
      buildEnv,
      executable,
      resourceDir: writeResource(appRoot, buildEnv),
      hostBinDir: resolveMcodeToolsHostBinDir({ dataDir, buildEnv, executable }),
    };
  };
  return {
    dataDir,
    internal: app('MiniMax Internal Code', 'staging'),
    test: app('MiniMax Test Code', 'test'),
  };
}

function install(dataDir: string, app: DesktopApp, label: string) {
  return installMcodeToolsLauncher({
    resourceDir: app.resourceDir,
    expectedBuildEnv: app.buildEnv,
    dataDir,
    executable: app.executable,
    platform: 'darwin',
    region: 'cn',
    hostBinDir: app.hostBinDir,
    brokerEndpoint: path.join(dataDir, 'run', `mt-${label}`, 'mcode-auth-lease-v1.sock'),
    brokerCapabilityFile: path.join(dataDir, 'run', `mt-${label}`, 'mcode-auth-lease-v1.cap'),
  });
}

function remove(dataDir: string, app: DesktopApp): void {
  removeMcodeToolsLaunchers({
    dataDir,
    executable: app.executable,
    region: 'cn',
    hostBinDir: app.hostBinDir,
    platform: 'darwin',
  });
}

const LAUNCHER_NAMES = ['mcode-tools', 'mcode-tools-cn', 'mcode-tools-global'];

/**
 * Runs a bare command the way this App's Agent bash resolves it: App-owned directory first, then
 * the shared `<dataDir>/bin` another App may have written last. No region is set.
 */
function runAsAgent(dataDir: string, app: DesktopApp, command = 'mcode-tools') {
  const result = spawnSync('/bin/sh', ['-c', command], {
    env: {
      PATH: [app.hostBinDir, path.join(dataDir, 'bin'), '/usr/bin', '/bin'].join(path.delimiter),
    },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function expectPlaceholders(hostBinDir: string): void {
  for (const name of LAUNCHER_NAMES) {
    const file = path.join(hostBinDir, name);
    expect(readFileSync(file, 'utf8')).toContain('not available in this app');
    expect(statSync(file).mode & 0o777).toBe(0o755);
  }
}

function expectFailsClosed(run: ReturnType<typeof runAsAgent>): void {
  expect(run.status).toBe(127);
  expect(run.stdout).not.toContain('RAN=');
  expect(run.stderr).toContain('mcode-tools is not available in this app');
}

describe('mcode-tools launchers for Desktop packages sharing one dataDir', () => {
  it('derives a distinct, stable launcher directory per installed App', () => {
    const { dataDir, internal, test } = sharedDataDirFixture();

    expect(internal.hostBinDir).not.toBe(test.hostBinDir);
    expect(path.dirname(internal.hostBinDir)).toBe(path.join(dataDir, 'bin', 'hosts'));
    expect(path.basename(internal.hostBinDir)).toMatch(/^staging-[0-9a-f]{16}$/u);
    expect(path.basename(test.hostBinDir)).toMatch(/^test-[0-9a-f]{16}$/u);
    // Same buildEnv, different install (e.g. Staging and Internal are both staging builds).
    expect(
      resolveMcodeToolsHostBinDir({ dataDir, buildEnv: 'staging', executable: test.executable }),
    ).not.toBe(internal.hostBinDir);
    expect(
      resolveMcodeToolsHostBinDir({
        dataDir,
        buildEnv: internal.buildEnv,
        executable: internal.executable,
      }),
    ).toBe(internal.hostBinDir);
  });

  it('keeps each App on its own launcher, CLI and broker when the later App starts', async () => {
    const { dataDir, internal, test } = sharedDataDirFixture();

    const internalInstalled = await install(dataDir, internal, 'internal');
    const testInstalled = await install(dataDir, test, 'test');

    expect(internalInstalled.launcherPath).toBe(path.join(internal.hostBinDir, 'mcode-tools'));
    expect(testInstalled.launcherPath).toBe(path.join(test.hostBinDir, 'mcode-tools'));
    expect(internalInstalled.regionalLauncherPath).not.toBe(testInstalled.regionalLauncherPath);

    const internalLauncher = readFileSync(internalInstalled.regionalLauncherPath, 'utf8');
    expect(internalLauncher).toContain(`'${internal.executable}' '${path.join(internal.resourceDir, 'cli.mjs')}'`);
    expect(internalLauncher).toContain(path.join(dataDir, 'run', 'mt-internal'));
    expect(internalLauncher).not.toContain(test.executable);
    expect(internalLauncher).not.toContain('mt-test');
    expect(readFileSync(testInstalled.regionalLauncherPath, 'utf8')).toContain(test.executable);
    // The App-owned dispatcher only resolves siblings, so it never reaches the other App.
    expect(readFileSync(internalInstalled.launcherPath, 'utf8')).toContain(
      'mcode_tools_target="$mcode_tools_bin_dir/mcode-tools-cn"',
    );
    // The shared copy for shells outside the App is still last-writer-wins.
    expect(readFileSync(path.join(dataDir, 'bin', 'mcode-tools-cn'), 'utf8')).toContain(
      test.executable,
    );
  });

  it('removes only the disposing App launchers and never the other App launchers', async () => {
    const { dataDir, internal, test } = sharedDataDirFixture();
    const internalInstalled = await install(dataDir, internal, 'internal');
    await install(dataDir, test, 'test');
    const shared = path.join(dataDir, 'bin', 'mcode-tools-cn');

    // Internal quits while Test still runs: the shared copy now belongs to Test.
    remove(dataDir, internal);

    expectPlaceholders(internal.hostBinDir);
    expect(existsSync(path.join(test.hostBinDir, 'mcode-tools'))).toBe(true);
    expect(readFileSync(path.join(test.hostBinDir, 'mcode-tools-cn'), 'utf8')).toContain(
      test.executable,
    );
    expect(readFileSync(shared, 'utf8')).toContain(test.executable);
    expect(existsSync(path.join(dataDir, 'bin', 'mcode-tools'))).toBe(true);

    // Internal restarts and takes over the shared copy; Test quits afterwards.
    await install(dataDir, internal, 'internal-2');
    remove(dataDir, test);

    expectPlaceholders(test.hostBinDir);
    expect(readFileSync(internalInstalled.regionalLauncherPath, 'utf8')).toContain(
      internal.executable,
    );
    expect(readFileSync(shared, 'utf8')).toContain(internal.executable);
    expect(existsSync(path.join(dataDir, 'bin', 'mcode-tools'))).toBe(true);
  });

  it('leaves no shared launcher behind for a single App and placeholders in its own', async () => {
    const { dataDir, internal } = sharedDataDirFixture();
    await install(dataDir, internal, 'only');

    remove(dataDir, internal);

    expectPlaceholders(internal.hostBinDir);
    expect(readdirSync(internal.hostBinDir).sort()).toEqual([...LAUNCHER_NAMES].sort());
    for (const name of LAUNCHER_NAMES) {
      expect(existsSync(path.join(dataDir, 'bin', name))).toBe(false);
    }
  });

  it('keeps an unrelated file in the App directory and a launcher it cannot attribute', async () => {
    const { dataDir, internal } = sharedDataDirFixture();
    await install(dataDir, internal, 'only');
    const foreign = path.join(dataDir, 'bin', 'mcode-tools-global');
    writeFileSync(foreign, '#!/bin/sh\nexec /opt/other/node /opt/other/cli.mjs "$@"\n');
    writeFileSync(path.join(internal.hostBinDir, 'notes.txt'), 'keep');

    remove(dataDir, internal);

    expect(readFileSync(path.join(internal.hostBinDir, 'notes.txt'), 'utf8')).toBe('keep');
    expectPlaceholders(internal.hostBinDir);
    expect(existsSync(foreign)).toBe(true);
    // A remaining regional launcher still needs the dispatcher.
    expect(existsSync(path.join(dataDir, 'bin', 'mcode-tools'))).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')(
  'Agent bash of an App whose mcode-tools is not ready',
  // macOS scans freshly written executables on first exec, which can take seconds.
  { timeout: 30_000 },
  () => {
    it('fails closed instead of running the other App launcher from the shared directory', async () => {
      const { dataDir, internal, test } = sharedDataDirFixture();
      await install(dataDir, test, 'test');
      // Without placeholders the shared copy answers: that is the cross-App fallback.
      expect(runAsAgent(dataDir, internal).stdout).toContain('RAN=MiniMax Test Code');

      // Internal's integration is disabled, failed, or has not finished: only placeholders.
      ensureMcodeToolsPlaceholderLaunchers({ hostBinDir: internal.hostBinDir, platform: 'darwin' });

      for (const command of LAUNCHER_NAMES) expectFailsClosed(runAsAgent(dataDir, internal, command));
      expect(runAsAgent(dataDir, test).stdout).toContain('RAN=MiniMax Test Code');
    });

    it('runs its own launcher once ready while the other region stays a placeholder', async () => {
      const { dataDir, internal, test } = sharedDataDirFixture();
      await install(dataDir, test, 'test');
      ensureMcodeToolsPlaceholderLaunchers({ hostBinDir: internal.hostBinDir, platform: 'darwin' });

      await install(dataDir, internal, 'internal');

      const run = runAsAgent(dataDir, internal);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(
        `RAN=MiniMax Internal Code BROKER=${path.join(dataDir, 'run', 'mt-internal')}`,
      );
      expectFailsClosed(runAsAgent(dataDir, internal, 'MCODE_REGION=global mcode-tools'));
      expectFailsClosed(runAsAgent(dataDir, internal, 'mcode-tools-global'));
    });

    it('fails closed again after this App quits, instead of reaching the shared copy', async () => {
      const { dataDir, internal, test } = sharedDataDirFixture();
      await install(dataDir, internal, 'internal');
      await install(dataDir, test, 'test');

      remove(dataDir, internal);
      // Next launch, before the integration is ready again.
      ensureMcodeToolsPlaceholderLaunchers({ hostBinDir: internal.hostBinDir, platform: 'darwin' });

      expectFailsClosed(runAsAgent(dataDir, internal));
      expect(runAsAgent(dataDir, test).stdout).toContain('RAN=MiniMax Test Code');
    });
  },
);

describe('ensureMcodeToolsPlaceholderLaunchers', () => {
  it('keeps launchers that are already installed', async () => {
    const { dataDir, internal } = sharedDataDirFixture();
    const installed = await install(dataDir, internal, 'internal');
    const dispatcher = readFileSync(installed.launcherPath, 'utf8');
    const launcher = readFileSync(installed.regionalLauncherPath, 'utf8');

    ensureMcodeToolsPlaceholderLaunchers({ hostBinDir: internal.hostBinDir, platform: 'darwin' });

    expect(readFileSync(installed.launcherPath, 'utf8')).toBe(dispatcher);
    expect(readFileSync(installed.regionalLauncherPath, 'utf8')).toBe(launcher);
    expect(readFileSync(path.join(internal.hostBinDir, 'mcode-tools-global'), 'utf8')).toContain(
      'not available in this app',
    );
  });

  it('writes Windows placeholders that exit 127 and resets to them on removal', () => {
    const { dataDir, internal } = sharedDataDirFixture();

    ensureMcodeToolsPlaceholderLaunchers({ hostBinDir: internal.hostBinDir, platform: 'win32' });
    const names = LAUNCHER_NAMES.map((name) => `${name}.cmd`);
    expect(readdirSync(internal.hostBinDir).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(readFileSync(path.join(internal.hostBinDir, name), 'utf8')).toContain('exit /b 127');
    }

    writeFileSync(path.join(internal.hostBinDir, 'mcode-tools-cn.cmd'), '@echo off\r\n"C:\\x.exe" %*\r\n');
    removeMcodeToolsLaunchers({
      dataDir,
      executable: 'C:\\x.exe',
      region: 'cn',
      hostBinDir: internal.hostBinDir,
      platform: 'win32',
    });
    expect(readFileSync(path.join(internal.hostBinDir, 'mcode-tools-cn.cmd'), 'utf8')).toContain(
      'exit /b 127',
    );
  });
});

describe('isMcodeToolsLauncherOwnedBy', () => {
  it('matches only the exact host executable of POSIX and Windows launchers', async () => {
    const { dataDir, internal, test } = sharedDataDirFixture();
    const installed = await install(dataDir, internal, 'owned');

    expect(isMcodeToolsLauncherOwnedBy(installed.regionalLauncherPath, internal.executable)).toBe(true);
    expect(isMcodeToolsLauncherOwnedBy(installed.regionalLauncherPath, test.executable)).toBe(false);
    expect(
      isMcodeToolsLauncherOwnedBy(installed.regionalLauncherPath, `${internal.executable} Helper`),
    ).toBe(false);
    expect(isMcodeToolsLauncherOwnedBy(path.join(dataDir, 'missing'), internal.executable)).toBe(false);

    const windows = await installMcodeToolsLauncher({
      resourceDir: test.resourceDir,
      expectedBuildEnv: 'test',
      dataDir: path.join(dataDir, 'win'),
      executable: 'C:\\Program Files\\MiniMax Test Code\\MiniMax Test Code.exe',
      platform: 'win32',
      region: 'cn',
      brokerEndpoint: '\\\\.\\pipe\\mcode-auth-lease-test',
      brokerCapabilityFile: 'C:\\data\\run\\mt-test\\mcode-auth-lease-v1.cap',
    });
    expect(
      isMcodeToolsLauncherOwnedBy(
        windows.regionalLauncherPath,
        'C:\\Program Files\\MiniMax Test Code\\MiniMax Test Code.exe',
      ),
    ).toBe(true);
    expect(
      isMcodeToolsLauncherOwnedBy(
        windows.regionalLauncherPath,
        'C:\\Program Files\\MiniMax Internal Code\\MiniMax Internal Code.exe',
      ),
    ).toBe(false);
  });
});
