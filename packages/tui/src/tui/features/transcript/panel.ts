import {
  panelContentWidth,
  renderPanelHeader,
  renderPanelRow,
  renderPanelFooter,
  renderPanelDivider,
  renderPanelBottom,
} from '../../widgets/panel-frame.js';
import {
  decodePrintableKey,
  Input,
  Markdown,
  matchesKey,
  Text,
  VStack,
} from '../../engine/public.js';
import { projectAssistantContentForTerminal } from '../../../application/assistant-content.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import { renderTuiStructuredPreview } from '../../transcript/presentation/structured-preview.js';
import { renderDeliveredAssets } from '../../transcript/delivered-assets.js';
import {
  renderTuiActionHint,
  tuiChalk as chalk,
  tuiColors as colors,
  tuiMarkdownTheme as markdownTheme,
} from '../../theme/runtime.js';
import type { TranscriptCell } from '../../transcript/model.js';
import type { TranscriptProjectionSource } from '../../transcript/projection-window.js';
import { presentTranscriptToolEvidence } from '../../transcript/tool-evidence.js';
import { resolveTranscriptToolDefinition } from '../../transcript/tool-definitions.js';
import {
  presentTranscriptCell,
  type TranscriptCellPresentation,
  type TranscriptPresentationTone,
} from '../../transcript/presentation/content.js';
import type { TuiFeatureScreen } from '../../shell/surface-host.js';
import {
  formatTuiTranscriptMarkdown,
  latestAssistantReply,
  type TuiTranscriptExportMetadata,
} from '../../transcript/export.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';
import { TuiSelectionScrollView } from '../../widgets/selection-scroll-view.js';

export interface TuiTranscriptPanelOptions {
  readonly source: TranscriptProjectionSource & { readonly revision?: number };
  readonly onCancel: () => void;
  readonly requestRender: () => void;
  readonly writeClipboardText?: (text: string) => Promise<void>;
  readonly openExternalTarget?: (target: string) => Promise<void>;
  readonly workspaceDir?: string;
  readonly exportTranscript?: (markdown: string) => Promise<string>;
  readonly exportMetadata?: TuiTranscriptExportMetadata | (() => TuiTranscriptExportMetadata);
  readonly onForkFromUserMessage?: (sourceMessageId: string) => Promise<void>;
}

interface SearchEntry {
  readonly id: string;
  readonly text: string;
}

interface ExpandedBlockLayout {
  readonly index: number;
  readonly row: number;
  readonly extraRows: number;
}

interface ExpandedBlockMeasurement {
  readonly cell: TranscriptCell;
  readonly width: number;
  readonly raw: boolean;
  readonly height: number;
}

interface TranscriptBodyWindow {
  readonly selectedRow: number;
  readonly totalRows: number;
  readonly renderTop: number;
  readonly renderBottom: number;
}

export class TuiTranscriptPanel implements TuiFeatureScreen, Component, Focusable {
  readonly id = 'transcript';
  readonly layoutRoot: Component;
  private _focused = false;
  private selectedIndex = -1;
  private selectedCellId: string | undefined;
  private readonly bodyViewport: TuiSelectionScrollView;
  private expandedIds = new Set<string>();
  private collapsedIds = new Set<string>();
  private rawIds = new Set<string>();
  private allExpanded = false;
  private searchEditing = false;
  private readonly searchInput = new Input({ prompt: '' });
  private searchMatches: number[] = [];
  private searchMatchIndex = -1;
  private searchRevision: number | undefined;
  private searchEntries: SearchEntry[] = [];
  private ensureSelectionOnNextRender = true;
  private lastSelectedRow = 0;
  private notice: string | undefined;
  private forking = false;
  private disposed = false;
  private operationGeneration = 0;
  private readonly expandedBlockMeasurements = new Map<string, ExpandedBlockMeasurement>();

  constructor(private readonly options: TuiTranscriptPanelOptions) {
    this.selectedIndex = Math.max(0, options.source.length - 1);
    this.selectedCellId = options.source.cellAt(this.selectedIndex)?.id;
    const header: Component = {
      render: (width) => this.renderHeader(width),
      invalidate: () => undefined,
    };
    const body: Component = {
      render: (width) => this.renderFramedBody(width),
      invalidate: () => undefined,
    };
    const footer: Component = {
      render: (width) => this.renderFooter(width),
      invalidate: () => undefined,
    };
    this.bodyViewport = new TuiSelectionScrollView(body, {
      follow: 'end',
      primary: true,
      overscroll: 'contain',
    });
    this.layoutRoot = new VStack([
      { component: header, basis: 'auto', shrink: 1, minSize: 1 },
      { component: this.bodyViewport, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: footer, basis: 'auto', shrink: 1, minSize: 1 },
    ]);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value && this.searchEditing;
  }

