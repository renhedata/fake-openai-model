import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { formatDistanceToNow, format } from "date-fns";
import { zhCN } from "date-fns/locale";
import {
  Activity,
  ArrowUpDown,
  Bot,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  ExternalLink,
  Hash,
  Loader2,
  Moon,
  Radio,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Shield,
  Square,
  Sun,
  Trash2,
  User,
  X,
  Zap,
  XCircle,
  Copy,
  Check,
  Server,
  Filter,
  Coins,
  MinusSquare,
  type LucideIcon
} from "lucide-react";

/* ========== types ========== */

type ProxyMode = "capture_only" | "forward";
type ApiType = "chat_completions" | "responses";

type ProxyConfig = {
  mode: ProxyMode;
  apiType: ApiType;
  baseUrl: string;
  path: string;
  apiKey: string;
  modelOverride: string;
};

type ExchangeRecord = {
  id: string;
  mode: ProxyMode;
  model: string;
  prompt: string;
  promptTokens: number;
  requestBody: unknown;
  createdAt: string;
  completedAt?: string;
  responseStatus: "pending" | "success" | "error";
  responseBody?: unknown;
  errorMessage?: string;
  upstreamUrl?: string;
  upstreamStatusCode?: number;
  durationMs?: number;
};

type ExchangeStats = {
  totalRequests: number;
  totalPromptTokens: number;
  totalForwarded: number;
  totalCaptureOnly: number;
};

type ModelRecord = { id: string; object: string; created: number; owned_by: string };

type DashboardState = {
  items: ExchangeRecord[];
  stats: ExchangeStats;
  config: ProxyConfig;
  models: ModelRecord[];
};

type DashboardEvent = {
  type: "snapshot" | "update";
  latest?: ExchangeRecord | null;
  state: DashboardState;
};

type UpstreamTestResult = {
  ok: boolean;
  apiType: ApiType;
  model: string;
  upstreamUrl: string;
  upstreamStatusCode: number;
  durationMs: number;
  preview: string;
  raw: unknown;
};

/* ========== helpers ========== */

const PAGE_SIZE = 40;
const apiTypeToPath = (t: ApiType) => (t === "responses" ? "/v1/responses" : "/v1/chat/completions");
const pathToApiType = (p: string): ApiType => (p.includes("/responses") ? "responses" : "chat_completions");

const normalizeConfig = (v?: Partial<ProxyConfig>): ProxyConfig => {
  const rawPath = v?.path ?? "/v1/chat/completions";
  const apiType = v?.apiType ?? pathToApiType(rawPath);
  return {
    mode: v?.mode ?? "capture_only",
    apiType,
    baseUrl: v?.baseUrl ?? "https://api.openai.com/v1",
    path: v?.path ?? apiTypeToPath(apiType),
    apiKey: v?.apiKey ?? "",
    modelOverride: v?.modelOverride ?? ""
  };
};

const defaultConfig: ProxyConfig = normalizeConfig();

const emptyState: DashboardState = {
  items: [],
  stats: { totalRequests: 0, totalPromptTokens: 0, totalForwarded: 0, totalCaptureOnly: 0 },
  config: defaultConfig,
  models: []
};

const formatTime = (iso: string) => format(new Date(iso), "MM-dd HH:mm:ss", { locale: zhCN });
const formatTimeFull = (iso: string) => format(new Date(iso), "yyyy-MM-dd HH:mm:ss", { locale: zhCN });
const formatRelative = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true, locale: zhCN });

const safeStringify = (v: unknown) => {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};

const getResponseText = (v: unknown): string => {
  if (!v || typeof v !== "object") return "";
  const r = v as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
    assistant?: string;
    content?: string;
    output_text?: string;
  };
  if (typeof r.assistant === "string") return r.assistant;
  if (typeof r.output_text === "string") return r.output_text;
  if (typeof r.content === "string") return r.content;
  const msg = r.choices?.[0]?.message;
  if (msg) {
    let text = "";
    if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
      text += `<think>\n${msg.reasoning_content}\n</think>\n\n`;
    }
    if (typeof msg.content === "string" && msg.content.trim()) {
      text += msg.content;
    }
    if (text.trim()) return text;
    // Handle tool_calls response
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      return msg.tool_calls
        .map((tc) => {
          const fn = tc.function;
          if (!fn) return "[tool_call]";
          return `[Tool Call] ${fn.name ?? "?"}(${fn.arguments ?? ""})`;
        })
        .join("\n");
    }
  }
  return "";
};

/** Extract completion tokens from response body */
const getCompletionTokens = (v: unknown): number => {
  if (!v || typeof v !== "object") return 0;
  const r = v as {
    usage?: { completion_tokens?: number; total_tokens?: number; prompt_tokens?: number };
    stream?: boolean;
    assistant?: string;
    content?: string;
  };
  if (r.usage?.completion_tokens && typeof r.usage.completion_tokens === "number") {
    return r.usage.completion_tokens;
  }
  // For streaming responses, estimate from content length
  if (r.stream) {
    const text = typeof r.assistant === "string" ? r.assistant : typeof r.content === "string" ? r.content : "";
    return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
  }
  // Try to estimate from response text
  const text = getResponseText(v);
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
};

