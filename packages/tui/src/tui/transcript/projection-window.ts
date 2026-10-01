import type { TranscriptCell } from './model.js';

export interface TranscriptProjection {
  readonly cells: readonly TranscriptCell[];
  readonly hiddenTurns: number;
  readonly foldedCells: number;
  readonly visitedCells: number;
  readonly windowRolls: number;
}

export interface TranscriptCellLocation {
  readonly index: number;
  readonly turnIndex: number;
}

export interface TranscriptTurnRange {
  readonly start: number;
  readonly end: number;
}

export interface TranscriptProjectionSource {
  readonly length: number;
  readonly revision?: number;
  /** Only return a revision for cells owned by this source, including their nested data. */
  cellRevision?(cell: TranscriptCell): number | undefined;
  readonly turnCount: number;
  cellAt(index: number): TranscriptCell | undefined;
  locateCell(id: string): TranscriptCellLocation | undefined;
  turnRange(turnIndex: number): TranscriptTurnRange | undefined;
}

export class TranscriptProjectionWindow {
  private anchorCellId: string | undefined;
  private hiddenTurns = 0;
  private windowRolls = 0;
  /**
   * Append-only projections fix each turn's fold when the turn is first seen.
   * Native terminal history cannot be rewritten, so a growing turn must only
   * extend its visible tail instead of moving the fold boundary.
   */
  private readonly appendOnlyFolds = new Map<string, number>();

  constructor(
    private readonly maxInitialTurns = 30,
    private readonly maxCellsPerTurn = 120,
    private readonly maxProjectedTurns = maxInitialTurns * 2,
    private readonly maxProjectedCells = 1_000,
  ) {}

  /**
   * Project the source into the cells to render. With `appendOnly`, an established
   * window never rolls, drops earlier turns, or re-folds a turn; later cells only
   * extend the projection. Regular terminal mode needs this because rows already
   * written to native scrollback cannot be changed in place.
   */
  project(
    input: readonly TranscriptCell[] | TranscriptProjectionSource,
    options: { readonly appendOnly?: boolean } = {},
  ): TranscriptProjection {
    const appendOnly = options.appendOnly === true;
    const source = Array.isArray(input)
      ? new ArrayTranscriptProjectionSource(input)
      : (input as TranscriptProjectionSource);
    if (source.length === 0) {
      this.reset();
      return {
        cells: [],
        hiddenTurns: 0,
        foldedCells: 0,
        visitedCells: 0,
        windowRolls: 0,
      };
    }
    if (this.anchorCellId) {
      const anchor = source.locateCell(this.anchorCellId);
      if (anchor && appendOnly) {
        this.hiddenTurns = anchor.turnIndex;
        return this.projectTurns(source, anchor.turnIndex, true);
      }
      if (anchor) {
        const projectedTurns = source.turnCount - anchor.turnIndex;
        const projectedTurnLimit = Math.max(
          normalizeLimit(this.maxInitialTurns),
          normalizeLimit(this.maxProjectedTurns),
        );
        if (projectedTurns <= projectedTurnLimit) {
          this.hiddenTurns = anchor.turnIndex;
          return this.projectTurns(source, anchor.turnIndex);
        }
        this.windowRolls += 1;
        return this.anchorTrailingWindow(source, appendOnly);
      }
      this.anchorCellId = undefined;
      this.hiddenTurns = 0;
    }

    return this.anchorTrailingWindow(source, appendOnly);
  }

  reset(): void {
    this.anchorCellId = undefined;
    this.hiddenTurns = 0;
    this.windowRolls = 0;
    this.appendOnlyFolds.clear();
  }

  private anchorTrailingWindow(
    source: TranscriptProjectionSource,
    appendOnly: boolean,
  ): TranscriptProjection {
    // A new window starts a new fold baseline.
    this.appendOnlyFolds.clear();
    const retainedTurns = normalizeLimit(this.maxInitialTurns);
    const firstTurn = Math.max(0, source.turnCount - retainedTurns);
    const range = source.turnRange(firstTurn);
    this.anchorCellId = range ? source.cellAt(range.start)?.id : undefined;
    this.hiddenTurns = firstTurn;
    return this.projectTurns(source, firstTurn, appendOnly, true);
  }

