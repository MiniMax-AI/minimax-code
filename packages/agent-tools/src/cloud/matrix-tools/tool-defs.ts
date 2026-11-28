/**
 * matrix-tools 工具 def 集合 —— 出入参全部改成 cloud-runtime 本地 workspace
 * 路径(`*_file_path` / `*_dir_path` / `*_path_list`),mirror 早期 thrift IDL
 * 的请求字段但屏蔽掉远端服务自己的 sandbox 概念。
 *
 * 设计原则:
 *   1. 输入文件(图/音/视频)只接受 `*_file_path` —— 工具实现内部把它上传到
 *      OSS、生成 1 小时签名 URL,再以远端服务能消费的 `url` / `image_url` 形
 *      态喂进 mcp-server。LLM 看不到 url / data / mime_type 等 schema 噪声。
 *   2. 输出文件强制要求 `*_file_path` —— 工具实现内部拿到 mcp-server 响应里
 *      的 CDN URL 后,主动 fetch 写回本地路径,LLM 拿到的 ToolResult 直接含
 *      本地路径,不需要再二次 download
 *   3. 整型字段(count / duration / pitch / sample_rate)用 `Type.Integer()`,
 *      浮点字段(speed / volume)用 `Type.Number()`,枚举字段用
 *      `Type.String({ description: 'a | b | c' })`(thrift 注释里"未来还会加",
 *      用 union 会让 LLM 一旦试错就被 schema 卡死)
 *   4. 嵌套复合 struct(image_info / audio_info / video_info / 各 batch 子项)
 *      还是用 `Type.Object({...})`,字段尽量贴近 IDL 但只保留 cloud-runtime
 *      关心的字段
 *   5. max 数量约束写 description,不用 typebox `maxItems`(服务端会再校验
 *      一次,客户端重复校验会让 LLM 在小批量场景误判)
 *   6. tool name 不带 `matrix_` 前缀(命名空间靠 capability 而非前缀);TS
 *      identifier 仍保留 `Matrix*` 前缀避免跟 daemon 同名 class 冲突
 */

import { Type, type Static } from '@sinclair/typebox';
import type { ToolDefinition } from '@mavis/agent-core/tools';

import { WebSearchToolDef } from '../../shared/web-search.js';

// ────────────────────────────────────────────────────────────────────────────
// 公共复合类型 —— 输入媒体只接受 workspace 本地路径
// ────────────────────────────────────────────────────────────────────────────

const ImageInfoSchema = Type.Object({
  file_path: Type.String({
    description: 'Local workspace path of the image file to analyze.',
  }),
  prompt: Type.Optional(
    Type.String({ description: 'Defaults to "Describe this content" if omitted.' }),
  ),
});

const AudioInfoSchema = Type.Object({
  file_path: Type.String({
    description: 'Local workspace path of the audio file to analyze.',
  }),
  prompt: Type.Optional(
    Type.String({ description: 'Defaults to "Describe this content" if omitted.' }),
  ),
});

const VideoInfoSchema = Type.Object({
  file_path: Type.String({
    description: 'Local workspace path of the video file to analyze.',
  }),
  prompt: Type.Optional(
    Type.String({ description: 'Defaults to "Describe this content" if omitted.' }),
  ),
});

// ────────────────────────────────────────────────────────────────────────────
// Web search — 无文件 I/O
// ────────────────────────────────────────────────────────────────────────────

export const MatrixWebSearchToolDef = WebSearchToolDef;
export type MatrixWebSearchInput = Static<typeof MatrixWebSearchToolDef.schema>;

/**
 * `web_fetch` has no cloud-runtime Matrix tool: it is a local-runtime tool whose
 * router may delegate a single read to the server. It still needs a name in the
 * shared path/timeout tables, and deliberately stays out of `MATRIX_TOOL_NAMES`
 * so cloud-runtime never registers a model-visible tool for it.
 */
export const MATRIX_WEB_FETCH_TOOL_NAME = 'web_fetch';

// ────────────────────────────────────────────────────────────────────────────
// Image understanding / synthesize / search / reverse-search
// ────────────────────────────────────────────────────────────────────────────

export const MatrixImagesUnderstandToolDef = {
  name: 'images_understand',
  description:
    'Offload local image FILES to a separate vision model for text descriptions. ' +
    'You are already multimodal: if an image is visible in this conversation (you can see it, ' +
    'or it was already loaded/read), describe it yourself and do NOT call this tool. ' +
    'Use this ONLY for image files on disk whose pixels you have not actually seen — never to ' +
    're-analyze an image already in your context.',
  schema: Type.Object({
    image_info: Type.Array(ImageInfoSchema, {
      description:
        'Batch of local image file inputs (up to 10). Always batch when you have multiple ' +
        'images. Include only images you cannot already see directly.',
    }),
  }),
} as const satisfies ToolDefinition;
export type MatrixImagesUnderstandInput = Static<typeof MatrixImagesUnderstandToolDef.schema>;

