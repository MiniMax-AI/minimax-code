import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McodeUpdateApplication } from '../../src/update/application.js';
import {
  createMcodeNpmRuntimeEnvironment,
  resolveMcodeNpmPrefixInstall,
} from '../../src/update/install-source.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('npm-prefix runtime consistency', () => {
  it('normalizes Windows PATH aliases without mutating the parent environment', () => {
    const environment = { Path: 'C:\\system;C:\\tools', PATH: 'C:\\other', TOKEN: 'keep' };
    const updated = createMcodeNpmRuntimeEnvironment(
      environment,
      'C:\\mcode runtime\\node.exe',
      'win32',
    );
    expect(updated).toEqual({ PATH: 'C:\\mcode runtime;C:\\other', TOKEN: 'keep' });
    expect(environment.Path).toBe('C:\\system;C:\\tools');
    expect(environment.PATH).toBe('C:\\other');
    expect(
      createMcodeNpmRuntimeEnvironment({ Path: 'C:\\system' }, 'C:\\runtime\\node.exe', 'win32'),
    ).toEqual({ PATH: 'C:\\runtime;C:\\system' });
  });

  it('preserves non-PATH variables and supports an absent Unix PATH', () => {
    expect(
      createMcodeNpmRuntimeEnvironment(
        { Path: 'case-sensitive' },
        '/private/node/bin/node',
        'darwin',
      ),
    ).toEqual({ Path: 'case-sensitive', PATH: '/private/node/bin' });
  });

  it.each([
    [false, 'npm'],
    [true, 'npm'],
    [false, 'npm.cmd'],
  ] as const)(
    'runs npm with the launcher Node and gates activation on SQLite (broken=%s, shim=%s)',
    async (broken, shim) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'mcode-update-runtime-'));
      roots.push(root);
      const prefix = path.join(root, 'install');
      const npm = path.join(root, shim);
      const npmCli = path.join(root, 'node_modules/npm/bin/npm-cli.js');
      mkdirSync(path.dirname(npmCli), { recursive: true });
      // Neither a Unix shim nor npm.cmd may choose its own runtime.
      writeFileSync(npm, '#!/bin/sh\nexit 42\n', { mode: 0o755 });
      const shadowBin = path.join(root, 'shadow');
      mkdirSync(shadowBin);
      mkdirSync(prefix);
      writeFileSync(path.join(prefix, 'current'), '1.2.3\n');
      // If npm resolves Node from the inherited PATH, it fails before installing.
      writeFileSync(path.join(shadowBin, 'node'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
      const sqlite = broken
        ? 'module.exports = class { constructor() { throw new Error("NODE_MODULE_VERSION mismatch"); } };'
        : `module.exports = class {
            constructor(file) { if (file !== ':memory:') throw new Error('Unexpected database'); }
            prepare(sql) { if (sql !== 'SELECT 1 AS value') throw new Error('Unexpected query'); return { get: () => ({ value: 1 }) }; }
            close() {}
          };`;
      writeFileSync(
        npmCli,
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.execPath !== ${JSON.stringify(process.execPath)}) throw new Error('Wrong npm Node');
const lifecycle = require('node:child_process').spawnSync('node', ['-p', 'process.execPath'], {encoding:'utf8'});
if (lifecycle.status !== 0 || lifecycle.stdout.trim() !== process.execPath) throw new Error('Wrong lifecycle Node');
if (process.argv.includes('view')) { console.log(JSON.stringify('1.2.4')); process.exit(0); }
const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
const root = path.join(prefix, process.platform === 'win32' ? 'node_modules/@minimax-ai/code' : 'lib/node_modules/@minimax-ai/code');
fs.mkdirSync(path.join(root, 'node_modules/better-sqlite3'), { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name:'@minimax-ai/code',version:'1.2.4',bin:{mcode:'cli.js','mcode-tools':'tools.js'}}));
fs.writeFileSync(path.join(root, 'cli.js'), 'console.log("1.2.4");');
fs.writeFileSync(path.join(root, 'tools.js'), 'console.log("mcode-tools 1.2.4");');
fs.writeFileSync(path.join(root, 'node_modules/better-sqlite3/index.js'), ${JSON.stringify(sqlite)});
`,
        { mode: 0o755 },
      );
      chmodSync(npm, 0o755);
      const environment = {
        ...process.env,
        PATH: `${shadowBin}${path.delimiter}${process.env.PATH ?? ''}`,
      };
      const application = new McodeUpdateApplication(
        {
          currentVersion: '1.2.3',
          entryFile: path.join(prefix, 'missing-old-entry.js'),
          runtimeExecutable: process.execPath,
          environment,
          prefixInstall: {
            executable: npm,
            prefix,
            packageName: '@minimax-ai/code',
            registry: 'https://registry.npmjs.org/',
          },
        },
        {
          detectInstallSource: async () => 'npm-prefix',
        },
      );
      const plan = await application.inspect();
      if (broken) {
        await expect(application.apply(plan)).rejects.toThrow('Staged SQLite validation failed');
        expect(readFileSync(path.join(prefix, 'current'), 'utf8')).toBe('1.2.3\n');
      } else {
        await expect(application.apply(plan)).resolves.toMatchObject({ applied: true });
        expect(readFileSync(path.join(prefix, 'current'), 'utf8')).toBe('1.2.4\n');
        expect(
          JSON.parse(readFileSync(path.join(prefix, 'install.json'), 'utf8')).nodeExecutable,
        ).toBe(process.execPath);
      }
      expect(environment.PATH.startsWith(shadowBin)).toBe(true);
    },
  );

  it('pins npm-prefix updates to the receipt Node across Homebrew-style upgrades', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mcode-update-runtime-'));
    roots.push(root);
    const prefix = path.join(root, 'install');
    const npm = path.join(root, 'npm');
    const npmCli = path.join(root, 'node_modules/npm/bin/npm-cli.js');
    const brewBin = path.join(root, 'homebrew', 'bin');
    const pinnedNode = path.join(brewBin, 'node');
    mkdirSync(path.dirname(npmCli), { recursive: true });
    mkdirSync(brewBin, { recursive: true });
    writeFileSync(npm, '#!/bin/sh\nexit 42\n', { mode: 0o755 });
    symlinkSync(process.execPath, pinnedNode);
    const packageRoot = path.join(
      prefix,
      'releases',
      '1.2.3',
      'lib',
      'node_modules',
      '@minimax',
      'code',
    );
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@minimax-ai/code',
        version: '1.2.3',
        bin: { mcode: 'cli.js', 'mcode-tools': 'tools.js' },
      }),
    );
    writeFileSync(path.join(packageRoot, 'cli.js'), 'console.log("1.2.3");');
    writeFileSync(path.join(prefix, 'current'), '1.2.3\n');
    writeFileSync(
      path.join(prefix, 'install.json'),
      JSON.stringify({
        schemaVersion: 2,
        product: 'minimax-code',
        updateOwner: 'npm-prefix',
        packageManager: 'npm',
        packageName: '@minimax-ai/code',
        registry: 'https://registry.npmjs.org/',
        distTag: 'latest',
        npmExecutable: npm,
        nodeExecutable: pinnedNode,
        prefix,
        layoutVersion: 2,
        releasesDirectory: 'releases',
        currentFile: 'current',
      }),
    );
    writeFileSync(
      npmCli,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('view')) { console.log(JSON.stringify('1.2.4')); process.exit(0); }
const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
const root = path.join(prefix, 'lib/node_modules/@minimax-ai/code');
fs.mkdirSync(path.join(root, 'node_modules/better-sqlite3'), { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name:'@minimax-ai/code',version:'1.2.4',bin:{mcode:'cli.js','mcode-tools':'tools.js'}}));
fs.writeFileSync(path.join(root, 'cli.js'), 'console.log("1.2.4");');
fs.writeFileSync(path.join(root, 'tools.js'), 'console.log("mcode-tools 1.2.4");');
fs.writeFileSync(path.join(root, 'node_modules/better-sqlite3/index.js'), 'module.exports = class { constructor() {} prepare() { return { get: () => ({ value: 1 }) }; } close() {} };');
`,
      { mode: 0o755 },
    );

    const application = new McodeUpdateApplication(
      {
        currentVersion: '1.2.3',
        entryFile: path.join(packageRoot, 'cli.js'),
        environment: { ...process.env },
      },
      {
        detectInstallSource: async () => 'npm-prefix',
      },
    );
    await expect(application.apply(await application.inspect())).resolves.toMatchObject({
      applied: true,
    });
    expect(readFileSync(path.join(prefix, 'current'), 'utf8')).toBe('1.2.4\n');
    expect(JSON.parse(readFileSync(path.join(prefix, 'install.json'), 'utf8')).nodeExecutable).toBe(
      pinnedNode,
    );
    const releaseLauncher = path.join(prefix, 'releases', '1.2.4', '.mcode-launcher');
    const launcherContents = readFileSync(releaseLauncher, 'utf8');
    expect(launcherContents).toContain(`node='${pinnedNode}'`);
    expect(launcherContents).not.toContain(process.execPath);
    expect(spawnSync(releaseLauncher, ['--version']).stdout.toString()).toBe('1.2.4\n');

    rmSync(pinnedNode);
    const missing = spawnSync(releaseLauncher, ['--version']);
    expect(missing.status).toBe(127);
    expect(missing.stderr.toString()).toMatch(/Node runtime is missing/u);
    expect(missing.stderr.toString()).toMatch(/re-run the MCode installer/u);
  });

  it('heals receipts pinned to a Homebrew Cellar keg via the stable opt path', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mcode-update-runtime-'));
    roots.push(root);
    const brewRoot = path.join(root, 'homebrew');
    const kegNode = path.join(brewRoot, 'Cellar', 'node', '26.7.0', 'bin', 'node');
    placeNodeBinaryAt(kegNode);
    const optLink = path.join(brewRoot, 'opt', 'node');
    mkdirSync(path.dirname(optLink), { recursive: true });
    symlinkSync(path.join(brewRoot, 'Cellar', 'node', '26.7.0'), optLink);
    const optNode = path.join(optLink, 'bin', 'node');

    const result = await runNpmPrefixUpdate(root, kegNode);
    expect(result.outcome).toMatchObject({ applied: true });
    expect(result.receiptNode).toBe(optNode);
    expect(result.launcher).toContain(`node='${optNode}'`);
    expect(result.launcher).not.toContain('/Cellar/');
    const releaseLauncher = path.join(result.prefix, 'releases', '1.2.4', '.mcode-launcher');
    expect(spawnSync(releaseLauncher, ['--version']).stdout.toString()).toBe('1.2.4\n');
  });

  it('falls back to the running Node when the receipt Node is unusable', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mcode-update-runtime-'));
    roots.push(root);

    const result = await runNpmPrefixUpdate(root, path.join(root, 'removed', 'bin', 'node'));
    expect(result.outcome).toMatchObject({ applied: true });
    expect(result.receiptNode).toBe(process.execPath);
    expect(result.launcher).toContain(`node='${process.execPath}'`);
  });

  it('ignores unusable receipt Node executables and legacy receipts', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mcode-update-runtime-'));
    roots.push(root);
    const npm = path.join(root, 'npm');
    writeFileSync(npm, '#!/bin/sh\nexit 42\n', { mode: 0o755 });
    const prefix = path.join(root, 'install');
    const legacyEntry = path.join(prefix, 'lib', 'node_modules', '@minimax-ai', 'code', 'cli.js');
    const versionedEntry = path.join(
      prefix,
      'releases',
      '1.0.0',
      'lib',
      'node_modules',
      '@minimax-ai',
      'code',
      'cli.js',
    );
    for (const entry of [legacyEntry, versionedEntry]) {
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(
        path.join(path.dirname(entry), 'package.json'),
        JSON.stringify({ name: '@minimax-ai/code', version: '1.0.0' }),
      );
      writeFileSync(entry, 'console.log("1.0.0");');
    }
    const directory = path.join(root, 'directory');
    mkdirSync(directory);
    const writeReceipt = (extra: Record<string, unknown> = {}) =>
      writeFileSync(
        path.join(prefix, 'install.json'),
        JSON.stringify({
          schemaVersion: 2,
          product: 'minimax-code',
          updateOwner: 'npm-prefix',
          packageManager: 'npm',
          packageName: '@minimax-ai/code',
          registry: 'https://registry.npmjs.org/',
          distTag: 'latest',
          npmExecutable: npm,
          prefix,
          layoutVersion: 2,
          releasesDirectory: 'releases',
          currentFile: 'current',
          ...extra,
        }),
      );

    writeReceipt({ nodeExecutable: 'bin/node' });
    expect(resolveMcodeNpmPrefixInstall(versionedEntry)?.nodeExecutable).toBeUndefined();
    writeReceipt({ nodeExecutable: path.join(root, 'missing', 'node') });
    expect(resolveMcodeNpmPrefixInstall(versionedEntry)?.nodeExecutable).toBeUndefined();
    writeReceipt({ nodeExecutable: directory });
    expect(resolveMcodeNpmPrefixInstall(versionedEntry)?.nodeExecutable).toBeUndefined();

    writeFileSync(
      path.join(prefix, 'install.json'),
      JSON.stringify({
        schemaVersion: 1,
        product: 'minimax-code',
        updateOwner: 'npm-prefix',
        packageManager: 'npm',
        packageName: '@minimax-ai/code',
        registry: 'https://registry.npmjs.org/',
        distTag: 'latest',
        npmExecutable: npm,
        prefix,
      }),
    );
    const legacyInstall = resolveMcodeNpmPrefixInstall(legacyEntry);
    expect(legacyInstall).toBeDefined();
    expect(legacyInstall?.nodeExecutable).toBeUndefined();
  });
});

