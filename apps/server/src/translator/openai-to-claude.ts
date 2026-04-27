/**
 * OpenAI request → Claude request translator.
 * Based on 9router's open-sse/translator/request/openai-to-claude.js
 */

const CLAUDE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

interface ClaudeMessage {
  role: "user" | "assistant";
  content: Array<Record<string, unknown>>;
}

interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type: string; ttl?: string };
}

interface ClaudeRequest {
  model: string;
  max_tokens: number;
  stream: boolean;
  messages: ClaudeMessage[];
  system?: Array<{ type: string; text: string; cache_control?: { type: string; ttl?: string } }>;
  tools?: ClaudeTool[];
  tool_choice?: Record<string, unknown>;
  thinking?: Record<string, unknown>;
  temperature?: number;
  _toolNameMap?: Map<string, string>;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function tryParseJSON(str: unknown): unknown {
  if (typeof str !== "string") return str;
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function getContentBlocksFromMessage(msg: Record<string, unknown>): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  if (msg.role === "tool") {
    blocks.push({
      type: "tool_result",
      tool_use_id: msg.tool_call_id,
      content: msg.content,
    });
  } else if (msg.role === "user") {
    if (typeof msg.content === "string") {
      if (msg.content) blocks.push({ type: "text", text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<Record<string, unknown>>) {
        if (part.type === "text" && part.text) {
          blocks.push({ type: "text", text: part.text });
        } else if (part.type === "tool_result") {
          blocks.push({
            type: "tool_result",
            tool_use_id: part.tool_use_id,
            content: part.content,
            ...(part.is_error ? { is_error: part.is_error } : {}),
          });
        } else if (part.type === "image_url") {
          const imageUrl = (part.image_url as Record<string, unknown> | undefined)?.url as string | undefined;
          if (imageUrl) {
            const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              blocks.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
            } else if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
              blocks.push({ type: "image", source: { type: "url", url: imageUrl } });
            }
          }
        } else if (part.type === "image" && part.source) {
          blocks.push({ type: "image", source: part.source });
        }
      }
    }
  } else if (msg.role === "assistant") {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<Record<string, unknown>>) {
        if (part.type === "text" && part.text) {
          blocks.push({ type: "text", text: part.text });
        } else if (part.type === "tool_use") {
          blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.input });
        } else if (part.type === "thinking") {
          const { cache_control, ...thinkingBlock } = part;
          blocks.push(thinkingBlock);
        }
      }
    } else if (msg.content) {
      const text = typeof msg.content === "string" ? msg.content : extractTextContent(msg.content);
      if (text) blocks.push({ type: "text", text });
    }

    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
        if (tc.type === "function") {
          const fn = tc.function as Record<string, unknown> | undefined;
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: fn?.name,
            input: tryParseJSON(fn?.arguments),
          });
        }
      }
    }
  }

  return blocks;
}

function convertOpenAIToolChoice(choice: unknown): Record<string, unknown> {
  if (!choice) return { type: "auto" };
  if (typeof choice === "object" && choice !== null && "type" in choice) return choice as Record<string, unknown>;
  if (choice === "auto" || choice === "none") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice !== null && "function" in choice) {
    const fc = choice as { function?: { name?: string } };
    return { type: "tool", name: fc.function?.name };
  }
  return { type: "auto" };
}

function convertOpenAIFunctionsToTools(functions: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(functions)) return undefined;
  return functions.map((fn) => ({
    type: "function",
    function: fn,
  }));
}

function convertOpenAIFunctionCallToToolChoice(functionCall: unknown): Record<string, unknown> | undefined {
  if (!functionCall) return undefined;
  if (typeof functionCall === "string") {
    if (functionCall === "none") return { type: "none" };
    if (functionCall === "auto") return { type: "auto" };
    return { type: "auto" };
  }
  if (typeof functionCall === "object" && functionCall !== null) {
    const fc = functionCall as { name?: string };
    if (fc.name) return { type: "tool", name: fc.name };
  }
  return undefined;
}

function adjustMaxTokens(body: Record<string, unknown>, providerDefault?: number): number {
  const max = body.max_tokens ?? body.max_completion_tokens;
  if (typeof max === "number" && max > 0) return max;
  return providerDefault ?? 4096;
}

