import { TuiPluginAutocomplete } from '../../commands/plugin-autocomplete.js';
import type { McodePluginRuntimeAccess } from '../../../plugin/contract.js';
import type { Component } from '../../rendering/component.js';
import type { Terminal } from '../../engine/public.js';
import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from '../../widgets/autocomplete.js';
import type { Editor } from '../../widgets/editor/editor.js';
import type { TuiAttachment, TuiTransportAttachment } from '../../../types/invocation.js';
import { toTuiTranscriptAttachments } from '../../features/composer/attachments.js';

import type {
  TuiActiveRunSnapshot,
  TuiActiveRunControlPort,
  TuiConversationPort,
  TuiInspectionPort,
  TuiSession,
  TuiSkillList,
  TuiWorkspaceFileEntry,
  TuiWorkspaceFilePort,
  TuiWorkspaceRoot,
  TuiWorkspaceTreeCandidate,
} from '../../../runtime/port.js';
import {
  type TuiCommandCatalog,
  MINIMAX_CODE_ACTIVE_RUN_COMMANDS,
  MINIMAX_CODE_COMMANDS,
  MINIMAX_CODE_DISCOVERABLE_COMMANDS,
  type TuiCommand,
} from '../../commands/catalog.js';
import { TuiHelpPanel } from '../../features/help/panel.js';
import type { TuiChatController, TuiChatSnapshot } from '../chat-controller.js';
import { isRuntimeMethodNotImplemented } from '../support.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import {
  createTuiContextInspection,
  formatTuiContextSnapshot,
} from '../../features/inspection/product-inspection.js';
import { TuiReportInspectionPanel } from '../../features/inspection/report-panel.js';
import type { TranscriptInspectionReport } from '../../transcript/model.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';
import type { TuiKeybindingRegistry } from '../../shell/keybindings.js';
import { TuiBashAutocomplete } from '../../commands/bash-autocomplete.js';

const MIN_HELP_ROWS = 4;
const RESERVED_HELP_CHROME_ROWS = 6;

export interface TuiSteerOptions {
  readonly requestedTurnId?: string;
  readonly requireActiveTurn?: boolean;
  readonly displayContent?: string;
  readonly attachments?: readonly TuiTransportAttachment[];
  readonly transcriptAttachments?: readonly TuiAttachment[];
}

export function createTuiInitialAutocomplete(
  workspace: string | readonly TuiWorkspaceRoot[],
  workspaceFiles?: Partial<
    TuiWorkspaceFilePort & Pick<McodePluginRuntimeAccess, 'listInstalledPlugins'>
  >,
  builtInCommands: readonly TuiCommand[] = MINIMAX_CODE_DISCOVERABLE_COMMANDS,
) {
  return createTuiAutocomplete(builtInCommands, [], workspace, workspaceFiles);
}

export function createTuiAutocomplete(
  builtInCommands: readonly TuiCommand[],
  skillCommands: readonly TuiCommand[],
  workspace: string | readonly TuiWorkspaceRoot[],
  workspaceFiles?: Partial<
    TuiWorkspaceFilePort & Pick<McodePluginRuntimeAccess, 'listInstalledPlugins'>
  >,
  shellCwd?: () => string,
): AutocompleteProvider {
  return new TuiPluginAutocomplete(
    new TuiAutocompleteProvider(
      builtInCommands,
      skillCommands,
      workspace,
      workspaceFiles,
      shellCwd,
    ),
    workspaceFiles,
  );
}