// Stated in every output path description so the model picks a valid path on
// the first call instead of learning the output fence by rejection.
const OUTPUT_PATH_RULE =
  'Paths outside the session workspace (e.g. /tmp or input attachment directories) are rejected.';

const ImageSynthesizeItemSchema = Type.Object({
  prompt: Type.String({ description: 'Synthesis prompt.' }),
  output_file_path: Type.String({
    description: `Where to save the generated image: a workspace-relative path like "art/cover.png". ${OUTPUT_PATH_RULE}`,
  }),
  input_file_paths: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Local workspace paths of reference images (max 4).',
    }),
  ),
  aspect_ratio: Type.Optional(Type.String({ description: 'e.g. "16:9", "1:1".' })),
  resolution: Type.Optional(Type.String({ description: '"1K" | "2K" | "4K".' })),
});

export const MatrixImageSynthesizeToolDef = {
  name: 'image_synthesize',
  description: 'Generate images from prompts, optionally conditioned on local reference images.',
  schema: Type.Object({
    requests: Type.Array(ImageSynthesizeItemSchema, {
      description: 'Up to 10 synthesis requests.',
    }),
  }),
} as const satisfies ToolDefinition;
export type MatrixImageSynthesizeInput = Static<typeof MatrixImageSynthesizeToolDef.schema>;

const ImageSearchQuerySchema = Type.Object({
  query: Type.String({ description: 'Search keywords.' }),
  output_dir_path: Type.String({
    description: `Directory to save this query's downloaded images (created if missing): a workspace-relative path like "downloads/cats". ${OUTPUT_PATH_RULE}`,
  }),
  prompt: Type.Optional(
    Type.String({
      description: 'Description of desired images; server defaults to `query` when empty.',
    }),
  ),
});

export const MatrixImagesSearchAndDownloadToolDef = {
  name: 'images_search_and_download',
  description: 'Search the web for images and save top hits to local disk.',
  schema: Type.Object({
    queries: Type.Array(ImageSearchQuerySchema, { description: 'Up to 10 image search queries.' }),
    providers: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Override auto-selection, e.g. ["tencent","serper"].',
      }),
    ),
  }),
} as const satisfies ToolDefinition;
export type MatrixImagesSearchAndDownloadInput = Static<
  typeof MatrixImagesSearchAndDownloadToolDef.schema
>;

export const MatrixImageReverseSearchToolDef = {
  name: 'image_reverse_search',
  description:
    'Given a local image, find visually similar images and pages on the web. Writes a markdown report of the matches to `output_file_path`.',
  schema: Type.Object({
    image_file_path: Type.String({
      description: 'Local workspace path of the image to reverse search.',
    }),
    output_file_path: Type.String({
      description: `Where to write the formatted markdown report: a workspace-relative .md path like "reports/matches.md". ${OUTPUT_PATH_RULE}`,
    }),
  }),
} as const satisfies ToolDefinition;
export type MatrixImageReverseSearchInput = Static<typeof MatrixImageReverseSearchToolDef.schema>;

// ────────────────────────────────────────────────────────────────────────────
// Video generation
// ────────────────────────────────────────────────────────────────────────────

export const MAX_VIDEO_GENERATION_PROMPT_LENGTH = 7000;
export const MAX_H3_REFERENCE_AUDIO_COUNT = 3;
export const MAX_H3_REFERENCE_MEDIA_COUNT = 12;
export const MINIMAX_H3_MODEL = 'MiniMax-H3';
export const HAILUO_23_MODEL = 'MiniMax-Hailuo-2.3';

export function isH3VideoModel(model: string): boolean {
  return model === MINIMAX_H3_MODEL;
}

const H3_REFERENCE_TOTAL_RULE =
  'Across reference_image_paths, reference_video_paths, and reference_audio_paths, allow at most 12 files total.';

const VIDEO_MODEL_DESCRIPTION =
  'Required and must be chosen in a separate first step. We recommend MiniMax-H3 for quality: it is ' +
  'newer and more capable. MiniMax-H3 natively generates synchronized audio together with the video ' +
  'directly from the prompt, without reference_audio_paths; reference audio is optional guidance, ' +
  'not a prerequisite for sound. MiniMax-Hailuo-2.3 accepts exactly one image; MiniMax-H3 ' +
  'supports either first/last-frame keyframes or multimodal references: 1-9 reference images, ' +
  '1-3 reference videos, and 1-3 reference audio files only together with reference images/videos, ' +
  'with at most 12 files total across all reference collections. If the ' +
  'user did not choose a model, ' +
  'explain only these model differences and ask which model to use. Do not ask about resolution, ' +
  'duration, keyframes, or reference media until the model is selected. After MiniMax-H3 is selected, ' +
  'ask for input mode, an integer duration from 4 through 15, and a resolution of 768P or 2K; ' +
  'offer a concrete ratio for text-only mode and adaptive or a concrete ratio for reference mode. ' +
  'Use MiniMax-H3 as the Tool and Matrix model value.';

