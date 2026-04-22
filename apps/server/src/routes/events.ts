import { Router } from "express";
import { getDashboardMeta, subscribeExchangeUpdated } from "../state.js";

export const eventsRouter = Router();

eventsRouter.get("/prompts", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // Send lightweight meta (no items) on initial snapshot
  send({ type: "snapshot", meta: getDashboardMeta() });

  const unsubscribe = subscribeExchangeUpdated((latest, meta) => {
    send({ type: "update", latest, meta });
  });

  req.on("close", () => {
    unsubscribe();
    res.end();
  });
});
