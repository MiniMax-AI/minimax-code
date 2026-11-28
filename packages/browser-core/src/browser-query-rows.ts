import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { OMIT_DATA_URLS_SOURCE } from './browser-data-url.js';
import { PAGE_CREDENTIAL_CONTROL_SOURCE, REDACTED_VALUE } from './browser-form-state.js';
import { asNumber, asString, byteLength, isRecord } from './browser-state.js';

/**
 * `query kind: "rows"`: one fixed host-owned read that turns every element
 * matching a row selector into one record, instead of a model probing or
 * paging a grid with one run_script after another. Only the row selector, field
 * selectors, attribute names and numeric
 * bounds reach the page, all JSON-encoded; no model-written JavaScript runs.
 * offset/limit count rows (`offsetUnit: "row"`), unlike the character offset
 * of a single text/dom read and the match offset of `all: true`.
 */

const ROWS_DEFAULT_LIMIT = 100;
const ROWS_MAX_LIMIT = 200;
const ROWS_DEFAULT_CELL_CHARS = 500;
const ROWS_MAX_CELL_CHARS = 10_000;
const ROWS_MAX_FIELDS = 50;
const ROWS_MAX_FIELD_NAME = 100;
const ROWS_MAX_FIELD_SPEC = 1_000;
/** Same page budget as `all: true` and editable pages, below the 64 KiB compact result cap. */
export const ROWS_PAGE_BYTES = 56 * 1024;
/** Rows a first page spills into `fullOutputPath` when it cannot hold them all. */
export const ROWS_FILE_MAX_ROWS = 5_000;
/**
 * Serialized characters the spill read stops after, so 5,000 rows of
 * 10,000-character cells (tens of MB) never cross CDP; a file cut short
 * reports `fullOutputComplete: false`.
 */
export const ROWS_FILE_BUDGET = 8 * 1024 * 1024;
/** Spill directory under the OS temp dir, the same place Pi's bash spill uses. */
export const ROWS_FILE_DIRECTORY = 'mavis-browser-rows';

export type RowCell = string | boolean | null;

/** A field reads `selector` inside the row (null: the row itself), then `attribute` or its value/text. */
type FieldSource = [selector: string | null, attribute: string | null];

export interface RowsRequest {
  selector: string;
  /** Absent: each row returns the readings of its direct children (cells) as an array. */
  fields?: { names: string[]; sources: FieldSource[]; input: Record<string, string> };
  offset: number;
  limit: number;
  maxChars: number;
}

/** What the page expression returns; `cut` lists [row index, column, full length]. */
export interface RowsRead {
  invalidField?: number;
  invalidMessage?: string;
  totalRows: number;
  rows: RowCell[][];
  cut: [number, number, number][];
  url: string;
  title: string;
}

interface TruncatedCell {
  row: number;
  field: string | number;
  totalLength: number;
}

const ATTRIBUTE_SUFFIX = /^([\s\S]*?)\s*@([A-Za-z_][\w.:-]*)$/u;

/**
 * A field value is "text" (the row's own reading), a CSS selector relative to
 * the row, `selector@attribute`, or `@attribute` of the row. An `@` escaped in
 * a class name (`.w-1\@sm`) stays part of the selector.
 */
function fieldSource(spec: string): FieldSource {
  const trimmed = spec.trim();
  if (trimmed === 'text') return [null, null];
  const [, prefix = '', attribute] = ATTRIBUTE_SUFFIX.exec(trimmed) ?? [];
  if (attribute && !prefix.endsWith('\\')) return [prefix.trim() || null, attribute];
  return [trimmed, null];
}

export function parseRowsRequest(input: Record<string, unknown>): RowsRequest {
  const selector = asString(input.selector).trim();
  if (!selector) {
    throw new Error(
      'query kind "rows" requires input.selector: one CSS selector matching every row, for example "table tbody tr".',
    );
  }
  let fields: RowsRequest['fields'];
  if (input.fields !== undefined) {
    const entries = isRecord(input.fields) ? Object.entries(input.fields) : [];
    if (entries.length === 0 || entries.length > ROWS_MAX_FIELDS) {
      throw new Error(
        `query kind "rows" fields must be an object with 1-${ROWS_MAX_FIELDS} entries mapping a field name to a CSS selector relative to the row, "selector@attribute", or "text".`,
      );
    }
    const invalid = entries.find(
      ([name, spec]) =>
        !name.trim() ||
        name.length > ROWS_MAX_FIELD_NAME ||
        typeof spec !== 'string' ||
        !spec.trim() ||
        spec.length > ROWS_MAX_FIELD_SPEC,
    );
    if (invalid) {
      throw new Error(
        `query kind "rows" field ${JSON.stringify(invalid[0])} needs a non-empty name (at most ${ROWS_MAX_FIELD_NAME} characters) and a non-empty string value (at most ${ROWS_MAX_FIELD_SPEC} characters).`,
      );
    }
    const specs = entries as [string, string][];
    fields = {
      names: specs.map(([name]) => name),
      sources: specs.map(([, spec]) => fieldSource(spec)),
      input: Object.fromEntries(specs),
    };
  }
  return {
    selector,
    ...(fields ? { fields } : {}),
    offset: Math.max(0, Math.floor(asNumber(input.offset, 0))),
    limit: Math.max(
      1,
      Math.min(ROWS_MAX_LIMIT, Math.floor(asNumber(input.limit, ROWS_DEFAULT_LIMIT))),
    ),
    maxChars: Math.max(
      1,
      Math.min(ROWS_MAX_CELL_CHARS, Math.floor(asNumber(input.maxChars, ROWS_DEFAULT_CELL_CHARS))),
    ),
  };
}

