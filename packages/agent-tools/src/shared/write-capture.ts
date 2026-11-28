/**
 * write-capture.ts — shared write-tool enhancement for the desktop and cloud
 * wrappers (design: .harness/docs/design/tools-optimize/write-tool-optimization.md).
 *
 * The pi engine's write tool accepts a public `WriteOperations` injection
 * point (third_party pi write.ts, self-described for remote/SSH delegation).
 * We inject a `writeFile` that runs INSIDE pi's `withFileMutationQueue`
 * critical section and, per call:
 *
 *   ① reports the true on-disk byte count (pi's `content.length` is a
 *      UTF-16 code-unit count — wrong for CJK/emoji; kimi-code precedent:
 *      `Buffer.byteLength`, taken one step further here to the actual
 *      encoded buffer length);
 *   ② captures the previous content of an overwritten file so the wrapper
 *      can emit a unified patch in `details` (field names aligned with the
 *      pi edit tool's `details.patch` / `firstChangedLine` precedent);
 *   ③ preserves the BOM and the utf16le encoding of the old file
 *      (`desiredBom = src.bom || next.bom` — opencode bom.ts semantics;
 *      encoding carry-over and the utf16le-only detection — reference CLI
 *      `detectEncodingForResolvedPath` semantics).
 *
 * Local-FS assumption: like read-video.ts / read-guards.ts, this module
 * uses physical-fs by default so Electron cannot treat user archives as
 * directories; the core tools pass their host fs port instead.
 * Both hosts (desktop process, cloud sandbox executor) run on a local FS.
 * Remote-FS hosts keep pi's default operations and none of this engages.
 */

import type { CoreToolFs, CoreToolStats } from '../core-tools/ports.js';
import { physicalToolFs } from './physical-fs.js';
import { formatPatch, structuredPatch } from 'diff';

import type { Stats } from 'node:fs';
import type { ToolResult } from '@mavis/agent-core/tools';
import type { WriteOperations } from '@earendil-works/pi-coding-agent';
import { withPluginHookCompatibleToolResponse } from '../plugin-hooks/vendor-tool-response.js';
import { regularFileVersion, type FileVersion } from './file-read-ledger.js';

/** Old files above this size still get BOM/encoding preservation and the
 * created/overwrote distinction, but no oldText/diff (memory + diff cost). */
export const WRITE_CAPTURE_MAX_BYTES = 1024 * 1024;

/** NUL sniff window for the binary-old-file check (read-guards precedent). */
const BINARY_SAMPLE_BYTES = 4096;

/** Backstop against pending-capture leaks if a caller never collects. */
const MAX_PENDING_CAPTURES = 16;

/** Ceiling for the generated unified patch kept in details — a full rewrite
 * produces a patch of roughly old+new size (up to ~2 MiB under the capture
 * cap), which would bloat the message store for zero display value. */
const PATCH_MAX_CHARS = 256 * 1024;

/** Myers diff worst case (two large, unrelated bodies) is superlinear;
 * jsdiff aborts after this budget (returns undefined) and we disclose the
 * omission instead of stalling the tool-result path. Value copied from
 * reference CLI `utils/diff.ts` DIFF_TIMEOUT_MS — cc guards every
 * structuredPatch call the same way (empty-hunks fallback). */
const PATCH_TIMEOUT_MS = 5_000;

const BOM_CHAR = '﻿';

export type WriteEncoding = 'utf-8' | 'utf16le';

/** Result of one enhanced write, produced inside the mutation-queue slot. */
export interface WriteCapture {
  /** Absolute path actually handed to the injected write operation. */
  path: string;
  /** Whether the target existed before this write (ENOENT probe). */
  existed: boolean;
  /** Actual bytes written to disk (BOM and encoding included). */
  bytesWritten: number;
  /** Encoding the file was written with (= old file's encoding; utf-8 for new files). */
  encoding: WriteEncoding;
  /** Whether the bytes on disk start with a BOM. */
  bom: boolean;
  /** Previous decoded content, BOM stripped. Absent for new files and when skipped. */
  oldText?: string;
  /** Why oldText/diff were skipped for an existing file. */
  captureSkipped?: 'too_large' | 'binary';
}

/** opencode Bom.split semantics: peel a leading U+FEFF off decoded text. */
export function splitBomText(text: string): { bom: boolean; text: string } {
  if (text.charCodeAt(0) !== 0xfeff) return { bom: false, text };
  return { bom: true, text: text.slice(1) };
}

