import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  sanitizeBashSubprocessEnv,
  type BashEnvPolicySource,
} from '@mavis/agent-core/bash-subprocess-env';
import type { ToolResult } from '@mavis/agent-core/tools';

import { LocalBashToolDef, type LocalBashToolInput } from './builtin-defs.js';

export interface LocalHostTrashExecution {
  readonly targets: readonly string[];
  readonly allowOutsideWorkspaceFiles?: true;
}

export interface LocalHostTrashDiagnostic {
  readonly status: 'windows_trash_failed' | 'host_trash_failed' | 'timed_out';
  readonly target_count: number;
  readonly runtime_kind: 'electron' | 'node';
  readonly runtime_executable_basename: string;
  readonly script_basename?: string;
  readonly error_code?: string;
  readonly exit_code?: number;
  readonly signal?: string;
  readonly killed?: boolean;
}

export interface LocalHostTrashRuntime {
  readonly platform: NodeJS.Platform;
  readonly scriptPath?: string;
  readonly readExecution: (input: unknown) => LocalHostTrashExecution | undefined;
  readonly reportDiagnostic?: (diagnostic: LocalHostTrashDiagnostic) => void;
}

type TrashExecutionKind = 'windows-trash' | 'host-trash';

type TrashLaunch = {
  readonly launcher: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly execution: TrashExecutionKind;
  readonly failureStatus: 'windows_trash_failed' | 'host_trash_failed';
};

export async function executeLocalHostTrashIfRequested(input: {
  readonly toolInput: LocalBashToolInput;
  readonly workspaceRoot: string;
  readonly runtime?: LocalHostTrashRuntime;
  readonly envPolicy: BashEnvPolicySource;
  readonly timeoutSeconds: number;
  readonly signal?: AbortSignal;
}): Promise<ToolResult | undefined> {
  const runtime = input.runtime;
  const execution = runtime?.readExecution(input.toolInput);
  if (!execution) {
    // `mavis-trash --` is an internal sentinel. Never pass it to an ordinary
    // shell when the host cannot recover its literal target metadata.
    if (input.toolInput.command !== 'mavis-trash --') return undefined;
    return unavailableTrashError(runtime?.platform);
  }
  if (!runtime) return unavailableTrashError(undefined);

  // POSIX recoverable deletion runs INSIDE the sandbox through the `rm` shim,
  // so the host never executes mavis-trash there. Only Windows — which has no
  // sandbox and no PATH-based shim (`rm` is a PowerShell alias) — needs a
  // host-side launcher.
  if (runtime.platform !== 'win32') return unavailableTrashError(runtime.platform);

  const sanitized = sanitizeBashSubprocessEnv(process.env, input.envPolicy);

  if (!isAvailableWindowsTrashRuntime(runtime)) {
    return windowsTrashError('windows_trash_unavailable', 'Windows trash runtime is unavailable.');
  }
  if (input.toolInput.command !== 'mavis-trash --' || input.toolInput.run_in_background === true) {
    return windowsTrashError(
      'windows_trash_input_rejected',
      'Windows trash execution rejected an invalid effective input.',
    );
  }
  const allowedTargets = await Promise.all(
    execution.targets.map((target) =>
      isWindowsTrashTargetAllowed(
        target,
        input.workspaceRoot,
        execution.allowOutsideWorkspaceFiles === true,
      ),
    ),
  );
  if (!allowedTargets.every(Boolean)) {
    return windowsTrashError(
      'windows_trash_target_rejected',
      'Windows trash execution rejected a target outside the workspace.',
    );
  }
  const launch: TrashLaunch = {
    launcher: process.execPath,
    argv: [runtime.scriptPath, '--', ...execution.targets],
    env: { ...sanitized.env, ELECTRON_RUN_AS_NODE: '1' },
    execution: 'windows-trash',
    failureStatus: 'windows_trash_failed',
  };

  try {
    const { stdout, stderr } = await execFileLiteral(launch.launcher, launch.argv, {
      cwd: input.workspaceRoot,
      env: launch.env,
      timeoutMs: input.timeoutSeconds * 1000,
      signal: input.signal,
    });
    const text = joinProcessOutput(stdout, stderr);
    return {
      tool_name: LocalBashToolDef.name,
      text,
      content: [{ type: 'text', text }],
      details: { status: 'exited', execution: launch.execution },
    };
  } catch (error) {
    if (input.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw error;
    }
    const failure = error as ProcessFailure;
    const captured = joinProcessOutput(failure.stdout, failure.stderr);
    const timedOut = failure.killed === true && input.timeoutSeconds > 0;
    const status = timedOut ? 'timed_out' : launch.failureStatus;
    reportWindowsTrashDiagnostic(input.runtime, {
      status,
      target_count: execution.targets.length,
      ...runtimeDiagnosticFields(input.runtime),
      ...(typeof failure.code === 'number' ? { exit_code: failure.code } : {}),
      ...(typeof failure.code === 'string' ? { error_code: failure.code } : {}),
      ...(typeof failure.signal === 'string' ? { signal: failure.signal } : {}),
      ...(typeof failure.killed === 'boolean' ? { killed: failure.killed } : {}),
    });
    const text =
      captured ||
      (timedOut
        ? `Command timed out after ${input.timeoutSeconds} seconds`
        : error instanceof Error
          ? error.message
          : String(error));
    return {
      tool_name: LocalBashToolDef.name,
      text,
      content: [{ type: 'text', text }],
      details: {
        status,
        execution: launch.execution,
        ...(typeof failure.code === 'number' ? { exitCode: failure.code } : {}),
      },
      isError: true,
    };
  }
}

