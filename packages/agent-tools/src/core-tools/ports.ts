/**
 * IO ports of the host-neutral core tools (read / write / edit / bash / grep / glob).
 *
 * Only the calls the tools actually make, with node:fs/promises signatures, so
 * the desktop host passes physical-fs unchanged and other hosts adapt their own
 * filesystem. Errors follow node conventions: a missing path rejects with
 * `code: 'ENOENT'` (Pi's mutation queue and the read fallbacks depend on it).
 */

export interface CoreToolFileHandle {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface CoreToolStats {
  readonly size: number;
  readonly mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  isBlockDevice(): boolean;
}

export interface CoreToolFs {
  access(path: string): Promise<void>;
  open(path: string, flags: 'r'): Promise<CoreToolFileHandle>;
  readFile(path: string): Promise<Buffer>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<CoreToolStats>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
}

export interface CoreRgOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  /** Byte safety cap on collected stdout; exceeding it sets `stdoutTruncated`. */
  maxStdoutBytes?: number;
  /** Keep only complete stdout lines matching this regex (`\r` stripped, `\` → `/`). */
  stdoutLineRegex?: RegExp;
  /** Stop after this many matching stdout lines and set `stdoutTruncated`. */
  maxStdoutLines?: number;
}

export interface CoreRgResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
}

/** Runs ripgrep with `args` from `cwd` on the host that owns the files. */
export type CoreRgRunner = (
  args: string[],
  cwd: string,
  opts?: CoreRgOptions,
) => Promise<CoreRgResult>;

export interface CoreToolHost {
  readonly fs: CoreToolFs;
  readonly runRg: CoreRgRunner;
  /**
   * Home directory for a leading `~`; undefined rejects such paths with a
   * clear error. Pi's file tools still expand `~` against the process home, so
   * a host whose home differs must pre-expand read/write/edit paths with
   * `expandHomePath` before calling execute.
   */
  homedir(): string | undefined;
}
