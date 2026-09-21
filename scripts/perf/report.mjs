import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';

const textContent = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(b => b.type === 'text').map(b => b.text).join('') : '';

export function selectScenarios(config, { suite = 'basic', scenario } = {}) {
  assert.ok(Object.hasOwn(config.suites, suite), 'Unknown performance suite');
  const ids = scenario ? [scenario] : config.suites[suite];
  assert.ok(ids.length > 0 && new Set(ids).size === ids.length, 'Invalid scenario selection');
  return ids.map(id => {
    const selected = config.scenarios.find(item => item.id === id);
    assert.ok(selected, `Unknown scenario: ${id}`);
    return selected;
  });
}

export function validateToolOutput(content, command, workspace) {
  const text = textContent(content).trim();
  if (command.startsWith('echo ')) assert.equal(text, command.slice(5), 'Echo result changed');
  else if (command === 'pwd') assert.equal(text, realpathSync(workspace), 'Working directory result changed');
  else if (command === 'ls' || command === 'ls -la') assert.match(text, /(?:^|\s)README\.txt(?:\s|$)/, 'Directory listing lost fixture');
  else throw new Error('Unknown benchmark command');
}

export function validateRequest(body, responses, requestNumber, workspace, prompt) {
  const rounds = requestNumber - 1;
  assert.ok(rounds >= 0 && rounds < responses.length - 1, 'Unexpected request');
  assert.ok(Array.isArray(body.messages), 'Request messages missing');
  assert.ok(typeof prompt === 'string' && prompt.length > 0, 'Expected task missing');
  const conversation = body.messages.filter(m => m.role !== 'system' && m.role !== 'developer');
  assert.equal(conversation.length, 1 + rounds * 2, 'Request conversation length changed');
  assert.equal(conversation[0]?.role, 'user', 'Initial user task missing');
  assert.ok(textContent(conversation[0].content).includes(prompt), 'Initial user task changed');
  for (let i = 0; i < rounds; i++) {
    assert.equal(conversation[i * 2 + 1].role, 'assistant', 'Request conversation order changed');
    assert.equal(conversation[i * 2 + 2].role, 'tool', 'Request conversation order changed');
  }
  const assistant = body.messages.filter(m => m.role === 'assistant');
  const tools = body.messages.filter(m => m.role === 'tool');
  assert.equal(assistant.length, rounds, 'Request lost assistant history');
  assert.equal(tools.length, rounds, 'Request lost tool history');
  for (let i = 0; i < rounds; i++) {
    const expected = responses[i].message;
    assert.equal(textContent(assistant[i].content), expected.content, 'Request history body changed');
    assert.equal(assistant[i].tool_calls?.length, 1, 'Request tool calls changed');
    const call = assistant[i].tool_calls[0];
    assert.equal(call.id, expected.tool_calls[0].id, 'Request call identity changed');
    assert.equal(call.function.name, 'bash', 'Request tool changed');
    const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
    assert.deepEqual(args, expected.tool_calls[0].function.arguments, 'Request command changed');
    assert.equal(tools[i].tool_call_id, call.id, 'Request tool result identity changed');
    validateToolOutput(tools[i].content, args.command, workspace);
  }
}

