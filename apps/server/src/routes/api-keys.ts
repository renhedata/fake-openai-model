import { Router } from "express";
import { apiKeyCreateSchema, generateApiKey } from "../router.js";
import { getApiKeys, createApiKey, deleteApiKey } from "../state.js";

export const apiKeysRouter = Router();

apiKeysRouter.get("/", (_req, res) => {
  res.json({ object: "list", data: getApiKeys() });
});

apiKeysRouter.post("/", (req, res) => {
  const parsed = apiKeyCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: "Invalid api key payload", detail: parsed.error.issues.map((i) => i.message).join("; ") } });
    return;
  }
  const key = createApiKey({ id: `key_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, key: generateApiKey(), name: parsed.data.name, allowedModels: parsed.data.allowedModels ?? null });
  res.status(201).json(key);
});

apiKeysRouter.delete("/:id", (req, res) => {
  const ok = deleteApiKey(req.params.id);
  if (!ok) {
    res.status(404).json({ error: { message: `API key '${req.params.id}' not found` } });
    return;
  }
  res.json({ ok: true });
});
