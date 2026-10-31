/**
 * LocalGrepTool: Desktop implementation of `grep` (counterpart to cloud/cloud-grep.ts).
 *
 * The class only orchestrates: validate input → buildGrepArgs constructs argv → runRg runs ripgrep
 * → shared/grep-parse.ts postprocesses by output_mode (shared by desktop and cloud, P0-3/P1-1).
 * argv construction is an exported pure function with no IO.
 *
 * Hardening (aligned with cloud):
 * - Append the shared sensitive deny-list as `--glob=!…` (P0-2).
 * - Put the LLM pattern after `--` so leading `-` cannot become an rg flag (P0-1).
 * - Bind user glob filters with `=` for the same reason (P0-1).
 *
 * output_mode (P1-1): Default `files_with_matches` returns only file names to save tokens, followed
 * by read/edit as needed. `content` / `count` are opt-in; `offset` supports pagination (P1-2).
 */

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  bindTool,
  withProgrammaticResult,
  type ToolImpl,
  type ToolResult,
} from '@mavis/agent-core/tools';

import {
  DEFAULT_GREP_OUTPUT_MODE,
  type GrepOutputMode,
  grepModeFlags,
  MAX_TOTAL_BYTES,
  parseCountOutput,
  parseFilesOutput,
  parseGrepOutput,
  splitGlobFilters,
} from '../shared/grep-parse.js';
import { withCompatibleGrepToolResponse } from '../plugin-hooks/vendor-tool-response.js';
import { defaultScanExcludeArgs } from '../shared/rg-scan-policy.js';
import { LocalGrepToolDef, type LocalGrepToolInput } from './builtin-defs.js';
import { resolveGrepTarget, runRg, type RunRgOptions, textResult } from './local-rg-runner.js';
import { isSensitiveSearchRoot, sensitiveExcludeArgs } from './local-sensitive.js';
import { withDesktopCompletenessReport } from './ptc-result-projection.js';
import {
  applyDesktopTextLimit,
  createDesktopOutputContinuation,
  DESKTOP_GREP_CONTENT_MAX_BYTES,
  isPtcChildCall,
  limitDesktopPrefixLines,
  withDesktopOutputContinuation,
} from './output-limit.js';
import type { LocalRuntimeToolContext } from './types.js';

const DEFAULT_GREP_LIMIT = 100;
export const MAX_FILESIZE_FLAG = '1M';
const INVALID_REGEX_ERROR_CODE = 'invalid_regex';
const MAX_GREP_ERROR_STDERR_BYTES = 4 * 1024;

// ─── argv construction (pure function) ───────────────────────────────────

export type GrepArgsInput = Pick<
  LocalGrepToolInput,
  'pattern' | 'glob' | 'ignoreCase' | 'literal' | 'context' | 'output_mode' | 'offset'
>;

export function buildGrepArgs(
  input: GrepArgsInput,
  effectiveLimit: number,
  searchPath = '.',
): string[] {
  const mode: GrepOutputMode = input.output_mode ?? DEFAULT_GREP_OUTPUT_MODE;
  const offset = input.offset && input.offset > 0 ? Math.floor(input.offset) : 0;
  const ctxLines =
    mode === 'content' && input.context && input.context > 0 ? Math.floor(input.context) : 0;
  const args = [
    '--no-config',
    '--no-messages',
    '--hidden',
    `--max-filesize=${MAX_FILESIZE_FLAG}`,
    ...grepModeFlags(mode),
  ];
  if (mode === 'content') {
    // ripgrep applies --max-count per file; the surplus row lets
    // parseGrepOutput detect "more available" beyond the requested page.
    args.push('--null', `--max-count=${offset + effectiveLimit + 1}`);
  }
  if (input.ignoreCase) args.push('--ignore-case');
  if (input.literal) args.push('--fixed-strings');
  // Gitignore: grep always respects it (CC parity, no toggle). Callers can
  // narrow `path` to a specific artifact directory when it is genuinely needed.
  if (ctxLines > 0) args.push(`--context=${ctxLines}`);
  // Models frequently write "*.ts, *.tsx" — split on commas/whitespace like
  // reference CLI does, but keep brace expansions ({ts,tsx}) intact.
  if (input.glob) {
    for (const g of splitGlobFilters(input.glob)) args.push(`--glob=${g}`);
  }
  args.push(...defaultScanExcludeArgs());
  // MUST come after any user glob: rg glob rules are last-match-wins, so the
  // deny-list only reliably excludes secrets when it is appended last.
  args.push(...sensitiveExcludeArgs());
  args.push('--', input.pattern, searchPath);
  return args;
}

