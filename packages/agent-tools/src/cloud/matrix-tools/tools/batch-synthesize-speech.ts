/**
 * matrix_batch_synthesize_speech — Pattern C batch: The server performs TTS for N requests and
 * splits success_items/failed_items. Send `slot_<i>.mp3` as the `output_file` placeholder, map the
 * echoed field back to the LLM's local path, and download each `output_url`. Individual failures do
 * not block the batch.
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
} from '../file-transfer.js';
import {
  MATRIX_TOOL_PATHS,
  MatrixBatchSynthesizeSpeechToolDef,
  type MatrixBatchSynthesizeSpeechInput,
} from '../tool-defs.js';
import { inferAigcMimeType, registerAigcIfPresent } from '../aigc-helpers.js';

interface ResultItem {
  is_success?: boolean;
  output_file?: string;
  output_url?: string;
  error_msg?: string;
  // v5 AIGC watermark — see image-synthesize.ts for shape rationale.
  clean_oss_key?: string;
  visible_oss_key?: string;
}

interface PerRequestStatus {
  index: number;
  output_file_path: string;
  status: 'downloaded' | 'failed' | 'missing';
  bytes?: number;
  error?: string;
}

function parseSlotIndex(echoed: string | undefined): number | null {
  if (typeof echoed !== 'string') return null;
  const m = echoed.match(/^slot_(\d+)\./);
  return m ? Number(m[1]) : null;
}

@bindTool(MatrixBatchSynthesizeSpeechToolDef)
export class MatrixBatchSynthesizeSpeechTool implements ToolImpl<
  typeof MatrixBatchSynthesizeSpeechToolDef.schema,
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
    input: MatrixBatchSynthesizeSpeechInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const toolName = MatrixBatchSynthesizeSpeechToolDef.name;
    const path = MATRIX_TOOL_PATHS[toolName];

    const body = {
      requests: input.requests.map((r, i) => {
        const item: Record<string, unknown> = {
          text: r.text,
          output_file: `slot_${i}.mp3`,
        };
        if (r.voice_id !== undefined) item.voice_id = r.voice_id;
        if (r.speed !== undefined) item.speed = r.speed;
        if (r.volume !== undefined) item.volume = r.volume;
        if (r.pitch !== undefined) item.pitch = r.pitch;
        if (r.emotion !== undefined) item.emotion = r.emotion;
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
      const url = item.output_url ?? '';
      if (!url) {
        slot.status = 'failed';
        slot.error = 'server reported success but output_url is empty';
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
        // v5 AIGC watermark — register clean+visible OSS pair if mcp returned them.
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
      slot.error = item.error_msg ?? 'unknown server error';
    }

    const downloaded = perRequest.filter((s) => s.status === 'downloaded').length;
    const failed = perRequest.filter((s) => s.status !== 'downloaded').length;
    const text = `${downloaded}/${perRequest.length} succeeded (${failed} failed/missing).`;
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
