export interface BrowserKeyDescriptor {
  key: string;
  code: string;
  windowsVirtualKeyCode?: number;
  text?: string;
}

export interface BrowserPrintableKeyDescriptor {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
}

const SHIFT_MODIFIER = 8;

const PRINTABLE_SYMBOL_KEYS: Readonly<Record<string, Omit<BrowserPrintableKeyDescriptor, 'key'>>> =
  {
    ' ': { code: 'Space', windowsVirtualKeyCode: 32, modifiers: 0 },
    '!': { code: 'Digit1', windowsVirtualKeyCode: 49, modifiers: SHIFT_MODIFIER },
    '"': { code: 'Quote', windowsVirtualKeyCode: 222, modifiers: SHIFT_MODIFIER },
    '#': { code: 'Digit3', windowsVirtualKeyCode: 51, modifiers: SHIFT_MODIFIER },
    $: { code: 'Digit4', windowsVirtualKeyCode: 52, modifiers: SHIFT_MODIFIER },
    '%': { code: 'Digit5', windowsVirtualKeyCode: 53, modifiers: SHIFT_MODIFIER },
    '&': { code: 'Digit7', windowsVirtualKeyCode: 55, modifiers: SHIFT_MODIFIER },
    "'": { code: 'Quote', windowsVirtualKeyCode: 222, modifiers: 0 },
    '(': { code: 'Digit9', windowsVirtualKeyCode: 57, modifiers: SHIFT_MODIFIER },
    ')': { code: 'Digit0', windowsVirtualKeyCode: 48, modifiers: SHIFT_MODIFIER },
    '*': { code: 'Digit8', windowsVirtualKeyCode: 56, modifiers: SHIFT_MODIFIER },
    '+': { code: 'Equal', windowsVirtualKeyCode: 187, modifiers: SHIFT_MODIFIER },
    ',': { code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 0 },
    '-': { code: 'Minus', windowsVirtualKeyCode: 189, modifiers: 0 },
    '.': { code: 'Period', windowsVirtualKeyCode: 190, modifiers: 0 },
    '/': { code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 0 },
    ':': { code: 'Semicolon', windowsVirtualKeyCode: 186, modifiers: SHIFT_MODIFIER },
    ';': { code: 'Semicolon', windowsVirtualKeyCode: 186, modifiers: 0 },
    '<': { code: 'Comma', windowsVirtualKeyCode: 188, modifiers: SHIFT_MODIFIER },
    '=': { code: 'Equal', windowsVirtualKeyCode: 187, modifiers: 0 },
    '>': { code: 'Period', windowsVirtualKeyCode: 190, modifiers: SHIFT_MODIFIER },
    '?': { code: 'Slash', windowsVirtualKeyCode: 191, modifiers: SHIFT_MODIFIER },
    '@': { code: 'Digit2', windowsVirtualKeyCode: 50, modifiers: SHIFT_MODIFIER },
    '[': { code: 'BracketLeft', windowsVirtualKeyCode: 219, modifiers: 0 },
    '\\': { code: 'Backslash', windowsVirtualKeyCode: 220, modifiers: 0 },
    ']': { code: 'BracketRight', windowsVirtualKeyCode: 221, modifiers: 0 },
    '^': { code: 'Digit6', windowsVirtualKeyCode: 54, modifiers: SHIFT_MODIFIER },
    _: { code: 'Minus', windowsVirtualKeyCode: 189, modifiers: SHIFT_MODIFIER },
    '`': { code: 'Backquote', windowsVirtualKeyCode: 192, modifiers: 0 },
    '{': { code: 'BracketLeft', windowsVirtualKeyCode: 219, modifiers: SHIFT_MODIFIER },
    '|': { code: 'Backslash', windowsVirtualKeyCode: 220, modifiers: SHIFT_MODIFIER },
    '}': { code: 'BracketRight', windowsVirtualKeyCode: 221, modifiers: SHIFT_MODIFIER },
    '~': { code: 'Backquote', windowsVirtualKeyCode: 192, modifiers: SHIFT_MODIFIER },
  };

const UNSHIFTED_KEY_BY_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PRINTABLE_SYMBOL_KEYS)
    .filter(([, descriptor]) => descriptor.modifiers === 0)
    .map(([char, descriptor]) => [descriptor.code, char]),
);

const SHIFTED_KEY_BY_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PRINTABLE_SYMBOL_KEYS)
    .filter(([, descriptor]) => descriptor.modifiers === SHIFT_MODIFIER)
    .map(([char, descriptor]) => [descriptor.code, char]),
);

/**
 * Physical US-layout key for a `KeyboardEvent.code` such as `KeyW`, `Digit1`
 * or `Minus`, with its unshifted character. Null for codes that are not
 * printable keys (use browserKeyDescriptor for named keys).
 */
export function browserPhysicalKeyDescriptor(code: string): BrowserKeyDescriptor | null {
  const letter = /^Key([A-Z])$/u.exec(code)?.[1];
  if (letter) return browserKeyDescriptor(letter.toLowerCase());
  const digit = /^Digit([0-9])$/u.exec(code)?.[1];
  if (digit) return browserKeyDescriptor(digit);
  const char = UNSHIFTED_KEY_BY_CODE[code];
  if (char === undefined) return null;
  const printable = browserPrintableKeyDescriptor(char);
  return printable
    ? { key: char, code, windowsVirtualKeyCode: printable.windowsVirtualKeyCode, text: char }
    : null;
}

/** Character the physical key `code` produces with Shift held (US layout). */
export function browserShiftedKey(code: string): string | undefined {
  const letter = /^Key([A-Z])$/u.exec(code)?.[1];
  return letter ?? SHIFTED_KEY_BY_CODE[code];
}

const NAMED_KEYS: Readonly<Record<string, BrowserKeyDescriptor>> = {
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  end: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  insert: { key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45 },
  pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  return: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
};

export function browserKeyDescriptor(key: string): BrowserKeyDescriptor {
  const named = NAMED_KEYS[key.toLowerCase()];
  if (named) return named;
  if (/^[a-z]$/iu.test(key)) {
    const upper = key.toUpperCase();
    return { key, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), text: key };
  }
  if (/^[0-9]$/u.test(key)) {
    return { key, code: `Digit${key}`, windowsVirtualKeyCode: key.charCodeAt(0), text: key };
  }
  if (key.length === 1) {
    return { key, code: key, windowsVirtualKeyCode: key.charCodeAt(0), text: key };
  }
  return { key, code: key };
}

/**
 * Resolve text that can be represented by a physical keyboard event sequence.
 * Unicode and IME text deliberately return null so callers use Input.insertText.
 */
export function browserPrintableKeyDescriptor(char: string): BrowserPrintableKeyDescriptor | null {
  if (/^[A-Za-z]$/u.test(char)) {
    const upper = char.toUpperCase();
    return {
      key: char,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      modifiers: char === upper ? SHIFT_MODIFIER : 0,
    };
  }
  if (/^[0-9]$/u.test(char)) {
    return {
      key: char,
      code: `Digit${char}`,
      windowsVirtualKeyCode: char.charCodeAt(0),
      modifiers: 0,
    };
  }
  const symbol = PRINTABLE_SYMBOL_KEYS[char];
  return symbol ? { key: char, ...symbol } : null;
}
