import { randomUUID } from 'node:crypto';

import {
  asNumber,
  asString,
  browserElementFrameIsCurrent,
  captureBrowserFrameEpochs,
  byteLength,
  getBrowserSnapshot,
  describeCdpException,
  type BrowserSessionState as SessionState,
  type ElementRecord,
  storeBrowserSnapshot,
  type PageSummary,
  type Rect,
  type Snapshot,
} from './browser-state.js';
import { exposeElement } from './browser-snapshot-helpers.js';
import {
  serializeSemanticTreePage,
  type AgentSemanticTreePage,
  type SemanticTargetRef,
  type SemanticPageTree,
} from './browser-semantic-tree.js';
import type {
  BrowserAXNode,
  BrowserDOMNode,
  BrowserInteractiveElement,
} from './browser-core-contracts.js';
import { CDPHelper } from './cdp-helper.js';
import type {
  BrowserAttachedFrame,
  BrowserEvaluateOptions,
  BrowserTransport,
  BrowserTransportCommandOptions,
  BrowserTransportEventListener,
} from './browser-transport.js';
import { isBrowserOperationInterruption } from './operation-timeout.js';

const DEFAULT_SNAPSHOT_PAGE_SIZE = 100;
const MAX_SNAPSHOT_PAGE_SIZE = 200;
const MAX_SNAPSHOT_PAGE_BYTES = 56 * 1024;
const MAX_SEMANTIC_QUERY_RESULTS = 50;
const SEMANTIC_ITEM_ROLES = new Set(['article', 'listitem', 'row', 'form', 'region', 'group']);

function browserSnapshotElementPriority(element: BrowserInteractiveElement): number {
  if (element.isInViewport && element.isInteractable) return 0;
  if (element.isInViewport) return 1;
  if (element.isInteractable) return 2;
  return 3;
}

export function compareBrowserSnapshotElements(
  left: BrowserInteractiveElement,
  right: BrowserInteractiveElement,
): number {
  return (
    browserSnapshotElementPriority(left) - browserSnapshotElementPriority(right) ||
    left.boundingBox.y - right.boundingBox.y ||
    left.boundingBox.x - right.boundingBox.x
  );
}

/** Compatibility names retained for existing Browser Core consumers. */
export type RawDomNode = BrowserDOMNode;
export type AccessibilityNode = BrowserAXNode;

/**
 * Shared page-understanding path for every Browser provider.
 *
 * The mature CDPHelper owns DOMSnapshot + DOM + AX + Runtime listener
 * discovery. ElementMapManager owns both the atomic semantic snapshot and
 * opaque refs. Providers supply only BrowserTransport.
 */
export abstract class BrowserSnapshotSupport {
  protected abstract readBox(session: SessionState, backendNodeId: number): Promise<Rect>;
  protected abstract readPageSummary(session: SessionState): Promise<PageSummary>;

