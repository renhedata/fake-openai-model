/**
 * Claude response → OpenAI response translator.
 * Based on 9router's open-sse/translator/response/claude-to-openai.js
 */

interface TranslationState {
  messageId: string;
  model: string;
  toolCallIndex: number;
  toolCalls: Map<number, { index: number; id: string; type: string; function: { name: string; arguments: string } }>;
  serverToolBlockIndex: number;
  inThinkingBlock: boolean;
  currentBlockIndex: number;
  finishReason: string | null;
  finishReasonSent: boolean;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | null;
}

export function createTranslationState(model: string): TranslationState {
  return {
    messageId: `msg_${Date.now()}`,
    model,
    toolCallIndex: 0,
    toolCalls: new Map(),
    serverToolBlockIndex: -1,
    inThinkingBlock: false,
    currentBlockIndex: -1,
    finishReason: null,
    finishReasonSent: false,
    usage: null,
  };
}

function createChunk(state: TranslationState, delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
  return {
    id: `chatcmpl-${state.messageId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function convertStopReason(reason: string): string {
  switch (reason) {
    case "end_turn": return "stop";
    case "max_tokens": return "length";
    case "tool_use": return "tool_calls";
    case "stop_sequence": return "stop";
    default: return "stop";
  }
}

export function claudeToOpenAIChunk(chunk: Record<string, unknown>, state: TranslationState, toolNameMap?: Map<string, string>): Array<Record<string, unknown>> | null {
  if (!chunk) return null;

  const results: Array<Record<string, unknown>> = [];
  const event = chunk.type as string;

  switch (event) {
    case "message_start": {
      const message = chunk.message as Record<string, unknown> | undefined;
      state.messageId = (message?.id as string) || `msg_${Date.now()}`;
      state.model = (message?.model as string) || state.model;
      state.toolCallIndex = 0;
      results.push(createChunk(state, { role: "assistant" }));
      break;
    }

    case "content_block_start": {
      const block = (chunk.content_block as Record<string, unknown>) || {};
      if (block.type === "server_tool_use") {
        state.serverToolBlockIndex = chunk.index as number;
        break;
      }
      if (block.type === "text") {
        // text block started
      } else if (block.type === "thinking") {
        state.inThinkingBlock = true;
        state.currentBlockIndex = chunk.index as number;
        results.push(createChunk(state, { content: "<think>" }));
      } else if (block.type === "tool_use") {
        const toolCallIndex = state.toolCallIndex++;
        const toolName = String(toolNameMap?.get(block.name as string) || block.name || "");
        const toolCall = {
          index: toolCallIndex,
          id: String(block.id ?? ""),
          type: "function",
          function: { name: toolName, arguments: "" },
        };
        state.toolCalls.set(chunk.index as number, toolCall);
        results.push(createChunk(state, { tool_calls: [toolCall] }));
      }
      break;
    }

    case "content_block_delta": {
      if (chunk.index === state.serverToolBlockIndex) break;
      const delta = (chunk.delta as Record<string, unknown>) || {};
      if (delta.type === "text_delta" && delta.text) {
        results.push(createChunk(state, { content: delta.text }));
      } else if (delta.type === "thinking_delta" && delta.thinking) {
        results.push(createChunk(state, { reasoning_content: delta.thinking }));
      } else if (delta.type === "input_json_delta" && delta.partial_json) {
        const toolCall = state.toolCalls.get(chunk.index as number);
        if (toolCall) {
          toolCall.function.arguments += delta.partial_json;
          results.push(createChunk(state, {
            tool_calls: [{
              index: toolCall.index,
              id: toolCall.id,
              function: { arguments: delta.partial_json },
            }],
          }));
        }
      }
      break;
    }

    case "content_block_stop": {
      if (chunk.index === state.serverToolBlockIndex) {
        state.serverToolBlockIndex = -1;
        break;
      }
      if (state.inThinkingBlock && chunk.index === state.currentBlockIndex) {
        results.push(createChunk(state, { content: "</think>" }));
        state.inThinkingBlock = false;
      }
      break;
    }

    case "message_delta": {
      if (chunk.usage && typeof chunk.usage === "object") {
        const usage = chunk.usage as Record<string, number>;
        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const cacheReadTokens = usage.cache_read_input_tokens || 0;
        const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
        const promptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;

        state.usage = {
          prompt_tokens: promptTokens,
          completion_tokens: outputTokens,
          total_tokens: promptTokens + outputTokens,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        };
        if (cacheReadTokens > 0) state.usage.cache_read_input_tokens = cacheReadTokens;
        if (cacheCreationTokens > 0) state.usage.cache_creation_input_tokens = cacheCreationTokens;
      }

      const msgDelta = chunk.delta as Record<string, unknown> | undefined;
      if (msgDelta?.stop_reason) {
        state.finishReason = convertStopReason(msgDelta.stop_reason as string);
        const finalChunk: Record<string, unknown> = createChunk(state, {}, state.finishReason);
        if (state.usage) {
          finalChunk.usage = {
            prompt_tokens: state.usage.prompt_tokens,
            completion_tokens: state.usage.completion_tokens,
            total_tokens: state.usage.total_tokens,
          };
          if (state.usage.cache_read_input_tokens || state.usage.cache_creation_input_tokens) {
            const details: Record<string, number> = {};
            if (state.usage.cache_read_input_tokens) details.cached_tokens = state.usage.cache_read_input_tokens;
            if (state.usage.cache_creation_input_tokens) details.cache_creation_tokens = state.usage.cache_creation_input_tokens;
            (finalChunk.usage as Record<string, unknown>).prompt_tokens_details = details;
          }
        }
        results.push(finalChunk);
        state.finishReasonSent = true;
      }
      break;
    }

    case "message_stop": {
      if (!state.finishReasonSent) {
        const finishReason = state.finishReason || (state.toolCalls.size > 0 ? "tool_calls" : "stop");
        const usageObj = state.usage ? {
          usage: {
            prompt_tokens: state.usage.input_tokens || 0,
            completion_tokens: state.usage.output_tokens || 0,
            total_tokens: (state.usage.input_tokens || 0) + (state.usage.output_tokens || 0),
          },
        } : {};
        results.push({
          id: `chatcmpl-${state.messageId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: state.model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          ...usageObj,
        });
        state.finishReasonSent = true;
      }
      break;
    }
  }

  return results.length > 0 ? results : null;
}

