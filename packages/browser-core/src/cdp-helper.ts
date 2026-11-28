/**
 * CDP (Chrome DevTools Protocol) Helper
 * 封装 CDP 相关操作，包括截图、获取可交互元素等
 *
 * 参考 browser-use 的实现，使用三个数据源融合：
 * 1. DOMSnapshot.captureSnapshot - 获取布局信息、计算样式、paint order
 * 2. DOM.getDocument - 获取完整 DOM 树
 * 3. Accessibility.getFullAXTree - 获取可访问性树
 *
 * 增量更新机制：
 * - 监听 DOM 变化事件（childNodeInserted, childNodeRemoved, attributeModified）
 * - 维护 isDirty 标志，只在 DOM 变化时才重新获取元素
 * - 提供 waitForDOMStable 方法，智能等待 DOM 稳定
 */
import type { InteractiveElement } from './browser-core-contracts.js';
import { browserPrintableKeyDescriptor } from './browser-keyboard.js';
import { CDPPageScanner } from './cdp-page-scanner.js';
import type { BrowserTransport } from './browser-transport.js';
import { EDITABLE_FIELD_SOURCE } from './browser-editable-field.js';
import { type CdpExceptionDetails, describeCdpException, isRecord } from './browser-state.js';
import {
  browserInputDiagnosticLogger,
  type BufferedConsoleDiagnosticEntry,
  type CDPConsoleCallFrame,
  type CDPConsoleStackTrace,
  type CDPRemoteObjectSummary,
  formatConsoleStack,
  MAX_CONSOLE_DIAGNOSTIC_ENTRIES,
  MAX_CONSOLE_DIAGNOSTIC_PAGE_BYTES,
  summarizeRemoteObject,
} from './cdp-diagnostic-helpers.js';
import { CDPNetworkDiagnostics } from './cdp-network-diagnostics.js';
import { uploadFilesByBackendNodeId as runFileUpload } from './cdp-file-upload.js';
import {
  abortReason,
  abortableDelay,
  BROWSER_TIMEOUTS,
  isBrowserOperationInterruption,
  throwIfAborted,
  withTimeout,
} from './operation-timeout.js';
import {
  CDPDragError,
  CDPTextInputError,
  DEFAULT_CDP_TIMEOUT_MS,
  DRAG_CANCEL_DATA,
  DRAG_PATH_STEPS,
  type CDPDragData,
  type CDPDragGestureOptions,
  type CDPBackendNodeInspectionOptions,
  type CDPDragGestureResult,
  type CDPEditableState,
  type CDPFocusedEditableState,
  type CDPFileUploadOptions,
  type CDPFileUploadResult,
  type CDPConsoleDiagnosticsOptions,
  type CDPConsoleDiagnosticsPage,
  type CDPNetworkDiagnosticsOptions,
  type CDPNetworkDiagnosticsPage,
  type CDPHoverSemanticSnapshot,
  type CDPRenderedState,
  type FormStateScanOptions,
} from './cdp-helper-contracts.js';
import {
  buildBoundedConsoleDiagnosticMessage,
  MAX_CONSOLE_ARGUMENTS,
  sanitizeConsoleDiagnosticUrl,
} from './console-diagnostic-sanitizer.js';

export type {
  CDPConsoleDiagnosticEntry,
  CDPConsoleDiagnosticLevelFilter,
  CDPConsoleDiagnosticsOptions,
  CDPConsoleDiagnosticsPage,
  CDPNetworkDiagnosticEntry,
  CDPNetworkDiagnosticOutcome,
  CDPNetworkDiagnosticResourceType,
  CDPNetworkDiagnosticStatusFilter,
  CDPNetworkDiagnosticsOptions,
  CDPNetworkDiagnosticsPage,
  CDPDragGestureResult,
  CDPEditableState,
  CDPFileUploadResult,
  CDPFocusedEditableState,
  CDPRenderedState,
} from './cdp-helper-contracts.js';

export { DEFAULT_VIEWPORT } from './cdp-page-scanner.js';

type ListenerInitializationKind = 'base' | 'dom' | 'console' | 'network';

export { sanitizeConsoleDiagnosticUrl } from './console-diagnostic-sanitizer.js';

/**
 * CDP Helper 类
 * 管理 CDP debugger 连接和相关操作
 */
export class CDPHelper {
  private transport: BrowserTransport;
  private cdpDebuggerAttached = false;
  private debuggerResetPromise: Promise<void> | undefined;
  private interruptionRecoveryGeneration = 0;
  private lastInterruptionRecoverySucceeded = true;
  private interruptionRecoveryGuard: (() => boolean) | undefined;
  private dragProbeSequence = 0;
  private pageScanner: CDPPageScanner;

  // DOM 变化监听相关
  private domListenerAttached = false;
  private domListenerDesired = false;
  private domListenerGeneration = 0;
  private domListenerLifecycleController = new AbortController();
  private listenerInitializations = new Map<ListenerInitializationKind, Promise<void>>();
  private domDomainEnabled = false;
  private pageDomainEnabled = false;
  private isDirty = true; // 初始为 true，表示需要获取
  private lastDOMChangeTime = 0;
  private domChangeCount = 0;
  private onDOMChangeCallback: (() => void) | null = null;
  private domEventDisposer: (() => void) | null = null;
  private consoleDiagnosticSequence = 0;
  private consoleDiagnostics: BufferedConsoleDiagnosticEntry[] = [];
  private consoleDiagnosticsEnabled = false;
  private consoleMainFrameId: string | null = null;
  private consoleExecutionContextFrames = new Map<number, string>();
  private networkDiagnosticsEnabled = false;
  private readonly network = new CDPNetworkDiagnostics();
  /** Set by interruption recovery: the re-attached listener keeps the network records. */
  private preserveNetworkOnAttach = false;

  constructor(
    transport: BrowserTransport,
    private readonly getInputCoordinateScale: () => number = () => 1,
  ) {
    this.transport = transport;
    this.pageScanner = this.createPageScanner();
  }

  private createPageScanner(): CDPPageScanner {
    return new CDPPageScanner(
      this.transport,
      (signal) => this.ensureAttached(signal),
      (method, params, timeoutMs, signal) => this.sendCommand(method, params, timeoutMs, signal),
    );
  }

  /** Update the concrete provider transport without changing Browser semantics. */
  setTransport(transport: BrowserTransport): void {
    // 先清理旧的监听器
    this.stopDOMListener();
    void this.transport.close();
    this.transport = transport;
    this.pageScanner = this.createPageScanner();
    this.cdpDebuggerAttached = false;
    this.isDirty = true;
    this.pageScanner.reset();
    this.resetConsoleDiagnostics();
    this.preserveNetworkOnAttach = false;
    this.network.reset(true);
  }

  /** Return the provider transport so adapters can share one debugger owner. */
  getTransport(): BrowserTransport {
    return this.transport;
  }

  /** Latest semantic tree built from the same scan as getInteractiveElements(). */
  getLastSemanticPageTree() {
    return this.pageScanner.getLastSemanticPageTree();
  }

  /**
   * 确保 CDP debugger 已连接
   */
  async ensureAttached(
    signal?: AbortSignal,
    timeoutMs: number = BROWSER_TIMEOUTS.cdpCommand,
  ): Promise<boolean> {
    throwIfAborted(signal);
    if (this.debuggerResetPromise) {
      await withTimeout(this.debuggerResetPromise, timeoutMs, 'CDP debugger reset', { signal });
    }
    await withTimeout(
      (attachSignal) => this.transport.start(attachSignal),
      timeoutMs,
      'CDP debugger attach',
      { signal },
    );
    this.cdpDebuggerAttached = true;
    return true;
  }

  /**
   * 断开 CDP debugger
   */
  detach(): void {
    this.domListenerDesired = false;
    this.removeDOMListener();
    this.resetConsoleDiagnostics();
    this.preserveNetworkOnAttach = false;
    this.network.reset();
    void this.detachDebugger().catch(() => undefined);
  }

  private detachDebugger(force = false): Promise<void> {
    if (!force && !this.cdpDebuggerAttached && !this.debuggerResetPromise) {
      return Promise.resolve();
    }
    this.cdpDebuggerAttached = false;
    if (this.debuggerResetPromise) return this.debuggerResetPromise;

    const reset = this.transport.resetConnection;
    const operation = (async (): Promise<void> => {
      if (reset) {
        // New providers reset the CDP connection without destroying the page.
        await reset.call(this.transport);
      } else {
        // Legacy transports use close() as a debugger detach. New providers
        // must implement resetConnection so timeout recovery is page-safe.
        await this.transport.close();
      }
    })();
    this.debuggerResetPromise = operation;
    const clearReset = (): void => {
      if (this.debuggerResetPromise === operation) this.debuggerResetPromise = undefined;
    };
    void operation.then(clearReset, clearReset);
    return operation;
  }

