import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { OFFICIAL_PLUGIN_MARKETPLACE } from '@mavis/shared';

import {
  describeMcpAuthError,
  describeMcpAuthTarget,
  describeRejectedMcpAuthRedirect,
  isSafeMcpAuthorizationUrl,
  mcpAuthCanDisconnect,
  mcpAuthConfirmationLines,
  mcpAuthErrorCode,
  resolveMcpAuthAttempt,
  resolveMcpAuthCompletion,
  sameMcpAuthTarget,
  type McpAuthAttemptResolution,
} from '../application/mcp-auth.js';
import { openTuiExternalTarget } from '../host/open-external.js';
import { prepareTuiDataDir } from '../runtime/data-dir.js';
import { createTuiRuntime, shutdownTuiRuntime } from '../runtime/lifecycle.js';
import type { TuiMcpAuthPort, TuiMcpAuthScope, TuiMcpAuthTarget } from '../runtime/port.js';
import { sanitizeTerminalText } from '../terminal-text.js';
import { isSshSession } from '../tui/platform/terminal-capabilities.js';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Slightly longer than the Runtime's 10-minute attempt expiry, so its outcome normally wins. */
const DEFAULT_WAIT_DEADLINE_MS = 11 * 60_000;
/** Consecutive polls without the target before the attempt is considered gone. */
const MISSING_STATE_LIMIT = 3;

type SettledMcpAuthAttempt = Exclude<McpAuthAttemptResolution, { readonly status: 'pending' }>;

export interface McodeMcpPluginSelector {
  readonly name: string;
  readonly marketplace?: string;
}

interface McodeMcpTargetRequest {
  readonly serverName: string;
  readonly plugin?: McodeMcpPluginSelector;
  /** Absolute project directory for a project-level `.mcp.json` server. */
  readonly projectDir?: string;
}

export type McodeMcpCliRequest =
  | (McodeMcpTargetRequest & {
      readonly action: 'login';
      /** False for `--no-browser`: print the address and accept the pasted redirect. */
      readonly openBrowser: boolean;
      readonly setClientSecret: boolean;
    })
  | (McodeMcpTargetRequest & { readonly action: 'logout' });

/** Terminal side effects; tests replace them, the default uses this process's TTY. */
export interface McodeMcpCommandIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  write(text: string): void;
  /** Reads without echoing the typed characters. */
  readSecret(prompt: string): Promise<string>;
  confirm(prompt: string): Promise<boolean>;
  /** Resolves undefined when the signal aborts or input ends. */
  readLine(prompt: string, signal: AbortSignal): Promise<string | undefined>;
  openExternal(url: string): Promise<void>;
  /** Ctrl+C while waiting for authorization. */
  onInterrupt(listener: () => void): () => void;
}

export interface McodeMcpCommandContext {
  readonly auth: TuiMcpAuthPort;
  shutdown(): Promise<void>;
}

export interface RunMcodeMcpCommandOptions {
  readonly request: McodeMcpCliRequest;
  readonly version: string;
  readonly lane?: string;
  readonly createContext?: (workspaceDir: string, lane?: string) => Promise<McodeMcpCommandContext>;
  readonly io?: McodeMcpCommandIo;
  readonly pollIntervalMs?: number;
  /** Test seam for {@link DEFAULT_WAIT_DEADLINE_MS}. */
  readonly waitDeadlineMs?: number;
}

interface ResolvedScope {
  readonly scope: TuiMcpAuthScope;
  readonly workspaceDir: string;
}

export async function runMcodeMcpCommand(options: RunMcodeMcpCommandOptions): Promise<string> {
  const { request } = options;
  if (
    request.action === 'login' &&
    request.setClientSecret &&
    (request.plugin || request.projectDir)
  ) {
    throw new Error(
      '--client-secret is only supported for servers in your user MCP configuration.',
    );
  }
  if (request.plugin?.marketplace === OFFICIAL_PLUGIN_MARKETPLACE) {
    throw new Error(
      `MCP servers from official Plugins don't use OAuth, so ${sanitizeTerminalText(request.plugin.name)}@${OFFICIAL_PLUGIN_MARKETPLACE} has nothing to authorize. OAuth applies to user, project, and local (custom) Plugin servers.`,
    );
  }
  const resolved = await resolveScope(request);
  const io = options.io ?? createProcessMcpCommandIo();
  const context = options.createContext
    ? await options.createContext(resolved.workspaceDir, options.lane)
    : await createMcpCommandContext(resolved.workspaceDir, options.version, options.lane);
  try {
    const target = await resolveTarget(context.auth, request, resolved.scope);
    if (request.action === 'logout') return await logout(context.auth, target, resolved.scope);
    return await login(context.auth, io, request, target, resolved.scope, {
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      waitDeadlineMs: options.waitDeadlineMs ?? DEFAULT_WAIT_DEADLINE_MS,
    });
  } finally {
    await context.shutdown();
  }
}