/** Convert Claude non-streaming response to OpenAI format. */
export function claudeToOpenAINonStreaming(claudeResponse: Record<string, unknown>, toolNameMap?: Map<string, string>): Record<string, unknown> {
  const message = claudeResponse as {
    id?: string;
    model?: string;
    content?: Array<{ type: string; text?: string; thinking?: string; name?: string; id?: string; input?: unknown }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };

  let content = "";
  let reasoning = "";
  const toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === "text" && block.text) {
        content += (content ? "\n" : "") + block.text;
      } else if (block.type === "thinking" && block.thinking) {
        reasoning += (reasoning ? "\n\n" : "") + block.thinking;
      } else if (block.type === "tool_use") {
        const toolName = toolNameMap?.get(block.name || "") || block.name;
        toolCalls.push({
          id: block.id || "",
          type: "function",
          function: {
            name: toolName || "",
            arguments: typeof block.input === "object" ? JSON.stringify(block.input) : String(block.input || ""),
          },
        });
      }
    }
  }

  const choice: Record<string, unknown> = {
    index: 0,
    message: {
      role: "assistant",
      content: content.trim(),
      ...(reasoning ? { reasoning_content: reasoning.trim() } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    finish_reason: convertStopReason(message.stop_reason || "end_turn"),
  };

  const usage = message.usage || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  const promptTokens = inputTokens + cacheRead + cacheCreation;

  const result: Record<string, unknown> = {
    id: message.id || `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: message.model || "unknown",
    choices: [choice],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: outputTokens,
      total_tokens: promptTokens + outputTokens,
    },
  };

  if (cacheRead > 0 || cacheCreation > 0) {
    const details: Record<string, number> = {};
    if (cacheRead > 0) details.cached_tokens = cacheRead;
    if (cacheCreation > 0) details.cache_creation_tokens = cacheCreation;
    (result.usage as Record<string, unknown>).prompt_tokens_details = details;
  }

  return result;
}
