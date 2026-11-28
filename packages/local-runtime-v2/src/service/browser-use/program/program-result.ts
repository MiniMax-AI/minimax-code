import type { ToolResult, ToolResultContent } from '@mavis/agent-core/tools';
import { BROWSER_PROGRAM_MAX_TIMEOUT_MS } from '@mavis/agent-tools/desktop';

import type { BrowserProgramFailure } from './worker-protocol.js';

const MAX_LISTED_WRITES = 30;
const MAX_STEP_URL_CHARS = 200;
const MAX_RETURN_TEXT_BYTES = 64 * 1024;

/**
 * The audit record of one page script as Browser Core reports it on the step
 * (`ProgramPageScriptAudit` in `@mavis/browser-core`): its code (first 4 KB)
 * and what it did while it ran.
 */
interface BrowserProgramPageScript {
  readonly source: string;
  readonly sourceTruncated?: true;
  readonly calls?: number;
  readonly origin: string;
  readonly durationMs: number;
  readonly mutations: number;
  readonly submits: number;
  readonly requests: readonly {
    readonly method: string;
    readonly url: string;
    readonly blocked?: true;
  }[];
  readonly requestCount: number;
  readonly nonGetRequests: number;
  readonly blockedRequests: number;
  readonly navigation?: Readonly<Record<string, unknown>>;
  readonly writeLike: boolean;
}

/** One page operation as the run_script result records it. */
export interface BrowserProgramStep {
  readonly op: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly target?: string;
  /** The tab the op acted on (a new page's tab for newPage). */
  readonly tabId?: number;
  readonly code?: string;
  readonly url?: string;
  readonly write?: true;
  readonly outcome?: string;
  /** A read that returned while a main-frame load was pending: it shows the page before that load. */
  readonly pendingNavigation?: true;
  /** Page JavaScript only: the code it ran and its effects, kept for the audit trail. */
  readonly pageScript?: BrowserProgramPageScript;
  /** The op wrote a page of this session that was not the controlled tab and took control of it. */
  readonly leaseTaken?: true;
  /** A popup closed itself during the op and control went back to this tab, its opener. */
  readonly leaseReturnedTo?: number;
}

