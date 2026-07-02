import { memo, useMemo } from "react";
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Loader2, XCircle } from "lucide-react";
import type { ExchangeRecord } from "../types";
import { extractMessages, formatTime, formatTimeFull, getCompletionTokens, getResponseText, truncate } from "../utils";
import { Badge } from "./Atoms";

export const ExchangeRow = memo(function ExchangeRow({
  item, serial, expanded, onToggle, selectMode, selected, onSelect, compact,
}: {
  item: ExchangeRecord;
  serial: number;
  expanded: boolean;
  onToggle: (id: string) => void;
  selectMode: boolean;
  selected: boolean;
  onSelect: (id: string, checked: boolean) => void;
  compact?: boolean;
}) {
  const messages = useMemo(() => extractMessages(item.requestBody), [item.requestBody]);

  const lastUserMsg = useMemo(() => {
    if (item.lastUserMessage?.trim()) return item.lastUserMessage;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && messages[i].content.trim()) return messages[i].content;
    }
    return item.prompt;
  }, [messages, item.lastUserMessage, item.prompt]);

  const promptPreview = useMemo(() => {
    const text = (lastUserMsg || "").replace(/\s+/g, " ").trim();
    return text ? truncate(text, 400) : "(空)";
  }, [lastUserMsg]);
  const responsePreview = useMemo(() => {
    const text = getResponseText(item.responseBody);
    return text ? truncate(text.replace(/\s+/g, " ").trim(), 280) : "";
  }, [item.responseBody]);
  const completionTokens = item.completionTokens ?? getCompletionTokens(item.responseBody);
  const totalTokens = item.promptTokens + completionTokens;
  const statusVariant = item.responseStatus === "success" ? "success" : item.responseStatus === "error" ? "error" : "warning";

  return (
    <div className={`rounded-lg border transition-all duration-200 ${
      selected
        ? "border-primary/50 bg-primary/10"
        : expanded
          ? "border-primary/50 bg-primary/[0.08] shadow-md shadow-primary/10"
          : "border-base-content/5 bg-base-100 hover:border-base-content/10 hover:shadow-sm"
    }`}>
      <div className="flex w-full items-center gap-2 px-3 py-2">
        {selectMode && (
          <label className="shrink-0 cursor-pointer flex items-center" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              className="checkbox checkbox-xs checkbox-primary"
              checked={selected}
              onChange={(e) => onSelect(item.id, e.target.checked)}
            />
          </label>
        )}

        <button
          type="button"
          className="flex flex-1 flex-col gap-0.5 text-left transition-colors hover:bg-base-content/[0.02] min-w-0 overflow-hidden"
          onClick={() => onToggle(item.id)}
        >
          <div className="flex w-full items-center gap-2 min-w-0">
          {expanded
            ? <ChevronDown size={14} className="shrink-0 text-primary" />
            : <ChevronRight size={14} className="shrink-0 text-base-content/30" />}

          <span className="mono w-8 shrink-0 text-[11px] text-base-content/25">#{serial}</span>

          <Badge variant={statusVariant}>
            {item.responseStatus === "success" ? <CheckCircle2 size={9} /> : item.responseStatus === "error" ? <XCircle size={9} /> : <Loader2 size={9} className="animate-spin" />}
            {item.responseStatus}
          </Badge>

          {item.apiKeyName && (
            <Badge variant="default">
              {item.apiKeyName}
            </Badge>
          )}

          {item.agentType && (
            <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium leading-tight transition-all duration-200 ${item.agentType === "openclaw" ? "bg-purple-500/15 text-purple-500 border-purple-500/20" : "bg-cyan-500/15 text-cyan-500 border-cyan-500/20"}`}>
              {item.agentType === "openclaw" ? "OpenClaw" : "Hermes"}
            </span>
          )}

          {!compact && (
            <span className="mono shrink-0 text-[11px] text-base-content/50 w-24 truncate" title={item.model}>{item.model}</span>
          )}

          {!compact && (
            <span className="shrink-0 text-[10px] tabular-nums text-base-content/40" title={`入:${item.promptTokens} 出:${completionTokens} 总:${totalTokens}`}>
              <span className="text-info/60">{item.promptTokens}</span>
              <span className="text-base-content/20"> / </span>
              <span className="text-success/60">{completionTokens}</span>
              <span className="text-base-content/20"> tok</span>
            </span>
          )}

          {!compact && typeof item.durationMs === "number" && (
            <span className="shrink-0 text-[10px] tabular-nums text-base-content/30">{item.durationMs}ms</span>
          )}

          {!compact && typeof item.upstreamStatusCode === "number" && (
            <Badge variant={item.upstreamStatusCode < 400 ? "success" : "error"}>
              {item.upstreamStatusCode}
            </Badge>
          )}

          <span className="ml-auto shrink-0 text-[10px] text-base-content/25" title={formatTimeFull(item.createdAt)}>
            {formatTime(item.createdAt)}
          </span>
          </div>

          <div className="w-full min-w-0 pl-[22px]">
            <p className={`text-xs leading-relaxed text-base-content/60 break-words ${compact ? "line-clamp-2" : "line-clamp-3"}`}>{promptPreview}</p>
          </div>

          {!compact && responsePreview && (
            <div className="flex w-full items-start gap-1.5 min-w-0 pl-[22px]">
              <Bot size={11} className="mt-px shrink-0 text-success/50" />
              <span className="min-w-0 flex-1 line-clamp-2 text-[11px] text-base-content/40">{responsePreview}</span>
            </div>
          )}
        </button>
      </div>
    </div>
  );
});
