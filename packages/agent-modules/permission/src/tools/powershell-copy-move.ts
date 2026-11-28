/**
 * PowerShell Copy-Item / Move-Item fast-allow for the Windows desktop `bash`
 * tool — the counterpart of the POSIX `cp` / `mv` write-target gate.
 *
 * Accepts one simple command whose every operand is a static literal:
 *   - each source must pass the read path capability (Move-Item sources also
 *     the delete capability), so sensitive files keep asking like `cp` does;
 *   - the destination must pass the write path capability, which already
 *     covers the working directory, the Turn's additional Project folders,
 *     real-location checks and protected names.
 * A copied or moved item keeps its name under an existing destination folder,
 * so `<destination>\<source name>` must pass the write capability too.
 * Variables, pipelines, comma arrays, wildcards, provider-qualified and UNC
 * paths, drive-relative paths, path segments Win32 would trim, comments,
 * remote sessions, credentials and any unlisted parameter fail closed.
 */

import type { ToolPermissionContext } from '../context.js';
import { resolvePermissionPath } from '../path-resolver.js';
import { evaluatePathCapability, type PathCapabilityAction } from './path-capability.js';
import { tokenizeSimplePowerShell } from './safe-command.js';

const COPY_COMMANDS: ReadonlySet<string> = new Set(['copy-item', 'cpi', 'copy']);
const MOVE_COMMANDS: ReadonlySet<string> = new Set(['move-item', 'mi', 'move']);

/** Switches that change neither the operands nor where data lands. */
const SWITCHES: ReadonlySet<string> = new Set([
  '-recurse',
  '-force',
  '-container',
  '-passthru',
  '-whatif',
  '-confirm',
  '-verbose',
  '-debug',
]);

/**
 * Values that are never paths: filters only narrow the selected source items,
 * and common parameters set preferences or name variables to fill.
 */
const FILTER_OPTIONS: ReadonlySet<string> = new Set([
  '-filter',
  '-include',
  '-exclude',
  '-erroraction',
  '-ea',
  '-warningaction',
  '-wa',
  '-informationaction',
  '-infa',
  '-errorvariable',
  '-ev',
  '-warningvariable',
  '-wv',
  '-informationvariable',
  '-iv',
  '-outvariable',
  '-ov',
]);

const PROVIDER_QUALIFIED = /^[A-Za-z][A-Za-z0-9_]+:/;
const WILDCARD = /[*?[\]]/;

type CopyMoveOperands = {
  readonly sources: readonly string[];
  readonly destination: string;
  readonly move: boolean;
};

/**
 * True when `command` is a statically resolved Copy-Item / Move-Item whose
 * sources and destination all pass the path capability.
 */
export function powerShellCopyMoveIsAllowed(
  command: string,
  context: ToolPermissionContext,
  originToolName: string,
): boolean {
  const operands = readCopyMoveOperands(command);
  if (!operands) return false;
  return (
    operands.sources.every((source) => {
      const name = lastSegment(source);
      return (
        capabilityAllows(source, 'read', context, originToolName) &&
        (!operands.move || capabilityAllows(source, 'delete', context, originToolName)) &&
        (name === undefined ||
          capabilityAllows(`${operands.destination}\\${name}`, 'write', context, originToolName))
      );
    }) && capabilityAllows(operands.destination, 'write', context, originToolName)
  );
}

/** The item name a copy keeps; `.` / `..` name no new item. */
function lastSegment(value: string): string | undefined {
  const name = value.split(/[\\/]/).filter(Boolean).pop();
  return name === undefined || name === '.' || name === '..' || /^[A-Za-z]:$/.test(name)
    ? undefined
    : name;
}

function capabilityAllows(
  operand: string,
  action: PathCapabilityAction,
  context: ToolPermissionContext,
  originToolName: string,
): boolean {
  const raw = operand.startsWith('~\\') ? `~/${operand.slice(2)}` : operand;
  const resolved = resolvePermissionPath(raw, context, 'powershell');
  if (resolved.dynamic || !resolved.resolved) return false;
  // Same namespaces and temp fallback as the bash path-intent loop.
  const decision = evaluatePathCapability(resolved.resolved, action, context, {
    toolName: action === 'read' ? 'read' : 'write',
    allowTempWrite: action !== 'read',
    originToolName,
  });
  return decision.behavior === 'allow';
}

function readCopyMoveOperands(command: string): CopyMoveOperands | undefined {
  const tokens = tokenizeSimplePowerShell(command);
  const name = tokens?.[0]?.toLowerCase();
  if (!tokens || !name) return undefined;
  const move = MOVE_COMMANDS.has(name);
  if (!move && !COPY_COMMANDS.has(name)) return undefined;

  const namedSources: string[] = [];
  const positional: string[] = [];
  let destination: string | undefined;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    // A `#` token starts a comment; PowerShell would drop the rest.
    if (token.startsWith('#')) return undefined;
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    const colon = token.indexOf(':');
    const option = (colon < 0 ? token : token.slice(0, colon)).toLowerCase();
    const attached = colon < 0 ? undefined : token.slice(colon + 1);
    const kind = optionKind(option);
    if (!kind) return undefined;
    if (kind === 'switch') {
      if (attached !== undefined) return undefined;
      continue;
    }
    const value = attached ?? tokens[++index];
    // PowerShell reads a following `-name` as the next parameter, not a value.
    if (value === undefined || value === '' || value.startsWith('-')) return undefined;
    if (kind === 'filter') continue;
    if (kind === 'source') namedSources.push(value);
    else if (destination !== undefined) return undefined;
    else destination = value;
  }

  // Path binds at position 0 and Destination at position 1; a named
  // parameter frees its position for the next one.
  const sources = namedSources.length > 0 ? namedSources : positional.splice(0, 1);
  destination ??= positional.shift();
  if (positional.length > 0 || sources.length === 0 || destination === undefined) return undefined;
  if (![...sources, destination].every(isStaticLiteralPath)) return undefined;
  return { sources, destination, move };
}

function optionKind(option: string): 'switch' | 'filter' | 'source' | 'destination' | undefined {
  if (SWITCHES.has(option)) return 'switch';
  // Copy-Item has no other parameter starting with `r`; Move-Item rejects it.
  if (option.length >= 2 && '-recurse'.startsWith(option)) return 'switch';
  if (FILTER_OPTIONS.has(option)) return 'filter';
  if (option === '-path' || option === '-pspath' || option === '-lp') return 'source';
  if (option.length >= 4 && '-literalpath'.startsWith(option)) return 'source';
  if (option.length >= 4 && '-destination'.startsWith(option)) return 'destination';
  return undefined;
}

function isStaticLiteralPath(value: string): boolean {
  if (!value || value.startsWith('@') || value.includes(',')) return false;
  if (PROVIDER_QUALIFIED.test(value)) return false;
  if (value.startsWith('\\\\') || value.startsWith('//')) return false;
  // `C:foo` depends on the per-drive current directory.
  if (/^[A-Za-z]:(?![\\/])/.test(value)) return false;
  // Win32 drops trailing dots and spaces, so `.git.` would reach `.git`.
  if (value.split(/[\\/]/).some((segment) => /[. ]$/.test(segment) && !/^\.{1,2}$/.test(segment)))
    return false;
  return !WILDCARD.test(value);
}
