import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./router.js";
import {
  createFakeCompletion,
  createFakeStreamText,
  proxyConfigSchema,
  upstreamModelsResponseSchema,
} from "./router.js";
import {
  addExchange,
  completeExchange,
  deleteExchanges,
  deleteAllExchanges,
  getDashboardMeta,
  getDashboardState,
  getExchangesPaginated,
  getModels,
  getProxyConfig,
  setModels,
  setProxyConfig,
  subscribeExchangeUpdated,
} from "./state.js";

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// --- Serve static web assets (production only) ---
const webDistPath = resolve(import.meta.dirname ?? __dirname, "../../web/dist");
const serveStatic = process.env.NODE_ENV !== "development" && existsSync(webDistPath);
if (serveStatic) {
  app.use(express.static(webDistPath, { index: false }));
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/exchanges", (req, res) => {
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const dateFrom = typeof req.query.dateFrom === "string" ? req.query.dateFrom : undefined;
  const dateTo = typeof req.query.dateTo === "string" ? req.query.dateTo : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  const result = getExchangesPaginated({ cursor, limit, dateFrom, dateTo, status, search });
  res.json(result);
});

app.delete("/exchanges", (req, res) => {
  const body = req.body as { ids?: string[]; all?: boolean } | undefined;
  if (body?.all) {
    deleteAllExchanges();
    res.json({ ok: true, deleted: "all" });
    return;
  }
  if (Array.isArray(body?.ids) && body.ids.length > 0) {
    const ids = body.ids.filter((id): id is string => typeof id === "string");
    const count = deleteExchanges(ids);
    res.json({ ok: true, deleted: count });
    return;
  }
  res.status(400).json({ error: { message: "Provide ids array or all: true" } });
});

app.get("/v1/models", async (req, res) => {
  const config = getProxyConfig();
  if (config.mode === "forward" && config.baseUrl.trim()) {
    try {
      const modelsUrl = resolveUpstreamUrl(config.baseUrl, "/v1/models");
      const authorization = resolveAuthorization(req, config.apiKey);
      const upstreamRes = await fetch(modelsUrl, {
        method: "GET",
        headers: {
          ...(authorization ? { authorization } : {}),
        },
      });
      const text = await upstreamRes.text();
      const contentType = upstreamRes.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        res.status(upstreamRes.status).json(JSON.parse(text));
      } else {
        res.status(upstreamRes.status).type(contentType || "text/plain").send(text);
      }
      return;
    } catch {
      // Fallback to local models on network error
    }
  }
  const models = getModels();
  res.json({
    object: "list",
    data: models,
  });
});

app.post("/dev/seed", (req, res) => {
  const count = Math.min(Number((req.query.count as string) ?? "80"), 500);
  const models = ["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet", "claude-3-haiku", "gemini-1.5-pro", "fake-gpt-4o-mini"];
  const prompts = [
    "帮我写一个 Python 冒泡排序",
    "解释一下什么是 Transformer 架构",
    "用 TypeScript 实现一个防抖函数",
    "写一首关于秋天的七言绝句",
    "What is the difference between REST and GraphQL?",
    "Summarize the key principles of clean code",
    "帮我优化这段 SQL 查询：SELECT * FROM orders WHERE status = 'pending'",
    "解释 React 的 useEffect 和 useLayoutEffect 的区别",
    "写一个 Rust 的链表实现",
    "如何设计一个高并发的消息队列系统？",
    "Explain the CAP theorem with examples",
    "帮我写一个正则表达式匹配中国手机号",
    "What are the SOLID principles in OOP?",
    "给我出 5 道关于二叉树的算法题",
    "帮我写一个 Docker Compose 配置：包含 nginx + postgres + redis",
  ];
  const responses = [
    "这是一个假的模型响应，用于测试界面显示效果。",
    "以下是示例回答内容，实际响应会包含更多信息。",
    "测试数据：此响应由 /dev/seed 端点自动生成，模拟真实 API 响应格式。",
    "Here is a sample response for testing purposes. The actual model would provide a more detailed answer.",
    "```python\ndef bubble_sort(arr):\n    n = len(arr)\n    for i in range(n):\n        for j in range(0, n-i-1):\n            if arr[j] > arr[j+1]:\n                arr[j], arr[j+1] = arr[j+1], arr[j]\n    return arr\n```",
  ];

  const statuses: Array<"success" | "error"> = ["success", "success", "success", "success", "error"];
  let inserted = 0;

  for (let i = 0; i < count; i++) {
    const model = models[Math.floor(Math.random() * models.length)];
    const prompt = prompts[Math.floor(Math.random() * prompts.length)];
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    const promptTokens = Math.floor(Math.random() * 800) + 50;
    const completionTokens = Math.floor(Math.random() * 1200) + 100;
    const durationMs = Math.floor(Math.random() * 4000) + 200;
    const response = responses[Math.floor(Math.random() * responses.length)];

    const record = addExchange({
      mode: Math.random() > 0.5 ? "capture_only" : "forward",
      model,
      prompt,
      promptTokens,
      requestBody: {
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 2048,
      },
    });

    completeExchange(record.id, {
      responseStatus: status,
      responseBody: status === "success" ? {
        id: `chatcmpl-seed-${i}`,
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content: response }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      } : undefined,
      errorMessage: status === "error" ? "upstream timeout: connection refused" : undefined,
      upstreamStatusCode: status === "success" ? 200 : 503,
      durationMs,
    });
    inserted++;
  }

  res.json({ ok: true, inserted });
});

