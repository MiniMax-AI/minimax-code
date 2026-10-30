import { evaluate, type BrowserSessionState as SessionState } from './browser-state.js';
import { isBrowserOperationInterruption } from './operation-timeout.js';

/**
 * Return the last compound selector after the final top-level combinator, or
 * undefined when the selector is already a single compound. Brackets, parens,
 * and quoted strings are skipped so `[aria-label="a b"]` stays intact.
 */
export function selectorTail(selector: string): string | undefined {
  const trimmed = selector.trim();
  // Selector lists (a, b) are not decomposed; their miss is already explicit.
  let depth = 0;
  let quote: string | undefined;
  let lastBoundary = -1;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index] ?? '';
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '(') depth += 1;
    else if (char === ']' || char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && char === ',') return undefined;
    else if (depth === 0 && (char === ' ' || char === '>' || char === '+' || char === '~')) {
      lastBoundary = index;
    }
  }
  if (lastBoundary < 0) return undefined;
  const tail = trimmed.slice(lastBoundary + 1).trim();
  return tail && tail !== trimmed ? tail : undefined;
}

/**
 * Return the first compound selector before the first top-level combinator, or
 * the whole selector when it is a single compound. Selector lists return
 * undefined.
 */
export function selectorHead(selector: string): string | undefined {
  const trimmed = selector.trim();
  let depth = 0;
  let quote: string | undefined;
  let firstBoundary = -1;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index] ?? '';
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '(') depth += 1;
    else if (char === ']' || char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && char === ',') return undefined;
    else if (
      firstBoundary < 0 &&
      depth === 0 &&
      (char === ' ' || char === '>' || char === '+' || char === '~')
    ) {
      firstBoundary = index;
    }
  }
  const head = firstBoundary < 0 ? trimmed : trimmed.slice(0, firstBoundary).trim();
  return head || undefined;
}

