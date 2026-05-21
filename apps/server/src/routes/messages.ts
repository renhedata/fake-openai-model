import { Router } from "express";
import {
  addExchange,
  completeExchange,
  getProxyConfig,
} from "../state.js";
import { extractPromptText, detectAgentType } from "../utils/prompt.js";
import { resolveProviderForModel } from "../utils/provider-resolution.js";
import { extractCallerKey, validateCallerKey } from "../utils/auth.js";
import { resolveUpstreamUrl } from "../utils/url.js";
import { buildForwardHeaders } from "../utils/headers.js";
import { createAnthropicSseExtractor, createOaiSseExtractor, type StoredToolCall } from "../utils/sse-extractors.js";
import { tryParseJson } from "../utils/json.js";
import { fetchWithRetry } from "../utils/fetch-retry.js";
import { anthropicToOpenAIRequest } from "../translator/anthropic-to-openai.js";
import { openaiToAnthropicResponse } from "../translator/openai-to-anthropic.js";
import { anthropicToGeminiRequest, getGeminiPath } from "../translator/anthropic-to-gemini.js";
import { geminiToAnthropicResponse, createGeminiStreamState, processGeminiChunk, type GeminiStreamState } from "../translator/gemini-to-anthropic.js";
import type express from "express";

export const messagesRouter = Router();

/** Handle /v1/messages streaming response from upstream.
 * Auto-detects format: translates OpenAI SSE → Anthropic SSE if needed, or passes Anthropic SSE through.
 * Uses inline extractors — content is never truncated. */
