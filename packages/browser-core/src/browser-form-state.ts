import type { BrowserFormState } from './browser-core-contracts.js';
import type { DOMSnapshotResult } from './cdp-helper-contracts.js';

/**
 * Live form-control state for `beta.browserReadV2`: DOM reads serialize
 * attributes and inspect records carried no current value, so a model could
 * not see which option a framework (Knockout) had selected.
 *
 * Credential fields never yield a live value: `type=password` and the
 * autocomplete tokens the host's authentication redaction treats as secrets.
 */
export const SECRET_AUTOCOMPLETE_PATTERN =
  /(?:^|\s)(?:current-password|new-password|one-time-code)(?:\s|$)/u;

const MAX_FORM_VALUE_LENGTH = 300;

type SnapshotNodes = DOMSnapshotResult['documents'][number]['nodes'];

/**
 * Raw per-node control state from one DOMSnapshot document, keyed by node
 * index. Inputs carry `value` and `checked`; textareas `value`; selects the
 * first selected option. Exposure rules are applied by `exposedFormState`.
 */
export function readSnapshotFormStates(
  nodes: SnapshotNodes,
  strings: readonly string[],
): Map<number, BrowserFormState> {
  const states = new Map<number, BrowserFormState>();
  const text = (index: number | undefined): string =>
    index !== undefined && index >= 0 ? (strings[index] ?? '') : '';
  const nodeName = (index: number): string => text(nodes.nodeName?.[index]).toUpperCase();

  const checked = new Set(nodes.inputChecked?.index ?? []);
  const inputValue = nodes.inputValue;
  inputValue?.index.forEach((nodeIndex, position) => {
    states.set(nodeIndex, {
      value: text(inputValue.value[position]),
      checked: checked.has(nodeIndex),
    });
  });
  const textValue = nodes.textValue;
  textValue?.index.forEach((nodeIndex, position) => {
    if (nodeName(nodeIndex) === 'TEXTAREA') {
      states.set(nodeIndex, { value: text(textValue.value[position]) });
    }
  });

  const selectedOptions = nodes.optionSelected?.index ?? [];
  if (selectedOptions.length === 0) return states;
  const parents = nodes.parentIndex ?? [];
  const optionText = new Map<number, string>(selectedOptions.map((index) => [index, '']));
  parents.forEach((parent, index) => {
    if (nodes.nodeType?.[index] !== 3 || !optionText.has(parent)) return;
    optionText.set(parent, `${optionText.get(parent)}${text(nodes.nodeValue?.[index])}`);
  });
  const attribute = (index: number, name: string): string | undefined => {
    const flat = nodes.attributes?.[index] ?? [];
    for (let position = 0; position + 1 < flat.length; position += 2) {
      if (text(flat[position]).toLowerCase() === name) return text(flat[position + 1]);
    }
    return undefined;
  };
  for (const option of selectedOptions) {
    let owner = parents[option];
    if (owner !== undefined && nodeName(owner) === 'OPTGROUP') owner = parents[owner];
    if (owner === undefined || nodeName(owner) !== 'SELECT') continue;
    const existing = states.get(owner);
    if (existing) {
      existing.selectedCount = (existing.selectedCount ?? 1) + 1;
      continue;
    }
    // HTMLOptionElement.text strips and collapses ASCII whitespace; value and
    // label fall back to it when their attributes are absent.
    const label = (optionText.get(option) ?? '').replace(/[\t\n\f\r ]+/gu, ' ').trim();
    states.set(owner, {
      value: attribute(option, 'value') ?? label,
      selectedText: attribute(option, 'label') || label,
    });
  }
  return states;
}

/**
 * Name, id or autocomplete fragments that mark a credential whose type is not
 * (or no longer) password, e.g. after a "show password" toggle made it text.
 */
const PASSWORD_HINT_PATTERN = /pass(?:word|wd|code|phrase)|pwd/iu;

/** Input types that hold no typed value, so the credential rule never applies. */
const NON_TEXT_INPUT_TYPES = ['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image'];

/** What a credential field shows instead of its value in a live read. */
export const REDACTED_VALUE = '[REDACTED]';

export interface CredentialControl {
  readonly tag: string;
  readonly type?: string | null;
  readonly name?: string | null;
  readonly id?: string | null;
  readonly autocomplete?: string | null;
  /** Seen as type=password by an earlier read; a later type change keeps it secret. */
  readonly observedAsPassword?: boolean;
}

/**
 * The credential rule of live form state (`beta.browserReadV2`): an input or
 * textarea that is or was type=password, carries a secret autocomplete token,
 * or names itself a password (name/id/autocomplete) never exposes a value in
 * inspect records or DOM reads. `SYNC_LIVE_FORM_STATE_SOURCE` applies the same
 * rule page-side.
 */
export function isCredentialControl(control: CredentialControl): boolean {
  const tag = control.tag.toLowerCase();
  const type = (control.type ?? '').trim().toLowerCase();
  if (tag !== 'textarea' && (tag !== 'input' || NON_TEXT_INPUT_TYPES.includes(type))) return false;
  if (control.observedAsPassword === true || type === 'password') return true;
  const autocomplete = (control.autocomplete ?? '').toLowerCase();
  return (
    SECRET_AUTOCOMPLETE_PATTERN.test(autocomplete) ||
    [control.name, control.id, autocomplete].some((value) =>
      PASSWORD_HINT_PATTERN.test(value ?? ''),
    )
  );
}

