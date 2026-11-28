import {
  asString,
  describeUnresolvedBrowserRef,
  evaluate,
  hasBrowserRefForm,
  resolveBrowserSnapshotElement,
  type BrowserSessionState,
} from './browser-state.js';

/** How a `ref` that held a CSS selector was used, reported beside the action result. */
export interface BrowserTargetInterpretation {
  readonly targetInterpretedAs: 'selector';
  readonly targetNote: string;
}

/**
 * Models mix refs and selectors: `ref: "#search"`, `ref: "a[href='/x']"`. A
 * ref that is not in ref form, is not a ref the session can resolve, and is a
 * valid CSS selector matching exactly one element has a single reading, so the
 * action runs with it as `selector` and the result says so. An invalid
 * selector, or one matching none or several elements, stays
 * INVALID_ELEMENT_REF (with the match count). Only top-level `ref`; drag
 * endpoints and program locators name their kind explicitly.
 */
export async function interpretRefAsSelector(
  state: BrowserSessionState,
  input: Record<string, unknown>,
): Promise<{ input: Record<string, unknown>; interpretation?: BrowserTargetInterpretation }> {
  const ref = asString(input.ref).trim();
  if (
    !ref ||
    hasBrowserRefForm(ref) ||
    input.selector !== undefined ||
    resolveBrowserSnapshotElement(state, ref) ||
    state.elementMap.getElementByOpaqueRef(ref)
  ) {
    return { input };
  }
  const matches = await evaluate<unknown>(
    state,
    `(() => { try { return document.querySelectorAll(${JSON.stringify(ref)}).length; } catch { return null; } })()`,
  );
  // Not a valid selector (or a page that cannot answer): the ref error as before.
  if (typeof matches !== 'number') return { input };
  if (matches !== 1) throw new Error(describeUnresolvedBrowserRef(state, ref, matches));
  const { ref: _ref, ...rest } = input;
  return {
    input: { ...rest, selector: ref },
    interpretation: {
      targetInterpretedAs: 'selector',
      targetNote: `"${ref}" is not an element ref, so it was used as the CSS selector it is (it matches exactly one element). Put CSS selectors in input.selector and refs from inspect or query in input.ref.`,
    },
  };
}
