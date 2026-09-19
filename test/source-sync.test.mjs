import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { prepareSourceSync } from '../scripts/prepare-source-sync.mjs';
import { extractionPath, inventoryPath } from '../scripts/lib/release-metadata.mjs';
import { extractSourceArchive } from '../scripts/lib/source-archive.mjs';
import { classifyChanges } from '../scripts/ci-changes.mjs';
import { suiteInventoryViolations } from '../scripts/lib/vitest-suites.mjs';
import { Header } from 'tar';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'source-sync-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = path.join(home, 'source'), root = path.join(home, 'public');
  mkdirSync(path.join(source, 'packages/example'), { recursive: true });
  mkdirSync(path.join(root, path.dirname(extractionPath)), { recursive: true });
  mkdirSync(path.join(root, 'packages/example'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const write = (base, name, text) => writeFileSync(path.join(base, 'packages/example', name), text);
  write(source, 'a.txt', 'first\nsecond\nthird\nfourth\nfifth\n');
  write(source, 'delete.txt', 'old\n');
  git('add', 'packages/example/a.txt', 'packages/example/delete.txt'); git('-c', 'core.hooksPath=', 'commit', '-m', 'Fixture baseline');
  const baseline = git('rev-parse', 'HEAD');
  for (const name of ['a.txt', 'delete.txt']) write(root, name, readFileSync(path.join(source, 'packages/example', name)));
  writeFileSync(path.join(root, extractionPath), JSON.stringify({ sourceRevision: baseline, packageRoots: ['packages/example'] }));
  writeFileSync(path.join(root, inventoryPath), JSON.stringify({ files: ['packages/example/a.txt', 'packages/example/delete.txt'] }));
  return { source, root, out: path.join(home, 'review'), ref: 'HEAD', git, write };
}

test('sync proposes updates/deletions, reports unlisted files and does not mutate public source', t => {
  const f = fixture(t);
  f.write(f.source, 'a.txt', 'new\n'); f.write(f.source, 'new.txt', 'unreviewed\n');
  f.git('rm', 'packages/example/delete.txt');
  f.git('add', 'packages/example/a.txt', 'packages/example/new.txt'); f.git('-c', 'core.hooksPath=', 'commit', '-m', 'Fixture change');
  const before = readFileSync(path.join(f.root, 'packages/example/a.txt'));
  const result = prepareSourceSync(f);
  assert.deepEqual(result.entries.map(e => e.status), ['update-candidate', 'delete-candidate', 'unlisted-source-review']);
  assert.deepEqual(readFileSync(path.join(f.root, 'packages/example/a.txt')), before);
  assert.equal(existsSync(path.join(f.out, 'candidates/packages/example/new.txt')), false);
  assert.equal(readFileSync(path.join(f.out, 'candidates/packages/example/a.txt'), 'utf8'), 'new\n');
});

test('three-way merge preserves public adaptations and exposes overlapping conflicts', t => {
  const f = fixture(t);
  f.write(f.root, 'a.txt', 'public\nsecond\nthird\nfourth\nfifth\n');
  f.write(f.source, 'a.txt', 'first\nsecond\nthird\nfourth\nupstream\n');
  f.git('add', 'packages/example/a.txt'); f.git('-c', 'core.hooksPath=', 'commit', '-m', 'Fixture change');
  assert.equal(prepareSourceSync(f).entries[0].status, 'merged-candidate');
  assert.equal(readFileSync(path.join(f.out, 'candidates/packages/example/a.txt'), 'utf8'), 'public\nsecond\nthird\nfourth\nupstream\n');
  f.write(f.root, 'a.txt', 'first\nsecond\nthird\nfourth\nconflicting\n');
  f.out += '-conflict';
  assert.equal(prepareSourceSync(f).entries[0].status, 'merge-conflict');
  assert.match(readFileSync(path.join(f.out, 'candidates/packages/example/a.txt'), 'utf8'), /<<<<<<< public/);
});

test('rejects existing output, output in repositories and unsafe inventory', t => {
  const f = fixture(t);
  assert.throws(() => prepareSourceSync({ ...f, out: f.root }), /Output/);
  assert.throws(() => prepareSourceSync({ ...f, out: path.join(f.source, 'review') }), /Output/);
  mkdirSync(f.out);
  assert.throws(() => prepareSourceSync(f), /Output/);
  writeFileSync(path.join(f.root, inventoryPath), JSON.stringify({ files: ['../outside'] }));
  assert.throws(() => prepareSourceSync({ ...f, out: `${f.out}-new` }), /Unsafe inventory/);
});

// Exercise the real verification dispatcher in an isolated repository. These
// commands stand in for gates, so a failure test cannot accidentally run builds
// or the release-tools suite recursively.
function verificationFixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'verify-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'source');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const verifier = path.join(root, 'scripts/verify.mjs');
  copyFileSync(new URL('../scripts/verify.mjs', import.meta.url), verifier);
  const manager = path.join(directory, 'manager.cjs');
  writeFileSync(manager, `
    const fs = require('node:fs');
    const path = require('node:path');
    const gate = process.argv[3];
    const report = JSON.parse(fs.readFileSync(path.join(process.env.MCODE_VERIFY_REPORT_DIR, 'verification.json')));
    if (report.status !== 'RUNNING' || report.gates.find(g => g.name === gate)?.status !== 'RUNNING') process.exit(99);
    console.log('FIXTURE_OUTPUT_MUST_NOT_BE_UPLOADED');
    if (gate === process.env.VERIFY_FIXTURE_FAIL) process.exit(17);
  `);
  const exportRecord = path.join(directory, 'export-path.txt');
  writeFileSync(path.join(root, 'scripts/export-source-preview.mjs'), `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.argv[3], 'synthetic export');
    writeFileSync(process.env.VERIFY_FIXTURE_EXPORT, process.argv[3]);
  `);
  const reportDir = path.join(directory, 'reports');
  const summaryPath = path.join(directory, 'summary.md');
  function run(args = [], env = {}) {
    return spawnSync(process.execPath, [verifier, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        npm_execpath: manager,
        MCODE_VERIFY_REPORT_DIR: reportDir,
        GITHUB_STEP_SUMMARY: summaryPath,
        VERIFY_FIXTURE_EXPORT: exportRecord,
        VERIFY_FIXTURE_FAIL: '',
        ...env,
      },
    });
  }
  return {
    run, exportRecord, reportDir, summaryPath,
    report: () => JSON.parse(readFileSync(path.join(reportDir, 'verification.json'), 'utf8')),
  };
}

