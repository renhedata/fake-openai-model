/**
 * Gemini response → Anthropic response translator (non-streaming + streaming).
 */

import type { StoredToolCall } from "../utils/sse-extractors.js";

type AnthropicStopReason = "end_turn" | "max_tokens" | "tool_use" | "stop_sequence";

function geminiFinishToAnthropic(reason: string | undefined, hasToolUse: boolean): AnthropicStopReason {
  if (hasToolUse) return "tool_use";
  if (reason === "MAX_TOKENS") return "max_tokens";
  return "end_turn";
}

/** Convert a non-streaming Gemini response object to Anthropic message format. */
export function geminiToAnthropicResponse(
  geminiResponse: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  const candidates = geminiResponse.candidates as Array<Record<string, unknown>> | undefined;
  const candidate = candidates?.[0];
  const parts = ((candidate?.content as Record<string, unknown> | undefined)?.parts ?? []) as Array<Record<string, unknown>>;

  const content: Array<Record<string, unknown>> = [];
  let hasToolUse = false;
  let toolIdx = 0;

  for (const part of parts) {
    if (typeof part.text === "string" && part.text) {
      content.push({ type: "text", text: part.text });
    } else if (part.functionCall && typeof part.functionCall === "object") {
      const fc = part.functionCall as Record<string, unknown>;
      hasToolUse = true;
      content.push({
        type: "tool_use",
        id: `call_${Date.now()}_${toolIdx++}`,
        name: String(fc.name ?? ""),
        input: fc.args ?? {},
      });
    }
  }

  const usageMeta = geminiResponse.usageMetadata as Record<string, number> | undefined;

  return {
    id: `msg_gemini_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: String(geminiResponse.modelVersion ?? model),
    content,
    stop_reason: geminiFinishToAnthropic(candidate?.finishReason as string | undefined, hasToolUse),
    stop_sequence: null,
    usage: {
      input_tokens: usageMeta?.promptTokenCount ?? 0,
      output_tokens: usageMeta?.candidatesTokenCount ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming support
// ---------------------------------------------------------------------------

export interface GeminiStreamState {
  msgId: string;
  model: string;
  promptTokens: number;
  textBlockOpen: boolean;
  toolCallCount: number;
  done: boolean;
  outputTokens: number;
  accumulatedContent: string;
  toolCalls: StoredToolCall[];
}

export function createGeminiStreamState(msgId: string, model: string, promptTokens: number): GeminiStreamState {
  return {
    msgId,
    model,
    promptTokens,
    textBlockOpen: false,
    toolCallCount: 0,
    done: false,
    outputTokens: 0,
    accumulatedContent: "",
    toolCalls: [],
  };
}

/**
 * Process one Gemini SSE data payload and return the Anthropic SSE events to emit.
 * Text block is always index 0; tool_use blocks follow at index 1, 2, …
 */
export function processGeminiChunk(
  data: string,
  state: GeminiStreamState
): Array<{ event: string; data: unknown }> {
  if (state.done) return [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return [];
  }

  const candidates = parsed.candidates as Array<Record<string, unknown>> | undefined;
  const candidate = candidates?.[0];
  if (!candidate) return [];

  const parts = ((candidate.content as Record<string, unknown> | undefined)?.parts ?? []) as Array<Record<string, unknown>>;
  const finishReason = candidate.finishReason as string | undefined;
  const events: Array<{ event: string; data: unknown }> = [];

  for (const part of parts) {
    if (typeof part.text === "string" && part.text) {
      if (!state.textBlockOpen) {
        state.textBlockOpen = true;
        events.push({
          event: "content_block_start",
          data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        });
        events.push({ event: "ping", data: { type: "ping" } });
      }
      state.accumulatedContent += part.text;
      events.push({
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part.text } },
      });
    } else if (part.functionCall && typeof part.functionCall === "object") {
      const fc = part.functionCall as Record<string, unknown>;
      const toolName = String(fc.name ?? "");
      const toolId = `call_${Date.now()}_${state.toolCallCount}`;
      const argsJson = JSON.stringify(fc.args ?? {});

      if (!state.textBlockOpen) {
        // Open an empty text block first to satisfy Anthropic block ordering
        state.textBlockOpen = true;
        events.push({
          event: "content_block_start",
          data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        });
      }

      const toolBlockIdx = state.toolCallCount + 1;
      state.toolCallCount++;

      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: toolBlockIdx,
          content_block: { type: "tool_use", id: toolId, name: toolName, input: {} },
        },
      });
      events.push({ event: "ping", data: { type: "ping" } });
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: toolBlockIdx,
          delta: { type: "input_json_delta", partial_json: argsJson },
        },
      });
      events.push({
        event: "content_block_stop",
        data: { type: "content_block_stop", index: toolBlockIdx },
      });

      state.toolCalls.push({ id: toolId, name: toolName, arguments: argsJson });
    }
  }

  const usageMeta = parsed.usageMetadata as Record<string, number> | undefined;
  if (usageMeta?.candidatesTokenCount) state.outputTokens = usageMeta.candidatesTokenCount;

  if (finishReason && !state.done) {
    state.done = true;

    if (state.textBlockOpen) {
      events.push({ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } });
    }

    const stopReason = finishReason === "MAX_TOKENS" ? "max_tokens"
      : state.toolCalls.length > 0 ? "tool_use" : "end_turn";
    const outputTokens = state.outputTokens || Math.max(1, Math.ceil(state.accumulatedContent.length / 4));

    events.push({
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } },
    });
    events.push({ event: "message_stop", data: { type: "message_stop" } });
  }

  return events;
}
