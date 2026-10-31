import type { AccessibilityNode, RawDomNode } from './browser-snapshot.js';
import type { ElementRecord, Rect } from './browser-state.js';

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'switch',
  'combobox',
  'listbox',
  'spinbutton',
  'slider',
  'option',
  'menuitem',
  'tab',
]);

const INTERACTIVE_TAGS = new Set([
  'button',
  'input',
  'textarea',
  'select',
  'a',
  'summary',
  'option',
]);

const MAX_EXPOSED_TAG_LENGTH = 80;
const MAX_EXPOSED_ROLE_LENGTH = 120;
const MAX_EXPOSED_TYPE_LENGTH = 120;
const MAX_EXPOSED_SELECTOR_LENGTH = 500;
const MAX_EXPOSED_TEXT_LENGTH = 300;
const MAX_EXPOSED_ATTRIBUTES = 20;
const MAX_EXPOSED_ATTRIBUTE_KEY_LENGTH = 120;
const MAX_EXPOSED_ATTRIBUTE_VALUE_LENGTH = 300;
const MAX_EXPOSED_PARENT_REGIONS = 16;

/**
 * The scanner falls back to `[data-backend-node-id="N"]` as an internal handle;
 * no such attribute exists in the page DOM, so exposing it invites selectors
 * that can never match (eval 784094: 85 results carried it, the model reused it
 * twice and both missed). Real selectors such as `input[name="q"]` stay.
 */
const SYNTHETIC_SELECTOR_PATTERN = /data-backend-node-id/i;

export function isSyntheticSelector(selector: string): boolean {
  return SYNTHETIC_SELECTOR_PATTERN.test(selector);
}

export function exposeElement(
  element: ElementRecord,
  viewport: { width: number; height: number },
  frameRef?: string,
): Record<string, unknown> & { ref: string } {
  const coordinateSpace = element.coordinateSpace ?? 'main-frame-viewport';
  const hasViewportRect = coordinateSpace === 'main-frame-viewport';
  const actionable = element.isInteractable === true;
  return {
    ref: element.ref,
    tag: element.tag.slice(0, MAX_EXPOSED_TAG_LENGTH),
    role: element.role.slice(0, MAX_EXPOSED_ROLE_LENGTH),
    type: element.type.slice(0, MAX_EXPOSED_TYPE_LENGTH),
    ...(element.selector && !isSyntheticSelector(element.selector)
      ? { selector: element.selector.slice(0, MAX_EXPOSED_SELECTOR_LENGTH) }
      : {}),
    text: element.text.slice(0, MAX_EXPOSED_TEXT_LENGTH),
    ...(hasViewportRect ? { rect: { ...element.rect } } : {}),
    coordinateSpace,
    inViewport:
      hasViewportRect &&
      element.rect.x < viewport.width &&
      element.rect.y < viewport.height &&
      element.rect.x + element.rect.width > 0 &&
      element.rect.y + element.rect.height > 0,
    actionable,
    pointerActionable: actionable && hasViewportRect,
    attributes: Object.fromEntries(
      Object.entries(element.attributes)
        .slice(0, MAX_EXPOSED_ATTRIBUTES)
        .map(([key, value]) => [
          key.slice(0, MAX_EXPOSED_ATTRIBUTE_KEY_LENGTH),
          value.slice(0, MAX_EXPOSED_ATTRIBUTE_VALUE_LENGTH),
        ]),
    ),
    ...(element.frameId && frameRef ? { frame: frameRef } : {}),
    ...(element.parentRegionPath
      ? {
          parentRegionPath: element.parentRegionPath
            .slice(0, MAX_EXPOSED_PARENT_REGIONS)
            .map((region) => ({
              role: region.role.slice(0, MAX_EXPOSED_ROLE_LENGTH),
              ...(region.name ? { name: region.name.slice(0, MAX_EXPOSED_TEXT_LENGTH) } : {}),
            })),
        }
      : {}),
  };
}

export function buildParentRegionPath(
  node: RawDomNode,
  byNodeId: Map<number, RawDomNode>,
  parents: Map<number, number>,
  axByBackend: Map<number, AccessibilityNode>,
): Array<{ role: string; name?: string }> {
  const path: Array<{ role: string; name?: string }> = [];
  let parentId = parents.get(node.nodeId);
  while (parentId !== undefined) {
    const parent = byNodeId.get(parentId);
    if (!parent) break;
    const attributes = attributeMap(parent.attributes);
    const role = elementRole(
      parent,
      attributes,
      parent.backendNodeId ? axByBackend.get(parent.backendNodeId) : undefined,
    );
    if (
      role === 'region' ||
      role === 'form' ||
      role === 'main' ||
      role === 'dialog' ||
      role === 'article'
    ) {
      const name = structuralRegionName(
        attributes,
        parent.backendNodeId ? axByBackend.get(parent.backendNodeId) : undefined,
      );
      path.unshift({ role, ...(name ? { name } : {}) });
    }
    parentId = parents.get(parent.nodeId);
  }
  return path;
}

