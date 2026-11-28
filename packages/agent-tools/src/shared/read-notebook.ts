/**
 * read-notebook.ts — Jupyter notebook (.ipynb) dispatch for the `read` tool
 * wrappers.
 *
 * Why (design: `.harness/docs/design/tools-optimize/read-tool-optimization.md`
 * §2.5): without dispatch a notebook reads as raw JSON — the model burns
 * context parsing escape sequences, and matplotlib outputs (hundreds of KB
 * of base64) flood straight into the context window. Benefit: cell-structured
 * text the model can navigate, image outputs delivered as real vision blocks
 * (MiniMax-M3 supports image input), and oversized outputs replaced with an
 * actionable jq escape hatch instead of raw base64.
 *
 * Rendering contract is copied from reference CLI (src/utils/notebook.ts):
 * - `<cell id="cell-N">…</cell id="cell-N">` wrappers;
 * - metadata only when it carries signal: `<cell_type>` for non-code cells,
 *   `<language>` for non-python code cells (a python code cell has zero
 *   metadata overhead);
 * - outputs: stream text / execute_result & display_data `text/plain` (+
 *   `image/png` / `image/jpeg` extracted as image blocks) / error rendered
 *   as `ename: evalue\ntraceback`;
 * - a single cell whose outputs exceed 10K chars has them replaced by a jq
 *   hint (cc LARGE_OUTPUT_THRESHOLD);
 * - the whole notebook exceeding the size budget is an error carrying cc's
 *   four jq recipes.
 * `offset`/`limit` are ignored for notebooks, same as reference CLI — paging
 * a cell-structured document by line makes no sense; jq recipes cover the
 * huge-notebook case.
 */

import type { CoreToolFs } from '../core-tools/ports.js';
import { physicalToolFs } from './physical-fs.js';
import { extname } from 'node:path';

import type { ToolResult, ToolResultContent } from '@mavis/agent-core/tools';

import { readErrorResult } from './read-result.js';

/** reference CLI notebook.ts: LARGE_OUTPUT_THRESHOLD */
export const NOTEBOOK_LARGE_OUTPUT_CHARS = 10_000;
/** Same output byte budget as pi's text read (DEFAULT_MAX_BYTES). */
export const NOTEBOOK_MAX_OUTPUT_BYTES = 50 * 1024;

export function isNotebookReadPath(filePath: string): boolean {
  return extname(filePath).toLowerCase() === '.ipynb';
}

interface NotebookCell {
  id?: string;
  cell_type?: string;
  source?: string | string[];
  execution_count?: number | null;
  outputs?: NotebookOutput[];
}

interface NotebookOutput {
  output_type?: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

interface RenderedOutput {
  text: string;
  image?: { data: string; mimeType: string };
}

export interface ReadNotebookOptions {
  toolName: string;
  absolutePath: string;
  signal?: AbortSignal;
  /** Filesystem port; defaults to physical-fs. */
  fs?: Pick<CoreToolFs, 'readFile'>;
}

export async function readNotebookAsToolResult(opts: ReadNotebookOptions): Promise<ToolResult> {
  const { toolName, absolutePath, fs = physicalToolFs } = opts;

  let raw: string;
  try {
    raw = (await fs.readFile(absolutePath)).toString('utf-8');
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      return readErrorResult(toolName, `File does not exist: ${absolutePath}`);
    }
    throw err;
  }
  if (opts.signal?.aborted) throw new Error('Operation aborted');

  let notebook: { cells?: unknown; metadata?: Record<string, unknown> };
  try {
    notebook = JSON.parse(raw) as typeof notebook;
  } catch (err) {
    return readErrorResult(
      toolName,
      `Invalid notebook JSON: ${(err as Error).message}. The file is not a valid .ipynb notebook.`,
    );
  }
  if (!Array.isArray(notebook.cells)) {
    return readErrorResult(
      toolName,
      'Invalid notebook: missing "cells" array. The file is not a valid .ipynb notebook.',
    );
  }

  const language = notebookLanguage(notebook.metadata);
  const content: ToolResultContent[] = [];
  let textBuffer = '';
  let renderedBytes = 0;

  const pushText = (text: string): boolean => {
    const size = Buffer.byteLength(text, 'utf-8');
    if (renderedBytes + size > NOTEBOOK_MAX_OUTPUT_BYTES) return false;
    renderedBytes += size;
    textBuffer += text;
    return true;
  };
  // Image base64 counts toward the SAME budget as text: without this, many
  // sub-LARGE_OUTPUT images across cells (each passing the per-cell 10K check)
  // stack into hundreds of KB / MB of vision blocks — the per-cell guard only
  // bounds a single cell, not the whole notebook.
  const reserveImageBudget = (data: string): boolean => {
    const size = Buffer.byteLength(data, 'utf-8');
    if (renderedBytes + size > NOTEBOOK_MAX_OUTPUT_BYTES) return false;
    renderedBytes += size;
    return true;
  };
  const flushText = () => {
    if (textBuffer !== '') {
      content.push({ type: 'text', text: textBuffer });
      textBuffer = '';
    }
  };

