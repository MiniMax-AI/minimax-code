import { formatSavedPtcScripts } from './saved-ptc-scripts.js';
import type { LocalTaskRunResult, ModelVerdict } from './types.js';

interface VerdictCandidate {
  readonly lineIndexes: readonly number[];
  readonly token?: ModelVerdict;
}

/** Product-visible scope of file-change capture; this is not a write barrier. */
export const FILE_CHANGE_OBSERVATION_NOTICE =
  'best-effort observation only; not a filesystem sandbox or security boundary; no_observed_change does not prove that no write occurred';

/**
 * Parse the one model-owned verification verdict line.
 *
 * Candidate lines are counted before validating their payload. This makes a
 * valid line plus a malformed (or indented) `VERDICT:` line ambiguous instead
 * of silently accepting the first parseable verdict.
 */
export function parseModelVerdict(text: string): ModelVerdict | undefined {
  const candidates = verdictCandidates(text.split(/\r?\n/u));
  if (candidates.length === 0 || candidates.some((candidate) => !candidate.token)) {
    return undefined;
  }
  const [first] = candidates;
  return candidates.every((candidate) => candidate.token === first?.token)
    ? first?.token
    : undefined;
}

/** True when a line starts a verdict candidate after common Markdown decoration is removed. */
export function isModelVerdictCandidateLine(line: string): boolean {
  return candidatePayload(line) !== undefined;
}

/**
 * Remove the same verdict candidates accepted by {@link parseModelVerdict}.
 * The Goal adapter persists this prose as its reason, so parsing and durable
 * reason cleanup cannot drift into two different grammars.
 */
export function stripModelVerdictCandidates(text: string): string {
  const lines = text.split(/\r?\n/u);
  const removed = new Set(
    verdictCandidates(lines).flatMap((candidate) => [...candidate.lineIndexes]),
  );
  return lines
    .filter((_line, index) => !removed.has(index))
    .join('\n')
    .trim();
}

function verdictCandidates(lines: readonly string[]): readonly VerdictCandidate[] {
  const candidates: VerdictCandidate[] = [];
  lines.forEach((line, lineIndex) => {
    const payload = candidatePayload(line);
    if (payload === undefined) return;
    if (payload !== null) {
      candidates.push({ lineIndexes: [lineIndex], token: verdictToken(payload) });
      return;
    }
    const valueLineIndex = nextNonEmptyLine(lines, lineIndex + 1);
    candidates.push({
      lineIndexes: valueLineIndex === undefined ? [lineIndex] : [lineIndex, valueLineIndex],
      ...(valueLineIndex === undefined ? {} : { token: verdictToken(lines[valueLineIndex] ?? '') }),
    });
  });
  return candidates;
}

/** null means a bare `VERDICT` label whose value is on the next non-empty line. */
function candidatePayload(line: string): string | null | undefined {
  const normalized = stripLeadingDecoration(line);
  const inline = /^VERDICT\s*:(.*)$/iu.exec(normalized);
  if (inline) return inline[1] ?? '';
  return /^VERDICT(?:\s*(?:\*{1,2}|_{1,2}|`{1,3}|~{2}))*\s*$/iu.test(normalized) ? null : undefined;
}

function stripLeadingDecoration(line: string): string {
  let value = line.trimStart();
  for (;;) {
    const previous = value;
    value = value
      .replace(/^(?:>\s*)+/u, '')
      .replace(/^(?:[-+*]|\d+[.)])\s+/u, '')
      .replace(/^#{1,6}\s*/u, '')
      .replace(/^(?:\*{1,2}|_{1,2}|`{1,3}|~{2})\s*/u, '');
    if (value === previous) return value;
  }
}

function verdictToken(payload: string): ModelVerdict | undefined {
  const match = /^[\s*_`~([{<]*(PASS|FAIL|PARTIAL)(?![\p{L}\p{N}_])/iu.exec(payload);
  const token = match?.[1]?.toLowerCase() as ModelVerdict | undefined;
  if (!token || !match) return undefined;
  const tail = payload.slice(match[0].length);
  const uppercaseTokens = tail.match(/(?<![\p{L}\p{N}_])(?:PASS|FAIL|PARTIAL)(?![\p{L}\p{N}_])/gu);
  if (uppercaseTokens?.some((candidate) => candidate.toLowerCase() !== token)) return undefined;
  return token;
}

function nextNonEmptyLine(lines: readonly string[], from: number): number | undefined {
  for (let index = from; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim().length > 0) return index;
  }
  return undefined;
}

/**
 * Render the raw child facts that the parent Agent should receive.
 *
 * This formatter deliberately only serializes facts already present on the
 * result. It never compares the model verdict with file observations and does
 * not synthesize a second status.
 */
export function formatLocalTaskParentReport(result: LocalTaskRunResult): string {
  const verification = result.verification;
  const changedFiles = verification?.changedFiles ?? [];
  const observationNotes = verification?.observationNotes ?? [];

  const report = [
    `run_status: ${result.status}`,
    `requested_agent_name: ${result.requestedAgentName}`,
    `resolved_agent_name: ${result.resolvedAgentName ?? 'missing'}`,
    `model_verdict: ${verification?.modelVerdict ?? 'missing'}`,
    `file_change: ${verification?.fileChange ?? 'missing'}`,
    `file_change_limitations: ${FILE_CHANGE_OBSERVATION_NOTICE}`,
    `changed_files: ${changedFiles.length > 0 ? changedFiles.join(', ') : 'none'}`,
    `observation_notes: ${observationNotes.length > 0 ? observationNotes.join(' | ') : 'none'}`,
    'final_text:',
    result.finalText ?? '',
    `error_message: ${result.errorMessage ?? ''}`,
  ].join('\n');
  // Absent when the child saved nothing, so today's report stays byte-identical.
  const savedScripts = formatSavedPtcScripts(result.savedPtcScripts);
  return savedScripts ? `${report}\n${savedScripts}` : report;
}