app.get("/events/prompts", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // Send lightweight meta (no items) on initial snapshot
  send({ type: "snapshot", meta: getDashboardMeta() });

  const unsubscribe = subscribeExchangeUpdated((latest, meta) => {
    send({ type: "update", latest, meta });
  });

  req.on("close", () => {
    unsubscribe();
    res.end();
  });
});

app.get("/proxy/config", (_req, res) => {
  res.json(getProxyConfig());
});

app.put("/proxy/config", (req, res) => {
  const current = getProxyConfig();
  const merged = { ...current, ...(req.body as Record<string, unknown>) };
  const parsed = proxyConfigSchema.safeParse(merged);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: "Invalid proxy config",
        type: "invalid_request_error",
        detail: parsed.error.issues.map((issue) => issue.message).join("; "),
      },
    });
    return;
  }

  const sanitized = {
    ...parsed.data,
    baseUrl: parsed.data.baseUrl.trim(),
    path: parsed.data.path.trim(),
    apiKey: parsed.data.apiKey.trim(),
    modelOverride: parsed.data.modelOverride.trim(),
  };
  res.json(setProxyConfig(sanitized));
});

app.get("/proxy/models", (_req, res) => {
  res.json({
    object: "list",
    data: getModels(),
  });
});

const getTestModel = () => {
  const config = getProxyConfig();
  if (config.modelOverride.trim()) {
    return config.modelOverride.trim();
  }
  const first = getModels()[0];
  return first?.id ?? "gpt-4o-mini";
};

const extractResponsePreview = (payload: unknown) => {
  if (typeof payload === "string") {
    return payload.slice(0, 300);
  }
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as {
    output_text?: string;
    choices?: Array<{ message?: { content?: string }; text?: string }>;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    error?: { message?: string };
  };
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.slice(0, 300);
  }
  const choiceContent = record.choices?.[0]?.message?.content;
  if (typeof choiceContent === "string" && choiceContent.trim()) {
    return choiceContent.slice(0, 300);
  }
  const choiceText = record.choices?.[0]?.text;
  if (typeof choiceText === "string" && choiceText.trim()) {
    return choiceText.slice(0, 300);
  }
  const outputText = record.output?.[0]?.content?.[0]?.text;
  if (typeof outputText === "string" && outputText.trim()) {
    return outputText.slice(0, 300);
  }
  const errorText = record.error?.message;
  if (typeof errorText === "string" && errorText.trim()) {
    return errorText.slice(0, 300);
  }
  return JSON.stringify(payload).slice(0, 300);
};

const resolveAuthorization = (req: express.Request, apiKey: string) => {
  if (apiKey.trim()) {
    return `Bearer ${apiKey.trim()}`;
  }
  const incoming = req.header("authorization");
  return typeof incoming === "string" ? incoming : "";
};

