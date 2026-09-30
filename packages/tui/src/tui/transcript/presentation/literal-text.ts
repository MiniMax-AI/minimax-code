import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { wrapTextWithAnsi } from '../../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';

/**
 * Wrap user-authored text for literal display in the transcript.
 *
 * A user prompt is quoted source, not assistant prose. Running it through the
 * Markdown renderer rewrites `__pycache__` into bold text with the underscores
 * dropped, turns `*` into emphasis, and folds a leading `>` into a quote, so
 * the echoed prompt stops matching what was typed. Codex keeps its user history
 * cells plain for the same reason and only renders assistant content as
 * Markdown. Every surface that shows a user prompt must use this helper so the
 * main rail, pending steers, and the transcript panel cannot drift apart.
 *
 * - Terminal control strings are stripped, matching the assistant path.
 * - Tabs expand to the 3-column form `visibleWidth` already assumes, so the
 *   rendered row and the width math agree. A literal tab would jump to the
 *   terminal's next tab stop and break a filled background.
 * - Trailing CR/LF are dropped, like Codex's user cell: a pasted prompt usually
 *   ends with a newline, which would otherwise add empty rows. Trailing spaces
 *   inside the text are left alone.
 * - Each row takes the theme text color explicitly. Leaving it to the terminal
 *   default foreground loses contrast when the palette appearance differs from
 *   the terminal's own, e.g. a light user band inside a dark terminal.
 *
 * Returns no rows when nothing printable is left, e.g. a prompt made only of
 * control sequences, so callers can keep their own empty-state rendering.
 */
export function wrapLiteralUserText(text: string, width: number): string[] {
  const normalized = sanitizeTerminalText(text)
    .replace(/\t/gu, '   ')
    .replace(/[\r\n]+$/u, '');
  if (!normalized.trim()) return [];
  const textColor = chalk.hex(colors.text);
  return wrapTextWithAnsi(normalized, Math.max(1, width)).map((line) =>
    line ? textColor(line) : line,
  );
}
