import type { ModelCapabilitiesConfig, ModelConfig } from './config.js';

// Shared first-run catalog; an existing remote snapshot remains authoritative.

/**
 * First-run default before any official snapshot is synced. After a sync the
 * delivered `model_order` decides the default (see `model-availability.ts`).
 */
export const MINIMAX_FIRST_RUN_DEFAULT_MODEL_ID = 'MiniMax-M3.1-Flash';

const MINIMAX_M3_FILE_API_CAPABILITIES: ModelCapabilitiesConfig = {
  support_files_api: true,
  files_api_upload_endpoint: '/v1/files/upload',
  max_image_bytes_inline: 10_485_760,
  max_video_bytes_inline: 52_428_800,
  max_request_body_bytes: 67_108_864,
  max_attachments_count: 4,
  max_images_per_request: 20,
};

export const MINIMAX_MODELS: Record<string, ModelConfig> = {
  'MiniMax-M3': {
    name: 'MiniMax-M3',
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    limit: { context: 512000, output: 128000 },
    contextWindowOptions: [512000, 1000000],
    contextWindowOptionHints: { '1000000': 'higher_usage' },
    options: { reasoningSummary: 'auto' },
    thinking_config: { mode: 'switchable', default_value: 'true' },
    variants: {
      'none-thinking': { thinking: { type: 'disabled' } },
      thinking: { thinking: { type: 'adaptive' } },
    },
    capabilities: MINIMAX_M3_FILE_API_CAPABILITIES,
  },
  'MiniMax-M3.1-Flash': {
    name: 'M3.1-Flash',
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    limit: { context: 512000, output: 128000 },
    contextWindowOptions: [512000, 1000000],
    contextWindowOptionHints: { '1000000': 'higher_usage' },
    options: { reasoningSummary: 'auto' },
    thinking: {
      effortOptions: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'default',
    },
    thinking_config: { mode: 'forced_on' },
    variants: {
      'none-thinking': { thinking: { type: 'disabled' } },
      thinking: { thinking: { type: 'adaptive' } },
    },
    capabilities: MINIMAX_M3_FILE_API_CAPABILITIES,
  },
};