const resolveUpstreamUrl = (baseUrl: string, path: string) => {
  const trimmedBase = baseUrl.trim();
  const trimmedPath = path.trim();

  if (trimmedPath.startsWith("http://") || trimmedPath.startsWith("https://")) {
    return trimmedPath;
  }
  if (!trimmedBase) {
    throw new Error("Missing upstream baseUrl");
  }
  return new URL(trimmedPath || "/v1/chat/completions", trimmedBase).toString();
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const buildForwardHeaders = (
  req: express.Request,
  apiKey: string
): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value === "string") {
      headers[key] = value;
    } else if (Array.isArray(value)) {
      headers[key] = value.join(", ");
    }
  }
  const auth = resolveAuthorization(req, apiKey);
  if (auth) {
    headers["authorization"] = auth;
  } else {
    delete headers["authorization"];
  }
  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  return headers;
};

app.post("/proxy/models/refresh", async (req, res) => {
  const config = getProxyConfig();
  const authorization = resolveAuthorization(req, config.apiKey);

  let modelsUrl = "";
  try {
    modelsUrl = resolveUpstreamUrl(config.baseUrl, "/v1/models");
  } catch (error) {
    res.status(400).json({
      error: {
        message: "Invalid upstream baseUrl",
        type: "invalid_request_error",
        detail: error instanceof Error ? error.message : "baseUrl is invalid",
      },
    });
    return;
  }

  try {
    const upstreamResponse = await fetch(modelsUrl, {
      method: "GET",
      headers: {
        ...(authorization ? { authorization } : {}),
      },
    });
    const text = await upstreamResponse.text();
    const payload = tryParseJson(text);

    if (!upstreamResponse.ok) {
      res.status(upstreamResponse.status).json({
        error: {
          message: "Failed to fetch upstream models",
          type: "api_error",
          detail: typeof payload === "string" ? payload : payload,
        },
      });
      return;
    }

    const parsed = upstreamModelsResponseSchema.safeParse(payload);
    if (!parsed.success) {
      res.status(502).json({
        error: {
          message: "Invalid upstream models response",
          type: "api_error",
          detail: parsed.error.issues.map((issue) => issue.message).join("; "),
        },
      });
      return;
    }

    const syncedModels = setModels(
      parsed.data.data.map((item) => ({
        id: item.id,
        object: item.object ?? "model",
        created: item.created ?? Math.floor(Date.now() / 1000),
        owned_by: item.owned_by ?? "upstream",
      }))
    );

    res.json({
      object: "list",
      data: syncedModels,
    });
  } catch (error) {
    res.status(502).json({
      error: {
        message: "Failed to fetch upstream models",
        type: "api_error",
        detail:
          error instanceof Error ? error.message : "unknown upstream error",
      },
    });
  }
});

app.post("/proxy/test", async (req, res) => {
  const config = getProxyConfig();
  const authorization = resolveAuthorization(req, config.apiKey);
  const model = getTestModel();

  let upstreamUrl = "";
  try {
    upstreamUrl = resolveUpstreamUrl(config.baseUrl, config.path);
  } catch (error) {
    res.status(400).json({
      error: {
        message: "Invalid upstream config",
        type: "invalid_request_error",
        detail: error instanceof Error ? error.message : "invalid upstream url",
      },
    });
    return;
  }

  const body =
    config.apiType === "responses"
      ? {
          model,
          input: "Ping. Reply with pong.",
          max_output_tokens: 32,
          stream: false,
        }
      : {
          model,
          messages: [{ role: "user", content: "Ping. Reply with pong." }],
          max_tokens: 32,
          stream: false,
        };

  const startedAt = Date.now();

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await upstreamResponse.text();
    const payload = tryParseJson(text);
    const durationMs = Date.now() - startedAt;

    res.json({
      ok: upstreamResponse.ok,
      apiType: config.apiType,
      model,
      upstreamUrl,
      upstreamStatusCode: upstreamResponse.status,
      durationMs,
      preview: extractResponsePreview(payload),
      raw: payload,
    });
  } catch (error) {
    res.status(502).json({
      error: {
        message: "Upstream test failed",
        type: "api_error",
        detail:
          error instanceof Error ? error.message : "unknown upstream error",
      },
    });
  }
});

const tryParseJson = (value: string) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

/** Extract prompt text directly from raw body - no schema needed */
const extractPromptText = (body: Record<string, unknown>): { captured: string; promptTokens: number } => {
  if (!Array.isArray(body.messages)) return { captured: "", promptTokens: 1 };
  const parts: string[] = [];
  for (const m of body.messages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as Record<string, unknown>;
    if (msg.role !== "user" && msg.role !== "system") continue;
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "string") parts.push(part);
        else if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") parts.push(p.text);
          else if (typeof p.input_text === "string") parts.push(p.input_text);
        }
      }
    }
  }
  const captured = parts.join("\n").trim();
  return { captured, promptTokens: Math.max(1, Math.ceil(Math.max(1, captured.length) / 4)) };
};

