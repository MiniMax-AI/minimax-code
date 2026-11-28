import { isBrowserOperationInterruption } from './operation-timeout.js';
import { EDITABLE_FIELD_SOURCE } from './browser-editable-field.js';
import { snapshotRefForBackendNode } from './browser-selector-candidates.js';
import { cdp, type BrowserSessionState } from './browser-state.js';

/**
 * Why typed text did not land in a fill/type target that did not keep focus.
 * Pages often paint two fields in one place (a search box swapping a plain and
 * an AI textarea) or move focus to another field when one is focused; the
 * generic "inspect and retry" then sends the model back to the same ref
 * (session mvs_6d7eb2b6: two textareas with the same box on xiaohongshu, the
 * hidden one chosen, focus never held). Name the field that takes input at the
 * target's center, or the one focus moved to, with its ref when inspected.
 */

export interface BrowserInputField {
  /** Tag, id and name/label/placeholder of the field, as the page shows it. */
  readonly element: string;
  /** The field's ref in the latest inspect snapshot, when it holds the field. */
  readonly ref?: string;
}

export interface BrowserInputDiagnosis {
  /** An editable field painted over the target's center: a pointer reaches it, not the target. */
  readonly coveredBy?: BrowserInputField;
  /** The editable field that has focus after the target was focused. */
  readonly focusMovedTo?: BrowserInputField;
}

const OBJECT_GROUP = 'browser-input-diagnosis';

/** Runs with `this` bound to the target; returns the other editable fields involved. */
const FIND_INPUT_FIELDS = `function (point) {
  const target = this;
  const doc = target.ownerDocument || document;
  const isEditable = ${EDITABLE_FIELD_SOURCE};
  const otherEditable = (element) =>
    Boolean(element) && element !== target && !target.contains(element) && !element.contains(target) &&
    isEditable(element);
  // Page-controlled names, cut short: the label names the field, it is not page text.
  const label = (element) => {
    let text = element.localName + (element.id ? '#' + element.id.slice(0, 40) : '');
    const named = element.getAttribute('name') || element.getAttribute('aria-label') || element.getAttribute('placeholder');
    if (named) text += ' "' + named.slice(0, 40) + '"';
    return text;
  };
  let hit = point ? doc.elementFromPoint(point.x, point.y) : null;
  while (hit && hit.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(point.x, point.y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  let active = doc.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  const covering = otherEditable(hit) ? hit : null;
  const focused = otherEditable(active) ? active : null;
  return {
    coveredBy: covering,
    coveredByLabel: covering ? label(covering) : '',
    focusMovedTo: focused,
    focusMovedToLabel: focused ? label(focused) : '',
  };
}`;

/**
 * The fields involved when a fill/type target did not keep focus, or undefined
 * when the page shows none. `point`: the target's center in its own frame's
 * viewport. Never throws except for an interruption of the running action.
 */
export async function diagnoseUnfocusedInput(
  session: BrowserSessionState,
  backendNodeId: number,
  point: { readonly x: number; readonly y: number } | undefined,
): Promise<BrowserInputDiagnosis | undefined> {
  try {
    const resolved = await cdp<{ object?: { objectId?: string } }>(session, 'DOM.resolveNode', {
      backendNodeId,
      objectGroup: OBJECT_GROUP,
    });
    const targetObjectId = resolved.object?.objectId;
    if (!targetObjectId) return undefined;
    const found = await cdp<{ result?: { objectId?: string } }>(session, 'Runtime.callFunctionOn', {
      objectId: targetObjectId,
      functionDeclaration: FIND_INPUT_FIELDS,
      arguments: [{ value: point ?? null }],
      returnByValue: false,
      objectGroup: OBJECT_GROUP,
    });
    const objectId = found.result?.objectId;
    if (!objectId) return undefined;
    const properties = await cdp<{
      result?: Array<{ name?: string; value?: { objectId?: string; value?: unknown } }>;
    }>(session, 'Runtime.getProperties', { objectId, ownProperties: true });
    const byName = new Map((properties.result ?? []).map((entry) => [entry.name, entry.value]));
    const field = async (
      key: 'coveredBy' | 'focusMovedTo',
    ): Promise<BrowserInputField | undefined> => {
      const handle = byName.get(key)?.objectId;
      const element = byName.get(`${key}Label`)?.value;
      if (!handle || typeof element !== 'string' || !element) return undefined;
      const described = await cdp<{ node?: { backendNodeId?: number } }>(
        session,
        'DOM.describeNode',
        { objectId: handle },
      );
      const ref = snapshotRefForBackendNode(session, described.node?.backendNodeId);
      return { element, ...(ref ? { ref } : {}) };
    };
    const coveredBy = await field('coveredBy');
    const focusMovedTo = await field('focusMovedTo');
    if (!coveredBy && !focusMovedTo) return undefined;
    return { ...(coveredBy ? { coveredBy } : {}), ...(focusMovedTo ? { focusMovedTo } : {}) };
  } catch (error) {
    if (isBrowserOperationInterruption(error)) throw error;
    return undefined;
  } finally {
    await cdp(session, 'Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(
      () => undefined,
    );
  }
}

/** Where input goes instead of the target: the field painted over it, and the field focus moved to. */
export function describeInputDiagnosis(diagnosis: BrowserInputDiagnosis): string {
  const { coveredBy, focusMovedTo } = diagnosis;
  return [
    coveredBy
      ? `Another editable field is painted over this target and takes input at its center: ${coveredBy.element}${coveredBy.ref ? ` (ref ${coveredBy.ref})` : ''}.`
      : '',
    focusMovedTo
      ? `Focus moved from this target to ${focusMovedTo.element}${focusMovedTo.ref ? ` (ref ${focusMovedTo.ref})` : ''}.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * What the model should do next, given the fields the diagnosis found. Text
 * goes to the focused field, so when focus moved to another field the text
 * may already be there: `type` appends, so it says to read that field before
 * typing again; `fill` replaces the whole value, so retrying there is safe.
 */
export function unfocusedInputRecovery(
  diagnosis: BrowserInputDiagnosis,
  action: 'fill' | 'type',
): string {
  const { coveredBy, focusMovedTo } = diagnosis;
  const described = describeInputDiagnosis(diagnosis);
  if (coveredBy && !(action === 'type' && focusMovedTo)) {
    return `${described} Retry with ${coveredBy.ref ? 'that ref' : 'that field (inspect to get its ref)'} instead of this one.`;
  }
  const itsRef = focusMovedTo?.ref ? 'its ref' : 'its ref from a new inspect';
  if (action === 'type') {
    return `${described} The typed text may already be in that field. Read that field first; if it already holds the text, do not type it again; if it is the field you meant and the text is missing, type with ${itsRef}.`;
  }
  return `${described} The typed text may have gone there. Read that field first; if it is the field you meant, retry with ${itsRef}.`;
}