// ─── Sort files_with_matches by mtime (P1-4, desktop only; cloud has no local fs) ─
//
// Match three reference CLI GrepTool details: allSettled tolerates files deleted between rg scanning
// and stat (mtime 0 sorts last instead of rejecting the batch); break ties by filename;
// use filename order under NODE_ENV=test for deterministic assertions. Sort before truncation.

type StatLike = (path: string) => Promise<{ mtimeMs?: number }>;

export async function sortFilesByMtime(
  files: readonly string[],
  root: string,
  statFn: StatLike = stat,
  mode: 'mtime' | 'name' = process.env.NODE_ENV === 'test' ? 'name' : 'mtime',
): Promise<string[]> {
  if (mode === 'name') return [...files].sort((a, b) => a.localeCompare(b));
  const stats = await Promise.allSettled(files.map((f) => statFn(resolve(root, f))));
  return files
    .map((file, i) => {
      const r = stats[i]!;
      return [file, r.status === 'fulfilled' ? (r.value.mtimeMs ?? 0) : 0] as const;
    })
    .sort((a, b) => {
      const timeComparison = b[1] - a[1];
      if (timeComparison === 0) return a[0].localeCompare(b[0]);
      return timeComparison;
    })
    .map(([file]) => file);
}

// ─── Tool orchestration ──────────────────────────────────────────────────

