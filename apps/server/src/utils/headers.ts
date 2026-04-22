import type express from "express";
import { resolveAuthorization } from "./auth.js";

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

export const buildForwardHeaders = (
  req: express.Request,
  apiKey: string,
  authStyle: "bearer" | "x-api-key" = "bearer"
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
  if (authStyle === "x-api-key") {
    if (apiKey.trim()) {
      headers["x-api-key"] = apiKey.trim();
      delete headers["authorization"];
    }
    if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";
  } else {
    const auth = resolveAuthorization(req, apiKey);
    if (auth) {
      headers["authorization"] = auth;
    } else {
      delete headers["authorization"];
    }
  }
  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  return headers;
};
