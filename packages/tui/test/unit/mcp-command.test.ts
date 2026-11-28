import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  runMcodeMcpCommand,
  type McodeMcpCliRequest,
  type McodeMcpCommandIo,
} from '../../src/cli/mcp-command.js';
import type {
  TuiMcpAuthPort,
  TuiMcpAuthStateView,
  TuiMcpAuthTarget,
} from '../../src/runtime/port.js';
import { waitFor } from '../helpers/wait-for.js';

const AUTH_URL = 'https://auth.example/authorize?client_id=pub-id&state=opaque';

function plugin(marketplace: string): Extract<TuiMcpAuthTarget, { kind: 'plugin' }> {
  return {
    kind: 'plugin',
    serverName: 'docs',
    pluginName: 'notion',
    pluginMarketplace: marketplace,
    pluginSource: 'LOCAL',
  };
}

function createAuth(states: TuiMcpAuthStateView[] = []) {
  return {
    listMcpAuthStates: vi.fn<TuiMcpAuthPort['listMcpAuthStates']>(async () => states),
    startMcpAuth: vi.fn<TuiMcpAuthPort['startMcpAuth']>(async () => ({
      status: 'pending',
      attemptId: 'attempt-1',
      authUrl: AUTH_URL,
      requiresConfirmation: false,
    })),
    cancelMcpAuth: vi.fn(async () => true),
    completeMcpAuth: vi.fn<TuiMcpAuthPort['completeMcpAuth']>(),
    clearMcpAuth: vi.fn<TuiMcpAuthPort['clearMcpAuth']>(async (target) => ({
      state: { target, authState: 'needs_auth' },
      revoked: true,
    })),
    setMcpUserClientSecret: vi.fn(async () => true),
  } satisfies TuiMcpAuthPort;
}

function createIo(options: { env?: Record<string, string>; pastes?: string[] } = {}) {
  const output: string[] = [];
  const interrupts = new Set<() => void>();
  const pastes = [...(options.pastes ?? [])];
  const io = {
    env: options.env ?? {},
    write: (text: string) => {
      output.push(text);
    },
    readSecret: vi.fn(async () => 's3cret-value'),
    confirm: vi.fn(async () => true),
    readLine: vi.fn(async (_prompt: string, signal: AbortSignal) => {
      const next = pastes.shift();
      if (next !== undefined) return next;
      return new Promise<string | undefined>((resolve) =>
        signal.addEventListener('abort', () => resolve(undefined), { once: true }),
      );
    }),
    openExternal: vi.fn(async () => undefined),
    onInterrupt: (listener: () => void) => {
      interrupts.add(listener);
      return () => interrupts.delete(listener);
    },
  } satisfies McodeMcpCommandIo;
  return {
    io,
    output: () => output.join(''),
    interrupt: () => {
      for (const listener of interrupts) listener();
    },
  };
}

function run(
  request: McodeMcpCliRequest,
  auth: TuiMcpAuthPort,
  io: McodeMcpCommandIo,
  createContext = vi.fn(async () => ({ auth, shutdown: async () => undefined })),
  pollIntervalMs = 1,
) {
  return {
    createContext,
    result: runMcodeMcpCommand({ request, version: 'test', io, createContext, pollIntervalMs }),
  };
}

const login = (overrides: Partial<Extract<McodeMcpCliRequest, { action: 'login' }>> = {}) =>
  ({
    action: 'login',
    serverName: 'linear',
    openBrowser: true,
    setClientSecret: false,
    ...overrides,
  }) as const;

