/**
 * Element Map Manager
 * 维护页面可交互元素映射，生成 dom_simple_map 供模型理解
 *
 * 设计思路：
 * 1. elementMap: 完整的元素信息，保存到本地文件（JSON 格式）
 * 2. simpleMap: 精简版，用于上报给模型（在 message 中通过 <browserState> 标签）
 * 3. 每次浏览器动作后更新 elementMap
 * 4. 按 URL path 维度缓存，最多维护指定个数（默认 5 个），使用 LRU 策略
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { InteractiveElement } from './browser-core-contracts.js';
import type { ElementRecord } from './browser-state.js';
import type { SemanticPageTree } from './browser-semantic-tree.js';
import { DOMSerializer, type SerializerConfig } from './dom-serializer.js';

/**
 * 简化版元素信息（用于上报给模型）
 * 格式: [index]type:text
 * 例如: [0]btn:Submit [1]lnk:Home [2]txt:Search...
 */
export interface SimpleElement {
  /** 元素索引 */
  i: number;
  /** 元素类型缩写 */
  t: string;
  /** 元素文本（截断） */
  n: string;
  /** 归一化坐标 [x, y] */
  p: [number, number];
}

/**
 * 简化版页面状态（用于上报给模型）
 */
export interface SimpleBrowserState {
  /** 当前 URL */
  url: string;
  /** 页面标题 */
  title: string;
  /** 视口尺寸 [width, height] */
  viewport: [number, number];
  /** 滚动位置 [x, y] */
  scroll: [number, number];
  /** 页面总高度 */
  pageHeight: number;
  /** 可交互元素数量 */
  elementCount: number;
  /** 简化版元素列表（仅视口内） */
  elements: SimpleElement[];
  /** 当前聚焦元素的索引 */
  focusedIndex?: number;
}

/**
 * 滚动信息（参考 browser-use）
 */
export interface ScrollInfo {
  /** 当前滚动位置 Y */
  scrollY: number;
  /** 当前滚动位置 X */
  scrollX: number;
  /** 页面总高度 */
  pageHeight: number;
  /** 页面总宽度 */
  pageWidth: number;
  /** 视口高度 */
  viewportHeight: number;
  /** 视口宽度 */
  viewportWidth: number;
  /** 上方还有多少页 */
  pagesAbove: number;
  /** 下方还有多少页 */
  pagesBelow: number;
  /** 垂直滚动百分比 */
  scrollPercentY: number;
  /** 是否可以向上滚动 */
  canScrollUp: boolean;
  /** 是否可以向下滚动 */
  canScrollDown: boolean;
}

/**
 * 页面信息
 */
interface PageInfo {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scrollPosition: { x: number; y: number };
  pageHeight: number;
  pageWidth: number;
  focusedElement: string | null;
}

/**
 * 缓存条目
 */
interface CacheEntry {
  urlPath: string;
  elements: InteractiveElement[];
  semanticTree: SemanticPageTree | null;
  pageInfo: PageInfo;
  filePath: string;
  lastAccess: number;
}

/**
 * Element Map 管理器
 * 支持按 URL path 维度的 LRU 缓存
 */
export class ElementMapManager {
  /** URL path -> 缓存条目 */
  private cache: Map<string, CacheEntry> = new Map();
  /** 最大缓存数量 */
  private maxCacheSize: number;
  /** 缓存目录 */
  private cacheDir: string | null = null;
  /** 当前活跃的 URL path */
  private currentUrlPath: string | null = null;
  /** Opaque refs for exactly one Browser Core snapshot generation. */
  private opaqueRefs = new Map<string, ElementRecord>();

  /** 类型映射表 */
  private static readonly TYPE_MAP: Record<string, string> = {
    button: 'btn',
    link: 'lnk',
    textbox: 'txt',
    searchbox: 'txt',
    checkbox: 'chk',
    radio: 'rad',
    combobox: 'sel',
    listbox: 'sel',
    menuitem: 'menu',
    tab: 'tab',
    switch: 'sw',
    generic: 'gene',
    tabpanel: 'tpnl',
  };

  constructor(maxCacheSize = 5) {
    this.maxCacheSize = maxCacheSize;
  }

