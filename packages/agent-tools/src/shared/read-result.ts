/**
 * read-result.ts — single conversion point from a pi `AgentToolResult` to
 * the MiniMax `ToolResult` for the `read` tool, plus the shared error-result
 * helper used by the wrapper-level guards.
 *
 * Why (design: `.harness/docs/design/tools-optimize/read-tool-optimization.md`
 * §2.6): desktop's `toToolResult` and cloud's hand-rolled text join were two
 * copies of the same conversion. With line-number postprocessing (①⑤) the
 * output format must have exactly one source of truth — otherwise desktop
 * and cloud drift and every format change breaks assertions in two places.
 */

import { findDegenerateImageReason } from '@mavis/agent-core/pi-turn-runner';
import type { ToolResult, ToolResultContent } from '@mavis/agent-core/tools';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';

import {
  compatibleReadToolResponseFromPiDetails,
  withPluginHookCompatibleToolResponse,
} from '../plugin-hooks/vendor-tool-response.js';
import { postprocessPiReadText } from './read-postprocess.js';

/**
 * Uniform recoverable error for wrapper-level read guards (device / binary /
 * PDF / notebook failures). `isError: true` flows through
 * pi-turn-runner/tools.ts `details.is_error` back to the pi agent loop, so
 * the model sees a tool error it can react to — same channel LocalBashTool
 * already uses. We deliberately do not throw: a thrown error reaches the
 * model via pi's generic catch with no structured details attached.
 */
export function readErrorResult(toolName: string, message: string): ToolResult {
  return {
    tool_name: toolName,
    text: message,
    content: [{ type: 'text', text: message }],
    details: {},
    isError: true,
  };
}

/**
 * Convert a pi read result into a MiniMax ToolResult, applying the ①⑤ text
 * postprocessing (line numbers + long-line truncation + empty-file
 * reminder).
 *
 * Postprocessing is skipped when the result is not plain file text:
 * - any non-text content block (pi image path — its text is a caption like
 *   `Read image file [image/png]`, not file content);
 * - `details.media` (video results built by read-video.ts);
 * - `details.truncation.firstLineExceedsLimit` (the whole text is pi's
 *   bash-fallback notice, not file content).
 *
 * An image the model provider would reject is refused here (see
 * `refuseDegenerateImages`), which also sets `details.media`.
 */
export function piReadResultToToolResult(
  toolName: string,
  res: AgentToolResult<Record<string, unknown>>,
  opts: { offset?: number; maxLineChars?: number } = {},
): ToolResult {
  const refused = refuseDegenerateImages(res.content as ToolResultContent[]);
  const content = refused.content;
  const details = { ...((res.details ?? {}) as Record<string, unknown>) };
  if (refused.media) details.media = refused.media;

  const hasNonTextContent = content.some((c) => c.type !== 'text');
  const truncation = details.truncation as { firstLineExceedsLimit?: boolean } | undefined;
  const skipPostprocess =
    hasNonTextContent || details.media !== undefined || truncation?.firstLineExceedsLimit === true;

  let outContent: ToolResultContent[];
  if (skipPostprocess) {
    outContent = content;
  } else {
    const truncatedLines: number[] = [];
    outContent = content.map((c) => {
      if (c.type !== 'text') return c;
      const processed = postprocessPiReadText(c.text, opts);
      truncatedLines.push(...processed.truncatedLines);
      return { ...c, text: processed.text };
    });
    if (truncatedLines.length > 0) {
      // Kimi-style disclosure: the model must know these lines are longer
      // than displayed before it copies one into edit.oldText.
      details.line_truncations = truncatedLines;
      const note = `\n\n[Lines [${truncatedLines.join(', ')}] were truncated to 2000 chars.]`;
      const lastText = [...outContent].reverse().find((c) => c.type === 'text');
      if (lastText && lastText.type === 'text') {
        lastText.text += note;
      }
    }
  }

  const result: ToolResult = {
    tool_name: toolName,
    text: outContent
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n'),
    content: outContent,
    details,
    ...(res.terminate !== undefined ? { terminate: res.terminate } : {}),
  };
  const compatibleResponse = compatibleReadToolResponseFromPiDetails(res.details);
  return compatibleResponse
    ? withPluginHookCompatibleToolResponse(result, compatibleResponse)
    : result;
}

/**
 * Pi reads an image file as it is (autoResizeImages is off). One the model
 * provider would reject for its size, an edge below 8 px or an aspect ratio
 * above 200:1 (see `findDegenerateImageReason`), becomes a text note, for
 * every model alike: in history it would only be replaced by a placeholder on
 * every later request. Like a broken video (read-video.ts) this is not a tool
 * error, and `details.media` says the image was not loaded.
 */
function refuseDegenerateImages(content: readonly ToolResultContent[]): {
  readonly content: ToolResultContent[];
  readonly media?: Record<string, unknown>;
} {
  let media: Record<string, unknown> | undefined;
  const checked = content.map((block): ToolResultContent => {
    if (block.type !== 'image' || !block.mimeType.startsWith('image/')) return block;
    const reason = findDegenerateImageReason(block.data, block.mimeType);
    if (reason === undefined) return block;
    media = {
      kind: 'image',
      mime_type: block.mimeType,
      size_bytes: Buffer.byteLength(block.data, 'base64'),
      inline: false,
      reason: 'degenerate_image',
    };
    return { type: 'text', text: `[Image not loaded: ${reason}.]` };
  });
  return media ? { content: checked, media } : { content: [...content] };
}
