/**
 * read-pdf.ts — PDF dispatch for the `read` tool wrappers.
 *
 * Why (design: `.harness/docs/design/tools-optimize/read-tool-optimization.md`
 * §2.4): the pi engine has no type dispatch — a `.pdf` goes down the UTF-8
 * text path and the model receives compressed-stream garbage. Benefit: PDFs
 * become readable with bounded, pageable output.
 *
 * Behavior contract is copied from reference CLI FileReadTool (page-range
 * grammar incl. open-ended "5-", validation before any file I/O, the
 * 10-page must-provide-pages threshold, the 20-pages-per-request cap and
 * the exact error wordings). The content channel deviates deliberately:
 * cc ships the PDF as a native document block or rasterizes pages via
 * poppler — MiniMax-M3 has no document-block input and poppler is a system
 * dependency we cannot assume on user machines, so we extract text with
 * `unpdf` (self-contained, no worker setup). Page rasterization for
 * layout-heavy PDFs is a recorded follow-up.
 *
 * `unpdf` is imported lazily inside the PDF branch only — it embeds a
 * ~2MB pdfjs build that must not sit on the startup path of every read.
 */

import type { CoreToolFs } from '../core-tools/ports.js';
import { physicalToolFs } from './physical-fs.js';
import { extname } from 'node:path';

import type { ToolResult } from '@mavis/agent-core/tools';

import { readErrorResult } from './read-result.js';

/** reference CLI apiLimits.ts: PDF_MAX_PAGES_PER_READ */
export const PDF_MAX_PAGES_PER_READ = 20;
/** reference CLI apiLimits.ts: PDF_AT_MENTION_INLINE_THRESHOLD */
export const PDF_FULL_READ_PAGE_THRESHOLD = 10;
/** Same output byte budget as pi's text read (DEFAULT_MAX_BYTES). */
export const PDF_MAX_OUTPUT_BYTES = 50 * 1024;

export function isPdfReadPath(filePath: string): boolean {
  return extname(filePath).toLowerCase() === '.pdf';
}

export interface PdfPageRange {
  firstPage: number;
  /** `Infinity` for open-ended ranges like "5-" (read to the last page). */
  lastPage: number;
}

/**
 * Page-range grammar copied from reference CLI `parsePDFPageRange`
 * (src/utils/pdfUtils.ts): "3", "1-10", open-ended "5-". Returns null for
 * anything invalid (0, negative, reversed ranges, non-numeric).
 */
export function parsePdfPageRange(pages: string): PdfPageRange | null {
  const trimmed = pages.trim();
  if (!trimmed) return null;

  if (trimmed.endsWith('-')) {
    const first = Number.parseInt(trimmed.slice(0, -1), 10);
    if (Number.isNaN(first) || first < 1 || !/^\d+-$/.test(trimmed)) return null;
    return { firstPage: first, lastPage: Number.POSITIVE_INFINITY };
  }

  const dashIndex = trimmed.indexOf('-');
  if (dashIndex === -1) {
    if (!/^\d+$/.test(trimmed)) return null;
    const page = Number.parseInt(trimmed, 10);
    if (Number.isNaN(page) || page < 1) return null;
    return { firstPage: page, lastPage: page };
  }

  if (!/^\d+-\d+$/.test(trimmed)) return null;
  const first = Number.parseInt(trimmed.slice(0, dashIndex), 10);
  const last = Number.parseInt(trimmed.slice(dashIndex + 1), 10);
  if (Number.isNaN(first) || Number.isNaN(last) || first < 1 || last < 1 || last < first) {
    return null;
  }
  return { firstPage: first, lastPage: last };
}

/**
 * Validates the `pages` parameter without touching the file (reference CLI
 * runs the same check in validateInput, before any I/O — invalid input
 * must not cost a PDF parse). Returns a model-readable error or null.
 */
export function validatePdfPagesParam(pages: string): string | null {
  const parsed = parsePdfPageRange(pages);
  if (!parsed) {
    return (
      `Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". ` +
      'Pages are 1-indexed.'
    );
  }
  const rangeSize =
    parsed.lastPage === Number.POSITIVE_INFINITY
      ? PDF_MAX_PAGES_PER_READ + 1
      : parsed.lastPage - parsed.firstPage + 1;
  if (rangeSize > PDF_MAX_PAGES_PER_READ) {
    return (
      `Page range "${pages}" exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request. ` +
      'Please use a smaller range.'
    );
  }
  return null;
}

export interface ReadPdfOptions {
  toolName: string;
  absolutePath: string;
  pages?: string;
  signal?: AbortSignal;
  /** Filesystem port; defaults to physical-fs. */
  fs?: Pick<CoreToolFs, 'readFile'>;
}

