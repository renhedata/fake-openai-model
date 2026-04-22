import { Router } from "express";
import { providerSchema, generateProviderId, upstreamModelsResponseSchema } from "../router.js";
import { getProviders, getProviderById, setProvider, deleteProvider, setProviderModels, getModels, type Provider } from "../state.js";
import { resolveUpstreamUrl } from "../utils/url.js";
import { extractResponsePreview } from "../utils/response-preview.js";
import { tryParseJson } from "../utils/json.js";

export const providersRouter = Router();

providersRouter.get("/", (_req, res) => {
  res.json({ object: "list", data: getProviders() });
});

providersRouter.post("/", (req, res) => {
  const parsed = providerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: "Invalid provider", detail: parsed.error.issues.map((i) => i.message).join("; ") } });
    return;
  }
  const id = parsed.data.id?.trim() || generateProviderId(parsed.data.name);
  const existing = getProviderById(id);
  if (existing) {
    res.status(409).json({ error: { message: `Provider '${id}' already exists` } });
    return;
  }
  const provider: Provider = {
    ...parsed.data,
    id,
    createdAt: new Date().toISOString()
  };
  setProvider(provider);
  res.status(201).json(provider);
});

providersRouter.put("/:id", (req, res) => {
  const id = req.params.id;
  const existing = getProviderById(id);
  if (!existing) {
    res.status(404).json({ error: { message: `Provider '${id}' not found` } });
    return;
  }
  const merged = { ...existing, ...(req.body as Record<string, unknown>) };
  const parsed = providerSchema.safeParse(merged);
  if (!parsed.success) {
    res.status(400).json({ error: { message: "Invalid provider", detail: parsed.error.issues.map((i) => i.message).join("; ") } });
    return;
  }
  const provider: Provider = { ...parsed.data, id: existing.id, createdAt: existing.createdAt };
  setProvider(provider);
  res.json(provider);
});

providersRouter.delete("/:id", (req, res) => {
  const ok = deleteProvider(req.params.id);
  if (!ok) {
    res.status(404).json({ error: { message: `Provider '${req.params.id}' not found` } });
    return;
  }
  res.json({ ok: true });
});

providersRouter.post("/:id/test", async (req, res) => {
  const provider = getProviderById(req.params.id);
  if (!provider) {
    res.status(404).json({ error: { message: `Provider '${req.params.id}' not found` } });
    return;
  }
  let upstreamUrl = "";
  try {
    upstreamUrl = resolveUpstreamUrl(provider.baseUrl, provider.path);
  } catch (error) {
    res.status(400).json({ error: { message: "Invalid provider config", detail: error instanceof Error ? error.message : "invalid upstream url" } });
    return;
  }
  const model = provider.models?.[0] ?? getModels().find((m) => m.providerId === provider.id)?.id ?? "gpt-4o-mini";
  const body = provider.apiType === "responses"
    ? { model, input: "Ping. Reply with pong.", max_output_tokens: 32, stream: false }
    : { model, messages: [{ role: "user", content: "Ping. Reply with pong." }], max_tokens: 32, stream: false };
  // Build headers respecting provider auth style
  const testHeaders: Record<string, string> = { "content-type": "application/json" };
  if (provider.authStyle === "x-api-key") {
    if (provider.apiKey.trim()) {
      testHeaders["x-api-key"] = provider.apiKey.trim();
    }
    testHeaders["anthropic-version"] = "2023-06-01";
  } else {
    if (provider.apiKey.trim()) {
      testHeaders["authorization"] = `Bearer ${provider.apiKey.trim()}`;
    }
  }
  const startedAt = Date.now();
  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: testHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await upstreamResponse.text();
    const payload = tryParseJson(text);
    res.json({ ok: upstreamResponse.ok, apiType: provider.apiType, model, upstreamUrl, upstreamStatusCode: upstreamResponse.status, durationMs: Date.now() - startedAt, preview: extractResponsePreview(payload), raw: payload });
  } catch (error) {
    res.status(502).json({ error: { message: "Upstream test failed", detail: error instanceof Error ? error.message : "unknown upstream error" } });
  }
});

providersRouter.post("/:id/refresh", async (req, res) => {
  const provider = getProviderById(req.params.id);
  if (!provider) {
    res.status(404).json({ error: { message: `Provider '${req.params.id}' not found` } });
    return;
  }
  let modelsUrl = "";
  try {
    modelsUrl = resolveUpstreamUrl(provider.baseUrl, "/v1/models");
  } catch (error) {
    res.status(400).json({ error: { message: "Invalid provider baseUrl", detail: error instanceof Error ? error.message : "baseUrl is invalid" } });
    return;
  }
  try {
    const refreshHeaders: Record<string, string> = {};
    if (provider.authStyle === "x-api-key") {
      if (provider.apiKey.trim()) refreshHeaders["x-api-key"] = provider.apiKey.trim();
    } else {
      if (provider.apiKey.trim()) refreshHeaders["authorization"] = `Bearer ${provider.apiKey.trim()}`;
    }
    const upstreamResponse = await fetch(modelsUrl, {
      method: "GET",
      headers: refreshHeaders,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await upstreamResponse.text();
    const payload = tryParseJson(text);
    if (!upstreamResponse.ok) {
      res.status(upstreamResponse.status).json({ error: { message: "Failed to fetch upstream models", type: "api_error", detail: typeof payload === "string" ? payload : payload } });
      return;
    }
    const parsed = upstreamModelsResponseSchema.safeParse(payload);
    if (!parsed.success) {
      res.status(502).json({ error: { message: "Invalid upstream models response", type: "api_error", detail: parsed.error.issues.map((i) => i.message).join("; ") } });
      return;
    }
    const modelIds = parsed.data.data.map((item) => item.id);
    setProviderModels(provider.id, modelIds);
    const syncedModels = getModels();
    res.json({ object: "list", data: syncedModels });
  } catch (error) {
    res.status(502).json({ error: { message: "Failed to fetch upstream models", type: "api_error", detail: error instanceof Error ? error.message : "unknown upstream error" } });
  }
});
