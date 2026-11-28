/**
 * DOM Serializer. Follows browser-use to serialize DOM trees efficiently.
 *
 * Core features:
 * 1. Tree optimization: Remove meaningless intermediate nodes.
 * 2. Paint-order filtering: Remove occluded elements.
 * 3. Bounding-box filtering: Remove children fully contained by their parents.
 * 4. Hierarchical text output: A more token-efficient format.
 */

import type { InteractiveElement } from './browser-core-contracts.js';

// ============================================
// Type definitions
// ============================================

/** Simplified DOM node for tree optimization. */
export interface SimplifiedNode {
  element: InteractiveElement;
  children: SimplifiedNode[];
  isInteractive: boolean;
  paintOrder: number | null;
  isExcludedByParent: boolean;
  isExcludedByPaintOrder: boolean;
  depth: number;
}

/** Propagation boundary for bbox filtering. */
interface PropagatingBounds {
  tag: string;
  bounds: { x: number; y: number; width: number; height: number };
  backendNodeId: number;
}

/** Serialization configuration. */
export interface SerializerConfig {
  enableTreeOptimization: boolean;
  enablePaintOrderFiltering: boolean;
  enableBboxFiltering: boolean;
  bboxContainmentThreshold: number;
  maxTextLength: number;
  outputFormat: 'tree' | 'flat';
  /** Maximum output characters; defaults to 20000. */
  maxOutputChars: number;
  /** Maximum number of elements; defaults to 100. */
  maxElements: number;
}

/** Serialization result. */
export interface SerializedResult {
  text: string;
  elementCount: number;
  filteredCount: number;
  timingInfo: Record<string, number>;
}

// ============================================
// Constants
// ============================================

/** Elements that propagate boundaries: clicking the parent is equivalent to clicking the child. */
const PROPAGATING_ELEMENTS = new Set(['a', 'button']);

/** Roles that propagate boundaries. */
const PROPAGATING_ROLES = new Set(['button', 'link', 'menuitem', 'option']);

/** Form elements that must not be excluded by bbox filtering. */
const FORM_ELEMENTS = new Set(['input', 'select', 'textarea', 'label']);

/** Type abbreviation mapping. */
const TYPE_ABBREV: Record<string, string> = {
  button: 'btn',
  link: 'lnk',
  textbox: 'txt',
  searchbox: 'search',
  checkbox: 'chk',
  radio: 'rad',
  combobox: 'combo',
  listbox: 'list',
  menuitem: 'menu',
  tab: 'tab',
  switch: 'sw',
  slider: 'slider',
  spinbutton: 'spin',
  option: 'opt',
  generic: 'div',
  img: 'img',
  heading: 'h',
};

// ============================================
// DOM serializer
// ============================================

export class DOMSerializer {
  private config: SerializerConfig;
  private timingInfo: Record<string, number> = {};

  constructor(config?: Partial<SerializerConfig>) {
    this.config = {
      enableTreeOptimization: true,
      enablePaintOrderFiltering: true,
      enableBboxFiltering: true,
      bboxContainmentThreshold: 0.95,
      maxTextLength: 30, // Shorten from 50 to 30.
      outputFormat: 'tree',
      maxOutputChars: 20000, // Limit total output characters.
      maxElements: 80, // Limit the maximum element count.
      ...config,
    };
  }

  /**
   * Serialize a list of interactive elements.
   * @param elements List of interactive elements.
   * @param pageInfo Page information.
   */
  serialize(
    elements: InteractiveElement[],
    pageInfo: {
      url: string;
      title: string;
      viewport: { width: number; height: number };
      scrollPosition: { x: number; y: number };
      pageHeight: number;
    },
  ): SerializedResult {
    this.timingInfo = {};
    const startTotal = Date.now();

    if (elements.length === 0) {
      return {
        text: this.formatHeader(pageInfo, 0),
        elementCount: 0,
        filteredCount: 0,
        timingInfo: { total: Date.now() - startTotal },
      };
    }

    let filteredElements = elements;
    let filteredCount = 0;

    // Step 1: Paint-order filtering.
    if (this.config.enablePaintOrderFiltering) {
      const startPaint = Date.now();
      const result = this.filterByPaintOrder(filteredElements);
      filteredElements = result.elements;
      filteredCount += result.filteredCount;
      this.timingInfo.paintOrderFilter = Date.now() - startPaint;
    }

    // Step 2: Bounding-box filtering.
    if (this.config.enableBboxFiltering) {
      const startBbox = Date.now();
      const result = this.filterByBoundingBox(filteredElements);
      filteredElements = result.elements;
      filteredCount += result.filteredCount;
      this.timingInfo.bboxFilter = Date.now() - startBbox;
    }

    // Step 3: Generate output.
    const startOutput = Date.now();
    const text =
      this.config.outputFormat === 'tree'
        ? this.formatAsTree(filteredElements, pageInfo)
        : this.formatAsFlat(filteredElements, pageInfo);
    this.timingInfo.formatOutput = Date.now() - startOutput;

    this.timingInfo.total = Date.now() - startTotal;

    return {
      text,
      elementCount: filteredElements.length,
      filteredCount,
      timingInfo: this.timingInfo,
    };
  }

