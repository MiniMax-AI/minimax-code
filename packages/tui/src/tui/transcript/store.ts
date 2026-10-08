import type { TranscriptCell, TranscriptCellUpdate } from './model.js';
import type {
  TranscriptCellLocation,
  TranscriptProjectionSource,
  TranscriptTurnRange,
} from './projection-window.js';

export interface TranscriptActivitySource {
  readonly length: number;
  findVisibleError(error: string): { readonly turnId?: string } | undefined;
  latestSettledFailure(): { readonly turnId?: string } | undefined;
  hasConcreteTurnActivity(turnId: string): boolean;
}

export class TranscriptStore implements TranscriptProjectionSource, TranscriptActivitySource {
  private readonly orderedIds: string[] = [];
  private readonly cells = new Map<string, TranscriptCell>();
  private readonly indexById = new Map<string, number>();
  private readonly turnStarts: number[] = [];
  private readonly pendingTextDeltas = new Map<string, string>();
  private revisionValue = 0;
  private readonly cellRevisions = new Map<string, number>();

  constructor(initialCells: readonly TranscriptCell[] = []) {
    for (const cell of initialCells) {
      this.upsert(cell);
    }
  }

  get(id: string): TranscriptCell | undefined {
    const cell = this.cells.get(id);
    return cell ? { ...cell } : undefined;
  }

  get length(): number {
    return this.orderedIds.length;
  }

  get revision(): number {
    return this.revisionValue;
  }

  cellRevision(cell: TranscriptCell): number | undefined {
    return this.cells.get(cell.id) === cell ? this.cellRevisions.get(cell.id) : undefined;
  }

  get turnCount(): number {
    return this.turnStarts.length;
  }

  cellAt(index: number): TranscriptCell | undefined {
    const id = this.orderedIds[index];
    return id === undefined ? undefined : this.cells.get(id);
  }

  locateCell(id: string): TranscriptCellLocation | undefined {
    const index = this.indexById.get(id);
    if (index === undefined) return undefined;
    return { index, turnIndex: this.findTurnIndex(index) };
  }

  turnRange(turnIndex: number): TranscriptTurnRange | undefined {
    const start = this.turnStarts[turnIndex];
    if (start === undefined) return undefined;
    return {
      start,
      end: this.turnStarts[turnIndex + 1] ?? this.orderedIds.length,
    };
  }

  snapshot(): TranscriptCell[] {
    return this.orderedIds.flatMap((id) => {
      const cell = this.cells.get(id);
      return cell ? [{ ...cell }] : [];
    });
  }

  findVisibleError(error: string): { readonly turnId?: string } | undefined {
    for (let index = this.orderedIds.length - 1; index >= 0; index -= 1) {
      const cell = this.cellAt(index);
      if (cell?.kind !== 'error' || cell.content.trim() !== error) continue;
      return cell.turnId ? { turnId: cell.turnId } : {};
    }
    return undefined;
  }

  latestSettledFailure(): { readonly turnId?: string } | undefined {
    for (let index = this.orderedIds.length - 1; index >= 0; index -= 1) {
      const cell = this.cellAt(index);
      if (!cell?.turnId) continue;
      if (cell.status === 'pending' || cell.status === 'running') return undefined;
      if (cell.kind === 'error' && cell.status === 'failed') return { turnId: cell.turnId };
      return undefined;
    }
    return undefined;
  }

  hasConcreteTurnActivity(turnId: string): boolean {
    for (let index = this.orderedIds.length - 1; index >= 0; index -= 1) {
      const cell = this.cellAt(index);
      if (!cell || cell.turnId !== turnId) continue;
      if (cell.status !== 'pending' && cell.status !== 'running') continue;
      if (cell.kind === 'tool') return true;
      if (
        (cell.kind === 'thinking' ||
          cell.kind === 'assistant' ||
          cell.kind === 'assistant-preamble') &&
        cell.content.trim()
      ) {
        return true;
      }
    }
    return false;
  }

