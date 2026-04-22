import { format, formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";
import type { ApiType, ProxyConfig, DashboardMeta, ChatMessage, Provider, ApiKey } from "./types";

export const PAGE_SIZE = 50;
export const RENDER_BATCH_SIZE = 30;

export const apiTypeToPath = (t: ApiType) =>
  t === "responses" ? "/v1/responses" : "/v1/chat/completions";

export const pathToApiType = (p: string): ApiType =>
  p.includes("/responses") ? "responses" : "chat_completions";

export const normalizeConfig = (v?: Partial<ProxyConfig>): ProxyConfig => {
  const rawPath = v?.path ?? "/v1/chat/completions";
  const apiType = v?.apiType ?? pathToApiType(rawPath);
  return {
    mode: v?.mode ?? "forward",
    apiType,
    baseUrl: v?.baseUrl ?? "https://api.openai.com/v1",
    path: v?.path ?? apiTypeToPath(apiType),
    apiKey: v?.apiKey ?? "",
    modelOverride: v?.modelOverride ?? "",
  };
};

export const defaultConfig: ProxyConfig = normalizeConfig();

export const emptyMeta: DashboardMeta = {
  stats: { totalRequests: 0, totalPromptTokens: 0, totalForwarded: 0 },
  config: defaultConfig,
  providers: [],
  apiKeys: [],
  models: [],
};

export type BuiltinProviderConfig = {
  name: string;
  baseUrl: string;
  path: string;
  apiType: ApiType;
  format: "openai" | "claude" | "gemini" | "ollama";
  authStyle: "bearer" | "x-api-key";
  models?: string[];
};

export const BUILTIN_PROVIDERS: Record<string, BuiltinProviderConfig> = {
  kimi: {
    name: "Kimi",
    baseUrl: "https://api.kimi.com/coding/v1/messages",
    path: "",
    apiType: "chat_completions",
    format: "claude",
    authStyle: "x-api-key",
    models: ["kimi-k2.5", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
  },
  minimax: {
    name: "MiniMax (国际版)",
    baseUrl: "https://api.minimax.io/anthropic/v1/messages",
    path: "",
    apiType: "chat_completions",
    format: "claude",
    authStyle: "x-api-key",
    models: ["MiniMax-Text-01", "abab6.5s-chat"],
  },
  "minimax-cn": {
    name: "MiniMax (中国版)",
    baseUrl: "https://api.minimaxi.com/anthropic/v1/messages",
    path: "",
    apiType: "chat_completions",
    format: "claude",
    authStyle: "x-api-key",
    models: ["MiniMax-Text-01", "abab6.5s-chat", "abab7-chat-preview"],
  },
  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    path: "",
    apiType: "chat_completions",
    format: "openai",
    authStyle: "bearer",
    models: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
  },
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1/chat/completions",
    path: "",
    apiType: "chat_completions",
    format: "openai",
    authStyle: "bearer",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  siliconflow: {
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1/chat/completions",
    path: "",
    apiType: "chat_completions",
    format: "openai",
    authStyle: "bearer",
    models: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1"],
  },
  glm: {
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    path: "",
    apiType: "chat_completions",
    format: "openai",
    authStyle: "bearer",
    models: ["glm-4", "glm-4-flash", "glm-4-plus"],
  },
  qwen: {
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    path: "",
    apiType: "chat_completions",
    format: "openai",
    authStyle: "bearer",
    models: ["qwen-max", "qwen-plus", "qwen-turbo"],
  },
  custom: {
    name: "自定义",
    baseUrl: "",
    path: "/v1/chat/completions",
    apiType: "chat_completions",
    format: "openai",
    authStyle: "bearer",
    models: [],
  },
};

export const getBuiltinProviderConfig = (type: string): BuiltinProviderConfig | undefined =>
  BUILTIN_PROVIDERS[type];

export const defaultProviderTemplates: Record<string, Omit<Provider, "id" | "createdAt" | "enabled">> = Object.fromEntries(
  Object.entries(BUILTIN_PROVIDERS).map(([key, cfg]) => [
    key,
    {
      name: cfg.name,
      providerType: key,
      baseUrl: cfg.baseUrl,
      apiKey: "",
      path: cfg.path,
      apiType: cfg.apiType,
      format: cfg.format,
      authStyle: cfg.authStyle,
      models: cfg.models ?? [],
    },
  ])
);

export const generateProviderId = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "provider";

export const formatTime = (iso: string) =>
  format(new Date(iso), "MM-dd HH:mm:ss", { locale: zhCN });

export const formatTimeFull = (iso: string) =>
  format(new Date(iso), "yyyy-MM-dd HH:mm:ss", { locale: zhCN });

export const formatRelative = (iso: string) =>
  formatDistanceToNow(new Date(iso), { addSuffix: true, locale: zhCN });

export const safeStringify = (v: unknown) => {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};

/** Extract content and reasoning from OAI-format rawSse string */
const extractFromOaiRawSse = (rawSse: string): { content: string; reasoning: string } => {
  let content = "";
  let reasoning = "";
  for (const line of rawSse.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as { choices?: Array<{ delta?: Record<string, unknown> }> };
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      if (typeof delta.content === "string") {
        content += delta.content.replace(/<\/?think>/gi, "");
      }
    } catch { continue; }
  }
  return { content: content.trim(), reasoning: reasoning.trim() };
};

