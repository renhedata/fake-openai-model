import { z } from "zod";

export const proxyConfigSchema = z.object({
  mode: z.enum(["capture_only", "forward"]),
  apiType: z.enum(["chat_completions", "responses"]),
  baseUrl: z.string(),
  path: z.string(),
  apiKey: z.string(),
  modelOverride: z.string()
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

const replyPool = [
  "这是一个假的模型响应。",
  "我已经收到你的提示词，并返回一条演示结果。",
  "提示词抓取成功，这里给你一个随机回复。",
  "这是测试环境返回的数据，不代表真实推理能力。"
];

const randomReply = () => replyPool[Math.floor(Math.random() * replyPool.length)];

export const createFakeCompletion = (input: { model: string }, promptTokens: number) => ({
  id: `chatcmpl_${Date.now()}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: input.model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: randomReply() },
      finish_reason: "stop"
    }
  ],
  usage: {
    prompt_tokens: promptTokens,
    completion_tokens: 20,
    total_tokens: promptTokens + 20
  }
});

export const createFakeStreamText = (captured: string) =>
  [
    "这是一个假的流式响应。",
    "系统已抓取你的提示词。",
    captured ? `提示词摘要：${captured.slice(0, 120)}` : "提示词为空。"
  ].join(" ") || "fake response";