export function buildTuiSkillCommands(result: TuiSkillList): TuiCommand[] {
  const builtinNames = new Set(
    [...MINIMAX_CODE_COMMANDS, ...MINIMAX_CODE_ACTIVE_RUN_COMMANDS].flatMap((command) =>
      [command.name, ...(command.aliases ?? [])].map((name) => name.toLocaleLowerCase()),
    ),
  );
  const seen = new Set<string>();
  return (result.skills ?? [])
    .flatMap((skill): TuiCommand[] => {
      const name = skill.name.trim().toLocaleLowerCase();
      if (
        skill.enabled === false ||
        builtinNames.has(name) ||
        seen.has(name) ||
        !name ||
        name.length > 128 ||
        name !== sanitizeTerminalText(name) ||
        /[\s/]/u.test(name)
      ) {
        return [];
      }
      seen.add(name);
      return [
        {
          name,
          description: formatSkillCommandDescription(skill.displayDescription ?? skill.description),
          category: 'Capability',
          invocationKind: 'skill',
          argumentHint: '[instructions]',
          usage: `/${name} [instructions]`,
          composerTemplate: `/${name} `,
        },
      ];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function formatSkillCommandDescription(description: string | undefined): string {
  const value = description ? sanitizeTerminalText(description).trim() : '';
  return value ? `[Skill] ${value}` : '[Skill]';
}

export class TuiActiveRunFlow {
  private snapshot: TuiActiveRunSnapshot | undefined;
  private refreshKey: string | undefined;
  private refreshSequence = 0;
  private stopped = false;
  private commandCatalog: TuiCommandCatalog | undefined;
  private autocompleteManagedTokenPresent: boolean | undefined;
  private autocompleteSessionKey: string | undefined;
  private autocompleteHasLiveRun: boolean | undefined;
  private autocompleteSignature: string | undefined;
  private pendingAutocomplete:
    { readonly provider: AutocompleteProvider; readonly signature: string } | undefined;
  private contextInspection:
    { readonly sessionId: string; readonly panel: TuiReportInspectionPanel } | undefined;

  constructor(
    private readonly options: {
      runtime: TuiConversationPort &
        TuiActiveRunControlPort &
        Pick<TuiInspectionPort, 'getContextSnapshot'> &
        Partial<TuiWorkspaceFilePort>;
      controller: TuiChatController;
      editor: Editor;
      terminal: Terminal;
      workspaceDir: string;
      workspaceRoots?: readonly TuiWorkspaceRoot[] | (() => readonly TuiWorkspaceRoot[]);
      liveRunId(snapshot?: TuiChatSnapshot): string | undefined;
      skillCommands(): TuiCommand[];
      requireSession(): TuiSession | undefined;
      append(
        content: string,
        kind?: 'final-summary' | 'warning' | 'error' | 'inspection',
        inspection?: TranscriptInspectionReport,
      ): void;
      stage(command: TuiCommand): void;
      showInteraction(panel: Component): void;
      closeInteraction(panel?: Component): boolean;
      onChanged(): void;
      adoptRuntimeTurn?(sessionId: string, turnId: string, acceptedAtMs: number): void;
      commandCatalog?: TuiCommandCatalog;
      keybindings?: TuiKeybindingRegistry;
      queueEnabled: boolean;
      isStopped?: () => boolean;
    },
  ) {
    this.commandCatalog = options.commandCatalog;
  }

  stop(): void {
    this.stopped = true;
    this.refreshSequence += 1;
    this.snapshot = undefined;
    this.pendingAutocomplete = undefined;
    this.closeContextInspection();
  }

  setCommandCatalog(commandCatalog: TuiCommandCatalog): void {
    this.commandCatalog = commandCatalog;
    this.refreshAutocomplete();
  }

  schedule(chat: TuiChatSnapshot): void {
    if (this.isStopped()) return;
    this.reconcileContextInspection(chat.session?.sessionId);
    const sessionKey = chat.session
      ? `${chat.session.sessionId}:${chat.session.parentSessionId ?? ''}`
      : '';
    if (
      this.autocompleteManagedTokenPresent !== (chat.account?.managedTokenPresent === true) ||
      this.autocompleteSessionKey !== sessionKey ||
      this.autocompleteHasLiveRun !== this.hasLiveRun(chat)
    ) {
      this.refreshAutocomplete();
    }
    const sessionId = chat.session?.sessionId;
    if (!sessionId) {
      this.snapshot = undefined;
      this.refreshKey = undefined;
      return;
    }
    const key = `${sessionId}:${this.options.liveRunId(chat) ?? 'idle'}:${chat.status}`;
    if (this.refreshKey === key) return;
    void this.refresh().catch(() => undefined);
  }

  async refresh(force = false): Promise<void> {
    if (this.isStopped()) return;
    const chat = this.options.controller.snapshot();
    const session = chat.session;
    this.reconcileContextInspection(session?.sessionId);
    if (!session) {
      this.refreshSequence += 1;
      this.snapshot = undefined;
      this.refreshAutocomplete();
      return;
    }
    const key = `${session.sessionId}:${this.options.liveRunId() ?? 'idle'}:${chat.status}`;
    if (!force && this.refreshKey === key) return;
    this.refreshKey = key;
    const refreshSequence = ++this.refreshSequence;
    if (this.snapshot?.sessionId !== session.sessionId) this.snapshot = undefined;
    let runtimeSnapshot: TuiActiveRunSnapshot | undefined;
    try {
      runtimeSnapshot = await this.options.runtime.getActiveRun(session.sessionId);
    } catch {
      runtimeSnapshot = undefined;
    }
    if (
      this.isStopped() ||
      refreshSequence !== this.refreshSequence ||
      this.options.controller.snapshot().session?.sessionId !== session.sessionId
    ) {
      return;
    }
    this.snapshot =
      runtimeSnapshot?.sessionId === session.sessionId
        ? { ...runtimeSnapshot, actions: { ...runtimeSnapshot.actions } }
        : undefined;
    this.refreshAutocomplete();
    this.options.onChanged();
  }

  currentSnapshot(): TuiActiveRunSnapshot | undefined {
    if (!this.snapshot) return undefined;
    return {
      ...this.snapshot,
      actions: { ...this.snapshot.actions },
    };
  }

  refreshAutocomplete(): void {
    const chat = this.options.controller.snapshot();
    this.autocompleteManagedTokenPresent = chat.account?.managedTokenPresent === true;
    this.autocompleteSessionKey = chat.session
      ? `${chat.session.sessionId}:${chat.session.parentSessionId ?? ''}`
      : '';
    this.autocompleteHasLiveRun = this.hasLiveRun(chat);
    const builtInCommands = [
      ...(this.commandCatalog?.searchableCommands ?? MINIMAX_CODE_DISCOVERABLE_COMMANDS),
    ];
    const skillCommands = this.options.skillCommands();
    const workspace =
      typeof this.options.workspaceRoots === 'function'
        ? this.options.workspaceRoots()
        : (this.options.workspaceRoots ?? this.options.workspaceDir);
    const signature = autocompleteSignature(builtInCommands, skillCommands, workspace);
    if (signature === this.autocompleteSignature) {
      this.pendingAutocomplete = undefined;
      return;
    }
    if (signature === this.pendingAutocomplete?.signature) return;

    const provider = createTuiAutocomplete(
      builtInCommands,
      skillCommands,
      workspace,
      this.options.runtime,
      () => this.options.controller.snapshot().session?.workspaceDir ?? this.options.workspaceDir,
    );
    if ((this.options.editor.getText?.() ?? '').length > 0) {
      this.pendingAutocomplete = { provider, signature };
      return;
    }
    this.applyAutocompleteProvider(provider, signature);
  }

  onEditorChanged(): void {
    if ((this.options.editor.getText?.() ?? '').length > 0 || !this.pendingAutocomplete) return;
    const { provider, signature } = this.pendingAutocomplete;
    this.applyAutocompleteProvider(provider, signature);
  }

  private applyAutocompleteProvider(provider: AutocompleteProvider, signature: string): void {
    this.pendingAutocomplete = undefined;
    this.autocompleteSignature = signature;
    this.options.editor.setAutocompleteProvider(provider);
  }

  showHelp(): void {
    if (this.isStopped()) return;
    const panel = new TuiHelpPanel({
      commands: [
        ...(this.commandCatalog?.discoverableCommands ?? MINIMAX_CODE_DISCOVERABLE_COMMANDS),
      ],
      queueEnabled: this.options.queueEnabled,
      keybindings: this.options.keybindings,
      onCancel: () => this.options.closeInteraction(panel),
      maxRows: () => {
        const terminalRows = Number.isFinite(this.options.terminal.rows)
          ? this.options.terminal.rows
          : 24;
        return Math.max(MIN_HELP_ROWS, terminalRows - RESERVED_HELP_CHROME_ROWS);
      },
    });
    this.options.showInteraction(panel);
  }

  async showContext(): Promise<void> {
    if (this.isStopped()) return;
    const session = this.options.requireSession();
    if (!session) return;
    const panel = new TuiReportInspectionPanel({
      title: 'Context',
      loadingMessage: 'Loading context details…',
      maxRows: () => {
        const rows = Number.isFinite(this.options.terminal.rows) ? this.options.terminal.rows : 24;
        return Math.max(4, rows - 4);
      },
      requestRender: this.options.onChanged,
      onCancel: () => this.closeContextInspection(panel),
      onDispose: () => {
        if (this.contextInspection?.panel === panel) this.contextInspection = undefined;
      },
    });
    this.showContextInspection(session.sessionId, panel);
    try {
      const response = await this.options.runtime.getContextSnapshot(session.sessionId);
      if (this.isStopped()) return;
      if (this.options.controller.snapshot().session?.sessionId !== session.sessionId) {
        this.closeContextInspection(panel);
        return;
      }
      if (!this.isCurrentContextInspection(panel)) {
        return;
      }
      const inspection = createTuiContextInspection(response);
      panel.setResult(formatTuiContextSnapshot(response), inspection);
    } catch (error) {
      if (this.isStopped()) return;
      if (this.options.controller.snapshot().session?.sessionId !== session.sessionId) {
        this.closeContextInspection(panel);
        return;
      }
      if (!this.isCurrentContextInspection(panel)) {
        return;
      }
      panel.setError(
        isRuntimeMethodNotImplemented(error)
          ? 'Context inspection is not supported by this Runtime.'
          : formatTuiActionFailure(error, {
              summary: "Couldn't load context details.",
              nextStep: 'Retry /context.',
            }),
      );
    }
  }

  private showContextInspection(sessionId: string, panel: TuiReportInspectionPanel): void {
    this.closeContextInspection();
    this.contextInspection = { sessionId, panel };
    this.options.showInteraction(panel);
  }

  private closeContextInspection(panel?: TuiReportInspectionPanel): boolean {
    const current = this.contextInspection;
    if (!current || (panel && current.panel !== panel)) return false;
    this.contextInspection = undefined;
    return this.options.closeInteraction(current.panel);
  }

  private reconcileContextInspection(sessionId: string | undefined): void {
    if (this.contextInspection?.sessionId !== sessionId) this.closeContextInspection();
  }

  private isCurrentContextInspection(panel: TuiReportInspectionPanel): boolean {
    return this.contextInspection?.panel === panel;
  }

  async handle(command: string): Promise<boolean> {
    if (!matches(command, '/steer')) return false;
    const prefix = '/steer';
    return this.steer(command.slice(prefix.length));
  }

  async steer(rawContent: string, options: TuiSteerOptions = {}): Promise<boolean> {
    if (this.isStopped()) return false;
    const session = this.options.requireSession();
    if (!session) return false;
    const content = rawContent.trim();
    if (!content) {
      this.options.append('Usage: /steer <message>');
      return false;
    }
    const requestId = `run_action_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    const projectionArguments = [
      requestId,
      options.displayContent ?? content,
      Date.now(),
      toTuiTranscriptAttachments(options.transcriptAttachments ?? []),
    ] as const;
    if (
      options.requireActiveTurn ||
      options.requestedTurnId ||
      this.hasLiveRun(this.options.controller.snapshot())
    ) {
      this.options.controller.projectOptimisticUserMessage(...projectionArguments, 'pending-steer');
    } else {
      this.options.controller.projectOptimisticUserMessage(...projectionArguments);
    }
    this.options.onChanged();
    try {
      await this.options.controller.requireLoginForAgentAction?.();
      await this.refresh(true);
    } catch (error) {
      this.options.controller.removeOptimisticUserMessage(requestId);
      throw error;
    }
    if (
      this.isStopped() ||
      this.options.controller.snapshot().session?.sessionId !== session.sessionId
    ) {
      this.options.controller.removeOptimisticUserMessage(requestId);
      return false;
    }
    const snapshot = this.snapshot?.sessionId === session.sessionId ? this.snapshot : undefined;
    const requestedTurnId =
      options.requestedTurnId ?? (options.requireActiveTurn ? snapshot?.turnId : undefined);
    const matchesRequestedTurn = !requestedTurnId || snapshot?.turnId === requestedTurnId;
    const canActivate =
      !requestedTurnId &&
      !options.requireActiveTurn &&
      (snapshot?.state === 'idle' || snapshot?.state === 'terminal');
    if (!snapshot || !matchesRequestedTurn || (!snapshot.actions.steer && !canActivate)) {
      this.options.controller.removeOptimisticUserMessage(requestId);
      this.options.append(
        snapshot?.state === 'decision-blocked'
          ? 'Resolve the pending Runtime decision first.'
          : 'Steer is not available for the current work.',
        'warning',
      );
      return false;
    }
    let receipt: Awaited<ReturnType<TuiConversationPort['steer']>>;
    try {
      receipt = await this.options.runtime.steer({
        sessionId: session.sessionId,
        source: 'api',
        message: {
          content,
          ...(options.displayContent ? { displayContent: options.displayContent } : {}),
          ...(options.attachments?.length ? { attachments: options.attachments } : {}),
        },
        producerId: 'mcode',
        idempotencyKey: requestId,
        ...(requestedTurnId ? { requestedTurnId } : {}),
      });
    } catch (error) {
      this.options.controller.removeOptimisticUserMessage(requestId);
      if (
        this.isStopped() ||
        this.options.controller.snapshot().session?.sessionId !== session.sessionId
      ) {
        return false;
      }
      this.options.append(
        formatTuiActionFailure(error, {
          summary: "Couldn't steer current work.",
          nextStep: 'Retry /steer.',
          preservation: 'Your message was not applied.',
        }),
        'warning',
      );
      return false;
    }
    if (
      this.isStopped() ||
      this.options.controller.snapshot().session?.sessionId !== session.sessionId
    ) {
      this.options.controller.removeOptimisticUserMessage(requestId);
      return true;
    }
    this.options.controller.acceptOptimisticUserMessage(
      requestId,
      receipt.turnId,
      Date.now(),
      receipt.mode === 'steered' ? 'runtime-message' : 'immediate',
    );
    if (receipt.mode === 'activated' || receipt.turnId !== snapshot.turnId) {
      this.options.adoptRuntimeTurn?.(session.sessionId, receipt.turnId, Date.now());
    }
    if (receipt.mode === 'activated') void receipt.completion.catch(() => undefined);
    try {
      await this.refresh(true);
    } catch (error) {
      this.options.append(
        formatTuiActionFailure(error, {
          summary: 'Steer was accepted, but this view could not refresh.',
          nextStep: 'Reopen the session to sync it.',
        }),
        'warning',
      );
    }
    return true;
  }

  private isStopped(): boolean {
    return this.stopped || Boolean(this.options.isStopped?.());
  }

  private hasLiveRun(chat: TuiChatSnapshot): boolean {
    return Boolean(this.options.liveRunId(chat) || this.options.controller.hasInProcessRun?.());
  }
}

function autocompleteSignature(
  builtInCommands: readonly TuiCommand[],
  skillCommands: readonly TuiCommand[],
  workspace: string | readonly TuiWorkspaceRoot[],
): string {
  const commandIdentity = (command: TuiCommand) => [
    command.name,
    command.description,
    command.invocationKind ?? '',
    command.argumentHint ?? '',
    !!command.getArgumentCompletions,
    command.composerTemplate ?? '',
    ...(command.aliases ?? []),
  ];
  return JSON.stringify({
    builtInCommands: builtInCommands.map(commandIdentity),
    skillCommands: skillCommands.map(commandIdentity),
    workspace:
      typeof workspace === 'string'
        ? workspace
        : workspace.map(({ path, label, primary }) => [path, label ?? '', primary === true]),
  });
}

class TuiAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ['@'];
  private readonly shellProvider: TuiBashAutocomplete;
  private readonly defaultProvider: CombinedAutocompleteProvider;
  private readonly baseProvider: CombinedAutocompleteProvider;
  private readonly aliasProvider: CombinedAutocompleteProvider;
  private readonly commandLabels = new Map<
    string,
    { commandName: string; label: string; description: string }
  >();
  private readonly skillNames: ReadonlySet<string>;

  constructor(
    builtInCommands: readonly TuiCommand[],
    skillCommands: readonly TuiCommand[],
    workspace: string | readonly TuiWorkspaceRoot[],
    private readonly workspaceFiles?: Partial<
      TuiWorkspaceFilePort & Pick<McodePluginRuntimeAccess, 'listInstalledPlugins'>
    >,
    shellCwd?: () => string,
  ) {
    this.workspaceRoots = normalizeAutocompleteRoots(workspace);
    this.workspaceDir =
      this.workspaceRoots.find((root) => root.primary)?.path ?? this.workspaceRoots[0]?.path ?? '';
    this.shellProvider = new TuiBashAutocomplete(shellCwd ?? (() => this.workspaceDir));
    const commands = [...builtInCommands, ...skillCommands];
    const defaultCommands = [
      ...builtInCommands.filter((command) => command.discoverability !== 'search-only'),
      ...skillCommands,
    ];
    this.skillNames = new Set(skillCommands.map((command) => command.name));
    const slashCommands = commands.map(toSlashCommand);
    const aliasCommands = commands.flatMap((command): SlashCommand[] => {
      const aliases = command.aliases ?? [];
      const label = aliases.length > 0 ? `${command.name} (${aliases.join(', ')})` : command.name;
      for (const name of [command.name, ...aliases]) {
        this.commandLabels.set(name, {
          commandName: command.name,
          label,
          description: command.description,
        });
      }
      return aliases.map((name) => ({ ...toSlashCommand(command), name }));
    });
    this.baseProvider = new CombinedAutocompleteProvider(
      [...slashCommands, ...aliasCommands],
      this.workspaceDir,
    );
    this.defaultProvider = new CombinedAutocompleteProvider(
      defaultCommands.map(toSlashCommand),
      this.workspaceDir,
    );
    this.aliasProvider = new CombinedAutocompleteProvider(
      [...slashCommands, ...aliasCommands],
      this.workspaceDir,
    );
  }

  private readonly workspaceRoots: readonly TuiWorkspaceRoot[];
  private readonly workspaceDir: string;

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    if (this.shellProvider.isShellInput(lines)) {
      return this.shellProvider.getSuggestions(lines, cursorLine, cursorCol, options);
    }
    const textBeforeCursor = (lines[cursorLine] ?? '').slice(0, cursorCol);
    const fileMentionPrefix = extractFileMentionPrefix(textBeforeCursor);
    if (fileMentionPrefix) {
      return this.getWorkspaceFileSuggestions(fileMentionPrefix, options.signal);
    }
    if (!textBeforeCursor.startsWith('/')) return null;
    const provider =
      textBeforeCursor === '/'
        ? this.defaultProvider
        : /^\/\S+$/u.test(textBeforeCursor)
          ? this.aliasProvider
          : this.baseProvider;
    const suggestions = await provider.getSuggestions(lines, cursorLine, cursorCol, {
      ...options,
      force: false,
    });
    if (!suggestions) return null;
    if (suggestions.kind === 'argument') return suggestions;
    const seenCommands = new Set<string>();
    const items = suggestions.items
      .map((item) => {
        const commandLabel = this.commandLabels.get(item.value);
        return commandLabel
          ? {
              ...item,
              label: commandLabel.label,
              description: commandLabel.description,
            }
          : item;
      })
      .filter((item) => {
        const commandName = this.commandLabels.get(item.value)?.commandName ?? item.value;
        if (seenCommands.has(commandName)) return false;
        seenCommands.add(commandName);
        return true;
      });
    const commandQuery = /^\/(\S+)$/u.exec(textBeforeCursor)?.[1]?.toLocaleLowerCase();
    const prefixItems = commandQuery
      ? items.filter((item) => item.value.toLocaleLowerCase().startsWith(commandQuery))
      : [];
    const rankedItems = prefixItems.length > 0 ? prefixItems : items;
    return {
      ...suggestions,
      items:
        textBeforeCursor.startsWith('/') && !textBeforeCursor.includes(' ')
          ? [
              ...rankedItems.filter((item) => !this.skillNames.has(item.value)),
              ...rankedItems.filter((item) => this.skillNames.has(item.value)),
            ]
          : rankedItems,
    };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    if (this.shellProvider.isShellInput(lines)) {
      return this.shellProvider.applyCompletion(lines, cursorLine, cursorCol, item);
    }
    return this.baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldAutoTriggerCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean | undefined {
    if (this.shellProvider.isShellInput(lines)) return false;
    const textBeforeCursor = (lines[cursorLine] ?? '').slice(0, cursorCol);
    // File mentions keep the Editor's existing forced-Tab insertion semantics.
    if (extractFileMentionPrefix(textBeforeCursor) !== undefined) return undefined;
    return this.baseProvider.shouldAutoTriggerCompletion(lines, cursorLine, cursorCol);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    if (this.shellProvider.isShellInput(lines)) {
      return this.shellProvider.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
    }
    const currentLine = lines[cursorLine] ?? '';
    return extractFileMentionPrefix(currentLine.slice(0, cursorCol)) !== undefined;
  }

  private async getWorkspaceFileSuggestions(
    prefix: string,
    signal: AbortSignal,
  ): Promise<AutocompleteSuggestions | null> {
    const query = readFileMentionQuery(prefix);
    if (query === undefined || !isWorkspaceRelativeReference(query)) return null;

    try {
      const items =
        query === '' || query.endsWith('/')
          ? await this.listWorkspaceDirectory(query, signal)
          : await this.searchWorkspace(query, signal);
      return items.length > 0 ? { items, prefix } : null;
    } catch {
      return null;
    }
  }

  private async listWorkspaceDirectory(
    query: string,
    signal: AbortSignal,
  ): Promise<AutocompleteItem[]> {
    const directory = query ? query.slice(0, -1) : undefined;
    if (this.workspaceFiles?.listWorkspaceFileTreeCandidates) {
      const entries = await this.workspaceFiles.listWorkspaceFileTreeCandidates(
        {
          roots: this.workspaceRoots,
          ...(directory ? { path: directory } : {}),
        },
        signal,
      );
      return entries.flatMap((entry) => this.toMultiRootTreeItem(entry));
    }
    if (!this.workspaceFiles?.listWorkspaceFileTree) return [];
    const entries = await this.workspaceFiles.listWorkspaceFileTree(
      this.workspaceDir,
      directory,
      signal,
    );
    return entries.flatMap((entry) => toWorkspaceTreeAutocompleteItem(entry));
  }

  private async searchWorkspace(query: string, signal: AbortSignal): Promise<AutocompleteItem[]> {
    if (this.workspaceFiles?.searchWorkspaceFileCandidates) {
      const candidates = await this.workspaceFiles.searchWorkspaceFileCandidates(
        { roots: this.workspaceRoots, query, limit: 20 },
        signal,
      );
      const seen = new Set<string>();
      return candidates.flatMap((candidate) => {
        const normalizedPath = normalizeWorkspacePath(candidate.path);
        const root = this.workspaceRoots.find((item) => item.path === candidate.workspaceDir);
        if (!normalizedPath || !root || !isWorkspaceRelativeReference(normalizedPath)) return [];
        const key = `${root.path}\u0000${normalizedPath}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [toMultiRootAutocompleteItem(root, normalizedPath, false)];
      });
    }
    if (!this.workspaceFiles?.searchWorkspaceFiles) return [];
    const paths = await this.workspaceFiles.searchWorkspaceFiles(
      this.workspaceDir,
      query,
      20,
      signal,
    );
    const seen = new Set<string>();
    return paths.flatMap((path) => {
      const normalizedPath = normalizeWorkspacePath(path);
      if (
        !normalizedPath ||
        !isWorkspaceRelativeReference(normalizedPath) ||
        seen.has(normalizedPath)
      ) {
        return [];
      }
      seen.add(normalizedPath);
      return [
        {
          value: toFileMentionValue(normalizedPath, false),
          label: normalizedPath.split('/').at(-1) ?? normalizedPath,
          description: normalizedPath,
        },
      ];
    });
  }

  private toMultiRootTreeItem(entry: TuiWorkspaceTreeCandidate): AutocompleteItem[] {
    const normalizedPath = normalizeWorkspacePath(entry.path);
    const root = this.workspaceRoots.find((item) => item.path === entry.workspaceDir);
    if (!normalizedPath || !root || !isWorkspaceRelativeReference(normalizedPath)) return [];
    return [
      toMultiRootAutocompleteItem(root, normalizedPath, entry.type === 'directory', entry.name),
    ];
  }
}

