import {
  POSIX_TRASH_EXECUTION,
  readPosixTrashExecution,
  rewritePosixRm,
} from './tools/rm-shell-rewrite.js';
import { snapshotPermissionEffectiveInput, snapshotPermissionInput } from './effective-input.js';
import type {
  CommandIntent,
  ExecutionPlan,
  ExecutionTransform,
  PermissionAction,
  PermissionEvaluationInput,
  PathValue,
  ShellFamily,
} from './permission-core.js';
import { resolvePermissionPath } from './path-resolver.js';
import { isNonRecursiveWindowsRm, readWindowsTrashExecution } from './windows-trash-execution.js';
import { isRmCommand, parseRmTargets, resolveRmCommandPaths } from './tools/bash-permission.js';
import { splitCommand } from './tools/bash-split.js';
import { shellTokenize, shellTokenizeWithMetadata } from './tools/shell-tokenize.js';
import { parseWindowsNativeDelete } from './tools/windows-native-delete.js';

export type { ExecutionPlan } from './permission-core.js';

const SHELL_FAMILIES = new Set<ShellFamily>(['posix', 'cmd', 'powershell', 'unknown']);
const FILESYSTEM_ACTIONS = new Set(['read', 'write', 'delete']);

export type CreatePermissionExecutionPlanInput = Pick<
  PermissionEvaluationInput,
  'toolName' | 'input'
> & {
  shell?: ShellFamily;
  context?: Pick<PermissionEvaluationInput['context'], 'workingDirectory' | 'homeDir'>;
  rewrittenInput?: Readonly<Record<string, unknown>>;
  /** Snapshot of Permission.nativeDelete at decision time. */
  nativeDelete?: boolean;
};

/** Build the complete immutable plan consumed by production permission gates. */
export function createPermissionExecutionPlan(
  input: CreatePermissionExecutionPlanInput,
): Readonly<ExecutionPlan> {
  const originalInput = snapshotPermissionInput(input.input);
  const intents =
    input.rewrittenInput && readPosixTrashExecution(input.rewrittenInput)
      ? [
          {
            kind: 'opaque' as const,
            shell: 'posix' as const,
            raw: String(originalInput.command),
            reason: 'Shell expands recoverable-delete arguments at execution time.',
          },
        ]
      : inferPermissionCommandIntents(input);
  const effectiveInput =
    snapshotPermissionEffectiveInput(originalInput, input.rewrittenInput) ?? originalInput;
  const targets = collectRecoverableDeleteTargets(intents);
  const posixTrash = readPosixTrashExecution(effectiveInput);
  const transforms: ExecutionPlan['transforms'] = posixTrash
    ? [{ type: 'recoverable-shell-delete', launcher: posixTrash.launcher }]
    : input.rewrittenInput && targets.length > 0
      ? [{ type: 'recoverable-delete', targets }]
      : [];
  return validatePermissionExecutionPlan(
    {
      originalInput,
      effectiveInput,
      intents,
      transforms,
      nativeDelete: input.nativeDelete === true,
    },
    originalInput,
  );
}

/** Shared intent inference used by the production plan builder and legacy parity adapter. */
export function inferPermissionCommandIntents(
  input: CreatePermissionExecutionPlanInput,
): CommandIntent[] {
  const shell = input.shell ?? 'unknown';
  if (input.toolName === 'bash' && typeof input.input.command === 'string') {
    const command = input.input.command;
    const segments = splitCommand(command);
    if (segments.length > 1) {
      return segments.flatMap((segment) => inferBashSegmentIntent(segment, input, shell));
    }
    return inferBashSegmentIntent(command, input, shell);
  }

  const pathCandidates = extractPathCandidates(input.input);
  if (pathCandidates.length > 0) {
    const action: PermissionAction =
      input.toolName === 'delete'
        ? 'delete'
        : ['edit', 'write', 'append'].includes(input.toolName)
          ? 'write'
          : 'read';
    return [
      {
        kind: 'filesystem',
        action,
        paths: pathCandidates.map((candidate) => toPathValue(candidate, input)),
        shell,
      },
    ];
  }

  return [
    {
      kind: 'opaque',
      shell,
      raw: JSON.stringify(input.input),
      reason: 'legacy adapter could not identify a capability',
    },
  ];
}

