/**
 * Anthropic request → OpenAI request translator.
 */

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: unknown;
}

interface OpenAiTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface OpenAiRequest {
  model: string;
  messages: OpenAiMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  temperature?: number;
  tools?: OpenAiTool[];
  tool_choice?: unknown;
  response_format?: Record<string, unknown>;
  [key: string]: unknown;
}

function convertAnthropicContentToOpenAI(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  const parts: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image" && b.source) {
      const source = b.source as Record<string, unknown>;
      if (source.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${source.media_type};base64,${source.data}` },
        });
      } else if (source.type === "url" && typeof source.url === "string") {
        parts.push({ type: "image_url", image_url: { url: source.url } });
      }
    } else if (b.type === "tool_result") {
      parts.push({ type: "tool_result", tool_use_id: b.tool_use_id, content: b.content });
    } else if (b.type === "tool_use") {
      parts.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      parts.push({ type: "text", text: `<thinking>${b.thinking}</thinking>` });
    }
  }
  return parts.length > 0 ? parts : "";
}

function convertAnthropicMessagesToOpenAI(
  messages: Array<Record<string, unknown>>,
  systemParts: string[]
): OpenAiMessage[] {
  const result: OpenAiMessage[] = [];

  for (const s of systemParts) {
    if (s.trim()) result.push({ role: "system", content: s.trim() });
  }

  for (const msg of messages) {
    const role = String(msg.role ?? "");
    const content = msg.content;

    if (role === "user") {
      const openAiContent = convertAnthropicContentToOpenAI(content);
      if (Array.isArray(openAiContent)) {
        const toolResults = openAiContent.filter((p) => p.type === "tool_result");
        const otherParts = openAiContent.filter((p) => p.type !== "tool_result");
        for (const tr of toolResults) {
          result.push({
            role: "tool",
            tool_call_id: String(tr.tool_use_id ?? ""),
            content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content ?? ""),
          });
        }
        if (otherParts.length > 0) {
          result.push({ role: "user", content: otherParts });
        }
      } else {
        result.push({ role: "user", content: openAiContent });
      }
    } else if (role === "assistant") {
      const openAiContent = convertAnthropicContentToOpenAI(content);
      const assistantMsg: OpenAiMessage = { role: "assistant", content: "" };
      const toolCalls: Array<Record<string, unknown>> = [];

      if (Array.isArray(openAiContent)) {
        const textParts: Array<Record<string, unknown>> = [];
        for (const part of openAiContent) {
          if (part.type === "tool_use") {
            toolCalls.push({
              id: String(part.id ?? `call_${Date.now()}_${toolCalls.length}`),
              type: "function",
              function: {
                name: String(part.name ?? ""),
                arguments: typeof part.input === "object" ? JSON.stringify(part.input) : String(part.input ?? ""),
              },
            });
          } else {
            textParts.push(part);
          }
        }
        if (textParts.length > 0) {
          assistantMsg.content = textParts;
        }
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
      } else if (typeof openAiContent === "string" && openAiContent) {
        assistantMsg.content = openAiContent;
      }

      result.push(assistantMsg);
    }
  }

  return result;
}

function convertAnthropicToolsToOpenAI(tools: unknown): OpenAiTool[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const result: OpenAiTool[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const t = tool as Record<string, unknown>;
    const name = String(t.name ?? "");
    if (!name) continue;
    result.push({
      type: "function",
      function: {
        name,
        description: typeof t.description === "string" ? t.description : undefined,
        parameters: (t.input_schema as Record<string, unknown>) || (t.parameters as Record<string, unknown>) || { type: "object", properties: {} },
      },
    });
  }
  return result.length > 0 ? result : undefined;
}

function convertAnthropicToolChoiceToOpenAI(choice: unknown): unknown {
  if (!choice || typeof choice !== "object") return undefined;
  const c = choice as Record<string, unknown>;
  const type = String(c.type ?? "");
  if (type === "auto") return "auto";
  if (type === "none") return "none";
  if (type === "any") return "required";
  if (type === "tool" && typeof c.name === "string") {
    return { type: "function", function: { name: c.name } };
  }
  return undefined;
}

function adjustMaxTokens(body: Record<string, unknown>, providerDefault?: number): number | undefined {
  const max = body.max_tokens ?? body.max_completion_tokens;
  if (typeof max === "number" && max > 0) return max;
  return providerDefault;
}

export function anthropicToOpenAIRequest(
  body: Record<string, unknown>,
  model: string,
  providerDefaultMaxTokens?: number
): OpenAiRequest {
  const result: OpenAiRequest = {
    model,
    messages: [],
  };

  const maxTokens = adjustMaxTokens(body, providerDefaultMaxTokens);
  if (maxTokens !== undefined) {
    result.max_tokens = maxTokens;
  }

  if (body.temperature !== undefined) {
    result.temperature = Number(body.temperature);
  }

  if (body.stream === true) {
    result.stream = true;
  }

  const systemParts: string[] = [];
  if (typeof body.system === "string" && body.system.trim()) {
    systemParts.push(body.system.trim());
  } else if (Array.isArray(body.system)) {
    for (const part of body.system) {
      if (typeof part === "string" && part.trim()) {
        systemParts.push(part.trim());
      } else if (part && typeof part === "object") {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string" && text.trim()) systemParts.push(text.trim());
      }
    }
  }

  if (Array.isArray(body.messages)) {
    result.messages = convertAnthropicMessagesToOpenAI(body.messages as Array<Record<string, unknown>>, systemParts);
  } else if (systemParts.length > 0) {
    result.messages = systemParts.map((s) => ({ role: "system" as const, content: s }));
  }

  const openAiTools = convertAnthropicToolsToOpenAI(body.tools);
  if (openAiTools) {
    result.tools = openAiTools;
  }

  const openAiToolChoice = convertAnthropicToolChoiceToOpenAI(body.tool_choice);
  if (openAiToolChoice !== undefined) {
    result.tool_choice = openAiToolChoice;
  }

  if (body.response_format) {
    result.response_format = body.response_format as Record<string, unknown>;
  }

  return result;
}
