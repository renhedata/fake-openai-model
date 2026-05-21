import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from "bun:test";
import express from "express";
import type { Server } from "node:http";

// ── Mock state ──────────────────────────────────────────────────────────────

let mockUseLegacy = false;
let mockModelName = "gpt-4o";
let capturedUpstreamBody: unknown = null;

mock.module("../state.js", () => ({
  getProxyConfig: () => ({
    mode: "forward" as const,
    apiType: "chat_completions" as const,
    baseUrl: "", path: "/v1/chat/completions", apiKey: "", modelOverride: "",
  }),
  addExchange: () => ({ id: "test-exchange" }),
  completeExchange: () => {},
}));

mock.module("../utils/provider-resolution.js", () => ({
  resolveProviderForModel: () => {
    if (mockUseLegacy) {
      return { provider: null, actualModel: mockModelName, useLegacy: true };
    }
    return {
      provider: {
        id: "p1", name: "test", providerType: "openai",
        baseUrl: "http://fake-upstream",
        path: "/v1/chat/completions",
        apiKey: "sk-test",
        apiType: "chat_completions" as const,
        format: "openai" as const,
        authStyle: "bearer" as const,
        enabled: true, models: [], createdAt: "2024-01-01T00:00:00Z",
      },
      actualModel: mockModelName,
      useLegacy: false,
    };
  },
  getTestModel: () => "gpt-4o",
}));

mock.module("../utils/auth.js", () => ({
  extractCallerKey: () => null,
  validateCallerKey: () => ({ ok: true }),
}));

mock.module("../utils/prompt.js", () => ({
  extractPromptText: () => ({ captured: "hi", promptTokens: 1 }),
  detectAgentType: () => null,
}));

mock.module("../utils/url.js", () => ({
  resolveUpstreamUrl: () => "http://fake-upstream/v1/chat/completions",
}));

mock.module("../utils/headers.js", () => ({
  buildForwardHeaders: () => ({ "content-type": "application/json" }),
}));

mock.module("../utils/fetch-retry.js", () => ({
  fetchWithRetry: async (_url: string, opts: RequestInit) => {
    capturedUpstreamBody = JSON.parse(opts.body as string);
    return new Response(JSON.stringify({
      id: "chatcmpl_1", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  },
}));

mock.module("../utils/json.js", () => ({
  tryParseJson: (text: string) => { try { return JSON.parse(text); } catch { return text; } },
}));

mock.module("../utils/sse-extractors.js", () => ({
  createOaiSseExtractor: () => ({ feed: () => {}, finish: () => ({ content: "", reasoning: "", toolCalls: [] }) }),
}));

mock.module("../translator/openai-to-claude.js", () => ({
  openaiToClaudeRequest: () => ({ model: "claude", max_tokens: 4096, stream: false, messages: [] }),
}));

mock.module("../translator/claude-to-openai.js", () => ({
  claudeToOpenAIChunk: () => null,
  claudeToOpenAINonStreaming: (parsed: Record<string, unknown>) => parsed,
  createTranslationState: () => ({}),
}));

import { chatCompletionsRouter } from "./chat-completions.js";

// ── Test server ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(chatCompletionsRouter);

let server: Server;
let port: number;

beforeAll(() => {
  server = app.listen(0);
  port = (server.address() as { port: number }).port;
});

afterAll(() => server.close());

beforeEach(() => {
  mockUseLegacy = false;
  mockModelName = "gpt-4o";
  capturedUpstreamBody = null;
});

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Chat Completions — known model", () => {
  it("forwards request upstream and returns response", async () => {
    const { status, json } = await post({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(status).toBe(200);
    const body = json as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");
    expect((body.choices as Array<Record<string, unknown>>)[0].message.content).toBe("hello");
  });

  it("sends the resolved model name upstream", async () => {
    await post({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    const body = capturedUpstreamBody as Record<string, unknown>;
    expect(body.model).toBe("gpt-4o");
  });
});

describe("Chat Completions — unknown model", () => {
  beforeEach(() => { mockUseLegacy = true; mockModelName = "nonexistent-model"; });

  it("returns 404 with error when model is not found", async () => {
    const { status, json } = await post({
      model: "nonexistent-model",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(status).toBe(404);
    const body = json as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).message).toContain("not found");
  });
});
