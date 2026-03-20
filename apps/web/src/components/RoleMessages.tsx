import { useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { Bot, Cpu, Hash, User, Zap, type LucideIcon } from "lucide-react";
import type { ChatMessage } from "../types";

const roleConfig: Record<string, { icon: LucideIcon; label: string; color: string; bgColor: string; borderColor: string }> = {
  system:    { icon: Cpu,  label: "System",    color: "text-warning",          bgColor: "bg-warning/5",          borderColor: "border-warning/20" },
  user:      { icon: User, label: "User",      color: "text-info",             bgColor: "bg-info/5",             borderColor: "border-info/20" },
  assistant: { icon: Bot,  label: "Assistant", color: "text-success",          bgColor: "bg-success/5",          borderColor: "border-success/20" },
  tool:      { icon: Zap,  label: "Tool",      color: "text-secondary",        bgColor: "bg-secondary/5",        borderColor: "border-secondary/20" },
  function:  { icon: Zap,  label: "Function",  color: "text-secondary",        bgColor: "bg-secondary/5",        borderColor: "border-secondary/20" },
};

const defaultRoleConfig = { icon: Hash, label: "Unknown", color: "text-base-content/50", bgColor: "bg-base-content/5", borderColor: "border-base-content/10" };

const TRUNCATE_LEN = 200;

export const RoleMessages = ({ messages }: { messages: ChatMessage[] }) => {
  const [expandedMsgs, setExpandedMsgs] = useState<Set<number>>(new Set());
  const toggleMsg = (idx: number) => setExpandedMsgs((prev) => {
    const next = new Set(prev);
    next.has(idx) ? next.delete(idx) : next.add(idx);
    return next;
  });

  return (
    <div className="space-y-1.5">
      {messages.map((msg, idx) => {
        const cfg = roleConfig[msg.role] ?? defaultRoleConfig;
        const Icon = cfg.icon;
        const isSystem = msg.role === "system";

        let displayText = msg.content;
        if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
          const tcText = msg.toolCalls
            .map((tc) => `📎 ${tc.name}(${tc.arguments.length > 200 ? tc.arguments.slice(0, 200) + "…" : tc.arguments})`)
            .join("\n");
          displayText = displayText ? `${displayText}\n\n${tcText}` : tcText;
        }
        if (msg.role === "tool" && msg.toolCallId) {
          displayText = `[tool_call_id: ${msg.toolCallId}]${msg.name ? ` [name: ${msg.name}]` : ""}\n${displayText}`;
        }

        const isLong = displayText.length > TRUNCATE_LEN;
        const isExpanded = expandedMsgs.has(idx);
        const showContent = isSystem ? isExpanded : (!isLong || isExpanded);
        const shownContent = !isSystem && isLong && !isExpanded
          ? displayText.slice(0, TRUNCATE_LEN) + "…"
          : displayText;

        return (
          <div key={idx} className="group">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cfg.color} ${cfg.bgColor}`}>
                <Icon size={10} />
                {cfg.label}
                {msg.name && <span className="font-normal normal-case">({msg.name})</span>}
              </span>
              {(isSystem || isLong) && (
                <button
                  type="button"
                  className="text-[10px] text-base-content/30 hover:text-base-content/50 transition-colors"
                  onClick={() => toggleMsg(idx)}
                >
                  {isSystem
                    ? (isExpanded ? "收起" : `展开 (${displayText.length} 字)`)
                    : (isExpanded ? "收起" : "展开全部")}
                </button>
              )}
            </div>

            {isSystem && !showContent ? (
              <div
                className="pl-2 border-l-2 border-base-content/5 cursor-pointer hover:border-base-content/15 transition-colors"
                onClick={() => toggleMsg(idx)}
              >
                <p className="text-xs text-base-content/35 truncate italic">
                  {displayText.slice(0, 80)}…
                </p>
              </div>
            ) : (
              <div className={`pl-2 border-l-2 ${cfg.borderColor}`}>
                <div className="markdown-body text-[13px] leading-relaxed text-base-content/70">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {shownContent || "(空)"}
                  </ReactMarkdown>
                </div>
                {!isSystem && isLong && !isExpanded && (
                  <button
                    type="button"
                    className="text-[11px] text-primary/60 hover:text-primary mt-0.5 transition-colors"
                    onClick={() => toggleMsg(idx)}
                  >
                    显示全部 →
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
