import { asString, cdp, type BrowserSessionState } from './browser-state.js';
import { isBrowserOperationInterruption } from './operation-timeout.js';
import { notActionableFacts, withBlockerControls } from './program/actionability.js';
import { blockerGuidance, type ProgramNotActionableFacts } from './program/errors.js';
import { callAtBackendNode, callAtLocator } from './program/locator-resolver.js';
import type { ProgramPageRequest, ProgramPageResponse } from './program/page-script.js';

/**
 * Pre-dispatch hit test of a ref or selector target (click, check, hover),
 * shared with run_code programs: the page script's `probe` (visible, not
 * inert, scrolled into view, stable, center hit-test through shadow roots and
 * same-origin frames) decides whether a pointer event at the target's center
 * would reach it.
 */

/** Why a click was not dispatched; the probe facts say what hides or covers the target. */
export interface BrowserClickInteractability extends ProgramNotActionableFacts {
  readonly reason: 'hidden' | 'covered' | 'outside_viewport' | 'disabled';
}

export interface BrowserClickProbe {
  /** Set when a pointer click would not reach the target. */
  readonly blocked?: BrowserClickInteractability;
  /**
   * A `covered` target whose cover belongs to the control itself (a styled
   * knob over a transparent input), not to the page (a modal's backdrop).
   */
  readonly ownCover?: true;
  /**
   * Where the click reaches the target, in main-viewport CSS pixels: the
   * center of its first box, measured after the probe scrolled it into view
   * and saw it hold still for a frame, and hit-tested there.
   */
  readonly point?: { readonly x: number; readonly y: number };
  /** The box `point` is the center of, in main-viewport CSS pixels. */
  readonly rect?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /**
   * What the target does on a click, as far as the page shows: a link that
   * opens a page, a control that submits its form, or a control that acts on
   * the page itself. Unset when the target was not probed (coordinates).
   */
  readonly control?: BrowserClickControl;
}

export type BrowserClickControl = 'link' | 'submit' | 'in_page';

/** What a pointer action asks of its target beyond the hit test. */
export interface BrowserPointerProbeChecks {
  /** The browser drops a click on a native disabled control; aria-disabled may still react. */
  readonly nativeDisabled?: boolean;
  /** A checkbox or radio that is itself invisible is reached through its visible label. */
  readonly labelFallback?: boolean;
}

const CLICK_CHECKS: BrowserPointerProbeChecks = { nativeDisabled: true };

/**
 * A target that moved between two frames (a layout that changes in reaction to
 * the probe's scroll) is measured again this many times before the click falls
 * back to the box its target resolution measured.
 */
const UNSTABLE_PROBE_RETRIES = 4;

const BLOCKING_REASONS: Readonly<Record<string, BrowserClickInteractability['reason']>> = {
  hidden: 'hidden',
  covered: 'covered',
  outside_viewport: 'outside_viewport',
  disabled: 'disabled',
};

/**
 * Probe the element a pointer action's ref or selector names (a selector means
 * its first match, as the action resolves it). Coordinate targets,
 * unresolvable refs and any probe failure other than an interruption return
 * `{}`: the action then runs exactly as it did without the probe and reports
 * its own target error. A target that is still moving is not blocked either.
 */
export async function probeBrowserClickTarget(
  session: BrowserSessionState,
  input: Record<string, unknown>,
  checks: BrowserPointerProbeChecks = CLICK_CHECKS,
): Promise<BrowserClickProbe> {
  // An empty chain: the probed element is the call's `this` (a ref's or selector's node).
  const request: ProgramPageRequest = {
    kind: 'probe',
    checks: { pointer: true, ...checks },
    chain: [],
  };
  let response: ProgramPageResponse | undefined;
  try {
    for (let attempt = 0; attempt <= UNSTABLE_PROBE_RETRIES; attempt += 1) {
      response = await probeResponse(session, input, request);
      if (response?.reason !== 'unstable') break;
    }
  } catch (error) {
    if (isBrowserOperationInterruption(error)) throw error;
    return {};
  }
  if (!response) return {};
  if (response.ok === true) {
    return {
      control:
        typeof response.href === 'string'
          ? 'link'
          : response.submits === true
            ? 'submit'
            : 'in_page',
      ...clickPoint(response),
    };
  }
  const reason =
    typeof response.reason === 'string' ? BLOCKING_REASONS[response.reason] : undefined;
  if (!reason) return {};
  const facts = await withBlockerControls(
    session,
    notActionableFacts(response),
    reason,
    async (explain) => (await probeResponse(session, input, { ...explain, chain: [] })) ?? {},
  );
  return {
    blocked: { reason, ...facts },
    ...(response.ownCover === true ? { ownCover: true } : {}),
  };
}