  upsert(update: TranscriptCellUpdate): TranscriptCell {
    const current = this.cells.get(update.id);
    const next = current ? mergeCell(current, update) : requireCompleteCell(update);

    if (!current) {
      const index = this.orderedIds.length;
      const previous = this.cellAt(index - 1);
      this.orderedIds.push(next.id);
      this.indexById.set(next.id, index);
      if (!previous || turnKey(previous) !== turnKey(next)) this.turnStarts.push(index);
    }
    this.cells.set(next.id, next);
    if (current && turnKey(current) !== turnKey(next)) this.rebuildIndexes();
    this.revisionValue += 1;
    this.cellRevisions.set(next.id, this.revisionValue);
    return { ...next };
  }

  remove(id: string): boolean {
    if (!this.cells.delete(id)) return false;
    this.cellRevisions.delete(id);
    const index = this.orderedIds.indexOf(id);
    if (index >= 0) this.orderedIds.splice(index, 1);
    this.pendingTextDeltas.delete(id);
    this.rebuildIndexes();
    this.revisionValue += 1;
    return true;
  }

  moveBefore(id: string, anchorId: string): boolean {
    const sourceIndex = this.indexById.get(id);
    const anchorIndex = this.indexById.get(anchorId);
    if (
      sourceIndex === undefined ||
      anchorIndex === undefined ||
      sourceIndex === anchorIndex ||
      sourceIndex + 1 === anchorIndex
    ) {
      return false;
    }
    this.orderedIds.splice(sourceIndex, 1);
    const nextAnchorIndex = this.orderedIds.indexOf(anchorId);
    this.orderedIds.splice(nextAnchorIndex, 0, id);
    this.rebuildIndexes();
    this.revisionValue += 1;
    return true;
  }

  moveToEnd(id: string): boolean {
    const sourceIndex = this.indexById.get(id);
    if (sourceIndex === undefined || sourceIndex === this.orderedIds.length - 1) return false;
    this.orderedIds.splice(sourceIndex, 1);
    this.orderedIds.push(id);
    this.rebuildIndexes();
    this.revisionValue += 1;
    return true;
  }

  queueTextDelta(id: string, delta: string): void {
    if (!delta) return;
    if (!this.cells.has(id)) {
      throw new Error(`Cannot queue transcript delta for unknown cell: ${id}`);
    }
    this.pendingTextDeltas.set(id, `${this.pendingTextDeltas.get(id) ?? ''}${delta}`);
  }

  flushTextDeltas(updatedAtMs: number): string[] {
    const updatedIds: string[] = [];

    for (const [id, delta] of this.pendingTextDeltas) {
      const cell = this.cells.get(id);
      if (!cell) continue;
      this.cells.set(id, {
        ...cell,
        content: `${cell.content}${delta}`,
        updatedAtMs,
      });
      updatedIds.push(id);
      this.cellRevisions.set(id, this.revisionValue + 1);
    }

    this.pendingTextDeltas.clear();
    if (updatedIds.length > 0) this.revisionValue += 1;
    return updatedIds;
  }

  clear(): void {
    const hadCells = this.orderedIds.length > 0;
    this.orderedIds.length = 0;
    this.cells.clear();
    this.cellRevisions.clear();
    this.indexById.clear();
    this.turnStarts.length = 0;
    this.pendingTextDeltas.clear();
    if (hadCells) this.revisionValue += 1;
  }

