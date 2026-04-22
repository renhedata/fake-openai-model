import { memo } from "react";
import { Brain } from "lucide-react";
import { MarkdownSurface } from "../Atoms";

export const ThinkingBlock = memo(function ThinkingBlock({
  reasoningText,
}: {
  reasoningText: string;
}) {
  return (
    <details className="mb-3 rounded-lg border border-base-content/8 bg-base-200/60 text-xs transition-colors hover:border-base-content/15">
      <summary className="cursor-pointer select-none px-3 py-1.5 text-[11px] text-base-content/40 hover:text-base-content/60 transition-colors flex items-center gap-1.5">
        <Brain size={10} />
        思考过程 ({reasoningText.length} 字符)
      </summary>
      <div className="max-h-64 overflow-y-auto border-t border-base-content/5 px-3 py-2">
        <MarkdownSurface markdown={reasoningText} />
      </div>
    </details>
  );
});
