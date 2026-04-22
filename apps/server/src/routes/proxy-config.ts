import { Router } from "express";
import { proxyConfigSchema } from "../router.js";
import { getProxyConfig, setProxyConfig } from "../state.js";
import { resolveAuthorization } from "../utils/auth.js";
import { resolveUpstreamUrl } from "../utils/url.js";
import { getTestModel } from "../utils/provider-resolution.js";
import { extractResponsePreview } from "../utils/response-preview.js";
import { tryParseJson } from "../utils/json.js";

export const proxyConfigRouter = Router();

proxyConfigRouter.get("/", (_req, res) => {
  res.json(getProxyConfig());
});

proxyConfigRouter.put("/", (req, res) => {
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

proxyConfigRouter.post("/test", async (req, res) => {
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
      signal: AbortSignal.timeout(30_000),
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
        detail: error instanceof Error ? error.message : "unknown upstream error",
      },
    });
  }
});
