import { memo, useMemo } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, XCircle } from "lucide-react";
import type { ExchangeRecord } from "../types";
import { extractMessages, formatTime, formatTimeFull, getCompletionTokens, truncate } from "../utils";
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
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && messages[i].content.trim()) return messages[i].content;
    }
    return item.prompt;
  }, [messages, item.prompt]);

  const promptPreview = truncate(lastUserMsg || "(空)", 140);
  const completionTokens = getCompletionTokens(item.responseBody);
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
          className="flex flex-1 items-center gap-2 text-left transition-colors hover:bg-base-content/[0.02] min-w-0"
          onClick={() => onToggle(item.id)}
        >
          {expanded
            ? <ChevronDown size={14} className="shrink-0 text-primary" />
            : <ChevronRight size={14} className="shrink-0 text-base-content/30" />}

          <span className="mono w-8 shrink-0 text-[11px] text-base-content/25">#{serial}</span>

          <Badge variant={statusVariant}>
            {item.responseStatus === "success" ? <CheckCircle2 size={9} /> : item.responseStatus === "error" ? <XCircle size={9} /> : <Loader2 size={9} className="animate-spin" />}
            {item.responseStatus}
          </Badge>

          <Badge variant={item.mode === "forward" ? "info" : "default"}>
            {item.mode === "forward" ? "FWD" : "CAP"}
          </Badge>

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

          <span className="min-w-0 flex-1 truncate text-xs text-base-content/50">{promptPreview}</span>

          <span className="shrink-0 text-[10px] text-base-content/25" title={formatTimeFull(item.createdAt)}>
            {formatTime(item.createdAt)}
          </span>
        </button>
      </div>
    </div>
  );
});