/**
 * Fixed page read of rows [offset, end). The read stops once the serialized
 * rows exceed `budget` characters (a page's host trims to exact bytes).
 * Form controls report their live value only with `liveFormState`
 * (`beta.browserReadV2`), which also turns long data: URLs in cells into
 * placeholders; otherwise every element reads as kind "text" does.
 * A cell whose only content is one control (a grid's qty input or size
 * select) reads as that control. Credential inputs/textareas (the
 * `isCredentialControl` rule, sticky marks included) read as "[REDACTED]" in
 * both modes, and so does their value attribute. Lists map through
 * Array.prototype.map: Prototype.js and MooTools replace Array.from with a
 * version that ignores its map function.
 */
export function rowsExpression(
  request: RowsRequest,
  bounds: { end: number; budget: number },
  liveFormState: boolean,
): string {
  const { maxChars } = request;
  const liveRead = liveFormState
    ? `
      if (tag === 'select') return Array.prototype.map.call(element.selectedOptions, (option) => option.text.trim()).join(', ');
      if (tag === 'textarea') return element.value;
      if (tag === 'input') {
        const type = String(element.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') return element.checked;
        if (type !== 'file') return element.value;
      }`
    : '';
  return `(() => {
    const sources = ${JSON.stringify(request.fields?.sources ?? null)};
    if (sources) {
      const probe = document.createDocumentFragment();
      for (let index = 0; index < sources.length; index += 1) {
        if (sources[index][0] === null) continue;
        try {
          probe.querySelector(sources[index][0]);
        } catch (error) {
          return { invalidField: index, invalidMessage: String((error && error.message) || error) };
        }
      }
    }
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(request.selector)}))
      .filter((element) => !element.closest('[data-mavis-agent-cursor-host]'));
    const credential = ${PAGE_CREDENTIAL_CONTROL_SOURCE};${
      liveFormState ? `\n    const omitDataUrls = ${OMIT_DATA_URLS_SOURCE};` : ''
    }
    // Script/style/noscript/template content is not text. innerText leaves it
    // out only on a rendered element (unrendered, it is textContent), so other
    // elements read textContent from a copy without those nodes.
    const NOT_TEXT = 'script, style, noscript, template';
    const withoutCode = (copy) => {
      copy.querySelectorAll(NOT_TEXT).forEach((node) => node.remove());
      return copy;
    };
    const textOf = (element) => {
      if (element.getClientRects().length > 0 && element.innerText) return String(element.innerText).trim();
      const source = element.querySelector(NOT_TEXT) ? withoutCode(element.cloneNode(true)) : element;
      return String(source.textContent || '').trim();
    };
    const read = (element) => {
      const tag = element.localName;
      if (credential(element)) return ${JSON.stringify(REDACTED_VALUE)};${liveRead}
      if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') {
        const controls = element.querySelectorAll('input:not([type="hidden"]), select, textarea');
        if (controls.length === 1 && textOf(element) === textOf(controls[0])) return read(controls[0]);
      }
      // A cell's text fallback (textContent) would include a nested credential
      // textarea's content, so such a cell reads from a redacted copy.
      const textareas = Array.from(element.querySelectorAll('textarea'));
      if (textareas.some((area) => credential(area))) {
        const copy = element.cloneNode(true);
        copy.querySelectorAll('textarea').forEach((area, index) => {
          if (credential(textareas[index])) area.textContent = ${JSON.stringify(REDACTED_VALUE)};
        });
        return String(withoutCode(copy).textContent || '').trim();
      }
      return textOf(element);
    };
    const attribute = (element, name) => {
      if (!element.hasAttribute(name)) return null;
      if (name.toLowerCase() === 'value' && credential(element)) return ${JSON.stringify(REDACTED_VALUE)};
      return element.getAttribute(name);
    };
    const rows = [];
    const cut = [];
    let chars = 0;
    const end = Math.min(nodes.length, ${bounds.end});
    for (let index = ${request.offset}; index < end; index += 1) {
      if (rows.length > 0 && chars > ${bounds.budget}) break;
      const row = nodes[index];
      const cells = sources
        ? sources.map(([selector, name]) => {
            const target = selector === null ? row : row.querySelector(selector);
            if (!target) return null;
            return name === null ? read(target) : attribute(target, name);
          })
        : Array.prototype.map.call(row.children, (child) => read(child));
      const kept = cells.map((source, column) => {
        const cell = ${liveFormState ? `typeof source === 'string' ? omitDataUrls(source) : source` : 'source'};
        if (typeof cell !== 'string' || cell.length <= ${maxChars}) return cell;
        cut.push([index, column, cell.length]);
        const code = cell.charCodeAt(${maxChars - 1});
        return cell.slice(0, code >= 0xd800 && code <= 0xdbff ? ${maxChars - 1} : ${maxChars});
      });
      chars += JSON.stringify(kept).length;
      rows.push(kept);
    }
    return { totalRows: nodes.length, rows, cut, url: location.href, title: document.title };
  })()`;
}