  protected async inspect(
    session: SessionState,
    input: Record<string, unknown>,
    continuationKind: NonNullable<Snapshot['continuationKind']> = 'inspect',
  ): Promise<unknown> {
    const snapshotId = asString(input.snapshotId);
    const offset = Math.max(0, Math.floor(asNumber(input.offset, 0)));
    const limit = Math.max(
      1,
      Math.min(
        MAX_SNAPSHOT_PAGE_SIZE,
        Math.floor(asNumber(input.limit, DEFAULT_SNAPSHOT_PAGE_SIZE)),
      ),
    );
    // Every element of a snapshot receives its opaque ref when the snapshot is
    // created, so any in-range offset of a live snapshot is a safe random-access
    // page. Only an obsolete observation must not be paged; replace it with a
    // fresh scan and say so explicitly instead of failing the call (eval: 172
    // pagination failures from missing snapshotId, non-exact offsets and stale
    // continuations).
    // Offsets are only meaningful within the snapshot that produced them.
    // Whenever the continuation target is gone — stale snapshotId, expired or
    // action-invalidated snapshot, or no snapshot at all — paging the fresh
    // scan at the requested offset could silently skip elements the model has
    // never seen. Every restarted scan therefore starts from offset 0 and
    // says so; `requestedOffset` keeps the original request visible.
    let restarted: Record<string, unknown> | undefined;
    if (snapshotId) {
      const snapshot = getBrowserSnapshot(session, snapshotId);
      if (snapshot) {
        if ((snapshot.continuationKind ?? 'inspect') !== 'inspect') {
          // Eval 777827: the bare message did not name the right action.
          throw new Error(
            snapshot.continuationKind === 'query-editable'
              ? 'SNAPSHOT_KIND_MISMATCH: this snapshotId came from query kind "editable"; continue it with action "query", kind "editable" and the same snapshotId/offset'
              : 'SNAPSHOT_KIND_MISMATCH: this snapshotId is not an inspect snapshot; continue it with the action named in its own continuation',
          );
        }
        return this.snapshotPage(snapshot, offset, limit);
      }
      const sameDocument = snapshotGenerationOf(snapshotId) === session.generation;
      restarted = {
        reason: sameDocument ? 'page_changed' : 'document_replaced',
        requestedSnapshotId: snapshotId.slice(0, 200),
        requestedOffset: offset,
        message: sameDocument
          ? 'The requested snapshot is no longer available (the page changed or the snapshot expired). Offsets from the old snapshot are not comparable, so this is a fresh snapshot of the current page starting at offset 0.'
          : 'The requested snapshot belongs to a previous document. This is a fresh snapshot of the current document starting at offset 0.',
      };
    } else if (offset > 0) {
      const latest = session.snapshot ? getBrowserSnapshot(session, session.snapshot.id) : undefined;
      if (latest && (latest.continuationKind ?? 'inspect') === 'inspect') {
        return this.snapshotPage(latest, offset, limit);
      }
      restarted = {
        reason: 'no_current_snapshot',
        requestedOffset: offset,
        message:
          'No current inspect snapshot was available to continue, so this is a fresh snapshot starting at offset 0.',
      };
    }

    const startedAt = Date.now();
    const inspectionGeneration = session.generation;
    const frameEpochs = captureBrowserFrameEpochs(session);
    const page = await this.readPageSummary(session);
    assertInspectionGeneration(session, inspectionGeneration);
    const scan = await scanPageUnderstanding(session);
    assertInspectionGeneration(session, inspectionGeneration);
    let sourceElements = scan.elements.filter((element) =>
      browserElementFrameIsCurrent(session, frameEpochs, element),
    );
    // Keep the complete scan in the session snapshot. Response pages remain
    // bounded by `limit` and the byte budget below, while truncating the
    // source here would make elements after the first 500 impossible to
    // discover or address through continuation pages.
    const semanticTree = scan.semanticTree;
    await session.elementMap.update(
      sourceElements,
      {
        ...page,
        focusedElement: null,
      },
      semanticTree,
    );
    if (session.generation !== inspectionGeneration) {
      // update() may have completed after the navigation listener invalidated
      // the session. Do not leave that obsolete scan available to legacy ref
      // bridges or republish it under the new generation.
      session.elementMap.clearByUrl(page.url);
      session.elementMap.clearOpaqueRefs();
      throw staleInspectionError();
    }
    sourceElements = sourceElements.filter((element) =>
      browserElementFrameIsCurrent(session, frameEpochs, element),
    );
    const elements = sourceElements.map((element) =>
      toElementRecord(inspectionGeneration, element),
    );

    const frameRefs = createFrameRefs(elements);
    const snapshot: Snapshot = {
      id: `browser-snapshot:${inspectionGeneration}-${randomUUID()}`,
      generation: inspectionGeneration,
      createdAt: Date.now(),
      continuationKind,
      elements,
      ...(semanticTree ? { semanticSource: semanticTree } : {}),
      semanticTree: serializeSnapshotTree(semanticTree, elements, undefined, frameRefs),
      page,
      nextOffset: 0,
      frameRefs,
    };
    storeBrowserSnapshot(session, snapshot);
    session.elementMap.replaceOpaqueRefs(elements);
    snapshot.durationMs = Date.now() - startedAt;
    // Every path that reaches the fresh scan serves its first page from
    // offset 0: ordinary first inspects request it, and restarted
    // continuations must not skip unseen elements.
    const firstPage = this.snapshotPage(snapshot, 0, limit);
    return restarted ? { ...firstPage, snapshotRestarted: restarted } : firstPage;
  }

