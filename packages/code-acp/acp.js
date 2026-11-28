#!/usr/bin/env node
// Zero-dependency ACP launcher for MiniMax Code:
// 1. Reuses a cached, adjacent, or compatible locally installed `mcode` immediately while
//    preserving the Node runtime ABI bound to that installation.
// 2. On a cold machine without `mcode`, answers ACP `initialize` immediately on stdio so
//    clients never hit initialize timeouts while bootstrapping `@minimax-ai/code@<version>`
//    from the public npm registry into an ABI-scoped isolated cache directory.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BOOTSTRAP_INIT_ID = '__mcode_acp_bootstrap_init__';
const DEFAULT_PUBLIC_REGISTRY = 'https://registry.npmjs.org/';
const DEFAULT_LOCK_STALE_MS = 30 * 60 * 1000;
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = DEFAULT_LOCK_STALE_MS;
const AUTH_API_KEY_ENV = 'MCODE_PROVIDER_API_KEY';

export const BOOTSTRAP_AUTH_METHODS = [
  {
    type: 'terminal',
    id: 'minimax-code-login',
    name: 'Sign in to MiniMax Code (Mainland China)',
    args: ['login', '--region', 'cn'],
  },
  {
    type: 'terminal',
    id: 'minimax-code-login-global',
    name: 'Sign in to MiniMax Code (Global)',
    args: ['login', '--region', 'global'],
  },
  {
    type: 'env_var',
    id: 'minimax-code-api-key',
    name: 'Use a MiniMax API key (Mainland China)',
    vars: [{ name: AUTH_API_KEY_ENV, label: 'MiniMax API key', secret: true }],
  },
  {
    type: 'env_var',
    id: 'minimax-code-api-key-global',
    name: 'Use a MiniMax API key (Global)',
    vars: [{ name: AUTH_API_KEY_ENV, label: 'MiniMax API key', secret: true }],
  },
];

export const BASE_EXTENSION_METHODS = [
  'session/activate',
  'mcode/session/activate',
  'mcode/session/steer',
  'mcode/session/queue/list',
  'mcode/session/queue/enqueue',
  'mcode/session/queue/update',
  'mcode/session/queue/delete',
  'mcode/session/queue/steer',
  'mcode/session/delegation/get',
  'mcode/session/delegation/stop',
  'mcode/session/delegation/message',
  'mcode/session/delegation/transcript',
];

export const GOAL_EXTENSION_METHODS = [
  'mcode/session/goal/get',
  'mcode/session/goal/create',
  'mcode/session/goal/patch',
  'mcode/session/goal/clear',
];

export const BASE_EXTENSION_NOTIFICATIONS = [
  'mcode/session/current_session_update',
  'mcode/session/queue_update',
  'mcode/session/delegation_update',
];

const selfPath = fileURLToPath(import.meta.url);
const selfRealPath = safeRealpath(selfPath);
const ownPkg = JSON.parse(readFileSync(join(dirname(selfPath), 'package.json'), 'utf8'));
const targetPackage = process.env.MCODE_ACP_PACKAGE_NAME?.trim() || '@minimax-ai/code';
const targetVersion = process.env.MCODE_ACP_TARGET_VERSION?.trim() || ownPkg.version;
const exactVersion = process.env.MCODE_ACP_EXACT_VERSION === '1';
const nodeAbi = process.env.MCODE_ACP_NODE_ABI?.trim() || process.versions.modules || 'unknown';
const cacheRoot =
  process.env.MCODE_ACP_CACHE_DIR?.trim() || join(os.homedir(), '.minimax-code', 'acp-releases');
const args = process.argv.slice(2);