  /**
   * 设置缓存目录
   */
  setCacheDir(dir: string): void {
    this.cacheDir = dir;
  }

  /**
   * 获取缓存目录
   */
  getCacheDir(): string | null {
    return this.cacheDir;
  }

  /**
   * 从 URL 提取 path（用于缓存 key）
   * 例如: https://example.com/path/to/page?query=1 -> example.com/path/to/page
   */
  private getUrlPath(url: string): string {
    try {
      const urlObj = new URL(url);
      // 使用 host + pathname 作为 key（忽略 query 和 hash）
      return `${urlObj.host}${urlObj.pathname}`;
    } catch {
      // URL 解析失败，使用原始 URL
      return url;
    }
  }

  /**
   * 生成文件名（基于 URL path 的 hash）
   */
  private getFileName(urlPath: string): string {
    const hash = crypto.createHash('md5').update(urlPath).digest('hex').slice(0, 12);
    // 提取域名作为前缀，便于调试
    const domain = urlPath
      .split('/')[0]!
      .replace(/[^a-zA-Z0-9]/g, '_')
      .slice(0, 20);
    return `element-map-${domain}-${hash}.json`;
  }

  /**
   * 更新元素映射
   * @param elements 可交互元素列表
   * @param pageInfo 页面信息
   * @param semanticTree 与元素列表同一次扫描生成的语义理解树
   */
  async update(
    elements: InteractiveElement[],
    pageInfo: PageInfo,
    semanticTree: SemanticPageTree | null = null,
  ): Promise<void> {
    const urlPath = this.getUrlPath(pageInfo.url);
    this.currentUrlPath = urlPath;

    // 检查是否已有缓存
    let entry = this.cache.get(urlPath);

    if (entry) {
      // 更新现有缓存
      entry.elements = elements;
      entry.semanticTree = semanticTree;
      entry.pageInfo = pageInfo;
      entry.lastAccess = Date.now();
    } else {
      // 创建新缓存条目
      const fileName = this.getFileName(urlPath);
      const filePath = this.cacheDir ? path.join(this.cacheDir, fileName) : '';

      entry = {
        urlPath,
        elements,
        semanticTree,
        pageInfo,
        filePath,
        lastAccess: Date.now(),
      };

      // 检查缓存是否已满，需要淘汰
      if (this.cache.size >= this.maxCacheSize) {
        await this.evictLRU();
      }

      this.cache.set(urlPath, entry);
    }

    // 保存到文件
    if (entry.filePath) {
      await this.saveToFile(entry);
    }
  }

