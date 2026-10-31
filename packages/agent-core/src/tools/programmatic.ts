/**
 * Helpers for the programmatic (PTC) side channel of tool results.
 *
 * A tool that fails below its own logic (for example an MCP call rejected by
 * the JSON-RPC peer) usually throws; Pi then keeps only `error.message`. The
 * raw protocol error is attached to the thrown object under a registry symbol
 * so the PTC executor can hand it to guest code as `error.raw` while ordinary
 * model calls, logs and persistence keep seeing the unchanged Error.
 */

import { createHash } from 'node:crypto';

import type { ProgrammaticToolResult, ToolResult } from './types.js';

const PROGRAMMATIC_ERROR_RAW = Symbol.for('mavis.programmaticTool.errorRaw');
const PROGRAMMATIC_ERROR_DATA = Symbol.for('mavis.programmaticTool.errorData');

/**
 * Attaches a raw error description to a thrown object in place, so the caller
 * can rethrow the original value with its type, message and stack unchanged.
 * Returns false when the value cannot carry it (a primitive or a frozen
 * object); the caller should log that the raw value was lost and still rethrow.
 */
export function attachProgrammaticErrorRaw(error: unknown, raw: unknown): boolean {
  if (raw === undefined || error === null || typeof error !== 'object') return false;
  if (!Object.isExtensible(error)) return false;
  Object.defineProperty(error, PROGRAMMATIC_ERROR_RAW, {
    value: raw,
    enumerable: false,
    configurable: true,
  });
  return true;
}

export function readProgrammaticErrorRaw(error: unknown): unknown {
  if (error === null || typeof error !== 'object') return undefined;
  return Reflect.get(error, PROGRAMMATIC_ERROR_RAW);
}

/**
 * Attaches the failure metadata a native tool knows (the path it tried, the
 * kind of read) to an error it rethrows, the same way as the raw error: Pi
 * keeps only the message for the model, so PTC data is the one place it shows.
 */
export function attachProgrammaticErrorData(
  error: unknown,
  data: Readonly<Record<string, unknown>>,
): boolean {
  if (error === null || typeof error !== 'object' || !Object.isExtensible(error)) return false;
  Object.defineProperty(error, PROGRAMMATIC_ERROR_DATA, {
    value: data,
    enumerable: false,
    configurable: true,
  });
  return true;
}

export function readProgrammaticErrorData(
  error: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const data: unknown = Reflect.get(error, PROGRAMMATIC_ERROR_DATA);
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    ? (data as Readonly<Record<string, unknown>>)
    : undefined;
}

/** Merges a programmatic payload into a tool result without touching model-visible fields. */
export function withProgrammaticResult(
  result: ToolResult,
  programmatic: ProgrammaticToolResult,
): ToolResult {
  return { ...result, programmatic: { ...result.programmatic, ...programmatic } };
}

/**
 * What the host's request image encoder did to one image block: re-encoded
 * it (`width`/`height` are what the model receives), or replaced it with a
 * note because the image processor cannot load.
 */
export type ProgrammaticImageEncoding =
  | {
      readonly mimeType: string;
      readonly width: number;
      readonly height: number;
      readonly originalWidth: number;
      readonly originalHeight: number;
    }
  | { readonly mimeType: string; readonly omittedReason: 'processor_unavailable' };

interface EncodedContentRecord {
  readonly source: string;
  readonly output: string;
  readonly images: readonly ProgrammaticImageEncoding[];
}

// Module-private, so only code that calls recordImageEncodedContent can mark
// content; a hook that returns its own array, or edits this one, is not marked.
const encodedContent = new WeakMap<object, EncodedContentRecord>();

/**
 * Called by the request image encoder on the content array it returns.
 * Digests of both arrays are kept (not the arrays: they carry image data and
 * the output stays in history), so a reader can check that the encoder's input
 * was the tool's own content and that nothing changed its output afterwards.
 */
export function recordImageEncodedContent(
  source: readonly unknown[],
  output: readonly unknown[],
  images: readonly ProgrammaticImageEncoding[],
): void {
  const sourceDigest = contentDigest(source);
  const outputDigest = contentDigest(output);
  if (sourceDigest === undefined || outputDigest === undefined || images.length === 0) return;
  encodedContent.set(output, { source: sourceDigest, output: outputDigest, images });
}

/**
 * The encoder's facts for `finalContent` when it is exactly the encoder's
 * output and the encoder's input serialized to `ownContentJson` (the tool's
 * content as it left the tool); undefined otherwise.
 */
export function readImageEncodedContent(
  finalContent: unknown,
  ownContentJson: string | undefined,
): readonly ProgrammaticImageEncoding[] | undefined {
  if (ownContentJson === undefined || finalContent === null || typeof finalContent !== 'object') {
    return undefined;
  }
  const record = encodedContent.get(finalContent);
  if (!record || record.source !== digest(ownContentJson)) return undefined;
  return record.output === contentDigest(finalContent) ? record.images : undefined;
}

function contentDigest(content: unknown): string | undefined {
  try {
    const json = JSON.stringify(content);
    return json === undefined ? undefined : digest(json);
  } catch {
    // Cycles or BigInt: such content cannot be shown to be the encoder's.
    return undefined;
  }
}

function digest(json: string): string {
  return createHash('sha256').update(json).digest('hex');
}
