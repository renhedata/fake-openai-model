import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { addPrompt, getPromptStats, getPrompts } from "./state.js";

const t = initTRPC.create();

const contentPartSchema = z
  .object({
    text: z.string().optional(),
    input_text: z.string().optional()
  })
  .passthrough();

const messageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(contentPartSchema)])
});

export const chatInputSchema = z.object({
  model: z.string(),
  messages: z.array(messageSchema),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  stream: z.boolean().optional()
});

const replyPool = [
  "这是一个假的模型响应。",
  "我已经收到你的提示词，并返回一条演示结果。",
  "提示词抓取成功，这里给你一个随机回复。",
  "这是测试环境返回的数据，不代表真实推理能力。"
];

const randomReply = () => replyPool[Math.floor(Math.random() * replyPool.length)];

const toMessageText = (content: z.infer<typeof messageSchema>["content"]) => {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => part.text ?? part.input_text ?? "").join("");
};

export const capturePrompt = (input: z.infer<typeof chatInputSchema>) => {
  const captured = input.messages
    .filter((m) => m.role === "user" || m.role === "system")
    .map((m) => toMessageText(m.content))
    .join("\n")
    .trim();
  const entry = addPrompt(captured);
  return {
    captured,
    promptTokens: entry?.promptTokens ?? Math.max(1, Math.ceil(Math.max(1, captured.length) / 4))
  };
};

export const createCompletion = (input: z.infer<typeof chatInputSchema>) => {
  const { promptTokens } = capturePrompt(input);
  return {
    id: `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: randomReply()
        },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 20,
      total_tokens: promptTokens + 20
    }
  };
};

export const appRouter = t.router({
  openai: t.router({
    chatCompletions: t.procedure.input(chatInputSchema).mutation(({ input }) => createCompletion(input))
  }),
  prompts: t.router({
    list: t.procedure.query(() => ({
      items: getPrompts(),
      stats: getPromptStats()
    }))
  })
});

export type AppRouter = typeof appRouter;
