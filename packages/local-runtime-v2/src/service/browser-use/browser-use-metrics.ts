import type {
  LocalBrowserObserver,
  LocalBrowserPostActionVisualObservation,
} from '@mavis/agent-tools/desktop';
import {
  incrementMetric,
  observeMetric,
  type RegisteredMetricLabels,
} from '@mavis/shared/local-runtime-logging/metric-registry';

/**
 * Online Browser metrics, shared by Desktop and TUI through the host
 * MetricsClient (its default `runtimeOwnerKind` label tells the two apart).
 * Each metric records counts, durations and enums only; the definitions are
 * the ones in `.harness/docs/local-runtime-observability.md` §10.4.
 *
 * - `browser_turn_opened_tabs_items`: tabs the Agent opened in one Turn that ran a
 *   Browser action (`open_tab` plus a click that adopted a new page).
 * - `browser_run_script_total{input}`: run_script provider calls; `none` did not
 *   call keyboard/mouse, so the read-only share is `none / all`.
 * - `browser_post_action_screenshot_duration_ms{outcome}`: action end to the
 *   automatic screenshot being ready, queueing included.
 * - `browser_post_action_screenshot_stage_ms{phase}`: the same wait split into
 *   queue / capture / encode / transfer / compress (or unsplit `provider`).
 * - `browser_write_action_total{outcome}`: page writes.
 */

export interface BrowserUseMetricsClient {
  counter(name: string, value: number, labels?: Record<string, string>): void;
  histogram(name: string, value: number, labels?: Record<string, string>): void;
}

export interface BrowserUseMetrics extends LocalBrowserObserver {
  /** Emits the Turn's tab count; Turns without a Browser action emit nothing. */
  finishTurn(sessionId: string, turnId: string): void;
  clearSession(sessionId: string): void;
  clear(): void;
}

/**
 * Actions that change the current page through input and therefore count as
 * Browser writes. Navigation, scrolling, reads and run_script are excluded.
 */
const BROWSER_WRITE_ACTIONS: Readonly<Record<string, true>> = {
  click: true,
  click_and_wait_for_navigation: true,
  double_click: true,
  triple_click: true,
  drag: true,
  fill: true,
  type: true,
  paste: true,
  press_key: true,
  check: true,
  uncheck: true,
  select_option: true,
  upload_files: true,
};

/** Turns whose `turn_end` never arrives are dropped beyond this many. */
const MAX_TRACKED_TURNS = 256;

export function createBrowserUseMetrics(client: BrowserUseMetricsClient): BrowserUseMetrics {
  const tabsOpenedByTurn = new Map<string, number>();
  const emit = (write: () => void): void => {
    try {
      write();
    } catch {
      // Metrics must not change or mask the Browser action outcome.
    }
  };
  return {
    actionExecuted(observation) {
      // Provider results cross IPC as plain JSON; only these fields are read.
      const result =
        typeof observation.result === 'object' && observation.result !== null
          ? (observation.result as ProviderResultFields)
          : undefined;
      const key = turnKey(observation.sessionId, observation.turnId ?? '');
      const opened = (tabsOpenedByTurn.get(key) ?? 0) + (result?.openedInNewTab === true ? 1 : 0);
      // Re-insert so the oldest-first eviction below drops idle Turns first.
      tabsOpenedByTurn.delete(key);
      tabsOpenedByTurn.set(key, opened);
      while (tabsOpenedByTurn.size > MAX_TRACKED_TURNS) {
        const oldest = tabsOpenedByTurn.keys().next().value;
        if (oldest === undefined) break;
        tabsOpenedByTurn.delete(oldest);
      }
      if (observation.action === 'run_script') {
        emit(() =>
          incrementMetric(client, 'browser_run_script_total', 1, {
            input: runScriptInputUse(result),
          }),
        );
      }
      if (BROWSER_WRITE_ACTIONS[observation.action] === true) {
        emit(() =>
          incrementMetric(client, 'browser_write_action_total', 1, {
            outcome: writeOutcome(result, observation.errorCode),
          }),
        );
      }
    },
    postActionVisualSettled(observation) {
      emit(() => {
        observeMetric(
          client,
          'browser_post_action_screenshot_duration_ms',
          wholeMs(observation.waitMs),
          { outcome: observation.outcome },
        );
        if (observation.outcome !== 'attached' && observation.outcome !== 'deduplicated') return;
        for (const [phase, ms] of postActionVisualPhases(observation)) {
          observeMetric(client, 'browser_post_action_screenshot_stage_ms', wholeMs(ms), { phase });
        }
      });
    },
    finishTurn(sessionId, turnId) {
      const key = turnKey(sessionId, turnId);
      const opened = tabsOpenedByTurn.get(key);
      if (opened === undefined) return;
      tabsOpenedByTurn.delete(key);
      emit(() => observeMetric(client, 'browser_turn_opened_tabs_items', opened, {}));
    },
    clearSession(sessionId) {
      for (const key of tabsOpenedByTurn.keys()) {
        if (key.startsWith(`${sessionId}\0`)) tabsOpenedByTurn.delete(key);
      }
    },
    clear() {
      tabsOpenedByTurn.clear();
    },
  };
}

