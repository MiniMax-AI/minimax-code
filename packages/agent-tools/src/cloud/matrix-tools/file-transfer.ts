/**
 * matrix-tools 工具的文件 I/O 共用 helper —— 把"workspace 本地文件 ↔ OSS 签名
 * URL ↔ matrix-tools 远端"三段流水线封装成两个函数:
 *
 *   uploadInputFile(filePath, ctx, ossMediaClient)
 *     · 把 LLM 给的 workspace 路径过 path-guard → realpath → OSS put → 签名
 *       URL,返回 `{ signedUrl, ossKey, bytes }` 喂给 matrix-tools request body
 *
 *   downloadOutputFile(url, filePath, ctx, ossMediaClient)
 *     · 把 matrix-tools response 里的 CDN/signed URL fetch 到 workspace 指定路径
 *
 * 失败语义统一:抛 `FileTransferError`(message 已经是 LLM 可读句子)。tool
 * 实现 catch 后包成 ToolResult { ok: false } 返回,跟 api_key 缺失同口径。
 *
 * 不在这里做 schema 校验 —— typebox 已经做完了。这里只做 fs / OSS / 网络。
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { ToolResult } from '@mavis/agent-core/tools';

import type { MatrixMediaClient, MatrixUploadOptions } from './types.js';
import { readMatrixMediaErrorKind } from './types.js';
import {
  inputRootsOf,
  resolveInputWithinScope,
  resolveWithinWorkspace,
  workspaceRootOf,
  type MatrixPathScope,
} from './path-guard.js';

/** 文件 I/O 操作的统一异常 —— tool 实现 catch 后读 `.message` 给 LLM。 */
export class FileTransferError extends Error {
  readonly kind:
    | 'input_not_found'
    | 'input_upload_failed'
    | 'output_download_failed'
    | 'output_write_failed'
    | 'path_escapes_workspace';
  readonly underlying?: unknown;

  constructor(kind: FileTransferError['kind'], message: string, underlying?: unknown) {
    super(message);
    this.name = 'FileTransferError';
    this.kind = kind;
    if (underlying !== undefined) this.underlying = underlying;
  }
}

export interface UploadedInputFile {
  /** workspace 内的绝对路径(已 resolveWithinWorkspace 过)。 */
  readonly absolutePath: string;
  /** 签名 URL,可直接喂给 matrix-tools request body。 */
  readonly signedUrl?: string;
  /** Base64 inline bytes, used by local hosts for small media files. */
  readonly inlineData?: string;
  /** MIME type for inline data or uploaded object. */
  readonly mimeType?: string;
  /** OSS 对象 key,纯日志用途。 */
  readonly ossKey: string;
  /** 文件字节数,纯日志用途。 */
  readonly bytes: number;
}

export interface MatrixMediaInfoPayload {
  readonly url?: string;
  readonly data?: string;
  readonly mime_type?: string;
  readonly prompt?: string;
}

/**
 * 把 workspace 文件上传到 OSS 并返回签名 URL。
 *
 * @throws FileTransferError 文件不存在 / 越界 workspace / OSS upload 失败
 */
export async function uploadInputFile(
  workspaceRelativeOrAbsolute: string,
  scope: MatrixPathScope,
  ossMediaClient: MatrixMediaClient,
  options?: MatrixUploadOptions,
): Promise<UploadedInputFile> {
  const inputPath = stripFileUri(workspaceRelativeOrAbsolute);
  let abs: string;
  try {
    abs = await resolveInputWithinScope(inputPath, scope);
  } catch (err) {
    throw new FileTransferError(
      'path_escapes_workspace',
      `Input file path '${workspaceRelativeOrAbsolute}' is outside the workspace. ` +
        `Provide a path under one of: '${inputRootsOf(scope).join("', '")}'.`,
      err,
    );
  }

  try {
    const { ossKey, signedUrl, inlineData, mimeType, bytes } = await ossMediaClient.uploadFile(
      abs,
      options,
    );
    return { absolutePath: abs, signedUrl, inlineData, mimeType, ossKey, bytes };
  } catch (err) {
    if (readMatrixMediaErrorKind(err) === 'file_not_found') {
      throw new FileTransferError(
        'input_not_found',
        `Input file does not exist at '${abs}'. Make sure the file was written ` +
          'before calling this tool.',
        err,
      );
    }
    throw new FileTransferError(
      'input_upload_failed',
      `Failed to upload input file '${abs}' to temporary storage: ${describe(err)}. ` +
        'Please retry.',
      err,
    );
  }
}

/**
 * Batch 版本 —— 顺序上传一组本地文件(并行容易把 OSS 打死,N≤20 串行够用)。
 * 任何一个失败即抛,不做部分成功兜底:LLM 看完整失败更好排查。
 */
export async function uploadInputFiles(
  paths: readonly string[],
  scope: MatrixPathScope,
  ossMediaClient: MatrixMediaClient,
  options?: MatrixUploadOptions,
): Promise<UploadedInputFile[]> {
  const results: UploadedInputFile[] = [];
  for (const p of paths) {
    results.push(await uploadInputFile(p, scope, ossMediaClient, options));
  }
  return results;
}

