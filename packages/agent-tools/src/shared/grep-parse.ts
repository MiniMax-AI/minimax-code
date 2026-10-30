/**
 * Pure output post-processing for the `grep` tools (desktop + cloud share
 * this implementation, P0-3): global match limiting with offset paging,
 * per-line clamping, total byte clamping, truncation notices, and the
 * output_mode flag/parse mapping (P1-1/P1-2).
 * No IO — unit-testable without spawning ripgrep.
 */

export const MAX_TOTAL_BYTES = 256 * 1024;
export const MAX_LINE_LENGTH = 2_000;

// ─── output_mode → rg flags（P1-1） ─────────────────────────────────────

export type GrepOutputMode = 'files_with_matches' | 'content' | 'count';

export const DEFAULT_GREP_OUTPUT_MODE: GrepOutputMode = 'files_with_matches';

export function grepModeFlags(mode: GrepOutputMode): string[] {
  switch (mode) {
    case 'files_with_matches':
      return ['-l'];
    case 'count':
      // --count-matches, NOT -c: -c counts matching LINES while the result
      // text says "occurrences" — a line with 3 hits must count as 3.
      return ['--count-matches', '--with-filename'];
    case 'content':
      return ['--with-filename', '--line-number'];
  }
}

// ─── content mode ────────────────────────────────────────────────────────

export interface LimitedGrepOutput {
  text: string;
  matchLimitReached: boolean;
}

export function limitGrepOutput(
  stdout: string,
  limit: number,
  offset = 0,
  options: { partitionContext?: boolean } = {},
): LimitedGrepOutput {
  // rg emits `--` between non-adjacent context groups. Context rows carry no
  // match ownership, so we page by GROUP: a group is emitted only when it
  // holds at least one in-window match. Skipping context by match count alone
  // (matches < offset) leaks the after-context of the last paged-past match
  // into the next page — dropping whole context-only groups avoids that.
  const groups: string[][] = [];
  let current: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    if (line === '--') {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) groups.push(current);

  const keptGroups: string[][] = [];
  let matches = 0;
  let matchLimitReached = false;

  if (options.partitionContext) {
    for (const group of groups) {
      const matchPositions: Array<{ position: number; ordinal: number }> = [];
      for (let position = 0; position < group.length; position += 1) {
        if (!isRipgrepMatchLine(group[position] ?? '')) continue;
        matches += 1;
        matchPositions.push({ position, ordinal: matches });
        if (matches > offset + limit) matchLimitReached = true;
      }
      const keptMatches = matchPositions.filter(
        ({ ordinal }) => ordinal > offset && ordinal <= offset + limit,
      );
      if (keptMatches.length === 0) continue;

      const firstKept = keptMatches[0];
      const lastKept = keptMatches.at(-1);
      if (!firstKept || !lastKept) continue;
      const previousMatch = [...matchPositions]
        .reverse()
        .find(({ ordinal }) => ordinal < firstKept.ordinal);
      const nextMatch = matchPositions.find(({ ordinal }) => ordinal > lastKept.ordinal);
      const start = previousMatch ? previousMatch.position + 1 : 0;
      // Context between two matches belongs to the later match. This makes
      // offset pages disjoint: the previous page ends at its last match and
      // the next page owns the intervening context plus the next match.
      const end = nextMatch ? lastKept.position : group.length - 1;
      keptGroups.push(group.slice(start, end + 1));
    }

    const kept: string[] = [];
    for (const group of keptGroups) {
      if (kept.length > 0) kept.push('--');
      kept.push(...group);
    }
    return { text: kept.join('\n'), matchLimitReached };
  }

  for (const group of groups) {
    const lines: string[] = [];
    let hasWindowMatch = false;
    for (const line of group) {
      if (isRipgrepMatchLine(line)) {
        matches += 1;
        if (matches <= offset) continue; // paged-past match: drop its match line
        if (matches > offset + limit) {
          matchLimitReached = true;
          continue; // over-limit match: drop its match line
        }
        hasWindowMatch = true;
      }
      lines.push(line);
    }
    // Only keep the group (match lines + shared context) when it anchors an
    // in-window match; context-only remnants of skipped matches are dropped.
    if (hasWindowMatch) keptGroups.push(lines);
  }

  const kept: string[] = [];
  for (const group of keptGroups) {
    if (kept.length > 0) kept.push('--');
    kept.push(...group);
  }
  return { text: kept.join('\n'), matchLimitReached };
}

function isRipgrepMatchLine(line: string): boolean {
  // With --null (P1-3) rg emits `path\0line:text` for matches and
  // `path\0line-text` for context rows — the NUL boundary makes paths
  // containing colons unambiguous. Legacy colon-separated lines (rg without
  // --null) fall back to the colon heuristic.
  const nul = line.indexOf('\u0000');
  if (nul > 0) return /^\d+:/.test(line.slice(nul + 1));
  return /^.+:\d+:/.test(line);
}

