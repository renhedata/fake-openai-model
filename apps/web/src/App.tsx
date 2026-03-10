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
  Calendar,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
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

type PaginatedResult = {
  items: ExchangeRecord[];
  nextCursor: string | null;
  total: number;
};

/* ========== helpers ========== */

const PAGE_SIZE = 50;
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
  <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium transition-colors duration-300 ${ok ? "text-success" : "text-error"}`}>
    <span className={`h-1.5 w-1.5 rounded-full transition-colors duration-300 ${ok ? "bg-success animate-live-pulse" : "bg-error"}`} />
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
  return <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium leading-tight transition-all duration-200 ${cls[variant]}`}>{children}</span>;
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

const StatMini = ({ icon: Icon, label, value, delay = 0 }: { icon: LucideIcon; label: string; value: number | string; delay?: number }) => (
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
    <div className={`rounded-lg border transition-all duration-200 ${selected ? "border-primary/40 bg-primary/[0.03]" : expanded ? "border-primary/30 bg-base-100 shadow-lg shadow-primary/5" : "border-base-content/5 bg-base-100 hover:border-base-content/10 hover:shadow-sm"}`}>
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
        <div className="border-t border-base-content/5 animate-expand-in">
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

/* ========== DatePicker Dropdown ========== */

const WEEKDAYS = ["\u65e5", "\u4e00", "\u4e8c", "\u4e09", "\u56db", "\u4e94", "\u516d"];

/** pad to 2 digits */
const p2 = (n: number) => String(n).padStart(2, "0");
/** Date → YYYY-MM-DD */
const toDateStr = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

interface DatePickerDropdownProps {
  dateFrom: string;
  dateTo: string;
  setDateFrom: (v: string) => void;
  setDateTo: (v: string) => void;
  presets: { label: string; from: string; to: string }[];
  activePresetLabel: string | null;
  applyPreset: (from: string, to: string) => void;
  clearDateFilter: () => void;
  close: () => void;
  hasDateFilter: boolean;
}

const DatePickerDropdown = ({
  dateFrom, dateTo, setDateFrom, setDateTo,
  presets, activePresetLabel, applyPreset, clearDateFilter, close, hasDateFilter,
}: DatePickerDropdownProps) => {
  // Calendar state
  const today = useMemo(() => new Date(), []);
  const todayStr = useMemo(() => toDateStr(today), [today]);
  const [viewYear, setViewYear] = useState(() => {
    if (dateFrom) { const [y] = dateFrom.split("-"); return Number(y); }
    return today.getFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    if (dateFrom) { const parts = dateFrom.split("-"); return Number(parts[1]) - 1; }
    return today.getMonth();
  });

  // Selection state: "idle" | "picking" (one date already clicked, waiting for second)
  const [pickStart, setPickStart] = useState<string | null>(null);
  const [hoverDate, setHoverDate] = useState<string | null>(null);

  const prevMonth = useCallback(() => {
    setViewMonth((m) => { if (m === 0) { setViewYear((y) => y - 1); return 11; } return m - 1; });
  }, []);
  const nextMonth = useCallback(() => {
    setViewMonth((m) => { if (m === 11) { setViewYear((y) => y + 1); return 0; } return m + 1; });
  }, []);

  // Build calendar grid for current view month
  const calendarDays = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1);
    const startDow = firstDay.getDay(); // 0=Sun
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

    const cells: { date: string; day: number; inMonth: boolean }[] = [];

    // Previous month fill
    if (startDow > 0) {
      const prevMonthDays = new Date(viewYear, viewMonth, 0).getDate();
      for (let i = startDow - 1; i >= 0; i--) {
        const d = prevMonthDays - i;
        const m = viewMonth === 0 ? 11 : viewMonth - 1;
        const y = viewMonth === 0 ? viewYear - 1 : viewYear;
        cells.push({ date: `${y}-${p2(m + 1)}-${p2(d)}`, day: d, inMonth: false });
      }
    }

    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: `${viewYear}-${p2(viewMonth + 1)}-${p2(d)}`, day: d, inMonth: true });
    }

    // Next month fill (up to 42 cells = 6 rows)
    const remaining = 42 - cells.length;
    for (let d = 1; d <= remaining; d++) {
      const m = viewMonth === 11 ? 0 : viewMonth + 1;
      const y = viewMonth === 11 ? viewYear + 1 : viewYear;
      cells.push({ date: `${y}-${p2(m + 1)}-${p2(d)}`, day: d, inMonth: false });
    }
    return cells;
  }, [viewYear, viewMonth]);

  const handleDayClick = useCallback((dateStr: string) => {
    if (!pickStart) {
      // First click — start picking
      setPickStart(dateStr);
      setDateFrom(dateStr);
      setDateTo(dateStr);
    } else {
      // Second click — set range
      if (dateStr < pickStart) {
        setDateFrom(dateStr);
        setDateTo(pickStart);
      } else {
        setDateFrom(pickStart);
        setDateTo(dateStr);
      }
      setPickStart(null);
      setHoverDate(null);
    }
  }, [pickStart, setDateFrom, setDateTo]);

  // Compute visual range (inclusive) for highlighting
  const rangeStart = useMemo(() => {
    if (pickStart && hoverDate) return pickStart < hoverDate ? pickStart : hoverDate;
    return dateFrom || null;
  }, [pickStart, hoverDate, dateFrom]);

  const rangeEnd = useMemo(() => {
    if (pickStart && hoverDate) return pickStart > hoverDate ? pickStart : hoverDate;
    return dateTo || null;
  }, [pickStart, hoverDate, dateTo]);

  const isInRange = useCallback((d: string) => {
    if (!rangeStart || !rangeEnd) return false;
    return d >= rangeStart && d <= rangeEnd;
  }, [rangeStart, rangeEnd]);

  const isRangeStart = useCallback((d: string) => d === rangeStart, [rangeStart]);
  const isRangeEnd = useCallback((d: string) => d === rangeEnd, [rangeEnd]);

  const monthLabel = `${viewYear} \u5e74 ${viewMonth + 1} \u6708`;

  const formatLabel = (d: string) => {
    const parts = d.split("-");
    return `${parts[1]}/${parts[2]}`;
  };

  return (
    <div className="absolute left-0 top-full mt-1.5 z-50 rounded-xl border border-base-content/10 bg-base-100 shadow-xl shadow-base-content/5 animate-fade-slide-in w-[300px]">
      {/* presets row */}
      <div className="px-3 pt-3 pb-2 border-b border-base-content/5">
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => {
            const isActive = dateFrom === p.from && dateTo === p.to && !pickStart;
            return (
              <button
                key={p.label}
                type="button"
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-all duration-150 ${
                  isActive
                    ? "bg-primary text-primary-content shadow-sm"
                    : "text-base-content/55 hover:bg-base-content/5 hover:text-base-content/80"
                }`}
                onClick={() => {
                  applyPreset(p.from, p.to);
                  setPickStart(null);
                  setHoverDate(null);
                  // Navigate calendar to the preset's start month
                  const [y, m] = p.from.split("-");
                  setViewYear(Number(y));
                  setViewMonth(Number(m) - 1);
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* calendar */}
      <div className="p-3">
        {/* month nav */}
        <div className="flex items-center justify-between mb-2">
          <button
            type="button"
            className="p-1 rounded-md text-base-content/40 hover:text-base-content/70 hover:bg-base-content/5 transition-colors"
            onClick={prevMonth}
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-xs font-semibold text-base-content/70 select-none">
            {monthLabel}
          </span>
          <button
            type="button"
            className="p-1 rounded-md text-base-content/40 hover:text-base-content/70 hover:bg-base-content/5 transition-colors"
            onClick={nextMonth}
          >
            <ChevronRight size={14} />
          </button>
        </div>

        {/* weekday headers */}
        <div className="grid grid-cols-7 mb-0.5">
          {WEEKDAYS.map((w) => (
            <div key={w} className="text-center text-[9px] font-medium text-base-content/30 py-0.5 select-none">
              {w}
            </div>
          ))}
        </div>

        {/* day grid */}
        <div className="grid grid-cols-7">
          {calendarDays.map((cell, i) => {
            const inRange = isInRange(cell.date);
            const isStart = isRangeStart(cell.date);
            const isEnd = isRangeEnd(cell.date);
            const isToday = cell.date === todayStr;
            const isSingleDay = isStart && isEnd;
            const isPicking = !!pickStart;

            return (
              <div
                key={i}
                className={`relative flex items-center justify-center ${
                  // Range background band
                  inRange && !isSingleDay
                    ? isStart
                      ? "bg-primary/10 rounded-l-md"
                      : isEnd
                        ? "bg-primary/10 rounded-r-md"
                        : "bg-primary/10"
                    : ""
                }`}
              >
                <button
                  type="button"
                  className={`
                    relative z-10 w-8 h-7 rounded-md text-[11px] font-medium transition-all duration-100 select-none
                    ${!cell.inMonth ? "text-base-content/15" : ""}
                    ${cell.inMonth && !inRange ? "text-base-content/70 hover:bg-base-content/8 hover:text-base-content" : ""}
                    ${inRange && !isStart && !isEnd ? "text-primary/80" : ""}
                    ${(isStart || isEnd) ? "bg-primary text-primary-content shadow-sm" : ""}
                    ${isToday && !isStart && !isEnd ? "ring-1 ring-primary/30 ring-inset" : ""}
                    ${isPicking ? "cursor-crosshair" : "cursor-pointer"}
                  `}
                  onClick={() => handleDayClick(cell.date)}
                  onMouseEnter={() => { if (pickStart) setHoverDate(cell.date); }}
                  onMouseLeave={() => { if (pickStart) setHoverDate(null); }}
                >
                  {cell.day}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* footer */}
      <div className="border-t border-base-content/5 px-3 py-2 flex items-center justify-between">
        {hasDateFilter && !pickStart ? (
          <>
            <button
              type="button"
              className="text-[10px] text-error/60 hover:text-error transition-colors flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-error/5"
              onClick={() => { clearDateFilter(); close(); }}
            >
              <X size={9} /> 清除
            </button>
            <span className="text-[10px] text-base-content/30 tabular-nums">
              {dateFrom && dateTo
                ? dateFrom === dateTo
                  ? formatLabel(dateFrom)
                  : `${formatLabel(dateFrom)} → ${formatLabel(dateTo)}`
                : dateFrom
                  ? `${formatLabel(dateFrom)} 起`
                  : `至 ${formatLabel(dateTo)}`}
            </span>
          </>
        ) : pickStart ? (
          <span className="text-[10px] text-primary/60 animate-live-pulse">
            点击第二个日期完成选择…
          </span>
        ) : (
          <span className="text-[10px] text-base-content/25">
            点击日期开始选择范围
          </span>
        )}
      </div>
    </div>
  );
};

/* ========== Connection Toast ========== */

const ConnectionToast = ({ connected }: { connected: boolean }) => {
  const [show, setShow] = useState(false);
  const [wasConnected, setWasConnected] = useState(true);

  useEffect(() => {
    if (!connected && wasConnected) {
      setShow(true);
    } else if (connected && !wasConnected) {
      setShow(true);
      const t = setTimeout(() => setShow(false), 2500);
      return () => clearTimeout(t);
    }
    setWasConnected(connected);
  }, [connected, wasConnected]);

  if (!show) return null;

  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] animate-toast-in">
      <div className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur-sm ${
        connected
          ? "border-success/30 bg-success/10 text-success"
          : "border-error/30 bg-error/10 text-error"
      }`}>
        <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-success" : "bg-error animate-live-pulse"}`} />
        {connected ? "已重新连接" : "连接已断开，正在重连…"}
      </div>
    </div>
  );
};