async function probeResponse(
  session: BrowserSessionState,
  input: Record<string, unknown>,
  request: ProgramPageRequest,
): Promise<ProgramPageResponse | undefined> {
  const ref = asString(input.ref);
  if (ref) return callAtLocator(session, { chain: [{ by: 'ref', ref }] }, request);
  const selector = asString(input.selector);
  if (!selector) return undefined;
  const evaluated = await cdp<{ result?: { objectId?: string } }>(session, 'Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  });
  const objectId = evaluated.result?.objectId;
  if (!objectId) return undefined;
  let backendNodeId: number | undefined;
  try {
    const described = await cdp<{ node?: { backendNodeId?: number } }>(
      session,
      'DOM.describeNode',
      { objectId },
    );
    backendNodeId = described.node?.backendNodeId;
  } finally {
    await cdp(session, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
  return backendNodeId === undefined
    ? undefined
    : callAtBackendNode(session, backendNodeId, request);
}

function clickPoint(response: ProgramPageResponse): Pick<BrowserClickProbe, 'point' | 'rect'> {
  const { x, y, rect } = response as { x?: unknown; y?: unknown; rect?: unknown };
  // A ref's target inside a frame whose place in the page could not be
  // measured: its point is in that frame's viewport, so the click keeps the box
  // it resolved.
  if (response.frameLocal === true) return {};
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return {};
  }
  const box = rect as { width?: unknown; height?: unknown } | undefined;
  const width = typeof box?.width === 'number' ? box.width : 0;
  const height = typeof box?.height === 'number' ? box.height : 0;
  // The probe answers the box in its own document's viewport and the center
  // moved into the main viewport (a ref inside a frame): keep the box around the center.
  return {
    point: { x, y },
    ...(width > 0 && height > 0
      ? { rect: { x: x - width / 2, y: y - height / 2, width, height } }
      : {}),
  };
}

/**
 * The resolved target moved to where the probe hit-tested it. The probe
 * scrolls a target outside the viewport into view and waits until it holds
 * still, which moves it away from the box resolution measured (a ref whose
 * page grew after inspect, a layout that reacts to the scroll); and it aims at
 * the first box of a wrapped link rather than between its lines.
 */
export function aimAtProbe<
  T extends {
    x: number;
    y: number;
    contextX?: number;
    contextY?: number;
    rect?: { x: number; y: number; width: number; height: number };
  },
>(resolved: T, probe: BrowserClickProbe): T {
  if (!probe.point) return resolved;
  return {
    ...resolved,
    x: probe.point.x,
    y: probe.point.y,
    contextX: probe.point.x,
    contextY: probe.point.y,
    ...(probe.rect ? { rect: { ...probe.rect } } : {}),
  };
}

/** The unified failure of a pointer action that was not dispatched because it would miss its target. */
export function targetNotInteractableResult(
  action: string,
  blocked: BrowserClickInteractability,
  durationMs: number,
): Record<string, unknown> {
  const { reason, coveredBy, hiddenBy, collapsed, href } = blocked;
  const why = {
    covered: `another element${coveredBy ? ` (${coveredBy})` : ''} covers the target's center and would receive the ${action === 'hover' ? 'pointer' : 'click'}`,
    outside_viewport:
      'the target cannot be scrolled into the viewport (it sits off-screen, for example in a closed off-canvas menu)',
    disabled: 'the target is disabled',
    hidden:
      collapsed && hiddenBy
        ? `the target is inside a collapsed container (${hiddenBy}) and is not visible or not interactive`
        : 'the target is not visible or not interactive (display: none, visibility: hidden, zero size or inert)',
  }[reason];
  // A known opener is already named by blockerGuidance: only the alternative is left to say.
  const offScreen = blocked.opener
    ? 'Or act on a visible copy found with inspect or query kind "semantic".'
    : 'Open the menu or section that holds it first (click its toggle; hover it only if the click does not open it), or act on a visible copy found with inspect or query kind "semantic".';
  const next = {
    covered:
      'Close whatever covers it (a dialog, banner or open menu) and retry; if the covering element is part of the same control, act on it by its own ref.',
    disabled: 'Do what enables it first (for example fill the required fields).',
    outside_viewport: offScreen,
    hidden: offScreen,
  }[reason];
  const link = href ? ` It is a link to ${href}; navigate to that URL to open it directly.` : '';
  return {
    success: false,
    code: 'TARGET_NOT_INTERACTABLE',
    error: `The ${action} was not dispatched: ${why}.`,
    recovery: `${[blockerGuidance(blocked), next].filter(Boolean).join(' ')}${link}`,
    retryable: false,
    durationMs,
    target: { resolved: true },
    effect: { dispatched: false, verified: false },
    interactability: { ...blocked },
  };
}

/**
 * A fill or type whose target the browser refused to focus (CDP "Element is
 * not focusable"): nothing was typed. A target the hit test finds hidden (an
 * inert or collapsed group) or disabled gets the same report as a click; any
 * other one is not the editable field itself.
 */
export function targetNotFocusableResult(
  action: string,
  blocked: BrowserClickInteractability | undefined,
  durationMs: number,
): Record<string, unknown> {
  if (blocked?.reason === 'hidden' || blocked?.reason === 'disabled') {
    return targetNotInteractableResult(action, blocked, durationMs);
  }
  return {
    success: false,
    code: 'TARGET_NOT_INTERACTABLE',
    error: `The ${action} was not dispatched: the browser cannot focus the target, so it cannot take typed text.`,
    recovery:
      'Locate the editable field itself (the input, textarea or contenteditable element, not a wrapper or label around it) with inspect or query kind "semantic", then retry.',
    retryable: false,
    durationMs,
    target: { resolved: true },
    effect: { dispatched: false, verified: false },
  };
}
