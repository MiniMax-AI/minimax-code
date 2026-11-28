import type { ClipboardProvider } from './clipboard.js';
import { classifyBrowserNavigationEvent } from './browser-action-helpers.js';
import { BrowserExtendedActionSupport } from './browser-extended-actions.js';
import { isHoverSemanticSnapshot, resolveBrowserHoverSemantic } from './browser-hover-semantic.js';
import {
  browserJsDialogActiveResult,
  BrowserRelatedPageDialogPause,
  browserJsDialogAwaitingUserResult,
  browserJsDialogKeyDecision,
  browserJsDialogNotActiveResult,
  browserJsDialogSnapshot,
  isBrowserJsDialogNotActiveError,
  JsDialogTracker,
  parseBrowserJsDialogHandleInput,
  parseBrowserJsDialogRef,
  resolveBrowserJsDialogDecision,
  type BrowserJsDialogDecision,
  type BrowserJsDialogState,
} from './browser-js-dialog.js';
import {
  asNumber,
  asString,
  delay,
  inputCoordinate,
  isRecord,
  invalidateBrowserFrame,
  isBrowserRefIssued,
  resolveBrowserSnapshotElement,
  type ElementRecord,
  type BrowserScreenshotCapture,
  type BrowserSessionState,
} from './browser-state.js';
import type { BrowserTransport } from './browser-transport.js';
import { CDPHelper } from './cdp-helper.js';
import { ElementMapManager } from './element-map-manager.js';
import {
  browserScriptTimeoutMs,
  browserScriptActionDeadlineMs,
  BROWSER_SCRIPT_CLEANUP_BUDGET_MS,
  BROWSER_SCRIPT_MAX_CODE_BYTES,
  BrowserScriptRun,
  deliverInputRelease,
  stopPageExecution,
} from './browser-script.js';
import { BrowserDocumentResponseTracker } from './browser-document-response.js';
import {
  BrowserMainFrameLoad,
  MainFrameNavigationPending,
  pageStillLoadingResult,
  pendingLoadFacts,
  pendingNavigationReport,
  waitStillLoadingResult,
  type BrowserPendingMainFrameLoad,
} from './browser-main-frame-load.js';
import { isBrowserOperationInterruption, withTimeout } from './operation-timeout.js';
import {
  aimAtProbe,
  probeBrowserClickTarget,
  targetNotInteractableResult,
} from './browser-click-interactability.js';
import {
  interpretRefAsSelector,
  type BrowserTargetInterpretation,
} from './browser-ref-selector.js';
import { BROWSER_REF_REBIND_NOTE, takeReboundRefs } from './browser-ref-rebind.js';
import {
  programFailureFrom,
  programFailureFromResult,
  programWriteFailure,
} from './program/errors.js';
import { endLeftoverPageScriptInterception } from './program/page-evaluate.js';
import { BrowserProgramOps, type BrowserProgramHost } from './program/ops.js';
import {
  describeProgramLocator,
  parseProgramOp,
  type ProgramOp,
  type ProgramOpResult,
  type ProgramOpStep,
  type ProgramPageScriptAudit,
} from './program/types.js';
import {
  BROWSER_WRITE_ACTIONS,
  BROWSER_PAGE_READ_ACTIONS,
  BrowserWriteLedger,
  classifyBrowserWriteError,
  classifyBrowserWriteResult,
  uncertainWriteNext,
  unexpectedNavigationRetry,
  unverifiedWriteRetryError,
  unverifiedWriteRetryWarning,
  type BrowserUncertainWriteReason,
  type BrowserWriteRecord,
} from './browser-write-record.js';

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const MAX_ACTION_TIMEOUT_MS = 120_000;
/** Actions that can submit a form. */
const SUBMIT_CAPABLE_ACTIONS: Readonly<Record<string, true>> = {
  click: true,
  click_and_wait_for_navigation: true,
  double_click: true,
  press_key: true,
};
/**
 * Actions that ask for another document (program goto, back and reload run as
 * these). They leave or replace the page, so they run while a main-frame load
 * is pending; every other action needs the current document.
 */
const NAVIGATION_ACTIONS: Readonly<Record<string, true>> = {
  navigate: true,
  back: true,
  forward: true,
  reload: true,
};
/** How long an action other than wait waits for a pending main-frame load to commit. */
const PENDING_LOAD_WAIT_MS = 10_000;
/** A wait without a timeout waits this long (the same default as the wait action). */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_ACTION_WITH_COMPLETION_BUFFER_MS = 125_000;
const NAVIGATION_ACTION_TIMEOUT_MS = 35_000;
const TEXT_INPUT_COMPLETION_BUFFER_MS = 30_000;
const TEXT_INPUT_CDP_EVENT_ESTIMATE_MS = 20;
const ACTION_COMPLETION_BUFFER_MS = 1_000;
/** Time a click-and-wait keeps after its navigation wait to read and report the page. */
const CLICK_AND_WAIT_RESULT_RESERVE_MS = 1_500;
const HOVER_SEMANTIC_SAMPLE_DELAY_MS = 160;
const HOVER_SEMANTIC_SAMPLE_COUNT = 6;
const PROGRAM_GATE_MARGIN_MS = 5_000;
/** Bound for the action a JavaScript dialog interrupted to finish after the dialog closes. */
const ABANDONED_ACTION_SETTLE_MS = 3_000;
/** Fetch.disable at the end of an action whose page JavaScript may have left interception on. */
const LEFTOVER_INTERCEPTION_DISABLE_MS = 1_000;

export interface BrowserCoreOptions<TAction extends string> {
  provider: string;
  version: number;
  actions: readonly TAction[];
}

export interface BrowserCoreContext {
  readonly sessionId: string;
}

export interface BrowserCoreSessionOptions {
  readonly clipboardProvider?: ClipboardProvider;
  /** Reuse a provider-neutral helper already owned by this exact page transport. */
  readonly cdpHelper?: CDPHelper;
  readonly actionTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly inputCoordinateScaleProvider?: () => number;
  /** Optional provider presentation step; it must not perform the Browser action itself. */
  readonly beforePointerAction?: (
    event: { action: string; point: { x: number; y: number } },
    signal?: AbortSignal,
  ) => Promise<void> | void;
  readonly clickNavigationDetectionMs?: number;
  /** Optional provider capture seam for presentation-aware screenshots. */
  readonly captureScreenshot?: BrowserScreenshotCapture;
  /**
   * `beta.browserReadV2`, read per call so a config change applies to the next
   * read: DOM queries and inspect records carry live form-control state.
   */
  readonly readLiveFormState?: () => boolean;
}

/** How a program op replaces an action inside the session gate. */
interface ProgramGateRun {
  readonly timeoutMs: number;
  run(): Promise<unknown>;
}

/** Snapshot-scoped identity returned to provider adapters for an opaque ref. */
export interface BrowserCoreResolvedTarget {
  readonly element: ElementRecord;
  readonly snapshotId: string;
  readonly generation: number;
  readonly frameId: string;
  readonly frameRef: string | null;
}

/**
 * Shared top layer for Browser providers.
 *
 * It owns the provider contract and action gate. Provider implementations
 * only supply the action executor; semantic snapshots, refs, query and
 * effect-verification code are kept below this same contract rather than
 * introducing a second Electron/native provider API.
 */
export class BrowserCore<TAction extends string = string> {
  private readonly actionSet: ReadonlySet<TAction>;

  constructor(private readonly options: BrowserCoreOptions<TAction>) {
    this.actionSet = new Set(options.actions);
  }

  getCapabilities() {
    return {
      provider: this.options.provider,
      version: this.options.version,
      actions: this.options.actions,
    } as const;
  }

  assertAction(action: string): asserts action is TAction {
    if (!this.actionSet.has(action as TAction)) {
      throw new Error(`Unsupported ${this.options.provider} Browser action: ${action}`);
    }
  }

  assertContext(ctx: BrowserCoreContext): string {
    const sessionId = ctx.sessionId.trim();
    if (!sessionId) throw new Error('Browser tool requires an active session');
    return sessionId;
  }

  assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('Operation aborted');
  }

  createSession(
    transport: BrowserTransport,
    options: BrowserCoreSessionOptions = {},
  ): BrowserCoreSession {
    return new BrowserCoreSession(transport, options);
  }
}

/**
 * The single provider-neutral Browser Core execution path.
 *
 * Providers create a transport and hand it to this class. Snapshot/ref state,
 * pagination, input dispatch, effect validation and action deadlines remain
 * here, so Electron and native Headless cannot silently grow separate action
 * implementations.
 */
