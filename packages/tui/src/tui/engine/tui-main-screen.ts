import * as fs from "node:fs";
import * as path from "node:path";
import { deleteKittyImage, isImageLine } from "./terminal-image.js";
import { type Component, type ScrollbackLayout, type TUI, TuiBase, type TuiStopOptions } from "./tui.js";
import { stripTerminalSequences, visibleWidth } from "./utils.js";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";
const MAX_RENDER_WRITE_CHARS = 1024 * 1024;
// OSC 133 zone marks are internal navigation sentinels produced by transcript components.
// They must never reach the real terminal from regular mode: terminals with semantic-history
// UI (iTerm2 marks/command bars) render one gutter mark per zone, and repainting lines that
// carry 133;B/133;C displaces the emulator cursor during differential updates. Fullscreen
// rendering already strips them before every write; regular mode mirrors that contract.
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

/**
 * Streams terminal output in bounded chunks so a large render never forms one
 * string large enough to exceed V8's maximum string length.
 */
class BoundedTerminalWriter {
	private buffer = "";
	private writtenChars = 0;
	private readonly write: (data: string) => void;

	constructor(write: (data: string) => void) {
		this.write = write;
	}

	append(value: string): void {
		let offset = 0;
		while (offset < value.length) {
			const capacity = MAX_RENDER_WRITE_CHARS - this.buffer.length;
			if (capacity === 0) {
				this.flush();
				continue;
			}

			let end = Math.min(value.length, offset + capacity);
			if (
				end < value.length &&
				end > offset &&
				value.charCodeAt(end - 1) >= 0xd800 &&
				value.charCodeAt(end - 1) <= 0xdbff &&
				value.charCodeAt(end) >= 0xdc00 &&
				value.charCodeAt(end) <= 0xdfff
			) {
				end--;
			}
			if (end === offset) {
				this.flush();
				continue;
			}

			this.buffer += value.slice(offset, end);
			offset = end;
			if (this.buffer.length === MAX_RENDER_WRITE_CHARS) this.flush();
		}
	}

	flush(): void {
		if (!this.buffer) return;
		this.write(this.buffer);
		this.writtenChars += this.buffer.length;
		this.buffer = "";
	}

	get length(): number {
		return this.writtenChars + this.buffer.length;
	}
}

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;
	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		if (key === "i") ids.push(numberValue);
		else if (key === "r") rows = numberValue;
	}
	return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

export interface TuiMainScreenRenderState {
	previousLines: string[];
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
	viewportLayouts: { component: Component; key: string | undefined }[];
	hadOverlays: boolean;
	scrollbackLayout?: ScrollbackLayout;
	segmentHeader?: boolean;
	geometry?: { width: number; height: number; changed: boolean; reflowed: boolean; reflowMayHaveScrolled: boolean };
}