const LANDMARK_TAG_PATTERN = /^(?:main|form|nav|header|footer|aside|article|section|dialog)$/i;
const LANDMARK_ROLE_PATTERN =
  /^[a-z]*\[\s*role\s*=\s*["']?(?:main|dialog|alertdialog|form|navigation|banner|contentinfo|complementary|region|search)["']?\s*\]$/i;

/**
 * Landmark selectors (`main`, `form`, `[role=dialog]`) are the usual first guess
 * for "read the content area", but many app pages have none of them (eval
 * 784094: 9 of 11 QUERY_FAILED were such guesses, each followed by `body`).
 */
export function landmarkSelectorHead(selector: string): string | undefined {
  const head = selectorHead(selector);
  if (!head) return undefined;
  return LANDMARK_TAG_PATTERN.test(head) || LANDMARK_ROLE_PATTERN.test(head) ? head : undefined;
}

export interface SelectorMissDiagnostics {
  /** Last compound of the missed selector and how many elements it alone matches. */
  selectorTail?: { selector: string; matchCount: number };
  /** Page the selector was evaluated against. */
  url?: string;
  /**
   * Counts only (never page content) of controls on the page, so a miss can be
   * told apart from an empty page: the target usually exists under markup the
   * selector did not guess (eval 769392: 12 consecutive class-name guesses on
   * a utility-class page that had plenty of buttons).
   */
  pageControls?: { buttons: number; fields: number; links: number };
  /** Consecutive selector misses on the same page, including this one. */
  consecutiveMisses?: number;
  /**
   * Leading landmark compound (`main`, `form`, `[role=dialog]`, ...) that
   * matches nothing on this page, with whether it was the whole selector.
   */
  missingLandmark?: { selector: string; wholeSelector: boolean };
}

const PAGE_CONTROL_COUNTS = `{
  buttons: document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]').length,
  fields: document.querySelectorAll('input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select, [contenteditable=""], [contenteditable="true"]').length,
  links: document.querySelectorAll('a[href]').length,
}`;

/**
 * Explain a selector miss with live page facts so the model can tell a wrong
 * ancestor chain (tail still matches) from a target that does not exist.
 * Diagnostics are best-effort and never turn a miss into a different failure.
 */
export async function diagnoseSelectorMiss(
  session: SessionState,
  selector: string,
): Promise<SelectorMissDiagnostics> {
  const tail = selectorTail(selector);
  const landmark = landmarkSelectorHead(selector);
  try {
    const facts = await evaluate<{
      url?: unknown;
      tailCount?: unknown;
      landmarkCount?: unknown;
      controls?: { buttons?: unknown; fields?: unknown; links?: unknown };
    } | null>(
      session,
      `(() => {
        let tailCount = null;
        const tail = ${JSON.stringify(tail ?? null)};
        if (tail) {
          try { tailCount = document.querySelectorAll(tail).length; } catch { tailCount = null; }
        }
        let landmarkCount = null;
        const landmark = ${JSON.stringify(landmark ?? null)};
        if (landmark) {
          try { landmarkCount = document.querySelectorAll(landmark).length; } catch { landmarkCount = null; }
        }
        let controls = null;
        try { controls = ${PAGE_CONTROL_COUNTS}; } catch { controls = null; }
        return { url: location.href, tailCount, landmarkCount, controls };
      })()`,
    );
    const diagnostics: SelectorMissDiagnostics = {};
    if (typeof facts?.url === 'string') diagnostics.url = facts.url;
    if (tail && typeof facts?.tailCount === 'number') {
      diagnostics.selectorTail = { selector: tail, matchCount: facts.tailCount };
    }
    if (landmark && facts?.landmarkCount === 0) {
      diagnostics.missingLandmark = {
        selector: landmark,
        wholeSelector: landmark === selector.trim(),
      };
    }
    const controls = facts?.controls;
    if (
      controls &&
      typeof controls.buttons === 'number' &&
      typeof controls.fields === 'number' &&
      typeof controls.links === 'number'
    ) {
      diagnostics.pageControls = {
        buttons: controls.buttons,
        fields: controls.fields,
        links: controls.links,
      };
    }
    return diagnostics;
  } catch (error) {
    if (isBrowserOperationInterruption(error)) throw error;
    return {};
  }
}

export function selectorMissRecovery(diagnostics: SelectorMissDiagnostics): string {
  const parts: string[] = [];
  const landmark = diagnostics.missingLandmark;
  if (landmark) {
    parts.push(
      landmark.wholeSelector
        ? `This page has no element matching "${landmark.selector}". To read the page content use selector "body" (query kind: "text" without a selector reads body).`
        : `This page has no element matching "${landmark.selector}"; drop that prefix (or scope with "body") and retry.`,
    );
  }
  const misses = diagnostics.consecutiveMisses ?? 0;
  if (misses >= 2) {
    parts.push(
      `This is selector miss #${misses} in a row on this page; guessing selectors is not converging. Stop guessing class or attribute names: use query with kind: "semantic" and the visible label text, or inspect, and act through the returned opaque ref.`,
    );
  }
  // A whole-selector landmark miss is fully explained above; the generic
  // "act through an opaque ref" advice does not apply to reading content.
  if (!landmark?.wholeSelector) parts.push(baseSelectorMissRecovery(diagnostics));
  const controls = diagnostics.pageControls;
  if (controls) {
    parts.push(
      `The page currently has ${controls.buttons} button(s), ${controls.fields} form field(s) and ${controls.links} link(s).`,
    );
  }
  return parts.join(' ');
}

function baseSelectorMissRecovery(diagnostics: SelectorMissDiagnostics): string {
  const tail = diagnostics.selectorTail;
  if (tail && tail.matchCount > 0) {
    return `The last part "${tail.selector}" alone matches ${tail.matchCount} element(s) on this page, so the ancestor/position part of the selector is wrong. Inspect the page and act through a returned opaque ref instead of guessing structural selectors.`;
  }
  if (tail) {
    return `Even the last part "${tail.selector}" matches nothing on this page. Inspect the current page (or query kind: "text") to find the element, then use its opaque ref.`;
  }
  return 'Inspect the current page and act through a returned opaque ref; refs and inspect output do not correspond to DOM attributes such as data-backend-node-id.';
}
