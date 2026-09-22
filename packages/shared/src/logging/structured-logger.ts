import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import pino from 'pino';
import pinoPretty from 'pino-pretty';

import type { DiskLogTransport } from './disk-transport.js';
import { redactSecretText, redactSecretValue } from './redact-log-secret.js';

export interface TraceContextLike {
  traceId: string;
}

export interface StructuredLoggerOptions {
  level?: string;
  colorize?: boolean;
  destination?: NodeJS.WritableStream | number;
  env?: NodeJS.ProcessEnv;
  /**
   * Optional persistent-disk transport. When provided, every pretty-formatted
   * line is fanned out to both {@link destination} (stdout by default, kept
   * for terminal / journald / stdio-capturing supervisor visibility) and the
   * disk transport's rotating file. The caller owns the transport lifecycle;
   * see `./disk-transport.ts` for how it manages hourly rotation, retention,
   * and the total-bytes cap.
   *
   * The disk copy is stripped of ANSI escape sequences before it is written:
   * `colorize` defaults to on whenever `NODE_ENV !== 'production'` (which
   * includes packaged Electron apps, where NODE_ENV is simply unset), and a
   * colorized level token breaks the `LOCAL_RUNTIME_ERROR_LEVEL_REGEX`
   * scanner (`apps/electron/main/utils/extra-log-source.ts`) that the
   * feedback upload bundle uses to extract ERROR/WARN/FATAL context. The
   * terminal copy keeps its colors.
   */
  disk?: DiskLogTransport;
}

/** Extras stay serializable the way the caller built them; an exotic payload degrades to its keys. */
function stringifyExtras(extras: Record<string, unknown>): string {
  try {
    return JSON.stringify(extras);
  } catch {
    return JSON.stringify(Object.keys(extras));
  }
}

function getCallerLocation(): string | undefined {
  const { stack } = new Error();
  if (!stack) return undefined;

  const stackLines = stack.split('\n').slice(1);
  let fallback: string | undefined;

  for (const line of stackLines) {
    if (
      line.includes('structured-logger.ts') ||
      line.includes('logger.ts') ||
      line.includes('node:internal')
    ) {
      continue;
    }

    const match = line.match(/at\s+(?:.+\s+\()?(.+):(\d+):(\d+)\)?$/);
    if (!match) continue;

    const rawPath = match[1]?.replace(/^file:\/\//, '');
    const lineNumber = match[2];
    if (!rawPath || !lineNumber) continue;
    if (rawPath.includes('/node_modules/') || rawPath.includes('/pino/')) continue;

    const location = `${path.basename(rawPath)}:${lineNumber}`;
    if (rawPath.includes('/packages/') || rawPath.includes('/src/')) return location;

    fallback = fallback ?? location;
  }

  return fallback;
}

function createPrettyStream(
  options?: Pick<StructuredLoggerOptions, 'colorize' | 'destination'>,
): ReturnType<typeof pinoPretty> {
  const standardKeys = new Set(['level', 'time', 'pid', 'hostname', 'source', 'msg', 'traceId']);

  return pinoPretty({
    colorize: options?.colorize ?? false,
    destination: options?.destination ?? process.stdout,
    translateTime: 'SYS:HH:MM:ss.l',
    ignore: 'pid,hostname',
    singleLine: true,
    hideObject: true,
    messageFormat: (log: Record<string, unknown>, messageKey: string) => {
      const source = log.source ?? '';
      const traceId = log.traceId as string | undefined;
      const msg = log[messageKey] ?? '';
      const extras: Record<string, unknown> = {};
      for (const key of Object.keys(log)) {
        if (!standardKeys.has(key)) extras[key] = log[key];
      }
      // Redact here, at the single point where a log line becomes text. Every
      // level and both the terminal and disk arms pass through it, so no call
      // site has to remember to strip credentials before logging.
      const safeExtras = redactSecretValue(extras);
      const jsonStr = Object.keys(safeExtras).length > 0 ? ` ${stringifyExtras(safeExtras)}` : '';
      const traceSuffix = traceId ? ` [${traceId}]` : '';
      return `[${String(source)}]${traceSuffix} ${redactSecretText(String(msg))}${jsonStr}\n`;
    },
  });
}

export function createStructuredLogger(options: StructuredLoggerOptions = {}): pino.Logger {
  const env = options.env ?? process.env;
  const isDev = env.NODE_ENV !== 'production';
  const level = options.level ?? env.LOG_LEVEL ?? 'info';
  const baseOptions: pino.LoggerOptions = {
    level,
    mixin() {
      const source = getCallerLocation();
      return source ? { source } : {};
    },
  };

  const primary = options.destination ?? process.stdout;
  const destination = isolateLoggerDestination(
    primary as NodeJS.WritableStream | number,
    options.disk,
  );

  return pino(
    baseOptions,
    createPrettyStream({
      colorize: options.colorize ?? isDev,
      destination,
    }),
  );
}

/**
 * CSI escape sequences (SGR colors, cursor movement). Stripped from the
 * disk arm so on-disk logs stay plain text for the upload error scanner and
 * human triage, regardless of the colorize setting.
 */
// eslint-disable-next-line no-control-regex -- matching the ESC byte is the point.
const ANSI_CSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.includes('\u001b') ? text.replace(ANSI_CSI_PATTERN, '') : text;
}