function extractFileMentionPrefix(text: string): string | undefined {
  return text.match(/(?:^|[\s])(@(?:"[^"]*|[^\s]*))$/u)?.[1];
}

function readFileMentionQuery(prefix: string): string | undefined {
  if (!prefix.startsWith('@')) return undefined;
  const value = prefix.slice(1);
  if (!value.startsWith('"')) return normalizeWorkspacePath(value, true);
  return normalizeWorkspacePath(value.slice(1, value.endsWith('"') ? -1 : undefined), true);
}

function isWorkspaceRelativeReference(path: string): boolean {
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path)) return false;
  return !path.split('/').some((segment) => segment === '..');
}

function normalizeWorkspacePath(path: string, allowEmpty = false): string | undefined {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\/+/u, '');
  if ((!normalized && !allowEmpty) || normalized.includes('\u0000')) return undefined;
  return normalized;
}

function toWorkspaceTreeAutocompleteItem(entry: TuiWorkspaceFileEntry): AutocompleteItem[] {
  const normalizedPath = normalizeWorkspacePath(entry.path);
  if (!normalizedPath || !isWorkspaceRelativeReference(normalizedPath)) return [];
  const isDirectory = entry.type === 'directory';
  return [
    {
      value: toFileMentionValue(normalizedPath, isDirectory),
      label: `${entry.name}${isDirectory ? '/' : ''}`,
    },
  ];
}

