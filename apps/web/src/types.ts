export type ProxyMode = "forward";
export type ApiType = "chat_completions" | "responses";

export type ProxyConfig = {
  mode: ProxyMode;
  apiType: ApiType;
  baseUrl: string;
  path: string;
  apiKey: string;
  modelOverride: string;
};

export type ProviderFormat = "openai" | "claude" | "gemini" | "ollama";
export type AuthStyle = "bearer" | "x-api-key";

export type Provider = {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  path: string;
  apiType: ApiType;
  format: ProviderFormat;
  authStyle: AuthStyle;
  enabled: boolean;
  models: string[];
  createdAt: string;
};

export type ApiKey = {
  id: string;
  key: string;
  name: string;
  allowedModels: string[] | null;
  enabled: boolean;
  createdAt: string;
};

export type ExchangeRecord = {
  id: string;
  mode: ProxyMode;
  model: string;
  prompt: string;
  promptTokens: number;
  requestBody: unknown;
  translatedRequestBody?: unknown;
  createdAt: string;
  completedAt?: string;
  responseStatus: "pending" | "success" | "error";
  responseBody?: unknown;
  translatedResponseBody?: unknown;
  errorMessage?: string;
  upstreamUrl?: string;
  upstreamStatusCode?: number;
  durationMs?: number;
  apiKeyId?: string;
  apiKeyName?: string;
  agentType?: "openclaw" | "hermes" | null;
};

export type ExchangeStats = {
  totalRequests: number;
  totalPromptTokens: number;
  totalForwarded: number;
};

export type ModelRecord = { id: string; object: string; created: number; owned_by: string; providerId?: string };

export type DashboardMeta = {
  stats: ExchangeStats;
  config: ProxyConfig;
  providers: Provider[];
  apiKeys: ApiKey[];
  models: ModelRecord[];
};

export type DashboardEvent = {
  type: "snapshot" | "update";
  latest?: ExchangeRecord | null;
  meta?: DashboardMeta;
};

export type UpstreamTestResult = {
  ok: boolean;
  apiType: ApiType;
  model: string;
  upstreamUrl: string;
  upstreamStatusCode: number;
  durationMs: number;
  preview: string;
  raw: unknown;
};

export type PaginatedResult = {
  items: ExchangeRecord[];
  nextCursor: string | null;
  total: number;
};

export type ChatMessage = {
  role: string;
  content: string;
  toolCalls?: Array<{ id?: string; name: string; arguments: string }>;
  toolCallId?: string;
  name?: string;
};
