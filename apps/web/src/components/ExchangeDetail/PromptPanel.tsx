import { memo, useMemo } from "react";
import { Send } from "lucide-react";
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
        <CopyButton text={lastUserMsg} />
      </div>
      <div className="max-h-[60vh] overflow-y-auto pr-1">
        {messages.length > 0 ? (
          <RoleMessages messages={messages} />
        ) : (
          <div className="rounded-lg bg-base-200/50 p-3 text-sm leading-relaxed text-base-content/70 whitespace-pre-wrap">
            {prompt || "(空)"}
          </div>
        )}
      </div>
    </div>
  );
});