  protected async searchSemantic(
    session: SessionState,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const text = asString(input.text).replace(/\s+/gu, ' ').trim();
    if (!text) throw new Error('semantic query requires non-empty text');
    const limit = Math.max(
      1,
      Math.min(MAX_SEMANTIC_QUERY_RESULTS, Math.floor(asNumber(input.limit, 20))),
    );
    const startedAt = Date.now();
    await this.inspect(session, { limit: 1 }, 'semantic');
    const snapshot = session.snapshot;
    if (!snapshot) throw new Error('SEMANTIC_QUERY_FAILED: no current Browser snapshot');

    const normalized = text.toLocaleLowerCase();
    const contexts = snapshot.semanticSource
      ? findSemanticContexts(snapshot.semanticSource, normalized)
      : [];
    const selectedContexts = contexts.slice(0, limit);
    const targetKeys = new Set<string>();
    for (const context of selectedContexts) collectSemanticTargetKeys(context, targetKeys);

    const refsByTargetKey = new Map<string, string>();
    for (const element of snapshot.elements) {
      refsByTargetKey.set(`${element.frameId ?? 'main'}:${element.backendNodeId}`, element.ref);
    }
    const allowedRefs = new Set<string>();
    for (const targetKey of targetKeys) {
      const ref = refsByTargetKey.get(targetKey);
      if (ref) allowedRefs.add(ref);
    }

    // Semantic-only matches remain useful evidence, but actionable results are
    // bounded independently so a matching container cannot flood the model.
    const matchingElements = snapshot.elements
      .filter((element) => allowedRefs.has(element.ref))
      .slice(0, MAX_SEMANTIC_QUERY_RESULTS);
    const returnedRefs = new Set(matchingElements.map((element) => element.ref));
    const semanticTree = snapshot.semanticSource
      ? serializeSnapshotTree(
          snapshot.semanticSource,
          snapshot.elements,
          returnedRefs,
          snapshot.frameRefs,
        )
      : { version: 1 as const, roots: [], truncated: false };

    return {
      success: true,
      url: snapshot.page.url,
      title: snapshot.page.title,
      snapshotId: snapshot.id,
      query: text,
      matchCount: contexts.length,
      returnedMatches: selectedContexts.length,
      elements: matchingElements.map((element) =>
        exposeElement(
          element,
          snapshot.page.viewport,
          snapshot.frameRefs?.get(element.frameId ?? 'main'),
        ),
      ),
      semanticTree,
      truncated:
        contexts.length > selectedContexts.length || allowedRefs.size > matchingElements.length,
      durationMs: Date.now() - startedAt,
    };
  }

