import {
  asNumber,
  asString,
  byteLength,
  evaluate,
  getBrowserSnapshot,
  isRecord,
  type ElementRecord,
  type Snapshot,
  stringArray,
  type BrowserSessionState as SessionState,
} from './browser-state.js';
import { BrowserSnapshotSupport } from './browser-snapshot.js';
import { exposeElement } from './browser-snapshot-helpers.js';
import {
  diagnoseSelectorMiss,
  isReadRegionSelector,
  READ_REGION_FALLBACKS,
  selectorMissRecovery,
  type SelectorMissDiagnostics,
} from './browser-selector-diagnostics.js';
import {
  sanitizeConsoleDiagnosticUrl,
  type CDPConsoleDiagnosticLevelFilter,
  type CDPNetworkDiagnosticResourceType,
  type CDPNetworkDiagnosticStatusFilter,
} from './cdp-helper.js';
import { SECRET_AUTOCOMPLETE_PATTERN } from './browser-form-state.js';
import { OMIT_DATA_URLS_SOURCE } from './browser-data-url.js';
import { sanitizeDomElementSource } from './browser-dom-sanitize.js';
import {
  invalidRowsField,
  parseRowsRequest,
  ROWS_FILE_BUDGET,
  ROWS_FILE_MAX_ROWS,
  ROWS_PAGE_BYTES,
  ROWS_SELECTOR_MISS_HINT,
  rowsExpression,
  rowsPage,
  writeRowsFile,
  type RowsRead,
} from './browser-query-rows.js';
import { isBrowserOperationInterruption } from './operation-timeout.js';

const NON_EDITABLE_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'file',
  'hidden',
  'image',
  'radio',
  'reset',
  'submit',
]);

export abstract class BrowserQuerySupport extends BrowserSnapshotSupport {
  /** Count consecutive misses per page so repeated blind guesses get a firmer redirect. */
  private async selectorMiss(
    session: SessionState,
    selector: string,
  ): Promise<Record<string, unknown>> {
    const diagnostics = await diagnoseSelectorMiss(session, selector);
    const url = diagnostics.url ?? '';
    const previous = session.selectorMissStreak;
    const count = previous && previous.url === url ? previous.count + 1 : 1;
    session.selectorMissStreak = { url, count };
    return selectorNotFound(selector, { ...diagnostics, consecutiveMisses: count });
  }

