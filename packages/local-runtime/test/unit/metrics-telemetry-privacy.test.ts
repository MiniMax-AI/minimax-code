import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLocalRuntimeMetricsClient } from '../../src/runtime/host-metrics.js';
import type { MetricsClient } from '../../src/common/metrics.js';

const clients: MetricsClient[] = [];
const fetchRequest = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv('__MAVIS_RUNTIME_MANAGED', '1');
  vi.stubEnv('MAVIS_BUILD_ENV', 'prod');
  vi.stubEnv('MAVIS_REGION', 'en');
  vi.stubEnv('MCODE_DISABLE_TELEMETRY', '');
  vi.stubEnv('DO_NOT_TRACK', '');
  fetchRequest.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchRequest);
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function fixture(metrics?: boolean) {
  const client = buildLocalRuntimeMetricsClient({
    runtimeOwnerKind: 'tui',
    appVersion: '0.4.12',
    readTelemetryEnabled: () => metrics,
  });
  clients.push(client);
  return client;
}

describe('automatic runtime metrics consent', () => {
  it.each([undefined, false])('does not send production metrics without an explicit opt-in (%s)', async (enabled) => {
    const client = fixture(enabled);
    client.counter('started_total', 1);
    await client.flush();
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it('sends metrics only after the metrics opt-in', async () => {
    const client = fixture(true);
    client.counter('started_total', 1);
    await client.flush();
    expect(fetchRequest).toHaveBeenCalledOnce();
    expect(String(fetchRequest.mock.calls[0]![0])).toBe('https://agent.minimax.io/matrix/api/v1/metrics/batch');
  });

  it.each(['MCODE_DISABLE_TELEMETRY', 'DO_NOT_TRACK'])('%s overrides the metrics opt-in', async (key) => {
    vi.stubEnv(key, '1');
    const client = fixture(true);
    client.counter('started_total', 1);
    await client.flush();
    expect(fetchRequest).not.toHaveBeenCalled();
  });
});
