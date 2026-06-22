import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from "bun:test";
import express from "express";
import type { Server } from "node:http";

// ── Mutable mock state (read by mock factories below) ─────────────────────

const mockProvider = {
  id: "p1", name: "test", providerType: "openai",
  baseUrl: "http://fake-upstream",
  path: "/v1/chat/completions",
  apiKey: "sk-test",
  apiType: "chat_completions" as const,
  format: "openai" as "openai" | "claude",
  authStyle: "bearer" as const,
  enabled: true, models: [], createdAt: "2024-01-01T00:00:00Z",
};

let capturedUpstreamUrl = "";
let capturedUpstreamBody: unknown = null;
let mockNonStreamResponse: Response | null = null;
let mockStreamResponse: Response | null = null;

// ── Module mocks (hoisted before imports) ─────────────────────────────────

mock.module("../state.js", () => ({
  getProxyConfig: () => ({
    mode: "forward" as const,
    apiType: "messages" as const,
    baseUrl: "", path: "/v1/messages", apiKey: "", modelOverride: "",
  }),
  addExchange: () => ({ id: "test-exchange" }),
  completeExchange: () => {},
}));

mock.module("../utils/provider-resolution.js", () => ({
  resolveProviderForModel: () => ({ provider: mockProvider, actualModel: "gpt-4", useLegacy: false }),
}));

mock.module("../utils/auth.js", () => ({
  extractCallerKey: () => null,
  validateCallerKey: () => ({ ok: true }),
}));

mock.module("../utils/fetch-retry.js", () => ({
  fetchWithRetry: async (url: string, opts: RequestInit) => {
    capturedUpstreamUrl = url;
    capturedUpstreamBody = JSON.parse(opts.body as string);
    return mockNonStreamResponse!;
  },
}));

import { messagesRouter } from "./messages.js";

// ── Test server ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(messagesRouter);

let server: Server;
let port: number;
const origFetch = globalThis.fetch;

beforeAll(() => {
  server = app.listen(0);
  port = (server.address() as { port: number }).port;
});

afterAll(() => server.close());

beforeEach(() => {
  capturedUpstreamUrl = "";
  capturedUpstreamBody = null;
  mockNonStreamResponse = null;
  mockStreamResponse = null;
  mockProvider.format = "openai";
  mockProvider.path = "/v1/chat/completions";
  mockProvider.authStyle = "bearer";

  // Intercept only upstream calls; pass local test-server calls through.
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes("fake-upstream")) {
      capturedUpstreamUrl = url;
      capturedUpstreamBody = JSON.parse((init?.body as string) ?? "{}");
      return mockStreamResponse ?? new Response("", { status: 502 });
    }
    return origFetch(input, init);
  };
});

afterEach(() => { globalThis.fetch = origFetch; });

// ── Helpers ────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

function sseResponse(lines: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const line of lines) ctrl.enqueue(encoder.encode(line));
      ctrl.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

function parseSseEvents(text: string): Array<{ event?: string; data: unknown }> {
  const events: Array<{ event?: string; data: unknown }> = [];
  for (const block of text.split("\n\n").filter(Boolean)) {
    let event: string | undefined;
    let data: unknown;
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        const raw = line.slice(5).trim();
        try { data = JSON.parse(raw); } catch { data = raw; }
      }
    }
    if (data !== undefined) events.push({ event, data });
  }
  return events;
}

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://localhost:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function postStream(body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://localhost:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

// ── Non-streaming: OAI provider ────────────────────────────────────────────