  protected async query(session: SessionState, input: Record<string, unknown>): Promise<unknown> {
    const kind = asString(input.kind);
    if (kind === 'snapshot') return this.inspect(session, input);
    if (kind === 'semantic') return this.searchSemantic(session, input);
    if (kind === 'editable') {
      const requestedSnapshotId = asString(input.snapshotId);
      if (requestedSnapshotId) {
        const snapshot = getBrowserSnapshot(session, requestedSnapshotId);
        if (!snapshot) {
          throw new Error('STALE_SNAPSHOT: editable query continuation is no longer available');
        }
        if ((snapshot.continuationKind ?? 'inspect') !== 'query-editable') {
          throw new Error(
            'SNAPSHOT_KIND_MISMATCH: this snapshotId was not produced by query kind "editable"; continue it with the action named in its own continuation (an inspect snapshot continues with action "inspect" and the same snapshotId/offset)',
          );
        }
        const current = snapshot.editableQuery;
        if (!current) {
          throw new Error('STALE_SNAPSHOT: editable query continuation is no longer available');
        }
        const offset = Math.max(0, Math.floor(asNumber(input.offset, 0)));
        if (current.nextOffset === null || offset !== current.nextOffset) {
          throw new Error(
            'SNAPSHOT_CONTINUATION_MISMATCH: continue from the exact nextOffset returned by the previous page',
          );
        }
        return editablePage(snapshot, current, offset, input);
      }
      if (asNumber(input.offset, 0) > 0) {
        throw new Error('editable query offset requires snapshotId from a previous query');
      }
      await this.inspect(session, { limit: 1 }, 'query-editable');
      const snapshot = session.snapshot;
      if (!snapshot) throw new Error('EDITABLE_QUERY_FAILED: no current Browser snapshot');
      const elements = snapshot.elements.filter(isEditableElement);
      snapshot.editableQuery = {
        elements,
        nextOffset: 0,
      };
      return editablePage(snapshot, snapshot.editableQuery, 0, input);
    }
    if (kind === 'text') {
      const selector = asString(input.selector, 'body');
      if (input.all === true) return this.queryAllMatches(session, 'text', selector, input);
      const maxChars = Math.max(1, Math.floor(asNumber(input.maxChars, 20_000)));
      // Characters, not matches: `all: true` returned above with its own offset.
      const offset = Math.max(0, Math.floor(asNumber(input.offset, 0)));
      // One character before offset lets the host see a surrogate pair split there.
      const chunkStart = Math.max(0, offset - 1);
      // Only a selector that names the content region as a whole: the caller
      // wants the page's text, not one element that happens not to exist.
      const fallbacks = isReadRegionSelector(selector) ? READ_REGION_FALLBACKS : [];
      try {
        const result = await evaluate<{
          found: boolean;
          used?: string;
          text: string;
          totalLength: number;
          url: string;
          title: string;
        }>(
          session,
          `(() => {
          let used = ${JSON.stringify(selector)};
          let element = document.querySelector(used);
          for (const fallback of ${JSON.stringify(fallbacks)}) {
            if (element) break;
            element = document.querySelector(fallback);
            used = fallback;
          }
          if (!element) return { found: false, text: '', totalLength: 0, url: location.href, title: document.title };
          const text = ${pageTextExpression(session.readLiveFormState?.() === true)};
          return { found: true, used, text: text.slice(${chunkStart}, ${offset + maxChars}), totalLength: text.length, url: location.href, title: document.title };
        })()`,
        );
        if (!result.found) return this.selectorMiss(session, selector);
        session.selectorMissStreak = undefined;
        const used = result.used ?? selector;
        const page = singleReadPage(
          {
            kind: 'text',
            selector: used,
            offset,
            maxChars,
            offsetGiven: input.offset !== undefined,
          },
          { chunk: result.text, chunkStart, totalLength: result.totalLength },
          { url: result.url, title: result.title },
        );
        return used === selector || page.success !== true
          ? page
          : { ...page, region: { requested: selector, used } };
      } catch (error) {
        if (isBrowserOperationInterruption(error)) throw error;
        return browserQueryFailure(error, selector);
      }
    }
    if (kind === 'dom') {
      const selector = asString(input.selector, 'body');
      if (input.all === true) return this.queryAllMatches(session, 'dom', selector, input);
      const maxChars = Math.max(1, Math.min(50_000, Math.floor(asNumber(input.maxChars, 20_000))));
      const offset = Math.max(0, Math.floor(asNumber(input.offset, 0)));
      try {
        // Every page re-runs the sanitizer with the current beta.browserReadV2
        // flag, so continuation never reads around the live-state rules.
        const result = await evaluate<{ found: boolean; html: string }>(
          session,
          sanitizedDomQueryExpression(selector, session.readLiveFormState?.() === true),
        );
        if (!result.found) return this.selectorMiss(session, selector);
        session.selectorMissStreak = undefined;
        return singleReadPage(
          { kind: 'dom', selector, offset, maxChars, offsetGiven: input.offset !== undefined },
          {
            chunk: result.html,
            chunkStart: 0,
            totalLength: result.html.length,
            keepWhole: () => credentialMarkupSpans(result.html),
          },
          {
            url: await evaluate<string>(session, 'location.href'),
            title: await evaluate<string>(session, 'document.title'),
          },
        );
      } catch (error) {
        if (isBrowserOperationInterruption(error)) throw error;
        return browserQueryFailure(error, selector);
      }
    }
    if (kind === 'rows') return this.queryRows(session, input);
    if (kind === 'console') {
      const diagnosticsReady = await session.cdpHelper.ensureConsoleDiagnosticsReady(
        session.commandSignal,
      );
      if (!diagnosticsReady || !session.cdpHelper.isConsoleDiagnosticsAvailable()) {
        return {
          success: false,
          code: 'CONSOLE_DIAGNOSTICS_UNAVAILABLE',
          error: 'Console diagnostics are unavailable for the current Browser tab.',
          recovery: 'Keep the current Browser tab open and retry once it finishes initializing.',
        };
      }
      const diagnostics = session.cdpHelper.getConsoleDiagnostics({
        ...(input.levels !== undefined
          ? {
              levels: stringArray(input.levels) as CDPConsoleDiagnosticLevelFilter[],
            }
          : {}),
        ...(input.filter !== undefined ? { filter: asString(input.filter) } : {}),
        limit: Math.max(1, Math.min(200, Math.floor(asNumber(input.limit, 100)))),
      });
      const page = await evaluate<{ url: string; title: string }>(
        session,
        '({ url: location.href, title: document.title })',
      );
      return {
        success: true,
        kind: 'console',
        url: sanitizeConsoleDiagnosticUrl(asString(page.url)),
        title: asString(page.title),
        ...diagnostics,
      };
    }
    if (kind === 'network') {
      const diagnosticsReady = await session.cdpHelper.ensureNetworkDiagnosticsReady(
        session.commandSignal,
      );
      if (!diagnosticsReady || !session.cdpHelper.isNetworkDiagnosticsAvailable()) {
        return {
          success: false,
          code: 'NETWORK_DIAGNOSTICS_UNAVAILABLE',
          error: 'Network diagnostics are unavailable for the current Browser tab.',
          recovery: 'Keep the current Browser tab open and retry once it finishes initializing.',
        };
      }
      const diagnostics = session.cdpHelper.getNetworkDiagnostics({
        ...(input.status !== undefined
          ? { status: stringArray(input.status) as CDPNetworkDiagnosticStatusFilter[] }
          : {}),
        ...(input.resourceTypes !== undefined
          ? {
              resourceTypes: stringArray(input.resourceTypes) as CDPNetworkDiagnosticResourceType[],
            }
          : {}),
        ...(input.filter !== undefined ? { filter: asString(input.filter) } : {}),
        ...(input.afterSequence !== undefined
          ? { afterSequence: Math.max(0, Math.floor(asNumber(input.afterSequence))) }
          : {}),
        limit: Math.max(1, Math.min(200, Math.floor(asNumber(input.limit, 100)))),
        ...(session.readLiveFormState?.() === true ? { readHints: true } : {}),
      });
      const page = await evaluate<{ url: string; title: string }>(
        session,
        '({ url: location.href, title: document.title })',
      );
      return {
        success: true,
        kind: 'network',
        url: sanitizeConsoleDiagnosticUrl(asString(page.url)),
        title: asString(page.title),
        ...diagnostics,
      };
    }
    throw new Error(
      'query requires kind: text, semantic, dom, rows, editable, snapshot, console, or network',
    );
  }

