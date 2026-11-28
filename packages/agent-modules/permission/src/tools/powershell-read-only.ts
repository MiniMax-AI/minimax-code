/**
 * PowerShell read-only fast-allow for the Windows desktop `bash` tool.
 *
 * Accepts only shapes seen in feedback replays that can be proven read-only:
 *   - one known read-only cmdlet or native read-only CLI
 *     ({@link isKnownSafePowerShellCommand});
 *   - that source piped into Select-String;
 *   - a literal `[System.IO.File]::ReadAllText('<path>')` call.
 * Every operand is treated as a read path and must pass the read path
 * capability, so sensitive files keep asking exactly like `cat` does.
 * Provider-qualified paths (Env:, HKLM:, Cert:, …), UNC paths, splatting and
 * `Get-Help -Online` fail closed. Script-block cmdlets (Where-Object,
 * ForEach-Object) and writers (Out-File, Set-Content, Tee-Object) are absent.
 */

import type { ToolPermissionContext } from '../context.js';
import { resolvePermissionPath } from '../path-resolver.js';
import { evaluatePathCapability } from './path-capability.js';
import { isKnownSafePowerShellCommand, tokenizeSimplePowerShell } from './safe-command.js';

/** Pipeline consumers seen in replays; each only filters its input. */
const PIPELINE_TAIL_COMMANDS: ReadonlySet<string> = new Set(['select-string']);

/** Commands whose glob operands may select file contents, not just names. */
const CONTENT_READERS: ReadonlySet<string> = new Set([
  'get-content',
  'select-string',
  'git',
  'git.exe',
  'rg',
  'rg.exe',
]);

/** Named parameters whose value is data rather than a path. */
const NON_PATH_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-pattern',
  '-encoding',
  '-tail',
  '-totalcount',
  '-head',
  '-first',
  '-last',
  '-depth',
  '-context',
]);

const PROVIDER_QUALIFIED = /^[A-Za-z][A-Za-z0-9_]+:/;
const WILDCARD = /[*?[\]]/;
const DOTNET_READ_ALL_TEXT =
  /^[ \t]*\[(?:System\.)?IO\.File\]::ReadAllText\([ \t]*(?:'([^']+)'|"([^"$`]+)")[ \t]*\)[ \t]*$/i;

/**
 * True when `command` is a provably read-only PowerShell command whose
 * every read operand is allowed by the read path capability.
 */
export function powerShellReadsAreAllowed(
  command: string,
  context: ToolPermissionContext,
  originToolName: string,
): boolean {
  const operands = powerShellReadOnlyOperands(command);
  if (!operands) return false;
  return operands.every((operand) => readIsAllowed(operand, context, originToolName));
}

function readIsAllowed(
  operand: string,
  context: ToolPermissionContext,
  originToolName: string,
): boolean {
  const raw = operand.startsWith('~\\') ? `~/${operand.slice(2)}` : operand;
  const resolved = resolvePermissionPath(raw, context, 'powershell');
  if (resolved.dynamic || !resolved.resolved) return false;
  const decision = evaluatePathCapability(resolved.resolved, 'read', context, {
    toolName: 'read',
    originToolName,
  });
  return decision.behavior === 'allow';
}

function powerShellReadOnlyOperands(command: string): string[] | undefined {
  const segments = splitPowerShellPipeline(command);
  if (!segments) return undefined;
  const operands: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const found = segmentOperands(segment, index === 0);
    if (!found) return undefined;
    operands.push(...found);
  }
  return operands;
}

/** Quote-aware split on `|`; empty segments (`||`, trailing pipe) fail closed. */
function splitPowerShellPipeline(command: string): string[] | undefined {
  const segments: string[] = [];
  let start = 0;
  let quote: string | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command.charAt(index);
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === '|') {
      segments.push(command.slice(start, index));
      start = index + 1;
    }
  }
  if (quote) return undefined;
  segments.push(command.slice(start));
  return segments.every((segment) => segment.trim().length > 0) ? segments : undefined;
}

function segmentOperands(segment: string, isSource: boolean): string[] | undefined {
  if (isSource) {
    const dotNetPath = dotNetReadAllTextPath(segment);
    if (dotNetPath !== undefined) return [dotNetPath];
  }
  const tokens = tokenizeSimplePowerShell(segment);
  const first = tokens?.[0];
  if (!tokens || first === undefined) return undefined;
  const name = first.toLowerCase();
  const allowed = isSource
    ? isKnownSafePowerShellCommand(segment)
    : PIPELINE_TAIL_COMMANDS.has(name);
  return allowed ? commandOperands(name, tokens.slice(1)) : undefined;
}

function dotNetReadAllTextPath(segment: string): string | undefined {
  const match = DOTNET_READ_ALL_TEXT.exec(segment);
  const literal = match?.[1] ?? match?.[2];
  return literal === undefined ? undefined : pathOperand('get-content', literal);
}

function commandOperands(name: string, args: readonly string[]): string[] | undefined {
  const operands: string[] = [];
  let skipValue = false;
  for (const arg of args) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    const lower = arg.toLowerCase();
    if (lower === '-online') return undefined;
    const isOption = lower.startsWith('-');
    if (isOption && !lower.includes(':')) {
      skipValue = NON_PATH_VALUE_OPTIONS.has(lower);
      continue;
    }
    const operand = pathOperand(name, isOption ? arg.slice(arg.indexOf(':') + 1) : arg);
    if (operand === undefined) return undefined;
    operands.push(operand);
  }
  return operands;
}

/** Normalise one operand to the literal path whose read must be allowed. */
function pathOperand(name: string, value: string): string | undefined {
  if (!value || value.startsWith('@')) return undefined;
  if (PROVIDER_QUALIFIED.test(value)) return undefined;
  if (value.startsWith('\\\\') || value.startsWith('//')) return undefined;
  if (!WILDCARD.test(value)) return value;
  return CONTENT_READERS.has(name) ? undefined : wildcardParent(value);
}

/** Listing a wildcard only reveals names under its literal parent directory. */
function wildcardParent(value: string): string {
  const prefix = value.slice(0, value.search(WILDCARD));
  const cut = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
  return cut < 0 ? '.' : prefix.slice(0, cut + 1);
}