/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase implements TUI {
	readonly mode = "regular" as const;
	private previousLines: string[] = [];
	private previousWidth = 0;
	private previousHeight = 0;
	private cursorRow = 0;
	private hardwareCursorRow = 0;
	private maxLinesRendered = 0;
	private previousViewportTop = 0;
	private resizeTimer: ReturnType<typeof setTimeout> | undefined;
	private resizePending = false;
	private viewportLayouts: TuiMainScreenRenderState['viewportLayouts'] = [];
	private hadOverlays = false;
	private scrollbackLayout: ScrollbackLayout | undefined;
	private segmentHeader = false;
	private overlayScreenActive = false;
	private overlayFrame: {
		width: number;
		height: number;
		lines: string[];
		cursor: { row: number; col: number } | null;
		showCursor: boolean;
	} | undefined;
	private geometry: TuiMainScreenRenderState["geometry"];
	private renderingMainOnStop = false;

	protected override onTerminalResize(): void {
		const geometry = this.geometry;
		if (geometry?.width === this.terminal.columns && geometry.height === this.terminal.rows) return;
		// A resize changes the physical main buffer even if no frame can be written.
		this.updateMainGeometry();
		if (this.overlayScreenActive) {
			this.requestRender();
			return;
		}
		// Repaint the active document now and settle the final geometry after a drag.
		if (this.previousLines.length > 0 && !isTermuxSession()) {
			if (this.resizeTimer) clearTimeout(this.resizeTimer);
			this.resizePending = true;
			this.resizeTimer = setTimeout(() => {
				this.resizeTimer = undefined;
				this.requestRender();
			}, 150);
		}
		this.requestImmediateRender();
	}

	private cancelResize(): void {
		if (this.resizeTimer) clearTimeout(this.resizeTimer);
		this.resizeTimer = undefined;
	}

	override stop(options: TuiStopOptions = {}): void {
		this.renderingMainOnStop = true;
		try {
			// Flush the main document and exit 1049 before returning terminal ownership.
			this.cancelResize();
			if (!this.stopped && (this.overlayScreenActive || this.resizePending || (!options.preserveScreen && this.hasPendingRender()))) {
				this.doRender();
			}
			super.stop(options);
		} finally {
			this.renderingMainOnStop = false;
		}
	}

	captureRenderState(): TuiMainScreenRenderState {
		return {
			previousLines: [...this.previousLines],
			previousWidth: this.previousWidth,
			previousHeight: this.previousHeight,
			cursorRow: this.cursorRow,
			hardwareCursorRow: this.hardwareCursorRow,
			maxLinesRendered: this.maxLinesRendered,
			previousViewportTop: this.previousViewportTop,
			viewportLayouts: this.viewportLayouts.map((layout) => ({ ...layout })),
			hadOverlays: this.hadOverlays,
			scrollbackLayout: this.scrollbackLayout,
			segmentHeader: this.segmentHeader,
			geometry: this.geometry && { ...this.geometry },
		};
	}

	restoreRenderState(state: TuiMainScreenRenderState): void {
		this.overlayFrame = undefined;
		this.cancelResize();
		this.resizePending = false;
		this.previousLines = state.previousLines.map((line) => (isImageLine(line) ? "" : line));
		this.previousWidth = state.previousWidth;
		this.previousHeight = state.previousHeight;
		this.cursorRow = state.cursorRow;
		this.hardwareCursorRow = state.hardwareCursorRow;
		this.maxLinesRendered = state.maxLinesRendered;
		this.previousViewportTop = state.previousViewportTop;
		this.viewportLayouts = state.viewportLayouts.map((layout) => ({ ...layout }));
		this.hadOverlays = state.hadOverlays;
		this.scrollbackLayout = state.scrollbackLayout;
		this.segmentHeader = state.segmentHeader ?? false;
		this.geometry = state.geometry && { ...state.geometry };
	}

	protected override resetRenderState(): void {
		this.overlayFrame = undefined;
		// A forced repaint still owns an existing physical screen. Retain its
		// coordinates and anchors so refreshing cannot append a duplicate frame.
		this.cancelResize();
		this.resizePending = false;
		this.previousWidth = -1;
	}

	protected override beforeTerminalStop(options: TuiStopOptions): void {
		if (options.preserveScreen || this.previousLines.length === 0) return;
		this.terminal.write(" ");
		const targetRow = this.previousLines.length;
		const lineDiff = targetRow - this.hardwareCursorRow;
		if (lineDiff > 0) this.terminal.write(`\x1b[${lineDiff}B`);
		else if (lineDiff < 0) this.terminal.write(`\x1b[${-lineDiff}A`);
		this.terminal.write("\r\n");
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private hasImageAtOrBelow(lines: string[], top: number): boolean {
		return lines.some((line, row) => isImageLine(line) && row + this.getKittyImageReservedRows(lines, row) > top);
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
		const rows = extractKittyImageRows(lines[index] ?? "");
		if (rows <= 1) return 1;

		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		let reservedRows = 1;
		while (reservedRows < maxRows) {
			const line = lines[index + reservedRows] ?? "";
			if (isImageLine(line) || visibleWidth(line) > 0) break;
			reservedRows++;
		}
		return reservedRows;
	}

	private expandChangedRangeForKittyImages(
		firstChanged: number,
		lastChanged: number,
		newLines: string[],
	): { firstChanged: number; lastChanged: number } {
		let expandedFirstChanged = firstChanged;
		let expandedLastChanged = lastChanged;
		const expandForLines = (lines: string[]): void => {
			for (let i = 0; i < lines.length; i++) {
				if (extractKittyImageIds(lines[i]!).length === 0) continue;
				const blockEnd = i + this.getKittyImageReservedRows(lines, i) - 1;
				if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
					expandedFirstChanged = Math.min(expandedFirstChanged, i);
					expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
				}
			}
		};

		expandForLines(this.previousLines);
		expandForLines(newLines);
		return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = Math.max(firstChanged, this.previousViewportTop); i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	protected override hideHardwareCursor(): void {
		super.hideHardwareCursor();
		// Overlay entry and preference changes can hide it between rendered frames.
		if (this.overlayFrame) this.overlayFrame.showCursor = false;
	}

	private renderOverlayScreen(): void {
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		if (!this.overlayScreenActive) {
			this.overlayFrame = undefined;
			this.terminal.write("\x1b[?1049h");
			this.overlayScreenActive = true;
		}
		this.updateMainGeometry();
		const background = this.render(width).slice(-height).map((line) => isImageLine(line) ? "" : line.replace(OSC133_ZONE_PREFIX, ""));
		const lines = this.compositeOverlays(background, width, height).slice(-height);
		const cursor = this.extractCursorPosition(lines, height);
		this.applyLineResets(lines);
		const previous = this.overlayFrame;
		const showCursor = cursor !== null && this.getShowHardwareCursor();
		const cursorChanged = previous?.cursor?.row !== cursor?.row ||
			previous?.cursor?.col !== cursor?.col || previous?.showCursor !== showCursor;
		let changedRows: number[] = [];
		for (let row = 0; row < height; row++) {
			if (!previous || (previous.lines[row] ?? "") !== (lines[row] ?? "")) changedRows.push(row);
		}
		if (changedRows.length === 0 && !cursorChanged) return;
		// Image placements may span multiple rows. Preserve the existing full-frame
		// repaint for changed image screens until those placements can be diffed.
		if (changedRows.length > 0 && (lines.some(isImageLine) || previous?.lines.some(isImageLine))) {
			changedRows = Array.from({ length: height }, (_, row) => row);
		}
		const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
		output.append("\x1b[?2026h");
		for (const row of changedRows) {
			output.append(`\x1b[${row + 1};1H\x1b[2K${lines[row] ?? ""}`);
		}
		// Row writes move the physical cursor even when its logical target is stable.
		// Hidden cursors still need positioning for IME candidate windows.
		if (cursor) output.append(`\x1b[${cursor.row + 1};${cursor.col + 1}H`);
		if (!previous || previous.showCursor !== showCursor) {
			output.append(showCursor ? "\x1b[?25h" : "\x1b[?25l");
		}
		output.append("\x1b[?2026l");
		output.flush();
		this.overlayFrame = { width, height, lines, cursor, showCursor };
	}

	/** Track every host resize, including while a different renderer owns input. */
	static resizeRenderState(
		state: Pick<TuiMainScreenRenderState, "previousLines" | "previousWidth" | "previousHeight" | "hardwareCursorRow" | "previousViewportTop" | "geometry">,
		width: number,
		height: number,
	): void {
		const geometry = state.geometry ??= {
			width: state.previousWidth, height: state.previousHeight, changed: false, reflowed: false, reflowMayHaveScrolled: false,
		};
		if (geometry.width === width && geometry.height === height) return;
		const oldCursor = Math.max(0, state.hardwareCursorRow - state.previousViewportTop);
		if (geometry.height > 0 && height !== geometry.height) {
			if (height < geometry.height) state.previousViewportTop += Math.max(0, oldCursor - height + 1);
			else if (oldCursor === geometry.height - 1) {
				state.previousViewportTop = Math.max(0, state.previousViewportTop - (height - geometry.height));
			}
		}
		if (geometry.width > 0 && geometry.width !== width && state.previousLines.some((line) =>
			!isImageLine(line) && visibleWidth(line) > Math.min(width, geometry.width))) {
			geometry.reflowed = true;
		}
		if (geometry.reflowed) {
			// A short frame that still fits can be repainted in place. Only archive
			// reflow when it may have moved output beyond the addressable screen.
			const narrowWidth = Math.max(1, Math.min(width, geometry.width));
			const reflowedRows = state.previousLines.reduce((rows, line) =>
				rows + Math.max(1, Math.ceil(visibleWidth(line) / narrowWidth)), 0);
			geometry.reflowMayHaveScrolled ||= state.previousViewportTop > 0 ||
				reflowedRows > Math.min(height, geometry.height);
		}
		geometry.changed ||= geometry.width > 0 && geometry.height > 0;
		geometry.width = width;
		geometry.height = height;
	}

	private updateMainGeometry(): void {
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		if (this.overlayFrame && (this.overlayFrame.width !== width || this.overlayFrame.height !== height)) {
			this.overlayFrame = undefined;
		}
		const state = {
			previousLines: this.previousLines, previousWidth: this.previousWidth, previousHeight: this.previousHeight,
			hardwareCursorRow: this.hardwareCursorRow, previousViewportTop: this.previousViewportTop, geometry: this.geometry,
		};
		TuiMainScreen.resizeRenderState(state, width, height);
		this.previousViewportTop = state.previousViewportTop;
		this.geometry = state.geometry;
	}

	protected doRender(): void {
		if (this.stopped) return;
		this.updateMainGeometry();
		// Transient screens must never enter native history, even when the host
		// shrinks before delivering its resize notification. Keep them on 1049.
		if (!this.renderingMainOnStop && this.hasOverlay()) {
			this.renderOverlayScreen();
			return;
		}
		const returningFromOverlay = this.overlayScreenActive;
		if (returningFromOverlay) {
			this.updateMainGeometry();
			this.terminal.write("\x1b[?1049l");
			this.overlayScreenActive = false;
			this.overlayFrame = undefined;
		}
		const mainReflowed = this.geometry?.reflowed ?? false;
		const reflowMayHaveScrolled = this.geometry?.reflowMayHaveScrolled ?? false;
		const geometryChanged = this.geometry?.changed ?? false;
		if (this.geometry) {
			this.geometry.changed = false;
			this.geometry.reflowed = false;
			this.geometry.reflowMayHaveScrolled = false;
		}
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && (this.previousHeight !== height || geometryChanged);
		let prevViewportTop = this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// Render all components to get new lines. Strip OSC 133 zone sentinels before the
		// differential compare so they never enter previousLines or any terminal write.
		let newLines = this.render(width).map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
		const segmentLabel = "── Transcript refreshed · earlier output retained ──";
		if (this.segmentHeader) newLines.unshift(segmentLabel.slice(0, width));
		const rootLayout = this.children.length === 1 ? this.children[0]?.getScrollbackLayout?.() : undefined;
		const nextScrollbackLayout: ScrollbackLayout | undefined = rootLayout && {
			...rootLayout,
			bodyEnd: rootLayout.bodyEnd + Number(this.segmentHeader),
			anchors: rootLayout.anchors.map((anchor) => ({ ...anchor, row: anchor.row + Number(this.segmentHeader) })),
		};
		const oldScrollbackLayout = this.scrollbackLayout;
		let previousBodyEnd = oldScrollbackLayout?.bodyEnd ?? this.previousLines.length;
		const currentAnchorIds = new Set(nextScrollbackLayout?.anchors.map(({ id }) => id));
		// A pinned request may survive even when the entire visible tool tail was
		// evicted. That is a snapshot boundary, not proof of output continuity.
		const currentBlocks = nextScrollbackLayout?.blocks;
		const evictedVisibleBlock = !!currentBlocks && oldScrollbackLayout?.anchors.some(
			({ row, blockId }) => row >= prevViewportTop && blockId !== undefined &&
				!currentBlocks.has(blockId) && nextScrollbackLayout?.containsBlock?.(blockId));
		// Prelude anchors keep short conversations stable, but a shared welcome must
		// not disguise replacement of every transcript block (for example /new).
		const oldTranscriptAnchors = oldScrollbackLayout?.blocks
			? oldScrollbackLayout.anchors.filter(({ blockId }) => blockId !== undefined)
			: oldScrollbackLayout?.anchors;
		const replacedTranscript = !!nextScrollbackLayout && !!oldTranscriptAnchors?.length &&
			(evictedVisibleBlock || !oldTranscriptAnchors.some(({ id }) => currentAnchorIds.has(id)));
		let anchored = false;
		if (!mainReflowed && !replacedTranscript && nextScrollbackLayout && oldScrollbackLayout && this.viewportLayouts[0]?.component === this.children[0] && prevViewportTop > 0 &&
			this.previousLines.every((line) => isImageLine(line) || visibleWidth(line) <= width)) {
			const currentRows = new Map(nextScrollbackLayout.anchors.map(({ id, row }) => [id, row]));
			let match: { before: number; after: number } | undefined;
			for (const { id, row } of oldScrollbackLayout.anchors) {
				if (row > prevViewportTop || (match && row <= match.before)) continue;
				const after = currentRows.get(id);
				if (after === undefined) continue;
				const text = stripTerminalSequences(this.previousLines[row] ?? "").slice(oldScrollbackLayout.horizontalPadding ?? 0).trimEnd();
				const nextText = stripTerminalSequences(newLines[after] ?? "").slice(nextScrollbackLayout.horizontalPadding ?? 0).trimEnd();
				if (!text.trim() || text !== nextText) continue;
				match = { before: row, after };
			}
			if (match && !nextScrollbackLayout.blocks) {
				for (let row = match.before; row < prevViewportTop; row++) {
					if (stripTerminalSequences(this.previousLines[row] ?? "") !== stripTerminalSequences(newLines[match.after + row - match.before] ?? "")) {
						match = undefined;
						break;
					}
				}
			}
			if (match) {
				// Native history is immutable. Rebase the bounded logical cache at the
				// last shared transcript row; projection eviction must not replay it.
				const shiftedBodyEnd = match.after + oldScrollbackLayout.bodyEnd - match.before;
				const lastPossibleTop = Math.max(nextScrollbackLayout.bodyEnd, newLines.length - height);
				let top = Math.min(lastPossibleTop, Math.max(0, match.after + prevViewportTop - match.before));
				// An oversized footer may already occupy native history. Newly appended
				// body rows must start before that old footer, not be skipped as history.
				if (prevViewportTop > oldScrollbackLayout.bodyEnd && nextScrollbackLayout.bodyEnd > shiftedBodyEnd) {
					top = Math.min(top, shiftedBodyEnd);
				}
				// Keep surviving visible rows and newly introduced blocks addressable.
				// A distant anchor must never classify unseen output as native history.
				for (const { id, row } of oldScrollbackLayout.anchors) {
					const currentRow = currentRows.get(id);
					if (row >= prevViewportTop && currentRow !== undefined) top = Math.min(top, currentRow);
				}
				if (oldScrollbackLayout.blocks) {
					// Admission can change a source block id while retaining its emitted
					// row identities. That handoff is not a newly inserted block.
					const oldIds = new Set(oldScrollbackLayout.anchors.map(({ id }) => id));
					const retainedBlocks = new Set(nextScrollbackLayout.anchors
						.filter(({ id }) => oldIds.has(id)).map(({ blockId }) => blockId));
					for (const { row, blockId } of nextScrollbackLayout.anchors) {
						if (blockId !== undefined && !oldScrollbackLayout.blocks.has(blockId) && !retainedBlocks.has(blockId)) top = Math.min(top, row);
					}
				}
				const shift = top - prevViewportTop;
				this.previousLines = [...this.applyLineResets(newLines.slice(0, top)), ...this.previousLines.slice(prevViewportTop)];
				this.cursorRow += shift;
				this.hardwareCursorRow += shift;
				this.maxLinesRendered += shift;
				previousBodyEnd += shift;
				hardwareCursorRow += shift;
				prevViewportTop = viewportTop = this.previousViewportTop = top;
				anchored = true;
			}
		}
		this.scrollbackLayout = nextScrollbackLayout;
		const viewportLayouts = this.children.map((component) => ({
			component,
			key: component.getViewportLayoutKey?.(),
		}));
		const stableLayout = viewportLayouts.length > 0 &&
			viewportLayouts.length === this.viewportLayouts.length &&
			viewportLayouts.every(({ component, key }, index) =>
				key !== undefined && component === this.viewportLayouts[index]?.component &&
				key === this.viewportLayouts[index]?.key);
		this.viewportLayouts = viewportLayouts;
		this.hadOverlays = this.hasOverlayEntries;

		// A native scrollback viewport cannot move backwards without clearing history.
		// When only addressable rows shrink, absorb the freed space in the active
		// screen instead. The composer stays at the bottom, historical rows stay unique,
		// and later output consumes this temporary space before scrolling again.
		if (
			(stableLayout || anchored || !nextScrollbackLayout) && ((!widthChanged && !heightChanged && !this.resizePending) || anchored || (returningFromOverlay && !mainReflowed)) &&
			prevViewportTop > 0 && newLines.length > prevViewportTop &&
			newLines.length < prevViewportTop + height &&
			!this.hasImageAtOrBelow(this.previousLines, prevViewportTop) && !this.hasImageAtOrBelow(newLines, prevViewportTop)
		) {
			let unchangedHistory = true;
			for (let i = 0; i < prevViewportTop; i++) {
				if (stripTerminalSequences(this.previousLines[i] ?? "") !== stripTerminalSequences(newLines[i] ?? "")) {
					unchangedHistory = false;
					break;
				}
			}
			if (unchangedHistory) {
				const padding = Array<string>(prevViewportTop + height - newLines.length).fill("");
				// Keep a table/code block contiguous. Known document layouts reserve
				// the reclaimed space between transcript and footer, not inside prose.
				const insertion = nextScrollbackLayout?.bodyEnd ?? prevViewportTop;
				newLines = [...newLines.slice(0, insertion), ...padding, ...newLines.slice(insertion)];
			}
		}

		// Extract cursor position before applying line resets (marker must be found first)
		let cursorPos = this.extractCursorPosition(newLines, height);

		newLines = this.applyLineResets(newLines);

		// Helper to redraw either the complete logical document or only the visible viewport.
		// Viewport-only redraws preserve the terminal's native scrollback.
		const fullRender = (clear: boolean, viewportOnly = false): void => {
			// Native scrollback cannot move backwards with a shrinking document. Keep the
			// previous viewport origin so rows already scrolled out are not painted twice,
			// and growth still writes every row before it scrolls out.
			if (viewportOnly && !this.resizePending && newLines.length <= prevViewportTop) {
				// Nothing remains addressable on screen; rebuild with one consistent origin.
				viewportOnly = false;
			}
			const start = viewportOnly ? prevViewportTop : 0;
			if (clear && !viewportOnly && this.previousLines.length > 0 && (prevViewportTop > 0 || replacedTranscript || reflowMayHaveScrolled) && !this.segmentHeader) {
				this.segmentHeader = true;
				newLines.unshift(segmentLabel.slice(0, width));
				if (cursorPos) cursorPos = { ...cursorPos, row: cursorPos.row + 1 };
				if (this.scrollbackLayout) this.scrollbackLayout = {
					...this.scrollbackLayout,
					bodyEnd: this.scrollbackLayout.bodyEnd + 1,
					anchors: this.scrollbackLayout.anchors.map((anchor) => ({ ...anchor, row: anchor.row + 1 })),
				};
			}
			this.fullRedrawCount += 1;
			const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
			output.append("\x1b[?2026h"); // Begin synchronized output
			if (clear) {
				// Before starting a new snapshot, commit the old visible transcript.
				// Otherwise a projection with no overlap would silently discard rows
				// that had been displayed but had not reached native history yet.
				const archiveRows = !viewportOnly && (prevViewportTop > 0 || replacedTranscript || reflowMayHaveScrolled)
					? widthChanged || mainReflowed ? height : Math.min(height, Math.max(0, previousBodyEnd - prevViewportTop)) : 0;
				if (archiveRows > 0) {
					for (let row = archiveRows; row < height; row++) {
						output.append(`\x1b[${row + 1};1H\x1b[2K`);
					}
					output.append(`\x1b[${height};1H${"\r\n".repeat(archiveRows)}`);
				}
				// Native-history images belong to the retained output snapshot.
				// Free only images whose headers are still addressable on screen.
				output.append(this.deleteKittyImages(this.collectKittyImageIds(this.previousLines.slice(prevViewportTop + archiveRows))));
				// ED 2 may save the old screen on some hosts; ED 3 destroys shell
				// history. Erase addressable rows in place for every redraw.
				output.append("\x1b[H");
				for (let row = 0; row < height; row++) {
					if (row > 0) output.append("\x1b[1B");
					output.append("\x1b[2K");
				}
				output.append("\x1b[H");
			}
			for (let i = start; i < newLines.length; i++) {
				if (i > start) output.append("\r\n");
				const line = newLines[i]!;
				const isImage = isImageLine(line);
				const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i) : 1;
				if (imageReservedRows > 1 && imageReservedRows <= height) {
					for (let row = 1; row < imageReservedRows; row++) {
						output.append("\r\n");
					}
					output.append(`\x1b[${imageReservedRows - 1}A`);
					output.append(line);
					output.append(`\x1b[${imageReservedRows - 1}B`);
					i += imageReservedRows - 1;
					continue;
				}
				output.append(line);
			}
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Reset max lines when clearing, otherwise track growth
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			this.previousViewportTop = Math.max(start, newLines.length - height);
			this.positionHardwareCursor(cursorPos, newLines.length, output);
			output.append("\x1b[?2026l"); // Present only after restoring the input cursor.
			output.flush();
			this.previousLines = newLines;
			this.previousWidth = width;
			this.previousHeight = height;
		};

		const debugRedraw = process.env.PI_DEBUG_REDRAW === "1";
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const logPath = path.join(this.logDirectory, "pi-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			fs.appendFileSync(logPath, msg);
		};

		// Preserve the emitted prefix only when it can still be aligned. A genuine
		// reflow without a safe anchor starts a labelled snapshot rather than dropping
		// pending output by painting only the final screenful.
		const resizeOriginPreserved = !mainReflowed && (anchored || this.previousLines.slice(0, prevViewportTop).every((line, row) =>
			visibleWidth(line) <= width && stripTerminalSequences(line) === stripTerminalSequences(newLines[row] ?? "")));
		if (replacedTranscript) {
			fullRender(true);
			return;
		}
		if (returningFromOverlay) {
			fullRender(true, resizeOriginPreserved);
			return;
		}
		if (this.resizePending) {
			fullRender(true, resizeOriginPreserved);
			if (this.resizeTimer === undefined) this.resizePending = false;
			return;
		}

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			fullRender(true, this.previousLines.length > 0 && resizeOriginPreserved);
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			fullRender(true, this.previousLines.length > 0 && resizeOriginPreserved);
			return;
		}

		// A shorter document can bring previously scrolled rows back into view.
		// Rebuild the complete projection so the viewport is full and native history
		// contains each row once; neither tail replay nor blank padding can do both.
		if (Math.max(0, newLines.length - height) < prevViewportTop) {
			logRedraw("document shrink reveals scrolled rows");
			fullRender(true);
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or PI_CLEAR_ON_SHRINK=0 env var
		if (this.getClearOnShrink() && newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true, true);
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) {
			const expandedRange = this.expandChangedRangeForKittyImages(firstChanged, lastChanged, newLines);
			firstChanged = expandedRange.firstChanged;
			lastChanged = expandedRange.lastChanged;
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
				output.append("\x1b[?2026h");
				output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					fullRender(true, true);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) output.append(`\x1b[${lineDiff}B`);
				else if (lineDiff < 0) output.append(`\x1b[${-lineDiff}A`);
				output.append("\r");
				// Clear extra lines without scrolling
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true, true);
					return;
				}
				const clearStartOffset = newLines.length === 0 ? 0 : 1;
				if (extraLines > 0 && clearStartOffset > 0) {
					output.append(`\x1b[${clearStartOffset}B`);
				}
				for (let i = 0; i < extraLines; i++) {
					output.append("\r\x1b[2K");
					if (i < extraLines - 1) output.append("\x1b[1B");
				}
				const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
				if (moveBack > 0) {
					output.append(`\x1b[${moveBack}A`);
				}
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
				this.positionHardwareCursor(cursorPos, newLines.length, output);
				output.append("\x1b[?2026l");
				output.flush();
			}
			this.previousLines = newLines;
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			return;
		}

		// Native scrollback is not addressable. If its text changed, retaining the old prefix
		// would splice stale rows onto the new document, even when its total height grew.
		// Style-only changes can still repaint the viewport without replaying history.
		if (firstChanged < prevViewportTop) {
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			for (let i = firstChanged; i < prevViewportTop; i++) {
				const oldLine = this.previousLines[i] ?? "";
				const newLine = newLines[i] ?? "";
				if (oldLine !== newLine && stripTerminalSequences(oldLine) !== stripTerminalSequences(newLine)) {
					fullRender(true);
					return;
				}
			}
			fullRender(true, true);
			return;
		}

		// Render from first changed line to end
		// Keep updates wrapped in synchronized output while writing bounded chunks.
		const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
		output.append("\x1b[?2026h"); // Begin synchronized output
		output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				output.append(`\x1b[${moveToBottom}B`);
			}
			const scroll = moveTargetRow - prevViewportBottom;
			output.append("\r\n".repeat(scroll));
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			output.append(`\x1b[${lineDiff}B`); // Move down
		} else if (lineDiff < 0) {
			output.append(`\x1b[${-lineDiff}A`); // Move up
		}

		output.append(appendStart ? "\r\n" : "\r"); // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) output.append("\r\n");
			const line = newLines[i]!;
			const isImage = isImageLine(line);
			const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;
			if (imageReservedRows > 1) {
				const imageStartScreenRow = i - viewportTop;
				if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
					logRedraw(`kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`);
					fullRender(true);
					return;
				}

				output.append("\x1b[2K");
				for (let row = 1; row < imageReservedRows; row++) {
					output.append("\r\n\x1b[2K");
				}
				output.append(`\x1b[${imageReservedRows - 1}A`);
				output.append(line);
				output.append(`\x1b[${imageReservedRows - 1}B`);
				i += imageReservedRows - 1;
				continue;
			}

			output.append("\x1b[2K"); // Clear current line
			if (!isImage && visibleWidth(line) > width) {
				// Log all lines to crash file for debugging
				const crashLogPath = path.join(this.logDirectory, "pi-crash.log");
				const crashData = [
					`Crash at ${new Date().toISOString()}`,
					`Terminal width: ${width}`,
					`Line ${i} visible width: ${visibleWidth(line)}`,
					"",
					"=== All rendered lines ===",
					...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				fs.writeFileSync(crashLogPath, crashData);

				// Clean up terminal state before throwing
				this.stop();

				const errorMsg = [
					`Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
					"",
					"This is likely caused by a custom TUI component not truncating its output.",
					"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
					"",
					`Debug log written to: ${crashLogPath}`,
				].join("\n");
				throw new Error(errorMsg);
			}
			output.append(line);
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				output.append(`\x1b[${moveDown}B`);
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				output.append("\r\n\x1b[2K");
			}
			// Move cursor back to end of new content
			output.append(`\x1b[${extraLines}A`);
		}

		if (process.env.PI_TUI_DEBUG === "1") {
			const debugDir = "/tmp/tui";
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				`[${output.length} chars written in bounded chunks]`,
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
		}

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		// Restore the IME anchor before presenting the frame, including cursor visibility.
		this.positionHardwareCursor(cursorPos, newLines.length, output);
		output.append("\x1b[?2026l");
		output.flush();

		this.previousLines = newLines;
		this.previousWidth = width;
		this.previousHeight = height;
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private positionHardwareCursor(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
		output?: BoundedTerminalWriter,
	): void {
		if (!cursorPos || totalLines <= 0) {
			if (output) output.append("\x1b[?25l");
			else this.terminal.hideCursor();
			return;
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			if (output) output.append(buffer);
			else this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (output) {
			output.append(this.getShowHardwareCursor() ? "\x1b[?25h" : "\x1b[?25l");
		} else if (this.getShowHardwareCursor()) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}