  /**
   * kind "rows": one record per row element, paged by row index. Every page is
   * a fresh host-owned read under the current beta.browserReadV2 flag. A first
   * page that cannot hold every row also spills up to ROWS_FILE_MAX_ROWS rows
   * (and about ROWS_FILE_BUDGET characters) to a JSON file (`fullOutputPath`);
   * continuation pages do not rewrite it.
   */
  private async queryRows(
    session: SessionState,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const request = parseRowsRequest(input);
    const liveFormState = session.readLiveFormState?.() === true;
    let read: RowsRead;
    try {
      read = await evaluate<RowsRead>(
        session,
        rowsExpression(
          request,
          { end: request.offset + request.limit, budget: ROWS_PAGE_BYTES },
          liveFormState,
        ),
      );
    } catch (error) {
      if (isBrowserOperationInterruption(error)) throw error;
      return browserQueryFailure(error, request.selector);
    }
    if (read.invalidField !== undefined)
      return invalidRowsField(request, read, invalidSelectorHint);
    if (read.totalRows === 0) {
      const miss = await this.selectorMiss(session, request.selector);
      return {
        ...miss,
        totalRows: 0,
        recovery: `${ROWS_SELECTOR_MISS_HINT} ${asString(miss.recovery)}`,
      };
    }
    session.selectorMissStreak = undefined;
    if (request.offset > read.totalRows) {
      return {
        success: false,
        code: 'OFFSET_OUT_OF_RANGE',
        error: `offset ${request.offset} is past the last row (totalRows ${read.totalRows})`,
        totalRows: read.totalRows,
        offsetUnit: 'row',
        recovery:
          'The row list is shorter than this offset, so it likely changed since the previous page. Read it again without offset and continue only with the nextOffset that read returns.',
      };
    }
    const page = rowsPage(request, read);
    if (request.offset !== 0 || page.nextOffset === undefined) return page;
    try {
      const everyRow = await evaluate<RowsRead>(
        session,
        rowsExpression(
          request,
          { end: ROWS_FILE_MAX_ROWS, budget: ROWS_FILE_BUDGET },
          liveFormState,
        ),
      );
      if (everyRow.invalidField !== undefined || everyRow.totalRows === 0) return page;
      return { ...page, ...(await writeRowsFile(request, everyRow)) };
    } catch (error) {
      if (isBrowserOperationInterruption(error)) throw error;
      // The inline page stays valid and pageable without the spill file.
      return page;
    }
  }

