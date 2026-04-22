import { Router } from "express";
import { bulkSeedExchanges, type SeedRecord } from "../state.js";

export const devRouter = Router();

if (process.env.NODE_ENV !== "production") {
  devRouter.post("/seed", (req, res) => {
    const count = Math.min(Number((req.query.count as string) ?? "80"), 500);
    const models = ["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet", "claude-3-haiku", "gemini-1.5-pro", "fake-gpt-4o-mini"];
    const prompts = [
      "帮我写一个 Python 冒泡排序",
      "解释一下什么是 Transformer 架构",
      "用 TypeScript 实现一个防抖函数",
      "写一首关于秋天的七言绝句",
      "What is the difference between REST and GraphQL?",
      "Summarize the key principles of clean code",
      "帮我优化这段 SQL 查询：SELECT * FROM orders WHERE status = 'pending'",
      "解释 React 的 useEffect 和 useLayoutEffect 的区别",
      "写一个 Rust 的链表实现",
      "如何设计一个高并发的消息队列系统？",
      "Explain the CAP theorem with examples",
      "帮我写一个正则表达式匹配中国手机号",
      "What are the SOLID principles in OOP?",
      "给我出 5 道关于二叉树的算法题",
      "帮我写一个 Docker Compose 配置：包含 nginx + postgres + redis",
    ];
    const responses = [
      "这是一个假的模型响应，用于测试界面显示效果。",
      "以下是示例回答内容，实际响应会包含更多信息。",
      "测试数据：此响应由 /dev/seed 端点自动生成，模拟真实 API 响应格式。",
      "Here is a sample response for testing purposes. The actual model would provide a more detailed answer.",
      "```python\ndef bubble_sort(arr):\n    n = len(arr)\n    for i in range(n):\n        for j in range(0, n-i-1):\n            if arr[j] > arr[j+1]:\n                arr[j], arr[j+1] = arr[j+1], arr[j]\n    return arr\n```",
    ];

    const statuses: Array<"success" | "error"> = ["success", "success", "success", "success", "error"];
    const records: SeedRecord[] = [];

    for (let i = 0; i < count; i++) {
      const model = models[Math.floor(Math.random() * models.length)];
      const prompt = prompts[Math.floor(Math.random() * prompts.length)];
      const status = statuses[Math.floor(Math.random() * statuses.length)];
      const promptTokens = Math.floor(Math.random() * 800) + 50;
      const completionTokens = Math.floor(Math.random() * 1200) + 100;
      const durationMs = Math.floor(Math.random() * 4000) + 200;
      const response = responses[Math.floor(Math.random() * responses.length)];
      records.push({
        mode: Math.random() > 0.5 ? "capture_only" : "forward",
        model,
        prompt,
        promptTokens,
        requestBody: { model, messages: [{ role: "user", content: prompt }], temperature: 0.7, max_tokens: 2048 },
        responseStatus: status,
        responseBody: status === "success" ? {
          id: `chatcmpl-seed-${i}`,
          object: "chat.completion",
          model,
          choices: [{ index: 0, message: { role: "assistant", content: response }, finish_reason: "stop" }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        } : undefined,
        errorMessage: status === "error" ? "upstream timeout: connection refused" : undefined,
        upstreamStatusCode: status === "success" ? 200 : 503,
        durationMs,
      });
    }

    const inserted = bulkSeedExchanges(records);
    res.json({ ok: true, inserted });
  });
}