export function uploadedInputFileToMediaInfo(
  uploaded: UploadedInputFile,
  prompt?: string,
): MatrixMediaInfoPayload {
  const payload: Record<string, string> = {};
  if (uploaded.inlineData) {
    payload.data = uploaded.inlineData;
    if (uploaded.mimeType) payload.mime_type = uploaded.mimeType;
  } else if (uploaded.signedUrl) {
    payload.url = uploaded.signedUrl;
    if (uploaded.mimeType) payload.mime_type = uploaded.mimeType;
  } else {
    throw new FileTransferError(
      'input_upload_failed',
      `Failed to prepare input file '${uploaded.absolutePath}': no URL or inline data was returned.`,
    );
  }
  if (prompt !== undefined) payload.prompt = prompt;
  return payload;
}

export function requireUploadedInputFileUrl(uploaded: UploadedInputFile): string {
  if (uploaded.signedUrl) return uploaded.signedUrl;
  throw new FileTransferError(
    'input_upload_failed',
    `Failed to upload input file '${uploaded.absolutePath}' to temporary storage: no URL was returned.`,
  );
}

/**
 * 把 matrix-tools response 里的 URL 拉到 workspace 指定路径。
 *
 * `options.signal` 是 turn 级 abort 通道:中止时正在跑的下载会被 cancel,
 * 这里把它原样 rethrow(不包成 FileTransferError),让 pi agent-loop 能识别
 * abort 并停止当前 turn,而不是把"下载失败"当普通 tool-error 继续下一轮。
 * `options.timeoutMs` 透传给底层做兜底超时。
 *
 * @throws FileTransferError 路径越界 / 下载失败 / 写文件失败
 * @throws MatrixMediaError(kind='aborted') 当 caller signal / 超时触发
 */
export async function downloadOutputFile(
  url: string,
  workspaceRelativeOrAbsolute: string,
  scope: MatrixPathScope,
  ossMediaClient: MatrixMediaClient,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ absolutePath: string; bytes: number }> {
  // Output fence is workspace-only on purpose: extra input roots (dataDir
  // assets) must never become writable through matrix tools.
  const workspaceRoot = workspaceRootOf(scope);
  let abs: string;
  try {
    abs = await resolveWithinWorkspace(workspaceRelativeOrAbsolute, workspaceRoot);
  } catch (err) {
    throw new FileTransferError(
      'path_escapes_workspace',
      `Output file path '${workspaceRelativeOrAbsolute}' is outside the workspace. ` +
        `Provide a path under '${workspaceRoot}'.`,
      err,
    );
  }

  try {
    const { bytes } = await ossMediaClient.downloadToFile(url, abs, {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    return { absolutePath: abs, bytes };
  } catch (err) {
    // Abort must bubble unchanged so the agent loop can terminate the turn
    // instead of treating it as a retryable download failure.
    if (readMatrixMediaErrorKind(err) === 'aborted') {
      throw err;
    }
    if (readMatrixMediaErrorKind(err) === 'write_failed') {
      throw new FileTransferError(
        'output_write_failed',
        `Failed to write output file '${abs}': ${describe(err)}.`,
        err,
      );
    }
    throw new FileTransferError(
      'output_download_failed',
      `Failed to download generated content from server to '${abs}': ${describe(err)}. ` +
        'The remote content may have expired or the network failed; please retry the tool.',
      err,
    );
  }
}

/**
 * 文本输出 helper —— 不走 URL 下载,直接把 string content 写到 workspace 路径。
 * `image_reverse_search` 等"远端不传文件、本地直接序列化结果"的工具用。
 *
 * @throws FileTransferError 路径越界 / 写文件失败
 */
export async function writeOutputText(
  content: string,
  workspaceRelativeOrAbsolute: string,
  scope: MatrixPathScope,
): Promise<{ absolutePath: string; bytes: number }> {
  // Same workspace-only output fence as downloadOutputFile.
  const workspaceRoot = workspaceRootOf(scope);
  let abs: string;
  try {
    abs = await resolveWithinWorkspace(workspaceRelativeOrAbsolute, workspaceRoot);
  } catch (err) {
    throw new FileTransferError(
      'path_escapes_workspace',
      `Output file path '${workspaceRelativeOrAbsolute}' is outside the workspace. ` +
        `Provide a path under '${workspaceRoot}'.`,
      err,
    );
  }
  const buf = Buffer.from(content, 'utf8');
  try {
    await writeFile(abs, buf);
  } catch (err) {
    throw new FileTransferError(
      'output_write_failed',
      `Failed to write output file '${abs}': ${describe(err)}.`,
      err,
    );
  }
  return { absolutePath: abs, bytes: buf.length };
}

/**
 * 把 FileTransferError 转成 cloud-runtime tool 统一的 failure ToolResult。
 * 这样每个 matrix-tools tool 的 execute body 里只需要:
 *   try { ... } catch (err) {
 *     if (err instanceof FileTransferError) return fileTransferFailureResult(toolName, path, err);
 *     throw err;
 *   }
 */
export function fileTransferFailureResult(
  toolName: string,
  path: string,
  err: FileTransferError,
): ToolResult {
  return {
    tool_name: toolName,
    text: err.message,
    content: [{ type: 'text', text: err.message }],
    details: {
      ok: false,
      path,
      reason: err.kind,
    },
  };
}

function describe(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error';
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  return String(err);
}

function stripFileUri(value: string): string {
  if (!value.startsWith('file://')) return value;
  return fileURLToPath(value);
}