/** opencode Bom.join semantics: strip first so a BOM is never doubled. */
export function joinBomText(text: string, bom: boolean): string {
  const stripped = splitBomText(text).text;
  return bom ? BOM_CHAR + stripped : stripped;
}

/**
 * Byte-level BOM sniff. Detection is deliberately BOM-only and mirrors
 * reference CLI's `detectEncodingForResolvedPath` (fileRead.ts:34): UTF-8 BOM
 * and utf16le (FF FE) only. FE FF (utf16be) is intentionally NOT detected —
 * cc treats those as utf8 too; here BE content additionally trips the NUL
 * binary guard, so the overwrite is disclosed instead of silently diffed.
 * A UTF-16 file without a BOM is indistinguishable from binary at this
 * layer and is treated as utf-8 — identical to the status quo.
 */
export function detectEncodingFromBuffer(buf: Buffer): { encoding: WriteEncoding; bom: boolean } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf-8', bom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf16le', bom: true };
  }
  return { encoding: 'utf-8', bom: false };
}

function decodeText(buf: Buffer, encoding: WriteEncoding): string {
  // Node's utf16le decoding ignores a stray trailing byte in corrupt files;
  // no byte swapping happens anywhere in this module (cc likewise).
  const text = encoding === 'utf16le' ? buf.toString('utf16le') : buf.toString('utf-8');
  return splitBomText(text).text;
}

function encodeText(body: string, encoding: WriteEncoding, bom: boolean): Buffer {
  if (encoding === 'utf16le') {
    // A BOM is what identified the encoding in the first place; UTF-16
    // output always carries one so the file stays self-describing.
    return Buffer.from(BOM_CHAR + body, 'utf16le');
  }
  return Buffer.from(joinBomText(body, bom), 'utf-8');
}

interface OldFileProbe {
  existed: boolean;
  encoding: WriteEncoding;
  srcBom: boolean;
  /** Pre-write version of a regular file; absent for new and non-regular targets. */
  version?: FileVersion;
  oldText?: string;
  captureSkipped?: 'too_large' | 'binary';
}

type WriteCaptureFs = Pick<CoreToolFs, 'mkdir' | 'open' | 'readFile' | 'realpath' | 'stat' | 'writeFile'>;

async function probeOldFile(absolutePath: string, fs: WriteCaptureFs): Promise<OldFileProbe> {
  const fresh: OldFileProbe = { existed: false, encoding: 'utf-8', srcBom: false };
  let stats: CoreToolStats;
  try {
    stats = await fs.stat(absolutePath);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return fresh;
    throw err;
  }
  const size = stats.size;
  // The port only promises CoreToolStats; `version` is read by the guard alone,
  // and the desktop host that sets a guard stats through physical-fs.
  const version = regularFileVersion(stats as Stats);

  if (size > WRITE_CAPTURE_MAX_BYTES) {
    // Sample just enough bytes for BOM/encoding preservation; skip oldText.
    const sample = Buffer.alloc(Math.min(BINARY_SAMPLE_BYTES, size));
    const handle = await fs.open(absolutePath, 'r');
    try {
      await handle.read(sample, 0, sample.length, 0);
    } finally {
      await handle.close();
    }
    const { encoding, bom } = detectEncodingFromBuffer(sample);
    return { existed: true, encoding, srcBom: bom, version, captureSkipped: 'too_large' };
  }

  const raw = await fs.readFile(absolutePath);
  const { encoding, bom } = detectEncodingFromBuffer(raw);
  if (encoding === 'utf-8' && raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    // NULs in a non-UTF-16 file: binary — diffing it would be garbage.
    // The overwrite itself still proceeds (status-quo semantics).
    return { existed: true, encoding, srcBom: bom, version, captureSkipped: 'binary' };
  }
  return { existed: true, encoding, srcBom: bom, version, oldText: decodeText(raw, encoding) };
}

/**
 * Pre-write version for the guard. Reuses the probe's stat; when the probe
 * failed, stats again so an existing file is still checked, and lets stat
 * errors other than ENOENT refuse the write.
 */