/**
 * `--project` has no Session, so it borrows a synthetic Session id; the credential
 * namespace depends only on the directory's realpath, shared with TUI and Desktop.
 */
async function resolveScope(request: McodeMcpCliRequest): Promise<ResolvedScope> {
  if (!request.projectDir) return { scope: {}, workspaceDir: process.cwd() };
  let workspaceRoot: string;
  try {
    workspaceRoot = await realpath(request.projectDir);
    if (!(await stat(workspaceRoot)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`Project directory not found: ${sanitizeTerminalText(request.projectDir)}`);
  }
  return {
    scope: { sessionId: `mcode-mcp-cli-${randomUUID()}`, workspaceRoot },
    workspaceDir: workspaceRoot,
  };
}

async function resolveTarget(
  auth: TuiMcpAuthPort,
  request: McodeMcpTargetRequest,
  scope: TuiMcpAuthScope,
): Promise<TuiMcpAuthTarget> {
  const { serverName, plugin } = request;
  if (scope.sessionId && scope.workspaceRoot) {
    return {
      kind: 'project',
      serverName,
      sessionId: scope.sessionId,
      workspaceRoot: scope.workspaceRoot,
    };
  }
  if (!plugin) return { kind: 'user', serverName };
  // Plugin targets carry Runtime-resolved fields (source); pick them from the listed states.
  const matches = (await auth.listMcpAuthStates({}))
    .map((state) => state.target)
    .filter(
      (target): target is Extract<TuiMcpAuthTarget, { kind: 'plugin' }> =>
        target.kind === 'plugin' &&
        target.serverName === serverName &&
        target.pluginName === plugin.name &&
        (!plugin.marketplace || target.pluginMarketplace === plugin.marketplace),
    );
  const selector = sanitizeTerminalText(
    plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name,
  );
  const [match, ...others] = matches;
  if (!match) {
    throw new Error(
      `No MCP server "${sanitizeTerminalText(serverName)}" that uses OAuth was found in Plugin ${selector}. OAuth applies to local (custom) Plugins that are installed and enabled; official Plugin servers need no sign-in.`,
    );
  }
  if (others.length > 0) {
    const marketplaces = matches.map((target) => target.pluginMarketplace).join(', ');
    throw new Error(
      `Plugin ${selector} is installed from more than one marketplace (${sanitizeTerminalText(marketplaces)}). Use --plugin ${selector}@<marketplace>.`,
    );
  }
  return match;
}

async function login(
  auth: TuiMcpAuthPort,
  io: McodeMcpCommandIo,
  request: Extract<McodeMcpCliRequest, { action: 'login' }>,
  target: TuiMcpAuthTarget,
  scope: TuiMcpAuthScope,
  options: { readonly pollIntervalMs: number; readonly waitDeadlineMs: number },
): Promise<string> {
  const label = describeMcpAuthTarget(target);
  if (request.setClientSecret) {
    const secret = await io.readSecret(`Client secret for ${label} (leave empty to clear): `);
    // Reports whether a secret is configured afterwards; an unknown server throws instead.
    const configured = await auth.setMcpUserClientSecret(target.serverName, secret || undefined);
    io.write(configured ? 'Client secret saved.\n' : 'Client secret cleared.\n');
  }
  // An explicit login always signs in again, e.g. to switch accounts or recover a revoked token.
  const started = await auth.startMcpAuth(target, { force: true });
  if (started.status === 'already_authorized') return `${label} is already authorized.`;
  if (started.status !== 'pending') {
    throw new Error(`Couldn't authorize ${label}: ${describeMcpAuthError(started.errorCode)}`);
  }
  const { attemptId, authUrl } = started;
  if (!isSafeMcpAuthorizationUrl(authUrl)) {
    await auth.cancelMcpAuth(attemptId).catch(() => undefined);
    throw new Error(`The sign-in page for ${label} is not an HTTPS address, so it was not opened.`);
  }
  if (started.requiresConfirmation) {
    io.write(
      [
        `${label} opens a sign-in page from a source MiniMax doesn't verify:`,
        ...(started.confirmation
          ? mcpAuthConfirmationLines(started.confirmation).map((line) => `  ${line}`)
          : ['  Source details are unavailable for this server.']),
        '',
      ].join('\n'),
    );
    let confirmed = false;
    try {
      confirmed = await io.confirm(
        'Continue only if you trust this source. Open the sign-in page? [y/N] ',
      );
    } finally {
      if (!confirmed) await auth.cancelMcpAuth(attemptId).catch(() => undefined);
    }
    if (!confirmed) throw new Error('Authorization cancelled.');
  }
  let manual = !request.openBrowser || isSshSession(io.env);
  const url = sanitizeTerminalText(authUrl);
  if (!manual) {
    try {
      await io.openExternal(authUrl);
      io.write(
        `Opened the sign-in page in your browser. If it didn't open, visit:\n${url}\n\nWaiting for authorization… (Ctrl+C to cancel)\n`,
      );
    } catch {
      manual = true;
    }
  }
  if (manual) {
    io.write(
      [
        'Open this address in a browser on your computer:',
        url,
        '',
        'After you approve, the browser goes to a localhost address that may not load.',
        'Copy that full address from the address bar and paste it below (Ctrl+C to cancel).',
        '',
      ].join('\n'),
    );
  }
  const resolution = await waitForAuthorization({
    auth,
    io,
    target,
    scope,
    attemptId,
    manual,
    ...options,
  });
  if (!resolution) {
    await auth.cancelMcpAuth(attemptId).catch(() => undefined);
    throw new Error('Authorization cancelled.');
  }
  if (resolution.status === 'authorized') return `${label} authorized.`;
  if (resolution.status === 'incomplete') {
    // Release a still-running attempt (e.g. the CLI deadline passed first).
    await auth.cancelMcpAuth(attemptId).catch(() => undefined);
    throw new Error(
      `Authorization for ${label} was not completed. Run the command again to retry.`,
    );
  }
  throw new Error(`Couldn't authorize ${label}: ${describeMcpAuthError(resolution.errorCode)}`);
}

async function logout(
  auth: TuiMcpAuthPort,
  target: TuiMcpAuthTarget,
  scope: TuiMcpAuthScope,
): Promise<string> {
  const label = describeMcpAuthTarget(target);
  const state = (await auth.listMcpAuthStates(scope)).find((candidate) =>
    sameMcpAuthTarget(candidate.target, target),
  );
  if (!state) throw new Error(`No remote MCP server found for ${label}.`);
  // Clearing a server without stored credentials would only mark it as needing sign-in.
  if (!mcpAuthCanDisconnect(state.authState)) {
    return `${label} has no stored authorization; nothing to disconnect.`;
  }
  const result = await auth.clearMcpAuth(target);
  return `${label} disconnected. ${
    result.revoked
      ? 'The authorization server revoked the token.'
      : 'Local credentials were removed.'
  }`;
}

interface WaitInput {
  readonly auth: TuiMcpAuthPort;
  readonly io: McodeMcpCommandIo;
  readonly target: TuiMcpAuthTarget;
  readonly scope: TuiMcpAuthScope;
  readonly attemptId: string;
  readonly manual: boolean;
  readonly pollIntervalMs: number;
  readonly waitDeadlineMs: number;
}

/**
 * Settles on whichever comes first: the browser callback observed through the auth state,
 * a pasted redirect accepted by the Runtime, the CLI deadline (incomplete), or Ctrl+C (undefined).
 */
async function waitForAuthorization(input: WaitInput): Promise<SettledMcpAuthAttempt | undefined> {
  const controller = new AbortController();
  const removeInterrupt = input.io.onInterrupt(() => controller.abort());
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await new Promise<SettledMcpAuthAttempt | undefined>((resolve, reject) => {
      controller.signal.addEventListener('abort', () => resolve(undefined), { once: true });
      const settle = (resolution: SettledMcpAuthAttempt | undefined) => {
        if (resolution) resolve(resolution);
      };
      // Backstop if the Runtime never records an outcome (its attempts expire after 10 minutes).
      deadline = setTimeout(() => resolve({ status: 'incomplete' }), input.waitDeadlineMs);
      void pollAuthState(input, controller.signal).then(settle, reject);
      if (input.manual) void readPastedRedirects(input, controller.signal).then(settle, reject);
    });
  } finally {
    clearTimeout(deadline);
    controller.abort();
    removeInterrupt();
  }
}