const extractAssistantContentFromSse = (raw: string): { content: string; reasoning: string } => {
  let content = "";
  let reasoning = "";
  const toolCalls: Array<{
    index: number;
    id?: string;
    type?: string;
    function: { name: string; arguments: string };
  }> = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          message?: { content?: string };
        }>;
      };
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.content && typeof delta.content === "string") {
        // Strip <think>/<\/think> markers (some models send them as content deltas)
        const stripped = delta.content.replace(/<\/?think>/gi, "");
        content += stripped;
      }
      // reasoning_content goes to a separate field, not mixed into content
      const reasoningDelta = (delta as Record<string, unknown> | undefined)?.reasoning_content;
      if (typeof reasoningDelta === "string") {
        reasoning += reasoningDelta;
      }
      // Accumulate tool_calls from streaming deltas
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = {
              index: idx,
              id: tc.id,
              type: tc.type ?? "function",
              function: { name: "", arguments: "" },
            };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
      const messageContent = parsed.choices?.[0]?.message?.content;
      if (typeof messageContent === "string") {
        content += messageContent;
      }
    } catch {
      continue;
    }
  }

  let result = content.trim();
  if (toolCalls.length > 0) {
    const tcSummary = toolCalls
      .filter(Boolean)
      .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
      .join("; ");
    result = result ? `${result}\n\n[Tool Calls] ${tcSummary}` : `[Tool Calls] ${tcSummary}`;
  }
  return { content: result, reasoning: reasoning.trim() };
};

