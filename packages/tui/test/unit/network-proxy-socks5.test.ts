import { once } from 'node:events';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import {
  type AddressInfo,
  connect,
  createServer as createNetServer,
  type Server,
  type Socket,
} from 'node:net';
import { fetch, type Dispatcher } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  configureTuiNetworkProxy,
  createTuiNetworkDispatcher,
} from '../../src/cli/network-proxy.js';

/**
 * End-to-end coverage for SOCKS5 proxies (#393) against loopback-only fixtures.
 *
 * The proxied requests target `*.socks.invalid` host names. They cannot resolve
 * locally, so undici must hand the name to the SOCKS5 server, which maps every
 * requested domain to the local HTTP fixture. A successful response therefore
 * proves that the request went through the proxy, and the server records the
 * CONNECT address type to show that the name, not a local IP, was sent. Loopback hosts are always in
 * the TUI's NO_PROXY list, so a request to 127.0.0.1 is the NO_PROXY case: it
 * must reach the HTTP fixture directly while the SOCKS5 server sees nothing.
 */

interface SocksConnectRecord {
  /** RFC 1928 ATYP of the CONNECT request: 0x01 IPv4, 0x03 domain name, 0x04 IPv6. */
  readonly addressType: number;
  readonly host: string;
  readonly port: number;
  readonly username?: string;
}

interface SocksFixture {
  readonly port: number;
  readonly connects: SocksConnectRecord[];
  readonly connections: { count: number };
  close(): Promise<void>;
}

const SOCKS_VERSION = 0x05;
const NO_AUTH = 0x00;
const USERNAME_PASSWORD = 0x02;
const NO_ACCEPTABLE_METHOD = 0xff;
const ATYP_DOMAIN_NAME = 0x03;

let target: HttpServer;
let targetPort: number;
const targetRequests: string[] = [];
const openDispatchers: Dispatcher[] = [];
const openFixtures: SocksFixture[] = [];

/** Some CI containers disable IPv6; the IPv6 proxy case is skipped there. */
async function canListenOnIpv6Loopback(): Promise<boolean> {
  const probe = createNetServer();
  try {
    probe.listen(0, '::1');
    await once(probe, 'listening');
    probe.close();
    await once(probe, 'close');
    return true;
  } catch {
    return false;
  }
}

const HAS_IPV6_LOOPBACK = await canListenOnIpv6Loopback();

function createReader(socket: Socket) {
  let buffered = Buffer.alloc(0);
  let pending: { length: number; resolve: (value: Buffer) => void } | undefined;
  const flush = () => {
    if (!pending || buffered.length < pending.length) return;
    const chunk = buffered.subarray(0, pending.length);
    buffered = buffered.subarray(pending.length);
    const { resolve } = pending;
    pending = undefined;
    resolve(chunk);
  };
  const onData = (data: Buffer) => {
    buffered = Buffer.concat([buffered, data]);
    flush();
  };
  socket.on('data', onData);
  return {
    read: (length: number) =>
      new Promise<Buffer>((resolve) => {
        pending = { length, resolve };
        flush();
      }),
    /** Stops parsing and returns bytes received after the handshake. */
    detach: () => {
      socket.off('data', onData);
      return buffered;
    },
  };
}