async function pollAuthState(
  input: WaitInput,
  signal: AbortSignal,
): Promise<SettledMcpAuthAttempt | undefined> {
  let missing = 0;
  while (!signal.aborted) {
    await delay(input.pollIntervalMs, signal);
    if (signal.aborted) return undefined;
    let states;
    try {
      states = await input.auth.listMcpAuthStates(input.scope);
    } catch {
      continue; // Transient; the pasted redirect or the next poll can still settle it.
    }
    const state = states.find((candidate) => sameMcpAuthTarget(candidate.target, input.target));
    if (!state) {
      // The server was removed or its Plugin disabled mid-flow; its attempt can't finish.
      missing += 1;
      if (missing >= MISSING_STATE_LIMIT) return { status: 'incomplete' };
      continue;
    }
    missing = 0;
    const resolution = resolveMcpAuthAttempt(state, input.attemptId);
    if (resolution.status !== 'pending') return resolution;
  }
  return undefined;
}

async function readPastedRedirects(
  input: WaitInput,
  signal: AbortSignal,
): Promise<SettledMcpAuthAttempt | undefined> {
  while (!signal.aborted) {
    const line = await input.io.readLine('Redirect URL: ', signal);
    // Input ended (e.g. stdin is not a terminal): keep waiting for the browser callback.
    if (line === undefined) return undefined;
    const callbackUrl = line.trim();
    if (!callbackUrl) continue;
    try {
      const outcome = await input.auth.completeMcpAuth(input.attemptId, callbackUrl);
      const resolution = resolveMcpAuthCompletion(outcome);
      if (resolution.status !== 'pending') return resolution;
      input.io.write(`${describeRejectedMcpAuthRedirect(outcome.errorCode)}\n`);
    } catch (error) {
      // The pasted address carries the authorization code; never echo Runtime diagnostics.
      // An expired attempt is settled by the state poll (`lastAttemptOutcome`).
      const code = mcpAuthErrorCode(error);
      input.io.write(
        `${code ? describeMcpAuthError(code) : "Couldn't complete authorization."} Paste the full address again.\n`,
      );
    }
  }
  return undefined;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function createMcpCommandContext(
  workspaceDir: string,
  version: string,
  lane?: string,
): Promise<McodeMcpCommandContext> {
  const dataDir = await prepareTuiDataDir();
  const runtime = await createTuiRuntime({
    dataDir,
    workspaceDir,
    version,
    surface: 'headless',
    ...(lane ? { lane } : {}),
  });
  return {
    auth: runtime.adapter,
    shutdown: () => shutdownTuiRuntime(runtime).then(() => undefined),
  };
}

function createProcessMcpCommandIo(): McodeMcpCommandIo {
  const interruptListeners = new Set<() => void>();
  const interrupt = () => {
    for (const listener of interruptListeners) listener();
  };
  const question = (prompt: string, signal?: AbortSignal): Promise<string | undefined> =>
    new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let settled = false;
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        rl.close();
        resolve(value);
      };
      const onAbort = () => finish(undefined);
      signal?.addEventListener('abort', onAbort, { once: true });
      // readline owns Ctrl+C while it reads; forward it as a cancellation.
      rl.on('SIGINT', () => {
        finish(undefined);
        interrupt();
      });
      rl.on('close', () => finish(undefined));
      rl.question(prompt, (answer) => finish(answer));
    });
  return {
    env: process.env,
    write: (text) => {
      process.stdout.write(text);
    },
    readSecret: (prompt) => readMaskedLine(prompt),
    confirm: async (prompt) => {
      if (!process.stdin.isTTY) {
        throw new Error('Confirming this source requires an interactive terminal.');
      }
      const answer = await question(prompt);
      if (answer === undefined) throw new Error('Authorization cancelled.');
      return /^y(?:es)?$/iu.test(answer.trim());
    },
    readLine: (prompt, signal) => question(prompt, signal),
    openExternal: (url) => openTuiExternalTarget(url, process.cwd()),
    onInterrupt: (listener) => {
      interruptListeners.add(listener);
      if (interruptListeners.size === 1) process.on('SIGINT', interrupt);
      return () => {
        interruptListeners.delete(listener);
        if (interruptListeners.size === 0) process.off('SIGINT', interrupt);
      };
    },
  };
}

/** Raw-mode read that echoes `*`; piped stdin (scripts) is read as one plain line. */
function readMaskedLine(prompt: string): Promise<string> {
  const input = process.stdin;
  process.stdout.write(prompt);
  if (!input.isTTY) {
    return new Promise((resolve) => {
      const rl = createInterface({ input });
      rl.once('line', (line) => {
        rl.close();
        resolve(line);
      });
      rl.once('close', () => resolve(''));
    });
  }
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = input.isRaw;
    const finish = (error?: Error) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new Error('Cancelled.'));
        if (char === '\u007f' || char === '\b') {
          if (value) {
            value = [...value].slice(0, -1).join('');
            process.stdout.write('\b \b');
          }
        } else if (char >= ' ') {
          value += char;
          process.stdout.write('*');
        }
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}