test('platform verification omits only the compiler gate and invalid profiles fail closed', t => {
  const f = verificationFixture(t);
  const full = f.run(['--list']);
  const platform = f.run(['--profile', 'platform', '--list']);
  assert.equal(full.status, 0, full.stderr);
  assert.equal(platform.status, 0, platform.stderr);
  const gates = full.stdout.trim().split('\n');
  assert.ok(gates.includes('typecheck'));
  assert.deepEqual(platform.stdout.trim().split('\n'), gates.filter(g => g !== 'typecheck'));
  assert.notEqual(f.run(['--profile', 'platfrom', '--list']).status, 0);
  assert.notEqual(f.run(['--unknown']).status, 0);
  assert.equal(existsSync(f.reportDir), false);
  assert.equal(existsSync(f.exportRecord), false);
});

test('verification reports successes and intentional skips without collecting gate output', t => {
  const f = verificationFixture(t);
  const result = f.run(['--profile', 'platform']);
  assert.equal(result.status, 0, result.stderr);
  const report = f.report();
  assert.equal(report.status, 'PASS');
  assert.equal(report.platform, process.platform);
  assert.equal(report.node, process.version);
  assert.equal(report.profile, 'platform');
  assert.equal(report.gates.find(g => g.name === 'typecheck').status, 'SKIP');
  assert.match(report.gates.find(g => g.name === 'typecheck').reason, /full profile/);
  assert.equal(report.gates.find(g => g.name === 'build').status, 'PASS');
  assert.equal(report.gates.find(g => g.name === 'test:byok').status, 'PASS');
  assert.ok(report.gates.every(g => ['PASS', 'SKIP'].includes(g.status)));
  assert.ok(report.gates.filter(g => g.status === 'PASS').every(g => g.durationMs >= 0 && g.exitCode === 0));
  assert.equal(existsSync(path.dirname(readFileSync(f.exportRecord, 'utf8'))), false);
  assert.doesNotMatch(JSON.stringify(report), /FIXTURE_OUTPUT_MUST_NOT_BE_UPLOADED/);
  assert.doesNotMatch(readFileSync(f.summaryPath, 'utf8'), /FIXTURE_OUTPUT_MUST_NOT_BE_UPLOADED/);
  assert.equal(readFileSync(f.summaryPath, 'utf8'), readFileSync(path.join(f.reportDir, 'verification.md'), 'utf8'));
});

