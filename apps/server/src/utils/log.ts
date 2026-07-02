import type { Request, Response, NextFunction } from "express";

const disabled = (): boolean =>
  process.env.NO_REQUEST_LOGS === "1" ||
  process.env.NO_REQUEST_LOGS === "true" ||
  process.env.LOG_LEVEL === "none";

/** Express middleware that logs a single access line to the console after each request. */
export const requestLogMiddleware = () =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (disabled()) {
      next();
      return;
    }

    const start = process.hrtime.bigint();
    const path = (req.originalUrl || req.url || "").split("?")[0] || "/";

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      const duration = durationMs < 1 ? "<1" : durationMs.toFixed(0);
      // eslint-disable-next-line no-console
      console.log(`${req.method} ${path} ${res.statusCode} ${duration}ms`);
    });

    next();
  };