/** Raw provider result fields the metrics read; everything else is ignored. */
interface ProviderResultFields {
  readonly success?: unknown;
  readonly openedInNewTab?: unknown;
  /** run_script (Browser Core): keyboard/mouse API calls, insertText included. */
  readonly inputApiCalls?: unknown;
  readonly input?: { readonly keyEvents?: unknown; readonly mouseEvents?: unknown } | null;
}

/**
 * `none` when the script called neither keyboard nor mouse. Results without
 * input statistics (the provider threw or refused before the script ran) are
 * `unknown` and stay in the denominator.
 */
function runScriptInputUse(
  result: ProviderResultFields | undefined,
): 'none' | 'keyboard_mouse' | 'unknown' {
  if (typeof result?.inputApiCalls === 'number') {
    return result.inputApiCalls > 0 ? 'keyboard_mouse' : 'none';
  }
  const keyEvents = result?.input?.keyEvents;
  const mouseEvents = result?.input?.mouseEvents;
  if (typeof keyEvents !== 'number' || typeof mouseEvents !== 'number') return 'unknown';
  return keyEvents + mouseEvents > 0 ? 'keyboard_mouse' : 'none';
}

function writeOutcome(
  result: ProviderResultFields | undefined,
  errorCode: string | undefined,
): 'ok' | 'error' {
  return result && result.success !== false && errorCode === undefined ? 'ok' : 'error';
}

type PostActionPhase = RegisteredMetricLabels<'browser_post_action_screenshot_stage_ms'>['phase'];

/**
 * Phases of a returned capture; they add up to `waitMs`. `queue` is the tool's
 * wait before the request plus the provider's render-slot wait. Without a
 * provider split the provider call is reported once as `provider`. `transfer`
 * is the provider call minus its measured steps: IPC both ways plus overhead.
 */
function postActionVisualPhases(
  observation: LocalBrowserPostActionVisualObservation,
): [PostActionPhase, number][] {
  const phases: [PostActionPhase, number][] = [];
  const timing = observation.providerTiming;
  const providerMs = observation.providerMs;
  if (providerMs === undefined) return phases;
  if (timing?.captureMs === undefined) {
    phases.push(['queue', observation.requestMs], ['provider', providerMs]);
  } else {
    const queueMs = timing.queueMs ?? 0;
    const encodeMs = timing.encodeMs ?? 0;
    phases.push(
      ['queue', observation.requestMs + queueMs],
      ['capture', timing.captureMs],
      ...(timing.encodeMs === undefined ? [] : [['encode', encodeMs] as [PostActionPhase, number]]),
      ['transfer', providerMs - queueMs - timing.captureMs - encodeMs],
    );
  }
  if (observation.compressMs !== undefined) phases.push(['compress', observation.compressMs]);
  return phases;
}

function wholeMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\0${turnId}`;
}