function toFileMentionValue(path: string, isDirectory: boolean): string {
  const completionPath = `${path}${isDirectory && !path.endsWith('/') ? '/' : ''}`;
  return /\s/u.test(completionPath) ? `@"${completionPath}"` : `@${completionPath}`;
}

function normalizeAutocompleteRoots(
  workspace: string | readonly TuiWorkspaceRoot[],
): TuiWorkspaceRoot[] {
  const roots = typeof workspace === 'string' ? [{ path: workspace, primary: true }] : workspace;
  const seen = new Set<string>();
  const normalized = roots.flatMap((root) => {
    const path = root.path.trim();
    if (!path || seen.has(path)) return [];
    seen.add(path);
    return [{ ...root, path }];
  });
  if (normalized.length > 0 && !normalized.some((root) => root.primary)) {
    const first = normalized[0];
    if (first) normalized[0] = { ...first, primary: true };
  }
  return normalized;
}

function toMultiRootAutocompleteItem(
  root: TuiWorkspaceRoot,
  path: string,
  isDirectory: boolean,
  rawName?: string,
): AutocompleteItem {
  const label = root.label?.trim() || workspaceRootLabel(root.path);
  const primary = root.primary === true;
  const reference = primary ? path : joinWorkspacePath(root.path, path);
  const name = rawName ?? path.split('/').at(-1) ?? path;
  return {
    value: toFileMentionValue(reference, isDirectory),
    label: `${name}${isDirectory ? '/' : ''}${primary ? '' : ` · ${label}`}`,
    description: `${label} · ${path}`,
  };
}

function workspaceRootLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, '');
  return normalized.split(/[\\/]/u).at(-1) || normalized;
}

function joinWorkspacePath(root: string, path: string): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/u, '')}${separator}${path.replaceAll('/', separator)}`;
}

function toSlashCommand({
  name,
  description,
  argumentHint,
  getArgumentCompletions,
}: TuiCommand): SlashCommand {
  return {
    name,
    description,
    ...(argumentHint ? { argumentHint } : {}),
    ...(getArgumentCompletions ? { getArgumentCompletions } : {}),
  };
}

function matches(input: string, command: string): boolean {
  return input === command || input.startsWith(`${command} `);
}
