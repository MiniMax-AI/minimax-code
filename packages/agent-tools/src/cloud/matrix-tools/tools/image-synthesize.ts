/**
 * matrix_image_synthesize — Pattern D batch: Each request may include reference images
 * (input_file_paths) and an output path (output_file_path). Upload failure aborts the batch;
 * response-stage download failures are recorded in details without aborting the batch.
 */

import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';
import { basename } from 'node:path';

import type { MatrixMediaClient, MatrixPathScope, MatrixToolContext } from '../types.js';
import type { MatrixAigcRegisterServiceGetter } from '../aigc-helpers.js';
import { callMatrixToolRaw, type MatrixExecutor } from '../client.js';
import {
  FileTransferError,
  downloadOutputFile,
  fileTransferFailureResult,
  requireUploadedInputFileUrl,
  uploadInputFiles,
} from '../file-transfer.js';
import {
  MATRIX_TOOL_PATHS,
  MatrixImageSynthesizeToolDef,
  type MatrixImageSynthesizeInput,
} from '../tool-defs.js';
import { inferAigcMimeType, registerAigcIfPresent } from '../aigc-helpers.js';

interface ResultItem {
  is_success?: boolean;
  output_file?: string;
  output_url?: string;
  text_response?: string;
  has_image_output?: boolean;
  error_msg?: string;
  err_code?: string;
  // v5 AIGC watermark — mcp returns OSS keys for clean + visible bytes
  // it has already PUT to the public bucket. cloud-runtime forwards
  // them to archon-server `/api/v1/drive/aigc/register` so the chat-side
  // download path can pick the visible (watermarked) variant. Both
  // optional: missing pair → fall through to legacy deliver-assets
  // upload (un-watermarked).
  clean_oss_key?: string;
  visible_oss_key?: string;
}

interface PerRequestStatus {
  index: number;
  output_file_path: string;
  status: 'downloaded' | 'failed' | 'missing';
  bytes?: number;
  error?: string;
  text_response?: string;
}

function parseSlotIndex(echoed: string | undefined): number | null {
  if (typeof echoed !== 'string') return null;
  const m = echoed.match(/^slot_(\d+)\./);
  return m ? Number(m[1]) : null;
}

@bindTool(MatrixImageSynthesizeToolDef)
export class MatrixImageSynthesizeTool implements ToolImpl<
  typeof MatrixImageSynthesizeToolDef.schema,
  MatrixToolContext
> {
  constructor(
    private readonly archonServer: MatrixExecutor,
    private readonly ossMediaClient: MatrixMediaClient,
    private readonly workspaceScope: MatrixPathScope,
    private readonly aigcRegisterServiceGetter: MatrixAigcRegisterServiceGetter | null = null,
  ) {}

  async execute(
    ctx: MatrixToolContext,
    input: MatrixImageSynthesizeInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const toolName = MatrixImageSynthesizeToolDef.name;
    const path = MATRIX_TOOL_PATHS[toolName];

    // Upload phase — collect input_urls per request. Abort whole batch on failure.
    const uploadedUrlsPerRequest: string[][] = [];
    try {
      for (const r of input.requests) {
        if (r.input_file_paths && r.input_file_paths.length > 0) {
          const up = await uploadInputFiles(
            r.input_file_paths,
            this.workspaceScope,
            this.ossMediaClient,
            { forceRemoteUrl: true },
          );
          uploadedUrlsPerRequest.push(up.map((u) => requireUploadedInputFileUrl(u)));
        } else {
          uploadedUrlsPerRequest.push([]);
        }
      }
    } catch (err) {
      if (err instanceof FileTransferError) {
        return fileTransferFailureResult(toolName, path, err);
      }
      throw err;
    }

    // Build outgoing body — use input_urls only (signed); strip workspace-local paths.
    const body = {
      requests: input.requests.map((r, i) => {
        const item: Record<string, unknown> = {
          prompt: r.prompt,
          output_file: `slot_${i}.png`,
        };
        if (uploadedUrlsPerRequest[i]!.length > 0) {
          item.input_urls = uploadedUrlsPerRequest[i];
        }
        if (r.aspect_ratio !== undefined) item.aspect_ratio = r.aspect_ratio;
        if (r.resolution !== undefined) item.resolution = r.resolution;
        return item;
      }),
    };

    const raw = await callMatrixToolRaw({
      toolName,
      path,
      input: body,
      ctx,
      archonServer: this.archonServer,
      ...(signal ? { signal } : {}),
    });
    if (!raw.ok) return raw.result;

    const successItems = Array.isArray(raw.response.success_items)
      ? (raw.response.success_items as ResultItem[])
      : [];
    const failedItems = Array.isArray(raw.response.failed_items)
      ? (raw.response.failed_items as ResultItem[])
      : [];

    const perRequest: PerRequestStatus[] = input.requests.map((r, i) => ({
      index: i,
      output_file_path: r.output_file_path,
      status: 'missing',
    }));

    for (const item of successItems) {
      const idx = parseSlotIndex(item.output_file);
      if (idx === null || idx < 0 || idx >= perRequest.length) continue;
      const slot = perRequest[idx]!;
      if (item.text_response) slot.text_response = item.text_response;
      const url = item.output_url ?? '';
      if (!url || item.has_image_output === false) {
        slot.status = 'failed';
        slot.error = item.text_response
          ? `server returned text only (no image): ${item.text_response}`
          : 'server reported success but no output_url';
        continue;
      }
      try {
        const dl = await downloadOutputFile(
          url,
          slot.output_file_path,
          this.workspaceScope,
          this.ossMediaClient,
          { ...(signal ? { signal } : {}) },
        );
        slot.status = 'downloaded';
        slot.bytes = dl.bytes;
        slot.output_file_path = dl.absolutePath;
        // v5 AIGC watermark: when mcp returned clean (and optionally
        // visible) OSS keys for this slot, register the pair against
        // archon-server so the chat-side download picks the visible
        // variant. Helper is a fail-soft no-op when the service /
        // endpoint is unavailable.
        await registerAigcIfPresent({
          oss: { clean_oss_key: item.clean_oss_key, visible_oss_key: item.visible_oss_key },
          absolutePath: dl.absolutePath,
          fileName: basename(dl.absolutePath),
          sizeBytes: dl.bytes,
          mime: inferAigcMimeType(dl.absolutePath),
          sessionId: ctx.sessionId,
          toolName,
          registerService: this.aigcRegisterServiceGetter ? this.aigcRegisterServiceGetter() : null,
        });
      } catch (err) {
        if (err instanceof FileTransferError) {
          if (err.kind === 'path_escapes_workspace') {
            return fileTransferFailureResult(toolName, path, err);
          }
          slot.status = 'failed';
          slot.error = err.message;
          continue;
        }
        throw err;
      }
    }

    for (const item of failedItems) {
      const idx = parseSlotIndex(item.output_file);
      if (idx === null || idx < 0 || idx >= perRequest.length) continue;
      const slot = perRequest[idx]!;
      slot.status = 'failed';
      const code = item.err_code ? ` [${item.err_code}]` : '';
      slot.error = (item.error_msg ?? 'unknown server error') + code;
    }

    const downloaded = perRequest.filter((s) => s.status === 'downloaded').length;
    const failed = perRequest.filter((s) => s.status !== 'downloaded').length;
    const text = `${downloaded}/${perRequest.length} images saved (${failed} failed/missing).`;
    return {
      tool_name: toolName,
      text,
      content: [{ type: 'text', text }],
      details: {
        ok: true,
        path,
        total_succeeded: downloaded,
        total_failed: failed,
        per_request: perRequest,
      },
    };
  }
}
