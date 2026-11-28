export const COMPOSER_COPY = {
  imagePreviewLoading: 'Loading preview…',
  imagePreviewUnavailable: 'Preview unavailable · attachment is still ready to send',
  imagePreviewTextOnly: 'Image preview is not supported by this terminal',
  imagePreviewHint: 'Esc dismiss · Enter send',
  pastedTextPreviewLines: '{count} lines',
  pastedTextPreviewHint: 'Sent as a text file · Backspace remove · Esc dismiss',
  placeholder: 'Ask Mcode to do anything',
  draftSaveFailed: "Couldn't save draft recovery.",
  draftCleanupFailed: "Couldn't clean up draft recovery.",
  draftMigrationFailed: "Couldn't move draft recovery to this session.",
  draftRestoreFailed: "Couldn't read draft recovery.",
  draftRecoveryUnavailable:
    'You can continue using MCode. Unsent input may not be recoverable after restarting.',
  draftCleanupNextStep: 'An older draft or attachment backup may remain on disk.',
} as const;

export type ComposerCopyKey = keyof typeof COMPOSER_COPY;
