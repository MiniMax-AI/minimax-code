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

import {
  isReleaseRehearsal,
  NPMJS_REGISTRY,
  NPMJS_TARGET_ARGS,
  normalizeRegistry,
  PACKAGE_SCOPE,
  PACKAGE_TEXT_RULES,
  releaseClosingLines,
  resolveTool,
  scopedRegistryProblem,
  tarballProblems,
  textLabels,
} from './release-tools.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageDir, '../..');
// Shared with `check:source`. Dynamic import keeps this repository file out of the SDK typecheck
// root. The script runs only inside the checkout, never from the published package.
const { embeddedCredential, internalSourceReference } = await import(
  pathToFileURL(path.join(repoRoot, 'scripts/lib/public-text-policy.mjs')).href
);
const textRules = [
  ['internal source reference', internalSourceReference],
  ['embedded credential', embeddedCredential],
  ...PACKAGE_TEXT_RULES,
];
const REGISTRY = NPMJS_REGISTRY;
const RELEASE_BRANCH = 'main';
const PUBLISHED_FILES = ['dist', 'src', 'README.md', 'CHANGELOG.md'];

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

function run(tool, commandArgs, { cwd = repoRoot, capture = false, allowFailure = false } = {}) {
  let resolved;
  try {
    resolved = resolveTool(tool);
  } catch (error) {
    fail(error.message);
  }
  // Never through a shell: arguments such as the smoke-test script and temporary paths are
  // passed to the process verbatim on every platform.
  const result = spawnSync(resolved.command, [...resolved.args, ...commandArgs], {
    cwd,
    encoding: 'utf8',
    stdio: capture || allowFailure ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`${tool} could not be started: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    fail(
      `${tool} ${commandArgs.join(' ')} failed${capture ? `: ${`${result.stdout}${result.stderr}`.trim()}` : ''}`,
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

step('npm registry configuration');
const npmConfig = (key) =>
  normalizeRegistry(run('npm', ['config', 'get', key], { cwd: packageDir, capture: true }).stdout);
const scopedRegistry = npmConfig(`${PACKAGE_SCOPE}:registry`);
const defaultRegistry = npmConfig('registry');
const registryProblem = scopedRegistryProblem(scopedRegistry);
if (registryProblem) fail(registryProblem);
console.log(
  `✓ ${PACKAGE_SCOPE}:registry ${scopedRegistry || 'is not set'}; default registry ${defaultRegistry || 'is not set'}` +
    ` (npm commands below pin ${NPMJS_TARGET_ARGS.join(' ')})`,
);

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
  const view = run('npm', ['view', spec, 'version', ...NPMJS_TARGET_ARGS], {
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
run('node', ['scripts/run-vitest-suite.mjs', 'code-sdk']);

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
const packedEntries = tarballProblems(entries);
if (packedEntries.unexpected.length) {
  fail(`Unexpected tarball entries: ${packedEntries.unexpected.join(', ')}`);
}
if (packedEntries.missing.length) {
  fail(`Missing tarball entries: ${packedEntries.missing.join(', ')}`);
}
const extracted = path.join(outDir, 'extracted');
mkdirSync(extracted);
run('tar', ['-xzf', tarball, '-C', extracted]);
const findings = [];
for (const file of listFiles(path.join(extracted, 'package'))) {
  const text = readFileSync(file, 'utf8');
  for (const label of textLabels(text, textRules)) {
    findings.push(`${path.relative(extracted, file)}: ${label}`);
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
  [
    'install',
    tarball,
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    '--no-package-lock',
    ...NPMJS_TARGET_ARGS,
  ],
  {
    cwd: project,
    capture: true,
  },
);
const smoke = run(
  'node',
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

const rehearsal = isReleaseRehearsal({
  branch,
  head,
  remoteMain,
  releaseBranch: RELEASE_BRANCH,
});
for (const line of releaseClosingLines({
  rehearsal,
  spec,
  releaseBranch: RELEASE_BRANCH,
  tarball,
  integrity,
  version,
  name,
})) {
  console.log(line);
}