  replaceDurableProjection(projectDurable: () => void): void {
    const current = this.snapshot();
    let durableBefore = 0;
    const retained = current.flatMap((cell, index) => {
      if (!cell.ephemeral) {
        durableBefore += 1;
        return [];
      }
      return [
        {
          cell,
          previousDurableId: findDurableId(current, index, -1),
          nextDurableId: findDurableId(current, index, 1),
          durableBefore,
        },
      ];
    });

    const previousTurns = new Set(
      current.flatMap((cell) => (!cell.ephemeral && cell.turnId ? [cell.turnId] : [])),
    );

    this.clear();
    try {
      projectDurable();
    } finally {
      const projectedDurableIds = this.orderedIds.filter((id) => !this.cells.get(id)?.ephemeral);
      const projectedTurns = new Set(
        projectedDurableIds.flatMap((id) => {
          const turnId = this.cells.get(id)?.turnId;
          return turnId ? [turnId] : [];
        }),
      );
      // Turn ids are comparable when at least one earlier turn is still projected.
      const comparableTurns = [...previousTurns].some((turnId) => projectedTurns.has(turnId));
      // An edit removes later turns from history. One-time feedback of a removed turn
      // (its run duration, terminal error or shell block) has nowhere to go and is
      // dropped instead of being placed by position in an unrelated spot (#426).
      const removedTurn = (cell: TranscriptCell): boolean =>
        comparableTurns &&
        isTurnFeedback(cell) &&
        previousTurns.has(cell.turnId ?? '') &&
        !projectedTurns.has(cell.turnId ?? '');
      let turnEnds: Map<string, number> | undefined;
      const lastIndexOfTurn = (): Map<string, number> => {
        if (turnEnds) return turnEnds;
        turnEnds = new Map();
        this.orderedIds.forEach((id, index) => {
          const turnId = this.cells.get(id)?.turnId;
          if (turnId) turnEnds?.set(turnId, index);
        });
        return turnEnds;
      };
      const anchors = retained.map(
        ({ cell, previousDurableId, nextDurableId, durableBefore: durableCountBefore }) => {
          if (nextDurableId && this.cells.has(nextDurableId)) return nextDurableId;
          if (previousDurableId) {
            const previousIndex = this.indexById.get(previousDurableId);
            if (previousIndex !== undefined) return this.orderedIds[previousIndex + 1];
          }
          // Live and history projections use different cell ids. A turn-scoped
          // cell (a run-duration note, a terminal error) stays after its turn,
          // so notes kept in history do not drift or stack up (#426).
          const turnEnd = cell.turnId ? lastIndexOfTurn().get(cell.turnId) : undefined;
          if (turnEnd !== undefined) return this.orderedIds[turnEnd + 1];
          return projectedDurableIds[durableCountBefore];
        },
      );
      retained.forEach(({ cell }, index) => {
        if (this.cells.has(cell.id) || removedTurn(cell)) return;
        this.upsert(cell);
        const anchor = anchors[index];
        if (anchor) this.moveBefore(cell.id, anchor);
      });
    }
  }

  private findTurnIndex(cellIndex: number): number {
    let low = 0;
    let high = this.turnStarts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.turnStarts[middle] ?? 0) <= cellIndex) low = middle + 1;
      else high = middle;
    }
    return Math.max(0, low - 1);
  }

  private rebuildIndexes(): void {
    this.indexById.clear();
    this.turnStarts.length = 0;
    let previousTurn: string | undefined;
    this.orderedIds.forEach((id, index) => {
      this.indexById.set(id, index);
      const cell = this.cells.get(id);
      if (!cell) return;
      const turn = turnKey(cell);
      if (turn !== previousTurn) this.turnStarts.push(index);
      previousTurn = turn;
    });
  }
}

function findDurableId(
  cells: readonly TranscriptCell[],
  startIndex: number,
  direction: -1 | 1,
): string | undefined {
  for (let index = startIndex + direction; index >= 0 && index < cells.length; index += direction) {
    const cell = cells[index];
    if (cell && !cell.ephemeral) return cell.id;
  }
  return undefined;
}

function isTurnFeedback(cell: TranscriptCell): boolean {
  return (
    cell.kind === 'turn-duration' ||
    (cell.ephemeral === true && (cell.kind === 'error' || cell.kind === 'shell'))
  );
}

function turnKey(cell: TranscriptCell): string {
  return cell.turnId?.trim() || `cell:${cell.id}`;
}

function mergeCell(current: TranscriptCell, update: TranscriptCellUpdate): TranscriptCell {
  return {
    ...current,
    ...update,
    id: current.id,
    createdAtMs: current.createdAtMs,
  };
}

function requireCompleteCell(update: TranscriptCellUpdate): TranscriptCell {
  if (
    update.kind === undefined ||
    update.status === undefined ||
    update.content === undefined ||
    update.createdAtMs === undefined
  ) {
    throw new Error(`New transcript cell ${update.id} is missing required fields`);
  }

  return {
    ...update,
    kind: update.kind,
    status: update.status,
    content: update.content,
    createdAtMs: update.createdAtMs,
    updatedAtMs: update.updatedAtMs ?? update.createdAtMs,
  };
}
