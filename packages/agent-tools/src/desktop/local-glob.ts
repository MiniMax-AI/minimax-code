/**
 * LocalGlobTool: Desktop implementation of `glob` (counterpart to cloud/cloud-glob.ts).
 *
 * `rg --files` enumerates files respecting ignore rules; the runner matches user globs in the
 * output stream. Orchestration matches local-grep.ts; argv construction is an exported pure
 * function with no IO.
 *
 * Hardening (aligned with cloud):
 * - Append the shared sensitive deny-list as `--glob=!…` (P0-2).
 * - Keep patterns out of rg argv, so leading `-` cannot become an rg flag (P0-1).
 *
 * Sorting (P1-4): Optional `sort="modified"` maps to rg `--sortr=modified` (newest first). No
 * sorting by default: rg `--sort*` disables parallelism and slows large directories. When limit
 * truncates results, a notice suggests sorting to retain more relevant entries.
 */

import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

import {
  defaultScanNoiseDirectoriesInSearchRoot,
  defaultScanExcludeArgs,
  filterGlobPaths,
  findGlobMagicIndex,
  globToPathRegex,
  isBroadFileScan,
  isNarrowSearchRoot,
  resolveGlobStaticSearchRoot,
} from '../shared/rg-scan-policy.js';
import { withCompatibleGlobToolResponse } from '../plugin-hooks/vendor-tool-response.js';
import { LocalGlobToolDef, type LocalGlobToolInput } from './builtin-defs.js';
import { resolveSearchRoot, runRg, type RunRgOptions, textResult } from './local-rg-runner.js';
import { isSensitiveSearchRoot, sensitiveExcludeArgs } from './local-sensitive.js';
import { createDesktopOutputContinuation } from './output-limit.js';
import { withDesktopCompletenessReport } from './ptc-result-projection.js';
import type { LocalRuntimeToolContext } from './types.js';

const DEFAULT_GLOB_LIMIT = 200;

function isExactFilePattern(pattern: string): boolean {
  const normalized = pattern.replaceAll('\\', '/');
  return (
    findGlobMagicIndex(normalized) < 0 &&
    normalized.length > 0 &&
    normalized !== '.' &&
    normalized !== '..' &&
    !normalized.endsWith('/')
  );
}

// ─── argv construction (pure function) ───────────────────────────────────

export type GlobArgsInput = Pick<LocalGlobToolInput, 'pattern' | 'sort' | 'include_ignored'> & {
  broadFileScan?: boolean;
  includeDirectoryNoise?: boolean;
  allowedDirectoryNoise?: readonly string[];
};

export function buildGlobArgs(input: GlobArgsInput): string[] {
  const broadFileScan = input.broadFileScan ?? isBroadFileScan(input.pattern);
  return [
    '--no-config',
    '--no-messages',
    '--files',
    '--hidden',
    // Respect project / Git ignore rules by default so generated artifacts,
    // dependency trees, and local environments do not flood project scans.
    ...(input.include_ignored ? ['--no-ignore'] : []),
    // Newest-first so a truncated page keeps recently changed (likely
    // relevant) files. Off by default: rg --sort* disables parallelism.
    ...(input.sort === 'modified' ? ['--sortr=modified'] : []),
    // Positive rg globs override ignore rules when they match an ignored file
    // or directory. Enumerate the ignore-aware working set and filter the
    // runner stream before unmatched paths can consume the stdout byte cap.
    ...defaultScanExcludeArgs({
      broadFileScan,
      includeDirectoryNoise: input.includeDirectoryNoise,
      allowedDirectoryNoise: input.allowedDirectoryNoise,
    }),
    // Keep the security deny-list last so later scan-policy changes cannot
    // accidentally re-include sensitive paths.
    ...sensitiveExcludeArgs(),
  ];
}

// ─── Absolute-path patterns (CC extractGlobBaseDirectory parity) ─────────
//
// rg --glob only matches relative paths: `/Users/x/src/**/*.ts` silently yields no results.
// Extract the pattern's static prefix as the search root and use the remainder as a relative pattern.

