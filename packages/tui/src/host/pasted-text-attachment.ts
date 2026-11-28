import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TuiPastedTextSummary } from '../types/invocation.js';
import type { TuiClipboardImageLease } from './clipboard-image.js';

export const TUI_PASTED_TEXT_FILE_NAME = 'pasted-text.txt';

/**
 * Saves a long paste as a private temporary text file. The directory uses the clipboard
 * media prefix so queueing and draft recovery copy it like a clipboard image.
 */
export async function createTuiPastedTextLease(
  text: string,
  options: { readonly tempRoot?: string } = {},
): Promise<TuiClipboardImageLease> {
  const directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'minimax-code-clipboard-'));
  const filePath = join(directory, TUI_PASTED_TEXT_FILE_NAME);
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await rm(directory, { force: true, recursive: true });
  };
  try {
    await writeFile(filePath, text, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
  return {
    attachment: {
      type: 'file',
      filePath,
      fileName: TUI_PASTED_TEXT_FILE_NAME,
      mimeType: 'text/plain',
      sizeBytes: Buffer.byteLength(text, 'utf8'),
      pastedText: summarizeTuiPastedText(text),
    },
    dispose,
  };
}

export function summarizeTuiPastedText(text: string): TuiPastedTextSummary {
  return { lineCount: text.split('\n').length, charCount: text.length };
}