  private projectTurns(
    source: TranscriptProjectionSource,
    firstTurn: number,
    appendOnly = false,
    establishing = false,
  ): TranscriptProjection {
    const limit = Math.max(2, normalizeLimit(this.maxCellsPerTurn));
    const cellBudget = Math.max(limit + 1, normalizeLimit(this.maxProjectedCells));
    // An established append-only window keeps every turn it already shows.
    const applyBudget = !appendOnly || establishing;
    let effectiveFirstTurn = applyBudget ? source.turnCount : firstTurn;
    let projectedCellCount = 0;
    for (
      let turnIndex = source.turnCount - 1;
      applyBudget && turnIndex >= firstTurn;
      turnIndex -= 1
    ) {
      const range = source.turnRange(turnIndex);
      if (!range) continue;
      const turnLength = Math.max(0, range.end - range.start);
      const turnProjectionSize = turnLength <= limit ? turnLength : limit + 1;
      if (projectedCellCount > 0 && projectedCellCount + turnProjectionSize > cellBudget) break;
      effectiveFirstTurn = turnIndex;
      projectedCellCount += turnProjectionSize;
    }
    if (effectiveFirstTurn > firstTurn) {
      const range = source.turnRange(effectiveFirstTurn);
      this.anchorCellId = range ? source.cellAt(range.start)?.id : this.anchorCellId;
      this.hiddenTurns = effectiveFirstTurn;
    }

    const projected: TranscriptCell[] = [];
    let foldedCells = 0;
    let visitedCells = 0;
    for (let turnIndex = effectiveFirstTurn; turnIndex < source.turnCount; turnIndex += 1) {
      const range = source.turnRange(turnIndex);
      if (!range || range.end <= range.start) continue;
      const turnLength = range.end - range.start;
      const first = source.cellAt(range.start);
      visitedCells += 1;
      if (!first) continue;
      const turn = first.turnId?.trim() || `cell:${first.id}`;
      let hidden = turnLength <= limit ? 0 : turnLength - limit;
      if (appendOnly) {
        const fixed = this.appendOnlyFolds.get(turn);
        if (fixed === undefined) this.appendOnlyFolds.set(turn, hidden);
        else hidden = Math.min(fixed, Math.max(0, turnLength - 1));
      }
      if (hidden === 0) {
        projected.push(first);
        for (let index = range.start + 1; index < range.end; index += 1) {
          const cell = source.cellAt(index);
          visitedCells += 1;
          if (cell) projected.push(cell);
        }
        continue;
      }

      const tail: TranscriptCell[] = [];
      for (let index = range.start + 1 + hidden; index < range.end; index += 1) {
        const cell = source.cellAt(index);
        visitedCells += 1;
        if (cell) tail.push(cell);
      }
      projected.push(
        first,
        {
          id: `projection-fold:${turn}:${tail[0]?.id ?? first.id}`,
          kind: 'final-summary',
          status: 'succeeded',
          content: `… ${hidden} earlier steps folded`,
          createdAtMs: first.createdAtMs,
          updatedAtMs: tail[0]?.updatedAtMs ?? first.updatedAtMs,
          ...(first.turnId ? { turnId: first.turnId } : {}),
        },
        ...tail,
      );
      foldedCells += hidden;
    }
    return {
      cells: projected,
      hiddenTurns: this.hiddenTurns,
      foldedCells,
      visitedCells,
      windowRolls: this.windowRolls,
    };
  }
}

class ArrayTranscriptProjectionSource implements TranscriptProjectionSource {
  readonly turnCount: number;
  private readonly turnStarts: number[] = [];
  private readonly locations = new Map<string, TranscriptCellLocation>();

  constructor(private readonly cells: readonly TranscriptCell[]) {
    let previousTurn: string | undefined;
    let turnIndex = -1;
    cells.forEach((cell, index) => {
      const turn = turnKey(cell);
      if (turn !== previousTurn) {
        this.turnStarts.push(index);
        turnIndex += 1;
      }
      this.locations.set(cell.id, { index, turnIndex });
      previousTurn = turn;
    });
    this.turnCount = this.turnStarts.length;
  }

  get length(): number {
    return this.cells.length;
  }

  cellAt(index: number): TranscriptCell | undefined {
    return this.cells[index];
  }

  locateCell(id: string): TranscriptCellLocation | undefined {
    return this.locations.get(id);
  }

  turnRange(turnIndex: number): TranscriptTurnRange | undefined {
    const start = this.turnStarts[turnIndex];
    if (start === undefined) return undefined;
    return {
      start,
      end: this.turnStarts[turnIndex + 1] ?? this.cells.length,
    };
  }
}

function turnKey(cell: TranscriptCell): string {
  return cell.turnId?.trim() || `cell:${cell.id}`;
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}
