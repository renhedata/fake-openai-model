# fakemodel

一个可观测的 AI API 代理，用于拦截、记录并转发 LLM 请求。

- 后端：TypeScript + Express（Bun 运行）
- 前端：React + TypeScript + Vite（内置仪表盘）
- 数据库：SQLite（`bun:sqlite` / `node:sqlite` 自动选择）
- 兼容接口：`/v1/chat/completions`（OpenAI）和 `/v1/messages`（Anthropic）

## 核心功能

- **多 Provider 管理**：注册多个上游提供商，按模型名自动路由
- **格式自动转换**：
  - Anthropic Messages ↔ OpenAI Chat Completions（双向）
  - Anthropic Messages ↔ Gemini API（双向）
  - 流式（SSE）和非流式均支持
- **请求记录**：记录所有请求/响应、token 数、耗时、状态码
- **API Key 管理**：为接入方发放 `fm_*` 密钥，可限定允许的模型
- **SSE 实时推送**：仪表盘通过 `/events` 实时收到最新请求与配置变更
- **模型路由**：支持 `provider-id/model-name` 格式显式指定 provider

## 启动

```bash
bun install
bun run dev
```

- 后端：`http://localhost:3001`
- 前端：`http://localhost:5173`（开发模式），生产构建后由后端静态托管

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 后端监听端口 | `3001` |
| `UPSTREAM_BASE_URL` | 全局默认上游地址 | `https://api.openai.com` |
| `UPSTREAM_API_TYPE` | `chat_completions` 或 `responses` | `chat_completions` |
| `UPSTREAM_PATH` | 上游请求路径 | `/v1/chat/completions` |
| `UPSTREAM_API_KEY` | 上游 API Key | — |
| `UPSTREAM_MODEL` | 全局模型名覆盖 | — |
| `SQLITE_PATH` | SQLite 文件路径 | `data/fake-model.db` |
| `CORS_ORIGIN` | 允许的跨域来源（`*` 为全部放行） | `*` |

## 管理 API

### Provider

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/proxy/providers` | 列出所有 provider |
| `POST` | `/proxy/providers` | 新建 provider |
| `PUT` | `/proxy/providers/:id` | 更新 provider |
| `DELETE` | `/proxy/providers/:id` | 删除 provider |
| `POST` | `/proxy/providers/:id/test` | 测试连通性 |
| `POST` | `/proxy/providers/:id/refresh` | 从上游同步模型列表 |

Provider 字段：

```json
{
  "name": "My Provider",
  "baseUrl": "https://api.openai.com",
  "apiKey": "sk-***",
  "apiType": "chat_completions",
  "format": "openai",
  "authStyle": "bearer",
  "enabled": true,
  "models": ["gpt-4o", "gpt-4o-mini"],
  "defaultMaxTokens": 4096
}
```

`apiType` 可选值：`chat_completions` | `messages` | `responses`  
`format` 可选值：`openai` | `claude` | `gemini` | `ollama`

### API Key

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/proxy/api-keys` | 列出所有 key |
| `POST` | `/proxy/api-keys` | 创建 key（返回 `fm_*` 字符串） |
| `PATCH` | `/proxy/api-keys/:id` | 更新名称 / 启用状态 / 允许模型 |
| `DELETE` | `/proxy/api-keys/:id` | 删除 key |

### 全局代理配置

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/proxy/config` | 读取当前配置 |
| `PUT` | `/proxy/config` | 更新配置（支持部分字段） |

### 请求记录（Exchanges）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/exchanges` | 分页查询（支持 cursor、日期、状态、关键词过滤） |
| `DELETE` | `/exchanges` | 批量删除（body: `{ ids: string[] }`） |
| `DELETE` | `/exchanges/all` | 清空所有记录 |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/events` | SSE 实时事件流 |
| `GET` | `/v1/models` | 返回已注册的模型列表 |

## 模型路由规则

请求中的 `model` 字段按以下优先级解析：

1. `provider-id/model-name` 格式 → 路由到指定 provider
2. 模型在 `models` 表中有 `providerId` → 路由到对应 provider
3. 模型出现在某个 provider 的 `models` 列表中 → 路由到该 provider
4. 以上均不匹配 → 使用全局 `/proxy/config` 配置

## 调用示例

OpenAI 格式：

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer fm_your_key" \
  -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "hello"}]}'
```

Anthropic 格式：

```bash
curl http://localhost:3001/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: fm_your_key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model": "claude-sonnet-4-6", "max_tokens": 256, "messages": [{"role": "user", "content": "hello"}]}'
```

通过 `provider-id/model-name` 显式路由：

```bash
-d '{"model": "my-provider/gpt-4o", ...}'
```