  private async recoverDebuggerAfterInterruption(
    timeoutMs: number = BROWSER_TIMEOUTS.cdpCommand,
  ): Promise<void> {
    await this.recoverTransportAfterInterruption(timeoutMs);
  }

  /**
   * Defer interruption resets while the guard reports true. A held JavaScript
   * dialog is lost when the debugger reconnects (CDP cannot handle it again
   * and Page.enable stalls), so the connection is kept until it is handled.
   */
  setInterruptionRecoveryGuard(guard: () => boolean): () => void {
    this.interruptionRecoveryGuard = guard;
    return () => {
      if (this.interruptionRecoveryGuard === guard) this.interruptionRecoveryGuard = undefined;
    };
  }

  private isInterruptionRecoveryDeferred(): boolean {
    try {
      return this.interruptionRecoveryGuard?.() === true;
    } catch {
      return false;
    }
  }

  /** Return the helper-owned recovery epoch so Core avoids a duplicate reset. */
  getInterruptionRecoveryState(): { generation: number; succeeded: boolean } {
    return {
      generation: this.interruptionRecoveryGeneration,
      succeeded: this.lastInterruptionRecoverySucceeded,
    };
  }

  /** Reset transport/helper state after interruption; Core direct sends use `force`. */
  async recoverTransportAfterInterruption(
    timeoutMs: number = BROWSER_TIMEOUTS.cdpCommand,
    force = false,
  ): Promise<boolean> {
    // Preserve an earlier helper-owned recovery result; a second no-op detach
    // must not turn a failed reset into a successful one.
    if (!force && !this.cdpDebuggerAttached && !this.debuggerResetPromise) {
      return this.lastInterruptionRecoverySucceeded;
    }
    if (this.isInterruptionRecoveryDeferred()) {
      // The command is blocked by a held JavaScript dialog, not by a broken
      // connection. Keep the connection so the dialog can still be handled.
      this.interruptionRecoveryGeneration += 1;
      this.lastInterruptionRecoverySucceeded = true;
      return true;
    }
    // Recovery keeps the same logical page session: its network records and
    // sequence survive, marked with the reset (in evaluation the query after a
    // timed-out submit came back empty and the model submitted again). Mark
    // first: removing the listener forgets the requests still in flight.
    this.network.markReset();
    this.preserveNetworkOnAttach = true;
    this.removeDOMListener();
    this.pageScanner.reset();
    this.resetConsoleDiagnostics();
    this.isDirty = true;
    let succeeded = false;
    try {
      if (force && !this.transport.resetConnection) return false;
      await withTimeout(this.detachDebugger(force), timeoutMs, 'CDP debugger recovery');
      succeeded = true;
      return true;
    } catch {
      return false;
    } finally {
      this.interruptionRecoveryGeneration += 1;
      this.lastInterruptionRecoverySucceeded = succeeded;
    }
  }

  // ============================================
  // DOM 变化监听机制
  // ============================================

  /**
   * 启动 DOM 变化监听
   * 监听 DOM.childNodeInserted, DOM.childNodeRemoved, DOM.attributeModified 等事件
   */
  async startDOMListener(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.domListenerDesired = true;
    const baseReady = await this.ensureDOMListenerBaseReady(signal);
    if (!baseReady) return;
    await Promise.all([
      this.ensureListenerDomainReady('dom', signal),
      this.ensureListenerDomainReady('console', signal),
      this.ensureListenerDomainReady('network', signal),
    ]);
  }