function structuralRegionName(attributes: Record<string, string>, ax?: AccessibilityNode): string {
  return (ax?.name?.value || attributes['aria-label'] || attributes.title || attributes.name || '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 200);
}

export function hasArea(rect: Rect): boolean {
  return rect.width > 0 && rect.height > 0;
}

export function isInActionViewport(
  rect: Rect,
  viewport: { width: number; height: number },
): boolean {
  return rect.x < viewport.width && rect.x + rect.width > 0;
}

export function isVirtualEditorProxy(
  node: RawDomNode,
  attributes: Record<string, string>,
  byNodeId: Map<number, RawDomNode>,
  parents: Map<number, number>,
): boolean {
  const tag = node.nodeName.toLowerCase();
  if ((tag !== 'textarea' && tag !== 'input') || attributes.inputmode?.toLowerCase() !== 'none')
    return false;
  let parentId = parents.get(node.nodeId);
  while (parentId !== undefined) {
    const parent = byNodeId.get(parentId);
    if (!parent) break;
    if (hasClass(attributeMap(parent.attributes).class, 'dcg-mq-editable-field')) return true;
    parentId = parents.get(parent.nodeId);
  }
  return false;
}

export function hasClass(value: string | undefined, className: string): boolean {
  return (value ?? '').split(/\s+/u).includes(className);
}

export function visibleText(
  node: RawDomNode,
  attributes: Record<string, string>,
  ax?: AccessibilityNode,
): string {
  return (
    ax?.name?.value ||
    attributes['aria-label'] ||
    attributes.placeholder ||
    textContent(node) ||
    attributes.title ||
    ''
  )
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 300);
}

export function nameForNode(
  node: RawDomNode,
  attributes: Record<string, string>,
  ax?: AccessibilityNode,
): string {
  return visibleText(node, attributes, ax).slice(0, 200);
}

function textContent(node: RawDomNode): string {
  return [
    node.nodeValue ?? '',
    ...(node.children ?? []).map(textContent),
    ...(node.shadowRoots ?? []).map(textContent),
    node.contentDocument ? textContent(node.contentDocument) : '',
  ].join(' ');
}

export function elementRole(
  node: RawDomNode,
  attributes: Record<string, string>,
  ax?: AccessibilityNode,
): string {
  const explicit = attributes.role?.trim().toLowerCase();
  if (explicit) return explicit;
  const accessible = ax?.role?.value?.trim().toLowerCase();
  if (accessible && accessible !== 'generic') return accessible;
  switch (node.nodeName.toLowerCase()) {
    case 'a':
      return 'link';
    case 'button':
      return 'button';
    case 'textarea':
      return 'textbox';
    case 'select':
      return 'combobox';
    case 'input':
      return inputRole(attributes.type);
    case 'main':
      return 'main';
    case 'nav':
      return 'navigation';
    case 'form':
      return 'form';
    case 'dialog':
      return 'dialog';
    case 'article':
      return 'article';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'ul':
    case 'ol':
      return 'list';
    case 'li':
      return 'listitem';
    case 'table':
      return 'table';
    case 'tr':
      return 'row';
    case 'td':
    case 'th':
      return 'cell';
    default:
      return 'generic';
  }
}

function inputRole(type = ''): string {
  switch (type.toLowerCase()) {
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'search':
      return 'searchbox';
    case 'range':
      return 'slider';
    case 'button':
    case 'submit':
    case 'reset':
      return 'button';
    default:
      return 'textbox';
  }
}

export function elementType(tag: string, role: string, attributes: Record<string, string>): string {
  if (tag === 'input') return attributes.type || role;
  if (tag === 'textarea') return 'textarea';
  return role || tag;
}

export function isInteractive(
  node: RawDomNode,
  attributes: Record<string, string>,
  role: string,
): boolean {
  if (attributes.hidden !== undefined || attributes['aria-hidden'] === 'true') return false;
  return (
    INTERACTIVE_TAGS.has(node.nodeName.toLowerCase()) ||
    INTERACTIVE_ROLES.has(role) ||
    attributes.contenteditable === 'true' ||
    attributes.tabindex !== undefined
  );
}

export function attributeMap(attributes?: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index + 1 < (attributes?.length ?? 0); index += 2) {
    const key = attributes?.[index];
    const value = attributes?.[index + 1];
    if (key && value !== undefined) result[key.toLowerCase()] = value;
  }
  return result;
}

export function safeAttributes(attributes: Record<string, string>): Record<string, string> {
  const allowed = new Set([
    'id',
    'aria-label',
    'aria-labelledby',
    'aria-describedby',
    'placeholder',
    'title',
    'type',
    'name',
    'href',
    'role',
    'contenteditable',
    'autocomplete',
    'inputmode',
  ]);
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => allowed.has(key)));
}
