import type {
  AgentSemanticNode,
  AgentSemanticTreePage,
  SemanticNode,
  SemanticPageTree,
  SemanticTargetRef,
} from './browser-semantic-tree.js';

const MODEL_CONTEXT_ROLES = new Set([
  'document',
  'main',
  'navigation',
  'region',
  'article',
  'form',
  'dialog',
  'alertdialog',
  'heading',
  'list',
  'listitem',
  'table',
  'row',
  'cell',
  'columnheader',
  'rowheader',
  'group',
  'paragraph',
  'label',
  'caption',
  'note',
  'status',
  'alert',
  'description',
]);

/**
 * Nesting levels the serialized tree keeps; level 0 is a root. The desktop
 * Browser broker rejects a result nested deeper than 32 levels (Electron
 * `isStrictStructuredCloneValue`, depth 0 = the action result). In an
 * inspect or query result a node at level k sits at depth 3 + 2k (result >
 * semanticTree > roots[] > node, and children[] > node per level), and its
 * deepest value (a `rect` or `state` field) at 5 + 2k. With 10 levels the
 * deepest value is at 23, leaving 9 levels for any outer wrapper. A node on
 * the next-to-last level lists its whole retained subtree as flat children
 * (in tree order, nesting dropped) and is marked `flattened: true`, so no
 * ref, role or name is lost.
 */
export const SEMANTIC_TREE_MAX_LEVELS = 10;

function flattenSubtree(nodes: readonly AgentSemanticNode[], into: AgentSemanticNode[]): boolean {
  let flattened = false;
  for (const { children, ...node } of nodes) {
    into.push(node);
    if (children && children.length > 0) {
      flattened = true;
      flattenSubtree(children, into);
    }
  }
  return flattened;
}

function subtreeCounts(
  node: SemanticNode,
  refs: ReadonlyMap<string, SemanticTargetRef>,
  allowedRefs: ReadonlySet<string>,
  counts: Map<string, { anyActionable: number; allowedActionable: number }>,
): { anyActionable: number; allowedActionable: number } {
  const ownRef = node.targetKey ? refs.get(node.targetKey)?.ref : undefined;
  let anyActionable = ownRef ? 1 : 0;
  let allowedActionable = ownRef && allowedRefs.has(ownRef) ? 1 : 0;
  for (const child of node.children) {
    const childCounts = subtreeCounts(child, refs, allowedRefs, counts);
    anyActionable += childCounts.anyActionable;
    allowedActionable += childCounts.allowedActionable;
  }
  const result = { anyActionable, allowedActionable };
  counts.set(node.id, result);
  return result;
}

export function serializeSemanticTreePage(
  tree: SemanticPageTree,
  refs: ReadonlyMap<string, SemanticTargetRef>,
  allowedRefs: ReadonlySet<string>,
  options: { maxNodes?: number; maxBytes?: number } = {},
): AgentSemanticTreePage {
  const maxNodes = Math.max(1, options.maxNodes ?? 200);
  const maxBytes = Math.max(256, options.maxBytes ?? 12_000);
  const counts = new Map<string, { anyActionable: number; allowedActionable: number }>();
  tree.roots.forEach((root) => subtreeCounts(root, refs, allowedRefs, counts));
  let retainedNodes = 0;
  let retainedBytes = 0;
  let truncated = tree.truncated;

  const actionableFirst = (nodes: readonly SemanticNode[]): SemanticNode[] =>
    nodes
      .map((node, index) => ({ node, index }))
      .sort((left, right) => {
        const leftAllowed = counts.get(left.node.id)?.allowedActionable ?? 0;
        const rightAllowed = counts.get(right.node.id)?.allowedActionable ?? 0;
        return rightAllowed - leftAllowed || left.index - right.index;
      })
      .map(({ node }) => node);

  const serialize = (
    node: SemanticNode,
    contextual = false,
    level = 0,
  ): AgentSemanticNode | null => {
    const count = counts.get(node.id) ?? { anyActionable: 0, allowedActionable: 0 };
    const targetRef = node.targetKey ? refs.get(node.targetKey) : undefined;
    if (targetRef && !allowedRefs.has(targetRef.ref)) return null;
    if (!targetRef && count.anyActionable > 0 && count.allowedActionable === 0) return null;
    if (
      !targetRef &&
      count.allowedActionable === 0 &&
      !contextual &&
      !MODEL_CONTEXT_ROLES.has(node.role)
    ) {
      return null;
    }
    const base: AgentSemanticNode = {
      role: node.role,
      ...(node.name ? { name: node.name } : {}),
      ...(node.text ? { text: node.text } : {}),
      ...(node.level ? { level: node.level } : {}),
      ...(node.state ? { state: node.state } : {}),
      ...(targetRef
        ? {
            ref: targetRef.ref,
            frame: targetRef.frameRef,
            actionable: true as const,
            ...(node.coordinateSpace !== 'unavailable' && node.rect
              ? { rect: { ...node.rect } }
              : {}),
          }
        : {}),
    };
    const estimatedBytes = Buffer.byteLength(JSON.stringify(base), 'utf8');
    if (retainedNodes >= maxNodes || retainedBytes + estimatedBytes > maxBytes) {
      truncated = true;
      return null;
    }
    retainedNodes += 1;
    retainedBytes += estimatedBytes;
    const children = actionableFirst(node.children)
      .map((child) => serialize(child, count.allowedActionable > 0 || contextual, level + 1))
      .filter((child): child is AgentSemanticNode => child !== null);
    if (children.length === 0) return base;
    // Deeper levels stay nested here; the last kept level flattens them all.
    if (level !== SEMANTIC_TREE_MAX_LEVELS - 2) return { ...base, children };
    const flat: AgentSemanticNode[] = [];
    const flattened = flattenSubtree(children, flat);
    return { ...base, children: flat, ...(flattened ? { flattened: true as const } : {}) };
  };

  const roots = actionableFirst(tree.roots)
    .map((root) => serialize(root))
    .filter((root): root is AgentSemanticNode => root !== null);
  return { version: 1, roots, truncated };
}
