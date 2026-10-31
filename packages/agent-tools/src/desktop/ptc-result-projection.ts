import { withProgrammaticResult } from '@mavis/agent-core/tools';
import type {
  ProgrammaticToolResult,
  PtcChildCallStatus,
  PtcChildExecutionDetails,
  PtcExecutionDetails,
  PtcRetainedFact,
  PtcToolCallRecord,
  PtcToolExecutionOutcome,
  PtcToolResultProjection,
  PtcToolResultProjectionInput,
  PtcToolSource,
  ToolResult,
} from '@mavis/agent-core/tools';
import { redactSecretText } from '@mavis/shared/logging/redact-log-secret';
import { sanitizeObservabilityText } from '@mavis/shared/local-runtime-diagnostics/redaction';

/** Only final admitted builtin arguments may become durable model evidence. */
export function projectDesktopPtcEvidenceInput(
  input: PtcToolResultProjectionInput,
): Readonly<Record<string, unknown>> | undefined {
  if (input.source !== 'builtin' || !isRecord(input.args)) return undefined;
  const fields = ['read', 'write', 'edit'].includes(input.toolName)
    ? ['path', 'file_path', 'filePath']
    : input.toolName === 'bash'
      ? ['command']
      : ['task_query', 'task_output', 'task_stop'].includes(input.toolName)
        ? ['task_id']
        : [];
  const projected: Record<string, unknown> = {};
  const redactedFields: string[] = [];
  for (const field of fields) {
    const value = input.args[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    const safe = safeEvidenceText(value);
    projected[field] = safe;
    if (safe !== value) redactedFields.push(field);
  }
  if (Object.keys(projected).length === 0) return undefined;
  // These shared rules mask known patterns, not every possible secret.
  if (redactedFields.length > 0) projected.redacted_fields = redactedFields;
  return projected;
}

/** Drops guest/free text rather than moving rejected content into metadata. */
export function sanitizePtcExecutionDetailsForSafety(
  details: PtcExecutionDetails,
): PtcExecutionDetails {
  return {
    version: 1,
    child_calls: details.child_calls.map(safeEvidenceRecord),
    retained_facts: details.retained_facts.map(safeEvidenceFact),
  };
}

export function sanitizePtcChildExecutionDetailsForSafety(
  details: PtcChildExecutionDetails,
): PtcChildExecutionDetails {
  return {
    version: 1,
    record: safeEvidenceRecord(details.record),
    retained_facts: details.retained_facts.map(safeEvidenceFact),
  };
}

function safeEvidenceRecord(record: PtcToolCallRecord): PtcToolCallRecord {
  const input = projectDesktopPtcEvidenceInput({
    childToolCallId: record.child_tool_call_id,
    parentToolCallId: record.parent_tool_call_id,
    toolName: record.tool_name,
    source: 'builtin',
    status: record.status,
    args: record.input,
  });
  const previouslyRedacted = Array.isArray(record.input?.redacted_fields)
    ? record.input.redacted_fields.filter(
        (field): field is string =>
          typeof field === 'string' && input !== undefined && Object.hasOwn(input, field),
      )
    : [];
  return {
    child_tool_call_id: record.child_tool_call_id,
    parent_tool_call_id: record.parent_tool_call_id,
    tool_name: record.tool_name,
    status: record.status,
    ...(record.is_error === undefined ? {} : { is_error: record.is_error }),
    ...(record.outcome_unknown === undefined ? {} : { outcome_unknown: record.outcome_unknown }),
    ...(record.result_ref ? { result_ref: safeEvidenceText(record.result_ref) } : {}),
    ...(input
      ? {
          input: {
            ...input,
            ...(previouslyRedacted.length > 0
              ? {
                  redacted_fields: [
                    ...new Set([
                      ...previouslyRedacted,
                      ...(Array.isArray(input.redacted_fields)
                        ? (input.redacted_fields as string[])
                        : []),
                    ]),
                  ],
                }
              : {}),
          },
        }
      : {}),
  };
}

function safeEvidenceFact(fact: PtcRetainedFact): PtcRetainedFact {
  switch (fact.kind) {
    case 'terminate_agent':
      return { kind: fact.kind };
    case 'outcome_unknown':
      return { kind: fact.kind, child_tool_call_id: fact.child_tool_call_id };
    case 'child_error':
      return {
        kind: fact.kind,
        child_tool_call_id: fact.child_tool_call_id,
        code: fact.code,
        ...(fact.cancelled === undefined ? {} : { cancelled: fact.cancelled }),
      };
    case 'background_task':
      return {
        kind: fact.kind,
        child_tool_call_id: fact.child_tool_call_id,
        task_id: fact.task_id,
      };
    case 'bash_exit':
      return {
        kind: fact.kind,
        child_tool_call_id: fact.child_tool_call_id,
        exit_code: fact.exit_code,
      };
    case 'approval':
      return { kind: fact.kind, child_tool_call_id: fact.child_tool_call_id, status: fact.status };
    case 'plugin_feedback':
      return { kind: fact.kind, child_tool_call_id: fact.child_tool_call_id, phase: fact.phase };
    case 'budget_exceeded':
      return {
        kind: fact.kind,
        budget: fact.budget,
        // A count, never free text: safe to keep through safety reconciliation.
        ...(fact.refused_calls === undefined ? {} : { refused_calls: fact.refused_calls }),
      };
    case 'delivery_incomplete':
      return {
        kind: fact.kind,
        reason: fact.reason,
        ...(fact.reference ? { reference: safeEvidenceText(fact.reference) } : {}),
      };
    case 'media_delivery':
      return {
        kind: fact.kind,
        child_tool_call_id: fact.child_tool_call_id,
        status: fact.status,
        ...(fact.refs
          ? {
              refs: fact.refs
                .filter((ref) => !ref.uri.startsWith('data:'))
                .map((ref) => ({
                  uri: safeEvidenceText(ref.uri),
                  ...(ref.mimeType ? { mimeType: ref.mimeType } : {}),
                })),
            }
          : {}),
      };
    case 'truncation': {
      const hint = Object.fromEntries(
        Object.entries(sanitizeContinuation(fact.continuation) ?? {}).filter(
          ([key]) => key !== 'instruction',
        ),
      );
      const outputPath =
        typeof fact.continuation?.fullOutputPath === 'string'
          ? safeEvidenceText(fact.continuation.fullOutputPath)
          : undefined;
      const hasMore = fact.continuation?.has_more;
      const continuation = {
        ...hint,
        ...(outputPath ? { fullOutputPath: outputPath } : {}),
        ...(typeof hasMore === 'boolean' ? { has_more: hasMore } : {}),
      };
      return {
        kind: fact.kind,
        child_tool_call_id: fact.child_tool_call_id,
        truncated: fact.truncated,
        ...(Object.keys(continuation).length > 0 ? { continuation } : {}),
      };
    }
  }
}

function safeEvidenceText(value: string): string {
  return sanitizeObservabilityText(redactSecretText(value));
}

export interface DesktopPtcResultProjectionOptions {
  /** Host-owned parameter allowlist after admission; omitted means retain no input. */
  projectInput?: (
    input: PtcToolResultProjectionInput,
  ) => Readonly<Record<string, unknown>> | undefined;
  /** Host-owned artifact reference; raw child output never enters `details.ptc`. */
  projectResultRef?: (input: PtcToolResultProjectionInput) => string | undefined;
  /** Plugin/approval facts collected by the host's real hook chain. */
  projectRetainedFacts?: (input: PtcToolResultProjectionInput) => readonly PtcRetainedFact[];
}

/**
 * One word for a child result, checked before output or data. `failed` is
 * exactly `isError`; the rest are completed calls, ranked when several apply
 * (see desktopPtcGuestStatus). Strings, so a program compares names.
 */
export type DesktopPtcGuestStatus =
  | 'complete'
  | 'truncated'
  | 'resized'
  | 'omitted'
  | 'failed'
  | 'unverified';

export interface DesktopPtcGuestToolResult {
  readonly status: DesktopPtcGuestStatus;
  /**
   * Tool text: command output, file content, search hits, edit receipts.
   * Named after the common code-mode convention (`result.output`) because the
   * pilot showed models reading `.output` for command text; the previous
   * `text` name only mirrored Pi's `{ type: "text", text }` content blocks.
   */
  readonly output?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly refs?: readonly { readonly uri: string; readonly mimeType?: string }[];
  /** Only says whether `output` was cut; it never carries tool text itself. */
  readonly truncation: DesktopPtcGuestTruncation;
}

export interface DesktopPtcGuestTruncation {
  readonly truncated: boolean | 'unknown';
  readonly hasMore?: boolean;
  readonly nextOffset?: number;
  readonly offsetUnit?: string;
  readonly fullOutputPath?: string;
  readonly continuationHint?: Readonly<Record<string, unknown>>;
}

/**
 * Why a completed child output stays `unknown`. These codes exist only for
 * host logs; the durable fact format remains `truncated: 'true' | 'unknown'`.
 */
export type DesktopPtcTruncationUnknownReason =
  | 'non_builtin_source'
  | 'unverified_tool'
  | 'media_read'
  | 'unrecognized_read_result'
  | 'malformed_marker'
  | 'bash_missing_fields'
  // A verified builtin output without the tool's own completeness statement:
  // a return path that does not report, or a result a hook rewrote.
  | 'not_reported';

/** Why a child call carries no truncation fact at all. */
export type DesktopPtcTruncationSkipReason = 'not_completed' | 'background_bash';

export type DesktopPtcTruncationVerdict =
  | { readonly state: 'truncated' }
  | { readonly state: 'complete' }
  | { readonly state: 'unknown'; readonly reason: DesktopPtcTruncationUnknownReason }
  | { readonly state: 'skipped'; readonly reason: DesktopPtcTruncationSkipReason };

export interface DesktopPtcTruncationInput {
  readonly toolName: string;
  /** Host evidence source of the executed object, never a guest- or name-derived value. */
  readonly source?: PtcToolSource;
  /** Final result after after-tool hooks. */
  readonly result: unknown;
  /** Final child status; omitted means completed. */
  readonly status?: PtcChildCallStatus;
  /**
   * The tool's own programmatic payload. Agent Core passes it only when no
   * hook changed the result, so its completeness statement is the tool's.
   */
  readonly programmatic?: ProgrammaticToolResult;
}

type MarkerState = 'set' | 'clear' | 'absent' | 'malformed';

const TRUNCATED: DesktopPtcTruncationVerdict = { state: 'truncated' };
const COMPLETE: DesktopPtcTruncationVerdict = { state: 'complete' };

/** Native Computer Use tools, registered by local-runtime-v2 service/computer-use/tools.ts. */
const COMPUTER_USE_TOOLS = [
  'computer_app_list',
  'computer_window_list',
  'computer_display_list',
  'computer_window_set_frame',
  'computer_desktop_state',
  'computer_app_launch',
  'computer_app_activate',
  'computer_app_state',
  'computer_click',
  'computer_drag',
  'computer_type',
  'computer_set_value',
  'computer_select_text',
  'computer_key',
  'computer_scroll',
  'computer_secondary_action',
  'computer_verify_state',
] as const;

/**
 * Tool-specific truncation markers of builtin tools whose source writes a
 * structured marker on every path that drops output (verified 2026-10-12).
 * Every tool additionally gets the generic markers in `genericMarkers`.
 * Only for these tools does "no marker" prove a complete output; any other
 * tool keeps the §5.2 rule that missing metadata means `unknown`.
 */
type MarkerRule = (
  details: Readonly<Record<string, unknown>> | undefined,
) => readonly MarkerState[];

const VERIFIED_TOOL_MARKERS: ReadonlyMap<string, MarkerRule> = new Map<string, MarkerRule>([
  // grep (desktop/local-grep.ts, shared/grep-parse.ts):
  // - files_with_matches / count page beyond `limit` -> details.truncated
  //   (grep-parse.ts parseFilesOutput / parseCountOutput);
  // - content mode reached `limit` matches -> details.matchLimitReached = limit
  //   (a number, grep-parse.ts parseGrepOutput);
  // - content lines cut to 2000 chars -> details.linesTruncated;
  // - ripgrep 8 MiB stdout safety cap -> details.stdoutTruncated (local-grep.ts);
  // - content text over 16 KiB -> generic desktop_output_truncation. The 256 KiB
  //   parser cap only writes text, but it can only trigger above 16 KiB, where
  //   the generic marker is always written.
  [
    'grep',
    (details) => [
      booleanMarker(details, 'truncated'),
      numberMarker(details, 'matchLimitReached'),
      booleanMarker(details, 'linesTruncated'),
      booleanMarker(details, 'stdoutTruncated'),
    ],
  ],
  // glob (desktop/local-glob.ts): page beyond `limit` or ripgrep byte cap -> details.truncated.
  ['glob', (details) => [booleanMarker(details, 'truncated')]],
  // web_fetch (desktop/local-webfetch.ts): adapter cut or 16k-token clip ->
  // details.truncated (plus token_truncated for the clip).
  [
    'web_fetch',
    (details) => [booleanMarker(details, 'truncated'), booleanMarker(details, 'token_truncated')],
  ],
  // task_output (desktop/local-task-control.ts): bounded store read -> details.truncated;
  // its next_offset already reaches the guest through `data`.
  ['task_output', (details) => [booleanMarker(details, 'truncated')]],
  // task_query (desktop/local-task-control.ts): another page exists -> details.next_cursor.
  // The tool accepts no cursor, so this can only say that the list is partial.
  ['task_query', (details) => [cursorMarker(details, 'next_cursor')]],
  // The host never cuts these outputs: edit/write (desktop/local-pi-tools.ts and
  // Pi core/tools edit.ts/write.ts), todowrite (desktop/local-todowrite.ts),
  // task_stop (desktop/local-task-control.ts), web_search (desktop/local-web-search.ts),
  // session_create (desktop/local-session-create-tool.ts), self_reminder
  // (desktop/local-cron-tools.ts) and workspace_semantic_search
  // (desktop/local-workspace-semantic-search.ts).
  // memory (desktop/local-memory.ts) and mavis (desktop/local-mavis.ts) cut only
  // through their head+tail limits, which write the generic marker.
  ['edit', () => []],
  ['write', () => []],
  ['todowrite', () => []],
  ['task_stop', () => []],
  ['web_search', () => []],
  ['session_create', () => []],
  ['self_reminder', () => []],
  ['workspace_semantic_search', () => []],
  ['memory', () => []],
  ['mavis', () => []],
  // computer_* (local-runtime-v2 service/computer-use): the host never cuts
  // their text except by omitting a large application menu from
  // computer_app_state, which the tool reports itself as truncated.
  ...COMPUTER_USE_TOOLS.map((name) => [name, () => []] as const),
]);

/**
 * The single completeness decision shared by the guest `truncation` field,
 * durable audit facts and the run_code log, so the three never disagree.
 *
 * Trust: `source` must be the host evidence source. Local Runtime registers
 * it by native object identity at the trusted catalog boundary
 * (local-runtime-v2 execution/ptc/catalog.ts readPtcToolEvidenceSource) and
 * Agent Core checks it against the object it actually executed. The tool name
 * proves nothing: an MCP, plugin or configured tool may reuse "grep" or
 * "read" and return details that merely look like ours, so any non-builtin
 * evidence stays `unknown` even when such a field is present.
 */
export function classifyDesktopPtcTruncation(
  input: DesktopPtcTruncationInput,
): DesktopPtcTruncationVerdict {
  // Failed, denied and cancelled children delivered no output; their
  // child_error / approval facts already tell the model what happened.
  if (input.status !== undefined && input.status !== 'completed') {
    return { state: 'skipped', reason: 'not_completed' };
  }
  if (input.source !== 'builtin') return { state: 'unknown', reason: 'non_builtin_source' };
  const verdict = classifyDesktopToolOutput(input.toolName, input.result);
  // A cut marker, a media read or a malformed field decides on its own. What
  // no longer decides is the absence of a marker: "complete" now needs the
  // tool's own statement, so a return path that forgot to mark a cut (the
  // grep early return of 2026-10-12) shows up as unknown, not as complete.
  if (verdict.state !== 'complete') return verdict;
  return confirmedByToolReport(input.programmatic);
}

/** The per-tool marker rules confirmed on 2026-10-12, applied to one output. */
function classifyDesktopToolOutput(toolName: string, result: unknown): DesktopPtcTruncationVerdict {
  const details = resultDetails(result);
  if (toolName === 'bash') return classifyBashTruncation(details);
  if (toolName === 'read') return classifyReadTruncation(result, details);
  const toolMarkers = VERIFIED_TOOL_MARKERS.get(toolName);
  if (!toolMarkers) return { state: 'unknown', reason: 'unverified_tool' };
  return verdictFromMarkers([...genericMarkers(details), ...toolMarkers(details)]);
}

function confirmedByToolReport(
  programmatic: ProgrammaticToolResult | undefined,
): DesktopPtcTruncationVerdict {
  const report: unknown = programmatic?.completeness;
  if (report === undefined) return { state: 'unknown', reason: 'not_reported' };
  if (!isRecord(report) || typeof report.truncated !== 'boolean') {
    return { state: 'unknown', reason: 'malformed_marker' };
  }
  return report.truncated ? TRUNCATED : COMPLETE;
}

export interface DesktopCompletenessReportExtras {
  /** Structured data for PTC; must never show more than the text output. */
  readonly data?: Readonly<Record<string, unknown>>;
  /** Cursor of the next page when the output was complete but the source has more. */
  readonly more?: { readonly nextOffset: number; readonly offsetUnit: 'line' | 'match' | 'file' };
  /**
   * A PTC child skipped a cap that would have cut this output (see
   * isPtcChildCall in output-limit.ts). Reported as
   * `programmatic.uncappedOutput` for the run_code log only.
   */
  readonly uncappedOutput?: boolean;
}

/**
 * Called by each verified builtin tool on its return path: states whether
 * this output is complete, using the same per-tool rules the host applied
 * before, and attaches PTC data. Outputs it cannot judge (PDF, notebook and
 * video reads, Bash without stream flags, background receipts) get no
 * statement and stay unknown. Everything goes to the programmatic side channel, never to
 * details or content, so model calls and persisted results do not change.
 */
export function withDesktopCompletenessReport(
  toolName: string,
  result: ToolResult,
  extras: DesktopCompletenessReportExtras = {},
): ToolResult {
  const verdict = classifyDesktopToolOutput(toolName, result);
  const states = verdict.state === 'truncated' || verdict.state === 'complete';
  const prior = result.programmatic?.completeness;
  const more = verdict.state === 'complete' && extras.more ? { hasMore: true, ...extras.more } : {};
  if (!states && !extras.data && !extras.uncappedOutput) return result;
  return withProgrammaticResult(result, {
    ...(extras.data ? { data: extras.data } : {}),
    ...(extras.uncappedOutput ? { uncappedOutput: true } : {}),
    ...(states
      ? { completeness: { ...prior, ...more, truncated: verdict.state === 'truncated' } }
      : {}),
  });
}

/**
 * Guest projection for one Desktop child call. Text remains useful by
 * default; structured `data` comes from the tool's own programmatic payload
 * (present only when no hook rewrote the result), else from the per-tool
 * `details` allowlists below. A failed child keeps its text but only the
 * tool's own data: details of a failure are not a documented contract.
 * A native tool always has `data`, `{}` when it has nothing to say or its
 * result was rewritten, so the SDK can declare it as present.
 */
export function projectDesktopPtcToolResult(
  result: unknown,
  toolName: string,
  source?: PtcToolSource,
  options: DesktopPtcGuestProjectionOptions = {},
): DesktopPtcGuestToolResult {
  const shape = isRecord(result) ? result : undefined;
  const details = resultDetails(result);
  const output = textContent(shape?.content);
  const failed = options.status !== undefined && options.status !== 'completed';
  const native = source === 'builtin';
  const own = options.rewritten
    ? encodedReadImage(toolName, native, options.imageEncoding)
    : programmaticData(options.programmatic, options.onDataRejected);
  const data =
    own ??
    (failed || options.rewritten ? undefined : projectKnownData(toolName, details, source)) ??
    (native ? {} : undefined);
  const refs = projectRefs(details?.refs);
  const verdict = classifyDesktopPtcTruncation({
    toolName,
    ...(source ? { source } : {}),
    result,
    ...(options.status ? { status: options.status } : {}),
    ...(options.programmatic ? { programmatic: options.programmatic } : {}),
  });
  return {
    status: desktopPtcGuestStatus(failed, verdict, native && toolName === 'read' ? own : undefined),
    ...(output ? { output } : {}),
    ...(data ? { data } : {}),
    ...(refs.length > 0 ? { refs } : {}),
    truncation: projectGuestTruncation(verdict, details, options.programmatic),
  };
}

/**
 * A native read whose result was changed only by the host's request image
 * encoder (Agent Core checked that): the image as the model received it,
 * re-encoded (width/height are what was sent) or omitted. Any other tool, a
 * read that was not an image, or more than one changed image stays rewritten.
 */
function encodedReadImage(
  toolName: string,
  native: boolean,
  encoding: DesktopPtcGuestProjectionOptions['imageEncoding'],
): Readonly<Record<string, unknown>> | undefined {
  if (!native || toolName !== 'read' || encoding?.data?.kind !== 'image') return undefined;
  const [image, ...more] = encoding.images;
  return image && more.length === 0 ? { kind: 'image', ...image } : undefined;
}

/**
 * Ranks the conditions of one result: failed > omitted > truncated > resized >
 * unverified > complete. Image states come only from a native read's own data
 * (desktop/local-pi-tools.ts LocalReadTool), never from its wording.
 */
export function desktopPtcGuestStatus(
  failed: boolean,
  verdict: DesktopPtcTruncationVerdict,
  readData?: Readonly<Record<string, unknown>>,
): DesktopPtcGuestStatus {
  if (failed) return 'failed';
  const image = readData?.kind === 'image' ? readData : undefined;
  if (typeof image?.omittedReason === 'string') return 'omitted';
  if (verdict.state === 'truncated') return 'truncated';
  if (
    image &&
    (image.width !== image.originalWidth || image.height !== image.originalHeight) &&
    [image.width, image.height, image.originalWidth, image.originalHeight].every(isSafeInteger)
  ) {
    return 'resized';
  }
  // A background Bash receipt is its whole output (projectGuestTruncation).
  return verdict.state === 'unknown' ? 'unverified' : 'complete';
}

export interface DesktopPtcGuestProjectionOptions {
  /** The tool's own payload; Agent Core omits it when a hook or safety step changed the result. */
  readonly programmatic?: ProgrammaticToolResult;
  /** Final child status; omitted means completed. */
  readonly status?: PtcChildCallStatus;
  /** A hook or safety step changed the result; no structured field is exposed. */
  readonly rewritten?: boolean;
  /** With `rewritten`: the host image encoder was the only change (see encodedReadImage). */
  readonly imageEncoding?: PtcToolExecutionOutcome['imageEncoding'];
  /**
   * Called when the tool's own `data` is dropped because it is not a JSON
   * object (cycles, BigInt, a non-object). This layer holds no logger by
   * convention, so the caller records the decision.
   */
  readonly onDataRejected?: (reason: 'unserializable' | 'not_json_object') => void;
}

/**
 * `data` is always a JSON object. A copy is taken so the guest never shares
 * structure with a live tool result; anything JSON cannot carry is rejected
 * as a whole rather than silently altered.
 */
function programmaticData(
  programmatic: ProgrammaticToolResult | undefined,
  onRejected: DesktopPtcGuestProjectionOptions['onDataRejected'],
): Readonly<Record<string, unknown>> | undefined {
  const data = programmatic?.data;
  if (data === undefined) return undefined;
  if (!isRecord(data)) {
    onRejected?.('not_json_object');
    return undefined;
  }
  let copied: unknown;
  try {
    const json = JSON.stringify(data);
    copied = json === undefined ? undefined : JSON.parse(json);
  } catch {
    // Cycles or BigInt in a tool payload; the text output still carries the content.
    onRejected?.('unserializable');
    return undefined;
  }
  if (isRecord(copied)) return copied;
  // A toJSON() that returns a non-object.
  onRejected?.('not_json_object');
  return undefined;
}

/**
 * Projects only source-owned Desktop tool facts for PTC audit details. The
 * guest result stays outside this projection; callers must opt in to every
 * retained input field through `projectInput`.
 */
export function createDesktopPtcResultProjection(
  options: DesktopPtcResultProjectionOptions = {},
): PtcToolResultProjection {
  return {
    project(input) {
      const details = resultDetails(input.result);
      const projectedInput = options.projectInput?.(input);
      const resultRef = options.projectResultRef?.(input);
      const bashCompleted =
        input.toolName === 'bash' &&
        input.source === 'builtin' &&
        input.isError === true &&
        input.isErrorOrigin === 'tool' &&
        completedBashExit(details);
      // A nonzero Bash exit is a completed call (§5.4), so the completeness of
      // its output still matters; every other error status yields no fact.
      const verdict = classifyDesktopPtcTruncation({
        toolName: input.toolName,
        ...(input.source ? { source: input.source } : {}),
        result: input.result,
        status: bashCompleted ? 'completed' : input.status,
        ...(input.programmatic ? { programmatic: input.programmatic } : {}),
      });
      const facts = [
        ...truncationFacts(input.childToolCallId, verdict, details, input.programmatic),
        ...backgroundTaskFacts(input.childToolCallId, details),
        ...bashExitFacts(input.childToolCallId, input.toolName, input.source, details),
        ...(options.projectRetainedFacts?.(input) ?? []),
      ];
      return {
        ...(projectedInput ? { input: projectedInput } : {}),
        ...(resultRef ? { resultRef } : {}),
        ...(facts.length > 0 ? { retainedFacts: facts } : {}),
        ...(bashCompleted ? { status: 'completed' as const, isError: false } : {}),
      };
    },
  };
}

function resultDetails(result: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(result)) return undefined;
  return isRecord(result.details) ? result.details : undefined;
}

function textContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((block) => (isRecord(block) && typeof block.text === 'string' ? [block.text] : []))
    .join('\n');
  return text || undefined;
}

function projectKnownData(
  toolName: string,
  details: Readonly<Record<string, unknown>> | undefined,
  source: PtcToolSource | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!details) return undefined;
  switch (toolName) {
    case 'task_query':
      return pickJsonFields(details, ['task', 'count', 'tasks', 'next_cursor']);
    case 'task_output':
      return pickJsonFields(details, [
        'task_id',
        'status',
        'next_offset',
        'truncated',
        'timed_out',
        'effective_wait_ms',
        'wait_ms_clamped',
        'summary',
      ]);
    case 'task_stop':
      return pickJsonFields(details, ['task_id', 'status']);
    case 'bash': {
      if (source !== 'builtin') return undefined;
      const exitCode = bashExitCode(details);
      if (details.status === 'started' || details.status === 'auto_promoted') {
        return typeof details.task_id === 'string' && details.task_id
          ? { status: 'background', taskId: details.task_id }
          : { status: 'background' };
      }
      // "complete" like the result status; "background" says it is still running.
      return exitCode === undefined ? undefined : { status: 'complete', exitCode };
    }
    default:
      return undefined;
  }
}

function projectGuestTruncation(
  verdict: DesktopPtcTruncationVerdict,
  details: Readonly<Record<string, unknown>> | undefined,
  programmatic?: ProgrammaticToolResult,
): DesktopPtcGuestTruncation {
  const metadata = projectContinuationMetadata(details, programmatic);
  // A background Bash notice is itself the whole foreground output, so it is
  // complete; `not_completed` never reaches a guest and stays conservative.
  const truncated =
    verdict.state === 'truncated'
      ? true
      : verdict.state === 'unknown' ||
          (verdict.state === 'skipped' && verdict.reason === 'not_completed')
        ? 'unknown'
        : false;
  return {
    truncated,
    ...(metadata.hasMore === true || truncated === true ? { hasMore: true } : {}),
    ...(metadata.nextOffset === undefined ? {} : { nextOffset: metadata.nextOffset }),
    ...(metadata.offsetUnit ? { offsetUnit: metadata.offsetUnit } : {}),
    ...(metadata.fullOutputPath ? { fullOutputPath: metadata.fullOutputPath } : {}),
    ...(metadata.continuationHint ? { continuationHint: metadata.continuationHint } : {}),
  };
}

