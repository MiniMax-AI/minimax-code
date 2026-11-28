import { EDITABLE_FIELD_SOURCE } from './browser-editable-field.js';
import { isBrowserOperationInterruption } from './operation-timeout.js';
import { cdp, type BrowserSessionState, type ElementRecord } from './browser-state.js';

/**
 * A page that re-renders a control leaves the inspected ref on a node that is
 * gone (a framework remount) or no longer painted (a search box that swaps two
 * textareas in place, a placeholder carousel that remounts its field). The
 * model then pays an inspect round trip per re-render, and on a page that
 * re-renders every few seconds a ref read in one turn is already stale in the
 * next (session mvs_6d7eb2b6: xiaohongshu's search textarea, ref stale within
 * 6.4 s, three extra turns). When a fill/type/paste target carried a stable
 * identity, the field that took its place is found by that identity and the
 * ref is bound to it; anything ambiguous stays STALE_ELEMENT_REF. Other writes
 * (click, check, select, drag) never rebind: in a list remounted one row up,
 * the control in a row's place is the next row's, and the write is not undone.
 */

/**
 * Attributes that name the element; at least one must be present, and a
 * replacement must carry each the inspected element had, with the same value.
 */
const IDENTITY_ATTRIBUTES = ['id', 'data-testid', 'name', 'aria-label'] as const;
/**
 * Of {@link IDENTITY_ATTRIBUTES}, the ones repeated controls share (each row's
 * "Remove" label, a form array's `name`): they identify the element only when
 * no other element in the document carries the same value.
 */
const SHARED_IDENTITY_ATTRIBUTES: Readonly<Record<string, true>> = {
  name: true,
  'aria-label': true,
};
/** Attributes a replacement must also share when the inspected element had them. */
const MATCHED_ATTRIBUTES = ['type', 'role'] as const;
/** How far (CSS px) a replacement's center may be from the inspected center. */
const PLACE_TOLERANCE_PX = 8;
const MAX_IDENTITY_VALUE_CHARS = 200;
const OBJECT_GROUP = 'browser-ref-rebind';

export const BROWSER_REF_REBIND_NOTE =
  'The page re-rendered the field this ref named; the action used the field now in its place (same tag; same id or test id, or a name or label no other element has; same position), and the ref now names it.';

interface ReplacementSpec {
  readonly tag: string;
  readonly attributes: ReadonlyArray<readonly [string, string]>;
  /**
   * The identity attributes the inspected element had: at least one must be
   * id or data-testid, or carried with its value by one element only.
   */
  readonly identity: ReadonlyArray<readonly [string, string]>;
  /** Of `identity`, the names that identify only when their value is unique. */
  readonly shared: readonly string[];
  /** Inspect-time center, in the element's own viewport. */
  readonly center: { readonly x: number; readonly y: number };
  readonly tolerance: number;
  /** Main-document scroll at inspect time; centers compare in document coordinates. */
  readonly scroll?: { readonly x: number; readonly y: number };
}

/**
 * Runs in the page with `this` bound to the inspected node (detached or not)
 * or to nothing, and returns the one editable field now in its place, or null.
 * Only the place decides: a same-id element elsewhere on the page is a
 * different control as far as the model's ref is concerned.
 */
const FIND_REPLACEMENT = `function (spec) {
  const self = this && this.nodeType === 1 ? this : null;
  const doc = (self && self.ownerDocument) || document;
  const view = doc.defaultView || window;
  const isEditable = ${EDITABLE_FIELD_SOURCE};
  // A name or label a second element carries names no element (the inspected
  // node, detached or a hidden twin, does not count).
  const identified = spec.identity.some((pair) => {
    if (!spec.shared.includes(pair[0])) return true;
    let count = 0;
    for (const element of doc.querySelectorAll('[' + pair[0] + ']')) {
      if (element !== self && element.getAttribute(pair[0]) === pair[1]) count += 1;
    }
    return count === 1;
  });
  if (!identified) return null;
  // The inspect-time scroll is the top document's: only there do centers
  // compare in document coordinates.
  const top = spec.scroll && view === view.top;
  const dx = top ? view.scrollX - spec.scroll.x : 0;
  const dy = top ? view.scrollY - spec.scroll.y : 0;
  const placed = [];
  for (const element of doc.getElementsByTagName(spec.tag)) {
    if (element === self || !element.isConnected) continue;
    if (!spec.attributes.every((pair) => element.getAttribute(pair[0]) === pair[1])) continue;
    if (!isEditable(element)) continue;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0) || element.getClientRects().length === 0) continue;
    const style = view.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    if (Math.abs(x + dx - spec.center.x) > spec.tolerance) continue;
    if (Math.abs(y + dy - spec.center.y) > spec.tolerance) continue;
    placed.push({ element, x, y });
  }
  if (placed.length === 1) return placed[0].element;
  const onTop = placed.filter((entry) => {
    const hit = doc.elementFromPoint(entry.x, entry.y);
    return Boolean(hit) && (hit === entry.element || entry.element.contains(hit));
  });
  return onTop.length === 1 ? onTop[0].element : null;
}`;

