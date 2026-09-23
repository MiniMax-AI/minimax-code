import type { TuiAttachment, TuiTransportAttachment } from '../../../types/invocation.js';
import type { EditorDraftSnapshot } from '../../widgets/editor/editor.js';
import type { TuiComposerDraftSnapshot } from './draft.js';
import type { TuiPlanClientIntent } from '../../../runtime/port.js';

export interface TuiSubmissionSeed {
  readonly sessionId?: string;
  readonly editor: EditorDraftSnapshot;
  readonly resources: TuiComposerDraftSnapshot;
  readonly transportContent?: string;
  readonly transportAttachments?: readonly TuiTransportAttachment[];
  readonly clientIntent?: TuiPlanClientIntent;
  readonly reviewRequest?: { readonly scope: 'local_changes' };
}

export interface TuiSubmissionSnapshot {
  readonly submissionId: string;
  readonly sessionId?: string;
  readonly editor: EditorDraftSnapshot;
  readonly content: string;
  readonly transportContent?: string;
  readonly attachments: readonly TuiAttachment[];
  readonly transportAttachments?: readonly TuiTransportAttachment[];
  readonly createdAtMs: number;
  readonly clientIntent?: TuiPlanClientIntent;
  readonly reviewRequest?: { readonly scope: 'local_changes' };
}

export interface TuiRetrySubmission {
  readonly retryId: string;
  readonly snapshot: TuiSubmissionSnapshot;
  readonly failedReason: string;
  readonly failureCode?: string;
}

export function createTuiSubmissionSnapshot(options: {
  readonly submissionId: string;
  readonly sessionId?: string;
  readonly editor: EditorDraftSnapshot;
  readonly content: string;
  readonly transportContent?: string;
  readonly resources: TuiComposerDraftSnapshot;
  readonly transportAttachments?: readonly TuiTransportAttachment[];
  readonly createdAtMs?: number;
  readonly clientIntent?: TuiPlanClientIntent;
  readonly reviewRequest?: { readonly scope: 'local_changes' };
}): TuiSubmissionSnapshot {
  return {
    submissionId: options.submissionId,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    editor: cloneEditorDraft(options.editor),
    content: options.content,
    ...(options.transportContent ? { transportContent: options.transportContent } : {}),
    attachments: options.resources.attachments.map((attachment) => ({
      ...attachment,
    })),
    transportAttachments: (options.transportAttachments ?? options.resources.attachments).map(
      (attachment) => ({ ...attachment }),
    ),
    createdAtMs: options.createdAtMs ?? Date.now(),
    ...(options.clientIntent ? { clientIntent: options.clientIntent } : {}),
    ...(options.reviewRequest ? { reviewRequest: options.reviewRequest } : {}),
  };
}

function cloneEditorDraft(editor: EditorDraftSnapshot): EditorDraftSnapshot {
  return {
    ...editor,
    pluginMentions: editor.pluginMentions?.map((mention) => ({ ...mention })),
    pastes: editor.pastes.map((paste) => ({ ...paste })),
    ...(editor.attachmentPlaceholders
      ? {
          attachmentPlaceholders: editor.attachmentPlaceholders.map((element) => ({ ...element })),
        }
      : {}),
  };
}
