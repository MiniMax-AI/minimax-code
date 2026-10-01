import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c as createTar } from 'tar';
import { cliBuildVersion, cliExternalModules } from './lib/cli-release.mjs';
import { readExtraction, dependencyLicensesPath } from './lib/release-metadata.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function resolvePackage(name, importer) {
  const require = createRequire(path.join(importer, 'package.json'));
  for (const search of require.resolve.paths(`${name}/package.json`) ?? []) {
    const candidate = path.join(search, name);
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
  }
  return undefined;
}

function copyLicenses(stage) {
  const licenses = path.join(stage, 'licenses');
  mkdirSync(licenses);
  for (const name of ['LICENSE', 'NOTICE', 'LICENSE-STATUS.md', 'THIRD_PARTY_NOTICES.md']) copyFileSync(path.join(root, name), path.join(stage, name));
  copyFileSync(path.join(root, dependencyLicensesPath), path.join(licenses, 'dependency-licenses.json'));
  for (const directory of ['third_party/pi-mono', 'third_party/sandbox-runtime']) {
    copyFileSync(path.join(root, directory, 'LICENSE'), path.join(licenses, `${path.basename(directory)}-LICENSE`));
  }
  const metafile = json(path.join(root, 'dist/metafile.json'));
  const packageRoots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.includes('node_modules/')) continue;
    let directory = path.dirname(path.resolve(root, input));
    while (directory !== path.dirname(directory)) {
      const manifest = path.join(directory, 'package.json');
      if (existsSync(manifest) && json(manifest).name) break;
      directory = path.dirname(directory);
    }
    if (existsSync(path.join(directory, 'package.json'))) packageRoots.add(realpathSync(directory));
  }
  for (const directory of [...packageRoots].sort()) {
    const manifest = json(path.join(directory, 'package.json'));
    const target = path.join(licenses, `${manifest.name.replaceAll('/', '+')}@${manifest.version}`);
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(directory).filter(name => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name))) {
      cpSync(path.join(directory, name), path.join(target, name), { recursive: true });
    }
  }
}

export function releaseManifest(importers, version) {
  const dependencies = {}, optionalDependencies = {};
  for (const name of cliExternalModules) {
    const versions = new Set(importers.map(importer => resolvePackage(name, importer)).filter(Boolean)
      .map(directory => json(path.join(directory, 'package.json')).version));
    if (versions.size !== 1) throw new Error(`Expected one installed version for ${name}, found ${[...versions]}`);
    const target = name === '@mariozechner/clipboard' ? optionalDependencies : dependencies;
    target[name] = [...versions][0];
  }
  return {
    name: '@minimax-ai/code', version, private: true, type: 'module', license: 'MIT',
    description: 'MiniMax Code CLI built from the tagged public source.',
    bin: { mcode: 'cli.js' },
    engines: json(path.join(root, 'package.json')).engines,
    repository: { type: 'git', url: 'https://github.com/MiniMax-AI/minimax-code.git' },
    dependencies, optionalDependencies,
  };
}

export async function packageCliRelease({ tag, out }) {
  const version = cliBuildVersion(root, tag);
  const dist = path.join(root, 'dist');
  if (json(path.join(dist, 'package.json')).version !== version) throw new Error('Build version does not match the release tag. Build with MCODE_RELEASE_TAG first.');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Packaging requires a clean committed working tree.');
  if (json(path.join(dist, 'package.json')).gitHead !== revision) throw new Error('Build revision does not match HEAD. Rebuild with MCODE_RELEASE_TAG.');
  const temporary = mkdtempSync(path.join(tmpdir(), 'mcode-release-'));
  try {
    const stage = path.join(temporary, 'package');
    cpSync(dist, stage, { recursive: true, filter: file => path.basename(file) !== 'metafile.json' });
    const manifest = releaseManifest(readExtraction(root).packageRoots.map(directory => path.join(root, directory)), version);
    writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    copyLicenses(stage);
    writeFileSync(path.join(stage, 'release.json'), JSON.stringify({ version, tag, revision, buildNode: process.version }, null, 2) + '\n');
    writeFileSync(path.join(stage, 'README.md'), `# MiniMax Code ${version}

Built from https://github.com/MiniMax-AI/minimax-code/tree/${revision}.
Install this tar.gz with npm. Node.js must satisfy the package engines requirement.
Keep optional dependencies enabled and allow better-sqlite3 installation scripts.
Update by installing a newer GitHub release archive; the built-in updater follows npm.
The archive uses the same package name, mcode command and user data as the official npm CLI.
See https://github.com/MiniMax-AI/minimax-code/blob/${revision}/docs/installation.md.
`);
    mkdirSync(out, { recursive: true });
    const archive = path.join(out, `minimax-code-${version}.tar.gz`);
    if (existsSync(archive) || existsSync(`${archive}.sha256`)) throw new Error(`Output already exists: ${archive}`);
    await createTar({ file: archive, gzip: true, cwd: temporary, portable: true }, ['package']);
    writeFileSync(`${archive}.sha256`, `${digest(readFileSync(archive))}  ${path.basename(archive)}\n`, { flag: 'wx' });
    console.log(archive);
    return archive;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, out] = process.argv.slice(2);
  if (!tag || !out) throw new Error('Usage: node scripts/package-cli-release.mjs vX.Y.Z /path/to/output');
  await packageCliRelease({ tag, out: path.resolve(out) });
}