export class BrowserCoreSession extends BrowserExtendedActionSupport {
  private readonly state: BrowserSessionState;
  private readonly ownsCdpHelper: boolean;
  private networkEnabledGeneration: number | undefined;
  private readonly actionTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private active = false;
  private poisoned = false;
  private externalNavigationGeneration = 0;
  private readonly navigationEventDisposer: () => void;
  private readonly jsDialogs: JsDialogTracker;
  private readonly jsDialogRecoveryGuardDisposer: () => void;
  /** Text typed into the virtual prompt textbox, keyed by dialogId. */
  private jsDialogPromptDraft: { dialogId: string; text: string } | undefined;
  /** Dialog the Agent has read through inspect or addressed by its ref. */
  private jsDialogSeenId: string | undefined;
  /** An action a dialog interrupted; its blocked command completes after the dialog closes. */
  private abandonedAction: Promise<unknown> | undefined;
  private readonly documentResponses: BrowserDocumentResponseTracker;
  private readonly mainFrameLoad = new BrowserMainFrameLoad();
  private readonly writes = new BrowserWriteLedger(
    Date.now,
    () => this.mainFrameLoad.pending !== undefined,
  );
  private readonly programOps: BrowserProgramOps;

  constructor(transport: BrowserTransport, options: BrowserCoreSessionOptions = {}) {
    super(options.clipboardProvider);
    if (options.cdpHelper && options.cdpHelper.getTransport() !== transport) {
      throw new Error('Browser Core CDP helper must own the supplied page transport');
    }
    const cdpHelper = options.cdpHelper ?? new CDPHelper(transport);
    this.ownsCdpHelper = options.cdpHelper === undefined;
    this.state = {
      mainFrameLoad: this.mainFrameLoad,
      transport,
      cdpHelper,
      elementMap: new ElementMapManager(),
      generation: 0,
      ...(options.inputCoordinateScaleProvider
        ? { inputCoordinateScaleProvider: options.inputCoordinateScaleProvider }
        : {}),
      ...(options.beforePointerAction ? { beforePointerAction: options.beforePointerAction } : {}),
      ...(options.captureScreenshot ? { captureScreenshot: options.captureScreenshot } : {}),
      ...(options.readLiveFormState ? { readLiveFormState: options.readLiveFormState } : {}),
      ...(options.clickNavigationDetectionMs !== undefined
        ? {
            clickNavigationDetectionMs: Math.max(
              1,
              Math.min(30_000, Math.floor(options.clickNavigationDetectionMs)),
            ),
          }
        : {}),
    };
    this.actionTimeoutMs = positiveDeadline(options.actionTimeoutMs, DEFAULT_ACTION_TIMEOUT_MS);
    this.commandTimeoutMs = positiveDeadline(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
    this.jsDialogs = new JsDialogTracker(transport);
    this.jsDialogRecoveryGuardDisposer = cdpHelper.setInterruptionRecoveryGuard(
      () => this.jsDialogs.current() !== null || this.jsDialogs.awaitingUser(),
    );
    this.documentResponses = new BrowserDocumentResponseTracker(transport);
    this.programOps = new BrowserProgramOps(this.programHost());
    this.navigationEventDisposer = transport.onEvent((event) => {
      this.jsDialogs.observeTransportEvent(event);
      const params = isRecord(event.params) ? event.params : {};
      const frame = isRecord(params.frame) ? params.frame : {};
      const frameId = asString(frame.id) || asString(params.frameId);
      const commandSessionId = event.sessionId || asString(params.sessionId);
      const mainFrameId = this.state.cdpHelper.getMainFrameId();
      this.documentResponses.handle(event, mainFrameId);
      this.mainFrameLoad.handle(event, mainFrameId);
      const navigationScope = classifyBrowserNavigationEvent(event, transport, mainFrameId);
      if (event.method === 'Page.frameNavigated' && navigationScope === 'main') {
        this.writes.documentCommitted();
      }
      if (event.method === 'Page.frameNavigated') {
        if (navigationScope === 'child') {
          invalidateBrowserFrame(this.state, {
            ...(frameId ? { frameId } : {}),
            ...(commandSessionId ? { commandSessionId } : {}),
          });
        } else if (navigationScope === 'main') {
          this.invalidate(this.state);
        }
      } else if (event.method === 'Page.navigatedWithinDocument') {
        if (navigationScope === 'child') {
          invalidateBrowserFrame(this.state, {
            ...(frameId ? { frameId } : {}),
            ...(commandSessionId ? { commandSessionId } : {}),
          });
        } else if (navigationScope === 'main') {
          this.invalidate(this.state);
        }
      } else if (event.method === 'Page.frameDetached' && frameId) {
        if (mainFrameId && frameId === mainFrameId) this.invalidate(this.state);
        else invalidateBrowserFrame(this.state, { frameId });
      } else if (event.method === 'Target.detachedFromTarget' && asString(params.sessionId)) {
        invalidateBrowserFrame(this.state, { commandSessionId: asString(params.sessionId) });
      }
    });
  }

  private programHost(): BrowserProgramHost {
    const state = this.state;
    return {
      state,
      dispatchMouse: (x, y, type, extra) => this.dispatchMouse(state, x, y, type, extra),
      dispatchKey: (key, modifiers) => this.dispatchKey(state, key, modifiers),
      enableNetworkForSubmit: () => this.enableNetworkForSubmit(),
      query: (input) => this.query(state, input),
      inspect: (input) => this.inspect(state, input),
      waitFor: (input) => this.waitFor(state, input),
      screenshot: (input) => this.screenshot(state, input),
      waitForDocumentReady: (accepts, timeoutMs) =>
        this.waitForDocumentReady(state, accepts, timeoutMs),
      waitForHistoryEntryReady: (target, timeoutMs) =>
        this.waitForHistoryEntryReady(state, target, timeoutMs),
      invalidate: () => this.invalidate(state),
      invalidateObservation: () => this.invalidateObservation(state),
      recordPageScriptWrite: (url) => {
        this.writes.record(
          'evaluate',
          {},
          { outcome: 'uncertain', reason: 'page_script' },
          { ...(url ? { url } : {}), anyTarget: true },
        );
      },
    };
  }

  get transport(): BrowserTransport {
    return this.state.transport;
  }

  get generation(): number {
    return this.state.generation;
  }

  /** A failed interruption reset requires the provider to recreate this session. */
  get requiresRecreation(): boolean {
    return this.poisoned;
  }

  /** The most recent page write and whether its outcome is known. */
  get lastWrite(): BrowserWriteRecord | undefined {
    return this.writes.last;
  }

  /**
   * A provider that reprojects a write result (Electron's click projection)
   * found that the write may have had a side effect after all.
   */
  markLastWriteUncertain(reason: BrowserUncertainWriteReason): void {
    this.writes.markLastUncertain(reason);
  }

  /** Whether this session issued the element ref (so another tab cannot resolve it). */
  issuedRef(ref: string): boolean {
    return isBrowserRefIssued(this.state, ref);
  }

  /** Provider adapter escape hatch for actions that remain provider-specific. */
  resolveOpaqueRef(ref: string): ElementRecord | null {
    // Some focused white-box fixtures predate retained snapshots and seed only
    // ElementMap. Once a snapshot store exists, it is the sole production ref
    // authority so expiry/pruning cannot be bypassed through ElementMap.
    const allowFixtureFallback = this.state.snapshotAuthorityEstablished !== true;
    return (
      resolveBrowserSnapshotElement(this.state, ref)?.element ??
      (allowFixtureFallback ? this.state.elementMap.getElementByOpaqueRef(ref) : null)
    );
  }

  /**
   * Resolve an opaque ref together with the frame identity from the exact
   * snapshot that issued it. Adapters must use this atomic result when they
   * validate a public `{ ref, frame }` pair; consulting the latest snapshot's
   * frame map separately can incorrectly reject a retained ref.
   */
  resolveOpaqueTarget(ref: string): BrowserCoreResolvedTarget | null {
    const resolved = resolveBrowserSnapshotElement(this.state, ref);
    if (!resolved) return null;
    const frameId = resolved.element.frameId ?? 'main';
    return {
      element: resolved.element,
      snapshotId: resolved.snapshot.id,
      generation: resolved.snapshot.generation,
      frameId,
      frameRef: resolved.snapshot.frameRefs?.get(frameId) ?? null,
    };
  }

  resolveFrameRef(frameId = 'main'): string | null {
    return this.state.snapshot?.frameRefs?.get(frameId) ?? null;
  }

  /** Current page JavaScript dialog held for the Agent, if any. */
  get jsDialog(): BrowserJsDialogState | null {
    return this.jsDialogs.current();
  }

  /**
   * Close a held dialog without an Agent decision. Only providers without a
   * user-visible surface use this when Agent control ends; it dismisses
   * (alert: closes) so no business action is confirmed on the user's behalf.
   */
  async dismissJsDialog(): Promise<boolean> {
    const dialog = this.jsDialogs.current();
    if (!dialog) return false;
    try {
      const { accept } = resolveBrowserJsDialogDecision(dialog, { decision: 'dismiss' });
      await this.jsDialogs.handle(dialog.dialogId, accept);
      return true;
    } catch {
      return false;
    }
  }

  /** Release the lifecycle listener before the provider closes its transport. */
  dispose(): void {
    this.jsDialogRecoveryGuardDisposer();
    this.jsDialogs.dispose();
    this.navigationEventDisposer();
    if (this.ownsCdpHelper) this.state.cdpHelper.stopDOMListener();
  }

  /** Invalidate opaque refs after navigation observed outside Browser Core. */
  synchronizeGeneration(generation: number): void {
    const normalized = Math.max(0, Math.floor(generation));
    if (normalized === this.externalNavigationGeneration) return;
    this.externalNavigationGeneration = normalized;
    this.invalidate(this.state);
  }

  async execute(
    action: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.runGated(action, input, signal);
  }

  /**
   * One page operation of a run_code program, through the same gate as every
   * action: serial per page, dialogs, pending loads and the write record.
   * Inside the gate it takes the fast path of program/ops.ts. A repeated
   * uncertain write is refused here rather than warned about: a program cannot
   * stop to look at each result. Every outcome comes back as a result, never
   * as a throw.
   */
  async executeOp(rawOp: unknown, signal?: AbortSignal): Promise<ProgramOpResult> {
    const startedAt = Date.now();
    let op: ProgramOp;
    try {
      op = parseProgramOp(rawOp);
    } catch (error) {
      const name = isRecord(rawOp) ? asString(rawOp.op, 'unknown') : 'unknown';
      return programOpFailure(name, error, startedAt);
    }
    if (op.op === 'networkCheckpoint') return this.networkCheckpoint(startedAt, signal);
    const action = PROGRAM_GATE_ACTION[op.op];
    const target = 'target' in op && op.target ? describeProgramLocator(op.target) : undefined;
    const write = BROWSER_WRITE_ACTIONS[action] === true;
    const named = target ?? ('x' in op ? `mouse at ${op.x},${op.y}` : undefined);
    const facts = { op: op.op, write, ...(named ? { target: named } : {}) };
    try {
      const result =
        op.op === 'handleDialog'
          ? await this.runGated(
              action,
              {
                dialogId: op.dialogId,
                action: op.action,
                ...(op.promptText === undefined ? {} : { promptText: op.promptText }),
              },
              signal,
            )
          : await this.runGated(action, programGateInput(op, target), signal, {
              timeoutMs: programGateTimeout(op),
              run: () => {
                this.state.keyboardContinuationTarget = undefined;
                return this.programOps.run(op);
              },
            });
      return this.programOpResult(op, facts, result, startedAt);
    } catch (error) {
      const recorded = this.writes.last;
      const failure = programFailureFrom(error);
      const pageScript = isRecord(failure.details?.pageScript)
        ? (failure.details.pageScript as unknown as ProgramPageScriptAudit)
        : undefined;
      const scriptWrite = pageScript?.writeLike === true;
      const uncertain =
        scriptWrite || (write && recorded?.outcome === 'uncertain' && recorded.at >= startedAt);
      const reported = programWriteFailure(failure, uncertain, uncertainWriteNext(action));
      return {
        ok: false,
        error: { ...reported, ...(uncertain ? { writeOutcomeUnknown: true } : {}) },
        step: {
          ...facts,
          ...(scriptWrite ? { write: true } : {}),
          durationMs: Date.now() - startedAt,
          code: reported.code,
          ...(write || scriptWrite ? { outcome: uncertain ? 'uncertain' : 'failed' } : {}),
          ...(pageScript ? { pageScript } : {}),
        },
      };
    }
  }

  private programOpResult(
    op: ProgramOp,
    facts: Pick<ProgramOpStep, 'op' | 'write' | 'target'>,
    result: unknown,
    startedAt: number,
  ): ProgramOpResult {
    const record = isRecord(result) ? result : { value: result };
    const navigation = isRecord(record.navigation) ? record.navigation : undefined;
    const uncertain = isRecord(record.uncertainWrite) ? record.uncertainWrite : undefined;
    // A click whose navigation has not committed is the normal case here: the
    // next op waits for the commit, and the program gets the navigation facts.
    const unknownOutcome = uncertain !== undefined && uncertain.reason !== 'navigation_pending';
    const failed = record.success === false || unknownOutcome;
    const failure = failed
      ? {
          ...programWriteFailure(programFailureFromResult(record), unknownOutcome),
          ...(unknownOutcome ? { writeOutcomeUnknown: true } : {}),
        }
      : undefined;
    const reports = {
      ...(record.opensNewTab === true ? { opensNewTab: true } : {}),
    };
    const pageScript = isRecord(record.pageScript)
      ? (record.pageScript as unknown as ProgramPageScriptAudit)
      : undefined;
    // Page JavaScript that wrote (non-GET, submit, navigation) is listed with the writes.
    const scriptWrite = pageScript?.writeLike === true;
    const step: ProgramOpStep = {
      ...facts,
      ...(scriptWrite ? { write: true } : {}),
      durationMs: Date.now() - startedAt,
      ...(typeof record.url === 'string' && record.url ? { url: record.url } : {}),
      ...(isRecord(record.pendingNavigation)
        ? { pendingNavigation: record.pendingNavigation }
        : {}),
      ...(navigation ? { navigation } : {}),
      ...(facts.write
        ? { outcome: unknownOutcome || uncertain ? 'uncertain' : failed ? 'failed' : 'succeeded' }
        : scriptWrite
          ? { outcome: 'uncertain' }
          : {}),
      ...(failure ? { code: failure.code } : {}),
      ...(pageScript ? { pageScript } : {}),
    };
    if (failure) return { ok: false, error: failure, step, ...reports };
    const value =
      op.op === 'handleDialog'
        ? { handled: record.handled === true, type: record.type, action: record.action }
        : op.op === 'observe' && record.value === undefined && isRecord(record.dialog)
          ? // A held dialog: inspect read its virtual modal instead of the page.
            { url: record.url, dialog: record.dialog }
          : record.value;
    return { ok: true, value: value === undefined ? null : value, step, ...reports };
  }

  /** The newest network sequence, so a later waitForResponse only sees later requests. */
  private async networkCheckpoint(
    startedAt: number,
    signal?: AbortSignal,
  ): Promise<ProgramOpResult> {
    const step = { op: 'networkCheckpoint', write: false };
    try {
      const ready = await this.state.cdpHelper.ensureNetworkDiagnosticsReady(signal);
      const lastSequence = ready
        ? this.state.cdpHelper.getNetworkDiagnostics({ limit: 1 }).lastSequence
        : 0;
      return {
        ok: true,
        value: lastSequence,
        step: { ...step, durationMs: Date.now() - startedAt },
      };
    } catch (error) {
      return programOpFailure('networkCheckpoint', error, startedAt);
    }
  }

  private async runGated(
    action: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    program?: ProgramGateRun,
  ): Promise<unknown> {
    if (this.active) throw new Error('BROWSER_SESSION_BUSY: another Browser action is running');
    if (this.poisoned) {
      throw new Error(
        'BROWSER_SESSION_POISONED: Browser connection recovery failed; recreate the Browser session and inspect the page before continuing',
      );
    }
    if (signal?.aborted) throw new Error('ABORTED: Browser action was cancelled');
    // Claim the session before the first await so a concurrent action gets
    // BROWSER_SESSION_BUSY. Every exit before the action runs releases it,
    // including a rejected deadline.
    this.active = true;
    const ref = asString(input.ref);
    let timeoutMs: number;
    let admitted = false;
    try {
      // A held JavaScript dialog queues every page command until it closes, so
      // decide here, before any command reaches the page.
      const dialogOutcome = await this.executeJsDialogGate(action, input);
      if (dialogOutcome !== undefined) return dialogOutcome;
      await this.settleAbandonedAction();
      const reopenedDialog = this.jsDialogs.current();
      if (reopenedDialog) return browserJsDialogActiveResult(reopenedDialog, action);
      // The abort listener is added below; a cancellation during the awaits
      // above would otherwise be lost and the action would run on.
      if (signal?.aborted) throw new Error('ABORTED: Browser action was cancelled');
      const requestedTimeoutMs = asNumber(input.timeout, this.actionTimeoutMs);
      const textTarget =
        ref && (action === 'fill' || action === 'type')
          ? (resolveBrowserSnapshotElement(this.state, ref)?.element ??
            this.state.elementMap.getElementByOpaqueRef(ref))
          : null;
      timeoutMs =
        program?.timeoutMs ??
        actionDeadline(
          action,
          input,
          requestedTimeoutMs,
          this.actionTimeoutMs,
          textTarget?.virtualEditor === true,
        );
      admitted = true;
    } finally {
      if (!admitted) {
        // A dialog action may end the action that left interception on.
        await endLeftoverPageScriptInterception(this.state, LEFTOVER_INTERCEPTION_DISABLE_MS);
        this.active = false;
      }
    }
    // Rebinds belong to the action that made them.
    takeReboundRefs(this.state);
    const controller = new AbortController();
    let timedOut = false;
    let dialogInterrupted = false;
    // A provider ends the action this way when a dialog in another page (a
    // popup sharing this page's renderer) pauses it.
    let relatedDialogPause: BrowserRelatedPageDialogPause | undefined;
    const forwardAbort = (): void => {
      if (signal?.reason instanceof BrowserRelatedPageDialogPause)
        relatedDialogPause = signal.reason;
      controller.abort();
    };
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    this.state.commandSignal = controller.signal;
    this.state.commandTimeoutMs = Math.min(this.commandTimeoutMs, timeoutMs);
    this.state.actionDeadlineAt = Date.now() + timeoutMs;
    const recoveryGeneration = this.state.cdpHelper.getInterruptionRecoveryState().generation;
    this.documentResponses.beginAction();

    const abortResult = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          if (relatedDialogPause) {
            reject(relatedDialogPause);
            return;
          }
          // Page.stopLoading would queue behind a held dialog and later cancel
          // the navigation the Agent's dialog decision starts. A navigation the
          // server already answered (a submit's 302, or the new document
          // arriving) is the result of an earlier write; stopping it would
          // leave the submitted form on screen as if nothing happened.
          if (!dialogInterrupted && !this.jsDialogs.current() && !this.mainFrameLoad.answered) {
            void this.state.transport.stopLoading().catch(() => undefined);
          }
          reject(
            new Error(
              timedOut
                ? `ACTION_TIMEOUT: Browser action exceeded ${timeoutMs}ms`
                : 'ABORTED: Browser action was cancelled',
            ),
          );
        },
        { once: true },
      );
    });

    let startResult: Promise<void> | undefined;
    let actionResult: Promise<unknown> | undefined;
    // A single-step write repeating an unverified uncertain write: reported, not refused.
    let writeRetryWarning: Record<string, unknown> | undefined;
    // Set once a write starts running: from then on its outcome is recorded.
    let writePage: { url?: string; targetLabel?: string } | undefined;
    // A CSS selector sent as `ref` that names one element runs as that selector.
    let targetInterpretation: BrowserTargetInterpretation | undefined;
    const dialogOpening = this.jsDialogs.watchOpening();
    const dialogResult = dialogOpening.promise.then((dialog) => ({ dialog }));
    try {
      if (BROWSER_WRITE_ACTIONS[action] === true) {
        const repeated = this.writes.repeatedBy(action, input);
        // In a program, or after page JavaScript the model did not see, a
        // repeated uncertain write is refused instead.
        if (repeated && (program !== undefined || repeated.reason === 'page_script')) {
          throw unverifiedWriteRetryError(action, repeated);
        }
        if (repeated) writeRetryWarning = unverifiedWriteRetryWarning(action, repeated);
      }
      if (NAVIGATION_ACTIONS[action] === true) this.writes.navigationStarted();
      let actionInput = input;
      // wait exists to wait out a load: a timeout wait reads nothing, and a
      // program's waitFor waits for the commit itself, so neither is refused.
      const waitKind = action === 'wait' ? asString(input.kind) : '';
      const runsDuringLoad =
        NAVIGATION_ACTIONS[action] === true ||
        waitKind === 'timeout' ||
        (program !== undefined && action === 'wait_for');
      if (!runsDuringLoad && this.mainFrameLoad.pending) {
        // Renderer commands wait for the pending commit; wait for it here with
        // browser-side events instead, and report a page that is still
        // loading rather than letting a read run into its command deadline.
        const gateStartedAt = Date.now();
        const waitMs =
          action === 'wait' || action === 'wait_for'
            ? timeoutMs - ACTION_COMPLETION_BUFFER_MS
            : Math.min(PENDING_LOAD_WAIT_MS, timeoutMs - ACTION_COMPLETION_BUFFER_MS);
        const committed = await this.mainFrameLoad.waitForCommit(waitMs, controller.signal);
        if (controller.signal.aborted) await abortResult;
        const load = this.mainFrameLoad.pending;
        if (!committed && load) {
          // A url or load wait did run: its condition is the commit that never came.
          return waitKind === 'url' || waitKind === 'load'
            ? waitStillLoadingResult(load)
            : pageStillLoadingResult(action, load);
        }
        if (action === 'wait') {
          // The wait for the commit counts against the wait's own timeout.
          const requested = asNumber(input.timeout, DEFAULT_WAIT_TIMEOUT_MS);
          actionInput = {
            ...input,
            timeout: Math.max(0, requested - (Date.now() - gateStartedAt)),
          };
        }
      }
      // A provider may have reset its CDP connection after the previous
      // command was cancelled. Starting here makes handler/session recovery a
      // precondition for every Core action, not just page scans.
      startResult = this.state.transport.start(controller.signal);
      await Promise.race([startResult, abortResult]);
      if (!program) {
        const interpreted = await Promise.race([
          interpretRefAsSelector(this.state, actionInput),
          abortResult,
        ]);
        actionInput = interpreted.input;
        targetInterpretation = interpreted.interpretation;
      }
      if (BROWSER_WRITE_ACTIONS[action] === true) {
        const url = this.state.snapshot?.page.url;
        const targetLabel = ref ? this.resolveOpaqueRef(ref)?.text : undefined;
        writePage = { ...(url ? { url } : {}), ...(targetLabel ? { targetLabel } : {}) };
      }
      actionResult = program ? program.run() : this.executeAction(action, actionInput);
      // Observe a late rejection after cancellation instead of leaking an
      // unhandled promise while the transport discards the late CDP response.
      actionResult.catch(() => undefined);
      // run_script observes the abort itself and must release held input on
      // this connection before the interruption reset below replaces it, so a
      // cancellation leaves it the cleanup budget. The action deadline already
      // includes that budget: past it the script is given up, whatever keeps it
      // from returning (a command nobody answers). A cancellation or deadline
      // that fires during that cleanup must still fail the action and run
      // recovery, even if the script had completed.
      if (action === 'run_script') {
        const scriptSettled = await Promise.race([
          actionResult.then((value) => ({ value })),
          abortResult.catch(async (error: unknown) => {
            if (!timedOut) await delay(BROWSER_SCRIPT_CLEANUP_BUDGET_MS);
            throw error;
          }),
          dialogResult,
        ]);
        if ('dialog' in scriptSettled) {
          // Page JavaScript (an alert/confirm inside the script, or one it
          // triggered) is paused on the dialog: end the action like any other
          // the dialog interrupted. The script observes the abort and gives up
          // within its cleanup budget; the next action waits for that.
          dialogInterrupted = true;
          this.abandonedAction = actionResult;
          controller.abort();
          this.invalidate(this.state);
          return browserJsDialogActiveResult(scriptSettled.dialog, action);
        }
        if (controller.signal.aborted) await abortResult;
        return this.documentResponses.annotate(scriptSettled.value);
      }
      const settled = await Promise.race([
        actionResult.then((value) => ({ value })),
        abortResult,
        dialogResult,
      ]);
      if ('dialog' in settled) {
        // The command that opened the dialog (for example mouseReleased)
        // stays blocked until the dialog closes. Return now instead of letting
        // the action run into its deadline; never report the action as done.
        dialogInterrupted = true;
        this.abandonedAction = actionResult;
        // Stop the rest of the interrupted action locally so its follow-up
        // steps cannot run against the page after the Agent handles the dialog.
        controller.abort();
        this.invalidate(this.state);
        return browserJsDialogActiveResult(settled.dialog, action);
      }
      const result = this.withWriteRecord(
        action,
        input,
        this.documentResponses.annotate(settled.value),
        writePage,
        writeRetryWarning,
      );
      const rebound = takeReboundRefs(this.state);
      return isRecord(result) && (targetInterpretation || rebound)
        ? {
            ...result,
            ...targetInterpretation,
            ...(rebound ? { targetRebound: { refs: rebound, note: BROWSER_REF_REBIND_NOTE } } : {}),
          }
        : result;
    } catch (error) {
      if (relatedDialogPause) {
        // Paused like a dialog of its own: the connection is healthy, and the
        // page resumes once the other page's dialog is handled or closed.
        if (actionResult) this.abandonedAction = actionResult;
        this.state.pageUnresponsive = undefined;
        this.invalidate(this.state);
        throw relatedDialogPause;
      }
      const heldDialog = this.jsDialogs.current();
      if (heldDialog && (controller.signal.aborted || isBrowserOperationInterruption(error))) {
        // A held dialog, not a broken connection, blocked the command. A
        // reconnect would lose the dialog, so leave the connection as is.
        dialogInterrupted = true;
        if (actionResult) this.abandonedAction = actionResult;
        this.state.pendingInputRelease = undefined;
        this.state.pageUnresponsive = undefined;
        this.invalidate(this.state);
        if (signal?.aborted) throw error;
        return browserJsDialogActiveResult(heldDialog, action);
      }
      // The server may have answered a submit before the action failed; say
      // so instead of inviting a duplicate submission.
      const observed = this.documentResponses.describeAndClear();
      if (observed && error instanceof Error) error.message = `${error.message} ${observed}`;
      if (targetInterpretation && error instanceof Error) {
        error.message = `${error.message} ${targetInterpretation.targetNote}`;
      }
      // The ref stays bound to the replacement: a retry with it acts there.
      const reboundOnError = takeReboundRefs(this.state);
      if (reboundOnError && error instanceof Error) {
        error.message = `${error.message} ${BROWSER_REF_REBIND_NOTE} (${reboundOnError.join(', ')})`;
      }
      if (writePage) {
        const outcome = classifyBrowserWriteError(error, {
          aborted: controller.signal.aborted,
          timedOut,
          serverAnswered: observed !== '',
        });
        this.writes.record(action, input, outcome, writePage);
        if (error instanceof Error && outcome.outcome === 'uncertain') {
          error.message = `${error.message} ${uncertainWriteNext(action)}`;
        }
        if (error instanceof Error && writeRetryWarning) {
          error.message = `${error.message} ${String(writeRetryWarning.message)}`;
        }
      }
      // A provider command can hit its own deadline before the encompassing
      // action timer fires. Either interruption leaves an already-sent CDP
      // side effect uncertain, so never release the action gate until the
      // connection has been reset or the session has been poisoned.
      if (controller.signal.aborted || isBrowserOperationInterruption(error)) {
        if (!controller.signal.aborted && !this.mainFrameLoad.answered) {
          void this.state.transport.stopLoading().catch(() => undefined);
        }
        const recoveryDeadline = Date.now() + this.commandTimeoutMs;
        const recovered = await this.recoverInterruptedOperation(
          recoveryGeneration,
          Math.max(1, recoveryDeadline - Date.now()),
        );
        const settled = await this.settleInterruptedOperation(
          startResult,
          actionResult,
          Math.max(1, recoveryDeadline - Date.now()),
        );
        this.invalidate(this.state);
        // A run_script release that could not reach the page is retried on
        // the recovered connection. If it still fails, the page may hold a
        // key or button down: poison the session so the provider recreates
        // the page instead of handing a stuck input state to the next action.
        const pendingRelease = this.state.pendingInputRelease;
        this.state.pendingInputRelease = undefined;
        const released =
          recovered && pendingRelease
            ? (await deliverInputRelease(this.state, pendingRelease)).length === 0
            : !pendingRelease;
        // A reconnect does not stop a page-side loop. If run_script could not
        // stop its page JavaScript, the page must respond on the new
        // connection before the session is reused.
        const pageUnresponsive = this.state.pageUnresponsive === true;
        this.state.pageUnresponsive = undefined;
        const responsive = pageUnresponsive
          ? recovered && (await stopPageExecution(this.state))
          : true;
        this.poisoned = !recovered || !settled || !released || !responsive;
      }
      throw error;
    } finally {
      dialogOpening.cancel();
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
      this.state.commandSignal = undefined;
      this.state.commandTimeoutMs = undefined;
      this.state.actionDeadlineAt = undefined;
      this.state.commandSessionId = undefined;
      // Interception of page JavaScript ends with its action, whatever ended it.
      await endLeftoverPageScriptInterception(this.state, LEFTOVER_INTERCEPTION_DISABLE_MS);
      this.active = false;
    }
  }

  /**
   * Resolve dialog actions and block page actions while a dialog is held.
   * Returns undefined when the action should run normally.
   */
  private async executeJsDialogGate(
    action: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (action === 'get_js_dialog') {
      const dialog = this.jsDialogs.current();
      return {
        success: true,
        dialog: dialog ? { dialogId: dialog.dialogId, type: dialog.type } : null,
        ...(!dialog && this.jsDialogs.awaitingUser() ? { awaitingUser: true } : {}),
      };
    }
    if (action === 'handle_js_dialog') {
      const request = parseBrowserJsDialogHandleInput(input);
      const dialog = this.jsDialogs.current();
      if (
        request.decision === 'accept' &&
        dialog?.dialogId === request.dialogId &&
        this.needsInspectBeforeAccept(dialog)
      ) {
        return browserJsDialogActiveResult(dialog, action);
      }
      return this.handleJsDialog(request.dialogId, request.decision, request.promptText);
    }
    const dialog = this.jsDialogs.current();
    const dialogRef = parseBrowserJsDialogRef(asString(input.ref));
    if (!dialog) {
      // A virtual dialog ref outlives its dialog only as a stale reference.
      if (dialogRef) return browserJsDialogNotActiveResult();
      // A dialog handed back to the user still blocks every page command.
      return this.jsDialogs.awaitingUser() ? browserJsDialogAwaitingUserResult(action) : undefined;
    }
    if (action === 'inspect') {
      this.jsDialogSeenId = dialog.dialogId;
      return browserJsDialogSnapshot(dialog);
    }
    if (dialogRef && dialogRef.dialogId !== dialog.dialogId) {
      return browserJsDialogNotActiveResult();
    }
    if (
      dialogRef &&
      (action === 'click' ||
        action === 'double_click' ||
        action === 'triple_click' ||
        action === 'click_and_wait_for_navigation')
    ) {
      if (dialogRef.part === 'text') {
        return { success: true, effect: { dispatched: true, verified: true } };
      }
      if (dialogRef.part === 'accept' && this.needsInspectBeforeAccept(dialog)) {
        return browserJsDialogActiveResult(dialog, action);
      }
      return this.handleJsDialog(
        dialog.dialogId,
        dialogRef.part,
        dialogRef.part === 'accept' ? this.promptDraft(dialog) : undefined,
      );
    }
    if (dialogRef?.part === 'text' && (action === 'fill' || action === 'type')) {
      const previous =
        action === 'type' && this.jsDialogPromptDraft?.dialogId === dialog.dialogId
          ? this.jsDialogPromptDraft.text
          : '';
      this.jsDialogPromptDraft = {
        dialogId: dialog.dialogId,
        text: previous + asString(input.text),
      };
      return { success: true, effect: { dispatched: true, verified: true } };
    }
    if (action === 'press_key' && (!asString(input.ref) || dialogRef)) {
      const decision = browserJsDialogKeyDecision(dialog, asString(input.key));
      // Accepting confirms a page action, so it needs a dialog the Agent has read.
      if (decision === 'dismiss') return this.handleJsDialog(dialog.dialogId, decision);
      if (decision === 'accept' && this.jsDialogSeenId === dialog.dialogId) {
        return this.handleJsDialog(dialog.dialogId, decision, this.promptDraft(dialog));
      }
    }
    return browserJsDialogActiveResult(dialog, action);
  }

  /**
   * Accepting a confirm or prompt performs a page action, so the Agent must
   * have read the dialog through inspect first. Ref actions do not count as reads.
   */
  private needsInspectBeforeAccept(dialog: BrowserJsDialogState): boolean {
    return (
      (dialog.type === 'confirm' || dialog.type === 'prompt') &&
      this.jsDialogSeenId !== dialog.dialogId
    );
  }

  private promptDraft(dialog: BrowserJsDialogState): string | undefined {
    if (dialog.type !== 'prompt') return undefined;
    return this.jsDialogPromptDraft?.dialogId === dialog.dialogId
      ? this.jsDialogPromptDraft.text
      : dialog.defaultPrompt;
  }

  private async handleJsDialog(
    dialogId: string,
    decision: BrowserJsDialogDecision,
    promptText?: string,
  ): Promise<Record<string, unknown>> {
    const dialog = this.jsDialogs.current();
    if (!dialog || dialog.dialogId !== dialogId) return browserJsDialogNotActiveResult();
    const resolved = resolveBrowserJsDialogDecision(dialog, {
      decision,
      ...(promptText !== undefined ? { promptText } : {}),
    });
    // execute() holds the session for the whole call.
    try {
      await this.jsDialogs.handle(dialogId, resolved.accept, resolved.promptText);
    } catch (error) {
      if (isBrowserJsDialogNotActiveError(error)) return browserJsDialogNotActiveResult();
      throw error;
    }
    if (this.jsDialogPromptDraft?.dialogId === dialogId) this.jsDialogPromptDraft = undefined;
    return { success: true, handled: true, type: dialog.type, action: decision };
  }

  /** Let an action a dialog interrupted finish before the next action reuses the page. */
  private async settleAbandonedAction(): Promise<void> {
    const abandoned = this.abandonedAction;
    if (!abandoned) return;
    this.abandonedAction = undefined;
    await withTimeout(
      abandoned.then(
        () => undefined,
        () => undefined,
      ),
      ABANDONED_ACTION_SETTLE_MS,
      'Browser dialog-interrupted action settlement',
    ).catch(() => undefined);
  }

  private async recoverInterruptedOperation(
    recoveryGeneration: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const helperRecovery = this.state.cdpHelper.getInterruptionRecoveryState();
    if (helperRecovery.generation !== recoveryGeneration) {
      return helperRecovery.succeeded;
    }
    return this.state.cdpHelper.recoverTransportAfterInterruption(timeoutMs, true);
  }

  private async settleInterruptedOperation(
    startResult: Promise<void> | undefined,
    actionResult: Promise<unknown> | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    const pending = [startResult, actionResult].filter(
      (candidate): candidate is Promise<unknown> => candidate !== undefined,
    );
    if (pending.length === 0) return true;
    try {
      await withTimeout(
        Promise.allSettled(pending).then(() => undefined),
        timeoutMs,
        'Browser interrupted action settlement',
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Record a write's outcome (browser-write-record.ts). An uncertain write
   * carries `uncertainWrite` with the one "check before repeating" sentence,
   * and an UNEXPECTED_NAVIGATION is retryable only when nothing was sent and
   * no form was submitted. A successful read verifies the page, unless a
   * main-frame load is still pending (the page shown is then the one from
   * before that load, and the read says so in `pendingNavigation`) or the read
   * is the host's automatic screenshot after an action (`__postActionVisual`):
   * the model did not choose it, and it frames that action's target, not the
   * outcome of an earlier uncertain write.
   */
  private withWriteRecord(
    action: string,
    input: Record<string, unknown>,
    result: unknown,
    page: { url?: string; targetLabel?: string } | undefined,
    retryWarning: Record<string, unknown> | undefined,
  ): unknown {
    if (!page) {
      if (
        BROWSER_PAGE_READ_ACTIONS[action] !== true ||
        (isRecord(result) && result.success === false)
      ) {
        return result;
      }
      const load = this.mainFrameLoad.pending;
      if (load) {
        return isRecord(result)
          ? { ...result, pendingNavigation: pendingNavigationReport(load) }
          : result;
      }
      // A timer wait shows nothing about the page, so it cannot verify a write.
      const verifies =
        !(action === 'wait' && input.kind === 'timeout') && input.__postActionVisual !== true;
      if (verifies) this.writes.pageRead();
      return result;
    }
    if (!isRecord(result)) {
      this.writes.record(action, input, { outcome: 'succeeded' }, page);
      return result;
    }
    let reported = result;
    if (result.code === 'UNEXPECTED_NAVIGATION') {
      const effect = isRecord(result.effect) ? result.effect : {};
      const navigation = isRecord(result.navigation) ? result.navigation : {};
      const requestMethod = asString(navigation.requestMethod);
      reported = {
        ...result,
        ...unexpectedNavigationRetry(action, {
          dispatched: effect.dispatched !== false,
          ...(requestMethod ? { requestMethod } : {}),
        }),
      };
    }
    const outcome = classifyBrowserWriteResult(reported);
    this.writes.record(action, input, outcome, page);
    return {
      ...reported,
      ...(outcome.outcome === 'uncertain'
        ? { uncertainWrite: { reason: outcome.reason, message: uncertainWriteNext(action) } }
        : {}),
      ...(retryWarning ? { writeRetryWarning: retryWarning } : {}),
    };
  }

  /**
   * Network delivers the submitted document's HTTP status to
   * BrowserDocumentResponseTracker. Diagnostics only: a page that cannot
   * enable it still gets the action. A connection reset drops enabled
   * domains, so it is enabled again per recovery generation.
   */
  private async enableNetworkForSubmit(): Promise<void> {
    const generation = this.state.cdpHelper.getInterruptionRecoveryState().generation;
    if (this.networkEnabledGeneration === generation) return;
    try {
      await this.state.transport.send('Network.enable', undefined, undefined, {
        ...(this.state.commandSignal ? { signal: this.state.commandSignal } : {}),
        ...(this.state.commandTimeoutMs ? { timeoutMs: this.state.commandTimeoutMs } : {}),
      });
    } catch (error) {
      if (isBrowserOperationInterruption(error)) throw error;
      return;
    }
    this.networkEnabledGeneration = generation;
  }

  private async executeAction(action: string, input: Record<string, unknown>): Promise<unknown> {
    if (action !== 'press_key') this.state.keyboardContinuationTarget = undefined;
    if (SUBMIT_CAPABLE_ACTIONS[action] === true) await this.enableNetworkForSubmit();
    switch (action) {
      case 'inspect':
        return this.inspect(this.state, input);
      case 'query':
        return this.query(this.state, input);
      case 'navigate':
        return this.navigate(this.state, input);
      case 'back':
        return this.history(this.state, 'back');
      case 'forward':
        return this.history(this.state, 'forward');
      case 'reload':
        return this.reload(this.state);
      case 'click':
        return this.click(this.state, input);
      case 'click_and_wait_for_navigation':
        return this.clickAndWaitForNavigation(input, this.actionTimeoutMs);
      case 'double_click':
        return this.click(this.state, { ...input, clickCount: 2 });
      case 'triple_click':
        return this.click(this.state, { ...input, clickCount: 3 });
      case 'drag':
        return this.drag(input);
      case 'fill':
        return this.type(this.state, { ...input, clear: true });
      case 'type':
        return this.type(this.state, input);
      case 'press_key':
        return this.pressKey(this.state, input);
      case 'check':
        return this.setChecked(this.state, input, true);
      case 'uncheck':
        return this.setChecked(this.state, input, false);
      case 'select_option':
        return this.selectOption(this.state, input);
      case 'upload_files':
        return this.uploadFiles(this.state, input);
      case 'paste':
        return this.paste(this.state, input);
      case 'scroll':
        return this.scroll(this.state, input);
      case 'hover':
        return this.hover(input);
      case 'wait':
      case 'wait_for':
        return this.waitFor(this.state, input);
      case 'get_dom':
        return this.query(this.state, { ...input, kind: 'dom' });
      case 'screenshot':
        return this.screenshot(this.state, input);
      case 'verify_text':
        return this.verifyText(input);
      case 'inspect_editable_targets':
        return this.query(this.state, { ...input, kind: 'editable' });
      case 'run_script':
        return this.runScript(input);
      case 'get_js_dialog':
      case 'handle_js_dialog':
        // Resolved by executeJsDialogGate before any page command is sent.
        throw new Error(`Unsupported Browser Core action: ${action}`);
      case 'open_tab':
      case 'list_tabs':
      case 'select_tab':
      case 'close_tab':
        throw new Error(`PROVIDER_LIFECYCLE_ACTION: ${action} must be handled by the provider`);
      default:
        throw new Error(`Unsupported Browser Core action: ${String(action)}`);
    }
  }

  private async runScript(input: Record<string, unknown>): Promise<unknown> {
    const code = asString(input.code);
    if (!code.trim()) throw new Error('SCRIPT_REQUIRED: run_script requires non-empty code');
    if (Buffer.byteLength(code, 'utf8') > BROWSER_SCRIPT_MAX_CODE_BYTES) {
      throw new Error(
        `SCRIPT_TOO_LARGE: run_script code exceeds ${BROWSER_SCRIPT_MAX_CODE_BYTES} bytes`,
      );
    }
    const signal = this.state.commandSignal;
    if (!signal) throw new Error('SCRIPT_CONTEXT_UNAVAILABLE');
    const filename = asString(input.filename).trim() || 'browser-script.js';
    const generation = this.state.generation;
    try {
      const result = await new BrowserScriptRun(this.state, {
        code,
        filename,
        timeoutMs: browserScriptTimeoutMs(input),
        signal,
        captureScreenshot: (captureInput) => this.screenshot(this.state, captureInput),
        // Like a program's page script: until the page is read, the next write is refused.
        recordPageScriptWrite: (url) => {
          this.writes.record(
            'run_script',
            {},
            { outcome: 'uncertain', reason: 'page_script' },
            { ...(url ? { url } : {}), anyTarget: true },
          );
        },
      }).run();
      return result.pageScript?.writeLike === true
        ? {
            ...result,
            uncertainWrite: { reason: 'page_script', message: uncertainWriteNext('run_script') },
          }
        : result;
    } finally {
      // A script may navigate, mutate the DOM, or leave focus anywhere: refs
      // issued before it are no longer trustworthy evidence.
      if (this.state.generation === generation) this.invalidate(this.state);
    }
  }

  private async clickAndWaitForNavigation(
    input: Record<string, unknown>,
    defaultTimeoutMs: number,
  ): Promise<unknown> {
    const timeoutMs = Math.max(
      1_000,
      Math.min(
        MAX_ACTION_TIMEOUT_MS,
        positiveDeadline(asNumber(input.timeout, defaultTimeoutMs), defaultTimeoutMs),
      ),
    );
    // Every wait below shares this deadline, so the action returns before the
    // enclosing action timer fires: that timer stops the page load and resets
    // the connection, cancelling a submit's slow follow-up page.
    const deadlineAt = Date.now() + timeoutMs;
    const before = await this.readPageSummary(this.state);
    const beforeTimeOrigin = await this.evaluateMainDocument<number>(
      this.state,
      'performance.timeOrigin',
    );
    const result = await this.click(this.state, {
      ...input,
      __navigationTimeoutMs: Math.max(
        1,
        deadlineAt - Date.now() - CLICK_AND_WAIT_RESULT_RESERVE_MS,
      ),
    });
    if (!isRecord(result)) return result;
    // Nothing was dispatched: the hit test already explains why.
    if (result.code === 'TARGET_NOT_INTERACTABLE') return result;
    const navigation = isRecord(result.navigation) ? result.navigation : {};
    const detected = result.code === 'UNEXPECTED_NAVIGATION' || navigation.detected === true;
    // The click started a main-frame navigation that has not committed by the
    // deadline (a forum submit: POST /submit answered 302 in 0.3 s, the post
    // it redirected to took 48 s; or a slow GET page after a committed one).
    // The load keeps running; a submit may already have reached the server.
    const pendingResult = (pending: BrowserPendingMainFrameLoad, committed: boolean) => {
      const status = pending.httpStatus ?? pending.redirectStatus;
      return {
        ...result,
        success: true,
        ...(committed
          ? pending.url
            ? { url: pending.url }
            : {}
          : { url: before.url, title: before.title }),
        message: `The click ${committed ? 'navigated, and the page then started' : 'started'} a ${pending.requestMethod ?? 'page'} navigation that was still loading after ${timeoutMs}ms; the page shown is still the previous one.${status === undefined ? '' : ` The server already answered the request with HTTP ${status}.`}`,
        recovery:
          'Do not click or submit again. The page load keeps running and the URL changes when the new page arrives: wait for it or inspect the page again in a few seconds, and check the result on the site before any retry.',
        navigation: {
          ...navigation,
          detected: true,
          urlChanged: committed,
          loaded: false,
          ...pendingLoadFacts(pending),
          generation: this.state.generation,
        },
      };
    };
    const pending = detected ? undefined : this.mainFrameLoad.pending;
    if (pending) return pendingResult(pending, false);
    if (!detected) {
      // Eval 774252: models re-chose click_and_wait_for_navigation for tabs,
      // menus and dialog triggers after this failure (5 times in one case,
      // ~30s each) because the recovery did not say why nothing navigated.
      // URL changes, including same-document history updates, already count
      // as navigation above, so reaching here means the URL stayed the same.
      return {
        ...result,
        success: false,
        code: 'ACTION_TIMEOUT',
        error: 'The click did not produce an observable main-document navigation.',
        recovery:
          'The click was dispatched but the URL did not change, so this control most likely updates the page in place (menu, tab, dialog, inline form). Inspect the current page to see its effect; for such controls use click, and reserve click_and_wait_for_navigation for links that load a new page.',
      };
    }
    try {
      const ready = await this.waitForDocumentReady(
        this.state,
        (state) => state.url !== before.url || state.timeOrigin !== beforeTimeOrigin,
        Math.max(1, deadlineAt - Date.now()),
      );
      const page = await this.readPageSummary(this.state);
      this.assertNotChromeErrorPage(page, 'after the click');
      const normalized: Record<string, unknown> = { ...result, success: true, url: page.url };
      delete normalized.code;
      delete normalized.error;
      delete normalized.recovery;
      normalized.title = page.title;
      normalized.navigation = {
        ...navigation,
        detected: true,
        urlChanged: page.url !== before.url,
        loaded: true,
        awaited: true,
        readyState: ready.readyState,
        generation: this.state.generation,
      };
      return normalized;
    } catch (error) {
      if (isBrowserOperationInterruption(error)) throw error;
      // The click's navigation committed, and an answered GET load that
      // followed it (a client redirect to a slow page) was still pending at
      // the deadline: the same pending report as navigate and reload.
      if (error instanceof MainFrameNavigationPending) return pendingResult(error.load, true);
      // The first document of the click's navigation committed: the server
      // answered, so a submit may have landed even though the load failed.
      return {
        ...result,
        success: false,
        code: 'NAVIGATION_FAILED',
        error: error instanceof Error ? error.message : String(error),
        recovery: 'Inspect the current page before deciding whether to retry.',
        navigation: {
          ...navigation,
          detected: true,
          loaded: false,
          generation: this.state.generation,
        },
      };
    }
  }

  private async hover(input: Record<string, unknown>): Promise<unknown> {
    const startedAt = Date.now();
    const coordinateTarget =
      input.position !== undefined || input.normalized_position !== undefined;
    const resolved = await this.resolveTarget(this.state, input).catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    );
    if (resolved instanceof Error) {
      // A ref whose element has no box (display: none) reads as stale; say what hides it.
      if (!coordinateTarget && /no longer has a live box/u.test(resolved.message)) {
        const hidden = await probeBrowserClickTarget(this.state, input, {});
        if (hidden.blocked) {
          return targetNotInteractableResult('hover', hidden.blocked, Date.now() - startedAt);
        }
      }
      throw resolved;
    }
    // Pre-hover hit test, as for a click: the pointer would otherwise land on
    // whatever covers the target or sits where a hidden target's box is (the
    // visible row below a collapsed group), and hover that instead.
    const probe = coordinateTarget ? {} : await probeBrowserClickTarget(this.state, input, {});
    if (probe.blocked) {
      return targetNotInteractableResult('hover', probe.blocked, Date.now() - startedAt);
    }
    const target = aimAtProbe(resolved, probe);
    const hoverPoint = inputCoordinate(this.state, { x: target.x, y: target.y });
    const ref = asString(input.ref);
    const fallbackText = ref ? (this.state.elementMap.getElementByOpaqueRef(ref)?.text ?? '') : '';
    const captureSemantic = async () => {
      if (target.backendNodeId === undefined) return null;
      const snapshot = await this.state.cdpHelper
        .captureHoverSemanticSnapshotByBackendNodeId(target.backendNodeId, {
          ...(this.state.commandSignal ? { signal: this.state.commandSignal } : {}),
          ...(this.state.commandTimeoutMs ? { timeoutMs: this.state.commandTimeoutMs } : {}),
          ...(this.state.commandSessionId ? { commandSessionId: this.state.commandSessionId } : {}),
        })
        .catch((error) => {
          if (isBrowserOperationInterruption(error)) throw error;
          return null;
        });
      return isHoverSemanticSnapshot(snapshot) ? snapshot : null;
    };
    const before = await captureSemantic();
    await this.state.beforePointerAction?.(
      { action: 'hover', point: { x: target.x, y: target.y } },
      this.state.commandSignal,
    );
    await this.state.transport.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', ...hoverPoint },
      undefined,
      { signal: this.state.commandSignal, timeoutMs: this.state.commandTimeoutMs },
    );
    const hovered =
      target.backendNodeId === undefined
        ? true
        : await this.callBackendNode<boolean>(
            this.state,
            target.backendNodeId,
            `function () { return this.matches(':hover') || this.contains(document.elementFromPoint(${target.contextX ?? target.x}, ${target.contextY ?? target.y})); }`,
          ).catch((error) => {
            if (isBrowserOperationInterruption(error)) throw error;
            return false;
          });
    let after = null;
    let semanticEffect = resolveBrowserHoverSemantic(before, after, fallbackText);
    // Models pass click/type-style `delay` here to give slow tooltips time to
    // appear (eval 766011 rejected it as invalid_input). Treat it as a pointer
    // hold: keep sampling across the hold and do not return before it elapses.
    const holdMs = Math.max(0, Math.min(5_000, asNumber(input.delay, 0)));
    const holdUntil = Date.now() + holdMs;
    if (target.backendNodeId !== undefined) {
      const samples = Math.max(
        HOVER_SEMANTIC_SAMPLE_COUNT,
        Math.ceil(holdMs / HOVER_SEMANTIC_SAMPLE_DELAY_MS),
      );
      for (let sample = 0; sample < samples; sample += 1) {
        await delay(HOVER_SEMANTIC_SAMPLE_DELAY_MS, this.state.commandSignal);
        after = await captureSemantic();
        semanticEffect = resolveBrowserHoverSemantic(before, after, fallbackText);
        if (semanticEffect.semantic.name) break;
      }
    }
    const remainingHoldMs = holdUntil - Date.now();
    if (remainingHoldMs > 0) await delay(remainingHoldMs, this.state.commandSignal);
    return {
      success: hovered,
      durationMs: Date.now() - startedAt,
      target: { resolved: true, ...(target.rect ? { rect: target.rect } : {}) },
      effect: {
        dispatched: true,
        verified: hovered,
        hovered,
        tooltipObserved: semanticEffect.tooltipObserved,
        semantic: semanticEffect.semantic,
      },
    };
  }

  private async drag(input: Record<string, unknown>): Promise<unknown> {
    const sourceInput = isRecord(input.source) ? input.source : input;
    const targetInput = isRecord(input.target) ? input.target : undefined;
    if (!targetInput) throw new Error('DRAG_REQUIRES_TARGET');
    await this.resolveTarget(this.state, sourceInput);
    await this.resolveTarget(this.state, targetInput);
    // Resolving the target may scroll the same container that owns the source.
    // Measure both endpoints again without another scroll before dispatching.
    const source = await this.resolveTarget(this.state, sourceInput, false);
    const target = await this.resolveTarget(this.state, targetInput, false);
    const viewport = await this.readCssViewport(this.state);
    if (
      !dragTargetIsVisible(source.rect, viewport) ||
      !dragTargetIsVisible(target.rect, viewport)
    ) {
      throw new Error(
        'ELEMENT_NOT_INTERACTABLE: drag source and target are not simultaneously visible',
      );
    }
    await this.state.beforePointerAction?.(
      { action: 'drag', point: { x: source.x, y: source.y } },
      this.state.commandSignal,
    );
    const dragResult = await this.state.cdpHelper.dispatchDragGesture(
      inputCoordinate(this.state, { x: source.x, y: source.y }),
      inputCoordinate(this.state, { x: target.x, y: target.y }),
      {
        interceptTimeoutMs: Math.min(this.state.commandTimeoutMs ?? 2_000, 2_000),
        commandTimeoutMs: this.state.commandTimeoutMs,
        signal: this.state.commandSignal,
      },
    );
    await this.state.beforePointerAction?.(
      { action: 'drag', point: { x: target.x, y: target.y } },
      this.state.commandSignal,
    );
    this.invalidateObservation(this.state);
    return {
      success: true,
      ...dragResult,
      // A completed CDP gesture proves dispatch, not that the application
      // accepted the drop or changed business state. Keep that distinction
      // explicit so agents verify the page after dragging.
      effect: { dispatched: true, verified: false, verificationRequired: true },
    };
  }

  private async verifyText(input: Record<string, unknown>): Promise<unknown> {
    const result = await this.query(this.state, {
      kind: 'text',
      ...(typeof input.selector === 'string' ? { selector: input.selector } : {}),
      maxChars: 50_000,
    });
    const actual = asString(isRecord(result) ? result.text : '');
    const expected = Array.isArray(input.texts)
      ? input.texts.map(String)
      : typeof input.text === 'string'
        ? [input.text]
        : [];
    const caseSensitive = input.caseSensitive === true;
    const haystack = caseSensitive ? actual : actual.toLocaleLowerCase();
    const matches = expected.map((item) => {
      const needle = caseSensitive ? item : item.toLocaleLowerCase();
      return input.exact === true ? haystack.trim() === needle.trim() : haystack.includes(needle);
    });
    return {
      success: matches.length > 0 && matches.every(Boolean),
      expected,
      matches,
      text: actual.slice(0, 2_000),
    };
  }
}