/**
 * Continuation fields only; whether the output was cut is decided by the
 * classifier. Detail cursors from a Desktop output cut are the most precise;
 * the tool's own completeness report (programmatic side channel) supplies the
 * rest, e.g. grep's match-limit page or the remaining lines after a read limit.
 */
function projectContinuationMetadata(
  details: Readonly<Record<string, unknown>> | undefined,
  programmatic?: ProgrammaticToolResult,
): {
  readonly hasMore?: boolean;
  readonly nextOffset?: number;
  readonly offsetUnit?: string;
  readonly fullOutputPath?: string;
  readonly continuationHint?: Readonly<Record<string, unknown>>;
} {
  const desktopTruncation =
    details && isRecord(details.desktop_output_truncation)
      ? details.desktop_output_truncation
      : undefined;
  const piTruncation = details && isRecord(details.truncation) ? details.truncation : undefined;
  const processOutput =
    details && isRecord(details.processOutput) ? details.processOutput : undefined;
  const desktopContinuation =
    details && isRecord(details.desktop_output_continuation)
      ? details.desktop_output_continuation
      : undefined;
  const continuationHint = desktopContinuation
    ? sanitizeContinuation(desktopContinuation)
    : desktopTruncation
      ? sanitizeContinuation(desktopTruncation.continuation_hint)
      : undefined;
  const fullOutputPath = firstNonEmptyString(
    details?.fullOutputPath,
    piTruncation?.fullOutputPath,
    processOutput?.rawOutputPath,
  );
  const reported = reportedContinuation(programmatic);
  const nextOffset =
    desktopTruncation && isSafeInteger(desktopTruncation.next_offset)
      ? desktopTruncation.next_offset
      : desktopContinuation && isSafeInteger(desktopContinuation.next_offset)
        ? desktopContinuation.next_offset
        : reported.nextOffset;
  const offsetUnit =
    desktopTruncation && typeof desktopTruncation.offset_unit === 'string'
      ? desktopTruncation.offset_unit
      : desktopContinuation && typeof desktopContinuation.offset_unit === 'string'
        ? desktopContinuation.offset_unit
        : reported.offsetUnit;
  return {
    ...(desktopTruncation?.has_more === true || reported.hasMore ? { hasMore: true } : {}),
    ...(nextOffset === undefined ? {} : { nextOffset }),
    ...(offsetUnit ? { offsetUnit } : {}),
    ...(fullOutputPath ? { fullOutputPath } : {}),
    ...(continuationHint ? { continuationHint } : {}),
  };
}