  /**
   * 淘汰最久未使用的缓存条目（LRU）
   */
  private async evictLRU(): Promise<void> {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.cache.get(oldestKey);
      // 删除对应的文件
      if (entry?.filePath) {
        try {
          await fs.promises.unlink(entry.filePath);
        } catch {
          // 文件可能不存在，忽略
        }
      }
      this.cache.delete(oldestKey);
    }
  }

  /**
   * 保存元素映射到文件
   */
  private async saveToFile(entry: CacheEntry): Promise<void> {
    if (!entry.filePath) return;

    try {
      const dir = path.dirname(entry.filePath);
      await fs.promises.mkdir(dir, { recursive: true });

      const data = {
        timestamp: Date.now(),
        urlPath: entry.urlPath,
        pageInfo: entry.pageInfo,
        elements: entry.elements,
      };

      await fs.promises.writeFile(entry.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save element map:', error);
    }
  }

  /**
   * 获取当前页面的完整元素映射
   */
  getElementMap(): InteractiveElement[] {
    if (!this.currentUrlPath) return [];
    const entry = this.cache.get(this.currentUrlPath);
    return entry?.elements || [];
  }

  /** Returns the semantic tree captured atomically with the current ElementMap. */
  getSemanticPageTree(): SemanticPageTree | null {
    if (!this.currentUrlPath) return null;
    return this.cache.get(this.currentUrlPath)?.semanticTree ?? null;
  }

  /**
   * 获取指定 URL 的元素映射
   */
  getElementMapByUrl(url: string): InteractiveElement[] | null {
    const urlPath = this.getUrlPath(url);
    const entry = this.cache.get(urlPath);
    if (entry) {
      // 更新访问时间
      entry.lastAccess = Date.now();
      return entry.elements;
    }
    return null;
  }

  /**
   * 根据索引获取元素
   */
  getElementById(index: number): InteractiveElement | null {
    const elements = this.getElementMap();
    return elements[index] || null;
  }

  /**
   * 根据选择器获取元素
   */
  getElementBySelector(selector: string): InteractiveElement | null {
    const elements = this.getElementMap();
    return elements.find((el) => el.selector === selector) || null;
  }

  /**
   * 获取当前页面信息
   */
  private getCurrentPageInfo(): PageInfo | null {
    if (!this.currentUrlPath) return null;
    const entry = this.cache.get(this.currentUrlPath);
    return entry?.pageInfo || null;
  }

  /**
   * 生成简化版浏览器状态（用于上报给模型）
   * 格式设计为 LLM 友好，便于理解和规划下一步操作
   */
  getSimpleBrowserState(): SimpleBrowserState | null {
    const pageInfo = this.getCurrentPageInfo();
    if (!pageInfo) return null;

    const elements = this.getElementMap();

    // 只返回视口内的元素
    const viewportElements = elements.filter((el) => el.isInViewport);

    // 查找聚焦元素的索引
    let focusedIndex: number | undefined;
    if (pageInfo.focusedElement) {
      const focusedEl = elements.find((el) => el.selector === pageInfo.focusedElement);
      if (focusedEl) {
        focusedIndex = focusedEl.index;
      }
    }

    return {
      url: pageInfo.url,
      title: pageInfo.title,
      viewport: [pageInfo.viewport.width, pageInfo.viewport.height],
      scroll: [pageInfo.scrollPosition.x, pageInfo.scrollPosition.y],
      pageHeight: pageInfo.pageHeight,
      elementCount: elements.length,
      elements: viewportElements.map((el) => ({
        i: el.index,
        t: ElementMapManager.TYPE_MAP[el.type] || el.type.slice(0, 4),
        n: el.text.slice(0, 50),
        p: [el.normalizedPosition.x, el.normalizedPosition.y] as [number, number],
      })),
      focusedIndex,
    };
  }

  /**
   * 生成 dom_simple_map 字符串（用于嵌入到消息中）
   * 格式: 精简的 JSON，只包含模型理解页面和规划动作所需的最小信息
   * 详细信息（如精确位置、selector）保存在本地 elementMap 文件中
   *
   * 示例输出:
   * {"u":"https://example.com","t":"Example","v":[1200,800],"s":[0,100],"c":45,"e":[{"i":0,"t":"btn","n":"Submit"},{"i":1,"t":"lnk","n":"Home"}],"m":"/path/to/element-map.json"}
   *
   * 字段说明:
   * - u: url
   * - t: title
   * - v: viewport [width, height]
   * - s: scroll position [x, y]
   * - c: total element count
   * - e: visible elements (i: index, t: type, n: name/text)
   * - f: focused element index (optional)
   * - m: elementMap file path (模型需要详细信息时可读取此文件)
   */
  generateSimpleMapString(): string {
    const state = this.getSimpleBrowserState();
    if (!state) return '';

    // 精简格式：只保留模型理解页面所需的最小信息
    // 位置信息 (p) 不传给模型，模型通过 index (i) 引用元素
    // 执行时从本地 elementMap 文件中查找详细信息
    const output: Record<string, unknown> = {
      u: state.url,
      t: state.title,
      v: state.viewport,
      s: state.scroll,
      c: state.elementCount,
      e: state.elements.map((el) => ({
        i: el.i,
        t: el.t,
        n: el.n,
      })),
    };

    if (state.focusedIndex !== undefined) {
      output.f = state.focusedIndex;
    }

    // elementMap 文件路径，模型需要详细信息（如 selector、精确位置）时可读取
    const filePath = this.getCacheDir();
    if (filePath) {
      output.m = filePath;
    }

    return JSON.stringify(output);
  }

  /**
   * 生成 <browserState> 标签内容
   * 用于嵌入到消息中上报给模型
   */
  generateBrowserStateTag(): string {
    const simpleMap = this.generateSimpleMapString();
    if (!simpleMap) return '';

    return `<browserState>${simpleMap}</browserState>`;
  }

  /**
   * 生成优化后的层级文本格式（参考 browser-use）
   * 应用 Paint Order 和 Bounding Box 过滤，输出更精简
   *
   * @param config 序列化配置
   * @returns 层级文本格式的浏览器状态
   */
  generateOptimizedBrowserState(config?: Partial<SerializerConfig>): string {
    const pageInfo = this.getCurrentPageInfo();
    if (!pageInfo) return '';

    const elements = this.getElementMap();
    if (elements.length === 0) return '';

    const serializer = new DOMSerializer({
      outputFormat: 'tree',
      ...config,
    });

    const result = serializer.serialize(elements, pageInfo);
    return result.text;
  }

  /**
   * 生成优化后的 <browserState> 标签
   * 使用层级文本格式，更省 token
   * 包含 elementMap 文件路径供模型读取详细信息
   */
  generateOptimizedBrowserStateTag(config?: Partial<SerializerConfig>): string {
    const text = this.generateOptimizedBrowserState(config);
    if (!text) return '';

    // 添加 elementMap 文件路径
    const filePath = this.getCurrentFilePath();
    const mapLine = filePath ? `[Map] ${filePath}` : '';

    return `<browserState>\n${text}${mapLine ? '\n' + mapLine : ''}\n</browserState>`;
  }

  /**
   * 获取当前 elementMap 文件路径
   */
  private getCurrentFilePath(): string | null {
    if (!this.currentUrlPath) return null;
    const entry = this.cache.get(this.currentUrlPath);
    return entry?.filePath || null;
  }

  /**
   * 根据 backendNodeId 获取元素
   */
  getElementByBackendNodeId(backendNodeId: number): InteractiveElement | null {
    const elements = this.getElementMap();
    return elements.find((el) => el.backendNodeId === backendNodeId) || null;
  }

  /** Replace the current generation's opaque refs atomically with its ElementMap. */
  replaceOpaqueRefs(elements: readonly ElementRecord[]): void {
    this.opaqueRefs = new Map(elements.map((element) => [element.ref, element]));
  }

  /** Resolve only refs produced by the current snapshot generation. */
  getElementByOpaqueRef(ref: string): ElementRecord | null {
    return this.opaqueRefs.get(ref) ?? null;
  }

  hasOpaqueRef(ref: string): boolean {
    return this.opaqueRefs.has(ref);
  }

  clearOpaqueRefs(): void {
    this.opaqueRefs.clear();
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    // 删除所有缓存文件
    for (const entry of this.cache.values()) {
      if (entry.filePath) {
        fs.promises.unlink(entry.filePath).catch(() => {
          // 忽略删除错误
        });
      }
    }
    this.cache.clear();
    this.currentUrlPath = null;
    this.clearOpaqueRefs();
  }

  /**
   * 清空指定 URL 的缓存
   */
  clearByUrl(url: string): void {
    const urlPath = this.getUrlPath(url);
    const entry = this.cache.get(urlPath);
    if (entry) {
      if (entry.filePath) {
        fs.promises.unlink(entry.filePath).catch(() => {
          // 忽略删除错误
        });
      }
      this.cache.delete(urlPath);
      if (this.currentUrlPath === urlPath) {
        this.currentUrlPath = null;
      }
    }
  }

  /**
   * 检查指定 URL 是否有缓存
   */
  hasCache(url: string): boolean {
    const urlPath = this.getUrlPath(url);
    return this.cache.has(urlPath);
  }

  /**
   * 检查是否需要更新（URL 变化或无缓存）
   */
  needsUpdate(currentUrl: string): boolean {
    const urlPath = this.getUrlPath(currentUrl);
    return !this.cache.has(urlPath);
  }

  /**
   * 获取缓存统计信息
   */
  getCacheStats(): { size: number; maxSize: number; urls: string[] } {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      urls: Array.from(this.cache.keys()),
    };
  }

  /**
   * 设置最大缓存数量
   */
  setMaxCacheSize(size: number): void {
    this.maxCacheSize = size;
    // 如果当前缓存超过新的最大值，淘汰多余的
    while (this.cache.size > this.maxCacheSize) {
      this.evictLRU();
    }
  }
}
