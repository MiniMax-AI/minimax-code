/**
 * Desktop read / write / edit / bash: the host-neutral core tools
 * (`../core-tools/`) bound to physical IO plus the desktop-only behavior: native
 * audio / PDF reads, the read-before-overwrite guard, and the bash capabilities
 * (host trash, sandboxed operations, env sanitizing, background).
 */

import {
  attachProgrammaticErrorData,
  bindTool,
  type ToolImpl,
  type ToolResult,
  withProgrammaticResult,
} from '@mavis/agent-core/tools';
import { logger } from '@mavis/shared/local-runtime-logging/logger';
import { getShellConfig } from '@earendil-works/pi-coding-agent/shell';
import { basename, extname, isAbsolute, relative, sep } from 'node:path';
import { release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { CoreBashTool } from '../core-tools/bash-tool.js';
import { CoreReadTool } from '../core-tools/read-tool.js';
import { CoreEditTool, CoreWriteTool } from '../core-tools/write-edit-tools.js';
import { resolveCandidatePath } from '../core-tools/paths.js';
import type { CoreToolHost } from '../core-tools/ports.js';
import { readNativeMediaAsToolResult } from '../shared/read-native-media.js';
import { nativeAudioMimeForExtension } from '../shared/multimodal-attachments.js';
import { checkBlockedDeviceRead, checkNonRegularFileRead } from '../shared/read-guards.js';
import { isPdfReadPath } from '../shared/read-pdf.js';
import type { EditReadTracking } from '../shared/edit-capture.js';
import type { WriteGuard } from '../shared/write-capture.js';
import {
  assertOverwriteAllowed,
  isRememberedVersionCurrent,
  observeFileVersion,
  type ObservedFileVersion,
  rememberCurrentFileVersion,
  rememberFileVersion,
  WriteGuardRejectedError,
  writeGuardRejectedResult,
} from '../shared/file-read-ledger.js';
import {
  LocalBashToolDef,
  LocalEditToolDef,
  type LocalEditToolInput,
  LocalReadToolDef,
  type LocalReadToolInput,
  LocalWriteToolDef,
  type LocalWriteToolInput,
} from './builtin-defs.js';
import type {
  LocalBashAdapter,
  LocalRuntimeToolContext,
  LocalSandboxBashOperationsFactory,
  LocalSandboxInvocationIdentity,
} from './types.js';
import {
  executeLocalHostTrashIfRequested,
  type LocalHostTrashRuntime,
} from './host-trash-executor.js';
import {
  assertPermissionWriteTargetUnchanged,
  resolvePermissionBashEnvPolicy,
  type LocalBashEnvPolicySource,
} from './permission-execution.js';
import { localCoreToolHost } from './local-core-tool-host.js';

export { normalizeLocalExistingPath } from '../core-tools/paths.js';
export {
  resolveForegroundTimeout,
  resolvePtcForegroundTimeout,
} from '../core-tools/bash-tool.js';

/**
 * Platform, OS release and shell as this machine states them now. Each call
 * reads them again; the prompt keeps the first answer of its process
 * (createNativeLocalAgentPreparation), since these facts sit in the cached
 * system prompt prefix.
 */
export function getLocalBashEnvironment(): {
  readonly platform: NodeJS.Platform;
  readonly osVersion: string;
  readonly shell: string;
} {
  let shell = 'unavailable';
  try {
    // Windows prompt preparation uses the Session binding (or pending), never
    // Pi's synchronous auto-discovery. Unix keeps the existing executor choice.
    if (process.platform !== 'win32') {
      const selected = getShellConfig();
      const version = selected.type === 'bash' ? bashVersion(selected.shell) : undefined;
      shell = `${selected.type}${version ? ` ${version}` : ''} (${selected.shell})`;
    }
  } catch {
    // Missing shell support must not prevent turns using other tools.
  }
  const kernel = `${process.platform} ${release()} ${process.arch}`;
  const name = osReleaseName();
  return {
    platform: process.platform,
    osVersion: name ? `${name} (${kernel})` : kernel,
    shell,
  };
}

/**
 * The OS release the model knows, read from the system's own version file.
 * Which commands and flags exist (BSD or GNU tools, BusyBox on Alpine) follows
 * from the release, which a kernel version such as `darwin 25.5.0` does not
 * name. An unreadable file leaves the kernel facts alone, as before.
 */
function osReleaseName(): string | undefined {
  if (process.platform === 'darwin') {
    try {
      const plist = readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8');
      const value = (key: string) =>
        plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, 'u'))?.[1]?.trim();
      const product = value('ProductName');
      const version = value('ProductVersion');
      return product && version ? `${product} ${version}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'linux') {
    for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      return text.match(/^PRETTY_NAME=(["']?)(.*)\1$/mu)?.[2]?.trim() || undefined;
    }
  }
  return undefined;
}

/**
 * The version Bash itself reports: Bash 3.2 (macOS /bin/bash) lacks what Bash
 * 4+ scripts assume. The executable holds no version string to read (macOS
 * builds it from `3.2` and patch 57 at run time), so Bash runs without startup
 * files or environment. A second attempt and a generous limit keep one slow
 * start from leaving the version out of this process's prompt while the next
 * process states it.
 */
function bashVersion(shellPath: string): string | undefined {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const probe = spawnSync(
      shellPath,
      ['--noprofile', '--norc', '-c', 'printf %s "$BASH_VERSION"'],
      { encoding: 'utf8', env: {}, timeout: 5_000 },
    );
    const version = probe.status === 0 ? probe.stdout.match(/^\d+(?:\.\d+)+/u)?.[0] : undefined;
    if (version) return version;
    // A missing or non-executable file gives the same answer on every attempt.
    const code = (probe.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'EACCES') return undefined;
  }
  return undefined;
}

/** The file the core read actually opened, observed just before reading it. */
interface ReadObservation {
  reached: boolean;
  observed?: ObservedFileVersion;
}

/**
 * Physical host for one read, recording in `seen` the file it opens. Pi resolves
 * the path itself (strips `@`, normalizes whitespace), so it may read another
 * file than the one dispatched on; recording what is read keeps the key on the
 * file write targets. When a child read falls back, the second read wins.
 */
function observedReadHost(seen: ReadObservation): CoreToolHost {
  return {
    ...localCoreToolHost,
    fs: {
      ...localCoreToolHost.fs,
      async readFile(path) {
        seen.reached = true;
        seen.observed = await observeFileVersion(path);
        return localCoreToolHost.fs.readFile(path);
      },
    },
  };
}

@bindTool(LocalReadToolDef)
export class LocalReadTool implements ToolImpl<
  typeof LocalReadToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly workspaceRoot: string) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalReadToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const seen: ReadObservation = { reached: false };
    const core = new CoreReadTool<LocalRuntimeToolContext>(
      this.workspaceRoot,
      observedReadHost(seen),
    );
    const readAbs = await resolveLocalReadPath(input.path, this.workspaceRoot).catch(
      () => undefined,
    );
    // The core tool reports these. Nothing here may open a device or FIFO: the
    // read would hang the whole turn, and there is no regular file to record.
    if (
      readAbs === undefined ||
      checkBlockedDeviceRead(readAbs) ||
      (await checkNonRegularFileRead(readAbs))
    ) {
      return core.execute(ctx, input, signal);
    }

    // Stat before reading: if the file changes during the read, the recorded
    // version is already stale and a later overwrite asks for a fresh read.
    // An existing regular file is recorded even when read refuses or fails
    // (binary content, blocked extension, no read permission): read cannot
    // show those by design, and write must still be able to overwrite them.
    // Missing and non-regular files record nothing.
    const observed = await observeFileVersion(readAbs);
    try {
      return (
        (await this.readNativeMedia(ctx, input, readAbs, signal)) ??
        (await core.execute(ctx, input, signal))
      );
    } finally {
      const version = seen.reached ? seen.observed : observed;
      if (version && !signal?.aborted) rememberFileVersion(ctx.sessionId, version);
    }
  }

  /**
   * Audio and PDF go inline only for a model that reads them natively (Gemini).
   * `undefined` leaves the read to the core tool: audio hits the binary guard
   * and PDF is extracted. A page range always uses text extraction.
   */
  private async readNativeMedia(
    ctx: LocalRuntimeToolContext,
    input: LocalReadToolInput,
    absolutePath: string,
    signal: AbortSignal | undefined,
  ): Promise<ToolResult | undefined> {
    const audioMime = nativeAudioMimeForExtension(extname(absolutePath));
    const kind = audioMime ? 'audio' : 'pdf';
    if (!audioMime && (!isPdfReadPath(absolutePath) || input.pages !== undefined)) {
      return undefined;
    }
    try {
      const result = await readNativeMediaAsToolResult({
        toolName: LocalReadToolDef.name,
        absolutePath,
        kind,
        mimeType: audioMime ?? 'application/pdf',
        capabilities: ctx.parentAgentConfig?.model?.capabilities,
        signal,
      });
      return result && withProgrammaticResult(result, { data: { kind } });
    } catch (err) {
      // ENOENT: let the core tool and pi's path variants report it.
      if ((err as { code?: unknown } | null)?.code === 'ENOENT') return undefined;
      // Pi keeps only the message; PTC data still says what kind of read failed.
      attachProgrammaticErrorData(err, { kind });
      throw err;
    }
  }
}

/**
 * What one desktop write's overwrite check decided. `new_file` means there was
 * no regular file to overwrite, so no check ran; the rest are the guard's own
 * outcomes (file-read-ledger.ts). Counted, never shown: the tool result, the
 * reminders and the warning log are unchanged whether or not an observer is
 * attached.
 */
export type WriteGuardCheckResult = 'new_file' | 'allowed' | 'not_read' | 'stale_read';

/**
 * Observes the overwrite check of every write, including writes made by a
 * run_code child. The local runtime turns this into a metric; agent-tools
 * itself only knows the four outcomes above and never imports a metrics client.
 */
export type WriteGuardCheckObserver = (result: WriteGuardCheckResult) => void;

@bindTool(LocalWriteToolDef)
export class LocalWriteTool implements ToolImpl<
  typeof LocalWriteToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(
    private readonly workspaceRoot: string,
    private readonly observeGuardCheck?: WriteGuardCheckObserver,
  ) {}

  /** Diagnostics only: a throwing observer must not change what the write does. */
  private reportGuardCheck(result: WriteGuardCheckResult): void {
    try {
      this.observeGuardCheck?.(result);
    } catch {
      // The write already has its own outcome; observation never overrides it.
    }
  }

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalWriteToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    // In pi's withFileMutationQueue slot, the guard refuses to overwrite a file
    // this session has not read, or that changed after its last read
    // (file-read-ledger.ts).
    const guard: WriteGuard = {
      beforeWrite: async (path, current) => {
        assertPermissionWriteTargetUnchanged(input);
        // No regular file to overwrite: the guard has nothing to compare.
        if (!current) {
          this.reportGuardCheck('new_file');
          return;
        }
        try {
          await assertOverwriteAllowed(ctx.sessionId, path, current);
        } catch (err) {
          if (err instanceof WriteGuardRejectedError) {
            this.reportGuardCheck(err.code === 'WRITE_NOT_READ' ? 'not_read' : 'stale_read');
          }
          throw err;
        }
        this.reportGuardCheck('allowed');
      },
      afterWrite: (path) => rememberCurrentFileVersion(ctx.sessionId, path),
    };
    const fs = { ...localCoreToolHost.fs, guard };
    try {
      return await new CoreWriteTool<LocalRuntimeToolContext>(this.workspaceRoot, {
        ...localCoreToolHost,
        fs,
      }).execute(ctx, input, signal);
    } catch (err) {
      if (!(err instanceof WriteGuardRejectedError)) throw err;
      logger.warn(
        {
          sessionId: ctx.sessionId,
          path: writeGuardLogPath(input.path, this.workspaceRoot),
          reason: err.code,
          recordedVersion: err.recorded ?? null,
          currentVersion: err.current,
        },
        'write guard refused to overwrite file',
      );
      return writeGuardRejectedResult(LocalWriteToolDef.name, input.path, err.code);
    }
  }
}

@bindTool(LocalEditToolDef)
export class LocalEditTool implements ToolImpl<
  typeof LocalEditToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly workspaceRoot: string) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalEditToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    // Edit does not require a read. It only refreshes a read record that
    // still matches the file, so the session can overwrite its own edit
    // without reading again.
    const tracking: EditReadTracking = {
      isRecordCurrent: (path) => isRememberedVersionCurrent(ctx.sessionId, path),
      beforeWrite: () => assertPermissionWriteTargetUnchanged(input),
      refresh: (path) => rememberCurrentFileVersion(ctx.sessionId, path),
    };
    const fs = { ...localCoreToolHost.fs, tracking };
    return new CoreEditTool<LocalRuntimeToolContext>(this.workspaceRoot, {
      ...localCoreToolHost,
      fs,
    }).execute(ctx, input, signal);
  }
}

/**
 * Log label for a refused write. Logs must not carry a private path in full
 * (.harness/docs/code-standards.md), so a file inside the workspace is logged
 * workspace-relative and anything else as `<path>/<basename>`, the shape the
 * Mini App startup-failure log already uses.
 */
function writeGuardLogPath(inputPath: string, workspaceRoot: string): string {
  const absolutePath = resolveCandidatePath(inputPath, workspaceRoot, localCoreToolHost);
  const fromWorkspace = relative(workspaceRoot, absolutePath);
  const outside =
    fromWorkspace === '' ||
    fromWorkspace === '..' ||
    fromWorkspace.startsWith(`..${sep}`) ||
    isAbsolute(fromWorkspace);
  return outside ? `<path>/${basename(absolutePath)}` : fromWorkspace.split(sep).join('/');
}

/** The file the core read tool's path resolution lands on, so native reads dispatch on it. */
async function resolveLocalReadPath(input: string, workspaceRoot: string): Promise<string> {
  const literalResolved = resolveCandidatePath(input, workspaceRoot, localCoreToolHost);
  if (await pathExists(literalResolved)) return literalResolved;

  const resolved = resolveCandidatePath(
    normalizeLocalReadInput(input),
    workspaceRoot,
    localCoreToolHost,
  );
  if (await pathExists(resolved)) return resolved;

  const amPmVariant = resolved.replace(/ (AM|PM)\./gi, '\u202f$1.');
  if (amPmVariant !== resolved && (await pathExists(amPmVariant))) return amPmVariant;

  const nfdVariant = resolved.normalize('NFD');
  if (nfdVariant !== resolved && (await pathExists(nfdVariant))) return nfdVariant;

  const curlyVariant = resolved.replace(/'/g, '\u2019');
  if (curlyVariant !== resolved && (await pathExists(curlyVariant))) return curlyVariant;

  const nfdCurlyVariant = nfdVariant.replace(/'/g, '\u2019');
  if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant))) {
    return nfdCurlyVariant;
  }

  return resolved;
}

function normalizeLocalReadInput(input: string): string {
  let normalized = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await localCoreToolHost.fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

@bindTool(LocalBashToolDef)
export class LocalBashTool extends CoreBashTool<LocalRuntimeToolContext> {
  constructor(
    workspaceRoot: string,
    backgroundAdapter: LocalBashAdapter | undefined,
    envPolicy: LocalBashEnvPolicySource,
    hostTrashRuntime?: LocalHostTrashRuntime,
    sandboxOperationsFactory?: LocalSandboxBashOperationsFactory,
  ) {
    super(workspaceRoot, {
      backgroundAdapter,
      envPolicy,
      executeHostTrash: ({ toolInput, permissionExecutionPlan, timeoutSeconds, signal }) =>
        executeLocalHostTrashIfRequested({
          toolInput,
          workspaceRoot,
          runtime: hostTrashRuntime,
          envPolicy: () => resolvePermissionBashEnvPolicy(envPolicy, permissionExecutionPlan),
          timeoutSeconds,
          ...(signal ? { signal } : {}),
        }),
      ...(sandboxOperationsFactory
        ? {
            createOperations: (ctx, permissionExecutionPlan) =>
              sandboxOperationsFactory.create({
                identity: directForegroundIdentity(ctx),
                workspaceRoot,
                ...(ctx.workspaceRoots ? { workspaceRoots: ctx.workspaceRoots } : {}),
                ...(permissionExecutionPlan ? { permissionExecutionPlan } : {}),
              }),
          }
        : {}),
    });
  }
}

function directForegroundIdentity(ctx: LocalRuntimeToolContext): LocalSandboxInvocationIdentity {
  const invocationId = ctx.toolCallId ?? `runtime_${randomUUID()}`;
  return {
    operationClass: 'direct_foreground' as const,
    invocationId,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
    ...(ctx.forceReadOnlyFilesystem ? { forceReadOnlyFilesystem: true } : {}),
  };
}

export {
  DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS,
  MAX_FOREGROUND_BASH_TIMEOUT_SECONDS,
  DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS,
} from './local-bash-timing.js';
