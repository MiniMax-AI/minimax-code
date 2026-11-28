import { stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import { callMatrixToolRaw, type MatrixExecutor } from '../client.js';
import {
  FileTransferError,
  fileTransferFailureResult,
  requireUploadedInputFileUrl,
  uploadInputFile,
  type MatrixMediaInfoPayload,
  type UploadedInputFile,
} from '../file-transfer.js';
import {
  MAX_H3_REFERENCE_AUDIO_COUNT,
  MAX_H3_REFERENCE_MEDIA_COUNT,
  MAX_VIDEO_GENERATION_PROMPT_LENGTH,
  HAILUO_23_MODEL,
  isH3VideoModel,
  MATRIX_TOOL_PATHS,
  MINIMAX_H3_MODEL,
  MatrixSubmitVideoGenerationToolDef,
  type MatrixSubmitVideoGenerationInput,
} from '../tool-defs.js';
import type { MatrixMediaClient, MatrixPathScope, MatrixToolContext } from '../types.js';
import { readIsoBmffDurationSeconds } from '../iso-bmff-duration.js';
import { inputRootsOf, resolveInputWithinScope } from '../path-guard.js';

const DEFAULT_H3_RATIO = '16:9';
const H3_CONCRETE_RATIOS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
const H3_RATIOS = new Set([...H3_CONCRETE_RATIOS, 'adaptive']);
const VIDEO_MEDIA_UPLOAD_OPTIONS = {
  forceRemoteUrl: true,
  category: 'user_file_upload_tmp',
} as const;

const H3_ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);
const HAILUO_23_ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.png', '.webp']);
const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov']);
const ALLOWED_AUDIO_EXTENSIONS = new Set(['.wav', '.mp3']);
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

// Local runtime rebuilds tools each turn, so paid submissions for the same turn must be shared across instances in-process.
const attemptedVideoSubmissions = new Set<string>();

@bindTool(MatrixSubmitVideoGenerationToolDef)
export class MatrixSubmitVideoGenerationTool implements ToolImpl<
  typeof MatrixSubmitVideoGenerationToolDef.schema,
  MatrixToolContext
