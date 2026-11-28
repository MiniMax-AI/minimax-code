/**
 * Page-side source of `(element) => boolean`: whether the element is a field
 * fill/type/paste write text into, i.e. a textarea, an input of a text-like
 * type, a contenteditable element, or an ARIA textbox/searchbox. The write
 * path's read-back (cdp-helper), the unfocused-input diagnosis and the ref
 * rebind splice it into their page functions, so they agree on which element
 * is a field.
 */
export const EDITABLE_FIELD_SOURCE = String.raw`(element) => {
  if (!element || element.nodeType !== 1) return false;
  const tag = String(element.localName || '').toLowerCase();
  if (tag === 'textarea') return true;
  if (
    tag === 'input' &&
    !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']
      .includes(String(element.type || '').toLowerCase())
  ) {
    return true;
  }
  if (element.isContentEditable === true) return true;
  const role = String((element.getAttribute && element.getAttribute('role')) || '').toLowerCase();
  return role === 'textbox' || role === 'searchbox';
}`;
