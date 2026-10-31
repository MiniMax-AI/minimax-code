import { randomUUID } from 'node:crypto';

import { parseArchiveTitleVerdict } from './archived-root-title.js';
import {
  RootArchiveTitleModelError,
  type RootArchiveTitleModel,
  type RootArchiveTitleModelInput,
  type RootArchiveTitleSafetyVerdict,
} from './root-archive-title-model.js';
import {
  completeTitleModel,
  TitleModelCompletionError,
  type TitleModelStream,
  type TitleResolvedModel,
} from '../title/title-model-completion.js';

const CONFIG_FIELD_SAFETY_SCENE = 205;

export type ArchiveTitleStream<TModel> = TitleModelStream<TModel>;

export interface ArchiveTitleModelAdapterOptions<TAgentConfig, TModel> {
  readonly buildAgentConfig: (
    session: RootArchiveTitleModelInput['session'],
  ) => Promise<TAgentConfig>;
  readonly resolveModel: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly agentConfig: TAgentConfig;
  }) => Promise<TitleResolvedModel<TModel>>;
  readonly review: (
    title: string,
    scene: typeof CONFIG_FIELD_SAFETY_SCENE,
  ) => Promise<RootArchiveTitleSafetyVerdict>;
  readonly stream: ArchiveTitleStream<TModel>;
  readonly nowMs?: () => number;
  readonly makeTurnId?: () => string;
}

/** Transport-neutral archive-title adapter; production model wiring stays outside the domain. */
export class ArchiveTitleModelAdapter<TAgentConfig, TModel> implements RootArchiveTitleModel {
  private readonly nowMs: () => number;
  private readonly makeTurnId: () => string;

  constructor(private readonly options: ArchiveTitleModelAdapterOptions<TAgentConfig, TModel>) {
    this.nowMs = options.nowMs ?? Date.now;
    this.makeTurnId = options.makeTurnId ?? (() => `turn_archive_title_${randomUUID()}`);
  }

  async summarize(input: RootArchiveTitleModelInput): Promise<string | null> {
    const turnId = this.makeTurnId();
    // 记下这次生成标题用的模型要不要审，标题出来后据此决定是否送审。
    let contentReviewRequired: boolean | undefined;
    let raw: string;
    try {
      raw = await completeTitleModel(
        {
          buildAgentConfig: this.options.buildAgentConfig,
          resolveModel: async (resolveInput) => {
            const resolved = await this.options.resolveModel(resolveInput);
            contentReviewRequired = resolved.contentReviewRequired;
            return resolved;
          },
          stream: this.options.stream,
          nowMs: this.nowMs,
        },
        { ...input, turnId },
      );
    } catch (error) {
      if (!(error instanceof TitleModelCompletionError)) throw error;
      throw new RootArchiveTitleModelError('model', error.message, error);
    }
    const title = raw ? parseArchiveTitleVerdict(raw) : null;
    if (!title) return null;
    if (contentReviewRequired === false) return title;
    return this.reviewTitle(title);
  }

  private async reviewTitle(title: string): Promise<string | null> {
    let verdict: RootArchiveTitleSafetyVerdict;
    try {
      verdict = await this.options.review(title, CONFIG_FIELD_SAFETY_SCENE);
    } catch (error) {
      throw new RootArchiveTitleModelError(
        'review',
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
    return !verdict.pass && verdict.errorKind !== 'api_error' ? null : title;
  }
}
