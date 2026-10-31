import {
  multimodalDemotionTextNotes,
  selectMultimodalAttachments,
  type MultimodalAttachmentCapabilities,
} from '@mavis/agent-tools';
import type { PtcRetainedFact, ToolResultContent } from '@mavis/agent-core/tools';

import type { PtcMediaDelivery } from '../../execution/ptc/contracts.js';

interface Candidate {
  readonly id: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly delivery: PtcMediaDelivery;
}

export interface PtcOuterMediaProjection {
  readonly content: readonly ToolResultContent[];
  readonly retainedFacts: readonly PtcRetainedFact[];
  readonly notes: readonly string[];
}

/** Applies the same provider capability limits used for native user attachments. */
export function projectPtcOuterMedia(
  media: readonly PtcMediaDelivery[],
  capabilities: MultimodalAttachmentCapabilities | undefined,
): PtcOuterMediaProjection {
  const candidates = media.flatMap((delivery, index) => {
    const content = delivery.content;
    if (
      (content.type !== 'image' && content.type !== 'video') ||
      typeof content.data !== 'string' ||
      typeof content.mimeType !== 'string'
    ) {
      return [];
    }
    return [
      {
        id: String(index),
        mime: content.mimeType,
        sizeBytes: base64ByteSize(content.data),
        delivery,
      } satisfies Candidate,
    ];
  });
  const selected = selectMultimodalAttachments(candidates, capabilities);
  const statusByChild = new Map<
    string,
    {
      status: 'delivered' | 'unavailable' | 'budget_exceeded';
      refs: Array<{ readonly uri: string; readonly mimeType?: string }>;
    }
  >();
  for (const item of selected.kept) {
    recordStatus(statusByChild, item.candidate.delivery, 'delivered');
  }
  for (const item of selected.demoted) {
    recordStatus(
      statusByChild,
      item.candidate.delivery,
      item.reason === 'unsupported_model' || item.reason === 'unsupported_mime'
        ? 'unavailable'
        : 'budget_exceeded',
    );
  }
  return {
    content: selected.kept.map((item) => item.candidate.delivery.content),
    retainedFacts: [...statusByChild].map(([childToolCallId, state]) => ({
      kind: 'media_delivery' as const,
      child_tool_call_id: childToolCallId,
      status: state.status,
      ...(state.refs.length > 0 ? { refs: state.refs } : {}),
    })),
    notes: multimodalDemotionTextNotes(selected.demoted),
  };
}

function recordStatus(
  states: Map<
    string,
    {
      status: 'delivered' | 'unavailable' | 'budget_exceeded';
      refs: Array<{ readonly uri: string; readonly mimeType?: string }>;
    }
  >,
  delivery: PtcMediaDelivery,
  next: 'delivered' | 'unavailable' | 'budget_exceeded',
): void {
  const existing = states.get(delivery.childToolCallId);
  const status = worseMediaStatus(existing?.status, next);
  const refs = [...(existing?.refs ?? [])];
  for (const ref of delivery.refs) {
    if (!refs.some((known) => known.uri === ref.uri)) refs.push(ref);
  }
  states.set(delivery.childToolCallId, { status, refs });
}

function worseMediaStatus(
  first: 'delivered' | 'unavailable' | 'budget_exceeded' | undefined,
  second: 'delivered' | 'unavailable' | 'budget_exceeded',
): 'delivered' | 'unavailable' | 'budget_exceeded' {
  if (first === 'budget_exceeded' || second === 'budget_exceeded') return 'budget_exceeded';
  if (first === 'unavailable' || second === 'unavailable') return 'unavailable';
  return 'delivered';
}

function base64ByteSize(value: string): number {
  let padding = 0;
  if (value.endsWith('==')) padding = 2;
  else if (value.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}