const VideoModelSchema = Type.Union(
  [Type.Literal(MINIMAX_H3_MODEL), Type.Literal(HAILUO_23_MODEL)],
  { description: VIDEO_MODEL_DESCRIPTION },
);

export const MatrixSubmitVideoGenerationToolDef = {
  name: 'submit_video_generation',
  description: [
    'Submit exactly one asynchronous video task and return task_id immediately.',
    'For MiniMax-H3 this Tool adapts the official POST /v2/video_generation contract to the current Matrix MCP wrapper: one required non-empty prompt becomes the single text content item, and frame/reference path fields become image_url/video_url/audio_url content roles.',
    "Use a strict two-step conversation: first resolve the video model; after the user selects a model, ask only that model's remaining applicable options.",
    'The video model choice is mandatory unless the current user request or terminal `<video-generation-options>` explicitly names H3.0 (MiniMax-H3) or H2.3 (MiniMax-Hailuo-2.3). Never infer a default model from the Plugin name, a recommendation, or an omitted value.',
    'When the video model is missing and the `ask_user` tool is available, make one actual `ask_user` tool call before any submission. Use this exact call shape, keeping `steps` and every `options` value as literal JSON arrays: { "mode": "questionnaire", "title": "Video specifications", "steps": [{ "question": "Which model?", "options": [{ "label": "H3.0 (Recommended)" }, { "label": "H2.3" }], "selectionMode": "single" }] }. Never wrap either array in an `item` container such as `{ "item": [...] }`. Use `selectionMode`; never `multiSelect`.',
    'Write the questionnaire in the same language as the user. H3.0 maps to `MiniMax-H3`; H2.3 maps to `MiniMax-Hailuo-2.3`. Do not call `submit_video_generation` until the user replies. When `ask_user` is unavailable, ask the same unresolved choices in concise prose and wait for the reply.',
    'MiniMax-H3 is recommended for quality and supports 768P or 2K; ask the user to choose a resolution unless it is already explicit or delegated. When the user delegates or omits the choice, use 2K.',
    'MiniMax-H3 natively generates synchronized audio together with the video. Put requested dialogue, ambience, and sound effects in the prompt; native sound works without reference_audio_paths. Reference audio is optional guidance, not a prerequisite for an audible video. Do not use a separate audio-generation tool unless the user explicitly asks for a separate audio output.',
    'After MiniMax-H3 is selected, first ask whether the input mode is text-only, first-frame, last-frame, first+last-frame, or multimodal reference, then ask for an integer duration from 4 through 15 and a resolution. Text-only mode uses one non-adaptive ratio from 21:9, 16:9, 4:3, 1:1, 3:4, or 9:16 and defaults to 16:9 when omitted or delegated. Keyframe mode is always adaptive. Reference mode defaults to adaptive and also accepts any concrete ratio.',
    'Reference images allow 1-9 items, reference videos allow 1-3 items, reference audio allows 1-3 items and must accompany reference images or videos, and all reference collections together allow at most 12 files total. Do not submit until duration and applicable media choices are explicit; ratio and resolution may use their documented defaults when omitted or delegated.',
    'The official V2 video_url content item contains only url and role. The current Matrix wrapper additionally requires duration_seconds on each reference_videos item; this is Matrix wrapper metadata, not a Video Generation V2 content field. Workspace MP4/MOV duration is inspected automatically before upload; for public reference-video URLs, supply reference_video_duration_seconds in the same order because those URLs must not be downloaded or re-uploaded.',
    'Every media input accepts either a public HTTP/HTTPS URL or a workspace-relative path. Public URLs are passed through unchanged without downloading or uploading them again. Every workspace media path, including first/last keyframes and image/video/audio references, is fenced, validated, and uploaded through the dedicated temporary public upload flow before submission; internal OSS hosts are never sent upstream. The agent Tool intentionally does not expose mm_file:// or data URI inputs because its supported local-file path must use the workspace fence and real temporary public upload flow.',
    'A submit attempt is terminal for that exact request in the current turn. If submit returns any error, timeout, or HTTP failure, report it without inferring that a task was created and never retry submit automatically. Retry only after a new explicit user request in a later turn. Call `query_video_generation` only when submit returned a task_id; never repeat submit to check status.',
  ].join(' '),
  schema: Type.Object(
    {
      model: VideoModelSchema,
      prompt: Type.String({
        minLength: 1,
        maxLength: MAX_VIDEO_GENERATION_PROMPT_LENGTH,
        description:
          'The one required non-empty V2 text/prompt item, up to 7000 characters. For MiniMax-H3 native audio generation, describe the desired dialogue, ambience, and sound effects here; reference audio is optional.',
      }),
      input_image_path: Type.Optional(
        Type.String({
          description:
            'Optional public HTTP/HTTPS URL or workspace-relative path to a first-frame or last-frame image. Public URLs pass through unchanged; a workspace path is automatically uploaded to a temporary public URL before submission. MiniMax-H3 accepts .jpg/.jpeg/.png/.webp/.heic/.heif. MiniMax-Hailuo-2.3 accepts .jpg/.png/.webp and exactly one image for first-frame or legacy subject mode. MiniMax-H3 uses this only for a keyframe, not as multimodal reference media. Cannot be combined with reference collections.',
        }),
      ),
      last_frame_image_path: Type.Optional(
        Type.String({
          description:
            'MiniMax-H3 first+last-frame mode only. Public HTTP/HTTPS URL or workspace-relative .jpg/.jpeg/.png/.webp/.heic/.heif path for the ending frame. Public URLs pass through unchanged; a workspace path is automatically uploaded to a temporary public URL. Requires input_image_path as the first frame; reference_type must be first_frame or omitted. Cannot be combined with reference collections.',
        }),
      ),
      reference_type: Type.Optional(
        Type.Union(
          [Type.Literal('first_frame'), Type.Literal('last_frame'), Type.Literal('subject')],
          {
            description:
              'How input_image_path is used. MiniMax-H3 supports first_frame or last_frame keyframes; omit it to default input_image_path to first_frame. MiniMax-Hailuo-2.3 supports first_frame or legacy subject mode. Requires input_image_path and cannot be combined with reference collections.',
          },
        ),
      ),
      reference_image_paths: Type.Optional(
        Type.Array(Type.String(), {
          minItems: 1,
          maxItems: 9,
          description: `MiniMax-H3 only. 1-9 public HTTP/HTTPS URLs or workspace-relative reference image paths; local paths are automatically uploaded to temporary public URLs. Each must be .jpg/.jpeg/.png/.webp/.heic/.heif, no larger than 30 MB, with width and height each in [256, 5760] and width/height ratio in [0.4, 2.5]. ${H3_REFERENCE_TOTAL_RULE} MiniMax-Hailuo-2.3 does not accept this collection. Cannot be combined with keyframes.`,
        }),
      ),
      reference_video_paths: Type.Optional(
        Type.Array(Type.String(), {
          minItems: 1,
          maxItems: 3,
          description: `MiniMax-H3 only. 1-3 public HTTP/HTTPS URLs or workspace-relative .mp4/.mov video paths; local paths are automatically uploaded to temporary public URLs. Videos must use H.264/AVC or H.265/HEVC (embedded audio AAC/MP3); each no larger than 50 MB and 2-15 seconds, total video duration at most 15 seconds, width and height each in [256, 5760], aspect ratio in [0.4, 2.5], and frame rate in [23.976, 60]. ${H3_REFERENCE_TOTAL_RULE} Workspace MP4/MOV size and duration are checked before upload. Every public URL requires a same-index value in reference_video_duration_seconds. Dimensions, frame rate, and codecs are validated upstream. Cannot be combined with keyframes.`,
        }),
      ),
      reference_video_duration_seconds: Type.Optional(
        Type.Array(Type.Number({ minimum: 2, maximum: 15 }), {
          minItems: 1,
          maxItems: 3,
          description:
            'MiniMax-H3 Matrix-wrapper reference-video durations in seconds, in the same order as reference_video_paths. A value is required for every public URL because URLs are passed through without downloading; workspace MP4/MOV durations are inspected automatically when this field is omitted. When provided, the array length must equal reference_video_paths length and every value must be between 2 and 15.',
        }),
      ),
      reference_audio_paths: Type.Optional(
        Type.Array(Type.String(), {
          minItems: 1,
          maxItems: MAX_H3_REFERENCE_AUDIO_COUNT,
          description: `MiniMax-H3 only. Optional audio guidance; it is not required for native audio generation because MiniMax-H3 can generate synchronized sound directly from the prompt. Accepts 1-3 public HTTP/HTTPS URLs or workspace-relative .wav/.mp3 reference audio paths; local paths are automatically uploaded to temporary public URLs. Each must be no larger than 15 MB and 2-15 seconds, with total audio duration at most 15 seconds. ${H3_REFERENCE_TOTAL_RULE} Reference audio cannot be used alone: include at least one reference image or video. Duration is validated upstream. Cannot be combined with keyframes.`,
        }),
      ),
      duration: Type.Integer({
        minimum: 4,
        maximum: 15,
        description:
          'Required after model selection. MiniMax-H3 supports an integer from 4 through 15 seconds. MiniMax-Hailuo-2.3 supports exactly 6s or 10s.',
      }),
      resolution: Type.Optional(
        Type.Union([Type.Literal('768P'), Type.Literal('1080P'), Type.Literal('2K')], {
          description:
            'MiniMax-H3 supports 768P or 2K and defaults to 2K when omitted or delegated. MiniMax-Hailuo-2.3 supports 768P (default) or 1080P; 10s requires 768P.',
        }),
      ),
      ratio: Type.Optional(
        Type.Union(
          [
            Type.Literal('21:9'),
            Type.Literal('16:9'),
            Type.Literal('4:3'),
            Type.Literal('1:1'),
            Type.Literal('3:4'),
            Type.Literal('9:16'),
            Type.Literal('adaptive'),
          ],
          {
            description:
              'MiniMax-H3 text-only mode accepts 21:9, 16:9, 4:3, 1:1, 3:4, or 9:16, defaults to 16:9 when omitted, and cannot use adaptive. Keyframe mode is forced to adaptive. Reference mode defaults to adaptive and also accepts any concrete ratio.',
          },
        ),
      ),
      aigc_watermark: Type.Optional(
        Type.Boolean({
          description:
            'MiniMax-H3 V2 AIGC watermark switch. Omit or set false for the upstream default; set true only when the user requests the AIGC watermark.',
          default: false,
        }),
      ),
    },
    { additionalProperties: false },
  ),
} as const satisfies ToolDefinition;
export type MatrixSubmitVideoGenerationInput = Static<
  typeof MatrixSubmitVideoGenerationToolDef.schema
