import { memo } from "react";
import { ExternalLink } from "lucide-react";
import { formatTimeFull, formatRelative, getUsageFromResponse } from "../../utils";
import type { ExchangeRecord } from "../../types";

export const MetaBar = memo(function MetaBar({
  item,
}: {
  item: ExchangeRecord;
}) {
  const usage = getUsageFromResponse(item.responseBody);

  const promptTokens = usage?.promptTokens ?? item.promptTokens;
  const completionTokens = usage?.completionTokens ?? 0;
  const totalTokens = usage?.totalTokens ?? (promptTokens + completionTokens);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-base-content/5 px-4 py-2 text-[11px] text-base-content/40">
      <span className="shrink-0">
        ID: <span className="mono select-all">{item.id}</span>
      </span>
      <span className="shrink-0">创建: {formatTimeFull(item.createdAt)}</span>
      {item.completedAt && (
        <span className="shrink-0">
          完成: {formatTimeFull(item.completedAt)}{" "}
          <span className="text-base-content/25">({formatRelative(item.completedAt)})</span>
        </span>
      )}
      <span className="shrink-0">
        Prompt: <span className="text-info">{promptTokens}</span>
      </span>
      <span className="shrink-0">
        Completion: <span className="text-success">{completionTokens}</span>
      </span>
      <span className="shrink-0">
        Total:{" "}
        <span className="font-semibold text-base-content/60">{totalTokens}</span>
      </span>
      {typeof item.durationMs === "number" && <span className="shrink-0">耗时: {item.durationMs}ms</span>}
      {item.apiKeyName && (
        <span className="shrink-0">
          密钥: <span className="text-base-content/60">{item.apiKeyName}</span>
        </span>
      )}
      {item.agentType && (
        <span className={`shrink-0 inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium leading-tight ${item.agentType === "openclaw" ? "bg-purple-500/15 text-purple-500 border-purple-500/20" : "bg-cyan-500/15 text-cyan-500 border-cyan-500/20"}`}>
          {item.agentType === "openclaw" ? "OpenClaw" : "Hermes"}
        </span>
      )}
      {item.upstreamUrl && (
        <span className="flex items-center gap-1 min-w-0 flex-1">
          <ExternalLink size={10} className="shrink-0" />
          <span className="mono truncate select-all">{item.upstreamUrl}</span>
        </span>
      )}
    </div>
  );
});
