import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, type PathLike } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DIRECTORY_PUBLISH_MESSAGE,
  isReleaseRehearsal,
  LOCAL_USER_PATH,
  NPMJS_TARGET_ARGS,
  normalizeRegistry,
  PACKAGE_TEXT_RULES,
  publishCommand,
  readBackCommands,
  releaseClosingLines,
  REQUIRED_TARBALL_ENTRIES,
  resolveTool,
  scopedRegistryProblem,
  tarballProblems,
  textLabels,
} from '../scripts/release-tools.mjs';
import { tempDir } from './helpers.js';

const releaseCheck = fileURLToPath(new URL('../scripts/release-check.mjs', import.meta.url));
const NPMJS = 'https://registry.npmjs.org/';

describe('release:check registry safety', () => {
  it('pins both the default and the @minimax-ai scoped registry on every printed npm command', () => {
    expect(NPMJS_TARGET_ARGS).toEqual([`--registry=${NPMJS}`, `--@minimax-ai:registry=${NPMJS}`]);
    for (const command of [
      publishCommand('/tmp/code sdk/minimax-ai-code-sdk-0.1.0.tgz'),
      ...readBackCommands('@minimax-ai/code-sdk@0.1.0', '@minimax-ai/code-sdk'),
    ]) {
      expect(command).toEqual(expect.arrayContaining([...NPMJS_TARGET_ARGS]));
    }
    expect(publishCommand('x.tgz')).toEqual([
      'npm',
      'publish',
      'x.tgz',
      ...NPMJS_TARGET_ARGS,
      '--access',
      'public',
      '--tag',
      'latest',
    ]);
  });

  it('accepts an unset or npmjs scoped registry and rejects any other', () => {
    expect(normalizeRegistry('undefined')).toBe('');
    expect(scopedRegistryProblem('undefined')).toBeUndefined();
    expect(scopedRegistryProblem('https://registry.npmjs.org')).toBeUndefined();
    expect(scopedRegistryProblem('http://127.0.0.1:9/scoped')).toMatch(
      /@minimax-ai:registry is set to http:\/\/127\.0\.0\.1:9\/scoped\/\. It overrides publishConfig and --registry/u,
    );
  });

  it('fails before any registry access when the effective npm config scopes @minimax-ai elsewhere', () => {
    // An isolated user config reproduces a machine whose npmrc points the scope at a mirror.
    const npmrc = join(tempDir(), 'npmrc');
    writeFileSync(
      npmrc,
      'registry=http://127.0.0.1:9/default/\n@minimax-ai:registry=http://127.0.0.1:9/scoped/\n',
    );

    const result = spawnSync(process.execPath, [releaseCheck, '--allow-non-main', '--offline'], {
      encoding: 'utf8',
      env: { ...process.env, npm_config_userconfig: npmrc },
      timeout: 60_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /@minimax-ai:registry is set to http:\/\/127\.0\.0\.1:9\/scoped\//u,
    );
    expect(result.stdout).not.toMatch(/Build, type check and tests|npm publish/u);
  });
});

describe('release:check tool invocation', () => {
  const exists = (files: string[]) => (file: PathLike) => files.includes(String(file));

  it('starts tools directly on POSIX and runs Node.js itself without a shell', () => {
    expect(resolveTool('npm', { platform: 'linux' })).toEqual({ command: 'npm', args: [] });
    expect(resolveTool('node', { platform: 'win32', execPath: 'C:\\node\\node.exe' })).toEqual({
      command: 'C:\\node\\node.exe',
      args: [],
    });
  });

  it('runs npm and pnpm through their JS entries on Windows', () => {
    const execPath = 'C:\\Program Files\\nodejs\\node.exe';
    const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    const pnpmCli = 'C:\\Users\\me\\AppData\\pnpm\\pnpm.cjs';
    const env = { npm_execpath: pnpmCli };
    expect(
      resolveTool('npm', { platform: 'win32', execPath, env, exists: exists([npmCli]) }),
    ).toEqual({
      command: execPath,
      args: [npmCli],
    });
    expect(
      resolveTool('pnpm', { platform: 'win32', execPath, env, exists: exists([pnpmCli]) }),
    ).toEqual({
      command: execPath,
      args: [pnpmCli],
    });
    expect(resolveTool('git', { platform: 'win32' })).toEqual({ command: 'git', args: [] });
    expect(() =>
      resolveTool('npm', { platform: 'win32', execPath, env: {}, exists: exists([]) }),
    ).toThrow(/Cannot find npm-cli\.js/u);
  });
});

describe('release:check private text and tarball allowlist', () => {
  it('matches local user paths and ignores nearby forms', () => {
    for (const sample of [
      '/Users/alice/project',
      '/home/alice/project',
      '/root/.npmrc',
      '/private/var/folders/xx/yy/T/tmp',
      String.raw`C:\Users\alice\src`,
      String.raw`C:\\Users\\alice\\src`,
      'C:/Users/alice/src',
    ]) {
      expect(LOCAL_USER_PATH.test(sample), sample).toBe(true);
      expect(textLabels(sample, PACKAGE_TEXT_RULES)).toContain('local user path');
    }
    for (const sample of [
      '/opt/minimax/app',
      '/home/',
      'home/alice/file',
      '/private/var/log/system.log',
      '/opt/root-tools/bin',
      'chroot/bin',
      'Users/alice',
      String.raw`D:\Temp\build`,
      'packages/code-sdk/src/index.ts',
    ]) {
      expect(LOCAL_USER_PATH.test(sample), sample).toBe(false);
    }
    expect(textLabels('packages/tui/src/cli.ts', PACKAGE_TEXT_RULES)).toContain(
      'repository package path',
    );
    expect(textLabels('packages/code-sdk/src/index.ts', PACKAGE_TEXT_RULES)).not.toContain(
      'repository package path',
    );
    expect(textLabels('@mavis/config', PACKAGE_TEXT_RULES)).toContain('internal package name');
    expect(textLabels('hello from the sdk', PACKAGE_TEXT_RULES)).toEqual([]);
  });

  it('accepts the public file set and rejects paths outside it', () => {
    expect(tarballProblems([...REQUIRED_TARBALL_ENTRIES, 'package/src/index.ts'])).toEqual({
      unexpected: [],
      missing: [],
    });
    expect(tarballProblems(['package/', ...REQUIRED_TARBALL_ENTRIES]).unexpected).toEqual([]);
    expect(
      tarballProblems([
        ...REQUIRED_TARBALL_ENTRIES,
        'package/scripts/release-check.mjs',
        'package/../../etc/passwd',
        'package/src/nested/secret.ts',
      ]).unexpected,
    ).toEqual([
      'package/scripts/release-check.mjs',
      'package/../../etc/passwd',
      'package/src/nested/secret.ts',
    ]);
    expect(tarballProblems(['package/package.json']).missing).toContain('package/dist/index.js');
  });

  it('prints a publish command only for an up-to-date main', () => {
    const head = 'a'.repeat(40);
    expect(isReleaseRehearsal({ branch: 'feat/code-sdk', head, remoteMain: head })).toBe(true);
    expect(isReleaseRehearsal({ branch: 'main', head, remoteMain: 'b'.repeat(40) })).toBe(true);
    expect(isReleaseRehearsal({ branch: 'main', head, remoteMain: head })).toBe(false);

    const shared = {
      spec: '@minimax-ai/code-sdk@0.1.0',
      releaseBranch: 'main',
      tarball: '/tmp/code-sdk-release-xx/minimax-ai-code-sdk-0.1.0.tgz',
      integrity: 'sha512-abc',
      version: '0.1.0',
      name: '@minimax-ai/code-sdk',
    };
    const rehearsal = releaseClosingLines({ ...shared, rehearsal: true }).join('\n');
    expect(rehearsal).toMatch(/Do not publish/u);
    expect(rehearsal).not.toMatch(/npm publish/u);
    const ready = releaseClosingLines({ ...shared, rehearsal: false }).join('\n');
    expect(ready).toMatch(/npm publish/u);
    expect(ready).toContain(shared.tarball);
    expect(ready).not.toMatch(/Do not publish/u);
  });
});

describe('directory publish guard', () => {
  const packageDir = fileURLToPath(new URL('..', import.meta.url));
  const guard = fileURLToPath(new URL('../scripts/release-tools.mjs', import.meta.url));

  it('is the prepublishOnly script and exits before a directory publish', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      scripts: { prepublishOnly: string };
      private?: boolean;
    };
    expect(manifest.private).not.toBe(true);
    expect(manifest.scripts.prepublishOnly).toBe('node scripts/release-tools.mjs');

    const direct = spawnSync(process.execPath, [guard], { encoding: 'utf8' });
    expect(direct.status).toBe(1);
    expect(direct.stderr).toContain(DIRECTORY_PUBLISH_MESSAGE);

    const publish = spawnSync(
      'npm',
      [
        'publish',
        '--dry-run',
        '--registry=https://registry.npmjs.org/',
        '--@minimax-ai:registry=https://registry.npmjs.org/',
      ],
      { cwd: packageDir, encoding: 'utf8', timeout: 60_000 },
    );
    expect(publish.status).not.toBe(0);
    expect(`${publish.stdout}${publish.stderr}`).toContain('Refusing to publish');
    expect(`${publish.stdout}${publish.stderr}`).not.toMatch(/npm notice.*published/u);
  });
});
