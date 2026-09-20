import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cliBuildVersion, versionFromTag } from './lib/cli-release.mjs';

const versionFiles = ['package.json', 'packages/tui/package.json'];

export function compareVersions(left, right) {
  versionFromTag(`v${left}`); versionFromTag(`v${right}`);
  const parse = version => {
    const index = version.indexOf('-');
    return { core: (index < 0 ? version : version.slice(0, index)).split('.').map(BigInt),
      pre: index < 0 ? undefined : version.slice(index + 1).split('.') };
  };
  const a = parse(left), b = parse(right);
  const compare = (x, y) => x === y ? 0 : x > y ? 1 : -1;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return compare(a.core[i], b.core[i]);
  if (!a.pre || !b.pre) return compare(a.pre ? 0 : 1, b.pre ? 0 : 1);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^[0-9]+$/.test(x), ny = /^[0-9]+$/.test(y);
    return nx && ny ? compare(BigInt(x), BigInt(y)) : nx !== ny ? (nx ? -1 : 1) : compare(x, y);
  }
  return 0;
}

function githubCli(root) {
  for (const command of ['gh-axi', 'gh']) {
    try {
      execFileSync(command, ['--help'], { cwd: root, stdio: 'ignore' });
      return command;
    } catch { /* Try the standard GitHub CLI when the wrapper is unavailable. */ }
  }
  throw new Error('Install and authenticate gh (or gh-axi) to create the version PR.');
}

function createVersionPullRequest({ root, branch, version, tag }) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'mcode-version-pr-'));
  try {
    const body = path.join(temporary, 'body.md');
    writeFileSync(body, `Update the root and TUI source versions to ${version}.\n\nTag \`${tag}\` points to this version commit. The tag-triggered CLI release workflow builds and validates the npm installation archive. Merge this PR to carry the released source version back to main; do not move or recreate the release tag.\n`);
    execFileSync(githubCli(root), ['pr', 'create', '--base', 'main', '--head', branch,
      '--title', `chore: release MiniMax Code ${version}`, '--body-file', body], { cwd: root, stdio: 'inherit' });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function releaseCli({ root, version, dryRun = false, openPullRequest = createVersionPullRequest }) {
  const tag = `v${version}`;
  versionFromTag(tag);
  const branch = `release/${tag}`;
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git('status', '--porcelain')) throw new Error('Release requires a clean working tree, including untracked files.');
  const current = cliBuildVersion(root, null);
  if (compareVersions(version, current) <= 0) throw new Error(`Release version must be newer than ${current}.`);
  git('fetch', '--no-tags', 'origin', 'main');
  const base = git('rev-parse', 'HEAD');
  if (base !== git('rev-parse', 'refs/remotes/origin/main')) throw new Error('Start the release from the latest origin/main commit.');
  for (const ref of [`refs/tags/${tag}`, `refs/heads/${branch}`]) {
    let exists = false;
    try { git('show-ref', '--verify', '--quiet', ref); exists = true; } catch (error) { if (error.status !== 1) throw error; }
    if (exists) throw new Error(`Release ref already exists locally: ${ref}`);
  }
  if (git('ls-remote', 'origin', `refs/tags/${tag}`, `refs/heads/${branch}`)) throw new Error('Release tag or branch already exists on origin.');
  const plan = { current, version, tag, branch, base, files: versionFiles };
  console.log(JSON.stringify({ ...plan, dryRun }, null, 2));
  if (dryRun) return plan;
  // Fail before making local commits if the required PR client is unavailable.
  if (openPullRequest === createVersionPullRequest)
    execFileSync(githubCli(root), ['api', 'user', '--jq', '.login'], { cwd: root, stdio: 'ignore' });
  git('switch', '-c', branch);
  for (const name of versionFiles) {
    const file = path.join(root, name);
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.version = version;
    writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  }
  git('add', '--', ...versionFiles);
  git('commit', '-m', `chore: release MiniMax Code ${version}`);
  if (git('status', '--porcelain')) throw new Error('Working tree changed during the version commit; inspect it before tagging.');
  if (git('diff', '--name-only', base, 'HEAD') !== [...versionFiles].sort().join('\n')) throw new Error('Version commit must change only the two package manifests.');
  cliBuildVersion(root, tag);
  git('tag', '-a', tag, '-m', `MiniMax Code ${version}`);
  // Push both refs or neither. Never force an existing tag or update main.
  git('push', '--atomic', '--set-upstream', 'origin', `refs/heads/${branch}:refs/heads/${branch}`, `refs/tags/${tag}:refs/tags/${tag}`);
  console.log(`Pushed ${branch} and ${tag}; CI will build and publish the archive after validation.`);
  openPullRequest({ root, branch, version, tag });
  return { ...plan, revision: git('rev-parse', 'HEAD') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { version: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
  if (!values.version) throw new Error('Usage: pnpm release:cli --version X.Y.Z [--dry-run]');
  releaseCli({ root: fileURLToPath(new URL('../', import.meta.url)), version: values.version, dryRun: values['dry-run'] });
}
