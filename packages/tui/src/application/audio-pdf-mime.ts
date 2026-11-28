import { extname } from 'node:path';

/**
 * Audio and PDF files the TUI attaches as media. The Runtime sends them inline
 * only to a model that reads them natively (Gemini); for any other model they
 * stay ordinary file attachments.
 */
const AUDIO_PDF_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.pdf': 'application/pdf',
  '.wav': 'audio/wav',
};

export function inferTuiAudioPdfMimeType(fileName: string): string | undefined {
  return AUDIO_PDF_MIME_BY_EXTENSION[extname(fileName).toLowerCase()];
}

export function isTuiAudioFile(fileName: string): boolean {
  return inferTuiAudioPdfMimeType(fileName)?.startsWith('audio/') === true;
}
