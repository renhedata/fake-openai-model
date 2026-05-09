import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import type { ModelRecord } from "../state.js";

// Hoisted by bun:test — applied before any module import resolves
const mockModels: ModelRecord[] = [];

mock.module("../state.js", () => ({
  getModels: () => [...mockModels],
  addModel: (item: ModelRecord) => {
    mockModels.push(item);
    return [...mockModels];
  },
  deleteModel: (id: string): boolean => {
    const idx = mockModels.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    mockModels.splice(idx, 1);
    return true;
  },
  setModels: (items: ModelRecord[]) => {
    mockModels.splice(0, mockModels.length, ...items);
    return [...mockModels];
  },
  getProxyConfig: () => ({
    mode: "forward" as const,
    baseUrl: "",
    apiKey: "",
    modelOverride: "",
    path: "/v1/chat/completions",
    apiType: "chat_completions" as const,
  }),
  getProviderById: () => undefined,
  getApiKeys: () => [],
}));

mock.module("../utils/auth.js", () => ({
  resolveAuthorization: () => null,
}));

import { modelsRouter } from "./models.js";

const app = express();
app.use(express.json());
app.use(modelsRouter);

let server: Server;
let port: number;

beforeAll(() => {
  server = app.listen(0);
  port = (server.address() as { port: number }).port;
});

afterAll(() => server.close());

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("GET /proxy/models", () => {
  beforeEach(() => {
    mockModels.splice(0, mockModels.length, {
      id: "gpt-4",
      object: "model",
      created: 1000,
      owned_by: "upstream",
    });
  });

  it("returns the model list", async () => {
    const { status, body } = await req("GET", "/proxy/models");
    expect(status).toBe(200);
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some((m: ModelRecord) => m.id === "gpt-4")).toBe(true);
  });
});

describe("POST /proxy/models", () => {
  beforeEach(() => {
    mockModels.splice(0, mockModels.length);
  });

  it("adds a model and returns updated list", async () => {
    const { status, body } = await req("POST", "/proxy/models", { id: "new-model" });
    expect(status).toBe(200);
    expect(body.object).toBe("list");
    expect(body.data.some((m: ModelRecord) => m.id === "new-model")).toBe(true);
  });

  it("rejects a model without an id", async () => {
    const { status } = await req("POST", "/proxy/models", { object: "model" });
    expect(status).toBe(400);
  });
});

describe("DELETE /proxy/models/*", () => {
  beforeEach(() => {
    mockModels.splice(
      0,
      mockModels.length,
      { id: "gpt-4", object: "model", created: 1000, owned_by: "upstream" },
      { id: "anthropic/claude-3-5-sonnet", object: "model", created: 1000, owned_by: "anthropic" },
    );
  });

  it("deletes a simple model ID", async () => {
    const { status, body } = await req("DELETE", "/proxy/models/gpt-4");
    expect(status).toBe(200);
    expect(body.object).toBe("list");
    expect(body.data.every((m: ModelRecord) => m.id !== "gpt-4")).toBe(true);
  });

  it("deletes a slash-containing model ID", async () => {
    const { status, body } = await req("DELETE", "/proxy/models/anthropic/claude-3-5-sonnet");
    expect(status).toBe(200);
    expect(body.object).toBe("list");
    expect(body.data.every((m: ModelRecord) => m.id !== "anthropic/claude-3-5-sonnet")).toBe(true);
  });

  it("returns 404 for an unknown model ID", async () => {
    const { status } = await req("DELETE", "/proxy/models/does-not-exist");
    expect(status).toBe(404);
  });
});
