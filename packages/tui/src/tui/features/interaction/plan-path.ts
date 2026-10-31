import { homedir } from 'node:os';
import { isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getCapabilities, hyperlink } from '../../engine/public.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { sliceByColumn, visibleWidth } from '../../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';

const PLAN_PATH_LABEL = 'Plan  ';

/**
 * Display form of a Plan File path. Windows shells do not expand `~`, so only
 * POSIX hosts shorten the home directory.
 */
export function formatPlanPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const clean = sanitizeTerminalText(path).trim();
  if (platform === 'win32' || !home) return clean;
  if (clean === home) return '~';
  return clean.startsWith(`${home}${sep}`) ? `~${clean.slice(home.length)}` : clean;
}

/**
 * Plan File path rows: the full path is wrapped instead of truncated so it can
 * be copied intact, and each segment links to the same `file://` URL when the
 * terminal supports OSC 8.
 */
export function renderPlanPathRows(path: string | undefined, width: number): string[] {
  const absolute = sanitizeTerminalText(path ?? '').trim();
  if (!absolute || width <= 0) return [];
  const display = formatPlanPath(absolute);
  const labelWidth = visibleWidth(PLAN_PATH_LABEL);
  const segmentWidth = width > labelWidth + 8 ? width - labelWidth : width;
  const indent = segmentWidth === width ? '' : ' '.repeat(labelWidth);
  const href = planPathHref(absolute);
  const segments = splitByColumns(display, segmentWidth);
  return segments.map((segment, index) => {
    const styled = chalk.hex(colors.signal)(segment);
    const linked = href ? hyperlink(styled, href) : styled;
    const prefix = index === 0 && indent ? chalk.hex(colors.muted)(PLAN_PATH_LABEL) : indent;
    return `${prefix}${linked}`;
  });
}

function planPathHref(path: string): string | undefined {
  if (!getCapabilities().hyperlinks || !isAbsolute(path)) return undefined;
  try {
    return pathToFileURL(path).href;
  } catch {
    return undefined;
  }
}

function splitByColumns(text: string, width: number): string[] {
  const total = visibleWidth(text);
  if (total <= width) return [text];
  const segments: string[] = [];
  for (let start = 0; start < total; ) {
    const segment = sliceByColumn(text, start, width);
    const segmentWidth = visibleWidth(segment);
    // A wide character that does not fit the remaining columns still advances.
    if (segmentWidth === 0) {
      segments.push(sliceByColumn(text, start, width + 1));
      start += width + 1;
      continue;
    }
    segments.push(segment);
    start += segmentWidth;
  }
  return segments;
}