  protected snapshotPage(
    snapshot: Snapshot,
    offset: number,
    limit: number,
  ): Record<string, unknown> {
    const pageElements = snapshot.elements.slice(offset, offset + limit);
    let elements = pageElements.map((element) =>
      exposeElement(
        element,
        snapshot.page.viewport,
        snapshot.frameRefs?.get(element.frameId ?? 'main'),
      ),
    );
    let end = offset + pageElements.length;
    let includeSemanticTree = true;
    let result = buildSnapshotPage(snapshot, offset, elements, end, includeSemanticTree);
    if (byteLength(result) > MAX_SNAPSHOT_PAGE_BYTES) {
      includeSemanticTree = false;
      result = buildSnapshotPage(snapshot, offset, elements, end, includeSemanticTree);
    }
    if (byteLength(result) > MAX_SNAPSHOT_PAGE_BYTES && elements.length > 1) {
      const candidates = elements;
      let lower = 1;
      let upper = candidates.length - 1;
      let fittingCount = 0;
      let fittingResult: Record<string, unknown> | undefined;
      while (lower <= upper) {
        const count = Math.floor((lower + upper) / 2);
        const candidateEnd = offset + count;
        const candidate = buildSnapshotPage(
          snapshot,
          offset,
          candidates.slice(0, count),
          candidateEnd,
          includeSemanticTree,
        );
        if (byteLength(candidate) <= MAX_SNAPSHOT_PAGE_BYTES) {
          fittingCount = count;
          fittingResult = candidate;
          lower = count + 1;
        } else {
          upper = count - 1;
        }
      }
      if (fittingResult) {
        elements = candidates.slice(0, fittingCount);
        end = offset + fittingCount;
        result = fittingResult;
      }
    }
    if (byteLength(result) > MAX_SNAPSHOT_PAGE_BYTES) {
      throw new Error('BROWSER_RESULT_TOO_LARGE: inspect summary exceeds the result budget');
    }
    snapshot.nextOffset = result.truncated === true ? end : null;
    return result;
  }
}

function assertInspectionGeneration(session: SessionState, expected: number): void {
  if (session.generation !== expected) throw staleInspectionError();
}

/** Snapshot ids are `browser-snapshot:<generation>-<uuid>`; foreign ids yield undefined. */
function snapshotGenerationOf(snapshotId: string): number | undefined {
  const match = /^browser-snapshot:(\d+)-/u.exec(snapshotId);
  return match ? Number(match[1]) : undefined;
}

function staleInspectionError(): Error {
  return new Error('STALE_SNAPSHOT: page changed while inspect was scanning; inspect again');
}

function buildSnapshotPage(
  snapshot: Snapshot,
  offset: number,
  elements: Array<Record<string, unknown>>,
  end: number,
  includeSemanticTree: boolean,
): Record<string, unknown> {
  const truncated = end < snapshot.elements.length;
  const refs = new Set<string>(elements.map((element) => String(element.ref ?? '')));
  const semanticTree = includeSemanticTree
    ? snapshot.semanticSource
      ? serializeSnapshotTree(snapshot.semanticSource, snapshot.elements, refs, snapshot.frameRefs)
      : filterSemanticTree(snapshot.semanticTree, refs)
    : undefined;
  return {
    success: true,
    url: snapshot.page.url.slice(0, 4_000),
    title: snapshot.page.title.slice(0, 1_000),
    viewport: snapshot.page.viewport,
    scrollPosition: snapshot.page.scrollPosition,
    pageHeight: snapshot.page.pageHeight,
    pageWidth: snapshot.page.pageWidth,
    ...(snapshot.durationMs !== undefined
      ? { durationMs: snapshot.durationMs, duration: snapshot.durationMs }
      : {}),
    snapshotId: snapshot.id,
    offset,
    totalElements: snapshot.elements.length,
    returnedElements: elements.length,
    elements,
    ...(includeSemanticTree
      ? { semanticTree }
      : snapshot.semanticSource || snapshot.semanticTree.roots.length > 0
        ? { semanticTreeOmitted: { reason: 'result_budget' } }
        : {}),
    truncated,
    ...(truncated ? { nextOffset: end } : {}),
    ...(truncated
      ? {
          continuation: {
            action: 'inspect',
            input: { snapshotId: snapshot.id, offset: end },
          },
        }
      : {}),
  };
}

function createFrameRefs(elements: readonly ElementRecord[]): Map<string, string> {
  const refs = new Map<string, string>();
  for (const element of elements) {
    const frameId = element.frameId ?? 'main';
    if (!refs.has(frameId)) refs.set(frameId, `browser-frame:${randomUUID()}`);
  }
  return refs;
}

