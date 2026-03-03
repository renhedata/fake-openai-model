# fake-openai-model

一个最小可用的假模型项目：

- 后端：TypeScript + Express + tRPC
- 前端：React + TypeScript + Vite
- 兼容接口：`/v1/chat/completions`、`/v1/models`
- 能力：抓取调用提示词并缓存，记录 token 与时间戳，随机返回一条假回复，SSE 实时推送提示词更新

## 启动

```bash
bun install
bun run dev
```

- 后端: `http://localhost:3000`
- 前端: `http://localhost:5173`

## OpenAI 兼容调用示例

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fake-gpt-4o-mini",
    "messages": [
      {"role": "user", "content": "给我一个随机建议"}
    ]
  }'
```
