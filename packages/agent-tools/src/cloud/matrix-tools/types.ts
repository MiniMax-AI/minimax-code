import type { ToolExecutionContext } from '@mavis/agent-core/tools';

export type { MatrixPathScope } from './path-guard.js';

export interface MatrixToolLogger {
  info(ctx: MatrixToolContext, message: string): void;
  warn(ctx: MatrixToolContext, message: string): void;
  debug?(ctx: MatrixToolContext, message: string): void;
}

export interface MatrixToolContext extends ToolExecutionContext {
  readonly workspaceRoot?: string;
  readonly matrixLogger?: MatrixToolLogger;
}

export interface MatrixExecutor {
  postJson(
    pathname: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    options?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
}

export interface MatrixUploadOptions {
  readonly filename?: string;
  readonly mimeType?: string;
  readonly ttlSeconds?: number;
  readonly category?: string;
  readonly forceRemoteUrl?: boolean;
}

export interface MatrixUploadResult {
  readonly ossKey: string;
  readonly signedUrl?: string;
  readonly inlineData?: string;
  readonly mimeType?: string;
  readonly bytes: number;
}

export interface MatrixDownloadToFileOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface MatrixMediaClient {
  uploadFile(localPath: string, options?: MatrixUploadOptions): Promise<MatrixUploadResult>;
  downloadToFile(
    url: string,
    localPath: string,
    options?: MatrixDownloadToFileOptions,
  ): Promise<{ bytes: number }>;
}

/**
 * Which credential a Matrix client lacks: the managed MiniMax login, or the
 * MATRIX_TOKEN a custom MATRIX_BASE_URL requires.
 */
export type MatrixAuthRequiredReason = 'managed_login' | 'matrix_token';

const MATRIX_AUTH_REQUIRED_REASONS: readonly string[] = ['managed_login', 'matrix_token'];

/**
 * Which Matrix backend answered: the managed MiniMax gateway, whose credential
 * is the MiniMax sign-in, or a custom MATRIX_BASE_URL using MATRIX_TOKEN.
 */
export type MatrixGatewayBackend = 'managed' | 'custom';

/** Reads the backend a gateway HTTP error was raised for, when it carries one. */
export function readMatrixGatewayBackend(err: unknown): MatrixGatewayBackend | undefined {
  if (!(err instanceof Error)) return undefined;
  const backend = (err as { backend?: unknown }).backend;
  return backend === 'managed' || backend === 'custom' ? backend : undefined;
}

/**
 * Thrown before any request when a Matrix client has no credential to send, so
 * callers can tell the user to sign in instead of reporting a request failure.
 */
export class MatrixAuthRequiredError extends Error {
  constructor(
    readonly reason: MatrixAuthRequiredReason,
    message: string,
  ) {
    super(message);
    this.name = 'MatrixAuthRequiredError';
  }
}

/**
 * Reads the reason of a {@link MatrixAuthRequiredError}, also from a copy of
 * the class bundled separately (matched by name and a known reason).
 */
export function readMatrixAuthRequiredReason(err: unknown): MatrixAuthRequiredReason | undefined {
  if (err instanceof MatrixAuthRequiredError) return err.reason;
  if (!(err instanceof Error) || err.name !== 'MatrixAuthRequiredError') return undefined;
  const reason = (err as { reason?: unknown }).reason;
  return typeof reason === 'string' && MATRIX_AUTH_REQUIRED_REASONS.includes(reason)
    ? (reason as MatrixAuthRequiredReason)
    : undefined;
}

export class MatrixMediaError extends Error {
  readonly underlying?: unknown;

  constructor(
    readonly kind:
      | 'file_not_found'
      | 'upload_failed'
      | 'download_failed'
      | 'write_failed'
      | 'file_too_large'
      | 'aborted',
    message: string,
    underlying?: unknown,
  ) {
    super(message);
    this.name = 'MatrixMediaError';
    if (underlying !== undefined) this.underlying = underlying;
  }
}

export function readMatrixMediaErrorKind(err: unknown): string | undefined {
  if (err instanceof MatrixMediaError) return err.kind;
  if (err && typeof err === 'object') {
    const kind = (err as { kind?: unknown }).kind;
    return typeof kind === 'string' ? kind : undefined;
  }
  return undefined;
}