>;

export const MatrixQueryVideoGenerationToolDef = {
  name: 'query_video_generation',
  description:
    'Query one previously submitted video task once. This read-only call does not create another charge. Pass the same model returned by submit and keep using the same output_file_path while polling. Returns queued/running/failed/cancelled without writing a file. When status is succeeded, downloads video_url immediately to output_file_path because MiniMax-H3 signed URLs are valid for only about 9 hours.',
  schema: Type.Object(
    {
      task_id: Type.String({
        description: 'Task ID returned by submit_video_generation.',
      }),
      model: VideoModelSchema,
      output_file_path: Type.String({
        description: `Required workspace-relative path for the generated mp4, such as "videos/result.mp4". Keep the same path on every query; the file is written only after status becomes succeeded. ${OUTPUT_PATH_RULE}`,
      }),
    },
    { additionalProperties: false },
  ),
} as const satisfies ToolDefinition;
export type MatrixQueryVideoGenerationInput = Static<
  typeof MatrixQueryVideoGenerationToolDef.schema
>;

// Legacy synchronous video generation tools (pre submit/query async contract).
// Kept alongside the async pair — they serve existing callers and register
// AIGC assets on download.
const VideoRequestSchema = Type.Object({
  prompt: Type.String({ description: 'Video prompt.' }),
  output_file_path: Type.String({
    description: `Where to save the generated video: a workspace-relative path like "clips/intro.mp4". ${OUTPUT_PATH_RULE}`,
  }),
  input_image_path: Type.Optional(
    Type.String({
      description:
        'Local workspace path of a reference image (image-to-video). Omit for pure text-to-video.',
    }),
  ),
  reference_type: Type.Optional(
    Type.String({ description: '"first_frame" (default) | "last_frame".' }),
  ),
  duration: Type.Optional(Type.Integer({ description: '6 (default) | 10.' })),
  resolution: Type.Optional(Type.String({ description: '"768P" (default) | "1080P".' })),
  model: Type.Optional(Type.String({ description: 'Override default model.' })),
});

