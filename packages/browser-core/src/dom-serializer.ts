/**
 * DOM Serializer
 * 参考 browser-use 的实现，提供高效的 DOM 树序列化
 *
 * 核心功能：
 * 1. 树优化 - 移除无意义中间节点
 * 2. Paint Order 过滤 - 过滤被遮挡元素
 * 3. Bounding Box 过滤 - 过滤被父元素完全包含的子元素
 * 4. 层级文本输出 - 更省 token 的输出格式
 */

import type { InteractiveElement } from './browser-core-contracts.js';

// ============================================
// 类型定义
// ============================================

/** 简化的 DOM 节点（用于树优化） */
export interface SimplifiedNode {
  element: InteractiveElement;
  children: SimplifiedNode[];
  isInteractive: boolean;
  paintOrder: number | null;
  isExcludedByParent: boolean;
  isExcludedByPaintOrder: boolean;
  depth: number;
}

/** 传播边界（用于 bbox 过滤） */
interface PropagatingBounds {
  tag: string;
  bounds: { x: number; y: number; width: number; height: number };
  backendNodeId: number;
}

/** 序列化配置 */
export interface SerializerConfig {
  enableTreeOptimization: boolean;
  enablePaintOrderFiltering: boolean;
  enableBboxFiltering: boolean;
  bboxContainmentThreshold: number;
  maxTextLength: number;
  outputFormat: 'tree' | 'flat';
  /** 最大输出字符数（默认 20000） */
  maxOutputChars: number;
  /** 最大元素数量（默认 100） */
  maxElements: number;
}

/** 序列化结果 */
export interface SerializedResult {
  text: string;
  elementCount: number;
  filteredCount: number;
  timingInfo: Record<string, number>;
}

// ============================================
// 常量
// ============================================

/** 会传播边界的元素（点击父元素等同于点击子元素） */
const PROPAGATING_ELEMENTS = new Set(['a', 'button']);

/** 会传播边界的 role */
const PROPAGATING_ROLES = new Set(['button', 'link', 'menuitem', 'option']);

/** 表单元素（不应被 bbox 过滤排除） */
const FORM_ELEMENTS = new Set(['input', 'select', 'textarea', 'label']);

