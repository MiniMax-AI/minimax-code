import { createHash } from 'node:crypto';

import type { PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';

/**
 * Prompt-prefix fingerprints of PTC-mode Session Turns, for logs only.
 *
 * A Session fixes its tool call mode at creation and changes it only after a
 * committed summary (`llm_checkpoint`) compaction, so PTC must not change the
 * prefix between compactions where the native catalog would not: the PTC
 * section of the system prompt, the tools array sent to the model and the
 * run_code declaration. Changes the
 * native catalog makes too (the user toggling a built-in tool, Computer Use,
 * an MCP server or Plugin, or the model mid-conversation) are allowed, as in
 * native mode. The hashes go on the `ptc admission` line; a Turn whose PTC
 * output differs from the previous Turn of the same Session while the native
 * catalog stayed the same, with no committed compaction in between, writes one
 * `ptc prefix changed` warn. Nothing here changes what the model sees, and
 * content never reaches a log, only truncated sha256 digests.
 */

/** Truncated sha256 of each prefix part of one Turn. */
export interface PtcPrefixFingerprint {
  /** The catalog this Turn lists without PTC (buildPtcCatalog's input). */
  readonly native_catalog_sha: string;
  /** Reference only: the whole final system prompt. */
  readonly system_prompt_sha: string;
  /** The PTC section of the system prompt; `none` when the prompt has none. */
  readonly ptc_section_sha: string;
  /** The tools array exactly as sent. */
  readonly tools_sha: string;
  /** `none` when the catalog has no run_code. */
  readonly run_code_sha: string;
}

/** A PTC output part that may change only when the native catalog changes too. */
type PtcPrefixPart = 'ptc_section' | 'tools' | 'run_code';

interface ToolDeclarationSource {
  readonly def: {
    readonly name: string;
    readonly description?: string;
    readonly schema?: unknown;
  };
}

/** The request prefix as the executor sends it, plus the catalog it would list without PTC. */
export interface PtcPrefixInput {
  readonly systemPrompt: string;
  /** Final tools in send order. */
  readonly tools: readonly ToolDeclarationSource[];
  readonly nativeCatalog: readonly ToolDeclarationSource[];
}

interface Baseline {
  readonly turnId: string;
  readonly fingerprint: PtcPrefixFingerprint;
}

/** Sessions remembered per process; the least recently observed one is dropped first. */
const MAX_TRACKED_SESSIONS = 512;
const DIGEST_LENGTH = 16;
/**
 * First line of the local-only `_v2/PTC_TOOL_CALLS.md.hbs`; every template
 * inserts the section right before its `# Harness` heading.
 */
const PTC_SECTION_HEADING = '# Tool calls in this turn (PTC)';
const SECTION_END = '\n# Harness';

const baselines = new Map<string, Baseline>();

export function fingerprintPtcPrefix(prefix: PtcPrefixInput): PtcPrefixFingerprint {
  const runCode = prefix.tools.find((tool) => tool.def.name === 'run_code');
  const section = ptcSections(prefix.systemPrompt);
  return {
    native_catalog_sha: digest(declarations(prefix.nativeCatalog)),
    system_prompt_sha: digest(prefix.systemPrompt),
    ptc_section_sha: section === undefined ? 'none' : digest(section),
    tools_sha: digest(declarations(prefix.tools)),
    run_code_sha: runCode
      ? digest(
          JSON.stringify({
            description: runCode.def.description ?? '',
            parameters: runCode.def.schema ?? null,
          }),
        )
      : 'none',
  };
}

/**
 * Remembers this Turn's fingerprint as the Session's baseline and warns when a
 * PTC output differs from the previous Turn's under the same native catalog.
 * The first Turn after a process start, a committed compaction or an eviction
 * only sets the baseline.
 */
export function comparePtcPrefix(
  input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly source: string;
    readonly fingerprint: PtcPrefixFingerprint;
  },
  logger: Pick<PiTurnRunnerLogger, 'warn'> | undefined,
): void {
  const previous = baselines.get(input.sessionId);
  baselines.delete(input.sessionId);
  baselines.set(input.sessionId, { turnId: input.turnId, fingerprint: input.fingerprint });
  evictOldest();
  if (!previous) return;
  // The native catalog changed too: native mode would send a new prefix as well.
  if (previous.fingerprint.native_catalog_sha !== input.fingerprint.native_catalog_sha) return;
  const changed = changedParts(previous.fingerprint, input.fingerprint);
  if (changed.length === 0) return;
  try {
    logger?.warn?.(
      {
        session_id: input.sessionId,
        turn_id: input.turnId,
        previous_turn_id: previous.turnId,
        source: input.source,
        changed,
      },
      'ptc prefix changed',
    );
  } catch {
    // Diagnostics must not affect the Turn.
  }
}

/**
 * Drops the Session's baseline. A committed summary compaction may switch the
 * tool call mode and any committed compaction rewrites the history, so the next
 * Turn starts a new baseline; a deleted Session has no next Turn.
 */
export function resetPtcPrefixBaseline(sessionId: string): void {
  baselines.delete(sessionId);
}

function changedParts(
  previous: PtcPrefixFingerprint,
  current: PtcPrefixFingerprint,
): PtcPrefixPart[] {
  return [
    ...(previous.ptc_section_sha === current.ptc_section_sha ? [] : (['ptc_section'] as const)),
    ...(previous.tools_sha === current.tools_sha ? [] : (['tools'] as const)),
    ...(previous.run_code_sha === current.run_code_sha ? [] : (['run_code'] as const)),
  ];
}

/** Every PTC section in the prompt (a layered prompt may carry it more than once), joined. */
function ptcSections(systemPrompt: string): string | undefined {
  const sections: string[] = [];
  let start = systemPrompt.indexOf(PTC_SECTION_HEADING);
  while (start >= 0) {
    const end = systemPrompt.indexOf(SECTION_END, start);
    sections.push(systemPrompt.slice(start, end < 0 ? undefined : end));
    if (end < 0) break;
    start = systemPrompt.indexOf(PTC_SECTION_HEADING, end);
  }
  return sections.length > 0 ? sections.join('\n') : undefined;
}

function declarations(tools: readonly ToolDeclarationSource[]): string {
  return JSON.stringify(
    tools.map(({ def }) => ({
      name: def.name,
      description: def.description ?? '',
      parameters: def.schema ?? null,
    })),
  );
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, DIGEST_LENGTH);
}

function evictOldest(): void {
  while (baselines.size > MAX_TRACKED_SESSIONS) {
    const oldest = baselines.keys().next();
    if (oldest.done) return;
    baselines.delete(oldest.value);
  }
}