  /**
   * `all: true` for kind text/dom: one fixed querySelectorAll read, each match
   * truncated on its own, paged by match index: `selector: "select"` alone
   * returned only the first select, and a model enumerated a form's selects
   * with run_script. Pages are re-queried live (no stored
   * snapshot), so `nextOffset` counts matches, not characters.
   */
  private async queryAllMatches(
    session: SessionState,
    kind: 'text' | 'dom',
    selector: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const offset = Math.max(0, Math.floor(asNumber(input.offset, 0)));
    const limit = Math.max(
      1,
      Math.min(QUERY_ALL_MAX_LIMIT, Math.floor(asNumber(input.limit, QUERY_ALL_DEFAULT_LIMIT))),
    );
    const maxChars = Math.max(
      1,
      Math.min(50_000, Math.floor(asNumber(input.maxChars, QUERY_ALL_DEFAULT_MAX_CHARS))),
    );
    let result: QueryAllPage;
    try {
      result = await evaluate<QueryAllPage>(
        session,
        queryAllExpression(
          kind,
          selector,
          { offset, limit, maxChars },
          session.readLiveFormState?.() === true,
        ),
      );
    } catch (error) {
      if (isBrowserOperationInterruption(error)) throw error;
      return browserQueryFailure(error, selector);
    }
    if (result.totalMatches === 0) return this.selectorMiss(session, selector);
    session.selectorMissStreak = undefined;
    const field = kind === 'text' ? 'text' : 'html';
    let matches = result.matches.map((match, position) => ({
      index: offset + position,
      [field]: match.content,
      totalLength: match.totalLength,
      truncated: match.totalLength > match.content.length,
    }));
    while (matches.length > 1 && byteLength({ matches }) > QUERY_ALL_PAGE_BYTES) {
      matches = matches.slice(0, -1);
    }
    const end = offset + matches.length;
    const hasMore = end < result.totalMatches;
    return {
      success: true,
      url: result.url,
      title: result.title,
      selector,
      offset,
      offsetUnit: 'match',
      totalMatches: result.totalMatches,
      returnedMatches: matches.length,
      matches,
      truncated: hasMore,
      ...(hasMore
        ? {
            nextOffset: end,
            continuation: {
              action: 'query',
              input: { kind, selector, all: true, offset: end, limit, maxChars },
            },
          }
        : {}),
    };
  }
}

