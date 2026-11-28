/**
 * matrix_audios_understand —— Pattern B:批量本地音频上传 OSS,签名 URL 列表
 * 喂给 mcp-server 后端 Gemini 理解,返回 list<MediaUnderstandResult> 文本,
 * 不下载任何产物。
 */

import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import type { MatrixMediaClient, MatrixPathScope, MatrixToolContext } from '../types.js';
import { callMatrixTool, type MatrixExecutor } from '../client.js';
import {
  FileTransferError,
  fileTransferFailureResult,
  uploadInputFiles,
  uploadedInputFileToMediaInfo,
} from '../file-transfer.js';
import {
  MATRIX_TOOL_PATHS,
  MatrixAudiosUnderstandToolDef,
  type MatrixAudiosUnderstandInput,
} from '../tool-defs.js';

@bindTool(MatrixAudiosUnderstandToolDef)
export class MatrixAudiosUnderstandTool implements ToolImpl<
  typeof MatrixAudiosUnderstandToolDef.schema,
  MatrixToolContext
> {
  constructor(
    private readonly archonServer: MatrixExecutor,
    private readonly ossMediaClient: MatrixMediaClient,
    private readonly workspaceScope: MatrixPathScope,
  ) {}

  async execute(
    ctx: MatrixToolContext,
    input: MatrixAudiosUnderstandInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const toolName = MatrixAudiosUnderstandToolDef.name;
    const path = MATRIX_TOOL_PATHS[toolName];
    try {
      const uploaded = await uploadInputFiles(
        input.audio_info.map((it) => it.file_path),
        this.workspaceScope,
        this.ossMediaClient,
      );
      const body = {
        audio_info: input.audio_info.map((it, i) =>
          uploadedInputFileToMediaInfo(uploaded[i]!, it.prompt),
        ),
      };
      return await callMatrixTool({
        toolName,
        path,
        input: body,
        ctx,
        archonServer: this.archonServer,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (err instanceof FileTransferError) {
        return fileTransferFailureResult(toolName, path, err);
      }
      throw err;
    }
  }
}