  const cells = notebook.cells as NotebookCell[];
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index] ?? {};
    const cellId = cell.id ?? `cell-${index}`;
    const cellType = cell.cell_type ?? 'code';
    const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '');

    // Conditional metadata, copied from cc: only emit what carries signal.
    const metadata: string[] = [];
    if (cellType !== 'code') metadata.push(`<cell_type>${cellType}</cell_type>`);
    if (cellType === 'code' && language !== 'python')
      metadata.push(`<language>${language}</language>`);

    const header = `${index > 0 ? '\n' : ''}<cell id="${cellId}">${metadata.join('')}${source}</cell id="${cellId}">`;
    if (!pushText(header)) {
      return notebookTooLargeError(toolName, absolutePath);
    }

    if (cellType !== 'code' || !cell.outputs?.length) continue;

    const rendered = cell.outputs.map(renderOutput);
    if (isLargeOutputs(rendered)) {
      // cc behavior: don't dump hundreds of KB of base64/text — replace the
      // whole cell's outputs with an actionable jq escape hatch.
      pushText(
        `\nOutputs are too large to include. Use bash with: cat "${absolutePath}" | jq '.cells[${index}].outputs'`,
      );
      continue;
    }
    for (const output of rendered) {
      if (output.text) {
        if (!pushText(`\n${output.text}`)) {
          return notebookTooLargeError(toolName, absolutePath);
        }
      }
      if (output.image) {
        if (!reserveImageBudget(output.image.data)) {
          return notebookTooLargeError(toolName, absolutePath);
        }
        flushText();
        content.push({ type: 'image', data: output.image.data, mimeType: output.image.mimeType });
      }
    }
  }
  flushText();

  if (content.length === 0) {
    content.push({
      type: 'text',
      text: '<system-reminder>Warning: the notebook exists but has no cells.</system-reminder>',
    });
  }

  return {
    tool_name: toolName,
    text: content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n'),
    content,
    details: { notebook: { total_cells: cells.length } },
  };
}

function notebookLanguage(metadata: Record<string, unknown> | undefined): string {
  const kernelspec = metadata?.kernelspec as { language?: string } | undefined;
  const languageInfo = metadata?.language_info as { name?: string } | undefined;
  return kernelspec?.language ?? languageInfo?.name ?? 'python';
}

function renderOutput(output: NotebookOutput): RenderedOutput {
  switch (output.output_type) {
    case 'stream':
      return { text: joinText(output.text) };
    case 'execute_result':
    case 'display_data': {
      const data = output.data ?? {};
      const image = extractImage(data);
      return { text: joinText(data['text/plain'] as string | string[] | undefined), image };
    }
    case 'error':
      return {
        text: `${output.ename ?? 'Error'}: ${output.evalue ?? ''}\n${(output.traceback ?? []).join('\n')}`,
      };
    default:
      return { text: '' };
  }
}

function joinText(text: string | string[] | undefined): string {
  if (!text) return '';
  return Array.isArray(text) ? text.join('') : text;
}

function extractImage(data: Record<string, unknown>): RenderedOutput['image'] {
  if (typeof data['image/png'] === 'string') {
    return { data: data['image/png'].replaceAll(/\s/g, ''), mimeType: 'image/png' };
  }
  if (typeof data['image/jpeg'] === 'string') {
    return { data: data['image/jpeg'].replaceAll(/\s/g, ''), mimeType: 'image/jpeg' };
  }
  return undefined;
}

function isLargeOutputs(outputs: RenderedOutput[]): boolean {
  let size = 0;
  for (const output of outputs) {
    size += output.text.length + (output.image ? output.image.data.length : 0);
    if (size > NOTEBOOK_LARGE_OUTPUT_CHARS) return true;
  }
  return false;
}

/** cc's four jq recipes — a concrete self-serve path instead of a dead end. */
function notebookTooLargeError(toolName: string, filePath: string): ToolResult {
  return readErrorResult(
    toolName,
    `Notebook content exceeds the maximum output size (${NOTEBOOK_MAX_OUTPUT_BYTES} bytes). ` +
      'Use bash with jq to read specific portions:\n' +
      `  cat "${filePath}" | jq '.cells[:20]' # First 20 cells\n` +
      `  cat "${filePath}" | jq '.cells[100:120]' # Cells 100-120\n` +
      `  cat "${filePath}" | jq '.cells | length' # Count total cells\n` +
      `  cat "${filePath}" | jq '.cells[] | select(.cell_type=="code") | .source' # All code sources`,
  );
}