export const App = () => {
  const [dashboard, setDashboard] = useState<DashboardState>(emptyState);
  const [configForm, setConfigForm] = useState<ProxyConfig>(defaultConfig);
  const [connected, setConnected] = useState(false);

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
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "error" | "pending">("all");

  /* date filters */
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  /* paginated exchange list (loaded via REST API) */
  const [paginatedItems, setPaginatedItems] = useState<ExchangeRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);

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

  /* fetch paginated exchanges from REST API */
  const fetchExchanges = useCallback(async (cursor?: string) => {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    if (cursor) params.set("cursor", cursor);
    if (dateFrom) {
      // dateFrom is YYYY-MM-DD, convert to ISO start of day
      params.set("dateFrom", new Date(dateFrom + "T00:00:00").toISOString());
    }
    if (dateTo) {
      // dateTo is YYYY-MM-DD, convert to ISO end of day
      params.set("dateTo", new Date(dateTo + "T23:59:59.999").toISOString());
    }
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (searchQuery.trim()) params.set("search", searchQuery.trim());

    const r = await fetch(`/exchanges?${params.toString()}`);
    if (!r.ok) return null;
    return (await r.json()) as PaginatedResult;
  }, [dateFrom, dateTo, statusFilter, searchQuery]);

  /* load initial page */
  const loadInitialPage = useCallback(async () => {
    const result = await fetchExchanges();
    if (result) {
      setPaginatedItems(result.items);
      setNextCursor(result.nextCursor);
      setTotalCount(result.total);
      setInitialLoaded(true);
    }
  }, [fetchExchanges]);

  /* reload when filters change */
  useEffect(() => {
    void loadInitialPage();
  }, [loadInitialPage]);

  /* debounce search input → searchQuery (optimize: reduce re-renders during typing) */
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  /* SSE — updates dashboard stats/config and prepends new exchanges to the paginated list.
     Includes automatic reconnection with exponential backoff (harden skill). */
  useEffect(() => {
    let es: EventSource | null = null;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      es = new EventSource("/events/prompts");

      es.onopen = () => {
        setConnected(true);
        retryCount = 0; // reset backoff on successful connect
      };

      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!disposed) {
          // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
          const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
          retryCount++;
          retryTimer = setTimeout(connect, delay);
        }
      };

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
          // If there's a latest exchange update from SSE, merge it into paginatedItems
          if (data.latest) {
            const latest = data.latest;
            setPaginatedItems((prev) => {
              const idx = prev.findIndex((i) => i.id === latest.id);
              if (idx >= 0) {
                // Update existing
                const next = [...prev];
                next[idx] = latest;
                return next;
              }
              // Prepend new item (only if not filtered out by date range)
              if (dateFrom) {
                const fromDate = new Date(dateFrom + "T00:00:00");
                if (new Date(latest.createdAt) < fromDate) return prev;
              }
              if (dateTo) {
                const toDate = new Date(dateTo + "T23:59:59.999");
                if (new Date(latest.createdAt) > toDate) return prev;
              }
              return [latest, ...prev];
            });
            setTotalCount((prev) => {
              // If it's a new exchange (not update), increment count
              const isNew = data.type === "update" && latest.responseStatus === "pending";
              return isNew ? prev + 1 : prev;
            });
          }
        } catch { /* ignore parse errors */ }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
      setConnected(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo]);

  /* apply client-side search/status filter on top of paginated items
     (server also filters, but SSE-pushed items may need client filtering) */
  const filteredItems = useMemo(() => {
    let items = paginatedItems;
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
  }, [paginatedItems, statusFilter, searchQuery]);

  const visibleItems = filteredItems;

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

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await fetchExchanges(nextCursor);
      if (result) {
        setPaginatedItems((prev) => {
          // Deduplicate
          const existingIds = new Set(prev.map((i) => i.id));
          const newItems = result.items.filter((i) => !existingIds.has(i.id));
          return [...prev, ...newItems];
        });
        setNextCursor(result.nextCursor);
        setTotalCount(result.total);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, fetchExchanges]);

  const onListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const t = e.currentTarget;
    if (t.scrollTop + t.clientHeight < t.scrollHeight - 200) return;
    void loadMore();
  }, [loadMore]);

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
      setPaginatedItems([]);
      setNextCursor(null);
      setTotalCount(0);
    } catch (e) {
      console.error(e);
    } finally {
      setDeleting(false);
    }
  }, []);

  const clearDateFilter = useCallback(() => {
    setDateFrom("");
    setDateTo("");
  }, []);

  const hasDateFilter = dateFrom || dateTo;

  /* date filter dropdown */
  const [dateDropdownOpen, setDateDropdownOpen] = useState(false);
  const dateDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    if (!dateDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dateDropdownRef.current && !dateDropdownRef.current.contains(e.target as Node)) {
        setDateDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dateDropdownOpen]);

  // Close on Escape
  useEffect(() => {
    if (!dateDropdownOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setDateDropdownOpen(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [dateDropdownOpen]);

  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const yesterdayStr = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }, []);

  const datePresets = useMemo(() => [
    { label: "今天", from: todayStr, to: todayStr },
    { label: "昨天", from: yesterdayStr, to: yesterdayStr },
    { label: "近 3 天", from: (() => { const d = new Date(); d.setDate(d.getDate() - 2); return d.toISOString().slice(0, 10); })(), to: todayStr },
    { label: "近 7 天", from: (() => { const d = new Date(); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); })(), to: todayStr },
    { label: "近 30 天", from: (() => { const d = new Date(); d.setDate(d.getDate() - 29); return d.toISOString().slice(0, 10); })(), to: todayStr },
  ], [todayStr, yesterdayStr]);

  const activePresetLabel = useMemo(() => {
    if (!dateFrom && !dateTo) return null;
    const match = datePresets.find(p => p.from === dateFrom && p.to === dateTo);
    return match?.label ?? null;
  }, [dateFrom, dateTo, datePresets]);

  const applyPreset = useCallback((from: string, to: string) => {
    setDateFrom(from);
    setDateTo(to);
  }, []);

  const formatDateLabel = useCallback((d: string) => {
    if (!d) return "";
    // Convert YYYY-MM-DD to more readable MM/DD
    const parts = d.split("-");
    return `${parts[1]}/${parts[2]}`;
  }, []);

  const dateFilterLabel = useMemo(() => {
    if (activePresetLabel) return activePresetLabel;
    if (dateFrom && dateTo) return `${formatDateLabel(dateFrom)} ~ ${formatDateLabel(dateTo)}`;
    if (dateFrom) return `${formatDateLabel(dateFrom)} 起`;
    if (dateTo) return `至 ${formatDateLabel(dateTo)}`;
    return null;
  }, [activePresetLabel, dateFrom, dateTo, formatDateLabel]);

  const { stats } = dashboard;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* ── connection toast ── */}
      <ConnectionToast connected={connected} />

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
        <StatMini icon={Activity} label="请求" value={stats.totalRequests} delay={0} />
        <StatMini icon={Send} label="入 Tokens" value={stats.totalPromptTokens.toLocaleString()} delay={50} />
        <StatMini icon={Zap} label="出 Tokens" value={totalCompletionTokens.toLocaleString()} delay={100} />
        <StatMini icon={Coins} label="总 Tokens" value={(stats.totalPromptTokens + totalCompletionTokens).toLocaleString()} delay={150} />
        <StatMini icon={ArrowUpDown} label="转发" value={stats.totalForwarded} delay={200} />
        <StatMini icon={Shield} label="捕获" value={stats.totalCaptureOnly} delay={250} />
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
                className="input input-bordered input-sm w-full bg-base-100 pl-8 text-xs transition-shadow duration-200 focus:shadow-md focus:shadow-primary/5"
                placeholder="搜索 prompt, model, response …"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
              {searchInput && (
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-base-content/30 hover:text-base-content/60 transition-colors duration-150"
                  onClick={() => { setSearchInput(""); setSearchQuery(""); }}
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
            {/* date filter dropdown */}
            <div className="relative" ref={dateDropdownRef}>
              <button
                type="button"
                className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium transition-all duration-200 ${
                  hasDateFilter
                    ? "border-primary/30 bg-primary/10 text-primary shadow-sm shadow-primary/5"
                    : dateDropdownOpen
                      ? "border-base-content/20 bg-base-content/5 text-base-content/60"
                      : "border-base-content/10 text-base-content/40 hover:text-base-content/60 hover:border-base-content/20"
                }`}
                onClick={() => setDateDropdownOpen((p) => !p)}
                title="按日期筛选"
              >
                <Calendar size={11} />
                <span>{dateFilterLabel ?? "日期"}</span>
                {hasDateFilter && (
                  <span
                    className="ml-0.5 rounded-full hover:bg-primary/20 p-0.5 transition-colors"
                    onClick={(e) => { e.stopPropagation(); clearDateFilter(); }}
                    title="清除日期筛选"
                  >
                    <X size={9} />
                  </span>
                )}
                {!hasDateFilter && <ChevronDown size={9} className={`transition-transform duration-200 ${dateDropdownOpen ? "rotate-180" : ""}`} />}
              </button>

              {/* dropdown panel */}
              {dateDropdownOpen && (
                <DatePickerDropdown
                  dateFrom={dateFrom}
                  dateTo={dateTo}
                  setDateFrom={setDateFrom}
                  setDateTo={setDateTo}
                  presets={datePresets}
                  activePresetLabel={activePresetLabel}
                  applyPreset={applyPreset}
                  clearDateFilter={clearDateFilter}
                  close={() => setDateDropdownOpen(false)}
                  hasDateFilter={!!hasDateFilter}
                />
              )}
            </div>
          </>
        )}
        <span className="text-[10px] text-base-content/25 tabular-nums ml-auto">
          {initialLoaded ? `${filteredItems.length} / ${totalCount} 条` : `${dashboard.items.length} 条`}
        </span>
      </div>

      {/* ── exchange list (fills remaining viewport) ── */}
      <div className="flex-1 overflow-y-auto" onScroll={onListScroll}>
        <div className="mx-auto max-w-[1600px] space-y-1 p-3">
          {visibleItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-base-content/25 animate-fade-slide-in">
              <Radio size={28} className="mb-2 opacity-30" />
              <p className="text-sm">{searchQuery || statusFilter !== "all" || hasDateFilter ? "无匹配记录" : "等待请求中…"}</p>
              {!searchQuery && statusFilter === "all" && !hasDateFilter && (
                <p className="mt-1 text-xs text-base-content/15">发送一个 API 请求到代理端点开始使用</p>
              )}
            </div>
          ) : (
            visibleItems.map((item, idx) => {
              const serial = totalCount - idx;
              return (
                <div
                  key={item.id}
                  className="animate-fade-slide-in"
                  style={{ animationDelay: `${Math.min(idx * 30, 300)}ms` }}
                >
                  <ExchangeRow
                    item={item}
                    serial={serial}
                    expanded={expandedId === item.id}
                    onToggle={() => setExpandedId((p) => (p === item.id ? null : item.id))}
                    selectMode={selectMode}
                    selected={selectedIds.has(item.id)}
                    onSelect={onSelectItem}
                  />
                </div>
              );
            })
          )}
          {nextCursor && (
            <div className="flex justify-center py-2">
              <button
                className="btn btn-ghost btn-sm gap-1.5 text-xs"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <><Loader2 size={12} className="animate-spin" /> 加载中…</>
                ) : (
                  <><ChevronDown size={12} /> 加载更多 ({totalCount - paginatedItems.length > 0 ? totalCount - paginatedItems.length : "..."} 条)</>
                )}
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
