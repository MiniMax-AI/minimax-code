import { homedir } from 'node:os';
import path from 'node:path';
import {
  extractBashPathIntents,
  readBashCommand,
  resolvePermissionPath,
  splitCommand,
  unwrapBashCommandWrappers,
} from '@mavis/permission';

import { canonicalPath, isInside, type Protects } from './canonical-paths.js';

/**
 * Write and delete targets the shared bash path model recognizes: redirects,
 * `tee`, `cp`/`mv` destinations, `mv` and `rm` operands, and `sed -i` files,
 * including commands wrapped in `bash -c`. Reads are never targets here.
 * Relative targets resolve from the session directories and from every literal
 * `cd` in the command, so an earlier `cd` cannot hide the directory.
 */
export function bashWritesInside(
  root: string,
  sessionBases: readonly string[],
  toolInput: Readonly<Record<string, unknown>>,
  protects: Protects,
): boolean {
  const command = [toolInput.command, toolInput.cmd].find(
    (value): value is string => typeof value === 'string',
  );
  if (!command?.trim()) return false;
  const windowsPosix = process.platform === 'win32';
  const home = homedir();
  for (const script of unwrapBashCommandWrappers(command)) {
    const bases = [...sessionBases, ...literalCdTargets(script, sessionBases, home)];
    const targets = extractBashPathIntents(script, windowsPosix, {
      retainDynamicTargets: true,
    }).filter((intent) => intent.action === 'write' || intent.action === 'delete');
    for (const target of targets) {
      if (bashTargetReaches({ root, bases, home, protects }, target)) return true;
    }
  }
  return false;
}

type BashPathIntent = ReturnType<typeof extractBashPathIntents>[number];

function bashTargetReaches(
  {
    root,
    bases,
    home,
    protects,
  }: { root: string; bases: readonly string[]; home: string; protects: Protects },
  target: BashPathIntent,
): boolean {
  const glob = firstGlobIndex(target.path);
  const raw = glob === undefined ? target.path : staticGlobDirectory(target.path, glob);
  const pathSyntax =
    glob === undefined || !target.pathSyntax
      ? target.pathSyntax
      : { ...target.pathSyntax, glob: false };
  const resolved = resolveBashPath(raw, bases, home, pathSyntax);
  // Variables and other expansions cannot be resolved here; a target that
  // still names the protected directory by its last segments is treated as it.
  if (resolved === undefined) return namesDirectory(root, target.path, protects);
  return resolved.some((candidate) => {
    const canonical = canonicalPath(candidate);
    if (protects(root, canonical)) return true;
    // A glob may match a protected entry of the directory it expands in.
    if (
      glob !== undefined &&
      protects(root, path.join(canonical, globSegment(target.path, glob)))
    ) {
      return true;
    }
    // Deleting or moving away a literal parent removes the protected directory too.
    return target.action === 'delete' && glob === undefined && isInside(canonical, root);
  });
}

function resolveBashPath(
  raw: string,
  bases: readonly string[],
  home: string,
  pathSyntax: BashPathIntent['pathSyntax'],
): string[] | undefined {
  const context = {
    homeDir: home,
    platform: process.platform,
    ...(pathSyntax ? { pathSyntax } : {}),
  };
  const first = resolvePermissionPath(raw, context, 'posix');
  if (first.dynamic) return undefined;
  if (first.resolution !== 'relative') return first.resolved ? [first.resolved] : undefined;
  return bases.flatMap((workingDirectory) => {
    const value = resolvePermissionPath(raw, { ...context, workingDirectory }, 'posix');
    return value.resolved ? [value.resolved] : [];
  });
}

/** Every `cd`/`pushd` to a literal directory, resolved from the session directories. */
export function literalCdTargets(script: string, bases: readonly string[], home: string): string[] {
  return splitCommand(script).flatMap((segment) => {
    const parsed = readBashCommand(segment.trim());
    if (!parsed || !['cd', 'pushd'].includes(parsed.executable)) return [];
    const operand = parsed.args.find((arg) => !arg.startsWith('-'));
    if (!operand) return [];
    return resolveBashPath(operand, bases, home, undefined) ?? [];
  });
}

function firstGlobIndex(raw: string): number | undefined {
  const index = raw.search(/[*?[]/);
  return index < 0 ? undefined : index;
}
/** The literal directory a glob expands inside, e.g. `memory` for `memory/*.md`. */
function staticGlobDirectory(raw: string, globIndex: number): string {
  const slash = raw.lastIndexOf('/', globIndex);
  if (slash < 0) return '.';
  return slash === 0 ? '/' : raw.slice(0, slash);
}

/** The path segment that holds the first glob character, e.g. `*.md` for `memory/*.md`. */
function globSegment(raw: string, globIndex: number): string {
  const start = Math.max(raw.lastIndexOf('/', globIndex), raw.lastIndexOf('\\', globIndex)) + 1;
  const end = raw.slice(globIndex).search(/[\\/]/);
  return end < 0 ? raw.slice(start) : raw.slice(start, globIndex + end);
}

/**
 * A target only the shell can expand that names the protected directory by its
 * last two segments. The literal segments after the directory decide, as far
 * as they go; with none, the whole directory is named.
 */
function namesDirectory(root: string, raw: string, protects: Protects): boolean {
  const tail = `${path.basename(path.dirname(root))}/${path.basename(root)}`;
  const normalized = `/${raw.replaceAll('\\', '/')}/`;
  const index = normalized.indexOf(`/${tail}/`);
  if (index < 0) return false;
  const literal: string[] = [];
  for (const segment of normalized.slice(index + tail.length + 2).split('/')) {
    if (!segment) continue;
    if (/[$%`{]/.test(segment)) break;
    literal.push(segment);
    if (/[*?[]/.test(segment)) break;
  }
  return literal.length === 0 || protects(root, path.join(root, ...literal));
}