export const MatrixGenVideosToolDef = {
  name: 'gen_videos',
  description:
    'Generate videos from prompts, optionally seeded with a local reference image. Generation is async on the server and may take many minutes.',
  schema: Type.Object({
    requests: Type.Array(VideoRequestSchema, { description: 'Up to 5 video generation requests.' }),
  }),
} as const satisfies ToolDefinition;
export type MatrixGenVideosInput = Static<typeof MatrixGenVideosToolDef.schema>;

export const MatrixBatchTextToVideoToolDef = {
  name: 'batch_text_to_video',
  description: 'Batch text-to-video using parallel lists. Items at the same index form one video.',
  schema: Type.Object({
    prompt_list: Type.Array(Type.String(), { description: 'One prompt per video.' }),
    output_file_path_list: Type.Array(Type.String(), {
      description: `One workspace-relative output path per video (e.g. "clips/scene-1.mp4"), parallel to \`prompt_list\`. ${OUTPUT_PATH_RULE}`,
    }),
    duration_list: Type.Optional(
      Type.Array(Type.Integer(), { description: 'Optional durations, parallel to `prompt_list`.' }),
    ),
    resolution_list: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Optional resolutions, parallel to `prompt_list`.',
      }),
    ),
  }),
} as const satisfies ToolDefinition;
export type MatrixBatchTextToVideoInput = Static<typeof MatrixBatchTextToVideoToolDef.schema>;