describe('mcode mcp', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops waiting once the server disappears from the auth states', async () => {
    // E.g. the user removes the server or disables its Plugin mid-flow: no outcome will arrive.
    const auth = createAuth([]);
    const { io } = createIo();

    await expect(run(login(), auth, io).result).rejects.toThrow(
      'Authorization for linear was not completed.',
    );
    expect(auth.listMcpAuthStates).toHaveBeenCalledTimes(3);
    expect(auth.cancelMcpAuth).toHaveBeenCalledWith('attempt-1');
  });

  it('gives up after its deadline when the Runtime never records an outcome', async () => {
    vi.useFakeTimers();
    const auth = createAuth([
      {
        target: { kind: 'user', serverName: 'linear' },
        authState: 'authorizing',
        attemptId: 'attempt-1',
      },
    ]);
    const { io } = createIo();
    const { result } = run(login(), auth, io, undefined, 60_000);
    const settled = expect(result).rejects.toThrow('Authorization for linear was not completed.');

    // The Runtime expires attempts after 10 minutes; the CLI waits slightly longer.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(auth.cancelMcpAuth).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);

    await settled;
    expect(auth.cancelMcpAuth).toHaveBeenCalledWith('attempt-1');
  });

  it('signs a user server in through the browser and confirms completion from the auth state', async () => {
    const auth = createAuth();
    auth.listMcpAuthStates
      .mockResolvedValueOnce([
        { target: { kind: 'user', serverName: 'linear' }, authState: 'authorizing' },
      ])
      .mockResolvedValue([
        {
          target: { kind: 'user', serverName: 'linear' },
          authState: 'authorized',
          lastAttemptId: 'attempt-1',
          lastAttemptOutcome: 'authorized',
        },
      ]);
    const { io, output } = createIo();

    const { result, createContext } = run(login(), auth, io);

    await expect(result).resolves.toBe('linear authorized.');
    expect(createContext).toHaveBeenCalledWith(process.cwd(), undefined);
    expect(auth.startMcpAuth).toHaveBeenCalledWith(
      { kind: 'user', serverName: 'linear' },
      { force: true },
    );
    expect(io.openExternal).toHaveBeenCalledWith(AUTH_URL);
    expect(io.readLine).not.toHaveBeenCalled();
    expect(output()).toContain('Waiting for authorization');
  });

  it('fails a denied reauthorization even though the previous token keeps the server authorized', async () => {
    const linear = { kind: 'user', serverName: 'linear' } as const;
    const auth = createAuth();
    auth.listMcpAuthStates
      .mockResolvedValueOnce([{ target: linear, authState: 'authorized', attemptId: 'attempt-1' }])
      .mockResolvedValue([
        {
          target: linear,
          authState: 'authorized',
          lastAttemptId: 'attempt-1',
          lastAttemptOutcome: 'failed',
          lastAttemptErrorCode: 'MCP_OAUTH_ACCESS_DENIED',
        },
      ]);
    const { io } = createIo();

    await expect(run(login(), auth, io).result).rejects.toThrow(
      "Couldn't authorize linear: Authorization was denied.",
    );
    expect(auth.listMcpAuthStates).toHaveBeenCalledTimes(2);
  });

  it('prints the address over SSH and completes with a pasted redirect, retrying a bad paste', async () => {
    const auth = createAuth([
      { target: { kind: 'user', serverName: 'linear' }, authState: 'authorizing' },
    ]);
    const pasted = 'http://localhost:43123/callback?code=pasted-code&state=opaque';
    auth.completeMcpAuth
      .mockRejectedValueOnce(
        Object.assign(new Error(`bad callback ${pasted}`), { code: 'MCP_OAUTH_ISSUER_MISMATCH' }),
      )
      .mockResolvedValueOnce({
        state: { target: { kind: 'user', serverName: 'linear' }, authState: 'authorized' },
      });
    const { io, output } = createIo({
      env: { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' },
      pastes: [pasted, pasted],
    });

    await expect(run(login(), auth, io).result).resolves.toBe('linear authorized.');

    expect(io.openExternal).not.toHaveBeenCalled();
    expect(output()).toContain(AUTH_URL);
    expect(output()).toContain(
      'The authorization response came from an unexpected issuer. Paste the full address again.',
    );
    expect(output()).not.toContain('pasted-code');
    expect(auth.completeMcpAuth).toHaveBeenLastCalledWith('attempt-1', pasted);
  });

  it('cancels the attempt on Ctrl+C while waiting', async () => {
    const auth = createAuth([
      { target: { kind: 'user', serverName: 'linear' }, authState: 'authorizing' },
    ]);
    const { io, interrupt } = createIo();
    const { result } = run(login({ openBrowser: false }), auth, io);

    await waitFor(() => expect(io.readLine).toHaveBeenCalled());
    interrupt();

    await expect(result).rejects.toThrow('Authorization cancelled.');
    expect(auth.cancelMcpAuth).toHaveBeenCalledWith('attempt-1');
  });

  it('asks before opening an unverified project source and resolves the project by realpath', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcode-mcp-'));
    try {
      const link = join(root, 'link');
      await symlink(root, link);
      const workspaceRoot = await realpath(root);
      const auth = createAuth();
      auth.startMcpAuth.mockResolvedValueOnce({
        status: 'pending',
        attemptId: 'attempt-1',
        authUrl: AUTH_URL,
        requiresConfirmation: true,
        confirmation: {
          sourceLabel: `${workspaceRoot}/.mcp.json`,
          serverOrigin: 'https://mcp.example',
          issuer: 'https://auth.example',
          clientId: 'pub-id',
        },
      });
      const { io, output } = createIo();
      io.confirm.mockResolvedValueOnce(false);

      const { result, createContext } = run(login({ projectDir: link }), auth, io);

      await expect(result).rejects.toThrow('Authorization cancelled.');
      expect(createContext).toHaveBeenCalledWith(workspaceRoot, undefined);
      expect(auth.startMcpAuth).toHaveBeenCalledWith(
        {
          kind: 'project',
          serverName: 'linear',
          sessionId: expect.stringMatching(/^mcode-mcp-cli-/u),
          workspaceRoot,
        },
        { force: true },
      );
      expect(output()).toContain('Client ID: pub-id');
      expect(io.openExternal).not.toHaveBeenCalled();
      expect(auth.cancelMcpAuth).toHaveBeenCalledWith('attempt-1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('selects a local Plugin server by marketplace and disconnects it', async () => {
    const auth = createAuth([
      { target: plugin('acme'), authState: 'authorized' },
      { target: plugin('local'), authState: 'authorized' },
    ]);
    const { io } = createIo();
    const logout = (marketplace?: string) =>
      run(
        {
          action: 'logout',
          serverName: 'docs',
          plugin: { name: 'notion', ...(marketplace ? { marketplace } : {}) },
        },
        auth,
        io,
      ).result;

    await expect(logout()).rejects.toThrow('Use --plugin notion@<marketplace>.');
    await expect(logout('team')).rejects.toThrow(
      'OAuth applies to local (custom) Plugins that are installed and enabled',
    );
    await expect(logout('local')).resolves.toBe(
      'docs (notion@local) disconnected. The authorization server revoked the token.',
    );
    expect(auth.clearMcpAuth).toHaveBeenCalledOnce();
    expect(auth.clearMcpAuth).toHaveBeenCalledWith(plugin('local'));
  });

  it('explains that official Plugin servers have nothing to authorize, before starting the Runtime', async () => {
    const auth = createAuth();
    const { io } = createIo();

    const { result, createContext } = run(
      login({ serverName: 'docs', plugin: { name: 'notion', marketplace: 'official' } }),
      auth,
      io,
    );

    await expect(result).rejects.toThrow(
      "MCP servers from official Plugins don't use OAuth, so notion@official has nothing to authorize.",
    );
    expect(createContext).not.toHaveBeenCalled();
  });

  it('does not clear a server that has no stored authorization', async () => {
    const auth = createAuth([
      { target: { kind: 'user', serverName: 'linear' }, authState: 'needs_auth' },
    ]);
    const { io } = createIo();

    await expect(run({ action: 'logout', serverName: 'linear' }, auth, io).result).resolves.toBe(
      'linear has no stored authorization; nothing to disconnect.',
    );
    expect(auth.clearMcpAuth).not.toHaveBeenCalled();
  });

  it('saves or clears a hidden client secret for user servers only', async () => {
    const auth = createAuth();
    auth.startMcpAuth.mockResolvedValue({ status: 'already_authorized' });
    const { io, output } = createIo();

    await expect(run(login({ setClientSecret: true }), auth, io).result).resolves.toBe(
      'linear is already authorized.',
    );
    expect(auth.setMcpUserClientSecret).toHaveBeenCalledWith('linear', 's3cret-value');
    expect(output()).toContain('Client secret saved.');
    expect(output()).not.toContain('s3cret-value');

    // Empty input clears it; the Runtime answers "configured afterwards", i.e. false.
    io.readSecret.mockResolvedValueOnce('');
    auth.setMcpUserClientSecret.mockResolvedValueOnce(false);
    await expect(run(login({ setClientSecret: true }), auth, io).result).resolves.toBe(
      'linear is already authorized.',
    );
    expect(auth.setMcpUserClientSecret).toHaveBeenLastCalledWith('linear', undefined);
    expect(output()).toContain('Client secret cleared.');

    const pluginRun = run(login({ setClientSecret: true, plugin: { name: 'notion' } }), auth, io);
    await expect(pluginRun.result).rejects.toThrow('--client-secret is only supported');
    expect(pluginRun.createContext).not.toHaveBeenCalled();
  });
});
