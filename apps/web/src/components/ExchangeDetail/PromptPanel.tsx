import { memo, useMemo, useState } from "react";
import { ArrowDownUp, Send } from "lucide-react";
import { CopyButton } from "../Atoms";
import { RoleMessages } from "../RoleMessages";
import type { ChatMessage } from "../../types";

export const PromptPanel = memo(function PromptPanel({
  messages,
  prompt,
}: {
  messages: ChatMessage[];
  prompt: string;
}) {
  const lastUserMsg = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && messages[i].content.trim()) {
        return messages[i].content;
      }
    }
    return prompt;
  }, [messages, prompt]);

  // Default to newest-first so the latest turn is visible without scrolling.
  const [reverse, setReverse] = useState(true);
  const orderedMessages = useMemo(
    () => (reverse ? [...messages].reverse() : messages),
    [messages, reverse]
  );

  return (
    <div className="border-b border-base-content/5 p-4 lg:border-b-0 lg:border-r">
      <div className="mb-3 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-base-content/40">
          <Send size={11} /> Prompt
          {messages.length > 0 && (
            <span className="font-normal normal-case tracking-normal text-base-content/25">
              ({messages.length} 条消息)
            </span>
          )}
        </span>
        <div className="flex items-center gap-2">
          {messages.length > 1 && (
            <button
              type="button"
              onClick={() => setReverse((r) => !r)}
              className="flex items-center gap-1 rounded border border-base-content/10 px-1.5 py-0.5 text-[10px] font-medium text-base-content/40 transition-colors hover:border-base-content/20 hover:text-base-content/70"
              title="切换消息顺序"
            >
              <ArrowDownUp size={10} /> {reverse ? "倒序" : "正序"}
            </button>
          )}
          <CopyButton text={lastUserMsg} />
        </div>
      </div>
      <div className="max-h-[60vh] overflow-y-auto pr-1">
        {messages.length > 0 ? (
          <RoleMessages messages={orderedMessages} />
        ) : (
          <div className="rounded-lg bg-base-200/50 p-3 text-sm leading-relaxed text-base-content/70 whitespace-pre-wrap">
            {prompt || "(空)"}
          </div>
        )}
      </div>
    </div>
  );
});
