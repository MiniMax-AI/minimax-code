/**
 * Element Map Manager. Maintains mappings of interactive page elements and generates dom_simple_map
 * for model understanding.
 *
 * Design:
 * 1. elementMap: Complete element information saved locally as JSON.
 * 2. simpleMap: Compact representation sent to the model via the message's <browserState> tag.
 * 3. Update elementMap after every browser action.
 * 4. Cache by URL path using LRU, up to a configurable maximum (default five).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { InteractiveElement } from './browser-core-contracts.js';
import type { ElementRecord } from './browser-state.js';
import type { SemanticPageTree } from './browser-semantic-tree.js';
import { DOMSerializer, type SerializerConfig } from './dom-serializer.js';

/**
 * Simplified element information sent to the model.
 * Format: [index]type:text
 * Example: [0]btn:Submit [1]lnk:Home [2]txt:Search...
 */
export interface SimpleElement {
  /** Element index. */
  i: number;
  /** Element type abbreviation. */
  t: string;
  /** Truncated element text. */
  n: string;
  /** Normalized coordinates [x, y]. */
  p: [number, number];
}

/**
 * Simplified page state sent to the model.
 */
export interface SimpleBrowserState {
  /** Current URL. */
  url: string;
  /** Page title. */
  title: string;
  /** Viewport dimensions [width, height]. */
  viewport: [number, number];
  /** Scroll position [x, y]. */
  scroll: [number, number];
  /** Total page height. */
  pageHeight: number;
  /** Number of interactive elements. */
  elementCount: number;
  /** Simplified element list, limited to the viewport. */
  elements: SimpleElement[];
  /** Index of the currently focused element. */
  focusedIndex?: number;
}

/**
 * Scroll information (following browser-use).
 */
export interface ScrollInfo {
  /** Current Y scroll position. */
  scrollY: number;
  /** Current X scroll position. */
  scrollX: number;
  /** Total page height. */
  pageHeight: number;
  /** Total page width. */
  pageWidth: number;
  /** Viewport height. */
  viewportHeight: number;
  /** Viewport width. */
  viewportWidth: number;
  /** Number of pages above. */
  pagesAbove: number;
  /** Number of pages below. */
  pagesBelow: number;
  /** Vertical scroll percentage. */
  scrollPercentY: number;
  /** Whether upward scrolling is possible. */
  canScrollUp: boolean;
  /** Whether downward scrolling is possible. */
  canScrollDown: boolean;
}

/**
 * Page information.
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
 * Cache entry.
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
 * Element Map manager with LRU caching by URL path.
 */
export class ElementMapManager {
  /** URL path → cache entry. */
  private cache: Map<string, CacheEntry> = new Map();
  /** Maximum cache entries. */
  private maxCacheSize: number;
  /** Cache directory. */
  private cacheDir: string | null = null;
  /** Currently active URL path. */
  private currentUrlPath: string | null = null;
  /** Opaque refs for exactly one Browser Core snapshot generation. */
  private opaqueRefs = new Map<string, ElementRecord>();

  /** Type mapping table. */
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
   * Set the cache directory.
   */
  setCacheDir(dir: string): void {
    this.cacheDir = dir;
  }

  /**
   * Get the cache directory.
   */
  getCacheDir(): string | null {
    return this.cacheDir;
  }

  /**
   * Extract the path from a URL for use as a cache key.
   * Example: https://example.com/path/to/page?query=1 → example.com/path/to/page
   */
  private getUrlPath(url: string): string {
    try {
      const urlObj = new URL(url);
      // Use host + pathname as the key, ignoring query and hash.
      return `${urlObj.host}${urlObj.pathname}`;
    } catch {
      // Use the original URL if parsing fails.
      return url;
    }
  }

  /**
   * Generate a filename from the URL path's hash.
   */
  private getFileName(urlPath: string): string {
    const hash = crypto.createHash('md5').update(urlPath).digest('hex').slice(0, 12);
    // Use the domain as a prefix to aid debugging.
    const domain = urlPath
      .split('/')[0]!
      .replace(/[^a-zA-Z0-9]/g, '_')
      .slice(0, 20);
    return `element-map-${domain}-${hash}.json`;
  }

  /**
   * Update the element map.
   * @param elements List of interactive elements.
   * @param pageInfo Page information.
   * @param semanticTree Semantic understanding tree generated in the same scan as the element list.
   */
  async update(
    elements: InteractiveElement[],
    pageInfo: PageInfo,
    semanticTree: SemanticPageTree | null = null,
  ): Promise<void> {
    const urlPath = this.getUrlPath(pageInfo.url);
    this.currentUrlPath = urlPath;

    // Check for an existing cache entry.
    let entry = this.cache.get(urlPath);

    if (entry) {
      // Update the existing cache entry.
      entry.elements = elements;
      entry.semanticTree = semanticTree;
      entry.pageInfo = pageInfo;
      entry.lastAccess = Date.now();
    } else {
      // Create a new cache entry.
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

      // Check whether the cache is full and needs eviction.
      if (this.cache.size >= this.maxCacheSize) {
        await this.evictLRU();
      }

      this.cache.set(urlPath, entry);
    }

    // Save to file.
    if (entry.filePath) {
      await this.saveToFile(entry);
    }
  }

  /**
   * Evict the least recently used (LRU) cache entry.
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
      // Delete the corresponding file.
      if (entry?.filePath) {
        try {
          await fs.promises.unlink(entry.filePath);
        } catch {
          // Ignore missing files.
        }
      }
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Save the element map to a file.
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
   * Get the current page's complete element map.
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
   * Get the element map for a specified URL.
   */
  getElementMapByUrl(url: string): InteractiveElement[] | null {
    const urlPath = this.getUrlPath(url);
    const entry = this.cache.get(urlPath);
    if (entry) {
      // Update access time.
      entry.lastAccess = Date.now();
      return entry.elements;
    }
    return null;
  }