const QUERY_ALL_DEFAULT_LIMIT = 50;
const QUERY_ALL_MAX_LIMIT = 200;
/** Per-match default: listing reads many short elements, not one long one. */
const QUERY_ALL_DEFAULT_MAX_CHARS = 2_000;
/** Same page budget as editable-query pages, below the 64 KiB compact result cap. */
const QUERY_ALL_PAGE_BYTES = 56 * 1024;

interface QueryAllPage {
  totalMatches: number;
  matches: { content: string; totalLength: number }[];
  url: string;
  title: string;
}

/**
 * Page-side innerText of `element`, shared by single and `all` text queries.
 * With `beta.browserReadV2` long data: URLs become placeholders before paging,
 * so every page and its offsets see the same text.
 */
function pageTextExpression(readV2: boolean): string {
  const read = `String(element.innerText || element.textContent || '')`;
  return readV2 ? `(${OMIT_DATA_URLS_SOURCE})(${read})` : read;
}

function sanitizedDomQueryExpression(selector: string, liveFormState: boolean): string {
  return `(() => {
    const sanitize = ${sanitizeDomElementSource(liveFormState)};
    const source = document.querySelector(${JSON.stringify(selector)});
    if (!source || source.closest('[data-mavis-agent-cursor-host]')) return { found: false, html: '' };
    return { found: true, html: sanitize(source) };
  })()`;
}

/**
 * Fixed host-owned read for `all: true`; only selector and numeric bounds are
 * interpolated (JSON-encoded). Serialization stops early once the page holds
 * more characters than the byte budget could return, so a broad selector does
 * not ship the whole document over CDP; the host trims to exact bytes. A dom
 * match is never cut inside an `<input>` tag or `<textarea>` element (any of
 * them, credential or not): the cut moves back to the unit start, and a unit
 * that starts the match is kept whole, as the single read keeps
 * `credentialMarkupSpans` whole, so the host redaction sees complete units.
 */
function queryAllExpression(
  kind: 'text' | 'dom',
  selector: string,
  bounds: { offset: number; limit: number; maxChars: number },
  readV2: boolean,
): string {
  const read =
    kind === 'text'
      ? `(element) => ${pageTextExpression(readV2)}`
      : sanitizeDomElementSource(readV2);
  const cut =
    kind === 'text'
      ? `(content) => ${bounds.maxChars}`
      : `(content) => {
      let end = ${bounds.maxChars};
      if (content.length <= end) return end;
      for (const unit of content.matchAll(${CREDENTIAL_MARKUP_UNITS})) {
        if (unit.index >= end) break;
        const unitEnd = unit.index + unit[0].length;
        if (unitEnd > end) return unit.index > 0 ? unit.index : unitEnd;
      }
      return end;
    }`;
  return `(() => {
    const read = ${read};
    const cut = ${cut};
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .filter((element) => !element.closest('[data-mavis-agent-cursor-host]'));
    const matches = [];
    let chars = 0;
    for (const element of nodes.slice(${bounds.offset}, ${bounds.offset + bounds.limit})) {
      if (matches.length > 0 && chars > ${QUERY_ALL_PAGE_BYTES}) break;
      const content = read(element);
      const kept = content.slice(0, cut(content));
      chars += kept.length;
      matches.push({ content: kept, totalLength: content.length });
    }
    return { totalMatches: nodes.length, matches, url: location.href, title: document.title };
  })()`;
}

interface CharSpan {
  start: number;
  end: number;
}

interface SingleReadSource {
  /** content[chunkStart, chunkStart + chunk.length); covers offset - 1 through offset + maxChars. */
  chunk: string;
  chunkStart: number;
  totalLength: number;
  /** Spans a page may not cut through, computed only when the read is actually paged. */
  keepWhole?: () => readonly CharSpan[];
}

