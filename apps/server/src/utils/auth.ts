import type express from "express";
import { getApiKeys } from "../state.js";

/** Build authorization header from explicit apiKey or incoming request. */
export const resolveAuthorization = (req: express.Request, apiKey: string) => {
  if (apiKey.trim()) {
    return `Bearer ${apiKey.trim()}`;
  }
  const incoming = req.header("authorization");
  return typeof incoming === "string" ? incoming : "";
};

/** Extract the caller's API key string from Authorization or x-api-key header. */
export const extractCallerKey = (req: express.Request): string => {
  const auth = req.header("authorization");
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  if (typeof auth === "string") {
    return auth.trim();
  }
  const xApiKey = req.header("x-api-key");
  if (typeof xApiKey === "string") {
    return xApiKey.trim();
  }
  return "";
};

/** Result of validating a caller key. */
export type CallerKeyValidation =
  | { ok: true; apiKeyId?: string; apiKeyName?: string }
  | { ok: false; error: string };

/** Validate caller key. Returns ok if valid, error message if invalid. */
export const validateCallerKey = (callerKey: string, model: string): CallerKeyValidation => {
  const keys = getApiKeys();
  if (keys.length === 0) {
    return { ok: true }; // no keys configured = allow all
  }
  const found = keys.find((k) => k.key === callerKey && k.enabled);
  if (!found) {
    return { ok: false, error: "Invalid API key" };
  }
  if (found.allowedModels && found.allowedModels.length > 0 && !found.allowedModels.includes(model)) {
    return { ok: false, error: `Model '${model}' is not allowed for this API key` };
  }
  return { ok: true, apiKeyId: found.id, apiKeyName: found.name };
};