export function median(values) {
  assert.ok(values.length > 0 && values.every(Number.isFinite), 'Nonempty finite samples required');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function validateRun(meta, messages, scenario, expectedFinal, expectedResponses, workspace) {
  assert.equal(meta.schemaVersion, 1, 'Unknown upstream run schema');
  assert.equal(meta.status, 'ok', 'Benchmark did not complete');
  assert.equal(meta.exit?.code, 0, 'CLI failed');
  assert.equal(meta.mock?.requests, scenario.turns + 1, 'Unexpected model request count');
  assert.equal(meta.sampling?.backend, 'rusage', 'macOS rusage sampler is required');
  assert.equal(meta.sampling?.withTree, true, 'Process-tree sampling is required');
  assert.ok(meta.summary?.count >= 3, 'Insufficient samples');
  const calls = messages.flatMap(m => m.role === 'assistant' ? m.content.filter(b => b.type === 'toolCall') : []);
  const assistant = messages.filter(m => m.role === 'assistant');
  const results = messages.filter(m => m.role === 'toolResult');
  assert.equal(calls.length, scenario.turns, 'Missing or extra tool calls');
  assert.equal(results.length, scenario.turns, 'Missing or extra tool results');
  const ids = new Set();
  for (let i = 0; i < scenario.turns; i++) {
    assert.equal(calls[i].id, `call_long_run_${i + 1}`, 'Unexpected tool sequence');
    assert.equal(calls[i].name, 'bash', 'Unexpected tool');
    if (expectedResponses) {
      assert.deepEqual(calls[i].arguments, expectedResponses[i].message.tool_calls[0].function.arguments, 'Tool command changed');
      assert.equal(assistant[i].content.filter(b => b.type === 'text').map(b => b.text).join(''), expectedResponses[i].message.content, 'History body changed');
    }
    assert.equal(results[i].toolCallId, calls[i].id, 'Tool result does not match call');
    assert.equal(results[i].isError, false, 'Tool execution failed');
    if (expectedResponses && workspace) validateToolOutput(results[i].content, calls[i].arguments.command, workspace);
    assert.ok(!ids.has(results[i].toolCallId), 'Duplicate tool result');
    ids.add(results[i].toolCallId);
  }
  const last = messages.filter(m => m.role === 'assistant').at(-1);
  const final = last?.content.filter(b => b.type === 'text').map(b => b.text).join('');
  assert.equal(final, expectedFinal, 'Final response changed');
  const metrics = {
    durationMs: meta.duration?.endToEndMs,
    cpuSeconds: meta.cost?.cpuSeconds,
    rssBytes: meta.peaks?.treeRssBytes,
  };
  for (const [name, value] of Object.entries(metrics)) {
    assert.ok(Number.isFinite(value) && value > 0, `Invalid ${name}`);
  }
  return metrics;
}

export function spread(values, trim = 0) {
  assert.ok(Number.isInteger(trim) && trim >= 0 && values.length - trim >= 2, 'Too few samples for spread');
  const sorted = [...values].sort((a, b) => a - b);
  let best = Infinity;
  for (let low = 0; low <= trim; low++) {
    const kept = sorted.slice(low, sorted.length - (trim - low));
    best = Math.min(best, (kept[kept.length - 1] - kept[0]) / median(kept));
  }
  return best;
}

export function exitCodeForStatus(status) {
  const codes = { PASS: 0, REGRESSION: 1, ERROR: 1, INCONCLUSIVE: 2 };
  assert.ok(Object.hasOwn(codes, status), `No exit code for status: ${status}`);
  return codes[status];
}

// Two-stage paired classification. With the initial repetitions, only a run
// that is within budget and stable on both sides settles early as PASS;
// anything else asks for the bounded confirmation pairs. At full pair count
// the verdict is final: a regression must exceed the per-pair budget in all
// pairs but at most one, a pass must be within budget by median with both
// sides stable after discarding one extreme sample per side, and the rest is
// INCONCLUSIVE.
export function compareRuns(base, head, config) {
  const confirmPairs = config.confirmPairs ?? 0;
  const total = config.repetitions + confirmPairs;
  assert.equal(base.length, head.length, 'Unpaired base/candidate samples');
  assert.ok(base.length === config.repetitions || base.length === total, 'Unexpected pair count');
  const pairs = base.length, final = pairs === total;
  const trim = final && pairs >= 5 ? 1 : 0;
  const overBudgetNeeded = pairs >= 4 ? pairs - 1 : pairs;
  return Object.entries(config.thresholds).map(([metric, threshold]) => {
    const before = base.map(r => r[metric]);
    const after = head.map(r => r[metric]);
    assert.ok([...before, ...after].every(v => Number.isFinite(v) && v > 0), `Invalid ${metric}`);
    const baseline = median(before), candidate = median(after);
    const baseSpread = spread(before, trim), headSpread = spread(after, trim);
    const stable = baseSpread <= config.maxSpread && headSpread <= config.maxSpread;
    const delta = candidate - baseline;
    const withinBudget = delta <= Math.max(baseline * threshold.relative, threshold.absolute);
    const overBudgetPairs = after.filter((value, i) =>
      value - before[i] > Math.max(before[i] * threshold.relative, threshold.absolute)).length;
    const status = !final ? (withinBudget && stable ? 'PASS' : 'NEEDS_CONFIRMATION')
      : overBudgetPairs >= overBudgetNeeded ? 'REGRESSION'
      : withinBudget && stable ? 'PASS' : 'INCONCLUSIVE';
    return { metric, baseline, candidate, change: delta / baseline,
      pairs, overBudgetPairs, trimmedSamples: trim, baseSpread, headSpread, status };
  });
}

export function renderReport(report) {
  const inconclusive = report.suite === 'full'
    ? ' — runner too noisy to conclude; blocking for the full suite, not evidence of a pass'
    : ' — runner too noisy to conclude; non-blocking for the basic suite, not evidence of a pass';
  const lines = ['# Performance comparison', '',
    `Status: **${report.status}**${report.status === 'INCONCLUSIVE'
      ? inconclusive : ''}`, '',
    '| Item | Value |', '| --- | --- |',
    `| Base | \`${report.baseRevision}\` |`, `| Candidate | \`${report.headRevision}\` |`,
    `| Benchmark | [${report.benchmarkRevision}](${report.benchmarkRepository}/tree/${report.benchmarkRevision}) |`,
    `| Machine | ${report.host.cpuModel}; ${report.host.cpus} CPUs; ${Math.round(report.host.totalMemBytes / 2 ** 30)} GiB; ${report.host.platform} ${report.host.osRelease}; ${report.host.arch} |`,
    `| Runtime | Node ${report.nodeVersion}; Bun ${report.bunVersion} |`,
    `| Suite | ${report.suite}; ${report.selectedScenarios.join(', ')} |`,
    `| Method | One warmup per revision/scenario; ${report.config.repetitions} alternating serial pairs plus up to ${report.config.confirmPairs ?? 0} confirmation pairs when unsettled; 100 ms process-tree rusage sampling |`,
    '', '| Scenario | Metric | Base median | Candidate median | Change | Pairs over budget | Result |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |'];
  for (const scenario of report.results) for (const row of scenario.comparison ?? []) {
    const scale = row.metric === 'rssBytes' ? 2 ** 20 : row.metric === 'durationMs' ? 1000 : 1;
    const unit = row.metric === 'rssBytes' ? 'MiB' : row.metric === 'durationMs' ? 's' : 'core-s';
    lines.push(`| ${scenario.id} | ${row.metric} | ${(row.baseline / scale).toFixed(2)} ${unit} | ${(row.candidate / scale).toFixed(2)} ${unit} | ${(row.change * 100).toFixed(1)}% | ${row.overBudgetPairs}/${row.pairs} | ${row.status} |`);
  }
  if (report.error) lines.push('', `Failure: ${String(report.error).replaceAll('\n', ' ').replaceAll('`', "'")}`);
  lines.push('', 'Raw run.json, samples.csv, CLI/mock logs, synthetic histories and any diagnostic CPU profile are attached. Warmups and diagnostic runs are excluded from comparisons.',
    '', 'This is a mock throughput check, not live-model acceptance. RSS is sampled. INCONCLUSIVE means the runner stayed too noisy to conclude even after confirmation pairs; CI reports a basic-suite result as a non-blocking warning, while a full-suite result fails the check. It is neither evidence of a regression nor of a pass; rerun before relying on performance results.');
  return lines.join('\n') + '\n';
}