/** Minimal RFC 1928 server: CONNECT only, with optional RFC 1929 authentication. */
async function startSocksServer(
  credentials?: { username: string; password: string },
  listenHost = '127.0.0.1',
): Promise<SocksFixture> {
  const connects: SocksConnectRecord[] = [];
  const connections = { count: 0 };
  const sockets = new Set<Socket>();
  const server: Server = createNetServer((client) => {
    connections.count += 1;
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => undefined);
    void handleClient(client).catch(() => client.destroy());
  });

  async function handleClient(client: Socket): Promise<void> {
    const reader = createReader(client);
    const { read } = reader;
    const [version, methodCount] = await read(2);
    if (version !== SOCKS_VERSION) throw new Error('Unexpected SOCKS version');
    const methods = [...(await read(methodCount ?? 0))];
    const method = credentials ? USERNAME_PASSWORD : NO_AUTH;
    if (!methods.includes(method)) {
      client.end(Buffer.from([SOCKS_VERSION, NO_ACCEPTABLE_METHOD]));
      return;
    }
    client.write(Buffer.from([SOCKS_VERSION, method]));

    let username: string | undefined;
    if (credentials) {
      const [, usernameLength] = await read(2);
      username = (await read(usernameLength ?? 0)).toString('utf8');
      const [passwordLength] = await read(1);
      const password = (await read(passwordLength ?? 0)).toString('utf8');
      const accepted = username === credentials.username && password === credentials.password;
      client.write(Buffer.from([0x01, accepted ? 0x00 : 0x01]));
      if (!accepted) {
        client.end();
        return;
      }
    }

    const [, command, , addressType = 0] = await read(4);
    let host: string;
    if (addressType === 0x01) host = [...(await read(4))].join('.');
    else if (addressType === 0x03) {
      const [length] = await read(1);
      host = (await read(length ?? 0)).toString('utf8');
    } else if (addressType === 0x04) {
      host = (await read(16)).toString('hex').replace(/(.{4})(?!$)/gu, '$1:');
    } else throw new Error('Unsupported address type');
    const port = (await read(2)).readUInt16BE(0);
    if (command !== 0x01) throw new Error('Only CONNECT is supported');
    connects.push({ addressType, host, port, ...(username ? { username } : {}) });

    // Every requested destination is served by the local HTTP fixture.
    const upstream = connect(targetPort, '127.0.0.1');
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    await once(upstream, 'connect');
    const early = reader.detach();
    if (early.length > 0) upstream.write(early);
    client.write(Buffer.from([SOCKS_VERSION, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
    client.pipe(upstream);
    upstream.pipe(client);
  }

  server.listen(0, listenHost);
  await once(server, 'listening');
  const fixture: SocksFixture = {
    port: (server.address() as AddressInfo).port,
    connects,
    connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
  openFixtures.push(fixture);
  return fixture;
}

function track<T extends Dispatcher>(dispatcher: T): T {
  openDispatchers.push(dispatcher);
  return dispatcher;
}

beforeAll(async () => {
  target = createHttpServer((request, response) => {
    targetRequests.push(`${request.headers.host ?? ''}${request.url ?? ''}`);
    response.end(`hello from ${request.headers.host ?? 'unknown'}`);
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  targetPort = (target.address() as AddressInfo).port;
});

afterEach(async () => {
  await Promise.all(openDispatchers.splice(0).map((dispatcher) => dispatcher.destroy()));
  await Promise.all(openFixtures.splice(0).map((fixture) => fixture.close()));
  targetRequests.length = 0;
});

afterAll(async () => {
  target.close();
  await once(target, 'close');
});

describe('SOCKS5 proxy dispatch', () => {
  it('routes requests through ALL_PROXY=socks5:// without an experimental warning', async () => {
    const socks = await startSocksServer();
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.message);
    process.on('warning', onWarning);
    let dispatcher: Dispatcher;
    try {
      dispatcher = track(
        createTuiNetworkDispatcher({
          all_proxy: ` socks5://127.0.0.1:${socks.port} `,
        }),
      );
      const response = await fetch('http://target.socks.invalid/through-socks', { dispatcher });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('hello from target.socks.invalid');
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
    }

    expect(socks.connects).toEqual([
      { addressType: ATYP_DOMAIN_NAME, host: 'target.socks.invalid', port: 80 },
    ]);
    expect(targetRequests).toEqual(['target.socks.invalid/through-socks']);
    expect(warnings.filter((message) => message.includes('SOCKS5'))).toEqual([]);
  });

  it('authenticates with credentials from the proxy URL', async () => {
    const socks = await startSocksServer({
      username: 'mcode user',
      password: 'p@ss:word',
    });
    const dispatcher = track(
      createTuiNetworkDispatcher({
        HTTPS_PROXY: `socks5://mcode%20user:p%40ss%3Aword@127.0.0.1:${socks.port}`,
        HTTP_PROXY: `socks5://mcode%20user:p%40ss%3Aword@127.0.0.1:${socks.port}`,
      }),
    );

    const response = await fetch('http://auth.socks.invalid/authenticated', {
      dispatcher,
    });

    expect(await response.text()).toBe('hello from auth.socks.invalid');
    expect(socks.connects).toEqual([
      {
        addressType: ATYP_DOMAIN_NAME,
        host: 'auth.socks.invalid',
        port: 80,
        username: 'mcode user',
      },
    ]);
  });

  it('fails the request when SOCKS5 authentication is rejected', async () => {
    const socks = await startSocksServer({
      username: 'mcode',
      password: 'expected',
    });
    const dispatcher = track(
      createTuiNetworkDispatcher({
        ALL_PROXY: `socks5://mcode:wrong@127.0.0.1:${socks.port}`,
      }),
    );

    await expect(fetch('http://denied.socks.invalid/', { dispatcher })).rejects.toThrow();
    expect(socks.connects).toEqual([]);
    expect(targetRequests).toEqual([]);
  });

  it('sends NO_PROXY hosts directly even when a SOCKS5 proxy is configured', async () => {
    const socks = await startSocksServer();
    const dispatcher = track(
      createTuiNetworkDispatcher({
        ALL_PROXY: `socks5://127.0.0.1:${socks.port}`,
        NO_PROXY: 'internal.example.invalid',
      }),
    );

    const response = await fetch(`http://127.0.0.1:${targetPort}/direct`, {
      dispatcher,
    });

    expect(await response.text()).toBe(`hello from 127.0.0.1:${targetPort}`);
    expect(targetRequests).toEqual([`127.0.0.1:${targetPort}/direct`]);
    expect(socks.connections.count).toBe(0);
  });

  it('installs a SOCKS5 global dispatcher at startup instead of failing (#393)', async () => {
    const socks = await startSocksServer();
    const warnings: string[] = [];
    let installed: Dispatcher | undefined;

    const configuration = configureTuiNetworkProxy({
      environment: { ALL_PROXY: `socks5://127.0.0.1:${socks.port}` },
      setGlobalDispatcher: (dispatcher) => {
        installed = track(dispatcher);
      },
      installFetch: () => undefined,
      writeWarning: (message) => warnings.push(message),
    });

    expect(configuration.mode).toBe('proxy');
    expect(warnings).toEqual([]);
    if (!installed) throw new Error('Expected a global dispatcher');
    const response = await fetch('http://startup.socks.invalid/', {
      dispatcher: installed,
    });
    expect(await response.text()).toBe('hello from startup.socks.invalid');
    expect(socks.connects).toEqual([
      { addressType: ATYP_DOMAIN_NAME, host: 'startup.socks.invalid', port: 80 },
    ]);
  });

  it.each(['ALL_PROXY', 'HTTPS_PROXY'])(
    'accepts %s=socks5h:// and lets the proxy resolve host names',
    async (name) => {
      const socks = await startSocksServer({ username: 'mcode', password: 's3cr3t' });
      const warnings: string[] = [];
      let installed: Dispatcher | undefined;

      const configuration = configureTuiNetworkProxy({
        environment: {
          [name]: ` socks5h://mcode:s3cr3t@127.0.0.1:${socks.port} `,
          HTTP_PROXY: `socks5h://mcode:s3cr3t@127.0.0.1:${socks.port}`,
        },
        setGlobalDispatcher: (dispatcher) => {
          installed = track(dispatcher);
        },
        installFetch: () => undefined,
        writeWarning: (message) => warnings.push(message),
      });

      expect(configuration.mode).toBe('proxy');
      expect(warnings).toEqual([]);
      if (!installed) throw new Error('Expected a global dispatcher');
      const response = await fetch('http://remote-dns.socks.invalid/h', { dispatcher: installed });
      expect(await response.text()).toBe('hello from remote-dns.socks.invalid');
      expect(socks.connects).toEqual([
        {
          addressType: ATYP_DOMAIN_NAME,
          host: 'remote-dns.socks.invalid',
          port: 80,
          username: 'mcode',
        },
      ]);
    },
  );

  it.skipIf(!HAS_IPV6_LOOPBACK)(
    'connects to a SOCKS5 proxy at an IPv6 literal address',
    async () => {
      const socks = await startSocksServer({ username: 'mcode', password: 'p@ss' }, '::1');
      const dispatcher = track(
        createTuiNetworkDispatcher({ ALL_PROXY: `socks5://mcode:p%40ss@[::1]:${socks.port}` }),
      );

      const response = await fetch('http://ipv6-proxy.socks.invalid/', { dispatcher });

      expect(await response.text()).toBe('hello from ipv6-proxy.socks.invalid');
      expect(socks.connects).toEqual([
        {
          addressType: ATYP_DOMAIN_NAME,
          host: 'ipv6-proxy.socks.invalid',
          port: 80,
          username: 'mcode',
        },
      ]);
    },
  );

  it('treats an empty password as no SOCKS5 credentials', async () => {
    const socks = await startSocksServer();
    const dispatcher = track(
      createTuiNetworkDispatcher({ ALL_PROXY: `socks5://mcode:@127.0.0.1:${socks.port}` }),
    );

    const response = await fetch('http://empty-password.socks.invalid/', { dispatcher });

    expect(await response.text()).toBe('hello from empty-password.socks.invalid');
    expect(socks.connects).toEqual([
      { addressType: ATYP_DOMAIN_NAME, host: 'empty-password.socks.invalid', port: 80 },
    ]);
  });

  it('starts without a proxy when ALL_PROXY has malformed credentials', () => {
    const warnings: string[] = [];
    let installed = false;

    const configuration = configureTuiNetworkProxy({
      environment: { ALL_PROXY: 'socks5://user:50%off@127.0.0.1:1080' },
      setGlobalDispatcher: () => {
        installed = true;
      },
      installFetch: () => undefined,
      writeWarning: (message) => warnings.push(message),
    });

    expect(configuration).toEqual({ mode: 'direct' });
    expect(installed).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ALL_PROXY=socks5://***:***@127.0.0.1:1080');
    expect(warnings[0]).not.toContain('50%off');
  });

  it('keeps explicit proxies at startup when ALL_PROXY has malformed credentials', async () => {
    const socks = await startSocksServer();
    let installed: Dispatcher | undefined;

    configureTuiNetworkProxy({
      environment: {
        ALL_PROXY: 'socks5://user:50%off@127.0.0.1:1080',
        HTTP_PROXY: `socks5://127.0.0.1:${socks.port}`,
      },
      setGlobalDispatcher: (dispatcher) => {
        installed = track(dispatcher);
      },
      installFetch: () => undefined,
      writeWarning: () => undefined,
    });

    if (!installed) throw new Error('Expected a global dispatcher');
    const response = await fetch('http://explicit.socks.invalid/', { dispatcher: installed });
    expect(await response.text()).toBe('hello from explicit.socks.invalid');
  });
});
