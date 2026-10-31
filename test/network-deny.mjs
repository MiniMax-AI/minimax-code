// Loaded only in isolated test children. Record attempts even if callers catch failures.
import { appendFileSync } from 'node:fs';
import { Socket } from 'node:net';
const allowed = process.env.MCODE_TEST_ALLOWED_ORIGIN ? new URL(process.env.MCODE_TEST_ALLOWED_ORIGIN) : undefined;
const originalFetch = globalThis.fetch;
const originalConnect = Socket.prototype.connect;
if (process.env.MCODE_TEST_PROCESS_PROBE === '1') {
  const startedAt = Date.now();
  const probe = setInterval(() => {
    process.stderr.write(`[test-process-probe] ${JSON.stringify({
      elapsedMs: Date.now() - startedAt,
      resources: process.getActiveResourcesInfo(),
    })}\n`);
  }, 10000);
  // This diagnostic timer must not keep an otherwise completed CLI alive.
  probe.unref();
}
function denied() {
  appendFileSync(process.env.MCODE_TEST_NETWORK_AUDIT, new Error('network-attempt').stack + '\n');
  throw new Error('Unexpected network access during standalone validation');
}
// Apply the same policy to whichever fetch implementation is installed: the one Node
// starts with, or the Undici fetch the CLI installs so direct connections stay on
// HTTP/1.1. Allowed origins keep using the installed implementation, so a fixture
// server is exercised the way production exercises it.
function withOfflinePolicy(delegate) {
  return function (input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (allowed && url.origin === allowed.origin) return delegate(input, init);
  // Offline acceptance after restoring managed capabilities: these requests return only local failure responses and never reach servers.
  // Keep attempted requests in a separate log; unknown addresses still fail tests.
  if (process.env.MCODE_TEST_MANAGED_OFFLINE === '1' && [
    'agent.minimax.cn', 'agent.minimax.io', 'agent.minimaxi.com',
    'www.minimaxi.com', 'platform.minimax.io', 'models.dev',
    'data.hailuo.ai', 'data.hailuoai.com',
    ].includes(url.hostname) && url.protocol === 'https:') {
      appendFileSync(process.env.MCODE_TEST_NETWORK_AUDIT + '.managed', `${url.origin}${url.pathname}\n`);
      return Promise.resolve(new Response(JSON.stringify({ error: 'Managed service offline fixture' }), { status: 503 }));
    }
    return denied();
  };
}
let installedFetch = withOfflinePolicy(originalFetch);
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  enumerable: true,
  get: () => installedFetch,
  set: (value) => {
    if (typeof value === 'function' && value !== installedFetch) installedFetch = withOfflinePolicy(value);
  },
});
Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (allowed && options && typeof options === 'object' && options.host === allowed.hostname && String(options.port) === allowed.port) {
    return Reflect.apply(originalConnect, this, args);
  }
  return denied();
};
