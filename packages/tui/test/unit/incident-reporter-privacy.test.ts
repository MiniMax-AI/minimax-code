import { createDecipheriv, hkdfSync, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTuiIncidentReporter,
  resolveTuiIncidentDirectory,
} from '../../src/observability/incident-reporter.js';
import type {
  TuiIncidentCapture,
  TuiIncidentReporter,
  CreateTuiIncidentReporterOptions,
} from '../../src/observability/incident-reporter.js';

const privateText = 'Unannounced acquisition of Example Company /home/private/client-plan.txt';
const token = 'synthetic-transport-token';
const userId = 'synthetic-user';
const directories: string[] = [];
const reporters: TuiIncidentReporter[] = [];
afterEach(() => {
  for (const reporter of reporters.splice(0)) reporter.completeRun();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const dataDir = mkdtempSync(join(tmpdir(), 'tui-incident-privacy-'));
  directories.push(dataDir);
  return dataDir;
}

function fixture(
  dataDir = temporaryDirectory(),
  authenticated = true,
  readTelemetryEnabled: () => boolean | undefined = () => true,
  resolveAuthContext?: CreateTuiIncidentReporterOptions['resolveAuthContext'],
) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return new Response(null, { status: 204 });
  });
  const reporter = createTuiIncidentReporter({
    readTelemetryEnabled,
    dataDir,
    appVersion: '0.4.12',
    region: 'en',
    buildEnv: 'prod',
    architecture: 'arm64',
    platform: 'darwin',
    nodeVersion: '26.4.0',
    terminal: privateText,
    osVersion: privateText,
    tuiMode: privateText,
    resolveAuthContext: resolveAuthContext ?? (() =>
      authenticated ? { accessToken: token, realUserID: userId } : undefined),
    fetchImpl,
  });
  reporters.push(reporter);
  return {
    reporter,
    requests,
    fetchImpl,
    directory: resolveTuiIncidentDirectory(dataDir),
  };
}

function decrypt(event: Record<string, any>) {
  const [version, nonce, payload] = event.event_log.split('.');
  expect(version).toBe('v1');
  const bytes = Buffer.from(payload, 'base64url');
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(token),
      Buffer.from('mcode-desktop-event-log-v1'),
      Buffer.from(userId),
      32,
    ),
  );
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
  decipher.setAAD(
    Buffer.from(
      JSON.stringify({
        event_type: event.event_type,
        occurred_at_ms: event.occurred_at_ms,
      }),
    ),
  );
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString(),
  );
}

function input(error: unknown): TuiIncidentCapture {
  return {
    eventType: 'cli_runtime_bridge_error',
    error,
    component: privateText,
    operation: privateText,
    codeLocation: privateText,
    context: {
      [privateText]: privateText,
      appVersion: privateText,
      prompt: privateText,
    },
  };
}

function diskRecords(directory: string) {
  return readdirSync(directory)
    .filter((name) => /^(pending|sent)-/.test(name))
    .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')));
}