function safeRealpath(target) {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

const WINDOWS_CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/gu;

function escapeWindowsCmdCommand(command) {
  return String(command).replace(WINDOWS_CMD_META_CHARS, '^$1');
}

export function quoteWindowsCmdArg(value, doubleEscapeMetaChars = false) {
  // Follow cross-spawn's proven cmd.exe /d /s /c escaping: C-runtime backslash/quote escaping
  // inside quotes, then ^-escaping cmd metacharacters (including %, never batch-only %%).
  let arg = String(value);
  arg = arg.replace(/(?=(\\+?)?)\1"/gu, '$1$1\\"');
  arg = arg.replace(/(?=(\\+?)?)\1$/gu, '$1$1');
  arg = `"${arg}"`;
  arg = arg.replace(WINDOWS_CMD_META_CHARS, '^$1');
  if (doubleEscapeMetaChars) {
    arg = arg.replace(WINDOWS_CMD_META_CHARS, '^$1');
  }
  return arg;
}

export function buildSpawnInvocation(
  command,
  cmdArgs,
  { platform = process.platform, comSpec = process.env.ComSpec || 'cmd.exe' } = {},
) {
  if (platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command)) {
    const isNodeBinShim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/iu.test(command);
    const commandLine = [
      escapeWindowsCmdCommand(command),
      ...cmdArgs.map((arg) => quoteWindowsCmdArg(arg, isNodeBinShim)),
    ].join(' ');
    return {
      command: comSpec,
      args: ['/d', '/s', '/c', `"${commandLine}"`],
      options: { windowsVerbatimArguments: true, windowsHide: true },
    };
  }
  return {
    command,
    args: cmdArgs,
    options: { windowsHide: true },
  };
}

function resolveBundledNpmCliJs(execPath = process.execPath, platform = process.platform) {
  const nodeDir = dirname(execPath);
  const candidates =
    platform === 'win32'
      ? [
          join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        ]
      : [
          join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function parseSemverCore(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+].*)?$/u);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionCompatible(installed, required, requireExact = false) {
  if (!required || required === '0.0.0-dev') return Boolean(parseSemverCore(installed));
  const inst = parseSemverCore(installed);
  const req = parseSemverCore(required);
  if (!inst || !req) return false;
  if (requireExact) {
    return inst[0] === req[0] && inst[1] === req[1] && inst[2] === req[2];
  }
  for (let i = 0; i < 3; i += 1) {
    if (inst[i] > req[i]) return true;
    if (inst[i] < req[i]) return false;
  }
  return true;
}

function resolveBinEntryFromPkgJson(
  pkgJsonPath,
  checkVersion = true,
  nodeBinary = process.execPath,
) {
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    if (checkVersion && !isVersionCompatible(pkg.version, targetVersion, exactVersion)) {
      return null;
    }
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.mcode;
    if (!bin) return null;
    const entry = resolve(dirname(pkgJsonPath), bin);
    if (!existsSync(entry)) return null;
    return { command: nodeBinary, prefixArgs: [entry] };
  } catch {
    return null;
  }
}

export function packageCacheKey(pkgName, version, abi = nodeAbi) {
  return `${pkgName.replace(/^@/, '').replace(/\//g, '__')}@${version}-abi${abi}`.replace(
    /[^0-9A-Za-z._@-]/g,
    '_',
  );
}

function packageJsonInPrefix(prefixDir, pkgName) {
  return join(prefixDir, 'node_modules', ...pkgName.split('/'), 'package.json');
}

function resolveCachedRelease() {
  if (!targetVersion || targetVersion === '0.0.0-dev') return null;
  const releaseDir = join(cacheRoot, packageCacheKey(targetPackage, targetVersion));
  if (!existsSync(join(releaseDir, 'ready.json'))) return null;
  return resolveBinEntryFromPkgJson(packageJsonInPrefix(releaseDir, targetPackage), false);
}

function resolveAdjacentDependency() {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve(`${targetPackage}/package.json`);
    return resolveBinEntryFromPkgJson(pkgPath, true);
  } catch {
    return null;
  }
}

function readInstallerNodeExecutable(installDir) {
  try {
    const receipt = JSON.parse(readFileSync(join(installDir, 'install.json'), 'utf8'));
    const nodeExec =
      typeof receipt?.nodeExecutable === 'string' ? receipt.nodeExecutable.trim() : '';
    if (nodeExec && existsSync(nodeExec)) return nodeExec;
  } catch {
    // Receipt is optional in custom or test layouts.
  }
  return null;
}