  // ============================================
  // Paint-order filtering
  // ============================================

  /**
   * Filter occluded elements by paint order: elements with lower paint order can be covered by
   * those with higher paint order.
   */
  private filterByPaintOrder(elements: InteractiveElement[]): {
    elements: InteractiveElement[];
    filteredCount: number;
  } {
    // Group by position to detect overlap.
    const filtered: InteractiveElement[] = [];
    const excluded = new Set<number>();

    // Sort by descending paint order, placing later-painted elements first.
    const sortedByPaint = [...elements].sort((a, b) => {
      const paintA = (a as unknown as { paintOrder?: number }).paintOrder ?? 0;
      const paintB = (b as unknown as { paintOrder?: number }).paintOrder ?? 0;
      return paintB - paintA;
    });

    for (let i = 0; i < sortedByPaint.length; i++) {
      const current = sortedByPaint[i];
      if (!current) continue;
      if (excluded.has(current.index)) continue;

      // Check whether a later-painted element (higher paint order) fully occludes this element.
      let isOccluded = false;
      for (let j = 0; j < i; j++) {
        const other = sortedByPaint[j];
        if (!other) continue;
        if (this.isFullyContained(current.boundingBox, other.boundingBox)) {
          isOccluded = true;
          break;
        }
      }

      if (!isOccluded) {
        filtered.push(current);
      } else {
        excluded.add(current.index);
      }
    }

    return {
      elements: filtered,
      filteredCount: excluded.size,
    };
  }

  // ============================================
  // Bounding-box filtering
  // ============================================

  /**
   * Filter children contained within a parent's bounding box. For clickable containers such as <a>
   * and <button>, clicking the parent is equivalent to clicking the child.
   */
  private filterByBoundingBox(elements: InteractiveElement[]): {
    elements: InteractiveElement[];
    filteredCount: number;
  } {
    const filtered: InteractiveElement[] = [];
    const excluded = new Set<number>();

    // Find all boundary-propagating elements.
    const propagatingElements: PropagatingBounds[] = [];
    for (const el of elements) {
      if (this.isPropagatingElement(el)) {
        propagatingElements.push({
          tag: el.tag,
          bounds: el.boundingBox,
          backendNodeId: el.index,
        });
      }
    }

    for (const el of elements) {
      // Do not exclude form elements.
      if (FORM_ELEMENTS.has(el.tag.toLowerCase())) {
        filtered.push(el);
        continue;
      }

      // Check containment by a boundary-propagating element.
      let isContained = false;
      for (const parent of propagatingElements) {
        if (parent.backendNodeId === el.index) continue;
        if (
          this.isContainedWithThreshold(
            el.boundingBox,
            parent.bounds,
            this.config.bboxContainmentThreshold,
          )
        ) {
          isContained = true;
          break;
        }
      }

      if (!isContained) {
        filtered.push(el);
      } else {
        excluded.add(el.index);
      }
    }

    return {
      elements: filtered,
      filteredCount: excluded.size,
    };
  }

  /**
   * Check whether the element propagates boundaries.
   */
  private isPropagatingElement(el: InteractiveElement): boolean {
    const tag = el.tag.toLowerCase();
    if (PROPAGATING_ELEMENTS.has(tag)) return true;

    const role = el.attributes.role?.toLowerCase();
    if (role && PROPAGATING_ROLES.has(role)) return true;

    return false;
  }

