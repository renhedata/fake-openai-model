import { memo } from "react";
import { Loader2, Zap } from "lucide-react";
import { CopyButton, MarkdownSurface } from "../Atoms";
import { ThinkingBlock } from "./ThinkingBlock";
import { getResponseText, safeStringify } from "../../utils";

export const ResponsePanel = memo(function ResponsePanel({
  responseStatus,
  responseBody,
  reasoningText,
  responseMd,
}: {
  responseStatus: "pending" | "success" | "error";
  responseBody?: unknown;
  reasoningText: string;
  responseMd: string;
}) {
  const responseText = getResponseText(responseBody);
  const copyText = responseText || safeStringify(responseBody ?? "");

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-base-content/40">
          <Zap size={11} /> Response
        </span>
        <CopyButton text={copyText} />
      </div>
      {responseStatus === "pending" ? (
        <p className="flex items-center gap-2 text-sm text-base-content/40">
          <Loader2 size={14} className="animate-spin" /> 等待响应…
        </p>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          {reasoningText && <ThinkingBlock reasoningText={reasoningText} />}
          <MarkdownSurface markdown={responseMd} />
        </div>
      )}
    </div>
  );
});