/**
 * One page of a single-element text/dom read, paged by UTF-16 character offset
 * (`offsetUnit: "char"`; `all: true` pages by match instead). As with `all`,
 * each page is a fresh host-owned read rather than a stored snapshot, so the
 * DOM sanitizer, the live-state flag and host redaction apply to every page.
 * Without offset an untruncated read is the original result; a truncated one
 * adds nextOffset and an exact continuation, as inspect does.
 */
function singleReadPage(
  request: {
    kind: 'text' | 'dom';
    selector: string;
    offset: number;
    maxChars: number;
    offsetGiven: boolean;
  },
  source: SingleReadSource,
  page: { url: string; title: string },
): Record<string, unknown> {
  const { kind, selector, offset, maxChars } = request;
  const { totalLength } = source;
  if (offset > totalLength) {
    return {
      success: false,
      code: 'OFFSET_OUT_OF_RANGE',
      error: `offset ${offset} is past the end of the ${kind} content (totalLength ${totalLength})`,
      totalLength,
      offsetUnit: 'char',
      recovery:
        'The element content is shorter than this offset, so it likely changed since the previous page. Read it again without offset and continue only with the nextOffset that read returns.',
    };
  }
  const { start, end } = charWindow(source, offset, maxChars);
  const truncated = end < totalLength;
  return {
    success: true,
    [kind === 'text' ? 'text' : 'html']: source.chunk.slice(
      start - source.chunkStart,
      end - source.chunkStart,
    ),
    totalLength,
    url: page.url,
    title: page.title,
    truncated,
    ...(request.offsetGiven || truncated ? { offset: start, offsetUnit: 'char' } : {}),
    ...(truncated
      ? {
          nextOffset: end,
          continuation: { action: 'query', input: { kind, selector, offset: end, maxChars } },
        }
      : {}),
  };
}

/**
 * The [start, end) window of one page. A page never starts or ends between
 * the halves of a surrogate pair: CDP returns a lone half as U+FFFD, so the
 * pages would no longer join into the original. Nor does it cut through a
 * `keepWhole` span: an offset inside one moves back to the span start, and a
 * page ends before a span rather than inside it. A span that begins the page
 * is returned whole even past maxChars, so reading always advances.
 */
function charWindow(
  source: SingleReadSource,
  offset: number,
  maxChars: number,
): { start: number; end: number } {
  const { chunk, chunkStart, totalLength } = source;
  const code = (index: number) => chunk.charCodeAt(index - chunkStart);
  let start = offset;
  if (
    start > 0 &&
    start < totalLength &&
    isLowSurrogate(code(start)) &&
    isHighSurrogate(code(start - 1))
  ) {
    start -= 1;
  }
  const spans =
    source.keepWhole && (start > 0 || start + maxChars < totalLength) ? source.keepWhole() : [];
  start = spans.find((span) => span.start < start && start < span.end)?.start ?? start;
  let end = Math.min(totalLength, start + maxChars);
  if (end < totalLength && end - start > 1 && isHighSurrogate(code(end - 1))) end -= 1;
  const cut = spans.find((span) => span.start < end && end < span.end);
  if (cut) end = cut.start > start ? cut.start : cut.end;
  return { start, end };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The units the host's authentication redaction scans (agent-tools
 * local-browser.ts): `<input …>` tags and whole `<textarea>…</textarea>`
 * elements. It recognizes a credential only from the complete unit, so a DOM
 * page must never cut one; the type/autocomplete test mirrors the host's.
 */
const CREDENTIAL_MARKUP_UNITS = /<input\b[^>]*>|<textarea\b[^>]*>[\s\S]*?<\/textarea>/giu;

