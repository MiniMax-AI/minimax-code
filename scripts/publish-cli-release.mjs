import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionFromTag, cliReleaseTargets } from './lib/cli-release.mjs';

export function validateReleaseReports({ archive, reports, version, revision }) {
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  assert.equal(readFileSync(`${archive}.sha256`, 'utf8'), `${sha256}  ${path.basename(archive)}\n`);
  for (const target of cliReleaseTargets) {
    const directory = path.join(reports, `cli-install-${target.os}-${target.node}`);
    const installation = JSON.parse(readFileSync(path.join(directory, 'package-install.json'), 'utf8'));
    const verification = JSON.parse(readFileSync(path.join(directory, 'verification.json'), 'utf8'));
    assert.equal(verification.status, 'PASS');
    assert.equal(verification.profile, 'package');
    assert.equal(verification.revision, revision);
    assert.equal(verification.gates.find(gate => gate.name === 'test:release-package')?.status, 'PASS');
    assert.equal(installation.status, 'PASS');
    assert.equal(installation.version, version);
    assert.equal(installation.revision, revision);
    assert.equal(installation.sha256, sha256);
    assert.equal(installation.platform, target.os.startsWith('ubuntu') ? 'linux' : 'darwin');
    assert.ok(installation.node === `v${target.node}` || installation.node.startsWith(`v${target.node}.`));
  }
  return sha256;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.env.MCODE_RELEASE_TAG;
  const version = versionFromTag(tag);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!process.env.MCODE_RELEASE_DIRECTORY || !process.env.MCODE_RELEASE_REPORTS) throw new Error('Release directory and reports are required.');
  const archive = path.join(process.env.MCODE_RELEASE_DIRECTORY, `minimax-code-${version}.tar.gz`);
  const sha256 = validateReleaseReports({ archive, reports: process.env.MCODE_RELEASE_REPORTS, version, revision });
  const notes = path.join(process.env.MCODE_RELEASE_DIRECTORY, 'release-notes.md');
  writeFileSync(notes, `Built from public source commit ${revision}. SHA-256: \`${sha256}\`.

Download the tar.gz and its checksum, verify the checksum, then install:

\`\`\`sh
npm install --global ./minimax-code-${version}.tar.gz --registry=https://registry.npmjs.org/ --include=optional --ignore-scripts=false --allow-scripts=better-sqlite3
mcode --version
\`\`\`

Requires Node.js 22.19+ (22.x), 24.2+ (24.x), 25 or 26 and network access to public npm for runtime dependencies. Native dependencies may require a C/C++ toolchain and Python when no prebuilt binary is available.

The same archive passed npm installation and offline CLI/BYOK tests on Linux and macOS across the supported Node lines. Windows and live-service acceptance were not run. This package shares the official npm CLI's package name and user data. Install future GitHub archives explicitly; the built-in updater follows the npm registry channel.
`);
  // An existing release is never overwritten. Upload to a draft so failures
  // cannot expose a release with missing assets; maintainers can inspect/retry.
  const gh = (...args) => execFileSync('gh', args, { stdio: 'inherit' });
  gh('release', 'create', tag, '--verify-tag', '--draft', '--title', `MiniMax Code ${version}`, '--notes-file', notes, ...(version.includes('-') ? ['--prerelease'] : []));
  gh('release', 'upload', tag, archive, `${archive}.sha256`);
  gh('release', 'edit', tag, '--draft=false');
}
