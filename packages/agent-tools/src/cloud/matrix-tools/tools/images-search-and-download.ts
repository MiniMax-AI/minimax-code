/**
 * matrix_images_search_and_download — Pattern C-special: The server lists candidate images per
 * query (up to five). Download each `image_url` to `<dir>/<n>.<ext>` under the LLM's
 * `output_dir_path`. Individual failures do not block the batch; details summarize success/failure
 * counts.
 */

import { extname } from 'node:path';

import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import type { MatrixMediaClient, MatrixPathScope, MatrixToolContext } from '../types.js';
import { callMatrixToolRaw, type MatrixExecutor } from '../client.js';
import {
  FileTransferError,
  downloadOutputFile,
  fileTransferFailureResult,
} from '../file-transfer.js';
import {
  MATRIX_TOOL_PATHS,
  MatrixImagesSearchAndDownloadToolDef,
  type MatrixImagesSearchAndDownloadInput,
} from '../tool-defs.js';

interface FoundImage {
  image_url?: string;
  title?: string;
  source?: string;
  link?: string;
}

interface QueryResult {
  query?: string;
  images?: FoundImage[];
  error?: string;
}

interface QuerySummary {
  query: string;
  output_dir_path: string;
  downloaded: Array<{ index: number; image_url: string; local_path: string; bytes: number }>;
  failed: Array<{ index: number; image_url: string; reason: string }>;
  server_error?: string;
}

const FALLBACK_EXT = '.jpg';

function inferExt(url: string): string {
  try {
    const ext = extname(new URL(url).pathname).toLowerCase();
    if (!ext || ext.length > 5) return FALLBACK_EXT;
    return ext;
  } catch {
    return FALLBACK_EXT;
  }
}

@bindTool(MatrixImagesSearchAndDownloadToolDef)
export class MatrixImagesSearchAndDownloadTool implements ToolImpl<
  typeof MatrixImagesSearchAndDownloadToolDef.schema,
  MatrixToolContext
> {
  constructor(
    private readonly archonServer: MatrixExecutor,
    private readonly ossMediaClient: MatrixMediaClient,
    private readonly workspaceScope: MatrixPathScope,
  ) {}

  async execute(
    ctx: MatrixToolContext,
    input: MatrixImagesSearchAndDownloadInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const toolName = MatrixImagesSearchAndDownloadToolDef.name;
    const path = MATRIX_TOOL_PATHS[toolName];

    const body: Record<string, unknown> = {
      queries: input.queries.map((q) => ({
        query: q.query,
        ...(q.prompt !== undefined ? { prompt: q.prompt } : {}),
      })),
    };
    if (input.providers !== undefined) body.providers = input.providers;

    const raw = await callMatrixToolRaw({
      toolName,
      path,
      input: body,
      ctx,
      archonServer: this.archonServer,
      ...(signal ? { signal } : {}),
    });
    if (!raw.ok) return raw.result;

    const results = Array.isArray(raw.response.results)
      ? (raw.response.results as QueryResult[])
      : [];

    const summaries: QuerySummary[] = [];
    for (let i = 0; i < input.queries.length; i++) {
      const q = input.queries[i]!;
      const r = results[i];
      const summary: QuerySummary = {
        query: q.query,
        output_dir_path: q.output_dir_path,
        downloaded: [],
        failed: [],
      };
      if (r?.error) summary.server_error = r.error;
      const images = Array.isArray(r?.images) ? r.images : [];
      for (let j = 0; j < images.length; j++) {
        const url = images[j]?.image_url;
        if (!url) {
          summary.failed.push({ index: j, image_url: '', reason: 'missing image_url in response' });
          continue;
        }
        const localPath = `${q.output_dir_path.replace(/\/+$/, '')}/${j}${inferExt(url)}`;
        try {
          const dl = await downloadOutputFile(
            url,
            localPath,
            this.workspaceScope,
            this.ossMediaClient,
            { ...(signal ? { signal } : {}) },
          );
          summary.downloaded.push({
            index: j,
            image_url: url,
            local_path: dl.absolutePath,
            bytes: dl.bytes,
          });
        } catch (err) {
          if (err instanceof FileTransferError) {
            // Path-escape errors apply to the whole query (the dir is unsafe), so abort
            // this query and move on; per-image network failures are recorded.
            if (err.kind === 'path_escapes_workspace') {
              return fileTransferFailureResult(toolName, path, err);
            }
            summary.failed.push({ index: j, image_url: url, reason: err.message });
            continue;
          }
          throw err;
        }
      }
      summaries.push(summary);
    }

    const totalDownloaded = summaries.reduce((acc, s) => acc + s.downloaded.length, 0);
    const totalFailed = summaries.reduce((acc, s) => acc + s.failed.length, 0);
    const text =
      `${totalDownloaded} image(s) saved across ` +
      `${summaries.length} query(ies); ${totalFailed} failure(s).`;
    return {
      tool_name: toolName,
      text,
      content: [{ type: 'text', text }],
      details: {
        ok: true,
        path,
        total_downloaded: totalDownloaded,
        total_failed: totalFailed,
        per_query: summaries,
      },
    };
  }
}
