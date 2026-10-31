/**
 * run_code return values larger than the outer result (64 KiB,
 * PTC_LIMITS.maxOuterResultBytes) keep their beginning in the result and are
 * saved whole as a Session tool-output artifact, so the model can read the
 * rest instead of rerunning the program (its children already ran and may
 * have written). Child results are not cut to the model caps (agent-tools
 * isPtcChildCall), so the return value is the one place left that is cut.
 *
 * The artifact goes where the tool output budget puts externalized results:
 * the Session's reports/tool-outputs directory, written by the same
 * ToolOutputArtifactRepository (turn-system/persistence). That directory is a
 * Session read grant (runner/policy/session-readable-grants.ts, kind
 * 'tool-outputs'), so reading it back needs no extra approval, and it is
 * removed with the Session. No platform I/O here: production composition
 * passes the writer down to run_code (PtcRunCodeToolOptions.writeReturnArtifact).
 */

/** Same fields as ToolOutputArtifactRepository.write takes and returns. */
export type PtcReturnArtifactWriter = (input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly text: string;
  readonly originalBytes: number;
  readonly sensitive: boolean;
}) => Promise<{
  readonly reference: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}>;

export type PtcReturnSpill =
  | {
      readonly path: string;
      /** The repository stored chunked JSONL because a line exceeds the read line cap. */
      readonly chunked: boolean;
    }
  | { readonly error: string };

/**
 * Saves the whole return value. The return JSON is a single line; it is
 * written indented so the read tool, which pages by lines, can continue it
 * with offset. A write failure is reported, never thrown: the truncated
 * result is still delivered.
 */
export async function spillPtcReturnValue(
  call: { readonly sessionId: string; readonly turnId: string; readonly toolCallId?: string },
  valueJson: string,
  write: PtcReturnArtifactWriter,
): Promise<PtcReturnSpill> {
  let text = valueJson;
  try {
    text = JSON.stringify(JSON.parse(valueJson), null, 2);
  } catch {
    // Not parseable here: save the exact text instead.
  }
  try {
    const artifact = await write({
      sessionId: call.sessionId,
      turnId: call.turnId,
      toolCallId: call.toolCallId ?? 'unknown',
      toolName: 'run_code',
      text,
      originalBytes: new TextEncoder().encode(text).byteLength,
      sensitive: false,
    });
    return {
      path: artifact.reference,
      chunked: artifact.metadata?.read_format === 'chunked_jsonl_v1',
    };
  } catch (error) {
    const code = (error as { readonly code?: unknown } | undefined)?.code;
    return { error: typeof code === 'string' ? code : 'write_failed' };
  }
}

/** Note after a shortened return value; says where the rest is, or that it is unavailable. */
export function ptcReturnTruncationNotice(
  shownBytes: number,
  totalBytes: number,
  spill: PtcReturnSpill | undefined,
): string {
  const head = `[run_code result truncated: showing ${shownBytes} of ${totalBytes} bytes.`;
  if (spill && 'path' in spill) {
    // Same wording as the tool output budget's receipt for a chunked artifact.
    const chunked = spill.chunked
      ? " Artifact format: chunked JSONL; concatenate each chunk row's text field in index order."
      : '';
    return `${head} The full return value is saved as indented JSON at ${spill.path}; read it with the read tool and continue with offset, or return a smaller value.${chunked}]`;
  }
  const lost = spill
    ? ` The full return value could not be saved (${spill.error}) and is unavailable.`
    : '';
  return `${head} Return a smaller value or aggregate inside the code.${lost}]`;
}
