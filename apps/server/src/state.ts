export type ProxyMode = "capture_only" | "forward";
export type ApiType = "chat_completions" | "responses";

export type ProxyConfig = {
  mode: ProxyMode;
  apiType: ApiType;
  baseUrl: string;
  path: string;
  apiKey: string;
  modelOverride: string;
};

export type ModelRecord = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
};

export type ExchangeRecord = {
  id: string;
  mode: ProxyMode;
  model: string;
  prompt: string;
  promptTokens: number;
  requestBody: unknown;
  createdAt: string;
  completedAt?: string;
  responseStatus: "pending" | "success" | "error";
  responseBody?: unknown;
  errorMessage?: string;
  upstreamUrl?: string;
  upstreamStatusCode?: number;
  durationMs?: number;
};

export type ExchangeStats = {
  totalRequests: number;
  totalPromptTokens: number;
  totalForwarded: number;
  totalCaptureOnly: number;
};

export type DashboardState = {
  items: ExchangeRecord[];
  stats: ExchangeStats;
  config: ProxyConfig;
  models: ModelRecord[];
};

const exchanges: ExchangeRecord[] = [];
const listeners = new Set<(latest: ExchangeRecord | null, state: DashboardState) => void>();

const defaultModels: ModelRecord[] = [
  {
    id: "fake-gpt-4o-mini",
    object: "model",
    created: 1710000000,
    owned_by: "fake-model"
  }
];

let modelCatalog: ModelRecord[] = [...defaultModels];

const pathFromApiType = (apiType: ApiType) => (apiType === "responses" ? "/v1/responses" : "/v1/chat/completions");
const apiTypeFromPath = (path: string): ApiType => (path.includes("/responses") ? "responses" : "chat_completions");

const envApiType: ApiType = process.env.UPSTREAM_API_TYPE === "responses" ? "responses" : "chat_completions";
const envPath = process.env.UPSTREAM_PATH ?? pathFromApiType(envApiType);

const proxyConfig: ProxyConfig = {
  mode: process.env.PROXY_MODE === "forward" ? "forward" : "capture_only",
  apiType: apiTypeFromPath(envPath),
  baseUrl: process.env.UPSTREAM_BASE_URL ?? "https://api.openai.com",
  path: envPath,
  apiKey: process.env.UPSTREAM_API_KEY ?? "",
  modelOverride: process.env.UPSTREAM_MODEL ?? ""
};

const emit = (latest: ExchangeRecord | null) => {
  const state = getDashboardState();
  listeners.forEach((listener) => listener(latest, state));
};

export const addExchange = (params: {
  mode: ProxyMode;
  model: string;
  prompt: string;
  promptTokens: number;
  requestBody: unknown;
}) => {
  const record: ExchangeRecord = {
    id: `x_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    mode: params.mode,
    model: params.model,
    prompt: params.prompt,
    promptTokens: params.promptTokens,
    requestBody: params.requestBody,
    createdAt: new Date().toISOString(),
    responseStatus: "pending"
  };

  exchanges.unshift(record);
  if (exchanges.length > 100) {
    exchanges.length = 100;
  }
  emit(record);
  return record;
};

export const completeExchange = (
  id: string,
  update: {
    responseStatus: "success" | "error";
    responseBody?: unknown;
    errorMessage?: string;
    upstreamUrl?: string;
    upstreamStatusCode?: number;
    durationMs?: number;
  }
) => {
  const target = exchanges.find((item) => item.id === id);
  if (!target) {
    return null;
  }
  target.responseStatus = update.responseStatus;
  target.responseBody = update.responseBody;
  target.errorMessage = update.errorMessage;
  target.upstreamUrl = update.upstreamUrl;
  target.upstreamStatusCode = update.upstreamStatusCode;
  target.durationMs = update.durationMs;
  target.completedAt = new Date().toISOString();
  emit(target);
  return target;
};

export const getExchanges = () => exchanges;

export const getExchangeStats = (): ExchangeStats => ({
  totalRequests: exchanges.length,
  totalPromptTokens: exchanges.reduce((sum, item) => sum + item.promptTokens, 0),
  totalForwarded: exchanges.filter((item) => item.mode === "forward").length,
  totalCaptureOnly: exchanges.filter((item) => item.mode === "capture_only").length
});

export const getProxyConfig = (): ProxyConfig => ({ ...proxyConfig });

export const setProxyConfig = (next: Partial<ProxyConfig>) => {
  if (next.mode) {
    proxyConfig.mode = next.mode;
  }
  if (next.apiType) {
    proxyConfig.apiType = next.apiType;
    proxyConfig.path = pathFromApiType(next.apiType);
  }
  if (typeof next.baseUrl === "string") {
    proxyConfig.baseUrl = next.baseUrl.trim();
  }
  if (typeof next.path === "string") {
    proxyConfig.path = next.path.trim();
    proxyConfig.apiType = apiTypeFromPath(proxyConfig.path);
  }
  if (typeof next.apiKey === "string") {
    proxyConfig.apiKey = next.apiKey.trim();
  }
  if (typeof next.modelOverride === "string") {
    proxyConfig.modelOverride = next.modelOverride.trim();
  }
  emit(null);
  return getProxyConfig();
};

export const getModels = () => [...modelCatalog];

export const setModels = (items: ModelRecord[]) => {
  const uniq = new Map<string, ModelRecord>();
  for (const item of items) {
    const id = item.id.trim();
    if (!id) {
      continue;
    }
    uniq.set(id, {
      id,
      object: item.object || "model",
      created: Number.isFinite(item.created) ? item.created : Math.floor(Date.now() / 1000),
      owned_by: item.owned_by || "upstream"
    });
  }

  if (uniq.size === 0) {
    modelCatalog = [...defaultModels];
  } else {
    modelCatalog = Array.from(uniq.values()).slice(0, 200);
  }

  if (proxyConfig.modelOverride && !modelCatalog.some((item) => item.id === proxyConfig.modelOverride)) {
    proxyConfig.modelOverride = "";
  }

  emit(null);
  return getModels();
};

export const getDashboardState = (): DashboardState => ({
  items: [...getExchanges()],
  stats: getExchangeStats(),
  config: getProxyConfig(),
  models: getModels()
});

export const subscribeExchangeUpdated = (listener: (latest: ExchangeRecord | null, state: DashboardState) => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