function resolveOfficialInstallerRelease() {
  const installDir = process.env.MCODE_INSTALL_DIR?.trim() || join(os.homedir(), '.minimax-code');
  const currentPointer = join(installDir, 'current');
  if (!existsSync(currentPointer)) return null;
  let releaseKey = '';
  try {
    releaseKey = readFileSync(currentPointer, 'utf8').trim();
  } catch {
    return null;
  }
  if (!releaseKey || releaseKey === '.' || releaseKey === '..' || /[\\/]/.test(releaseKey)) {
    return null;
  }

  const releaseRoot = join(installDir, 'releases', releaseKey);
  const pkgCandidates = [
    join(releaseRoot, 'lib', 'node_modules', ...targetPackage.split('/'), 'package.json'),
    join(releaseRoot, 'node_modules', ...targetPackage.split('/'), 'package.json'),
  ];
  const matchedPkgPath = pkgCandidates.find((candidate) => existsSync(candidate));
  if (!matchedPkgPath) return null;

  // Prefer the installer's own wrapper or recorded nodeExecutable so a managed Node 24 install
  // is never forced onto an ACP client's Node 22 ABI.
  const recordedNode = readInstallerNodeExecutable(installDir);
  if (recordedNode) {
    return resolveBinEntryFromPkgJson(matchedPkgPath, true, recordedNode);
  }

  try {
    const pkg = JSON.parse(readFileSync(matchedPkgPath, 'utf8'));
    if (!isVersionCompatible(pkg.version, targetVersion, exactVersion)) return null;
  } catch {
    return null;
  }

  const launcherCandidates =
    process.platform === 'win32'
      ? [join(installDir, 'mcode.cmd'), join(releaseRoot, 'mcode.cmd')]
      : [join(installDir, 'bin', 'mcode'), join(releaseRoot, '.mcode-launcher')];
  for (const launcher of launcherCandidates) {
    if (existsSync(launcher)) {
      return { command: launcher, prefixArgs: [] };
    }
  }

  return resolveBinEntryFromPkgJson(matchedPkgPath, true, process.execPath);
}

function resolvePathMcode() {
  const rawPath = process.env.PATH;
  const pathDirs = rawPath ? rawPath.split(delimiter).filter(Boolean) : [];
  if (rawPath !== '' && process.platform !== 'win32') {
    for (const extra of [
      join(os.homedir(), '.minimax-code', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      join(os.homedir(), '.local', 'bin'),
    ]) {
      if (!pathDirs.includes(extra)) pathDirs.push(extra);
    }
  }
  const names = process.platform === 'win32' ? ['mcode.cmd', 'mcode.exe', 'mcode'] : ['mcode'];

  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      const real = safeRealpath(candidate);
      if (real === selfRealPath) continue;

      const spec = buildSpawnInvocation(candidate, ['--version']);
      const probe = spawnSync(spec.command, spec.args, {
        ...spec.options,
        encoding: 'utf8',
        timeout: 2500,
      });
      if (
        probe.status === 0 &&
        isVersionCompatible(
          (probe.stdout || '').trim().split(/\r?\n/u)[0],
          targetVersion,
          exactVersion,
        )
      ) {
        // Execute the candidate shim/shebang itself so it keeps its own bound Node binary.
        return { command: candidate, prefixArgs: [] };
      }
    }
  }
  return null;
}

function resolveExistingMcode() {
  const cached = resolveCachedRelease();
  if (cached) return cached;
  const adjacent = resolveAdjacentDependency();
  if (adjacent) return adjacent;
  if (process.env.MCODE_ACP_SKIP_LOCAL_MCODE === '1') return null;
  const official = resolveOfficialInstallerRelease();
  if (official) return official;
  return resolvePathMcode();
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function positiveMillisecondsFromEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function sweepStaleStagingDirectories(rootDir, keyPrefix, staleMs) {
  let entries = [];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return;
  }
  const prefix = `${keyPrefix}.staging-`;
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    const pidPart = Number.parseInt(rest.split('-')[0] ?? '', 10);
    const fullPath = join(rootDir, name);
    let expired = !isProcessAlive(pidPart);
    if (!expired) {
      try {
        expired = now - statSync(fullPath).mtimeMs > staleMs;
      } catch {
        expired = true;
      }
    }
    if (expired) {
      rmSync(fullPath, { recursive: true, force: true });
    }
  }
}

