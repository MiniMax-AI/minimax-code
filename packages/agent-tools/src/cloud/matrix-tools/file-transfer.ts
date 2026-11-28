/**
 * Shared file-I/O helpers for matrix-tools, encapsulating the workspace file ↔ OSS signed URL ↔
 * remote matrix-tools pipeline in two functions:
 *
 *   uploadInputFile(filePath, ctx, ossMediaClient)
 *     Pass the LLM's workspace path through path-guard → realpath → OSS put → signed URL. Return `{ signedUrl, ossKey, bytes }` for the matrix-tools request body.
 *
 *   downloadOutputFile(url, filePath, ctx, ossMediaClient)
 *     Fetch the response CDN/signed URL into the specified workspace path.
 *
 * Consistent failure semantics: throw `FileTransferError` with an LLM-readable message. Tools catch
 * it and return ToolResult { ok: false }, matching missing-api_key handling.
 *
 * No schema validation here; typebox already handled it. This module handles only fs / OSS /
 * network.
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

/** Unified file-I/O error; tool implementations catch it and expose `.message` to the LLM. */
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
  /** Absolute workspace path, already checked by resolveWithinWorkspace. */
  readonly absolutePath: string;
  /** Signed URL ready for the matrix-tools request body. */
  readonly signedUrl?: string;
  /** Base64 inline bytes, used by local hosts for small media files. */
  readonly inlineData?: string;
  /** MIME type for inline data or uploaded object. */
  readonly mimeType?: string;
  /** OSS object key, for logging only. */
  readonly ossKey: string;
  /** File size in bytes, for logging only. */
  readonly bytes: number;
}

export interface MatrixMediaInfoPayload {
  readonly url?: string;
  readonly data?: string;
  readonly mime_type?: string;
  readonly prompt?: string;
}

/**
 * Upload a workspace file to OSS and return its signed URL.
 *
 * @throws FileTransferError if the file is missing, outside the workspace, or OSS upload fails.
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
 * Batch variant: upload local files sequentially to avoid overloading OSS; serial execution is
 * sufficient for N≤20. Throw on any failure without partial-success fallback so the LLM can
 * diagnose the full failure.
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
 * Download a URL from a matrix-tools response to the specified workspace path.
 *
 * `options.signal` is the turn-level abort channel. Aborting cancels an active download; rethrow
 * unchanged (without wrapping as FileTransferError) so pi agent-loop recognizes abort and stops the
 * turn rather than continuing with a normal download tool error. Forward `options.timeoutMs` for
 * the underlying fallback timeout.
 *
 * @throws FileTransferError for out-of-bounds paths, download failures, or file-write failures.
 * @throws MatrixMediaError(kind='aborted') when the caller signal or timeout fires.
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
 * Text output helper: write string content directly to a workspace path without downloading a URL.
 * Used by tools such as `image_reverse_search` that serialize results locally instead of
 * transferring remote files.
 *
 * @throws FileTransferError for out-of-bounds paths or file-write failures.
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
 * Convert FileTransferError to cloud-runtime's standard failure ToolResult. Each matrix-tools
 * execute body only needs:
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