/**
 * Validate the plan at the execution boundary and return a detached immutable copy.
 * The returned `effectiveInput` is the only input a permission gate may install.
 */
export function validatePermissionExecutionPlan(
  value: unknown,
  expectedOriginalInput: Readonly<Record<string, unknown>>,
): Readonly<ExecutionPlan> {
  const plan = readRecord(value, 'Permission execution plan must be an object.');
  const originalInput = readRecord(
    readDataProperty(plan, 'originalInput'),
    'Permission execution plan requires originalInput.',
  );
  const effectiveInput = readRecord(
    readDataProperty(plan, 'effectiveInput'),
    'Permission execution plan requires effectiveInput.',
  );
  const intents = readDataProperty(plan, 'intents');
  const transforms = readDataProperty(plan, 'transforms');
  if (!Array.isArray(intents) || !intents.every(isCommandIntent)) {
    throw new TypeError('Permission execution plan contains invalid intents.');
  }
  if (!Array.isArray(transforms) || !transforms.every(isExecutionTransform)) {
    throw new TypeError('Permission execution plan contains an invalid transform.');
  }

  const expectedSnapshot = snapshotPermissionInput(expectedOriginalInput);
  const originalSnapshot = snapshotPermissionInput(originalInput);
  const effectiveSnapshot = snapshotPermissionInput(effectiveInput);
  if (!permissionValuesEqual(originalSnapshot, expectedSnapshot)) {
    throw new TypeError('Permission execution plan original input does not match the tool call.');
  }
  if (!hasEveryInputField(effectiveSnapshot, originalSnapshot)) {
    throw new TypeError('Permission execution plan effective input must be complete.');
  }

  validateTransformConsistency(originalSnapshot, effectiveSnapshot, intents, transforms);
  const metadata = snapshotPermissionInput({ intents, transforms });
  const nativeDelete = readDataProperty(plan, 'nativeDelete');
  return Object.freeze({
    originalInput: originalSnapshot as Record<string, unknown>,
    effectiveInput: effectiveSnapshot as Record<string, unknown>,
    intents: metadata.intents as CommandIntent[],
    transforms: metadata.transforms as ExecutionTransform[],
    ...(nativeDelete === undefined ? {} : { nativeDelete: nativeDelete === true }),
  });
}

