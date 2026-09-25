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
import { cliBuildVersion, cliExternalModules, cliReleaseTargets, versionFromTag } from '../scripts/lib/cli-release.mjs';
import { releaseManifest } from '../scripts/package-cli-release.mjs';
import { validateReleaseReports } from '../scripts/publish-cli-release.mjs';
import { compareVersions, releaseCli } from '../scripts/release-cli.mjs';
import { compareRuns, exitCodeForStatus, renderReport, spread, validateRun, validateRequest, validateToolOutput, median, selectScenarios } from '../scripts/perf/report.mjs';
import { copyMcodeToolsArtifact, downloadMcodeToolsArtifact, MCODE_TOOLS_ARTIFACT } from '../scripts/lib/mcode-tools-artifact.mjs';
import { checkWindowsSourceLocation, runWindowsSourceLocationCheck } from '../scripts/check-windows-source-location.mjs';

test('Windows source preflight accepts localized fsutil labels', () => {
  const result = checkWindowsSourceLocation({
    platform: 'win32',
    cwd: 'C:\\repo',
    execFile: (_command, args) => args[1] === 'drivetype'
      ? 'Laufwerkstyp: DRIVE_FIXED\n'
      : 'Dateisystemname: NTFS\n',
  });
  assert.deepEqual(result, { ok: true, skipped: false });
});

test('Windows source preflight requires a local NTFS checkout', () => {
  const calls = [];
  const execFile = (command, args) => {
    calls.push([command, args]);
    if (args[1] === 'drivetype') return 'Drive type is : DRIVE_FIXED\n';
    return 'File System Name             : NTFS\n';
  };
  assert.deepEqual(
    checkWindowsSourceLocation({ platform: 'win32', cwd: 'C:\\repo', execFile }),
    { ok: true, skipped: false },
  );
  assert.deepEqual(calls.map(([command, args]) => [command, args[1], args[2]]), [
    ['fsutil', 'drivetype', 'C:'],
    ['fsutil', 'volumeinfo', 'C:'],
  ]);
});

test('Windows source preflight rejects unsupported volumes clearly', () => {
  const run = (driveType, volumeInfo, cwd = 'C:\\repo', allowNonFixed = false) => checkWindowsSourceLocation({
    platform: 'win32', cwd, allowNonFixed,
    execFile: (_command, args) => args[1] === 'drivetype' ? driveType : volumeInfo,
  });
  assert.match(run('Drive type is : DRIVE_REMOTE\n', 'File System Name : NTFS\n').reason, /not a local fixed drive/);
  assert.deepEqual(
    run('Drive type is : DRIVE_REMOTE\n', 'File System Name : NTFS\n', 'C:\\repo', true),
    { ok: true, skipped: false },
  );
  assert.match(run('Drive type is : DRIVE_FIXED\n', 'File System Name : NTFS\n', '\\\\server\\share\\repo').reason, /not a local drive-letter path/);
});

test('Windows source preflight is a no-op on non-Windows platforms', () => {
  assert.deepEqual(
    checkWindowsSourceLocation({ platform: 'linux', execFile: () => assert.fail('must not run fsutil') }),
    { ok: true, skipped: true },
  );
});

test('Windows source preflight propagates a failed check to the CLI', () => {
  const messages = [];
  const result = runWindowsSourceLocationCheck({
    platform: 'win32',
    cwd: 'C:\\repo',
    execFile: () => { throw new Error('fsutil unavailable'); },
    report: (message) => messages.push(message),
  });
  assert.equal(result.ok, false);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /fsutil unavailable/);
});

test('artifact download recovers from TLS reset and interrupted response bodies', async () => {
  const reset = new TypeError('fetch failed', { cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) });
  const interrupted = new TypeError('terminated', { cause: Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }) });
  const signals = [], delays = [], warnings = [];
  const result = await downloadMcodeToolsArtifact(async (url, { signal }) => {
    assert.equal(url, MCODE_TOOLS_ARTIFACT.url);
    assert.ok(signal instanceof AbortSignal);
    signals.push(signal);
    if (signals.length === 1) throw reset;
    if (signals.length === 2) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
      pull(controller) { controller.error(interrupted); },
    }));
    return new Response('complete archive');
  }, { wait: async ms => delays.push(ms), warn: message => warnings.push(message) });
  assert.equal(result.toString(), 'complete archive');
  assert.equal(new Set(signals).size, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /1\/3.*ECONNRESET/);
  assert.match(warnings[1], /2\/3.*UND_ERR_SOCKET/);
});

test('artifact download retries temporary HTTP failures and releases rejected bodies', async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    let calls = 0, cancelled = false;
    const delays = [];
    const result = await downloadMcodeToolsArtifact(async () => {
      if (++calls > 1) return new Response('ok');
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
    }, { wait: async ms => delays.push(ms), warn() {} });
    assert.equal(result.toString(), 'ok');
    assert.equal(calls, 2);
    assert.equal(cancelled, true);
    assert.deepEqual(delays, [1000]);
  }
});

test('artifact download bounds Retry-After delays and rejects permanent failures immediately', async () => {
  for (const [header, expectedDelay] of [['5', 5000], ['999999', 30000], ['invalid', 1000], ['0', 1000]]) {
    let calls = 0;
    const delays = [];
    await downloadMcodeToolsArtifact(async () => ++calls === 1
      ? new Response(null, { status: 429, headers: { 'Retry-After': header } }) : new Response('ok'),
    { wait: async ms => delays.push(ms), warn() {} });
    assert.deepEqual(delays, [expectedDelay]);
  }
  const certificateError = new TypeError('fetch failed', { cause: Object.assign(new Error('certificate expired'), { code: 'CERT_HAS_EXPIRED' }) });
  for (const failure of [new Response(null, { status: 403 }), new Response(null, { status: 404 }), certificateError]) {
    let calls = 0;
    await assert.rejects(downloadMcodeToolsArtifact(async () => {
      calls++;
      if (failure instanceof Error) throw failure;
      return failure;
    }, { wait: async () => assert.fail('permanent failures must not wait'), warn: () => assert.fail('permanent failures must not retry') }));
    assert.equal(calls, 1);
  }
});