  startDOMListenerInBackground(): void {
    void this.startDOMListener().catch((error) => {
      browserInputDiagnosticLogger.warn({
        msg: '[EmbeddedBrowserOperation] background-listener-initialization-failed',
        browserSessionId: this.transport.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async waitForListenerInitialization(
    initialization: Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (!signal) {
      await initialization;
      return;
    }

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortReason(signal));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([initialization, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
    throwIfAborted(signal);
  }

  async ensureConsoleDiagnosticsReady(signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    if (this.isConsoleDiagnosticsAvailable()) return true;
    this.domListenerDesired = true;
    if (!(await this.ensureDOMListenerBaseReady(signal))) return false;
    await this.ensureListenerDomainReady('console', signal);
    return this.isConsoleDiagnosticsAvailable();
  }

  async ensureNetworkDiagnosticsReady(signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    if (this.isNetworkDiagnosticsAvailable()) return true;
    this.domListenerDesired = true;
    if (!(await this.ensureDOMListenerBaseReady(signal))) return false;
    await this.ensureListenerDomainReady('network', signal);
    return this.isNetworkDiagnosticsAvailable();
  }

  private async ensureDOMListenerBaseReady(signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    if (this.isDOMListenerBaseReady()) return true;

    const initialization = this.getOrCreateListenerInitialization('base', () => {
      const generation = this.domListenerGeneration;
      return this.initializeDOMListenerBase(generation, this.domListenerLifecycleController.signal);
    });

    await this.waitForListenerInitialization(initialization, signal);
    throwIfAborted(signal);
    return this.isDOMListenerBaseReady();
  }

  private async ensureListenerDomainReady(
    kind: Exclude<ListenerInitializationKind, 'base'>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    throwIfAborted(signal);
    if (this.isListenerDomainReady(kind)) return true;

    const initialization = this.getOrCreateListenerInitialization(kind, () => {
      const generation = this.domListenerGeneration;
      const lifecycleSignal = this.domListenerLifecycleController.signal;
      return kind === 'dom'
        ? this.initializeDOMDomain(generation, lifecycleSignal)
        : this.initializeDiagnosticDomain(
            generation,
            kind === 'console' ? 'Runtime.enable' : 'Network.enable',
            lifecycleSignal,
          );
    });

    await this.waitForListenerInitialization(initialization, signal);
    throwIfAborted(signal);
    return this.isListenerDomainReady(kind);
  }

  private getOrCreateListenerInitialization(
    kind: ListenerInitializationKind,
    create: () => Promise<void>,
  ): Promise<void> {
    const current = this.listenerInitializations.get(kind);
    if (current) return current;

    const initialization = create();
    this.listenerInitializations.set(kind, initialization);
    const clearIfCurrent = () => {
      if (this.listenerInitializations.get(kind) === initialization) {
        this.listenerInitializations.delete(kind);
      }
    };
    void initialization.then(clearIfCurrent, clearIfCurrent);
    return initialization;
  }

  private isListenerDomainReady(kind: Exclude<ListenerInitializationKind, 'base'>): boolean {
    if (kind === 'dom') return this.domDomainEnabled;
    return kind === 'console' ? this.consoleDiagnosticsEnabled : this.networkDiagnosticsEnabled;
  }

  private async enableListenerDomain(
    method: 'DOM.enable' | 'Page.enable' | 'Runtime.enable' | 'Network.enable',
    signal?: AbortSignal,
  ): Promise<{ enabled: boolean; interruption?: unknown }> {
    try {
      await this.sendCommand(method, undefined, BROWSER_TIMEOUTS.cdpCommand, signal);
      return { enabled: true };
    } catch (error) {
      return isBrowserOperationInterruption(error)
        ? { enabled: false, interruption: error }
        : { enabled: false };
    }
  }

  private async initializeDOMListenerBase(generation: number, signal?: AbortSignal): Promise<void> {
    const transport = this.transport;

    const attached = await this.ensureAttached(signal).catch((error) => {
      if (isBrowserOperationInterruption(error)) throw error;
      return false;
    });
    if (!attached) return;

    try {
      if (!this.domListenerAttached) this.attachDOMMessageListener();
      if (!this.isDOMListenerInitializationCurrent(transport, generation)) return;

      if (!this.pageDomainEnabled) {
        const pageEnable = await this.enableListenerDomain('Page.enable', signal);
        if (pageEnable.interruption) throw pageEnable.interruption;
        this.pageDomainEnabled = pageEnable.enabled;
      }
      throwIfAborted(signal);
      if (
        !this.isDOMListenerInitializationCurrent(transport, generation) ||
        !this.pageDomainEnabled
      ) {
        return;
      }

      if (this.consoleMainFrameId === null) {
        let frameTreeResult: Record<string, unknown> | undefined;
        try {
          frameTreeResult = (await this.sendCommand(
            'Page.getFrameTree',
            undefined,
            BROWSER_TIMEOUTS.cdpCommand,
            signal,
          )) as Record<string, unknown>;
        } catch (error) {
          if (isBrowserOperationInterruption(error)) throw error;
        }
        throwIfAborted(signal);
        if (!this.isDOMListenerInitializationCurrent(transport, generation)) return;
        const frameTree = (
          frameTreeResult?.frameTree && typeof frameTreeResult.frameTree === 'object'
            ? frameTreeResult.frameTree
            : {}
        ) as Record<string, unknown>;
        const frame = (
          frameTree.frame && typeof frameTree.frame === 'object' ? frameTree.frame : {}
        ) as Record<string, unknown>;
        this.consoleMainFrameId = typeof frame.id === 'string' ? frame.id : null;
        this.network.mainFrameId = this.consoleMainFrameId;
      }
      if (this.consoleMainFrameId === null) return;
      if (this.network.mainFrameId === null) this.network.mainFrameId = this.consoleMainFrameId;
      this.isDirty = true; // 初始标记为脏，需要获取一次
    } catch (error) {
      if (signal?.aborted || isBrowserOperationInterruption(error)) throw error;
      console.warn('Failed to start DOM listener:', error);
    }
  }

  private async initializeDOMDomain(generation: number, signal?: AbortSignal): Promise<void> {
    const transport = this.transport;
    if (!this.isDOMListenerInitializationCurrent(transport, generation)) return;
    const result = await this.enableListenerDomain('DOM.enable', signal);
    if (result.interruption) throw result.interruption;
    throwIfAborted(signal);
    if (!this.isDOMListenerInitializationCurrent(transport, generation)) return;
    this.domDomainEnabled = result.enabled;
  }

  private async initializeDiagnosticDomain(
    generation: number,
    method: 'Runtime.enable' | 'Network.enable',
    signal?: AbortSignal,
  ): Promise<void> {
    const transport = this.transport;
    if (
      !this.isDOMListenerBaseReady() ||
      !this.isDOMListenerInitializationCurrent(transport, generation)
    ) {
      return;
    }
    const result = await this.enableListenerDomain(method, signal);
    if (result.interruption) throw result.interruption;
    throwIfAborted(signal);
    if (!this.isDOMListenerInitializationCurrent(transport, generation)) return;
    if (method === 'Runtime.enable') {
      this.consoleDiagnosticsEnabled = result.enabled;
    } else {
      this.networkDiagnosticsEnabled = result.enabled;
    }
  }

  private attachDOMMessageListener(): void {
    this.resetConsoleDiagnostics();
    this.resetConsoleDiagnosticScope();
    // A listener after interruption recovery continues the same page's records.
    if (this.preserveNetworkOnAttach) this.preserveNetworkOnAttach = false;
    else this.network.reset();
    this.network.resetScope();
    this.domEventDisposer?.();
    this.domEventDisposer = this.transport.onEvent(({ method, params, sessionId }) => {
      if (
        method === 'DOM.childNodeInserted' ||
        method === 'DOM.childNodeRemoved' ||
        method === 'DOM.attributeModified' ||
        method === 'DOM.attributeRemoved' ||
        method === 'DOM.characterDataModified' ||
        method === 'DOM.childNodeCountUpdated' ||
        method === 'DOM.documentUpdated'
      ) {
        this.markDirty();
      }
      const attachedFrameEvent =
        Boolean(sessionId) &&
        (this.transport.listAttachedFrames?.() ?? []).some(
          (frame) => frame.sessionId === sessionId,
        );
      if (!attachedFrameEvent) this.handleDiagnosticMessage(method, params);
    });
    this.domListenerAttached = true;
  }

  private isDOMListenerInitializationCurrent(
    transport: BrowserTransport,
    generation: number,
  ): boolean {
    return (
      this.domListenerDesired &&
      this.domListenerAttached &&
      this.transport === transport &&
      this.domListenerGeneration === generation
    );
  }

  private isDOMListenerBaseReady(): boolean {
    return (
      this.domListenerAttached &&
      this.pageDomainEnabled &&
      this.consoleMainFrameId !== null &&
      this.network.mainFrameId !== null
    );
  }

  /**
   * 停止 DOM 变化监听
   */
  stopDOMListener(): void {
    this.domListenerDesired = false;
    this.removeDOMListener();
  }

  private removeDOMListener(): void {
    this.domEventDisposer?.();
    this.domEventDisposer = null;

    this.domListenerLifecycleController.abort(new Error('CDP listener lifecycle reset'));
    this.domListenerLifecycleController = new AbortController();
    this.domListenerGeneration += 1;
    this.listenerInitializations.clear();
    this.domListenerAttached = false;
    this.domDomainEnabled = false;
    this.pageDomainEnabled = false;
    this.consoleDiagnosticsEnabled = false;
    this.networkDiagnosticsEnabled = false;
    this.resetConsoleDiagnosticScope();
    this.network.resetScope();
  }

  getConsoleDiagnostics(options: CDPConsoleDiagnosticsOptions = {}): CDPConsoleDiagnosticsPage {
    const requestedLimit = Number.isFinite(options.limit) ? Number(options.limit) : 100;
    const limit = Math.max(1, Math.min(MAX_CONSOLE_DIAGNOSTIC_ENTRIES, Math.floor(requestedLimit)));
    const requestedLevels = new Set<string>(
      (options.levels ?? []).map((level) => (level === 'warning' ? 'warn' : level)),
    );
    const filter = options.filter ?? '';
    const filteredEntries = this.consoleDiagnostics.filter((entry) => {
      const normalizedLevel = entry.level === 'warning' ? 'warn' : entry.level;
      return (
        (requestedLevels.size === 0 || requestedLevels.has(normalizedLevel)) &&
        (filter.length === 0 || entry.message.includes(filter))
      );
    });
    const totalEntries = filteredEntries.length;
    const limitedEntries = filteredEntries.slice(Math.max(0, totalEntries - limit));
    const entries: BufferedConsoleDiagnosticEntry[] = [];
    for (let index = limitedEntries.length - 1; index >= 0; index -= 1) {
      const entry = limitedEntries[index];
      if (!entry) continue;
      const candidateEntries = [entry, ...entries];
      const candidatePage: CDPConsoleDiagnosticsPage = {
        entries: candidateEntries,
        totalEntries,
        returnedEntries: candidateEntries.length,
        truncated: candidateEntries.length < totalEntries,
      };
      if (
        Buffer.byteLength(JSON.stringify(candidatePage), 'utf8') > MAX_CONSOLE_DIAGNOSTIC_PAGE_BYTES
      ) {
        break;
      }
      entries.unshift(entry);
    }
    return {
      entries: entries.map((entry) => {
        const publicEntry = { ...entry };
        delete publicEntry.exceptionId;
        return {
          ...publicEntry,
          ...(entry.stack ? { stack: [...entry.stack] } : {}),
        };
      }),
      totalEntries,
      returnedEntries: entries.length,
      truncated: entries.length < totalEntries,
    };
  }

  getNetworkDiagnostics(options: CDPNetworkDiagnosticsOptions = {}): CDPNetworkDiagnosticsPage {
    return this.network.page(options);
  }

  isConsoleDiagnosticsAvailable(): boolean {
    return (
      this.domListenerAttached &&
      this.pageDomainEnabled &&
      this.consoleDiagnosticsEnabled &&
      this.consoleMainFrameId !== null
    );
  }

  isNetworkDiagnosticsAvailable(): boolean {
    return (
      this.domListenerAttached &&
      this.pageDomainEnabled &&
      this.networkDiagnosticsEnabled &&
      this.network.mainFrameId !== null
    );
  }

  getMainFrameId(): string | null {
    return this.consoleMainFrameId;
  }

  private handleDiagnosticMessage(method: string, params: unknown): void {
    const payload = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
    if (method.startsWith('Network.')) {
      this.network.handleMessage(method, payload);
      return;
    }
    if (method === 'Runtime.executionContextCreated') {
      const context = (
        payload.context && typeof payload.context === 'object' ? payload.context : {}
      ) as Record<string, unknown>;
      const auxData = (
        context.auxData && typeof context.auxData === 'object' ? context.auxData : {}
      ) as Record<string, unknown>;
      if (typeof context.id === 'number') {
        if (typeof auxData.frameId === 'string' && auxData.isDefault !== false) {
          this.consoleExecutionContextFrames.set(context.id, auxData.frameId);
        } else {
          this.consoleExecutionContextFrames.delete(context.id);
        }
      }
      return;
    }
    if (method === 'Runtime.executionContextDestroyed') {
      if (typeof payload.executionContextId === 'number') {
        this.consoleExecutionContextFrames.delete(payload.executionContextId);
      }
      return;
    }
    if (method === 'Runtime.executionContextsCleared') {
      this.consoleExecutionContextFrames.clear();
      return;
    }
    if (method === 'Runtime.exceptionRevoked') {
      if (typeof payload.exceptionId === 'number') {
        this.consoleDiagnostics = this.consoleDiagnostics.filter(
          (entry) => entry.exceptionId !== payload.exceptionId,
        );
      }
      return;
    }
    if (method === 'Page.frameNavigated') {
      const frame = (
        payload.frame && typeof payload.frame === 'object' ? payload.frame : {}
      ) as Record<string, unknown>;
      if (!frame.parentId) {
        this.resetConsoleDiagnostics();
        this.network.resetForNavigation(
          typeof frame.loaderId === 'string' ? frame.loaderId : undefined,
        );
        this.consoleExecutionContextFrames.clear();
        this.consoleMainFrameId = typeof frame.id === 'string' ? frame.id : null;
        this.network.mainFrameId = this.consoleMainFrameId;
      }
      return;
    }
    if (method === 'Page.frameDetached') {
      if (typeof payload.frameId === 'string') {
        if (payload.frameId === this.consoleMainFrameId) {
          this.resetConsoleDiagnostics();
          this.network.reset();
          this.resetConsoleDiagnosticScope();
          this.network.resetScope();
          return;
        }
        for (const [contextId, frameId] of this.consoleExecutionContextFrames) {
          if (frameId === payload.frameId) this.consoleExecutionContextFrames.delete(contextId);
        }
      }
      return;
    }
    if (method === 'Runtime.consoleAPICalled') {
      const level = typeof payload.type === 'string' ? payload.type : 'log';
      const args = Array.isArray(payload.args)
        ? (payload.args as CDPRemoteObjectSummary[])
            .slice(0, MAX_CONSOLE_ARGUMENTS)
            .map((remote) => summarizeRemoteObject(remote) || '<value>')
        : [];
      const stackTrace = payload.stackTrace as CDPConsoleStackTrace | undefined;
      const firstFrame = stackTrace?.callFrames?.[0];
      const stack = formatConsoleStack(stackTrace);
      this.releaseConsoleRemoteObjects(payload.args);
      if (!this.isMainFrameConsoleContext(payload.executionContextId)) return;
      this.appendConsoleDiagnostic({
        source: 'console',
        level,
        timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
        message: buildBoundedConsoleDiagnosticMessage(args, `[console.${level}]`),
        ...this.consoleLocation(firstFrame),
        ...(stack ? { stack } : {}),
      });
      return;
    }
    if (method !== 'Runtime.exceptionThrown') return;

    const details = (
      payload.exceptionDetails && typeof payload.exceptionDetails === 'object'
        ? payload.exceptionDetails
        : {}
    ) as Record<string, unknown>;
    const exception = (
      details.exception && typeof details.exception === 'object' ? details.exception : {}
    ) as CDPRemoteObjectSummary;
    const stackTrace = details.stackTrace as CDPConsoleStackTrace | undefined;
    const stack = formatConsoleStack(stackTrace);
    const message =
      summarizeRemoteObject(exception) || String(details.text || 'Uncaught exception');
    this.releaseConsoleRemoteObjects([exception]);
    if (!this.isMainFrameConsoleContext(details.executionContextId)) return;
    this.appendConsoleDiagnostic({
      source: 'exception',
      level: 'error',
      timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
      message: buildBoundedConsoleDiagnosticMessage([message], 'Uncaught exception'),
      ...(typeof details.exceptionId === 'number' ? { exceptionId: details.exceptionId } : {}),
      ...this.consoleLocation({
        url: typeof details.url === 'string' ? details.url : undefined,
        lineNumber: typeof details.lineNumber === 'number' ? details.lineNumber : undefined,
        columnNumber: typeof details.columnNumber === 'number' ? details.columnNumber : undefined,
      }),
      ...(stack ? { stack } : {}),
    });
  }

  private consoleLocation(frame?: CDPConsoleCallFrame): {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  } {
    if (!frame) return {};
    return {
      ...(frame.url ? { url: sanitizeConsoleDiagnosticUrl(frame.url) } : {}),
      ...(typeof frame.lineNumber === 'number'
        ? { lineNumber: Math.max(0, frame.lineNumber) + 1 }
        : {}),
      ...(typeof frame.columnNumber === 'number'
        ? { columnNumber: Math.max(0, frame.columnNumber) + 1 }
        : {}),
    };
  }

  private appendConsoleDiagnostic(entry: Omit<BufferedConsoleDiagnosticEntry, 'sequence'>): void {
    this.consoleDiagnosticSequence += 1;
    this.consoleDiagnostics.push({ sequence: this.consoleDiagnosticSequence, ...entry });
    if (this.consoleDiagnostics.length > MAX_CONSOLE_DIAGNOSTIC_ENTRIES) {
      this.consoleDiagnostics.splice(
        0,
        this.consoleDiagnostics.length - MAX_CONSOLE_DIAGNOSTIC_ENTRIES,
      );
    }
  }

  private releaseConsoleRemoteObjects(value: unknown): void {
    if (!Array.isArray(value)) return;
    const objectIds = new Set(
      (value as CDPRemoteObjectSummary[])
        .map((remote) => remote.objectId)
        .filter(
          (objectId): objectId is string => typeof objectId === 'string' && objectId.length > 0,
        ),
    );
    for (const objectId of objectIds) {
      void this.transport.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }

  private resetConsoleDiagnostics(): void {
    this.consoleDiagnosticSequence = 0;
    this.consoleDiagnostics = [];
  }

  private resetConsoleDiagnosticScope(): void {
    this.consoleMainFrameId = null;
    this.consoleExecutionContextFrames.clear();
  }

  private isMainFrameConsoleContext(executionContextId: unknown): boolean {
    return (
      typeof executionContextId === 'number' &&
      this.consoleMainFrameId !== null &&
      this.consoleExecutionContextFrames.get(executionContextId) === this.consoleMainFrameId
    );
  }

  /**
   * 标记 DOM 为脏（需要重新获取）
   */
  markDirty(): void {
    this.isDirty = true;
    this.lastDOMChangeTime = Date.now();
    this.domChangeCount++;

    // 触发回调
    if (this.onDOMChangeCallback) {
      this.onDOMChangeCallback();
    }
  }

  /**
   * 检查 DOM 是否需要更新
   */
  needsUpdate(): boolean {
    return this.isDirty;
  }

  /**
   * 清除脏标记（在成功获取元素后调用）
   */
  clearDirty(): void {
    this.isDirty = false;
    this.domChangeCount = 0;
  }

  /**
   * 设置 DOM 变化回调
   */
  onDOMChange(callback: (() => void) | null): void {
    this.onDOMChangeCallback = callback;
  }

  /**
   * 等待 DOM 稳定
   * 智能等待：在 DOM 停止变化后返回
   *
   * @param options 配置选项
   * @param options.timeout 最大等待时间（毫秒），默认 3000
   * @param options.stableTime DOM 稳定时间（毫秒），默认 200
   * @param options.minWait 最小等待时间（毫秒），默认 100
   */
  async waitForDOMStable(options?: {
    timeout?: number;
    stableTime?: number;
    minWait?: number;
    signal?: AbortSignal;
  }): Promise<void> {
    const { timeout = 3000, stableTime = 200, minWait = 100, signal } = options || {};

    const startTime = Date.now();
    const startChangeCount = this.domChangeCount;

    // 最小等待
    await this.sleep(minWait, signal);

    // 等待 DOM 稳定
    while (Date.now() - startTime < timeout) {
      const timeSinceLastChange = Date.now() - this.lastDOMChangeTime;

      // 如果距离上次变化已经超过 stableTime，认为 DOM 已稳定
      if (timeSinceLastChange >= stableTime) {
        break;
      }

      // 如果变化次数没有增加且已经等待了一段时间，也认为稳定
      if (this.domChangeCount === startChangeCount && Date.now() - startTime >= stableTime) {
        break;
      }

      // 继续等待
      await this.sleep(50, signal);
    }

    // 标记为脏，因为我们要获取新状态
    this.isDirty = true;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return abortableDelay(ms, signal);
  }

  /**
   * 发送 CDP 命令
   *
   * 带超时保护：个别命令（典型是对未合成页面的 Page.captureScreenshot）会
   * 永久挂起；不设上限会拖满 broker 的 30s 工具超时并连环卡死后续调用。
   */
  async sendCommand(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = DEFAULT_CDP_TIMEOUT_MS,
    signal?: AbortSignal,
    commandSessionId?: string,
  ): Promise<unknown> {
    const attached = await this.ensureAttached(signal, timeoutMs);
    if (!attached) {
      throw new Error('Failed to attach CDP debugger');
    }

    try {
      return await withTimeout(
        (commandSignal) =>
          this.transport.send(method, params, commandSessionId, {
            signal: commandSignal,
            timeoutMs,
          }) as Promise<unknown>,
        timeoutMs,
        `CDP ${method}`,
        { signal },
      );
    } catch (error) {
      // Electron exposes no per-command CDP cancellation primitive. Detaching
      // is the only bounded way to reject a stuck debugger request; the next
      // command reattaches through ensureAttached().
      if (isBrowserOperationInterruption(error)) {
        await this.recoverDebuggerAfterInterruption(timeoutMs);
      }
      throw error;
    }
  }

  /**
   * Browser targets use the visible main-frame viewport in CSS pixels. The
   * legacy metrics are native/display coordinates and must not leak into
   * Agent target resolution.
   */
  async getCssViewportSize(): Promise<{ width: number; height: number }> {
    const metrics = (await this.sendCommand('Page.getLayoutMetrics')) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
    };
    const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
    const width = Number(viewport?.clientWidth);
    const height = Number(viewport?.clientHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('CSS viewport metrics unavailable');
    }
    return { width, height };
  }

  private inputScale(): number {
    const scale = Number(this.getInputCoordinateScale());
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

  private inputPoint(point: { x: number; y: number }): { x: number; y: number } {
    const scale = this.inputScale();
    return {
      x: Math.round(point.x * scale),
      y: Math.round(point.y * scale),
    };
  }

  async dispatchMouseMove(x: number, y: number): Promise<void> {
    const point = this.inputPoint({ x, y });
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
  }

  async dispatchMouseWheel(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    const scale = this.inputScale();
    const point = this.inputPoint({ x, y });
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: deltaX * scale,
      deltaY: deltaY * scale,
    });
  }

  /**
   * Chromium drag state machine, aligned with Playwright's Chromium DragManager.
   * Project-specific adapters are limited to the source/target path and the
   * Provider frame-evaluation/CDP transport.
   */
  async dispatchDragGesture(
    source: { x: number; y: number },
    target: { x: number; y: number },
    options: CDPDragGestureOptions = {},
  ): Promise<CDPDragGestureResult> {
    const signal = options.signal;
    const commandTimeoutMs = Math.max(1, options.commandTimeoutMs ?? DEFAULT_CDP_TIMEOUT_MS);
    const send = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
      this.sendCommand(method, params, commandTimeoutMs, signal);
    // Cleanup deliberately ignores the cancelled action signal. A bounded
    // release is required so the next Browser action never inherits a pressed
    // pointer or enabled drag interception.
    const cleanupSend = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
      this.sendCommand(method, params, Math.min(commandTimeoutMs, 1_000));
    const inputSource = this.inputPoint(source);
    const inputTarget = this.inputPoint(target);
    const points = Array.from({ length: DRAG_PATH_STEPS }, (_, index) => {
      const ratio = (index + 1) / DRAG_PATH_STEPS;
      return {
        x: Math.round(inputSource.x + (inputTarget.x - inputSource.x) * ratio),
        y: Math.round(inputSource.y + (inputTarget.y - inputSource.y) * ratio),
      };
    });
    let dragData: CDPDragData | null = null;
    let resolveDragData: ((data: CDPDragData) => void) | undefined;
    const dragDataPromise = new Promise<CDPDragData>((resolve) => {
      resolveDragData = resolve;
    });
    let dragEventDisposer: (() => void) | null = null;

    let interceptEnabled = false;
    let listenerAttached = false;
    let pointerDown = false;
    let lastPoint = inputSource;
    let finishDragProbe: (() => Promise<boolean>) | null = null;

    const stopInterception = async (): Promise<void> => {
      if (listenerAttached) {
        dragEventDisposer?.();
        dragEventDisposer = null;
        listenerAttached = false;
      }
      if (interceptEnabled) {
        await cleanupSend('Input.setInterceptDrags', { enabled: false });
        interceptEnabled = false;
      }
    };

    const releasePointer = async (): Promise<void> => {
      if (!pointerDown) return;
      await cleanupSend('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: lastPoint.x,
        y: lastPoint.y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      pointerDown = false;
    };

    try {
      throwIfAborted(signal);
      let expectingDrag = false;
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: inputSource.x,
        y: inputSource.y,
        button: 'none',
        buttons: 0,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: inputSource.x,
        y: inputSource.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      pointerDown = true;

      // Playwright only intercepts the first pressed move. The initial move to
      // source must happen before this probe or it consumes the one-shot listener.
      finishDragProbe = await this.installDragStartProbe(signal, commandTimeoutMs);
      dragEventDisposer = this.transport.onEvent(({ method, params }) => {
        if (method !== 'Input.dragIntercepted' || !isRecord(params) || !isRecord(params.data)) {
          return;
        }
        dragData = params.data as unknown as CDPDragData;
        resolveDragData?.(dragData);
      });
      listenerAttached = true;
      await send('Input.setInterceptDrags', { enabled: true });
      interceptEnabled = true;

      try {
        lastPoint = points[0]!;
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: lastPoint.x,
          y: lastPoint.y,
          button: 'left',
          buttons: 1,
        });
        expectingDrag = await finishDragProbe();
        throwIfAborted(signal);
        finishDragProbe = null;
      } finally {
        await stopInterception();
      }

      if (expectingDrag) {
        dragData ??= await this.waitForDragData(
          dragDataPromise,
          options.interceptTimeoutMs ?? DEFAULT_CDP_TIMEOUT_MS,
          signal,
        );
      } else {
        dragData = null;
      }

      if (dragData) {
        pointerDown = false;
        try {
          await send('Input.dispatchDragEvent', {
            type: 'dragEnter',
            x: lastPoint.x,
            y: lastPoint.y,
            data: dragData,
          });
          for (const point of points.slice(1)) {
            lastPoint = point;
            await send('Input.dispatchDragEvent', {
              type: 'dragOver',
              x: point.x,
              y: point.y,
              data: dragData,
            });
          }
          await send('Input.dispatchDragEvent', {
            type: 'drop',
            x: inputTarget.x,
            y: inputTarget.y,
            data: dragData,
          });
        } catch (error) {
          await cleanupSend('Input.dispatchDragEvent', {
            type: 'dragCancel',
            x: lastPoint.x,
            y: lastPoint.y,
            data: DRAG_CANCEL_DATA,
          }).catch(() => undefined);
          if (isBrowserOperationInterruption(error)) throw error;
          throw new CDPDragError(
            'DROP_DISPATCH_FAILED',
            `Failed to dispatch HTML5 drag: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return { mode: 'html5', dragStarted: true, dropDispatched: true };
      }

      for (const point of points.slice(1)) {
        lastPoint = point;
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: point.x,
          y: point.y,
          button: 'left',
          buttons: 1,
        });
      }
      lastPoint = inputTarget;
      await releasePointer();
      return { mode: 'pointer', dragStarted: true, dropDispatched: false };
    } catch (error) {
      await releasePointer().catch(() => undefined);
      throw error;
    } finally {
      if (finishDragProbe) await finishDragProbe().catch(() => false);
      await stopInterception();
    }
  }

  private async waitForDragData(
    dragDataPromise: Promise<CDPDragData>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CDPDragData> {
    try {
      return await withTimeout(dragDataPromise, Math.max(1, timeoutMs), 'Chromium drag data', {
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new CDPDragError(
        'DRAG_DATA_UNAVAILABLE',
        `Chromium did not provide DragData within ${timeoutMs}ms.`,
      );
    }
  }

  private async installDragStartProbe(
    signal?: AbortSignal,
    timeoutMs = DEFAULT_CDP_TIMEOUT_MS,
  ): Promise<() => Promise<boolean>> {
    const probeKey = `__mavisDragProbe_${Date.now()}_${this.dragProbeSequence++}`;
    const serializedKey = JSON.stringify(probeKey);
    const setupScript = `(() => {
      const key = ${serializedKey};
      let dragEvent = null;
      let didStartDrag = Promise.resolve(false);
      const onDragStart = (event) => { dragEvent = event; };
      const onMouseMove = () => {
        didStartDrag = new Promise((resolve) => {
          window.addEventListener('dragstart', onDragStart, { once: true, capture: true });
          setTimeout(() => resolve(Boolean(dragEvent && !dragEvent.defaultPrevented)), 0);
        });
      };
      window.addEventListener('mousemove', onMouseMove, { once: true, capture: true });
      window[key] = async () => {
        const result = await didStartDrag;
        window.removeEventListener('mousemove', onMouseMove, { capture: true });
        window.removeEventListener('dragstart', onDragStart, { capture: true });
        delete window[key];
        return result;
      };
      return true;
    })()`;

    const evaluateAll = async <T>(expression: string): Promise<readonly T[]> => {
      if (this.transport.evaluateInAllFrames) {
        return this.transport.evaluateInAllFrames<T>(expression, { signal, timeoutMs });
      }
      return [await this.transport.evaluate<T>(expression, { signal, timeoutMs })];
    };
    try {
      await evaluateAll(setupScript);
    } catch (error) {
      if (isBrowserOperationInterruption(error)) throw error;
      return async () => false;
    }

    let finished = false;
    return async () => {
      if (finished) return false;
      finished = true;
      const results = await evaluateAll<boolean>(
        `window[${serializedKey}] ? window[${serializedKey}]() : false`,
      ).catch((error) => {
        if (isBrowserOperationInterruption(error)) throw error;
        return [];
      });
      return results.some(Boolean);
    };
  }

  /**
   * 使用 CDP 截图
   * 支持窗口最小化/不可见时截图
   */
  async captureScreenshot(): Promise<{
    data: string;
    width: number;
    height: number;
  }>;
  async captureScreenshot(options?: {
    scope?: 'viewport' | 'fullPage' | 'clip';
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<{ data: string; width: number; height: number }>;
  async captureScreenshot(
    options: {
      scope?: 'viewport' | 'fullPage' | 'clip';
      clip?: { x: number; y: number; width: number; height: number };
    } = {},
  ): Promise<{
    data: string;
    width: number;
    height: number;
  }> {
    let clip = options.scope === 'clip' ? options.clip : undefined;
    if (options.scope === 'fullPage') {
      const metrics = (await this.sendCommand('Page.getLayoutMetrics')) as {
        cssContentSize?: { width?: number; height?: number };
        contentSize?: { width?: number; height?: number };
      };
      const size = metrics.cssContentSize ?? metrics.contentSize;
      const width = Math.max(1, Math.ceil(size?.width ?? 1));
      const height = Math.max(1, Math.ceil(size?.height ?? 1));
      clip = { x: 0, y: 0, width, height };
    }
    const result = (await this.sendCommand(
      'Page.captureScreenshot',
      {
        format: 'png',
        captureBeyondViewport: options.scope === 'fullPage',
        ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
      },
      8_000,
    )) as { data: string };

    const buffer = Buffer.from(result.data, 'base64');

    // 获取图片尺寸（通过解析 PNG header）
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);

    return {
      data: result.data,
      width,
      height,
    };
  }

  // ============================================
  // 基于 backendNodeId 的元素操作
  // ============================================

  /**
   * 通过 backendNodeId 获取元素的盒模型（边界框）
   */
  async getBoxModelByBackendNodeId(
    backendNodeId: number,
    signal?: AbortSignal,
  ): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
  }> {
    const result = (await this.sendCommand(
      'DOM.getBoxModel',
      { backendNodeId },
      BROWSER_TIMEOUTS.cdpCommand,
      signal,
    )) as {
      model: {
        content: number[];
        padding: number[];
        border: number[];
        margin: number[];
        width: number;
        height: number;
      };
    };

    // content 是 [x1,y1, x2,y2, x3,y3, x4,y4] 四个角的坐标（顺时针）
    const content = result.model.content;
    if (content.length < 6) throw new Error('DOM box model content quad is incomplete');
    const x = content[0]!;
    const y = content[1]!;
    const width = content[2]! - x;
    const height = content[5]! - y;
    const centerX = x + width / 2;
    const centerY = y + height / 2;

    return { x, y, width, height, centerX, centerY };
  }

  /**
   * 通过 backendNodeId 滚动元素到视口
   */
  async scrollIntoViewByBackendNodeId(backendNodeId: number, signal?: AbortSignal): Promise<void> {
    await this.sendCommand(
      'DOM.scrollIntoViewIfNeeded',
      { backendNodeId },
      BROWSER_TIMEOUTS.cdpCommand,
      signal,
    );
  }

  /**
   * 通过 backendNodeId 聚焦元素
   */
  async focusByBackendNodeId(backendNodeId: number): Promise<void> {
    await this.sendCommand('DOM.focus', {
      backendNodeId,
    });
  }

  /**
   * 通过 backendNodeId 获取元素的 nodeId（用于某些需要 nodeId 的操作）
   */
  async resolveNodeId(backendNodeId: number): Promise<number> {
    const result = (await this.sendCommand('DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: [backendNodeId],
    })) as { nodeIds: number[] };

    if (!result.nodeIds || result.nodeIds.length === 0) {
      throw new Error(`Failed to resolve nodeId for backendNodeId: ${backendNodeId}`);
    }

    const nodeId = result.nodeIds[0];
    if (nodeId === undefined) throw new Error(`Failed to resolve nodeId: ${backendNodeId}`);
    return nodeId;
  }

  /**
   * 通过 backendNodeId 获取元素的属性
   */
  async getAttributesByBackendNodeId(backendNodeId: number): Promise<Record<string, string>> {
    const nodeId = await this.resolveNodeId(backendNodeId);
    const result = (await this.sendCommand('DOM.getAttributes', {
      nodeId,
    })) as { attributes: string[] };

    const attrs: Record<string, string> = {};
    if (result.attributes) {
      for (let i = 0; i < result.attributes.length; i += 2) {
        const name = result.attributes[i];
        const value = result.attributes[i + 1];
        if (name !== undefined && value !== undefined) attrs[name] = value;
      }
    }
    return attrs;
  }

  /**
   * 通过 backendNodeId 设置元素的属性
   */
  async setAttributeByBackendNodeId(
    backendNodeId: number,
    name: string,
    value: string,
  ): Promise<void> {
    const nodeId = await this.resolveNodeId(backendNodeId);
    await this.sendCommand('DOM.setAttributeValue', {
      nodeId,
      name,
      value,
    });
  }

  /**
   * 通过 backendNodeId 获取元素的 outerHTML
   */
  async getOuterHTMLByBackendNodeId(backendNodeId: number): Promise<string> {
    const result = (await this.sendCommand('DOM.getOuterHTML', {
      backendNodeId,
    })) as { outerHTML: string };
    return result.outerHTML;
  }

  /**
   * 通过 CDP Input 域发送点击事件
   * 这种方式更接近真实用户操作
   */
  async dispatchClickEvent(
    x: number,
    y: number,
    options?: {
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
      delay?: number;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    const point = this.inputPoint({ x, y });
    const button = options?.button || 'left';
    const requestedClickCount = options?.clickCount ?? 1;
    const clickCount = Number.isFinite(requestedClickCount)
      ? Math.max(1, Math.floor(requestedClickCount))
      : 1;
    const delay = options?.delay ?? 50;
    const signal = options?.signal;

    // 移动鼠标
    await this.sendCommand(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
      },
      BROWSER_TIMEOUTS.cdpCommand,
      signal,
    );

    await this.sleep(delay, signal);

    // CDP 的 clickCount 只是当前点击序号，不能替代前面的点击序列。
    // 双击必须依次发送 clickCount=1 和 clickCount=2，页面才会收到
    // 两次 click 以及最终的 dblclick。
    for (let currentClick = 1; currentClick <= clickCount; currentClick += 1) {
      await this.sendCommand(
        'Input.dispatchMouseEvent',
        {
          type: 'mousePressed',
          x: point.x,
          y: point.y,
          button,
          clickCount: currentClick,
        },
        BROWSER_TIMEOUTS.cdpCommand,
        signal,
      );

      await this.sleep(delay, signal);

      await this.sendCommand(
        'Input.dispatchMouseEvent',
        {
          type: 'mouseReleased',
          x: point.x,
          y: point.y,
          button,
          clickCount: currentClick,
        },
        BROWSER_TIMEOUTS.cdpCommand,
        signal,
      );

      if (currentClick < clickCount) await this.sleep(delay, signal);
    }
  }

  /**
   * 通过 backendNodeId 点击元素
   * 自动滚动到视口并点击元素中心
   */
  async clickByBackendNodeId(
    backendNodeId: number,
    options?: {
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
      delay?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ x: number; y: number }> {
    // 1. 先滚动元素到视口
    await this.scrollIntoViewByBackendNodeId(backendNodeId, options?.signal);
    await this.sleep(100, options?.signal);

    // 2. 获取元素位置
    const box = await this.getBoxModelByBackendNodeId(backendNodeId, options?.signal);

    // 3. 点击元素中心
    await this.dispatchClickEvent(box.centerX, box.centerY, options);

    return { x: box.centerX, y: box.centerY };
  }

  /**
   * Select all content owned by the currently focused editable target.
   *
   * Input commands intentionally stay on the root CDP session even when DOM.focus was routed to
   * an OOPIF session. Chromium forwards trusted keyboard input to the page's actual focused node.
   */
  async selectAllAtCurrentFocus(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<void> {
    const selectAllModifiers = process.platform === 'darwin' ? 4 : 2;
    const timeoutMs = options?.timeoutMs ?? BROWSER_TIMEOUTS.cdpCommand;
    await this.sendCommand(
      'Input.dispatchKeyEvent',
      {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        modifiers: selectAllModifiers,
        commands: ['SelectAll'],
      },
      timeoutMs,
      options?.signal,
    );
    await this.sendCommand(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: selectAllModifiers },
      timeoutMs,
      options?.signal,
    );
  }

  /**
   * 通过 backendNodeId 输入文本
   * 先聚焦元素，然后输入文本
   */
  async typeByBackendNodeId(
    backendNodeId: number,
    text: string,
    options?: {
      clear?: boolean;
      delay?: number;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    const signal = options?.signal;
    throwIfAborted(signal);
    // 1. 滚动到视口并聚焦
    await this.scrollIntoViewByBackendNodeId(backendNodeId);
    await this.sleep(50, signal);
    await this.focusByBackendNodeId(backendNodeId);
    await this.sleep(50, signal);

    // 2. 如果需要清空，先全选再删除
    if (options?.clear) {
      await this.selectAllAtCurrentFocus({ signal });
      await this.sleep(50, signal);
    }

    // 3. 输入文本
    if (options?.delay && options.delay > 0) {
      // 逐字符输入
      for (const char of text) {
        await this.sendCommand(
          'Input.insertText',
          { text: char },
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        );
        await this.sleep(options.delay, signal);
      }
    } else {
      // 一次性输入
      await this.sendCommand('Input.insertText', { text }, BROWSER_TIMEOUTS.cdpCommand, signal);
    }
  }

  /**
   * Activate a visible virtual-editor host, then deliver real keyboard events to the editable
   * proxy that the page focused. The proxy is intentionally resolved from current focus instead
   * of being persisted in the model-facing ref.
   */
  async typeAtCurrentFocusByBackendNodeId(
    backendNodeId: number,
    text: string,
    options?: {
      clear?: boolean;
      delay?: number;
      signal?: AbortSignal;
    },
  ): Promise<CDPRenderedState> {
    const signal = options?.signal;
    if (signal) await this.clickByBackendNodeId(backendNodeId, { signal });
    else await this.clickByBackendNodeId(backendNodeId);
    await this.sleep(50, signal);

    const focused = await this.inspectFocusedEditableStateByBackendNodeId(backendNodeId);
    if (!focused.focused || !focused.editable || !focused.withinTarget) {
      throw new CDPTextInputError(
        'INPUT_FOCUS_REJECTED',
        'INPUT_FOCUS_REJECTED: activating the editor host did not focus its editable proxy',
      );
    }
    const renderedBeforeInput = await this.inspectRenderedStateByBackendNodeId(backendNodeId);

    if (options?.clear) {
      await this.selectAllAtCurrentFocus({ signal });
      await this.sendCommand(
        'Input.dispatchKeyEvent',
        {
          type: 'keyDown',
          key: 'Backspace',
          code: 'Backspace',
          windowsVirtualKeyCode: 8,
        },
        BROWSER_TIMEOUTS.cdpCommand,
        signal,
      );
      await this.sendCommand(
        'Input.dispatchKeyEvent',
        {
          type: 'keyUp',
          key: 'Backspace',
          code: 'Backspace',
          windowsVirtualKeyCode: 8,
        },
        BROWSER_TIMEOUTS.cdpCommand,
        signal,
      );
      await this.sleep(50, signal);
    }

    for (const char of text) {
      const key = browserPrintableKeyDescriptor(char);
      if (!key) {
        // Unicode and IME text keep the browser-native insertion path until composition support is
        // available. ASCII editor commands always use the complete keyboard event path above.
        await this.sendCommand(
          'Input.insertText',
          { text: char },
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        );
      } else {
        await this.sendCommand(
          'Input.dispatchKeyEvent',
          {
            type: 'keyDown',
            key: key.key,
            code: key.code,
            windowsVirtualKeyCode: key.windowsVirtualKeyCode,
            modifiers: key.modifiers,
          },
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        );
        await this.sendCommand(
          'Input.dispatchKeyEvent',
          {
            type: 'char',
            key: key.key,
            text: char,
            unmodifiedText: char,
          },
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        );
        await this.sendCommand(
          'Input.dispatchKeyEvent',
          {
            type: 'keyUp',
            key: key.key,
            code: key.code,
            windowsVirtualKeyCode: key.windowsVirtualKeyCode,
            modifiers: key.modifiers,
          },
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        );
      }
      if (options?.delay && options.delay > 0) await this.sleep(options.delay, signal);
    }
    return renderedBeforeInput;
  }

  async uploadFilesByBackendNodeId(
    backendNodeId: number,
    files: string[],
    options: CDPFileUploadOptions = {},
  ): Promise<CDPFileUploadResult> {
    return runFileUpload(
      {
        ensureAttached: () =>
          this.ensureAttached(options.signal, options.timeoutMs ?? BROWSER_TIMEOUTS.cdpCommand),
        sendCommand: (method, params) =>
          this.sendCommand(
            method,
            params,
            options.timeoutMs ?? BROWSER_TIMEOUTS.cdpCommand,
            options.signal,
          ),
        sendCleanupCommand: (method, params) =>
          this.sendCommand(method, params, options.timeoutMs ?? BROWSER_TIMEOUTS.cdpCommand),
        onEvent: (listener) => this.transport.onEvent(listener),
        clickByBackendNodeId: (targetId) =>
          this.clickByBackendNodeId(targetId, { signal: options.signal }),
        callFunctionOnBackendNode: <T>(targetId: number, declaration: string) =>
          this.callFunctionOnBackendNode<T>(
            targetId,
            declaration,
            [],
            options.signal,
            options.timeoutMs ?? BROWSER_TIMEOUTS.cdpCommand,
          ),
      },
      backendNodeId,
      files,
      options,
    );
  }

  async inspectEditableStateByBackendNodeId(
    backendNodeId: number,
    expectedText?: string,
    options: CDPBackendNodeInspectionOptions = {},
  ): Promise<CDPEditableState> {
    return this.callFunctionOnBackendNode<CDPEditableState>(
      backendNodeId,
      `function(expectedText) {
        const tag = String(this.tagName || '').toLowerCase();
        const role = String(this.getAttribute?.('role') || '').toLowerCase();
        const editable = (${EDITABLE_FIELD_SOURCE})(this);
        const text = this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement
          ? String(this.value || '')
          : String(this.innerText || this.textContent || '');
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
          hash ^= text.charCodeAt(index);
          hash = Math.imul(hash, 16777619);
        }
        const state = {
          tag,
          role,
          contentEditable: this.isContentEditable === true,
          editable,
          focused: this.ownerDocument?.activeElement === this,
          textLength: text.length,
          fingerprint: (hash >>> 0).toString(16) + ':' + text.length
        };
        if (arguments.length > 0) {
          const expected = String(expectedText);
          state.matchesExpected = text === expected;
          state.containsExpected = text.includes(expected);
        }
        return state;
      }`,
      expectedText === undefined ? [] : [expectedText],
      options.signal,
      options.timeoutMs ?? BROWSER_TIMEOUTS.cdpCommand,
      options.commandSessionId,
    );
  }

  async inspectFocusedEditableStateByBackendNodeId(
    backendNodeId: number,
    options: CDPBackendNodeInspectionOptions = {},
  ): Promise<CDPFocusedEditableState> {
    return this.callFunctionOnBackendNode<CDPFocusedEditableState>(
      backendNodeId,
      `function() {
        let active = this.ownerDocument?.activeElement || null;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        const tag = String(active?.tagName || '').toLowerCase();
        const role = String(active?.getAttribute?.('role') || '').toLowerCase();
        const editable = (${EDITABLE_FIELD_SOURCE})(active);
        const text = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
          ? String(active.value || '')
          : String(active?.innerText || active?.textContent || '');
        let withinTarget = false;
        let cursor = active;
        while (cursor) {
          if (cursor === this) {
            withinTarget = true;
            break;
          }
          cursor = cursor.parentNode || cursor.getRootNode?.()?.host || null;
        }
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
          hash ^= text.charCodeAt(index);
          hash = Math.imul(hash, 16777619);
        }
        return {
          tag,
          role,
          contentEditable: active?.isContentEditable === true,
          editable,
          focused: editable,
          withinTarget,
          textLength: text.length,
          fingerprint: (hash >>> 0).toString(16) + ':' + text.length
        };
      }`,
      [],
      options.signal,
      options.timeoutMs ?? BROWSER_TIMEOUTS.cdpCommand,
      options.commandSessionId,
    );
  }

  async inspectRenderedStateByBackendNodeId(
    backendNodeId: number,
    expectedText?: string,
    options: CDPBackendNodeInspectionOptions = {},
  ): Promise<CDPRenderedState> {
    return this.callFunctionOnBackendNode<CDPRenderedState>(
      backendNodeId,
      `function(expectedText) {
        const text = String(this.innerText || this.textContent || '');
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
          hash ^= text.charCodeAt(index);
          hash = Math.imul(hash, 16777619);
        }
        const state = {
          textLength: text.length,
          fingerprint: (hash >>> 0).toString(16) + ':' + text.length
        };
        if (arguments.length > 0) {
          const expected = String(expectedText);
          state.matchesExpected = text === expected;
          state.containsExpected = text.includes(expected);
        }
        return state;
      }`,
      expectedText === undefined ? [] : [expectedText],
      options.signal,
      options.timeoutMs ?? BROWSER_TIMEOUTS.cdpCommand,
      options.commandSessionId,
    );
  }

  /**
   * Capture bounded, visible semantics around a hover target. Callers compare snapshots before and
   * after mouse movement so only semantics caused by that hover are promoted.
   */
  async captureHoverSemanticSnapshotByBackendNodeId(
    backendNodeId: number,
    options: { signal?: AbortSignal; timeoutMs?: number; commandSessionId?: string } = {},
  ): Promise<CDPHoverSemanticSnapshot> {
    return this.callFunctionOnBackendNode<CDPHoverSemanticSnapshot>(
      backendNodeId,
      `function() {
        const target = this;
        const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
        const onlyCount = (value) =>
          Boolean(value) && /^[\\s\\d.,+万亿千百kKmMwW]+$/u.test(String(value));
        const linkedText = (attributeName) => {
          const ids = clean(target.getAttribute(attributeName)).split(' ').filter(Boolean);
          return clean(ids.map((id) => {
            const node = document.getElementById(id);
            return node?.innerText || node?.textContent || '';
          }).join(' '));
        };

        const ariaLabel = clean(target.getAttribute('aria-label'));
        const labelledBy = linkedText('aria-labelledby');
        const title = clean(target.getAttribute('title'));
        const svgTitle = clean(target.querySelector?.('svg title')?.textContent);
        const alt = clean(
          target.getAttribute('alt') || target.querySelector?.('img[alt]')?.getAttribute('alt')
        );
        const visibleText = clean(target.innerText || target.textContent);
        let name = '';
        let source = 'none';
        if (ariaLabel) {
          name = ariaLabel;
          source = 'aria-label';
        } else if (labelledBy) {
          name = labelledBy;
          source = 'aria-labelledby';
        } else if (title) {
          name = title;
          source = 'title';
        } else if (svgTitle) {
          name = svgTitle;
          source = 'svg-title';
        } else if (alt) {
          name = alt;
          source = 'alt';
        } else if (visibleText && !onlyCount(visibleText)) {
          name = visibleText;
          source = 'text';
        }

        const targetRect = target.getBoundingClientRect();
        const distanceToTarget = (rect) => {
          const dx = Math.max(targetRect.left - rect.right, rect.left - targetRect.right, 0);
          const dy = Math.max(targetRect.top - rect.bottom, rect.top - targetRect.bottom, 0);
          return Math.round(Math.hypot(dx, dy));
        };
        const isVisible = (rect, style) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.top < window.innerHeight &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.right > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number.parseFloat(style.opacity || '1') > 0;

        const nearby = [];
        const seen = new Set();
        const addCandidate = (element, linked) => {
          if (!(element instanceof Element) || element === target || target.contains(element)) return;
          const text = clean(
            element.innerText || element.textContent || element.getAttribute('aria-label')
          );
          if (!text || text.length > 80) return;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (!isVisible(rect, style)) return;
          const role = clean(element.getAttribute('role')).toLowerCase();
          const distance = distanceToTarget(rect);
          if (!linked && distance > 320) return;
          const overlay =
            linked ||
            role === 'tooltip' ||
            style.position === 'fixed' ||
            style.position === 'absolute' ||
            style.position === 'sticky';
          if (!overlay || rect.width > 480 || rect.height > 200) return;
          const fingerprint = [
            element.id || '',
            element.tagName.toLowerCase(),
            role,
            text,
            Math.round(rect.left / 4),
            Math.round(rect.top / 4)
          ].join(':');
          if (seen.has(fingerprint)) return;
          seen.add(fingerprint);
          nearby.push({ fingerprint, text, role, linked: Boolean(linked), distance });
        };

        for (const id of clean(target.getAttribute('aria-describedby')).split(' ').filter(Boolean)) {
          addCandidate(document.getElementById(id), true);
        }
        for (const element of document.querySelectorAll('[role="tooltip"]')) {
          addCandidate(element, false);
        }
        let visited = 0;
        for (const element of document.querySelectorAll('body *')) {
          visited += 1;
          if (visited > 5000 || nearby.length >= 48) break;
          if (element.childElementCount > 4 || element.getAttribute('role') === 'tooltip') continue;
          const position = getComputedStyle(element).position;
          if (position !== 'fixed' && position !== 'absolute' && position !== 'sticky') continue;
          addCandidate(element, false);
        }
        nearby.sort((left, right) =>
          Number(right.linked) - Number(left.linked) ||
          Number(right.role === 'tooltip') - Number(left.role === 'tooltip') ||
          left.distance - right.distance
        );

        return {
          target: {
            name,
            source,
            supportingText: onlyCount(visibleText) ? visibleText : ''
          },
          nearby: nearby.slice(0, 48)
        };
      }`,
      [],
      options.signal,
      options.timeoutMs ?? BROWSER_TIMEOUTS.cdpCommand,
      options.commandSessionId,
    );
  }

  private async callFunctionOnBackendNode<T>(
    backendNodeId: number,
    functionDeclaration: string,
    args: unknown[] = [],
    signal?: AbortSignal,
    timeoutMs: number = BROWSER_TIMEOUTS.cdpCommand,
    commandSessionId?: string,
  ): Promise<T> {
    const resolved = (await this.sendCommand(
      'DOM.resolveNode',
      { backendNodeId },
      timeoutMs,
      signal,
      commandSessionId,
    )) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error(`Failed to resolve backend node: ${backendNodeId}`);
    try {
      const response = (await this.sendCommand(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration,
          arguments: args.map((value) => ({ value })),
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        },
        timeoutMs,
        signal,
        commandSessionId,
      )) as {
        result?: { value?: T; description?: string };
        exceptionDetails?: CdpExceptionDetails;
      };
      if (response.exceptionDetails) {
        throw new Error(
          describeCdpException(
            response.exceptionDetails,
            response.result?.description ?? 'Element action failed',
          ),
        );
      }
      return response.result?.value as T;
    } finally {
      await this.sendCommand(
        'Runtime.releaseObject',
        { objectId },
        timeoutMs,
        undefined,
        commandSessionId,
      ).catch(() => undefined);
    }
  }

  async setCheckedByBackendNodeId(backendNodeId: number, checked: boolean): Promise<boolean> {
    const current = await this.callFunctionOnBackendNode<boolean>(
      backendNodeId,
      `function() {
        if (!(this instanceof HTMLInputElement)) throw new Error('Target is not an input');
        if (this.type !== 'checkbox' && this.type !== 'radio') {
          throw new Error('Target is not checkable');
        }
        return this.checked;
      }`,
    );
    if (current !== checked) await this.clickByBackendNodeId(backendNodeId);
    return this.callFunctionOnBackendNode<boolean>(
      backendNodeId,
      'function() { return this.checked; }',
    );
  }

  async selectOptionsByBackendNodeId(backendNodeId: number, values: string[]): Promise<string[]> {
    return this.callFunctionOnBackendNode<string[]>(
      backendNodeId,
      `function(values) {
        if (!(this instanceof HTMLSelectElement)) throw new Error('Target is not a select');
        const requested = new Set(values);
        for (const option of this.options) option.selected = requested.has(option.value);
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        // Not Array.from: Prototype.js/MooTools replace it and drop the map
        // function, returning DOM nodes that returnByValue cannot serialize.
        return Array.prototype.filter
          .call(this.options, (option) => option.selected)
          .map((option) => option.value);
      }`,
      [values],
    );
  }

  /**
   * 使用 CDP 获取可交互元素（参考 browser-use 实现）
   *
   * 流程：
   * 1. 并行获取三个数据源：DOMSnapshot、DOM tree、Accessibility tree
   * 2. 检测 JavaScript 事件监听器
   * 3. 构建 snapshot lookup，关联布局信息
   * 4. 遍历 DOM 树，融合所有信息，检测可交互元素
   * 5. 过滤不可见和被遮挡的元素
   *
   * 设计原则：
   * - 普通数据源失败允许降级为空数组或纯 JS 扫描
   * - deadline / abort 必须向调用方透出，不能伪装成成功空结果
   * - 中断时重置 debugger，下一次扫描可重新连接
   */
  private traverseDOMTree(...args: Parameters<CDPPageScanner['traverseDOMTree']>) {
    return this.pageScanner.traverseDOMTree(...args);
  }

  private isElementVisible(...args: Parameters<CDPPageScanner['isElementVisible']>) {
    return this.pageScanner.isElementVisible(...args);
  }

  private isElementInteractive(...args: Parameters<CDPPageScanner['isElementInteractive']>) {
    return this.pageScanner.isElementInteractive(...args);
  }

  private buildSnapshotLookup(...args: Parameters<CDPPageScanner['buildSnapshotLookup']>) {
    return this.pageScanner.buildSnapshotLookup(...args);
  }

  private getViewportBoundsByBackendNodeId(
    ...args: Parameters<CDPPageScanner['getViewportBoundsByBackendNodeId']>
  ) {
    return this.pageScanner.getViewportBoundsByBackendNodeId(...args);
  }

  async getInteractiveElements(
    signal?: AbortSignal,
    options: FormStateScanOptions = {},
  ): Promise<InteractiveElement[]> {
    this.pageScanner.reset();
    try {
      const elements = await withTimeout(
        (scanSignal) => this.pageScanner.scan(scanSignal, options),
        BROWSER_TIMEOUTS.cdpScan,
        'CDP interactive element scan',
        { signal },
      );
      if (this.domListenerDesired && !this.domListenerAttached) {
        this.startDOMListenerInBackground();
      }
      return elements;
    } catch (error) {
      browserInputDiagnosticLogger.warn({
        msg: '[EmbeddedBrowserOperation] cdp-scan-timeout',
        browserSessionId: this.transport.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (isBrowserOperationInterruption(error)) {
        await this.recoverDebuggerAfterInterruption();
        throw error;
      }
      return [];
    }
  }
}