/** Cursor fields of a tool's completeness report; malformed values are ignored. */
function reportedContinuation(programmatic: ProgrammaticToolResult | undefined): {
  readonly hasMore: boolean;
  readonly nextOffset?: number;
  readonly offsetUnit?: string;
} {
  const report = programmatic?.completeness;
  if (!isRecord(report)) return { hasMore: false };
  const nextOffset = isSafeInteger(report.nextOffset) ? report.nextOffset : undefined;
  const offsetUnit =
    report.offsetUnit === 'line' || report.offsetUnit === 'match' || report.offsetUnit === 'file'
      ? report.offsetUnit
      : undefined;
  return {
    hasMore: report.hasMore === true,
    ...(nextOffset === undefined ? {} : { nextOffset }),
    ...(offsetUnit ? { offsetUnit } : {}),
  };
}

/**
 * bash keeps its pre-existing rule. Truncation markers: Desktop 24 KiB
 * head+tail cap -> generic desktop_output_truncation (desktop/local-pi-tools.ts
 * limitDesktopBashOutput); Pi spill to a temp file -> details.truncation
 * (Pi core/tools/bash.ts formatOutput); split-stream caps ->
 * processOutput.stdoutTruncated / stderrTruncated (bash.ts). Only both stream
 * flags false prove completeness, because shell operations that cannot split
 * streams omit processOutput and then leave no positive evidence.
 */
