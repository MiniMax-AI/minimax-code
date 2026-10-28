import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildSpawnCommand, resolveCli } from '../src/cli-resolver.js';
import { MCodeNotFoundError } from '../src/errors.js';
import { findProjectBin, parseCmdShim, parseShellShim } from '../src/project-bin.js';
import { FAKE_MCODE, tempDir } from './helpers.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

/** A project whose CLI package (any name) is installed with a JS entry under node_modules. */
function project(): { root: string; entry: string; bin: string } {
  const root = tempDir();
  const packageDir = join(root, 'node_modules', '@scope', 'any-mcode-cli', 'dist');
  mkdirSync(packageDir, { recursive: true });
  const entry = join(packageDir, 'index.js');
  copyFileSync(FAKE_MCODE, entry);
  writeFileSync(
    join(root, 'node_modules', '@scope', 'any-mcode-cli', 'package.json'),
    '{"type":"module"}',
  );
  const bin = join(root, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  return { root, entry, bin };
}

function versionOf(command: ReturnType<typeof buildSpawnCommand>): string {
  return spawnSync(command.command, command.args, { encoding: 'utf8' }).stdout.trim();
}

describe('project-local node_modules/.bin/mcode', () => {
  posixOnly('follows an npm-style symlink from a nested working directory to the JS entry', () => {
    const { root, entry, bin } = project();
    symlinkSync(join('..', '@scope', 'any-mcode-cli', 'dist', 'index.js'), join(bin, 'mcode'));
    const nested = join(root, 'packages', 'app', 'src');
    mkdirSync(nested, { recursive: true });

    const cli = resolveCli({ env: { PATH: '' }, packageSearchFrom: [], projectSearchFrom: nested });

    // Symlinks resolve to the real path (macOS temp dirs live under /private).
    expect(cli).toEqual({ kind: 'node', path: realpathSync(entry), source: 'project' });
    expect(versionOf(buildSpawnCommand(cli, ['--version']))).toBe('0.7.0');
  });

  posixOnly('resolves a pnpm-style shell shim to its JS entry', () => {
    const { root, entry, bin } = project();
    const shim = join(bin, 'mcode');
    writeFileSync(
      shim,
      [
        '#!/bin/sh',
        'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
        'if [ -x "$basedir/node" ]; then',
        '  exec "$basedir/node"  "$basedir/../@scope/any-mcode-cli/dist/index.js" "$@"',
        'else',
        '  exec node  "$basedir/../@scope/any-mcode-cli/dist/index.js" "$@"',
        'fi',
      ].join('\n'),
    );
    chmodSync(shim, 0o755);

    expect(findProjectBin(root)).toEqual({ kind: 'node', path: entry, source: 'project' });
  });

  it('takes precedence over PATH but not over an installed @minimax-ai/code package', () => {
    const { root, bin } = project();
    if (process.platform === 'win32') {
      writeFileSync(
        join(bin, 'mcode.cmd'),
        '"%~dp0\\..\\@scope\\any-mcode-cli\\dist\\index.js" %*',
      );
    } else {
      symlinkSync(join('..', '@scope', 'any-mcode-cli', 'dist', 'index.js'), join(bin, 'mcode'));
    }
    const onPath = tempDir();
    writeFileSync(join(onPath, 'mcode'), '#!/bin/sh\n');
    chmodSync(join(onPath, 'mcode'), 0o755);

    expect(
      resolveCli({ env: { PATH: onPath }, packageSearchFrom: [], projectSearchFrom: root }).source,
    ).toBe('project');
    const sdkSource = new URL('../src/cli-resolver.ts', import.meta.url).href;
    expect(
      resolveCli({ env: { PATH: onPath }, packageSearchFrom: [sdkSource], projectSearchFrom: root })
        .source,
    ).toBe('package');
  });

  it('returns nothing when no ancestor has node_modules/.bin/mcode', () => {
    expect(findProjectBin(tempDir())).toBeUndefined();
  });

  it('parses Windows cmd and PowerShell shims to the JS entry', () => {
    const { entry, bin } = project();
    const cmd = join(bin, 'mcode.cmd');
    const ps1 = join(bin, 'mcode.ps1');
    expect(
      parseCmdShim('"%_prog%"  "%dp0%\\..\\@scope\\any-mcode-cli\\dist\\index.js" %*', cmd),
    ).toBe(entry);
    expect(
      parseShellShim(
        '& "$basedir/node$exe"  "$basedir/../@scope/any-mcode-cli/dist/index.js" $args',
        ps1,
      ),
    ).toBe(entry);
    expect(parseShellShim('exec "$basedir/native-mcode" "$@"', ps1)).toBeUndefined();
  });
});

/**
 * The Windows layout written by the official installer (install.ps1) and by CLI self-update
 * (packages/tui/src/update/versioned-prefix.ts): a root launcher that reads `current` and
 * calls the release launcher, which runs the CLI's JS entry with a pinned Node.js runtime.
 */
function windowsInstall(
  releases: readonly string[],
  current: string,
): { prefix: string; entry: (release: string) => string } {
  const prefix = tempDir();
  const entry = (release: string): string =>
    join(prefix, 'releases', release, 'node_modules', '@minimax-ai', 'code', 'cli.js');
  for (const release of releases) {
    mkdirSync(join(prefix, 'releases', release, 'node_modules', '@minimax-ai', 'code'), {
      recursive: true,
    });
    copyFileSync(FAKE_MCODE, entry(release));
    writeFileSync(
      join(prefix, 'releases', release, '.mcode-launcher.cmd'),
      '@ECHO off\r\n"C:\\Program Files\\nodejs\\node.exe" "%~dp0node_modules\\@minimax-ai\\code\\cli.js" %*\r\nEXIT /B %ERRORLEVEL%\r\n',
    );
  }
  writeFileSync(
    join(prefix, 'mcode.cmd'),
    '@ECHO off\r\nSETLOCAL\r\nSET /P MCODE_RELEASE=<"%~dp0current"\r\nECHO(%MCODE_RELEASE%| %SystemRoot%\\System32\\findstr.exe /R /X "[0-9A-Za-z][0-9A-Za-z._-]*" >NUL || EXIT /B 1\r\nCALL "%~dp0releases\\%MCODE_RELEASE%\\.mcode-launcher.cmd" %*\r\nEXIT /B %ERRORLEVEL%\r\n',
  );
  writeFileSync(join(prefix, 'current'), `${current}\r\n`);
  return { prefix, entry };
}

describe('official Windows installer layout', () => {
  it('follows mcode.cmd → current → .mcode-launcher.cmd to the JS entry, without a shell', () => {
    const { prefix, entry } = windowsInstall(['0.7.1'], '0.7.1');
    const options = {
      packageSearchFrom: [],
      projectSearchFrom: tempDir(),
      platform: 'win32' as const,
    };

    const viaPath = resolveCli({ env: { PATH: prefix, PATHEXT: '.cmd' }, ...options });
    const viaBin = resolveCli({ bin: join(prefix, 'mcode.cmd'), env: {}, ...options });

    for (const cli of [viaPath, viaBin]) {
      expect(cli).toMatchObject({
        kind: 'node',
        path: entry('0.7.1'),
        launcher: join(prefix, 'mcode.cmd'),
      });
      expect(buildSpawnCommand(cli, ['--version'])).toEqual({
        command: process.execPath,
        args: [entry('0.7.1'), '--version'],
      });
    }
  });

  it('re-reads the current release for every spawn, so a self-update is picked up', () => {
    const { prefix, entry } = windowsInstall(['0.7.1', '0.7.2'], '0.7.1');
    const cli = resolveCli({ bin: join(prefix, 'mcode.cmd'), env: {}, platform: 'win32' });
    writeFileSync(join(prefix, 'current'), '0.7.2\r\n');

    expect(buildSpawnCommand(cli, ['exec']).args[0]).toBe(entry('0.7.2'));

    writeFileSync(join(prefix, 'current'), '..\\outside\r\n');
    expect(() => buildSpawnCommand(cli, ['exec'])).toThrow(/no longer points to a usable release/u);
  });

  it('asks for bin, not an install, when an installed launcher cannot be followed', () => {
    const { prefix } = windowsInstall(['0.7.1'], '../escape');
    const error = (() => {
      try {
        resolveCli({ bin: join(prefix, 'mcode.cmd'), env: {}, platform: 'win32' });
      } catch (caught) {
        return caught as Error;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(MCodeNotFoundError);
    expect(error?.message).toMatch(
      /could not determine the JS entry it runs\. Pass the CLI's JS entry as `bin`\.$/u,
    );
    expect(error?.message).not.toMatch(/npm install|mcode\.exe/u);
  });
});