/** Extract content and reasoning from Anthropic-format rawSse string */
const extractFromAnthropicRawSse = (rawSse: string): { content: string; reasoning: string } => {
  let content = "";
  let reasoning = "";
  let currentEvent = "";
  for (const line of rawSse.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) { currentEvent = ""; continue; }
    if (trimmed.startsWith("event:")) {
      currentEvent = trimmed.slice(6).trim();
      continue;
    }
    if (trimmed.startsWith("data:")) {
      const data = trimmed.slice(5).trim();
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        const delta = parsed.delta as Record<string, unknown> | undefined;
        if (delta) {
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            content += delta.text;
          }
          if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            reasoning += delta.thinking;
          }
          if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            // Tool use args streaming — collect if needed, but getResponseText doesn't show partial args
          }
        }
        // Also handle content_block_start for text blocks
        if (parsed.type === "content_block_start") {
          const cb = parsed.content_block as Record<string, unknown> | undefined;
          if (cb?.type === "text" && typeof cb.text === "string") {
            content += cb.text;
          }
        }
      } catch { /* skip unparseable */ }
    }
  }
  return { content: content.trim(), reasoning: reasoning.trim() };
};

/** Format a tool call for display. */
const formatToolCall = (name: string, args: string): string => {
  let pretty = args;
  try { pretty = JSON.stringify(JSON.parse(args), null, 2); } catch { /* keep as-is */ }
  return `[Tool Call] **${name}**\n\`\`\`json\n${pretty}\n\`\`\``;
};

export const getResponseText = (v: unknown): string => {
  if (!v || typeof v !== "object") return "";
  let r = v as Record<string, unknown>;

  // Unwrap server-side `rawResponse` wrapper (non-streaming)
  if (typeof r.rawResponse === "object" && r.rawResponse !== null) {
    r = r.rawResponse as Record<string, unknown>;
  }

  // Streaming stored format
  if (typeof r.assistant === "string" && r.assistant.trim()) {
    let result = r.assistant;
    // Append stored tool calls (from streaming OAI or Anthropic)
    if (Array.isArray(r.toolCalls) && r.toolCalls.length > 0) {
      const tcText = (r.toolCalls as Array<{ name?: string; arguments?: string }>)
        .map((tc) => formatToolCall(tc.name ?? "?", tc.arguments ?? ""))
        .join("\n\n");
      result = result ? `${result}\n\n${tcText}` : tcText;
    }
    return result;
  }

  // OpenAI Responses API
  if (typeof r.output_text === "string" && r.output_text.trim()) return r.output_text;

  // Anthropic / streaming stored plain content string
  if (typeof r.content === "string" && r.content.trim()) return r.content;

  // Anthropic content array
  if (Array.isArray(r.content)) {
    const parts: string[] = [];
    for (const b of r.content as Array<Record<string, unknown>>) {
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        parts.push(b.text);
      } else if (b.type === "tool_use") {
        const args = b.input !== undefined ? JSON.stringify(b.input, null, 2) : (typeof b.arguments === "string" ? b.arguments : "");
        parts.push(formatToolCall(String(b.name ?? "?"), args));
      }
    }
    if (parts.length > 0) return parts.join("\n\n");
  }

  // OpenAI chat.completion
  const msg = (r.choices as Array<{ message?: Record<string, unknown> }> | undefined)?.[0]?.message;
  if (msg) {
    if (typeof msg.content === "string" && msg.content.trim()) return msg.content;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      return (msg.tool_calls as Array<{ function?: { name?: string; arguments?: string } }>)
        .map((tc) => formatToolCall(tc.function?.name ?? "?", tc.function?.arguments ?? ""))
        .join("\n\n");
    }
  }

  // OpenAI Responses API output array
  if (Array.isArray(r.output)) {
    for (const item of r.output as Array<Record<string, unknown>>) {
      if (item.type === "message" && Array.isArray(item.content)) {
        const text = (item.content as Array<Record<string, unknown>>)
          .filter((c) => c.type === "output_text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("\n");
        if (text.trim()) return text;
      }
    }
  }

  // Fallback: parse Anthropic-format rawSse first
  if (typeof r.rawSse === "string" && r.rawSse) {
    const anthropic = extractFromAnthropicRawSse(r.rawSse);
    if (anthropic.content || anthropic.reasoning) return anthropic.content;
    return extractFromOaiRawSse(r.rawSse).content;
  }
  // Fallback: parse translated SSE
  if (typeof r.translatedSse === "string" && r.translatedSse) {
    return extractFromOaiRawSse(r.translatedSse).content;
  }
  return "";
};