/** Whether the element was inspected in the top document of the tab's own target. */
async function isMainFrameElement(
  session: BrowserSessionState,
  element: ElementRecord,
): Promise<boolean> {
  if (element.commandSessionId) return false;
  if (!element.frameId || element.frameId === 'main') return true;
  const mainFrameId =
    session.cdpHelper.getMainFrameId() ??
    (await cdp<{ frameTree?: { frame?: { id?: string } } }>(session, 'Page.getFrameTree')).frameTree
      ?.frame?.id;
  return element.frameId === mainFrameId;
}

/**
 * The backendNodeId of the editable field that took the inspected element's
 * place, or undefined when there is none or more than one could have. Only
 * fill/type/paste call it. `scroll`: the main document's scroll position when
 * the element was inspected, so a page scrolled since still finds the field
 * in its place. Never throws except for an interruption of the running action.
 */
export async function findReplacementNode(
  session: BrowserSessionState,
  element: ElementRecord,
  scroll: { readonly x: number; readonly y: number } | undefined,
): Promise<number | undefined> {
  const identity = IDENTITY_ATTRIBUTES.flatMap((name): Array<[string, string]> => {
    const value = element.attributes[name];
    return value && value.length <= MAX_IDENTITY_VALUE_CHARS ? [[name, value]] : [];
  });
  if (identity.length === 0 || !element.tag) return undefined;
  const frameOffset = element.frameOffset ?? { x: 0, y: 0 };
  const spec: ReplacementSpec = {
    tag: element.tag.toLowerCase(),
    attributes: [
      ...identity,
      ...MATCHED_ATTRIBUTES.flatMap((name): Array<[string, string]> => {
        const value = element.attributes[name];
        return value ? [[name, value]] : [];
      }),
    ],
    identity,
    shared: identity.flatMap(([name]) => (SHARED_IDENTITY_ATTRIBUTES[name] ? [name] : [])),
    center: {
      x: element.rect.x - frameOffset.x + element.rect.width / 2,
      y: element.rect.y - frameOffset.y + element.rect.height / 2,
    },
    tolerance: PLACE_TOLERANCE_PX,
    ...(scroll ? { scroll } : {}),
  };
  try {
    const inspected = await cdp<{ object?: { objectId?: string } }>(session, 'DOM.resolveNode', {
      backendNodeId: element.backendNodeId,
      objectGroup: OBJECT_GROUP,
    }).catch((error: unknown) => {
      if (isBrowserOperationInterruption(error)) throw error;
      return undefined;
    });
    const inspectedObjectId = inspected?.object?.objectId;
    let found: { result?: { objectId?: string; subtype?: string } };
    if (inspectedObjectId) {
      // The node's own document: the frame it was inspected in, even once detached.
      found = await cdp(session, 'Runtime.callFunctionOn', {
        objectId: inspectedObjectId,
        functionDeclaration: FIND_REPLACEMENT,
        arguments: [{ value: spec }],
        returnByValue: false,
        objectGroup: OBJECT_GROUP,
      });
    } else if (await isMainFrameElement(session, element)) {
      // A collected node no longer names its document; the main document is safe to search.
      found = await cdp(session, 'Runtime.evaluate', {
        expression: `(${FIND_REPLACEMENT}).call(null, ${JSON.stringify(spec)})`,
        returnByValue: false,
        objectGroup: OBJECT_GROUP,
      });
    } else {
      return undefined;
    }
    const objectId = found.result?.subtype === 'null' ? undefined : found.result?.objectId;
    if (!objectId) return undefined;
    const described = await cdp<{ node?: { backendNodeId?: number } }>(
      session,
      'DOM.describeNode',
      { objectId },
    );
    const backendNodeId = described.node?.backendNodeId;
    return typeof backendNodeId === 'number' && backendNodeId !== element.backendNodeId
      ? backendNodeId
      : undefined;
  } catch (error) {
    if (isBrowserOperationInterruption(error)) throw error;
    return undefined;
  } finally {
    await cdp(session, 'Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(
      () => undefined,
    );
  }
}

/**
 * Binds `element` (the record its ref resolves to) to the replacement node
 * and remembers the rebind for the running action's result. A credential
 * field stays one.
 */
export function rebindElementRecord(
  session: BrowserSessionState,
  element: ElementRecord,
  backendNodeId: number,
): void {
  if (session.passwordFields?.has(element.backendNodeId)) {
    session.passwordFields.add(backendNodeId);
  }
  element.backendNodeId = backendNodeId;
  element.nodeId = backendNodeId;
  (session.reboundRefs ??= new Set()).add(element.ref);
}

/** The refs the running action rebound, and forgets them. */
export function takeReboundRefs(session: BrowserSessionState): string[] | undefined {
  const refs = session.reboundRefs;
  session.reboundRefs = undefined;
  return refs && refs.size > 0 ? [...refs] : undefined;
}
