import { Router } from "express";
import { getProxyConfig } from "../state.js";
import { resolveUpstreamUrl } from "../utils/url.js";
import { buildForwardHeaders } from "../utils/headers.js";
import { fetchWithRetry } from "../utils/fetch-retry.js";

export const transparentProxyRouter = Router();

transparentProxyRouter.all("/v1/*", async (req, res) => {
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
        detail: error instanceof Error ? error.message : "invalid upstream url",
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
  const isStreaming = !!(hasBody && req.body && (req.body as Record<string, unknown>).stream === true);

  try {
    const upstreamResponse = isStreaming
      ? await fetch(upstreamUrl, {
          method: req.method,
          headers: forwardHeaders,
          ...(hasBody && req.body ? { body: JSON.stringify(req.body) } : {}),
        })
      : await fetchWithRetry(upstreamUrl, {
          method: req.method,
          headers: forwardHeaders,
          ...(hasBody && req.body ? { body: JSON.stringify(req.body) } : {}),
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
    // If streaming already started, headers/body are flushed — we can't send a
    // JSON error (that throws ERR_HTTP_HEADERS_SENT and masks the real error).
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(502).json({
      error: {
        message: "Upstream request failed",
        type: "api_error",
        detail: error instanceof Error ? error.message : "unknown upstream error",
      },
    });
  }
});