const handleMessagesStream = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: express.Response,
  msgId: string,
  model: string,
  promptTokens: number,
  targetFormat: string = "openai",
): Promise<{ capturedSse: string; content: string; reasoning: string; toolCalls: StoredToolCall[]; format: "oai" | "anthropic" | "gemini" | "unknown" }> => {
  const decoder = new TextDecoder();
  let lineBuffer = "";
  const RAW_SSE_LIMIT = 32_000;
  let capturedSse = "";
  let format: "oai" | "anthropic" | "gemini" | "unknown" = targetFormat === "gemini" ? "gemini" : "unknown";

  // Gemini streaming state — initialised only when targetFormat === "gemini"
  const geminiState: GeminiStreamState | null = targetFormat === "gemini"
    ? createGeminiStreamState(msgId, model, promptTokens)
    : null;

  // OAI → Anthropic translation state
  let oaiTextBlockOpen = false;
  let oaiDone = false;
  let oaiRawContent = "";
  let oaiReasoning = "";
  const oaiToolBlocks: Array<{ id: string; name: string; contentBlockIdx: number; started: boolean }> = [];
  let nextBlockIdx = 0;

  // Anthropic passthrough extraction
  const anthropicExtractor = createAnthropicSseExtractor();

  const writeEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // For Gemini: emit message_start before reading any chunks
  if (targetFormat === "gemini") {
    writeEvent("message_start", {
      type: "message_start",
      message: { id: msgId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: promptTokens, output_tokens: 0 } },
    });
  }

  const handleOaiChunk = (data: string) => {
    if (data === "[DONE]") return;
    let parsed: { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>; usage?: { completion_tokens?: number } };
    try { parsed = JSON.parse(data); } catch { return; }
    const choice = parsed.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};

    // Reasoning (DeepSeek / Qwen style)
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      oaiReasoning += delta.reasoning_content;
    }

    // Text content
    if (typeof delta.content === "string" && delta.content) {
      // Keep raw content for <think> post-processing
      oaiRawContent += delta.content;
      // Strip <think> tags for the text block sent to the client
      const stripped = delta.content.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "");
      if (stripped) {
        if (!oaiTextBlockOpen) {
          oaiTextBlockOpen = true;
          nextBlockIdx = 0;
          writeEvent("content_block_start", { type: "content_block_start", index: nextBlockIdx, content_block: { type: "text", text: "" } });
          writeEvent("ping", { type: "ping" });
          nextBlockIdx++;
        }
        writeEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: stripped } });
      }
    }

    // Tool calls → Anthropic tool_use blocks
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>) {
        const idx = tc.index ?? 0;
        if (!oaiToolBlocks[idx]) {
          // First delta for this tool: open text block first if not yet done
          if (!oaiTextBlockOpen && !oaiToolBlocks.some(Boolean)) {
            // Close text block (even empty) to keep block order clean
            oaiTextBlockOpen = true;
            nextBlockIdx = 0;
            writeEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            nextBlockIdx = 1;
          } else if (oaiTextBlockOpen) {
            nextBlockIdx = 1;
          }
          oaiToolBlocks[idx] = { id: tc.id ?? "", name: "", contentBlockIdx: nextBlockIdx, started: false };
          nextBlockIdx++;
        }
        const block = oaiToolBlocks[idx];
        if (tc.id) block.id = tc.id;
        if (tc.function?.name) block.name += tc.function.name;
        if (!block.started && block.name && block.id) {
          block.started = true;
          writeEvent("content_block_start", { type: "content_block_start", index: block.contentBlockIdx, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
          writeEvent("ping", { type: "ping" });
        }
        if (tc.function?.arguments && block.started) {
          writeEvent("content_block_delta", { type: "content_block_delta", index: block.contentBlockIdx, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
        }
      }
    }

    if (choice.finish_reason && !oaiDone) {
      oaiDone = true;
      // Close any open text block
      if (oaiTextBlockOpen) {
        writeEvent("content_block_stop", { type: "content_block_stop", index: 0 });
      }
      // Close all open tool blocks
      for (const block of oaiToolBlocks) {
        if (block?.started) writeEvent("content_block_stop", { type: "content_block_stop", index: block.contentBlockIdx });
      }
      const stopReason = choice.finish_reason === "length" ? "max_tokens"
        : choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
      const outputTokens = parsed.usage?.completion_tokens ?? Math.max(1, Math.ceil((oaiRawContent.replace(/<think>[\s\S]*?<\/think>/gi, "")).length / 4));
      writeEvent("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
      writeEvent("message_stop", { type: "message_stop" });
    }
  };

  const processLine = (line: string) => {
    if (capturedSse.length < RAW_SSE_LIMIT) capturedSse += line + "\n";

    if (format === "gemini") {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (!data) return;
      const events = processGeminiChunk(data, geminiState!);
      for (const { event, data: evData } of events) writeEvent(event, evData);
      return;
    }

    if (format === "anthropic") {
      res.write(line + "\n");
      anthropicExtractor.feed(line + "\n");
      return;
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;

    if (format === "unknown") {
      if (data === "[DONE]") { format = "oai"; return; }
      try {
        const peek = JSON.parse(data) as Record<string, unknown>;
        if (peek.object === "chat.completion.chunk" || Array.isArray(peek.choices)) {
          format = "oai";
          writeEvent("message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: promptTokens, output_tokens: 0 } } });
          handleOaiChunk(data);
        } else {
          format = "anthropic";
          res.write(line + "\n");
          anthropicExtractor.feed(line + "\n");
        }
      } catch { /* skip unparseable first line */ }
      return;
    }
    handleOaiChunk(data);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    lineBuffer += decoder.decode(value, { stream: true });
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  }
  if (lineBuffer) processLine(lineBuffer);

  // Flush any unterminated Gemini stream
  if (format === "gemini" && geminiState && !geminiState.done) {
    if (geminiState.textBlockOpen) {
      writeEvent("content_block_stop", { type: "content_block_stop", index: 0 });
    }
    const outputTokens = geminiState.outputTokens || Math.max(1, Math.ceil(geminiState.accumulatedContent.length / 4));
    writeEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } });
    writeEvent("message_stop", { type: "message_stop" });
  }

  // Flush any unterminated OAI stream
  if ((format as string) === "oai" && !oaiDone) {
    if (oaiTextBlockOpen) writeEvent("content_block_stop", { type: "content_block_stop", index: 0 });
    for (const block of oaiToolBlocks) {
      if (block?.started) writeEvent("content_block_stop", { type: "content_block_stop", index: block.contentBlockIdx });
    }
    writeEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: Math.max(1, Math.ceil(oaiRawContent.length / 4)) } });
    writeEvent("message_stop", { type: "message_stop" });
  }

  // Compute final extracted values
  let content: string;
  let reasoning: string;
  let toolCalls: StoredToolCall[];

  if (format === "gemini") {
    content = geminiState!.accumulatedContent;
    reasoning = "";
    toolCalls = geminiState!.toolCalls;
  } else if ((format as string) === "anthropic") {
    const r = anthropicExtractor.finish();
    content = r.content; reasoning = r.reasoning; toolCalls = r.toolCalls;
  } else {
    // OAI: post-process rawContent for <think> tags
    let thinkReasoning = "";
    const thinkRe = /<think>([\s\S]*?)<\/think>/gi;
    let m: RegExpExecArray | null;
    while ((m = thinkRe.exec(oaiRawContent)) !== null) thinkReasoning += (thinkReasoning ? "\n\n" : "") + m[1];
    content = oaiRawContent.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "").trim();
    reasoning = [oaiReasoning, thinkReasoning].filter(Boolean).join("\n\n").trim();
    toolCalls = oaiToolBlocks.filter(Boolean).map((b) => ({ id: b.id, name: b.name, arguments: "" }));
    // Note: tool args were streamed to client but not accumulated separately here (they're in the SSE)
    // Re-extract from capturedSse for completeness
    const reExtracted = createOaiSseExtractor();
    reExtracted.feed(capturedSse);
    const re = reExtracted.finish();
    if (re.toolCalls.length > 0) toolCalls = re.toolCalls;
    if (!content && re.content) content = re.content;
    if (!reasoning && re.reasoning) reasoning = re.reasoning;
  }

  return { capturedSse, content, reasoning, toolCalls, format };
};

