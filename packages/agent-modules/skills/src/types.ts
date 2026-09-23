export type SkillSourceKind = 'project' | 'workspace' | 'agent' | 'global' | 'user' | 'builtin';

export interface SkillSourceRoot {
  id: string;
  kind: SkillSourceKind;
  scope?: string;
  rootPath: string;
  priority?: number;
  external?: boolean;
  /** Follow directory links outside the root for configured compatibility sources. */
  allowDirectorySymlinksOutsideRoot?: boolean;
}

export type SkillDiagnosticLevel = 'warning' | 'error';

export interface SkillDiagnostic {
  level: SkillDiagnosticLevel;
  code: string;
  message: string;
  rootId?: string;
  locationUri?: string;
}

export interface SkillEntry {
  id: string;
  name: string;
  title: string;
  description: string;
  firstDescriptionLine: string;
  content: string;
  locationUri: string;
  skillDir: string;
  /** Root-owned directory entry; differs from skillDir for linked skills. */
  entryDir?: string;
  rootId: string;
  rootKind: SkillSourceKind;
  rootScope?: string;
  rootPriority: number;
  sourceExternal: boolean;
  frontmatter: Record<string, string | number | boolean>;
  /** Optional locale->name map from the nested `displayNames` frontmatter key. */
  displayNames?: Record<string, string>;
  /** Optional locale->description map from the nested `descriptions` frontmatter key. */
  descriptions?: Record<string, string>;
  size: number;
  mtimeMs: number;
}

export interface SkillLoser {
  entry: SkillEntry;
  reason: string;
  winnerLocationUri: string;
}

export interface SkillViewEntry extends SkillEntry {
  losers: SkillLoser[];
}

export interface SkillSnapshot {
  version: number;
  generatedAt: number;
  roots: SkillSourceRoot[];
  entries: SkillEntry[];
  winners: SkillViewEntry[];
  losers: SkillLoser[];
  diagnostics: SkillDiagnostic[];
  metrics: SkillRefreshMetrics;
}

export interface SkillRefreshMetrics {
  rootsScanned: number;
  filesSeen: number;
  filesRead: number;
  filesReused: number;
  diagnostics: number;
  entries: number;
  winners: number;
  losers: number;
}

export interface SkillRenderOptions {
  budgetChars?: number;
  externalDescriptionChars?: number;
}

export interface SkillRenderMetrics {
  total: number;
  rendered: number;
  compacted: number;
  dropped: number;
  charsUsed: number;
  budgetChars: number;
}

export interface SkillCatalogRender {
  catalog: string;
  metrics: SkillRenderMetrics;
}

export interface SkillRegistryDump {
  version: number;
  generated_at: number;
  roots: Array<SkillSourceRoot & { canonicalPath?: string }>;
  entries: Array<Omit<SkillEntry, 'content'>>;
  winners: string[];
  losers: Array<{
    locationUri: string;
    name: string;
    reason: string;
    winnerLocationUri: string;
  }>;
  diagnostics: SkillDiagnostic[];
  refresh_metrics: SkillRefreshMetrics;
  render_metrics?: SkillRenderMetrics;
}

export interface SkillRegistryWatcher {
  rearm?(): void;
  close(): void;
}

export interface SkillRegistryWatchOptions {
  onChange: (root: SkillSourceRoot) => void | Promise<void>;
}