// Homebrew's Cellar/node/<version>/bin/node is the real binary, so the fixture
// places the running Node there via hardlink (copy fallback) to make
// process.execPath resolve inside the fake keg.
function placeNodeBinaryAt(target: string) {
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    linkSync(process.execPath, target);
  } catch {
    copyFileSync(process.execPath, target);
  }
  chmodSync(target, 0o755);
}

async function runNpmPrefixUpdate(
  root: string,
  nodeExecutable: string | undefined,
): Promise<{ prefix: string; receiptNode: unknown; launcher: string; outcome: unknown }> {
  const prefix = path.join(root, 'install');
  const npm = path.join(root, 'npm');
  const npmCli = path.join(root, 'node_modules/npm/bin/npm-cli.js');
  mkdirSync(path.dirname(npmCli), { recursive: true });
  writeFileSync(npm, '#!/bin/sh\nexit 42\n', { mode: 0o755 });
  const packageRoot = path.join(
    prefix,
    'releases',
    '1.2.3',
    'lib',
    'node_modules',
    '@minimax-ai',
    'code',
  );
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@minimax-ai/code',
      version: '1.2.3',
      bin: { mcode: 'cli.js', 'mcode-tools': 'tools.js' },
    }),
  );
  writeFileSync(path.join(packageRoot, 'cli.js'), 'console.log("1.2.3");');
  writeFileSync(path.join(prefix, 'current'), '1.2.3\n');
  writeFileSync(
    path.join(prefix, 'install.json'),
    JSON.stringify({
      schemaVersion: 2,
      product: 'minimax-code',
      updateOwner: 'npm-prefix',
      packageManager: 'npm',
      packageName: '@minimax-ai/code',
      registry: 'https://registry.npmjs.org/',
      distTag: 'latest',
      npmExecutable: npm,
      ...(nodeExecutable ? { nodeExecutable } : {}),
      prefix,
      layoutVersion: 2,
      releasesDirectory: 'releases',
      currentFile: 'current',
    }),
  );
  writeFileSync(
    npmCli,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('view')) { console.log(JSON.stringify('1.2.4')); process.exit(0); }
