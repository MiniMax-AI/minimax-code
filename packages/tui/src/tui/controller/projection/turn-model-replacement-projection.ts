import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import type { TranscriptCell } from '../../transcript/model.js';

/**
 * Projects the Runtime model replacement notice into a transcript cell.
 *
 * The notice is a product message about the Turn, not a model turn itself, so it
 * never becomes one. Runtime replaced the requested model, so the user has to see
 * which model actually answered.
 */
export function projectModelReplacementMessage(input: {
  eventType: string;
  data: Readonly<Record<string, unknown>>;
  turnId: string;
  timestamp: number;
}): TranscriptCell | undefined {
  if (input.eventType !== 'model_replacement') return undefined;
  const requested = readModelReference(input.data.requestedModel);
  const actual = readModelReference(input.data.actualModel);
  if (!requested || !actual) return undefined;
  const tier = readText(input.data.tier);
  const reason = readText(input.data.reason);
  const detail = [tier, reason].filter((value) => value !== undefined).join(': ');
  const content = sanitizeTerminalText(
    `Requested model ${requested} was replaced with ${actual}${detail ? ` (${detail})` : ''}.`,
  );
  if (!content.trim()) return undefined;
  return {
    id: `model-replacement:${input.turnId}`,
    kind: 'warning',
    status: 'succeeded',
    title: 'Model',
    content,
    turnId: input.turnId,
    createdAtMs: input.timestamp,
    updatedAtMs: input.timestamp,
  };
}

function readModelReference(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const providerId = readText(record.providerId);
  const modelId = readText(record.modelId);
  if (!providerId || !modelId) return undefined;
  return `${providerId}/${modelId}`;
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