/** 类型缩写映射 */
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
// DOM 序列化器
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
      maxTextLength: 30, // 精简：从 50 减少到 30
      outputFormat: 'tree',
      maxOutputChars: 20000, // 限制总输出字符数
      maxElements: 80, // 限制最大元素数量
      ...config,
    };
  }

  /**
   * 序列化可交互元素列表
   * @param elements 可交互元素列表
   * @param pageInfo 页面信息
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

    // Step 1: Paint Order 过滤
    if (this.config.enablePaintOrderFiltering) {
      const startPaint = Date.now();
      const result = this.filterByPaintOrder(filteredElements);
      filteredElements = result.elements;
      filteredCount += result.filteredCount;
      this.timingInfo.paintOrderFilter = Date.now() - startPaint;
    }

    // Step 2: Bounding Box 过滤
    if (this.config.enableBboxFiltering) {
      const startBbox = Date.now();
      const result = this.filterByBoundingBox(filteredElements);
      filteredElements = result.elements;
      filteredCount += result.filteredCount;
      this.timingInfo.bboxFilter = Date.now() - startBbox;
    }

    // Step 3: 生成输出
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
  // Paint Order 过滤
  // ============================================

  /**
   * 根据 paint order 过滤被遮挡的元素
   * 原理：paint order 较小的元素会被 paint order 较大的元素遮挡
   */
  private filterByPaintOrder(elements: InteractiveElement[]): {
    elements: InteractiveElement[];
    filteredCount: number;
  } {
    // 按位置分组，检测重叠
    const filtered: InteractiveElement[] = [];
    const excluded = new Set<number>();

    // 按 paint order 排序（从大到小，后绘制的在前）
    const sortedByPaint = [...elements].sort((a, b) => {
      const paintA = (a as unknown as { paintOrder?: number }).paintOrder ?? 0;
      const paintB = (b as unknown as { paintOrder?: number }).paintOrder ?? 0;
      return paintB - paintA;
    });

    for (let i = 0; i < sortedByPaint.length; i++) {
      const current = sortedByPaint[i];
      if (!current) continue;
      if (excluded.has(current.index)) continue;

      // 检查是否被后面（paint order 更大）的元素完全遮挡
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
  // Bounding Box 过滤
  // ============================================

  /**
   * 根据边界框过滤被父元素包含的子元素
   * 原理：对于 <a> 和 <button> 等可点击容器，点击父元素等同于点击子元素
   */
  private filterByBoundingBox(elements: InteractiveElement[]): {
    elements: InteractiveElement[];
    filteredCount: number;
  } {
    const filtered: InteractiveElement[] = [];
    const excluded = new Set<number>();

    // 找出所有传播边界的元素
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
      // 表单元素不应被排除
      if (FORM_ELEMENTS.has(el.tag.toLowerCase())) {
        filtered.push(el);
        continue;
      }

      // 检查是否被传播元素包含
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
   * 检查元素是否是传播边界的元素
   */
  private isPropagatingElement(el: InteractiveElement): boolean {
    const tag = el.tag.toLowerCase();
    if (PROPAGATING_ELEMENTS.has(tag)) return true;

    const role = el.attributes.role?.toLowerCase();
    if (role && PROPAGATING_ROLES.has(role)) return true;

    return false;
  }

  /**
   * 检查 A 是否完全包含在 B 中
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
   * 检查 A 是否被 B 包含（带阈值）
   */
  private isContainedWithThreshold(
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number },
    threshold: number,
  ): boolean {
    // 计算交集面积
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
  // 输出格式化
  // ============================================

  /**
   * 计算滚动信息
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

    // 计算上方和下方还有多少页
    const pagesAbove = viewportHeight > 0 ? Math.round((scrollY / viewportHeight) * 10) / 10 : 0;
    const contentBelow = Math.max(0, pageHeight - viewportHeight - scrollY);
    const pagesBelow =
      viewportHeight > 0 ? Math.round((contentBelow / viewportHeight) * 10) / 10 : 0;

    // 计算滚动百分比
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
   * 格式化页面头部信息（精简版）
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

    // 精简标题（最多 50 字符）
    const title = pageInfo.title.length > 50 ? pageInfo.title.slice(0, 47) + '...' : pageInfo.title;

    // 精简 URL（只保留 path）
    let urlPath = pageInfo.url;
    try {
      const url = new URL(pageInfo.url);
      urlPath = url.host + url.pathname;
      if (urlPath.length > 60) {
        urlPath = urlPath.slice(0, 57) + '...';
      }
    } catch {
      // 保持原样
    }

    // 滚动信息：简化格式
    let scrollStr = '';
    if (scrollInfo.canScrollUp || scrollInfo.canScrollDown) {
      const parts: string[] = [];
      if (scrollInfo.canScrollUp) parts.push(`↑${scrollInfo.pagesAbove}`);
      if (scrollInfo.canScrollDown) parts.push(`↓${scrollInfo.pagesBelow}`);
      scrollStr = ` ${parts.join(' ')}`;
    }

    // 单行紧凑格式
    return `[${title}] ${urlPath} | ${elementCount}el${scrollStr}\n---`;
  }

  /**
   * 格式化为层级树结构（更省 token）
   * 应用字符限制和元素数量限制
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
    // 只输出视口内的元素
    let viewportElements = elements.filter((el) => el.isInViewport);

    // 限制元素数量
    const maxElements = this.config.maxElements;
    const truncatedByCount = viewportElements.length > maxElements;
    if (truncatedByCount) {
      viewportElements = viewportElements.slice(0, maxElements);
    }

    const lines: string[] = [this.formatHeader(pageInfo, elements.length)];
    let totalChars = lines[0]?.length ?? 0;

    // 逐个添加元素，检查字符限制
    let truncatedByChars = false;
    let addedCount = 0;
    for (const el of viewportElements) {
      const line = this.formatElement(el);
      if (totalChars + line.length + 1 > this.config.maxOutputChars - 100) {
        // 预留 100 字符给尾部信息
        truncatedByChars = true;
        break;
      }
      lines.push(line);
      totalChars += line.length + 1;
      addedCount++;
    }

    // 添加截断提示
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
   * 格式化为扁平 JSON（兼容旧格式）
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
   * 格式化单个元素
   * 格式: @{index} [{type}] "{text}" {attributes}
   */
  private formatElement(el: InteractiveElement): string {
    const parts: string[] = [];

    // 索引
    parts.push(`@${el.index}`);

    // 类型
    const type = this.getTypeAbbrev(el.type);
    parts.push(`[${type}]`);

    // 文本
    if (el.text) {
      const text = this.truncateText(el.text);
      parts.push(`"${text}"`);
    }

    // 关键属性
    const attrs = this.formatAttributes(el);
    if (attrs) {
      parts.push(attrs);
    }

    return parts.join(' ');
  }

  /**
   * 获取类型缩写
   */
  private getTypeAbbrev(type: string): string {
    const lower = type.toLowerCase();
    return TYPE_ABBREV[lower] || lower.slice(0, 4);
  }

  /**
   * 截断文本
   */
  private truncateText(text: string): string {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= this.config.maxTextLength) {
      return cleaned;
    }
    return cleaned.slice(0, this.config.maxTextLength - 3) + '...';
  }

  /**
   * 格式化关键属性（精简版，只保留最重要的）
   */
  private formatAttributes(el: InteractiveElement): string {
    const attrs: string[] = [];

    // placeholder（对输入框很重要）
    if (el.attributes.placeholder && el.type.includes('text')) {
      const ph = this.truncateText(el.attributes.placeholder);
      if (ph.length <= 20) {
        attrs.push(`ph="${ph}"`);
      }
    }

    // href（只显示短路径，对链接重要）
    if (el.attributes.href && el.type === 'link') {
      try {
        const url = new URL(el.attributes.href, 'http://placeholder.local');
        const path = url.pathname;
        // 只显示短路径
        if (path.length > 1 && path.length <= 20 && path !== '/') {
          attrs.push(`→${path}`);
        }
      } catch {
        // 忽略
      }
    }

    // 状态属性（用简短符号）
    if (el.attributes['aria-expanded'] === 'true') attrs.push('▼');
    if (el.attributes['aria-expanded'] === 'false') attrs.push('▶');
    if (el.attributes.checked) attrs.push('✓');
    if (!el.isInteractable) attrs.push('✗');

    return attrs.join(' ');
  }
}

// ============================================
// 导出便捷函数
// ============================================

/**
 * 序列化可交互元素（使用默认配置）
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
