/**
 * Text rules shared by everything that shows a PTC script description: the
 * `<run-code-scripts>` catalog, the `<saved-run-code-scripts>` task report and the
 * `// @description` header written into the file itself.
 */

/**
 * One line: control characters and newlines become spaces and runs of
 * whitespace collapse. A description comes from model output and from other
 * people's repositories, so it must never break the single-line shape.
 */
export function ptcScriptSingleLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * A description as it may appear inside a `<run-code-scripts>` or
 * `<saved-run-code-scripts>` block: one line, cut to `maxChars` characters, then
 * XML-escaped. Escaping rather than deleting keeps the meaning (`>=` stays
 * `>=` instead of becoming `=`) and still makes it impossible to close the
 * block's own tag from a description.
 */
export function ptcScriptDescriptionLine(value: string, maxChars: number): string {
  const oneLine = ptcScriptSingleLine(value);
  const cut = oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars - 1)}…`;
  return cut.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** The header line a saved script carries; the only place it is spelled. */
export const PTC_SCRIPT_DESCRIPTION_PREFIX = '// @description';

/**
 * The first line of `text`, and the index of the newline that ends it,
 * or -1 when there is none. The writer needs the index to replace that line and
 * the reader needs the line itself, so both take it from here.
 */
export function ptcScriptFirstLine(text: string): {
  readonly line: string;
  readonly end: number;
} {
  const end = text.indexOf('\n');
  return { line: end === -1 ? text : text.slice(0, end), end };
}

/**
 * The description a script's own first line carries, or undefined when that
 * line is not a `// @description` header. An empty string means the header is
 * there and says nothing: the writer still replaces such a line, while the
 * catalog lists the script without a description. Returned unescaped, because
 * it is the file's own header line and the renderers escape what they show.
 */
export function ptcScriptDescriptionFromFirstLine(text: string): string | undefined {
  const trimmed = ptcScriptFirstLine(text).line.trimStart();
  if (!trimmed.startsWith(PTC_SCRIPT_DESCRIPTION_PREFIX)) return undefined;
  return ptcScriptSingleLine(trimmed.slice(PTC_SCRIPT_DESCRIPTION_PREFIX.length));
}
