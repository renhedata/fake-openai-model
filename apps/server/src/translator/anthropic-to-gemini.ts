/**
 * Anthropic request → Gemini request translator.
 *
 * Gemini uses a structurally different API:
 *   - messages[]            → contents[] (role "assistant" → "model")
 *   - system                → systemInstruction
 *   - tools[].input_schema  → functionDeclarations[].parameters (uppercase types)
 *   - tool_choice           → toolConfig.functionCallingConfig
 *   - max_tokens            → generationConfig.maxOutputTokens
 *   - stream                → URL endpoint (:streamGenerateContent?alt=sse vs :generateContent)
 */

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { fileUri: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { output: string } };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  tools?: [{ functionDeclarations: GeminiFunctionDeclaration[] }];
  toolConfig?: { functionCallingConfig: { mode: string; allowedFunctionNames?: string[] } };
  generationConfig?: { maxOutputTokens?: number; temperature?: number };
}

function anthropicBlocksToGeminiParts(content: unknown): GeminiPart[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];

  const parts: GeminiPart[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "text" && typeof block.text === "string" && block.text) {
      parts.push({ text: block.text });
    } else if (block.type === "image" && block.source) {
      const src = block.source as Record<string, unknown>;
      if (src.type === "base64" && typeof src.data === "string" && typeof src.media_type === "string") {
        parts.push({ inlineData: { mimeType: src.media_type, data: src.data } });
      } else if (src.type === "url" && typeof src.url === "string") {
        parts.push({ fileData: { fileUri: src.url } });
      }
    } else if (block.type === "tool_use") {
      parts.push({
        functionCall: {
          name: String(block.name ?? ""),
          args: (block.input as Record<string, unknown>) ?? {},
        },
      });
    } else if (block.type === "tool_result") {
      const rawContent = block.content;
      let output: string;
      if (typeof rawContent === "string") {
        output = rawContent;
      } else if (Array.isArray(rawContent)) {
        output = (rawContent as Array<{ type?: string; text?: string }>)
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n");
      } else {
        output = JSON.stringify(rawContent ?? "");
      }
      parts.push({
        functionResponse: {
          name: String(block.tool_use_id ?? ""),
          response: { output },
        },
      });
    } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
      parts.push({ text: `<thinking>${block.thinking}</thinking>` });
    }
  }
  return parts;
}

// Gemini schema uses uppercase type names ("STRING", "OBJECT", "ARRAY", …)
function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...schema };
  if (typeof result.type === "string") result.type = result.type.toUpperCase();
  if (result.properties && typeof result.properties === "object") {
    const converted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result.properties as Record<string, unknown>)) {
      converted[k] = toGeminiSchema(v as Record<string, unknown>);
    }
    result.properties = converted;
  }
  if (result.items && typeof result.items === "object") {
    result.items = toGeminiSchema(result.items as Record<string, unknown>);
  }
  return result;
}

export function anthropicToGeminiRequest(body: Record<string, unknown>): GeminiRequest {
  const result: GeminiRequest = { contents: [] };

  // System instruction
  const systemTexts: string[] = [];
  if (typeof body.system === "string" && body.system.trim()) {
    systemTexts.push(body.system.trim());
  } else if (Array.isArray(body.system)) {
    for (const part of body.system) {
      if (typeof part === "string" && part.trim()) {
        systemTexts.push(part.trim());
      } else if (part && typeof part === "object") {
        const t = (part as Record<string, unknown>).text;
        if (typeof t === "string" && t.trim()) systemTexts.push(t.trim());
      }
    }
  }
  if (systemTexts.length > 0) {
    result.systemInstruction = { parts: [{ text: systemTexts.join("\n") }] };
  }

  // Messages → contents
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages as Array<Record<string, unknown>>) {
      const role = String(msg.role ?? "");
      if (role !== "user" && role !== "assistant") continue;
      const parts = anthropicBlocksToGeminiParts(msg.content);
      if (parts.length === 0) continue;
      result.contents.push({ role: role === "assistant" ? "model" : "user", parts });
    }
  }

  // Tools → functionDeclarations
  if (Array.isArray(body.tools) && (body.tools as unknown[]).length > 0) {
    const declarations: GeminiFunctionDeclaration[] = [];
    for (const tool of body.tools as Array<Record<string, unknown>>) {
      const name = String(tool.name ?? "");
      if (!name) continue;
      const rawSchema = (tool.input_schema ?? tool.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>;
      declarations.push({
        name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        parameters: toGeminiSchema(rawSchema),
      });
    }
    if (declarations.length > 0) result.tools = [{ functionDeclarations: declarations }];
  }

  // Tool choice → toolConfig
  if (body.tool_choice && typeof body.tool_choice === "object") {
    const choice = body.tool_choice as Record<string, unknown>;
    const t = String(choice.type ?? "");
    if (t === "none") {
      result.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    } else if (t === "any") {
      result.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    } else if (t === "tool" && typeof choice.name === "string") {
      result.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.name] } };
    } else {
      result.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }
  }

  // Generation config
  const genConfig: { maxOutputTokens?: number; temperature?: number } = {};
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  if (typeof maxTokens === "number" && maxTokens > 0) genConfig.maxOutputTokens = maxTokens;
  if (typeof body.temperature === "number") genConfig.temperature = body.temperature;
  if (Object.keys(genConfig).length > 0) result.generationConfig = genConfig;

  return result;
}

/** Returns the Gemini API path for the given model and streaming mode. */
export function getGeminiPath(model: string, stream: boolean): string {
  const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return `/v1beta/models/${encodeURIComponent(model)}:${action}`;
}
