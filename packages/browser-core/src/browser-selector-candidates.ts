import {
  byteLength,
  cdp,
  isRecord,
  resolveBrowserSnapshotElement,
  stringArray,
  type BrowserSessionState as SessionState,
} from './browser-state.js';
import { UNIQUE_SELECTOR_SOURCE } from './browser-unique-selector.js';
import { isBrowserOperationInterruption } from './operation-timeout.js';

/**
 * Elements of the current page closest to a selector that matched nothing.
 * Everything here comes from the page and from the selector's own words; the
 * ranking holds no knowledge of any site.
 */
export interface SelectorCandidate {
  /** Present only when the element is in the live inspect snapshot. */
  ref?: string;
  tag: string;
  role?: string;
  /** Accessible label or visible text. Form field values are never read. */
  text?: string;
  /**
   * A selector verified to match this element alone; with `count`, the
   * selector of the whole repeated structure.
   */
  selector?: string;
  /** Set on a repeated structure: how many elements `selector` matches. */
  count?: number;
  /** The selector words this element shares. */
  matched: string[];
  /** Set when the element has no layout box or is visibility: hidden. */
  hidden?: true;
}

export const MAX_SELECTOR_CANDIDATES = 5;
/** Budget of the serialized `candidates` array. */
export const MAX_SELECTOR_CANDIDATES_BYTES = 2_048;
const MAX_TAG_CHARS = 24;
const MAX_TEXT_CHARS = 60;
const MAX_SELECTOR_CHARS = 120;
const MAX_MATCHED_WORDS = 6;
const MAX_MATCHED_WORD_CHARS = 24;
/** Fewer alike elements than this are listed one by one. */
const MIN_REPEATED_ELEMENTS = 3;

export interface SelectorAttributeTerm {
  readonly name: string;
  readonly value?: string;
}

export interface SelectorCompoundTerms {
  readonly tag?: string;
  readonly ids: readonly string[];
  readonly classes: readonly string[];
  readonly attributes: readonly SelectorAttributeTerm[];
}

const MAX_PARSED_SELECTOR_CHARS = 2_000;
const MAX_PARSED_BRANCHES = 16;
const MAX_PARSED_COMPOUNDS = 6;
const MAX_PARSED_TERMS = 8;

/** Splits on top-level commas and combinators; brackets, parens and quotes stay whole. */
function selectorBranches(selector: string): string[][] {
  const branches: string[][] = [];
  let compounds: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  const endCompound = (end: number) => {
    const compound = selector.slice(start, end).trim();
    if (compound) compounds.push(compound);
    start = end + 1;
  };
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index] ?? '';
    if (char === '\\') index += 1;
    else if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '(') depth += 1;
    else if (char === ']' || char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && char === ',') {
      endCompound(index);
      branches.push(compounds);
      compounds = [];
    } else if (depth === 0 && /[\s>+~]/u.test(char)) endCompound(index);
  }
  endCompound(selector.length);
  branches.push(compounds);
  return branches.filter((branch) => branch.length > 0);
}

const ATTRIBUTE_TERM =
  /^\s*([\w:-]+)\s*(?:[~|^$*]?=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s\]]+))(?:\s+[is])?)?\s*$/iu;