export function splitAbsoluteGlob(pattern: string): { root?: string; pattern: string } {
  if (!isAbsolute(pattern)) return { pattern };
  const magicIndex = findGlobMagicIndex(pattern);
  if (magicIndex < 0) {
    // Literal absolute path: search its directory for its basename.
    return { root: dirname(pattern), pattern: basename(pattern) };
  }
  const prefix = pattern.slice(0, magicIndex);
  const cut = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
  if (cut <= 0) return { root: '/', pattern: pattern.slice(1) };
  let root = prefix.slice(0, cut);
  // Windows drive root: "C:" means "cwd on drive C" (relative) — force "C:/".
  if (/^[A-Za-z]:$/.test(root)) root += '/';
  return { root, pattern: pattern.slice(cut + 1) };
}

// ─── Tool orchestration ──────────────────────────────────────────────────

@bindTool(LocalGlobToolDef)
export class LocalGlobTool implements ToolImpl<
  typeof LocalGlobToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(
    private readonly workspaceRoot: string,
    /** Runner overrides (byte cap / timeouts) — used by tests; production uses defaults. */
    private readonly rgOptions: Pick<
      RunRgOptions,
      'maxStdoutBytes' | 'timeoutMs' | 'killGraceMs'
    > = {},
  ) {}

  async execute(
    _ctx: LocalRuntimeToolContext,
    input: LocalGlobToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    if (!input.pattern) throw new Error('glob pattern is required');
    const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_GLOB_LIMIT));
    const offset = input.offset && input.offset > 0 ? Math.floor(input.offset) : 0;
    const split = splitAbsoluteGlob(input.pattern);
    const patternRoot = split.root;
    let effectivePattern = split.pattern;
    // The permission gate reviews `input.path` — an absolute pattern is only
    // a convenience spelling and MUST NOT widen the approved scope. Compare
    // via realpath so a workspace-internal symlink pointing outside
    // (workspace/link -> /etc) cannot smuggle the search root out (same
    // approach as cloud's assertWithinWorkspace). Escaping roots are
    // rejected and routed through `path` (which the gate audits).
    const base = resolveSearchRoot(this.workspaceRoot, input.path);
    let searchRoot = base;
    if (patternRoot) {
      let baseReal: string;
      let patternRootReal: string;
      try {
        baseReal = await realpath(base);
        patternRootReal = await realpath(resolve(patternRoot));
      } catch {
        throw new Error(`glob path does not exist: ${input.path ?? patternRoot}`);
      }
      const rel = relative(baseReal, patternRootReal);
      const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      if (!inside) {
        throw new Error(
          `glob absolute pattern escapes the approved search path (${base}); pass the directory via "path" so the permission gate can review it`,
        );
      }
      // rg always runs from the reviewed base — running from the pattern's
      // subdirectory would return paths relative to that subdirectory, which
      // follow-up read/edit would then resolve against the base and hit the
      // wrong files. Fold the subdirectory back into the glob instead.
      searchRoot = baseReal;
      if (rel !== '') {
        effectivePattern = `${rel.split('\\').join('/')}/${effectivePattern}`;
      }
    }
    // Clear error for a missing path — spawn's cwd ENOENT would otherwise
    // surface as a misleading "ripgrep binary not found".
    try {
      await stat(searchRoot);
    } catch {
      throw new Error(`glob path does not exist: ${input.path ?? searchRoot}`);
    }
    if (await isSensitiveSearchRoot(searchRoot)) {
      return reportGlob(
        withCompatibleGlobToolResponse(textResult(LocalGlobToolDef.name, 'No files matched'), {
          durationMs: Date.now() - startedAt,
          filenames: [],
          truncated: false,
          totalMatches: 0,
          countIsComplete: true,
        }),
        [],
      );
    }
    const requestedRoot = resolveGlobStaticSearchRoot(effectivePattern, searchRoot);
    const narrowSearchRoot = await isNarrowSearchRoot(requestedRoot, this.workspaceRoot);
    const exactFilePattern = isExactFilePattern(effectivePattern);
    const explicitIgnoredScope = narrowSearchRoot || exactFilePattern;
    if (input.include_ignored && !explicitIgnoredScope) {
      throw new Error(
        'include_ignored requires a narrow path, pattern prefix, or exact filename; narrow the search scope before inspecting ignored artifacts',
      );
    }
    const broadFileScan = isBroadFileScan(effectivePattern) && !narrowSearchRoot;
    const allowedDirectoryNoise = defaultScanNoiseDirectoriesInSearchRoot(
      requestedRoot,
      searchRoot,
    );
    const result = await runRg(
      buildGlobArgs({
        pattern: effectivePattern,
        ...(input.sort ? { sort: input.sort } : {}),
        ...(input.include_ignored ? { include_ignored: true } : {}),
        broadFileScan,
        includeDirectoryNoise: Boolean(
          input.include_ignored && narrowSearchRoot && !exactFilePattern,
        ),
        allowedDirectoryNoise,
      }),
      searchRoot,
      {
        ...this.rgOptions,
        stdoutLineRegex: globToPathRegex(effectivePattern),
        maxStdoutLines: offset + limit + 1,
        ...(signal ? { signal } : {}),
      },
    );
    if (result.timedOut) throw new Error('glob timed out');
    // rg --files: exit 1 = no files matched (NOT an error), 2 = error. A
    // byte-cap kill ends the child via signal (exitCode null) — that is a
    // truncation, not a failure: fall through and list the partial output.
    if (result.exitCode !== 0 && result.exitCode !== 1 && !result.stdoutTruncated) {
      const reason = result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`;
      throw new Error(`glob failed: ${reason}`);
    }

    const discoveredLines = result.stdout
      .split('\n')
      .map((line) => line.replace(/\r$/, '').trim())
      .filter((line) => line.length > 0);
    const allLines = filterGlobPaths(discoveredLines, effectivePattern);
    const lines = allLines.slice(offset, offset + limit);
    const truncated = allLines.length > offset + lines.length || result.stdoutTruncated;
    let text =
      lines.length > 0
        ? lines.join('\n')
        : offset > 0
          ? `No more files matched at offset ${offset}`
          : 'No files matched';

    const details: Record<string, unknown> = { matched: lines.length, limit, offset };
    if (truncated) {
      details.truncated = true;
      if (lines.length > 0) {
        const nextOffset = offset + lines.length;
        details.next_offset = nextOffset;
        details.desktop_output_continuation = createDesktopOutputContinuation({
          next_offset: nextOffset,
          offset_unit: 'file',
          continuation_hint: {
            tool: 'glob',
            preserve_args: ['pattern', 'path', 'include_ignored', 'limit', 'sort'],
            instruction:
              `If the omitted remainder is needed, call glob again with offset=${nextOffset}; ` +
              'preserve the same search arguments.',
          },
        });
        text +=
          `\n\n[Results truncated: showing ${lines.length} paths from offset ${offset}. ` +
          `If the omitted remainder is needed, use offset=${nextOffset} with the same search arguments. ` +
          `Refine path/pattern or pass sort="modified" to surface recently changed files]`;
      } else {
        text +=
          '\n\n[Output was truncated before this page could be reached. ' +
          'Refine path/pattern or reduce offset]';
      }
    }
    return reportGlob(
      withCompatibleGlobToolResponse(
        {
          tool_name: LocalGlobToolDef.name,
          text,
          content: [{ type: 'text', text }],
          details,
        },
        {
          durationMs: Date.now() - startedAt,
          filenames: lines,
          truncated,
          totalMatches: allLines.length,
          countIsComplete: !result.stdoutTruncated,
        },
      ),
      lines,
    );
  }
}

/** PTC data is exactly the page of paths the text lists, plus the completeness statement. */
function reportGlob(result: ToolResult, paths: readonly string[]): ToolResult {
  return withDesktopCompletenessReport(LocalGlobToolDef.name, result, {
    data: { paths: [...paths] },
  });
}