app.post("/v1/chat/completions", async (req, res) => {
  const config = getProxyConfig();
  const body = req.body as Record<string, unknown>;

  // --- Minimal extraction from raw body (no schema validation) ---
  const rawModel = typeof body.model === "string" ? body.model : "unknown";
  const model = config.modelOverride.trim() || rawModel;
  const stream = body.stream === true;
  const { captured, promptTokens } = extractPromptText(body);

  const recordBody = config.modelOverride.trim()
    ? { ...body, model }
    : body;
  const record = addExchange({
    mode: config.mode,
    model,
    prompt: captured,
    promptTokens,
    requestBody: recordBody,
  });

  // --- Capture Only mode: generate fake response ---
  if (config.mode === "capture_only") {
    if (stream) {
      const content = createFakeStreamText(captured);
      const startedAt = Date.now();
      const id = `chatcmpl_${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const chunks = content.match(/.{1,12}/g) ?? [content];

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const write = (payload: unknown) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      write({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      });

      for (const part of chunks) {
        write({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            { index: 0, delta: { content: part }, finish_reason: null },
          ],
        });
      }

      write({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      res.write("data: [DONE]\n\n");
      res.end();

      completeExchange(record.id, {
        responseStatus: "success",
        responseBody: {
          stream: true,
          content,
        },
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const completion = createFakeCompletion(
      { model, messages: [], stream: false },
      promptTokens,
    );
    completeExchange(record.id, {
      responseStatus: "success",
      responseBody: completion,
      durationMs: 0,
    });
    res.json(completion);
    return;
  }

  const startedAt = Date.now();
  let upstreamUrl = "";
  try {
    upstreamUrl = resolveUpstreamUrl(config.baseUrl, config.path);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "invalid upstream config";
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

  // --- Forward mode: send ORIGINAL request body to upstream ---
  const forwardBody: Record<string, unknown> = { ...body };
  if (config.modelOverride.trim()) {
    forwardBody.model = config.modelOverride.trim();
  }

  const forwardHeaders = buildForwardHeaders(req, config.apiKey);

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
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
      // Forward additional upstream headers
      for (const key of ["x-request-id", "openai-organization", "openai-processing-ms", "openai-version"]) {
        const val = upstreamResponse.headers.get(key);
        if (val) res.setHeader(key, val);
      }

      const captureLimit = 24000;
      let capturedSse = "";
      const decoder = new TextDecoder();

      if (upstreamResponse.body) {
        const reader = upstreamResponse.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (!value) {
            continue;
          }
          res.write(Buffer.from(value));
          if (capturedSse.length < captureLimit) {
            const decoded = decoder.decode(value, { stream: true });
            const remaining = captureLimit - capturedSse.length;
            capturedSse += decoded.slice(0, remaining);
          } else {
            decoder.decode(value, { stream: true });
          }
        }
      }

      if (capturedSse.length < captureLimit) {
        const tail = decoder.decode();
        const remaining = captureLimit - capturedSse.length;
        capturedSse += tail.slice(0, remaining);
      }

      res.end();
      const extracted = extractAssistantContentFromSse(capturedSse);
      completeExchange(record.id, {
        responseStatus: upstreamResponse.ok ? "success" : "error",
        responseBody: {
          stream: true,
          assistant: extracted.content,
          ...(extracted.reasoning ? { reasoning: extracted.reasoning } : {}),
          rawSse: capturedSse,
        },
        upstreamUrl,
        upstreamStatusCode: upstreamResponse.status,
        durationMs: Date.now() - startedAt,
        errorMessage: upstreamResponse.ok
          ? undefined
          : `upstream returned ${upstreamResponse.status}`,
      });
      return;
    }

    const text = await upstreamResponse.text();
    const upstreamParsed = tryParseJson(text);

    completeExchange(record.id, {
      responseStatus: upstreamResponse.ok ? "success" : "error",
      responseBody: upstreamParsed,
      upstreamUrl,
      upstreamStatusCode: upstreamResponse.status,
      durationMs: Date.now() - startedAt,
      errorMessage: upstreamResponse.ok
        ? undefined
        : `upstream returned ${upstreamResponse.status}`,
    });

    const upstreamType = upstreamResponse.headers.get("content-type") ?? "";
    if (
      upstreamType.includes("application/json") &&
      typeof upstreamParsed !== "string"
    ) {
      res.status(upstreamResponse.status).json(upstreamParsed);
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

/** Extract prompt text from Anthropic-format request body */
const extractPromptTextAnthropic = (body: Record<string, unknown>): { captured: string; promptTokens: number } => {
  const parts: string[] = [];
  if (typeof body.system === "string" && body.system.trim()) {
    parts.push(body.system.trim());
  }
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || typeof m !== "object") continue;
      const msg = m as Record<string, unknown>;
      if (msg.role !== "user") continue;
      if (typeof msg.content === "string") {
        parts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === "string") parts.push(part);
          else if (part && typeof part === "object") {
            const p = part as Record<string, unknown>;
            if (typeof p.text === "string") parts.push(p.text);
          }
        }
      }
    }
  }
  const captured = parts.join("\n").trim();
  return { captured, promptTokens: Math.max(1, Math.ceil(Math.max(1, captured.length) / 4)) };
};

/** Build forward headers for Anthropic upstream (uses x-api-key instead of Authorization) */
const buildAnthropicForwardHeaders = (req: express.Request, apiKey: string): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value === "string") {
      headers[key] = value;
    } else if (Array.isArray(value)) {
      headers[key] = value.join(", ");
    }
  }
  if (apiKey.trim()) {
    headers["x-api-key"] = apiKey.trim();
    delete headers["authorization"];
  }
  if (!headers["content-type"]) headers["content-type"] = "application/json";
  if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";
  return headers;
};

/** Extract text content from Anthropic SSE stream */
const extractAnthropicSseContent = (raw: string): string => {
  let content = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string } };
      if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta" && typeof parsed.delta.text === "string") {
        content += parsed.delta.text;
      }
    } catch { continue; }
  }
  return content.trim();
};

/** Handle /v1/messages streaming response from upstream.
 * Auto-detects format: translates OpenAI SSE → Anthropic SSE if needed, or passes Anthropic SSE through. */
const handleMessagesStream = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: express.Response,
  msgId: string,
  model: string,
): Promise<{ capturedSse: string; content: string; reasoning: string; format: "oai" | "anthropic" | "unknown" }> => {
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let capturedSse = "";
  const captureLimit = 24000;
  let format: "oai" | "anthropic" | "unknown" = "unknown";
  let oaiContentBlockOpen = false;
  let oaiDone = false;
  let content = "";
  let reasoning = "";

  const writeEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const handleOaiChunk = (data: string) => {
    if (data === "[DONE]") return;
    let parsed: {
      choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>;
      usage?: { completion_tokens?: number };
    };
    try { parsed = JSON.parse(data); } catch { return; }
    const choice = parsed.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      reasoning += delta.reasoning_content;
    }
    if (typeof delta.content === "string") {
      const stripped = delta.content.replace(/<\/?think>/gi, "");
      if (stripped) {
        if (!oaiContentBlockOpen) {
          oaiContentBlockOpen = true;
          writeEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
          writeEvent("ping", { type: "ping" });
        }
        writeEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: stripped } });
        content += stripped;
      }
    }
    if (choice.finish_reason && !oaiDone) {
      oaiDone = true;
      if (!oaiContentBlockOpen) {
        oaiContentBlockOpen = true;
        writeEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      }
      writeEvent("content_block_stop", { type: "content_block_stop", index: 0 });
      const stopReason = choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
      const outputTokens = parsed.usage?.completion_tokens ?? Math.max(1, Math.ceil(content.length / 4));
      writeEvent("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
      writeEvent("message_stop", { type: "message_stop" });
    }
  };

  const processLine = (line: string) => {
    if (capturedSse.length < captureLimit) capturedSse += line + "\n";
    if (format === "anthropic") { res.write(line + "\n"); return; }
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
          writeEvent("message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 1 } } });
          handleOaiChunk(data);
        } else {
          format = "anthropic";
          res.write(line + "\n");
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

  if ((format as "oai" | "anthropic" | "unknown") === "oai" && !oaiDone) {
    if (!oaiContentBlockOpen) {
      oaiContentBlockOpen = true;
      writeEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    }
    writeEvent("content_block_stop", { type: "content_block_stop", index: 0 });
    writeEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: Math.max(1, Math.ceil(content.length / 4)) } });
    writeEvent("message_stop", { type: "message_stop" });
  }

  return { capturedSse, content, reasoning, format };
};

app.post("/v1/messages", async (req, res) => {
  const config = getProxyConfig();
  const body = req.body as Record<string, unknown>;

  const rawModel = typeof body.model === "string" ? body.model : "unknown";
  const model = config.modelOverride.trim() || rawModel;
  const stream = body.stream === true;
  const { captured, promptTokens } = extractPromptTextAnthropic(body);

  const recordBody = config.modelOverride.trim() ? { ...body, model } : body;
  const record = addExchange({ mode: config.mode, model, prompt: captured, promptTokens, requestBody: recordBody });

  if (config.mode === "capture_only") {
    const content = createFakeStreamText(captured);
    const msgId = `msg_${Date.now()}`;
    const inputTokens = promptTokens;
    const outputTokens = Math.max(1, Math.ceil(content.length / 4));

    if (stream) {
      const startedAt = Date.now();
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const writeEvent = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      writeEvent("message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } });
      writeEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      writeEvent("ping", { type: "ping" });

      for (const part of (content.match(/.{1,12}/g) ?? [content])) {
        writeEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } });
      }

      writeEvent("content_block_stop", { type: "content_block_stop", index: 0 });
      writeEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } });
      writeEvent("message_stop", { type: "message_stop" });
      res.end();

      completeExchange(record.id, { responseStatus: "success", responseBody: { stream: true, content, output_text: content }, durationMs: Date.now() - startedAt });
      return;
    }

    const fakeResponse = { id: msgId, type: "message", role: "assistant", content: [{ type: "text", text: content }], model, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
    completeExchange(record.id, { responseStatus: "success", responseBody: fakeResponse, durationMs: 0 });
    res.json(fakeResponse);
    return;
  }

  const startedAt = Date.now();
  let upstreamUrl = "";
  try {
    upstreamUrl = resolveUpstreamUrl(config.baseUrl, "/v1/messages");
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid upstream config";
    completeExchange(record.id, { responseStatus: "error", errorMessage: message, durationMs: Date.now() - startedAt });
    res.status(400).json({ error: { message: "Invalid upstream config", type: "invalid_request_error", detail: message } });
    return;
  }

  const forwardBody: Record<string, unknown> = { ...body };
  if (config.modelOverride.trim()) forwardBody.model = config.modelOverride.trim();

  const forwardHeaders = buildAnthropicForwardHeaders(req, config.apiKey);

  try {
    const upstreamResponse = await fetch(upstreamUrl, { method: "POST", headers: forwardHeaders, body: JSON.stringify(forwardBody) });

    if (stream) {
      res.status(upstreamResponse.status);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      let capturedSse = "";
      let extractedContent = "";
      let extractedReasoning = "";

      if (upstreamResponse.body) {
        const reader = upstreamResponse.body.getReader();
        const msgId = `msg_${Date.now()}`;
        const result = await handleMessagesStream(reader, res, msgId, model);
        capturedSse = result.capturedSse;
        extractedContent = result.format === "oai" ? result.content : extractAnthropicSseContent(capturedSse);
        extractedReasoning = result.reasoning;
      }
      res.end();

      completeExchange(record.id, {
        responseStatus: upstreamResponse.ok ? "success" : "error",
        responseBody: {
          stream: true,
          content: extractedContent,
          output_text: extractedContent,
          ...(extractedReasoning ? { reasoning: extractedReasoning } : {}),
          rawSse: capturedSse,
        },
        upstreamUrl, upstreamStatusCode: upstreamResponse.status, durationMs: Date.now() - startedAt,
        errorMessage: upstreamResponse.ok ? undefined : `upstream returned ${upstreamResponse.status}`,
      });
      return;
    }

    const text = await upstreamResponse.text();
    const upstreamParsed = tryParseJson(text);
    completeExchange(record.id, {
      responseStatus: upstreamResponse.ok ? "success" : "error",
      responseBody: upstreamParsed, upstreamUrl, upstreamStatusCode: upstreamResponse.status,
      durationMs: Date.now() - startedAt,
      errorMessage: upstreamResponse.ok ? undefined : `upstream returned ${upstreamResponse.status}`,
    });
    const upstreamType = upstreamResponse.headers.get("content-type") ?? "";
    if (upstreamType.includes("application/json") && typeof upstreamParsed !== "string") {
      res.status(upstreamResponse.status).json(upstreamParsed);
      return;
    }
    res.status(upstreamResponse.status).send(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown upstream error";
    completeExchange(record.id, { responseStatus: "error", errorMessage: message, upstreamUrl, durationMs: Date.now() - startedAt });
    res.status(502).json({ error: { message: "Upstream request failed", type: "api_error", detail: message } });
  }
});

// --- Transparent proxy for all other /v1/* endpoints in forward mode ---
app.all("/v1/*", async (req, res) => {
  const config = getProxyConfig();
  if (config.mode !== "forward") {
    res.status(501).json({
      error: {
        message:
          "This endpoint is only available in forward mode. Switch to forward mode in settings.",
        type: "invalid_request_error",
      },
    });
    return;
  }

  let upstreamUrl = "";
  try {
    upstreamUrl = resolveUpstreamUrl(config.baseUrl, req.path);
  } catch (error) {
    res.status(400).json({
      error: {
        message: "Invalid upstream config",
        type: "invalid_request_error",
        detail:
          error instanceof Error ? error.message : "invalid upstream url",
      },
    });
    return;
  }

  // Preserve query string from the original request
  const qsIndex = req.originalUrl.indexOf("?");
  if (qsIndex !== -1) {
    upstreamUrl += req.originalUrl.slice(qsIndex);
  }

  const forwardHeaders = buildForwardHeaders(req, config.apiKey);
  const hasBody = !["GET", "HEAD"].includes(req.method);

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers: forwardHeaders,
      ...(hasBody && req.body
        ? { body: JSON.stringify(req.body) }
        : {}),
    });

    res.status(upstreamResponse.status);

    // Forward key response headers
    for (const key of [
      "content-type",
      "x-request-id",
      "openai-organization",
      "openai-processing-ms",
      "openai-version",
      "x-ratelimit-limit-requests",
      "x-ratelimit-remaining-requests",
      "x-ratelimit-limit-tokens",
      "x-ratelimit-remaining-tokens",
    ]) {
      const val = upstreamResponse.headers.get(key);
      if (val) res.setHeader(key, val);
    }

    // Stream response body
    if (upstreamResponse.body) {
      const reader = upstreamResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (error) {
    res.status(502).json({
      error: {
        message: "Upstream request failed",
        type: "api_error",
        detail:
          error instanceof Error ? error.message : "unknown upstream error",
      },
    });
  }
});

app.use(
  "/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext: () => ({}),
  })
);

// --- SPA fallback: serve index.html for any unmatched GET request (production only) ---
if (serveStatic) {
  const indexPath = resolve(webDistPath, "index.html");
  app.get("*", (_req, res) => {
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).json({ error: "Not found" });
    }
  });
}

app.listen(port, () => {
  console.log(`server running on http://localhost:${port}`);
});
