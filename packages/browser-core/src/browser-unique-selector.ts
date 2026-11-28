/**
 * Page-side selector builder shared by the selector-miss candidates and the
 * program page script. It takes the longest selector it may return and yields
 * helpers bound to that limit:
 *
 * - `unique(element)`: a selector verified to match this element alone in its
 *   own document or shadow root: the simple forms first, then the shortest
 *   position path below the nearest ancestor that has a simple form.
 * - `simple(element)`: the simple forms only.
 * - `isUnique(selector, element)` and `quoted(value)` for callers building
 *   their own selectors.
 *
 * Only string and array primitives: pages replace Array.from (see page-script).
 */
export const UNIQUE_SELECTOR_SOURCE = String.raw`(limit) => {
  const MAX_PATH_DEPTH = 8;
  const MAX_CLASSES = 6;
  const IDENT = /^-?[A-Za-z_][\w-]*$/;
  const ATTRIBUTES = ['name', 'data-testid', 'data-test', 'data-qa', 'data-cy', 'data-role', 'data-ui-id', 'aria-label', 'title', 'placeholder', 'for'];
  const quoted = (value) => '"' + value.replace(/["\\]/g, '\\$&') + '"';
  const isUnique = (selector, element) => {
    try {
      const matches = element.getRootNode().querySelectorAll(selector);
      return matches.length === 1 && matches[0] === element;
    } catch {
      return false;
    }
  };
  const simple = (element) => {
    const tag = element.localName;
    const options = [];
    const id = element.getAttribute('id');
    if (id && IDENT.test(id)) options.push('#' + id);
    for (const name of ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value && !/[\r\n]/.test(value)) options.push(tag + '[' + name + '=' + quoted(value) + ']');
    }
    const classes = (element.getAttribute('class') || '')
      .split(/\s+/)
      .filter((name) => IDENT.test(name))
      .slice(0, MAX_CLASSES);
    for (const name of classes) options.push(tag + '.' + name);
    if (classes.length > 1) options.push(tag + '.' + classes.slice(0, 2).join('.'));
    const href = tag === 'a' ? element.getAttribute('href') : null;
    if (href && !/[\r\n]/.test(href)) options.push('a[href=' + quoted(href) + ']');
    options.push(tag);
    return options.find((option) => option.length <= limit && isUnique(option, element));
  };
  const unique = (element) => {
    const found = simple(element);
    if (found) return found;
    const path = [];
    let at = element;
    for (let depth = 0; depth < MAX_PATH_DEPTH && at.parentElement; depth += 1) {
      const peers = [];
      for (const peer of at.parentElement.children) if (peer.localName === at.localName) peers.push(peer);
      path.unshift(at.localName + ':nth-of-type(' + (peers.indexOf(at) + 1) + ')');
      at = at.parentElement;
      const anchor = simple(at);
      if (!anchor) continue;
      for (let kept = 1; kept <= path.length; kept += 1) {
        const tail = path.slice(path.length - kept).join(' > ');
        const selector = anchor + (kept === path.length ? ' > ' : ' ') + tail;
        if (selector.length <= limit && isUnique(selector, element)) return selector;
      }
    }
    return undefined;
  };
  return { unique, simple, isUnique, quoted };
}`;
