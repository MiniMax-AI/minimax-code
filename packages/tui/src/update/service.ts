import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';
import { EnvHttpProxyAgent, fetch } from 'undici';
import { retryWindowsFileSystemOperation } from '@mavis/shared';
import { resolveMcodeNpmDistribution } from './install-source.js';
import { readMcodeBinEntry, resolveMcodePrefixPackageRoot } from './prefix-update.js';
import {
  McodeUpdateCancelledError,
  reportMcodeUpdatePhase,
  throwIfMcodeUpdateCancelled,
  type McodeUpdateOperationOptions,
} from './progress.js';
import {
  assertMcodeReleaseTargetAvailable,
  compareMcodeVersions,
  parseAndVerifyMcodeReleaseManifest,
  parseMcodeUpdateChannel,
  parseMcodeVersion,
  resolveMcodeReleaseTarget,
  type McodeReleaseManifestV1,
  type McodeUpdateChannel,
} from './release.js';

export { isManagedMcodeInstallRoot } from './install-source.js';

const DEFAULT_RELEASE_BASE_URL =
  'https://algeng-ali-shanghai-agent-02.oss-cn-shanghai.aliyuncs.com/' +
  'minimax-dialogue/data/env/.npm-global/mcode';
const DEFAULT_TIMEOUT_MS = 8_000;

export interface McodeUpdateRequest extends McodeUpdateOperationOptions {
  channel?: string;
  version?: string;
  timeoutMs?: number;
}

export interface McodeUpdateCheckResult {
  status: 'available' | 'current' | 'ahead';
  channel: McodeUpdateChannel;
  currentVersion: string;
  latestVersion: string;
  manifest: McodeReleaseManifestV1;
}

export interface McodeUpdateApplyResult extends McodeUpdateCheckResult {
  applied: boolean;
  installRoot: string;
}

export interface McodeUpdateDependencies {
  fetchBytes(
    url: string,
    options?: { signal?: AbortSignal; proxyEnvironment?: NodeJS.ProcessEnv },
  ): Promise<Buffer>;
  installArtifact(input: {
    artifact: string;
    prefix: string;
    registry: string;
    proxyEnvironment: NodeJS.ProcessEnv;
  }): Promise<void>;
  validateInstalledVersion(prefix: string, version: string): Promise<void>;
}

export interface McodeUpdateServiceOptions {
  currentVersion: string;
  installRoot?: string;
  releaseBaseUrl?: string;
  publicKey?: string;
  environment?: NodeJS.ProcessEnv;
  dependencies?: Partial<McodeUpdateDependencies>;
}

export class McodeUpdateService {
  private readonly currentVersion: string;
  private readonly installRoot: string;
  private readonly releaseBaseUrl: string;
  private readonly publicKey?: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly dependencies: McodeUpdateDependencies;

  constructor(options: McodeUpdateServiceOptions) {
    this.currentVersion = parseMcodeVersion(options.currentVersion);
    this.installRoot = options.installRoot ?? resolveMcodeInstallRoot(options.environment);
    this.releaseBaseUrl = (options.releaseBaseUrl ?? DEFAULT_RELEASE_BASE_URL).replace(/\/+$/u, '');
    this.publicKey = options.publicKey;
    this.environment = options.environment ?? process.env;
    this.dependencies = {
      fetchBytes: defaultFetchBytes,
      installArtifact: defaultInstallArtifact,
      validateInstalledVersion: defaultValidateInstalledVersion,
      ...options.dependencies,
    };
  }