/** The Browser action whose rules (dialogs, pending loads, write record) an op follows. */
const PROGRAM_GATE_ACTION: Readonly<Record<Exclude<ProgramOp['op'], 'networkCheckpoint'>, string>> =
  {
    goto: 'navigate',
    back: 'back',
    reload: 'reload',
    click: 'click',
    dblclick: 'double_click',
    hover: 'hover',
    check: 'check',
    uncheck: 'uncheck',
    fill: 'fill',
    type: 'type',
    press: 'press_key',
    selectOption: 'select_option',
    read: 'query',
    readAll: 'query',
    rows: 'query',
    waitFor: 'wait_for',
    waitForResponse: 'wait',
    observe: 'inspect',
    url: 'query',
    title: 'query',
    screenshot: 'screenshot',
    handleDialog: 'handle_js_dialog',
    mouseClick: 'click',
    mouseMove: 'hover',
    mouseWheel: 'scroll',
    evaluate: 'evaluate',
  };

/**
 * The op's own timeout ends it with a normal failure; the gate deadline, which
 * also stops the load and resets the connection, only catches a hung page. It
 * leaves room for the wait on a pending load before the op starts.
 */
function programGateTimeout(op: ProgramOp): number {
  // A page script call stops itself at 10 s; interception, the request drain
  // and stopping a busy page take the rest.
  const inner =
    op.op === 'evaluate'
      ? (op.poll ? (op.timeoutMs ?? 30_000) : 10_000) + 3_000
      : (op.timeoutMs ??
        (op.op === 'goto' ||
        op.op === 'back' ||
        op.op === 'reload' ||
        op.op === 'waitFor' ||
        op.op === 'waitForResponse'
          ? 30_000
          : 5_000));
  return Math.min(MAX_ACTION_TIMEOUT_MS, inner + PENDING_LOAD_WAIT_MS + PROGRAM_GATE_MARGIN_MS);
}