function parseCompound(source: string): SelectorCompoundTerms | undefined {
  const ids: string[] = [];
  const classes: string[] = [];
  const attributes: SelectorAttributeTerm[] = [];
  let tag: string | undefined;
  let index = 0;
  const readName = () => {
    let name = '';
    while (index < source.length) {
      const char = source[index] ?? '';
      if (char === '\\') {
        name += source[index + 1] ?? '';
        index += 2;
      } else if (/[\w-]/u.test(char) || char > '\u007f') {
        name += char;
        index += 1;
      } else break;
    }
    return name;
  };
  /** Moves past the balanced group opening at `index`. */
  const skipGroup = (open: string, close: string) => {
    let depth = 0;
    let quote: string | undefined;
    const from = index;
    for (; index < source.length; index += 1) {
      const char = source[index] ?? '';
      if (char === '\\') index += 1;
      else if (quote) {
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }
    return source.slice(from + 1, Math.max(from + 1, index - 1));
  };
  while (index < source.length) {
    const char = source[index] ?? '';
    if (char === '.' || char === '#') {
      index += 1;
      const name = readName();
      if (name) (char === '.' ? classes : ids).push(name);
    } else if (char === '[') {
      const match = ATTRIBUTE_TERM.exec(skipGroup('[', ']'));
      const name = match?.[1]?.toLowerCase();
      const value = match?.[2] ?? match?.[3] ?? match?.[4];
      if (name) attributes.push({ name, ...(value === undefined ? {} : { value }) });
    } else if (char === ':') {
      // Pseudo-classes describe state and position, not words on the element.
      index += source[index + 1] === ':' ? 2 : 1;
      readName();
      if (source[index] === '(') skipGroup('(', ')');
    } else if (index === 0 && char !== '*') {
      const name = readName();
      if (name) tag = name.toLowerCase();
      else index += 1;
    } else index += 1;
  }
  if (!tag && ids.length + classes.length + attributes.length === 0) return undefined;
  return {
    ...(tag ? { tag } : {}),
    ids: ids.slice(0, MAX_PARSED_TERMS),
    classes: classes.slice(0, MAX_PARSED_TERMS),
    attributes: attributes.slice(0, MAX_PARSED_TERMS),
  };
}

/**
 * The selector list as data for the page-side ranking: one entry per
 * top-level list item, each holding its compounds left to right, so the last
 * compound is the element the selector asked for.
 */
export function parseSelectorTerms(selector: string): SelectorCompoundTerms[][] {
  return selectorBranches(selector.slice(0, MAX_PARSED_SELECTOR_CHARS))
    .slice(0, MAX_PARSED_BRANCHES)
    .map((branch) =>
      branch
        .slice(-MAX_PARSED_COMPOUNDS)
        .map(parseCompound)
        .filter((compound) => compound !== undefined),
    )
    .filter((branch) => branch.length > 0);
}

/**
 * Page-side ranking over at most 5000 elements in document order.
 *
 * An element scores on each list item through its own class, id and attribute
 * words and its short visible text. A word counts by how rare it is on this
 * page, so a word most of the page shares does not decide anything. An
 * ancestor compound counts at 30% and may be met by the element or by anything
 * above it, so the last compound decides. A list item scores on its own: the
 * element keeps its best one. A compound's tag or the role of that tag adds to
 * a word hit. Bare tag hits and attribute-name hits rank but do not qualify an
 * element, or every `div` on the page would be "close" to `div.product-info`;
 * a selector that is only a tag is the exception unless that tag is div or
 * span.
 *
 * Elements of one repeated structure (siblings of a tag, or the same shape
 * across parents) collapse into one candidate carrying the selector of the
 * whole structure and its `count`, unless a member stands out by score. Five
 * rows of a table were the usual shortlist for a guessed list selector and
 * none of them named the list.
 */
const SELECTOR_CANDIDATES_SOURCE = String.raw`(branches) => {
  const MAX_SCANNED = 5000;
  const RANKED = 40;
  const LIMIT = ${MAX_SELECTOR_CANDIDATES};
  const TEXT_CHARS = ${MAX_TEXT_CHARS};
  const SELECTOR_CHARS = ${MAX_SELECTOR_CHARS};
  const ANCESTOR_WEIGHT = 0.3;
  const HIDDEN_WEIGHT = 0.6;
  const KEPT_SHARE_OF_TOP = 0.3;
  const WORD = 2;
  const TEXT_WORD = 1.5;
  const EXACT = 4;
  const SAME_TAG = 3;
  const SAME_ROLE = 2;
  const MIN_SCORE = 1;
  const MIN_RARITY = 0.25;
  const MIN_PAGE_ELEMENTS = 100;
  const MIN_REPEATED = ${MIN_REPEATED_ELEMENTS};
  const STANDS_OUT = 1;
  const EXTRA_MATCHES = 0.2;
  const SCANNED_TEXT_CHARS = 80;
  const SCANNED_TEXT_CHILDREN = 3;
  const SKIPPED = /^(?:script|style|noscript|template|svg)$/;
  const STRUCTURAL = /^(?:div|span)$/;
  const FIELD = /^(?:input|select|textarea)$/;
  const NAMED_BY_CONTENT = /^(?:a|button|label|summary|th|legend|h[1-6])$/;
  const BAG_ATTRIBUTES = ['name', 'role', 'aria-label', 'title', 'placeholder', 'alt', 'data-role', 'data-testid'];
  const SHARED_ATTRIBUTES = ['role', 'data-role', 'name', 'type', 'data-testid'];
  const TAG_ROLES = {
    a: /^link$/,
    button: /^button$/,
    li: /^(?:listitem|option|menuitem|treeitem)$/,
    ul: /^(?:list|listbox|menu|tree)$/,
    ol: /^(?:list|listbox|menu|tree)$/,
    tr: /^row$/,
    td: /^(?:cell|gridcell)$/,
    table: /^(?:table|grid|treegrid)$/,
    select: /^(?:listbox|combobox)$/,
    input: /^(?:textbox|searchbox|combobox|checkbox|radio)$/,
  };
  const selectors = (${UNIQUE_SELECTOR_SOURCE})(SELECTOR_CHARS);
  const wordCache = new Map();
  const wordsOf = (value) => {
    let words = wordCache.get(value);
    if (words) return words;
    words = [];
    const spaced = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    for (const word of spaced.split(/[^\p{L}\p{N}]+/u)) {
      if (word.length < 3 || /^\d+$/.test(word)) continue;
      words.push(word.length > 3 && /[^s]s$/.test(word) ? word.slice(0, -1) : word);
    }
    wordCache.set(value, words);
    return words;
  };
  const compiled = [];
  const lists = branches.map((branch) =>
    branch.map((compound) => {
      compiled.push({
        tag: compound.tag || '',
        tagWord: (compound.tag && wordsOf(compound.tag)[0]) || '',
        tagOnly: !compound.ids.length && !compound.classes.length && !compound.attributes.length,
        names: [...compound.ids, ...compound.classes].map((value) => ({ value, words: wordsOf(value) })),
        attributes: compound.attributes.map((attribute) => ({
          name: attribute.name,
          value: attribute.value === undefined ? null : attribute.value.toLowerCase(),
          words: attribute.value === undefined ? [] : wordsOf(attribute.value),
        })),
      });
      return compiled.length - 1;
    }),
  );
  const asked = new Set();
  for (const compound of compiled) {
    if (compound.tagWord) asked.add(compound.tagWord);
    for (const name of compound.names) for (const word of name.words) asked.add(word);
    for (const attribute of compound.attributes) for (const word of attribute.words) asked.add(word);
  }
  // The element that says the words, not every wrapper around it.
  const visibleWords = (element) => {
    if (FIELD.test(element.localName) || element.childElementCount > SCANNED_TEXT_CHILDREN) return null;
    let speaks = NAMED_BY_CONTENT.test(element.localName);
    for (const node of element.childNodes) {
      speaks = speaks || (node.nodeType === 3 && /\S/.test(node.nodeValue));
    }
    const text = speaks ? element.textContent || '' : '';
    return text.length > 0 && text.length <= SCANNED_TEXT_CHARS ? new Set(wordsOf(text)) : null;
  };
  const factsOf = (element) => {
    const classAttribute = element.getAttribute('class') || '';
    const id = element.getAttribute('id') || '';
    const classes = classAttribute.split(/\s+/).filter(Boolean);
    const bag = new Set();
    for (const value of [...classes, id]) for (const word of wordsOf(value)) bag.add(word);
    for (const name of BAG_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value) for (const word of wordsOf(value)) bag.add(word);
    }
    return { classes, id, bag, text: visibleWords(element), joined: (classAttribute + ' ' + id).toLowerCase() };
  };
  const hasWord = (facts, word) =>
    facts.bag.has(word) || (word.length >= 5 && facts.joined.includes(word));
  const root = document.body || document.documentElement;
  const scanned = [root];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) =>
      SKIPPED.test(node.localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  while (scanned.length < MAX_SCANNED && walker.nextNode()) scanned.push(walker.currentNode);
  const factsByElement = new Map();
  const seenOn = new Map();
  for (const element of scanned) {
    const facts = factsOf(element);
    factsByElement.set(element, facts);
    for (const word of asked) {
      if (hasWord(facts, word) || (facts.text && facts.text.has(word))) {
        seenOn.set(word, (seenOn.get(word) || 0) + 1);
      }
    }
  }
  const pageSize = Math.log(Math.max(scanned.length, MIN_PAGE_ELEMENTS));
  const rarity = (word) =>
    Math.max(MIN_RARITY, 1 - Math.log(Math.max(seenOn.get(word) || 1, 1)) / pageSize);
  const sameRole = (tag, element) => {
    const role = element.getAttribute('role');
    if (role && TAG_ROLES[tag] && TAG_ROLES[tag].test(role)) return true;
    return tag === 'button' && element.localName === 'input' && /^(?:submit|button)$/.test(element.getAttribute('type') || '');
  };
  const scoreOwn = (compound, element, facts) => {
    const hits = [];
    let score = 0;
    let qualifies = false;
    const addWords = (words, source, weight) => {
      let found = false;
      for (const word of words) {
        if (!source(word)) continue;
        score += weight * rarity(word);
        hits.push(word);
        found = true;
        qualifies = true;
      }
      return found;
    };
    const addTextWords = (words) => {
      if (facts.text) addWords(words.filter((word) => !hits.includes(word)), (word) => facts.text.has(word), TEXT_WORD);
    };
    if (compound.tag === element.localName) {
      score += STRUCTURAL.test(compound.tag) ? 1 : SAME_TAG;
      hits.push(compound.tag);
      if (compound.tagOnly && !STRUCTURAL.test(compound.tag)) qualifies = true;
    } else if (compound.tag && sameRole(compound.tag, element)) {
      score += SAME_ROLE;
      hits.push(compound.tag);
      if (compound.tagOnly) qualifies = true;
    } else if (compound.tagWord) {
      addWords([compound.tagWord], (word) => hasWord(facts, word), WORD);
    }
    for (const name of compound.names) {
      if (facts.id === name.value || facts.classes.includes(name.value)) {
        score += EXACT + WORD * name.words.length;
        hits.push(name.value);
        qualifies = true;
      } else {
        addWords(name.words, (word) => hasWord(facts, word), WORD);
        addTextWords(name.words);
      }
    }
    for (const attribute of compound.attributes) {
      const actual = element.getAttribute(attribute.name);
      if (actual === null) {
        addWords(attribute.words, (word) => hasWord(facts, word), WORD);
        addTextWords(attribute.words);
      } else if (attribute.value === null) {
        score += EXACT;
        hits.push(attribute.name);
        qualifies = true;
      } else if (attribute.value && actual.toLowerCase().includes(attribute.value)) {
        score += EXACT + WORD * attribute.words.length;
        hits.push(attribute.value);
        qualifies = true;
      } else {
        const actualWords = wordsOf(actual);
        if (!addWords(attribute.words, (word) => actualWords.includes(word), WORD)) {
          score += 1;
          hits.push(attribute.name);
        }
      }
    }
    return { score, qualifies, hits };
  };
  const inherited = new Map();
  const ranked = [];
  scanned.forEach((element, order) => {
    const facts = factsByElement.get(element);
    const own = compiled.map((compound) => scoreOwn(compound, element, facts));
    const above = inherited.get(element.parentElement);
    const reach = own.map((entry, index) => Math.max(entry.score, above ? above[index] : 0));
    inherited.set(element, reach);
    if (element === root) return;
    let best = null;
    for (const list of lists) {
      if (!list.some((index) => own[index].qualifies)) continue;
      const target = list[list.length - 1];
      let score = own[target].score;
      for (const index of list) if (index !== target) score += ANCESTOR_WEIGHT * reach[index];
      if (best && best.score >= score) continue;
      best = { element, order, score, list, members: null };
    }
    if (!best || best.score < MIN_SCORE) return;
    const hits = new Set();
    for (const index of [...best.list].reverse()) for (const hit of own[index].hits) hits.add(hit);
    best.matched = [...hits];
    ranked.push(best);
  });
  const stableClasses = (element) =>
    factsByElement.get(element).classes.filter((name) => !/\d/.test(name)).sort().join('.');
  const parentIds = new Map();
  const siblingKey = (element) => {
    const parent = element.parentElement;
    if (!parentIds.has(parent)) parentIds.set(parent, parentIds.size);
    return parentIds.get(parent) + '|' + element.localName;
  };
  const hrefFolder = (element) =>
    element.localName === 'a' ? /^(?:[a-z]+:\/\/[^/]+)?(\/[^/?#]+\/)/i.exec(element.getAttribute('href') || '')?.[1] || '' : '';
  const shapeKey = (element) => {
    const parent = element.parentElement;
    const idStem = (element.getAttribute('id') || '').replace(/\d+/g, '#');
    return [
      element.localName,
      stableClasses(element),
      parent.localName,
      factsByElement.has(parent) ? stableClasses(parent) : '',
      idStem,
      hrefFolder(element),
    ].join('|');
  };
  const collapsed = [];
  const collapse = (keyOf) => {
    const buckets = new Map();
    for (const entry of ranked) {
      if (entry.members) continue;
      const key = keyOf(entry.element);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(entry);
      else buckets.set(key, [entry]);
    }
    for (const entries of buckets.values()) {
      if (entries.length < MIN_REPEATED) continue;
      const scores = entries.map((entry) => entry.score).sort((a, b) => a - b);
      const median = scores[Math.floor(scores.length / 2)];
      const members = entries.map((entry) => entry.element);
      const common = entries.filter((entry) => entry.score - median < STANDS_OUT);
      if (common.length < MIN_REPEATED) continue;
      for (const entry of common) entry.members = members;
      collapsed.push({ ...common[0], members });
    }
  };
  collapse(siblingKey);
  collapse(shapeKey);
  const byRank = (a, b) =>
    b.score - a.score || Number(Boolean(b.members)) - Number(Boolean(a.members)) || a.order - b.order;
  const entries = [...ranked.filter((entry) => !entry.members), ...collapsed].sort(byRank);
  const floor = entries.length > 0 ? entries[0].score * KEPT_SHARE_OF_TOP : 0;
  const shortlist = entries.filter((entry) => entry.score >= floor).slice(0, RANKED);
  const isHidden = (element) => {
    // An option of a closed select has no box of its own.
    const boxed = (element.localName === 'option' && element.closest('select')) || element;
    if (boxed.getClientRects().length === 0) return true;
    return getComputedStyle(boxed).visibility === 'hidden';
  };
  for (const entry of shortlist) {
    entry.hidden = (entry.members ? entry.members.slice(0, LIMIT) : [entry.element]).every(isHidden);
    if (entry.hidden) entry.score *= HIDDEN_WEIGHT;
  }
  const clip = (value, limit) => {
    const end = /[\uD800-\uDBFF]/.test(value.charAt(limit - 1)) ? limit - 1 : limit;
    return value.slice(0, end);
  };
  const NOT_TEXT = 'script, style, noscript, template, textarea';
  // innerText only of a rendered element: unrendered, it is textContent, which
  // like the fallback holds script/style source and textarea default text.
  const plainText = (element) => {
    if (!element.querySelector(NOT_TEXT)) return element.textContent || '';
    const copy = element.cloneNode(true);
    copy.querySelectorAll(NOT_TEXT).forEach((node) => node.remove());
    return copy.textContent || '';
  };
  const textOf = (element) => {
    const attributes = ['aria-label', 'placeholder', 'alt', 'title'];
    let text = '';
    for (const name of attributes) text = text || element.getAttribute(name) || '';
    if (!text && !FIELD.test(element.localName)) {
      text = (element.getClientRects().length > 0 && element.innerText) || plainText(element);
    }
    return clip(text.replace(/\s+/g, ' ').trim(), TEXT_CHARS);
  };
  const sharedPrefix = (values) => {
    let prefix = values[0];
    for (const value of values) while (!value.startsWith(prefix)) prefix = prefix.slice(0, -1);
    return prefix;
  };
  const repeatedOptions = (members) => {
    const tag = members[0].localName;
    const classes = factsByElement
      .get(members[0])
      .classes.filter(
        (name) =>
          /^-?[A-Za-z_][\w-]*$/.test(name) &&
          !/\d/.test(name) &&
          members.every((member) => factsByElement.get(member).classes.includes(name)),
      );
    const options = classes.slice(0, 4).map((name) => tag + '.' + name);
    if (classes.length > 1) options.push(tag + '.' + classes.slice(0, 2).join('.'));
    for (const name of SHARED_ATTRIBUTES) {
      const value = members[0].getAttribute(name);
      if (value && !/[\r\n]/.test(value) && members.every((member) => member.getAttribute(name) === value)) {
        options.push(tag + '[' + name + '=' + selectors.quoted(value) + ']');
      }
    }
    const ids = members.map((member) => member.getAttribute('id') || '');
    const idPrefix = ids.every(Boolean) ? sharedPrefix(ids) : '';
    if (idPrefix.length >= 3) options.push(tag + '[id^=' + selectors.quoted(idPrefix) + ']');
    if (tag === 'a') {
      const hrefs = members.map((member) => member.getAttribute('href') || '');
      const folder = sharedPrefix(hrefs).replace(/[^/]*$/, '');
      if (hrefs.every(Boolean) && /[^/:]\/?$/.test(folder) && folder.length >= 2) {
        options.push('a[href^=' + selectors.quoted(folder) + ']');
      }
    }
    const inner = tag + (classes.length > 0 ? '.' + classes[0] : '');
    let holder = members[0].parentElement;
    while (holder && holder !== root && !members.every((member) => holder.contains(member))) {
      holder = holder.parentElement;
    }
    const holderSelector = holder && holder !== root ? selectors.unique(holder) : undefined;
    if (holderSelector) {
      options.push(holderSelector + (holder === members[0].parentElement ? ' > ' : ' ') + inner);
    }
    options.push(tag);
    return options;
  };
  const repeatedSelector = (members) => {
    const wanted = new Set(members);
    for (const option of repeatedOptions(members)) {
      if (option.length > SELECTOR_CHARS) continue;
      const matches = document.querySelectorAll(option);
      if (matches.length < members.length || matches.length > members.length * (1 + EXTRA_MATCHES)) continue;
      let covered = 0;
      for (const match of matches) if (wanted.has(match)) covered += 1;
      if (covered === members.length) return { selector: option, count: matches.length };
    }
    return undefined;
  };
  return shortlist
    .sort(byRank)
    .slice(0, LIMIT)
    .map((entry) => {
      const repeated = entry.members ? repeatedSelector(entry.members) : undefined;
      return {
        tag: entry.element.localName,
        role: entry.element.getAttribute('role') || undefined,
        text: textOf(entry.element) || undefined,
        selector: repeated ? repeated.selector : selectors.unique(entry.element),
        count: repeated ? repeated.count : undefined,
        matched: entry.matched,
        hidden: entry.hidden ? true : undefined,
      };
    });
}`;

/** Page expression ranking the elements for `selector`; `null` when it has no usable words. */
export function selectorCandidatesExpression(selector: string): string {
  const terms = parseSelectorTerms(selector);
  return terms.length > 0 ? `(${SELECTOR_CANDIDATES_SOURCE})(${JSON.stringify(terms)})` : 'null';
}

function clipped(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const end = /[\uD800-\uDBFF]/u.test(value.charAt(limit - 1)) ? limit - 1 : limit;
  return value.slice(0, end);
}

/** Page output is untrusted: only bounded fields of the expected types survive. */
function readSelectorCandidates(value: unknown): SelectorCandidate[] {
  if (!Array.isArray(value)) return [];
  const candidates: SelectorCandidate[] = [];
  for (const item of value.slice(0, MAX_SELECTOR_CANDIDATES)) {
    if (!isRecord(item)) continue;
    const tag = clipped(item.tag, MAX_TAG_CHARS);
    if (!tag) continue;
    const role = clipped(item.role, MAX_TAG_CHARS);
    const text = clipped(item.text, MAX_TEXT_CHARS);
    const { selector, count } = item;
    candidates.push({
      tag,
      ...(role ? { role } : {}),
      ...(text ? { text } : {}),
      // A cut selector would be a different selector.
      ...(typeof selector === 'string' && selector && selector.length <= MAX_SELECTOR_CHARS
        ? { selector }
        : {}),
      ...(typeof count === 'number' && Number.isInteger(count) && count >= MIN_REPEATED_ELEMENTS
        ? { count }
        : {}),
      matched: stringArray(item.matched)
        .slice(0, MAX_MATCHED_WORDS)
        .map((word) => clipped(word, MAX_MATCHED_WORD_CHARS) ?? ''),
      ...(item.hidden === true ? { hidden: true as const } : {}),
    });
  }
  return candidates;
}

/**
 * The live inspect ref of a node in this frame, by backendNodeId: the current
 * snapshot's element for it, while retained snapshots still resolve the ref
 * (as in resolveTarget). Undefined for a node the snapshot does not name.
 */
export function snapshotRefForBackendNode(
  session: SessionState,
  backendNodeId: number | undefined,
): string | undefined {
  const snapshot = session.snapshot;
  if (backendNodeId === undefined || !snapshot || snapshot.generation !== session.generation) {
    return undefined;
  }
  const element = snapshot.elements.find(
    (candidate) =>
      candidate.backendNodeId === backendNodeId &&
      candidate.commandSessionId === session.commandSessionId,
  );
  return element && resolveBrowserSnapshotElement(session, element.ref) ? element.ref : undefined;
}

/**
 * Names the elements the live inspect snapshot already knows, by
 * backendNodeId. A failed lookup only leaves a candidate without a ref. This
 * never inspects: a page not inspected yet is left to the candidate selectors.
 */
export async function attachSnapshotRefs(
  session: SessionState,
  candidates: Array<{ selector?: string; count?: number; ref?: string }>,
): Promise<void> {
  const snapshot = session.snapshot;
  if (!snapshot || snapshot.generation !== session.generation) return;
  // A repeated structure is not one element, so it has no ref.
  const selectors = candidates.map((candidate) =>
    candidate.count === undefined ? (candidate.selector ?? null) : null,
  );
  if (!selectors.some((selector) => selector !== null)) return;
  const objectGroup = 'browser-selector-candidates';
  try {
    const evaluated = await cdp<{ result?: { objectId?: string } }>(session, 'Runtime.evaluate', {
      expression: `${JSON.stringify(selectors)}.map((selector) => selector && document.querySelector(selector))`,
      objectGroup,
      returnByValue: false,
    });
    const objectId = evaluated.result?.objectId;
    if (!objectId) return;
    const properties = await cdp<{
      result?: Array<{ name?: string; value?: { objectId?: string } }>;
    }>(session, 'Runtime.getProperties', { objectId, ownProperties: true });
    await Promise.all(
      (properties.result ?? []).map(async ({ name, value }) => {
        const candidate = candidates[Number(name)];
        if (!candidate || !value?.objectId) return;
        const described = await cdp<{ node?: { backendNodeId?: number } }>(
          session,
          'DOM.describeNode',
          { objectId: value.objectId },
        );
        const ref = snapshotRefForBackendNode(session, described.node?.backendNodeId);
        if (ref) candidate.ref = ref;
      }),
    );
  } catch (error) {
    if (isBrowserOperationInterruption(error)) throw error;
  } finally {
    await cdp(session, 'Runtime.releaseObjectGroup', { objectGroup }).catch(() => undefined);
  }
}

/** The page's ranked output, bounded and with refs for the elements already inspected. */
export async function resolveSelectorCandidates(
  session: SessionState,
  ranked: unknown,
): Promise<SelectorCandidate[]> {
  const candidates = readSelectorCandidates(ranked);
  if (candidates.length > 0) await attachSnapshotRefs(session, candidates);
  while (candidates.length > 0 && byteLength(candidates) > MAX_SELECTOR_CANDIDATES_BYTES) {
    candidates.pop();
  }
  return candidates;
}

/** One line for failures that reach the model as text alone. */
export function formatSelectorCandidates(candidates: readonly SelectorCandidate[]): string {
  const lines = candidates.map((candidate) => {
    const handles = [
      candidate.ref ? `ref ${candidate.ref}` : '',
      candidate.selector ? `selector ${candidate.selector}` : '',
      candidate.count === undefined ? '' : `${candidate.count} matches`,
      candidate.hidden ? 'hidden' : '',
    ].filter(Boolean);
    const role = candidate.role ? ` role=${candidate.role}` : '';
    const text = candidate.text ? ` ${JSON.stringify(candidate.text)}` : '';
    return `<${candidate.tag}${role}>${text}${handles.length ? ` (${handles.join(', ')})` : ''}`;
  });
  return lines.length > 0 ? `Candidates: ${lines.join('; ')}.` : '';
}
