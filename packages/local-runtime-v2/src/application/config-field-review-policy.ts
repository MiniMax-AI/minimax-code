import { resolveProviderAuthMode } from '@mavis/config';

import {
  isLegacyMinimaxProvider,
  parseSourceQualifiedModelKey,
  type LocalRuntimeConfig,
} from '../service/model-system/index.js';

/** Only a known unmanaged route exempts local CLI configuration from managed review. */
export function isUnmanagedConfigModel(
  config: LocalRuntimeConfig,
  modelKey: string | undefined,
): boolean {
  const model = parseSourceQualifiedModelKey(modelKey);
  if (!model || isLegacyMinimaxProvider(config, model.providerId)) return false;
  if (model.source === 'minimax_api') return true;
  if (model.source === 'custom_provider') {
    const provider = config.custom_provider?.[model.providerKey];
    return provider !== undefined && provider.enabled !== false;
  }
  if (model.providerId === 'minimax' && config.minimaxModelSource === 'minimax_api_key') {
    return true;
  }
  const provider = config.provider?.[model.providerId];
  return (
    provider !== undefined &&
    resolveProviderAuthMode(provider.options).authMode !== 'managed-login'
  );
}