test('compiler failure fails full verification, preserves evidence, and stops dependent gates', t => {
  const f = verificationFixture(t);
  const result = f.run([], { VERIFY_FIXTURE_FAIL: 'typecheck' });
  assert.equal(result.status, 1, result.stderr);
  const report = f.report();
  assert.equal(report.status, 'FAIL');
  assert.equal(report.gates.find(g => g.name === 'typecheck').status, 'FAIL');
  assert.equal(report.gates.find(g => g.name === 'typecheck').exitCode, 17);
  assert.equal(report.gates.find(g => g.name === 'check:source').status, 'PASS');
  assert.equal(report.gates.find(g => g.name === 'build').status, 'NOT_RUN');
  assert.match(report.gates.find(g => g.name === 'build').reason, /stopped/);
  assert.equal(existsSync(path.dirname(readFileSync(f.exportRecord, 'utf8'))), false);
  assert.match(readFileSync(f.summaryPath, 'utf8'), /Verification: FAIL/);
  assert.doesNotMatch(JSON.stringify(report), /FIXTURE_OUTPUT_MUST_NOT_BE_UPLOADED/);
});

test('missing package manager produces failure metadata instead of a passing verification', t => {
  const f = verificationFixture(t);
  const result = f.run([], { npm_execpath: path.join(f.reportDir, 'missing-executable') });
  assert.equal(result.status, 1, result.stderr);
  const report = f.report();
  assert.equal(report.status, 'FAIL');
  assert.equal(report.gates[0].status, 'FAIL');
  assert.ok(report.gates[0].errorCode || report.gates[0].exitCode !== 0);
  assert.equal(report.gates.find(g => g.name === 'build').status, 'NOT_RUN');
});

test('documentation and archive profiles preserve their required validation gates', t => {
  const f = verificationFixture(t);
  const full = f.run(['--list']).stdout.trim().split('\n');
  const docs = f.run(['--profile', 'docs', '--list']);
  assert.equal(docs.status, 0, docs.stderr);
  assert.deepEqual(docs.stdout.trim().split('\n'), ['check:source', 'check:tsconfig', 'export source preview', 'test:release-tools']);
  const archive = f.run(['--profile', 'archive', '--list']);
  assert.equal(archive.status, 0, archive.stderr);
  assert.deepEqual(archive.stdout.trim().split('\n'), full.filter(g => g !== 'export source preview'));
  const failure = f.run(['--profile', 'docs'], { VERIFY_FIXTURE_FAIL: 'check:source' });
  assert.equal(failure.status, 1);
  assert.equal(f.report().status, 'FAIL');
});

test('change classification is conservative for mixed changes, metadata and missing diffs', () => {
  assert.deepEqual(classifyChanges(['README.md', 'docs/installation.md']), { docsOnly: true });
  for (const files of [[], ['README.md', 'packages/tui/src/main.ts'], ['docs/run.mjs'], ['release/public-source.json'], ['.github/workflows/ci.yml'], ['scripts/export-source-preview.mjs']])
    assert.equal(classifyChanges(files).docsOnly, false);
  assert.deepEqual(classifyChanges(['.github/PULL_REQUEST_TEMPLATE.md', 'docs/source-sync.md']), { docsOnly: true });
  for (const file of ['.github/actions/setup-gitleaks/action.yml', '.github/ISSUE_TEMPLATE/config.yml', '.github/unknown.md', '.github/PULL_REQUEST_TEMPLATE.md/run.js'])
    assert.equal(classifyChanges([file]).docsOnly, false, file);
});

