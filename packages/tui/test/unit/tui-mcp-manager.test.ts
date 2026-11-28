import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  TuiMcpAuthStateView,
  TuiMcpAuthTarget,
  TuiMcpServer,
} from '../../src/runtime/port.js';
import { TuiMcpManager, type TuiMcpManagerOptions } from '../../src/tui/features/mcp/manager.js';
import { waitFor } from '../helpers/wait-for.js';

const LINEAR: TuiMcpAuthTarget = { kind: 'user', serverName: 'linear' };
const DOCS: TuiMcpAuthTarget = {
  kind: 'plugin',
  serverName: 'docs',
  pluginName: 'notion',
  pluginMarketplace: 'local',
  pluginSource: 'LOCAL',
};
const AUTH_URL = 'https://auth.linear.example/authorize?client_id=pub-id&state=opaque';
const ENTER = '\r';
const ESC = '\x1b';

const servers: TuiMcpServer[] = [
  {
    name: 'matrix',
    enabled: false,
    status: 'unavailable',
    sourceKind: 'builtin',
    managed: true,
    transport: 'stdio',
    tools: [{ name: 'web_search' }, { name: 'image_synthesize' }, { name: 'transcribe_audio' }],
  },
  {
    name: 'browser',
    enabled: true,
    sourceKind: 'configured',
    transport: 'stdio',
    description: 'Browser automation tools',
    configJson: '{"status":"available","secret":"do-not-render"}',
  },
  {
    name: 'linear',
    enabled: true,
    sourceKind: 'configured',
    transport: 'streamable-http',
    configJson: '{"status":"error","error":"MCP server requires authorization."}',
  },
  {
    name: 'jira',
    enabled: true,
    sourceKind: 'configured',
    transport: 'sse',
    configJson: '{"status":"error","error":"Upstream said token=secret-value"}',
  },
];

const authStates: TuiMcpAuthStateView[] = [
  { target: LINEAR, authState: 'needs_auth', serverOrigin: 'https://mcp.linear.example' },
  { target: DOCS, authState: 'authorized', serverOrigin: 'https://mcp.notion.example' },
];

function createManager(overrides: Partial<TuiMcpManagerOptions> = {}) {
  const auth = {
    startMcpAuth: vi.fn<TuiMcpManagerOptions['auth']['startMcpAuth']>(async () => ({
      status: 'pending',
      attemptId: 'attempt-1',
      authUrl: AUTH_URL,
      requiresConfirmation: false,
    })),
    cancelMcpAuth: vi.fn(async () => true),
    completeMcpAuth: vi.fn<TuiMcpManagerOptions['auth']['completeMcpAuth']>(),
    clearMcpAuth: vi.fn<TuiMcpManagerOptions['auth']['clearMcpAuth']>(),
  };
  const options = {
    servers,
    authStates,
    filter: '',
    browserMode: 'open' as const,
    auth,
    reload: vi.fn(async () => ({ servers, authStates })),
    loadAuthStates: vi.fn(async () => authStates),
    openExternalTarget: vi.fn(async () => undefined),
    onClose: vi.fn(),
    requestRender: vi.fn(),
    maxRows: () => 40,
    ...overrides,
  };
  return { manager: new TuiMcpManager(options), options, auth };
}

function screen(manager: TuiMcpManager): string {
  return stripVTControlCharacters(manager.render(100).join('\n'));
}

