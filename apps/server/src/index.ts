import cors from "cors";
import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./router.js";
import { capturePrompt, chatInputSchema, createCompletion } from "./router.js";
import { getPrompts, getPromptStats, subscribePromptAdded } from "./state.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: "fake-gpt-4o-mini",
        object: "model",
        created: 1710000000,
        owned_by: "fake-model"
      }
    ]
  });
});

app.get("/events/prompts", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send({ type: "snapshot", items: getPrompts(), stats: getPromptStats() });

  const unsubscribe = subscribePromptAdded((latest, items, stats) => {
    send({ type: "update", latest, items, stats });
  });

  req.on("close", () => {
    unsubscribe();
    res.end();
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const input = chatInputSchema.parse(req.body);
    if (input.stream) {
      const { captured } = capturePrompt(input);
      const content =
        [
          "这是一个假的流式响应。",
          "系统已抓取你的提示词。",
          captured ? `提示词摘要：${captured.slice(0, 120)}` : "提示词为空。"
        ].join(" ") || "fake response";
      const id = `chatcmpl_${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const chunks = content.match(/.{1,12}/g) ?? [content];

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const write = (payload: unknown) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      write({
        id,
        object: "chat.completion.chunk",
        created,
        model: input.model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
      });

      for (const part of chunks) {
        write({
          id,
          object: "chat.completion.chunk",
          created,
          model: input.model,
          choices: [{ index: 0, delta: { content: part }, finish_reason: null }]
        });
      }

      write({
        id,
        object: "chat.completion.chunk",
        created,
        model: input.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.json(createCompletion(input));
  } catch {
    res.status(400).json({
      error: {
        message: "Invalid request body",
        type: "invalid_request_error"
      }
    });
  }
});

app.use(
  "/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext: () => ({})
  })
);

app.listen(port, () => {
  console.log(`server running on http://localhost:${port}`);
});