  dispose(): void {
    this.disposed = true;
    this.operationGeneration += 1;
    this.searchInput.focused = false;
  }

  handleInput(data: string): void {
    if (this.forking || this.disposed) return;
    if (this.searchEditing) {
      this.handleSearchInput(data);
      return;
    }

    const printable = decodePrintableKey(data) ?? data;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.options.onCancel();
      return;
    }
    if (matchesKey(data, 'up') || printable === 'k') {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, 'down') || printable === 'j') {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
      this.toggleSelected();
      return;
    }
    if (matchesKey(data, 'ctrl+o')) {
      this.toggleAll();
      return;
    }
    if (printable === '/') {
      this.searchEditing = true;
      this.searchInput.focused = this._focused;
      this.notice = undefined;
      this.requestRender();
      return;
    }
    if (printable === 'n' || printable === 'N') {
      this.moveSearchMatch(printable === 'n' ? 1 : -1);
      return;
    }
    if (printable === 'r') {
      this.toggleRaw();
      return;
    }
    if (printable === 'c') {
      void this.copySelected();
      return;
    }
    if (printable === 'y') {
      void this.copyLastReply();
      return;
    }
    if (printable === 'e') {
      void this.exportTranscript();
      return;
    }
    if (printable === 'w' && this.options.onForkFromUserMessage) {
      void this.forkSelectedPrompt();
      return;
    }
    if (printable === 'o') {
      void this.openSelectedTarget();
    }
  }

  invalidate(): void {
    this.searchRevision = undefined;
    this.layoutRoot.invalidate();
  }

  render(width: number): string[] {
    return [
      ...this.renderHeader(width),
      ...this.renderFramedBody(width),
      ...this.renderFooter(width),
    ];
  }

  renderViewport(rawWidth: number, rawHeight: number): readonly string[] {
    const width = Math.max(1, Math.floor(rawWidth));
    const height = Math.max(1, Math.floor(rawHeight));
    this.reconcileSelection();
    if (height <= 3) return this.renderCompactViewport(width, height);

    const header = this.renderHeader(width);
    const footer = this.renderFooter(width);
    const bodyRows = Math.max(1, height - header.length - footer.length);
    const body = this.renderFramedBody(width, bodyRows);
    const selected = this.selectedCell();
    const maxStart = Math.max(0, body.length - bodyRows);
    const start = this.isExpanded(selected?.id)
      ? Math.min(this.lastSelectedRow, maxStart)
      : Math.max(0, Math.min(maxStart, this.lastSelectedRow - bodyRows + 1));
    const visibleBody = body.slice(start, start + bodyRows);
    while (visibleBody.length < bodyRows) visibleBody.push('');
    return [...header, ...visibleBody, ...footer].slice(0, height);
  }

  private renderHeader(width: number): string[] {
    const blocks = this.options.source.length;
    const turns = this.options.source.turnCount;
    const count = `${blocks} ${blocks === 1 ? 'block' : 'blocks'} · ${turns} ${turns === 1 ? 'turn' : 'turns'}`;
    const searchQuery = this.searchInput.getValue();
    const mode = searchQuery
      ? `/ ${searchQuery} · ${this.searchMatches.length} ${this.searchMatches.length === 1 ? 'match' : 'matches'}`
      : this.allExpanded
        ? 'all details'
        : 'focused details';
    const left = renderPanelHeader('Transcript', count, width);
    const right = chalk.hex(searchQuery ? colors.signal : colors.dim)(mode);
    if (!this.searchEditing) {
      return [left, renderPanelRow(right, width)];
    }
    this.searchInput.focused = this._focused;
    const prompt = chalk.hex(colors.signal)('/ ');
    const search =
      this.searchInput.render(Math.max(1, panelContentWidth(width) - visibleWidth(prompt)))[0] ??
      '';
    const matchStatus = chalk.hex(colors.muted)(
      `${this.searchMatches.length} ${this.searchMatches.length === 1 ? 'match' : 'matches'}`,
    );
    return [left, renderPanelRow(`${prompt}${search}`, width), renderPanelRow(matchStatus, width)];
  }

  private renderFooter(width: number): string[] {
    const selected = this.selectedCell();
    const expanded = selected ? this.isExpanded(selected.id) : false;
    const primary = expanded ? 'Enter collapse' : 'Enter expand';
    const action = `${primary}${this.options.onForkFromUserMessage ? ' · w fork' : ''}${presentTranscriptCellSafe(selected)?.target ? ' · o open' : ''} · y last reply · e export · / find · c copy · r raw`;
    const footer = this.notice
      ? `${renderTuiActionHint('Esc close')} · ${chalk.hex(colors.signal)(this.notice)}`
      : renderTuiActionHint(`${action} · Esc close`);
    return [
      renderPanelDivider(width),
      ...renderPanelFooter(footer, panelContentWidth(width)).map((line) =>
        renderPanelRow(line, width),
      ),
      renderPanelBottom(width),
    ];
  }

  private renderFramedBody(width: number, rows = this.bodyViewport.viewportHeight || 24): string[] {
    const body = this.renderBody(panelContentWidth(width), rows);
    while (body.length < this.bodyViewport.viewportHeight) body.push('');
    return body.map((line) => renderPanelRow(line, width));
  }

  private renderBody(
    width: number,
    viewportRows = this.bodyViewport.viewportHeight || 24,
  ): string[] {
    this.reconcileSelection();
    if (this.options.source.length === 0) {
      if (this.ensureSelectionOnNextRender) this.bodyViewport.setActiveRow(0, true);
      else this.bodyViewport.setActiveRowPreservingScroll(0);
      this.ensureSelectionOnNextRender = false;
      return [chalk.hex(colors.muted)('  No conversation yet. Send a message to begin.')];
    }
    let expanded = this.createExpandedBlockLayout(width);
    let window = this.resolveBodyWindow(expanded, viewportRows);
    let renderedExpandedBlocks = new Map<number, readonly string[]>();
    for (let pass = 0; pass < 3; pass += 1) {
      const measured = this.measureExpandedBlocks(
        width,
        expanded,
        window.renderTop,
        window.renderBottom,
      );
      renderedExpandedBlocks = measured.blocks;
      if (!measured.layoutChanged) break;
      expanded = this.createExpandedBlockLayout(width);
      window = this.resolveBodyWindow(expanded, viewportRows);
    }

    const lines = Array.from({ length: window.totalRows }, () => '');
    this.lastSelectedRow = window.selectedRow;
    let index = this.indexForRow(window.renderTop, expanded);
    while (index < this.options.source.length) {
      const row = this.rowForIndex(index, expanded);
      if (row >= window.renderBottom) break;
      const cell = this.options.source.cellAt(index);
      if (cell) {
        const block =
          renderedExpandedBlocks.get(index) ??
          this.renderMeasuredBlock(cell, width, index === this.selectedIndex);
        for (let offset = 0; offset < block.length; offset += 1) {
          const target = row + offset;
          if (target >= window.renderTop && target < window.renderBottom) {
            lines[target] = block[offset] ?? '';
          }
        }
      }
      index += 1;
    }

    if (this.ensureSelectionOnNextRender) {
      this.bodyViewport.setActiveRow(window.selectedRow, true);
    } else {
      this.bodyViewport.setActiveRowPreservingScroll(window.selectedRow);
    }
    this.ensureSelectionOnNextRender = false;
    return lines;
  }

  private resolveBodyWindow(
    expanded: readonly ExpandedBlockLayout[],
    viewportRows: number,
  ): TranscriptBodyWindow {
    const totalExtraRows = expanded.reduce((sum, entry) => sum + entry.extraRows, 0);
    const totalRows = this.options.source.length + totalExtraRows;
    const selectedRow = this.rowForIndex(this.selectedIndex, expanded);
    const safeViewportRows = Math.max(1, Math.floor(viewportRows));
    const currentTop =
      this.bodyViewport.viewportHeight > 0 ? this.bodyViewport.scrollTop : selectedRow;
    let targetTop = this.bodyViewport.isFollowingEnd
      ? Math.max(0, totalRows - safeViewportRows)
      : currentTop;
    if (this.ensureSelectionOnNextRender) {
      if (selectedRow < currentTop) targetTop = selectedRow;
      else if (selectedRow >= currentTop + safeViewportRows) {
        targetTop = Math.max(0, selectedRow - safeViewportRows + 1);
      }
    }
    return {
      selectedRow,
      totalRows,
      renderTop: Math.max(0, targetTop - safeViewportRows),
      renderBottom: Math.min(totalRows, targetTop + safeViewportRows * 2),
    };
  }

  private measureExpandedBlocks(
    width: number,
    expanded: readonly ExpandedBlockLayout[],
    renderTop: number,
    renderBottom: number,
  ): { readonly blocks: Map<number, readonly string[]>; readonly layoutChanged: boolean } {
    const blocks = new Map<number, readonly string[]>();
    let layoutChanged = false;
    let index = this.indexForRow(renderTop, expanded);
    while (index < this.options.source.length) {
      const row = this.rowForIndex(index, expanded);
      if (row >= renderBottom) break;
      const cell = this.options.source.cellAt(index);
      if (cell && this.isExpanded(cell.id)) {
        const previousHeight = this.expandedBlockHeight(cell, width);
        const lines = this.renderMeasuredBlock(cell, width, index === this.selectedIndex);
        blocks.set(index, lines);
        if (lines.length !== previousHeight) layoutChanged = true;
      }
      index += 1;
    }
    return { blocks, layoutChanged };
  }

  private createExpandedBlockLayout(width: number): ExpandedBlockLayout[] {
    const indices = this.allExpanded
      ? Array.from({ length: this.options.source.length }, (_, index) => index).filter((index) => {
          const cell = this.options.source.cellAt(index);
          return Boolean(cell && !this.collapsedIds.has(cell.id));
        })
      : [...this.expandedIds]
          .map((id) => this.options.source.locateCell(id)?.index)
          .filter((index): index is number => index !== undefined)
          .sort((left, right) => left - right);
    const result: ExpandedBlockLayout[] = [];
    let extraRows = 0;
    for (const index of indices) {
      const cell = this.options.source.cellAt(index);
      if (!cell) continue;
      const blockExtraRows = Math.max(0, this.expandedBlockHeight(cell, width) - 1);
      result.push({ index, row: index + extraRows, extraRows: blockExtraRows });
      extraRows += blockExtraRows;
    }
    return result;
  }

  private rowForIndex(index: number, expanded: readonly ExpandedBlockLayout[]): number {
    const safeIndex = Math.max(0, index);
    let low = 0;
    let high = expanded.length - 1;
    let previous = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if ((expanded[middle]?.index ?? Number.POSITIVE_INFINITY) < safeIndex) {
        previous = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (previous < 0) return safeIndex;
    const block = expanded[previous];
    if (!block) return safeIndex;
    return safeIndex + (block.row - block.index) + block.extraRows;
  }

  private expandedBlockHeight(cell: TranscriptCell, width: number): number {
    const measurement = this.expandedBlockMeasurements.get(cell.id);
    return measurement?.cell === cell &&
      measurement.width === width &&
      measurement.raw === this.rawIds.has(cell.id)
      ? measurement.height
      : 1;
  }

  private renderMeasuredBlock(cell: TranscriptCell, width: number, selected: boolean): string[] {
    const lines = this.renderBlock(cell, width, selected);
    if (this.isExpanded(cell.id)) {
      this.expandedBlockMeasurements.set(cell.id, {
        cell,
        width,
        raw: this.rawIds.has(cell.id),
        height: lines.length,
      });
    }
    return lines;
  }

  private indexForRow(row: number, expanded: readonly ExpandedBlockLayout[]): number {
    let low = 0;
    let high = Math.max(0, this.options.source.length - 1);
    let result = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (this.rowForIndex(middle, expanded) <= row) {
        result = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return result;
  }

  private renderBlock(cell: TranscriptCell, width: number, selected: boolean): string[] {
    const presentation = presentTranscriptCell(cell);
    const marker = paintTone(presentation.marker, presentation.tone);
    const selector = selected ? chalk.bold.hex(colors.signal)('›') : ' ';
    const title = selected
      ? chalk.bold.hex(colors.signal)(presentation.title)
      : chalk.hex(colors.text)(presentation.title);
    const summary = presentation.summary
      ? `  ${chalk.hex(colors.muted)(presentation.summary)}`
      : '';
    const heading = truncateToWidth(`${selector} ${marker} ${title}${summary}`, width, '…');
    if (!this.isExpanded(cell.id)) return [heading];
    return [heading, ...this.renderDetail(cell, presentation, width)];
  }

  private renderDetail(
    cell: TranscriptCell,
    presentation: TranscriptCellPresentation,
    width: number,
  ): string[] {
    const contentWidth = Math.max(1, width - 4);
    if (this.rawIds.has(cell.id)) {
      return this.renderTextSection('raw', presentation.rawText || 'No raw content', contentWidth);
    }
    if (cell.kind === 'assistant' || cell.kind === 'assistant-preamble' || cell.kind === 'user') {
      const content =
        cell.kind === 'user'
          ? { text: cell.content, assets: [] }
          : projectAssistantContentForTerminal(cell.content);
      const body = new Markdown(content.text, 0, 0, markdownTheme, {
        color: (value) => chalk.hex(colors.text)(value),
      }).render(contentWidth);
      const assets = renderDeliveredAssets(content.assets, contentWidth, this.options.workspaceDir);
      const lines =
        body.length > 0 && assets.length > 0 ? [...body, '', ...assets] : [...body, ...assets];
      return lines.map((line) => this.detailLine(line, width));
    }

    const lines: string[] = [];
    const toolEvidence =
      cell.kind === 'tool'
        ? presentTranscriptToolEvidence(cell, resolveTranscriptToolDefinition(cell.title), {
            width,
            prefix: '  │ ',
            displayMode: 'expanded',
          })
        : undefined;
    if (cell.kind === 'tool' && toolEvidence?.lines.length) {
      lines.push(...toolEvidence.lines);
    } else if (cell.kind === 'tool' && cell.content.trim()) {
      lines.push(...this.renderTextSection('input', cell.content, contentWidth));
    } else if (cell.content.trim()) {
      lines.push(...this.renderTextSection(undefined, cell.content, contentWidth));
    }
    if (cell.structuredPreview) {
      lines.push(
        ...renderTuiStructuredPreview(cell.structuredPreview, width, {
          prefix: '  │ ',
          maxBodyLines: Number.MAX_SAFE_INTEGER,
        }),
      );
    }
    if (cell.detail?.trim() && !toolEvidence?.handlesDetail) {
      lines.push(
        ...this.renderTextSection(
          cell.kind === 'tool' ? 'output' : 'detail',
          cell.detail,
          contentWidth,
        ),
      );
    }
    if (lines.length === 0)
      lines.push(this.detailLine(chalk.hex(colors.dim)('No additional detail'), width));
    return lines;
  }

  private renderTextSection(
    label: string | undefined,
    value: string,
    contentWidth: number,
  ): string[] {
    const lines: string[] = [];
    if (label) lines.push(this.detailLine(chalk.bold.hex(colors.dim)(label), contentWidth + 4));
    const rendered = new Text(chalk.hex(colors.muted)(sanitizeTerminalText(value)), 0, 0).render(
      contentWidth,
    );
    lines.push(...rendered.map((line) => this.detailLine(line, contentWidth + 4)));
    return lines;
  }

  private detailLine(value: string, width: number): string {
    const prefix = chalk.hex(colors.line)('  │ ');
    return truncateToWidth(`${prefix}${value}`, width, '');
  }

  private renderCompactViewport(width: number, height: number): string[] {
    const cell = this.selectedCell();
    const title = cell ? presentTranscriptCell(cell).title : 'No conversation';
    return [
      truncateToWidth(chalk.bold.hex(colors.signal)('Transcript'), width, '…'),
      truncateToWidth(title, width, '…'),
      truncateToWidth(renderTuiActionHint('Esc close'), width, '…'),
    ].slice(0, height);
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.searchEditing = false;
      this.searchInput.focused = false;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'enter')) {
      this.searchEditing = false;
      this.searchInput.focused = false;
      this.selectCurrentSearchMatch();
      this.requestRender();
      return;
    }
    const previousQuery = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (this.searchInput.getValue() !== previousQuery) this.refreshSearchMatches();
  }

  private refreshSearchMatches(): void {
    this.ensureSearchEntries();
    const query = this.searchInput.getValue().trim().toLocaleLowerCase();
    this.searchMatches = query
      ? this.searchEntries.flatMap((entry, index) => (entry.text.includes(query) ? [index] : []))
      : [];
    this.searchMatchIndex = this.searchMatches.length > 0 ? 0 : -1;
    this.selectCurrentSearchMatch();
    this.notice = undefined;
    this.requestRender();
  }

  private ensureSearchEntries(): void {
    const revision = this.options.source.revision;
    if (
      revision !== undefined &&
      this.searchEntries.length === this.options.source.length &&
      this.searchRevision === revision
    ) {
      return;
    }
    this.searchEntries = Array.from({ length: this.options.source.length }, (_, index) => {
      const cell = this.options.source.cellAt(index);
      return cell
        ? { id: cell.id, text: presentTranscriptCell(cell).searchText }
        : { id: `missing:${index}`, text: '' };
    });
    this.searchRevision = revision;
  }

  private moveSearchMatch(delta: -1 | 1): void {
    if (this.searchMatches.length === 0) return;
    this.searchMatchIndex =
      (this.searchMatchIndex + delta + this.searchMatches.length) % this.searchMatches.length;
    this.selectCurrentSearchMatch();
    this.requestRender();
  }

  private selectCurrentSearchMatch(): void {
    const match = this.searchMatches[this.searchMatchIndex];
    if (match !== undefined) this.selectIndex(match);
  }

  private moveSelection(delta: -1 | 1): void {
    this.selectIndex(this.selectedIndex + delta);
  }

  private selectIndex(index: number): void {
    if (this.options.source.length === 0) {
      this.selectedIndex = -1;
      return;
    }
    this.selectedIndex = Math.max(0, Math.min(this.options.source.length - 1, index));
    this.selectedCellId = this.options.source.cellAt(this.selectedIndex)?.id;
    this.ensureSelectionOnNextRender = true;
    this.notice = undefined;
    this.requestRender();
  }

  private toggleSelected(): void {
    const cell = this.selectedCell();
    if (!cell) return;
    const expanded = this.isExpanded(cell.id);
    if (this.allExpanded) {
      if (expanded) this.collapsedIds.add(cell.id);
      else this.collapsedIds.delete(cell.id);
    } else if (expanded) {
      this.expandedIds.delete(cell.id);
    } else {
      this.expandedIds.add(cell.id);
    }
    this.notice = undefined;
    this.requestRender();
  }

  private toggleAll(): void {
    this.allExpanded = !this.allExpanded;
    this.expandedIds.clear();
    this.collapsedIds.clear();
    this.notice = this.allExpanded ? 'All details shown' : 'Semantic folding restored';
    this.requestRender();
  }

  private toggleRaw(): void {
    const cell = this.selectedCell();
    if (!cell) return;
    if (this.rawIds.has(cell.id)) this.rawIds.delete(cell.id);
    else this.rawIds.add(cell.id);
    if (!this.isExpanded(cell.id)) {
      if (this.allExpanded) this.collapsedIds.delete(cell.id);
      else this.expandedIds.add(cell.id);
    }
    this.notice = this.rawIds.has(cell.id) ? 'Raw content' : 'Rendered content';
    this.requestRender();
  }

  private async copySelected(): Promise<void> {
    const cell = this.selectedCell();
    const write = this.options.writeClipboardText;
    if (!cell || !write) {
      this.notice = 'Copy is unavailable';
      this.requestRender();
      return;
    }
    const operation = this.beginOperation();
    try {
      await write(presentTranscriptCell(cell).rawText);
      if (!this.isCurrentOperation(operation)) return;
      this.notice = 'Copied selected block';
    } catch (error) {
      if (!this.isCurrentOperation(operation)) return;
      this.notice = formatTuiActionFailure(error, {
        summary: "Couldn't copy.",
        nextStep: 'Select the text and copy it manually.',
      });
    }
    this.requestRender();
  }

  private async copyLastReply(): Promise<void> {
    const write = this.options.writeClipboardText;
    const reply = latestAssistantReply(this.options.source);
    if (!write || !reply) {
      this.notice = reply ? 'Copy is unavailable' : 'No Assistant reply to copy';
      this.requestRender();
      return;
    }
    const operation = this.beginOperation();
    try {
      await write(reply);
      if (!this.isCurrentOperation(operation)) return;
      this.notice = 'Copied last Assistant reply';
    } catch (error) {
      if (!this.isCurrentOperation(operation)) return;
      this.notice = formatTuiActionFailure(error, {
        summary: "Couldn't copy.",
        nextStep: 'Select the text and copy it manually.',
      });
    }
    this.requestRender();
  }

  private async exportTranscript(): Promise<void> {
    if (!this.options.exportTranscript) {
      this.notice = 'Transcript export is unavailable';
      this.requestRender();
      return;
    }
    const metadata =
      typeof this.options.exportMetadata === 'function'
        ? this.options.exportMetadata()
        : (this.options.exportMetadata ?? {});
    const operation = this.beginOperation();
    try {
      const file = await this.options.exportTranscript(
        formatTuiTranscriptMarkdown(this.options.source, metadata),
      );
      if (!this.isCurrentOperation(operation)) return;
      this.notice = `Exported to ${file}`;
    } catch (error) {
      if (!this.isCurrentOperation(operation)) return;
      this.notice = formatTuiActionFailure(error, {
        summary: "Couldn't export.",
        nextStep: 'Check folder permissions and retry.',
      });
    }
    this.requestRender();
  }

  private async openSelectedTarget(): Promise<void> {
    const target = presentTranscriptCellSafe(this.selectedCell())?.target;
    if (!target || !this.options.openExternalTarget) {
      this.notice = 'No openable target in this block';
      this.requestRender();
      return;
    }
    const operation = this.beginOperation();
    try {
      await this.options.openExternalTarget(target);
      if (!this.isCurrentOperation(operation)) return;
      this.notice = 'Opened target';
    } catch (error) {
      if (!this.isCurrentOperation(operation)) return;
      this.notice = formatTuiActionFailure(error, {
        summary: "Couldn't open target.",
        nextStep: 'Copy it and open it manually.',
      });
    }
    this.requestRender();
  }

  private async forkSelectedPrompt(): Promise<void> {
    if (this.forking || !this.options.onForkFromUserMessage) return;
    const selected = this.selectedCell();
    if (selected?.kind !== 'user' || !selected.sourceMessageId) {
      this.notice = 'Select a persisted user prompt to fork';
      this.requestRender();
      return;
    }
    this.forking = true;
    this.notice = 'Forking Session…';
    this.requestRender();
    const operation = this.beginOperation();
    try {
      await this.options.onForkFromUserMessage(selected.sourceMessageId);
      if (!this.isCurrentOperation(operation)) return;
      this.notice = 'Fork created';
    } catch (error) {
      if (!this.isCurrentOperation(operation)) return;
      this.notice = formatTuiActionFailure(error, {
        summary: "Couldn't fork this prompt.",
        nextStep: 'Select another persisted user prompt and retry.',
      });
    } finally {
      if (this.isCurrentOperation(operation)) {
        this.forking = false;
        this.requestRender();
      }
    }
  }

  private isExpanded(id: string | undefined): boolean {
    if (!id) return false;
    return this.allExpanded ? !this.collapsedIds.has(id) : this.expandedIds.has(id);
  }

  private selectedCell(): TranscriptCell | undefined {
    if (this.selectedIndex < 0) return undefined;
    const cell = this.options.source.cellAt(this.selectedIndex);
    if (cell?.id === this.selectedCellId) return cell;
    this.reconcileSelection();
    return this.selectedIndex < 0 ? undefined : this.options.source.cellAt(this.selectedIndex);
  }

  private reconcileSelection(): void {
    if (this.options.source.length === 0) {
      this.selectedIndex = -1;
      this.selectedCellId = undefined;
      return;
    }
    if (this.selectedCellId) {
      const location = this.options.source.locateCell(this.selectedCellId);
      if (location) {
        this.selectedIndex = location.index;
        return;
      }
    }
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.options.source.length - 1));
    this.selectedCellId = this.options.source.cellAt(this.selectedIndex)?.id;
  }

  private requestRender(): void {
    if (!this.disposed) this.options.requestRender();
  }

  private beginOperation(): number {
    this.operationGeneration += 1;
    return this.operationGeneration;
  }

  private isCurrentOperation(operation: number): boolean {
    return !this.disposed && operation === this.operationGeneration;
  }
}

function paintTone(value: string, tone: TranscriptPresentationTone): string {
  if (tone === 'success') return chalk.hex(colors.success)(value);
  if (tone === 'error') return chalk.hex(colors.error)(value);
  if (tone === 'warning') return chalk.hex(colors.warning)(value);
  if (tone === 'accent') return chalk.hex(colors.accent)(value);
  return chalk.hex(colors.muted)(value);
}

function presentTranscriptCellSafe(
  cell: TranscriptCell | undefined,
): TranscriptCellPresentation | undefined {
  return cell ? presentTranscriptCell(cell) : undefined;
}