export const MatrixBatchImageToVideoToolDef = {
  name: 'batch_image_to_video',
  description:
    'Batch image-to-video using each local image as the first frame. Items at the same index form one video.',
  schema: Type.Object({
    image_file_path_list: Type.Array(Type.String(), {
      description: 'Local workspace paths of input images (first_frame source) per video.',
    }),
    output_file_path_list: Type.Array(Type.String(), {
      description: `One workspace-relative output path per video (e.g. "clips/scene-1.mp4"), parallel to \`image_file_path_list\`. ${OUTPUT_PATH_RULE}`,
    }),
    prompt_list: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Optional prompts, parallel to `image_file_path_list`.',
      }),
    ),
    reference_type_list: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Optional reference types, parallel to `image_file_path_list`.',
      }),
    ),
    duration_list: Type.Optional(
      Type.Array(Type.Integer(), {
        description: 'Optional durations, parallel to `image_file_path_list`.',
      }),
    ),
    resolution_list: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Optional resolutions, parallel to `image_file_path_list`.',
      }),
    ),
  }),
} as const satisfies ToolDefinition;
export type MatrixBatchImageToVideoInput = Static<typeof MatrixBatchImageToVideoToolDef.schema>;

// ────────────────────────────────────────────────────────────────────────────
// Voice / Audio
// ────────────────────────────────────────────────────────────────────────────

export const MatrixGetVoiceListToolDef = {
  name: 'get_voice_list',
  description:
    'List the voice presets (voice_id + voice_name) available to `synthesize_speech` and the batch TTS tools.',
  schema: Type.Object({}),
} as const satisfies ToolDefinition;
export type MatrixGetVoiceListInput = Static<typeof MatrixGetVoiceListToolDef.schema>;

const AudioParamsSchema = Type.Object({
  text: Type.String({ description: 'Text to synthesize.' }),
  output_file_path: Type.String({
    description: `Where to save the generated mp3: a workspace-relative path like "audio/speech.mp3". ${OUTPUT_PATH_RULE}`,
  }),
  voice_id: Type.Optional(Type.String({ description: 'Default "male-qn-qingse".' })),
  speed: Type.Optional(Type.Number({ description: '[0.5, 2.0] default 1.0.' })),
  volume: Type.Optional(Type.Number({ description: '[0.0, 10.0] default 1.0.' })),
  pitch: Type.Optional(Type.Integer({ description: '[-12, 12] default 0.' })),
  emotion: Type.Optional(
    Type.String({
      description: 'happy | sad | angry | fearful | disgusted | surprised | neutral.',
    }),
  ),
});

export const MatrixBatchTextToAudioToolDef = {
  name: 'batch_text_to_audio',
  description: 'Batch text-to-speech, with voice and audio parameters configurable per request.',
  schema: Type.Object({
    requests: Type.Array(AudioParamsSchema, { description: 'Up to 10 TTS requests.' }),
  }),
} as const satisfies ToolDefinition;
export type MatrixBatchTextToAudioInput = Static<typeof MatrixBatchTextToAudioToolDef.schema>;

const MusicParamsSchema = Type.Object({
  prompt: Type.String({ description: 'Music prompt, length [10, 300].' }),
  output_file_path: Type.String({
    description: `Where to save the generated music file: a workspace-relative path like "music/track.mp3". ${OUTPUT_PATH_RULE}`,
  }),
  lyrics: Type.Optional(
    Type.String({
      description:
        'Lyrics text, length [10, 600] when set; omit for pure instrumental / background music.',
    }),
  ),
  sample_rate: Type.Optional(Type.Integer({ description: '{16000, 24000, 32000, 44100}.' })),
  bitrate: Type.Optional(Type.Integer({ description: '{32000, 64000, 128000, 256000}.' })),
  format: Type.Optional(Type.String({ description: 'mp3 | wav | pcm.' })),
});

export const MatrixBatchTextToMusicToolDef = {
  name: 'batch_text_to_music',
  description: 'Generate music tracks from text prompts, optionally with lyrics.',
  schema: Type.Object({
    requests: Type.Array(MusicParamsSchema, { description: 'Up to 5 music generation requests.' }),
  }),
} as const satisfies ToolDefinition;
export type MatrixBatchTextToMusicInput = Static<typeof MatrixBatchTextToMusicToolDef.schema>;

