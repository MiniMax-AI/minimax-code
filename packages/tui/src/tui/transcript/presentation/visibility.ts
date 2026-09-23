import type { TranscriptCell } from '../model.js';
import type {
  TranscriptCellLocation,
  TranscriptProjectionSource,
  TranscriptTurnRange,
} from '../projection-window.js';

/**
 * Presentation-only suffix mask used while replacing the latest user turn.
 * The canonical transcript stays intact so cancel and Runtime retries do not
 * need to reconstruct local history.
 */
export class TranscriptVisibilityProjection implements TranscriptProjectionSource {
  private hiddenFromSourceMessageId: string | undefined;
  private hiddenTerminalDurationId: string | undefined;
  private visibilityRevision = 0;
  private visibleLengthCache:
    | {
        readonly sourceRevision: number;
        readonly visibilityRevision: number;
        readonly length: number;
      }
    | undefined;

  constructor(private readonly source: TranscriptProjectionSource) {}

  get revision(): number | undefined {
    const sourceRevision = this.source.revision;
    return sourceRevision === undefined ? undefined : sourceRevision + this.visibilityRevision;
  }

  get length(): number {
    return this.visibleLength();
  }

  get turnCount(): number {
    const length = this.visibleLength();
    if (length === 0) return 0;
    const lastCell = this.source.cellAt(length - 1);
    const location = lastCell ? this.source.locateCell(lastCell.id) : undefined;
    return location ? location.turnIndex + 1 : 0;
  }

  readonly hideFromSourceMessage = (sourceMessageId: string | undefined): void => {
    if (this.hiddenFromSourceMessageId === sourceMessageId) return;
    this.hiddenFromSourceMessageId = sourceMessageId;
    this.hiddenTerminalDurationId = undefined;
    if (sourceMessageId) {
      let durationId: string | undefined;
      for (let index = this.source.length - 1; index >= 0; index -= 1) {
        const cell = this.source.cellAt(index);
        if (cell?.kind === 'turn-duration') durationId = cell.id;
        if (cell?.sourceMessageId === sourceMessageId) {
          this.hiddenTerminalDurationId = durationId;
          break;
        }
      }
    }
    this.visibilityRevision += 1;
  };

  cellAt(index: number): TranscriptCell | undefined {
    if (index < 0 || index >= this.visibleLength()) return undefined;
    return this.source.cellAt(index);
  }

  locateCell(id: string): TranscriptCellLocation | undefined {
    const location = this.source.locateCell(id);
    return location && location.index < this.visibleLength() ? location : undefined;
  }

  turnRange(turnIndex: number): TranscriptTurnRange | undefined {
    const range = this.source.turnRange(turnIndex);
    const length = this.visibleLength();
    if (!range || range.start >= length) return undefined;
    return { start: range.start, end: Math.min(range.end, length) };
  }

  private visibleLength(): number {
    const sourceMessageId = this.hiddenFromSourceMessageId;
    if (!sourceMessageId) return this.source.length;
    const sourceRevision = this.source.revision;
    if (
      sourceRevision !== undefined &&
      this.visibleLengthCache?.sourceRevision === sourceRevision &&
      this.visibleLengthCache.visibilityRevision === this.visibilityRevision
    ) {
      return this.visibleLengthCache.length;
    }
    let length = this.source.length;
    for (let index = this.source.length - 1; index >= 0; index -= 1) {
      if (this.source.cellAt(index)?.sourceMessageId !== sourceMessageId) continue;
      length = index;
      break;
    }
    // Runtime can refresh rewound history before the edit RPC settles. Keep
    // the captured footer hidden if that refresh removes the message anchor.
    if (length === this.source.length && this.hiddenTerminalDurationId) {
      length = this.source.locateCell(this.hiddenTerminalDurationId)?.index ?? length;
    }
    if (sourceRevision !== undefined) {
      this.visibleLengthCache = {
        sourceRevision,
        visibilityRevision: this.visibilityRevision,
        length,
      };
    }
    return length;
  }
}
