/**
 * matrix_synthesize_speech — Pattern C: The server returns a CDN URL after TTS; download it to the
 * LLM-specified workspace path before returning.
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
  MatrixSynthesizeSpeechToolDef,
  type MatrixSynthesizeSpeechInput,
} from '../tool-defs.js';
import { inferAigcMimeType, registerAigcIfPresent } from '../aigc-helpers.js';

@bindTool(MatrixSynthesizeSpeechToolDef)
export class MatrixSynthesizeSpeechTool implements ToolImpl<
  typeof MatrixSynthesizeSpeechToolDef.schema,
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
    input: MatrixSynthesizeSpeechInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const toolName = MatrixSynthesizeSpeechToolDef.name;
    const path = MATRIX_TOOL_PATHS[toolName];

    // Strip output_file_path before sending — server doesn't need it.
    const { output_file_path: _stripped, ...body } = input;

    const raw = await callMatrixToolRaw({
      toolName,
      path,
      input: body,
      ctx,
      archonServer: this.archonServer,
      ...(signal ? { signal } : {}),
    });
    if (!raw.ok) return raw.result;

    const outputUrl = typeof raw.response.output_url === 'string' ? raw.response.output_url : '';
    if (!outputUrl) {
      const err = typeof raw.response.error === 'string' ? raw.response.error : '';
      const text = `server response missing output_url${
        err ? ` (server error: ${err})` : '. Cannot download generated audio.'
      }`;
      return {
        tool_name: toolName,
        text,
        content: [{ type: 'text', text }],
        details: { ok: false, path, reason: 'missing_output_url', response: raw.response },
      };
    }

    try {
      const downloaded = await downloadOutputFile(
        outputUrl,
        input.output_file_path,
        this.workspaceScope,
        this.ossMediaClient,
        { ...(signal ? { signal } : {}) },
      );
      // v5 AIGC watermark — single-output flavor: OSS keys (when present)
      // sit at the top level of the response. Same fail-soft contract.
      const cleanKey =
        typeof raw.response.clean_oss_key === 'string' ? raw.response.clean_oss_key : undefined;
      const visibleKey =
        typeof raw.response.visible_oss_key === 'string' ? raw.response.visible_oss_key : undefined;
      await registerAigcIfPresent({
        oss: { clean_oss_key: cleanKey, visible_oss_key: visibleKey },
        absolutePath: downloaded.absolutePath,
        fileName: basename(downloaded.absolutePath),
        sizeBytes: downloaded.bytes,
        mime: inferAigcMimeType(downloaded.absolutePath),
        sessionId: ctx.sessionId,
        toolName,
        registerService: this.aigcRegisterServiceGetter ? this.aigcRegisterServiceGetter() : null,
      });
      const text = `wrote ${downloaded.bytes} bytes to ${downloaded.absolutePath}.`;
      return {
        tool_name: toolName,
        text,
        content: [{ type: 'text', text }],
        details: {
          ok: true,
          path,
          output_file_path: downloaded.absolutePath,
          bytes: downloaded.bytes,
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