> {
  constructor(
    private readonly archonServer: MatrixExecutor,
    private readonly videoMediaClient: MatrixMediaClient,
    private readonly workspaceScope: MatrixPathScope,
  ) {}

  async execute(
    ctx: MatrixToolContext,
    input: MatrixSubmitVideoGenerationInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');

    const toolName = MatrixSubmitVideoGenerationToolDef.name;
    const path = MATRIX_TOOL_PATHS[toolName];
    const validationError = validateVideoSubmission(input);
    if (validationError) return invalidVideoRequest(toolName, path, validationError);

    const hasKeyframes =
      input.input_image_path !== undefined || input.last_frame_image_path !== undefined;
    const hasReferences = hasReferenceCollections(input);
    const effectiveRatio = isH3VideoModel(input.model)
      ? hasKeyframes
        ? 'adaptive'
        : hasReferences
          ? (input.ratio ?? 'adaptive')
          : (input.ratio ?? DEFAULT_H3_RATIO)
      : input.ratio;
    const effectiveResolution = isH3VideoModel(input.model)
      ? (input.resolution ?? '2K')
      : input.resolution;
    const normalizedInput = {
      ...input,
      ratio: effectiveRatio,
      resolution: effectiveResolution,
    };
    const duplicateKey = `${ctx.sessionId}:${ctx.turnId}:${stableStringify(normalizedInput)}`;
    if (attemptedVideoSubmissions.has(duplicateKey)) {
      return duplicateVideoSubmission(toolName, path);
    }

    let inputImage: MatrixMediaInfoPayload | undefined;
    let lastFrameImage: MatrixMediaInfoPayload | undefined;
    let referenceImages: MatrixMediaInfoPayload[] | undefined;
    let referenceVideos: Array<MatrixMediaInfoPayload & { duration_seconds: number }> | undefined;
    let referenceAudios: MatrixMediaInfoPayload[] | undefined;
    try {
      if (input.input_image_path) {
        inputImage = await prepareVideoInput(
          input.input_image_path,
          this.workspaceScope,
          this.videoMediaClient,
          MAX_IMAGE_BYTES,
          'input_image_path',
        );
      }
      if (input.last_frame_image_path) {
        lastFrameImage = await prepareVideoInput(
          input.last_frame_image_path,
          this.workspaceScope,
          this.videoMediaClient,
          MAX_IMAGE_BYTES,
          'last_frame_image_path',
        );
      }
      referenceImages = await uploadCollection(
        input.reference_image_paths,
        this.workspaceScope,
        this.videoMediaClient,
        MAX_IMAGE_BYTES,
        'reference_image_paths',
      );
      referenceVideos = await prepareReferenceVideoCollection(
        input.reference_video_paths,
        input.reference_video_duration_seconds,
        this.workspaceScope,
        this.videoMediaClient,
      );
      referenceAudios = await uploadCollection(
        input.reference_audio_paths,
        this.workspaceScope,
        this.videoMediaClient,
        MAX_AUDIO_BYTES,
        'reference_audio_paths',
      );
    } catch (err) {
      if (err instanceof FileTransferError) {
        return fileTransferFailureResult(toolName, path, err);
      }
      throw err;
    }

    const body: Record<string, unknown> = {
      model: input.model,
      prompt: input.prompt,
    };
    if (inputImage) body.input_image = inputImage;
    if (inputImage) {
      body.reference_type = input.reference_type ?? 'first_frame';
    }
    if (lastFrameImage) body.last_frame_image = lastFrameImage;
    if (referenceImages !== undefined) body.reference_images = referenceImages;
    if (referenceVideos !== undefined) body.reference_videos = referenceVideos;
    if (referenceAudios !== undefined) body.reference_audios = referenceAudios;
    body.duration = input.duration;
    if (effectiveResolution !== undefined) body.resolution = effectiveResolution;
    if (effectiveRatio !== undefined) {
      body.ratio = effectiveRatio;
    }
    if (input.aigc_watermark !== undefined) body.aigc_watermark = input.aigc_watermark;

    if (attemptedVideoSubmissions.has(duplicateKey)) {
      return duplicateVideoSubmission(toolName, path);
    }
    attemptedVideoSubmissions.add(duplicateKey);

    let raw: Awaited<ReturnType<typeof callMatrixToolRaw>>;
    try {
      raw = await callMatrixToolRaw({
        toolName,
        path,
        input: body,
        ctx,
        archonServer: this.archonServer,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      return failedVideoSubmission(toolName, path, error);
    }
    if (!raw.ok) return failedVideoSubmission(toolName, path, raw.result.text, raw.result);
    return successfulVideoResult(toolName, path, raw.response);
  }
}

async function uploadCollection(
  paths: readonly string[] | undefined,
  workspaceScope: MatrixPathScope,
  mediaClient: MatrixMediaClient,
  maxBytes: number,
  field: string,
): Promise<MatrixMediaInfoPayload[] | undefined> {
  if (paths === undefined) return undefined;
  const results: MatrixMediaInfoPayload[] = [];
  for (const [index, path] of paths.entries()) {
    results.push(
      await prepareVideoInput(path, workspaceScope, mediaClient, maxBytes, `${field}[${index}]`),
    );
  }
  return results;
}

async function prepareReferenceVideoCollection(
  paths: readonly string[] | undefined,
  suppliedDurations: readonly number[] | undefined,
  workspaceScope: MatrixPathScope,
  mediaClient: MatrixMediaClient,
): Promise<Array<MatrixMediaInfoPayload & { duration_seconds: number }> | undefined> {
  if (paths === undefined) return undefined;
  const results: Array<MatrixMediaInfoPayload & { duration_seconds: number }> = [];
  for (const [index, path] of paths.entries()) {
    const suppliedDuration = suppliedDurations?.[index];
    if (isHttpUrl(path) && suppliedDuration === undefined) {
      throw new FileTransferError(
        'input_upload_failed',
        `reference_video_duration_seconds[${index}] is required for public reference video URL '${path}'.`,
      );
    }
    let prepared: MatrixMediaInfoPayload;
    let durationSeconds = suppliedDuration;
    if (isHttpUrl(path)) {
      prepared = await prepareVideoInput(
        path,
        workspaceScope,
        mediaClient,
        MAX_VIDEO_BYTES,
        `reference_video_paths[${index}]`,
      );
    } else {
      const inspected = await inspectWorkspaceMedia(
        path,
        workspaceScope,
        MAX_VIDEO_BYTES,
        `reference_video_paths[${index}]`,
      );
      let probedDuration: number | undefined;
      try {
        probedDuration = await readIsoBmffDurationSeconds(inspected.absolutePath);
      } catch (error) {
        throw new FileTransferError(
          'input_upload_failed',
          `Could not read duration_seconds for reference_video_paths[${index}] '${path}'. Provide a valid MP4/MOV workspace file or use a public URL with reference_video_duration_seconds[${index}].`,
          error,
        );
      }
      if (probedDuration === undefined) {
        throw new FileTransferError(
          'input_upload_failed',
          `Could not read duration_seconds for reference_video_paths[${index}] '${path}'. Provide a valid MP4/MOV workspace file or use a public URL with reference_video_duration_seconds[${index}].`,
        );
      }
      durationSeconds = probedDuration;
      const uploaded = await uploadInputFile(
        path,
        workspaceScope,
        mediaClient,
        VIDEO_MEDIA_UPLOAD_OPTIONS,
      );
      prepared = uploadedVideoInputToMediaInfo(uploaded);
      if (prepared.url && !isPublicHttpUrl(prepared.url)) {
        throw new FileTransferError(
          'input_upload_failed',
          `Failed to prepare video media '${path}': temporary URL host is not publicly reachable.`,
        );
      }
    }
    if (durationSeconds === undefined) {
      throw new FileTransferError(
        'input_upload_failed',
        `Could not read duration_seconds for reference_video_paths[${index}] '${path}'. Provide reference_video_duration_seconds[${index}] explicitly.`,
      );
    }
    if (durationSeconds < 2 || durationSeconds > 15) {
      throw new FileTransferError(
        'input_upload_failed',
        `reference video duration_seconds must be between 2 and 15; reference_video_paths[${index}] is ${durationSeconds}.`,
      );
    }
    results.push({ ...prepared, duration_seconds: durationSeconds });
  }
  const totalDuration = results.reduce((total, item) => total + item.duration_seconds, 0);
  if (totalDuration > 15) {
    throw new FileTransferError(
      'input_upload_failed',
      `reference video duration_seconds total must be at most 15; received ${totalDuration}.`,
    );
  }
  return results;
}

async function prepareVideoInput(
  input: string,
  workspaceScope: MatrixPathScope,
  mediaClient: MatrixMediaClient,
  maxBytes: number,
  field: string,
): Promise<MatrixMediaInfoPayload> {
  if (isHttpUrl(input)) {
    if (!isPublicHttpUrl(input)) {
      throw new FileTransferError(
        'input_upload_failed',
        `Failed to prepare video media '${input}': URL host is not publicly reachable.`,
      );
    }
    return { url: input };
  }
  await inspectWorkspaceMedia(input, workspaceScope, maxBytes, field);
  const payload = uploadedVideoInputToMediaInfo(
    await uploadInputFile(input, workspaceScope, mediaClient, VIDEO_MEDIA_UPLOAD_OPTIONS),
  );
  if (payload.url && !isPublicHttpUrl(payload.url)) {
    throw new FileTransferError(
      'input_upload_failed',
      `Failed to prepare video media '${input}': temporary URL host is not publicly reachable.`,
    );
  }
  return payload;
}

async function inspectWorkspaceMedia(
  input: string,
  workspaceScope: MatrixPathScope,
  maxBytes: number,
  field: string,
): Promise<{ absolutePath: string; bytes: number }> {
  let inputPath: string;
  try {
    inputPath = input.startsWith('file://') ? fileURLToPath(input) : input;
  } catch (error) {
    throw new FileTransferError(
      'input_not_found',
      `Input file URL is invalid: '${input}'. Provide a workspace-relative path or valid file:// URL.`,
      error,
    );
  }
  let absolutePath: string;
  try {
    absolutePath = await resolveInputWithinScope(inputPath, workspaceScope);
  } catch (error) {
    throw new FileTransferError(
      'path_escapes_workspace',
      `Input file path '${input}' is outside the workspace. Provide a path under one of: '${inputRootsOf(
        workspaceScope,
      ).join("', '")}'.`,
      error,
    );
  }
  let fileStats;
  try {
    fileStats = await stat(absolutePath);
  } catch (error) {
    throw new FileTransferError(
      'input_not_found',
      `Input file does not exist at '${absolutePath}'. Make sure the file was written before calling this tool.`,
      error,
    );
  }
  if (!fileStats.isFile()) {
    throw new FileTransferError('input_not_found', `Input path is not a file: ${absolutePath}`);
  }
  if (fileStats.size > maxBytes) {
    throw new FileTransferError(
      'input_upload_failed',
      `${field} is ${formatMiB(fileStats.size)}, above the Video Generation V2 limit of ${formatMiB(
        maxBytes,
      )}.`,
    );
  }
  return { absolutePath, bytes: fileStats.size };
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function uploadedVideoInputToMediaInfo(uploaded: UploadedInputFile): MatrixMediaInfoPayload {
  return {
    url: requireUploadedInputFileUrl(uploaded),
    ...(uploaded.mimeType ? { mime_type: uploaded.mimeType } : {}),
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
    const addressFamily = isIP(hostname);
    if (addressFamily === 4) return isPublicIpv4(hostname);
    if (addressFamily === 6) return isPublicIpv6(hostname);
    if (
      hostname === 'localhost' ||
      !hostname.includes('.') ||
      ['.localhost', '.local', '.internal', '.home.arpa', '.invalid'].some((suffix) =>
        hostname.endsWith(suffix),
      ) ||
      hostname.endsWith('-internal.aliyuncs.com')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  const [first = 0, second = 0, third = 0] = octets;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 192 && second === 0 && [0, 2].includes(third)) return false;
  if (first === 198 && [18, 19, 51].includes(second)) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return !(
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:') ||
    normalized.startsWith('::ffff:')
  );
}

function validateVideoSubmission(input: MatrixSubmitVideoGenerationInput): string | undefined {
  if (!isH3VideoModel(input.model) && input.model !== HAILUO_23_MODEL) {
    return `model must be ${MINIMAX_H3_MODEL} or ${HAILUO_23_MODEL}`;
  }
  if (!input.prompt?.trim()) return 'prompt is required';
  if (Array.from(input.prompt).length > MAX_VIDEO_GENERATION_PROMPT_LENGTH) {
    return `prompt may contain at most ${MAX_VIDEO_GENERATION_PROMPT_LENGTH} characters`;
  }
  if (!Number.isInteger(input.duration)) {
    return 'duration is required after model selection and must be an integer number of seconds';
  }
  if (isH3VideoModel(input.model) && (input.duration < 4 || input.duration > 15)) {
    return `${MINIMAX_H3_MODEL} duration must be between 4 and 15 seconds`;
  }
  const collectionError =
    validateCollection(input.reference_image_paths, 'reference_image_paths', 9) ??
    validateCollection(input.reference_video_paths, 'reference_video_paths', 3) ??
    validateCollection(
      input.reference_video_duration_seconds,
      'reference_video_duration_seconds',
      3,
    ) ??
    validateCollection(
      input.reference_audio_paths,
      'reference_audio_paths',
      MAX_H3_REFERENCE_AUDIO_COUNT,
    );
  if (collectionError) return collectionError;

  if (
    input.reference_video_duration_seconds !== undefined &&
    input.reference_video_paths === undefined
  ) {
    return 'reference_video_duration_seconds requires reference_video_paths';
  }
  if (
    input.reference_video_duration_seconds !== undefined &&
    input.reference_video_duration_seconds.length !== input.reference_video_paths?.length
  ) {
    return 'reference_video_duration_seconds must contain the same number of items as reference_video_paths';
  }
  if (input.reference_video_duration_seconds !== undefined) {
    for (const [index, durationSeconds] of input.reference_video_duration_seconds.entries()) {
      if (!Number.isFinite(durationSeconds) || durationSeconds < 2 || durationSeconds > 15) {
        return `reference_video_duration_seconds[${index}] must be between 2 and 15`;
      }
    }
    const totalDuration = input.reference_video_duration_seconds.reduce(
      (total, durationSeconds) => total + durationSeconds,
      0,
    );
    if (totalDuration > 15) {
      return `reference_video_duration_seconds total must be at most 15; received ${totalDuration}`;
    }
  }

  const referenceMediaCount =
    (input.reference_image_paths?.length ?? 0) +
    (input.reference_video_paths?.length ?? 0) +
    (input.reference_audio_paths?.length ?? 0);
  if (isH3VideoModel(input.model) && referenceMediaCount > MAX_H3_REFERENCE_MEDIA_COUNT) {
    return `reference collections may contain at most ${MAX_H3_REFERENCE_MEDIA_COUNT} files in total`;
  }

  const hasCollections =
    input.reference_image_paths !== undefined ||
    input.reference_video_paths !== undefined ||
    input.reference_audio_paths !== undefined;
  if (input.model === HAILUO_23_MODEL && hasCollections) {
    return (
      `${HAILUO_23_MODEL} accepts exactly one input_image_path; ` +
      `reference collections are supported only by ${MINIMAX_H3_MODEL}`
    );
  }
  if (input.model === HAILUO_23_MODEL && !input.input_image_path?.trim()) {
    return `${HAILUO_23_MODEL} requires exactly one input_image_path`;
  }
  if (
    hasCollections &&
    (input.input_image_path !== undefined ||
      input.last_frame_image_path !== undefined ||
      input.reference_type !== undefined)
  ) {
    return 'reference collections cannot be combined with keyframe image paths or reference_type';
  }
  if (
    (input.reference_audio_paths?.length ?? 0) > 0 &&
    (input.reference_image_paths?.length ?? 0) === 0 &&
    (input.reference_video_paths?.length ?? 0) === 0
  ) {
    return 'reference_audio_paths cannot be used alone; add at least one reference image or video';
  }
  if (input.reference_type !== undefined && input.input_image_path === undefined) {
    return 'reference_type requires input_image_path';
  }
  if (input.last_frame_image_path !== undefined) {
    if (!isH3VideoModel(input.model)) {
      return 'last_frame_image_path is supported only by MiniMax-H3';
    }
    if (input.input_image_path === undefined) {
      return 'last_frame_image_path requires input_image_path as the first frame';
    }
    if (input.reference_type !== undefined && input.reference_type !== 'first_frame') {
      return 'first+last-frame mode requires reference_type first_frame or omitted';
    }
  }
  if (
    isH3VideoModel(input.model) &&
    input.reference_type !== undefined &&
    input.reference_type !== 'first_frame' &&
    input.reference_type !== 'last_frame'
  ) {
    return `${MINIMAX_H3_MODEL} supports first_frame or last_frame keyframe mode`;
  }
  if (
    input.model === HAILUO_23_MODEL &&
    input.reference_type !== undefined &&
    input.reference_type !== 'first_frame' &&
    input.reference_type !== 'subject'
  ) {
    return `${HAILUO_23_MODEL} supports first_frame or legacy subject mode`;
  }

  if (
    isH3VideoModel(input.model) &&
    input.resolution !== undefined &&
    input.resolution !== '768P' &&
    input.resolution !== '2K'
  ) {
    return `${MINIMAX_H3_MODEL} supports 768P or 2K`;
  }
  if (
    input.model === HAILUO_23_MODEL &&
    input.resolution !== undefined &&
    input.resolution !== '768P' &&
    input.resolution !== '1080P'
  ) {
    return `${HAILUO_23_MODEL} supports 768P or 1080P`;
  }
  if (input.model === HAILUO_23_MODEL) {
    if (input.duration !== 6 && input.duration !== 10) {
      return `${HAILUO_23_MODEL} supports 6s or 10s`;
    }
    if (input.duration === 10 && input.resolution === '1080P') {
      return `${HAILUO_23_MODEL} 10s generation requires 768P`;
    }
  }
  if (isH3VideoModel(input.model) && input.ratio !== undefined && !H3_RATIOS.has(input.ratio)) {
    return `${MINIMAX_H3_MODEL} ratio must be adaptive, 21:9, 16:9, 4:3, 1:1, 3:4, or 9:16`;
  }
  const hasKeyframes =
    input.input_image_path !== undefined || input.last_frame_image_path !== undefined;
  if (
    isH3VideoModel(input.model) &&
    !hasKeyframes &&
    !hasCollections &&
    input.ratio === 'adaptive'
  ) {
    return `${MINIMAX_H3_MODEL} text-only ratio cannot be adaptive`;
  }

  const formatError =
    validateFileExtension(
      input.input_image_path,
      'input_image_path',
      isH3VideoModel(input.model)
        ? H3_ALLOWED_IMAGE_EXTENSIONS
        : HAILUO_23_ALLOWED_IMAGE_EXTENSIONS,
    ) ??
    validateFileExtension(
      input.last_frame_image_path,
      'last_frame_image_path',
      H3_ALLOWED_IMAGE_EXTENSIONS,
    ) ??
    validateFileExtensions(
      input.reference_image_paths,
      'reference_image_paths',
      H3_ALLOWED_IMAGE_EXTENSIONS,
    ) ??
    validateFileExtensions(
      input.reference_video_paths,
      'reference_video_paths',
      ALLOWED_VIDEO_EXTENSIONS,
    ) ??
    validateFileExtensions(
      input.reference_audio_paths,
      'reference_audio_paths',
      ALLOWED_AUDIO_EXTENSIONS,
    );
  return formatError;
}

function hasReferenceCollections(input: MatrixSubmitVideoGenerationInput): boolean {
  return (
    input.reference_image_paths !== undefined ||
    input.reference_video_paths !== undefined ||
    input.reference_audio_paths !== undefined
  );
}

function validateCollection(
  values: readonly unknown[] | undefined,
  field: string,
  maxItems?: number,
): string | undefined {
  if (values === undefined) return undefined;
  if (values.length === 0) return `${field} must be a non-empty array when provided`;
  if (maxItems !== undefined && values.length > maxItems) {
    return `${field} may contain at most ${maxItems} items`;
  }
  return undefined;
}

function validateFileExtensions(
  paths: readonly string[] | undefined,
  field: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  if (paths === undefined) return undefined;
  for (let index = 0; index < paths.length; index += 1) {
    const error = validateFileExtension(paths[index], `${field}[${index}]`, allowed);
    if (error) return error;
  }
  return undefined;
}

function validateFileExtension(
  path: string | undefined,
  field: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  if (path === undefined) return undefined;
  const extension = extname(pathnameForExtension(path)).toLowerCase();
  if (!allowed.has(extension)) {
    return `${field} must use ${[...allowed].join(', ')} media`;
  }
  return undefined;
}

function pathnameForExtension(value: string): string {
  if (isHttpUrl(value)) return new URL(value).pathname;
  return value.split(/[?#]/u, 1)[0] ?? '';
}

function invalidVideoRequest(toolName: string, path: string, message: string): ToolResult {
  const text = `Invalid video request: ${message}. No file was read and no paid task was submitted.`;
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    isError: true,
    details: { ok: false, path, reason: 'invalid_video_request' },
  };
}

function duplicateVideoSubmission(toolName: string, path: string): ToolResult {
  const text =
    'Duplicate paid submission blocked: this exact video request was already attempted in this ' +
    'turn. Do not wait and do not call submit_video_generation again. If the original attempt ' +
    'returned a task_id, call query_video_generation with that task_id and the same model. If it ' +
    'returned an error, report that original failure; never infer that a task was created. Retry ' +
    'only after a new explicit user request in a later turn.';
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    isError: true,
    details: { ok: false, path, reason: 'duplicate_paid_submission' },
  };
}

function failedVideoSubmission(
  toolName: string,
  path: string,
  error: unknown,
  original?: ToolResult,
): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const text =
    `Video submit failed: ${message}. No task_id was returned. Do not infer that a task was created, ` +
    'do not wait for a duplicate lock to expire, and do not retry submit_video_generation ' +
    'automatically. Report this failure to the user. Retry only after a new explicit user request ' +
    'in a later turn.';
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    isError: true,
    details: {
      ...(original?.details ?? {}),
      ok: false,
      path,
      reason: 'video_submit_failed',
      ...(original?.details ? { upstream: original.details } : {}),
    },
  };
}

function successfulVideoResult(
  toolName: string,
  path: string,
  response: Record<string, unknown>,
): ToolResult {
  const text = JSON.stringify(response, null, 2);
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    details: { ok: true, path, response },
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