  /**
   * Get an element by index.
   */
  getElementById(index: number): InteractiveElement | null {
    const elements = this.getElementMap();
    return elements[index] || null;
  }

  /**
   * Get an element by selector.
   */
  getElementBySelector(selector: string): InteractiveElement | null {
    const elements = this.getElementMap();
    return elements.find((el) => el.selector === selector) || null;
  }

  /**
   * Get current page information.
   */
  private getCurrentPageInfo(): PageInfo | null {
    if (!this.currentUrlPath) return null;
    const entry = this.cache.get(this.currentUrlPath);
    return entry?.pageInfo || null;
  }

  /**
   * Generate simplified browser state for the model, using an LLM-friendly format for understanding
   * the page and planning the next action.
   */
  getSimpleBrowserState(): SimpleBrowserState | null {
    const pageInfo = this.getCurrentPageInfo();
    if (!pageInfo) return null;

    const elements = this.getElementMap();

    // Return only elements in the viewport.
    const viewportElements = elements.filter((el) => el.isInViewport);

    // Find the focused element's index.
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
   * Generate a dom_simple_map string for embedding in messages. Compact JSON contains only what the
   * model needs to understand the page and plan actions; details such as exact positions and
   * selectors remain in the local elementMap file.
   *
   * Example output:
   * {"u":"https://example.com","t":"Example","v":[1200,800],"s":[0,100],"c":45,"e":[{"i":0,"t":"btn","n":"Submit"},{"i":1,"t":"lnk","n":"Home"}],"m":"/path/to/element-map.json"}
   *
   * Fields:
   * - u: url
   * - t: title
   * - v: viewport [width, height]
   * - s: scroll position [x, y]
   * - c: total element count
   * - e: visible elements (i: index, t: type, n: name/text)
   * - f: focused element index (optional)
   * - m: elementMap file path (the model may read this file for details)
   */
  generateSimpleMapString(): string {
    const state = this.getSimpleBrowserState();
    if (!state) return '';

    // Compact format: retain only the minimum information needed for the model to understand the page.
    // Do not send position (p) to the model; it references elements by index (i).
    // Look up details in the local elementMap file during execution.
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

    // elementMap file path, available for the model to read selectors, exact positions, and other details.
    const filePath = this.getCacheDir();
    if (filePath) {
      output.m = filePath;
    }

    return JSON.stringify(output);
  }

  /**
   * Generate <browserState> tag content for embedding in messages sent to the model.
   */
  generateBrowserStateTag(): string {
    const simpleMap = this.generateSimpleMapString();
    if (!simpleMap) return '';

    return `<browserState>${simpleMap}</browserState>`;
  }

  /**
   * Generate optimized hierarchical text following browser-use. Apply paint-order and bounding-box
   * filtering for compact output.
   *
   * @param config Serialization configuration.
   * @returns Browser state in hierarchical text format.
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
   * Generate an optimized <browserState> tag using token-efficient hierarchical text, including the
   * elementMap file path for the model to read details.
   */
  generateOptimizedBrowserStateTag(config?: Partial<SerializerConfig>): string {
    const text = this.generateOptimizedBrowserState(config);
    if (!text) return '';

    // Add the elementMap file path.
    const filePath = this.getCurrentFilePath();
    const mapLine = filePath ? `[Map] ${filePath}` : '';

    return `<browserState>\n${text}${mapLine ? '\n' + mapLine : ''}\n</browserState>`;
  }

  /**
   * Get the current elementMap file path.
   */
  private getCurrentFilePath(): string | null {
    if (!this.currentUrlPath) return null;
    const entry = this.cache.get(this.currentUrlPath);
    return entry?.filePath || null;
  }

  /**
   * Get an element by backendNodeId.
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
   * Clear all caches.
   */
  clear(): void {
    // Delete all cache files.
    for (const entry of this.cache.values()) {
      if (entry.filePath) {
        fs.promises.unlink(entry.filePath).catch(() => {
          // Ignore deletion errors.
        });
      }
    }
    this.cache.clear();
    this.currentUrlPath = null;
    this.clearOpaqueRefs();
  }

  /**
   * Clear the cache for a specified URL.
   */
  clearByUrl(url: string): void {
    const urlPath = this.getUrlPath(url);
    const entry = this.cache.get(urlPath);
    if (entry) {
      if (entry.filePath) {
        fs.promises.unlink(entry.filePath).catch(() => {
          // Ignore deletion errors.
        });
      }
      this.cache.delete(urlPath);
      if (this.currentUrlPath === urlPath) {
        this.currentUrlPath = null;
      }
    }
  }

  /**
   * Check whether a specified URL has a cache entry.
   */
  hasCache(url: string): boolean {
    const urlPath = this.getUrlPath(url);
    return this.cache.has(urlPath);
  }

  /**
   * Check whether an update is needed because the URL changed or no cache exists.
   */
  needsUpdate(currentUrl: string): boolean {
    const urlPath = this.getUrlPath(currentUrl);
    return !this.cache.has(urlPath);
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): { size: number; maxSize: number; urls: string[] } {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      urls: Array.from(this.cache.keys()),
    };
  }

  /**
   * Set the maximum number of cache entries.
   */
  setMaxCacheSize(size: number): void {
    this.maxCacheSize = size;
    // Evict excess entries if the current cache exceeds the new maximum.
    while (this.cache.size > this.maxCacheSize) {
      this.evictLRU();
    }
  }
}
