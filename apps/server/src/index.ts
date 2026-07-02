import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { healthRouter } from "./routes/health.js";
import { exchangesRouter } from "./routes/exchanges.js";
import { eventsRouter } from "./routes/events.js";
import { proxyConfigRouter } from "./routes/proxy-config.js";
import { apiKeysRouter } from "./routes/api-keys.js";
import { providersRouter } from "./routes/providers.js";
import { modelsRouter } from "./routes/models.js";
import { devRouter } from "./routes/dev.js";
import { chatCompletionsRouter } from "./routes/chat-completions.js";
import { messagesRouter } from "./routes/messages.js";
import { transparentProxyRouter } from "./routes/transparent-proxy.js";
import { requestLogMiddleware } from "./utils/log.js";

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigin = process.env.CORS_ORIGIN;
    // If CORS_ORIGIN=* or unset (open/self-hosted), allow all
    if (!allowedOrigin || allowedOrigin === "*") {
      callback(null, true);
      return;
    }
    // Allow same-origin requests (no Origin header) and configured/localhost origins
    if (!origin || origin === allowedOrigin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS: origin not allowed"));
    }
  }
}));
app.use(express.json({ limit: "50mb" }));
app.use(requestLogMiddleware());

// --- Serve static web assets (production only) ---
const webDistPath = resolve(import.meta.dirname ?? __dirname, "../../web/dist");
const serveStatic = process.env.NODE_ENV !== "development" && existsSync(webDistPath);
const indexPath = resolve(webDistPath, "index.html");
const indexExists = serveStatic && existsSync(indexPath);
if (serveStatic) {
  app.use(express.static(webDistPath, { index: false }));
}

// --- Routes ---
app.use("/health", healthRouter);
app.use("/exchanges", exchangesRouter);
app.use("/events", eventsRouter);
app.use("/proxy/config", proxyConfigRouter);
app.use("/proxy/api-keys", apiKeysRouter);
app.use("/proxy/providers", providersRouter);
app.use(modelsRouter);
app.use("/dev", devRouter);

// Specific /v1/* routes must come before the transparent proxy catch-all
app.use(chatCompletionsRouter);
app.use(messagesRouter);
app.use(transparentProxyRouter);

// --- SPA fallback: serve index.html for any unmatched GET request (production only) ---
if (serveStatic) {
  app.get("*", (_req, res) => {
    if (indexExists) {
      res.sendFile(indexPath);
    } else {
      res.status(404).json({ error: "Not found" });
    }
  });
}

app.listen(port, () => {
  console.log(`server running on http://localhost:${port}`);
});
