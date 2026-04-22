import { useState } from "react";
import { ArrowUpDown, BookOpen, CheckCircle2, Loader2, Play, Server, X, XCircle } from "lucide-react";
import { Badge } from "./Atoms";

const TryItPanel = ({ endpoint, buildBody, extractText }: {
  endpoint: string;
  buildBody: (msg: string) => object;
  extractText: (data: unknown) => string;
}) => {
  const [msg, setMsg] = useState("你好，请用一句话介绍你自己。");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ text: string; ms: number } | null>(null);
  const [error, setError] = useState("");

  const run = async () => {
    if (!msg.trim() || loading) return;
    setLoading(true);
    setResult(null);
    setError("");
    const t = Date.now();
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer fake-key", "x-api-key": "fake-key" },
        body: JSON.stringify({ ...buildBody(msg.trim()), stream: false }),
      });
      const text = await r.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = { _raw: text }; }
      const d = data as Record<string, unknown>;
      const text2 = "_raw" in d
        ? String(d._raw).slice(0, 500)
        : extractText(data);
      setResult({ text: text2, ms: Date.now() - t });
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-2 rounded-lg border border-base-content/8 bg-base-100 p-3 space-y-2">
      <div className="flex gap-2">
        <input
          className="input input-bordered input-xs flex-1 text-xs bg-base-200 font-sans"
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
          placeholder="输入消息…"
        />
        <button
          type="button"
          className="btn btn-primary btn-xs gap-1 shrink-0"
          onClick={() => void run()}
          disabled={loading || !msg.trim()}
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
          {loading ? "请求中…" : "发送"}
        </button>
      </div>
      {error && (
        <div className="flex items-center gap-1.5 text-[11px] text-error">
          <XCircle size={11} /> {error}
        </div>
      )}
      {result && (
        <div className="rounded-lg bg-base-200 p-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="flex items-center gap-1 text-[10px] text-success font-medium">
              <CheckCircle2 size={9} /> 响应成功
            </span>
            <span className="text-[10px] tabular-nums text-base-content/30">{result.ms}ms</span>
          </div>
          <p className="text-xs text-base-content/70 whitespace-pre-wrap leading-relaxed">{result.text}</p>
        </div>
      )}
    </div>
  );
};

export const HelpModal = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  if (!open) return null;
  const host = window.location.host;
  const base = `http://${host}`;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="relative w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-xl border border-base-content/10 bg-base-200 shadow-2xl">
          <div className="sticky top-0 flex items-center justify-between border-b border-base-content/5 bg-base-200 px-5 py-3">
            <h3 className="flex items-center gap-2 text-sm font-bold">
              <BookOpen size={15} /> 使用说明
            </h3>
            <button className="btn btn-ghost btn-sm btn-circle h-7 w-7 min-h-0" onClick={onClose} type="button">
              <X size={16} />
            </button>
          </div>

          <div className="p-5 space-y-6 text-sm">
            <section>
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-base-content/40">这是什么</h4>
              <p className="text-base-content/70 leading-relaxed">
                Fake Model Gateway 是一个本地 AI API 代理，支持 <span className="font-semibold text-base-content">OpenAI</span> 和 <span className="font-semibold text-base-content">Anthropic</span> 两种调用格式。通过配置不同提供商，可将请求自动路由到对应的上游模型。
              </p>
            </section>

            <section>
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-base-content/40">OpenAI 格式</h4>
              <p className="mb-2 text-base-content/60 text-xs">端点：<code className="rounded bg-base-content/8 px-1 py-0.5 font-mono text-[11px]">POST {base}/v1/chat/completions</code></p>
              <pre className="rounded-lg bg-base-300 p-3 text-[11px] font-mono leading-relaxed overflow-x-auto text-base-content/70">{`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}/v1",
  apiKey: "your-api-key",
});

const resp = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});`}</pre>
              <TryItPanel
                endpoint="/v1/chat/completions"
                buildBody={(msg) => ({ model: "gpt-4o", messages: [{ role: "user", content: msg }] })}
                extractText={(data) => {
                  const d = data as { choices?: Array<{ message?: { content?: string } }> };
                  return d?.choices?.[0]?.message?.content ?? JSON.stringify(data, null, 2);
                }}
              />
            </section>

            <section>
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-base-content/40">Anthropic 格式</h4>
              <p className="mb-2 text-base-content/60 text-xs">端点：<code className="rounded bg-base-content/8 px-1 py-0.5 font-mono text-[11px]">POST {base}/v1/messages</code></p>
              <pre className="rounded-lg bg-base-300 p-3 text-[11px] font-mono leading-relaxed overflow-x-auto text-base-content/70">{`import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "${base}",
  apiKey: "your-api-key",
});

const resp = await client.messages.create({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});`}</pre>
              <TryItPanel
                endpoint="/v1/messages"
                buildBody={(msg) => ({ model: "claude-3-5-sonnet-20241022", max_tokens: 256, messages: [{ role: "user", content: msg }] })}
                extractText={(data) => {
                  const d = data as { content?: Array<{ type?: string; text?: string }> };
                  return d?.content?.find((b) => b.type === "text")?.text ?? JSON.stringify(data, null, 2);
                }}
              />
            </section>

            <section>
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-base-content/40">工作原理</h4>
              <div className="space-y-2">
                <div className="rounded-lg border border-base-content/8 bg-base-100 px-3 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    <Server size={12} className="text-base-content/50" />
                    <span className="font-semibold text-xs">提供商</span>
                    <Badge variant="default">核心</Badge>
                  </div>
                  <p className="text-xs text-base-content/55 leading-relaxed">在配置中添加提供商（如 OpenAI、Kimi、MiniMax 等），填写 API Key 后即可使用对应模型。支持 OpenAI 和 Claude 两种格式。</p>
                </div>
                <div className="rounded-lg border border-base-content/8 bg-base-100 px-3 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    <ArrowUpDown size={12} className="text-info/70" />
                    <span className="font-semibold text-xs">模型路由</span>
                  </div>
                  <p className="text-xs text-base-content/55 leading-relaxed">请求中的 model 参数会自动匹配到对应的提供商。例如 model 为 "gpt-4o" 时自动路由到 OpenAI 提供商。</p>
                </div>
              </div>
            </section>

            <section>
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-base-content/40">内置提供商</h4>
              <div className="space-y-1.5 text-xs text-base-content/60">
                <div className="grid grid-cols-3 gap-1 font-mono">
                  <span className="text-base-content/40">提供商</span>
                  <span className="text-base-content/40">格式</span>
                  <span className="text-base-content/40">鉴权</span>
                  <span>OpenAI</span><span>Chat</span><span>Bearer</span>
                  <span>Anthropic</span><span>Messages</span><span>x-api-key</span>
                  <span>Kimi</span><span>Messages</span><span>x-api-key</span>
                  <span>MiniMax</span><span>Messages</span><span>x-api-key</span>
                  <span>DeepSeek</span><span>Chat</span><span>Bearer</span>
                  <span>SiliconFlow</span><span>Chat</span><span>Bearer</span>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </>
  );
};