async function guardedFileVersion(
  absolutePath: string,
  probe: OldFileProbe | undefined,
  fs: WriteCaptureFs,
): Promise<FileVersion | undefined> {
  if (probe) return probe.version;
  try {
    return regularFileVersion((await fs.stat(absolutePath)) as Stats);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Optional overwrite check. Both hooks run inside pi's mutation-queue slot,
 * so no other in-process write or edit of the same file can slip between the
 * check, the write and the refresh.
 */
export interface WriteGuard {
  /** Before any byte is written; `current` is undefined when there is no regular file. Throw to refuse. */
  beforeWrite(absolutePath: string, current: FileVersion | undefined): Promise<void>;
  /** After the bytes are on disk. */
  afterWrite(absolutePath: string): Promise<void>;
}

type WriteCaptureOptions = (WriteCaptureFs & { guard?: WriteGuard }) | { guard?: WriteGuard };

/**
 * Build the `WriteOperations` to inject into pi's `createWriteTool`, plus
 * the collector the wrapper calls after `tool.execute` settles.
 *
 * Lifecycle: the desktop/cloud wrappers construct one of these PER `execute`
 * (not once per tool instance), so a given collector only ever sees the single
 * write of that call. That isolation matters because the wrappers are
 * process-level singletons shared across concurrent agents — an instance-level
 * pending map would let two same-path writes clobber each other's capture.
 *
 * Handoff contract: captures are keyed by the absolutePath pi hands to
 * `writeFile` (its `resolveToCwd` output). The wrapper's hint is computed
 * independently, so `takeCapture` matches exactly first, then falls back to
 * the single pending entry (with per-execute construction there is exactly one
 * in-flight write, so this only bridges a hint/normalization mismatch), and
 * abstains when several entries are pending — the caller then degrades to pi's
 * own result text rather than risking a cross-file mixup.
 *
 * `guard` is desktop-only; without it (cloud) the write path is unchanged.
 * Core tools pass their host fs port, on which the desktop host also carries
 * `guard`; without a port the physical filesystem is used.
 */
export function createCapturingWriteOperations(options: WriteCaptureOptions = {}): {
  operations: WriteOperations;
  takeCapture(absoluteHint: string): WriteCapture | undefined;
} {
  const { guard } = options;
  const fs = 'writeFile' in options ? options : physicalToolFs;
  const captures = new Map<string, WriteCapture>();

  const operations: WriteOperations = {
    realpath: (path) => fs.realpath(path),
    mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {}),
    async writeFile(absolutePath, content) {
      let probe: OldFileProbe | undefined;
      try {
        probe = await probeOldFile(absolutePath, fs);
      } catch {
        // Capture is an enhancement, never a gate: if the old file cannot
        // be probed (permissions, exotic FS), fall through to a plain
        // utf-8 write and record nothing — the wrapper degrades to pi's
        // own result text.
        probe = undefined;
      }
      if (guard) {
        await guard.beforeWrite(absolutePath, await guardedFileVersion(absolutePath, probe, fs));
      }

      const { bom: nextBom, text: body } = splitBomText(content);
      const encoding = probe?.encoding ?? 'utf-8';
      const bom = (probe?.srcBom ?? false) || nextBom;
      const buffer = encodeText(body, encoding, bom);
      await fs.writeFile(absolutePath, buffer);
      if (guard) await guard.afterWrite(absolutePath);

      if (!probe) return;
      if (captures.size >= MAX_PENDING_CAPTURES) {
        const oldest = captures.keys().next().value;
        if (oldest !== undefined) captures.delete(oldest);
      }
      captures.set(absolutePath, {
        path: absolutePath,
        existed: probe.existed,
        bytesWritten: buffer.byteLength,
        encoding,
        bom,
        ...(probe.oldText !== undefined ? { oldText: probe.oldText } : {}),
        ...(probe.captureSkipped ? { captureSkipped: probe.captureSkipped } : {}),
      });
    },
  };

  return {
    operations,
    takeCapture(absoluteHint: string): WriteCapture | undefined {
      const exact = captures.get(absoluteHint);
      if (exact) {
        captures.delete(absoluteHint);
        return exact;
      }
      if (captures.size === 1) {
        const [key, capture] = captures.entries().next().value as [string, WriteCapture];
        captures.delete(key);
        return capture;
      }
      return undefined;
    },
  };
}

/**
 * Strip the indentation common to every +/-/context line of a unified diff.
 * Ported from opencode `tool/edit.ts` trimDiff (source attribution — keep
 * behavior aligned when syncing).
 */
export function trimDiff(diff: string): string {
  const lines = diff.split('\n');
  const isContent = (line: string) =>
    (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) &&
    !line.startsWith('---') &&
    !line.startsWith('+++');
  const contentLines = lines.filter(isContent);
  if (contentLines.length === 0) return diff;

  let min = Infinity;
  for (const line of contentLines) {
    const content = line.slice(1);
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/);
      if (match?.[1] !== undefined) min = Math.min(min, match[1].length);
    }
  }
  if (min === Infinity || min === 0) return diff;
  return lines
    .map((line) => (isContent(line) ? line[0] + line.slice(1).slice(min) : line))
    .join('\n');
}