function classifyBashTruncation(
  details: Readonly<Record<string, unknown>> | undefined,
): DesktopPtcTruncationVerdict {
  // The started/auto_promoted receipt is the whole foreground output; the
  // background_task fact already says the task continues after run_code.
  if (details?.status === 'started' || details?.status === 'auto_promoted') {
    return { state: 'skipped', reason: 'background_bash' };
  }
  // Pi Bash with output accounting bounds the split stream snapshots separately
  // from the returned text, so only the text markers describe this output.
  if (isRecord(details?.output)) return verdictFromMarkers(genericMarkers(details));
  const processOutput = details?.processOutput;
  const streams: readonly MarkerState[] =
    processOutput === undefined
      ? ['absent', 'absent']
      : isRecord(processOutput)
        ? [
            booleanMarker(processOutput, 'stdoutTruncated'),
            booleanMarker(processOutput, 'stderrTruncated'),
          ]
        : ['malformed', 'malformed'];
  const markers = [...genericMarkers(details), ...streams];
  if (markers.includes('set')) return TRUNCATED;
  if (markers.includes('malformed')) return { state: 'unknown', reason: 'malformed_marker' };
  return streams.every((state) => state === 'clear')
    ? COMPLETE
    : { state: 'unknown', reason: 'bash_missing_fields' };
}