const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
const root = path.join(prefix, 'lib/node_modules/@minimax-ai/code');
fs.mkdirSync(path.join(root, 'node_modules/better-sqlite3'), { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name:'@minimax-ai/code',version:'1.2.4',bin:{mcode:'cli.js','mcode-tools':'tools.js'}}));
fs.writeFileSync(path.join(root, 'cli.js'), 'console.log("1.2.4");');
fs.writeFileSync(path.join(root, 'tools.js'), 'console.log("mcode-tools 1.2.4");');
fs.writeFileSync(path.join(root, 'node_modules/better-sqlite3/index.js'), 'module.exports = class { constructor() {} prepare() { return { get: () => ({ value: 1 }) }; } close() {} };');
`,
    { mode: 0o755 },
  );

  const application = new McodeUpdateApplication(
    {
      currentVersion: '1.2.3',
      entryFile: path.join(packageRoot, 'cli.js'),
      environment: { ...process.env },
    },
    {
      detectInstallSource: async () => 'npm-prefix',
    },
  );
  const outcome = await application.apply(await application.inspect());
  const receiptNode = JSON.parse(
    readFileSync(path.join(prefix, 'install.json'), 'utf8'),
  ).nodeExecutable;
  const launcher = readFileSync(path.join(prefix, 'releases', '1.2.4', '.mcode-launcher'), 'utf8');
  return { prefix, receiptNode, launcher, outcome };
}
