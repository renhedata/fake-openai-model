import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { Check, Copy, type LucideIcon } from "lucide-react";

export const StatusDot = ({ ok, label }: { ok: boolean; label: string }) => (
  <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium transition-colors duration-300 ${ok ? "text-success" : "text-error"}`}>
    <span className={`h-1.5 w-1.5 rounded-full transition-colors duration-300 ${ok ? "bg-success animate-live-pulse" : "bg-error"}`} />
    {label}
  </span>
);

export const Badge = ({ children, variant = "default" }: { children: React.ReactNode; variant?: "success" | "error" | "warning" | "info" | "default" }) => {
  const cls: Record<string, string> = {
    success: "bg-success/15 text-success border-success/20",
    error: "bg-error/15 text-error border-error/20",
    warning: "bg-warning/15 text-warning border-warning/20",
    info: "bg-info/15 text-info border-info/20",
    default: "bg-base-content/5 text-base-content/60 border-base-content/10",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium leading-tight transition-all duration-200 ${cls[variant]}`}>
      {children}
    </span>
  );
};

export const CopyButton = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button onClick={copy} className="btn btn-ghost btn-xs gap-1 h-6 min-h-0" type="button" title="复制">
      {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
    </button>
  );
};

export const StatMini = ({ icon: Icon, label, value, delay = 0 }: { icon: LucideIcon; label: string; value: number | string; delay?: number }) => (
  <div
    className="flex items-center gap-2 rounded-lg border border-base-content/5 bg-base-100 px-3 py-2 animate-stat-reveal hover:border-base-content/10 hover:shadow-sm transition-all duration-200"
    style={{ animationDelay: `${delay}ms` }}
  >
    <Icon size={14} className="text-base-content/30 shrink-0" />
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-base-content/40">{label}</div>
      <div className="text-sm font-bold tabular-nums leading-tight">{value}</div>
    </div>
  </div>
);

export const MarkdownSurface = memo(function MarkdownSurface({ markdown }: { markdown: string }) {
  return (
    <div className="markdown-body markdown-surface">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
});