export const getReasoningText = (v: unknown): string => {
  if (!v || typeof v !== "object") return "";
  let r = v as Record<string, unknown>;

  // Unwrap server-side `rawResponse` wrapper (non-streaming)
  if (typeof r.rawResponse === "object" && r.rawResponse !== null) {
    r = r.rawResponse as Record<string, unknown>;
  }

  // Streaming stored reasoning
  if (typeof r.reasoning === "string" && r.reasoning.trim()) return r.reasoning;
  // OpenAI non-streaming: choices[0].message.reasoning_content
  const choices = r.choices as Array<Record<string, unknown>> | undefined;
  const msg = choices?.[0]?.message as Record<string, unknown> | undefined;
  if (msg && typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
    return msg.reasoning_content;
  }
  // Anthropic non-streaming: thinking blocks in content array
  if (Array.isArray(r.content)) {
    const thinking = (r.content as Array<Record<string, unknown>>)
      .filter((b) => b.type === "thinking" && typeof b.thinking === "string")
      .map((b) => b.thinking as string)
      .join("\n\n");
    if (thinking.trim()) return thinking;
  }
  // Fallback: parse Anthropic-format rawSse first
  if (typeof r.rawSse === "string" && r.rawSse) {
    const anthropic = extractFromAnthropicRawSse(r.rawSse);
    if (anthropic.content || anthropic.reasoning) return anthropic.reasoning;
    return extractFromOaiRawSse(r.rawSse).reasoning;
  }
  // Fallback: parse translated SSE
  if (typeof r.translatedSse === "string" && r.translatedSse) {
    return extractFromOaiRawSse(r.translatedSse).reasoning;
  }
  return "";
};

export const getUsageFromResponse = (v: unknown): { promptTokens: number; completionTokens: number; totalTokens: number } | null => {
  if (!v || typeof v !== "object") return null;
  let r = v as Record<string, unknown>;

  // Unwrap server-side rawResponse wrapper
  if (typeof r.rawResponse === "object" && r.rawResponse !== null) {
    r = r.rawResponse as Record<string, unknown>;
  }

  const usage = r.usage as Record<string, unknown> | undefined;
  if (!usage) return null;

  // OpenAI-style: prompt_tokens / completion_tokens / total_tokens
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;

  if (typeof usage.prompt_tokens === "number") promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") completionTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === "number") totalTokens = usage.total_tokens;

  // Anthropic-style: input_tokens / output_tokens
  if (!promptTokens && typeof usage.input_tokens === "number") promptTokens = usage.input_tokens;
  if (!completionTokens && typeof usage.output_tokens === "number") completionTokens = usage.output_tokens;

  if (!promptTokens && !completionTokens && !totalTokens) return null;

  if (!totalTokens && (promptTokens || completionTokens)) {
    totalTokens = promptTokens + completionTokens;
  }
  return { promptTokens, completionTokens, totalTokens };
};