describe('TUI automatic incident HTTP privacy boundary', () => {
  it.each([undefined, false])('keeps incidents local without an explicit diagnostics opt-in (%s)', async (enabled) => {
    const { reporter, requests, directory } = fixture(undefined, true, () => enabled);
    reporter.capture(input(new Error('synthetic')));
    await reporter.drain();
    expect(requests).toEqual([]);
    const files = readdirSync(directory);
    expect(files.filter((name) => name.startsWith('local-'))).toHaveLength(1);
    expect(files.some((name) => name.startsWith('pending-'))).toBe(false);
  });

  it.each(['MCODE_DISABLE_TELEMETRY', 'DO_NOT_TRACK'])('%s overrides the diagnostics opt-in', async (key) => {
    vi.stubEnv(key, '1');
    try {
      const { reporter, requests } = fixture(undefined, true, () => true);
      reporter.capture(input(new Error('synthetic')));
      await reporter.drain();
      expect(requests).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['config', 'MCODE_DISABLE_TELEMETRY', 'DO_NOT_TRACK'])('does not upload when %s revokes consent during authentication', async (source) => {
    let enabled = true;
    let resolveAuth!: (auth: { accessToken: string; realUserID: string }) => void;
    const auth = new Promise<{ accessToken: string; realUserID: string }>((resolve) => {
      resolveAuth = resolve;
    });
    const resolveAuthContext = vi.fn(() => auth);
    const { reporter, requests } = fixture(undefined, true, () => enabled, resolveAuthContext);
    try {
      reporter.capture(input(new Error('synthetic')));
      const drain = reporter.drain();
      expect(resolveAuthContext).toHaveBeenCalled();
      if (source === 'config') enabled = false;
      else vi.stubEnv(source, '1');
      resolveAuth({ accessToken: token, realUserID: userId });
      await drain;
      expect(requests).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('decrypts the final fetch payload without recovering private text from any capture field', async () => {
    const { reporter, requests, directory } = fixture();
    const getter = vi.fn(() => privateText);
    const error = Object.assign(
      new AggregateError([new Error(privateText)], privateText, {
        cause: new Error(privateText),
      }),
      {
        name: privateText,
        code: 'ECONNRESET',
        status: 503,
        stack: privateText,
      },
    );
    Object.defineProperty(error, 'toJSON', { get: getter });
    reporter.breadcrumb(privateText, { [privateText]: privateText });
    reporter.breadcrumb('cli.runtime.events.disconnected', {
      reason: privateText,
      phase: 'runtime',
    });
    reporter.capture(input(error));
    await reporter.drain();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.init.method).toBe('POST');
    const events = JSON.parse(String(requests[0]!.init.body)).events;
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.code_location).toBe('tui.cli_runtime_bridge_error');
    const log = decrypt(event);
    expect(log.error).toEqual({
      name: 'AggregateError',
      code: 'ECONNRESET',
      status: 503,
    });
    expect(log.context).toEqual({
      appVersion: '0.4.12',
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: '26.4.0',
    });
    expect(log.breadcrumbs.at(-1)).toMatchObject({
      name: 'cli.runtime.events.disconnected',
      details: { phase: 'runtime' },
    });
    expect(Object.keys(log).sort()).toEqual(
      [
        'breadcrumbs',
        'context',
        'error',
        'fingerprint',
        'handled',
        'impact',
        'incidentId',
        'phase',
        'runId',
        'schemaVersion',
        'severity',
        'source',
      ].sort(),
    );
    expect(JSON.stringify([requests, log, diskRecords(directory)])).not.toContain(privateText);
    expect(getter).not.toHaveBeenCalled();
    expect(readdirSync(directory).filter((name) => name.startsWith('sent-'))).toHaveLength(1);
  });

  it('drops arbitrary thrown values, custom names/codes and invalid enum inputs, and bounds breadcrumbs', async () => {
    const { reporter, requests, directory } = fixture();
    const getter = vi.fn(() => privateText);
    const error = Object.defineProperties(
      {},
      {
        name: { get: getter },
        code: { get: getter },
        status: { get: getter },
        toString: { value: getter },
      },
    );
    for (let i = 0; i < 100; i++)
      reporter.breadcrumb('cli.phase.changed', {
        phase: privateText,
        text: privateText,
      });
    const invalid = {
      ...input(error),
      phase: privateText,
      severity: privateText,
      impact: privateText,
      handled: privateText,
    } as unknown as TuiIncidentCapture;
    reporter.capture(invalid);
    reporter.capture(input(privateText)); // Same minimized category is deduplicated.
    expect(
      reporter.capture({
        ...input(error),
        eventType: privateText,
      } as TuiIncidentCapture),
    ).toBeUndefined();
    await reporter.drain();
    const events = requests.flatMap((request) => JSON.parse(String(request.init.body)).events);
    expect(events).toHaveLength(1);
    const log = decrypt(events[0]);
    expect(log.error).toEqual({ name: 'unknown' });
    expect(log.breadcrumbs).toHaveLength(20);
    expect(log.phase).toBe('runtime');
    expect(log.severity).toBe('error');
    expect(log.impact).toBe('action_failed');
    expect(log.handled).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(log))).toBeLessThan(16 * 1024);
    expect(JSON.stringify([log, diskRecords(directory)])).not.toContain(privateText);
    expect(getter).not.toHaveBeenCalled();
  });

  it('purges legacy pending and sent records before authentication, including legacy records added later', async () => {
    const dataDir = temporaryDirectory();
    const directory = resolveTuiIncidentDirectory(dataDir);
    mkdirSync(directory, { recursive: true });
    const legacy = {
      schemaVersion: 1,
      incidentId: randomUUID(),
      eventType: 'cli_process_error',
      occurredAtMs: Date.now(),
      codeLocation: privateText,
      eventLog: JSON.stringify({ error: privateText }),
    };
    for (const prefix of ['pending', 'sent'])
      writeFileSync(join(directory, `${prefix}-legacy.json`), JSON.stringify(legacy));
    const unauthenticated = fixture(dataDir, false);
    await unauthenticated.reporter.drain();
    expect(diskRecords(directory)).toEqual([]);
    expect(unauthenticated.requests).toEqual([]);
    unauthenticated.reporter.completeRun();
    const { reporter, requests } = fixture(dataDir);
    writeFileSync(join(directory, 'pending-late-legacy.json'), JSON.stringify(legacy));
    await reporter.drain();
    expect(requests).toEqual([]);
    expect(diskRecords(directory)).toEqual([]);
  });

  it('reprojects a current-schema disk record at retry, including the plaintext envelope and sent copy', async () => {
    const { reporter, requests, directory, fetchImpl } = fixture();
    const onlineFetch = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async () => {
      throw new Error('Synthetic offline');
    });
    reporter.capture(input(new Error(privateText)));
    await reporter.drain();
    expect(requests).toEqual([]);
    const name = readdirSync(directory).find((name) => name.startsWith('pending-'))!;
    const path = join(directory, name);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    const log = JSON.parse(stored.eventLog);
    stored.codeLocation = privateText;
    stored.extra = privateText;
    stored.eventLog = JSON.stringify({
      ...log,
      component: privateText,
      operation: privateText,
      fingerprint: privateText,
      error: {
        name: privateText,
        message: privateText,
        code: privateText,
        cause: privateText,
        stack: privateText,
      },
      context: {
        appVersion: privateText,
        platform: privateText,
        arch: privateText,
        nodeVersion: privateText,
        custom: privateText,
      },
      breadcrumbs: [{ name: privateText, details: { text: privateText } }],
    });
    writeFileSync(path, JSON.stringify(stored));
    fetchImpl.mockImplementation(onlineFetch);
    await reporter.drain();
    expect(requests).toHaveLength(1);
    const event = JSON.parse(String(requests[0]!.init.body)).events[0];
    expect(event.code_location).toBe('tui.cli_runtime_bridge_error');
    const cleanLog = decrypt(event);
    expect(cleanLog.error).toEqual({ name: 'unknown' });
    expect(cleanLog.context).toEqual({});
    expect(cleanLog.breadcrumbs).toEqual([]);
    expect(JSON.stringify([event, cleanLog, diskRecords(directory)])).not.toContain(privateText);
  });
});
