import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MCode, MCodeNotFoundError, MCodeVersionError } from '../src/index.js';
import {
  buildSpawnCommand,
  escapeCmdArgument,
  findOnPath,
  parseCmdShim,
  resolveCli,
  resolvePackageEntry,
} from '../src/cli-resolver.js';
import { parseVersion, satisfiesMinimum } from '../src/version.js';
import { FAKE_MCODE, fakeClient, fixture, tempDir } from './helpers.js';

const isWindows = process.platform === 'win32';

/** Creates a platform-native `mcode` launcher in a fresh directory that runs the fake CLI. */
function installLauncher(name = 'mcode'): string {
  const dir = tempDir();
  if (isWindows) {
    mkdirSync(join(dir, 'node_modules', 'fake'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'fake', 'mcode.mjs'), readFileSync(FAKE_MCODE));
    writeFileSync(
      join(dir, `${name}.cmd`),
      `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\fake\\mcode.mjs" %*\r\n`,
    );
  } else {
    const launcher = join(dir, name);
    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_MCODE}" "$@"\n`);
    chmodSync(launcher, 0o755);
  }
  return dir;
}

describe('CLI resolution', () => {
  it('prefers an explicit bin', () => {
    expect(resolveCli({ bin: FAKE_MCODE, env: {} })).toEqual({
      kind: 'node',
      path: FAKE_MCODE,
      source: 'option',
    });
  });

  it('resolves bin.mcode of an installed @minimax-ai/code package and runs it with Node', async () => {
    // The workspace links a test double for the optional peer dependency.
    const sdkSource = new URL('../src/cli-resolver.ts', import.meta.url).href;
    expect(resolvePackageEntry([sdkSource])).toBe(FAKE_MCODE);

    const turn = await new MCode({
      env: { PATH: '', FAKE_MCODE_FIXTURE: fixture('resumed') },
    })
      .startThread()
      .run('hi');
    expect(turn.finalResponse).toMatch(/^I wrote exactly/u);
  });

  it('falls back to mcode on PATH', async () => {
    const dir = installLauncher();
    const env = { PATH: dir, PATHEXT: '.CMD' };

    const cli = resolveCli({ env, packageSearchFrom: [], projectSearchFrom: tempDir() });
    expect(cli.source).toBe('path');
    // Windows .cmd shims resolve to their JS entry, avoiding cmd.exe.
    expect(cli.kind).toBe(isWindows ? 'node' : 'exec');
    expect(findOnPath('mcode', env)).toBeTruthy();

    const turn = await new MCode({
      bin: 'mcode',
      env: { ...env, FAKE_MCODE_FIXTURE: fixture('resumed') },
    })
      .startThread()
      .run('hi');
    expect(turn.status).toBe('succeeded');
  });

  it('throws MCodeNotFoundError with an install hint when nothing is found', async () => {
    const empty = tempDir();
    expect(() =>
      resolveCli({ env: { PATH: empty }, packageSearchFrom: [], projectSearchFrom: empty }),
    ).toThrow(MCodeNotFoundError);
    const error = await new MCode({ bin: join(empty, 'missing-mcode'), env: { PATH: empty } })
      .startThread()
      .run('x')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MCodeNotFoundError);
    expect((error as Error).message).toContain('npm install @minimax-ai/code@latest');
  });

  it('extracts the JS entry from npm and pnpm cmd shims', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'node_modules', '@minimax-ai', 'code', 'dist'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '@minimax-ai', 'code', 'dist', 'index.js'), '');
    const shim = join(dir, 'mcode.cmd');
    const npm = `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@minimax-ai\\code\\dist\\index.js" %*`;
    const pnpm = `"%~dp0\\node_modules\\@minimax-ai\\code\\dist\\index.js" %*`;
    const entry = join(dir, 'node_modules', '@minimax-ai', 'code', 'dist', 'index.js');

    expect(parseCmdShim(npm, shim)).toBe(entry);
    expect(parseCmdShim(pnpm, shim)).toBe(entry);
    expect(parseCmdShim('@echo off\r\nnative.exe %*', shim)).toBeUndefined();
  });

  it('escapes arguments for the cmd.exe fallback', () => {
    expect(escapeCmdArgument('--cwd=C:\\a b')).toBe('^^^"--cwd=C:\\a^^^ b^^^"');
    expect(escapeCmdArgument('x&y|z')).toBe('^^^"x^^^&y^^^|z^^^"');
    const command = buildSpawnCommand(
      { kind: 'cmd', path: 'C:\\bin\\mcode.cmd', source: 'path' },
      ['exec'],
      {
        ComSpec: 'C:\\Windows\\cmd.exe',
      },
    );
    expect(command).toEqual({
      command: 'C:\\Windows\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\bin\\mcode.cmd ^^^"exec^^^""'],
      windowsVerbatimArguments: true,
    });
  });
});

describe('CLI version check', () => {
  it('compares major.minor.patch and accepts preview builds of the minimum', () => {
    const satisfies = (text: string): boolean => {
      const version = parseVersion(text);
      const minimum = parseVersion('0.7.0');
      if (!version || !minimum) throw new Error(`unparseable version ${text}`);
      return satisfiesMinimum(version, minimum);
    };
    expect(satisfies('0.7.0-preview.1015121')).toBe(true);
    expect(satisfies('mcode 0.7.1')).toBe(true);
    expect(satisfies('1.0.0')).toBe(true);
    expect(satisfies('0.6.12')).toBe(false);
  });

  it('rejects an older CLI before running', async () => {
    const error = await fakeClient({ FAKE_MCODE_VERSION: '0.6.12' })
      .startThread()
      .run('x')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MCodeVersionError);
    expect((error as MCodeVersionError).version).toBe('0.6.12');
    expect((error as Error).message).toContain('npm install @minimax-ai/code@latest');
  });

  it('checks the version once per client', async () => {
    const log = join(tempDir(), 'versions.log');
    const mcode = fakeClient({
      FAKE_MCODE_FIXTURE: fixture('resumed'),
      FAKE_MCODE_VERSION_LOG: log,
    });
    await mcode.startThread().run('a');
    await mcode.startThread().run('b');
    expect(readFileSync(log, 'utf8')).toBe('version\n');
  });
});

describe('package metadata', () => {
  it('keeps engines.node identical to the mcode CLI package', () => {
    const read = (path: string): { engines: { node: string } } =>
      JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')) as {
        engines: { node: string };
      };
    expect(read('../package.json').engines.node).toBe(read('../../tui/package.json').engines.node);
  });
});
