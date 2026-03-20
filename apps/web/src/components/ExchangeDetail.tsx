import { memo, useMemo } from "react";
import { CheckCircle2, ExternalLink, Loader2, Send, X, XCircle, Zap } from "lucide-react";
import type { ExchangeRecord } from "../types";
import { buildResponseMarkdown, extractMessages, formatRelative, formatTimeFull, getCompletionTokens, getResponseText, safeStringify } from "../utils";
import { Badge, CopyButton, MarkdownSurface } from "./Atoms";
import { RoleMessages } from "./RoleMessages";

export const ExchangeDetail = memo(function ExchangeDetail({
  item, serial, onClose,
}: {
  item: ExchangeRecord;
  serial: number;
  onClose: () => void;
}) {
  const messages = useMemo(() => extractMessages(item.requestBody), [item.requestBody]);
  const lastUserMsg = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && messages[i].content.trim()) return messages[i].content;
    }
    return item.prompt;
  }, [messages, item.prompt]);

  const completionTokens = getCompletionTokens(item.responseBody);
  const totalTokens = item.promptTokens + completionTokens;
  const responseMd = buildResponseMarkdown(item.responseBody);
  const responseText = getResponseText(item.responseBody);
  const statusVariant = item.responseStatus === "success" ? "success" : item.responseStatus === "error" ? "error" : "warning";

  return (
    <div className="flex h-full flex-col">
      {/* sticky header */}
      <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-base-content/5 bg-base-200 px-4 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="mono text-[11px] text-base-content/30">#{serial}</span>
          <Badge variant={statusVariant}>
            {item.responseStatus === "success" ? <CheckCircle2 size={9} /> : item.responseStatus === "error" ? <XCircle size={9} /> : <Loader2 size={9} className="animate-spin" />}
            {item.responseStatus}
          </Badge>
          <Badge variant={item.mode === "forward" ? "info" : "default"}>{item.mode === "forward" ? "Forward" : "Capture"}</Badge>
          <span className="mono text-[11px] text-base-content/50 truncate">{item.model}</span>
        </div>
        <button className="btn btn-ghost btn-sm btn-circle h-6 w-6 min-h-0 shrink-0" onClick={onClose} type="button" title="关闭 (Esc)">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* meta row */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-base-content/5 px-4 py-2 text-[11px] text-base-content/40">
          <span>ID: <span className="mono">{item.id}</span></span>
          <span>创建: {formatTimeFull(item.createdAt)}</span>
          {item.completedAt && <span>完成: {formatTimeFull(item.completedAt)} ({formatRelative(item.completedAt)})</span>}
          <span>Prompt: <span className="text-info">{item.promptTokens}</span></span>
          <span>Completion: <span className="text-success">{completionTokens}</span></span>
          <span>Total: <span className="font-semibold text-base-content/60">{totalTokens}</span></span>
          {typeof item.durationMs === "number" && <span>耗时: {item.durationMs}ms</span>}
          {item.upstreamUrl && (
            <span className="flex items-center gap-1 min-w-0">
              <ExternalLink size={10} className="shrink-0" />
              <span className="mono truncate">{item.upstreamUrl}</span>
            </span>
          )}
        </div>

        {item.errorMessage && (
          <div className="mx-4 mt-3 rounded bg-error/10 px-3 py-1.5 text-xs text-error">{item.errorMessage}</div>
        )}

        {/* prompt + response */}
        <div className="grid gap-0 lg:grid-cols-2">
          <div className="border-b border-base-content/5 p-4 lg:border-b-0 lg:border-r">
            <div className="mb-3 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-base-content/40">
                <Send size={11} /> Prompt
                {messages.length > 0 && (
                  <span className="font-normal normal-case tracking-normal text-base-content/25">({messages.length} 条消息)</span>
                )}
              </span>
              <CopyButton text={lastUserMsg} />
            </div>
            {messages.length > 0
              ? <RoleMessages messages={messages} />
              : <div className="rounded-lg bg-base-200/50 p-3 text-sm leading-relaxed text-base-content/70 whitespace-pre-wrap">{item.prompt || "(空)"}</div>}
          </div>

          <div className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-base-content/40">
                <Zap size={11} /> Response
              </span>
              <CopyButton text={responseText || safeStringify(item.responseBody ?? "")} />
            </div>
            {item.responseStatus === "pending" ? (
              <p className="flex items-center gap-2 text-sm text-base-content/40">
                <Loader2 size={14} className="animate-spin" /> 等待响应…
              </p>
            ) : (
              <MarkdownSurface markdown={responseMd} />
            )}
          </div>
        </div>

        {/* raw JSON */}
        <details className="border-t border-base-content/5">
          <summary className="cursor-pointer px-4 py-2 text-[11px] text-base-content/30 hover:text-base-content/50 select-none">
            查看原始请求/响应 JSON
          </summary>
          <div className="grid gap-0 lg:grid-cols-2 pb-4">
            <div className="p-4 lg:border-r border-base-content/5">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-base-content/30">Request Body</div>
              <pre className="overflow-auto rounded-lg bg-base-300 p-3 text-[11px] text-base-content/60 mono">{safeStringify(item.requestBody)}</pre>
            </div>
            <div className="p-4">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-base-content/30">Response Body</div>
              <pre className="overflow-auto rounded-lg bg-base-300 p-3 text-[11px] text-base-content/60 mono">{safeStringify(item.responseBody)}</pre>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
});
