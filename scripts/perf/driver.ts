// Run under Bun. Reuse the pinned upstream generator, mock and sampler unchanged.
import { readFileSync, mkdirSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateRun, validateRequest } from './report.mjs';

const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const { runPerf } = await import(pathToFileURL(join(input.benchmark, 'scripts/perf/run.ts')).href);
const { loadPerfConfig } = await import(pathToFileURL(join(input.benchmark, 'scripts/perf/config.ts')).href);
const workspace = join(input.directory, 'workspace');
const data = join(input.directory, 'data');
mkdirSync(workspace, { recursive: true });
mkdirSync(data, { recursive: true });
writeFileSync(join(workspace, 'README.txt'), 'Synthetic performance fixture.\n');
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
const port = server.port;
server.stop(true);
const scenario = JSON.parse(readFileSync(input.script, 'utf8'));
let requests = 0;
let auditFailure: string | undefined;
const proxy = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
  const url = new URL(request.url);
  const bytes = await request.arrayBuffer();
  if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
    requests++;
    const start = performance.now();
    let error: string | undefined;
    try { validateRequest(JSON.parse(new TextDecoder().decode(bytes)), scenario.responses, requests, workspace, cfg.prompt); }
    catch (failure) { error = String(failure); auditFailure ??= error; }
    appendFileSync(join(input.directory, 'requests.jsonl'), JSON.stringify({ request: requests,
      bytes: bytes.byteLength, validationMs: performance.now() - start, ok: !error, ...(error ? { error } : {}) }) + '\n');
  }
  return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
    method: request.method, headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
    ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: bytes }),
  });
} });
writeFileSync(join(data, 'config.yaml'), [
  'logLevel: info', 'custom_provider:', '  llm-mock:', '    name: llm-mock',
  '    kind: custom', '    enabled: true', '    api: openai-completions',
  '    options:', '      apiKey: mock-key', `      baseURL: http://127.0.0.1:${proxy.port}/v1`,
  '      authMode: api-key', '    models:', '      llm-mock:', '        reasoning: true',
  '        thinking_config:', '          mode: switchable', "          default_value: 'true'",
  ...(input.scenario.contextWindow ? ['        limit:', `          context: ${input.scenario.contextWindow}`, '          output: 16384'] : []), '',
].join('\n'));
const cfg = loadPerfConfig([
  '--script', input.script, '--exhausted', 'stop', '--work-dir', workspace,
  '--out-dir', join(input.directory, 'raw'), '--harness', 'minimax-code',
  '--port', String(port), '--interval-ms', String(input.intervalMs),
  '--timeout-ms', String(input.scenario.timeoutMs), '--sampler', 'rusage',
  '--prompt', '压测：请持续用只读命令检查当前目录状态',
]);
let code: number;
try { code = await runPerf(cfg, {
  harnessCommand: () => [input.node,
    ...(input.profile ? ['--cpu-prof', `--cpu-prof-dir=${input.directory}`] : []),
    '--import', pathToFileURL(join(input.control, 'test/network-deny.mjs')).href,
    join(input.build, 'dist/cli.js'), 'exec', '--permission', 'off', '--cwd', workspace,
    '--model', 'custom_provider:llm-mock/llm-mock', cfg.prompt],
  harnessEnv: () => ({ MINIMAX_DATA_DIR: data, PI_TELEMETRY: '0',
    MCODE_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${proxy.port}`,
    MCODE_TEST_NETWORK_AUDIT: join(input.directory, 'network.log'), MCODE_TEST_MANAGED_OFFLINE: '1',
  }),
}); } finally { proxy.stop(true); }
if (code !== 0) throw new Error(`Upstream runner failed: ${code}`);
if (auditFailure) throw new Error(`Request history validation failed: ${auditFailure}`);
if (requests !== input.scenario.turns + 1) throw new Error('Request audit count mismatch');
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = join(directory, entry.name);
    return entry.isDirectory() ? files(name) : [name];
  });
}
const metas = files(join(input.directory, 'raw')).filter(p => p.endsWith('/run.json'));
if (metas.length !== 1) throw new Error('Expected exactly one upstream run');
const histories = files(data).filter(p => p.endsWith('/messages.jsonl'));
if (histories.length !== 1) throw new Error('Expected exactly one canonical session history');
const meta = JSON.parse(readFileSync(metas[0]!, 'utf8'));
const messages = readFileSync(histories[0]!, 'utf8').trim().split('\n').map(line => JSON.parse(line).message);
const metrics = validateRun(meta, messages, input.scenario, scenario.responses[input.scenario.turns].message.content, scenario.responses, workspace);
writeFileSync(join(input.directory, 'result.json'), JSON.stringify({ metrics, meta: resolve(metas[0]!), history: resolve(histories[0]!) }, null, 2));