function findSemanticContexts(
  tree: SemanticPageTree,
  normalizedText: string,
): SemanticPageTree['roots'] {
  const matches: SemanticPageTree['roots'] = [];
  const seen = new Set<string>();
  const visit = (
    node: SemanticPageTree['roots'][number],
    ancestors: readonly SemanticPageTree['roots'][number][],
  ): void => {
    const ownText = `${node.name ?? ''} ${node.text ?? ''}`
      .replace(/\s+/gu, ' ')
      .trim()
      .toLocaleLowerCase();
    if (ownText.includes(normalizedText)) {
      const path = [...ancestors, node];
      const context = [...path]
        .reverse()
        .find((candidate) => SEMANTIC_ITEM_ROLES.has(candidate.role));
      const selected = context ?? node;
      if (!seen.has(selected.id)) {
        seen.add(selected.id);
        matches.push(selected);
      }
    }
    for (const child of node.children) visit(child, [...ancestors, node]);
  };
  for (const root of tree.roots) visit(root, []);
  return matches;
}

function collectSemanticTargetKeys(
  node: SemanticPageTree['roots'][number],
  targetKeys: Set<string>,
): void {
  if (node.targetKey) targetKeys.add(node.targetKey);
  for (const child of node.children) collectSemanticTargetKeys(child, targetKeys);
}

function toElementRecord(generation: number, element: BrowserInteractiveElement): ElementRecord {
  return {
    ref: `browser-element:${generation}-${randomUUID().slice(0, 12)}`,
    nodeId: element.backendNodeId,
    backendNodeId: element.backendNodeId,
    tag: element.tag,
    role: element.attributes.role ?? element.type,
    type: element.type,
    selector: element.selector,
    text: element.text,
    rect: { ...element.boundingBox },
    ...(element.coordinateSpace ? { coordinateSpace: element.coordinateSpace } : {}),
    ...(element.isInteractable === undefined ? {} : { isInteractable: element.isInteractable }),
    ...(element.frameId ? { frameId: element.frameId } : {}),
    ...(element.commandSessionId ? { commandSessionId: element.commandSessionId } : {}),
    ...(element.frameOffset ? { frameOffset: { ...element.frameOffset } } : {}),
    ...(element.inputStrategy === 'focused-keyboard' ? { virtualEditor: true } : {}),
    attributes: { ...element.attributes },
  };
}