/** Why the unified patch was left out of details for an overwrite. */
export type PatchOmittedReason = 'too_large' | 'timeout';

/**
 * Compute the details payload for an overwrite diff: ONE structuredPatch run
 * (time-budgeted) feeds both the unified patch text (via formatPatch — the
 * same rendering createTwoFilesPatch uses internally) and firstChangedLine.
 */
function computeWritePatch(
  oldText: string,
  body: string,
  path: string,
): {
  patch?: string;
  firstChangedLine?: number;
  patchOmitted?: PatchOmittedReason;
  structuredPatch?: ReadonlyArray<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
} {
  if (body.length > WRITE_CAPTURE_MAX_BYTES) {
    // Symmetric with the old-side capture cap: diffing an oversized new
    // body costs CPU and would exceed the patch ceiling anyway.
    return { patchOmitted: 'too_large' };
  }
  const structured = structuredPatch(path, path, oldText, body, undefined, undefined, {
    timeout: PATCH_TIMEOUT_MS,
  });
  if (structured === undefined) return { patchOmitted: 'timeout' };

  const patch = trimDiff(formatPatch(structured));
  if (patch.length > PATCH_MAX_CHARS) return { patchOmitted: 'too_large' };

  const result: {
    patch: string;
    firstChangedLine?: number;
    structuredPatch: ReadonlyArray<{
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      lines: string[];
    }>;
  } = { patch, structuredPatch: structured.hunks };
  const hunk = structured.hunks[0];
  if (hunk) {
    let newLine = hunk.newStart;
    let found: number | undefined;
    for (const line of hunk.lines) {
      const marker = line[0];
      if (marker === '+' || marker === '-') {
        found = newLine;
        break;
      }
      if (marker === ' ') newLine++;
    }
    result.firstChangedLine = found ?? hunk.newStart;
  }
  return result;
}

/**
 * Assemble the final ToolResult from the model input and the capture.
 * `piFallbackText` is pi's own result text — used verbatim when the capture
 * is missing (degraded path), so the tool never gets worse than status quo.
 */
export function buildWriteToolResult(
  toolName: string,
  inputPath: string,
  newContent: string,
  capture: WriteCapture | undefined,
  piFallbackText: string,
): ToolResult {
  if (!capture) {
    return {
      tool_name: toolName,
      text: piFallbackText,
      content: [{ type: 'text', text: piFallbackText }],
      details: {},
    };
  }

  const suffix = capture.existed ? ' (overwrote existing file)' : '';
  const text = `Successfully wrote ${capture.bytesWritten} bytes to ${inputPath}${suffix}`;
  const details: Record<string, unknown> = {
    created: !capture.existed,
    bytes_written: capture.bytesWritten,
    encoding: capture.encoding,
    bom: capture.bom,
  };
  if (capture.captureSkipped) details.capture_skipped = capture.captureSkipped;
  const body = splitBomText(newContent).text;
  const originalFile = capture.existed ? capture.oldText : null;
  const diff =
    originalFile !== undefined ? computeWritePatch(originalFile ?? '', body, inputPath) : undefined;
  if (capture.existed && diff) {
    if (diff.patch !== undefined) details.patch = diff.patch;
    if (diff.firstChangedLine !== undefined) details.firstChangedLine = diff.firstChangedLine;
    if (diff.patchOmitted) details.patch_omitted = diff.patchOmitted;
  }

  const result: ToolResult = {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    details,
  };
  if (originalFile === undefined || !diff?.structuredPatch) return result;
  return withPluginHookCompatibleToolResponse(result, {
    type: capture.existed ? 'update' : 'create',
    filePath: capture.path,
    content: body,
    structuredPatch: diff.structuredPatch,
    originalFile,
  });
}
