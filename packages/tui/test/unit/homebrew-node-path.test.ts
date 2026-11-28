import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stableHomebrewNodeToolchainPath } from '../../src/update/homebrew-node-path.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createBrew(prefixParts: readonly string[], formula: string, version: string) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mcode-brew-path-')));
  roots.push(root);
  const prefix = path.join(root, ...prefixParts);
  const keg = path.join(prefix, 'Cellar', formula, version);
  const npmCli = path.join(keg, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  mkdirSync(path.join(keg, 'bin'), { recursive: true });
  mkdirSync(path.dirname(npmCli), { recursive: true });
  writeFileSync(path.join(keg, 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(npmCli, '#!/usr/bin/env node\n', { mode: 0o755 });
  symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', path.join(keg, 'bin', 'npm'));
  mkdirSync(path.join(prefix, 'opt'), { recursive: true });
  symlinkSync(path.join('..', 'Cellar', formula, version), path.join(prefix, 'opt', formula));
  return { root, prefix, keg, opt: path.join(prefix, 'opt', formula) };
}

describe('stable Homebrew Node toolchain paths', () => {
  it('maps a live Linuxbrew keg-only node and npm to the formula opt path', () => {
    const brew = createBrew(['home', 'linuxbrew', '.linuxbrew'], 'node@24', '24.21.0_2');
    expect(stableHomebrewNodeToolchainPath(path.join(brew.keg, 'bin', 'node'))).toBe(
      path.join(brew.opt, 'bin', 'node'),
    );
    // npm keeps its command name instead of becoming npm-cli.js.
    expect(stableHomebrewNodeToolchainPath(path.join(brew.keg, 'bin', 'npm'))).toBe(
      path.join(brew.opt, 'bin', 'npm'),
    );
    expect(stableHomebrewNodeToolchainPath(path.join(brew.opt, 'bin', 'node'))).toBe(
      path.join(brew.opt, 'bin', 'node'),
    );
  });

  it('maps a linked bin/node under any Homebrew prefix to the formula opt path', () => {
    const brew = createBrew(['custom-brew'], 'node', '26.7.0');
    mkdirSync(path.join(brew.prefix, 'bin'));
    symlinkSync('../Cellar/node/26.7.0/bin/node', path.join(brew.prefix, 'bin', 'node'));
    symlinkSync('../Cellar/node/26.7.0/bin/npm', path.join(brew.prefix, 'bin', 'npm'));
    expect(stableHomebrewNodeToolchainPath(path.join(brew.prefix, 'bin', 'node'))).toBe(
      path.join(brew.opt, 'bin', 'node'),
    );
    // Linked npm resolves to npm-cli.js; keep the stable command instead of rewriting it.
    expect(stableHomebrewNodeToolchainPath(path.join(brew.prefix, 'bin', 'npm'))).toBe(
      path.join(brew.prefix, 'bin', 'npm'),
    );
  });

  it('heals a keg removed by brew upgrade to the same formula opt path only', () => {
    const brew = createBrew(['home', 'linuxbrew', '.linuxbrew'], 'node@24', '24.21.0_3');
    const removedKeg = path.join(brew.prefix, 'Cellar', 'node@24', '24.21.0_2');
    expect(stableHomebrewNodeToolchainPath(path.join(removedKeg, 'bin', 'node'))).toBe(
      path.join(brew.opt, 'bin', 'node'),
    );
    expect(stableHomebrewNodeToolchainPath(path.join(removedKeg, 'bin', 'npm'))).toBe(
      path.join(brew.opt, 'bin', 'npm'),
    );
    const otherFormula = path.join(brew.prefix, 'Cellar', 'node@22', '22.19.0', 'bin', 'node');
    expect(stableHomebrewNodeToolchainPath(otherFormula)).toBe(otherFormula);
  });

  it('leaves version-manager and managed runtimes unchanged', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mcode-brew-path-')));
    roots.push(root);
    const nvmNode = path.join(root, '.nvm', 'versions', 'node', 'v24.21.0', 'bin', 'node');
    mkdirSync(path.dirname(nvmNode), { recursive: true });
    writeFileSync(nvmNode, '#!/bin/sh\n', { mode: 0o755 });
    expect(stableHomebrewNodeToolchainPath(nvmNode)).toBe(nvmNode);
    expect(stableHomebrewNodeToolchainPath('C:\\Program Files\\nodejs\\node.exe')).toBe(
      'C:\\Program Files\\nodejs\\node.exe',
    );
  });
});
