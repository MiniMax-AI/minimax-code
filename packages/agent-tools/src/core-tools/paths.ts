/**
 * Lexical path helpers of the core tools, moved unchanged from the desktop
 * tools (local-pi-tools / local-rg-runner). The one host fact they need — the
 * home directory behind a leading `~` — comes from the host instead of
 * `os.homedir()`, so a host without a home rejects such paths explicitly.
 */

import { isAbsolute, join, resolve as resolvePath } from 'node:path';

import type { ToolResult } from '@mavis/agent-core/tools';

import type { CoreToolHost } from './ports.js';

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

type HomeSource = Pick<CoreToolHost, 'homedir'>;

function missingHomeError(path: string): Error {
  return new Error(
    `Cannot expand "~" in ${path}: this environment has no home directory. Use an absolute or workspace-relative path.`,
  );
}

function requireHome(host: HomeSource, path: string): string {
  const home = host.homedir();
  if (home === undefined) throw missingHomeError(path);
  return home;
}

/**
 * Expands a leading `~` / `~/` the way Pi's `normalizePath` does for its file
 * tools (unicode spaces and a leading `@` normalized first), but against the
 * given home instead of the process's. Other inputs are returned untouched so
 * Pi still applies its own normalization to them.
 */
export function expandHomePath(input: string, home: string | undefined): string {
  let normalized = input.replace(UNICODE_SPACES, ' ');
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (normalized !== '~' && !normalized.startsWith('~/')) return input;
  if (home === undefined) throw missingHomeError(input);
  return normalized === '~' ? home : join(home, normalized.slice(2));
}

/**
 * Lexical normalization for capture hints and read dispatch, aligned with
 * Pi's `resolveToCwd` input. It is not the read-before-write key: the
 * read ledger (file-read-ledger.ts) deliberately keys by realpath, so symlink
 * aliases of one file share a read record; the version check still catches
 * any change made through either alias.
 */
export function normalizeLocalExistingPath(
  absolutePath: string,
  resolveAbsolutePath: (path: string) => string = resolvePath,
): string {
  return resolveAbsolutePath(absolutePath);
}

/**
 * Best-effort absolute path used to pre-detect read dispatch extensions and
 * to look up write captures. Mirrors the common pieces of pi's
 * `normalizePath` (tilde expansion + absolute pass-through) without pulling
 * pi's private path-utils.
 */
export function resolveCandidatePath(
  input: string,
  workspaceRoot: string,
  host: HomeSource,
): string {
  let path = input;
  if (path === '~') {
    return normalizeLocalExistingPath(requireHome(host, input));
  }
  if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) {
    path = resolvePath(requireHome(host, input), path.slice(2));
  }
  return normalizeLocalExistingPath(isAbsolute(path) ? path : resolvePath(workspaceRoot, path));
}

export function resolveSearchRoot(workspaceRoot: string, inputPath?: string): string {
  if (!inputPath?.trim()) return resolvePath(workspaceRoot);
  return isAbsolute(inputPath) ? resolvePath(inputPath) : resolvePath(workspaceRoot, inputPath);
}

/** rg working directory + positional search path for one grep invocation. */
export interface GrepTarget {
  cwd: string;
  searchPath: string;
}

export function textResult(toolName: string, text: string): ToolResult {
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
  };
}