/** Render the NUL path boundary back as a colon for model-facing output. */
function restoreNulSeparator(line: string): string {
  const nul = line.indexOf('\u0000');
  return nul === -1 ? line : `${line.slice(0, nul)}:${line.slice(nul + 1)}`;
}

export interface ParsedGrepOutput {
  text: string;
  details: Record<string, unknown>;
  /** Exact structured result facts retained before model-facing decoration. */
  facts: {
    readonly filenames: readonly string[];
    readonly numFiles: number;
    readonly numLines?: number;
    readonly numMatches?: number;
    readonly totalFiles?: number;
    /** count mode: the page's per-file counts, exactly as listed in the text. */
    readonly counts?: readonly GrepCountEntry[];
  };
  /** Zero-based output line indexes that originated from actual rg matches. */
  matchLineIndexes?: readonly number[];
  /**
   * content mode: the retained match lines (no context lines) with their
   * output line index. `text` is cut where the output line is cut, so it
   * never carries more than the model-visible text.
   */
  matchEntries?: readonly GrepMatchEntry[];
}

export interface GrepMatchEntry {
  readonly lineIndex: number;
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface GrepCountEntry {
  readonly path: string;
  readonly count: number;
}

export function parseGrepOutput(
  stdout: string,
  opts: { limit: number; offset?: number; partitionContext?: boolean },
): ParsedGrepOutput {
  const offset = opts.offset && opts.offset > 0 ? Math.floor(opts.offset) : 0;
  const limitedOutput = limitGrepOutput(stdout, opts.limit, offset, {
    partitionContext: opts.partitionContext,
  });
  let output = limitedOutput.text;
  const details: Record<string, unknown> = {};
  let bytesTruncated = false;
  let linesTruncated = false;

  const rawLines = output.length > 0 ? output.split('\n') : [];
  if (limitedOutput.matchLimitReached) {
    details.matchLimitReached = opts.limit;
  }

  output = rawLines
    .map((line) => {
      const restored = restoreNulSeparator(line).replace(/^\.\//, '');
      if (restored.length > MAX_LINE_LENGTH) {
        linesTruncated = true;
        return `${restored.slice(0, MAX_LINE_LENGTH)}...`;
      }
      return restored;
    })
    .join('\n');

  if (Buffer.byteLength(output, 'utf-8') > MAX_TOTAL_BYTES) {
    // Cutting at a raw byte offset lands mid-line: the tail row is torn and
    // may end on a partial multi-byte sequence (→ U+FFFD). Drop everything
    // after the last complete line so the model never sees a half path/match
    // (mirrors the 8 MB stdout cap's torn-tail handling in local-rg-runner).
    const capped = Buffer.from(output, 'utf-8').subarray(0, MAX_TOTAL_BYTES).toString('utf-8');
    const lastNewline = capped.lastIndexOf('\n');
    output = lastNewline >= 0 ? capped.slice(0, lastNewline) : capped;
    bytesTruncated = true;
  }
  output = output.replace(/\n+$/, '');
  const retainedSourceLineCount = output.length > 0 ? output.split('\n').length : 0;
  const retainedRawLines = rawLines.slice(0, retainedSourceLineCount);
  const matchLineIndexes = retainedRawLines.flatMap((line, index) =>
    isRipgrepMatchLine(line) ? [index] : [],
  );
  const matchEntries = matchLineIndexes.flatMap((index) => {
    const entry = parseMatchLine(retainedRawLines[index] ?? '');
    return entry ? [{ lineIndex: index, ...entry }] : [];
  });
  const filenames = uniqueStrings(retainedRawLines.flatMap(ripgrepLinePath));
  if (linesTruncated) details.linesTruncated = true;

  const notices: string[] = [];
  if (limitedOutput.matchLimitReached) {
    notices.push(
      `${opts.limit} matches limit reached. More available — use offset=${offset + opts.limit}, or refine pattern`,
    );
  }
  if (bytesTruncated) notices.push(`${MAX_TOTAL_BYTES / 1024}KB output limit reached`);
  if (linesTruncated) {
    notices.push(`Some lines truncated to ${MAX_LINE_LENGTH} chars. Use read tool for full lines`);
  }
  if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`;

  return {
    text: output,
    details,
    matchLineIndexes,
    matchEntries,
    facts: {
      filenames,
      numFiles: filenames.length,
      numLines: retainedRawLines.length,
      numMatches: matchLineIndexes.length,
    },
  };
}

// ─── files_with_matches mode (P1-1, default) ──────────────────────────────
//
// rg -l emits all matching files; slice in JS so total is exact and the model can be told
// how many remain and which offset to use for the next page.

export function parseFilesOutput(
  stdout: string,
  opts: { limit: number; offset?: number },
): ParsedGrepOutput {
  const offset = opts.offset && opts.offset > 0 ? Math.floor(opts.offset) : 0;
  const files = stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim().replace(/^\.\//, ''))
    .filter((line) => line.length > 0);
  const details: Record<string, unknown> = { files: files.length };
  if (files.length === 0) {
    return { text: '', details, facts: { filenames: [], numFiles: 0, totalFiles: 0 } };
  }
  if (offset > 0 && offset >= files.length) {
    return {
      text: `Found ${files.length} files (offset ${offset} is beyond the end)`,
      details,
      facts: { filenames: [], numFiles: 0, totalFiles: files.length },
    };
  }

  const page = files.slice(offset, offset + opts.limit);
  const truncated = files.length > offset + page.length;
  const header =
    offset === 0 && !truncated
      ? `Found ${files.length} files`
      : `Found ${files.length} files (showing ${offset + 1}-${offset + page.length})`;
  let text = [header, ...page].join('\n');
  if (truncated) {
    details.truncated = true;
    text += `\n\n[More available — use offset=${offset + page.length}]`;
  }
  return {
    text,
    details,
    facts: { filenames: page, numFiles: page.length, totalFiles: files.length },
  };
}

// ─── count mode (P1-1) ───────────────────────────────────────────────────

export function parseCountOutput(
  stdout: string,
  opts: { limit: number; offset?: number },
): ParsedGrepOutput {
  const offset = opts.offset && opts.offset > 0 ? Math.floor(opts.offset) : 0;
  const entries = stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim().replace(/^\.\//, ''))
    .filter((line) => line.length > 0);

  let totalMatches = 0;
  let fileCount = 0;
  for (const entry of entries) {
    // rg -c emits `path:count`; split on the LAST colon so Windows drive
    // letters (C:\…) and paths containing colons stay intact.
    const idx = entry.lastIndexOf(':');
    const count = Number.parseInt(entry.slice(idx + 1), 10);
    if (!Number.isNaN(count)) {
      totalMatches += count;
      fileCount += 1;
    }
  }

  const details: Record<string, unknown> = { files: fileCount, matches: totalMatches };
  if (entries.length === 0) {
    return {
      text: '',
      details,
      facts: { filenames: [], numFiles: 0, numMatches: 0, totalFiles: 0 },
    };
  }

  const page = entries.slice(offset, offset + opts.limit);
  const pageEntries = page.flatMap((entry) => {
    const idx = entry.lastIndexOf(':');
    const count = Number.parseInt(entry.slice(idx + 1), 10);
    return idx > 0 && !Number.isNaN(count) ? [{ filename: entry.slice(0, idx), count }] : [];
  });
  const truncated = entries.length > offset + page.length;
  let text = page.join('\n');
  text += `\n\nFound ${totalMatches} total ${totalMatches === 1 ? 'occurrence' : 'occurrences'} across ${fileCount} ${fileCount === 1 ? 'file' : 'files'}.`;
  if (truncated) {
    details.truncated = true;
    text += ` [More entries — use offset=${offset + page.length}]`;
  }
  return {
    text,
    details,
    facts: {
      filenames: pageEntries.map(({ filename }) => filename),
      numFiles: pageEntries.length,
      numMatches: pageEntries.reduce((sum, { count }) => sum + count, 0),
      totalFiles: fileCount,
      counts: pageEntries.map(({ filename, count }) => ({ path: filename, count })),
    },
  };
}

/**
 * Splits one rg match line (`path\0line:text`, or legacy `path:line:text`)
 * the way the output shows it: `./` dropped and the text cut so that
 * `path:line:text` stays within MAX_LINE_LENGTH, like the model-visible line.
 */
function parseMatchLine(
  raw: string,
): { readonly path: string; readonly line: number; readonly text: string } | undefined {
  const nul = raw.indexOf('\u0000');
  const located = nul > 0 ? raw.slice(nul + 1).match(/^(\d+):/) : raw.match(/^(.+?):(\d+):/);
  if (!located) return undefined;
  const path = (nul > 0 ? raw.slice(0, nul) : (located[1] ?? '')).replace(/^\.\//, '');
  const line = Number(nul > 0 ? located[1] : located[2]);
  const text = nul > 0 ? raw.slice(nul + 1 + located[0].length) : raw.slice(located[0].length);
  const prefixLength = `${path}:${line}:`.length;
  return { path, line, text: text.slice(0, Math.max(0, MAX_LINE_LENGTH - prefixLength)) };
}

function ripgrepLinePath(line: string): string[] {
  if (line === '--') return [];
  const nul = line.indexOf('\u0000');
  if (nul > 0) return [line.slice(0, nul).replace(/^\.\//, '')];
  const match = line.match(/^(.+):\d+[:-]/);
  return match?.[1] ? [match[1].replace(/^\.\//, '')] : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// ─── Glob filter splitting (shared by desktop/cloud) ─────────────────────

/**
 * Split "*.ts, *.tsx" style filters into individual globs (models write
 * comma/space separated lists frequently — mirrors reference CLI). Brace
 * expansions ({ts,tsx}) contain commas and stay whole.
 */
export function splitGlobFilters(glob: string): string[] {
  if (glob.includes('{')) return [glob.trim()].filter(Boolean);
  return glob
    .split(/[,\s]+/)
    .map((g) => g.trim())
    .filter(Boolean);
}
