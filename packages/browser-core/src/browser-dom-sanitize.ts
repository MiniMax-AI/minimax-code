import { OMIT_DATA_URLS_SOURCE } from './browser-data-url.js';
import { SYNC_LIVE_FORM_STATE_SOURCE } from './browser-form-state.js';

/**
 * Page-side sanitizer shared by `query kind: "dom"` and the Browser program's
 * HTML reads: `(source, inner?, prepare?) => string`. Returns the cleaned
 * outerHTML (the innerHTML when `inner` is true), or '' when the element itself
 * is a blocked tag. `prepare(source, clone)` runs before any node is removed,
 * while the live and cloned elements still align. With `readV2` (`beta.browserReadV2`; always on for programs) the clone
 * first takes the controls' live value/checked/selected state, credential
 * fields read `[REDACTED]`, `selected` survives attribute filtering and long
 * data: URLs become placeholders; without it the source is exactly the
 * attribute-only sanitizer. The element's own attributes are filtered like
 * its descendants' (an `onclick` on the queried element is dropped too);
 * `autocomplete` stays, since the host's authentication redaction recognizes
 * one-time-code and password fields by it.
 */
export function sanitizeDomElementSource(readV2: boolean): string {
  return `(source, inner, prepare) => {
    const blocked = 'script, noscript, style, link, template, iframe, object, embed, svg defs, svg symbol';
    if (source.matches('[data-mavis-agent-cursor-host], ' + blocked)) return '';
    const clone = source.cloneNode(true);${
      readV2 ? `\n    (${SYNC_LIVE_FORM_STATE_SOURCE})(source, clone);` : ''
    }
    if (prepare) prepare(source, clone);
    clone.querySelectorAll('[data-mavis-agent-cursor-host]').forEach((element) => element.remove());
    clone.querySelectorAll(blocked).forEach((element) => element.remove());

    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((comment) => comment.remove());

    clone.querySelectorAll('[hidden], [aria-hidden="true"], [style*="display: none"], [style*="display:none"], [style*="visibility: hidden"], [style*="visibility:hidden"]').forEach((element) => element.remove());

    const keepAttrs = new Set([
      'href', 'src', 'alt', 'title', 'type', 'name', 'id', 'class', 'for',
      'placeholder', 'value', 'checked', 'disabled', 'readonly', 'required',
      'min', 'max', 'pattern', 'maxlength', 'minlength', 'role',
      'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-expanded',
      'aria-selected', 'aria-checked', 'aria-disabled', 'aria-haspopup',
      'aria-controls', 'aria-hidden', 'data-testid', 'data-id', 'data-value',
      'data-name', 'colspan', 'rowspan', 'scope', 'target', 'rel', 'download',
      'action', 'method', 'enctype', 'tabindex', 'contenteditable', 'lang', 'dir',
      'autocomplete'${readV2 ? ", 'selected'" : ''}
    ]);
    [clone, ...clone.querySelectorAll('*')].forEach((element) => {
      Array.from(element.attributes).forEach((attribute) => {
        const name = attribute.name;
        if (!keepAttrs.has(name) && !name.startsWith('aria-') && !name.startsWith('data-')) {
          element.removeAttribute(name);
        }
      });
    });
    const html = (inner ? clone.innerHTML : clone.outerHTML) || '';
    return ${readV2 ? `(${OMIT_DATA_URLS_SOURCE})(html)` : 'html'};
  }`;
}