describe('TuiMcpManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges the catalog with authorization states, keeping connection errors first', () => {
    const { manager } = createManager();

    const rendered = screen(manager);

    expect(rendered).toContain('MCP servers');
    expect(rendered).toContain('1 NEED AUTH');
    expect(rendered).toContain('User-configured · 3');
    expect(rendered).toContain('! error · streamable-http · ! Needs authorization');
    // A remote row's connection error wins over its origin; the origin fills an empty detail.
    expect(rendered).toContain('MCP server requires authorization.');
    expect(rendered).not.toContain('https://mcp.linear.example');
    expect(rendered).toContain('MCP server is unavailable. Retry or check its configuration.');
    expect(rendered).toContain('● available · stdio');
    expect(rendered).toContain('Browser automation tools');
    expect(rendered).toContain('Local Plugins · 1');
    expect(rendered).toContain('✓ Authorized · notion@local');
    expect(rendered).toContain('https://mcp.notion.example');
    expect(rendered).toContain('Built-in · 1');
    expect(rendered).toContain('○ unavailable · runtime-managed · 3 tools');
    expect(rendered).toContain('web_search · image_synthesize · transcribe_audio');
    expect(rendered).not.toContain('do-not-render');
    expect(rendered).not.toContain('secret-value');
  });

  it('shows why an oauth block is invalid without letting config keys inject text', () => {
    const remote = (name: string, error: string): TuiMcpServer => ({
      name,
      enabled: true,
      sourceKind: 'configured',
      transport: 'streamable-http',
      configJson: JSON.stringify({ status: 'error', error }),
    });
    const { manager } = createManager({
      servers: [
        remote('port', 'MCP oauth.callbackPort must be an integer from 1024 to 65535.'),
        remote(
          'secret',
          'Unsupported MCP oauth fields: clientSecret. Client secrets are stored through the settings secret field.',
        ),
        remote(
          'crafted',
          'Unsupported MCP oauth fields: run /logout now. Client secrets are stored through the settings secret field.',
        ),
      ],
      authStates: [],
    });

    const rendered = screen(manager);

    expect(rendered).toContain('MCP oauth.callbackPort must be an integer from 1024 to 65535.');
    expect(rendered).toContain('Unsupported MCP oauth fields: clientSecret.');
    expect(rendered).not.toContain('run /logout now');
    expect(rendered).toContain('MCP server is unavailable. Retry or check its configuration.');
  });

  it('confirms an unverified source before opening the browser and settles on the auth event', async () => {
    const { manager, options, auth } = createManager();
    auth.startMcpAuth.mockResolvedValueOnce({
      status: 'pending',
      attemptId: 'attempt-1',
      authUrl: AUTH_URL,
      requiresConfirmation: true,
      confirmation: {
        sourceLabel: '/repo/.mcp.json',
        serverOrigin: 'https://mcp.linear.example',
        issuer: 'https://auth.linear.example',
        clientId: 'pub-id',
        authorizationHost: 'auth.linear.example',
      },
    });

    manager.handleInput(ENTER);
    await waitFor(() => expect(screen(manager)).toContain('Confirm MCP authorization'));
    expect(auth.startMcpAuth).toHaveBeenCalledWith(LINEAR, undefined);
    expect(screen(manager)).toContain('Source: /repo/.mcp.json');
    expect(screen(manager)).toContain('Client ID: pub-id');
    expect(options.openExternalTarget).not.toHaveBeenCalled();

    // Enter starts authorization in the list; a double press must not skip the confirmation.
    manager.handleInput(ENTER);
    expect(screen(manager)).toContain('Confirm MCP authorization');
    manager.handleInput('y');
    await waitFor(() => expect(options.openExternalTarget).toHaveBeenCalledWith(AUTH_URL));
    expect(screen(manager)).toContain('Complete authorization in your browser.');

    manager.applyAuthUpdate({
      target: LINEAR,
      authState: 'authorized',
      attemptId: 'attempt-1',
      attemptOutcome: 'authorized',
    });

    expect(screen(manager)).toContain('linear authorized.');
    expect(screen(manager)).toContain('✓ Authorized');
    expect(auth.cancelMcpAuth).not.toHaveBeenCalled();
  });

  it('reports a denied reauthorization even though the previous token keeps the server authorized', async () => {
    const { manager } = createManager();
    manager.handleInput('\x1b[B');
    manager.handleInput('\x1b[B');
    manager.handleInput('\x1b[B');
    manager.handleInput('r');
    await waitFor(() => expect(screen(manager)).toContain('Complete authorization'));

    // Neither a target-wide `authorized` nor a turn's `mcp.auth_required` settles the attempt.
    manager.applyAuthUpdate({ target: DOCS, authState: 'authorized' });
    manager.applyAuthRequired(DOCS, 'reauth_required');
    expect(screen(manager)).toContain('Waiting for authorization…');

    manager.applyAuthUpdate({
      target: DOCS,
      authState: 'authorized',
      attemptId: 'attempt-1',
      attemptOutcome: 'failed',
      errorCode: 'MCP_OAUTH_ACCESS_DENIED',
    });

    expect(screen(manager)).toContain(
      "Couldn't authorize docs (notion@local): Authorization was denied.",
    );
    expect(screen(manager)).not.toContain('docs (notion@local) authorized.');
  });

  it('cancels the attempt when the confirmation is declined', async () => {
    const { manager, options, auth } = createManager();
    auth.startMcpAuth.mockResolvedValueOnce({
      status: 'pending',
      attemptId: 'attempt-1',
      authUrl: AUTH_URL,
      requiresConfirmation: true,
    });

    manager.handleInput(ENTER);
    await waitFor(() => expect(screen(manager)).toContain('Confirm MCP authorization'));
    manager.handleInput(ESC);

    await waitFor(() => expect(auth.cancelMcpAuth).toHaveBeenCalledWith('attempt-1'));
    expect(options.openExternalTarget).not.toHaveBeenCalled();
    expect(screen(manager)).toContain('Authorization cancelled.');
  });

  it('prints the address over SSH and completes with the pasted redirect', async () => {
    const { manager, options, auth } = createManager({ browserMode: 'manual' });
    const pasted = 'http://localhost:43123/callback?code=pasted-code-value&state=opaque';
    auth.completeMcpAuth
      .mockResolvedValueOnce({
        state: { target: LINEAR, authState: 'authorizing', attemptId: 'attempt-1' },
        errorCode: 'MCP_OAUTH_ATTEMPT_NOT_FOUND',
      })
      .mockResolvedValueOnce({
        state: {
          target: LINEAR,
          authState: 'authorized',
          lastAttemptId: 'attempt-1',
          lastAttemptOutcome: 'authorized',
        },
      });

    manager.handleInput(ENTER);
    await waitFor(() =>
      expect(screen(manager)).toContain('Open this address in a browser on your computer:'),
    );
    expect(options.openExternalTarget).not.toHaveBeenCalled();
    expect(screen(manager).replace(/[\s│]/gu, '')).toContain(AUTH_URL);

    manager.handleInput(`\x1b[200~${pasted}\x1b[201~`);
    manager.handleInput(ENTER);
    await waitFor(() =>
      expect(screen(manager)).toContain(
        "The redirect address doesn't match this authorization. Paste it again.",
      ),
    );
    expect(screen(manager)).toContain('Waiting for authorization…');

    manager.handleInput(`\x1b[200~${pasted}\x1b[201~`);
    manager.handleInput(ENTER);
    await waitFor(() => expect(screen(manager)).toContain('linear authorized.'));

    expect(auth.completeMcpAuth).toHaveBeenNthCalledWith(2, 'attempt-1', pasted);
    expect(screen(manager)).not.toContain('pasted-code-value');
  });

  it('switches to paste when the browser cannot open and settles from the attempt outcome', async () => {
    vi.useFakeTimers();
    // A timed-out reauthorization keeps the old token: only `lastAttempt*` tells the outcome.
    const loadAuthStates = vi
      .fn<TuiMcpManagerOptions['loadAuthStates']>()
      .mockResolvedValueOnce([{ target: LINEAR, authState: 'authorized', attemptId: 'attempt-1' }])
      .mockResolvedValue([
        {
          target: LINEAR,
          authState: 'authorized',
          lastAttemptId: 'attempt-1',
          lastAttemptOutcome: 'expired',
        },
      ]);
    const { manager } = createManager({
      loadAuthStates,
      openExternalTarget: vi.fn(async () => {
        throw new Error('xdg-open not found');
      }),
      pollIntervalMs: 1_000,
    });

    manager.handleInput(ENTER);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen(manager)).toContain("Couldn't open a browser.");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(screen(manager)).toContain('Waiting for authorization…');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(screen(manager)).toContain('Authorization for linear was not completed.');
    expect(screen(manager)).not.toContain('linear authorized.');
    expect(loadAuthStates).toHaveBeenCalledTimes(2);
  });

  it('abandons a pending attempt when the panel closes', async () => {
    const { manager, auth } = createManager();

    manager.handleInput(ENTER);
    await waitFor(() => expect(screen(manager)).toContain('Complete authorization'));
    manager.dispose();

    expect(auth.cancelMcpAuth).toHaveBeenCalledWith('attempt-1');
  });

  it('refuses to open a sign-in page that is not HTTPS', async () => {
    const { manager, options, auth } = createManager();
    auth.startMcpAuth.mockResolvedValueOnce({
      status: 'pending',
      attemptId: 'attempt-1',
      authUrl: 'http://auth.example/authorize',
      requiresConfirmation: false,
    });

    manager.handleInput(ENTER);

    await waitFor(() => expect(screen(manager)).toContain('is not an HTTPS address'));
    expect(auth.cancelMcpAuth).toHaveBeenCalledWith('attempt-1');
    expect(options.openExternalTarget).not.toHaveBeenCalled();
  });

  it('disconnects only stored authorizations, without claiming a server-side revocation', async () => {
    const { manager, auth } = createManager();
    auth.clearMcpAuth.mockResolvedValueOnce({
      state: { target: DOCS, authState: 'needs_auth' },
      revoked: false,
    });

    manager.handleInput('d');
    expect(screen(manager)).toContain('Nothing to disconnect');

    manager.handleInput('\x1b[B');
    manager.handleInput('\x1b[B');
    manager.handleInput('\x1b[B');
    manager.handleInput('d');

    await waitFor(() => expect(screen(manager)).toContain('docs (notion@local) disconnected.'));
    expect(auth.clearMcpAuth).toHaveBeenCalledOnce();
    expect(auth.clearMcpAuth).toHaveBeenCalledWith(DOCS);
    expect(screen(manager)).toContain('! Needs authorization · notion@local');
    expect(screen(manager)).not.toContain('revoked');
  });
});
