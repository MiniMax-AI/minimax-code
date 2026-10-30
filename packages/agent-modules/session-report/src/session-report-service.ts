import type { Dirent } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type {
  ReportLocations,
  ReportSession,
  ReportSessions,
  SessionReportArtifact,
  SessionReportCapability,
  SessionReportManifest,
} from './contracts.js';

export interface SessionReportServiceOptions {
  readonly sessions: ReportSessions;
  readonly locations: ReportLocations;
}

interface LocatedSession {
  readonly session: ReportSession;
  readonly sessionDir: string;
}

interface SkippedArtifact {
  readonly name: string;
  readonly reason: string;
}

type ReportFailure = (name: string, error: unknown) => void;

const REWIND_STAGING_PREFIX = '.history-mutation-';
const LLM_CALL_REPORT_TEMP_PREFIX = '.llm-call-report-';
const IGNORED_FILE_NAMES = new Set(['.DS_Store']);
const IGNORED_DIRECTORY_NAMES = new Set(['llm-call', 'llm-context-inspector']);
// Publication intermediates owned by jsonl/materializer/tool-output writers and
// session-history-paths, plus leftovers (including rollback) of the removed
// canonical history index that older session directories may still contain.
const ATOMIC_PUBLICATION_TEMP_FILES = [
  /\.\d+[.-][0-9a-f-]{36}\.tmp$/u,
  /^(?:history-catalog\.json|user-message-locators\.jsonl)\.\d+\.\d+\.[0-9a-f]*\.(?:tmp|restore)$/u,
  /^manifest\.json\.\d+\.tmp$/u,
];

/** Collects readable artifacts independently; diagnostics must survive partial history loss. */
export class SessionReportService implements SessionReportCapability {
  constructor(private readonly options: SessionReportServiceOptions) {}

