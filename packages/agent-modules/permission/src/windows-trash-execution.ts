/**
 * Recoverable Windows delete metadata carried in-process from the permission
 * checker to the local Bash implementation. Literal targets and verified
 * non-recursive scope cross this seam; the runtime owns the launcher and environment.
 */
import { parseScriptPlainCommands } from './tools/bash-ast.js';
import { shellTokenizeWithMetadata } from './tools/shell-tokenize.js';

const WINDOWS_TRASH_EXECUTION = Symbol.for('@mavis/permission/windows-trash-execution');

export interface WindowsTrashExecution {
  readonly targets: readonly string[];
  /** A proven non-recursive rm may recycle files outside the workspace after approval. */
  readonly allowOutsideWorkspaceFiles?: true;
}

/** Keep unknown flags and compound commands on the workspace-only boundary. */
export function isNonRecursiveWindowsRm(command: string): boolean {
  const commands = parseScriptPlainCommands(command);
  const argv = commands?.length === 1 ? commands[0] : undefined;
  if (!argv || argv[0] !== 'rm' || argv.length < 2) return false;
  let pastDoubleDash = false;
  let hasTarget = false;
  for (const { value: arg, quoted } of shellTokenizeWithMetadata(command).slice(1)) {
    if (!pastDoubleDash && arg === '--') {
      // PowerShell can treat a quoted terminator as a literal target, leaving
      // later -Recurse flags active. Do not infer broader scope in that case.
      if (quoted) return false;
      pastDoubleDash = true;
    } else if (!pastDoubleDash && arg.startsWith('-')) {
      if (
        arg.toLowerCase() !== '-force' &&
        !/^(?:-[fiIv]+|--(?:force|verbose|interactive(?:=(?:never|once|always))?))$/.test(arg)
      ) {
        return false;
      }
    } else {
      hasTarget = true;
    }
  }
  return hasTarget;
}

type WindowsTrashExecutionCarrier = {
  [WINDOWS_TRASH_EXECUTION]?: WindowsTrashExecution;
};

export function withWindowsTrashExecution<T extends Record<string, unknown>>(
  input: T,
  targets: readonly string[],
  options: Pick<WindowsTrashExecution, 'allowOutsideWorkspaceFiles'> = {},
): T {
  if (targets.length === 0 || !targets.every((target) => typeof target === 'string' && target)) {
    throw new TypeError('Windows trash execution requires at least one literal target.');
  }
  const effectiveInput = { ...input } as T & WindowsTrashExecutionCarrier;
  Object.defineProperty(effectiveInput, WINDOWS_TRASH_EXECUTION, {
    value: Object.freeze({
      targets: Object.freeze([...targets]),
      ...(options.allowOutsideWorkspaceFiles === true ? { allowOutsideWorkspaceFiles: true } : {}),
    }),
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return effectiveInput;
}

export function readWindowsTrashExecution(input: unknown): WindowsTrashExecution | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = (input as WindowsTrashExecutionCarrier)[WINDOWS_TRASH_EXECUTION];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (
    !Array.isArray(value.targets) ||
    value.targets.length === 0 ||
    !value.targets.every((target) => typeof target === 'string' && target) ||
    (value.allowOutsideWorkspaceFiles !== undefined && value.allowOutsideWorkspaceFiles !== true)
  ) {
    return undefined;
  }
  return value;
}