function credentialMarkupSpans(html: string): CharSpan[] {
  const spans: CharSpan[] = [];
  for (const match of html.matchAll(CREDENTIAL_MARKUP_UNITS)) {
    const unit = match[0];
    const opening = /^<[^>]*>/u.exec(unit)?.[0] ?? unit;
    const type = markupAttribute(opening, 'type')?.trim().toLowerCase();
    const autocomplete = (markupAttribute(opening, 'autocomplete') ?? '').toLowerCase();
    if (type !== 'password' && !SECRET_AUTOCOMPLETE_PATTERN.test(autocomplete)) continue;
    spans.push({ start: match.index, end: match.index + unit.length });
  }
  return spans;
}

function markupAttribute(markup: string, name: 'type' | 'autocomplete'): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu').exec(
    markup,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function selectorNotFound(
  selector: string,
  diagnostics: SelectorMissDiagnostics,
): Record<string, unknown> {
  const hint = nonCssTextSelectorHint(selector);
  const recovery = selectorMissRecovery(diagnostics);
  return {
    success: false,
    code: 'QUERY_FAILED',
    error: `Element not found: ${selector}`,
    ...(diagnostics.url ? { url: diagnostics.url } : {}),
    ...(diagnostics.selectorTail ? { selectorTail: diagnostics.selectorTail } : {}),
    ...(diagnostics.pageControls ? { pageControls: diagnostics.pageControls } : {}),
    ...(diagnostics.missingLandmark
      ? { missingLandmark: diagnostics.missingLandmark.selector }
      : {}),
    ...(diagnostics.consecutiveMisses && diagnostics.consecutiveMisses > 1
      ? { consecutiveMisses: diagnostics.consecutiveMisses }
      : {}),
    ...(diagnostics.candidates ? { candidates: diagnostics.candidates } : {}),
    recovery: hint ? `${hint} ${recovery}` : recovery,
  };
}

/**
 * Playwright/jQuery text engines that look like pseudo-classes but are not CSS,
 * so `querySelector` rejects them outright. The selector itself is the useful
 * diagnosis here: the model wanted a text match, which is `kind: "semantic"`.
 */