  async check(request: McodeUpdateRequest = {}): Promise<McodeUpdateCheckResult> {
    throwIfMcodeUpdateCancelled(request.signal);
    reportMcodeUpdatePhase(request, 'checking', true);
    const channel = request.channel
      ? parseMcodeUpdateChannel(request.channel)
      : readMcodeUpdateChannel(this.installRoot);
    const version = request.version ? parseMcodeVersion(request.version) : undefined;
    const manifestUrl = version
      ? `${this.releaseBaseUrl}/releases/${encodeURIComponent(version)}/manifest.json`
      : `${this.releaseBaseUrl}/channels/${channel}.json`;
    const publicKey = this.publicKey ?? readInstalledPublicKey(this.installRoot, this.environment);
    const timeoutMs = normalizeTimeout(request.timeoutMs);
    const controller = new AbortController();
    const detachRequestAbort = forwardAbort(request.signal, controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`MCode update check timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timeout.unref?.();
    try {
      const [manifestBytes, signatureBytes] = await Promise.all([
        this.dependencies.fetchBytes(manifestUrl, {
          signal: controller.signal,
          proxyEnvironment: this.environment,
        }),
        this.dependencies.fetchBytes(`${manifestUrl}.sig`, {
          signal: controller.signal,
          proxyEnvironment: this.environment,
        }),
      ]);
      const manifest = parseAndVerifyMcodeReleaseManifest(
        manifestBytes,
        signatureBytes.toString('utf8'),
        publicKey,
      );
      if (!version && manifest.channel !== channel) {
        throw new Error(
          `Signed MCode release channel mismatch: expected ${channel}, got ${manifest.channel}.`,
        );
      }
      if (version && manifest.version !== version) {
        throw new Error(
          `Signed MCode release version mismatch: expected ${version}, got ${manifest.version}.`,
        );
      }
      assertMcodeReleaseTargetAvailable(manifest, resolveMcodeReleaseTarget());
      const comparison = compareMcodeVersions(this.currentVersion, manifest.version);
      return {
        status: comparison < 0 ? 'available' : comparison > 0 ? 'ahead' : 'current',
        channel,
        currentVersion: this.currentVersion,
        latestVersion: manifest.version,
        manifest,
      };
    } catch (error) {
      if (request.signal?.aborted) throw new McodeUpdateCancelledError();
      if (timedOut) {
        throw new Error(`MCode update check timed out after ${timeoutMs}ms.`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      detachRequestAbort();
    }
  }

  async apply(request: McodeUpdateRequest = {}): Promise<McodeUpdateApplyResult> {
    const check = await this.check(request);
    if (check.status === 'current') {
      return { ...check, applied: false, installRoot: this.installRoot };
    }
    if (check.status === 'ahead' && !request.version) {
      throw new Error(
        `Installed MCode ${this.currentVersion} is newer than ${check.channel} ` +
          `${check.latestVersion}; pass --to to downgrade explicitly.`,
      );
    }

    const artifactTimeoutMs = normalizeTimeout(request.timeoutMs);
    throwIfMcodeUpdateCancelled(request.signal);
    reportMcodeUpdatePhase(request, 'downloading', true);
    const artifactController = new AbortController();
    const detachRequestAbort = forwardAbort(request.signal, artifactController);
    let artifactTimedOut = false;
    const artifactTimeout = setTimeout(() => {
      artifactTimedOut = true;
      artifactController.abort(
        new Error(`MCode artifact download timed out after ${artifactTimeoutMs}ms.`),
      );
    }, artifactTimeoutMs);
    artifactTimeout.unref?.();
    let artifactBytes: Buffer;
    try {
      artifactBytes = await this.dependencies.fetchBytes(check.manifest.installArtifact.url, {
        signal: artifactController.signal,
        proxyEnvironment: this.environment,
      });
    } catch (error) {
      if (request.signal?.aborted) throw new McodeUpdateCancelledError();
      if (artifactTimedOut) {
        throw new Error(`MCode artifact download timed out after ${artifactTimeoutMs}ms.`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(artifactTimeout);
      detachRequestAbort();
    }
    throwIfMcodeUpdateCancelled(request.signal);
    verifyArtifact(artifactBytes, check.manifest);

    const versionsRoot = path.join(this.installRoot, 'versions');
    const finalPrefix = path.join(versionsRoot, check.latestVersion);
    const stagingPrefix = path.join(
      versionsRoot,
      `.staging-${check.latestVersion}-${process.pid}-${Date.now()}`,
    );
    const artifactFile = path.join(stagingPrefix, `minimax-mcode-${check.latestVersion}.tgz`);
    mkdirSync(stagingPrefix, { recursive: true });
    let createdFinalPrefix = false;
    try {
      reportMcodeUpdatePhase(request, 'staging', true);
      throwIfMcodeUpdateCancelled(request.signal);
      writeFileSync(artifactFile, artifactBytes, { mode: 0o600 });
      throwIfMcodeUpdateCancelled(request.signal);
      reportMcodeUpdatePhase(request, 'installing', false);
      await this.dependencies.installArtifact({
        artifact: artifactFile,
        prefix: stagingPrefix,
        registry: check.manifest.registry,
        proxyEnvironment: this.environment,
      });
      throwIfMcodeUpdateCancelled(request.signal);
      retryWindowsFileSystemOperation(() => rmSync(artifactFile, { force: true }));
      reportMcodeUpdatePhase(request, 'validating', false);
      await this.dependencies.validateInstalledVersion(stagingPrefix, check.latestVersion);
      throwIfMcodeUpdateCancelled(request.signal);
      reportMcodeUpdatePhase(request, 'activating', false);
      if (existsSync(finalPrefix)) {
        await this.dependencies.validateInstalledVersion(finalPrefix, check.latestVersion);
        removeUpdateTree(stagingPrefix);
      } else {
        retryWindowsFileSystemOperation(() => renameSync(stagingPrefix, finalPrefix));
        createdFinalPrefix = true;
      }
      activateVersion(this.installRoot, check.latestVersion);
      reportMcodeUpdatePhase(request, 'completed', false);
      return { ...check, applied: true, installRoot: this.installRoot };
    } catch (error) {
      removeUpdateTree(stagingPrefix);
      if (createdFinalPrefix && readActiveVersion(this.installRoot) !== check.latestVersion) {
        removeUpdateTree(finalPrefix);
      }
      if (error instanceof McodeUpdateCancelledError || request.signal?.aborted) {
        throw new McodeUpdateCancelledError();
      }
      throw new Error(
        `MCode ${check.latestVersion} was not activated; the previous version is unchanged: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

export function resolveMcodeInstallRoot(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.MCODE_INSTALL_ROOT) return path.resolve(environment.MCODE_INSTALL_ROOT);
  if (process.platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA;
    if (!localAppData)
      throw new Error('LOCALAPPDATA is required to resolve the MCode install root.');
    return path.join(localAppData, 'MinimaxCode');
  }
  const dataHome = environment.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
  return path.join(dataHome, 'minimax-code');
}

export function readMcodeUpdateChannel(installRoot: string): McodeUpdateChannel {
  const file = path.join(installRoot, 'update.json');
  if (!existsSync(file)) return 'stable';
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`MCode update channel config is invalid: ${errorMessage(error)}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('channel' in parsed) ||
    typeof parsed.channel !== 'string'
  ) {
    throw new Error('MCode update channel config is missing channel.');
  }
  return parseMcodeUpdateChannel(parsed.channel);
}

function readInstalledPublicKey(installRoot: string, environment: NodeJS.ProcessEnv): string {
  const explicitFile = environment.MCODE_RELEASE_PUBLIC_KEY_FILE;
  if (explicitFile) return readFileSync(path.resolve(explicitFile), 'utf8');
  const metadataFile = path.join(installRoot, 'install.json');
  if (!existsSync(metadataFile)) {
    throw new Error(
      'MCode update trust root is missing. Install with the official Shell/PowerShell installer first.',
    );
  }
  const metadata = JSON.parse(readFileSync(metadataFile, 'utf8')) as { publicKey?: unknown };
  if (typeof metadata.publicKey !== 'string' || !metadata.publicKey.includes('BEGIN PUBLIC KEY')) {
    throw new Error('MCode installer metadata does not contain a valid release public key.');
  }
  return metadata.publicKey;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) {
    throw new Error('MCode update timeout must be an integer between 100 and 60000 milliseconds.');
  }
  return value;
}

async function defaultFetchBytes(
  url: string,
  options: { signal?: AbortSignal; proxyEnvironment?: NodeJS.ProcessEnv } = {},
): Promise<Buffer> {
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: options.proxyEnvironment?.HTTP_PROXY ?? options.proxyEnvironment?.http_proxy,
    httpsProxy: options.proxyEnvironment?.HTTPS_PROXY ?? options.proxyEnvironment?.https_proxy,
    noProxy: options.proxyEnvironment?.NO_PROXY ?? options.proxyEnvironment?.no_proxy,
  });
  try {
    const response = await fetch(url, {
      signal: options.signal,
      dispatcher,
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(`MCode release server returned HTTP ${response.status} for ${url}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    await dispatcher.close();
  }
}

async function defaultInstallArtifact(input: {
  artifact: string;
  prefix: string;
  registry: string;
  proxyEnvironment: NodeJS.ProcessEnv;
}): Promise<void> {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await runMcodeUpdateCommand(
    npm,
    [
      'install',
      '--global',
      '--prefix',
      input.prefix,
      input.artifact,
      '--registry',
      input.registry,
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
    ],
    input.proxyEnvironment,
    true,
  );
}

async function defaultValidateInstalledVersion(prefix: string, version: string): Promise<void> {
  let executable = path.join(prefix, 'bin', 'mcode');
  let args = ['--version'];
  if (process.platform === 'win32') {
    const packageRoot = resolveMcodePrefixPackageRoot(
      prefix,
      resolveMcodeNpmDistribution().packageName,
    );
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const binEntry = readMcodeBinEntry(manifest.bin, 'mcode');
    if (!binEntry || !existsSync(path.join(prefix, 'mcode.cmd'))) {
      throw new Error(`Installed MCode launcher is missing or invalid at ${prefix}.`);
    }
    executable = process.execPath;
    args = [path.join(packageRoot, binEntry), '--version'];
  }
  const output = await runMcodeUpdateCommand(executable, args, process.env, true);
  if (output.trim() !== version) {
    throw new Error(`Installed MCode version mismatch: expected ${version}, got ${output.trim()}`);
  }
}

export function runMcodeUpdateCommand(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  capture = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      env: environment,
      shell: false,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', (code, exitSignal) => {
      if (settled) return;
      settled = true;
      if (code === 0) return resolve(Buffer.concat(stdout).toString('utf8'));
      const details = Buffer.concat(stderr).toString('utf8').trim();
      reject(
        new Error(
          `${command} failed (${
            exitSignal ? `signal ${exitSignal}` : `exit ${String(code)}`
          })${details ? `: ${details}` : ''}`,
        ),
      );
    });
  });
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function verifyArtifact(bytes: Buffer, manifest: McodeReleaseManifestV1): void {
  if (bytes.length !== manifest.installArtifact.size) {
    throw new Error(
      `MCode artifact checksum/size verification failed: expected ` +
        `${manifest.installArtifact.size} bytes, got ${bytes.length}.`,
    );
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== manifest.installArtifact.sha256) {
    throw new Error('MCode artifact checksum verification failed.');
  }
}

function activateVersion(installRoot: string, version: string): void {
  mkdirSync(installRoot, { recursive: true });
  const current = path.join(installRoot, 'current');
  const temporary = `${current}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${version}\n`, { mode: 0o600 });
  retryWindowsFileSystemOperation(() => renameSync(temporary, current));
}

function removeUpdateTree(target: string): void {
  rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
}

function readActiveVersion(installRoot: string): string | undefined {
  const current = path.join(installRoot, 'current');
  if (!existsSync(current)) return undefined;
  return readFileSync(current, 'utf8').trim() || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
