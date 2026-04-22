import { getProxyConfig, getModels, getProviderById, getProviders } from "../state.js";
import type { Provider } from "../state.js";

export const getTestModel = () => {
  const config = getProxyConfig();
  if (config.modelOverride.trim()) {
    return config.modelOverride.trim();
  }
  const first = getModels()[0];
  return first?.id ?? "gpt-4o-mini";
};

/**
 * Resolve provider for a model. Supports formats:
 * - "provider-id/model-name" → routes to provider-id with actual model "model-name"
 * - "model-name" → checks models table providerId, then provider.models list
 * - fallback → legacy proxy_config
 */
export const resolveProviderForModel = (model: string): { provider: Provider | null; actualModel: string; useLegacy: boolean } => {
  // 1. Check provider-id/model-name format
  const slashIdx = model.indexOf("/");
  if (slashIdx > 0) {
    const providerId = model.slice(0, slashIdx);
    const actualModel = model.slice(slashIdx + 1);
    const provider = getProviderById(providerId);
    if (provider && provider.enabled) {
      return { provider, actualModel, useLegacy: false };
    }
  }

  // 2. Check models table providerId
  const models = getModels();
  const modelRecord = models.find((m) => m.id === model);
  if (modelRecord?.providerId) {
    const provider = getProviderById(modelRecord.providerId);
    if (provider && provider.enabled) {
      return { provider, actualModel: model, useLegacy: false };
    }
  }

  // 3. Check provider.models list
  const providers = getProviders();
  for (const p of providers) {
    if (p.enabled && p.models && p.models.includes(model)) {
      return { provider: p, actualModel: model, useLegacy: false };
    }
  }

  // 4. Fallback to legacy proxy_config
  return { provider: null, actualModel: model, useLegacy: true };
};