/** The model-facing subset of a control's raw state, bounded and credential-safe. */
export function exposedFormState(
  tag: string,
  type: string | null | undefined,
  credential: boolean,
  raw: BrowserFormState | undefined,
): BrowserFormState | undefined {
  if (!raw) return undefined;
  const normalizedTag = tag.toLowerCase();
  const inputType = (type ?? '').trim().toLowerCase();
  let extra: BrowserFormState = {};
  if (normalizedTag === 'select') {
    if (raw.selectedText === undefined) return undefined;
    extra = {
      selectedText: raw.selectedText.slice(0, MAX_FORM_VALUE_LENGTH),
      ...(raw.selectedCount !== undefined ? { selectedCount: raw.selectedCount } : {}),
    };
  } else if (normalizedTag === 'input' || normalizedTag === 'textarea') {
    if (credential || raw.value === undefined) return undefined;
    if (normalizedTag === 'input' && (inputType === 'checkbox' || inputType === 'radio')) {
      return { checked: raw.checked === true };
    }
    if (normalizedTag === 'input' && inputType === 'file') return undefined;
  } else {
    return undefined;
  }
  const value = raw.value ?? '';
  return {
    value: value.slice(0, MAX_FORM_VALUE_LENGTH),
    ...(value.length > MAX_FORM_VALUE_LENGTH ? { valueTruncated: true as const } : {}),
    ...extra,
  };
}

/**
 * Page-side `isCredentialControl`: `(element) => boolean` for an input or
 * textarea. A field seen as type=password is kept in a page-global WeakSet, so
 * a later "show password" type change keeps it secret for every live read
 * (DOM serialization and `query kind: "rows"`) on the page.
 */
export const PAGE_CREDENTIAL_CONTROL_SOURCE = `(element) => {
    const tag = element.localName;
    const liveType = String(element.type || '').toLowerCase();
    if (tag !== 'textarea' && (tag !== 'input' || ${JSON.stringify(NON_TEXT_INPUT_TYPES)}.includes(liveType))) return false;
    const markKey = Symbol.for('mavis.browser.passwordFields');
    if (!window[markKey]) Object.defineProperty(window, markKey, { value: new WeakSet() });
    const observed = window[markKey];
    const type = String(element.getAttribute('type') || '').trim().toLowerCase();
    if (liveType === 'password' || type === 'password') observed.add(element);
    if (observed.has(element)) return true;
    const autocomplete = String(element.getAttribute('autocomplete') || '').toLowerCase();
    return ${SECRET_AUTOCOMPLETE_PATTERN}.test(autocomplete) ||
      [element.getAttribute('name'), element.id, autocomplete].some((value) => ${PASSWORD_HINT_PATTERN}.test(String(value || '')));
  }`;

/**
 * Page-side step of the DOM sanitizer: copies live state onto the clone before
 * any node is removed, so live and cloned control lists still align. Only
 * values that differ from the serialized default are written, and a single
 * select also states its current value on its own opening tag, which stays
 * visible even when the option list is truncated. Credential fields (the
 * `isCredentialControl` rule) show `[REDACTED]` instead of any value; a field
 * once seen as type=password stays marked in a page-global WeakSet.
 */
export const SYNC_LIVE_FORM_STATE_SOURCE = `(source, clone) => {
    const controls = 'input, textarea, select, option';
    const collect = (root) => [
      ...(root.matches(controls) ? [root] : []),
      ...root.querySelectorAll(controls),
    ];
    const live = collect(source);
    const copies = collect(clone);
    if (live.length !== copies.length) return;
    const credential = ${PAGE_CREDENTIAL_CONTROL_SOURCE};
    const toggle = (copy, name, on) => (on ? copy.setAttribute(name, '') : copy.removeAttribute(name));
    live.forEach((element, index) => {
      const copy = copies[index];
      const tag = element.localName;
      if (tag === 'option') {
        if (element.selected !== element.hasAttribute('selected')) toggle(copy, 'selected', element.selected);
        return;
      }
      if (tag === 'select') {
        if (!element.multiple && element.selectedIndex >= 0) copy.setAttribute('value', element.value);
        return;
      }
      if (tag === 'textarea') {
        if (credential(element)) {
          if (copy.textContent) copy.textContent = ${JSON.stringify(REDACTED_VALUE)};
        } else if (element.value !== element.defaultValue) copy.textContent = element.value;
        return;
      }
      const type = String(element.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (element.checked !== element.hasAttribute('checked')) toggle(copy, 'checked', element.checked);
        return;
      }
      if (type === 'file') return;
      if (credential(element)) {
        if (copy.getAttribute('value')) copy.setAttribute('value', ${JSON.stringify(REDACTED_VALUE)});
        return;
      }
      if (element.value !== (element.getAttribute('value') ?? '')) copy.setAttribute('value', element.value);
    });
  }`;
