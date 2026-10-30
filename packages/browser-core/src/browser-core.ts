import type { ClipboardProvider } from './clipboard.js';
import { classifyBrowserNavigationEvent } from './browser-action-helpers.js';
import { BrowserExtendedActionSupport } from './browser-extended-actions.js';
import { isHoverSemanticSnapshot, resolveBrowserHoverSemantic } from './browser-hover-semantic.js';
import {
  asNumber,
  asString,
  delay,
  inputCoordinate,
  isRecord,
  invalidateBrowserFrame,
  resolveBrowserSnapshotElement,
  type ElementRecord,
  type BrowserScreenshotCapture,
  type BrowserSessionState,
} from './browser-state.js';
import type { BrowserTransport } from './browser-transport.js';
import { CDPHelper } from './cdp-helper.js';
import { ElementMapManager } from './element-map-manager.js';
import {
  BROWSER_SCRIPT_CLEANUP_BUDGET_MS,
  BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS,
  BROWSER_SCRIPT_MAX_CODE_BYTES,
  BROWSER_SCRIPT_MAX_TIMEOUT_MS,
  BrowserScriptRun,
  deliverInputRelease,
  stopPageExecution,
} from './browser-script.js';
import { isBrowserOperationInterruption, withTimeout } from './operation-timeout.js';

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const MAX_ACTION_TIMEOUT_MS = 120_000;
const MAX_ACTION_WITH_COMPLETION_BUFFER_MS = 125_000;
const NAVIGATION_ACTION_TIMEOUT_MS = 35_000;
const TEXT_INPUT_COMPLETION_BUFFER_MS = 30_000;
const TEXT_INPUT_CDP_EVENT_ESTIMATE_MS = 20;
const ACTION_COMPLETION_BUFFER_MS = 1_000;
const HOVER_SEMANTIC_SAMPLE_DELAY_MS = 160;
const HOVER_SEMANTIC_SAMPLE_COUNT = 6;

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
  private readonly actionTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private active = false;
  private poisoned = false;
  private externalNavigationGeneration = 0;
  private readonly navigationEventDisposer: () => void;

  constructor(transport: BrowserTransport, options: BrowserCoreSessionOptions = {}) {
    super(options.clipboardProvider);
    if (options.cdpHelper && options.cdpHelper.getTransport() !== transport) {
      throw new Error('Browser Core CDP helper must own the supplied page transport');
    }
    const cdpHelper = options.cdpHelper ?? new CDPHelper(transport);
    this.ownsCdpHelper = options.cdpHelper === undefined;
    this.state = {
      transport,
      cdpHelper,
      elementMap: new ElementMapManager(),
      generation: 0,
      ...(options.inputCoordinateScaleProvider
        ? { inputCoordinateScaleProvider: options.inputCoordinateScaleProvider }
        : {}),
      ...(options.beforePointerAction ? { beforePointerAction: options.beforePointerAction } : {}),
      ...(options.captureScreenshot ? { captureScreenshot: options.captureScreenshot } : {}),
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
    this.navigationEventDisposer = transport.onEvent((event) => {
      const params = isRecord(event.params) ? event.params : {};
      const frame = isRecord(params.frame) ? params.frame : {};
      const frameId = asString(frame.id) || asString(params.frameId);
      const commandSessionId = event.sessionId || asString(params.sessionId);
      const mainFrameId = this.state.cdpHelper.getMainFrameId();
      const navigationScope = classifyBrowserNavigationEvent(event, transport, mainFrameId);
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

  /** Release the lifecycle listener before the provider closes its transport. */
  dispose(): void {
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
    if (this.active) throw new Error('BROWSER_SESSION_BUSY: another Browser action is running');
    if (this.poisoned) {
      throw new Error(
        'BROWSER_SESSION_POISONED: Browser connection recovery failed; recreate the Browser session and inspect the page before continuing',
      );
    }
    if (signal?.aborted) throw new Error('ABORTED: Browser action was cancelled');
    const requestedTimeoutMs = asNumber(input.timeout, this.actionTimeoutMs);
    const ref = asString(input.ref);
    const textTarget =
      ref && (action === 'fill' || action === 'type')
        ? (resolveBrowserSnapshotElement(this.state, ref)?.element ??
          this.state.elementMap.getElementByOpaqueRef(ref))
        : null;
    const timeoutMs = actionDeadline(
      action,
      input,
      requestedTimeoutMs,
      this.actionTimeoutMs,
      textTarget?.virtualEditor === true,
    );
    // Validate the complete action deadline before claiming the session. The
    // deadline calculation can reject synchronously (for example, delayed
    // input that cannot fit within the maximum action budget); such a rejected
    // request must not leave the session permanently busy.
    this.active = true;
    const controller = new AbortController();
    let timedOut = false;
    const forwardAbort = (): void => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    this.state.commandSignal = controller.signal;
    this.state.commandTimeoutMs = Math.min(this.commandTimeoutMs, timeoutMs);
    const recoveryGeneration = this.state.cdpHelper.getInterruptionRecoveryState().generation;

    const abortResult = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          void this.state.transport.stopLoading().catch(() => undefined);
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
    try {
      // A provider may have reset its CDP connection after the previous
      // command was cancelled. Starting here makes handler/session recovery a
      // precondition for every Core action, not just page scans.
      startResult = this.state.transport.start(controller.signal);
      await Promise.race([startResult, abortResult]);
      actionResult = this.executeAction(action, input);
      // Observe a late rejection after cancellation instead of leaking an
      // unhandled promise while the transport discards the late CDP response.
      actionResult.catch(() => undefined);
      // run_script observes the abort itself and must release held input on
      // this connection before the interruption reset below replaces it. Its
      // release is bounded, so awaiting it cannot outlive the action deadline.
      // A cancellation or deadline that fires during that cleanup must still
      // fail the action and run recovery, even if the script had completed.
      if (action === 'run_script') {
        const scriptResult = await actionResult;
        if (controller.signal.aborted) await abortResult;
        return scriptResult;
      }
      return await Promise.race([actionResult, abortResult]);
    } catch (error) {
      // A provider command can hit its own deadline before the encompassing
      // action timer fires. Either interruption leaves an already-sent CDP
      // side effect uncertain, so never release the action gate until the
      // connection has been reset or the session has been poisoned.
      if (controller.signal.aborted || isBrowserOperationInterruption(error)) {
        if (!controller.signal.aborted) {
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
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
      this.state.commandSignal = undefined;
      this.state.commandTimeoutMs = undefined;
      this.state.commandSessionId = undefined;
      this.active = false;
    }
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

  private async executeAction(action: string, input: Record<string, unknown>): Promise<unknown> {
    if (action !== 'press_key') this.state.keyboardContinuationTarget = undefined;
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
      case 'open_tab':
        throw new Error('PROVIDER_LIFECYCLE_ACTION: open_tab must be handled by the provider');
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
      return await new BrowserScriptRun(this.state, {
        code,
        filename,
        timeoutMs: scriptTimeout(input),
        signal,
        captureScreenshot: (captureInput) => this.screenshot(this.state, captureInput),
      }).run();
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
    const before = await this.readPageSummary(this.state);
    const beforeTimeOrigin = await this.evaluateMainDocument<number>(
      this.state,
      'performance.timeOrigin',
    );
    const result = await this.click(this.state, {
      ...input,
      __navigationTimeoutMs: timeoutMs,
    });
    if (!isRecord(result)) return result;
    const navigation = isRecord(result.navigation) ? result.navigation : {};
    const detected = result.code === 'UNEXPECTED_NAVIGATION' || navigation.detected === true;
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
        timeoutMs,
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
      return {
        ...result,
        success: false,
        code: 'NAVIGATION_FAILED',
        error: error instanceof Error ? error.message : String(error),
        recovery: 'Inspect the current page before deciding whether to retry.',
      };
    }
  }

  private async hover(input: Record<string, unknown>): Promise<unknown> {
    const startedAt = Date.now();
    const target = await this.resolveTarget(this.state, input);
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

function scriptTimeout(input: Record<string, unknown>): number {
  const requested = asNumber(input.timeout, BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS);
  return Math.max(1_000, Math.min(BROWSER_SCRIPT_MAX_TIMEOUT_MS, Math.floor(requested)));
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
  if (action === 'run_script') return scriptTimeout(input) + BROWSER_SCRIPT_CLEANUP_BUDGET_MS;
  if (action !== 'wait' && action !== 'wait_for') return requested;
  // `wait.timeout` is the condition budget. Keep a small cleanup margin so a
  // successful timeout wait is not cancelled by the enclosing action timer.
  return Math.min(MAX_ACTION_TIMEOUT_MS, requested + 1_000);
}