/**
 * Isolate pino-pretty lifecycle listeners from `primary` (usually process.stdout),
 * and optionally fan output out to the disk transport. Errors on either arm never propagate: stdout failures
 * would spam the terminal, and disk failures already route through the
 * transport's `onError` sink. Losing a log line is preferable to breaking
 * the caller's control flow.
 *
 * `primary` may be a file descriptor number when the caller passes a
 * pino-pretty compatible destination — in that case we resolve it through
 * `fs.createWriteStream` so we still have a Writable to fan out to.
 */
function isolateLoggerDestination(
  primary: NodeJS.WritableStream | number,
  disk?: DiskLogTransport,
): NodeJS.WritableStream {
  const primaryStream: NodeJS.WritableStream =
    typeof primary === 'number' ? fdToWritable(primary) : primary;
  return new Writable({
    autoDestroy: false,
    decodeStrings: false,
    defaultEncoding: 'utf8',
    write(chunk, _encoding, cb) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      try {
        primaryStream.write(text);
      } catch {
        // ignore stdout / journald errors — matches pino's default behaviour
      }
      if (disk) {
        try {
          disk.write(stripAnsi(text));
        } catch {
          // disk failures already route via disk.onError; swallow here so a
          // broken transport can never crash the pretty stream pipeline.
        }
      }
      cb();
    },
  });
}

function fdToWritable(fd: number): NodeJS.WritableStream {
  return createWriteStream('', { fd, autoClose: false });
}

const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

function isContextObject(v: unknown): v is TraceContextLike {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).traceId === 'string'
  );
}

export function wrapTraceContextLogger(logger: pino.Logger): pino.Logger {
  return new Proxy(logger, {
    get(target, prop) {
      const val = Reflect.get(target, prop, target);
      if (typeof prop === 'string' && LOG_METHODS.has(prop) && typeof val === 'function') {
        return (firstArg: unknown, ...rest: unknown[]) => {
          if (isContextObject(firstArg) && !('ctx' in firstArg)) {
            return (val as (...a: unknown[]) => void).call(
              target,
              { traceId: firstArg.traceId },
              ...rest,
            );
          }
          if (firstArg !== null && typeof firstArg === 'object' && 'ctx' in firstArg) {
            const { ctx, ...others } = firstArg as Record<string, unknown>;
            const flat = isContextObject(ctx) ? { traceId: ctx.traceId, ...others } : { ...others };
            return (val as (...a: unknown[]) => void).call(target, flat, ...rest);
          }
          return (val as (...a: unknown[]) => void).call(target, firstArg, ...rest);
        };
      }
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}
