import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { getDashboardState, getProxyConfig, setProxyConfig } from "./state.js";

const t = initTRPC.create();

const contentPartSchema = z
  .object({
    text: z.string().optional(),
    input_text: z.string().optional()
  })
  .passthrough();

const messageSchema = z.object({
  role: z.string(),
  content: z.unknown().optional(),
}).passthrough();

export const chatInputSchema = z.object({
  model: z.string(),
  messages: z.array(messageSchema),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  stream: z.boolean().optional()
}).passthrough();

export const proxyModeSchema = z.enum(["capture_only", "forward"]);
export const apiTypeSchema = z.enum(["chat_completions", "responses"]);

export const proxyConfigSchema = z.object({
  mode: proxyModeSchema,
  apiType: apiTypeSchema,
  baseUrl: z.string(),
  path: z.string(),
  apiKey: z.string(),
  modelOverride: z.string()
});

export const proxyConfigUpdateSchema = proxyConfigSchema.partial();

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

const replyPool = [
  "这是一个假的模型响应。",
  "我已经收到你的提示词，并返回一条演示结果。",
  "提示词抓取成功，这里给你一个随机回复。",
  "这是测试环境返回的数据，不代表真实推理能力。"
];

const randomReply = () => replyPool[Math.floor(Math.random() * replyPool.length)];

const toMessageText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          return String(p.text ?? p.input_text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
};

export const capturePrompt = (input: z.infer<typeof chatInputSchema>) => {
  const captured = input.messages
    .filter((m) => m.role === "user" || m.role === "system")
    .map((m) => toMessageText(m.content))
    .join("\n")
    .trim();
  return {
    captured,
    promptTokens: Math.max(1, Math.ceil(Math.max(1, captured.length) / 4))
  };
};

export const createFakeCompletion = (input: z.infer<typeof chatInputSchema>, promptTokens: number) => {
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

export const createFakeStreamText = (captured: string) =>
  [
    "这是一个假的流式响应。",
    "系统已抓取你的提示词。",
    captured ? `提示词摘要：${captured.slice(0, 120)}` : "提示词为空。"
  ].join(" ") || "fake response";

export const appRouter = t.router({
  openai: t.router({
    chatCompletions: t.procedure.input(chatInputSchema).mutation(({ input }) => {
      const { promptTokens } = capturePrompt(input);
      return createFakeCompletion(input, promptTokens);
    })
  }),
  dashboard: t.router({
    state: t.procedure.query(() => getDashboardState()),
    proxyConfig: t.procedure.query(() => getProxyConfig()),
    updateProxyConfig: t.procedure.input(proxyConfigUpdateSchema).mutation(({ input }) => setProxyConfig(input))
  })
});

export type AppRouter = typeof appRouter;
