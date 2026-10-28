#!/usr/bin/env node
/**
 * Pre-publication check for @minimax-ai/code-sdk. It never publishes: on success it prints the
 * `npm publish` command for a maintainer to run. See ../RELEASING.md.
 *
 *   pnpm --filter @minimax-ai/code-sdk run release:check
 *   pnpm --filter @minimax-ai/code-sdk run release:check -- --allow-non-main   # rehearsal only
 *   pnpm --filter @minimax-ai/code-sdk run release:check -- --offline          # skip npm lookup
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageDir, '../..');
// The repository's own publication rules (also used by `check:source`); this script runs only
// inside the repository checkout, never from the published package.
const { embeddedCredential, internalSourceReference } = await import(
  pathToFileURL(path.join(repoRoot, 'scripts/lib/public-text-policy.mjs')).href
);
const REGISTRY = 'https://registry.npmjs.org/';
const RELEASE_BRANCH = 'main';
const PUBLISHED_FILES = ['dist', 'src', 'README.md', 'CHANGELOG.md'];
const ALLOWED_ENTRY =
  /^package\/(?:package\.json|README\.md|CHANGELOG\.md|LICENSE|(?:dist|src)\/[^/]+\.(?:js|js\.map|d\.ts|d\.ts\.map|ts))$/u;
const REQUIRED_ENTRIES = [
  'package/package.json',
  'package/README.md',
  'package/CHANGELOG.md',
  'package/LICENSE',
  'package/dist/index.js',
  'package/dist/index.d.ts',
];
/** Published text must not point into the repository, at a local machine, or at private names. */
const PUBLIC_TEXT_RULES = [
  ['internal source reference', internalSourceReference],
  ['embedded credential', embeddedCredential],
  ['local user path', /(?:\/Users\/|[A-Za-z]:\\Users\\)/u],
  ['repository package path', /\b(?:packages\/(?!code-sdk\b)[\w.-]+|third_party)\//u],
  ['internal package name', /@minimax\/code\b|@mavis\//u],
];

const args = new Set(process.argv.slice(2).filter((arg) => arg !== '--'));
for (const arg of args) {
  if (!['--allow-non-main', '--offline'].includes(arg)) fail(`Unknown option: ${arg}`);
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

function run(command, commandArgs, { cwd = repoRoot, capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    stdio: capture || allowFailure ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) {
    fail(
      `${command} ${commandArgs.join(' ')} failed${capture ? `: ${`${result.stdout}${result.stderr}`.trim()}` : ''}`,
    );
  }
  return result;
}

function git(commandArgs) {
  return run('git', commandArgs, { capture: true }).stdout.trim();
}

function listFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
const { name, version } = manifest;
const spec = `${name}@${version}`;

step('Checkout');
const status = git(['status', '--porcelain']);
if (status) fail(`The working tree must be clean; found: ${status.split('\n')[0]}`);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const head = git(['rev-parse', 'HEAD']);
const remoteMain = run('git', ['rev-parse', '--verify', '--quiet', `origin/${RELEASE_BRANCH}`], {
  capture: true,
  allowFailure: true,
}).stdout.trim();
if (branch !== RELEASE_BRANCH || head !== remoteMain) {
  const detail = `on ${branch} at ${head.slice(0, 12)}; origin/${RELEASE_BRANCH} is ${remoteMain.slice(0, 12) || 'unknown'}`;
  if (!args.has('--allow-non-main')) {
    fail(`Release from an up-to-date ${RELEASE_BRANCH} (git fetch first): ${detail}`);
  }
  console.log(`! Rehearsal only (--allow-non-main): ${detail}`);
} else {
  console.log(`✓ Clean ${RELEASE_BRANCH} at ${head}, equal to origin/${RELEASE_BRANCH}`);
}

step('Version and manifest');
if (!/^\d+\.\d+\.\d+$/u.test(version)) fail(`${name} version must be X.Y.Z, got ${version}`);
const changelog = readFileSync(path.join(packageDir, 'CHANGELOG.md'), 'utf8');
const firstRelease = /^## (\S+) · \d{4}-\d{2}-\d{2}$/mu.exec(changelog)?.[1];
if (firstRelease !== version) {
  fail(
    `CHANGELOG.md must start with "## ${version} · YYYY-MM-DD"; found ${firstRelease ?? 'nothing'}`,
  );
}
if (manifest.private) fail('package.json must not be private');
if (manifest.publishConfig?.registry !== REGISTRY || manifest.publishConfig?.access !== 'public') {
  fail(`publishConfig must be { access: "public", registry: "${REGISTRY}" }`);
}
if (JSON.stringify(manifest.files) !== JSON.stringify(PUBLISHED_FILES)) {
  fail(`files must be ${JSON.stringify(PUBLISHED_FILES)}`);
}
if (Object.keys(manifest.dependencies ?? {}).length > 0)
  fail('The SDK must not have runtime dependencies');
console.log(`✓ ${spec}, CHANGELOG first section ${firstRelease}, publishConfig → ${REGISTRY}`);

if (args.has('--offline')) {
  console.log('! Skipped the npm registry lookup (--offline)');
} else {
  const view = run('npm', ['view', spec, 'version', '--registry', REGISTRY], {
    capture: true,
    allowFailure: true,
  });
  if (view.status === 0 && view.stdout.trim() === version) {
    fail(`${spec} is already published; published versions cannot be replaced, bump the version`);
  }
  if (view.status !== 0 && !/E404|404 Not Found/u.test(`${view.stdout}${view.stderr}`)) {
    fail(`Could not query ${REGISTRY}: ${`${view.stdout}${view.stderr}`.trim()}`);
  }
  console.log(`✓ ${spec} is not yet on ${REGISTRY}`);
}

step('Build, type check and tests');
run('pnpm', ['--filter', name, 'run', 'build']);
run('pnpm', ['--filter', name, 'run', 'typecheck']);
run(process.execPath, ['scripts/run-vitest-suite.mjs', 'code-sdk']);

step('Pack and scan the tarball');
const outDir = mkdtempSync(path.join(tmpdir(), 'code-sdk-release-'));
const packed = JSON.parse(
  run('npm', ['pack', '--json', '--pack-destination', outDir], { cwd: packageDir, capture: true })
    .stdout,
)[0];
const tarball = path.join(outDir, packed.filename);
const entries = run('tar', ['-tzf', tarball], { capture: true })
  .stdout.split(/\r?\n/u)
  .filter((entry) => entry && !entry.endsWith('/'));
const unexpected = entries.filter(
  (entry) => !ALLOWED_ENTRY.test(entry) || entry.split('/').includes('..'),
);
if (unexpected.length) fail(`Unexpected tarball entries: ${unexpected.join(', ')}`);
const missing = REQUIRED_ENTRIES.filter((entry) => !entries.includes(entry));
if (missing.length) fail(`Missing tarball entries: ${missing.join(', ')}`);
const extracted = path.join(outDir, 'extracted');
mkdirSync(extracted);
run('tar', ['-xzf', tarball, '-C', extracted]);
const findings = [];
for (const file of listFiles(path.join(extracted, 'package'))) {
  const text = readFileSync(file, 'utf8');
  for (const [label, pattern] of PUBLIC_TEXT_RULES) {
    if (pattern.test(text)) findings.push(`${path.relative(extracted, file)}: ${label}`);
  }
}
if (findings.length)
  fail(`The tarball would publish private information:\n  ${findings.join('\n  ')}`);
const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
console.log(`✓ ${entries.length} files, all within the public surface and free of private text`);
console.log(`✓ ${packed.filename} ${integrity}`);

step('Install smoke test from the tarball');
const project = path.join(outDir, 'smoke');
mkdirSync(project);
writeFileSync(path.join(project, 'package.json'), '{"name":"code-sdk-smoke","private":true}\n');
run(
  'npm',
  ['install', tarball, '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock'],
  {
    cwd: project,
    capture: true,
  },
);
const smoke = run(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `const esm = await import('${name}');
     const { createRequire } = await import('node:module');
     const cjs = createRequire(process.cwd() + '/package.json')('${name}');
     for (const api of [esm, cjs]) {
       if (typeof api.MCode !== 'function' || typeof api.MIN_CLI_VERSION !== 'string') process.exit(1);
     }
     console.log('import and require OK');`,
  ],
  { cwd: project, capture: true },
);
console.log(`✓ ${smoke.stdout.trim()}`);

const rehearsal = branch !== RELEASE_BRANCH || head !== remoteMain;
console.log(
  rehearsal
    ? `\n! Rehearsal passed for ${spec}. Do not publish this tarball: release from an up-to-date ${RELEASE_BRANCH}.`
    : `\n✓ ${spec} is ready. The tarball was checked but nothing was published.`,
);
if (!rehearsal) {
  console.log('\nPublish it yourself (npm login with 2FA required):\n');
  console.log(`  npm publish ${tarball} --registry ${REGISTRY} --access public --tag latest`);
  console.log(
    `\nThen read it back:\n\n  npm view ${spec} version dist.integrity --registry ${REGISTRY}   # expect ${integrity}`,
  );
  console.log(`  npm view ${name} dist-tags --registry ${REGISTRY}   # expect latest: ${version}`);
}
