import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  LOCAL_MEMORY_TOPIC_NAME_RE,
  LocalMemoryError,
  type LocalMemoryArchiveEntry,
  type LocalMemoryConfig,
  type LocalMemoryDailyEntry,
  type LocalMemoryLocation,
  type LocalMemoryReadResult,
  type LocalMemorySearchResult,
  type LocalMemoryTarget,
  type LocalMemoryTopicEntry,
  type LocalMemoryUnremindedEntry,
} from './types.js';
import {
  appendWithSeparator,
  applyEdit,
  assertDate,
  assertSafeAgentName,
  byteLength,
  deleteIfExists,
  firstLine,
  formatTs,
  formatTopic,
  parseTopic,
  safeRead,
  safeReaddir,
  searchLines,
  today,
} from './local-memory-store-utils.js';
import { FsLocalMemoryTracking } from './local-memory-tracking.js';
import { ensureEmptyMainFile, readMainFile } from './local-memory-main-file.js';

const MAIN_MEMORY_FILE = 'MEMORY.md';
const USER_MEMORY_FILE = 'user.md';
const LEGACY_USER_MEMORY_FILE = 'MEMORY.md';
const SUMMARY_FILE = '.summary.md';

export class FsLocalMemoryStore {
  private readonly writeQueues = new Map<string, Promise<unknown>>();
  private readonly tracking: FsLocalMemoryTracking;

  constructor(
    private readonly config: () => LocalMemoryConfig,
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.tracking = new FsLocalMemoryTracking(config, this.nowMs);
  }

  resolve(target: LocalMemoryTarget): LocalMemoryLocation {
    const dataDir = this.config().dataDir;
    if (target.scope === 'user') {
      const memoryDir = join(dataDir, 'memory');
      return { scope: 'user', memoryDir, mainPath: join(memoryDir, USER_MEMORY_FILE) };
    }
    const agentName = assertSafeAgentName(target.agentName);
    const memoryDir = join(dataDir, 'agents', agentName, 'memory');
    return {
      scope: 'agent',
      agentName,
      memoryDir,
      mainPath: join(memoryDir, MAIN_MEMORY_FILE),
    };
  }

  async readMain(target: LocalMemoryTarget): Promise<LocalMemoryReadResult> {
    const location = this.resolve(target);
    const readablePath = await this.migrateLegacyUserMemory(location);
    return readMainFile(
      this.config().dataDir,
      readablePath === location.mainPath ? location : { ...location, mainPath: readablePath },
    );
  }

  async writeMain(target: LocalMemoryTarget, content: string): Promise<LocalMemoryReadResult> {
    this.assertWritable();
    return this.writeMainContent(target, content);
  }

  async writeMainForManagement(
    target: LocalMemoryTarget,
    content: string,
  ): Promise<LocalMemoryReadResult> {
    return this.writeMainContent(target, content);
  }

  private async writeMainContent(
    target: LocalMemoryTarget,
    content: string,
  ): Promise<LocalMemoryReadResult> {
    const location = this.resolve(target);
    await this.migrateLegacyUserMemory(location);
    await this.atomicWrite(location.mainPath, content);
    return this.readFileResult(location.mainPath);
  }

  async appendMain(target: LocalMemoryTarget, content: string): Promise<LocalMemoryReadResult> {
    const location = this.resolve(target);
    const filePath = await this.migrateLegacyUserMemory(location);
    const activeLocation =
      filePath === location.mainPath ? location : { ...location, mainPath: filePath };
    if (content === '') {
      return this.withFileQueue(filePath, async () => {
        this.assertWritable();
        return ensureEmptyMainFile(this.config().dataDir, activeLocation);
      });
    }
    return this.withFileQueue(filePath, async () => {
      const current = await safeRead(filePath);
      this.assertWritable();
      await this.writeFileAtomic(location.mainPath, appendWithSeparator(current, content));
      return this.readFileResult(location.mainPath);
    });
  }