describe("Non-streaming OAI provider — request forwarding", () => {
  it("translates Anthropic request to OpenAI format before sending upstream", async () => {
    mockNonStreamResponse = jsonResponse({
      id: "chatcmpl_1", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });

    await post({
      model: "claude-3",
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 1024,
    });

    const body = capturedUpstreamBody as Record<string, unknown>;
    expect(body.model).toBe("gpt-4");
    const msgs = body.messages as Array<Record<string, unknown>>;
    // system string → OpenAI system message
    expect(msgs.some((m) => m.role === "system")).toBe(true);
    // user message preserved
    expect(msgs.some((m) => m.role === "user")).toBe(true);
    // Anthropic-only top-level keys not forwarded
    expect(body.system).toBeUndefined();
  });

  it("translates OpenAI response back to Anthropic format", async () => {
    mockNonStreamResponse = jsonResponse({
      id: "chatcmpl_1", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const { json } = await post({ model: "claude-3", messages: [{ role: "user", content: "hi" }], max_tokens: 1024 });
    const b = json as Record<string, unknown>;

    expect(b.type).toBe("message");
    expect(b.role).toBe("assistant");
    const content = b.content as Array<{ type: string; text: string }>;
    expect(content[0]).toMatchObject({ type: "text", text: "hello" });
    expect(b.stop_reason).toBe("end_turn");
    expect((b.usage as Record<string, number>).input_tokens).toBe(10);
    expect((b.usage as Record<string, number>).output_tokens).toBe(5);
  });

  it("translates tool_calls response to Anthropic tool_use blocks", async () => {
    mockNonStreamResponse = jsonResponse({
      id: "chatcmpl_1", object: "chat.completion",
      choices: [{
        index: 0,
        message: {
          role: "assistant", content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const { json } = await post({ model: "claude-3", messages: [{ role: "user", content: "run ls" }], max_tokens: 1024 });
    const b = json as Record<string, unknown>;
    const content = b.content as Array<Record<string, unknown>>;
    const toolUse = content.find((c) => c.type === "tool_use");

    expect(toolUse?.name).toBe("bash");
    expect(toolUse?.id).toBe("call_1");
    expect(toolUse?.input).toEqual({ cmd: "ls" });
    expect(b.stop_reason).toBe("tool_use");
  });
});

// ── Streaming: OAI provider ────────────────────────────────────────────────

describe("Streaming OAI provider — SSE translation", () => {
  it("forwards request upstream in OpenAI format with stream:true", async () => {
    mockStreamResponse = sseResponse([
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    await postStream({ model: "claude-3", system: "Be concise.", messages: [{ role: "user", content: "hi" }], max_tokens: 512, stream: true });

    const body = capturedUpstreamBody as Record<string, unknown>;
    expect(body.model).toBe("gpt-4");
    expect(body.stream).toBe(true);
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs.some((m) => m.role === "system")).toBe(true);
    expect(msgs.some((m) => m.role === "user")).toBe(true);
  });

  it("translates OAI text SSE chunks to Anthropic SSE events", async () => {
    mockStreamResponse = sseResponse([
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    const { text } = await postStream({ model: "claude-3", messages: [{ role: "user", content: "hi" }], max_tokens: 512, stream: true });
    const events = parseSseEvents(text);

    expect(events.some((e) => (e.data as Record<string, unknown>)?.type === "message_start")).toBe(true);

    const textDelta = events.find((e) => {
      const d = e.data as Record<string, unknown>;
      return d?.type === "content_block_delta" && (d.delta as Record<string, unknown>)?.type === "text_delta";
    });
    expect(textDelta).toBeDefined();
    expect(((textDelta!.data as Record<string, unknown>).delta as Record<string, unknown>).text).toBe("hello");
    expect(events.some((e) => (e.data as Record<string, unknown>)?.type === "message_stop")).toBe(true);
  });

  it("tool name is NOT duplicated — regression test for bashbash bug", async () => {
    mockStreamResponse = sseResponse([
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
      // First tool delta: carries name "bash"
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "bash", arguments: "" } }] }, finish_reason: null }] })}\n\n`,
      // Subsequent delta: carries only arguments
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    const { text } = await postStream({ model: "claude-3", messages: [{ role: "user", content: "run ls" }], max_tokens: 1024, stream: true });
    const events = parseSseEvents(text);

    const toolStart = events.find((e) => {
      const d = e.data as Record<string, unknown>;
      return d?.type === "content_block_start" && (d.content_block as Record<string, unknown>)?.type === "tool_use";
    });
    expect(toolStart).toBeDefined();
    const cb = (toolStart!.data as Record<string, unknown>).content_block as Record<string, unknown>;
    expect(cb.name).toBe("bash"); // must NOT be "bashbash"
    expect(cb.id).toBe("call_abc");
  });

  it("finish_reason tool_calls translates to stop_reason tool_use in message_delta", async () => {
    mockStreamResponse = sseResponse([
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp/x"}' } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    const { text } = await postStream({ model: "claude-3", messages: [{ role: "user", content: "read file" }], max_tokens: 512, stream: true });
    const events = parseSseEvents(text);

    const msgDelta = events.find((e) => (e.data as Record<string, unknown>)?.type === "message_delta");
    expect(msgDelta).toBeDefined();
    const delta = (msgDelta!.data as Record<string, unknown>).delta as Record<string, unknown>;
    expect(delta.stop_reason).toBe("tool_use");
  });
});

// ── Passthrough: Claude format provider ────────────────────────────────────

describe("Passthrough — Claude format provider", () => {
  beforeEach(() => {
    mockProvider.format = "claude";
    mockProvider.path = "/v1/messages";
    mockProvider.authStyle = "x-api-key";
  });

  it("forwards Anthropic SSE content to the client unchanged", async () => {
    mockStreamResponse = sseResponse([
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "claude-3", stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello from claude" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ]);

    const { text } = await postStream({ model: "claude-3", messages: [{ role: "user", content: "hi" }], max_tokens: 512, stream: true });

    expect(text).toContain('"type":"message_start"');
    expect(text).toContain('"text":"hello from claude"');
    expect(text).toContain('"type":"content_block_stop"');
    expect(text).toContain('"type":"message_stop"');
  });
});

// ── Streaming error handling ─────────────────────────────────────────────────

describe("Streaming — upstream error after headers sent", () => {
  // First chunk succeeds (flushing headers), then the upstream stream errors.
  function erroringSseResponse(firstChunk: string, status = 200): Response {
    const encoder = new TextEncoder();
    let sentFirst = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (!sentFirst) {
          sentFirst = true;
          ctrl.enqueue(encoder.encode(firstChunk));
          return;
        }
        throw new Error("upstream connection reset");
      },
    });
    return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
  }

  it("ends the stream cleanly instead of crashing with ERR_HTTP_HEADERS_SENT", async () => {
    mockStreamResponse = erroringSseResponse(
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] })}\n\n`,
    );

    const { status, text } = await postStream({
      model: "claude-3",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 512,
      stream: true,
    });

    // Headers were already flushed by the stream, so the catch must NOT try to
    // send a 502 JSON body (that throws ERR_HTTP_HEADERS_SENT). It ends the
    // stream, leaving the original upstream 200 status and partial body intact.
    expect(status).toBe(200);
    expect(text).toContain('"type":"message_start"');
  });
});
