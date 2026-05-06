import { Router } from "express";
import {
  getExchangesPaginated,
  getExchangeById,
  deleteExchanges,
  deleteAllExchanges,
} from "../state.js";

export const exchangesRouter = Router();

exchangesRouter.get("/", (req, res) => {
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const dateFrom = typeof req.query.dateFrom === "string" ? req.query.dateFrom : undefined;
  const dateTo = typeof req.query.dateTo === "string" ? req.query.dateTo : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  const apiKeyId = typeof req.query.apiKeyId === "string" ? req.query.apiKeyId : undefined;
  const agentType = typeof req.query.agentType === "string" ? req.query.agentType : undefined;
  const result = getExchangesPaginated({ cursor, limit, dateFrom, dateTo, status, search, apiKeyId, agentType });
  res.json(result);
});

exchangesRouter.get("/:id", (req, res) => {
  const record = getExchangeById(req.params.id);
  if (!record) { res.status(404).json({ error: { message: "Not found" } }); return; }
  res.json(record);
});

exchangesRouter.delete("/", (req, res) => {
  const body = req.body as { ids?: string[]; all?: boolean } | undefined;
  if (body?.all) {
    deleteAllExchanges();
    res.json({ ok: true, deleted: "all" });
    return;
  }
  if (Array.isArray(body?.ids) && body.ids.length > 0) {
    const ids = body.ids.filter((id): id is string => typeof id === "string");
    const count = deleteExchanges(ids);
    res.json({ ok: true, deleted: count });
    return;
  }
  res.status(400).json({ error: { message: "Provide ids array or all: true" } });
});
