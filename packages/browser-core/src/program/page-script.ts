import { OMIT_DATA_URLS_SOURCE } from '../browser-data-url.js';
import { sanitizeDomElementSource } from '../browser-dom-sanitize.js';
import { PAGE_CREDENTIAL_CONTROL_SOURCE, REDACTED_VALUE } from '../browser-form-state.js';
import { UNIQUE_SELECTOR_SOURCE } from '../browser-unique-selector.js';

/** innerHTML/outerHTML reads (and readAll's "@html") stop at this many characters. */
const PROGRAM_HTML_LIMIT_CHARS = 20 * 1024;
/** Longest selector a candidate or a blocked target's control may carry. */
const PROGRAM_SELECTOR_LIMIT_CHARS = 120;
/** Empty required fields a disabled control's failure names at most. */
const PROGRAM_MISSING_FIELDS_LIMIT = 5;

/**
 * Whether a pointer click reached a control. Called with `arm` before the
 * click, it listens for `click` on the control's window in the capture phase
 * and on the control and its labels themselves (a window listener sees only
 * the host of a closed shadow root). Called without `arm`, it removes the
 * listeners and answers whether a click went through the control or one of
 * its labels (a label click is what clicks its control), or undefined when
 * nothing was armed or no listener saw any click: a page window-capture
 * handler registered earlier can stop the click before ours, so a click that
 * reached the control would otherwise read as a miss.
 */
export const CLICK_REACH_SOURCE = String.raw`(element, arm) => {
  const view = element.ownerDocument && element.ownerDocument.defaultView;
  if (!view) return undefined;
  const key = Symbol.for('mavis.browser.click-reach');
  if (!view[key]) Object.defineProperty(view, key, { value: new WeakMap() });
  const records = view[key];
  const previous = records.get(element);
  if (previous) { previous.stop(); records.delete(element); }
  if (!arm) return previous && previous.sawAny ? previous.reached : undefined;
  const watched = [element];
  const labels = element.labels;
  for (let index = 0; labels && index < labels.length; index += 1) watched.push(labels[index]);
  const record = { reached: false, sawAny: false };
  const reach = () => { record.reached = true; record.sawAny = true; };
  const seen = (event) => {
    record.sawAny = true;
    const path = event.composedPath();
    for (let index = 0; index < watched.length; index += 1) if (path.indexOf(watched[index]) >= 0) record.reached = true;
  };
  view.addEventListener('click', seen, true);
  for (let index = 0; index < watched.length; index += 1) watched[index].addEventListener('click', reach, true);
  record.stop = () => {
    view.removeEventListener('click', seen, true);
    for (let index = 0; index < watched.length; index += 1) watched[index].removeEventListener('click', reach, true);
  };
  records.set(element, record);
  return true;
}`;

/**
 * The one fixed script every page operation runs in the page. It takes data
 * (`request`), never code: locator chains, what to read, which checks to make.
 * Only this source, the credential rule and the option-selection function
 * Browser Core already uses are ever evaluated by the locator and read ops.
 * Page JavaScript a program asks for (page.evaluate) runs separately, in
 * page-evaluate.ts; it uses this script only to find its target elements
 * (`elements`, `pick`).
 *
 * It avoids Array.from and other replaceable built-ins with a callback:
 * Prototype.js (Magento admin) and MooTools replace Array.from with a version
 * that ignores the map function (seen in evaluation).
 *
 * Roles and names follow the same rules as `elementRole` and the accessibility
 * tree the inspect snapshot reads, computed page-side so one evaluate resolves
 * a whole chain, including shadow DOM and same-origin iframes.
 */