const buildResponseMarkdown = (v: unknown) => {
  const t = getResponseText(v);
  return t.trim() ? t : `\`\`\`json\n${safeStringify(v ?? {})}\n\`\`\``;
};

type ChatMessage = { role: string; content: string; toolCalls?: Array<{ id?: string; name: string; arguments: string }>; toolCallId?: string; name?: string };

const extractMessages = (requestBody: unknown): ChatMessage[] => {
  if (!requestBody || typeof requestBody !== "object") return [];
  const body = requestBody as { messages?: Array<Record<string, unknown>> };
  if (!Array.isArray(body.messages)) return [];
  return body.messages.map((m) => {
    const role = typeof m.role === "string" ? m.role : "unknown";
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = (m.content as Array<Record<string, unknown>>)
        .map((part) => {
          if (typeof part === "string") return part;
          if (typeof part.text === "string") return part.text;
          if (typeof part.input_text === "string") return part.input_text;
          // Image URL parts
          if (part.type === "image_url" && part.image_url) {
            const url = typeof part.image_url === "string" ? part.image_url : (part.image_url as Record<string, unknown>).url;
            return `[Image: ${typeof url === "string" ? url.slice(0, 80) : "..."}]`;
          }
          return "";
        })
        .filter(Boolean)
        .join("");
    }
    // Extract tool_calls from assistant messages
    const toolCalls = Array.isArray(m.tool_calls)
      ? (m.tool_calls as Array<Record<string, unknown>>).map((tc) => {
          const fn = tc.function as Record<string, unknown> | undefined;
          return {
            id: typeof tc.id === "string" ? tc.id : undefined,
            name: typeof fn?.name === "string" ? fn.name : "unknown",
            arguments: typeof fn?.arguments === "string" ? fn.arguments : "",
          };
        })
      : undefined;
    const toolCallId = typeof m.tool_call_id === "string" ? m.tool_call_id : undefined;
    const name = typeof m.name === "string" ? m.name : undefined;
    return { role, content, toolCalls, toolCallId, name };
  });
};

const roleConfig: Record<string, { icon: LucideIcon; label: string; color: string; bgColor: string; borderColor: string }> = {
  system: { icon: Cpu, label: "System", color: "text-warning", bgColor: "bg-warning/5", borderColor: "border-warning/20" },
  user: { icon: User, label: "User", color: "text-info", bgColor: "bg-info/5", borderColor: "border-info/20" },
  assistant: { icon: Bot, label: "Assistant", color: "text-success", bgColor: "bg-success/5", borderColor: "border-success/20" },
  tool: { icon: Zap, label: "Tool", color: "text-secondary", bgColor: "bg-secondary/5", borderColor: "border-secondary/20" },
  function: { icon: Zap, label: "Function", color: "text-secondary", bgColor: "bg-secondary/5", borderColor: "border-secondary/20" },
};

const defaultRoleConfig = { icon: Hash, label: "Unknown", color: "text-base-content/50", bgColor: "bg-base-content/5", borderColor: "border-base-content/10" };

const truncate = (s: string, n = 120) => (s.length <= n ? s : `${s.slice(0, n)}…`);

/* ========== atoms ========== */

const StatusDot = ({ ok, label }: { ok: boolean; label: string }) => (
  <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${ok ? "text-success" : "text-error"}`}>
    <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-success animate-pulse" : "bg-error"}`} />
    {label}
  </span>
);

