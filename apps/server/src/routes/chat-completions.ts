import { Router } from "express";
import { openaiToClaudeRequest } from "../translator/openai-to-claude.js";
import {
  claudeToOpenAIChunk,
  claudeToOpenAINonStreaming,
  createTranslationState,
} from "../translator/claude-to-openai.js";
import {
  addExchange,
  completeExchange,
  getProxyConfig,
} from "../state.js";
import { extractPromptText, detectAgentType } from "../utils/prompt.js";
import { resolveProviderForModel, getTestModel } from "../utils/provider-resolution.js";
import { extractCallerKey, validateCallerKey } from "../utils/auth.js";
import { resolveUpstreamUrl } from "../utils/url.js";
import { buildForwardHeaders } from "../utils/headers.js";
import { createOaiSseExtractor } from "../utils/sse-extractors.js";
import { tryParseJson } from "../utils/json.js";
import { fetchWithRetry } from "../utils/fetch-retry.js";

export const chatCompletionsRouter = Router();

chatCompletionsRouter.post("/v1/chat/completions", async (req, res) => {
  const config = getProxyConfig();
  const body = req.body as Record<string, unknown>;

  // --- Minimal extraction from raw body (no schema validation) ---
  const rawModel = typeof body.model === "string" ? body.model : "unknown";
  const model = config.modelOverride.trim() || rawModel;
  const stream = body.stream === true;
  const { captured, promptTokens } = extractPromptText(body);
  const agentType = detectAgentType(captured);

  // Pre-resolve provider to know if translation is needed for the record
  const preResolve = resolveProviderForModel(model);
  // Translation needed when provider uses Anthropic Messages API format (apiType === "messages")
  // or legacy explicit claude format. User sets this explicitly in the UI.
  const needsTranslation =
    preResolve.provider?.apiType === "messages" ||
    preResolve.provider?.format === "claude";
  let translatedRequest: Record<string, unknown> | undefined;
  if (needsTranslation) {
    translatedRequest = openaiToClaudeRequest(preResolve.actualModel, body, stream, preResolve.provider?.defaultMaxTokens) as unknown as Record<string, unknown>;

  }

  const recordBody = config.modelOverride.trim()
    ? { ...body, model }
    : body;

  // Validate caller key early to capture apiKey info
  const callerKey = extractCallerKey(req);
  const keyValidation = validateCallerKey(callerKey, model);

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

  // --- Validate caller key (if api_keys table has entries) ---
  if (!keyValidation.ok) {
    completeExchange(record.id, {
      responseStatus: "error",
      errorMessage: keyValidation.error,
      durationMs: 0,
    });
    res.status(401).json({
      error: { message: keyValidation.error, type: "authentication_error" },
    });
    return;
  }

  // --- Resolve provider by model, fallback to legacy proxy_config ---
  const { provider, actualModel, useLegacy } = preResolve;
  const targetBaseUrl = provider?.baseUrl ?? config.baseUrl;
  const targetPath = provider?.path ?? config.path;
  const targetApiKey = provider?.apiKey ?? config.apiKey;

  const startedAt = Date.now();
  let upstreamUrl = "";
  try {
    upstreamUrl = resolveUpstreamUrl(targetBaseUrl, targetPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid upstream config";
    completeExchange(record.id, {
      responseStatus: "error",
      errorMessage: message,
      durationMs: Date.now() - startedAt,
    });
    res.status(400).json({
      error: {
        message: "Invalid upstream config",
        type: "invalid_request_error",
        detail: message,
      },
    });
    return;
  }

  // --- Determine if translation is needed ---
  const authStyle = provider?.authStyle ?? "bearer";

  // --- Build request body ---
  let forwardBody: Record<string, unknown>;
  if (needsTranslation) {
    // OpenAI → Claude translation (already computed for the record)
    forwardBody = translatedRequest ?? {};
  } else {
    forwardBody = { ...body };
    if (config.modelOverride.trim()) {
      forwardBody.model = config.modelOverride.trim();
    } else if (provider && actualModel !== model) {
      forwardBody.model = actualModel;
    }

  }

  const forwardHeaders = buildForwardHeaders(req, targetApiKey, authStyle);

  try {
    // Streaming: no timeout — wait indefinitely for upstream SSE
    // Non-streaming: 5-minute timeout with 1 retry
    const upstreamResponse = stream
      ? await fetch(upstreamUrl, {
          method: "POST",
          headers: forwardHeaders,
          body: JSON.stringify(forwardBody),
        })
      : await fetchWithRetry(upstreamUrl, {
          method: "POST",
          headers: forwardHeaders,
          body: JSON.stringify(forwardBody),
        });

    if (stream) {
      const contentType =
        upstreamResponse.headers.get("content-type") ??
        "text/event-stream; charset=utf-8";
      const cacheControl =
        upstreamResponse.headers.get("cache-control") ?? "no-cache";
      res.status(upstreamResponse.status);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", cacheControl);
      res.setHeader("Connection", "keep-alive");
      for (const key of ["x-request-id", "openai-organization", "openai-processing-ms", "openai-version"]) {
        const val = upstreamResponse.headers.get(key);
        if (val) res.setHeader(key, val);
      }

      const RAW_SSE_LIMIT = 32_000;
      let capturedRawSse = "";
      let capturedTranslatedSse = "";
      const decoder = new TextDecoder();

      if (needsTranslation) {
        // Claude SSE → OpenAI SSE translation
        const translateState = createTranslationState(actualModel);
        const toolNameMap = (translatedRequest as { _toolNameMap?: Map<string, string> } | undefined)?._toolNameMap;
        let lineBuffer = "";

        if (upstreamResponse.body) {
          const reader = upstreamResponse.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            const chunk = decoder.decode(value, { stream: true });
            lineBuffer += chunk;
            const lines = lineBuffer.split("\n");
            lineBuffer = lines.pop() ?? "";
            for (const line of lines) {
              if (capturedRawSse.length < RAW_SSE_LIMIT) capturedRawSse += line + "\n";
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const data = trimmed.slice(5).trim();
              if (!data) continue;
              try {
                const parsed = JSON.parse(data) as Record<string, unknown>;
                const translatedChunks = claudeToOpenAIChunk(parsed, translateState, toolNameMap);
                if (translatedChunks) {
                  for (const tc of translatedChunks) {
                    const sseLine = `data: ${JSON.stringify(tc)}\n\n`;
                    res.write(sseLine);
                    if (capturedTranslatedSse.length < RAW_SSE_LIMIT) capturedTranslatedSse += sseLine;
                  }
                }
              } catch {
                // ignore unparseable lines
              }
            }
          }
          if (lineBuffer) {
            const trimmed = lineBuffer.trim();
            if (trimmed.startsWith("data:")) {
              const data = trimmed.slice(5).trim();
              if (data) {
                try {
                  const parsed = JSON.parse(data) as Record<string, unknown>;
                  const translatedChunks = claudeToOpenAIChunk(parsed, translateState, toolNameMap);
                  if (translatedChunks) {
                    for (const tc of translatedChunks) {
                      const sseLine = `data: ${JSON.stringify(tc)}\n\n`;
                      res.write(sseLine);
                      if (capturedTranslatedSse.length < RAW_SSE_LIMIT) capturedTranslatedSse += sseLine;
                    }
                  }
                } catch { /* ignore */ }
              }
            }
          }
        }
        res.write("data: [DONE]\n\n");
        res.end();

        completeExchange(record.id, {
          responseStatus: upstreamResponse.ok ? "success" : "error",
          responseBody: {
            stream: true,
            rawSse: capturedRawSse,
          },
          translatedResponseBody: {
            stream: true,
            translatedSse: capturedTranslatedSse,
          },
          upstreamUrl,
          upstreamStatusCode: upstreamResponse.status,
          durationMs: Date.now() - startedAt,
          errorMessage: upstreamResponse.ok ? undefined : `upstream returned ${upstreamResponse.status}`,
        });
        return;
      }

      // Passthrough streaming: auto-detect upstream format.
      // Some providers return Anthropic SSE even when sent OpenAI requests — translate to OAI SSE if so.
      let lineBuffer2 = "";
      let streamFormat = "unknown";
      const autoTranslateState = createTranslationState(actualModel);
      const oaiExtractor = createOaiSseExtractor();

      const processPassthroughLine = (line: string) => {
        if (capturedRawSse.length < RAW_SSE_LIMIT) capturedRawSse += line + "\n";

        if (streamFormat === "oai") {
          res.write(line + "\n");
          oaiExtractor.feed(line + "\n");
          return;
        }

        if (streamFormat === "anthropic") {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) return;
          const data = trimmed.slice(5).trim();
          if (!data) return;
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            const chunks = claudeToOpenAIChunk(parsed, autoTranslateState);
            if (chunks) {
              for (const tc of chunks) {
                const sseLine = `data: ${JSON.stringify(tc)}\n\n`;
                res.write(sseLine);
                oaiExtractor.feed(sseLine);
              }
            }
          } catch { /* ignore */ }
          return;
        }

        // Format detection on first data line
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) { res.write(line + "\n"); return; }
        const data = trimmed.slice(5).trim();
        if (!data) return;
        if (data === "[DONE]") {
          streamFormat = "oai";
          res.write(line + "\n");
          oaiExtractor.feed(line + "\n");
          return;
        }
        try {
          const peek = JSON.parse(data) as Record<string, unknown>;
          if (peek.object === "chat.completion.chunk" || Array.isArray(peek.choices)) {
            streamFormat = "oai";
            res.write(line + "\n");
            oaiExtractor.feed(line + "\n");
          } else if (typeof peek.type === "string" && (peek.type.startsWith("message") || peek.type.startsWith("content_block"))) {
            streamFormat = "anthropic";
            const chunks = claudeToOpenAIChunk(peek, autoTranslateState);
            if (chunks) {
              for (const tc of chunks) {
                const sseLine = `data: ${JSON.stringify(tc)}\n\n`;
                res.write(sseLine);
                oaiExtractor.feed(sseLine);
              }
            }
          } else {
            streamFormat = "oai";
            res.write(line + "\n");
            oaiExtractor.feed(line + "\n");
          }
        } catch {
          res.write(line + "\n");
        }
      };

      if (upstreamResponse.body) {
        const reader = upstreamResponse.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          lineBuffer2 += decoder.decode(value, { stream: true });
          const lines = lineBuffer2.split("\n");
          lineBuffer2 = lines.pop() ?? "";
          for (const line of lines) processPassthroughLine(line);
        }
        if (lineBuffer2) processPassthroughLine(lineBuffer2);
      }

      if (streamFormat === "anthropic") res.write("data: [DONE]\n\n");
      res.end();

      const extracted = oaiExtractor.finish();
      completeExchange(record.id, {
        responseStatus: upstreamResponse.ok ? "success" : "error",
        responseBody: {
          stream: true,
          assistant: extracted.content,
          ...(extracted.reasoning ? { reasoning: extracted.reasoning } : {}),
          ...(extracted.toolCalls.length > 0 ? { toolCalls: extracted.toolCalls } : {}),
          rawSse: capturedRawSse,
        },
        upstreamUrl,
        upstreamStatusCode: upstreamResponse.status,
        durationMs: Date.now() - startedAt,
        errorMessage: upstreamResponse.ok ? undefined : `upstream returned ${upstreamResponse.status}`,
      });
      return;
    }

    // Non-streaming
    const text = await upstreamResponse.text();
    const upstreamParsed = tryParseJson(text);
    let responseToClient: unknown = upstreamParsed;
    let translatedResponse: Record<string, unknown> | undefined;

    if (typeof upstreamParsed === "object" && upstreamParsed !== null && upstreamResponse.ok) {
      const parsed = upstreamParsed as Record<string, unknown>;
      const toolNameMap = (translatedRequest as { _toolNameMap?: Map<string, string> } | undefined)?._toolNameMap;
      if (needsTranslation) {
        // Explicit claude → OpenAI translation
        translatedResponse = claudeToOpenAINonStreaming(parsed, toolNameMap);
        responseToClient = translatedResponse;
      } else if (parsed.type === "message" && Array.isArray(parsed.content)) {
        // Provider returned Anthropic format despite receiving an OpenAI request (e.g. MiniMax).
        // Translate back so the client gets the OpenAI format it expects.
        translatedResponse = claudeToOpenAINonStreaming(parsed, toolNameMap);
        responseToClient = translatedResponse;
      }
    }

    completeExchange(record.id, {
      responseStatus: upstreamResponse.ok ? "success" : "error",
      responseBody: {
        rawResponse: upstreamParsed,
      },
      translatedResponseBody: translatedResponse,
      upstreamUrl,
      upstreamStatusCode: upstreamResponse.status,
      durationMs: Date.now() - startedAt,
      errorMessage: upstreamResponse.ok ? undefined : `upstream returned ${upstreamResponse.status}`,
    });

    const upstreamType = upstreamResponse.headers.get("content-type") ?? "";
    if (upstreamType.includes("application/json") && typeof responseToClient === "object") {
      res.status(upstreamResponse.status).json(responseToClient);
      return;
    }

    res.status(upstreamResponse.status).send(text);
    return;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown upstream error";
    completeExchange(record.id, {
      responseStatus: "error",
      errorMessage: message,
      upstreamUrl,
      durationMs: Date.now() - startedAt,
    });
    res.status(502).json({
      error: {
        message: "Upstream request failed",
        type: "api_error",
        detail: message,
      },
    });
  }
});