messagesRouter.post("/v1/messages", async (req, res) => {
  const config = getProxyConfig();
  const body = req.body as Record<string, unknown>;

  const rawModel = typeof body.model === "string" ? body.model : "unknown";
  const model = config.modelOverride.trim() || rawModel;
  const stream = body.stream === true;
  const { captured, promptTokens } = extractPromptText(body, "anthropic");
  const agentType = detectAgentType(captured);

  const recordBody = config.modelOverride.trim() ? { ...body, model } : body;

  // Validate caller key early to capture apiKey info
  const callerKey = extractCallerKey(req);
  const keyValidation = validateCallerKey(callerKey, model);

  // --- Resolve provider by model, fallback to legacy proxy_config ---
  const { provider, actualModel, useLegacy } = resolveProviderForModel(model);

  // Reject unknown models — don't proxy upstream
  if (useLegacy) {
    res.status(404).json({
      error: {
        message: `Model '${model}' not found`,
        type: "invalid_request_error",
      },
    });
    return;
  }

  const targetBaseUrl = provider?.baseUrl ?? config.baseUrl;
  const targetApiKey = provider?.apiKey ?? config.apiKey;

  const targetFormat = provider?.format ?? "openai";
  // "ollama" is OpenAI-compatible; treat it the same as "openai" for translation
  const needsOpenAITranslation = targetFormat === "openai" || targetFormat === "ollama";
  const needsGeminiTranslation = targetFormat === "gemini";
  let translatedRequest: Record<string, unknown> | undefined;
  let upstreamUrl = "";
  let forwardBody: Record<string, unknown>;
  let forwardAuthStyle: "bearer" | "x-api-key";

  if (needsOpenAITranslation) {
    translatedRequest = anthropicToOpenAIRequest(body, actualModel, provider?.defaultMaxTokens) as unknown as Record<string, unknown>;
    try {
      upstreamUrl = resolveUpstreamUrl(targetBaseUrl, provider?.path ?? "/v1/chat/completions");
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid upstream config";
      res.status(400).json({ error: { message: "Invalid upstream config", type: "invalid_request_error", detail: message } });
      return;
    }
    forwardBody = translatedRequest;
    forwardAuthStyle = provider?.authStyle ?? "bearer";
  } else if (needsGeminiTranslation) {
    translatedRequest = anthropicToGeminiRequest(body) as unknown as Record<string, unknown>;
    try {
      upstreamUrl = resolveUpstreamUrl(targetBaseUrl, getGeminiPath(actualModel, stream));
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid upstream config";
      res.status(400).json({ error: { message: "Invalid upstream config", type: "invalid_request_error", detail: message } });
      return;
    }
    forwardBody = translatedRequest;
    forwardAuthStyle = provider?.authStyle ?? "bearer";
  } else {
    // "claude" format — pass through as-is to the upstream Anthropic-compatible endpoint
    const claudePath = provider?.path ?? "/v1/messages";
    try {
      upstreamUrl = resolveUpstreamUrl(targetBaseUrl, claudePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid upstream config";
      res.status(400).json({ error: { message: "Invalid upstream config", type: "invalid_request_error", detail: message } });
      return;
    }
    forwardBody = { ...body };
    if (config.modelOverride.trim()) {
      forwardBody.model = config.modelOverride.trim();
    } else if (provider && actualModel !== model) {
      forwardBody.model = actualModel;
    }
    forwardAuthStyle = provider?.authStyle ?? "x-api-key";
  }

  const record = addExchange({
    mode: config.mode,
    model,
    prompt: captured,
    promptTokens,
    requestBody: recordBody,
    translatedRequestBody: translatedRequest,
    apiKeyId: keyValidation.ok ? keyValidation.apiKeyId : undefined,
    apiKeyName: keyValidation.ok ? keyValidation.apiKeyName : undefined,
    agentType,
  });

  // --- Validate caller key ---
  if (!keyValidation.ok) {
    completeExchange(record.id, { responseStatus: "error", errorMessage: keyValidation.error, durationMs: 0 });
    res.status(401).json({ error: { message: keyValidation.error, type: "authentication_error" } });
    return;
  }

  const forwardHeaders = buildForwardHeaders(req, targetApiKey, forwardAuthStyle);
  const startedAt = Date.now();

  try {
    const upstreamResponse = stream
      ? await fetch(upstreamUrl, { method: "POST", headers: forwardHeaders, body: JSON.stringify(forwardBody) })
      : await fetchWithRetry(upstreamUrl, { method: "POST", headers: forwardHeaders, body: JSON.stringify(forwardBody) });

    if (stream) {
      res.status(upstreamResponse.status);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      let capturedSse = "";
      let extractedContent = "";
      let extractedReasoning = "";
      let extractedToolCalls: StoredToolCall[] = [];
      if (upstreamResponse.body) {
        const reader = upstreamResponse.body.getReader();
        const msgId = `msg_${Date.now()}`;
        const result = await handleMessagesStream(reader, res, msgId, model, promptTokens, targetFormat);
        capturedSse = result.capturedSse;
        extractedContent = result.content;
        extractedReasoning = result.reasoning;
        extractedToolCalls = result.toolCalls;
      }
      res.end();

      completeExchange(record.id, {
        responseStatus: upstreamResponse.ok ? "success" : "error",
        responseBody: {
          stream: true,
          content: extractedContent,
          output_text: extractedContent,
          ...(extractedReasoning ? { reasoning: extractedReasoning } : {}),
          ...(extractedToolCalls.length > 0 ? { toolCalls: extractedToolCalls } : {}),
          rawSse: capturedSse,
        },
        upstreamUrl, upstreamStatusCode: upstreamResponse.status, durationMs: Date.now() - startedAt,
        errorMessage: upstreamResponse.ok ? undefined : `upstream returned ${upstreamResponse.status}`,
      });
      return;
    }

    const text = await upstreamResponse.text();
    const upstreamParsed = tryParseJson(text);
    let responseToClient: unknown = upstreamParsed;
    let translatedResponse: Record<string, unknown> | undefined;

    if (needsOpenAITranslation && upstreamResponse.ok && typeof upstreamParsed === "object" && upstreamParsed !== null) {
      const parsed = upstreamParsed as Record<string, unknown>;
      // Some providers (e.g. MiniMax) accept OpenAI-format requests but return Anthropic-format responses.
      // Detect by presence of top-level "type":"message" + "content" array — skip translation if already Anthropic.
      if (parsed.type === "message" && Array.isArray(parsed.content)) {
        translatedResponse = parsed;
      } else {
        translatedResponse = openaiToAnthropicResponse(parsed, actualModel);
      }
      responseToClient = translatedResponse;
    } else if (needsGeminiTranslation && upstreamResponse.ok && typeof upstreamParsed === "object" && upstreamParsed !== null) {
      translatedResponse = geminiToAnthropicResponse(upstreamParsed as Record<string, unknown>, actualModel);
      responseToClient = translatedResponse;
    }

    completeExchange(record.id, {
      responseStatus: upstreamResponse.ok ? "success" : "error",
      responseBody: upstreamParsed,
      translatedResponseBody: translatedResponse,
      upstreamUrl, upstreamStatusCode: upstreamResponse.status,
      durationMs: Date.now() - startedAt,
      errorMessage: upstreamResponse.ok ? undefined : `upstream returned ${upstreamResponse.status}`,
    });

    const upstreamType = upstreamResponse.headers.get("content-type") ?? "";
    if (upstreamType.includes("application/json") && typeof responseToClient === "object") {
      res.status(upstreamResponse.status).json(responseToClient);
      return;
    }
    res.status(upstreamResponse.status).send(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown upstream error";
    completeExchange(record.id, { responseStatus: "error", errorMessage: message, upstreamUrl, durationMs: Date.now() - startedAt });
    res.status(502).json({ error: { message: "Upstream request failed", type: "api_error", detail: message } });
  }
});