@bindTool(LocalGrepToolDef)
export class LocalGrepTool implements ToolImpl<
  typeof LocalGrepToolDef.schema,
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
    ctx: LocalRuntimeToolContext,
    input: LocalGrepToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (!input.pattern) throw new Error('grep pattern is required');
    const effectiveLimit = Math.max(1, Math.floor(input.limit ?? DEFAULT_GREP_LIMIT));
    const mode: GrepOutputMode = input.output_mode ?? DEFAULT_GREP_OUTPUT_MODE;
    const offset = input.offset && input.offset > 0 ? Math.floor(input.offset) : 0;
    // Resolve the target to an rg cwd + search path: a directory searches `.`,
    // a single file runs from its parent with just the basename. Throws a clear
    // "grep path does not exist" before spawn, so a missing path never surfaces
    // as a misleading "ripgrep binary not found" (CC stats in validateInput too).
    const target = resolveGrepTarget(this.workspaceRoot, input.path);
    if (await isSensitiveSearchRoot(resolve(target.cwd, target.searchPath))) {
      return reportGrep(
        withCompatibleGrepToolResponse(textResult(LocalGrepToolDef.name, 'No matches found'), {
          mode,
          filenames: [],
          appliedLimit: effectiveLimit,
          appliedOffset: offset,
        }),
        emptyGrepData(mode),
      );
    }
    const args = buildGrepArgs(input, effectiveLimit, target.searchPath);

    const result = await runRg(args, target.cwd, {
      ...this.rgOptions,
      ...(signal ? { signal } : {}),
    });
    if (result.timedOut) throw new Error('grep timed out');
    if (result.exitCode === 1) {
      return reportGrep(
        withCompatibleGrepToolResponse(textResult(LocalGrepToolDef.name, 'No matches found'), {
          mode,
          filenames: [],
          appliedLimit: effectiveLimit,
          appliedOffset: offset,
        }),
        emptyGrepData(mode),
      );
    }
    // A byte-cap kill ends the child via signal (exitCode null) — that is a
    // truncation, not a failure: fall through and parse the partial stdout.
    if (result.exitCode !== 0 && !result.stdoutTruncated) {
      if (isRipgrepRegexParseError(result.stderr)) {
        return invalidRegexResult(result.stderr, result.exitCode);
      }
      const reason = result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`;
      throw new Error(`grep failed: ${reason}`);
    }

    const parseOpts = { limit: effectiveLimit, offset };
    let parsed;
    if (mode === 'files_with_matches') {
      // Sort newest-first BEFORE slicing so a truncated page keeps recently
      // changed (likely relevant) files (P1-4, mirrors reference CLI).
      const files = result.stdout
        .split('\n')
        .map((line) => line.replace(/\r$/, '').trim())
        .filter((line) => line.length > 0);
      const sorted = await sortFilesByMtime(files, target.cwd);
      parsed = parseFilesOutput(sorted.join('\n'), parseOpts);
    } else if (mode === 'count') {
      parsed = parseCountOutput(result.stdout, parseOpts);
    } else {
      parsed = parseGrepOutput(result.stdout, {
        ...parseOpts,
        partitionContext: true,
        // A run_code child keeps whole lines and the whole page (see isPtcChildCall).
        ...(isPtcChildCall(ctx) ? { uncapped: true } : {}),
      });
    }
    const { text, details } = parsed;
    if (result.stdoutTruncated) {
      details.stdoutTruncated = true;
    }
    if (text.trim().length === 0) {
      if (result.stdoutTruncated) {
        return reportGrep(
          outputCutBeforePageResult(mode, offset, effectiveLimit, details),
          emptyGrepData(mode),
        );
      }
      return reportGrep(
        withCompatibleGrepToolResponse(textResult(LocalGrepToolDef.name, 'No matches found'), {
          mode,
          filenames: [],
          appliedLimit: effectiveLimit,
          appliedOffset: offset,
        }),
        emptyGrepData(mode),
      );
    }
    let modelText = text;
    if (mode === 'files_with_matches' && details.truncated === true) {
      const nextOffset = offset + effectiveLimit;
      const sharedFooter = `\n\n[More available — use offset=${nextOffset}]`;
      const conditionalNotice =
        `[More available. If the omitted remainder is needed, use offset=${nextOffset} ` +
        'with the same search arguments and output_mode.]';
      if (modelText.endsWith(sharedFooter)) {
        modelText = `${modelText.slice(0, -sharedFooter.length)}\n\n${conditionalNotice}`;
      }
      details.desktop_output_continuation = createDesktopOutputContinuation({
        next_offset: nextOffset,
        offset_unit: 'file',
        continuation_hint: {
          tool: 'grep',
          preserve_args: [
            'pattern',
            'path',
            'glob',
            'ignoreCase',
            'literal',
            'output_mode',
            'limit',
          ],
          instruction:
            `If the omitted remainder is needed, call grep again with offset=${nextOffset}; ` +
            'preserve the same search arguments and output_mode.',
        },
      });
    }
    const finalText = result.stdoutTruncated
      ? `${modelText}\n\n[Output hit the byte safety cap; totals may be incomplete. Refine the pattern]`
      : modelText;
    const toolResult: ToolResult = withCompatibleGrepToolResponse(
      {
        tool_name: LocalGrepToolDef.name,
        text: finalText,
        content: [{ type: 'text', text: finalText }],
        ...(Object.keys(details).length > 0 ? { details } : {}),
      },
      {
        mode,
        filenames: parsed.facts.filenames,
        ...(parsed.facts.numLines !== undefined ? { numLines: parsed.facts.numLines } : {}),
        ...(parsed.facts.numMatches !== undefined ? { numMatches: parsed.facts.numMatches } : {}),
        ...(parsed.facts.totalFiles !== undefined ? { totalFiles: parsed.facts.totalFiles } : {}),
        ...(mode === 'content' ? { content: text } : {}),
        appliedLimit: effectiveLimit,
        appliedOffset: offset,
      },
    );
    if (mode !== 'content') {
      return reportGrep(
        toolResult,
        mode === 'count'
          ? { counts: [...(parsed.facts.counts ?? [])] }
          : { files: [...parsed.facts.filenames] },
      );
    }

    if (isPtcChildCall(ctx)) {
      // A run_code child gets every match line of the page in full; the
      // 16 KiB cap below is for the model (see isPtcChildCall).
      return reportGrep(
        withMatchLimitContinuation(toolResult, details, offset + effectiveLimit),
        {
          matches: (parsed.matchEntries ?? []).map(({ path, line, text: matchText }) => ({
            path,
            line,
            text: matchText,
          })),
        },
        parsed.uncappedOutput === true ||
          Buffer.byteLength(finalText, 'utf8') > DESKTOP_GREP_CONTENT_MAX_BYTES,
      );
    }
    let matchLineIndexes = parsed.matchLineIndexes ?? [];
    // Output line index of the first line still shown after leading context was dropped.
    let shownFrom = 0;
    const retainedMatchCount = (lineCount: number): number =>
      matchLineIndexes.filter((lineIndex) => lineIndex < lineCount).length;
    const parserWarnings: string[] = [];
    if (typeof details.matchLimitReached === 'number') {
      parserWarnings.push(`${details.matchLimitReached} matches limit reached`);
    }
    if (details.linesTruncated === true) {
      parserWarnings.push('some lines were truncated to 2000 chars; use read for full lines');
    }
    if (finalText.includes(`${MAX_TOTAL_BYTES / 1024}KB output limit reached`)) {
      parserWarnings.push(`${MAX_TOTAL_BYTES / 1024}KB parser limit reached`);
    }
    const desktopNotice = (originalBytes: number, retainedLines: readonly string[]): string => {
      const retainedMatches = retainedMatchCount(retainedLines.length);
      return `[desktop grep output truncated: original_bytes=${originalBytes}; ${
        result.stdoutTruncated ? 'ripgrep byte safety cap was reached; ' : ''
      }${parserWarnings.length > 0 ? `${parserWarnings.join('; ')}; ` : ''}if the omitted remainder is needed, continue with grep using offset=${offset + retainedMatches} and the same search arguments, or refine pattern/path/glob/context.]`;
    };
    const originalBytes = Buffer.byteLength(finalText, 'utf8');
    let desktopText = finalText;
    let limited = limitDesktopPrefixLines(desktopText, {
      maxBytes: DESKTOP_GREP_CONTENT_MAX_BYTES,
      notice: ({ originalBytes: noticeOriginalBytes, retainedLines }) =>
        desktopNotice(noticeOriginalBytes, retainedLines),
    });

    // If large before-context fills the entire cap, continuing with the same
    // offset would repeat this page forever. Retry from the first actual match
    // and record the omission so the model gets a progressing continuation.
    if (limited.truncation && retainedMatchCount(limited.returnedBodyLines) === 0) {
      const firstMatchIndex = matchLineIndexes[0];
      if (firstMatchIndex !== undefined && firstMatchIndex > 0) {
        const modelLines = desktopText.split('\n');
        shownFrom = firstMatchIndex;
        matchLineIndexes = matchLineIndexes.map((lineIndex) => lineIndex - firstMatchIndex);
        parserWarnings.push('leading context was omitted to keep pagination progressing');
        desktopText = modelLines.slice(firstMatchIndex).join('\n');
        limited = limitDesktopPrefixLines(desktopText, {
          maxBytes: DESKTOP_GREP_CONTENT_MAX_BYTES,
          originalBytes,
          notice: ({ originalBytes: noticeOriginalBytes, retainedLines }) =>
            desktopNotice(noticeOriginalBytes, retainedLines),
        });
      }
    }
    if (limited.truncation) {
      const lastRetainedMatchIndex = matchLineIndexes
        .filter((lineIndex) => lineIndex < limited.returnedBodyLines)
        .at(-1);
      if (
        lastRetainedMatchIndex !== undefined &&
        lastRetainedMatchIndex + 1 < limited.returnedBodyLines
      ) {
        // Context after the last retained match belongs to the next offset
        // page. Removing it here prevents duplicate context while keeping the
        // match-offset contract stateless and deterministic.
        desktopText = desktopText
          .split('\n')
          .slice(0, lastRetainedMatchIndex + 1)
          .join('\n');
        limited = limitDesktopPrefixLines(desktopText, {
          maxBytes: DESKTOP_GREP_CONTENT_MAX_BYTES,
          originalBytes,
          notice: ({ originalBytes: noticeOriginalBytes, retainedLines }) =>
            desktopNotice(noticeOriginalBytes, retainedLines),
        });
      }
    }
    if (limited.truncation) {
      const nextOffset = offset + retainedMatchCount(limited.returnedBodyLines);
      limited = withDesktopOutputContinuation(limited, {
        next_offset: nextOffset,
        offset_unit: 'match',
        continuation_hint: {
          tool: 'grep',
          preserve_args: [
            'pattern',
            'path',
            'glob',
            'ignoreCase',
            'literal',
            'context',
            'output_mode',
            'limit',
          ],
          instruction:
            `If the omitted remainder is needed, call grep again with offset=${nextOffset}; ` +
            'preserve the same search arguments and output_mode.',
        },
      });
    }
    // data lists only the match lines the output still shows (no context lines).
    const shownMatches = (parsed.matchEntries ?? [])
      .filter(
        ({ lineIndex }) =>
          lineIndex >= shownFrom &&
          (!limited.truncation || lineIndex - shownFrom < limited.returnedBodyLines),
      )
      .map(({ path, line, text: matchText }) => ({ path, line, text: matchText }));
    return reportGrep(
      withMatchLimitContinuation(
        applyDesktopTextLimit(toolResult, limited),
        details,
        offset + effectiveLimit,
      ),
      { matches: shownMatches },
    );
  }
}

type GrepProgrammaticData =
  | { readonly files: readonly string[] }
  | { readonly matches: readonly { path: string; line: number; text: string }[] }
  | { readonly counts: readonly { path: string; count: number }[] };

function emptyGrepData(mode: GrepOutputMode): GrepProgrammaticData {
  if (mode === 'content') return { matches: [] };
  return mode === 'count' ? { counts: [] } : { files: [] };
}

/** Every non-error return states its completeness and carries the page as data. */
function reportGrep(
  result: ToolResult,
  data: GrepProgrammaticData,
  uncappedOutput = false,
): ToolResult {
  return withDesktopCompletenessReport(LocalGrepToolDef.name, result, {
    data,
    ...(uncappedOutput ? { uncappedOutput } : {}),
  });
}

/**
 * ripgrep's byte cap ended its output before this page, so an empty page does
 * not prove there are no more matches. Keep the truncation marker and say so
 * (mirrors glob) instead of "No matches found".
 */
function outputCutBeforePageResult(
  mode: GrepOutputMode,
  offset: number,
  limit: number,
  details: Record<string, unknown>,
): ToolResult {
  const text =
    `${offset > 0 ? `No more matches at offset ${offset}` : 'No matches found'}\n\n` +
    '[Output was truncated before this page could be reached. Refine pattern/path/glob or reduce offset]';
  return withCompatibleGrepToolResponse(
    {
      tool_name: LocalGrepToolDef.name,
      text,
      content: [{ type: 'text', text }],
      details: { ...details, stdoutTruncated: true },
    },
    { mode, filenames: [], appliedLimit: limit, appliedOffset: offset },
  );
}

/**
 * At the match limit the next page starts at offset + limit (in matches).
 * PTC scripts get that as a structured continuation through the programmatic
 * side channel; details and the model text stay as they were.
 */
function withMatchLimitContinuation(
  result: ToolResult,
  details: Readonly<Record<string, unknown>>,
  nextOffset: number,
): ToolResult {
  if (typeof details.matchLimitReached !== 'number') return result;
  // A Desktop 16 KiB cut already names the exact next offset in details.
  if (result.details?.desktop_output_truncation !== undefined) return result;
  return withProgrammaticResult(result, {
    completeness: { truncated: true, nextOffset, offsetUnit: 'match' },
  });
}

function isRipgrepRegexParseError(stderr: string): boolean {
  return stderr.toLocaleLowerCase().includes('regex parse error:');
}

function invalidRegexResult(stderr: string, exitCode: number | null): ToolResult {
  const rawStderr = stderr.trim();
  const errorSummary = lastRipgrepErrorLine(rawStderr) ?? 'invalid regular expression';
  const text =
    `Invalid search pattern: ${errorSummary}. ` +
    'Escape regex special characters (for example, use `\\(` for a literal parenthesis) ' +
    'or use `literal=true` for one exact string.';
  return {
    tool_name: LocalGrepToolDef.name,
    text,
    content: [{ type: 'text', text }],
    isError: true,
    details: {
      error_code: INVALID_REGEX_ERROR_CODE,
      exit_code: exitCode,
      stderr: Buffer.from(rawStderr, 'utf8')
        .subarray(0, MAX_GREP_ERROR_STDERR_BYTES)
        .toString('utf8'),
    },
  };
}

function lastRipgrepErrorLine(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line?.toLocaleLowerCase().startsWith('error:')) {
      const summary = line.slice('error:'.length).trim();
      if (summary) return summary;
    }
  }
  return undefined;
}