/** What a finished (or stopped) program reports back to the model. */
export interface BrowserProgramReport {
  readonly ok: boolean;
  readonly valueJson?: string;
  readonly failure?: BrowserProgramFailure;
  /** Why the host ended the program before the guest did. */
  readonly stopNote?: string;
  readonly steps: readonly BrowserProgramStep[];
  /** Ops that started and gave no answer by the report (still running, or failed in the host). */
  readonly unfinishedOps: readonly string[];
  readonly refusedOps: number;
  /** The page-operation limit this program ran under. */
  readonly opLimit: number;
  /** The time limit this program ran under. */
  readonly timeoutMs: number;
  readonly wallMs: number;
  /** Op time on the page (Browser Core) and round trips as the Worker saw them. */
  readonly opMs: number;
  readonly opRoundTripMs: number;
  readonly console: string;
  readonly consoleTruncated: boolean;
  readonly stateNote?: string;
  readonly media: readonly ToolResultContent[];
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** How a write ended, in the words the result lists it with; undefined for a read. */
function writeOutcome(
  result: Readonly<Record<string, unknown>>,
  step: Readonly<Record<string, unknown>>,
  error: Readonly<Record<string, unknown>>,
  code: string | undefined,
): string | undefined {
  if (step.write !== true) return undefined;
  const label = code ?? 'error';
  if (result.ok !== true) {
    return error.writeOutcomeUnknown === true ? `outcome unknown (${label})` : `failed (${label})`;
  }
  const navigation = readRecord(step.navigation);
  if (navigation.pending === true) return 'ok, page still loading';
  return navigation.detected === true ? 'ok, navigated' : 'ok';
}

/** The step's page script audit, field by field; undefined when it is not one. */
function pageScriptAudit(value: unknown): BrowserProgramPageScript | undefined {
  const audit = readRecord(value);
  const count = (key: string): number => {
    const field = audit[key];
    return typeof field === 'number' ? field : 0;
  };
  if (typeof audit.source !== 'string' || typeof audit.origin !== 'string') return undefined;
  const requests = Array.isArray(audit.requests) ? audit.requests.map(readRecord) : [];
  const navigation = readRecord(audit.navigation);
  return {
    source: audit.source,
    ...(audit.sourceTruncated === true ? { sourceTruncated: true as const } : {}),
    ...(typeof audit.calls === 'number' ? { calls: audit.calls } : {}),
    origin: audit.origin,
    durationMs: count('durationMs'),
    mutations: count('mutations'),
    submits: count('submits'),
    requests: requests.map((request) => ({
      method: stringField(request, 'method') ?? 'GET',
      url: stringField(request, 'url') ?? '',
      ...(request.blocked === true ? { blocked: true as const } : {}),
    })),
    requestCount: count('requestCount'),
    nonGetRequests: count('nonGetRequests'),
    blockedRequests: count('blockedRequests'),
    ...(Object.keys(navigation).length > 0 ? { navigation } : {}),
    writeLike: audit.writeLike === true,
  };
}

/** A tab id as hosts send it; undefined for anything else. */
function tabIdOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

/**
 * The tab an op acted on: Browser Core's step, else the op's own tabId or its
 * locator's (the guest sends one with every page op), else a new page's tab.
 */
function stepTab(
  name: string,
  result: Readonly<Record<string, unknown>>,
  step: Readonly<Record<string, unknown>>,
  op: Readonly<Record<string, unknown>>,
): Pick<BrowserProgramStep, 'tabId'> {
  const tabId =
    tabIdOf(step.tabId) ??
    tabIdOf(op.tabId) ??
    tabIdOf(readRecord(op.target).tabId) ??
    (name === 'newPage' && result.ok === true ? tabIdOf(readRecord(result.value).tabId) : undefined);
  return tabId === undefined ? {} : { tabId };
}

/** The lease fields of a step: an op that took control of a tab, or a popup that gave it back. */
function stepLease(
  result: Readonly<Record<string, unknown>>,
): Pick<BrowserProgramStep, 'leaseTaken' | 'leaseReturnedTo'> {
  const leaseReturnedTo = tabIdOf(result.leaseReturnedTo);
  return {
    ...(result.leaseTaken === true ? { leaseTaken: true as const } : {}),
    ...(leaseReturnedTo === undefined ? {} : { leaseReturnedTo }),
  };
}

/**
 * The step record of one op result, as Browser Core (or the host) reported
 * it; `op` is the op the guest sent, which names its tab when the result does not.
 */
export function browserProgramStep(
  name: string,
  result: Readonly<Record<string, unknown>>,
  op: Readonly<Record<string, unknown>> = {},
): BrowserProgramStep {
  const step = readRecord(result.step);
  const error = readRecord(result.error);
  const target = stringField(step, 'target');
  const code = stringField(step, 'code') ?? stringField(error, 'code');
  const url = stringField(step, 'url')?.slice(0, MAX_STEP_URL_CHARS);
  const outcome = writeOutcome(result, step, error, code);
  const pageScript = pageScriptAudit(step.pageScript);
  return {
    op: name,
    ok: result.ok === true,
    durationMs: typeof step.durationMs === 'number' ? step.durationMs : 0,
    ...(target ? { target } : {}),
    ...stepTab(name, result, step, op),
    ...(code ? { code } : {}),
    ...(url ? { url } : {}),
    ...(step.write === true ? { write: true as const } : {}),
    ...(outcome ? { outcome } : {}),
    ...(step.pendingNavigation ? { pendingNavigation: true as const } : {}),
    ...(pageScript ? { pageScript } : {}),
    ...stepLease(result),
  };
}

/** Where a failure is in the model's code. */
function failureWhere(failure: BrowserProgramFailure): string {
  if (failure.line === undefined) return '';
  return ` at line ${failure.line}${failure.column === undefined ? '' : `, column ${failure.column}`}`;
}

/** What follows a failure's message: the code it points at and what to do next. */
function failureDetails(failure: BrowserProgramFailure): string {
  const code = failure.snippet ? `\n${failure.snippet}` : '';
  const next =
    failure.recovery && !failure.message.includes(failure.recovery)
      ? ` Next: ${failure.recovery}`
      : '';
  return `${code}${next}`;
}

function failureLine(report: BrowserProgramReport): string {
  const failure = report.failure;
  if (!failure) return '';
  const where = failureWhere(failure);
  const lastFailed = [...report.steps].reverse().find((step) => !step.ok);
  const op =
    failure.kind === 'browser' && lastFailed
      ? `; page operation ${report.steps.lastIndexOf(lastFailed) + 1} (${lastFailed.op}${lastFailed.target ? ` ${lastFailed.target}` : ''})`
      : '';
  switch (failure.kind) {
    case 'timeout':
      return `The program was stopped at its time limit after ${Math.round(report.wallMs / 1000)} s. ${report.timeoutMs < BROWSER_PROGRAM_MAX_TIMEOUT_MS ? `Pass a larger input.timeout (at most ${BROWSER_PROGRAM_MAX_TIMEOUT_MS}) or do less per program.` : 'Do less per program; keep progress in state and continue in the next one.'}`;
    case 'memory':
      return 'The program ran out of memory. Keep less data in variables and return a summary.';
    default:
      return `The program failed${where}${op}: ${failure.name}: ${failure.message}${failureDetails(failure)}`;
  }
}

function returnText(valueJson: string | undefined): string {
  if (valueJson === undefined) return 'No return value.';
  const bytes = Buffer.byteLength(valueJson, 'utf8');
  if (bytes <= MAX_RETURN_TEXT_BYTES) return valueJson;
  return `${Buffer.from(valueJson).subarray(0, MAX_RETURN_TEXT_BYTES).toString('utf8')}\n[return value cut at ${MAX_RETURN_TEXT_BYTES} of ${bytes} bytes; return a summary instead]`;
}

const NAVIGATION_OPS: Readonly<Record<string, true>> = { goto: true, back: true, reload: true };

/** What a program stopped at its op limit had done, and how to do it in fewer operations. */
function opLimitLine(report: BrowserProgramReport, writes: number): string {
  const counts = new Map<string, number>();
  let navigations = 0;
  for (const step of report.steps) {
    if (NAVIGATION_OPS[step.op] === true) navigations += 1;
    const shape = `${step.op}${step.target ? ` ${step.target.replace(/\.nth\(-?\d+\)/gu, '.nth(i)')}` : ''}`;
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  const most = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([shape, count]) => `${shape} ×${count}`)
    .join('; ');
  const last = report.steps.at(-1);
  const reads = report.steps.length - writes - navigations;
  return [
    `The program reached its limit of ${report.opLimit} page operations: ${report.refusedOps} later page call(s) threw BROWSER_OP_LIMIT, so its return value is not used${report.stopNote ? '' : '; what it put in state is kept'}.`,
    `Done before the limit: ${reads} reads, ${writes} writes, ${navigations} navigations${most ? `; most were ${most}` : ''}${last ? `; the last that ran was operation ${report.steps.length} (${last.op}${last.target ? ` ${last.target}` : ''})` : ''}.`,
    'A read per element in a loop costs one operation each: read the whole list in ONE operation with readAll({ text: "text", href: "@href" }) or allTextContents(). Reads of textContent(), innerText(), getAttribute(), inputValue() and isVisible() on the locators from `await locator.all()`, or on list.nth(i) after its first, cost no operation until the next write, navigation or wait; reads through a child locator (list.nth(i).locator(css)) still cost one each.',
    'For a long crawl, keep progress in state (state.next = page number or index) as you go and continue from it in the next program.',
  ].join(' ');
}

/**
 * Ops that can change the page: Browser Core's write ops, and page JavaScript,
 * which may write. One that did not finish may have reached the page.
 */
const PAGE_WRITE_OPS: Readonly<Record<string, true>> = {
  click: true,
  dblclick: true,
  mouseClick: true,
  check: true,
  uncheck: true,
  fill: true,
  type: true,
  press: true,
  selectOption: true,
  evaluate: true,
};
const UNFINISHED_OUTCOME = 'did not finish, outcome unknown';

function writesLines(
  writes: readonly BrowserProgramStep[],
  unfinishedWrites: readonly string[],
  failed: boolean,
  multiTab: boolean,
): string[] {
  const lines: string[] = [];
  if (writes.length > 0) {
    const listed = writes
      .slice(0, MAX_LISTED_WRITES)
      .map(
        (step) =>
          `${step.op}${writeTarget(step)}${multiTab && step.tabId !== undefined ? ` on tab ${step.tabId}` : ''}: ${step.outcome ?? 'ok'}`,
      )
      .join('; ');
    const more =
      writes.length > MAX_LISTED_WRITES ? `; and ${writes.length - MAX_LISTED_WRITES} more` : '';
    lines.push(`Page writes, in order: ${listed}${more}.`);
  }
  if (unfinishedWrites.length > 0) {
    lines.push(
      `Page writes that ${UNFINISHED_OUTCOME} (read the page before repeating them): ${unfinishedWrites.join(', ')}.`,
    );
  }
  return lines.length === 0 && failed ? ['No page writes ran.'] : lines;
}

/**
 * What a listed write acted on. Only keyboard ops without a target act on the
 * focused element; a step that lost its target (an op that ended without
 * Browser Core's result) names none rather than a wrong one.
 */
function writeTarget(step: BrowserProgramStep): string {
  if (step.target) return ` ${step.target}`;
  return step.op === 'type' || step.op === 'press' ? ' the focused element' : '';
}

function reportLines(
  report: BrowserProgramReport,
  writes: readonly BrowserProgramStep[],
  unfinishedWrites: readonly string[],
): string[] {
  const failed = !report.ok;
  const lines: string[] = [];
  if (report.stopNote) lines.push(report.stopNote);
  if (failed && report.failure) lines.push(failureLine(report));
  if (!failed) lines.push(returnText(report.valueJson));
  // With more than one tab in the program, each write names its tab.
  const multiTab =
    new Set(report.steps.flatMap((step) => (step.tabId === undefined ? [] : [step.tabId]))).size >
    1;
  lines.push(...writesLines(writes, unfinishedWrites, failed, multiTab));
  lines.push(...runNotes(report, writes.length));
  if (report.stateNote) lines.push(report.stateNote);
  if (report.console) {
    lines.push(
      `console:\n${report.console}${report.consoleTruncated ? '\n[console output cut]' : ''}`,
    );
  }
  lines.push(`(${report.steps.length} page operations, ${Math.round(report.wallMs)} ms)`);
  return lines;
}

/**
 * What the steps and stops tell about the run: popups that gave control back,
 * reads of a loading page, refused ops, and a user takeover.
 */
function runNotes(report: BrowserProgramReport, writeCount: number): string[] {
  const notes: string[] = [];
  report.steps.forEach((step, index) => {
    if (step.leaseReturnedTo === undefined) return;
    notes.push(
      `A popup closed itself during operation ${index + 1} (${step.op}); control went back to tab ${step.leaseReturnedTo}, the page that opened it.`,
    );
  });
  const staleReads = report.steps.filter((step) => step.pendingNavigation === true).length;
  if (staleReads > 0) {
    notes.push(
      `${staleReads} read(s) returned while a new page was still loading: they show the page from before that navigation and do not show the outcome of an earlier write. Read again after the page arrives before repeating any write.`,
    );
  }
  if (report.refusedOps > 0) notes.push(opLimitLine(report, writeCount));
  if (report.failure?.code === 'BROWSER_USER_TAKEOVER' && !report.stopNote) {
    notes.push(
      'The user took over the Browser during the program: no page call after that ran, and what the program put in state is kept.',
    );
  }
  return notes;
}

/** The model's text. A failed program's screenshots are named here, not attached. */
function resultText(
  report: BrowserProgramReport,
  writes: readonly BrowserProgramStep[],
  unfinishedWrites: readonly string[],
): string {
  const lines = reportLines(report, writes, unfinishedWrites);
  // Error tool results stay text-only: providers reject an error result that
  // carries images (see local-browser.ts).
  if (!report.ok && report.media.length > 0) {
    lines.push(
      `${report.media.length} screenshot(s) the program took are not attached: a failed program returns text only. Take them again after the program succeeds.`,
    );
  }
  return lines.join('\n');
}

function failureSummary(report: BrowserProgramReport) {
  const failure = report.failure;
  if (!failure) return undefined;
  const failedOp = report.steps.findIndex((step) => !step.ok) + 1;
  return {
    kind: failure.kind,
    name: failure.name,
    ...(failure.code ? { code: failure.code } : {}),
    ...(failure.line !== undefined ? { line: failure.line } : {}),
    ...(failure.column !== undefined ? { column: failure.column } : {}),
    ...(failedOp > 0 ? { failedOp } : {}),
  };
}

/** run_script's result in program mode: the conclusion, the writes it made, and the program's numbers. */
export function browserProgramToolResult(report: BrowserProgramReport): ToolResult {
  const writes = report.steps.filter((step) => step.write === true);
  const unfinishedWrites = report.unfinishedOps.filter((op) => PAGE_WRITE_OPS[op] === true);
  const failed = !report.ok;
  const text = resultText(report, writes, unfinishedWrites);
  const failure = failureSummary(report);
  const value = failed ? undefined : programValue(report.valueJson);
  return {
    tool_name: 'browser',
    text,
    content: failed ? [{ type: 'text', text }] : [{ type: 'text', text }, ...report.media],
    ...(failed ? { isError: true } : {}),
    details: {
      action: 'run_script',
      browserProgram: {
        ok: report.ok,
        ops: report.steps.length,
        refusedOps: report.refusedOps,
        wallMs: Math.round(report.wallMs),
        opMs: Math.round(report.opMs),
        opRoundTripMs: Math.round(report.opRoundTripMs),
        writes: writes.length,
        ...(failure ? { failure } : {}),
        ...(report.unfinishedOps.length > 0 ? { unfinishedOps: report.unfinishedOps } : {}),
        steps: report.steps,
      },
    },
    // What a run_code caller reads as `r.data`: the program's return value
    // itself, not its text rendering.
    programmatic: {
      data: {
        action: 'run_script',
        ok: report.ok,
        ...value,
        ops: report.steps.length,
        writes: [
          ...writes.map((step) => ({
            op: step.op,
            ...(step.target ? { target: step.target } : {}),
            ...(step.tabId === undefined ? {} : { tabId: step.tabId }),
            outcome: step.outcome ?? 'ok',
          })),
          ...unfinishedWrites.map((op) => ({ op, outcome: UNFINISHED_OUTCOME })),
        ],
        ...(failure ? { failure: { ...failure, message: failureLine(report) } } : {}),
        ...(report.stopNote ? { stopNote: report.stopNote } : {}),
        ...(report.stateNote ? { stateNote: report.stateNote } : {}),
      },
    },
  };
}

/** `{ value }` for a return value that fits, `{ valueCut: true }` for one that does not. */
function programValue(
  valueJson: string | undefined,
): { readonly value: unknown } | { readonly valueCut: true } | undefined {
  if (valueJson === undefined) return undefined;
  if (Buffer.byteLength(valueJson, 'utf8') > MAX_RETURN_TEXT_BYTES) return { valueCut: true };
  try {
    const value: unknown = JSON.parse(valueJson);
    return { value };
  } catch {
    return undefined;
  }
}
