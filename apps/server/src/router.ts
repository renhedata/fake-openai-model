import { z } from "zod";

export const proxyConfigSchema = z.object({
  mode: z.literal("forward"),
  apiType: z.enum(["chat_completions", "responses"]),
  baseUrl: z.string(),
  path: z.string(),
  apiKey: z.string(),
  modelOverride: z.string()
});

export const providerSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  name: z.string().min(1),
  providerType: z.string().default("custom"),
  baseUrl: z.string().min(1),
  apiKey: z.string(),
  // path removed: baseUrl should be the full endpoint URL
  apiType: z.enum(["chat_completions", "messages", "responses"]).default("chat_completions"),
  // format is derived from apiType: messages → claude, otherwise → openai
  format: z.enum(["openai", "claude", "gemini", "ollama"]).default("openai"),
  authStyle: z.enum(["bearer", "x-api-key"]).default("bearer"),
  enabled: z.boolean().default(true),
  models: z.array(z.string()).default([]),
  defaultMaxTokens: z.number().int().positive().optional()
});

export const apiKeyCreateSchema = z.object({
  name: z.string().min(1),
  allowedModels: z.array(z.string()).nullable().optional()
});

export const upstreamModelSchema = z
  .object({
    id: z.string().min(1),
    object: z.string().optional(),
    created: z.number().optional(),
    owned_by: z.string().optional()
  })
  .passthrough();

export const upstreamModelsResponseSchema = z
  .object({
    object: z.string().optional(),
    data: z.array(upstreamModelSchema)
  })
  .passthrough();

export const generateApiKey = () => {
  const prefix = "fm_";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = prefix;
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

export const generateProviderId = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "provider";