  /**
   * Check whether A is fully contained in B.
   */
  private isFullyContained(
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number },
  ): boolean {
    return (
      a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height
    );
  }

  /**
   * Check whether A is contained in B, with a threshold.
   */
  private isContainedWithThreshold(
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number },
    threshold: number,
  ): boolean {
    // Compute the intersection area.
    const intersectX = Math.max(a.x, b.x);
    const intersectY = Math.max(a.y, b.y);
    const intersectRight = Math.min(a.x + a.width, b.x + b.width);
    const intersectBottom = Math.min(a.y + a.height, b.y + b.height);

    if (intersectRight <= intersectX || intersectBottom <= intersectY) {
      return false;
    }

    const intersectArea = (intersectRight - intersectX) * (intersectBottom - intersectY);
    const aArea = a.width * a.height;

    return aArea > 0 && intersectArea / aArea >= threshold;
  }

  // ============================================
  // Output formatting
  // ============================================

  /**
   * Compute scroll information.
   */
  private calculateScrollInfo(pageInfo: {
    viewport: { width: number; height: number };
    scrollPosition: { x: number; y: number };
    pageHeight: number;
    pageWidth?: number;
  }): {
    pagesAbove: number;
    pagesBelow: number;
    scrollPercentY: number;
    canScrollUp: boolean;
    canScrollDown: boolean;
  } {
    const viewportHeight = pageInfo.viewport.height;
    const scrollY = pageInfo.scrollPosition.y;
    const pageHeight = pageInfo.pageHeight;

    // Compute the number of pages above and below.
    const pagesAbove = viewportHeight > 0 ? Math.round((scrollY / viewportHeight) * 10) / 10 : 0;
    const contentBelow = Math.max(0, pageHeight - viewportHeight - scrollY);
    const pagesBelow =
      viewportHeight > 0 ? Math.round((contentBelow / viewportHeight) * 10) / 10 : 0;

    // Compute scroll percentage.
    const maxScrollY = Math.max(0, pageHeight - viewportHeight);
    const scrollPercentY = maxScrollY > 0 ? Math.round((scrollY / maxScrollY) * 100) : 0;

    return {
      pagesAbove,
      pagesBelow,
      scrollPercentY,
      canScrollUp: scrollY > 0,
      canScrollDown: contentBelow > 0,
    };
  }

  /**
   * Format compact page header information.
   */
  private formatHeader(
    pageInfo: {
      url: string;
      title: string;
      viewport: { width: number; height: number };
      scrollPosition: { x: number; y: number };
      pageHeight: number;
      pageWidth?: number;
    },
    elementCount: number,
  ): string {
    const scrollInfo = this.calculateScrollInfo(pageInfo);

    // Shorten the title to at most 50 characters.
    const title = pageInfo.title.length > 50 ? pageInfo.title.slice(0, 47) + '...' : pageInfo.title;

    // Shorten the URL, keeping only the path.
    let urlPath = pageInfo.url;
    try {
      const url = new URL(pageInfo.url);
      urlPath = url.host + url.pathname;
      if (urlPath.length > 60) {
        urlPath = urlPath.slice(0, 57) + '...';
      }
    } catch {
      // Keep unchanged.
    }

    // Use a simplified scroll information format.
    let scrollStr = '';
    if (scrollInfo.canScrollUp || scrollInfo.canScrollDown) {
      const parts: string[] = [];
      if (scrollInfo.canScrollUp) parts.push(`↑${scrollInfo.pagesAbove}`);
      if (scrollInfo.canScrollDown) parts.push(`↓${scrollInfo.pagesBelow}`);
      scrollStr = ` ${parts.join(' ')}`;
    }

    // Compact single-line format.
    return `[${title}] ${urlPath} | ${elementCount}el${scrollStr}\n---`;
  }

  /**
   * Format as a token-efficient hierarchical tree, applying character and element-count limits.
   */
  private formatAsTree(
    elements: InteractiveElement[],
    pageInfo: {
      url: string;
      title: string;
      viewport: { width: number; height: number };
      scrollPosition: { x: number; y: number };
      pageHeight: number;
      pageWidth?: number;
    },
  ): string {
    // Output only elements in the viewport.
    let viewportElements = elements.filter((el) => el.isInViewport);

    // Limit the number of elements.
    const maxElements = this.config.maxElements;
    const truncatedByCount = viewportElements.length > maxElements;
    if (truncatedByCount) {
      viewportElements = viewportElements.slice(0, maxElements);
    }

    const lines: string[] = [this.formatHeader(pageInfo, elements.length)];
    let totalChars = lines[0]?.length ?? 0;

    // Add elements one at a time, checking the character limit.
    let truncatedByChars = false;
    let addedCount = 0;
    for (const el of viewportElements) {
      const line = this.formatElement(el);
      if (totalChars + line.length + 1 > this.config.maxOutputChars - 100) {
        // Reserve 100 characters for the footer.
        truncatedByChars = true;
        break;
      }
      lines.push(line);
      totalChars += line.length + 1;
      addedCount++;
    }

    // Add a truncation notice.
    const hiddenInViewport = viewportElements.length - addedCount;
    const hiddenBelowViewport = elements.length - elements.filter((el) => el.isInViewport).length;
    const totalHidden = hiddenInViewport + hiddenBelowViewport;

    if (truncatedByChars || truncatedByCount || totalHidden > 0) {
      const reasons: string[] = [];
      if (hiddenInViewport > 0) reasons.push(`${hiddenInViewport} truncated`);
      if (hiddenBelowViewport > 0) reasons.push(`${hiddenBelowViewport} below`);
      lines.push(`... ${totalHidden} more (${reasons.join(', ')})`);
    }

    return lines.join('\n');
  }

  /**
   * Format as flat JSON for compatibility with the legacy format.
   */
  private formatAsFlat(
    elements: InteractiveElement[],
    pageInfo: {
      url: string;
      title: string;
      viewport: { width: number; height: number };
      scrollPosition: { x: number; y: number };
      pageHeight: number;
      pageWidth?: number;
    },
  ): string {
    const output = {
      u: pageInfo.url,
      t: pageInfo.title,
      v: [pageInfo.viewport.width, pageInfo.viewport.height],
      s: [pageInfo.scrollPosition.x, pageInfo.scrollPosition.y],
      h: pageInfo.pageHeight,
      c: elements.length,
      e: elements
        .filter((el) => el.isInViewport)
        .map((el) => ({
          i: el.index,
          t: this.getTypeAbbrev(el.type),
          n: this.truncateText(el.text),
        })),
    };
    return JSON.stringify(output);
  }

  /**
   * Format one element.
   * Format: @{index} [{type}] "{text}" {attributes}
   */
  private formatElement(el: InteractiveElement): string {
    const parts: string[] = [];

    // Index
    parts.push(`@${el.index}`);

    // Type
    const type = this.getTypeAbbrev(el.type);
    parts.push(`[${type}]`);

    // Text
    if (el.text) {
      const text = this.truncateText(el.text);
      parts.push(`"${text}"`);
    }

    // Key attributes
    const attrs = this.formatAttributes(el);
    if (attrs) {
      parts.push(attrs);
    }

    return parts.join(' ');
  }

  /**
   * Get the type abbreviation.
   */
  private getTypeAbbrev(type: string): string {
    const lower = type.toLowerCase();
    return TYPE_ABBREV[lower] || lower.slice(0, 4);
  }

  /**
   * Truncate text.
   */
  private truncateText(text: string): string {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= this.config.maxTextLength) {
      return cleaned;
    }
    return cleaned.slice(0, this.config.maxTextLength - 3) + '...';
  }

  /**
   * Format a compact set of only the most important attributes.
   */
  private formatAttributes(el: InteractiveElement): string {
    const attrs: string[] = [];

    // placeholder is important for input fields.
    if (el.attributes.placeholder && el.type.includes('text')) {
      const ph = this.truncateText(el.attributes.placeholder);
      if (ph.length <= 20) {
        attrs.push(`ph="${ph}"`);
      }
    }

    // href is important for links; show only a short path.
    if (el.attributes.href && el.type === 'link') {
      try {
        const url = new URL(el.attributes.href, 'http://placeholder.local');
        const path = url.pathname;
        // Show only a short path.
        if (path.length > 1 && path.length <= 20 && path !== '/') {
          attrs.push(`→${path}`);
        }
      } catch {
        // Ignore.
      }
    }

    // State attributes, represented with short symbols.
    if (el.attributes['aria-expanded'] === 'true') attrs.push('▼');
    if (el.attributes['aria-expanded'] === 'false') attrs.push('▶');
    if (el.attributes.checked) attrs.push('✓');
    if (!el.isInteractable) attrs.push('✗');

    return attrs.join(' ');
  }
}

// ============================================
// Export convenience functions.
// ============================================

/**
 * Serialize interactive elements with default configuration.
 */
export function serializeElements(
  elements: InteractiveElement[],
  pageInfo: {
    url: string;
    title: string;
    viewport: { width: number; height: number };
    scrollPosition: { x: number; y: number };
    pageHeight: number;
  },
  config?: Partial<SerializerConfig>,
): SerializedResult {
  const serializer = new DOMSerializer(config);
  return serializer.serialize(elements, pageInfo);
}