  async collect(sessionId: string): Promise<SessionReportManifest> {
    if (!sessionId.trim()) throw new Error('session_report_session_id_required');
    const skipped: SkippedArtifact[] = [];
    const reportFailure: ReportFailure = (name, error) => {
      const code = typeof error === 'object' && error !== null && Reflect.get(error, 'code');
      skipped.push({ name, reason: typeof code === 'string' ? code : String(error) });
    };
    const sessions = await this.collectSubtree(sessionId, reportFailure);
    const artifacts: SessionReportArtifact[] = [];

    for (const located of sessions) {
      try {
        artifacts.push(...(await collectSessionFiles(located, reportFailure)));
      } catch (error) {
        reportFailure(archiveSessionPrefix(located.session.sessionId), error);
      }

      if (located.session.sessionKind === 'task') {
        try {
          const binding = await this.options.sessions.getTaskAgentBinding(
            located.session.sessionId,
          );
          if (!binding) {
            throw new Error(`session_report_task_binding_missing:${located.session.sessionId}`);
          }
          const content = `${JSON.stringify(binding.definition, null, 2)}\n`;
          artifacts.push({
            name: `${archiveSessionPrefix(located.session.sessionId)}/task-agent-definition.json`,
            content,
            bytes: Buffer.byteLength(content, 'utf8'),
            required: true,
          });
        } catch (error) {
          reportFailure(
            `${archiveSessionPrefix(located.session.sessionId)}/task-agent-definition.json`,
            error,
          );
        }
      }
    }

    const unique = new Map<string, SessionReportArtifact>();
    for (const artifact of artifacts) {
      if (unique.has(artifact.name)) reportFailure(artifact.name, 'duplicate_artifact');
      else unique.set(artifact.name, artifact);
    }
    if (skipped.length > 0) {
      const content = `${JSON.stringify({ schemaVersion: 1, skipped }, null, 2)}\n`;
      unique.set('session-report-collection.json', {
        name: 'session-report-collection.json',
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
        required: true,
      });
    }
    return {
      schemaVersion: 1,
      rootSessionId: sessionId,
      sessionIds: sessions.map(({ session }) => session.sessionId),
      artifacts: [...unique.values()].sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  private async collectSubtree(
    rootSessionId: string,
    reportFailure: ReportFailure,
  ): Promise<LocatedSession[]> {
    const located: LocatedSession[] = [];
    const pending = [rootSessionId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const currentSessionId = pending.shift();
      if (!currentSessionId || visited.has(currentSessionId)) continue;
      visited.add(currentSessionId);
      try {
        const resolved = await this.options.locations.inspectSession(currentSessionId);
        if (!resolved) throw new Error(`session_report_session_missing:${currentSessionId}`);
        located.push({ session: resolved.session, sessionDir: resolved.paths.sessionDir });
      } catch (error) {
        reportFailure(archiveSessionPrefix(currentSessionId), error);
      }
      // A missing parent directory/identity must not hide discoverable descendants.
      try {
        const children = await this.options.sessions.listChildren(currentSessionId);
        for (const child of children) {
          if (!visited.has(child.sessionId)) pending.push(child.sessionId);
        }
      } catch (error) {
        reportFailure(`${archiveSessionPrefix(currentSessionId)}/children`, error);
      }
    }
    return located;
  }
}

async function collectSessionFiles(
  input: LocatedSession,
  reportFailure: ReportFailure,
): Promise<SessionReportArtifact[]> {
  await requireDirectory(input.sessionDir, input.session.sessionId);
  const root = await realpath(input.sessionDir);
  const entries: SessionReportArtifact[] = [];
  await visit('');
  if (
    !entries.some(
      (entry) => entry.name === `${archiveSessionPrefix(input.session.sessionId)}/manifest.json`,
    )
  ) {
    reportFailure(
      `${archiveSessionPrefix(input.session.sessionId)}/manifest.json`,
      'manifest_missing',
    );
  }
  return entries;

  async function visit(relativeDirectory: string): Promise<void> {
    const directory = resolve(root, relativeDirectory);
    let children: Dirent[];
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      reportFailure(`${archiveSessionPrefix(input.session.sessionId)}/${relativeDirectory}`, error);
      return;
    }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (ignoredSessionEntry(child)) continue;
      const relativeName = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const path = resolve(root, relativeName);
      try {
        if (child.isSymbolicLink()) {
          throw new Error(
            `session_report_unsafe_symlink:${input.session.sessionId}:${relativeName}`,
          );
        }
        if (child.isDirectory()) {
          await visit(relativeName);
          continue;
        }
        if (!child.isFile()) continue;
        if (isLlmCallReportFile(relativeName)) {
          entries.push(await collectLlmCallReportArtifact(input, root, path, relativeName));
          continue;
        }
        const info = await lstat(path);
        const resolvedPath = await realpath(path);
        if (!pathInside(root, resolvedPath)) {
          throw new Error(`session_report_path_escape:${input.session.sessionId}:${relativeName}`);
        }
        entries.push({
          name: `${archiveSessionPrefix(input.session.sessionId)}/${relativeName}`,
          path,
          bytes: info.size,
          required: true,
        });
      } catch (error) {
        reportFailure(`${archiveSessionPrefix(input.session.sessionId)}/${relativeName}`, error);
      }
    }
  }
}

async function collectLlmCallReportArtifact(
  input: LocatedSession,
  root: string,
  path: string,
  relativeName: string,
): Promise<SessionReportArtifact> {
  const info = await lstat(path);
  const resolvedPath = await realpath(path);
  if (!info.isFile() || !pathInside(root, resolvedPath)) {
    throw new Error(`session_report_path_escape:${input.session.sessionId}:${relativeName}`);
  }
  const content = await readFile(path, 'utf8');
  return {
    name: `${archiveSessionPrefix(input.session.sessionId)}/${relativeName}`,
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    required: true,
  };
}

function ignoredSessionEntry(entry: Dirent): boolean {
  if (IGNORED_FILE_NAMES.has(entry.name)) return true;
  if (entry.name.startsWith(LLM_CALL_REPORT_TEMP_PREFIX)) return true;
  if (entry.isFile() && ATOMIC_PUBLICATION_TEMP_FILES.some((pattern) => pattern.test(entry.name))) {
    return true;
  }
  return (
    entry.isDirectory() &&
    (IGNORED_DIRECTORY_NAMES.has(entry.name) || entry.name.startsWith(REWIND_STAGING_PREFIX))
  );
}

function isLlmCallReportFile(relativeName: string): boolean {
  return (
    relativeName === 'llm-call.json' ||
    /^snapshots\/env-g\d{12}--[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(relativeName)
  );
}

async function requireDirectory(path: string, sessionId: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isDirectory() && !info.isSymbolicLink()) return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  throw new Error(`session_report_history_missing:${sessionId}`);
}

function archiveSessionPrefix(sessionId: string): string {
  return `session/${encodeURIComponent(sessionId)}`;
}

function pathInside(root: string, child: string): boolean {
  const value = relative(root, child);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}
