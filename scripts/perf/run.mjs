import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { cpus, totalmem, platform, release, arch } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { compareRuns, renderReport, selectScenarios } from './report.mjs';

const control = fileURLToPath(new URL('../../', import.meta.url));
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const { values } = parseArgs({ options: {
  base: { type: 'string' }, head: { type: 'string' }, benchmark: { type: 'string' },
  out: { type: 'string' }, scenario: { type: 'string' },
  suite: { type: 'string', default: 'basic' },
}, strict: true });
for (const name of ['base', 'head', 'benchmark', 'out']) {
  if (!values[name]) throw new Error(`Missing --${name}`);
}
const base = resolve(values.base), head = resolve(values.head);
const benchmark = resolve(values.benchmark), out = resolve(values.out);
if (existsSync(out)) throw new Error('Output directory must be new; old results cannot be reused');
if (platform() !== 'darwin') throw new Error('This benchmark requires macOS process-tree rusage');
const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
if (git(benchmark, 'rev-parse', 'HEAD') !== config.benchmarkRevision) throw new Error('Wrong benchmark revision');
if (git(benchmark, 'status', '--porcelain', '--untracked-files=no')) throw new Error('Benchmark has tracked edits');
const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim();
const scenarios = selectScenarios(config, values);
mkdirSync(out, { recursive: true });
const report = {
  status: 'RUNNING', baseRevision: git(base, 'rev-parse', 'HEAD'), headRevision: git(head, 'rev-parse', 'HEAD'),
  benchmarkRepository: config.benchmarkRepository, benchmarkRevision: config.benchmarkRevision,
  nodeVersion: process.version, bunVersion: execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim(),
  host: { cpuModel: cpus()[0]?.model, cpus: cpus().length, totalMemBytes: totalmem(), platform: platform(), osRelease: release(), arch: arch() },
  config, suite: values.scenario ? 'focused' : values.suite, selectedScenarios: scenarios.map(s => s.id), results: [],
  builds: Object.fromEntries([['base', base], ['head', head]].map(([name, directory]) => [name, {
    path: directory, entrySha256: createHash('sha256').update(readFileSync(join(directory, 'dist/cli.js'))).digest('hex'),
  }])),
};
function save() {
  writeFileSync(join(out, 'comparison.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(out, 'comparison.md'), renderReport(report));
}
// Children receive synthetic state and an explicit environment, never local provider credentials.
const environment = { PATH: process.env.PATH, HOME: join(out, 'home'), TMPDIR: process.env.TMPDIR ?? '/tmp',
  LANG: 'en_US.UTF-8', TERM: 'dumb', CI: '1', NO_COLOR: '1' };
mkdirSync(environment.HOME, { recursive: true });
function run(build, scenario, script, name, profile = false) {
  const directory = join(out, scenario.id, name);
  mkdirSync(directory, { recursive: true });
  const input = { benchmark, control, build, script, scenario, directory, profile,
    intervalMs: config.intervalMs, node: process.execPath };
  const inputPath = join(directory, 'input.json');
  writeFileSync(inputPath, JSON.stringify(input));
  const result = spawnSync(bun, [join(control, 'scripts/perf/driver.ts'), inputPath], {
    cwd: benchmark, env: environment, encoding: 'utf8', timeout: scenario.timeoutMs + 45000, maxBuffer: 16 * 1024 * 1024,
  });
  writeFileSync(join(directory, 'driver.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.error || result.status !== 0) throw new Error(`${scenario.id}/${name} failed; see driver.log (${result.error?.message ?? result.status})`);
  return { ...JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8')), directory };
}
save();
try {
  for (const scenario of scenarios) {
    const script = join(out, `${scenario.id}.json`);
    execFileSync(bun, [join(benchmark, 'scripts/perf/gen-long-run.ts'), '--turns', String(scenario.turns),
      '--body-kb', String(scenario.bodyKb), '--tool', 'bash', '--chunk-size', String(scenario.chunkSize),
      '--chunk-delay-ms', '0', '--out', script], { cwd: benchmark, env: environment });
    const scriptData = JSON.parse(readFileSync(script, 'utf8'));
    const textUnits = scriptData.responses.slice(0, scenario.turns).reduce((sum, entry) => sum + entry.message.content.length, 0);
    if (scenario.minimumTextUnits && textUnits < scenario.minimumTextUnits) throw new Error('Long-history fixture no longer exceeds token cache capacity');
    const result = { id: scenario.id, textUnits, scenarioSha256: createHash('sha256').update(readFileSync(script)).digest('hex'), warmups: [], pairs: [] };
    report.results.push(result);
    save();
    for (let i = 0; i < config.warmups; i++) for (const [side, directory] of [['base', base], ['head', head]]) {
      console.log(`[perf] ${scenario.id}: ${side} warmup`);
      result.warmups.push({ side, ...run(directory, scenario, script, `${side}-warmup-${i}`) });
      save();
    }
    for (let pair = 0; pair < config.repetitions; pair++) {
      const item = { pair, order: pair % 2 ? ['head', 'base'] : ['base', 'head'] };
      result.pairs.push(item);
      for (const side of item.order) {
        console.log(`[perf] ${scenario.id}: pair ${pair + 1}, ${side}`);
        item[side] = run(side === 'base' ? base : head, scenario, script, `${side}-${pair}`);
        save();
      }
    }
    result.comparison = compareRuns(result.pairs.map(p => p.base.metrics), result.pairs.map(p => p.head.metrics), config);
    save();
    if (result.comparison.some(row => row.status === 'REGRESSION')) {
      console.log(`[perf] ${scenario.id}: separate diagnostic CPU profile`);
      try { result.diagnostic = run(head, scenario, script, 'head-profile', true); }
      catch (error) { result.diagnosticError = error.message; }
      save();
    }
  }
  const statuses = report.results.flatMap(r => r.comparison.map(row => row.status));
  report.status = statuses.includes('REGRESSION') ? 'REGRESSION' : statuses.includes('INCONCLUSIVE') ? 'INCONCLUSIVE' : 'PASS';
  process.exitCode = report.status === 'PASS' ? 0 : report.status === 'REGRESSION' ? 1 : 2;
} catch (error) {
  report.status = 'ERROR';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  save();
  const markdown = readFileSync(join(out, 'comparison.md'), 'utf8');
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}