export const getCompletionTokens = (v: unknown): number => {
  const usage = getUsageFromResponse(v);
  if (usage) return usage.completionTokens;

  if (!v || typeof v !== "object") return 0;
  const r = v as {
    stream?: boolean;
    assistant?: string;
    content?: string;
  };
  if (r.stream) {
    const text = typeof r.assistant === "string" ? r.assistant : typeof r.content === "string" ? r.content : "";
    return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
  }
  const text = getResponseText(v);
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
};

export const buildResponseMarkdown = (v: unknown) => {
  const t = getResponseText(v);
  if (t.trim()) return t;
  // Omit rawSse from fallback JSON dump to avoid huge code blocks
  if (v && typeof v === "object") {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { rawSse, ...rest } = v as Record<string, unknown>;
    return `\`\`\`json\n${safeStringify(rest)}\n\`\`\``;
  }
  return `\`\`\`json\n${safeStringify(v ?? {})}\n\`\`\``;
};

const extractContentParts = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .map((part) => {
      if (typeof part === "string") return part;
      // Common text fields
      if (typeof part.text === "string") return part.text;
      if (typeof part.input_text === "string") return part.input_text;
      // OAI image_url
      if (part.type === "image_url") {
        const iu = part.image_url as Record<string, unknown> | string | undefined;
        const url = typeof iu === "string" ? iu : (iu as Record<string, unknown> | undefined)?.url;
        return `[Image: ${typeof url === "string" ? url.slice(0, 80) : "..."}]`;
      }
      // Anthropic image (base64 or URL)
      if (part.type === "image") {
        const src = part.source as Record<string, unknown> | undefined;
        if (src?.type === "url" && typeof src.url === "string") return `[Image: ${src.url.slice(0, 80)}]`;
        if (src?.type === "base64") return `[Image: base64 ${src.media_type ?? ""}]`;
        return "[Image]";
      }
      // Anthropic tool_use (assistant)
      if (part.type === "tool_use") {
        const args = part.input !== undefined ? JSON.stringify(part.input) : "";
        return `[Tool Call] ${String(part.name ?? "?")}(${args})`;
      }
      // Anthropic tool_result (user)
      if (part.type === "tool_result") {
        const resultContent = extractContentParts(part.content);
        return `[Tool Result: ${String(part.tool_use_id ?? "")}] ${resultContent}`;
      }
      // Anthropic thinking block
      if (part.type === "thinking" && typeof part.thinking === "string") {
        return `[Thinking] ${part.thinking.slice(0, 200)}${part.thinking.length > 200 ? "…" : ""}`;
      }
      // Anthropic document
      if (part.type === "document") {
        const src = part.source as Record<string, unknown> | undefined;
        const title = typeof part.title === "string" ? part.title : (typeof src?.url === "string" ? src.url.slice(0, 60) : "document");
        return `[Document: ${title}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("");
};

export const extractMessages = (requestBody: unknown): ChatMessage[] => {
  if (!requestBody || typeof requestBody !== "object") return [];
  const body = requestBody as { messages?: Array<Record<string, unknown>> };
  if (!Array.isArray(body.messages)) return [];
  return body.messages.map((m) => {
    const role = typeof m.role === "string" ? m.role : "unknown";
    const content = extractContentParts(m.content);
    // OAI-style tool_calls on the message object
    const toolCalls = Array.isArray(m.tool_calls)
      ? (m.tool_calls as Array<Record<string, unknown>>).map((tc) => {
          const fn = tc.function as Record<string, unknown> | undefined;
          return {
            id: typeof tc.id === "string" ? tc.id : undefined,
            name: typeof fn?.name === "string" ? fn.name : "unknown",
            arguments: typeof fn?.arguments === "string" ? fn.arguments : "",
          };
        })
      : undefined;
    const toolCallId = typeof m.tool_call_id === "string" ? m.tool_call_id : undefined;
    const name = typeof m.name === "string" ? m.name : undefined;
    return { role, content, toolCalls, toolCallId, name };
  });
};

export const truncate = (s: string, n = 120) =>
  s.length <= n ? s : `${s.slice(0, n)}…`;