async function scanPageUnderstanding(session: SessionState): Promise<{
  elements: BrowserInteractiveElement[];
  semanticTree: SemanticPageTree | null;
}> {
  const rootElements = await session.cdpHelper.getInteractiveElements(session.commandSignal);
  const roots = [session.cdpHelper.getLastSemanticPageTree()].filter(
    (tree): tree is SemanticPageTree => tree !== null,
  );
  const elements = [...rootElements];
  const frames = session.transport.listAttachedFrames?.() ?? [];

  type FrameOffsetResolution = { offset?: { x: number; y: number } };
  const offsets = new Map<string, Promise<FrameOffsetResolution>>();
  const frameBySession = new Map(frames.map((frame) => [frame.sessionId, frame]));
  const resolveOffset = (frame: BrowserAttachedFrame): Promise<FrameOffsetResolution> => {
    const existing = offsets.get(frame.sessionId);
    if (existing) return existing;
    const pending = (async () => {
      const parentFrame = frame.parentSessionId
        ? frameBySession.get(frame.parentSessionId)
        : undefined;
      const parentResolution = parentFrame
        ? await resolveOffset(parentFrame)
        : { offset: { x: 0, y: 0 } };
      const parentOffset = parentResolution.offset;
      if (!parentOffset) return {};
      const owner = await session.transport
        .send<{
          backendNodeId?: number;
        }>(
          'DOM.getFrameOwner',
          { frameId: frame.frameId },
          frame.parentSessionId,
          commandOptions(session),
        )
        .catch((error): { backendNodeId?: number } => {
          if (isBrowserOperationInterruption(error)) throw error;
          return {};
        });
      if (owner.backendNodeId === undefined) return {};
      const box = await session.transport
        .send<{
          model?: { content?: number[]; border?: number[] };
        }>(
          'DOM.getBoxModel',
          { backendNodeId: owner.backendNodeId },
          frame.parentSessionId,
          commandOptions(session),
        )
        .catch((error): { model?: { content?: number[]; border?: number[] } } => {
          if (isBrowserOperationInterruption(error)) throw error;
          return {};
        });
      const quad = box.model?.content ?? box.model?.border;
      return quad && quad.length >= 8
        ? {
            offset: {
              x: parentOffset.x + Math.min(quad[0]!, quad[2]!, quad[4]!, quad[6]!),
              y: parentOffset.y + Math.min(quad[1]!, quad[3]!, quad[5]!, quad[7]!),
            },
          }
        : {};
    })();
    offsets.set(frame.sessionId, pending);
    return pending;
  };

  for (const frame of frames) {
    const scoped = new AttachedFrameTransport(session.transport, frame);
    const helper = new CDPHelper(scoped);
    const [frameElements, offsetResolution] = await Promise.all([
      helper.getInteractiveElements(session.commandSignal),
      resolveOffset(frame),
    ]);
    const offset = offsetResolution.offset;
    elements.push(
      ...frameElements.map((element) => ({
        ...element,
        frameId: element.frameId ?? frame.frameId,
        commandSessionId: frame.sessionId,
        // Browser Core currently has no action-time owner-chain remeasurement.
        // Preserve OOPIF DOM identity for focus/upload, but never advertise a
        // cached inspect-time offset as safe pointer coordinates.
        coordinateSpace: 'unavailable' as const,
        ...(offset ? { frameOffset: offset } : {}),
        boundingBox: {
          ...element.boundingBox,
          ...(offset
            ? {
                x: element.boundingBox.x + offset.x,
                y: element.boundingBox.y + offset.y,
              }
            : {}),
        },
      })),
    );
    const tree = helper.getLastSemanticPageTree();
    if (tree) roots.push(offset ? offsetSemanticTree(tree, offset) : tree);
  }
  elements.sort(compareBrowserSnapshotElements);
  elements.forEach((element, index) => {
    element.index = index;
  });
  return { elements, semanticTree: mergeSemanticTrees(roots) };
}

function commandOptions(session: SessionState): BrowserTransportCommandOptions {
  return {
    ...(session.commandSignal ? { signal: session.commandSignal } : {}),
    ...(session.commandTimeoutMs ? { timeoutMs: session.commandTimeoutMs } : {}),
  };
}

function offsetSemanticTree(
  tree: SemanticPageTree,
  offset: { x: number; y: number },
): SemanticPageTree {
  const adjust = (node: SemanticPageTree['roots'][number]): SemanticPageTree['roots'][number] => ({
    ...node,
    ...(node.rect
      ? { rect: { ...node.rect, x: node.rect.x + offset.x, y: node.rect.y + offset.y } }
      : {}),
    children: node.children.map(adjust),
  });
  return { ...tree, roots: tree.roots.map(adjust) };
}

function mergeSemanticTrees(trees: readonly SemanticPageTree[]): SemanticPageTree | null {
  if (trees.length === 0) return null;
  return {
    version: 1,
    roots: trees.flatMap((tree) => tree.roots),
    stats: {
      canonicalNodeCount: trees.reduce((sum, tree) => sum + tree.stats.canonicalNodeCount, 0),
      semanticNodeCount: trees.reduce((sum, tree) => sum + tree.stats.semanticNodeCount, 0),
      actionableCount: trees.reduce((sum, tree) => sum + tree.stats.actionableCount, 0),
      semanticOnlyCount: trees.reduce((sum, tree) => sum + tree.stats.semanticOnlyCount, 0),
      collapsedCount: trees.reduce((sum, tree) => sum + tree.stats.collapsedCount, 0),
    },
    truncated: trees.some((tree) => tree.truncated),
  };
}

