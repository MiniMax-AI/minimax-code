/**
 * matrix_image_reverse_search — Pattern D-special: Upload a local image to OSS for reverse image
 * search. Format the server's structured results (data: ReverseSearchResultItem[]) as Markdown and
 * write to the LLM-specified path. No remote files are downloaded.
 */

import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import type { MatrixMediaClient, MatrixPathScope, MatrixToolContext } from '../types.js';
import { callMatrixToolRaw, type MatrixExecutor } from '../client.js';
import {
  FileTransferError,
  fileTransferFailureResult,
  requireUploadedInputFileUrl,
  uploadInputFile,
  writeOutputText,
} from '../file-transfer.js';
import {
  MATRIX_TOOL_PATHS,
  MatrixImageReverseSearchToolDef,
  type MatrixImageReverseSearchInput,
} from '../tool-defs.js';

interface ReverseSearchItem {
  index?: number;
  title?: string;
  link?: string;
  source?: string;
  image_url?: string;
  snippet?: string;
}

function formatMarkdown(items: ReverseSearchItem[]): string {
  const lines: string[] = ['# Reverse Image Search Results', ''];
  if (items.length === 0) {
    lines.push('_No results._', '');
    return lines.join('\n');
  }
  items.forEach((it, i) => {
    const heading = `## ${i + 1}. ${it.title ?? '(untitled)'}`;
    lines.push(heading);
    if (it.link) lines.push(`- **Link:** ${it.link}`);
    if (it.source) lines.push(`- **Source:** ${it.source}`);
    if (it.image_url) lines.push(`- **Image:** ${it.image_url}`);
    if (it.snippet) lines.push(`- **Snippet:** ${it.snippet}`);
    lines.push('');
  });
  return lines.join('\n');
}

@bindTool(MatrixImageReverseSearchToolDef)
export class MatrixImageReverseSearchTool implements ToolImpl<
  typeof MatrixImageReverseSearchToolDef.schema,
  MatrixToolContext
> {
  constructor(
    private readonly archonServer: MatrixExecutor,
    private readonly ossMediaClient: MatrixMediaClient,
    private readonly workspaceScope: MatrixPathScope,
  ) {}

  async execute(
    ctx: MatrixToolContext,
    input: MatrixImageReverseSearchInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const toolName = MatrixImageReverseSearchToolDef.name;
    const path = MATRIX_TOOL_PATHS[toolName];
    try {
      const uploaded = await uploadInputFile(
        input.image_file_path,
        this.workspaceScope,
        this.ossMediaClient,
        { forceRemoteUrl: true },
      );
      const body = { image_url: requireUploadedInputFileUrl(uploaded) };
      const raw = await callMatrixToolRaw({
        toolName,
        path,
        input: body,
        ctx,
        archonServer: this.archonServer,
        ...(signal ? { signal } : {}),
      });
      if (!raw.ok) return raw.result;

      const items = Array.isArray(raw.response.data)
        ? (raw.response.data as ReverseSearchItem[])
        : [];
      const md = formatMarkdown(items);
      const written = await writeOutputText(md, input.output_file_path, this.workspaceScope);
      const text = `wrote ${items.length} result(s) (${written.bytes} bytes) to ${written.absolutePath}.`;
      return {
        tool_name: toolName,
        text,
        content: [{ type: 'text', text }],
        details: {
          ok: true,
          path,
          output_file_path: written.absolutePath,
          bytes: written.bytes,
          result_count: items.length,
        },
      };
    } catch (err) {
      if (err instanceof FileTransferError) {
        return fileTransferFailureResult(toolName, path, err);
      }
      throw err;
    }
  }
}
