import { getRuntimeRegion } from '@mavis/config';

import type { LocalRuntimeConfig } from '../config/types.js';

export { minimaxApiModels } from '@mavis/config';

export const MINIMAX_API_FORMAT = 'anthropic-messages';
const MESSAGES_PATH = MINIMAX_API_FORMAT.split('-')[0];
export const MINIMAX_API_DEFAULT_BASE_URL =
  getRuntimeRegion() === 'cn'
    ? `https://api.minimaxi.com/${MESSAGES_PATH}`
    : `https://api.minimax.io/${MESSAGES_PATH}`;
export const MINIMAX_API_PROVIDER_NAME = 'MiniMax API';

export function minimaxApiBaseUrl(config: LocalRuntimeConfig): string {
  return config.minimax_api?.baseURL?.trim() || MINIMAX_API_DEFAULT_BASE_URL;
}