/** What the write record and the action rules see as the op's target. */
function programGateInput(op: ProgramOp, target: string | undefined): Record<string, unknown> {
  if (op.op === 'mouseClick' || op.op === 'mouseMove' || op.op === 'mouseWheel') {
    return { position: { x: op.x, y: op.y } };
  }
  const locatorInput = target ? { selector: target } : {};
  // The key tells an Escape apart from a repeat of an uncertain Enter.
  return op.op === 'press' ? { ...locatorInput, key: op.key } : locatorInput;
}

function programOpFailure(op: string, error: unknown, startedAt: number): ProgramOpResult {
  const failure = programFailureFrom(error);
  return {
    ok: false,
    error: failure,
    step: { op, write: false, durationMs: Date.now() - startedAt, code: failure.code },
  };
}

function dragTargetIsVisible(
  rect: { x: number; y: number; width: number; height: number } | undefined,
  viewport: { width: number; height: number },
): boolean {
  return Boolean(
    rect &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= viewport.width &&
    rect.y + rect.height <= viewport.height,
  );
}

function positiveDeadline(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function actionDeadline(
  action: string,
  input: Record<string, unknown>,
  requestedMs: number,
  fallback: number,
  focusedKeyboard = false,
): number {
  const requested = Math.min(MAX_ACTION_TIMEOUT_MS, positiveDeadline(requestedMs, fallback));
  if (action === 'fill' || action === 'type') {
    const text = asString(input.text);
    const rawDelay = input.delay;
    const delayMs =
      typeof rawDelay === 'number' ? rawDelay : typeof rawDelay === 'string' ? Number(rawDelay) : 0;
    if (text.length > 0 && Number.isFinite(delayMs) && (delayMs > 0 || focusedKeyboard)) {
      const characters = Array.from(text);
      const delayedInputMs = characters.length * Math.max(0, delayMs);
      const cdpDispatchMs = focusedKeyboard
        ? characters.reduce(
            (count, character) => count + (/^[\x20-\x7E]$/u.test(character) ? 3 : 1),
            action === 'fill' || input.clear === true ? 4 : 0,
          ) * TEXT_INPUT_CDP_EVENT_ESTIMATE_MS
        : 0;
      const required = Math.ceil(delayedInputMs + cdpDispatchMs) + TEXT_INPUT_COMPLETION_BUFFER_MS;
      if (required > MAX_ACTION_TIMEOUT_MS) {
        throw new Error(
          `INPUT_DURATION_EXCEEDS_DEADLINE: Delayed input requires ${required}ms but the maximum safe Browser action budget is ${MAX_ACTION_TIMEOUT_MS}ms`,
        );
      }
      return Math.max(requested, required);
    }
  }
  if (action === 'click_and_wait_for_navigation') {
    return Math.min(MAX_ACTION_TIMEOUT_MS, requested + ACTION_COMPLETION_BUFFER_MS);
  }
  if (action === 'upload_files') {
    return Math.min(MAX_ACTION_WITH_COMPLETION_BUFFER_MS, requested + ACTION_COMPLETION_BUFFER_MS);
  }
  if (action === 'navigate' || action === 'reload') {
    // The readiness probe owns a 30s window after page summaries, diagnostics
    // setup and the navigation CDP command. Keep those preconditions outside
    // the readiness budget instead of letting the default 30s action timer
    // cancel an otherwise valid slow navigation.
    return Math.max(requested, NAVIGATION_ACTION_TIMEOUT_MS);
  }
  if (action === 'run_script') return browserScriptActionDeadlineMs(input);
  if (action !== 'wait' && action !== 'wait_for') return requested;
  // `wait.timeout` is the condition budget. Keep a small cleanup margin so a
  // successful timeout wait is not cancelled by the enclosing action timer.
  return Math.min(MAX_ACTION_TIMEOUT_MS, requested + 1_000);
}
