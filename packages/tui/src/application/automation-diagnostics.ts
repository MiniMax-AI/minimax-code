import { appendFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Explicit sink for automation forensics. Takes precedence over every derived
 * location so a harness can put the lines wherever it collects them.
 */
export const MCODE_TUI_DIAGNOSTIC_PATH_ENV = 'MCODE_TUI_DIAGNOSTIC_PATH';

/**
 * Public result-channel contract (see `packages/tui/docs/distribution.md`). Read
 * as a plain name so this module stays inside the application layer.
 */
const RESULT_PATH_ENV = 'MCODE_TUI_RESULT_PATH';

const DIAGNOSTIC_SUFFIX = '.diagnostics.log';

/**
 * Whether a harness explicitly asked for these lines by naming a sink.
 *
 * `mcode exec` promises an empty stderr on success (see
 * `test/cli/compiled-exec-cli.test.ts`), and its stderr is a pipe, not a terminal, so
 * the stderr fallback below would land answer forensics in the machine contract. Answer
 * selection diagnostics are therefore written only when the caller opted into a sink.
 */
export function tuiAutomationDiagnosticSinkConfigured(): boolean {
  return diagnosticPath() !== undefined;
}

/**
 * Writes an automation diagnostic line to the configured file sink, or to non-TTY
 * stderr when piped. Never writes to a TTY stderr, which would corrupt the TUI's
 * differential terminal renderer and leave stale `[V]` rows on screen.
 */
export function writeTuiAutomationDiagnostic(line: string): void {
  const text = line.endsWith('\n') ? line : `${line}\n`;
  const target = diagnosticPath();
  if (target) {
    try {
      appendFileSync(target, text, 'utf8');
      return;
    } catch {
      // Forensics must never alter execution; fall through to the safe cases.
    }
  }
  if (process.stderr.isTTY === true) return;
  try {
    process.stderr.write(text);
  } catch {
    // Diagnostics must never alter execution or answer selection.
  }
}

/**
 * Where forensics go when they must not touch the terminal. An explicit path
 * wins; otherwise they sit next to the result channel the harness already
 * collects, so an automated run keeps every line it used to get from the
 * container log.
 */
function diagnosticPath(): string | undefined {
  const explicit = process.env[MCODE_TUI_DIAGNOSTIC_PATH_ENV]?.trim();
  if (explicit) return explicit;
  const resultPath = process.env[RESULT_PATH_ENV]?.trim();
  if (!resultPath) return undefined;
  return path.join(path.dirname(resultPath), path.basename(resultPath) + DIAGNOSTIC_SUFFIX);
}
