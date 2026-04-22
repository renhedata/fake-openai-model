export type StoredToolCall = { id?: string; name: string; arguments: string };

/** Stateful inline extractor for OpenAI-format SSE streams (no size limit). */
export const createOaiSseExtractor = () => {
  let rawContent = "";
  let reasoning = "";
  const toolCalls: Array<{ index: number; id?: string; function: { name: string; arguments: string } }> = [];
  let lineBuffer = "";

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{
          delta?: Record<string, unknown>;
          message?: { content?: string };
        }>;
      };
      const delta = parsed.choices?.[0]?.delta;
      if (delta) {
        if (typeof delta.content === "string") rawContent += delta.content;
        if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) toolCalls[idx] = { index: idx, id: tc.id, function: { name: "", arguments: "" } };
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }
      // Non-streaming message format
      const msgContent = parsed.choices?.[0]?.message?.content;
      if (typeof msgContent === "string") rawContent += msgContent;
    } catch { /* ignore */ }
  };

  const feed = (chunk: string) => {
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  };

  const finish = (): { content: string; reasoning: string; toolCalls: StoredToolCall[] } => {
    if (lineBuffer) { processLine(lineBuffer); lineBuffer = ""; }
    // Extract <think>…</think> blocks into reasoning (models like QwQ / DeepSeek)
    let thinkReasoning = "";
    const thinkRe = /<think>([\s\S]*?)<\/think>/gi;
    let m: RegExpExecArray | null;
    while ((m = thinkRe.exec(rawContent)) !== null) {
      thinkReasoning += (thinkReasoning ? "\n\n" : "") + m[1];
    }
    const content = rawContent
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/<\/?think>/gi, "")
      .trim();
    const finalReasoning = [reasoning, thinkReasoning].filter(Boolean).join("\n\n").trim();
    const stored: StoredToolCall[] = toolCalls
      .filter(Boolean)
      .map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
    return { content, reasoning: finalReasoning, toolCalls: stored };
  };

  return { feed, finish };
};

/** Stateful inline extractor for Anthropic-format SSE streams. */
export const createAnthropicSseExtractor = () => {
  type Block = { type: string; text: string; thinking: string; name: string; id: string; input: string };
  const blocks: Block[] = [];
  let lineBuffer = "";

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (parsed.type === "content_block_start") {
        const idx = parsed.index as number;
        const cb = parsed.content_block as Record<string, unknown>;
        blocks[idx] = { type: String(cb.type ?? ""), text: "", thinking: "", name: String(cb.name ?? ""), id: String(cb.id ?? ""), input: "" };
      } else if (parsed.type === "content_block_delta") {
        const idx = parsed.index as number;
        const block = blocks[idx];
        if (!block) return;
        const delta = parsed.delta as Record<string, unknown>;
        if (delta.type === "text_delta" && typeof delta.text === "string") block.text += delta.text;
        else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") block.thinking += delta.thinking;
        else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") block.input += delta.partial_json;
      }
    } catch { /* ignore */ }
  };

  const feed = (chunk: string) => {
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  };

  const finish = (): { content: string; reasoning: string; toolCalls: StoredToolCall[] } => {
    if (lineBuffer) { processLine(lineBuffer); lineBuffer = ""; }
    let content = "";
    let reasoning = "";
    const toolCalls: StoredToolCall[] = [];
    for (const block of blocks) {
      if (!block) continue;
      if (block.type === "text" && block.text) content += (content ? "\n" : "") + block.text;
      if (block.type === "thinking" && block.thinking) reasoning += (reasoning ? "\n\n" : "") + block.thinking;
      if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
    }
    return { content: content.trim(), reasoning: reasoning.trim(), toolCalls };
  };

  return { feed, finish };
};