export const MatrixSynthesizeSpeechToolDef = {
  name: 'synthesize_speech',
  description:
    'Convert a single text input to speech. Use `batch_synthesize_speech` for multiple texts.',
  schema: Type.Object({
    text: Type.String({ description: 'Text to synthesize.' }),
    output_file_path: Type.String({
      description: `Where to save the generated mp3: a workspace-relative path like "audio/speech.mp3". ${OUTPUT_PATH_RULE}`,
    }),
    voice_id: Type.Optional(Type.String()),
    speed: Type.Optional(Type.Number({ description: '[0.5, 2.0] default 1.0.' })),
    volume: Type.Optional(Type.Number({ description: '[0.0, 10.0] default 1.0.' })),
    pitch: Type.Optional(Type.Integer({ description: '[-12, 12] default 0.' })),
    emotion: Type.Optional(
      Type.String({
        description: 'happy | sad | angry | fearful | disgusted | surprised | neutral.',
      }),
    ),
  }),
} as const satisfies ToolDefinition;
export type MatrixSynthesizeSpeechInput = Static<typeof MatrixSynthesizeSpeechToolDef.schema>;

export const MatrixBatchSynthesizeSpeechToolDef = {
  name: 'batch_synthesize_speech',
  description: 'Batch text-to-speech. Prefer this over calling `synthesize_speech` in a loop.',
  schema: Type.Object({
    requests: Type.Array(AudioParamsSchema, { description: 'Up to 10 synthesize requests.' }),
  }),
} as const satisfies ToolDefinition;
export type MatrixBatchSynthesizeSpeechInput = Static<
  typeof MatrixBatchSynthesizeSpeechToolDef.schema
>;

// ────────────────────────────────────────────────────────────────────────────
// Media understanding
// ────────────────────────────────────────────────────────────────────────────

export const MatrixAudiosUnderstandToolDef = {
  name: 'audios_understand',
  description: 'Analyze local audio files and return one description per audio.',
  schema: Type.Object({
    audio_info: Type.Array(AudioInfoSchema, {
      description: 'Batch of audio inputs (up to 10). Always batch when you have multiple audios.',
    }),
  }),
} as const satisfies ToolDefinition;
export type MatrixAudiosUnderstandInput = Static<typeof MatrixAudiosUnderstandToolDef.schema>;

export const MatrixVideosUnderstandToolDef = {
  name: 'videos_understand',
  description:
    'Offload local video FILES to a separate vision model for text descriptions. ' +
    'If a video (or its frames) is already visible in this conversation, or you have already ' +
    'analyzed it, describe it yourself and do NOT call this tool. ' +
    'Use this ONLY for video files on disk whose content you have not actually seen — never to ' +
    're-analyze a video already in your context.',
  schema: Type.Object({
    video_info: Type.Array(VideoInfoSchema, {
      description:
        'Batch of local video file inputs (up to 5). Always batch when you have multiple ' +
        'videos. Include only videos you cannot already see directly.',
    }),
  }),
} as const satisfies ToolDefinition;
export type MatrixVideosUnderstandInput = Static<typeof MatrixVideosUnderstandToolDef.schema>;

export const MatrixTranscribeAudioToolDef = {
  name: 'transcribe_audio',
  description: 'Transcribe a single local audio file to text.',
  schema: Type.Object({
    audio_info: AudioInfoSchema,
  }),
} as const satisfies ToolDefinition;
export type MatrixTranscribeAudioInput = Static<typeof MatrixTranscribeAudioToolDef.schema>;

// ────────────────────────────────────────────────────────────────────────────
// Path mapping — single source of truth for each tool's archon-server REST
// proxy path. Used by both the tool implementations and the registration
// index. Paths mirror `mcp_service.thrift::McpService` `api.post` annotations
// verbatim so archon-server's proxy layer can route 1:1 to mcp-server.
// ────────────────────────────────────────────────────────────────────────────

