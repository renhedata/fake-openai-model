/** Extract prompt text from raw body. format="anthropic" also reads body.system and only captures user messages. */
export const extractPromptText = (
  body: Record<string, unknown>,
  format: "oai" | "anthropic" = "oai"
): { captured: string; promptTokens: number } => {
  const parts: string[] = [];
  if (format === "anthropic" && typeof body.system === "string" && body.system.trim()) {
    parts.push(body.system.trim());
  }
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || typeof m !== "object") continue;
      const msg = m as Record<string, unknown>;
      if (format === "oai" ? (msg.role !== "user" && msg.role !== "system") : msg.role !== "user") continue;
      if (typeof msg.content === "string") {
        parts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === "string") parts.push(part);
          else if (part && typeof part === "object") {
            const p = part as Record<string, unknown>;
            if (typeof p.text === "string") parts.push(p.text);
            else if (format === "oai" && typeof p.input_text === "string") parts.push(p.input_text);
          }
        }
      }
    }
  }
  const captured = parts.join("\n").trim();
  return { captured, promptTokens: Math.max(1, Math.ceil(Math.max(1, captured.length) / 4)) };
};

/** Extract the text of the latest human-typed user message from a messages array.
 *  Skips content parts that are images, documents, or tool results so the preview
 *  reflects the real task/question rather than raw tool output.
 */
export const extractLastUserText = (body: Record<string, unknown>): string => {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return "";
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const m = body.messages[i];
    if (!m || typeof m !== "object") continue;
    const msg = m as Record<string, unknown>;
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") {
      const text = msg.content.trim();
      if (text) return text;
      continue;
    }
    if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const part of msg.content) {
        if (!part || typeof part !== "object") {
          if (typeof part === "string") parts.push(part);
          continue;
        }
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") parts.push(p.text);
        else if (typeof p.input_text === "string") parts.push(p.input_text);
        // Skip image, document, tool_result, tool_use, thinking, etc.
      }
      const text = parts.join("").trim();
      if (text) return text;
    }
  }
  return "";
};

/** Detect agent type from prompt text based on known keywords. */
export const detectAgentType = (text: string): "openclaw" | "hermes" | null => {
  if (text.includes("You are a personal assistant running inside OpenClaw.")) return "openclaw";
  if (text.includes("Hermes Agent Persona")) return "hermes";
  return null;
};