test('artifact download stops after three timeouts and preserves the final cause', async () => {
  const timeout = new DOMException('The operation timed out', 'TimeoutError');
  let calls = 0;
  const delays = [];
  await assert.rejects(downloadMcodeToolsArtifact(async () => { calls++; throw timeout; },
    { wait: async ms => delays.push(ms), warn() {} }), error => {
    assert.match(error.message, /after 3 attempts/);
    assert.equal(error.cause, timeout);
    return true;
  });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

test('artifact download never retries or caches an archive that fails integrity', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mcode-artifact-download-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(copyMcodeToolsArtifact(root, path.join(root, 'dist'), async () => {
    calls++;
    return new Response('corrupt archive');
  }), /integrity mismatch/);
  assert.equal(calls, 1);
  assert.equal(existsSync(path.join(root, '.cache', 'artifacts', 'code-0.3.11.tgz')), false);
  assert.equal(existsSync(path.join(root, 'dist')), false);
});

test('performance defaults to the 100-round suite; long history requires explicit selection', () => {
  const config = JSON.parse(readFileSync(new URL('../scripts/perf/config.json', import.meta.url), 'utf8'));
  assert.deepEqual(selectScenarios(config).map(s => s.id), ['upstream-100']);
  assert.deepEqual(selectScenarios(config, { suite: 'full' }).map(s => s.id), ['startup', 'upstream-100', 'history-300']);
  assert.deepEqual(selectScenarios(config, { scenario: 'startup' }).map(s => s.id), ['startup']);
  assert.throws(() => selectScenarios(config, { suite: 'typo' }));
  assert.throws(() => selectScenarios(config, { scenario: 'typo' }));
  const workflow = parseYaml(readFileSync(new URL('../.github/workflows/performance.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.on.workflow_dispatch.inputs.suite.default, 'full');
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.suite.options, ['full', 'basic']);
  const compare = workflow.jobs.performance.steps.find(s => s.name === 'Compare on this runner');
  assert.equal(compare.env.PERF_SUITE, "${{ matrix.suite }}");
  assert.match(compare.run, /--suite "\$PERF_SUITE"/);
});

test('performance labels select full coverage without interrupting checks for unrelated labels', () => {
  const workflow = parseYaml(readFileSync(new URL('../.github/workflows/performance.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs.performance;
  assert.deepEqual(workflow.on.pull_request.types, ['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled']);
  assert.equal(job.strategy.matrix.suite, `\${{ fromJSON((inputs.suite == 'full' || (github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'perf:full'))) && '["full"]' || '["basic"]') }}`);
  assert.equal(job.if, `\${{ !contains(fromJSON('["labeled","unlabeled"]'), github.event.action) || github.event.label.name == 'perf:full' }}`);
  assert.equal(job.name, `\${{ contains(fromJSON('["labeled","unlabeled"]'), github.event.action) && github.event.label.name != 'perf:full' && 'performance (label ignored)' || 'performance' }}`);
  assert.equal(workflow.concurrency, undefined);
  assert.equal(job.concurrency.group, `performance-\${{ github.event_name }}-\${{ github.ref }}-\${{ github.event_name == 'workflow_dispatch' && matrix.suite || 'auto' }}`);
  assert.equal(job.concurrency['cancel-in-progress'], true);
  assert.equal(job['timeout-minutes'], `\${{ matrix.suite == 'full' && 45 || 15 }}`);
});

test('performance request audit rejects truncated wire history and empty tool results', () => {
  const responses = [
    { message: { content: 'full history', tool_calls: [{ id: 'call_long_run_1', function: { name: 'bash', arguments: { command: 'ls' } } }] } },
    { message: { content: 'done' } }, { message: { content: ' ' } },
  ];
  const messages = [{ role: 'user', content: 'task' },
    { role: 'assistant', content: 'full history', tool_calls: [{ id: 'call_long_run_1', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', tool_call_id: 'call_long_run_1', content: 'README.txt\n' }];
  assert.doesNotThrow(() => validateRequest({ messages }, responses, 2, process.cwd(), 'task'));
  assert.throws(() => validateRequest({ messages: messages.slice(0, 1) }, responses, 2, process.cwd(), 'task'), /conversation length/);
  assert.throws(() => validateRequest({ messages: [] }, responses, 1, process.cwd(), 'task'), /conversation length/);
  assert.throws(() => validateRequest({ messages: [messages[0], messages[2], messages[1]] }, responses, 2, process.cwd(), 'task'), /order changed/);
  assert.throws(() => validateRequest({ messages: [{ role: 'user', content: 'wrong' }] }, responses, 1, process.cwd(), 'task'), /task changed/);
  assert.doesNotThrow(() => validateRequest({ messages: [messages[0]] }, responses, 1, process.cwd(), 'task'));
  const changed = structuredClone(messages);
  changed[1].content = 'shortened';
  assert.throws(() => validateRequest({ messages: changed }, responses, 2, process.cwd(), 'task'), /body changed/);
  changed[1].content = 'full history'; changed[2].content = '';
  assert.throws(() => validateRequest({ messages: changed }, responses, 2, process.cwd(), 'task'), /lost fixture/);
  assert.throws(() => validateToolOutput([], 'ls', process.cwd()), /lost fixture/);
  assert.throws(() => validateToolOutput('wrong', 'echo expected', process.cwd()), /Echo/);
  assert.throws(() => validateToolOutput('/wrong', 'pwd', process.cwd()), /directory/);
  assert.doesNotThrow(() => validateToolOutput(realpathSync(process.cwd()) + '\n', 'pwd', process.cwd()));
});

const perfConfig = { repetitions: 3, confirmPairs: 2, maxSpread: 0.3, thresholds: { cpuSeconds: { relative: 0.2, absolute: 0.5 } } };
const perfRuns = values => values.map(cpuSeconds => ({ cpuSeconds }));

test('performance comparison settles clean first pairs and rejects incomplete or invalid samples', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(compareRuns(perfRuns([10, 10, 10]), perfRuns([10, 10, 10]), perfConfig)[0].status, 'PASS');
  assert.equal(compareRuns(perfRuns([1, 1, 1]), perfRuns([1.4, 1.4, 1.4]), perfConfig)[0].status, 'PASS');
  // Over budget or noisy on either side: escalate to confirmation pairs instead of a verdict.
  assert.equal(compareRuns(perfRuns([10, 10, 10]), perfRuns([13, 13, 13]), perfConfig)[0].status, 'NEEDS_CONFIRMATION');
  assert.equal(compareRuns(perfRuns([10, 10, 10]), perfRuns([10, 10, 14]), perfConfig)[0].status, 'NEEDS_CONFIRMATION');
  assert.equal(compareRuns(perfRuns([10, 10, 14]), perfRuns([10, 10, 10]), perfConfig)[0].status, 'NEEDS_CONFIRMATION');
  // Without confirmation pairs configured, the first pairs are final and never escalate.
  const single = { ...perfConfig, confirmPairs: 0 };
  assert.equal(compareRuns(perfRuns([10, 10, 10]), perfRuns([13, 13, 13]), single)[0].status, 'REGRESSION');
  assert.equal(compareRuns(perfRuns([10, 10, 10]), perfRuns([10, 10, 14]), single)[0].status, 'INCONCLUSIVE');
  assert.throws(() => compareRuns(perfRuns([10, 10]), perfRuns([10, 10, 10]), perfConfig));
  assert.throws(() => compareRuns(perfRuns([10, 10, 10, 10]), perfRuns([10, 10, 10, 10]), perfConfig));
  assert.throws(() => compareRuns(perfRuns([10, NaN, 10]), perfRuns([10, 10, 10]), perfConfig));
  assert.throws(() => compareRuns(perfRuns([0, 0, 0]), perfRuns([10, 10, 10]), perfConfig));
});

test('performance confirmation pairs fail confirmed regressions and absorb single outliers', () => {
  const five = (before, after) => compareRuns(perfRuns(before), perfRuns(after), perfConfig)[0];
  // Consistently worse beyond budget: confirmed regression.
  assert.equal(five([10, 10, 10, 10, 10], [13, 13, 13, 13, 13]).status, 'REGRESSION');
  // One corrupted pair cannot veto a confirmed regression.
  assert.equal(five([10, 10, 10, 10, 20], [13, 13, 13, 13, 13]).status, 'REGRESSION');
  // Unanimous paired evidence outranks side dispersion.
  assert.equal(five([10, 10, 10, 10, 10], [13, 13, 18, 13, 20]).status, 'REGRESSION');
  // One slow candidate sample no longer blocks a faster candidate.
  const outlier = five([10, 10, 10, 10, 10], [9.5, 9.6, 9.7, 9.6, 13.5]);
  assert.deepEqual([outlier.status, outlier.pairs, outlier.overBudgetPairs, outlier.trimmedSamples], ['PASS', 5, 1, 1]);
  assert.ok(outlier.headSpread <= 0.3);
  // Persistent noise stays inconclusive: neither a block nor a pass.
  assert.equal(five([10, 10, 10, 10, 10], [9, 9.5, 10, 14, 15]).status, 'INCONCLUSIVE');
  // An over-budget median that pairs do not reproduce is inconclusive, not a regression.
  assert.equal(five([10, 14, 10, 14, 10], [13, 13, 13, 13, 13]).status, 'INCONCLUSIVE');
  // Separate medians must not turn one over-budget paired delta into a regression.
  const shifted = five([10, 10, 10, 20, 20], [10.1, 10.1, 20.1, 20.1, 20.1]);
  assert.deepEqual([shifted.status, shifted.overBudgetPairs], ['INCONCLUSIVE', 1]);
  assert.equal(spread([10, 10, 14]), 0.4);
  assert.equal(spread([10, 10, 14], 1), 0);
  assert.throws(() => spread([10, 10], 1));
});

test('performance exit codes fail regressions and errors but not inconclusive noise', () => {
  assert.equal(exitCodeForStatus('PASS'), 0);
  assert.equal(exitCodeForStatus('REGRESSION'), 1);
  assert.equal(exitCodeForStatus('ERROR'), 1);
  assert.equal(exitCodeForStatus('INCONCLUSIVE'), 2);
  assert.throws(() => exitCodeForStatus('NEEDS_CONFIRMATION'));
});

test('performance workflow warns on basic inconclusive runs but fails full inconclusive runs', () => {
  const workflow = parseYaml(readFileSync(new URL('../.github/workflows/performance.yml', import.meta.url), 'utf8'));
  const compare = workflow.jobs.performance.steps.find(s => s.name === 'Compare on this runner');
  assert.match(compare.run, /\|\| status=\$\?/);
  assert.match(compare.run, /if \[ "\$status" -eq 2 \]/);
  assert.match(compare.run, /if \[ "\$PERF_SUITE" = "full" \]/);
  assert.match(compare.run, /::error title=Full performance check inconclusive::/);
  assert.match(compare.run, /exit 2/);
  assert.match(compare.run, /::warning title=Performance check inconclusive::/);
  assert.match(compare.run, /exit 0/);
  assert.match(compare.run, /exit "\$status"/);
  const config = JSON.parse(readFileSync(new URL('../scripts/perf/config.json', import.meta.url), 'utf8'));
  assert.equal(config.confirmPairs, 2);
});

test('performance report states suite-specific inconclusive behavior', () => {
  const row = { metric: 'durationMs', baseline: 17820, candidate: 17530, change: -0.016,
    pairs: 5, overBudgetPairs: 1, trimmedSamples: 1, baseSpread: 0.05, headSpread: 0.34, status: 'INCONCLUSIVE' };
  const report = { status: 'INCONCLUSIVE', baseRevision: 'base-sha', headRevision: 'head-sha',
    benchmarkRepository: 'https://example.invalid/bench', benchmarkRevision: 'bench-sha',
    nodeVersion: 'v22.0.0', bunVersion: '1.0.0',
    host: { cpuModel: 'test', cpus: 3, totalMemBytes: 2 ** 33, platform: 'darwin', osRelease: '24.0.0', arch: 'arm64' },
    config: { repetitions: 3, confirmPairs: 2 }, suite: 'basic', selectedScenarios: ['upstream-100'],
    results: [{ id: 'upstream-100', comparison: [row] }] };
  const markdown = renderReport(report);
  assert.match(markdown, /Status: \*\*INCONCLUSIVE\*\* — runner too noisy to conclude; non-blocking for the basic suite/);
  assert.match(markdown, /\| 1\/5 \| INCONCLUSIVE \|/);
  assert.match(markdown, /basic-suite result as a non-blocking warning/);
  assert.match(markdown, /confirmation pairs when unsettled/);
  const full = renderReport({ ...report, suite: 'full' });
  assert.match(full, /Status: \*\*INCONCLUSIVE\*\* — runner too noisy to conclude; blocking for the full suite/);
  assert.match(full, /full-suite result fails the check/);
});

test('performance measurements require complete successful tool execution', () => {
  const meta = { schemaVersion: 1, status: 'ok', exit: { code: 0 }, mock: { requests: 2 },
    sampling: { backend: 'rusage', withTree: true }, summary: { count: 10 },
    duration: { endToEndMs: 1000 }, cost: { cpuSeconds: 0.5 }, peaks: { treeRssBytes: 1024 } };
  const messages = [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call_long_run_1', name: 'bash' }] },
    { role: 'toolResult', toolCallId: 'call_long_run_1', isError: false },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];
  assert.equal(validateRun(meta, messages, { turns: 1 }, 'done').rssBytes, 1024);
  const expected = [{ message: { content: '', tool_calls: [{ function: { arguments: { command: 'pwd' } } }] } }];
  const withArguments = structuredClone(messages);
  withArguments[0].content[0].arguments = { command: 'pwd' };
  assert.doesNotThrow(() => validateRun(meta, withArguments, { turns: 1 }, 'done', expected));
  withArguments[0].content[0].arguments.command = 'true';
  assert.throws(() => validateRun(meta, withArguments, { turns: 1 }, 'done', expected), /command changed/);
  withArguments[0].content[0].arguments.command = 'pwd';
  expected[0].message.content = 'body that must be retained';
  assert.throws(() => validateRun(meta, withArguments, { turns: 1 }, 'done', expected), /body changed/);
  for (const mutate of [
    (m, _) => { m.status = 'timeout'; }, (m, _) => { m.mock.requests = 1; },
    (m, _) => { m.sampling.backend = 'ps'; }, (m, _) => { m.summary.count = 0; },
    (m, _) => { m.cost.cpuSeconds = null; }, (_, rows) => { rows[1].isError = true; },
    (_, rows) => { rows[1].toolCallId = 'wrong'; }, (_, rows) => { rows.pop(); },
    (_, rows) => { rows.push(rows[1]); },
  ]) {
    const copiedMeta = structuredClone(meta), copiedMessages = structuredClone(messages);
    mutate(copiedMeta, copiedMessages);
    assert.throws(() => validateRun(copiedMeta, copiedMessages, { turns: 1 }, 'done'));
  }
});

test('performance workflow uses pinned mock input and an unprivileged PR job', () => {
  const workflow = parseYaml(readFileSync(new URL('../.github/workflows/performance.yml', import.meta.url), 'utf8'));
  const config = JSON.parse(readFileSync(new URL('../scripts/perf/config.json', import.meta.url), 'utf8'));
  assert.ok(Object.hasOwn(workflow.on, 'pull_request'));
  assert.ok(!Object.hasOwn(workflow.on, 'pull_request_target'));
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const steps = workflow.jobs.performance.steps;
  const benchmark = steps.find(s => s.with?.repository === 'KonghaYao/harness-perf-benchmark');
  assert.equal(benchmark.with.ref, config.benchmarkRevision);
  assert.match(config.benchmarkRevision, /^[a-f0-9]{40}$/);
  for (const step of steps.filter(s => s.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/);
  const standard = config.scenarios.find(s => s.id === 'upstream-100');
  assert.deepEqual([standard.turns, standard.bodyKb, standard.chunkSize], [100, 4, 64]);
  assert.ok(config.scenarios.some(s => s.minimumTextUnits > 1048576));
});

test('release tags are canonical and must match both source versions without overriding them', t => {
  for (const tag of ['v0.4.13', 'v1.0.0-rc.1', 'v0.0.0', 'v2.3.4-beta-test.0'])
    assert.equal(versionFromTag(tag), tag.slice(1));
  for (const tag of [undefined, '', '0.4.13', 'v01.2.3', 'v1.02.3', 'v1.2.03', 'v1.2.3-01', 'v1.2.3+build', 'v1.2.3\n', 'v1.2.3;echo bad', 'v1.2.3/../bad'])
    assert.throws(() => versionFromTag(tag), /Release tag/);
  const f = fixture(t);
  mkdirSync(path.join(f.root, 'packages/tui'), { recursive: true });
  const manifest = path.join(f.root, 'packages/tui/package.json');
  writeFileSync(manifest, JSON.stringify({ version: '0.4.12', private: true }));
  writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ version: '0.4.12', private: true }));
  const before = readFileSync(manifest);
  assert.equal(cliBuildVersion(f.root, 'v0.4.12'), '0.4.12');
  assert.throws(() => cliBuildVersion(f.root, 'v0.4.13-rc.1'), /Release tag must match/);
  assert.deepEqual(readFileSync(manifest), before);
  writeFileSync(manifest, JSON.stringify({ version: '0.4.13' }));
  assert.throws(() => cliBuildVersion(f.root, null), /Root and TUI/);
});

function cliReleaseFixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'cli-release-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'checkout'), remote = path.join(home, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['init', '--initial-branch=main', root], { stdio: 'ignore' });
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('config', 'user.name', 'Release Fixture'); git('config', 'user.email', 'release@example.invalid');
  git('config', 'core.hooksPath', path.join(home, 'no-hooks'));
  mkdirSync(path.join(root, 'packages/tui'), { recursive: true });
  for (const name of ['package.json', 'packages/tui/package.json']) writeFileSync(path.join(root, name), JSON.stringify({ name: 'fixture', version: '1.2.3', private: true }, null, 2) + '\n');
  git('add', '.'); git('commit', '-m', 'Fixture baseline'); git('remote', 'add', 'origin', remote); git('push', '-u', 'origin', 'main');
  return { root, remote, git, base: git('rev-parse', 'HEAD') };
}

test('release command bumps source before tagging, pushes a release branch and opens its version PR', t => {
  const f = cliReleaseFixture(t);
  const prs = [];
  const plan = releaseCli({ root: f.root, version: '1.2.4', dryRun: true });
  assert.equal(plan.tag, 'v1.2.4');
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  const result = releaseCli({ root: f.root, version: '1.2.4', openPullRequest: request => prs.push(request) });
  assert.equal(f.git('branch', '--show-current'), 'release/v1.2.4');
  assert.equal(f.git('cat-file', '-t', 'v1.2.4'), 'tag');
  assert.equal(f.git('rev-parse', 'v1.2.4^{commit}'), result.revision);
  assert.equal(f.git('rev-parse', 'origin/main'), f.base);
  assert.equal(f.git('rev-parse', 'origin/release/v1.2.4'), result.revision);
  for (const name of ['package.json', 'packages/tui/package.json'])
    assert.equal(JSON.parse(f.git('show', `v1.2.4:${name}`)).version, '1.2.4');
  assert.equal(prs.length, 1);
  assert.equal(prs[0].branch, 'release/v1.2.4');
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0], f.base);
  assert.ok(f.git('ls-remote', 'origin', 'refs/tags/v1.2.4'));
});

test('release command rejects dirty trees, version regressions, stale bases and existing remote tags', t => {
  const f = cliReleaseFixture(t);
  const release = version => releaseCli({ root: f.root, version, dryRun: true });
  for (const version of ['1.2.3', '1.2.2', '1.2.3-rc.1']) assert.throws(() => release(version), /must be newer/);
  writeFileSync(path.join(f.root, 'untracked'), 'unfinished');
  assert.throws(() => release('1.2.4'), /clean working tree/);
  f.git('add', 'untracked'); f.git('commit', '-m', 'Unreviewed change');
  assert.throws(() => release('1.2.4'), /latest origin\/main/);
  f.git('switch', '--detach', f.base);
  f.git('tag', 'v1.2.4'); f.git('push', 'origin', 'refs/tags/v1.2.4'); f.git('tag', '-d', 'v1.2.4');
  assert.throws(() => release('1.2.4'), /already exists on origin/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  assert.equal(f.git('status', '--porcelain'), '');
  for (const [a, b] of [['1.2.4', '1.2.3'], ['1.2.4', '1.2.4-rc.1'], ['1.2.4-rc.10', '1.2.4-rc.2'], ['1.2.4-beta', '1.2.4-1']]) {
    assert.equal(compareVersions(a, b), 1); assert.equal(compareVersions(b, a), -1);
  }
});

test('rejected tag pushes cannot leave a partial remote release branch or open a version PR', { skip: process.platform === 'win32' }, t => {
  const f = cliReleaseFixture(t);
  execFileSync('git', ['--git-dir', f.remote, 'config', 'core.hooksPath', path.join(f.remote, 'hooks')]);
  writeFileSync(path.join(f.remote, 'hooks/update'), '#!/bin/sh\ncase "$1" in refs/tags/*) exit 1 ;; esac\nexit 0\n', { mode: 0o755 });
  let opened = false;
  assert.throws(() => releaseCli({ root: f.root, version: '1.2.4', openPullRequest: () => { opened = true; } }));
  assert.equal(opened, false);
  assert.equal(f.git('ls-remote', 'origin', 'refs/tags/v1.2.4', 'refs/heads/release/v1.2.4'), '');
  assert.equal(f.git('rev-parse', 'origin/main'), f.base);
  assert.equal(f.git('rev-parse', 'v1.2.4^{commit}'), f.git('rev-parse', 'HEAD'));
});

test('npm release manifests require native SQLite and pin installed external dependencies', t => {
  const f = fixture(t);
  for (const name of cliExternalModules) {
    const directory = path.join(f.root, 'node_modules', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.2.3' }));
  }
  const manifest = releaseManifest([f.root], '0.4.13');
  assert.equal(manifest.version, '0.4.13');
  assert.equal(manifest.private, true);
  assert.equal(manifest.bin.mcode, 'cli.js');
  assert.equal(manifest.dependencies['better-sqlite3'], '1.2.3');
  assert.equal(manifest.dependencies['@vscode/ripgrep'], '1.2.3');
  assert.equal(manifest.optionalDependencies['@mariozechner/clipboard'], '1.2.3');
  assert.equal(manifest.scripts, undefined);
  const conflicting = path.join(f.source, 'node_modules/better-sqlite3');
  mkdirSync(conflicting, { recursive: true });
  writeFileSync(path.join(conflicting, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '9.9.9' }));
  assert.throws(() => releaseManifest([f.root, f.source], '0.4.13'), /Expected one installed version/);
});

test('CLI publication requires every supported installation receipt for the exact archive and revision', t => {
  const f = fixture(t);
  const archive = path.join(f.root, 'minimax-code-0.4.13.tar.gz');
  writeFileSync(archive, 'synthetic archive');
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`);
  const revision = 'a'.repeat(40);
  const reports = path.join(f.root, 'reports');
  for (const target of cliReleaseTargets) {
    const directory = path.join(reports, `cli-install-${target.os}-${target.node}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'package-install.json'), JSON.stringify({
      status: 'PASS', version: '0.4.13', revision, sha256,
      platform: target.os.startsWith('ubuntu') ? 'linux' : 'darwin', node: `v${target.node}`,
    }));
    writeFileSync(path.join(directory, 'verification.json'), JSON.stringify({
      status: 'PASS', profile: 'package', revision, gates: [{ name: 'test:release-package', status: 'PASS' }],
    }));
  }
  const options = { archive, reports, version: '0.4.13', revision };
  assert.equal(validateReleaseReports(options), sha256);
  assert.throws(() => validateReleaseReports({ ...options, version: '0.4.14' }));
  assert.throws(() => validateReleaseReports({ ...options, revision: 'b'.repeat(40) }));
  const target = cliReleaseTargets.at(-1);
  const receipt = path.join(reports, `cli-install-${target.os}-${target.node}`, 'package-install.json');
  const original = readFileSync(receipt, 'utf8');
  for (const override of [{ sha256: '0'.repeat(64) }, { status: 'FAIL' }, { node: 'v20.0.0' }]) {
    writeFileSync(receipt, JSON.stringify({ ...JSON.parse(original), ...override }));
    assert.throws(() => validateReleaseReports(options));
  }
  rmSync(receipt);
  assert.throws(() => validateReleaseReports(options));
  writeFileSync(receipt, original);
  writeFileSync(archive, 'changed archive');
  assert.throws(() => validateReleaseReports(options));
});

test('CLI release publishes only tag pushes after full verification and archive installation', () => {
  const workflow = parseYaml(readFileSync(new URL('../.github/workflows/cli-release.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on.push, { tags: ['v*'] });
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, false);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.ok(workflow.jobs.build.steps.some(step => step.run === 'pnpm verify'));
  assert.ok(workflow.jobs.build.steps.some(step => step.run?.includes('cliBuildVersion(process.cwd(), tag)')));
  assert.deepEqual(workflow.jobs.publish.needs, ['build', 'install']);
  assert.equal(workflow.jobs.publish.if, "github.event_name == 'push'");
  assert.equal(workflow.jobs.publish.permissions.contents, 'write');
  assert.equal(workflow.jobs.install.strategy.matrix, '${{ fromJSON(needs.build.outputs.matrix) }}');
  const install = workflow.jobs.install.steps.find(step => step.run === 'pnpm verify --profile package');
  assert.ok(install.env.MCODE_RELEASE_ARCHIVE.endsWith('.tar.gz'));
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.uses && !step.uses.startsWith('./')) assert.match(step.uses, /@[a-f0-9]{40}$/);
      if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
      if (step.run) assert.doesNotMatch(step.run, /\$\{\{.*(?:inputs|github\.(?:ref|event))/);
    }
  }
});
import { runInNewContext } from 'node:vm';

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
  const packageProfile = f.run(['--profile', 'package', '--list']);
  if (['linux', 'darwin'].includes(process.platform)) {
    assert.equal(packageProfile.status, 0, packageProfile.stderr);
    assert.equal(packageProfile.stdout.trim(), 'test:release-package');
  } else assert.notEqual(packageProfile.status, 0);
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

test('ordinary CI runs a focused Windows contract while compatibility remains macOS/Linux', () => {
  const readWorkflow = name => parseYaml(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
  const ci = readWorkflow('ci');
  assert.ok(Object.hasOwn(ci.on, 'pull_request'));
  assert.deepEqual(ci.on.push.branches, ['main']);
  assert.deepEqual(Object.keys(ci.jobs).sort(), ['changes', 'docs', 'verification', 'verify']);
  assert.deepEqual(ci.jobs.verify.strategy.matrix.os, ['ubuntu-latest', 'ubuntu-24.04-arm', 'macos-latest', 'windows-latest']);
  assert.deepEqual(ci.jobs.verify.strategy.matrix.node, ['24']);
  assert.deepEqual(ci.jobs.verify.strategy.matrix.include, [
    { os: 'ubuntu-latest', node: '24', profile: 'full' },
    { os: 'ubuntu-24.04-arm', node: '24', profile: 'full' },
    { os: 'windows-latest', node: '24', profile: 'windows' },
  ]);
  assert.equal(ci.jobs.verify.needs, 'changes');
  assert.equal(ci.jobs.verify.if, "needs.changes.outputs.docs_only == 'false'");
  assert.equal(ci.jobs.docs.if, "needs.changes.outputs.docs_only == 'true'");
  assert.equal(ci.jobs.verification.if, '${{ always() }}');
  assert.deepEqual(ci.jobs.verification.needs, ['changes', 'docs', 'verify']);
  assert.ok(ci.jobs.verify.steps.some(step => step.run === "pnpm verify --profile ${{ matrix.profile || 'platform' }}"));
  const compatibility = readWorkflow('compatibility');
  assert.deepEqual(Object.keys(compatibility.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(compatibility.jobs.compatibility.strategy.matrix.node, ['22.19.0', '24.2.0', '25', '26']);
  assert.deepEqual(compatibility.jobs.compatibility.strategy.matrix.os, ['ubuntu-latest', 'ubuntu-24.04-arm', 'macos-latest']);
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
  assert.deepEqual(validate.strategy.matrix.os, ['ubuntu-latest', 'macos-latest']);
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

test('candidate rejects mismatched receipts and requires successful same-revision Linux and macOS reports', t => {
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
  for (const platform of ['linux', 'darwin']) {
    const folder = path.join(reports, platform);
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'verification.json'), JSON.stringify({ revision, platform, arch: 'fixture', node: 'v24', profile: 'archive', status: 'PASS', gates: [{ name: 'build', status: 'PASS' }] }));
  }
  assert.equal(run('finalize', '--reports', reports).status, 0);
  const manifest = JSON.parse(readFileSync(path.join(f.directory, 'candidate.json')));
  assert.equal(manifest.sha256, receipt.sha256);
  assert.deepEqual(manifest.validation.map(report => report.platform).sort(), ['darwin', 'linux']);
  const macos = path.join(reports, 'darwin/verification.json');
  const report = JSON.parse(readFileSync(macos));
  for (const change of [{ status: 'FAIL' }, { revision: 'b'.repeat(40) }, { gates: [{ name: 'build', status: 'NOT_RUN' }] }, { platform: 'linux' }, { platform: 'win32' }]) {
    writeFileSync(macos, JSON.stringify({ ...report, ...change }));
    assert.notEqual(run('finalize', '--reports', reports).status, 0);
  }
  rmSync(path.dirname(macos), { recursive: true });
  assert.notEqual(run('finalize', '--reports', reports).status, 0);
});


test('Windows contract profile fails closed off Windows', () => {
  const result = spawnSync(process.execPath, ['scripts/verify.mjs', '--profile', 'windows', '--list'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });
  if (process.platform === 'win32') {
    assert.equal(result.status, 0, result.stderr);
  } else {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires a Windows host/);
  }
});

test('Windows contract profile selects focused gates', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'windows-profile-'));
  try {
    const fixture = path.join(root, 'verify.mjs');
    copyFileSync(new URL('../scripts/verify.mjs', import.meta.url), fixture);
    const preload = path.join(root, 'platform.cjs');
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32' });\n");
    const result = spawnSync(process.execPath, ['--require', preload, fixture, '--profile', 'windows', '--list'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      'check:source',
      'check:tsconfig',
      'export source preview',
      'test:release-tools',
      'lint:tui',
      'build',
      'check:standalone',
      'test:artifact',
      'test:windows',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  const forms = ['01-bug-report.yml', '02-feature-request.yml', '03-question.yml', 'docs.yml'];
  for (const name of forms) {
    const form = parseYaml(readFileSync(new URL(`../.github/ISSUE_TEMPLATE/${name}`, import.meta.url), 'utf8'));
    const product = form.body.find(field => field.id === 'product');
    assert.equal(product.validations.required, name !== '03-question.yml');
    assert.equal(product.attributes.label, 'Product or interface');
    assert.ok(product.attributes.options.includes('CLI - interactive TUI'));
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

test('issue product labels follow current form answers without replacing unrelated labels', async () => {
  const workflow = parseYaml(readFileSync(new URL('../.github/workflows/label-issue-product.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on, { issues: { types: ['opened', 'edited'] } });
  assert.deepEqual(workflow.permissions, { issues: 'write' });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const job = workflow.jobs['label-product'];
  assert.equal(job.if, "${{ github.repository == 'MiniMax-AI/minimax-code' && github.event.repository.private == false && !github.event.issue.pull_request }}");
  assert.equal(job.steps.length, 1); // No checkout or execution of issue-supplied code.
  const run = job.steps[0].run;
  assert.doesNotMatch(run, /\$\{\{/);
  const script = run.match(/^node <<'EOF'\r?\n([\s\S]*?)\r?\nEOF\s*$/)?.[1];
  assert.ok(script);
  async function replay(body, labels, failureStatus) {
    const writes = [];
    const issuePath = '/repos/MiniMax-AI/minimax-code/issues/7';
    await runInNewContext(script, {
      require: name => {
        assert.equal(name, 'node:fs');
        return { readFileSync: () => JSON.stringify({ issue: { number: 7, body: '### Product or interface\n\nDesktop app', labels: [] } }) };
      },
      process: { env: { GITHUB_EVENT_PATH: 'fixture.json', GITHUB_REPOSITORY: 'MiniMax-AI/minimax-code', GITHUB_API_URL: 'https://api.github.invalid', GH_TOKEN: 'synthetic' } },
      fetch: async (url, options) => {
        assert.equal(options.headers.Authorization, 'Bearer synthetic');
        if (options.method === 'GET') {
          assert.equal(url, `https://api.github.invalid${issuePath}`);
          return { ok: !failureStatus, status: failureStatus || 200, json: async () => ({ body, labels: labels.map(name => ({ name })) }) };
        }
        writes.push({ method: options.method, path: url.replace(`https://api.github.invalid${issuePath}`, ''), body: options.body && JSON.parse(options.body) });
        return { ok: true, status: 204 };
      },
    });
    return writes;
  }
  const answer = product => `### Product or interface\n\n${product}\n\n### Question\n\nSynthetic question`;
  const add = name => ({ method: 'POST', path: '/labels', body: { labels: [name] } });
  const remove = name => ({ method: 'DELETE', path: `/labels/${name}`, body: undefined });
  assert.deepEqual(await replay(answer('CLI - interactive TUI'), ['bug', 'desktop']), [add('tui'), remove('desktop')]);
  assert.deepEqual(await replay(answer('Desktop app').replace(/\n/g, '\r\n'), ['question']), [add('desktop')]);
  assert.deepEqual(await replay(answer('Desktop app'), ['desktop', 'bug']), []);
  for (const product of ['CLI - headless', 'CLI - ACP', 'Source build or repository tooling']) {
    assert.deepEqual(await replay(answer(product), ['tui', 'bug']), [remove('tui')]);
  }
  for (const body of [null, 'Desktop app', answer('_No response_'), answer('$(touch must-not-execute)')]) {
    assert.deepEqual(await replay(body, ['desktop', 'bug']), []);
  }
  await assert.rejects(replay(answer('Desktop app'), [], 403), /GitHub GET failed: 403/);
});

test('issue forms label incoming reports for triage and retain collaborator-only PR guidance', () => {
  for (const [name, type] of [
    ['01-bug-report.yml', 'bug'], ['02-feature-request.yml', 'enhancement'],
    ['03-question.yml', 'question'], ['docs.yml', 'documentation'],
  ]) {
    const form = parseYaml(readFileSync(new URL(`../.github/ISSUE_TEMPLATE/${name}`, import.meta.url), 'utf8'));
    assert.deepEqual(form.labels, [type, 'needs-triage']);
  }
  const config = parseYaml(readFileSync(new URL('../.github/ISSUE_TEMPLATE/config.yml', import.meta.url), 'utf8'));
  assert.equal(config.blank_issues_enabled, false);
  const policy = config.contact_links.find(link => link.url.endsWith('/CONTRIBUTING.md'));
  assert.match(policy.about, /only from repository collaborators/);
  assert.match(policy.about, /external PRs are not accepted/);
  const question = parseYaml(readFileSync(new URL('../.github/ISSUE_TEMPLATE/03-question.yml', import.meta.url), 'utf8'));
  assert.equal(question.body.find(field => field.id === 'platform').validations.required, false);
  assert.equal(question.body.find(field => field.id === 'question').validations.required, true);
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

test('TUI lint rejects semantic regressions in source and tests while preserving engine exceptions', async () => {
  const { ESLint } = await import('eslint');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const eslint = new ESLint({ cwd: root });
  const rulesFor = async (source, filePath) => {
    const [result] = await eslint.lintText(source, { filePath });
    assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
    return result.messages.filter(message => message.severity === 2).map(message => message.ruleId);
  };
  const shadow = 'const value = 1; export function sample(value: number) { return value; }\n';
  for (const file of ['packages/tui/src/lint-probe.ts', 'packages/tui/test/unit/lint-probe.test.ts']) {
    assert.ok((await rulesFor(shadow, file)).includes('@typescript-eslint/no-shadow'), file);
    assert.ok((await rulesFor('export const compare = (value: number) => value == 1;\n', file)).includes('eqeqeq'), file);
  }
  assert.ok((await rulesFor('export const compare = (value) => value == 1;\n', 'packages/tui/test/lint-probe.mjs')).includes('eqeqeq'));
  assert.ok(!(await rulesFor(shadow, 'packages/tui/src/tui/engine/lint-probe.ts')).includes('@typescript-eslint/no-shadow'));
  assert.ok((await rulesFor(shadow, 'packages/tui/src/tui/engine/public.ts')).includes('@typescript-eslint/no-shadow'));
  assert.ok((await rulesFor('export const compare = (value: number) => value == 1;\n', 'packages/tui/src/tui/engine/lint-probe.ts')).includes('eqeqeq'));
  const [formatting] = await eslint.lintText('export const label = "synthetic";\n', { filePath: 'packages/tui/src/lint-probe.ts' });
  assert.ok(formatting.messages.some(message => message.ruleId === 'prettier/prettier' && message.severity === 1));
  assert.equal(await eslint.isPathIgnored('packages/tui/test/unit/lint-probe.test.ts'), false);
  assert.equal(await eslint.isPathIgnored('packages/tui/test/pi-084-upstream/lint-probe.test.ts'), true);
  assert.equal(await eslint.isPathIgnored('third_party/pi-mono/packages/tui/src/lint-probe.ts'), true);
});

test('TUI lint failure stops full and platform verification before compilation or build', t => {
  const fixture = verificationFixture(t);
  for (const profile of ['full', 'platform', 'archive']) {
    const result = fixture.run(['--profile', profile], { VERIFY_FIXTURE_FAIL: 'lint:tui' });
    assert.equal(result.status, 1, result.stderr);
    const report = fixture.report();
    assert.equal(report.gates.find(gate => gate.name === 'lint:tui').status, 'FAIL');
    assert.equal(report.gates.find(gate => gate.name === 'lint:tui').exitCode, 17);
    assert.equal(report.gates.find(gate => gate.name === 'build').status, 'NOT_RUN');
  }
});