/**
 * read is verified on Pi's text path, which always records details.textFile
 * (Pi core/tools/read.ts). Its markers: Pi head limit of 2000 lines / 50 KB ->
 * details.truncation; Desktop 24 KiB cap -> generic desktop_output_truncation
 * (desktop/local-pi-tools.ts limitDesktopReadTextResult); lines cut to 2000
 * chars -> details.line_truncations (shared/read-result.ts).
 *
 * Pi's image path is complete by construction: it sends the whole image
 * (resized above 2000x2000, with the size said in the text) or omits it with
 * a text-only reason; there is no partial image. Whether the image reached
 * the model, or was downgraded by the media budget, is reported separately
 * as media delivery. Saying "did not report whether it was truncated" on
 * every image read was noise (GDPval63 smoke: 31 PNG reads, all delivered).
 * The omitted-image placeholder carries no structured marker, so it stays
 * unknown below rather than being recognised by its wording.
 *
 * PDF (details.pdf, shared/read-pdf.ts), notebook (details.notebook,
 * shared/read-notebook.ts) and video (details.media, shared/read-video.ts)
 * can stop part-way and mention cuts only in text, so they stay unknown.
 */
function classifyReadTruncation(
  result: unknown,
  details: Readonly<Record<string, unknown>> | undefined,
): DesktopPtcTruncationVerdict {
  const markers = [...genericMarkers(details), lineTruncationsMarker(details)];
  if (markers.includes('set')) return TRUNCATED;
  if (isWholeImageRead(result, details)) return verdictFromMarkers(markers);
  if (isMediaReadResult(result, details)) return { state: 'unknown', reason: 'media_read' };
  // Without Pi's text-file fact this is not the verified text path, for
  // example an omitted-image placeholder or a hook-replaced result.
  if (!isRecord(details?.textFile)) return { state: 'unknown', reason: 'unrecognized_read_result' };
  return verdictFromMarkers(markers);
}