export const PROGRAM_PAGE_SOURCE = String.raw`function (request, selectMutation) {
  const scopedStart = this && this.nodeType === 1 ? this : null;
  const REDACTED = ${JSON.stringify(REDACTED_VALUE)};
  const credential = ${PAGE_CREDENTIAL_CONTROL_SOURCE};
  const omitDataUrls = ${OMIT_DATA_URLS_SOURCE};
  const sanitizeHtml = ${sanitizeDomElementSource(true)};
  const clickReach = ${CLICK_REACH_SOURCE};
  const CURSOR_HOST = '[data-mavis-agent-cursor-host]';
  const NO_TEXT_TAGS = { script: 1, style: 1, noscript: 1, template: 1, head: 1, meta: 1, link: 1, title: 1, base: 1 };
  const NAME_FROM_CONTENT = { button: 1, link: 1, heading: 1, checkbox: 1, radio: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, option: 1, cell: 1, gridcell: 1, columnheader: 1, rowheader: 1, row: 1, switch: 1, treeitem: 1, tooltip: 1, listitem: 1, status: 1 };
  const TAG_ROLES = { button: 'button', summary: 'button', textarea: 'textbox', option: 'option', optgroup: 'group', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', ul: 'list', ol: 'list', menu: 'list', li: 'listitem', table: 'table', thead: 'rowgroup', tbody: 'rowgroup', tfoot: 'rowgroup', tr: 'row', nav: 'navigation', main: 'main', aside: 'complementary', article: 'article', dialog: 'dialog', p: 'paragraph', hr: 'separator', progress: 'progressbar', meter: 'meter', fieldset: 'group', details: 'group', output: 'status', figure: 'figure', dfn: 'term', dt: 'term', dd: 'definition' };
  const INPUT_ROLES = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox' };
  const VALUE_CONTROLS = { date: 1, time: 1, 'datetime-local': 1, month: 1, week: 1, color: 1, range: 1 };
  const NON_FIELD_INPUTS = { button: 1, hidden: 1, image: 1, reset: 1, submit: 1 };
  const NON_TEXT_INPUTS = { button: 1, checkbox: 1, file: 1, hidden: 1, image: 1, radio: 1, reset: 1, submit: 1 };

  const norm = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const matcher = (spec, exact) => {
    if (spec && typeof spec === 'object') {
      const pattern = new RegExp(spec.regex, spec.flags || '');
      return (text) => { pattern.lastIndex = 0; return pattern.test(text); };
    }
    const wanted = norm(spec);
    if (exact) return (text) => text === wanted;
    const lower = wanted.toLowerCase();
    return (text) => text.toLowerCase().indexOf(lower) >= 0;
  };
  const viewOf = (element) => (element.ownerDocument && element.ownerDocument.defaultView) || window;

  // A same-origin frame's document, or null (cross-origin frames are resolved through their own session).
  const frameDocument = (element) => {
    try {
      const inner = element.contentDocument;
      return inner && inner.documentElement ? inner : null;
    } catch (error) { return null; }
  };
  const FRAME_TAGS = { iframe: 1, frame: 1 };
  // A locator scoped to an iframe element searches the iframe's document.
  const treeScopes = (root) => {
    const scopes = [root];
    const rootDocument = root && root.nodeType === 1 && FRAME_TAGS[root.localName] === 1 ? frameDocument(root) : null;
    if (rootDocument) scopes.push(rootDocument);
    for (let index = 0; index < scopes.length; index += 1) {
      const all = scopes[index].querySelectorAll('*');
      for (let at = 0; at < all.length; at += 1) {
        const element = all[at];
        if (element.shadowRoot) scopes.push(element.shadowRoot);
        if (FRAME_TAGS[element.localName] === 1) {
          const inner = frameDocument(element);
          if (inner) scopes.push(inner);
        }
      }
    }
    return scopes;
  };
  const inHost = (element) => element.closest && element.closest(CURSOR_HOST);
  const allElements = (root) => {
    const out = [];
    const scopes = treeScopes(root);
    for (let index = 0; index < scopes.length; index += 1) {
      const all = scopes[index].querySelectorAll('*');
      for (let at = 0; at < all.length; at += 1) if (!inHost(all[at])) out.push(all[at]);
    }
    return out;
  };

  const isVisible = (element) => {
    if (!element.isConnected) return false;
    const style = viewOf(element).getComputedStyle(element);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const isHiddenFromTree = (element) => {
    if (element.closest('[aria-hidden="true"]')) return true;
    if (typeof element.checkVisibility === 'function') {
      return !element.checkVisibility({ visibilityProperty: true });
    }
    return !isVisible(element);
  };
  const isEnabled = (element) => {
    if (element.matches(':disabled')) return false;
    return !element.closest('[aria-disabled="true"]');
  };
  const isEditable = (element) => {
    const tag = element.localName;
    if (tag === 'textarea') return !element.readOnly;
    if (tag === 'input') return !element.readOnly && NON_TEXT_INPUTS[String(element.type || '').toLowerCase()] !== 1;
    if (element.isContentEditable) return true;
    const role = String(element.getAttribute('role') || '').toLowerCase();
    return (role === 'textbox' || role === 'searchbox' || role === 'combobox') && element.getAttribute('aria-readonly') !== 'true';
  };

  const roleOf = (element) => {
    const explicit = String(element.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = element.localName;
    switch (tag) {
      case 'a':
      case 'area':
        return element.hasAttribute('href') ? 'link' : '';
      case 'input': {
        const type = String(element.type || '').toLowerCase();
        if (type === 'hidden') return '';
        if (INPUT_ROLES[type]) return INPUT_ROLES[type];
        return element.hasAttribute('list') ? 'combobox' : 'textbox';
      }
      case 'select':
        return element.multiple || element.size > 1 ? 'listbox' : 'combobox';
      case 'td':
        return element.closest('[role="grid"],[role="treegrid"]') ? 'gridcell' : 'cell';
      case 'th':
        return String(element.getAttribute('scope') || '').toLowerCase() === 'row' ? 'rowheader' : 'columnheader';
      case 'header':
        return element.closest('article,aside,main,nav,section') ? '' : 'banner';
      case 'footer':
        return element.closest('article,aside,main,nav,section') ? '' : 'contentinfo';
      case 'form':
        return nameOf(element, '') ? 'form' : '';
      case 'section':
        return nameOf(element, '') ? 'region' : '';
      case 'img':
        return element.getAttribute('alt') === '' ? 'presentation' : 'img';
      default:
        return TAG_ROLES[tag] || '';
    }
  };
  // An element's text as the page shows it: script, style and the other
  // NO_TEXT_TAGS hold source, not text (Playwright's getByText skips them
  // too). Light DOM only, as textContent; the cache keeps a whole-page scan linear.
  const shownText = (element, cache) => {
    const known = cache.get(element);
    if (known !== undefined) return known;
    let text = '';
    for (let node = element.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 3) text += node.data;
      else if (node.nodeType === 1 && !NO_TEXT_TAGS[node.localName]) text += shownText(node, cache);
    }
    cache.set(element, text);
    return text;
  };
  const contentName = (node, depth) => {
    if (depth > 12) return '';
    let out = '';
    const children = node.childNodes;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child.nodeType === 3) { out += child.data; continue; }
      if (child.nodeType !== 1) continue;
      if (NO_TEXT_TAGS[child.localName] || child.getAttribute('aria-hidden') === 'true') continue;
      const display = viewOf(child).getComputedStyle(child).display;
      if (display === 'none') continue;
      const label = child.getAttribute('aria-label');
      if (label) { out += ' ' + label + ' '; continue; }
      if (child.localName === 'img') { out += ' ' + (child.getAttribute('alt') || '') + ' '; continue; }
      if (child.localName === 'input' && NON_TEXT_INPUTS[String(child.type || '').toLowerCase()] !== 1) continue;
      const inline = display.indexOf('inline') === 0;
      out += (inline ? '' : ' ') + contentName(child.shadowRoot || child, depth + 1) + (inline ? '' : ' ');
    }
    return out;
  };
  const labelledByText = (element) => {
    const ids = norm(element.getAttribute('aria-labelledby'));
    if (!ids) return '';
    const parts = [];
    const root = element.getRootNode();
    const list = ids.split(' ');
    for (let index = 0; index < list.length; index += 1) {
      const target = root.getElementById ? root.getElementById(list[index]) : null;
      if (target) parts.push(norm(target.getAttribute('aria-label') || contentName(target, 0) || target.textContent));
    }
    return norm(parts.join(' '));
  };
  const nativeLabelText = (element) => {
    const labels = element.labels;
    if (!labels || !labels.length) return '';
    const parts = [];
    for (let index = 0; index < labels.length; index += 1) parts.push(norm(contentName(labels[index], 0)));
    return norm(parts.join(' '));
  };
  const nameOf = (element, role) => {
    const labelled = labelledByText(element);
    if (labelled) return labelled;
    const aria = norm(element.getAttribute('aria-label'));
    if (aria) return aria;
    const tag = element.localName;
    if (tag === 'input') {
      const type = String(element.type || '').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset') {
        return norm(element.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
      }
      if (type === 'image') return norm(element.getAttribute('alt') || element.getAttribute('title'));
    }
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button' || tag === 'meter' || tag === 'output' || tag === 'progress') {
      const label = nativeLabelText(element);
      if (label) return label;
    }
    if (tag === 'img' || tag === 'area') {
      const alt = norm(element.getAttribute('alt'));
      if (alt) return alt;
    }
    if (tag === 'table' && element.caption) return norm(element.caption.textContent);
    if (tag === 'fieldset') {
      const legend = element.querySelector(':scope > legend');
      if (legend) return norm(legend.textContent);
    }
    if (tag === 'figure') {
      const caption = element.querySelector(':scope > figcaption');
      if (caption) return norm(caption.textContent);
    }
    if (NAME_FROM_CONTENT[role]) {
      const content = norm(contentName(element.shadowRoot || element, 0));
      if (content) return content;
    }
    return norm(element.getAttribute('title') || element.getAttribute('placeholder'));
  };

  const selectElements = (step, root) => {
    if (step.by === 'css') {
      const scopes = treeScopes(root);
      const out = [];
      for (let index = 0; index < scopes.length; index += 1) {
        const matches = scopes[index].querySelectorAll(step.selector);
        for (let at = 0; at < matches.length; at += 1) if (!inHost(matches[at])) out.push(matches[at]);
      }
      return out;
    }
    const elements = allElements(root);
    const out = [];
    if (step.by === 'role') {
      const wanted = step.role.toLowerCase();
      const nameMatch = step.name === undefined ? null : matcher(step.name, step.exact === true);
      for (let index = 0; index < elements.length; index += 1) {
        const element = elements[index];
        const role = roleOf(element);
        if (role !== wanted && !(wanted === 'textbox' && role === 'searchbox')) continue;
        if (isHiddenFromTree(element)) continue;
        if (nameMatch && !nameMatch(nameOf(element, role))) continue;
        out.push(element);
      }
      return out;
    }
    if (step.by === 'placeholder') {
      const match = matcher(step.value, step.exact === true);
      for (let index = 0; index < elements.length; index += 1) {
        const value = elements[index].getAttribute('placeholder');
        if (value !== null && match(norm(value))) out.push(elements[index]);
      }
      return out;
    }
    if (step.by === 'label') {
      const match = matcher(step.value, step.exact === true);
      for (let index = 0; index < elements.length; index += 1) {
        const element = elements[index];
        const tag = element.localName;
        if (tag === 'label' || (tag === 'input' && String(element.type || '').toLowerCase() === 'hidden')) continue;
        if (!element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby') && !(element.labels && element.labels.length)) continue;
        if (match(labelledByText(element) || norm(element.getAttribute('aria-label')) || nativeLabelText(element))) out.push(element);
      }
      return out;
    }
    // Text: the smallest elements holding it. Reverse document order sees children first.
    const match = matcher(step.value, step.exact === true);
    const matched = new Set();
    const texts = new Map();
    for (let index = elements.length - 1; index >= 0; index -= 1) {
      const element = elements[index];
      if (NO_TEXT_TAGS[element.localName]) continue;
      const tag = element.localName;
      const type = tag === 'input' ? String(element.type || '').toLowerCase() : '';
      const own = type === 'button' || type === 'submit' || type === 'reset' ? element.value : shownText(element, texts);
      if (!match(norm(own))) continue;
      matched.add(element);
      let hasMatchedChild = false;
      for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
        if (matched.has(child)) { hasMatchedChild = true; break; }
      }
      if (!hasMatchedChild) out.push(element);
    }
    return out.reverse();
  };
  // A selector list's matches together in document order (shadow roots and
  // same-origin frames after the document, as css steps list them).
  const inDocumentOrder = (found) => {
    const out = [];
    const elements = allElements(document);
    for (let index = 0; index < elements.length; index += 1) {
      if (found.has(elements[index])) { out.push(elements[index]); found.delete(elements[index]); }
    }
    for (const element of found) out.push(element);
    return out;
  };
  const resolveSteps = (chain, start) => {
    let current = start;
    for (let index = 0; index < chain.length; index += 1) {
      const step = chain[index];
      if (step.by === 'or') {
        const found = new Set();
        let lists = 0;
        let only = [];
        for (let branch = 0; branch < step.chains.length; branch += 1) {
          const matches = resolveSteps(step.chains[branch], current);
          if (matches.length > 0) { lists += 1; only = matches; }
          for (let at = 0; at < matches.length; at += 1) found.add(matches[at]);
        }
        current = lists > 1 ? inDocumentOrder(found) : only;
        continue;
      }
      if (step.by === 'nth') {
        if (!current) current = [];
        const at = step.index < 0 ? current.length + step.index : step.index;
        current = at >= 0 && at < current.length ? [current[at]] : [];
        continue;
      }
      if (step.by === 'filter') {
        const has = step.hasText === undefined ? null : matcher(step.hasText, false);
        const hasNot = step.hasNotText === undefined ? null : matcher(step.hasNotText, false);
        const kept = [];
        const texts = new Map();
        for (let at = 0; at < (current || []).length; at += 1) {
          const element = current[at];
          const text = norm(shownText(element, texts));
          if (has && !has(text)) continue;
          if (hasNot && hasNot(text)) continue;
          if (step.visible !== undefined && isVisible(element) !== step.visible) continue;
          kept.push(element);
        }
        current = kept;
        continue;
      }
      if (!current) {
        current = selectElements(step, document);
        continue;
      }
      const seen = new Set();
      const next = [];
      for (let at = 0; at < current.length; at += 1) {
        const matches = selectElements(step, current[at]);
        for (let inner = 0; inner < matches.length; inner += 1) {
          if (!seen.has(matches[inner])) { seen.add(matches[inner]); next.push(matches[inner]); }
        }
      }
      current = next;
    }
    return current || [];
  };
  const resolveChain = (chain) => resolveSteps(chain, scopedStart ? [scopedStart] : null);

  const selectorHint = (element) => {
    if (element.id) return '#' + element.id;
    const testId = element.getAttribute('data-testid');
    if (testId) return '[data-testid="' + testId + '"]';
    return undefined;
  };
  const selectors = (${UNIQUE_SELECTOR_SOURCE})(${PROGRAM_SELECTOR_LIMIT_CHARS});
  const contextOf = (element) => {
    const holder = element.parentElement && element.parentElement.closest('tr,li,article,section,form,fieldset,[role="row"],[role="listitem"],[role="dialog"]');
    if (!holder) return undefined;
    const text = norm(holder.innerText || holder.textContent);
    return text ? text.slice(0, 100) : undefined;
  };
  // A match inside a same-origin iframe names the iframe (by a selector unique
  // in the iframe's own document): the match's selector is unique only there.
  const describe = (element) => {
    const role = roleOf(element);
    const selector = selectors.unique(element);
    const context = contextOf(element);
    const holder = element.ownerDocument !== document ? viewOf(element).frameElement : null;
    const frame = holder ? selectors.unique(holder) || holder.localName : undefined;
    return {
      role,
      name: nameOf(element, role).slice(0, 80),
      tag: element.localName,
      text: norm(element.textContent).slice(0, 80),
      visible: isVisible(element),
      ...(context ? { context } : {}),
      ...(selector ? { selector } : {}),
      ...(frame ? { frame } : {}),
    };
  };
  // tag#id.class.class "text": enough to recognize an overlay or a collapsed container.
  const brief = (element) => {
    const hint = selectorHint(element);
    const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    let label = element.localName + (hint && hint.charAt(0) === '#' ? hint : '');
    for (let index = 0; index < classes.length; index += 1) label += '.' + classes[index];
    return label + (norm(element.textContent) ? ' "' + norm(element.textContent).slice(0, 40) + '"' : '');
  };
  const parentOf = (at) => at.parentElement || (at.parentNode && at.parentNode.host) || null;
  // What keeps a hidden element hidden: itself, or a collapsed ancestor
  // (display: none, a closed <details>, visibility: hidden, a zero-size clip).
  const hiddenCause = (element) => {
    let display = null;
    let details = null;
    let visibility = null;
    let visibilityChain = true;
    let clipped = null;
    const inSummary = Boolean(element.closest && element.closest('summary'));
    for (let at = element, depth = 0; at && at.nodeType === 1 && depth < 64; depth += 1) {
      const style = viewOf(at).getComputedStyle(at);
      if (!display && style.display === 'none') display = at;
      if (style.visibility === 'hidden' || style.visibility === 'collapse') {
        if (visibilityChain) visibility = at;
      } else {
        visibilityChain = false;
      }
      if (!details && at !== element && at.localName === 'details' && !at.open && !inSummary) details = at;
      if (!clipped && at !== element && /hidden|clip/.test(style.overflow + ' ' + style.overflowX + ' ' + style.overflowY)) {
        const box = at.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) clipped = at;
      }
      at = parentOf(at);
    }
    const holder = display || details || visibility || clipped || element;
    return { hiddenBy: brief(holder), ...(holder !== element ? { collapsed: true } : {}) };
  };
  // An inert subtree takes no pointer, focus or keyboard input: the page keeps
  // it out of reach (a collapsed group left in the DOM), whatever its boxes show.
  const inertHolder = (element) => {
    for (let at = element, depth = 0; at && at.nodeType === 1 && depth < 64; at = parentOf(at), depth += 1) {
      if (at.hasAttribute('inert')) return at;
    }
    return null;
  };
  // An aria-hidden ancestor whose part of the page is not painted where the
  // target is: transparent (opacity 0), or clipped by a box that does not hold
  // the target's center. aria-hidden alone hides nothing (dialog libraries
  // mark the whole page behind a modal), so a painted target keeps its reason.
  const unpaintedAriaHolder = (element) => {
    const box = element.getBoundingClientRect();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    let unpainted = false;
    for (let at = element, depth = 0; at && at.nodeType === 1 && depth < 64; at = parentOf(at), depth += 1) {
      const style = viewOf(at).getComputedStyle(at);
      if (style.opacity === '0') unpainted = true;
      if (at !== element && /hidden|clip|scroll|auto/.test(style.overflow + ' ' + style.overflowX + ' ' + style.overflowY)) {
        const clip = at.getBoundingClientRect();
        if (x < clip.x || y < clip.y || x >= clip.x + clip.width || y >= clip.y + clip.height) unpainted = true;
      }
      if (unpainted && at !== element && at.getAttribute('aria-hidden') === 'true') return at;
    }
    return null;
  };
  // A link that opens nothing new ("#", javascript:, the current address) is no page to offer.
  const linkOf = (element) => {
    const link = element.closest ? element.closest('a[href]') : null;
    const href = link && link.href ? String(link.href) : '';
    if (!href || /^javascript:/i.test(href)) return {};
    const hash = href.indexOf('#');
    const here = String(viewOf(link).location.href).split('#')[0];
    if ((hash < 0 || hash === href.length - 1) && (hash < 0 ? href : href.slice(0, hash)) === here) return {};
    return { href: href.slice(0, 500) };
  };
  // Hidden copies (a collapsed mobile menu) are never what an action or read meant.
  const pick = (matches) => {
    if (matches.length === 0) return { error: 'not_found' };
    if (matches.length === 1) return { element: matches[0] };
    const visible = [];
    for (let index = 0; index < matches.length; index += 1) if (isVisible(matches[index])) visible.push(matches[index]);
    if (visible.length === 1) return { element: visible[0] };
    const candidates = [];
    const pool = visible.length > 0 ? visible : matches;
    for (let index = 0; index < pool.length && index < 5; index += 1) candidates.push(describe(pool[index]));
    return { error: 'ambiguous', count: pool.length, candidates };
  };
  // A locator that matched nothing: elements whose name or text resembles what
  // it asked for, whatever their role (a "button" that is really a link).
  const STRUCTURAL_ROLES = { list: 1, listitem: 1, table: 1, rowgroup: 1, row: 1, paragraph: 1, group: 1, region: 1, main: 1, navigation: 1, banner: 1, contentinfo: 1, complementary: 1, article: 1, figure: 1, definition: 1, term: 1, separator: 1, form: 1, presentation: 1 };
  const nearCandidates = (chain) => {
    let wanted;
    let wantedRole = '';
    for (let index = chain.length - 1; index >= 0 && wanted === undefined; index -= 1) {
      const step = chain[index];
      if (step.by === 'role') {
        wantedRole = String(step.role).toLowerCase();
        if (step.name === undefined) break;
        wanted = step.name;
      } else if (step.by === 'text' || step.by === 'label' || step.by === 'placeholder') {
        wanted = step.value;
      } else if (step.by === 'css' || step.by === 'ref' || step.by === 'or') {
        break;
      }
    }
    if (wanted === undefined) return [];
    let resembles;
    if (wanted && typeof wanted === 'object') {
      const pattern = new RegExp(wanted.regex, String(wanted.flags || '').replace('g', '') + (String(wanted.flags || '').indexOf('i') >= 0 ? '' : 'i'));
      resembles = (text) => pattern.test(text);
    } else {
      const phrase = norm(wanted).toLowerCase();
      const words = phrase.split(' ').filter((word) => word.length > 2);
      resembles = (text) => {
        const lower = text.toLowerCase();
        if (!lower || !phrase) return false;
        if (lower.indexOf(phrase) >= 0 || (lower.length >= 3 && phrase.indexOf(lower) >= 0)) return true;
        return words.length > 0 && words.every((word) => lower.indexOf(word) >= 0);
      };
    }
    const elements = allElements(document);
    const found = [];
    for (let index = 0; index < elements.length && index < 20000 && found.length < 50; index += 1) {
      const element = elements[index];
      if (NO_TEXT_TAGS[element.localName]) continue;
      const role = roleOf(element);
      if (!role || STRUCTURAL_ROLES[role]) continue;
      const name = nameOf(element, role);
      if (!resembles(name) && !resembles(norm(element.getAttribute('placeholder')))) continue;
      found.push({ element, score: (isVisible(element) ? 2 : 0) + (role === wantedRole ? 1 : 0) });
    }
    found.sort((a, b) => b.score - a.score);
    const out = [];
    for (let index = 0; index < found.length && out.length < 5; index += 1) out.push(describe(found[index].element));
    return out;
  };

  const textOf = (element, inner) => {
    if (credential(element)) return REDACTED;
    const areas = element.querySelectorAll ? element.querySelectorAll('textarea') : [];
    let source = element;
    let hasCredential = false;
    for (let index = 0; index < areas.length; index += 1) if (credential(areas[index])) hasCredential = true;
    if (hasCredential) {
      source = element.cloneNode(true);
      const copies = source.querySelectorAll('textarea');
      for (let index = 0; index < copies.length; index += 1) {
        if (credential(areas[index])) copies[index].textContent = REDACTED;
      }
    }
    const raw = inner && source === element ? element.innerText : source.innerText || source.textContent;
    return omitDataUrls(inner ? String(raw == null ? '' : raw) : norm(raw || source.textContent));
  };
  const valueOf = (element) => {
    if (credential(element)) return REDACTED;
    const tag = element.localName;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return String(element.value == null ? '' : element.value);
    if (element.isContentEditable) return String(element.innerText || '');
    const attr = element.getAttribute('value');
    return attr === null ? String(element.textContent || '').trim() : attr;
  };
  const attributeOf = (element, name) => {
    if (!element.hasAttribute(name)) return null;
    if (name.toLowerCase() === 'value' && credential(element)) return REDACTED;
    return element.getAttribute(name);
  };
  const selectedTextOf = (element) => {
    if (element.localName !== 'select') return textOf(element, false);
    const parts = [];
    const selected = element.selectedOptions;
    for (let index = 0; index < selected.length; index += 1) parts.push(norm(selected[index].text));
    return parts.join(', ');
  };
  const checkedOf = (element) => {
    if ('checked' in element) return Boolean(element.checked);
    const aria = element.getAttribute('aria-checked');
    return aria === 'true' ? true : aria === 'false' ? false : null;
  };
  const HTML_LIMIT = ${PROGRAM_HTML_LIMIT_CHARS};
  // Credential fields keep their redaction: a server-rendered value attribute is replaced.
  const redactCredentials = (source, clone) => {
    const redact = (original, copy) => {
      if (!credential(original)) return;
      if (copy.localName === 'textarea') copy.textContent = REDACTED;
      else copy.setAttribute('value', REDACTED);
    };
    redact(source, clone);
    const controls = source.querySelectorAll('input,textarea');
    const copies = clone.querySelectorAll('input,textarea');
    for (let index = 0; index < controls.length; index += 1) redact(controls[index], copies[index]);
  };
  // The sanitizer of query kind "dom": no scripts, styles, comments, hidden parts or handlers.
  const htmlOf = (element, outer) => {
    const html = sanitizeHtml(element, !outer, redactCredentials);
    if (html.length <= HTML_LIMIT) return html;
    return html.slice(0, HTML_LIMIT) + '\n<!-- truncated: ' + HTML_LIMIT + ' of ' + html.length + ' characters; read a smaller element -->';
  };
  // One match of a list copy (locator.all()): what its reads answer from, in the program.
  const elementCopy = (element, spec) => {
    const cut = [];
    const bound = (name, value) => {
      if (typeof value !== 'string' || !spec.maxChars || value.length <= spec.maxChars) return value;
      cut.push(name);
      return value.slice(0, spec.maxChars);
    };
    const attrs = {};
    const list = element.attributes;
    for (let index = 0; index < list.length; index += 1) attrs[list[index].name] = bound('@' + list[index].name, attributeOf(element, list[index].name));
    const copy = {
      attrs,
      text: bound('text', textOf(element, false)),
      innerText: bound('innerText', textOf(element, true)),
      value: bound('value', valueOf(element)),
      visible: isVisible(element),
      enabled: isEnabled(element),
      checked: checkedOf(element),
    };
    if (cut.length) copy.cut = cut;
    return copy;
  };
  const readValue = (element, what) => {
    if (what && typeof what === 'object') return what.element ? elementCopy(element, what.element) : attributeOf(element, what.attr);
    switch (what) {
      case 'text': return textOf(element, false);
      case 'innerText': return textOf(element, true);
      case 'value': return valueOf(element);
      case 'selectedText': return selectedTextOf(element);
      case 'visible': return isVisible(element);
      case 'enabled': return isEnabled(element);
      case 'checked': return checkedOf(element);
      case 'html':
      case 'innerHTML': return htmlOf(element, false);
      case 'outerHTML': return htmlOf(element, true);
      default: return null;
    }
  };

  const frameOffset = (element) => {
    let x = 0;
    let y = 0;
    let view = viewOf(element);
    while (view !== window) {
      const owner = view.frameElement;
      if (!owner) break;
      const rect = owner.getBoundingClientRect();
      x += rect.x + owner.clientLeft;
      y += rect.y + owner.clientTop;
      view = viewOf(owner);
    }
    return { x, y };
  };
  const rootRect = (element) => {
    const rects = element.getClientRects();
    const box = rects.length > 1 ? rects[0] : element.getBoundingClientRect();
    const offset = frameOffset(element);
    return { x: box.x + offset.x, y: box.y + offset.y, width: box.width, height: box.height };
  };
  const nextFrame = () => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, 34);
  });
  const deepHit = (startX, startY) => {
    let x = startX;
    let y = startY;
    let hit = document.elementFromPoint(x, y);
    for (let depth = 0; hit && depth < 32; depth += 1) {
      if (hit.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (inner && inner !== hit) { hit = inner; continue; }
      }
      if (hit.localName === 'iframe' || hit.localName === 'frame') {
        let inner = null;
        try {
          const doc = hit.contentDocument;
          if (doc) {
            const rect = hit.getBoundingClientRect();
            x -= rect.x + hit.clientLeft;
            y -= rect.y + hit.clientTop;
            inner = doc.elementFromPoint(x, y);
          }
        } catch (error) { inner = null; }
        if (inner) { hit = inner; continue; }
      }
      return hit;
    }
    return hit;
  };
  const composedContains = (holder, node) => {
    for (let at = node; at; at = at.parentNode || at.host) if (at === holder) return true;
    return false;
  };
  // What acts on a click of its own: a click on the element around it does not reach it.
  const INTERACTIVE = 'a[href],area[href],button,input,select,textarea,summary,label,option,iframe,[onclick],[tabindex],[contenteditable]:not([contenteditable="false"])';
  const WIDGET_ROLES = { button: 1, link: 1, checkbox: 1, radio: 1, switch: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, option: 1, combobox: 1, textbox: 1, searchbox: 1, slider: 1, spinbutton: 1, treeitem: 1 };
  const visuallyHidden = (element, holder) => {
    const box = element.getBoundingClientRect();
    if (box.width <= 2 || box.height <= 2) return true;
    for (let at = element; at && at !== holder && at.nodeType === 1; at = at.parentElement) {
      const style = viewOf(at).getComputedStyle(at);
      if ((style.clip && style.clip !== 'auto') || (style.clipPath && style.clipPath !== 'none')) return true;
    }
    return false;
  };
  const receivesPointer = (element, hit) => {
    if (!hit) return false;
    if (composedContains(element, hit)) return true;
    const labels = element.labels;
    for (let index = 0; labels && index < labels.length; index += 1) {
      if (composedContains(labels[index], hit)) return true;
    }
    // Visually hidden text of a control (a 1 px screen-reader label): the
    // control around it takes the click, as it does for a user.
    const page = hit.ownerDocument;
    if (hit === page.body || hit === page.documentElement || !composedContains(hit, element)) return false;
    if (element.matches(INTERACTIVE) || WIDGET_ROLES[roleOf(element)]) return false;
    return visuallyHidden(element, hit);
  };
  const inViewport = (rect) => rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= window.innerWidth && rect.y + rect.height <= window.innerHeight;
  // A link or button inside the label a check aims at acts on a click of its own
  // (a "Terms of Service" link in "I agree to the Terms of Service").
  const actsOnItsOwn = (label, element, hit) => {
    for (let at = hit; at && at !== label; at = at.parentNode || at.host) {
      if (at !== element && at.nodeType === 1 && (at.matches(INTERACTIVE) || WIDGET_ROLES[roleOf(at)])) return true;
    }
    return false;
  };
  // The x of a point of the label's own text (at its middle line), off the links and buttons inside it.
  const LABEL_SPOTS = [0.1, 0.25, 0.4, 0.6, 0.75, 0.9];
  const labelSpot = (label, element, box) => {
    const y = box.y + box.height / 2;
    for (let index = 0; index < LABEL_SPOTS.length; index += 1) {
      const x = box.x + box.width * LABEL_SPOTS[index];
      const hit = deepHit(x, y);
      if (receivesPointer(label, hit) && !actsOnItsOwn(label, element, hit)) return x;
    }
    return null;
  };
  const probe = async (element, checks) => {
    let pointer = element;
    if (checks.labelFallback && !isVisible(element)) {
      const labels = element.labels;
      if (labels && labels.length && isVisible(labels[0])) pointer = labels[0];
    }
    if (!isVisible(pointer)) return { reason: 'hidden', ...hiddenCause(pointer), ...linkOf(element) };
    const inert = inertHolder(pointer) || (pointer !== element ? inertHolder(element) : null);
    if (inert) {
      return { reason: 'hidden', hiddenBy: brief(inert), ...(inert !== element && inert !== pointer ? { collapsed: true } : {}), ...linkOf(element) };
    }
    if (checks.enabled && !isEnabled(element)) return { reason: 'disabled' };
    if (checks.nativeDisabled && element.matches(':disabled')) return { reason: 'disabled' };
    if (checks.editable && !isEditable(element)) return { reason: 'not_editable' };
    if (!checks.pointer) return { ok: true };
    // reveal: the caller found the point outside the main viewport (a frame
    // below the fold), which this realm cannot see; scrolling the target into
    // view scrolls the frames around it too.
    if (checks.reveal || !inViewport(rootRect(pointer))) {
      pointer.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }
    const first = rootRect(pointer);
    await nextFrame();
    if (!pointer.isConnected) return { reason: 'hidden' };
    const second = rootRect(pointer);
    if (Math.abs(first.x - second.x) > 0.5 || Math.abs(first.y - second.y) > 0.5 || Math.abs(first.width - second.width) > 0.5 || Math.abs(first.height - second.height) > 0.5) {
      return { reason: 'unstable' };
    }
    let x = second.x + second.width / 2;
    const y = second.y + second.height / 2;
    // The box the point is the center of: the label's own text off its links, when it holds one.
    let aimed = second;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return { reason: 'outside_viewport', ...linkOf(element) };
    const hit = deepHit(x, y);
    if (!receivesPointer(pointer, hit)) {
      // Missed inside an unpainted aria-hidden group: the group is collapsed, nothing covers it.
      const group = unpaintedAriaHolder(pointer) || (pointer !== element ? unpaintedAriaHolder(element) : null);
      if (group) return { reason: 'hidden', hiddenBy: brief(group), collapsed: true, ...linkOf(element) };
      // ownCover: what covers it belongs to the control (a styled knob over a
      // transparent input, within its nearest containers short of a dialog), not
      // to the page (a modal's backdrop, a banner). A switch inside a dialog is
      // covered by its own knob, which is in the same dialog.
      const page = element.ownerDocument;
      const dialog = element.closest(MODAL);
      let ownCover = false;
      for (let holder = element.parentElement, depth = 0; hit && holder && depth < 4 && !ownCover; holder = holder.parentElement, depth += 1) {
        if (holder === page.body || holder === page.documentElement || holder === dialog) break;
        ownCover = composedContains(holder, hit) && hit.closest(MODAL) === dialog;
      }
      return { reason: 'covered', coveredBy: hit ? brief(hit) : undefined, ...(ownCover ? { ownCover: true } : {}), ...linkOf(element) };
    }
    if (pointer !== element && actsOnItsOwn(pointer, element, hit)) {
      const spot = labelSpot(pointer, element, second);
      if (spot === null) return { reason: 'covered', coveredBy: brief(hit), ownCover: true, ...linkOf(element) };
      x = spot;
      aimed = { x: spot - 1, y: second.y, width: 2, height: second.height };
    }
    const opener = element.closest ? element.closest('a[target],area[target],form[target]') : null;
    const target = opener ? String(opener.getAttribute('target') || '').toLowerCase() : '';
    // frameLocal: the request ran in a frame's own realm (a node of a frame
    // called directly), so x and y are in that frame's viewport.
    // submits: the target is (inside) a control that submits its form.
    const submitter = element.closest ? element.closest('button,input') : null;
    const submits = Boolean(submitter && submitter.form && (submitter.type === 'submit' || submitter.type === 'image'));
    return { ok: true, x, y, rect: aimed, ...(target === '_blank' ? { opensNewTab: true } : {}), ...(window !== window.top ? { frameLocal: true } : {}), ...(submits ? { submits: true } : {}), ...linkOf(element) };
  };
  // What a blocked target's page offers: reported, never clicked here.
  const TOGGLE = 'button,summary,a,[role="button"],[role="tab"],[role="menuitem"],[aria-expanded],[aria-haspopup]';
  const CLOSE_NAME = /^(?:close|dismiss|cancel|hide|no,? thanks|not now|maybe later|got it|ok|okay|x|\u00d7|\u2715|\u2716|\u5173\u95ed|\u53d6\u6d88|\u77e5\u9053\u4e86)(?:\s.*)?$/i;
  const CLOSE_MARK = '[data-dismiss],[data-bs-dismiss],[aria-label*="close" i],[title*="close" i],.close,.btn-close';
  const MODAL = 'dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
  const handleOf = (element) => {
    const text = (nameOf(element, roleOf(element)) || norm(element.getAttribute('name'))).slice(0, 60);
    const selector = element.getRootNode() === document ? selectors.unique(element) : undefined;
    return { tag: element.localName, ...(text ? { text } : {}), ...(selector ? { selector } : {}) };
  };
  const firstVisible = (elements) => {
    for (let index = 0; index < elements.length; index += 1) if (isVisible(elements[index])) return elements[index];
    return null;
  };
  // A control found only by its position is a guess: one without a name, or one
  // that removes, clears or closes something, is not what opens a container.
  const NOT_OPENER_NAME = /^(?:remove|delete|clear|reset|discard|trash|\u5220\u9664|\u79fb\u9664|\u6e05\u9664)(?:\s.*)?$/i;
  const likelyOpener = (control) => {
    if (control.matches(CLOSE_MARK)) return false;
    const name = nameOf(control, roleOf(control));
    return Boolean(name) && !CLOSE_NAME.test(name) && !NOT_OPENER_NAME.test(name);
  };
  const adjacentToggle = (holder) => {
    const near = [];
    for (let before = holder.previousElementSibling, steps = 0; before && steps < 2; before = before.previousElementSibling, steps += 1) {
      if (!isVisible(before) || before.getAttribute('aria-expanded') === 'true') continue;
      if (before.matches(TOGGLE)) { near.push(before); continue; }
      const inner = before.querySelectorAll(TOGGLE);
      for (let index = 0; index < inner.length; index += 1) {
        if (inner[index].getAttribute('aria-expanded') !== 'true' && isVisible(inner[index])) near.push(inner[index]);
      }
    }
    for (let index = 0; index < near.length; index += 1) {
      if (near[index].getAttribute('aria-expanded') === 'false') return { control: near[index] };
    }
    for (let index = 0; index < near.length; index += 1) {
      if (likelyOpener(near[index])) return { control: near[index], guessed: true };
    }
    return null;
  };
  const toggleFor = (holder) => {
    if (holder.localName === 'details' && !holder.open) {
      const summary = holder.querySelector(':scope > summary');
      return summary ? { control: summary } : null;
    }
    const doc = holder.ownerDocument;
    const id = holder.getAttribute('id');
    if (id) {
      const name = selectors.quoted(id);
      const fragment = selectors.quoted('#' + id);
      const linked = firstVisible(doc.querySelectorAll('[aria-controls~=' + name + '],[aria-owns~=' + name + '],[data-target=' + fragment + '],[data-bs-target=' + fragment + '],[href=' + fragment + ']'));
      if (linked) return { control: linked };
    }
    const labelledBy = norm(holder.getAttribute('aria-labelledby')).split(' ');
    for (let index = 0; index < labelledBy.length; index += 1) {
      const label = labelledBy[index] ? doc.getElementById(labelledBy[index]) : null;
      if (label && isVisible(label)) return { control: label.matches(TOGGLE) ? label : firstVisible(label.querySelectorAll(TOGGLE)) || label };
    }
    const near = adjacentToggle(holder);
    if (near) return near;
    const wrapper = holder.parentElement;
    return wrapper && wrapper.children.length === 1 ? adjacentToggle(wrapper) : null;
  };
  // The outermost closed ancestor is the one that can be opened now.
  const openerOf = (element) => {
    const closed = [];
    for (let at = element.parentElement, depth = 0; at && depth < 64; at = at.parentElement, depth += 1) {
      if ((at.localName === 'details' && !at.open) || !isVisible(at)) closed.push(at);
    }
    for (let index = closed.length - 1; index >= 0; index -= 1) {
      const toggle = toggleFor(closed[index]);
      if (toggle) return toggle;
    }
    return null;
  };
  const isEmptyField = (field, holder) => {
    const type = String(field.type || '').toLowerCase();
    if (type === 'checkbox') return !field.checked;
    if (type === 'radio') {
      const group = holder.querySelectorAll('input[type="radio"]');
      for (let index = 0; index < group.length; index += 1) if (group[index].name === field.name && group[index].checked) return false;
      return true;
    }
    return !('value' in field ? field.value : norm(field.textContent));
  };
  const missingFields = (element) => {
    const holder = element.form || element.closest('form,[role="form"],dialog,[role="dialog"],fieldset');
    if (!holder) return [];
    const fields = holder.querySelectorAll('input,select,textarea,[contenteditable="true"],[role="textbox"],[role="combobox"]');
    const named = {};
    const out = [];
    for (let index = 0; index < fields.length && out.length < ${PROGRAM_MISSING_FIELDS_LIMIT}; index += 1) {
      const field = fields[index];
      if (field === element || field.disabled || NON_FIELD_INPUTS[String(field.type || '').toLowerCase()]) continue;
      if (!(field.required || field.getAttribute('aria-required') === 'true') || !isEmptyField(field, holder)) continue;
      if (field.name && named[field.name]) continue;
      if (field.name) named[field.name] = true;
      out.push(handleOf(field));
    }
    return out;
  };
  const closeControl = (holder) => {
    const controls = holder.querySelectorAll('button,a,[role="button"],' + CLOSE_MARK);
    for (let index = 0; index < controls.length; index += 1) {
      const control = controls[index];
      if (!isVisible(control)) continue;
      if (control.matches(CLOSE_MARK) || CLOSE_NAME.test(nameOf(control, roleOf(control)))) return control;
    }
    return null;
  };
  const overlayOf = (hit) => {
    const modal = hit.closest(MODAL);
    if (modal) return modal;
    let top = hit;
    for (let at = hit; at && at.localName !== 'body'; at = at.parentElement) {
      if (/^(?:fixed|absolute)$/.test(viewOf(at).getComputedStyle(at).position)) top = at;
    }
    return top;
  };
  const closerOf = (element) => {
    const box = rootRect(element);
    const hit = deepHit(box.x + box.width / 2, box.y + box.height / 2);
    if (!hit || composedContains(element, hit)) return {};
    const closer = closeControl(overlayOf(hit)) || closeControl(firstVisible(document.querySelectorAll(MODAL)) || document.createElement('div'));
    return closer ? { closer: handleOf(closer) } : { closable: false };
  };
  const explainBlock = (element, reason) => {
    if (reason === 'hidden') {
      const opener = openerOf(element);
      return opener ? { opener: { ...handleOf(opener.control), ...(opener.guessed ? { guessed: true } : {}) } } : {};
    }
    if (reason === 'disabled') {
      const missing = missingFields(element);
      return missing.length > 0 ? { missing } : {};
    }
    return reason === 'covered' ? closerOf(element) : {};
  };
  const deepActive = () => {
    let active = document.activeElement;
    for (let depth = 0; active && depth < 32; depth += 1) {
      if (active.shadowRoot && active.shadowRoot.activeElement) { active = active.shadowRoot.activeElement; continue; }
      if (active.localName === 'iframe' || active.localName === 'frame') {
        let inner = null;
        try { inner = active.contentDocument && active.contentDocument.activeElement; } catch (error) { inner = null; }
        if (inner && inner !== active.contentDocument.body) { active = inner; continue; }
      }
      break;
    }
    return active;
  };
  const prepareFill = (element, value) => {
    const tag = element.localName;
    const type = tag === 'input' ? String(element.type || '').toLowerCase() : '';
    if (VALUE_CONTROLS[type] === 1) {
      element.focus();
      const setter = Object.getOwnPropertyDescriptor(viewOf(element).HTMLInputElement.prototype, 'value');
      if (setter && setter.set) setter.set.call(element, value); else element.value = value;
      element.dispatchEvent(new (viewOf(element).Event)('input', { bubbles: true }));
      element.dispatchEvent(new (viewOf(element).Event)('change', { bubbles: true }));
      return { ok: true, mode: 'value', actual: String(element.value) };
    }
    element.focus();
    if (deepActive() !== element && !element.contains(deepActive())) return { reason: 'not_editable' };
    if (tag === 'input' || tag === 'textarea') {
      if (typeof element.select === 'function') element.select();
    } else {
      const doc = element.ownerDocument;
      const selection = doc.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return { ok: true, mode: 'text', empty: String(value) === '' };
  };
  // The fill's own field (or the focused field inside it), never whatever holds
  // focus now: a page that moves focus on input would show another field's text.
  const fillCheck = (element, expected) => {
    const active = deepActive();
    const field = active && active !== element && element.contains(active) ? active : element;
    const editable = field.localName === 'input' || field.localName === 'textarea';
    const raw = editable ? String(field.value == null ? '' : field.value) : norm(field.innerText);
    const wanted = editable ? expected : norm(expected);
    const type = field.localName === 'input' ? String(field.type || '').toLowerCase() : '';
    return {
      ok: true,
      matches: raw === wanted || (type === 'number' && Number(raw) === Number(wanted)),
      ...(credential(field) ? {} : { actual: raw.slice(0, 200) }),
    };
  };

  const pageInfo = () => {
    let text = false;
    if (request.text !== undefined) {
      const match = matcher(request.text, false);
      const body = document.body;
      text = body ? match(norm(body.innerText)) : false;
    }
    const url = location.href;
    return {
      ok: true,
      url,
      title: document.title,
      readyState: document.readyState,
      timeOrigin: performance.timeOrigin,
      ...(request.text !== undefined ? { textFound: text } : {}),
      ...(request.url !== undefined ? { urlMatches: matcher(request.url, false)(url) } : {}),
    };
  };
  const stateMet = (matches, state) => {
    if (state === 'attached') return matches.length > 0;
    if (state === 'detached') return matches.length === 0;
    let visible = false;
    for (let index = 0; index < matches.length && !visible; index += 1) visible = isVisible(matches[index]);
    return state === 'visible' ? visible : !visible;
  };
  const readAll = (matches) => {
    const names = Object.keys(request.fields);
    const rows = [];
    let chars = 0;
    const end = Math.min(matches.length, request.limit);
    let index = 0;
    for (; index < end; index += 1) {
      if (chars > request.budget) break;
      const row = {};
      for (let at = 0; at < names.length; at += 1) {
        const field = request.fields[names[at]];
        let target = matches[index];
        if (field.sel) {
          try { target = matches[index].querySelector(field.sel); } catch (error) {
            return { error: 'invalid', message: 'Field ' + names[at] + ': ' + String(error && error.message) };
          }
        }
        const value = target ? readValue(target, field.what) : null;
        if (typeof value === 'string') chars += value.length;
        else if (value && typeof value === 'object') chars += JSON.stringify(value).length;
        row[names[at]] = value;
      }
      rows.push(row);
    }
    return { ok: true, rows, total: matches.length, truncated: index < matches.length };
  };

  const run = async () => {
    if (request.kind === 'page') return pageInfo();
    const matches = resolveChain(request.chain);
    switch (request.kind) {
      case 'count': {
        let visible = 0;
        for (let index = 0; index < matches.length; index += 1) if (isVisible(matches[index])) visible += 1;
        return { ok: true, count: matches.length, visible };
      }
      case 'state':
        return { ok: true, met: stateMet(matches, request.state), matched: matches.length };
      case 'readAll':
        return readAll(matches);
      default:
        break;
    }
    const picked = pick(matches);
    if (picked.error) return picked;
    const element = picked.element;
    switch (request.kind) {
      case 'read':
        return { ok: true, value: readValue(element, request.what) };
      case 'probe':
        return probe(element, request.checks);
      case 'explain':
        return { ok: true, ...explainBlock(element, request.reason) };
      case 'prepareFill': {
        const state = await probe(element, { enabled: true, editable: true });
        return state.ok ? prepareFill(element, request.value) : state;
      }
      case 'focus': {
        const state = await probe(element, { enabled: true });
        if (!state.ok) return state;
        element.focus();
        // Keys and text go to whatever holds focus. The target must take it itself:
        // a container whose focus() does nothing would pass them on to a field
        // focused before, inside it or not (and Enter would submit that field's form).
        // Only elements that hand focus on by definition may hold it inside: a
        // shadow host with delegatesFocus, and a frame.
        const active = deepActive();
        const delegates = (element.shadowRoot && element.shadowRoot.delegatesFocus) || element.localName === 'iframe' || element.localName === 'frame';
        let inside = false;
        for (let at = active; delegates && at && !inside; at = at.parentNode || at.host || (at.nodeType === 9 && at.defaultView ? at.defaultView.frameElement : null)) inside = at === element;
        if (active !== element && !inside) return { reason: 'not_focusable' };
        return { ok: true };
      }
      case 'checkState': {
        const type = element.localName === 'input' ? String(element.type || '').toLowerCase() : '';
        const role = roleOf(element);
        const checkable = type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio';
        // A node the page took out still answers (CDP resolves it while JavaScript holds it).
        return { ok: true, checkable, type: type || role, checked: checkedOf(element) === true, connected: element.isConnected };
      }
      case 'activate':
        // A detached control's click reaches its old handlers only: never a write on the page.
        if (!element.isConnected) return { ok: true, connected: false };
        element.click();
        return { ok: true, connected: true };
      case 'armClick':
        return { ok: true, armed: clickReach(element, true) === true };
      case 'clickReached':
        return { ok: true, reached: clickReach(element, false), connected: element.isConnected };
      case 'focused': {
        const active = deepActive();
        return { ok: true, focused: active === element || element.contains(active) };
      }
      case 'fillCheck':
        return fillCheck(element, request.expected);
      case 'mainHit': {
        // The owner element of a frame: the point a frame's realm measured, moved
        // into the main viewport, must be on screen and reach the frame, not an
        // element of the page drawn over it. An owner inside a same-origin frame
        // is checked through the frame elements above it, in the top document.
        let owner = element;
        for (let depth = 0; owner && viewOf(owner) !== window.top && depth < 32; depth += 1) {
          let up = null;
          try { up = viewOf(owner).frameElement; } catch (error) { up = null; }
          owner = up;
        }
        // A frame of another origin sits between the owner and the top document
        // (another origin on the same site, or a sandboxed frame): its realm cannot
        // reach the top, so the caller hit-tests the main viewport through CDP.
        if (!owner || viewOf(owner) !== window.top) return { reason: 'unreachable' };
        const top = viewOf(owner);
        const x = Number(request.x);
        const y = Number(request.y);
        if (!(x >= 0 && y >= 0 && x < top.innerWidth && y < top.innerHeight)) return { reason: 'outside_viewport' };
        let hit = top.document.elementFromPoint(x, y);
        for (let depth = 0; hit && hit.shadowRoot && depth < 32; depth += 1) {
          const inner = hit.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === hit) break;
          hit = inner;
        }
        if (hit && composedContains(owner, hit)) return { ok: true };
        return { reason: 'covered', coveredBy: hit ? brief(hit) : undefined };
      }
      case 'select': {
        const state = await probe(element, { enabled: true });
        if (!state.ok) return state;
        element.focus();
        return { ok: true, mutation: selectMutation.call(element, request.values) };
      }
      default:
        return { error: 'invalid', message: 'Unknown page request ' + String(request.kind) };
    }
  };
  const answer = (value) => ({ ...value, readyState: document.readyState });
  // For a page script in the same evaluation: the elements themselves, not data.
  if (request.kind === 'elements') return resolveChain(request.chain);
  if (request.kind === 'pick') return pick(resolveChain(request.chain));
  // A handle request (returnByValue: false): the single element itself, or null.
  if (request.kind === 'handle') return pick(resolveChain(request.chain)).element || null;
  if (request.kind === 'near') return answer({ ok: true, candidates: nearCandidates(request.chain) });
  return run().then(answer, (error) => answer({ error: 'invalid', message: String((error && error.message) || error) }));
}`;

export type ProgramPageRequest = Readonly<Record<string, unknown>> & { readonly kind: string };

export interface ProgramPageResponse {
  readonly ok?: boolean;
  readonly error?: 'not_found' | 'ambiguous' | 'invalid';
  readonly reason?: string;
  readonly coveredBy?: string;
  readonly message?: string;
  readonly readyState?: string;
  readonly [key: string]: unknown;
}

/** The evaluate expression of one request. */
export function programPageExpression(
  request: ProgramPageRequest,
  selectMutationSource?: string,
): string {
  return `(${PROGRAM_PAGE_SOURCE}).call(null, ${JSON.stringify(request)}, ${selectMutationSource ?? 'undefined'})`;
}
