import { COMPACT_STATUS_STRING_LIMITS } from './local-browser-compact-result.js';
import { isRecord } from './type-guards.js';

/**
 * `browser.compactInspect` (on by default): the model reads an inspect or semantic query
 * page as one line per element, instead of element records and a semantic
 * tree. In hard210 those two reads were 67% of all Browser result text and a
 * page cost about 42 KB; most of it repeated per element (`frame`, `rect`,
 * `coordinateSpace`, flags) or restated elements in tree form.
 *
 * Only the model's text changes. `details` and `programmatic` keep the records,
 * so a program reads the same data with the switch on or off, and the refs are
 * the same refs.
 */

const MAX_NAME_CHARS = 100;
const MAX_VALUE_CHARS = 80;
const MAX_HREF_CHARS = 120;
/** Browser Core's BROWSER_JS_DIALOG_MESSAGE_LIMIT; agent-tools does not depend on Browser Core. */
const MAX_JS_DIALOG_TEXT_CHARS = 2_000;

/** A person operates these, so they are always listed. */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'combobox',
  'disclosuretriangle',
  'input',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'select',
  'slider',
  'spinbutton',
  'summary',
  'switch',
  'tab',
  'textarea',
  'textbox',
  'treeitem',
]);
const INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  'a',
  'button',
  'input',
  'option',
  'select',
  'summary',
  'textarea',
]);
/** Tree nodes without a ref that say what the listed elements belong to. */
const CONTEXT_ROLES: ReadonlySet<string> = new Set([
  'alert',
  'columnheader',
  'heading',
  'paragraph',
  'rowheader',
  'status',
]);
const ATTRIBUTE_NAMES = ['aria-label', 'placeholder', 'title', 'name'] as const;
/** Accessibility states of the semantic tree a line carries; the rest is noise. */
const TREE_STATES = [
  'checked',
  'disabled',
  'expanded',
  'invalid',
  'pressed',
  'readonly',
  'required',
  'selected',
] as const;

/** Icon fonts put private-use glyphs into names; they say nothing as text. */
const PRIVATE_USE_GLYPHS = /[\uE000-\uF8FF]/gu;

/** Browser Core's virtual modal: the page behind a held JavaScript dialog cannot be read. */
export function isJsDialogPage(page: Record<string, unknown>): boolean {
  return typeof page.snapshotId === 'string' && page.snapshotId.startsWith('jsdialog:');
}

/** A cut address ends in `…` so it is never taken for a whole one. */
function boundedAddress(address: string, limit: number): string {
  return address.length > limit ? `${address.slice(0, limit - 1)}…` : address;
}

function oneLine(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(PRIVATE_USE_GLYPHS, '').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function elementName(element: Record<string, unknown>): string {
  const attributes = isRecord(element.attributes) ? element.attributes : {};
  const candidates = [element.text, ...ATTRIBUTE_NAMES.map((name) => attributes[name])];
  for (const candidate of candidates) {
    const name = oneLine(candidate, MAX_NAME_CHARS);
    if (name) return name;
  }
  return '';
}

function isInteractive(element: Record<string, unknown>): boolean {
  return (
    INTERACTIVE_ROLES.has(String(element.role)) ||
    INTERACTIVE_TAGS.has(String(element.tag)) ||
    element.value !== undefined ||
    element.checked !== undefined
  );
}

/**
 * Where a link goes, as the line shows it: the path and query on the page's
 * own origin, the address without its fragment elsewhere, nothing for a link
 * that only runs script or moves within the page. A cut address ends in `…`
 * so it is never taken for a whole one. Every link line carries its address:
 * the model navigates straight to addresses it reads, and a line without one
 * leaves it clicking through instead.
 */
function linkAddress(href: string, pageUrl: unknown): string | undefined {
  const raw = href.trim();
  if (!raw || raw.startsWith('#') || /^javascript:/iu.test(raw)) return undefined;
  let address = raw;
  try {
    const base = typeof pageUrl === 'string' ? new URL(pageUrl) : undefined;
    const target = new URL(raw, base);
    target.hash = '';
    if (base && target.origin === base.origin && /^https?:$/u.test(target.protocol)) {
      const here = `${base.pathname}${base.search}`;
      address = `${target.pathname}${target.search}`;
      if (address === here && raw.includes('#')) return undefined;
    } else {
      address = target.href;
    }
  } catch {
    // A relative href on a page whose address is not a URL stays as written.
  }
  address = address.replace(/\s+/gu, ' ');
  return boundedAddress(address, MAX_HREF_CHARS);
}

/** The states the tree knows of each ref; the element records know few of them. */
function collectTreeStates(nodes: readonly unknown[], out: Map<string, string[]>): void {
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    if (typeof node.ref === 'string' && isRecord(node.state)) {
      const { state } = node;
      const known = TREE_STATES.filter((name) => state[name] !== undefined);
      out.set(
        node.ref,
        known.flatMap((name) => {
          // Chromium reports these as booleans or as the strings of an ARIA value.
          const value = String(state[name]);
          if (value === 'true') return [name];
          if (value !== 'false') return [`${name}=${oneLine(value, MAX_VALUE_CHARS)}`];
          if (name === 'checked') return ['unchecked'];
          return name === 'expanded' ? ['expanded=false'] : [];
        }),
      );
    }
    if (Array.isArray(node.children)) collectTreeStates(node.children, out);
  }
}

