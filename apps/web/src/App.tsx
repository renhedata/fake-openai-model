import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

type PromptItem = {
  id: string;
  content: string;
  promptTokens: number;
  createdAt: string;
};

type PromptStats = {
  totalPrompts: number;
  totalPromptTokens: number;
};

type PromptsEvent = {
  type: "snapshot" | "update";
  items: PromptItem[];
  stats: PromptStats;
  latest?: PromptItem;
};

const manualMarkdown = `# 接入说明

本页面用于实时展示系统抓取到的提示词。

## 外部调用方式

使用兼容 OpenAI 的接口：

\`POST /v1/chat/completions\`

\`\`\`bash
curl http://localhost:3000/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "fake-gpt-4o-mini",
    "messages": [
      {"role": "user", "content": "# 标题\\n\\n写一段 Markdown"}
    ]
  }'
\`\`\`

## 展示说明

- 服务端通过 SSE 推送新提示词。
- 右侧使用 GitHub 风格 Markdown 渲染。
- 代码块支持语法高亮。`;

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

export const App = () => {
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [stats, setStats] = useState<PromptStats>({ totalPrompts: 0, totalPromptTokens: 0 });
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const eventSource = new EventSource("http://localhost:3000/events/prompts");

    eventSource.onopen = () => setConnected(true);
    eventSource.onerror = () => setConnected(false);
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as PromptsEvent;
        setPrompts(data.items ?? []);
        setStats(data.stats ?? { totalPrompts: 0, totalPromptTokens: 0 });
      } catch {
        setConnected(false);
      }
    };

    return () => {
      eventSource.close();
      setConnected(false);
    };
  }, []);

  const statusLabel = useMemo(() => (connected ? "SSE 已连接" : "SSE 断开"), [connected]);

  return (
    <main className="mx-auto max-w-[2100px] space-y-4 px-4 py-5 md:px-6">
      <header className="card border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body gap-3 p-5">
          <h1 className="card-title text-2xl">Fake OpenAI Model</h1>
          <div className="flex flex-wrap items-center gap-2">
            <span className="badge badge-neutral badge-outline">提示词展示台</span>
            <span className={`badge ${connected ? "badge-success" : "badge-error"}`}>{statusLabel}</span>
          </div>
        </div>
      </header>

      <section className="stats w-full border border-base-300 bg-base-100 shadow-sm">
        <div className="stat">
          <div className="stat-title">总提示词数</div>
          <div className="stat-value text-3xl">{stats.totalPrompts}</div>
        </div>
        <div className="stat">
          <div className="stat-title">累计发送 Token</div>
          <div className="stat-value text-3xl">{stats.totalPromptTokens}</div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(320px,0.58fr)_minmax(980px,1.95fr)]">
        <section className="self-start xl:sticky xl:top-4">
          <article className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body p-4">
              <h2 className="card-title text-base">说明书</h2>
              <div className="markdown-body markdown-surface mt-2">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {manualMarkdown}
                </ReactMarkdown>
              </div>
            </div>
          </article>
        </section>

        <aside className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="card-title text-base">抓取到的提示词</h2>
              <span className="badge badge-ghost">{prompts.length} 条</span>
            </div>

            <div className="max-h-[82vh] space-y-3 overflow-auto pr-1">
              {prompts.length === 0 ? (
                <p className="rounded-box border border-base-300 bg-base-200 p-4 text-sm text-base-content/70">暂无数据</p>
              ) : (
                prompts.map((item, idx) => (
                  <article className="rounded-box border border-base-300 bg-base-100 p-3" key={item.id}>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-base-content/70">
                      <span className="badge badge-outline">Prompt #{prompts.length - idx}</span>
                      <div className="flex items-center gap-2">
                        <span className="badge badge-ghost">{item.promptTokens} tokens</span>
                        <span>{formatTime(item.createdAt)}</span>
                      </div>
                    </div>
                    <div className="markdown-body markdown-surface">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                        {item.content}
                      </ReactMarkdown>
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
};