/**
 * Pi's image read: no PDF / notebook / video facts, and every non-text block
 * is an `image/*` image (video reads reuse the image block with `video/*`).
 */
function isWholeImageRead(
  result: unknown,
  details: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (details?.pdf !== undefined || details?.notebook !== undefined) return false;
  if (details?.media !== undefined) return false;
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const media = content.filter((block) => !isRecord(block) || block.type !== 'text');
  return (
    media.length > 0 &&
    media.every(
      (block) =>
        isRecord(block) &&
        block.type === 'image' &&
        typeof block.mimeType === 'string' &&
        block.mimeType.startsWith('image/'),
    )
  );
}

function isMediaReadResult(
  result: unknown,
  details: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (details?.pdf !== undefined || details?.notebook !== undefined) return true;
  if (details?.media !== undefined) return true;
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  return content.some((block) => isRecord(block) && block.type !== 'text');
}

/** Markers any builtin tool may carry from the shared Desktop and Pi output limits. */
function genericMarkers(
  details: Readonly<Record<string, unknown>> | undefined,
): readonly MarkerState[] {
  return [
    // desktop/output-limit.ts applyDesktopTextLimit writes `truncated: true` only.
    truncatedRecordMarker(details?.desktop_output_truncation),
    // Pi's TruncationResult (Pi core/tools/truncate.ts) carries a boolean `truncated`.
    truncatedRecordMarker(details?.truncation),
  ];
}

function verdictFromMarkers(markers: readonly MarkerState[]): DesktopPtcTruncationVerdict {
  // One real cut wins: a lower layer can never reset a higher one to complete (§5.2).
  if (markers.includes('set')) return TRUNCATED;
  if (markers.includes('malformed')) return { state: 'unknown', reason: 'malformed_marker' };
  return COMPLETE;
}

function truncatedRecordMarker(value: unknown): MarkerState {
  if (value === undefined) return 'absent';
  return isRecord(value) ? booleanMarker(value, 'truncated') : 'malformed';
}

function booleanMarker(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string,
): MarkerState {
  const value = record?.[key];
  if (value === undefined) return 'absent';
  if (typeof value !== 'boolean') return 'malformed';
  return value ? 'set' : 'clear';
}

/** grep stores the reached match limit itself, so any finite number means "cut". */
function numberMarker(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string,
): MarkerState {
  const value = record?.[key];
  if (value === undefined) return 'absent';
  return typeof value === 'number' && Number.isFinite(value) ? 'set' : 'malformed';
}

function cursorMarker(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string,
): MarkerState {
  const value = record?.[key];
  if (value === undefined) return 'absent';
  return typeof value === 'string' && value.length > 0 ? 'set' : 'malformed';
}

