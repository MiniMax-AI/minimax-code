/**
 * matrix-tools 工具包入口 —— `buildCloudToolRegistry`(`../index.ts`)从这里
 * 一把抓 18 个 RuntimeTool。
 *
 * 单一职责:
 *   1. 实例化全部 matrix-tools Tool class,toRuntimeTool 后返回数组
 *   2. 导出 `MATRIX_TOOL_NAMES` 常量(RuntimeTool name 列表),
 *      `CAPABILITY_TO_TOOL_NAMES.Other` 直接 spread 引用
 *   3. 导出 `getSuppressedToolNamesForModelCapabilities` —— 共享的 model
 *      capability gate(harness turn tool catalog 与 cloud tool catalog 都消费这一份 SoT),
 *      用于在每 turn 装配 tool 时屏蔽已被原生模态吸收的兜底工具
 *      (`images_understand` / `videos_understand`)
 *
 * 不在这里处理 capability map / withToolResultTruncation —— 那些都是
 * `../index.ts::buildCloudToolRegistry` 的责任,在 Map 装配阶段统一套上。
 */

import { toRuntimeTool, type RuntimeTool } from '@mavis/agent-core/tools';
import type { TSchema } from '@sinclair/typebox';

import type {
  MatrixExecutor,
  MatrixMediaClient,
  MatrixPathScope,
  MatrixToolContext,
  MatrixToolLogger,
} from './types.js';
import type { MatrixAigcRegisterServiceGetter } from './aigc-helpers.js';
import {
  MATRIX_TOOL_PATHS,
  MatrixAudiosUnderstandToolDef,
  MatrixBatchImageToVideoToolDef,
  MatrixBatchSynthesizeSpeechToolDef,
  MatrixBatchTextToAudioToolDef,
  MatrixBatchTextToMusicToolDef,
  MatrixBatchTextToVideoToolDef,
  MatrixGenVideosToolDef,
  MatrixGetVoiceListToolDef,
  MatrixImageReverseSearchToolDef,
  MatrixImageSynthesizeToolDef,
  MatrixImagesSearchAndDownloadToolDef,
  MatrixImagesUnderstandToolDef,
  MatrixQueryVideoGenerationToolDef,
  MatrixSubmitVideoGenerationToolDef,
  MatrixTranscribeAudioToolDef,
  MatrixSynthesizeSpeechToolDef,
  MatrixVideosUnderstandToolDef,
} from './tool-defs.js';
import { MatrixAudiosUnderstandTool } from './tools/audios-understand.js';
import { MatrixBatchImageToVideoTool } from './tools/batch-image-to-video.js';
import { MatrixBatchSynthesizeSpeechTool } from './tools/batch-synthesize-speech.js';
import { MatrixBatchTextToAudioTool } from './tools/batch-text-to-audio.js';
import { MatrixBatchTextToMusicTool } from './tools/batch-text-to-music.js';
import { MatrixBatchTextToVideoTool } from './tools/batch-text-to-video.js';
import { MatrixGenVideosTool } from './tools/gen-videos.js';
import { MatrixGetVoiceListTool } from './tools/get-voice-list.js';
import { MatrixImageReverseSearchTool } from './tools/image-reverse-search.js';
import { MatrixImageSynthesizeTool } from './tools/image-synthesize.js';
import { MatrixImagesSearchAndDownloadTool } from './tools/images-search-and-download.js';
import { MatrixImagesUnderstandTool } from './tools/images-understand.js';
import { MatrixQueryVideoGenerationTool } from './tools/query-video-generation.js';
import { MatrixSubmitVideoGenerationTool } from './tools/submit-video-generation.js';
import { MatrixTranscribeAudioTool } from './tools/transcribe-audio.js';
import { MatrixSynthesizeSpeechTool } from './tools/synthesize-speech.js';
import { MatrixVideosUnderstandTool } from './tools/videos-understand.js';
import { MatrixWebSearchTool } from './tools/web-search.js';

export {
  callMatrixTool,
  callMatrixToolRaw,
  type CallMatrixToolOptions,
  type CallMatrixToolRawResult,
} from './client.js';
export * from './tool-defs.js';
export type {
  AigcOssKeys,
  MatrixAigcRegisterAssetInput,
  MatrixAigcRegistrar,
  MatrixAigcRegisterServiceGetter,
  RegisterAigcOpts,
} from './aigc-helpers.js';
export { inferAigcMimeType, registerAigcIfPresent } from './aigc-helpers.js';
export type {
  MatrixDownloadToFileOptions,
  MatrixExecutor,
  MatrixMediaClient,
  MatrixPathScope,
  MatrixToolContext,
  MatrixToolLogger,
  MatrixUploadOptions,
  MatrixUploadResult,
} from './types.js';
export {
  MatrixAuthRequiredError,
  MatrixMediaError,
  readMatrixAuthRequiredReason,
  readMatrixGatewayBackend,
  readMatrixMediaErrorKind,
  type MatrixAuthRequiredReason,
  type MatrixGatewayBackend,
} from './types.js';
export { workspaceRootOf } from './path-guard.js';
export {
  FileTransferError,
  fileTransferFailureResult,
  uploadInputFile,
  uploadInputFiles,
  uploadedInputFileToMediaInfo,
  requireUploadedInputFileUrl,
  downloadOutputFile,
  writeOutputText,
  type MatrixMediaInfoPayload,
  type UploadedInputFile,
} from './file-transfer.js';

