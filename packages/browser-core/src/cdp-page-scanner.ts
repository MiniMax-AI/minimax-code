import type { BrowserFormState, InteractiveElement } from './browser-core-contracts.js';
import { buildSemanticPageTree, type SemanticPageTree } from './browser-semantic-tree.js';
import type { BrowserTransport } from './browser-transport.js';
import {
  BROWSER_TIMEOUTS,
  isBrowserOperationInterruption,
  throwIfAborted,
  withTimeout,
} from './operation-timeout.js';
import {
  exposedFormState,
  isCredentialControl,
  readSnapshotFormStates,
} from './browser-form-state.js';
import {
  CONTAINER_TAGS,
  INTERACTIVE_ROLES,
  INTERACTIVE_TAGS,
  REQUIRED_COMPUTED_STYLES,
  SKIP_TAGS,
  SVG_ELEMENTS,
  type AXNode,
  type DOMNode,
  type DOMSnapshotResult,
  type FormStateScanOptions,
  type SnapshotNode,
} from './cdp-helper-contracts.js';

export const DEFAULT_VIEWPORT = { width: 800, height: 600 };

type ScannerCommand = (
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<unknown>;

type JavaScriptFallbackElement = Omit<InteractiveElement, 'backendNodeId'> & {
  readonly backendNodeId?: number;
};

const browserInputDiagnosticLogger = {
  info(fields: Record<string, unknown>): void {
    if (process.env.MAVIS_BROWSER_DEBUG === '1') console.info(fields);
  },
};

function rethrowBrowserInterruption(error: unknown): void {
  if (isBrowserOperationInterruption(error)) throw error;
}

/**
 * Mature DOMSnapshot + DOM + AX + Runtime-listener page understanding.
 *
 * CDPHelper owns transport lifecycle and input primitives. This collaborator
 * owns only the page scan and semantic fusion algorithm so every provider uses
 * the same implementation without growing CDPHelper beyond the source-size gate.
 */
export class CDPPageScanner {
  private lastSemanticPageTree: SemanticPageTree | null = null;
  /** Set per scan; like the semantic tree, one scan owns the scanner at a time. */
  private collectFormState = false;
  private passwordFields: Set<number> | undefined;

  constructor(
    private readonly transport: BrowserTransport,
    private readonly ensurePageAttached: (signal?: AbortSignal) => Promise<boolean>,
    private readonly command: ScannerCommand,
  ) {}

  reset(): void {
    this.lastSemanticPageTree = null;
  }

  getLastSemanticPageTree(): SemanticPageTree | null {
    return this.lastSemanticPageTree;
  }

  private buildSemanticPageTreeSafely(
    input: Parameters<typeof buildSemanticPageTree>[0],
  ): SemanticPageTree | null {
    if (process.env.MAVIS_BROWSER_SEMANTIC_TREE_V1 === '0') return null;
    try {
      return buildSemanticPageTree(input);
    } catch (error) {
      console.warn('Failed to build browser semantic tree; keeping legacy ElementMap:', error);
      return null;
    }
  }

  private ensureAttached(signal?: AbortSignal): Promise<boolean> {
    return this.ensurePageAttached(signal);
  }

  private sendCommand(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = BROWSER_TIMEOUTS.cdpCommand,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.command(method, params, timeoutMs, signal);
  }

  private async resolveJavaScriptFallbackElements(
    elements: readonly JavaScriptFallbackElement[],
    signal: AbortSignal,
  ): Promise<InteractiveElement[]> {
    if (elements.length === 0) return [];
    const document = (await this.sendCommand(
      'DOM.getDocument',
      { depth: 0, pierce: true },
      BROWSER_TIMEOUTS.cdpCommand,
      signal,
    )) as { root?: { nodeId?: number } };
    const rootNodeId = document.root?.nodeId;
    if (!rootNodeId) return [];

    const resolved: InteractiveElement[] = [];
    for (const element of elements) {
      if (Number.isFinite(element.backendNodeId) && Number(element.backendNodeId) > 0) {
        resolved.push(element as InteractiveElement);
        continue;
      }
      if (!element.selector) continue;
      try {
        const match = (await this.sendCommand(
          'DOM.querySelectorAll',
          { nodeId: rootNodeId, selector: element.selector },
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        )) as { nodeIds?: number[] };
        if (match.nodeIds?.length !== 1) continue;
        const [nodeId] = match.nodeIds;
        if (!nodeId) continue;
        const description = (await this.sendCommand(
          'DOM.describeNode',
          { nodeId },
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        )) as { node?: { backendNodeId?: number } };
        const backendNodeId = description.node?.backendNodeId;
        if (!backendNodeId) continue;
        resolved.push({ ...element, backendNodeId });
      } catch (error) {
        rethrowBrowserInterruption(error);
      }
    }
    return resolved;
  }

  async scan(
    signal: AbortSignal,
    options: FormStateScanOptions = {},
  ): Promise<InteractiveElement[]> {
    throwIfAborted(signal);
    this.collectFormState = options.formState === true;
    this.passwordFields = options.passwordFields;
    const startedAt = Date.now();
    const logPhase = (phase: string, extra: Record<string, unknown> = {}) => {
      browserInputDiagnosticLogger.info({
        msg: '[EmbeddedBrowserOperation] cdp-scan-phase',
        phase,
        browserSessionId: this.transport.sessionId,
        durationMs: Date.now() - startedAt,
        ...extra,
      });
    };

    // 尝试连接 CDP，失败则静默返回
    logPhase('start');
    const attached = await this.ensureAttached(signal).catch((error) => {
      rethrowBrowserInterruption(error);
      return false;
    });
    if (!attached) return [];
    logPhase('attached');

    try {
      // 启用必要的 CDP 域
      await Promise.all([
        this.sendCommand('DOM.enable', undefined, BROWSER_TIMEOUTS.cdpCommand, signal).catch(
          (error) => {
            rethrowBrowserInterruption(error);
          },
        ),
        this.sendCommand(
          'DOMSnapshot.enable',
          undefined,
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        ).catch((error) => {
          rethrowBrowserInterruption(error);
        }),
        this.sendCommand(
          'Accessibility.enable',
          undefined,
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        ).catch((error) => {
          rethrowBrowserInterruption(error);
        }),
        this.sendCommand('Page.enable', undefined, BROWSER_TIMEOUTS.cdpCommand, signal).catch(
          (error) => {
            rethrowBrowserInterruption(error);
          },
        ),
      ]);
      throwIfAborted(signal);
      logPhase('domains-enabled');

      // 1. 并行获取三个数据源 + JS 事件监听器检测
      const [
        snapshotResult,
        domTreeResult,
        axTreeResult,
        jsListenerBackendIds,
        viewportInfo,
        snapshotToCssScale,
      ] = await Promise.all([
        // DOMSnapshot.captureSnapshot - 获取布局信息和计算样式
        this.captureSnapshot(signal).catch((e) => {
          rethrowBrowserInterruption(e);
          console.warn('Failed to capture snapshot:', e);
          return null;
        }),

        // DOM.getDocument - 获取完整 DOM 树
        this.sendCommand(
          'DOM.getDocument',
          { depth: -1, pierce: true },
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        ).catch((e) => {
          rethrowBrowserInterruption(e);
          console.warn('Failed to get DOM document:', e);
          return null;
        }) as Promise<{ root: DOMNode } | null>,

        // Accessibility.getFullAXTree - 获取可访问性树
        this.sendCommand(
          'Accessibility.getFullAXTree',
          undefined,
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        ).catch((e) => {
          rethrowBrowserInterruption(e);
          console.warn('Failed to get AX tree:', e);
          return null;
        }) as Promise<{ nodes: AXNode[] } | null>,

        // 检测 JS 事件监听器
        this.detectJSEventListeners(signal).catch((error) => {
          rethrowBrowserInterruption(error);
          return new Set<number>();
        }),

        // 获取视口信息（包含滚动信息）
        withTimeout(
          (commandSignal) =>
            this.transport.evaluate<{
              width: number;
              height: number;
              scrollX: number;
              scrollY: number;
              pageHeight: number;
              pageWidth: number;
            }>(
              `({
              width: window.innerWidth,
              height: window.innerHeight,
              scrollX: window.scrollX,
              scrollY: window.scrollY,
              pageHeight: Math.max(
                document.body.scrollHeight,
                document.documentElement.scrollHeight,
                document.body.offsetHeight,
                document.documentElement.offsetHeight
              ),
              pageWidth: Math.max(
                document.body.scrollWidth,
                document.documentElement.scrollWidth,
                document.body.offsetWidth,
                document.documentElement.offsetWidth
              )
            })`,
              {
                signal: commandSignal,
                timeoutMs: BROWSER_TIMEOUTS.cdpCommand,
              },
            ),
          BROWSER_TIMEOUTS.cdpCommand,
          'Browser viewport inspection',
          { signal },
        ).catch((error) => {
          rethrowBrowserInterruption(error);
          return {
            width: DEFAULT_VIEWPORT.width,
            height: DEFAULT_VIEWPORT.height,
            scrollX: 0,
            scrollY: 0,
            pageHeight: DEFAULT_VIEWPORT.height,
            pageWidth: DEFAULT_VIEWPORT.width,
          };
        }),

        // Electron/Chromium 的 DOMSnapshot layout 使用 legacy viewport 数值；换成 CSS viewport。
        this.getSnapshotToCssScale(signal).catch((error) => {
          rethrowBrowserInterruption(error);
          return 1;
        }),
      ]);
      throwIfAborted(signal);
      logPhase('sources-settled', {
        hasSnapshot: snapshotResult !== null,
        hasDomTree: domTreeResult !== null,
        axNodeCount: axTreeResult?.nodes?.length ?? 0,
        jsListenerCount: jsListenerBackendIds.size,
      });

      // 2. DOMSnapshot bounds 是各 Document 的文档坐标；统一 legacy 单位、滚动量和 viewport。
      const mainFrameId = domTreeResult?.root?.frameId ?? 'main';
      const snapshotLookup = this.buildSnapshotLookup(
        snapshotResult,
        mainFrameId,
        snapshotToCssScale,
        this.collectFormState,
      );

      // 3. 构建 AX tree lookup（backendDOMNodeId -> AX 节点）
      const axTreeLookup = new Map<number, AXNode>();
      if (axTreeResult?.nodes) {
        for (const node of axTreeResult.nodes) {
          if (node.backendDOMNodeId) {
            axTreeLookup.set(node.backendDOMNodeId, node);
          }
        }
      }

      // 4. 遍历 DOM 树，收集可交互元素
      const elements: InteractiveElement[] = [];
      const processedBackendIds = new Set<number>();

      if (domTreeResult?.root) {
        await this.traverseDOMTree(
          domTreeResult.root,
          elements,
          processedBackendIds,
          snapshotLookup,
          axTreeLookup,
          jsListenerBackendIds,
          viewportInfo,
          mainFrameId,
          [],
          signal,
        );
      }

      // 5. 如果 DOM 树遍历没有找到元素，使用 JavaScript 补充扫描
      if (elements.length === 0) {
        const jsElements = await this.scanInteractiveElementsViaJS(viewportInfo, signal);
        elements.push(...jsElements);
      }

      // 6. 按位置排序（从上到下，从左到右）
      elements.sort((a, b) => {
        const yDiff = a.boundingBox.y - b.boundingBox.y;
        if (Math.abs(yDiff) > 10) return yDiff;
        return a.boundingBox.x - b.boundingBox.x;
      });

      // 7. 重新分配索引
      elements.forEach((el, idx) => {
        el.index = idx;
      });

      this.lastSemanticPageTree = this.buildSemanticPageTreeSafely({
        mainFrameId,
        domRoot: domTreeResult?.root,
        axNodes: axTreeResult?.nodes ?? [],
        snapshotLookup,
        interactiveElements: elements,
      });
      logPhase('complete', { interactiveElementCount: elements.length });

      return elements;
    } catch (error) {
      rethrowBrowserInterruption(error);
      logPhase('primary-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      console.warn('Failed to get interactive elements:', error);
      // 降级到纯 JS 扫描
      try {
        const viewportInfo = await withTimeout(
          (commandSignal) =>
            this.transport.evaluate<{
              width: number;
              height: number;
              scrollX: number;
              scrollY: number;
            }>(
              `({
              width: window.innerWidth,
              height: window.innerHeight,
              scrollX: window.scrollX,
              scrollY: window.scrollY
            })`,
              {
                signal: commandSignal,
                timeoutMs: BROWSER_TIMEOUTS.cdpCommand,
              },
            ),
          BROWSER_TIMEOUTS.cdpCommand,
          'Browser viewport fallback inspection',
          { signal },
        ).catch((fallbackError) => {
          rethrowBrowserInterruption(fallbackError);
          return {
            width: DEFAULT_VIEWPORT.width,
            height: DEFAULT_VIEWPORT.height,
            scrollX: 0,
            scrollY: 0,
          };
        });
        throwIfAborted(signal);
        const elements = await this.scanInteractiveElementsViaJS(viewportInfo, signal);
        this.lastSemanticPageTree = this.buildSemanticPageTreeSafely({
          mainFrameId: 'main',
          interactiveElements: elements,
        });
        logPhase('fallback-complete', { interactiveElementCount: elements.length });
        return elements;
      } catch (fallbackError) {
        rethrowBrowserInterruption(fallbackError);
        logPhase('fallback-failed');
        return [];
      }
    }
  }

  /**
   * 使用 DOMSnapshot.captureSnapshot 获取页面快照
   */
  private async captureSnapshot(signal?: AbortSignal): Promise<DOMSnapshotResult | null> {
    const result = (await this.sendCommand(
      'DOMSnapshot.captureSnapshot',
      {
        computedStyles: REQUIRED_COMPUTED_STYLES,
        includePaintOrder: true,
        includeDOMRects: true,
        includeBlendedBackgroundColors: false,
        includeTextColorOpacities: false,
      },
      BROWSER_TIMEOUTS.cdpCommand,
      signal,
    )) as DOMSnapshotResult;

    return result;
  }

  /**
   * DOMSnapshot layout 与 Page.getLayoutMetrics 的 deprecated viewport 使用同一套 legacy
   * 数值。这里比较 legacy/CSS viewport 得到转换比例；它不是系统 devicePixelRatio。
   */
  private async getSnapshotToCssScale(signal?: AbortSignal): Promise<number> {
    try {
      const metrics = (await this.sendCommand(
        'Page.getLayoutMetrics',
        undefined,
        BROWSER_TIMEOUTS.cdpCommand,
        signal,
      )) as {
        visualViewport?: { clientWidth?: number };
        cssVisualViewport?: { clientWidth?: number };
      };
      const legacyWidth = Number(metrics.visualViewport?.clientWidth);
      const cssWidth = Number(metrics.cssVisualViewport?.clientWidth);
      if (legacyWidth > 0 && cssWidth > 0) {
        const scale = legacyWidth / cssWidth;
        if (Number.isFinite(scale) && scale > 0) return scale;
      }
    } catch (error) {
      rethrowBrowserInterruption(error);
      // captureSnapshot itself can still be used with the protocol default scale.
    }
    return 1;
  }

  /**
   * 构建 snapshot lookup（backendNodeId -> 布局信息）
   * @param snapshot DOMSnapshot 结果
   * @param mainFrameId 主 Frame CDP id
   */
  buildSnapshotLookup(
    snapshot: DOMSnapshotResult | null,
    mainFrameId: string,
    snapshotToCssScale = 1,
    collectFormState = false,
  ): Map<number, SnapshotNode> {
    const lookup = new Map<number, SnapshotNode>();
    if (!snapshot?.documents) return lookup;

    const strings = snapshot.strings || [];
    const scale =
      Number.isFinite(snapshotToCssScale) && snapshotToCssScale > 0 ? snapshotToCssScale : 1;

    for (let documentIndex = 0; documentIndex < snapshot.documents.length; documentIndex += 1) {
      const document = snapshot.documents[documentIndex];
      if (!document) continue;
      const nodes = document.nodes;
      const layout = document.layout;
      const documentFrameId =
        document.frameId !== undefined ? strings[document.frameId] : undefined;
      const isMainDocument =
        documentIndex === 0 || (documentFrameId !== undefined && documentFrameId === mainFrameId);
      const scrollOffsetX = Number.isFinite(document.scrollOffsetX)
        ? Number(document.scrollOffsetX)
        : 0;
      const scrollOffsetY = Number.isFinite(document.scrollOffsetY)
        ? Number(document.scrollOffsetY)
        : 0;
      const coordinateSpace = isMainDocument ? 'main-frame-viewport' : 'frame-local';

      if (!nodes?.backendNodeId) continue;
      const formStates = collectFormState ? readSnapshotFormStates(nodes, strings) : undefined;

      // 构建 nodeIndex -> layoutIndex 映射
      const layoutIndexMap = new Map<number, number>();
      if (layout?.nodeIndex) {
        for (let i = 0; i < layout.nodeIndex.length; i++) {
          const nodeIndex = layout.nodeIndex[i];
          if (nodeIndex !== undefined && !layoutIndexMap.has(nodeIndex)) {
            layoutIndexMap.set(nodeIndex, i);
          }
        }
      }

      // 遍历所有节点
      for (let i = 0; i < nodes.backendNodeId.length; i++) {
        const backendNodeId = nodes.backendNodeId[i];

        // 检查是否可点击
        let isClickable = false;
        if (nodes.isClickable?.index) {
          isClickable = nodes.isClickable.index.includes(i);
        }

        // 获取布局信息
        let bounds: { x: number; y: number; width: number; height: number } | null = null;
        const computedStyles: Record<string, string> = {};
        let paintOrder: number | null = null;

        const layoutIdx = layoutIndexMap.get(i);
        if (layoutIdx !== undefined && layout) {
          // 主文档先扣除同单位的滚动量，再以 legacy/CSS 比例换成主 Frame viewport CSS
          // 坐标；子文档仍是 frame-local，稍后通过 DOM.getContentQuads 换算。
          if (layout.bounds && layoutIdx < layout.bounds.length) {
            const b = layout.bounds[layoutIdx];
            if (b && b.length >= 4) {
              bounds = {
                x: (b[0]! - scrollOffsetX) / scale,
                y: (b[1]! - scrollOffsetY) / scale,
                width: b[2]! / scale,
                height: b[3]! / scale,
              };
            }
          }

          // 解析计算样式
          if (layout.styles && layoutIdx < layout.styles.length) {
            const styleIndices = layout.styles[layoutIdx];
            if (styleIndices) {
              for (let j = 0; j < styleIndices.length && j < REQUIRED_COMPUTED_STYLES.length; j++) {
                const styleIndex = styleIndices[j];
                const styleName = REQUIRED_COMPUTED_STYLES[j];
                if (
                  styleName !== undefined &&
                  styleIndex !== undefined &&
                  styleIndex >= 0 &&
                  styleIndex < strings.length
                ) {
                  computedStyles[styleName] = strings[styleIndex] ?? '';
                }
              }
            }
          }

          // 解析 paint order
          if (layout.paintOrders && layoutIdx < layout.paintOrders.length) {
            paintOrder = layout.paintOrders[layoutIdx] ?? null;
          }
        }

        if (backendNodeId === undefined) continue;
        const formState = formStates?.get(i);
        lookup.set(backendNodeId, {
          bounds,
          coordinateSpace,
          computedStyles,
          isClickable,
          paintOrder,
          frameId: documentFrameId || mainFrameId,
          ...(formState ? { formState } : {}),
        });
      }
    }

    return lookup;
  }

  /**
   * DOM.getContentQuads 返回相对 viewport 的 CSS quad，可将子 Frame 元素可靠映射到
   * 主 Frame viewport。多个 fragment 取联合包围盒；协议失败时由调用方 fail closed。
   */
  async getViewportBoundsByBackendNodeId(
    backendNodeId: number,
    signal?: AbortSignal,
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    try {
      const result = (await this.sendCommand(
        'DOM.getContentQuads',
        { backendNodeId },
        BROWSER_TIMEOUTS.cdpCommand,
        signal,
      )) as { quads?: number[][] };
      const coordinates = (result.quads ?? [])
        .filter((quad) => Array.isArray(quad) && quad.length >= 8)
        .flatMap((quad) => quad.slice(0, 8));
      if (coordinates.length < 8 || coordinates.some((value) => !Number.isFinite(value))) {
        return null;
      }
      const xs = coordinates.filter((_, index) => index % 2 === 0);
      const ys = coordinates.filter((_, index) => index % 2 === 1);
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      const top = Math.min(...ys);
      const bottom = Math.max(...ys);
      if (right <= left || bottom <= top) return null;
      return { x: left, y: top, width: right - left, height: bottom - top };
    } catch (error) {
      rethrowBrowserInterruption(error);
      return null;
    }
  }

  /**
   * 检测 JavaScript 事件监听器
   * 使用 CDP 的 getEventListeners API（需要 includeCommandLineAPI）
   */
  private async detectJSEventListeners(signal?: AbortSignal): Promise<Set<number>> {
    const backendIds = new Set<number>();

    try {
      // 使用 Runtime.evaluate 配合 includeCommandLineAPI 来访问 getEventListeners
      const result = (await this.sendCommand(
        'Runtime.evaluate',
        {
          expression: `
          (function() {
            if (typeof getEventListeners !== 'function') {
              return null;
            }

            const elementsWithListeners = new Set();
            const allElements = document.querySelectorAll('*');
            const explicitCandidateSelector = [
              'button', 'a[href]', 'input', 'textarea', 'select',
              '[role]', '[tabindex]', '[contenteditable="true"]',
              '[data-action]', '[data-command]', '[data-testid]'
            ].join(',');
            const delegatedEventTypes = [
              'click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart'
            ];
            const genericLeafTags = new Set(['DIV', 'SPAN', 'LI', 'P']);
            const globalDelegationRoots = new Set([
              document.documentElement,
              document.body
            ]);

            const isVisibleCandidate = (candidate) => {
              const style = getComputedStyle(candidate);
              if (style.display === 'none' || style.visibility === 'hidden' ||
                  Number.parseFloat(style.opacity || '1') <= 0 ||
                  style.pointerEvents === 'none') return false;
              const rect = candidate.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            };

            const hasFrameworkActionSignal = (candidate) => {
              for (const attribute of candidate.attributes) {
                const name = attribute.name.toLowerCase();
                if (/^(?:onclick|onmousedown|onmouseup|ng-click|data-(?:action|command|click|event|handler))$/.test(name) ||
                    /^(?:@|v-on:|x-on:)click$/.test(name) ||
                    name.startsWith('hx-')) return true;
              }
              return false;
            };

            const isScopedDelegatedLeaf = (candidate, listenerRoot) => {
              if (globalDelegationRoots.has(listenerRoot) || !isVisibleCandidate(candidate)) {
                return false;
              }
              const style = getComputedStyle(candidate);
              if (style.cursor === 'pointer' || hasFrameworkActionSignal(candidate)) return true;
              if (!genericLeafTags.has(candidate.tagName) && !candidate.tagName.includes('-')) {
                return false;
              }
              const semanticText = (
                candidate.getAttribute('aria-label') ||
                candidate.getAttribute('title') ||
                candidate.textContent || ''
              ).trim();
              if (!semanticText) return false;
              return !Array.from(candidate.children).some((child) =>
                isVisibleCandidate(child) && (child.textContent || '').trim().length > 0
              );
            };

            const addCandidate = (candidate) => {
              if (elementsWithListeners.size < 500) elementsWithListeners.add(candidate);
            };

            for (const el of allElements) {
              try {
                const listeners = getEventListeners(el);
                if (delegatedEventTypes.some((type) => listeners[type]?.length)) {
                  const delegatedCandidates = new Set();
                  for (const candidate of el.querySelectorAll(explicitCandidateSelector)) {
                    if (isVisibleCandidate(candidate)) delegatedCandidates.add(candidate);
                  }
                  // A scoped delegation root often targets a plain div/span/li with
                  // no ARIA or framework-specific attribute. Promote visible,
                  // text-bearing leaves generically; never apply this broad signal to
                  // html/body because global delegation would turn page prose into
                  // controls.
                  for (const candidate of el.querySelectorAll('div,span,li,p,*')) {
                    if (isScopedDelegatedLeaf(candidate, el)) delegatedCandidates.add(candidate);
                    if (delegatedCandidates.size >= 200) break;
                  }
                  // Preserve direct listeners. When a scoped listener has concrete
                  // delegated descendants, do not expose the structural ancestor as
                  // a competing control.
                  if (delegatedCandidates.size === 0 ||
                      el.matches(explicitCandidateSelector) ||
                      getComputedStyle(el).cursor === 'pointer' ||
                      hasFrameworkActionSignal(el)) {
                    addCandidate(el);
                  }
                  for (const candidate of delegatedCandidates) {
                    addCandidate(candidate);
                    if (elementsWithListeners.size >= 500) break;
                  }
                }
              } catch (e) {
                // 忽略单个元素的错误
              }
            }

            return Array.from(elementsWithListeners);
          })()
        `,
          includeCommandLineAPI: true,
          returnByValue: false,
        },
        BROWSER_TIMEOUTS.cdpCommand,
        signal,
      )) as { result?: { objectId?: string } };

      const objectId = result?.result?.objectId;
      if (!objectId) return backendIds;

      // 获取数组属性
      const propsResult = (await this.sendCommand(
        'Runtime.getProperties',
        { objectId, ownProperties: true },
        BROWSER_TIMEOUTS.cdpCommand,
        signal,
      )) as { result?: Array<{ name: string; value?: { objectId?: string } }> };

      // 获取每个元素的 backendNodeId
      const elementObjectIds: string[] = [];
      for (const prop of propsResult.result || []) {
        if (prop.name && /^\d+$/.test(prop.name) && prop.value?.objectId) {
          elementObjectIds.push(prop.value.objectId);
        }
      }

      // 并行获取 backendNodeId
      const nodePromises = elementObjectIds.map(async (objId) => {
        try {
          const nodeInfo = (await this.sendCommand(
            'DOM.describeNode',
            { objectId: objId },
            BROWSER_TIMEOUTS.cdpCommand,
            signal,
          )) as { node?: { backendNodeId?: number } };
          return nodeInfo?.node?.backendNodeId;
        } catch (error) {
          rethrowBrowserInterruption(error);
          return undefined;
        }
      });

      const nodeIds = await Promise.all(nodePromises);
      for (const id of nodeIds) {
        if (id !== undefined) {
          backendIds.add(id);
        }
      }

      // 释放对象
      try {
        await this.sendCommand(
          'Runtime.releaseObject',
          { objectId },
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        );
      } catch (error) {
        rethrowBrowserInterruption(error);
        // 忽略释放错误
      }
    } catch (error) {
      rethrowBrowserInterruption(error);
      console.warn('Failed to detect JS event listeners:', error);
    }

    return backendIds;
  }

  /**
   * 遍历 DOM 树，收集可交互元素
   */
  private axBooleanProperty(axNode: AXNode | undefined, name: string): boolean {
    return (
      axNode?.properties?.some(
        (property) => property.name === name && property.value?.value === true,
      ) === true
    );
  }

  private axHasEnabledProperty(axNode: AXNode | undefined, name: string): boolean {
    return (
      axNode?.properties?.some(
        (property) => property.name === name && property.value?.value !== false,
      ) === true
    );
  }

  private isVirtualEditorProxy(node: DOMNode, axNode: AXNode | undefined): boolean {
    const tagName = node.nodeName?.toLowerCase() || '';
    const inputType = this.getNodeAttribute(node, 'type')?.toLowerCase() || '';
    const role = (axNode?.role?.value || this.getNodeAttribute(node, 'role') || '').toLowerCase();
    const editableNode =
      tagName === 'textarea' ||
      (tagName === 'input' && inputType !== 'hidden') ||
      this.getNodeAttribute(node, 'contenteditable') === 'true';
    return (
      editableNode &&
      (role === 'textbox' || role === 'searchbox') &&
      (this.axBooleanProperty(axNode, 'focused') ||
        (this.axBooleanProperty(axNode, 'focusable') &&
          (this.axHasEnabledProperty(axNode, 'editable') ||
            this.axBooleanProperty(axNode, 'settable'))))
    );
  }

  private findVisibleVirtualEditorHost(
    ancestors: readonly DOMNode[],
    snapshotLookup: Map<number, SnapshotNode>,
    viewportInfo: { width: number; height: number; scrollX: number; scrollY: number },
    frameId: string,
  ): { node: DOMNode; snapshotNode: SnapshotNode } | null {
    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
      const candidate = ancestors[index];
      if (!candidate) continue;
      const tagName = candidate.nodeName?.toLowerCase() || '';
      if (
        candidate.nodeType !== 1 ||
        CONTAINER_TAGS.has(tagName) ||
        (candidate.frameId && candidate.frameId !== frameId)
      ) {
        continue;
      }
      const snapshotNode = snapshotLookup.get(candidate.backendNodeId);
      if (
        this.isElementVisible(snapshotNode, viewportInfo) &&
        snapshotNode?.bounds &&
        snapshotNode.bounds.width >= 16 &&
        snapshotNode.bounds.height >= 16
      ) {
        return { node: candidate, snapshotNode };
      }
    }
    return null;
  }

  private createVirtualEditorElement(
    proxyNode: DOMNode,
    hostNode: DOMNode,
    hostSnapshotNode: SnapshotNode,
    axNode: AXNode,
    viewportInfo: { width: number; height: number; scrollX: number; scrollY: number },
    index: number,
    frameId: string,
  ): InteractiveElement | null {
    const element = this.createInteractiveElement(
      proxyNode,
      hostSnapshotNode,
      axNode,
      viewportInfo,
      index,
      frameId,
    );
    if (!element) return null;
    return {
      ...element,
      backendNodeId: hostNode.backendNodeId,
      semanticBackendNodeId: proxyNode.backendNodeId,
      selector: `[data-backend-node-id="${hostNode.backendNodeId}"]`,
      inputStrategy: 'focused-keyboard',
    };
  }

  async traverseDOMTree(
    node: DOMNode,
    elements: InteractiveElement[],
    processedBackendIds: Set<number>,
    snapshotLookup: Map<number, SnapshotNode>,
    axTreeLookup: Map<number, AXNode>,
    jsListenerBackendIds: Set<number>,
    viewportInfo: { width: number; height: number; scrollX: number; scrollY: number },
    frameId: string,
    ancestors: readonly DOMNode[] = [],
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    // 跳过已处理的节点
    if (processedBackendIds.has(node.backendNodeId)) return;
    processedBackendIds.add(node.backendNodeId);

    const tagName = node.nodeName?.toLowerCase() || '';

    // 跳过文本节点和注释节点（nodeType: 1=Element, 3=Text, 8=Comment）
    if (node.nodeType === 3 || node.nodeType === 8) {
      return;
    }

    // 完全跳过的标签（不处理本身，也不递归子节点）
    if (SKIP_TAGS.has(tagName) || SVG_ELEMENTS.has(tagName)) {
      return;
    }

    // Runtime listener discovery can promote a custom div/section out of the
    // structural-container bucket. This is required for direct and delegated
    // application controls that have no native tag/role/tabindex signal.
    const hasJSEventListener = jsListenerBackendIds.has(node.backendNodeId);
    const isContainer = CONTAINER_TAGS.has(tagName) && !hasJSEventListener;

    if (!isContainer) {
      // 获取快照信息
      let snapshotNode = snapshotLookup.get(node.backendNodeId);

      // 获取 AX 节点信息
      const axNode = axTreeLookup.get(node.backendNodeId);

      // 检查元素是否可交互
      const isInteractive = this.isElementInteractive(
        node,
        snapshotNode,
        axNode,
        hasJSEventListener,
      );

      // 只为最终可交互的子 Frame 节点调用额外的 CDP quad 查询，避免逐 DOM 节点 round-trip。
      if (isInteractive && snapshotNode?.coordinateSpace === 'frame-local') {
        const viewportBounds = await this.getViewportBoundsByBackendNodeId(
          node.backendNodeId,
          signal,
        );
        snapshotNode = viewportBounds
          ? {
              ...snapshotNode,
              bounds: viewportBounds,
              coordinateSpace: 'main-frame-viewport',
            }
          : {
              ...snapshotNode,
              coordinateSpace: 'unavailable',
            };
      }

      // 检查元素是否可见
      const isVisible = this.isElementVisible(snapshotNode, viewportInfo);

      // 如果可见且可交互，添加到结果
      if (isVisible && isInteractive) {
        const element = this.createInteractiveElement(
          node,
          snapshotNode,
          axNode,
          viewportInfo,
          elements.length,
          node.frameId ?? frameId,
          hasJSEventListener,
        );
        if (element) {
          elements.push(element);
        }
      } else if (isInteractive && axNode && this.isVirtualEditorProxy(node, axNode)) {
        const host = this.findVisibleVirtualEditorHost(
          ancestors,
          snapshotLookup,
          viewportInfo,
          node.frameId ?? frameId,
        );
        if (host) {
          let hostSnapshotNode = host.snapshotNode;
          if (hostSnapshotNode.coordinateSpace === 'frame-local') {
            const viewportBounds = await this.getViewportBoundsByBackendNodeId(
              host.node.backendNodeId,
              signal,
            );
            hostSnapshotNode = viewportBounds
              ? {
                  ...hostSnapshotNode,
                  bounds: viewportBounds,
                  coordinateSpace: 'main-frame-viewport',
                }
              : {
                  ...hostSnapshotNode,
                  coordinateSpace: 'unavailable',
                };
          }
          const existingIndex = elements.findIndex(
            (element) => element.backendNodeId === host.node.backendNodeId,
          );
          const element = this.createVirtualEditorElement(
            node,
            host.node,
            hostSnapshotNode,
            axNode,
            viewportInfo,
            existingIndex >= 0 ? existingIndex : elements.length,
            node.frameId ?? frameId,
          );
          if (element) {
            if (existingIndex >= 0) elements[existingIndex] = element;
            else elements.push(element);
          }
        }
      }
    }

    // 递归处理子节点
    if (node.children) {
      for (const child of node.children) {
        await this.traverseDOMTree(
          child,
          elements,
          processedBackendIds,
          snapshotLookup,
          axTreeLookup,
          jsListenerBackendIds,
          viewportInfo,
          child.frameId ?? frameId,
          [...ancestors, node],
          signal,
        );
      }
    }

    // 处理 shadow DOM
    if (node.shadowRoots) {
      for (const shadowRoot of node.shadowRoots) {
        await this.traverseDOMTree(
          shadowRoot,
          elements,
          processedBackendIds,
          snapshotLookup,
          axTreeLookup,
          jsListenerBackendIds,
          viewportInfo,
          shadowRoot.frameId ?? frameId,
          [...ancestors, node],
          signal,
        );
      }
    }

    // 处理 iframe 的 contentDocument
    if (node.contentDocument) {
      await this.traverseDOMTree(
        node.contentDocument,
        elements,
        processedBackendIds,
        snapshotLookup,
        axTreeLookup,
        jsListenerBackendIds,
        viewportInfo,
        node.contentDocument.frameId ?? node.frameId ?? frameId,
        [],
        signal,
      );
    }
  }

  /**
   * 检查元素是否可见
   */
  isElementVisible(
    snapshotNode: SnapshotNode | undefined,
    viewportInfo: { width: number; height: number; scrollX: number; scrollY: number },
  ): boolean {
    if (!snapshotNode?.bounds) return false;

    const { bounds, computedStyles } = snapshotNode;

    // 检查尺寸
    if (bounds.width <= 0 || bounds.height <= 0) return false;

    // 检查 CSS 可见性
    const display = computedStyles.display?.toLowerCase();
    const visibility = computedStyles.visibility?.toLowerCase();
    const opacity = computedStyles.opacity;

    if (display === 'none') return false;
    if (visibility === 'hidden') return false;
    if (opacity !== undefined) {
      const opacityValue = parseFloat(opacity);
      if (!isNaN(opacityValue) && opacityValue <= 0) return false;
    }

    // 保留无法换算坐标的子 Frame ref，但后续不会向模型暴露 rect。
    if (snapshotNode.coordinateSpace === 'unavailable') return true;

    // 检查是否在视口内（允许一定的阈值）
    const threshold = 1000; // 允许视口外 1000px 的元素
    const viewportRight = viewportInfo.width;
    // Keep vertically offscreen controls discoverable so the Core can scroll
    // them into view. Horizontally detached nodes are commonly focus traps or
    // hidden editor proxies and must remain excluded.
    const isInActionableDocument =
      bounds.x < viewportRight + threshold &&
      bounds.x + bounds.width > -threshold &&
      bounds.y + bounds.height > -threshold;

    return isInActionableDocument;
  }

  /**
   * 搜索相关的关键词（参考 browser-use）
   */
  private static readonly SEARCH_INDICATORS = new Set([
    'search',
    'magnify',
    'glass',
    'lookup',
    'find',
    'query',
    'search-icon',
    'search-btn',
    'search-button',
    'searchbox',
  ]);

  /**
   * 检查元素是否是搜索相关元素
   */
  private isSearchElement(node: DOMNode): boolean {
    // 检查 class
    const className = this.getNodeAttribute(node, 'class')?.toLowerCase() || '';
    const classList = className.split(/\s+/);
    for (const cls of classList) {
      for (const indicator of CDPPageScanner.SEARCH_INDICATORS) {
        if (cls.includes(indicator)) return true;
      }
    }

    // 检查 id
    const id = this.getNodeAttribute(node, 'id')?.toLowerCase() || '';
    for (const indicator of CDPPageScanner.SEARCH_INDICATORS) {
      if (id.includes(indicator)) return true;
    }

    // 检查 data 属性
    if (node.attributes) {
      for (let i = 0; i < node.attributes.length; i += 2) {
        const attrName = node.attributes[i];
        const attrValue = node.attributes[i + 1]?.toLowerCase() || '';
        if (attrName?.startsWith('data-')) {
          for (const indicator of CDPPageScanner.SEARCH_INDICATORS) {
            if (attrValue.includes(indicator)) return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * 检查元素是否是可交互的图标（10-50px 大小的小元素）
   */
  private isInteractiveIcon(node: DOMNode, snapshotNode: SnapshotNode | undefined): boolean {
    if (!snapshotNode?.bounds) return false;

    const { width, height } = snapshotNode.bounds;

    // 检查是否是图标大小（10-50px）
    if (width < 10 || width > 50 || height < 10 || height > 50) {
      return false;
    }

    // 检查是否有交互相关的属性
    const hasInteractiveAttr =
      this.getNodeAttribute(node, 'class') !== null ||
      this.getNodeAttribute(node, 'role') !== null ||
      this.getNodeAttribute(node, 'onclick') !== null ||
      this.getNodeAttribute(node, 'data-action') !== null ||
      this.getNodeAttribute(node, 'aria-label') !== null;

    return hasInteractiveAttr;
  }

  /**
   * Some rich editors expose only a visible activation surface until the first click. The real
   * input/contenteditable is mounted or focused afterwards. Keep this signal narrow: the surface
   * must explicitly render a text cursor and carry a semantic name; execution still fails closed
   * unless clicking it produces an editable focus inside the surface.
   */
  private isTextEntryActivationSurface(
    node: DOMNode,
    snapshotNode: SnapshotNode | undefined,
    axNode: AXNode | undefined,
  ): boolean {
    const tagName = node.nodeName?.toLowerCase() || '';
    if (tagName !== 'div' && tagName !== 'span') return false;
    if (snapshotNode?.computedStyles?.cursor !== 'text') return false;

    const role = (axNode?.role?.value || this.getNodeAttribute(node, 'role') || '').toLowerCase();
    if (role && role !== 'generic' && role !== 'none' && role !== 'textbox') return false;

    const semanticName =
      axNode?.name?.value ||
      this.getNodeAttribute(node, 'aria-label') ||
      this.getNodeAttribute(node, 'title') ||
      this.getNodeAttribute(node, 'placeholder') ||
      '';
    return semanticName.trim().length > 0;
  }

  /**
   * 检查元素是否可交互（参考 browser-use 的 ClickableElementDetector）
   */
  isElementInteractive(
    node: DOMNode,
    snapshotNode: SnapshotNode | undefined,
    axNode: AXNode | undefined,
    hasJSClickListener: boolean,
  ): boolean {
    const tagName = node.nodeName?.toLowerCase() || '';

    // 0. 排除文本节点和非元素节点
    if (tagName === '#text' || tagName === '#comment' || node.nodeType !== 1) {
      return false;
    }

    // 1. 检查 JS 事件监听器（最高优先级）
    if (hasJSClickListener) return true;

    // 1.1 AX ignored only means the accessibility tree does not expose the
    // node; it cannot override positive Runtime listener evidence above.
    if (axNode?.ignored) return false;

    // 2. 检查原生可交互标签
    if (INTERACTIVE_TAGS.has(tagName)) return true;

    // 3. 检查 ARIA role
    const role = this.getNodeAttribute(node, 'role')?.toLowerCase();
    if (role && INTERACTIVE_ROLES.has(role)) return true;

    // 4. 检查 AX tree role（排除 generic 和 none）
    if (axNode?.role?.value) {
      const axRole = axNode.role.value.toLowerCase();
      // generic 和 none 不是真正的可交互 role
      if (axRole !== 'generic' && axRole !== 'none' && INTERACTIVE_ROLES.has(axRole)) {
        return true;
      }
    }

    // 5. 检查 contenteditable
    if (this.getNodeAttribute(node, 'contenteditable') === 'true') return true;

    // 6. 检查 tabindex（非 -1）
    const tabindex = this.getNodeAttribute(node, 'tabindex');
    if (tabindex !== null && tabindex !== '-1') return true;

    // 7. 检查 onclick 等事件属性
    const eventAttrs = [
      'onclick',
      'onmousedown',
      'onmouseup',
      'onkeydown',
      'onkeyup',
      'ontouchstart',
    ];
    for (const attr of eventAttrs) {
      if (this.getNodeAttribute(node, attr) !== null) return true;
    }

    // 8. 检查搜索元素（参考 browser-use）
    if (this.isSearchElement(node)) return true;

    // 9. 检查可交互图标（10-50px 小元素）
    if (this.isInteractiveIcon(node, snapshotNode)) return true;

    // 9.1 检查点击后才挂载/聚焦真实输入代理的富文本编辑器表面。
    if (
      this.isTextEntryActivationSurface(node, snapshotNode, axNode) &&
      (snapshotNode?.isClickable === true ||
        this.axBooleanProperty(axNode, 'focusable') ||
        this.getNodeAttribute(node, 'tabindex') !== null)
    ) {
      return true;
    }

    // 10. 检查 cursor: pointer 样式（但需要有其他交互信号）
    const hasCursorPointer = snapshotNode?.computedStyles?.cursor === 'pointer';

    // 11. 检查 snapshot 的 isClickable 标志
    // 注意：isClickable 可能误报，需要结合其他信号
    const isClickable = snapshotNode?.isClickable === true;

    // 12. 检查 AX 属性
    let hasInteractiveAxProp = false;
    if (axNode?.properties) {
      for (const prop of axNode.properties) {
        // 可编辑、可设置（不包括 focusable，因为很多元素都是 focusable）
        if (['editable', 'settable'].includes(prop.name) && prop.value?.value === true) {
          hasInteractiveAxProp = true;
          break;
        }
        // 交互状态属性（存在即表示可交互）
        if (['checked', 'expanded', 'pressed', 'selected'].includes(prop.name)) {
          hasInteractiveAxProp = true;
          break;
        }
      }
    }

    // 对于 div/span 等通用元素，需要多个信号才认为是可交互的
    if (tagName === 'div' || tagName === 'span') {
      // 需要至少两个信号，或者有明确的交互属性
      const signals = [hasCursorPointer, isClickable, hasInteractiveAxProp].filter(Boolean).length;
      if (signals >= 2 || hasInteractiveAxProp) {
        return true;
      }
      return false;
    }

    // 其他元素，有任一信号即可
    if (hasCursorPointer || isClickable || hasInteractiveAxProp) {
      return true;
    }

    // 13. 检查 label 包含表单控件
    if (tagName === 'label') {
      // 跳过有 for 属性的 label（避免重复）
      if (this.getNodeAttribute(node, 'for')) return false;
      if (this.hasFormControlDescendant(node)) return true;
    }

    // 14. 检查 iframe（大于 100x100 的 iframe 可能需要交互）
    if ((tagName === 'iframe' || tagName === 'frame') && snapshotNode?.bounds) {
      if (snapshotNode.bounds.width > 100 && snapshotNode.bounds.height > 100) {
        return true;
      }
    }

    return false;
  }

  /**
   * 获取节点属性
   */
  private getNodeAttribute(node: DOMNode, name: string): string | null {
    if (!node.attributes) return null;
    for (let i = 0; i < node.attributes.length; i += 2) {
      if (node.attributes[i] === name) {
        return node.attributes[i + 1] || '';
      }
    }
    return null;
  }

  /**
   * 检查节点是否包含表单控件子元素
   */
  private hasFormControlDescendant(node: DOMNode, maxDepth = 2): boolean {
    if (maxDepth <= 0) return false;
    if (!node.children) return false;

    for (const child of node.children) {
      const tag = child.nodeName?.toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        return true;
      }
      if (this.hasFormControlDescendant(child, maxDepth - 1)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 创建可交互元素对象
   */
  private createInteractiveElement(
    node: DOMNode,
    snapshotNode: SnapshotNode | undefined,
    axNode: AXNode | undefined,
    viewportInfo: { width: number; height: number; scrollX: number; scrollY: number },
    index: number,
    frameId: string,
    runtimeDiscovered = false,
  ): InteractiveElement | null {
    const bounds = snapshotNode?.bounds;
    if (!bounds) return null;

    const tagName = node.nodeName?.toLowerCase() || '';

    const textEntryActivationSurface = this.isTextEntryActivationSurface(
      node,
      snapshotNode,
      axNode,
    );

    // 获取元素类型
    let type = tagName;
    if (textEntryActivationSurface) {
      type = 'textbox';
    } else if (axNode?.role?.value) {
      type = axNode.role.value.toLowerCase();
    } else {
      const role = this.getNodeAttribute(node, 'role');
      if (role) type = role.toLowerCase();
    }
    // 获取元素文本
    let text = '';
    if (axNode?.name?.value) {
      text = axNode.name.value;
    } else {
      text =
        this.getNodeAttribute(node, 'aria-label') ||
        this.getNodeAttribute(node, 'title') ||
        this.getNodeAttribute(node, 'placeholder') ||
        this.getNodeAttribute(node, 'alt') ||
        '';
    }
    if (!text && runtimeDiscovered) text = this.getDescendantText(node);
    text = text.slice(0, 100).trim();

    // 过滤空的 generic 元素（没有文本、没有有意义的属性）
    // 这些通常是容器 div，对 LLM 没有交互价值
    if (!runtimeDiscovered && (type === 'generic' || type === 'none') && !text) {
      // 检查是否有有意义的属性
      const meaningfulAttrs = [
        'aria-label',
        'title',
        'data-testid',
        'data-action',
        'onclick',
        'tabindex',
        'draggable',
      ];
      const hasMeaningfulAttr = meaningfulAttrs.some(
        (attr) => this.getNodeAttribute(node, attr) !== null,
      );

      // 检查是否是小尺寸元素（可能是图标按钮）
      const isSmallElement = bounds.width <= 60 && bounds.height <= 60;

      // 如果没有有意义的属性，且不是小元素，则过滤掉
      if (!hasMeaningfulAttr && !isSmallElement) {
        return null;
      }
    }

    // 生成选择器（优先使用 backendNodeId）
    const selector = `[data-backend-node-id="${node.backendNodeId}"]`;

    // 计算归一化坐标
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const hasViewportCoordinates = snapshotNode?.coordinateSpace === 'main-frame-viewport';
    const normalizedX = hasViewportCoordinates
      ? Math.round((centerX / viewportInfo.width) * 1000) / 1000
      : 0;
    const normalizedY = hasViewportCoordinates
      ? Math.round((centerY / viewportInfo.height) * 1000) / 1000
      : 0;

    // 检查是否在视口内
    const isInViewport =
      hasViewportCoordinates &&
      bounds.y < viewportInfo.height &&
      bounds.y + bounds.height > 0 &&
      bounds.x < viewportInfo.width &&
      bounds.x + bounds.width > 0;

    // 收集属性
    const attributes: Record<string, string> = {};
    const attrNames = [
      'id',
      'class',
      'data-testid',
      'data-action',
      'href',
      'src',
      'placeholder',
      'value',
      'aria-label',
      'aria-expanded',
      'aria-selected',
      'aria-checked',
      'aria-pressed',
      'type',
      'target',
      'name',
      'role',
      'contenteditable',
      'tabindex',
      'draggable',
    ];
    for (const attrName of attrNames) {
      const val = this.getNodeAttribute(node, attrName);
      if (val) attributes[attrName] = val;
    }

    // 检查是否禁用
    const isDisabled =
      this.getNodeAttribute(node, 'disabled') !== null ||
      this.getNodeAttribute(node, 'aria-disabled') === 'true';
    let formState: BrowserFormState | undefined;
    if (this.collectFormState) {
      const inputType = this.getNodeAttribute(node, 'type');
      if (tagName.toLowerCase() === 'input' && inputType?.trim().toLowerCase() === 'password') {
        this.passwordFields?.add(node.backendNodeId);
      }
      const credential = isCredentialControl({
        tag: tagName,
        type: inputType,
        name: this.getNodeAttribute(node, 'name'),
        id: this.getNodeAttribute(node, 'id'),
        autocomplete: this.getNodeAttribute(node, 'autocomplete'),
        observedAsPassword: this.passwordFields?.has(node.backendNodeId) === true,
      });
      // A credential shows neither its live value nor its serialized default.
      if (credential) delete attributes.value;
      formState = exposedFormState(tagName, inputType, credential, snapshotNode?.formState);
    }

    return {
      index,
      backendNodeId: node.backendNodeId,
      frameId,
      selector,
      tag: tagName,
      type,
      text,
      normalizedPosition: { x: normalizedX, y: normalizedY },
      boundingBox: {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      },
      coordinateSpace: hasViewportCoordinates ? 'main-frame-viewport' : 'unavailable',
      isInViewport,
      isInteractable: !isDisabled,
      attributes,
      paintOrder: snapshotNode?.paintOrder ?? undefined,
      ...(textEntryActivationSurface ? { inputStrategy: 'focused-keyboard' as const } : {}),
      ...(formState ? { formState } : {}),
    };
  }

  private getDescendantText(node: DOMNode): string {
    let text = '';
    const visit = (current: DOMNode): void => {
      if (text.length >= 200) return;
      if (current.nodeType === 3 && current.nodeValue) text += ` ${current.nodeValue}`;
      for (const child of current.children ?? []) visit(child);
      for (const shadowRoot of current.shadowRoots ?? []) visit(shadowRoot);
    };
    visit(node);
    return text.replace(/\s+/gu, ' ').trim();
  }

  /**
   * 生成唯一选择器
   */
  private generateSelector(node: DOMNode): string {
    const tagName = node.nodeName?.toLowerCase() || 'div';

    // 优先使用 id
    const id = this.getNodeAttribute(node, 'id');
    if (id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) {
      return `#${id}`;
    }

    // 使用 data-testid
    const testId = this.getNodeAttribute(node, 'data-testid');
    if (testId) {
      return `[data-testid="${testId}"]`;
    }

    // 使用 aria-label
    const ariaLabel = this.getNodeAttribute(node, 'aria-label');
    if (ariaLabel) {
      return `${tagName}[aria-label="${ariaLabel.replace(/[\\"]/g, '\\$&')}"]`;
    }

    // 使用 name
    const name = this.getNodeAttribute(node, 'name');
    if (name) {
      return `${tagName}[name="${name}"]`;
    }

    // 使用 backendNodeId 作为后备
    return `[data-backend-node-id="${node.backendNodeId}"]`;
  }

  /**
   * 通过 JavaScript 扫描可交互元素（降级方案）
   * 当 CDP 方法失败时使用
   */
  private async scanInteractiveElementsViaJS(
    _viewportInfo: {
      width: number;
      height: number;
      scrollX: number;
      scrollY: number;
    },
    signal: AbortSignal,
  ): Promise<InteractiveElement[]> {
    try {
      const elements = (await withTimeout(
        (commandSignal) =>
          this.transport.evaluate(
            `
        (function() {
          const viewportWidth = window.innerWidth;
          const viewportHeight = window.innerHeight;
          const elements = [];
          const processedElements = new WeakSet();

          // 生成唯一选择器
          function getUniqueSelector(el) {
            if (el.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(el.id)) {
              const selector = '#' + CSS.escape(el.id);
              if (document.querySelectorAll(selector).length === 1) return selector;
            }
            if (el.dataset.testid) {
              const selector = '[data-testid="' + CSS.escape(el.dataset.testid) + '"]';
              if (document.querySelectorAll(selector).length === 1) return selector;
            }
            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel) {
              const tag = el.tagName.toLowerCase();
              const selector = tag + '[aria-label="' + CSS.escape(ariaLabel) + '"]';
              if (document.querySelectorAll(selector).length === 1) return selector;
            }
            if (el.name) {
              const tag = el.tagName.toLowerCase();
              const selector = tag + '[name="' + CSS.escape(el.name) + '"]';
              if (document.querySelectorAll(selector).length === 1) return selector;
            }
            // 构建路径选择器
            const path = [];
            let current = el;
            while (current && current !== document.body && path.length < 4) {
              let sel = current.tagName.toLowerCase();
              if (current.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(current.id)) {
                path.unshift('#' + CSS.escape(current.id));
                break;
              }
              const parent = current.parentElement;
              if (parent) {
                const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
                if (siblings.length > 1) {
                  sel += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
                }
              }
              path.unshift(sel);
              current = current.parentElement;
            }
            return path.join(' > ');
          }

          // 获取元素文本
          function getElementText(el) {
            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel) return ariaLabel.trim().slice(0, 100);
            const title = el.getAttribute('title');
            if (title) return title.trim().slice(0, 100);
            const placeholder = el.getAttribute('placeholder');
            if (placeholder) return placeholder.trim().slice(0, 100);
            const text = el.innerText?.trim();
            if (text) return text.slice(0, 100);
            if (el.tagName === 'IMG') return el.alt?.trim().slice(0, 100) || '';
            return '';
          }

          // 检测表单控件嵌套
          function hasFormControlDescendant(el, maxDepth = 2) {
            if (maxDepth <= 0) return false;
            for (const child of el.children) {
              const tag = child.tagName.toLowerCase();
              if (tag === 'input' || tag === 'select' || tag === 'textarea') return true;
              if (hasFormControlDescendant(child, maxDepth - 1)) return true;
            }
            return false;
          }

          // 判断元素是否可交互
          function isInteractive(el) {
            const tag = el.tagName.toLowerCase();
            if (tag === 'html' || tag === 'body') return { interactive: false };

            // 原生交互式标签
            const interactiveTags = new Set([
              'button', 'input', 'select', 'textarea', 'a',
              'details', 'summary', 'option', 'optgroup', 'video', 'audio'
            ]);
            if (interactiveTags.has(tag)) return { interactive: true, type: tag };

            // ARIA roles
            const role = el.getAttribute('role');
            const interactiveRoles = new Set([
              'button', 'link', 'menuitem', 'option', 'radio', 'checkbox',
              'tab', 'textbox', 'combobox', 'slider', 'spinbutton', 'search',
              'searchbox', 'switch', 'gridcell', 'row', 'cell', 'treeitem'
            ]);
            if (role && interactiveRoles.has(role)) return { interactive: true, type: role };

            // contenteditable
            if (el.getAttribute('contenteditable') === 'true') return { interactive: true, type: 'editable' };

            // tabindex
            const tabIndex = el.getAttribute('tabindex');
            if (tabIndex !== null && tabIndex !== '-1') return { interactive: true, type: 'focusable' };

            // onclick 等事件属性
            if (el.hasAttribute('onclick') || el.onclick !== null) return { interactive: true, type: 'clickable' };
            const eventAttrs = ['onmousedown', 'onmouseup', 'onkeydown', 'onkeyup', 'ontouchstart'];
            for (const attr of eventAttrs) {
              if (el.hasAttribute(attr)) return { interactive: true, type: 'clickable' };
            }

            // cursor: pointer
            const style = window.getComputedStyle(el);
            if (style.cursor === 'pointer') return { interactive: true, type: 'clickable' };

            // label 包含表单控件
            if (tag === 'label') {
              if (el.hasAttribute('for')) return { interactive: false };
              if (hasFormControlDescendant(el, 2)) return { interactive: true, type: 'label' };
            }

            // span 包含表单控件
            if (tag === 'span' && hasFormControlDescendant(el, 2)) return { interactive: true, type: 'wrapper' };

            // 交互状态属性
            const stateAttrs = ['aria-expanded', 'aria-pressed', 'aria-selected', 'aria-checked'];
            for (const attr of stateAttrs) {
              if (el.hasAttribute(attr)) return { interactive: true, type: 'stateful' };
            }

            return { interactive: false };
          }

          // 添加元素
          function addElement(el, type, text) {
            if (processedElements.has(el)) return false;

            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;

            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            if (parseFloat(style.opacity) === 0) return false;

            processedElements.add(el);

            elements.push({
              index: elements.length,
              selector: getUniqueSelector(el),
              tag: el.tagName.toLowerCase(),
              type: type,
              text: text || getElementText(el),
              normalizedPosition: {
                x: Math.round(((rect.left + rect.width / 2) / viewportWidth) * 1000) / 1000,
                y: Math.round(((rect.top + rect.height / 2) / viewportHeight) * 1000) / 1000
              },
              boundingBox: {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              },
              coordinateSpace: 'main-frame-viewport',
              isInViewport: rect.top < viewportHeight && rect.bottom > 0 && rect.left < viewportWidth && rect.right > 0,
              isInteractable: !el.disabled,
              attributes: {}
            });
            return true;
          }

          // 遍历 DOM
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_ELEMENT,
            {
              acceptNode: function(node) {
                const style = window.getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden') {
                  return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
              }
            }
          );

          let node;
          while (node = walker.nextNode()) {
            const result = isInteractive(node);
            if (result.interactive) {
              addElement(node, result.type, '');
            }
          }

          return elements;
        })()
      `,
            {
              signal: commandSignal,
              timeoutMs: BROWSER_TIMEOUTS.cdpCommand,
            },
          ),
        BROWSER_TIMEOUTS.cdpCommand,
        'Browser JavaScript element scan',
        { signal },
      )) as JavaScriptFallbackElement[];

      return Array.isArray(elements)
        ? await this.resolveJavaScriptFallbackElements(elements, signal)
        : [];
    } catch (error) {
      rethrowBrowserInterruption(error);
      console.warn('Failed to scan interactive elements via JS:', error);
      return [];
    }
  }
}
