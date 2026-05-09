import { Router } from "express";
import { upstreamModelSchema, upstreamModelsResponseSchema } from "../router.js";
import {
  getModels,
  setModels,
  addModel,
  deleteModel,
  getProxyConfig,
  getProviderById,
  type ModelRecord,
} from "../state.js";
import { resolveAuthorization } from "../utils/auth.js";
import { resolveUpstreamUrl } from "../utils/url.js";
import { extractResponsePreview } from "../utils/response-preview.js";
import { tryParseJson } from "../utils/json.js";

export const modelsRouter = Router();

modelsRouter.get("/v1/models", async (req, res) => {
  const providerId = typeof req.query.provider === "string" ? req.query.provider : undefined;

  // If a specific provider is requested, proxy to that provider
  if (providerId) {
    const provider = getProviderById(providerId);
    if (!provider) {
      res.status(404).json({ error: { message: `Provider '${providerId}' not found` } });
      return;
    }
    try {
      const modelsUrl = resolveUpstreamUrl(provider.baseUrl, "/v1/models");
      const providerModelHeaders: Record<string, string> = {};
      if (provider.authStyle === "x-api-key") {
        if (provider.apiKey.trim()) providerModelHeaders["x-api-key"] = provider.apiKey.trim();
      } else {
        if (provider.apiKey.trim()) providerModelHeaders["authorization"] = `Bearer ${provider.apiKey.trim()}`;
      }
      const upstreamRes = await fetch(modelsUrl, {
        method: "GET",
        headers: providerModelHeaders,
        signal: AbortSignal.timeout(30_000),
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
      // Fallback to local models
    }
  }

  // Legacy behavior
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
        signal: AbortSignal.timeout(30_000),
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

modelsRouter.get("/proxy/models", (_req, res) => {
  res.json({
    object: "list",
    data: getModels(),
  });
});

modelsRouter.post("/proxy/models", (req, res) => {
  const parsed = upstreamModelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: "Invalid model", detail: parsed.error.issues.map((i) => i.message).join("; ") } });
    return;
  }
  const model: ModelRecord = {
    id: parsed.data.id,
    object: parsed.data.object ?? "model",
    created: parsed.data.created ?? Math.floor(Date.now() / 1000),
    owned_by: parsed.data.owned_by ?? "upstream",
    providerId: typeof (req.body as Record<string, unknown>).providerId === "string" ? String((req.body as Record<string, unknown>).providerId) : undefined,
  };
  const updated = addModel(model);
  res.json({ object: "list", data: updated });
});

modelsRouter.delete("/proxy/models/*", (req, res) => {
  const modelId = (req.params as Record<string, string>)[0];
  const deleted = deleteModel(modelId);
  if (!deleted) {
    res.status(404).json({ error: { message: `Model '${modelId}' not found` } });
    return;
  }
  res.json({ object: "list", data: getModels() });
});

modelsRouter.post("/proxy/models/refresh", async (req, res) => {
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
      signal: AbortSignal.timeout(30_000),
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
        detail: error instanceof Error ? error.message : "unknown upstream error",
      },
    });
  }
});

modelsRouter.post("/proxy/models/:modelId/test", async (req, res) => {
  const modelId = req.params.modelId;
  const models = getModels();
  const model = models.find((m) => m.id === modelId);
  if (!model) {
    res.status(404).json({ error: { message: `Model '${modelId}' not found` } });
    return;
  }
  if (!model.providerId) {
    res.status(400).json({ error: { message: `Model '${modelId}' is not bound to a provider` } });
    return;
  }
  const provider = getProviderById(model.providerId);
  if (!provider || !provider.enabled) {
    res.status(400).json({ error: { message: `Provider for model '${modelId}' is not available` } });
    return;
  }

  let upstreamUrl = "";
  try {
    upstreamUrl = resolveUpstreamUrl(provider.baseUrl, provider.path);
  } catch (error) {
    res.status(400).json({ error: { message: "Invalid provider config", detail: error instanceof Error ? error.message : "invalid upstream url" } });
    return;
  }

  const actualModel = modelId; // use the raw model id
  const body = provider.apiType === "responses"
    ? { model: actualModel, input: "Ping. Reply with pong.", max_output_tokens: 32, stream: false }
    : { model: actualModel, messages: [{ role: "user", content: "Ping. Reply with pong." }], max_tokens: 32, stream: false };

  const testHeaders: Record<string, string> = { "content-type": "application/json" };
  if (provider.authStyle === "x-api-key") {
    if (provider.apiKey.trim()) testHeaders["x-api-key"] = provider.apiKey.trim();
    testHeaders["anthropic-version"] = "2023-06-01";
  } else {
    if (provider.apiKey.trim()) testHeaders["authorization"] = `Bearer ${provider.apiKey.trim()}`;
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
    res.json({ ok: upstreamResponse.ok, apiType: provider.apiType, model: actualModel, upstreamUrl, upstreamStatusCode: upstreamResponse.status, durationMs: Date.now() - startedAt, preview: extractResponsePreview(payload), raw: payload });
  } catch (error) {
    res.status(502).json({ error: { message: "Upstream test failed", detail: error instanceof Error ? error.message : "unknown upstream error" } });
  }
});
