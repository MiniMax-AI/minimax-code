/** Host-owned Session identity and read-only paths; no dependency on a Session store implementation. */
export interface ReportSession {
  readonly sessionId: string;
  readonly sessionKind: string;
}

export interface ReportLocations {
  inspectSession(sessionId: string): Promise<
    | {
        readonly session: ReportSession;
        readonly paths: { readonly sessionDir: string; readonly snapshots: string };
      }
    | undefined
  >;
}

export interface ReportSessions {
  listChildren(sessionId: string): Promise<readonly { readonly sessionId: string }[]>;
  getTaskAgentBinding(sessionId: string): Promise<{ readonly definition: unknown } | undefined>;
}

interface SessionReportArtifactBase {
  readonly name: string;
  readonly bytes: number;
  /** Local collection priority only. Uploaders must minimize these artifacts before transfer. */
  readonly required: true;
}

export type SessionReportArtifact = SessionReportArtifactBase &
  (
    | { readonly path: string; readonly content?: never }
    | { readonly content: string; readonly path?: never }
  );

export interface SessionReportManifest {
  readonly schemaVersion: 1;
  readonly rootSessionId: string;
  readonly sessionIds: readonly string[];
  readonly artifacts: readonly SessionReportArtifact[];
}

export interface SessionReportCapability {
  collect(sessionId: string): Promise<SessionReportManifest>;
}

export interface SessionLlmCallToolEnvelope {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

/** Secret-free, non-message inputs needed to reconstruct an agent LLM call. */
export interface SessionLlmCallEnvelope {
  readonly schemaVersion: 1;
  readonly systemPrompt: string;
  readonly tools: readonly SessionLlmCallToolEnvelope[];
  readonly model: string;
  readonly provider: string;
  readonly api: string;
  readonly thinkingLevel: string;
  readonly maxTokens?: number;
  readonly hostMaxOutputTokens?: number;
  readonly maxSerializedInputBytes?: number;
  readonly cacheRetention?: string;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly outputRevisionInstruction?: string;
}

export interface SessionLlmCallReportCapability {
  writeCurrent(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly envelope: SessionLlmCallEnvelope;
  }): Promise<void>;
  freezeCompletedCompaction(input: {
    readonly sessionId: string;
    readonly compactionId: string;
  }): Promise<void>;
  pruneAfterRewind(input: { readonly sessionId: string }): Promise<void>;
  copySnapshotCompanions(input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly snapshotFiles: readonly string[];
  }): Promise<void>;
}