function nonCssTextSelectorHint(selector: string): string | undefined {
  // `text=` only counts as a selector engine prefix at a compound boundary, so
  // attribute selectors such as `[data-text=foo]` are never misdiagnosed.
  // An escaped colon or a longer identifier (`hover\\:text-red-600`, eval
  // 777827) is a utility class name, not the `:text` engine.
  const fragment = selector
    .match(
      /(?<!\\):(?:has-)?text(?![\w-])|(?<!\\):contains(?![\w-])|(?:^|[\s>+~,(])text\s*=/iu,
    )?.[0]
    ?.trim()
    .replace(/^[>+~,(]\s*/u, '');
  if (!fragment) return undefined;
  return `The selector uses ${JSON.stringify(fragment)}, which is not valid CSS. For text matching use query with kind: "semantic" and input.text ("contains" matching), or query kind: "text" with a real CSS selector.`;
}

/**
 * Eval 774252: utility class names such as `hover:bg-gray-50` or `bg-black/50`
 * were sent as `.hover\\:bg-gray-50` (two backslashes after JSON decoding). CSS
 * reads `\\` as an escaped backslash, leaving the `:` or `/` unescaped, so the
 * selector is invalid; the model repeated this four times because the generic
 * recovery did not name the cause.
 */
function doubledBackslashSelectorHint(selector: string): string | undefined {
  const fragment = /\\\\[^\\\s]/u.exec(selector)?.[0];
  if (!fragment) return undefined;
  return `The selector contains a doubled backslash (${JSON.stringify(fragment)}); CSS reads "\\\\" as a literal backslash, so the next character stays unescaped. Escape special characters in class names with a single backslash (for example .hover\\:bg-gray-50), or act through an inspect ref instead.`;
}

const INVALID_SELECTOR_PHRASE = /failed to execute ['"]?queryselector|not a valid selector|invalid selector/iu;

function isSelectorSyntaxErrorLine(line: string): boolean {
  const lower = line.toLowerCase();
  return lower.includes('selector') && lower.includes('syntaxerror');
}

/** True when a page-side error message is the browser rejecting selector syntax. */
export function isInvalidSelectorMessage(message: string): boolean {
  return INVALID_SELECTOR_PHRASE.test(message) || message.split('\n').some(isSelectorSyntaxErrorLine);
}

/**
 * Cause-specific advice for a selector the browser rejected, shared by query
 * and by actions that target `input.selector`. Eval 777827: a click with
 * `button.hover\\:text-red-600` surfaced only the raw SyntaxError because the
 * doubled-backslash hint lived on the query path alone.
 */
export function invalidSelectorHint(selector: string): string | undefined {
  return nonCssTextSelectorHint(selector) ?? doubledBackslashSelectorHint(selector);
}

function browserQueryFailure(error: unknown, selector?: string): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const invalidSelector = isInvalidSelectorMessage(message);
  const hint = selector === undefined ? undefined : nonCssTextSelectorHint(selector);
  if (!invalidSelector) {
    const recovery =
      'Inspect the current page state and retry the query once; if navigation occurred, continue from the new snapshot.';
    return {
      success: false,
      code: 'QUERY_FAILED',
      error: message,
      recovery: hint ? `${hint} ${recovery}` : recovery,
    };
  }
  return {
    success: false,
    code: 'INVALID_SELECTOR',
    error: message,
    recovery:
      hint ??
      (selector === undefined ? undefined : doubledBackslashSelectorHint(selector)) ??
      'Use query with kind: "text" for text matching, or continue inspect and act through a returned opaque ref. CSS selectors must use standard CSS syntax.',
  };
}

function editablePage(
  snapshot: Snapshot,
  query: NonNullable<Snapshot['editableQuery']>,
  offset: number,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const limit = Math.max(1, Math.min(200, Math.floor(asNumber(input.limit, 100))));
  const pageElements = query.elements.slice(offset, offset + limit);
  const exposed: Record<string, unknown>[] = pageElements.map((element) =>
    exposeElement(
      element,
      snapshot.page.viewport,
      snapshot.frameRefs?.get(element.frameId ?? 'main'),
    ),
  );
  let returned = exposed;
  while (returned.length > 1 && byteLength({ targets: returned }) > 56 * 1024) {
    returned = returned.slice(0, -1);
  }
  const end = offset + returned.length;
  const truncated = end < query.elements.length;
  query.nextOffset = truncated ? end : null;
  return {
    success: true,
    url: snapshot.page.url,
    title: snapshot.page.title,
    viewport: snapshot.page.viewport,
    snapshotId: snapshot.id,
    offset,
    totalTargets: query.elements.length,
    returnedTargets: returned.length,
    targets: returned,
    truncated,
    ...(truncated ? { nextOffset: end } : {}),
    ...(truncated
      ? {
          continuation: {
            action: 'query',
            input: { kind: 'editable', snapshotId: snapshot.id, offset: end },
          },
        }
      : {}),
  };
}

function isEditableElement(
  element: Pick<ElementRecord, 'tag' | 'role' | 'type' | 'attributes'>,
): boolean {
  const tag = asString(element.tag).toLowerCase();
  const role = asString(element.role).toLowerCase();
  const attributes = isRecord(element.attributes) ? element.attributes : {};
  const type = asString(attributes.type, asString(element.type)).toLowerCase();
  if (tag === 'input' && NON_EDITABLE_INPUT_TYPES.has(type)) return false;
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    role === 'textbox' ||
    role === 'searchbox' ||
    asString(attributes.contenteditable).toLowerCase() === 'true' ||
    asString(attributes.role).toLowerCase() === 'textbox' ||
    asString(attributes.role).toLowerCase() === 'searchbox'
  );
}