/** Field objects (or cell arrays without fields) plus the cut cells among them. */
function shapeRows(
  request: RowsRequest,
  read: RowsRead,
  count: number,
): { rows: (Record<string, RowCell> | RowCell[])[]; truncatedCells: TruncatedCell[] } {
  const names = request.fields?.names;
  const rows = read.rows
    .slice(0, count)
    .map((cells) =>
      names
        ? Object.fromEntries(names.map((name, column) => [name, cells[column] ?? null]))
        : cells,
    );
  const end = request.offset + count;
  const truncatedCells = read.cut
    .filter(([row]) => row < end)
    .map(([row, column, totalLength]) => ({
      row,
      field: names?.[column] ?? column,
      totalLength,
    }));
  return { rows, truncatedCells };
}

/** One page of rows trimmed to `ROWS_PAGE_BYTES`, with an exact continuation when more remain. */
export function rowsPage(request: RowsRequest, read: RowsRead): Record<string, unknown> {
  const { selector, offset, limit, maxChars } = request;
  let count = read.rows.length;
  let shaped = shapeRows(request, read, count);
  while (count > 1 && byteLength(shaped) > ROWS_PAGE_BYTES) {
    count -= 1;
    shaped = shapeRows(request, read, count);
  }
  const end = offset + count;
  const hasMore = end < read.totalRows;
  return {
    success: true,
    url: read.url,
    title: read.title,
    selector,
    offset,
    offsetUnit: 'row',
    totalRows: read.totalRows,
    returnedRows: count,
    rows: shaped.rows,
    ...(shaped.truncatedCells.length > 0 ? { truncatedCells: shaped.truncatedCells } : {}),
    truncated: hasMore,
    ...(hasMore
      ? {
          nextOffset: end,
          continuation: {
            action: 'query',
            input: {
              kind: 'rows',
              selector,
              ...(request.fields ? { fields: request.fields.input } : {}),
              offset: end,
              limit,
              maxChars,
            },
          },
        }
      : {}),
  };
}

/**
 * Write rows [0, ROWS_FILE_MAX_ROWS) as one JSON document with a row per line,
 * so a line-paged file read can follow it. Cells carry the same truncation and
 * credential redaction as the inline page.
 */
export async function writeRowsFile(
  request: RowsRequest,
  read: RowsRead,
): Promise<{ fullOutputPath: string; fullOutputRows: number; fullOutputComplete: boolean }> {
  const { rows, truncatedCells } = shapeRows(request, read, read.rows.length);
  const directory = path.join(os.tmpdir(), ROWS_FILE_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `rows-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  const header = JSON.stringify({
    url: read.url,
    title: read.title,
    selector: request.selector,
    ...(request.fields ? { fields: request.fields.input } : {}),
    offset: request.offset,
    offsetUnit: 'row',
    totalRows: read.totalRows,
    returnedRows: rows.length,
    maxChars: request.maxChars,
    truncatedCells,
  });
  const body = rows.map((row) => JSON.stringify(row)).join(',\n');
  await writeFile(file, `${header.slice(0, -1)},"rows":[\n${body}\n]}\n`, { mode: 0o600 });
  return {
    fullOutputPath: file,
    fullOutputRows: rows.length,
    fullOutputComplete: request.offset + rows.length === read.totalRows,
  };
}

/** A field selector the browser rejected, named by its field. */
export function invalidRowsField(
  request: RowsRequest,
  read: RowsRead,
  hint: (selector: string) => string | undefined,
): Record<string, unknown> {
  const index = read.invalidField ?? 0;
  const name = request.fields?.names[index] ?? String(index);
  const selector = request.fields?.sources[index]?.[0] ?? '';
  return {
    success: false,
    code: 'INVALID_SELECTOR',
    field: name,
    error: `fields.${name}: ${read.invalidMessage ?? 'not a valid selector'}`,
    recovery:
      hint(selector) ??
      'Each fields value is a standard CSS selector relative to the row (optionally followed by @attribute), "@attribute" of the row itself, or "text" for the whole row.',
  };
}

/** A row selector that matched nothing: Core's selector diagnostics plus what rows needs. */
export const ROWS_SELECTOR_MISS_HINT =
  'kind "rows" needs input.selector to match every row element (for example "table tbody tr" or "ul.results > li"); if the grid renders after loading, wait for kind "selector" first.';