export const MATRIX_TOOL_PATHS = {
  [MatrixWebSearchToolDef.name]: '/matrix/api/v1/mcp/web_search',
  [MATRIX_WEB_FETCH_TOOL_NAME]: '/matrix/api/v1/mcp/web_fetch',
  [MatrixImagesUnderstandToolDef.name]: '/matrix/api/v1/mcp/images_understand',
  [MatrixImageSynthesizeToolDef.name]: '/matrix/api/v1/mcp/image_synthesize',
  [MatrixImagesSearchAndDownloadToolDef.name]: '/matrix/api/v1/mcp/images_search_and_download',
  [MatrixImageReverseSearchToolDef.name]: '/matrix/api/v1/mcp/image_reverse_search',
  [MatrixSubmitVideoGenerationToolDef.name]: '/matrix/api/v1/mcp/submit_video_generation',
  [MatrixQueryVideoGenerationToolDef.name]: '/matrix/api/v1/mcp/query_video_generation',
  [MatrixGenVideosToolDef.name]: '/matrix/api/v1/mcp/gen_videos',
  [MatrixBatchTextToVideoToolDef.name]: '/matrix/api/v1/mcp/batch_text_to_video',
  [MatrixBatchImageToVideoToolDef.name]: '/matrix/api/v1/mcp/batch_image_to_video',
  [MatrixGetVoiceListToolDef.name]: '/matrix/api/v1/mcp/get_voice_list',
  [MatrixBatchTextToAudioToolDef.name]: '/matrix/api/v1/mcp/batch_text_to_audio',
  [MatrixBatchTextToMusicToolDef.name]: '/matrix/api/v1/mcp/batch_text_to_music',
  [MatrixSynthesizeSpeechToolDef.name]: '/matrix/api/v1/mcp/synthesize_speech',
  [MatrixBatchSynthesizeSpeechToolDef.name]: '/matrix/api/v1/mcp/batch_synthesize_speech',
  [MatrixAudiosUnderstandToolDef.name]: '/matrix/api/v1/mcp/audios_understand',
  [MatrixVideosUnderstandToolDef.name]: '/matrix/api/v1/mcp/videos_understand',
  [MatrixTranscribeAudioToolDef.name]: '/matrix/api/v1/mcp/listen_audio',
} as const satisfies Record<string, string>;

// ────────────────────────────────────────────────────────────────────────────
// Per-tool HTTP timeout (ms) — overrides RemoteArchonServerAdapter's default
// 15s. archon-server's `/matrix/api/v1/mcp/*` proxy forwards to mcp-server
// which actually runs the work: text generation, diffusion, TTS, transcription.
//   - 生成类(image_synthesize / submit_video_generation / batch TTS / 音乐…):
//     服务端可能跑数分钟,拉到 10 min。
//   - 非生成类(web_search / *_understand / transcribe_audio / get_voice_list):
//     拉到 2 min,够覆盖 vision/asr LLM 调用,又不会让 hang 住的 turn 等太久。
// 工具内部多次调用 OSS 的 upload/download 不计在内 —— 它们走 ossMediaClient
// 自己的 timeout,不经 archon-server `postJson`。
// ────────────────────────────────────────────────────────────────────────────

const MATRIX_GEN_TIMEOUT_MS = 600_000;
const MATRIX_DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Server-side page reading is a single bounded upstream call (provider read plus
 * optional fallback), not an open-ended generation, so it gets its own budget
 * well below the 2 min default. The local router falls back to a direct fetch
 * once this elapses.
 */
export const MATRIX_WEB_FETCH_TIMEOUT_MS = 25_000;

export const MATRIX_TOOL_TIMEOUTS = {
  [MatrixWebSearchToolDef.name]: MATRIX_DEFAULT_TIMEOUT_MS,
  [MATRIX_WEB_FETCH_TOOL_NAME]: MATRIX_WEB_FETCH_TIMEOUT_MS,
  [MatrixImagesUnderstandToolDef.name]: MATRIX_DEFAULT_TIMEOUT_MS,
  [MatrixImageSynthesizeToolDef.name]: MATRIX_GEN_TIMEOUT_MS,
  [MatrixImagesSearchAndDownloadToolDef.name]: MATRIX_GEN_TIMEOUT_MS,
  [MatrixImageReverseSearchToolDef.name]: MATRIX_GEN_TIMEOUT_MS,
  [MatrixSubmitVideoGenerationToolDef.name]: MATRIX_GEN_TIMEOUT_MS,
  [MatrixQueryVideoGenerationToolDef.name]: MATRIX_DEFAULT_TIMEOUT_MS,
  [MatrixGenVideosToolDef.name]: MATRIX_GEN_TIMEOUT_MS,
  [MatrixBatchTextToVideoToolDef.name]: MATRIX_GEN_TIMEOUT_MS,
  [MatrixBatchImageToVideoToolDef.name]: MATRIX_GEN_TIMEOUT_MS,
  [MatrixGetVoiceListToolDef.name]: MATRIX_DEFAULT_TIMEOUT_MS,
  [MatrixBatchTextToAudioToolDef.name]: MATRIX_GEN_TIMEOUT_MS,
  [MatrixBatchTextToMusicToolDef.name]: MATRIX_GEN_TIMEOUT_MS,
  [MatrixSynthesizeSpeechToolDef.name]: MATRIX_GEN_TIMEOUT_MS,
  [MatrixBatchSynthesizeSpeechToolDef.name]: MATRIX_GEN_TIMEOUT_MS,
  [MatrixAudiosUnderstandToolDef.name]: MATRIX_DEFAULT_TIMEOUT_MS,
  [MatrixVideosUnderstandToolDef.name]: MATRIX_DEFAULT_TIMEOUT_MS,
  [MatrixTranscribeAudioToolDef.name]: MATRIX_DEFAULT_TIMEOUT_MS,
} as const satisfies Record<string, number>;