  async editMain(
    target: LocalMemoryTarget,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Promise<{ replacements: number; result: LocalMemoryReadResult }> {
    const location = this.resolve(target);
    const filePath = await this.migrateLegacyUserMemory(location);
    return this.withFileQueue(filePath, async () => {
      const current = await safeRead(filePath);
      const { content, replacements } = applyEdit(current, oldString, newString, replaceAll);
      this.assertWritable();
      await this.writeFileAtomic(location.mainPath, content);
      return { replacements, result: await this.readFileResult(location.mainPath) };
    });
  }

  async searchMain(target: LocalMemoryTarget, query: string): Promise<LocalMemorySearchResult[]> {
    const current = await this.readMain(target);
    return searchLines(current.content, query);
  }

  async listTopics(target: LocalMemoryTarget): Promise<LocalMemoryTopicEntry[]> {
    const location = this.requireAgentLocation(target);
    const topicDir = join(location.memoryDir, 'topics');
    const entries = await safeReaddir(topicDir);
    const topics: LocalMemoryTopicEntry[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const name = entry.slice(0, -3);
      if (!LOCAL_MEMORY_TOPIC_NAME_RE.test(name)) continue;
      const filePath = join(topicDir, entry);
      const parsed = parseTopic(await safeRead(filePath));
      const fileStat = await stat(filePath).catch(() => undefined);
      topics.push({
        name,
        description: parsed.description,
        sizeBytes: byteLength(parsed.body),
        updatedAt: formatTs(fileStat?.mtimeMs ?? this.nowMs()),
      });
    }
    return topics.sort((a, b) => a.name.localeCompare(b.name));
  }

  async readTopic(target: LocalMemoryTarget, topicName: string) {
    const filePath = this.topicPath(target, topicName);
    const parsed = parseTopic(await safeRead(filePath));
    return { name: topicName, ...parsed, sizeBytes: byteLength(parsed.body) };
  }

  async writeTopic(
    target: LocalMemoryTarget,
    topicName: string,
    description: string,
    content: string,
  ) {
    const filePath = this.topicPath(target, topicName);
    this.assertWritable();
    await this.atomicWrite(filePath, formatTopic(description, content));
  }

  async appendTopic(target: LocalMemoryTarget, topicName: string, content: string) {
    const filePath = this.topicPath(target, topicName);
    return this.withFileQueue(filePath, async () => {
      const current = parseTopic(await safeRead(filePath));
      const body = appendWithSeparator(current.body, content);
      this.assertWritable();
      await this.writeFileAtomic(filePath, formatTopic(current.description, body));
      return { newSizeBytes: byteLength(body) };
    });
  }

  async editTopic(
    target: LocalMemoryTarget,
    topicName: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ) {
    const filePath = this.topicPath(target, topicName);
    return this.withFileQueue(filePath, async () => {
      const current = parseTopic(await safeRead(filePath));
      const { content, replacements } = applyEdit(current.body, oldString, newString, replaceAll);
      this.assertWritable();
      await this.writeFileAtomic(filePath, formatTopic(current.description, content));
      return { replacements, newSizeBytes: byteLength(content) };
    });
  }

  async deleteTopic(target: LocalMemoryTarget, topicName: string): Promise<boolean> {
    const filePath = this.topicPath(target, topicName);
    this.assertWritable();
    return deleteIfExists(filePath);
  }

  async searchTopics(
    target: LocalMemoryTarget,
    keyword: string,
    limit = 10,
  ): Promise<LocalMemoryTopicEntry[]> {
    const lower = keyword.toLowerCase();
    const topics = await this.listTopics(target);
    const out: LocalMemoryTopicEntry[] = [];
    for (const topic of topics) {
      const body = (await this.readTopic(target, topic.name)).body;
      if (topic.name.includes(lower) || body.toLowerCase().includes(lower)) out.push(topic);
      if (out.length >= limit) break;
    }
    return out;
  }

  async listDaily(target: LocalMemoryTarget, limit = 20, offset = 0, includeArchived = false) {
    const location = this.requireAgentLocation(target);
    const entries = await this.collectDailyEntries(location, includeArchived);
    return { files: entries.slice(offset, offset + limit), total: entries.length };
  }

  async readDaily(target: LocalMemoryTarget, date: string): Promise<LocalMemoryReadResult> {
    return this.readFileResult(this.dailyPath(target, date));
  }

  async writeDaily(target: LocalMemoryTarget, date: string, content: string): Promise<void> {
    this.assertWritable();
    await this.atomicWrite(this.dailyPath(target, date), content);
  }

  async appendDaily(target: LocalMemoryTarget, date: string, content: string): Promise<void> {
    const filePath = this.dailyPath(target, date);
    await this.withFileQueue(filePath, async () => {
      const current = await safeRead(filePath);
      this.assertWritable();
      await this.writeFileAtomic(filePath, appendWithSeparator(current, content));
    });
  }

  async deleteDaily(target: LocalMemoryTarget, date: string): Promise<boolean> {
    this.assertWritable();
    return deleteIfExists(this.dailyPath(target, date));
  }

  async writeSummary(target: LocalMemoryTarget, content: string): Promise<void> {
    const location = this.requireAgentLocation(target);
    this.assertWritable();
    await this.atomicWrite(join(location.memoryDir, SUMMARY_FILE), content);
  }

  async readSummary(target: LocalMemoryTarget): Promise<string> {
    const location = this.requireAgentLocation(target);
    return safeRead(join(location.memoryDir, SUMMARY_FILE));
  }

  async listArchive(target: LocalMemoryTarget, limit = 20, offset = 0) {
    const location = this.requireAgentLocation(target);
    const archiveDir = join(location.memoryDir, 'archive');
    const dates = await safeReaddir(archiveDir);
    const entries: LocalMemoryArchiveEntry[] = [];
    for (const snapshotDate of dates) {
      const dir = join(archiveDir, snapshotDate);
      const files = await safeReaddir(dir);
      for (const fileName of files) {
        const sizeBytes = (await stat(join(dir, fileName)).catch(() => undefined))?.size ?? 0;
        entries.push({ snapshotDate, fileName, sizeBytes });
      }
    }
    entries.sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate));
    return { entries: entries.slice(offset, offset + limit), total: entries.length };
  }

  async readArchive(target: LocalMemoryTarget, snapshotDate: string, fileName: string) {
    if (basename(fileName) !== fileName) throw new LocalMemoryError('INVALID_FILE', 'invalid file');
    const location = this.requireAgentLocation(target);
    return this.readFileResult(
      join(location.memoryDir, 'archive', assertDate(snapshotDate), fileName),
    );
  }

  async snapshotForCleanup(
    target: LocalMemoryTarget,
    date = today(),
  ): Promise<{ snapshotDate: string; fileCount: number }> {
    const location = this.requireAgentLocation(target);
    this.assertWritable();
    const content = await safeRead(location.mainPath);
    const snapshotDate = assertDate(date);
    await this.atomicWrite(
      join(location.memoryDir, 'archive', snapshotDate, MAIN_MEMORY_FILE),
      content,
    );
    return { snapshotDate, fileCount: 1 };
  }

  async archiveOldDaily(target: LocalMemoryTarget, ttlDays: number): Promise<number> {
    const location = this.requireAgentLocation(target);
    this.assertWritable();
    const cutoff = Date.now() - Math.max(0, ttlDays) * 24 * 60 * 60 * 1000;
    let count = 0;
    for (const entry of await this.collectDailyEntries(location, false)) {
      const ts = Date.parse(`${entry.date}T00:00:00.000Z`);
      if (Number.isNaN(ts) || ts >= cutoff) continue;
      const from = join(location.memoryDir, 'daily', `${entry.date}.md`);
      const content = await safeRead(from);
      await this.atomicWrite(
        join(location.memoryDir, 'archive', entry.date, `daily-${entry.date}.md`),
        content,
      );
      if (await deleteIfExists(from)) count += 1;
    }
    return count;
  }

  markSession(
    date: string,
    sessionId: string,
    agentName: string,
    wroteMemory: boolean,
  ): Promise<void> {
    return this.tracking.markSession(date, sessionId, agentName, wroteMemory);
  }

  getUnreminded(date: string, agentName?: string): Promise<LocalMemoryUnremindedEntry[]> {
    return this.tracking.getUnreminded(date, agentName);
  }

  markReminded(date: string, sessionId: string): Promise<void> {
    return this.tracking.markReminded(date, sessionId);
  }

  markReflected(
    date: string,
    sessionId: string,
    agentName: string,
    reflectedAt: string,
  ): Promise<void> {
    return this.tracking.markReflected(date, sessionId, agentName, reflectedAt);
  }

  getReflectionTs(sessionId: string): Promise<string | undefined> {
    return this.tracking.getReflectionTs(sessionId);
  }

  private requireAgentLocation(target: LocalMemoryTarget): LocalMemoryLocation {
    const location = this.resolve(target);
    if (location.scope !== 'agent')
      throw new LocalMemoryError('AGENT_SCOPE_REQUIRED', 'agent scope required');
    return location;
  }

  private topicPath(target: LocalMemoryTarget, topicName: string): string {
    if (!LOCAL_MEMORY_TOPIC_NAME_RE.test(topicName))
      throw new LocalMemoryError('INVALID_TOPIC', 'invalid topic name');
    const location = this.requireAgentLocation(target);
    return join(location.memoryDir, 'topics', `${topicName}.md`);
  }

  private dailyPath(target: LocalMemoryTarget, date: string): string {
    const location = this.requireAgentLocation(target);
    return join(location.memoryDir, 'daily', `${assertDate(date)}.md`);
  }

  private async collectDailyEntries(
    location: LocalMemoryLocation,
    includeArchived: boolean,
  ): Promise<LocalMemoryDailyEntry[]> {
    const entries: LocalMemoryDailyEntry[] = [];
    for (const file of await safeReaddir(join(location.memoryDir, 'daily'))) {
      if (!file.endsWith('.md')) continue;
      const date = file.slice(0, -3);
      const content = await safeRead(join(location.memoryDir, 'daily', file));
      entries.push({
        date,
        sizeBytes: byteLength(content),
        brief: firstLine(content),
        archived: false,
      });
    }
    if (includeArchived) {
      const archiveTarget: LocalMemoryTarget = { scope: 'agent', agentName: location.agentName! };
      for (const entry of (await this.listArchive(archiveTarget, 1000, 0)).entries) {
        if (entry.fileName.startsWith('daily-')) {
          entries.push({ date: entry.snapshotDate, sizeBytes: entry.sizeBytes, archived: true });
        }
      }
    }
    return entries.sort((a, b) => b.date.localeCompare(a.date));
  }

  private async migrateLegacyUserMemory(location: LocalMemoryLocation): Promise<string> {
    if (location.scope !== 'user') return location.mainPath;
    const legacy = join(location.memoryDir, LEGACY_USER_MEMORY_FILE);
    if (!existsSync(legacy) || existsSync(location.mainPath)) return location.mainPath;
    if (this.config().enabled === false) return legacy;
    this.assertWritable();
    await mkdir(dirname(location.mainPath), { recursive: true });
    await rename(legacy, location.mainPath);
    return location.mainPath;
  }

  private async readFileResult(filePath: string): Promise<LocalMemoryReadResult> {
    const content = await safeRead(filePath);
    const fileStat = await stat(filePath).catch(() => undefined);
    return {
      content,
      sizeBytes: byteLength(content),
      brief: firstLine(content),
      updatedAt: fileStat ? formatTs(fileStat.mtimeMs) : undefined,
    };
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    await this.withFileQueue(filePath, () => this.writeFileAtomic(filePath, content));
  }

  private async withFileQueue<T>(filePath: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(filePath) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.writeQueues.set(
      filePath,
      next.catch(() => undefined),
    );
    return next;
  }

  private async writeFileAtomic(filePath: string, content: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, filePath);
  }

  private assertWritable(): void {
    if (this.config().enabled === false) {
      throw new LocalMemoryError('MEMORY_DISABLED', 'memory writes are disabled');
    }
  }
}
