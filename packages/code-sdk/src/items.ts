import type { ExecItem, RawToolCall, ThreadEvent, ThreadItem } from './types.js';

interface ItemState {
  type: ExecItem['type'];
  text: string;
  toolCall: RawToolCall | undefined;
  completed: boolean;
  /** Serialized last snapshot, used to drop identical repeated `item.updated` events. */
  snapshot: string;
}

/**
 * Folds CLI `item.*` events into SDK items.
 *
 * - Items are merged by `id`; events of different items may interleave in any order.
 * - Snapshot updates (no `contentDelta`) identical to the previous snapshot are reported as
 *   duplicates so the stream can drop them. Text deltas are never deduplicated.
 * - Items without `item.completed` are marked `incomplete` in {@link items}.
 */
export class ItemAccumulator {
  private readonly states = new Map<string, ItemState>();

  /** Applies one event. Returns false when the event is a duplicate snapshot update. */
  apply(event: ThreadEvent): boolean {
    if (
      event.type !== 'item.started' &&
      event.type !== 'item.updated' &&
      event.type !== 'item.completed'
    ) {
      return true;
    }
    const { item } = event;
    const snapshot = item.contentDelta === undefined ? JSON.stringify(item) : '';
    let state = this.states.get(item.id);
    if (
      state &&
      event.type === 'item.updated' &&
      snapshot &&
      state.snapshot === snapshot &&
      !state.completed
    ) {
      return false;
    }
    if (!state) {
      state = { type: item.type, text: '', toolCall: undefined, completed: false, snapshot: '' };
      this.states.set(item.id, state);
    }
    state.snapshot = snapshot;
    if (item.contentDelta !== undefined) state.text += item.contentDelta;
    if (item.content !== undefined) state.text = item.content;
    if (item.toolCall !== undefined) state.toolCall = item.toolCall;
    if (event.type === 'item.completed') state.completed = true;
    return true;
  }

  /** Known items in order of first appearance; unknown item types stay stream-only. */
  items(): ThreadItem[] {
    return [...this.states.entries()].flatMap(([id, state]) => toThreadItem(id, state) ?? []);
  }
}

function toThreadItem(id: string, state: ItemState): ThreadItem | undefined {
  const incomplete = state.completed ? {} : { incomplete: true as const };
  switch (state.type) {
    case 'tool_call':
      return { id, type: 'tool_call', toolCall: state.toolCall ?? { id }, ...incomplete };
    case 'reasoning':
      return { id, type: 'reasoning', text: state.text, ...incomplete };
    case 'agent_message':
      return { id, type: 'agent_message', text: state.text, ...incomplete };
    default:
      return undefined;
  }
}