const Badge = ({ children, variant = "default" }: { children: React.ReactNode; variant?: "success" | "error" | "warning" | "info" | "default" }) => {
  const cls: Record<string, string> = {
    success: "bg-success/15 text-success border-success/20",
    error: "bg-error/15 text-error border-error/20",
    warning: "bg-warning/15 text-warning border-warning/20",
    info: "bg-info/15 text-info border-info/20",
    default: "bg-base-content/5 text-base-content/60 border-base-content/10"
  };
  return <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium leading-tight ${cls[variant]}`}>{children}</span>;
};

const CopyButton = ({ text }: { text: string }) => {
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

const StatMini = ({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number | string }) => (
  <div className="flex items-center gap-2 rounded-lg border border-base-content/5 bg-base-100 px-3 py-2">
    <Icon size={14} className="text-base-content/30 shrink-0" />
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-base-content/40">{label}</div>
      <div className="text-sm font-bold tabular-nums leading-tight">{value}</div>
    </div>
  </div>
);

const MarkdownSurface = ({ markdown }: { markdown: string }) => (
  <div className="markdown-body markdown-surface">
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
      {markdown}
    </ReactMarkdown>
  </div>
);

const RoleMessages = ({ messages }: { messages: ChatMessage[] }) => {
  const [expandedMsgs, setExpandedMsgs] = useState<Set<number>>(new Set());
  const toggleMsg = (idx: number) => setExpandedMsgs((prev) => {
    const next = new Set(prev);
    next.has(idx) ? next.delete(idx) : next.add(idx);
    return next;
  });

  const TRUNCATE_LEN = 200;

  return (
    <div className="space-y-1.5">
      {messages.map((msg, idx) => {
        const cfg = roleConfig[msg.role] ?? defaultRoleConfig;
        const Icon = cfg.icon;
        const isSystem = msg.role === "system";

        // Build display content: include tool_calls info for assistant, tool_call_id for tool messages
        let displayText = msg.content;
        if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
          const tcText = msg.toolCalls
            .map((tc) => `📎 ${tc.name}(${tc.arguments.length > 200 ? tc.arguments.slice(0, 200) + '…' : tc.arguments})`)
            .join("\n");
          displayText = displayText ? `${displayText}\n\n${tcText}` : tcText;
        }
        if (msg.role === "tool" && msg.toolCallId) {
          displayText = `[tool_call_id: ${msg.toolCallId}]${msg.name ? ` [name: ${msg.name}]` : ""}\n${displayText}`;
        }

        const isLong = displayText.length > TRUNCATE_LEN;
        const isExpanded = expandedMsgs.has(idx);
        const showContent = isSystem ? isExpanded : (!isLong || isExpanded);
        const shownContent = (!isSystem && isLong && !isExpanded)
          ? displayText.slice(0, TRUNCATE_LEN) + "…"
          : displayText;

        return (
          <div key={idx} className="group">
            {/* Role badge + toggle */}
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

            {/* Content */}
            {(isSystem && !showContent) ? (
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

/* ========== Exchange Row (with inline expand) ========== */

const ExchangeRow = memo(function ExchangeRow({
  item,
  serial,
  expanded,
  onToggle,
  selectMode,
  selected,
  onSelect
}: {
  item: ExchangeRecord;
  serial: number;
  expanded: boolean;
  onToggle: () => void;
  selectMode: boolean;
  selected: boolean;
  onSelect: (id: string, checked: boolean) => void;
}) {
  // Memoize messages extraction
  const messages = useMemo(() => extractMessages(item.requestBody), [item.requestBody]);

  // Show LAST user message in collapsed preview (not all messages concatenated)
  const lastUserMsg = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && messages[i].content.trim()) {
        return messages[i].content;
      }
    }
    return item.prompt;
  }, [messages, item.prompt]);

  const promptPreview = truncate(lastUserMsg || "(空)", 140);
  const responseText = getResponseText(item.responseBody);
  const responsePreview = truncate(responseText || safeStringify(item.responseBody ?? ""), 140);
  const completionTokens = getCompletionTokens(item.responseBody);
  const totalTokens = item.promptTokens + completionTokens;

  const responseMd = buildResponseMarkdown(item.responseBody);
  const statusVariant = item.responseStatus === "success" ? "success" : item.responseStatus === "error" ? "error" : "warning";

  return (
    <div className={`rounded-lg border transition-all ${selected ? "border-primary/40 bg-primary/[0.03]" : expanded ? "border-primary/30 bg-base-100 shadow-lg shadow-primary/5" : "border-base-content/5 bg-base-100 hover:border-base-content/10"}`}>
      {/* clickable summary row */}
      <div className="flex w-full items-center gap-2 px-3 py-2">
        {/* checkbox */}
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
          onClick={onToggle}
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

        <span className="mono shrink-0 text-[11px] text-base-content/50 w-24 truncate" title={item.model}>{item.model}</span>

        {/* tokens */}
        <span className="shrink-0 text-[10px] tabular-nums text-base-content/40" title={`入:${item.promptTokens} 出:${completionTokens} 总:${totalTokens}`}>
          <span className="text-info/60">{item.promptTokens}</span>
          <span className="text-base-content/20"> / </span>
          <span className="text-success/60">{completionTokens}</span>
          <span className="text-base-content/20"> tok</span>
        </span>

        {typeof item.durationMs === "number" && (
          <span className="shrink-0 text-[10px] tabular-nums text-base-content/30">{item.durationMs}ms</span>
        )}

        {typeof item.upstreamStatusCode === "number" && (
          <Badge variant={item.upstreamStatusCode < 400 ? "success" : "error"}>
            {item.upstreamStatusCode}
          </Badge>
        )}

        {/* prompt preview */}
        <span className="min-w-0 flex-1 truncate text-xs text-base-content/50">{promptPreview}</span>

        <span className="shrink-0 text-[10px] text-base-content/25" title={formatTimeFull(item.createdAt)}>
          {formatTime(item.createdAt)}
        </span>
        </button>
      </div>

      {/* expanded detail (inline, no modal) */}
      {expanded && (
        <div className="border-t border-base-content/5">
          {/* meta */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-[11px] text-base-content/40">
            <span>ID: <span className="mono">{item.id}</span></span>
            <span>创建: {formatTimeFull(item.createdAt)}</span>
            {item.completedAt && <span>完成: {formatTimeFull(item.completedAt)} ({formatRelative(item.completedAt)})</span>}
            <span>Prompt Tokens: <span className="text-info">{item.promptTokens}</span></span>
            <span>Completion Tokens: <span className="text-success">{completionTokens}</span></span>
            <span>Total: <span className="font-semibold text-base-content/60">{totalTokens}</span></span>
            {typeof item.durationMs === "number" && <span>耗时: {item.durationMs}ms</span>}
            {item.upstreamUrl && (
              <span className="flex items-center gap-1">
                <ExternalLink size={10} />
                <span className="mono">{item.upstreamUrl}</span>
              </span>
            )}
          </div>
          {item.errorMessage && (
            <div className="mx-4 mb-2 rounded bg-error/10 px-3 py-1.5 text-xs text-error">{item.errorMessage}</div>
          )}

          {/* prompt + response side by side */}
          <div className="grid gap-0 lg:grid-cols-2">
            <div className="border-t border-base-content/5 p-4 lg:border-r">
              <div className="mb-2 flex items-center justify-between">
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
              <div className="max-h-96 overflow-auto">
                {messages.length > 0
                  ? <RoleMessages messages={messages} />
                  : <div className="rounded-lg bg-base-200/50 p-3 text-sm leading-relaxed text-base-content/70 whitespace-pre-wrap">{item.prompt || "(空)"}</div>}
              </div>
            </div>

            <div className="border-t border-base-content/5 p-4">
              <div className="mb-2 flex items-center justify-between">
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
                <div className="max-h-64 overflow-auto">
                  <MarkdownSurface markdown={responseMd} />
                </div>
              )}
            </div>
          </div>

          {/* raw JSON toggle */}
          <details className="border-t border-base-content/5">
            <summary className="cursor-pointer px-4 py-2 text-[11px] text-base-content/30 hover:text-base-content/50 select-none">
              查看原始请求/响应 JSON
            </summary>
            <div className="grid gap-0 lg:grid-cols-2">
              <div className="p-4 lg:border-r border-base-content/5">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-base-content/30">Request Body</div>
                <pre className="max-h-48 overflow-auto rounded-lg bg-base-300 p-3 text-[11px] text-base-content/60 mono">{safeStringify(item.requestBody)}</pre>
              </div>
              <div className="p-4">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-base-content/30">Response Body</div>
                <pre className="max-h-48 overflow-auto rounded-lg bg-base-300 p-3 text-[11px] text-base-content/60 mono">{safeStringify(item.responseBody)}</pre>
              </div>
            </div>
          </details>
        </div>
      )}
    </div>
  );
});

/* ========== Settings Drawer (right slide-in) ========== */

const SettingsDrawer = memo(function SettingsDrawer({
  open, configForm, models, saving, isDirty, saveHint, lastSavedAt, saveError,
  syncingModels, syncSuccess, syncError, testingUpstream, testResult, testError,
  onClose, onConfigChange, onApiTypeChange, onRefreshModels, onRunTest
}: {
  open: boolean;
  configForm: ProxyConfig;
  models: ModelRecord[];
  saving: boolean;
  isDirty: boolean;
  saveHint: string;
  lastSavedAt: string;
  saveError: string;
  syncingModels: boolean;
  syncSuccess: string;
  syncError: string;
  testingUpstream: boolean;
  testResult: UpstreamTestResult | null;
  testError: string;
  onClose: () => void;
  onConfigChange: <K extends keyof ProxyConfig>(key: K, value: ProxyConfig[K]) => void;
  onApiTypeChange: (apiType: ApiType) => void;
  onRefreshModels: () => void;
  onRunTest: () => void;
}) {
  const [modelQuery, setModelQuery] = useState("");

  useEffect(() => { if (!open) setModelQuery(""); }, [open]);

  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const src = q ? models.filter((m) => m.id.toLowerCase().includes(q)) : models;
    return src.slice(0, 80);
  }, [models, modelQuery]);

  return (
    <>
      {/* backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-200 ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={onClose}
      />

      {/* drawer */}
      <aside
        className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-base-content/10 bg-base-200 shadow-2xl transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* header */}
        <div className="flex shrink-0 items-center justify-between border-b border-base-content/5 px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <Settings2 size={16} /> 配置
          </h3>
          <button className="btn btn-ghost btn-sm btn-circle h-7 w-7 min-h-0" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>

        {/* scrollable body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* mode */}
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-base-content/40">模式</label>
            <div className="grid grid-cols-2 gap-2">
              {(["capture_only", "forward"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                    configForm.mode === m
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-base-content/10 text-base-content/50 hover:border-base-content/20"
                  }`}
                  onClick={() => onConfigChange("mode", m)}
                >
                  {m === "capture_only" ? (
                    <span className="flex items-center justify-center gap-1.5"><Shield size={12} /> 仅捕获</span>
                  ) : (
                    <span className="flex items-center justify-center gap-1.5"><ArrowUpDown size={12} /> 转发</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* api type + base url in one row */}
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-base-content/40">API</label>
              <select
                className="select select-bordered select-sm w-full bg-base-100 text-xs"
                value={configForm.apiType}
                onChange={(e) => onApiTypeChange(e.target.value as ApiType)}
              >
                <option value="chat_completions">Chat</option>
                <option value="responses">Responses</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-base-content/40">Base URL</label>
              <input
                className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                value={configForm.baseUrl}
                onChange={(e) => onConfigChange("baseUrl", e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </div>
          </div>

          {/* api key */}
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-base-content/40">API Key</label>
            <input
              className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
              type="password"
              value={configForm.apiKey}
              onChange={(e) => onConfigChange("apiKey", e.target.value)}
              placeholder="sk-..."
            />
          </div>

          {/* model override */}
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-base-content/40">模型覆盖</label>
            <input
              className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
              value={configForm.modelOverride}
              onChange={(e) => onConfigChange("modelOverride", e.target.value)}
              placeholder="留空则使用请求中的模型"
            />
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                className="input input-bordered input-sm flex-1 bg-base-100 text-xs"
                value={modelQuery}
                onChange={(e) => setModelQuery(e.target.value)}
                placeholder="🔍 搜索模型…"
              />
              <span className="shrink-0 text-[10px] text-base-content/30">{models.length}</span>
            </div>
            <div className="mt-1.5 max-h-24 overflow-auto rounded-lg border border-base-content/5 bg-base-100 p-1.5">
              {filteredModels.length === 0 ? (
                <p className="py-1 text-center text-[10px] text-base-content/30">无模型</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {filteredModels.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                        configForm.modelOverride === m.id
                          ? "border-primary bg-primary/15 text-primary"
                          : "border-base-content/10 text-base-content/50 hover:border-primary/30 hover:text-primary"
                      }`}
                      onClick={() => onConfigChange("modelOverride", m.id)}
                    >
                      {m.id}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* actions */}
          <div className="grid grid-cols-2 gap-2">
            <button className="btn btn-outline btn-sm gap-1.5 text-xs" onClick={onRefreshModels} disabled={syncingModels} type="button">
              <RefreshCw size={12} className={syncingModels ? "animate-spin" : ""} />
              {syncingModels ? "同步…" : "同步模型"}
            </button>
            <button className="btn btn-outline btn-sm gap-1.5 text-xs" onClick={onRunTest} disabled={testingUpstream} type="button">
              <Activity size={12} className={testingUpstream ? "animate-pulse" : ""} />
              {testingUpstream ? "测试…" : "测试连接"}
            </button>
          </div>

          {/* feedback */}
          <div className="space-y-1.5 text-[11px]">
            <div className="flex items-center gap-1.5 text-base-content/35">
              {saving ? <><Loader2 size={10} className="animate-spin" /> 保存中…</>
                : saveHint ? <><CheckCircle2 size={10} className="text-success" /> {saveHint}</>
                : "自动保存"}
              {!saving && !isDirty && lastSavedAt && <span>· {formatTimeFull(lastSavedAt)}</span>}
            </div>
            {syncSuccess && <p className="rounded bg-success/10 px-2 py-1 text-success">{syncSuccess}</p>}
            {syncError && <p className="rounded bg-error/10 px-2 py-1 text-error">{syncError}</p>}
            {saveError && <p className="rounded bg-error/10 px-2 py-1 text-error">{saveError}</p>}
            {testError && <p className="rounded bg-error/10 px-2 py-1 text-error">{testError}</p>}
            {testResult && (
              <div className={`rounded-lg border p-2.5 ${testResult.ok ? "border-success/20 bg-success/5" : "border-error/20 bg-error/5"}`}>
                <p className="font-semibold">
                  {testResult.ok ? <CheckCircle2 size={11} className="inline text-success" /> : <XCircle size={11} className="inline text-error" />}
                  {" "}HTTP {testResult.upstreamStatusCode} · {testResult.durationMs}ms
                </p>
                <p className="mt-0.5 font-mono text-base-content/40 text-[10px] break-all">{testResult.upstreamUrl}</p>
                <p className="text-base-content/50">model: {testResult.model}</p>
                {testResult.preview && <p className="mt-1 whitespace-pre-wrap text-base-content/60">{testResult.preview}</p>}
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
});

/* ========== App ========== */

export const App = () => {
  const [dashboard, setDashboard] = useState<DashboardState>(emptyState);
  const [configForm, setConfigForm] = useState<ProxyConfig>(defaultConfig);
  const [connected, setConnected] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveHint, setSaveHint] = useState("");
  const [lastSavedAt, setLastSavedAt] = useState("");

  const [syncingModels, setSyncingModels] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [syncSuccess, setSyncSuccess] = useState("");

  const [testingUpstream, setTestingUpstream] = useState(false);
  const [testError, setTestError] = useState("");
  const [testResult, setTestResult] = useState<UpstreamTestResult | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "error" | "pending">("all");

  /* selection */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  /* theme */
  const [theme, setTheme] = useState<"light" | "business">(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "business") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "business" : "light";
  });
  const isDark = theme === "business";
  const toggleTheme = useCallback(() => {
    const next = isDark ? "light" : "business";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
  }, [isDark]);

  const dirtyRef = useRef(false);
  const lastSavedSignatureRef = useRef(JSON.stringify(defaultConfig));

  /* SSE */
  useEffect(() => {
    const es = new EventSource("/events/prompts");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as DashboardEvent;
        const ns = data.state ?? emptyState;
        const nc = normalizeConfig(ns.config);
        setDashboard({ ...ns, config: nc });
        if (!dirtyRef.current) {
          setConfigForm(nc);
          lastSavedSignatureRef.current = JSON.stringify(nc);
        }
      } catch { setConnected(false); }
    };
    return () => { es.close(); setConnected(false); };
  }, []);

  /* filter + search */
  const filteredItems = useMemo(() => {
    let items = dashboard.items;
    if (statusFilter !== "all") {
      items = items.filter((i) => i.responseStatus === statusFilter);
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      items = items.filter((i) =>
        i.prompt.toLowerCase().includes(q) ||
        i.model.toLowerCase().includes(q) ||
        i.id.toLowerCase().includes(q) ||
        (i.errorMessage ?? "").toLowerCase().includes(q) ||
        getResponseText(i.responseBody).toLowerCase().includes(q)
      );
    }
    return items;
  }, [dashboard.items, statusFilter, searchQuery]);

  const visibleItems = useMemo(() => filteredItems.slice(0, visibleCount), [filteredItems, visibleCount]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [searchQuery, statusFilter]);

  /* compute total completion tokens */
  const totalCompletionTokens = useMemo(
    () => dashboard.items.reduce((sum, i) => sum + getCompletionTokens(i.responseBody), 0),
    [dashboard.items]
  );

  /* helpers */
  const readErrorMessage = useCallback(async (r: Response) => {
    const raw = await r.text();
    if (!raw) return "请求失败";
    try {
      const p = JSON.parse(raw) as { error?: { message?: string; detail?: string } };
      if (p?.error?.detail) return `${p.error.message ?? "请求失败"}: ${p.error.detail}`;
      if (p?.error?.message) return p.error.message;
      return raw;
    } catch { return raw; }
  }, []);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setIsDirty(true);
    setSaveError("");
    setSaveHint("已修改…");
  }, []);

  const onConfigChange = useCallback(<K extends keyof ProxyConfig>(key: K, value: ProxyConfig[K]) => {
    setConfigForm((p) => ({ ...p, [key]: value }));
    markDirty();
  }, [markDirty]);

  const onApiTypeChange = useCallback((apiType: ApiType) => {
    setConfigForm((p) => ({ ...p, apiType, path: apiTypeToPath(apiType) }));
    markDirty();
  }, [markDirty]);

  const saveConfig = useCallback(async (nc: ProxyConfig) => {
    const sig = JSON.stringify(nc);
    if (sig === lastSavedSignatureRef.current) {
      dirtyRef.current = false; setIsDirty(false); setSaveHint("已保存"); return true;
    }
    setSaving(true); setSaveError("");
    try {
      const r = await fetch("/proxy/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(nc) });
      if (!r.ok) throw new Error(await readErrorMessage(r));
      const updated = normalizeConfig((await r.json()) as ProxyConfig);
      setConfigForm(updated);
      setDashboard((p) => ({ ...p, config: updated }));
      lastSavedSignatureRef.current = JSON.stringify(updated);
      dirtyRef.current = false; setIsDirty(false);
      setLastSavedAt(new Date().toISOString());
      setSaveHint("已保存");
      return true;
    } catch (e) { setSaveError(e instanceof Error ? e.message : "保存失败"); setSaveHint(""); return false; }
    finally { setSaving(false); }
  }, [readErrorMessage]);

  useEffect(() => {
    if (!isDirty) return;
    const t = window.setTimeout(() => void saveConfig(configForm), 800);
    return () => window.clearTimeout(t);
  }, [configForm, isDirty, saveConfig]);

  const refreshUpstreamModels = useCallback(async () => {
    setSyncingModels(true); setSyncError(""); setSyncSuccess("");
    if (dirtyRef.current) { if (!(await saveConfig(configForm))) { setSyncingModels(false); return; } }
    try {
      const r = await fetch("/proxy/models/refresh", { method: "POST" });
      if (!r.ok) throw new Error(await readErrorMessage(r));
      const payload = (await r.json()) as { data?: ModelRecord[] };
      const m = payload.data ?? [];
      setDashboard((p) => ({ ...p, models: m }));
      setSyncSuccess(`已同步 ${m.length} 个模型`);
      if (configForm.modelOverride && !m.some((x) => x.id === configForm.modelOverride)) onConfigChange("modelOverride", "");
    } catch (e) { setSyncError(e instanceof Error ? e.message : "同步失败"); }
    finally { setSyncingModels(false); }
  }, [configForm, onConfigChange, readErrorMessage, saveConfig]);

  const runUpstreamTest = useCallback(async () => {
    setTestingUpstream(true); setTestError(""); setTestResult(null);
    if (dirtyRef.current) { if (!(await saveConfig(configForm))) { setTestingUpstream(false); return; } }
    try {
      const r = await fetch("/proxy/test", { method: "POST" });
      if (!r.ok) throw new Error(await readErrorMessage(r));
      setTestResult((await r.json()) as UpstreamTestResult);
    } catch (e) { setTestError(e instanceof Error ? e.message : "测试失败"); }
    finally { setTestingUpstream(false); }
  }, [configForm, readErrorMessage, saveConfig]);

  const onListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const t = e.currentTarget;
    if (t.scrollTop + t.clientHeight < t.scrollHeight - 200) return;
    setVisibleCount((p) => Math.min(p + PAGE_SIZE, filteredItems.length));
  }, [filteredItems.length]);

  /* selection helpers */
  const onSelectItem = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      checked ? next.add(id) : next.delete(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(filteredItems.map((i) => i.id)));
  }, [filteredItems]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const toggleSelectMode = useCallback(() => {
    setSelectMode((p) => {
      if (p) setSelectedIds(new Set());
      return !p;
    });
  }, []);

  const deleteSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setDeleting(true);
    try {
      const r = await fetch("/exchanges", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedIds) })
      });
      if (!r.ok) throw new Error("删除失败");
      setSelectedIds(new Set());
    } catch (e) {
      console.error(e);
    } finally {
      setDeleting(false);
    }
  }, [selectedIds]);

  const deleteAll = useCallback(async () => {
    if (!window.confirm("确定要删除所有记录吗？此操作不可恢复。")) return;
    setDeleting(true);
    try {
      const r = await fetch("/exchanges", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true })
      });
      if (!r.ok) throw new Error("删除失败");
      setSelectedIds(new Set());
      setSelectMode(false);
    } catch (e) {
      console.error(e);
    } finally {
      setDeleting(false);
    }
  }, []);

  const { stats } = dashboard;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* ── top bar ── */}
      <header className="z-30 flex shrink-0 items-center justify-between border-b border-base-content/5 bg-base-300 px-4 py-2">
        <div className="flex items-center gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-primary">
            <Server size={15} />
          </div>
          <h1 className="text-sm font-bold">Fake Model Gateway</h1>

          <div className="hidden items-center gap-2 sm:flex">
            <Badge variant={dashboard.config.mode === "forward" ? "info" : "default"}>
              {dashboard.config.mode === "forward" ? "Forward" : "Capture"}
            </Badge>
            <StatusDot ok={connected} label={connected ? "Live" : "Off"} />
          </div>
        </div>

        {/* mini stats in header */}
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-3 text-[10px] tabular-nums text-base-content/40 lg:flex">
            <span title="总请求"><Activity size={10} className="inline" /> {stats.totalRequests}</span>
            <span title="Prompt Tokens" className="text-info/60"><Send size={10} className="inline" /> {stats.totalPromptTokens.toLocaleString()}</span>
            <span title="Completion Tokens" className="text-success/60"><Zap size={10} className="inline" /> {totalCompletionTokens.toLocaleString()}</span>
            <span title="总 Tokens"><Coins size={10} className="inline" /> {(stats.totalPromptTokens + totalCompletionTokens).toLocaleString()}</span>
          </div>
          <button
            className="btn btn-ghost btn-sm btn-circle h-7 w-7 min-h-0"
            onClick={toggleTheme}
            title={isDark ? "切换亮色模式" : "切换暗色模式"}
          >
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <button className="btn btn-primary btn-sm gap-1.5 h-7 min-h-0 text-xs" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={13} /> 配置
          </button>
        </div>
      </header>

      {/* ── stats row (mobile visible) ── */}
      <div className="shrink-0 grid grid-cols-2 gap-2 border-b border-base-content/5 bg-base-300/50 px-4 py-2 sm:grid-cols-4 lg:grid-cols-6">
        <StatMini icon={Activity} label="请求" value={stats.totalRequests} />
        <StatMini icon={Send} label="入 Tokens" value={stats.totalPromptTokens.toLocaleString()} />
        <StatMini icon={Zap} label="出 Tokens" value={totalCompletionTokens.toLocaleString()} />
        <StatMini icon={Coins} label="总 Tokens" value={(stats.totalPromptTokens + totalCompletionTokens).toLocaleString()} />
        <StatMini icon={ArrowUpDown} label="转发" value={stats.totalForwarded} />
        <StatMini icon={Shield} label="捕获" value={stats.totalCaptureOnly} />
      </div>

      {/* ── search + filter bar ── */}
      <div className="shrink-0 flex items-center gap-2 border-b border-base-content/5 bg-base-300/30 px-4 py-2">
        {/* select mode toggle */}
        <button
          type="button"
          className={`btn btn-ghost btn-xs gap-1 h-6 min-h-0 ${selectMode ? "text-primary" : "text-base-content/40"}`}
          onClick={toggleSelectMode}
          title={selectMode ? "退出选择" : "选择模式"}
        >
          {selectMode ? <CheckSquare size={13} /> : <Square size={13} />}
        </button>

        {/* selection toolbar (shown when selectMode is on) */}
        {selectMode && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="text-[10px] text-base-content/50 hover:text-base-content/70 transition-colors px-1.5 py-0.5 rounded hover:bg-base-content/5"
              onClick={selectedIds.size === filteredItems.length ? deselectAll : selectAll}
            >
              {selectedIds.size === filteredItems.length ? (
                <span className="flex items-center gap-1"><MinusSquare size={10} /> 取消全选</span>
              ) : (
                <span className="flex items-center gap-1"><CheckSquare size={10} /> 全选</span>
              )}
            </button>
            {selectedIds.size > 0 && (
              <>
                <span className="text-[10px] tabular-nums text-primary font-medium">
                  已选 {selectedIds.size}
                </span>
                <button
                  type="button"
                  className="btn btn-error btn-xs gap-1 h-5 min-h-0 text-[10px]"
                  onClick={deleteSelected}
                  disabled={deleting}
                >
                  <Trash2 size={10} />
                  {deleting ? "删除中…" : "删除选中"}
                </button>
              </>
            )}
            <span className="text-base-content/10">|</span>
            <button
              type="button"
              className="text-[10px] text-error/50 hover:text-error transition-colors px-1.5 py-0.5 rounded hover:bg-error/5 flex items-center gap-1"
              onClick={deleteAll}
              disabled={deleting || dashboard.items.length === 0}
            >
              <Trash2 size={10} /> 清空全部
            </button>
          </div>
        )}

        {!selectMode && (
          <>
            <div className="relative flex-1 max-w-md">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-base-content/30" />
              <input
                className="input input-bordered input-sm w-full bg-base-100 pl-8 text-xs"
                placeholder="搜索 prompt, model, response …"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-base-content/30 hover:text-base-content/60"
                  onClick={() => setSearchQuery("")}
                  type="button"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Filter size={12} className="text-base-content/30" />
              {(["all", "success", "error", "pending"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`rounded border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    statusFilter === s
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-base-content/10 text-base-content/40 hover:text-base-content/60"
                  }`}
                  onClick={() => setStatusFilter(s)}
                >
                  {s === "all" ? "全部" : s}
                </button>
              ))}
            </div>
          </>
        )}
        <span className="text-[10px] text-base-content/25 tabular-nums ml-auto">
          {filteredItems.length === dashboard.items.length
            ? `${dashboard.items.length} 条`
            : `${filteredItems.length} / ${dashboard.items.length}`}
        </span>
      </div>

      {/* ── exchange list (fills remaining viewport) ── */}
      <div className="flex-1 overflow-y-auto" onScroll={onListScroll}>
        <div className="mx-auto max-w-[1600px] space-y-1 p-3">
          {visibleItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-base-content/25">
              <Radio size={28} className="mb-2 opacity-30" />
              <p className="text-sm">{searchQuery || statusFilter !== "all" ? "无匹配记录" : "等待请求中…"}</p>
            </div>
          ) : (
            visibleItems.map((item, idx) => {
              const serial = statusFilter === "all" && !searchQuery
                ? dashboard.items.length - idx
                : filteredItems.length - idx;
              return (
                <ExchangeRow
                  key={item.id}
                  item={item}
                  serial={serial}
                  expanded={expandedId === item.id}
                  onToggle={() => setExpandedId((p) => (p === item.id ? null : item.id))}
                  selectMode={selectMode}
                  selected={selectedIds.has(item.id)}
                  onSelect={onSelectItem}
                />
              );
            })
          )}
          {visibleItems.length < filteredItems.length && (
            <div className="flex justify-center py-2">
              <button className="btn btn-ghost btn-sm gap-1.5 text-xs" onClick={() => setVisibleCount((p) => Math.min(p + PAGE_SIZE, filteredItems.length))}>
                <ChevronDown size={12} /> 加载更多 ({filteredItems.length - visibleItems.length})
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── settings drawer ── */}
      <SettingsDrawer
        open={settingsOpen}
        configForm={configForm}
        models={dashboard.models}
        saving={saving}
        isDirty={isDirty}
        saveHint={saveHint}
        lastSavedAt={lastSavedAt}
        saveError={saveError}
        syncingModels={syncingModels}
        syncSuccess={syncSuccess}
        syncError={syncError}
        testingUpstream={testingUpstream}
        testResult={testResult}
        testError={testError}
        onClose={() => setSettingsOpen(false)}
        onConfigChange={onConfigChange}
        onApiTypeChange={onApiTypeChange}
        onRefreshModels={refreshUpstreamModels}
        onRunTest={runUpstreamTest}
      />
    </div>
  );
};