async function acquireBootstrapLock(lockDir, signal) {
  const staleMs = positiveMillisecondsFromEnv('MCODE_ACP_LOCK_STALE_MS', DEFAULT_LOCK_STALE_MS);
  const waitTimeoutMs = positiveMillisecondsFromEnv(
    'MCODE_ACP_LOCK_TIMEOUT_MS',
    DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  );
  const deadline = Date.now() + waitTimeoutMs;
  mkdirSync(dirname(lockDir), { recursive: true });
  while (true) {
    if (signal?.aborted) throw new Error('ACP bootstrap cancelled');
    try {
      mkdirSync(lockDir);
      writeFileSync(
        join(lockDir, 'owner.json'),
        JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      );
      return {
        staleMs,
        release: () => {
          rmSync(lockDir, { recursive: true, force: true });
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
        const ageMs =
          typeof owner?.startedAt === 'number' ? Date.now() - owner.startedAt : Infinity;
        if (!isProcessAlive(owner?.pid) || ageMs > staleMs) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // If owner.json is unreadable and lock directory itself is stale, reclaim it.
        try {
          if (Date.now() - statSync(lockDir).mtimeMs > staleMs) {
            rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {}
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for concurrent MiniMax Code bootstrap lock');
      }
      await new Promise((r) => setTimeout(r, Math.min(200, Math.max(10, deadline - Date.now()))));
    }
  }
}

const ALLOWED_NPMRC_PROXY_KEYS = new Set([
  'proxy',
  'https-proxy',
  'http-proxy',
  'noproxy',
  'no-proxy',
]);

export function extractAllowedProxyNpmrc(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent.trim()) return '';
  const kept = [];
  for (const rawLine of rawContent.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim().toLowerCase();
    if (!ALLOWED_NPMRC_PROXY_KEYS.has(key)) continue;
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!value || /[\r\n\0]/u.test(value)) continue;
    kept.push(`${key}=${value}`);
  }
  return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}

function readAllowedUserProxyNpmrc() {
  const userNpmrcPath = process.env.MCODE_ACP_USER_NPMRC?.trim() || join(os.homedir(), '.npmrc');
  try {
    if (!existsSync(userNpmrcPath)) return '';
    return extractAllowedProxyNpmrc(readFileSync(userNpmrcPath, 'utf8'));
  } catch {
    return '';
  }
}

function buildIsolatedNpmEnvironment() {
  const cleanEnv = {};
  const allowedNpmProxyKeys = new Set([
    'npm_config_proxy',
    'npm_config_https_proxy',
    'npm_config_http_proxy',
    'npm_config_noproxy',
    'npm_config_better_sqlite3_binary_host_mirror',
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower.startsWith('npm_config_') && !allowedNpmProxyKeys.has(lower)) {
      continue;
    }
    cleanEnv[key] = value;
  }
  const nodeBinDir = dirname(process.execPath);
  cleanEnv.PATH = cleanEnv.PATH ? `${nodeBinDir}${delimiter}${cleanEnv.PATH}` : nodeBinDir;
  return cleanEnv;
}

function resolveNpmSpawnInvocation(npmArgs) {
  const explicitNpm = process.env.MCODE_ACP_NPM_BIN?.trim();
  if (explicitNpm) {
    return buildSpawnInvocation(explicitNpm, npmArgs);
  }
  const bundledNpmCli = resolveBundledNpmCliJs();
  if (bundledNpmCli) {
    return {
      command: process.execPath,
      args: [bundledNpmCli, ...npmArgs],
      options: { windowsHide: true },
    };
  }
  return buildSpawnInvocation(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs);
}

async function bootstrapMcodeIntoCache(signal) {
  if (!targetVersion || targetVersion === '0.0.0-dev') {
    throw new Error(`${targetPackage} is not installed and launcher version is 0.0.0-dev`);
  }
  const key = packageCacheKey(targetPackage, targetVersion);
  const finalDir = join(cacheRoot, key);
  const lockDir = join(cacheRoot, `${key}.lock`);
  const lock = await acquireBootstrapLock(lockDir, signal);
  let stagingDir = '';
  try {
    sweepStaleStagingDirectories(cacheRoot, key, lock.staleMs);
    const alreadyReady = resolveCachedRelease();
    if (alreadyReady) return alreadyReady;

    stagingDir = join(cacheRoot, `${key}.staging-${process.pid}-${randomUUID().slice(0, 8)}`);
    mkdirSync(stagingDir, { recursive: true });
    const isolatedNpmrc = join(stagingDir, '.npmrc-isolated');
    writeFileSync(isolatedNpmrc, readAllowedUserProxyNpmrc());
    writeFileSync(join(stagingDir, 'package.json'), JSON.stringify({ private: true }));

    const registry = process.env.MCODE_ACP_NPM_REGISTRY?.trim() || DEFAULT_PUBLIC_REGISTRY;
    const npmArgs = [
      'install',
      `${targetPackage}@${targetVersion}`,
      '--no-save',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
      '--include=optional',
      '--ignore-scripts=false',
      '--userconfig',
      isolatedNpmrc,
      '--registry',
      registry,
    ];
    const npmSpec = resolveNpmSpawnInvocation(npmArgs);

    await new Promise((resolveInstall, rejectInstall) => {
      const npmChild = spawn(npmSpec.command, npmSpec.args, {
        ...npmSpec.options,
        cwd: stagingDir,
        env: buildIsolatedNpmEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      npmChild.stderr.on('data', (chunk) => {
        if (stderr.length < 16384) stderr += chunk.toString();
      });
      const onAbort = () => {
        try {
          npmChild.kill('SIGTERM');
        } catch {}
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      npmChild.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        rejectInstall(
          new Error(`Failed to run npm for ${targetPackage}@${targetVersion}: ${err.message}`),
        );
      });
      npmChild.on('exit', (code) => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) {
          rejectInstall(new Error('ACP bootstrap cancelled'));
          return;
        }
        if (code !== 0) {
          rejectInstall(
            new Error(
              `npm install ${targetPackage}@${targetVersion} exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
            ),
          );
          return;
        }
        resolveInstall();
      });
    });

    const stagedEntry = resolveBinEntryFromPkgJson(
      packageJsonInPrefix(stagingDir, targetPackage),
      false,
    );
    if (!stagedEntry) {
      throw new Error(`Installed ${targetPackage}@${targetVersion} has no runnable "mcode" bin`);
    }
    writeFileSync(
      join(stagingDir, 'ready.json'),
      JSON.stringify({
        package: targetPackage,
        version: targetVersion,
        nodeAbi,
        createdAt: Date.now(),
      }),
    );
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(stagingDir, finalDir);
    stagingDir = '';

    const resolved = resolveCachedRelease();
    if (!resolved) {
      throw new Error(`Failed to resolve cached ${targetPackage}@${targetVersion} after install`);
    }
    return resolved;
  } finally {
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
    lock.release();
  }
}

export function readThreadGoalEnabledFromConfig(
  dataDir = process.env.MINIMAX_DATA_DIR?.trim() || join(os.homedir(), '.minimax'),
) {
  // `threadGoal` has defaultVisibility 'online' in @mavis/config, so it is enabled unless
  // `config.yaml` explicitly sets `threadGoal: false`.
  try {
    const raw = readFileSync(join(dataDir, 'config.yaml'), 'utf8');
    if (/^\s*threadGoal\s*:\s*false\s*(?:#.*)?$/mu.test(raw)) return false;
    return true;
  } catch {
    return true;
  }
}

export function buildBootstrapInitializeResponse(
  id,
  params,
  { version = targetVersion, goalEnabled = readThreadGoalEnabledFromConfig() } = {},
) {
  const clientCapabilities = params?.clientCapabilities ?? {};
  const supportsTerminalAuth =
    clientCapabilities?.auth?.terminal === true ||
    clientCapabilities?._meta?.['terminal-auth'] === true;
  const methods = goalEnabled
    ? [
        ...BASE_EXTENSION_METHODS.slice(0, 8),
        ...GOAL_EXTENSION_METHODS,
        ...BASE_EXTENSION_METHODS.slice(8),
      ]
    : BASE_EXTENSION_METHODS;
  const notifications = goalEnabled
    ? [
        BASE_EXTENSION_NOTIFICATIONS[0],
        BASE_EXTENSION_NOTIFICATIONS[1],
        'mcode/session/goal_update',
        BASE_EXTENSION_NOTIFICATIONS[2],
      ]
    : BASE_EXTENSION_NOTIFICATIONS;

  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: { image: true, audio: false, embeddedContext: false },
        sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {} },
      },
      ...(supportsTerminalAuth ? { authMethods: BOOTSTRAP_AUTH_METHODS } : {}),
      agentInfo: {
        name: 'minimax-code',
        title: 'MiniMax Code',
        version,
      },
      _meta: {
        'minimax-code/extensions': {
          version: 1,
          methods,
          notifications,
        },
      },
    },
  };
}

function attachChildLifecycle(child, options = {}) {
  const { onSignalBeforeChild, waitForStdoutDrain = false, onBeforeExit } = options;
  if (onSignalBeforeChild) {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.off(sig, onSignalBeforeChild);
    }
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {}
    });
  }

  child.on('error', (err) => {
    console.error(`code-acp: failed to start mcode: ${err.message}`);
    process.exit(1);
  });

  let stdoutEnded = !waitForStdoutDrain || !child.stdout;
  if (waitForStdoutDrain && child.stdout) {
    child.stdout.once('end', () => {
      stdoutEnded = true;
    });
    child.stdout.once('close', () => {
      stdoutEnded = true;
    });
  }

  const exitNow = (code, signal) => {
    if (signal) {
      for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeAllListeners(s);
      try {
        process.kill(process.pid, signal);
      } catch {}
      process.exit(128 + (os.constants.signals[signal] ?? 0));
    }
    process.exit(code ?? 1);
  };

  const finishExit = (code, signal) => {
    onBeforeExit?.();
    if (!waitForStdoutDrain || process.stdout.writableLength === 0) {
      exitNow(code, signal);
      return;
    }
    let exited = false;
    const flushDone = () => {
      if (exited) return;
      exited = true;
      clearTimeout(flushTimer);
      exitNow(code, signal);
    };
    const flushTimer = setTimeout(flushDone, 250);
    process.stdout.write('', flushDone);
  };

  child.on('exit', (code, signal) => {
    if (stdoutEnded || child.stdout?.readableEnded) {
      finishExit(code, signal);
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      finishExit(code, signal);
    };
    // Bound the wait in case a grandchild process inherited the stdout pipe descriptor.
    const fallbackTimer = setTimeout(done, 250);
    child.stdout.once('end', done);
    child.stdout.once('close', done);
  });
}

function spawnResolvedChild(resolved, stdio) {
  const spec = buildSpawnInvocation(resolved.command, [...resolved.prefixArgs, ...args]);
  return spawn(spec.command, spec.args, {
    ...spec.options,
    stdio,
  });
}

async function bootstrapAndBridgeAcp() {
  const controller = new AbortController();
  const abortBootstrap = () => controller.abort();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, abortBootstrap);
  }

  let initAnswered = false;
  let initParams = {};
  let stdinEnded = false;
  let partialStdin = '';
  const bufferedLines = [];
  const bufferedRequestIds = [];
  let bootstrapSettled = false;

  const bootstrapPromise = bootstrapMcodeIntoCache(controller.signal);

  const onStdinData = (chunk) => {
    partialStdin += chunk.toString('utf8');
    const parts = partialStdin.split('\n');
    partialStdin = parts.pop() ?? '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) {
        bufferedLines.push(`${line}\n`);
        continue;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Forward non-JSON or malformed lines untouched once child starts.
      }
      if (!initAnswered && parsed && parsed.method === 'initialize' && parsed.id !== undefined) {
        initAnswered = true;
        initParams = parsed.params ?? {};
        process.stdout.write(
          `${JSON.stringify(buildBootstrapInitializeResponse(parsed.id, initParams))}\n`,
        );
        continue;
      }
      bufferedLines.push(`${line}\n`);
      if (parsed && parsed.id !== undefined && typeof parsed.method === 'string') {
        bufferedRequestIds.push(parsed.id);
      }
    }
  };

  const onStdinEnd = () => {
    stdinEnded = true;
    if (!bootstrapSettled && bufferedLines.length === 0 && !partialStdin.trim()) {
      controller.abort();
    }
  };

  process.stdin.on('data', onStdinData);
  process.stdin.on('end', onStdinEnd);

  let resolved;
  try {
    resolved = await bootstrapPromise;
    bootstrapSettled = true;
  } catch (err) {
    bootstrapSettled = true;
    process.stdin.off('data', onStdinData);
    process.stdin.off('end', onStdinEnd);
    if (stdinEnded && bufferedRequestIds.length === 0) {
      process.exit(0);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`code-acp: ${message}`);
    for (const id of bufferedRequestIds) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: `MiniMax Code bootstrap failed: ${message}` },
        })}\n`,
      );
    }
    process.exit(1);
  }

  process.stdin.pause();
  process.stdin.off('data', onStdinData);
  process.stdin.off('end', onStdinEnd);

  if (stdinEnded && bufferedLines.length === 0 && !partialStdin.trim()) {
    process.exit(0);
  }

  let childStdoutBuffer = '';
  const child = spawnResolvedChild(resolved, ['pipe', 'pipe', 'inherit']);
  attachChildLifecycle(child, {
    onSignalBeforeChild: abortBootstrap,
    waitForStdoutDrain: true,
    onBeforeExit: () => {
      if (childStdoutBuffer) {
        process.stdout.write(childStdoutBuffer);
        childStdoutBuffer = '';
      }
    },
  });

  const forwardRemainingStdin = () => {
    for (const line of bufferedLines) {
      child.stdin.write(line);
    }
    bufferedLines.length = 0;
    if (partialStdin) {
      child.stdin.write(partialStdin);
      partialStdin = '';
    }
    if (stdinEnded) {
      child.stdin.end();
    } else {
      process.stdin.pipe(child.stdin);
      process.stdin.resume();
    }
  };

  if (!initAnswered) {
    child.stdout.pipe(process.stdout);
    forwardRemainingStdin();
    return;
  }

  const onChildStdout = (chunk) => {
    childStdoutBuffer += chunk.toString('utf8');
    const lines = childStdoutBuffer.split('\n');
    childStdoutBuffer = lines.pop() ?? '';
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      let parsed = null;
      try {
        parsed = JSON.parse(line.trim());
      } catch {}
      if (parsed && parsed.id === BOOTSTRAP_INIT_ID) {
        child.stdout.off('data', onChildStdout);
        const remainingLines = lines.slice(i + 1);
        for (const rem of remainingLines) {
          process.stdout.write(`${rem}\n`);
        }
        if (childStdoutBuffer) {
          process.stdout.write(childStdoutBuffer);
          childStdoutBuffer = '';
        }
        child.stdout.pipe(process.stdout);
        forwardRemainingStdin();
        return;
      }
      process.stdout.write(`${line}\n`);
    }
  };

  child.stdout.on('data', onChildStdout);
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: BOOTSTRAP_INIT_ID,
      method: 'initialize',
      params: initParams,
    })}\n`,
  );
}

async function main() {
  const existing = resolveExistingMcode();
  if (existing) {
    const child = spawnResolvedChild(existing, 'inherit');
    attachChildLifecycle(child);
    return;
  }

  if (args.length === 1 && args[0] === 'acp') {
    await bootstrapAndBridgeAcp();
    return;
  }

  const controller = new AbortController();
  const abortBootstrap = () => controller.abort();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, abortBootstrap);
  }
  try {
    const resolved = await bootstrapMcodeIntoCache(controller.signal);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.off(sig, abortBootstrap);
    }
    const child = spawnResolvedChild(resolved, 'inherit');
    attachChildLifecycle(child);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`code-acp: ${message}`);
    process.exit(1);
  }
}

if (process.argv[1] && safeRealpath(process.argv[1]) === selfRealPath) {
  void main();
}
