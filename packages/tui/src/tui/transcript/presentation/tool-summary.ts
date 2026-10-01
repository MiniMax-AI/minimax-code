import { sanitizeTerminalText } from '../../rendering/terminal-text.js';

const SUMMARY_KEYS = [
  'path',
  'filePath',
  'file_path',
  'command',
  'query',
  'pattern',
  'url',
  'description',
] as const;

const METADATA_KEYS = ['target', 'operation', 'action', 'name'] as const;

export function formatTuiToolSummary(value: string): string {
  const sanitized = sanitizeTerminalText(value).trim();
  if (!sanitized) return '';
  try {
    const parsed = JSON.parse(sanitized) as unknown;
    if (typeof parsed === 'string') return firstLine(parsed);
    if (isRecord(parsed)) {
      const agentName = parsed.agent_name;
      const description = parsed.description;
      if (
        typeof agentName === 'string' &&
        agentName.trim() &&
        typeof description === 'string' &&
        description.trim()
      ) {
        return `${firstLine(agentName)} · ${firstLine(description)}`;
      }
      const scope = [parsed.path, parsed.filePath, parsed.file_path, parsed.cwd].find(
        (candidate): candidate is string =>
          typeof candidate === 'string' && Boolean(candidate.trim()),
      );
      const query = [parsed.query, parsed.pattern].find(
        (candidate): candidate is string =>
          typeof candidate === 'string' && Boolean(candidate.trim()),
      );
      if (typeof parsed.command === 'string' && parsed.command.trim()) {
        if (typeof description === 'string' && description.trim()) return firstLine(description);
        const command = firstLine(parsed.command);
        return scope ? `${command} · in ${firstLine(scope)}` : command;
      }
      if (query) return scope ? `${firstLine(query)} in ${firstLine(scope)}` : firstLine(query);
      for (const key of SUMMARY_KEYS) {
        const candidate = parsed[key];
        if (typeof candidate === 'string' && candidate.trim()) {
          return firstLine(candidate);
        }
        if (
          Array.isArray(candidate) &&
          candidate.length > 0 &&
          candidate.every((item) => typeof item === 'string')
        ) {
          return candidate.map(firstLine).filter(Boolean).join(' ');
        }
      }
      const metadata = METADATA_KEYS.flatMap((key) => {
        const candidate = parsed[key];
        return typeof candidate === 'string' && candidate.trim() ? [firstLine(candidate)] : [];
      });
      return metadata.slice(0, 2).join(' · ');
    }
    if (Array.isArray(parsed)) return `${parsed.length} item${parsed.length === 1 ? '' : 's'}`;
  } catch {
    return firstLine(sanitized);
  }
  return '';
}

function firstLine(value: string): string {
  return (
    sanitizeTerminalText(value)
      .split(/\r\n?|\n/u, 1)[0]
      ?.trim() ?? ''
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