/** The page's scrollable extent in document pixels and where it is scrolled to (inspect pages). */
interface PageExtent {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly width: number;
  readonly height: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function pageExtent(page: Record<string, unknown>): PageExtent | undefined {
  const scroll: Record<string, unknown> = isRecord(page.scrollPosition) ? page.scrollPosition : {};
  const { pageWidth: width, pageHeight: height } = page;
  const { x: scrollX, y: scrollY } = scroll;
  if (!isFiniteNumber(scrollX) || !isFiniteNumber(scrollY)) return undefined;
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return { scrollX, scrollY, width, height };
}

/**
 * Items of a closed off-canvas drawer (a fixed panel moved past the page edge)
 * would be listed like any other element and clicked, and the click fails as
 * outside the viewport. An element whose box lies wholly outside the page's
 * scrollable extent cannot be scrolled to. An element further down or to the
 * side of the page is inside the extent.
 */
function outsidePage(element: Record<string, unknown>, extent: PageExtent | undefined): boolean {
  if (!extent || element.coordinateSpace === 'unavailable' || !isRecord(element.rect)) return false;
  const { x, y, width, height } = element.rect;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height)
  ) {
    return false;
  }
  if (width <= 0 || height <= 0) return false;
  const left = x + extent.scrollX;
  const top = y + extent.scrollY;
  return left + width <= 0 || top + height <= 0 || left >= extent.width || top >= extent.height;
}

function elementLine(
  element: Record<string, unknown>,
  name: string,
  page: { mainFrame: unknown; url: unknown; extent?: PageExtent },
  treeStates: readonly string[],
): string {
  const attributes = isRecord(element.attributes) ? element.attributes : {};
  const states: string[] = [];
  if (
    typeof attributes.type === 'string' &&
    element.tag === 'input' &&
    attributes.type !== 'text'
  ) {
    states.push(`type=${oneLine(attributes.type, MAX_VALUE_CHARS)}`);
  }
  if (typeof element.value === 'string')
    states.push(`value=${oneLine(element.value, MAX_VALUE_CHARS)}`);
  if (typeof element.selectedText === 'string') {
    states.push(`selected=${oneLine(element.selectedText, MAX_VALUE_CHARS)}`);
  }
  if (typeof element.checked === 'boolean') states.push(element.checked ? 'checked' : 'unchecked');
  const expanded = attributes['aria-expanded'];
  // Written as the tree writes it, so the same state is not listed twice.
  if (typeof expanded === 'string') {
    states.push(
      expanded === 'true' ? 'expanded' : `expanded=${oneLine(expanded, MAX_VALUE_CHARS)}`,
    );
  }
  for (const state of treeStates) if (!states.includes(state)) states.push(state);
  if (element.actionable === false) states.push('not-actionable');
  else if (element.pointerActionable === false) states.push('no-pointer');
  if (outsidePage(element, page.extent)) states.push('offscreen');
  const href =
    typeof attributes.href === 'string' ? linkAddress(attributes.href, page.url) : undefined;
  if (href) states.push(`href=${href}`);
  if (element.frame !== page.mainFrame && typeof element.frame === 'string') {
    states.push(`frame=${element.frame}`);
  }
  const label = name ? ` ${name}` : '';
  const suffix = states.length > 0 ? ` [${states.join('] [')}]` : '';
  return `${String(element.ref)} ${oneLine(element.role, MAX_VALUE_CHARS)}${label}${suffix}`;
}

/** The frame most elements of the page sit in; only the others are marked. */
function commonFrame(elements: readonly Record<string, unknown>[]): unknown {
  const counts = new Map<unknown, number>();
  let common: unknown;
  let most = 0;
  for (const { frame } of elements) {
    const count = (counts.get(frame) ?? 0) + 1;
    counts.set(frame, count);
    if (count > most) {
      most = count;
      common = frame;
    }
  }
  return common;
}

/**
 * Lines by ref. An element that says nothing, or only what a neighbour says
 * (the image of a link, the span of a button, a row before its cells), is
 * left out unless it is interactive. Its ref stays valid.
 */
function elementLines(
  elements: readonly Record<string, unknown>[],
  treeStates: ReadonlyMap<string, readonly string[]>,
  url: unknown,
  extent: PageExtent | undefined,
): Map<string, string> {
  const page = { mainFrame: commonFrame(elements), url, extent };
  const names = elements.map(elementName);
  const lines = new Map<string, string>();
  let lastName = '';
  elements.forEach((element, index) => {
    const name = names[index] ?? '';
    const next = names[index + 1] ?? '';
    const echoes = name.length > 0 && (lastName.includes(name) || (next && name.includes(next)));
    if (isInteractive(element) || (name && !echoes)) {
      const ref = String(element.ref);
      lines.set(ref, elementLine(element, name, page, treeStates.get(ref) ?? []));
      lastName = name;
    }
  });
  return lines;
}

