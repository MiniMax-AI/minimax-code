import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionFromTag } from './lib/cli-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = versionFromTag(process.env.MCODE_RELEASE_TAG);
if (!process.env.MCODE_RELEASE_ARCHIVE) throw new Error('MCODE_RELEASE_ARCHIVE is required.');
if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Package validation currently supports Linux and macOS.');
const archive = path.resolve(process.env.MCODE_RELEASE_ARCHIVE);
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
assert.equal(readFileSync(`${archive}.sha256`, 'utf8'), `${sha256}  ${path.basename(archive)}\n`, 'Release archive checksum mismatch');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const temporary = mkdtempSync(path.join(tmpdir(), 'mcode-package-install-'));
try {
  // No global install or real user profile is modified. Dependencies and the
  // generated npm launcher must resolve from this fresh installation alone.
  const prefix = path.join(temporary, 'install');
  const home = path.join(temporary, 'home');
  mkdirSync(home);
  const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    MINIMAX_DATA_DIR: path.join(home, 'data'), MAVIS_DATA_DIR: path.join(home, 'data'),
    MCODE_DISABLE_TELEMETRY: '1',
  };
  for (const name of Object.keys(env)) {
    if (/^npm_config_/i.test(name)) delete env[name];
  }
  Object.assign(env, {
    npm_config_cache: path.join(temporary, 'npm-cache'),
    npm_config_userconfig: path.join(home, '.npmrc'),
  });
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  execFileSync('npm', ['install', '--global', '--prefix', prefix,
    '--registry=https://registry.npmjs.org/', '--include=optional', '--ignore-scripts=false',
    '--allow-scripts=better-sqlite3', '--no-audit', '--no-fund', archive],
  { cwd: home, env, stdio: 'inherit', timeout: 300000 });
  const installed = path.join(prefix, 'lib/node_modules/@minimax-ai/code');
  const release = JSON.parse(readFileSync(path.join(installed, 'release.json'), 'utf8'));
  assert.equal(release.version, version);
  assert.equal(release.tag, process.env.MCODE_RELEASE_TAG);
  assert.equal(release.revision, revision);
  const result = execFileSync(path.join(prefix, 'bin/mcode'), ['--version'], { cwd: home, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.trim(), version);
  const require = createRequire(path.join(installed, 'package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  try { assert.equal(db.prepare('select 42 as value').get().value, 42); } finally { db.close(); }
  assert.match(execFileSync(require('@vscode/ripgrep').rgPath, ['--version'], { encoding: 'utf8' }), /ripgrep/);
  execFileSync(process.execPath, ['--test', 'test/smoke.test.mjs', 'test/byok.test.mjs'], {
    cwd: root, env: { ...env, MCODE_TEST_CLI: path.join(installed, 'cli.js') }, stdio: 'inherit', timeout: 240000,
  });
  if (process.env.MCODE_VERIFY_REPORT_DIR) {
    mkdirSync(process.env.MCODE_VERIFY_REPORT_DIR, { recursive: true });
    writeFileSync(path.join(process.env.MCODE_VERIFY_REPORT_DIR, 'package-install.json'), JSON.stringify({
      status: 'PASS', version, revision, sha256, platform: process.platform, arch: process.arch, node: process.version,
    }, null, 2) + '\n');
  }
  console.log(`Verified npm installation of ${path.basename(archive)} (${sha256}).`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
