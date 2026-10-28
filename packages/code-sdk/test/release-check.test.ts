import { spawnSync } from 'node:child_process';
import { writeFileSync, type PathLike } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  NPMJS_TARGET_ARGS,
  normalizeRegistry,
  publishCommand,
  readBackCommands,
  resolveTool,
  scopedRegistryProblem,
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