export { MatrixAudiosUnderstandTool } from './tools/audios-understand.js';
export { MatrixBatchImageToVideoTool } from './tools/batch-image-to-video.js';
export { MatrixBatchSynthesizeSpeechTool } from './tools/batch-synthesize-speech.js';
export { MatrixBatchTextToAudioTool } from './tools/batch-text-to-audio.js';
export { MatrixBatchTextToMusicTool } from './tools/batch-text-to-music.js';
export { MatrixBatchTextToVideoTool } from './tools/batch-text-to-video.js';
export { MatrixGenVideosTool } from './tools/gen-videos.js';
export { MatrixGetVoiceListTool } from './tools/get-voice-list.js';
export { MatrixImageReverseSearchTool } from './tools/image-reverse-search.js';
export { MatrixImageSynthesizeTool } from './tools/image-synthesize.js';
export { MatrixImagesSearchAndDownloadTool } from './tools/images-search-and-download.js';
export { MatrixImagesUnderstandTool } from './tools/images-understand.js';
export { MatrixQueryVideoGenerationTool } from './tools/query-video-generation.js';
export { MatrixSubmitVideoGenerationTool } from './tools/submit-video-generation.js';
export { MatrixTranscribeAudioTool } from './tools/transcribe-audio.js';
export { MatrixSynthesizeSpeechTool } from './tools/synthesize-speech.js';
export { MatrixVideosUnderstandTool } from './tools/videos-understand.js';
export { MatrixWebSearchTool } from './tools/web-search.js';

/**
 * 工具名常量列表 —— 跟 `CAPABILITY_TO_TOOL_NAMES.Other` 的 spread 源。
 *
 * 顺序约定:跟 `mcp_service.thrift::McpService` 里 `api.post` 出现顺序一致,
 * 方便后续新增工具时插入到对应位置;不要按 alphabetical 排序。
 *
 * **`web_search` 不在此列**:它跟 `web_fetch` 同属 web 检索类工具,挂在
 * `CAPABILITY_TO_TOOL_NAMES.WEB` 而不是 `Other`(由 `tools/index.ts` 引用
 * `MatrixWebSearchToolDef.name` 直接放进 WEB 列表)。media / understanding /
 * tts 等纯 mcp 工具仍属 Other。
 */
export const MATRIX_TOOL_NAMES = [
  MatrixImagesUnderstandToolDef.name,
  MatrixImageSynthesizeToolDef.name,
  MatrixImagesSearchAndDownloadToolDef.name,
  MatrixImageReverseSearchToolDef.name,
  MatrixSubmitVideoGenerationToolDef.name,
  MatrixQueryVideoGenerationToolDef.name,
  MatrixGenVideosToolDef.name,
  MatrixBatchTextToVideoToolDef.name,
  MatrixBatchImageToVideoToolDef.name,
  MatrixGetVoiceListToolDef.name,
  MatrixBatchTextToAudioToolDef.name,
  MatrixBatchTextToMusicToolDef.name,
  MatrixSynthesizeSpeechToolDef.name,
  MatrixBatchSynthesizeSpeechToolDef.name,
  MatrixAudiosUnderstandToolDef.name,
  MatrixVideosUnderstandToolDef.name,
  MatrixTranscribeAudioToolDef.name,
] as const;

export interface BuildMatrixToolsOptions {
  readonly matrixLogger?: MatrixToolLogger;
  /** Dedicated public-upload client for every submit_video_generation media input. */
  readonly videoMediaClient?: MatrixMediaClient;
}

/**
 * 工厂:把所有 matrix-tools tool class 实例化,toRuntimeTool 后返回。
 *
 * 三件依赖:
 *   - `archonServer` —— RemoteArchonServerAdapter,所有 tool 共享同一份
 *     `postJson` 出口,身份/审计/限流由 archon-server 统一兜
 *   - `ossMediaClient` —— OSS 媒体客户端,文件 I/O 类工具用它把 LLM 给的
 *     workspace 文件上传 + 拉回 CDN URL;非文件类工具(web_search /
 *     get_voice_list)透传该依赖但不会调用
 *   - `workspaceScope` —— path-guard 的输入 fence 范围:纯 string 即
 *     workspaceRoot(旧行为);对象形式可附加 `extraInputRoots`(本地
 *     runtime 的 dataDir assets 子树)。所有 file_path 入参都先过这
 *     一关防越界;输出路径永远只认 workspaceRoot
 *
 * 返回元素类型用 `RuntimeTool<TSchema, MatrixToolContext>`,caller 装进
 * `tools[]` 数组直接 push 就行,不需要再 cast。
 */