/**
 * One line for every element of the virtual modal, each with its whole text:
 * this page is the only place the model reads a dialog from, and a message
 * that says "Click OK" says more than the button it names. The text comes from
 * `dialog` when it can: Electron's element projection cuts `text` at 300 chars.
 */
function jsDialogElementLines(page: Record<string, unknown>): Map<string, string> {
  const elements = Array.isArray(page.elements) ? page.elements.filter(isRecord) : [];
  const dialog = isRecord(page.dialog) ? page.dialog : {};
  const context = { mainFrame: undefined, url: page.url };
  return new Map(
    elements.map((element) => {
      const text =
        (element.role === 'text' && dialog.message) ||
        (element.role === 'textbox' && dialog.defaultPrompt) ||
        element.text;
      const name = boundedAddress(
        oneLine(text, MAX_JS_DIALOG_TEXT_CHARS + 1),
        MAX_JS_DIALOG_TEXT_CHARS,
      );
      return [String(element.ref), elementLine(element, name, context, [])];
    }),
  );
}

/**
 * The tree's document order, with its headings and table headers, around the
 * listed elements. A page whose tree was cut lists its elements alone.
 */
function outline(
  nodes: readonly unknown[],
  lines: Map<string, string>,
  everyName: boolean,
  out: string[],
): void {
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const ref = typeof node.ref === 'string' ? node.ref : undefined;
    const line = ref === undefined ? undefined : lines.get(ref);
    if (ref !== undefined && line !== undefined) {
      out.push(line);
      lines.delete(ref);
    } else if (ref === undefined && (everyName || CONTEXT_ROLES.has(String(node.role)))) {
      const name = oneLine(node.name, MAX_NAME_CHARS);
      if (name) out.push(`${oneLine(node.role, MAX_VALUE_CHARS)} ${name}`);
    }
    if (Array.isArray(node.children)) outline(node.children, lines, everyName, out);
  }
}

/** A page chooses how long its address is; a `data:` URL holds the whole page. */
function jsDialogAddresses(page: Record<string, unknown>): Record<string, unknown> {
  const limit = COMPACT_STATUS_STRING_LIMITS.url;
  const { url, dialog } = page;
  return {
    ...(typeof url === 'string' ? { url: boundedAddress(url, limit) } : {}),
    ...(isRecord(dialog) && typeof dialog.url === 'string'
      ? { dialog: { ...dialog, url: boundedAddress(dialog.url, limit) } }
      : {}),
  };
}

/** A page result in the form the model reads, or undefined for any other result. */
function compactBrowserPage(page: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(page.elements) || typeof page.snapshotId !== 'string') return undefined;
  const {
    elements,
    semanticTree,
    semanticTreeOmitted: _omitted,
    duration: _duration,
    ...rest
  } = page;
  const records = elements.filter(isRecord);
  const roots =
    isRecord(semanticTree) && Array.isArray(semanticTree.roots) ? semanticTree.roots : [];
  const treeStates = new Map<string, string[]>();
  collectTreeStates(roots, treeStates);
  const jsDialog = isJsDialogPage(page);
  const lines = jsDialog
    ? jsDialogElementLines(page)
    : elementLines(records, treeStates, page.url, pageExtent(page));
  const listed = lines.size;
  const ordered: string[] = [];
  // A semantic match without any ref is told by the tree alone.
  outline(roots, lines, listed === 0, ordered);
  ordered.push(...lines.values());
  return {
    ...rest,
    ...(jsDialog ? jsDialogAddresses(rest) : {}),
    elements: ordered,
    ...(records.length > listed ? { omittedElements: records.length - listed } : {}),
  };
}

/** The model's text for a page result (or an action result with a page observation), else undefined. */
export function compactBrowserPageText(action: unknown, page: unknown): string | undefined {
  if (!isRecord(page)) return undefined;
  const own = compactBrowserPage(page);
  const observation = isRecord(page.observation) ? compactBrowserPage(page.observation) : undefined;
  if (!own && !observation) return undefined;
  return JSON.stringify({ action, result: own ?? { ...page, observation } });
}

/** Puts the compact page into the model's text; `details` and `programmatic` stay as they are. */
export function withCompactBrowserPage<
  T extends { text: string; content: readonly unknown[]; details?: unknown },
>(result: T): T {
  const details = isRecord(result.details) ? result.details : undefined;
  const text = details ? compactBrowserPageText(details.action, details.result) : undefined;
  if (text === undefined) return result;
  return { ...result, text, content: [{ type: 'text', text }, ...result.content.slice(1)] };
}
