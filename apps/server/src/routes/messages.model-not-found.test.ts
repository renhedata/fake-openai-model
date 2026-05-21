import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import express from "express";
import type { Server } from "node:http";

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
  resolveProviderForModel: () => ({ provider: null, actualModel: "nonexistent", useLegacy: true }),
}));

mock.module("../utils/auth.js", () => ({
  extractCallerKey: () => null,
  validateCallerKey: () => ({ ok: true }),
}));

mock.module("../utils/fetch-retry.js", () => ({
  fetchWithRetry: () => new Response("", { status: 502 }),
}));

import { messagesRouter } from "./messages.js";

const app = express();
app.use(express.json());
app.use(messagesRouter);

let server: Server;
let port: number;

beforeAll(() => {
  server = app.listen(0);
  port = (server.address() as { port: number }).port;
});

afterAll(() => server.close());

describe("Messages API — unknown model", () => {
  it("returns 404 with error when model is not found", async () => {
    const res = await fetch(`http://localhost:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "nonexistent", messages: [{ role: "user", content: "hi" }], max_tokens: 128 }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.message).toContain("not found");
  });
});
