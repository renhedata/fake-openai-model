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

export type ModelRecord = { id: string; object: string; created: number; owned_by: string };

export type DashboardMeta = {
  stats: ExchangeStats;
  config: ProxyConfig;
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
