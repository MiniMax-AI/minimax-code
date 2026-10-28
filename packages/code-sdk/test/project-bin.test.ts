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