export function openaiToClaudeRequest(model: string, body: Record<string, unknown>, stream: boolean, providerDefaultMaxTokens?: number): ClaudeRequest {
  const toolNameMap = new Map<string, string>();
  const result: ClaudeRequest = {
    model,
    max_tokens: adjustMaxTokens(body, providerDefaultMaxTokens),
    stream,
    messages: [],
  };

  if (body.temperature !== undefined) {
    result.temperature = Number(body.temperature);
  }

  // Messages
  const systemParts: string[] = [];
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages as Array<Record<string, unknown>>) {
      if (msg.role === "system") {
        systemParts.push(typeof msg.content === "string" ? msg.content : extractTextContent(msg.content));
      }
    }

    const nonSystemMessages = (body.messages as Array<Record<string, unknown>>).filter((m) => m.role !== "system");

    let currentRole: "user" | "assistant" | undefined;
    let currentParts: Array<Record<string, unknown>> = [];

    const flushCurrentMessage = () => {
      if (currentRole && currentParts.length > 0) {
        result.messages.push({ role: currentRole, content: currentParts });
        currentParts = [];
      }
    };

    for (const msg of nonSystemMessages) {
      const newRole = (msg.role === "user" || msg.role === "tool") ? "user" : "assistant";
      const blocks = getContentBlocksFromMessage(msg);
      const hasToolResult = blocks.some((b) => b.type === "tool_result");

      if (hasToolResult) {
        const toolResultBlocks = blocks.filter((b) => b.type === "tool_result");
        const otherBlocks = blocks.filter((b) => b.type !== "tool_result");

        flushCurrentMessage();

        if (toolResultBlocks.length > 0) {
          result.messages.push({ role: "user", content: toolResultBlocks });
        }
        if (otherBlocks.length > 0) {
          currentRole = newRole;
          currentParts.push(...otherBlocks);
        }
        continue;
      }

      if (currentRole !== newRole) {
        flushCurrentMessage();
        currentRole = newRole;
      }

      currentParts.push(...blocks);
    }

    flushCurrentMessage();

    // Add cache_control to last assistant message
    for (let i = result.messages.length - 1; i >= 0; i--) {
      const message = result.messages[i];
      if (message.role === "assistant" && Array.isArray(message.content) && message.content.length > 0) {
        const validBlockTypes = ["text", "tool_use", "tool_result", "image"];
        for (let j = message.content.length - 1; j >= 0; j--) {
          const block = message.content[j];
          if (validBlockTypes.includes(block.type as string)) {
            block.cache_control = { type: "ephemeral" };
            break;
          }
        }
        break;
      }
    }
  }

  // Handle response_format for JSON mode
  if (body.response_format) {
    const responseFormat = body.response_format as Record<string, unknown>;
    if (responseFormat.type === "json_schema" && (responseFormat.json_schema as Record<string, unknown> | undefined)?.schema) {
      const schemaJson = JSON.stringify((responseFormat.json_schema as Record<string, unknown>).schema, null, 2);
      systemParts.push(`You must respond with valid JSON that strictly follows this JSON schema:\n\`\`\`json\n${schemaJson}\n\`\`\`\nRespond ONLY with the JSON object, no other text.`);
    } else if (responseFormat.type === "json_object") {
      systemParts.push("You must respond with valid JSON. Respond ONLY with a JSON object, no other text.");
    }
  }

  // System with Claude Code prompt
  const claudeCodePrompt = { type: "text", text: CLAUDE_SYSTEM_PROMPT };
  if (systemParts.length > 0) {
    const systemText = systemParts.join("\n");
    result.system = [
      claudeCodePrompt,
      { type: "text", text: systemText, cache_control: { type: "ephemeral", ttl: "1h" } },
    ];
  } else {
    result.system = [claudeCodePrompt];
  }

  // Tools (support both `tools` and legacy `functions`)
  const toolsSource = body.tools && Array.isArray(body.tools)
    ? (body.tools as Array<Record<string, unknown>>)
    : convertOpenAIFunctionsToTools(body.functions);

  if (toolsSource) {
    result.tools = [];
    for (const tool of toolsSource) {
      const toolType = tool.type as string | undefined;
      if (toolType && toolType !== "function") {
        result.tools.push(tool as unknown as ClaudeTool);
        continue;
      }

      const toolData = toolType === "function" && tool.function ? (tool.function as Record<string, unknown>) : tool;
      const originalName = toolData.name as string;
      toolNameMap.set(originalName, originalName);

      result.tools.push({
        name: originalName,
        description: (toolData.description as string) || "",
        input_schema: (toolData.parameters as Record<string, unknown>) || (toolData.input_schema as Record<string, unknown>) || { type: "object", properties: {}, required: [] },
      });
    }

    if (result.tools.length > 0) {
      result.tools[result.tools.length - 1].cache_control = { type: "ephemeral", ttl: "1h" };
    }
  }

  // Tool choice (support both `tool_choice` and legacy `function_call`)
  const toolChoiceSource = body.tool_choice
    ? body.tool_choice
    : convertOpenAIFunctionCallToToolChoice(body.function_call);

  if (toolChoiceSource) {
    result.tool_choice = convertOpenAIToolChoice(toolChoiceSource);
  }

  // Thinking
  if (body.thinking) {
    const thinking = body.thinking as Record<string, unknown>;
    result.thinking = {
      type: (thinking.type as string) || "enabled",
      ...(thinking.budget_tokens ? { budget_tokens: thinking.budget_tokens } : {}),
      ...(thinking.max_tokens ? { max_tokens: thinking.max_tokens } : {}),
    };
  }

  if (toolNameMap.size > 0) {
    result._toolNameMap = toolNameMap;
  }

  return result;
}
