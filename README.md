# fake-openai-model

一个最小可用的假模型项目：

- 后端：TypeScript + Express + tRPC
- 前端：React + TypeScript + Vite
- 兼容接口：`/v1/chat/completions`、`/v1/models`
- 能力：
  - 抓取请求与响应并缓存（含 token、时间、状态码、耗时）
  - 可选两种模式：
    - `capture_only`：只抓请求并返回本地假响应
    - `forward`：抓取请求后转发到上游模型，并记录上游响应
  - SSE 实时推送控制台更新（请求、响应、配置）

## 启动

```bash
bun install
bun run dev
```

- 后端: `http://localhost:3000`
- 前端: `http://localhost:5173`

## 代理配置接口

- `GET /proxy/config`：读取当前模式和转发配置
- `PUT /proxy/config`：更新配置（支持部分字段）
- `GET /proxy/models`：查看当前本地模型库
- `POST /proxy/models/refresh`：手动拉取上游模型并同步到本地模型库（`/v1/models`）
- `POST /proxy/test`：发送最小测试请求到上游模型，返回状态码、耗时和响应摘要

请求体示例：

```json
{
  "mode": "forward",
  "apiType": "chat_completions",
  "baseUrl": "https://api.openai.com/v1",
  "path": "/v1/chat/completions",
  "apiKey": "sk-***",
  "modelOverride": "gpt-4o-mini"
}
```

也可以通过环境变量设置默认值：

- `PROXY_MODE`：`capture_only` 或 `forward`
- `UPSTREAM_BASE_URL`
- `UPSTREAM_API_TYPE`：`chat_completions` 或 `responses`
- `UPSTREAM_PATH`
- `UPSTREAM_API_KEY`
- `UPSTREAM_MODEL`

同步上游模型后，本项目的 `/v1/models` 会返回与上游一致的模型列表。

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
