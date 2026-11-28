import type * as acp from '@agentclientprotocol/sdk';

import { buildTuiMessageParts, type TuiMessage } from '../runtime/stream-events.js';
import { readTuiAcpHistoryImages } from './prompt-content.js';
import type { TuiAcpUpdateProjector } from './updates.js';

/**
 * Projects one persisted message to the `session/update` payloads a Client already renders
 * for history replay. The projector carries tool-call state across the messages of one read.
 */
export async function projectTuiAcpHistoryMessage(
  message: TuiMessage,
  projector: TuiAcpUpdateProjector,
): Promise<acp.SessionUpdate[]> {
  if (message.role !== 'user') return projector.project({ type: 'message', message });
  const content: acp.ContentBlock[] = [
    ...buildTuiMessageParts(message).flatMap((part): acp.ContentBlock[] =>
      part.type === 'text' ? [{ type: 'text', text: part.content }] : [],
    ),
    ...(await readTuiAcpHistoryImages(message.attachments)),
  ];
  return content.map(
    (block): acp.SessionUpdate => ({
      sessionUpdate: 'user_message_chunk',
      ...(message.id ? { messageId: message.id } : {}),
      content: block,
    }),
  );
}
