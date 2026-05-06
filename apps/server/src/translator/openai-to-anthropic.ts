/**
 * OpenAI response → Anthropic response translator (non-streaming).
 */

interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

function convertStopReason(reason: string | null): AnthropicResponse["stop_reason"] {
  switch (reason) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    case "stop_sequence": return "stop_sequence";
    default: return "end_turn";
  }
}

export function openaiToAnthropicResponse(
  openaiResponse: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  const choice = (openaiResponse.choices as Array<Record<string, unknown>> | undefined)?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;

  const content: AnthropicContentBlock[] = [];

  if (typeof message?.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  } else if (Array.isArray(message?.content)) {
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type === "text" && typeof part.text === "string" && part.text) {
        content.push({ type: "text", text: part.text });
      }
    }
  }

  if (typeof message?.reasoning_content === "string" && message.reasoning_content) {
    content.push({ type: "thinking", thinking: message.reasoning_content });
  }

  const toolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (tc.type === "function") {
        const fn = tc.function as Record<string, unknown> | undefined;
        let input: unknown;
        try {
          input = typeof fn?.arguments === "string" ? JSON.parse(fn.arguments) : fn?.arguments;
        } catch {
          input = fn?.arguments ?? {};
        }
        content.push({
          type: "tool_use",
          id: String(tc.id ?? ""),
          name: String(fn?.name ?? ""),
          input,
        });
      }
    }
  }

  const usage = (openaiResponse.usage as Record<string, number> | undefined) || {};
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;

  const anthropicUsage: AnthropicUsage = {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
  };

  if (usage.cache_creation_input_tokens) {
    anthropicUsage.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  }
  if (usage.cache_read_input_tokens) {
    anthropicUsage.cache_read_input_tokens = usage.cache_read_input_tokens;
  }

  return {
    id: String(openaiResponse.id ?? `msg_${Date.now()}`),
    type: "message",
    role: "assistant",
    model: String(openaiResponse.model ?? model),
    content,
    stop_reason: convertStopReason((choice?.finish_reason as string | null) ?? "stop"),
    stop_sequence: null,
    usage: anthropicUsage,
  };
}