class AttachedFrameTransport implements BrowserTransport {
  readonly sessionId: string;
  readonly downloadDirectory?: string;

  constructor(
    private readonly root: BrowserTransport,
    private readonly frame: BrowserAttachedFrame,
  ) {
    this.sessionId = frame.sessionId;
    this.downloadDirectory = root.downloadDirectory;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    options?: BrowserTransportCommandOptions,
  ): Promise<T> {
    return this.root.send<T>(method, params, sessionId ?? this.frame.sessionId, options);
  }

  async evaluate<T = unknown>(
    expression: string,
    options: BrowserEvaluateOptions = {},
  ): Promise<T> {
    const payload = await this.send<Record<string, unknown>>(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: options.awaitPromise ?? true,
        returnByValue: options.returnByValue ?? true,
        userGesture: options.userGesture ?? true,
      },
      undefined,
      options,
    );
    const exception = payload.exceptionDetails;
    if (exception && typeof exception === 'object') {
      throw new Error(describeCdpException(exception, 'Page evaluation failed'));
    }
    const remote = payload.result;
    if (!remote || typeof remote !== 'object') return undefined as T;
    const result = remote as Record<string, unknown>;
    if ('value' in result) return result.value as T;
    if (result.unserializableValue === 'undefined') return undefined as T;
    return result.description as T;
  }

  onEvent(listener: BrowserTransportEventListener): () => void {
    return this.root.onEvent((event) => {
      if (event.sessionId === this.frame.sessionId) listener(event);
    });
  }

  waitForEvent(
    method: string,
    timeoutMs = 5_000,
    options?: Pick<BrowserTransportCommandOptions, 'signal'>,
  ): Promise<unknown> {
    return new Promise((resolve) => {
      let done = false;
      const unsubscribe = this.onEvent((event) => {
        if (event.method === method) finish(event.params);
      });
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      const finish = (value: unknown): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onAbort);
        unsubscribe();
        resolve(value);
      };
      const onAbort = (): void => finish(undefined);
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      if (options?.signal?.aborted) onAbort();
    });
  }

  stopLoading(): Promise<void> {
    return this.send('Page.stopLoading').then(() => undefined);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function serializeSnapshotTree(
  tree: ReturnType<SessionState['cdpHelper']['getLastSemanticPageTree']>,
  elements: readonly ElementRecord[],
  allowedRefs: ReadonlySet<string> = new Set(elements.map((element) => element.ref)),
  frameRefs: ReadonlyMap<string, string> = new Map(),
): AgentSemanticTreePage {
  if (!tree) return { version: 1, roots: [], truncated: false };
  const refs = new Map<string, SemanticTargetRef>();
  for (const element of elements) {
    const frameId = element.frameId ?? 'main';
    refs.set(`${frameId}:${element.backendNodeId}`, {
      ref: element.ref,
      frameRef: frameRefs.get(frameId) ?? `browser-frame:${frameId}`,
    });
  }
  return serializeSemanticTreePage(tree, refs, allowedRefs, {
    maxNodes: 200,
    maxBytes: 12_000,
  });
}

function filterSemanticTree(tree: AgentSemanticTreePage, refs: Set<string>): AgentSemanticTreePage {
  const filter = (
    node: AgentSemanticTreePage['roots'][number],
  ): AgentSemanticTreePage['roots'][number] | undefined => {
    const children = (node.children ?? [])
      .map(filter)
      .filter((child): child is AgentSemanticTreePage['roots'][number] => child !== undefined);
    if (node.actionable && node.ref && !refs.has(node.ref) && children.length === 0) {
      return undefined;
    }
    if (!node.actionable && children.length === 0 && node.role !== 'document') return undefined;
    return { ...node, ...(children.length > 0 ? { children } : {}) };
  };
  return {
    ...tree,
    roots: tree.roots
      .map(filter)
      .filter((node): node is AgentSemanticTreePage['roots'][number] => node !== undefined),
  };
}
