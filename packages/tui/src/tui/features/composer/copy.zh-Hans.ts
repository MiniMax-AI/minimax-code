import type { ComposerCopyKey } from './copy.en.js';

export const ZH_HANS_COMPOSER_COPY = {
  imagePreviewLoading: '正在加载预览…',
  imagePreviewUnavailable: '无法预览 · 附件仍可发送',
  imagePreviewTextOnly: '当前终端不支持显示图片预览',
  imagePreviewHint: 'Esc 收起 · Enter 发送',
  pastedTextPreviewLines: '{count} 行',
  pastedTextPreviewHint: '作为文本文件发送 · Backspace 删除 · Esc 收起',
  placeholder: 'Ask Mcode to do anything',
  draftSaveFailed: '无法保存草稿恢复备份。',
  draftCleanupFailed: '无法清理草稿恢复备份。',
  draftMigrationFailed: '无法将草稿恢复备份迁移到当前会话。',
  draftRestoreFailed: '无法读取草稿恢复备份。',
  draftRecoveryUnavailable: '可继续正常使用 MCode，重启后可能无法恢复未发送内容。',
  draftCleanupNextStep: '磁盘上可能仍保留旧草稿或附件备份。',
} as const satisfies Readonly<Record<ComposerCopyKey, string>>;