test('CI aggregate rejects failed, cancelled, missing and unexpectedly skipped checks', { skip: process.platform === 'win32' }, () => {
  // This shell step only runs on the aggregate job's Ubuntu runner.
  const workflow = parseYaml(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const script = workflow.jobs.verification.steps[0].run;
  const full = { CLASSIFICATION: 'success', DOCS_ONLY: 'false', DOCS_RESULT: 'skipped', MATRIX_RESULT: 'success' };
  const docs = { CLASSIFICATION: 'success', DOCS_ONLY: 'true', DOCS_RESULT: 'success', MATRIX_RESULT: 'skipped' };
  const run = env => spawnSync('bash', ['-e', '-c', script], { env: { ...process.env, ...env }, encoding: 'utf8' }).status;
  assert.equal(run(full), 0);
  assert.equal(run(docs), 0);
  for (const result of ['failure', 'cancelled', 'skipped', '']) {
    assert.notEqual(run({ ...full, MATRIX_RESULT: result }), 0);
    assert.notEqual(run({ ...docs, DOCS_RESULT: result }), 0);
    assert.notEqual(run({ ...full, CLASSIFICATION: result }), 0);
  }
  assert.notEqual(run({ ...full, DOCS_ONLY: '' }), 0);
  for (const result of ['success', 'failure', 'cancelled', ''])
    assert.notEqual(run({ ...docs, MATRIX_RESULT: result }), 0);
  for (const result of ['success', 'failure', 'cancelled', ''])
    assert.notEqual(run({ ...full, DOCS_RESULT: result }), 0);
  for (const scope of ['', 'unknown', 'True'])
    assert.notEqual(run({ ...full, DOCS_ONLY: scope }), 0);
});

test('ordinary CI preserves three platforms without invoking release-only matrices', () => {
  const readWorkflow = name => parseYaml(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
  const ci = readWorkflow('ci');
  assert.ok(Object.hasOwn(ci.on, 'pull_request'));
  assert.deepEqual(ci.on.push.branches, ['main']);
  assert.deepEqual(Object.keys(ci.jobs).sort(), ['changes', 'docs', 'verification', 'verify']);
  assert.deepEqual(ci.jobs.verify.strategy.matrix.os, ['ubuntu-latest', 'macos-latest', 'windows-latest']);
  assert.deepEqual(ci.jobs.verify.strategy.matrix.node, ['24']);
  assert.deepEqual(ci.jobs.verify.strategy.matrix.include, [{ os: 'ubuntu-latest', node: '24', profile: 'full' }]);
  assert.equal(ci.jobs.verify.needs, 'changes');
  assert.equal(ci.jobs.verify.if, "needs.changes.outputs.docs_only == 'false'");
  assert.equal(ci.jobs.docs.if, "needs.changes.outputs.docs_only == 'true'");
  assert.equal(ci.jobs.verification.if, '${{ always() }}');
  assert.deepEqual(ci.jobs.verification.needs, ['changes', 'docs', 'verify']);
  assert.ok(ci.jobs.verify.steps.some(step => step.run === "pnpm verify --profile ${{ matrix.profile || 'platform' }}"));
  const compatibility = readWorkflow('compatibility');
  assert.deepEqual(Object.keys(compatibility.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(compatibility.jobs.compatibility.strategy.matrix.node, ['22.19.0', '24.2.0', '25', '26']);
  assert.deepEqual(compatibility.jobs.compatibility.strategy.matrix.os, ci.jobs.verify.strategy.matrix.os);
  const audit = readWorkflow('security');
  assert.ok(Object.hasOwn(audit.on, 'pull_request'));
  assert.ok(audit.jobs['source-history-artifact'].steps.some(step => step.run?.includes('gitleaks dir dist')));
});

test('manual source candidates pin every checkout and receipt to the selected revision', () => {
  const workflow = parseYaml(readFileSync(new URL('../.github/workflows/source-candidate.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on).sort(), ['workflow_call', 'workflow_dispatch']);
  assert.equal(workflow.on.workflow_call.inputs.revision.required, true);
  assert.equal(workflow.env.MCODE_CANDIDATE_REVISION, '${{ inputs.revision || github.sha }}');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.match(workflow.concurrency.group, /inputs\.revision \|\| github\.sha/);
  const revision = '${{ env.MCODE_CANDIDATE_REVISION }}';
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, revision);
    for (const step of job.steps.filter(step => step.run?.includes('scripts/source-candidate.mjs')))
      assert.equal(step.env.REVISION, revision);
  }
  const validate = workflow.jobs.validate;
  assert.deepEqual(validate.strategy.matrix.os, ['ubuntu-latest', 'macos-latest', 'windows-latest']);
  assert.ok(validate.steps.some(step => step.run?.includes('--store-dir "$RUNNER_TEMP/candidate-store" --registry https://registry.npmjs.org/')));
  const verify = validate.steps.find(step => step.run === 'pnpm verify --profile archive');
  assert.equal(verify.env.MCODE_VERIFY_REVISION, revision);
  assert.deepEqual(workflow.jobs.publish.needs, ['export', 'validate']);
  assert.ok(workflow.jobs.publish.steps.some(step => step.run?.includes('scripts/source-candidate.mjs finalize')));
  assert.equal(workflow.permissions.contents, 'read');
});

function archiveFixture(t, entries) {
  const directory = mkdtempSync(path.join(tmpdir(), 'archive-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '');
    const header = new Header({ path: entry.path, type: entry.type ?? 'File', linkpath: entry.linkpath, size: content.length, mode: 0o644, uid: 0, gid: 0, mtime: new Date(0) });
    header.encode();
    blocks.push(header.block, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  const archive = path.join(directory, 'source.tar.gz');
  writeFileSync(archive, gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
  return { directory, archive };
}

test('native and Node source extractors produce identical file content', async t => {
  const f = archiveFixture(t, [
    { path: 'minimax-code/README.md', content: 'Source preview\n' },
    { path: 'minimax-code/nested/file.txt', content: 'portable contents\n' },
  ]);
  for (const extractor of ['native', 'node']) {
    const output = path.join(f.directory, extractor);
    mkdirSync(output);
    assert.equal(await extractSourceArchive(f.archive, output, extractor), extractor);
    assert.equal(readFileSync(path.join(output, 'minimax-code/nested/file.txt'), 'utf8'), 'portable contents\n');
  }
});

test('Windows extraction ignores a shadow tar executable on PATH', { skip: process.platform !== 'win32' }, t => {
  const f = archiveFixture(t, [{ path: 'minimax-code/README.md', content: 'Windows archive\n' }]);
  const shadow = path.join(f.directory, 'shadow');
  const output = path.join(f.directory, 'output');
  mkdirSync(shadow);
  mkdirSync(output);
  // Node rejects tar flags. If extraction accidentally uses PATH, this fake
  // tar.exe makes the regression fail without needing Git Bash installed.
  copyFileSync(process.execPath, path.join(shadow, 'tar.exe'));
  const script = `import { extractSourceArchive } from ${JSON.stringify(new URL('../scripts/lib/source-archive.mjs', import.meta.url).href)};
    const result = await extractSourceArchive(${JSON.stringify(f.archive)}, ${JSON.stringify(output)}, 'native');
    if (result !== 'native') process.exit(1);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8', env: { ...process.env, PATH: `${shadow}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(output, 'minimax-code/README.md'), 'utf8'), 'Windows archive\n');
});

test('source archive rejects traversal, links, Git history and duplicate entries before writing files', async t => {
  const good = { path: 'minimax-code/good.txt', content: 'safe' };
  for (const bad of [
    { path: 'minimax-code/../../outside.txt', content: 'unsafe' },
    { path: 'minimax-code/link', type: 'SymbolicLink', linkpath: '../../outside' },
    { path: 'minimax-code/link', type: 'Link', linkpath: '../../outside' },
    { path: 'minimax-code/.git/config', content: 'history' },
    { path: 'minimax-code/file:stream', content: 'stream' },
    good,
  ]) {
    const f = archiveFixture(t, [good, bad]);
    for (const extractor of ['native', 'node']) {
      const output = path.join(f.directory, extractor);
      mkdirSync(output);
      await assert.rejects(extractSourceArchive(f.archive, output, extractor), /unreviewed/);
      assert.deepEqual(readdirSync(output), []);
    }
  }
});

test('candidate rejects mismatched receipts and requires three successful same-revision reports', t => {
  const f = archiveFixture(t, [{ path: 'minimax-code/README.md', content: 'source' }]);
  const revision = 'a'.repeat(40);
  const receipt = { schemaVersion: 1, revision, sha256: createHash('sha256').update(readFileSync(f.archive)).digest('hex'), format: 'source-only-no-git-history', publicationPerformed: false };
  writeFileSync(`${f.archive}.json`, JSON.stringify(receipt));
  const script = fileURLToPath(new URL('../scripts/source-candidate.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args, '--archive', f.archive, '--revision', revision], { encoding: 'utf8', timeout: 15000 });
  const destination = path.join(f.directory, 'unpacked');
  assert.equal(run('unpack', '--destination', destination).status, 0);
  assert.notEqual(run('unpack', '--destination', destination).status, 0);
  writeFileSync(`${f.archive}.json`, JSON.stringify({ ...receipt, sha256: '0'.repeat(64) }));
  assert.notEqual(run('unpack', '--destination', `${destination}-bad`).status, 0);
  assert.equal(existsSync(`${destination}-bad`), false);
  writeFileSync(`${f.archive}.json`, JSON.stringify(receipt));
  const reports = path.join(f.directory, 'reports');
  mkdirSync(reports);
  for (const platform of ['linux', 'darwin', 'win32']) {
    const folder = path.join(reports, platform);
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'verification.json'), JSON.stringify({ revision, platform, arch: 'fixture', node: 'v24', profile: 'archive', status: 'PASS', gates: [{ name: 'build', status: 'PASS' }] }));
  }
  assert.equal(run('finalize', '--reports', reports).status, 0);
  assert.equal(JSON.parse(readFileSync(path.join(f.directory, 'candidate.json'))).sha256, receipt.sha256);
  const windows = path.join(reports, 'win32/verification.json');
  const report = JSON.parse(readFileSync(windows));
  for (const change of [{ status: 'FAIL' }, { revision: 'b'.repeat(40) }, { gates: [{ name: 'build', status: 'NOT_RUN' }] }]) {
    writeFileSync(windows, JSON.stringify({ ...report, ...change }));
    assert.notEqual(run('finalize', '--reports', reports).status, 0);
  }
  rmSync(path.dirname(windows), { recursive: true });
  assert.notEqual(run('finalize', '--reports', reports).status, 0);
});


test('source inventory rejects unregistered, missing and duplicate first-party test gates', () => {
  const existing = 'packages/example/src/existing.test.ts';
  const omitted = 'packages/example/test/omitted.spec.tsx';
  const missing = 'packages/example/test/missing.test.ts';
  const files = [existing, omitted, 'third_party/vendor/vendor.test.ts', 'test/release.test.mjs'];
  assert.deepEqual(suiteInventoryViolations(files, { capability: [existing, existing, missing] }), [
    `${existing}: duplicate Vitest registration`,
    `${missing}: registered Vitest file is missing`,
    `${omitted}: first-party test is absent from test/vitest-suites.json`,
  ]);
  assert.deepEqual(suiteInventoryViolations(files, { capability: [existing, omitted] }), []);
});

test('suite runner preserves gate arguments and canonicalizes Windows temporary paths', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'suite-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['scripts/lib', 'test', 'node_modules/vitest', 'temporary'])
    mkdirSync(path.join(root, directory), { recursive: true });
  for (const file of ['scripts/run-vitest-suite.mjs', 'scripts/lib/vitest-suites.mjs'])
    copyFileSync(new URL(`../${file}`, import.meta.url), path.join(root, file));
  writeFileSync(path.join(root, 'test/vitest-suites.json'), JSON.stringify({ suites: { fixture: ['test/example.test.ts'] } }));
  writeFileSync(path.join(root, 'node_modules/vitest/package.json'), JSON.stringify({ bin: { vitest: 'cli.cjs' } }));
  writeFileSync(path.join(root, 'node_modules/vitest/cli.cjs'), 'console.log(JSON.stringify({args:process.argv.slice(2),temp:process.env.TEMP,tmp:process.env.TMP,cwd:process.cwd()})); process.exit(17);');
  const alias = path.join(root, 'temporary-alias');
  symlinkSync(path.join(root, 'temporary'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const platform of ['linux', 'darwin', 'win32']) {
    const preload = path.join(root, 'platform.cjs');
    writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });`);
    const result = spawnSync(process.execPath, ['--require', preload, path.join(root, 'scripts/run-vitest-suite.mjs'), 'fixture'], {
      encoding: 'utf8', env: { ...process.env, TEMP: alias, TMP: alias, TMPDIR: alias },
    });
    assert.equal(result.status, 17, result.stderr);
    const child = JSON.parse(result.stdout);
    assert.deepEqual(child.args, ['run', '--config', 'vitest.oss.config.mjs',
      ...(platform === 'win32' ? ['--maxWorkers', '1'] : []), 'test/example.test.ts']);
    assert.equal(realpathSync(child.cwd), realpathSync(root));
    const expected = platform === 'win32' ? realpathSync.native(alias) : alias;
    assert.equal(child.temp, expected);
    assert.equal(child.tmp, expected);
  }
});

test('public support forms preserve destination URLs and separate Desktop from CLI reports', () => {
  const forms = ['01-bug-report.yml', '02-feature-request.yml', '03-question.yml'];
  for (const name of forms) {
    const form = parseYaml(readFileSync(new URL(`../.github/ISSUE_TEMPLATE/${name}`, import.meta.url), 'utf8'));
    const product = form.body.find(field => field.id === 'product');
    assert.equal(product.validations.required, true);
    assert.ok(product.attributes.options.includes('Desktop app'));
    assert.ok(product.attributes.options.includes('CLI - ACP'));
    assert.ok(product.attributes.options.includes('CLI - headless'));
    const ids = form.body.filter(field => field.id).map(field => field.id);
    assert.equal(new Set(ids).size, ids.length);
  }
  const bug = parseYaml(readFileSync(new URL('../.github/ISSUE_TEMPLATE/01-bug-report.yml', import.meta.url), 'utf8'));
  assert.notEqual(bug.body.find(field => field.id === 'upload-id').validations?.required, true);
  for (const retired of ['bug.yml', 'feature.yml'])
    assert.equal(existsSync(new URL(`../.github/ISSUE_TEMPLATE/${retired}`, import.meta.url)), false);
  assert.equal(classifyChanges(['README_ZH.md', 'README.md']).docsOnly, true);
});

test('issue notification is restricted to public destination events and builds payloads offline', t => {
  const workflow = parseYaml(readFileSync(new URL('../.github/workflows/sync-issue-to-feishu.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on, { issues: { types: ['opened'] } });
  assert.deepEqual(workflow.permissions, { contents: 'read', issues: 'read' });
  const job = workflow.jobs['notify-feishu'];
  assert.equal(job.if, "${{ github.repository == 'MiniMax-AI/minimax-code' && github.event.repository.private == false && !github.event.issue.pull_request }}");
  const generate = job.steps.find(step => step.name === 'Build Feishu payload').run;
  // Execute only the payload builder, never the delivery step or its secrets.
  assert.doesNotMatch(generate, /\$\{\{\s*github\.event/);
  const script = generate.match(/^node <<'EOF'\r?\n([\s\S]*?)\r?\nEOF\s*$/)?.[1];
  assert.ok(script);
  const directory = mkdtempSync(path.join(tmpdir(), 'support-payload-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'must-not-execute');
  const event = {
    repository: { full_name: 'MiniMax-AI/minimax-code', html_url: 'https://github.com/MiniMax-AI/minimax-code' },
    issue: { number: 7, title: 'Synthetic issue', body: `$(touch ${marker}) <at id=all>test</at>`, labels: [{ name: 'bug' }], created_at: '2026-09-18T00:00:00Z', html_url: 'https://github.com/MiniMax-AI/minimax-code/issues/7', user: { login: 'fixture' } },
  };
  const eventPath = path.join(directory, 'event.json');
  writeFileSync(eventPath, JSON.stringify(event));
  const result = spawnSync(process.execPath, ['--input-type=commonjs'], {
    input: script, cwd: directory, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, GITHUB_EVENT_PATH: eventPath, FEISHU_BOT_SECRET: '', FEISHU_BOT_WEBHOOK: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(marker), false);
  const payload = JSON.parse(readFileSync(path.join(directory, 'feishu-payload.json'), 'utf8'));
  assert.equal(payload.card.header.template, 'red');
  assert.equal(payload.card.card_link.url, event.issue.html_url);
  assert.equal(payload.card.header.title.content, 'GitHub Issue #7: Synthetic issue');
  assert.doesNotMatch(JSON.stringify(payload), /<at /);
  assert.match(JSON.stringify(payload), /‹at id=all›/);
  assert.equal(payload.sign, undefined);
});

test('source imports preserve vendored Office schema bytes through Git staging', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'source-import-bytes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init');
  copyFileSync(new URL('../.gitattributes', import.meta.url), path.join(directory, '.gitattributes'));
  const schema = 'packages/local-runtime/assets/skills/xlsx/scripts/office/schemas/ISO-IEC29500-4_2016/dml-chart.xsd';
  mkdirSync(path.dirname(path.join(directory, schema)), { recursive: true });
  const bytes = Buffer.from('<schema>\r\n  <element name="fixture"/>\r\n</schema>\r\n');
  writeFileSync(path.join(directory, schema), bytes);
  for (const autocrlf of ['true', 'false']) {
    git('-c', `core.autocrlf=${autocrlf}`, 'add', '--', '.gitattributes', schema);
    assert.deepEqual(git('show', `:${schema}`), bytes);
  }
});