function lineTruncationsMarker(
  details: Readonly<Record<string, unknown>> | undefined,
): MarkerState {
  const value = details?.line_truncations;
  if (value === undefined) return 'absent';
  if (!Array.isArray(value) || !value.every(isSafeInteger)) return 'malformed';
  return value.length > 0 ? 'set' : 'clear';
}

function projectRefs(
  value: unknown,
): readonly { readonly uri: string; readonly mimeType?: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.uri !== 'string' || !entry.uri) return [];
    return [
      {
        uri: entry.uri,
        ...(typeof entry.mimeType === 'string' && entry.mimeType
          ? { mimeType: entry.mimeType }
          : {}),
      },
    ];
  });
}

function pickJsonFields(
  details: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  const selected = Object.fromEntries(
    fields.flatMap((field) => {
      const value = copyJsonValue(details[field]);
      return value === undefined ? [] : [[field, value] as const];
    }),
  );
  return Object.keys(selected).length > 0 ? selected : undefined;
}

function copyJsonValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (depth >= 8) return undefined;
  if (Array.isArray(value)) {
    return value.length <= 1000
      ? value.map((item) => copyJsonValue(item, depth + 1)).filter((item) => item !== undefined)
      : undefined;
  }
  if (!isRecord(value) || Object.keys(value).length > 1000) return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const copied = copyJsonValue(item, depth + 1);
      return copied === undefined ? [] : [[key, copied] as const];
    }),
  );
}

function bashExitCode(details: Readonly<Record<string, unknown>>): number | null | undefined {
  const direct = details.exitCode;
  if (isSafeInteger(direct)) return direct;
  if (direct === null) return null;
  const processOutput = isRecord(details.processOutput) ? details.processOutput : undefined;
  // Pi Bash states the exit in `execution` for success and failure alike.
  const execution = isRecord(details.execution) ? details.execution : undefined;
  const exitCode =
    processOutput && 'exitCode' in processOutput ? processOutput.exitCode : execution?.exitCode;
  return isSafeInteger(exitCode) ? exitCode : exitCode === null ? null : undefined;
}

function completedBashExit(details: Readonly<Record<string, unknown>> | undefined): boolean {
  if (!details) return false;
  const exitCode = bashExitCode(details);
  return isSafeInteger(exitCode) && exitCode !== 0;
}

/** Durable facts exist only for real cuts and for completed outputs we cannot judge. */
function truncationFacts(
  childToolCallId: string,
  verdict: DesktopPtcTruncationVerdict,
  details: Readonly<Record<string, unknown>> | undefined,
  programmatic?: ProgrammaticToolResult,
): readonly PtcRetainedFact[] {
  if (verdict.state !== 'truncated' && verdict.state !== 'unknown') return [];
  const output = projectGuestTruncation(verdict, details, programmatic);
  const continuation = {
    ...(output.continuationHint ?? {}),
    ...(output.fullOutputPath ? { fullOutputPath: output.fullOutputPath } : {}),
    ...(output.nextOffset === undefined ? {} : { next_offset: output.nextOffset }),
    ...(output.offsetUnit === undefined ? {} : { offset_unit: output.offsetUnit }),
    ...(output.hasMore === undefined ? {} : { has_more: output.hasMore }),
  };
  return [
    {
      kind: 'truncation',
      child_tool_call_id: childToolCallId,
      truncated: verdict.state === 'truncated' ? 'true' : 'unknown',
      ...(Object.keys(continuation).length > 0 ? { continuation } : {}),
    },
  ];
}

function backgroundTaskFacts(
  childToolCallId: string,
  details: Readonly<Record<string, unknown>> | undefined,
): readonly PtcRetainedFact[] {
  if (!details || (details.status !== 'started' && details.status !== 'auto_promoted')) return [];
  return typeof details.task_id === 'string' && details.task_id
    ? [{ kind: 'background_task', child_tool_call_id: childToolCallId, task_id: details.task_id }]
    : [];
}

function bashExitFacts(
  childToolCallId: string,
  toolName: string,
  source: PtcToolSource | undefined,
  details: Readonly<Record<string, unknown>> | undefined,
): readonly PtcRetainedFact[] {
  if (toolName !== 'bash' || source !== 'builtin' || !details) return [];
  const exitCode = bashExitCode(details);
  return typeof exitCode === 'number' && exitCode !== 0
    ? [{ kind: 'bash_exit', child_tool_call_id: childToolCallId, exit_code: exitCode }]
    : [];
}

function sanitizeContinuation(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  const hint = isRecord(value.continuation_hint) ? value.continuation_hint : value;
  const tool = typeof hint.tool === 'string' ? hint.tool : undefined;
  const instruction = typeof hint.instruction === 'string' ? hint.instruction : undefined;
  const preserveArgs = Array.isArray(hint.preserve_args)
    ? hint.preserve_args.filter((arg): arg is string => typeof arg === 'string')
    : undefined;
  const nextOffset =
    hint === value && isSafeInteger(value.next_offset) ? value.next_offset : undefined;
  const offsetUnit =
    hint === value && typeof value.offset_unit === 'string' ? value.offset_unit : undefined;
  if (!tool && !instruction && !preserveArgs && nextOffset === undefined && !offsetUnit)
    return undefined;
  return {
    ...(tool ? { tool } : {}),
    ...(instruction ? { instruction } : {}),
    ...(preserveArgs ? { preserve_args: preserveArgs } : {}),
    ...(nextOffset === undefined ? {} : { next_offset: nextOffset }),
    ...(offsetUnit ? { offset_unit: offsetUnit } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}