function inferBashSegmentIntent(
  command: string,
  input: CreatePermissionExecutionPlanInput,
  shell: ShellFamily,
): CommandIntent[] {
  const effectiveShell = shell === 'unknown' ? 'posix' : shell;
  const nativeDelete =
    effectiveShell === 'cmd' || effectiveShell === 'powershell'
      ? parseWindowsNativeDelete(command, effectiveShell)
      : undefined;
  const rmPaths = isRmCommand(command)
    ? resolveRmCommandPaths(command, input.context, effectiveShell)
    : undefined;
  if (nativeDelete && nativeDelete.shell === effectiveShell) {
    return [
      {
        kind: 'filesystem',
        action: 'delete',
        // A PowerShell rm alias can also produce the recoverable rm rewrite.
        // Its marker follows the rm parser's literal quoting contract.
        paths:
          rmPaths && readWindowsTrashExecution(input.rewrittenInput)
            ? rmPaths
            : nativeDelete.targets.map((raw) => toPathValue(raw, input)),
        ...(nativeDelete.recursive ? { recursive: true } : {}),
        ...(nativeDelete.force ? { force: true } : {}),
        shell: effectiveShell,
      },
    ];
  }
  if (rmPaths) {
    return [
      {
        kind: 'filesystem',
        action: 'delete',
        paths: rmPaths,
        shell: effectiveShell,
      },
    ];
  }
  const tokens = shellTokenize(command);
  const scriptIntent = inferScriptIntent(tokens, input, effectiveShell);
  if (scriptIntent) return [scriptIntent];
  const networkIntent = inferNetworkIntent(tokens, effectiveShell);
  if (networkIntent) return [networkIntent];

  return [
    { kind: 'execute', argv: [command], shell: effectiveShell, dynamic: /[$`*;]/.test(command) },
  ];
}

const SCRIPT_INTERPRETERS = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'ksh',
  'dash',
  'node',
  'deno',
  'python',
  'python3',
  'ruby',
]);

function inferScriptIntent(
  tokens: string[],
  input: CreatePermissionExecutionPlanInput,
  shell: ShellFamily,
): CommandIntent | undefined {
  const interpreter = tokens[0]?.split('/').at(-1);
  if (!interpreter || !SCRIPT_INTERPRETERS.has(interpreter)) return undefined;
  if (interpreter === 'deno' && tokens[1] !== 'run') return undefined;
  const operand = interpreter === 'deno' ? tokens[2] : tokens[1];
  if (
    !operand ||
    operand.startsWith('-') ||
    operand.includes('$') ||
    operand.includes('`') ||
    /[*?[\]]/.test(operand)
  ) {
    return undefined;
  }
  return {
    kind: 'script',
    interpreter,
    path: toPathValue(operand, input),
    shell,
    dynamic: false,
  };
}

function inferNetworkIntent(tokens: string[], shell: ShellFamily): CommandIntent | undefined {
  const program = tokens[0]?.split('/').at(-1);
  if (program !== 'curl' && program !== 'wget') return undefined;
  const targets = tokens.filter((token) => /^https?:\/\/[^$`*?[\]]+$/.test(token));
  if (targets.length === 0) return undefined;
  return {
    kind: 'network',
    targets,
    method: program === 'wget' ? 'GET' : undefined,
    shell,
    dynamic: false,
  };
}

function collectRecoverableDeleteTargets(intents: readonly CommandIntent[]): string[] {
  return intents.flatMap((intent) =>
    intent.kind === 'filesystem' && intent.action === 'delete'
      ? intent.paths.map((pathValue) => pathValue.resolved ?? pathValue.raw)
      : [],
  );
}

function toPathValue(raw: string, input: CreatePermissionExecutionPlanInput): PathValue {
  return resolvePermissionPath(raw, input.context, input.shell ?? 'unknown');
}

function extractPathCandidates(input: Record<string, unknown>): string[] {
  for (const key of ['filePath', 'file_path', 'path', 'pattern', 'paths']) {
    const value = input[key];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) {
      return value;
    }
  }
  return [];
}

function validateTransformConsistency(
  originalInput: Readonly<Record<string, unknown>>,
  effectiveInput: Readonly<Record<string, unknown>>,
  intents: readonly CommandIntent[],
  transforms: readonly ExecutionTransform[],
): void {
  const shellTransform = transforms.find((item) => item.type === 'recoverable-shell-delete');
  if (shellTransform?.type === 'recoverable-shell-delete') {
    const marker = readPosixTrashExecution(effectiveInput);
    const originalCommand = originalInput.command;
    const expected =
      typeof originalCommand === 'string'
        ? rewritePosixRm(originalCommand, shellTransform.launcher)
        : undefined;
    if (
      transforms.length !== 1 ||
      !shellTransform.launcher.endsWith('/mavis-trash') ||
      !marker ||
      marker.launcher !== shellTransform.launcher ||
      !expected ||
      expected.dynamic !== marker.dynamic ||
      expected.command !== effectiveInput.command ||
      intents.some((intent) => intent.shell !== 'posix')
    ) {
      throw new TypeError(
        'Recoverable shell delete must preserve the original shell arguments and sequence.',
      );
    }
    const originalFields = { ...originalInput, command: expected.command };
    const effectiveFields = { ...effectiveInput };
    Reflect.deleteProperty(effectiveFields, POSIX_TRASH_EXECUTION);
    if (!permissionValuesEqual(originalFields, effectiveFields)) {
      throw new TypeError('Recoverable shell delete must preserve other tool arguments.');
    }
    return;
  }
  const changed = !permissionValuesEqual(originalInput, effectiveInput);
  const deleteIntents = intents.filter(
    (intent): intent is Extract<CommandIntent, { kind: 'filesystem' }> =>
      intent.kind === 'filesystem' && intent.action === 'delete',
  );
  if (changed && transforms.length === 0) {
    throw new TypeError('Permission execution plan changed input without a declared transform.');
  }
  if (transforms.length === 0) return;

  const recoverableTargets = transforms.flatMap((transform) =>
    transform.type === 'recoverable-delete' ? transform.targets : [],
  );
  const executedTargets = readRecoverableDeleteTargets(effectiveInput);
  if (!executedTargets) {
    throw new TypeError('Recoverable-delete execution plan must execute mavis-trash.');
  }
  if (!changed) {
    throw new TypeError('Permission execution plan declares a transform for unchanged input.');
  }

  const intentTargets = deleteIntents.flatMap((intent) =>
    intent.paths.map((pathValue) => pathValue.resolved ?? pathValue.raw),
  );
  if (!sameStringSet(recoverableTargets, intentTargets)) {
    throw new TypeError('Recoverable-delete transform targets do not match delete intents.');
  }

  const windowsTrash = readWindowsTrashExecution(effectiveInput);
  if (windowsTrash) {
    if (
      !sameStringSet(windowsTrash.targets, recoverableTargets) ||
      (windowsTrash.allowOutsideWorkspaceFiles === true &&
        (typeof originalInput.command !== 'string' ||
          !isNonRecursiveWindowsRm(originalInput.command)))
    ) {
      throw new TypeError(
        'Windows recoverable-delete plan requires the targets-only trash marker.',
      );
    }
    return;
  }
  const usesWindowsShell = deleteIntents.some(
    (intent) => intent.shell === 'cmd' || intent.shell === 'powershell',
  );
  if (usesWindowsShell) {
    throw new TypeError('Windows recoverable-delete plan requires the targets-only trash marker.');
  }
  if (!targetsMatchIntentPaths(executedTargets, deleteIntents)) {
    throw new TypeError('Recoverable-delete effective input targets do not match delete intents.');
  }
}

function readRecoverableDeleteTargets(
  input: Readonly<Record<string, unknown>>,
): string[] | undefined {
  const command = readDataProperty(input, 'command');
  if (typeof command !== 'string') return undefined;
  const targets = splitCommand(command).flatMap((segment) => {
    const tokens = shellTokenize(segment);
    const executable = readExecutableBasename(segment, tokens[0]);
    if (executable !== 'mavis-trash' && executable !== 'mavis-trash.cmd') return [];
    const executableToken = shellTokenizeWithMetadata(segment)[0];
    return executableToken ? parseRmTargets(`rm ${segment.slice(executableToken.end)}`) : [];
  });
  return targets.length > 0 || readWindowsTrashExecution(input) ? targets : undefined;
}

function readExecutableBasename(segment: string, tokenizedExecutable: string | undefined): string {
  const trimmed = segment.trimStart();
  const quote = trimmed[0];
  const rawExecutable =
    quote === "'" || quote === '"'
      ? trimmed.slice(1, trimmed.indexOf(quote, 1) === -1 ? undefined : trimmed.indexOf(quote, 1))
      : trimmed.match(/^\S+/)?.[0];
  return (rawExecutable ?? tokenizedExecutable ?? '').split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
}

function targetsMatchIntentPaths(
  executedTargets: readonly string[],
  deleteIntents: readonly Extract<CommandIntent, { kind: 'filesystem' }>[],
): boolean {
  const paths = deleteIntents.flatMap((intent) => intent.paths);
  return (
    executedTargets.length === paths.length &&
    executedTargets.every((target) =>
      paths.some((pathValue) => target === pathValue.raw || target === pathValue.resolved),
    ) &&
    paths.every((pathValue) =>
      executedTargets.some((target) => target === pathValue.raw || target === pathValue.resolved),
    )
  );
}

function hasEveryInputField(
  effectiveInput: Readonly<Record<string, unknown>>,
  originalInput: Readonly<Record<string, unknown>>,
): boolean {
  return enumerableDataKeys(originalInput).every((key) =>
    Object.prototype.hasOwnProperty.call(effectiveInput, key),
  );
}

function isExecutionTransform(value: unknown): value is ExecutionTransform {
  if (!isRecord(value)) return false;
  if (readDataProperty(value, 'type') === 'recoverable-shell-delete')
    return isNonBlankString(readDataProperty(value, 'launcher'));
  if (readDataProperty(value, 'type') !== 'recoverable-delete') return false;
  const targets = readDataProperty(value, 'targets');
  return Array.isArray(targets) && targets.length > 0 && targets.every(isNonBlankString);
}

function isCommandIntent(value: unknown): value is CommandIntent {
  if (!isRecord(value)) return false;
  const kind = readDataProperty(value, 'kind');
  const shell = readDataProperty(value, 'shell');
  if (!isShellFamily(shell)) return false;
  if (kind === 'filesystem') return isFilesystemIntent(value);
  if (kind === 'execute') {
    return isStringArray(readDataProperty(value, 'argv')) && isBoolean(value, 'dynamic');
  }
  if (kind === 'network') {
    return isStringArray(readDataProperty(value, 'targets')) && isBoolean(value, 'dynamic');
  }
  if (kind === 'script') return isBoolean(value, 'dynamic') && isOptionalPathValue(value, 'path');
  return kind === 'opaque' && isNonBlankString(readDataProperty(value, 'reason'));
}

function isFilesystemIntent(
  value: Record<PropertyKey, unknown>,
): value is Extract<CommandIntent, { kind: 'filesystem' }> {
  const action = readDataProperty(value, 'action');
  const paths = readDataProperty(value, 'paths');
  return (
    typeof action === 'string' &&
    FILESYSTEM_ACTIONS.has(action) &&
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.every(isPathValue)
  );
}

function isPathValue(value: unknown): value is PathValue {
  if (!isRecord(value)) return false;
  const raw = readDataProperty(value, 'raw');
  const dynamic = readDataProperty(value, 'dynamic');
  const resolved = readDataProperty(value, 'resolved');
  return (
    typeof raw === 'string' &&
    typeof dynamic === 'boolean' &&
    (resolved === undefined || typeof resolved === 'string')
  );
}

function isOptionalPathValue(value: Record<PropertyKey, unknown>, key: PropertyKey): boolean {
  const pathValue = readDataProperty(value, key);
  return pathValue === undefined || isPathValue(pathValue);
}

function isBoolean(value: Record<PropertyKey, unknown>, key: PropertyKey): boolean {
  return typeof readDataProperty(value, key) === 'boolean';
}

function isShellFamily(value: unknown): value is ShellFamily {
  return typeof value === 'string' && SHELL_FAMILIES.has(value as ShellFamily);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function permissionValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => permissionValuesEqual(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = enumerableDataKeys(left);
  const rightKeys = enumerableDataKeys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        rightKeys.includes(key) &&
        permissionValuesEqual(readDataProperty(left, key), readDataProperty(right, key)),
    )
  );
}

function enumerableDataKeys(value: object): PropertyKey[] {
  return Reflect.ownKeys(value).filter((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) return false;
    if (!('value' in descriptor)) {
      throw new TypeError('Permission execution plan must not contain accessors.');
    }
    return true;
  });
}

function readDataProperty(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) {
    throw new TypeError('Permission execution plan must not contain accessors.');
  }
  return descriptor.value;
}

function readRecord(value: unknown, message: string): Record<PropertyKey, unknown> {
  if (!isRecord(value)) throw new TypeError(message);
  return value;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
