/**
 * Maximum number of attachments in one TUI, `mcode exec` or ACP prompt. Keep in
 * sync with `MAX_ATTACHMENT_COUNT` in `packages/ui/src/const/input.ts`, which the
 * Desktop and Web composers share; this package does not depend on `@mavis/ui`.
 */
export const MINIMAX_CODE_MAX_ATTACHMENT_COUNT = 20;
export const MINIMAX_CODE_MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024;
/**
 * A paste of at least this many characters becomes a `pasted-text.txt` attachment instead
 * of message text. Keep in sync with `PASTED_TEXT_ATTACHMENT_THRESHOLD` in
 * `packages/ui/src/const/input.ts`.
 */
export const MINIMAX_CODE_PASTED_TEXT_ATTACHMENT_THRESHOLD = 5_000;

export type TuiAttachmentLimitViolation = 'count' | 'total-bytes';

export function findTuiAttachmentLimitViolation(
  attachments: readonly { readonly sizeBytes: number }[],
): TuiAttachmentLimitViolation | undefined {
  if (attachments.length > MINIMAX_CODE_MAX_ATTACHMENT_COUNT) return 'count';
  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  return totalBytes > MINIMAX_CODE_MAX_TOTAL_ATTACHMENT_BYTES ? 'total-bytes' : undefined;
}