/**
 * Read a PDF as per-page text. `offset`/`limit` do not apply here (the
 * reference CLI ignores them for PDFs too) — paging is expressed with `pages`.
 */
export async function readPdfAsToolResult(opts: ReadPdfOptions): Promise<ToolResult> {
  const { toolName, absolutePath, pages, fs = physicalToolFs } = opts;

  // 1. Pure string validation first — no file I/O for malformed input.
  if (pages !== undefined) {
    const invalid = validatePdfPagesParam(pages);
    if (invalid) return readErrorResult(toolName, invalid);
  }

  // 2. Read bytes. ENOENT gets a friendly recoverable error. Callers that need
  // pi-compatible filename variants resolve them before invoking this helper.
  let data: Uint8Array;
  try {
    data = new Uint8Array(await fs.readFile(absolutePath));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      return readErrorResult(toolName, `File does not exist: ${absolutePath}`);
    }
    throw err;
  }
  if (opts.signal?.aborted) throw new Error('Operation aborted');

  // 3. Parse. Lazy import keeps the ~2MB pdfjs build off the startup path
  // and off every non-PDF read (locked by unit test).
  try {
    const { getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(data);
    const totalPages = pdf.numPages;

    if (pages === undefined && totalPages > PDF_FULL_READ_PAGE_THRESHOLD) {
      return readErrorResult(
        toolName,
        `This PDF has ${totalPages} pages, which is too many to read at once. ` +
          'Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). ' +
          `Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
      );
    }

    const range = pages !== undefined ? parsePdfPageRange(pages) : null;
    const firstPage = range ? range.firstPage : 1;
    const lastPage = range ? Math.min(range.lastPage, totalPages) : totalPages;
    if (firstPage > totalPages) {
      return readErrorResult(
        toolName,
        `Page range "${pages}" is out of range: the PDF has ${totalPages} pages.`,
      );
    }
    if (lastPage - firstPage + 1 > PDF_MAX_PAGES_PER_READ) {
      return readErrorResult(
        toolName,
        `Page range "${pages}" exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request. ` +
          'Please use a smaller range.',
      );
    }

    // Per-page extraction (CR !4027 round-2 P2): unpdf's extractText parses
    // the WHOLE document, which would defeat the 20-page cap on a
    // hundreds-of-pages PDF (timeouts / memory). pdfjs loads pages lazily,
    // so pulling text page-by-page keeps the cost proportional to the
    // requested range — pinned by a getPage call-count test.
    let output = '';
    let truncatedAtPage: number | undefined;
    for (let page = firstPage; page <= lastPage; page += 1) {
      if (opts.signal?.aborted) throw new Error('Operation aborted');
      const pageText = await extractPdfPageText(pdf, page);
      const segment = `${output === '' ? '' : '\n\n'}== Page ${page} ==\n${pageText}`;
      if (Buffer.byteLength(output + segment, 'utf-8') > PDF_MAX_OUTPUT_BYTES) {
        truncatedAtPage = page;
        break;
      }
      output += segment;
    }
    if (truncatedAtPage !== undefined) {
      output += `\n\n[Truncated at page ${truncatedAtPage} (${PDF_MAX_OUTPUT_BYTES} byte limit). Use pages="${truncatedAtPage}-${Math.min(truncatedAtPage + PDF_MAX_PAGES_PER_READ - 1, totalPages)}" to continue.]`;
    }

    return {
      tool_name: toolName,
      text: output,
      content: [{ type: 'text', text: output }],
      details: {
        pdf: {
          total_pages: totalPages,
          pages_read: [firstPage, truncatedAtPage !== undefined ? truncatedAtPage - 1 : lastPage],
        },
      },
    };
  } catch (err) {
    if ((err as Error).message === 'Operation aborted') throw err;
    // Encrypted, corrupt or misnamed (text renamed to .pdf) files land here.
    return readErrorResult(
      toolName,
      `Failed to parse PDF: ${(err as Error).message ?? String(err)}. ` +
        'The file may be corrupt, encrypted, or not a real PDF.',
    );
  }
}

/** Minimal pdfjs page-proxy surface needed for text extraction. */
interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
  }>;
}

/**
 * Extract the text of a single page via pdfjs' lazy page loading. Exported
 * for the call-count test that pins the "only requested pages are parsed"
 * contract (CR !4027 round-2 P2).
 */
export async function extractPdfPageText(pdf: unknown, pageNumber: number): Promise<string> {
  const page = await (pdf as PdfDocumentLike).getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items
    .map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : ' '))
    .join('')
    .trim();
}
