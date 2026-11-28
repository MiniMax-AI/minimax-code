/** A session's `state` is released after this long without a program. */
const BROWSER_PROGRAM_STATE_IDLE_MS = 10 * 60_000;
/** The `state` one program leaves for the next, as JSON. */
export const BROWSER_PROGRAM_STATE_MAX_BYTES = 256 * 1024;

/**
 * `state` of Browser programs, per Browser session (the chat session the
 * provider keys its pages by), in memory. Pages and locators in it are plain
 * data, so no QuickJS runtime has to stay alive between programs.
 */
export class BrowserProgramStateStore {
  private readonly entries = new Map<string, { json: string; timer: NodeJS.Timeout }>();

  constructor(private readonly idleMs = BROWSER_PROGRAM_STATE_IDLE_MS) {}

  /** Reading counts as use: the idle clock starts again. */
  read(sessionId: string): string | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    this.write(sessionId, entry.json);
    return entry.json;
  }

  write(sessionId: string, json: string): void {
    const previous = this.entries.get(sessionId);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.entries.delete(sessionId), this.idleMs);
    timer.unref?.();
    this.entries.set(sessionId, { json, timer });
  }

  clearSession(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) clearTimeout(entry.timer);
    this.entries.delete(sessionId);
  }

  clear(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
  }
}