export function buildMatrixTools(
  archonServer: MatrixExecutor,
  ossMediaClient: MatrixMediaClient,
  workspaceScope: MatrixPathScope,
  aigcRegisterServiceGetter: MatrixAigcRegisterServiceGetter | null = null,
  options: BuildMatrixToolsOptions = {},
): Array<RuntimeTool<TSchema, MatrixToolContext>> {
  const tools: Array<RuntimeTool<TSchema, MatrixToolContext>> = [
    toRuntimeTool(new MatrixWebSearchTool(archonServer, ossMediaClient, workspaceScope)),
    toRuntimeTool(new MatrixImagesUnderstandTool(archonServer, ossMediaClient, workspaceScope)),
    toRuntimeTool(
      new MatrixImageSynthesizeTool(
        archonServer,
        ossMediaClient,
        workspaceScope,
        aigcRegisterServiceGetter,
      ),
    ),
    toRuntimeTool(
      new MatrixImagesSearchAndDownloadTool(archonServer, ossMediaClient, workspaceScope),
    ),
    toRuntimeTool(new MatrixImageReverseSearchTool(archonServer, ossMediaClient, workspaceScope)),
    toRuntimeTool(
      new MatrixSubmitVideoGenerationTool(
        archonServer,
        options.videoMediaClient ?? ossMediaClient,
        workspaceScope,
      ),
    ),
    toRuntimeTool(new MatrixQueryVideoGenerationTool(archonServer, ossMediaClient, workspaceScope)),
    toRuntimeTool(
      new MatrixGenVideosTool(
        archonServer,
        ossMediaClient,
        workspaceScope,
        aigcRegisterServiceGetter,
      ),
    ),
    toRuntimeTool(
      new MatrixBatchTextToVideoTool(
        archonServer,
        ossMediaClient,
        workspaceScope,
        aigcRegisterServiceGetter,
      ),
    ),
    toRuntimeTool(
      new MatrixBatchImageToVideoTool(
        archonServer,
        ossMediaClient,
        workspaceScope,
        aigcRegisterServiceGetter,
      ),
    ),
    toRuntimeTool(new MatrixGetVoiceListTool(archonServer, ossMediaClient, workspaceScope)),
    toRuntimeTool(
      new MatrixBatchTextToAudioTool(
        archonServer,
        ossMediaClient,
        workspaceScope,
        aigcRegisterServiceGetter,
      ),
    ),
    toRuntimeTool(
      new MatrixBatchTextToMusicTool(
        archonServer,
        ossMediaClient,
        workspaceScope,
        aigcRegisterServiceGetter,
      ),
    ),
    toRuntimeTool(
      new MatrixSynthesizeSpeechTool(
        archonServer,
        ossMediaClient,
        workspaceScope,
        aigcRegisterServiceGetter,
      ),
    ),
    toRuntimeTool(
      new MatrixBatchSynthesizeSpeechTool(
        archonServer,
        ossMediaClient,
        workspaceScope,
        aigcRegisterServiceGetter,
      ),
    ),
    toRuntimeTool(new MatrixAudiosUnderstandTool(archonServer, ossMediaClient, workspaceScope)),
    toRuntimeTool(new MatrixVideosUnderstandTool(archonServer, ossMediaClient, workspaceScope)),
    toRuntimeTool(new MatrixTranscribeAudioTool(archonServer, ossMediaClient, workspaceScope)),
  ];
  const { matrixLogger } = options;
  if (!matrixLogger) return tools;
  return tools.map((tool) => withMatrixLogger(tool, matrixLogger));
}

function withMatrixLogger(
  tool: RuntimeTool<TSchema, MatrixToolContext>,
  matrixLogger: MatrixToolLogger,
): RuntimeTool<TSchema, MatrixToolContext> {
  return {
    def: tool.def,
    impl: {
      execute(ctx, input, signal, onUpdate) {
        return tool.impl.execute(
          {
            ...ctx,
            matrixLogger: ctx.matrixLogger ?? matrixLogger,
          },
          input,
          signal,
          onUpdate,
        );
      },
    },
  };
}

export { MATRIX_TOOL_PATHS };

// The model-capability gate is host-neutral; it lives in tool-policy/.
export { getSuppressedToolNamesForModelCapabilities } from '../../tool-policy/model-capability-suppression.js';
