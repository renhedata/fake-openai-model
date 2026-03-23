import { format, formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";
import type { ApiType, ProxyConfig, DashboardMeta, ChatMessage } from "./types";

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
    mode: v?.mode ?? "capture_only",
    apiType,
    baseUrl: v?.baseUrl ?? "https://api.openai.com/v1",
    path: v?.path ?? apiTypeToPath(apiType),
    apiKey: v?.apiKey ?? "",
    modelOverride: v?.modelOverride ?? "",
  };
};

export const defaultConfig: ProxyConfig = normalizeConfig();

export const emptyMeta: DashboardMeta = {
  stats: { totalRequests: 0, totalPromptTokens: 0, totalForwarded: 0, totalCaptureOnly: 0 },
  config: defaultConfig,
  models: [],
};

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

export const getResponseText = (v: unknown): string => {
  if (!v || typeof v !== "object") return "";
  const r = v as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
    assistant?: string;
    content?: string | unknown[];
    output_text?: string;
  };
  if (typeof r.assistant === "string" && r.assistant.trim()) return r.assistant;
  if (typeof r.output_text === "string") return r.output_text;
  if (typeof r.content === "string") return r.content;
  if (Array.isArray(r.content)) {
    const text = (r.content as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
    if (text.trim()) return text;
  }
  const msg = r.choices?.[0]?.message;
  if (msg) {
    if (typeof msg.content === "string" && msg.content.trim()) return msg.content;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      return msg.tool_calls
        .map((tc) => {
          const fn = tc.function;
          if (!fn) return "[tool_call]";
          return `[Tool Call] ${fn.name ?? "?"}(${fn.arguments ?? ""})`;
        })
        .join("\n");
    }
  }
  // Fallback: parse OAI-format rawSse if content fields are empty
  const rr = v as Record<string, unknown>;
  if (typeof rr.rawSse === "string" && rr.rawSse) {
    return extractFromOaiRawSse(rr.rawSse).content;
  }
  return "";
};

export const getReasoningText = (v: unknown): string => {
  if (!v || typeof v !== "object") return "";
  const r = v as Record<string, unknown>;
  // Streaming mode: stored as r.reasoning
  if (typeof r.reasoning === "string" && r.reasoning.trim()) return r.reasoning;
  // Non-streaming: stored in choices[0].message.reasoning_content
  const choices = r.choices as Array<Record<string, unknown>> | undefined;
  const msg = choices?.[0]?.message as Record<string, unknown> | undefined;
  if (msg && typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
    return msg.reasoning_content;
  }
  // Fallback: parse OAI-format rawSse
  if (typeof r.rawSse === "string" && r.rawSse) {
    return extractFromOaiRawSse(r.rawSse).reasoning;
  }
  return "";
};

export const getCompletionTokens = (v: unknown): number => {
  if (!v || typeof v !== "object") return 0;
  const r = v as {
    usage?: { completion_tokens?: number; output_tokens?: number };
    stream?: boolean;
    assistant?: string;
    content?: string;
  };
  if (r.usage?.completion_tokens && typeof r.usage.completion_tokens === "number") {
    return r.usage.completion_tokens;
  }
  if (r.usage?.output_tokens && typeof r.usage.output_tokens === "number") {
    return r.usage.output_tokens;
  }
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

export const extractMessages = (requestBody: unknown): ChatMessage[] => {
  if (!requestBody || typeof requestBody !== "object") return [];
  const body = requestBody as { messages?: Array<Record<string, unknown>> };
  if (!Array.isArray(body.messages)) return [];
  return body.messages.map((m) => {
    const role = typeof m.role === "string" ? m.role : "unknown";
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = (m.content as Array<Record<string, unknown>>)
        .map((part) => {
          if (typeof part === "string") return part;
          if (typeof part.text === "string") return part.text;
          if (typeof part.input_text === "string") return part.input_text;
          if (part.type === "image_url" && part.image_url) {
            const url = typeof part.image_url === "string" ? part.image_url : (part.image_url as Record<string, unknown>).url;
            return `[Image: ${typeof url === "string" ? url.slice(0, 80) : "..."}]`;
          }
          return "";
        })
        .filter(Boolean)
        .join("");
    }
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
