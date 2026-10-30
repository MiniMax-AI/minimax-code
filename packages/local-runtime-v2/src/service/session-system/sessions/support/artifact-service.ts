export interface NativeSessionArtifactOwners {
  readonly queue: { deleteSession(sessionId: string): void | Promise<void> };
  readonly files: { deleteSession(sessionId: string): void | Promise<void> };
  readonly usage: { deleteSession(sessionId: string): void | Promise<void> };
  readonly messages: { deleteSessionData(sessionId: string): void | Promise<void> };
  readonly history: { deleteSessionData(sessionId: string): void | Promise<void> };
  readonly onLegacyCleanupError?: (error: unknown, sessionId: string) => void;
  readonly canonicalHistory: { delete(sessionId: string): void | Promise<void> };
  readonly stream: { deleteSession(sessionId: string): void };
  readonly reports: { ensureDirectory(sessionId: string): string | Promise<string> };
  readonly snapshots: { resolveDirectory(sessionId: string): string | Promise<string> };
}

export class SessionArtifactService {
  constructor(private readonly owners: NativeSessionArtifactOwners) {}

  async ensureReportsDirectory(sessionId: string): Promise<string> {
    return this.owners.reports.ensureDirectory(sessionId);
  }

  /** Where each compaction keeps the full history it replaced. */
  async resolveSnapshotsDirectory(sessionId: string): Promise<string> {
    return this.owners.snapshots.resolveDirectory(sessionId);
  }

  async deleteSession(
    sessionId: string,
    options: { readonly preserveUsage?: boolean } = {},
  ): Promise<void> {
    const operations = [
      () => this.owners.queue.deleteSession(sessionId),
      () => this.owners.files.deleteSession(sessionId),
      ...(options.preserveUsage ? [] : [() => this.owners.usage.deleteSession(sessionId)]),
      () => this.owners.messages.deleteSessionData(sessionId),
      () => this.deleteLegacyHistory(sessionId),
      () => this.owners.canonicalHistory.delete(sessionId),
      () => this.owners.stream.deleteSession(sessionId),
    ];
    const results = await Promise.allSettled(operations.map(execute));
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, `Session-owned artifact deletion failed: ${sessionId}`);
    }
  }

  private async deleteLegacyHistory(sessionId: string): Promise<void> {
    try {
      await this.owners.history.deleteSessionData(sessionId);
    } catch (error) {
      this.owners.onLegacyCleanupError?.(error, sessionId);
    }
  }
}

async function execute(operation: () => void | Promise<void>): Promise<void> {
  await operation();
}