function isAvailableWindowsTrashRuntime(
  runtime: LocalHostTrashRuntime,
): runtime is LocalHostTrashRuntime & { readonly scriptPath: string } {
  return (
    typeof runtime.scriptPath === 'string' &&
    path.isAbsolute(runtime.scriptPath) &&
    path.basename(runtime.scriptPath).toLowerCase() === 'mavis-trash.js'
  );
}

async function isWindowsTrashTargetAllowed(
  target: string,
  workspaceRoot: string,
  allowOutsideWorkspaceFiles: boolean,
): Promise<boolean> {
  const workspace = path.win32.resolve(workspaceRoot);
  const resolved = path.win32.resolve(workspaceRoot, target);
  if (isProtectedWindowsTrashPath(resolved)) return false;
  const relative = path.win32.relative(workspace, resolved);
  if (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.win32.sep}`) &&
      !path.win32.isAbsolute(relative))
  )
    return true;
  // The plan proves non-recursive rm syntax; the host separately proves the
  // external operand is a file. Directories, links and unavailable metadata
  // retain the workspace boundary, even with the trusted opt-in.
  if (!allowOutsideWorkspaceFiles || !/^[a-z]:[\\/]/i.test(target)) return false;
  try {
    // Resolve short names and parent-directory aliases before applying the
    // same protected-path boundary. Keep the approved argv unchanged.
    if (isProtectedWindowsTrashPath(await realpath(target))) return false;
    return (await lstat(target)).isFile();
  } catch {
    return false;
  }
}

function isProtectedWindowsTrashPath(target: string): boolean {
  const canonical = path.win32.normalize(target).replace(/^\\\\\?\\(?=[a-z]:\\)/i, '');
  return (
    canonical.startsWith('\\\\') ||
    /^[a-z]:\\$|^[a-z]:\\(?:windows|program files(?: \(x86\))?)(?:\\|$)/i.test(canonical)
  );
}

function unavailableTrashError(platform: NodeJS.Platform | undefined): ToolResult {
  if (platform === 'win32') {
    return windowsTrashError('windows_trash_unavailable', 'Windows trash runtime is unavailable.');
  }
  return hostTrashError(
    'host_trash_unavailable',
    platform === undefined
      ? 'Host trash runtime is unavailable.'
      : `Host trash runtime is unavailable on platform ${platform}.`,
  );
}

function windowsTrashError(status: string, text: string): ToolResult {
  return trashError(status, text, 'windows-trash');
}

function hostTrashError(status: string, text: string): ToolResult {
  return trashError(status, text, 'host-trash');
}

function trashError(status: string, text: string, execution: TrashExecutionKind): ToolResult {
  return {
    tool_name: LocalBashToolDef.name,
    text,
    content: [{ type: 'text', text }],
    details: { status, execution },
    isError: true,
  };
}

type ProcessFailure = Error & {
  code?: number | string;
  killed?: boolean;
  signal?: string;
  stdout?: string;
  stderr?: string;
};

function runtimeDiagnosticFields(
  runtime: LocalHostTrashRuntime | undefined,
): Pick<
  LocalHostTrashDiagnostic,
  'runtime_kind' | 'runtime_executable_basename' | 'script_basename'
> {
  return {
    runtime_kind: process.versions.electron ? 'electron' : 'node',
    runtime_executable_basename: path.win32.basename(process.execPath),
    ...(runtime?.scriptPath ? { script_basename: path.win32.basename(runtime.scriptPath) } : {}),
  };
}

function reportWindowsTrashDiagnostic(
  runtime: LocalHostTrashRuntime | undefined,
  diagnostic: LocalHostTrashDiagnostic,
): void {
  try {
    runtime?.reportDiagnostic?.(diagnostic);
  } catch {
    // Diagnostics must never change deletion safety or the tool result.
  }
}

function execFileLiteral(
  launcher: string,
  argv: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      launcher,
      [...argv],
      {
        cwd: options.cwd,
        env: options.env,
        encoding: 'utf8',
        timeout: options.timeoutMs,
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function joinProcessOutput(stdout?: string, stderr?: string): string {
  return [stdout, stderr]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n')
    .trimEnd();
}
