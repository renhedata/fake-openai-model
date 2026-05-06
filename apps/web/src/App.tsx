import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowUpDown, BookOpen, Calendar, CheckSquare, ChevronDown,
  Clipboard, Coins, Filter, Key, Loader2, MinusSquare, Moon, Radio, Search, Send,
  Server, Settings2, Shield, Square, Sun, Trash2, X, Zap,
} from "lucide-react";
import type { DashboardEvent, ExchangeRecord, ModelRecord, Provider, ApiKey, UpstreamTestResult } from "./types";
import { type PaginatedResult } from "./types";
import {
  PAGE_SIZE,
  normalizeConfig, emptyMeta,
  getCompletionTokens, getResponseText, getReasoningText,
} from "./utils";
import { Badge, StatMini, StatusDot } from "./components/Atoms";
import { ConnectionToast } from "./components/ConnectionToast";
import { DatePickerDropdown } from "./components/DatePickerDropdown";
import { ExchangeDetail } from "./components/ExchangeDetail";
import { ExchangeRow } from "./components/ExchangeRow";
import { HelpModal } from "./components/HelpModal";
import { SettingsDrawer } from "./components/SettingsDrawer";

export const App = () => {
  const [dashboardMeta, setDashboardMeta] = useState(emptyMeta);
  const [connected, setConnected] = useState(false);

  // Provider state
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState("");
  const [providerSuccess, setProviderSuccess] = useState("");

  // API Key state
  const [apiKeyLoading, setApiKeyLoading] = useState(false);
  const [apiKeyError, setApiKeyError] = useState("");
  const [apiKeySuccess, setApiKeySuccess] = useState("");

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedItemFull, setExpandedItemFull] = useState<ExchangeRecord | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "error" | "pending">("all");
  const [apiKeyFilter, setApiKeyFilter] = useState("");
  const [agentTypeFilter, setAgentTypeFilter] = useState<"all" | "openclaw" | "hermes">("all");

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [paginatedItems, setPaginatedItems] = useState<ExchangeRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

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

  const fetchExchanges = useCallback(async (cursor?: string) => {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    if (cursor) params.set("cursor", cursor);
    if (dateFrom) params.set("dateFrom", new Date(dateFrom + "T00:00:00").toISOString());
    if (dateTo) params.set("dateTo", new Date(dateTo + "T23:59:59.999").toISOString());
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (apiKeyFilter) params.set("apiKeyId", apiKeyFilter);
    if (agentTypeFilter !== "all") params.set("agentType", agentTypeFilter);
    if (searchQuery.trim()) params.set("search", searchQuery.trim());
    const r = await fetch(`/exchanges?${params.toString()}`);
    if (!r.ok) return null;
    return (await r.json()) as PaginatedResult;
  }, [dateFrom, dateTo, statusFilter, searchQuery, apiKeyFilter, agentTypeFilter]);

  const loadInitialPage = useCallback(async () => {
    const result = await fetchExchanges();
    if (result) {
      setPaginatedItems(result.items);
      setNextCursor(result.nextCursor);
      setTotalCount(result.total);
      setInitialLoaded(true);
    }
  }, [fetchExchanges]);

  useEffect(() => { void loadInitialPage(); }, [loadInitialPage]);

  const loadInitialPageRef = useRef(loadInitialPage);
  useEffect(() => { loadInitialPageRef.current = loadInitialPage; }, [loadInitialPage]);

  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      es = new EventSource("/events/prompts");
      es.onopen = () => { setConnected(true); retryCount = 0; };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!disposed) {
          const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
          retryCount++;
          retryTimer = setTimeout(connect, delay);
        }
      };
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as DashboardEvent;
          const meta = data.meta ?? null;
          if (meta) {
            const nc = normalizeConfig(meta.config);
            setDashboardMeta({ stats: meta.stats, config: nc, providers: meta.providers ?? [], apiKeys: meta.apiKeys ?? [], models: meta.models });
          }
          if (data.type === "update" && !data.latest && meta) {
            // Server emitted null latest (deletion or config change) — refresh list
            void loadInitialPageRef.current();
          }
          if (data.latest) {
            const latest = data.latest;
            // Re-fetch full record if it's currently expanded and has been updated
            setExpandedId((currentExpandedId) => {
              if (currentExpandedId === latest.id) {
                fetch(`/exchanges/${latest.id}`)
                  .then((r) => r.ok ? r.json() as Promise<ExchangeRecord> : null)
                  .then((full) => { if (full) setExpandedItemFull(full); })
                  .catch(() => {});
              }
              return currentExpandedId;
            });
            setPaginatedItems((prev) => {
              const idx = prev.findIndex((i) => i.id === latest.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = latest; return next; }
              if (dateFrom && new Date(latest.createdAt) < new Date(dateFrom + "T00:00:00")) return prev;
              if (dateTo && new Date(latest.createdAt) > new Date(dateTo + "T23:59:59.999")) return prev;
              return [latest, ...prev];
            });
            setTotalCount((prev) => (data.type === "update" && latest.responseStatus === "pending" ? prev + 1 : prev));
          }
        } catch { /* ignore */ }
      };
    };

    connect();
    return () => { disposed = true; if (retryTimer) clearTimeout(retryTimer); es?.close(); setConnected(false); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo]);

  const filteredItems = useMemo(() => {
    let items = paginatedItems;
    if (statusFilter !== "all") items = items.filter((i) => i.responseStatus === statusFilter);
    if (apiKeyFilter) items = items.filter((i) => i.apiKeyId === apiKeyFilter);
    if (agentTypeFilter !== "all") items = items.filter((i) => i.agentType === agentTypeFilter);
    const q = searchQuery.trim().toLowerCase();
    if (q) items = items.filter((i) =>
      i.prompt.toLowerCase().includes(q) || i.model.toLowerCase().includes(q) ||
      i.id.toLowerCase().includes(q) || (i.errorMessage ?? "").toLowerCase().includes(q)
    );
    return items;
  }, [paginatedItems, statusFilter, searchQuery, apiKeyFilter, agentTypeFilter]);

  const totalCompletionTokens = useMemo(
    () => paginatedItems.reduce((sum, i) => sum + getCompletionTokens(i.responseBody), 0),
    [paginatedItems]
  );

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

  // Provider CRUD
  const onAddProvider = useCallback(async (provider: Omit<Provider, "id" | "createdAt" | "enabled">) => {
    setProviderLoading(true); setProviderError(""); setProviderSuccess("");
    try {
      const r = await fetch("/proxy/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(provider) });
      if (!r.ok) throw new Error(await readErrorMessage(r));
      const created = (await r.json()) as Provider;
      setDashboardMeta((prev) => ({
        ...prev,
        providers: prev.providers.some((p) => p.id === created.id)
          ? prev.providers.map((p) => (p.id === created.id ? created : p))
          : [...prev.providers, created],
      }));
      setProviderSuccess(`已添加提供商 ${created.name}`);
    } catch (e) { setProviderError(e instanceof Error ? e.message : "添加失败"); }
    finally { setProviderLoading(false); }
  }, [readErrorMessage]);

  const onUpdateProvider = useCallback(async (id: string, patch: Partial<Provider>) => {
    setProviderLoading(true); setProviderError(""); setProviderSuccess("");
    try {
      const r = await fetch(`/proxy/providers/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
      if (!r.ok) throw new Error(await readErrorMessage(r));
      const updated = (await r.json()) as Provider;
      setDashboardMeta((prev) => ({
        ...prev,
        providers: prev.providers.map((p) => (p.id === id ? updated : p)),
      }));
      setProviderSuccess(`已更新提供商 ${updated.name}`);
    } catch (e) { setProviderError(e instanceof Error ? e.message : "更新失败"); }
    finally { setProviderLoading(false); }
  }, [readErrorMessage]);

  const onDeleteProvider = useCallback(async (id: string) => {
    if (!window.confirm("确定要删除此提供商吗？关联的模型将失去绑定。")) return;
    setProviderLoading(true); setProviderError(""); setProviderSuccess("");
    try {
      const r = await fetch(`/proxy/providers/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await readErrorMessage(r));
      setDashboardMeta((prev) => ({ ...prev, providers: prev.providers.filter((p) => p.id !== id) }));
      setProviderSuccess("已删除提供商");
    } catch (e) { setProviderError(e instanceof Error ? e.message : "删除失败"); }
    finally { setProviderLoading(false); }
  }, [readErrorMessage]);

  const onTestProvider = useCallback(async (id: string) => {
    const r = await fetch(`/proxy/providers/${id}/test`, { method: "POST" });
    if (!r.ok) throw new Error(await readErrorMessage(r));
    return (await r.json()) as UpstreamTestResult;
  }, [readErrorMessage]);

  const onTestModel = useCallback(async (modelId: string) => {
    const r = await fetch(`/proxy/models/${encodeURIComponent(modelId)}/test`, { method: "POST" });
    if (!r.ok) throw new Error(await readErrorMessage(r));
    return (await r.json()) as UpstreamTestResult;
  }, [readErrorMessage]);

  const onRefreshProviderModels = useCallback(async (id: string) => {
    const r = await fetch(`/proxy/providers/${id}/refresh`, { method: "POST" });
    if (!r.ok) throw new Error(await readErrorMessage(r));
    const payload = (await r.json()) as { data?: ModelRecord[] };
    const m = payload.data ?? [];
    setDashboardMeta((prev) => ({ ...prev, models: m }));
  }, [readErrorMessage]);

  // API Key CRUD
  const onCreateApiKey = useCallback(async (name: string, allowedModels: string[] | null) => {
    setApiKeyLoading(true); setApiKeyError(""); setApiKeySuccess("");
    try {
      const r = await fetch("/proxy/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, allowedModels }),
      });
      if (!r.ok) throw new Error(await readErrorMessage(r));
      const created = (await r.json()) as ApiKey;
      setDashboardMeta((prev) => ({
        ...prev,
        apiKeys: prev.apiKeys.some((k) => k.id === created.id)
          ? prev.apiKeys.map((k) => (k.id === created.id ? created : k))
          : [...prev.apiKeys, created],
      }));
      setApiKeySuccess(`已生成密钥 ${created.key.slice(0, 20)}…`);
    } catch (e) { setApiKeyError(e instanceof Error ? e.message : "生成失败"); }
    finally { setApiKeyLoading(false); }
  }, [readErrorMessage]);

  const onUpdateApiKey = useCallback(async (id: string, allowedModels: string[] | null) => {
    setApiKeyLoading(true); setApiKeyError(""); setApiKeySuccess("");
    try {
      const r = await fetch(`/proxy/api-keys/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowedModels }),
      });
      if (!r.ok) throw new Error(await readErrorMessage(r));
      const updated = (await r.json()) as ApiKey;
      setDashboardMeta((prev) => ({ ...prev, apiKeys: prev.apiKeys.map((k) => (k.id === id ? updated : k)) }));
      setApiKeySuccess("已更新模型权限");
    } catch (e) { setApiKeyError(e instanceof Error ? e.message : "更新失败"); }
    finally { setApiKeyLoading(false); }
  }, [readErrorMessage]);

  const onDeleteApiKey = useCallback(async (id: string) => {
    if (!window.confirm("确定要删除此密钥吗？")) return;
    setApiKeyLoading(true); setApiKeyError(""); setApiKeySuccess("");
    try {
      const r = await fetch(`/proxy/api-keys/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await readErrorMessage(r));
      setDashboardMeta((prev) => ({ ...prev, apiKeys: prev.apiKeys.filter((k) => k.id !== id) }));
      setApiKeySuccess("已删除密钥");
    } catch (e) { setApiKeyError(e instanceof Error ? e.message : "删除失败"); }
    finally { setApiKeyLoading(false); }
  }, [readErrorMessage]);

  // Model management
  const onAddModel = useCallback(async (model: Omit<ModelRecord, "object" | "created" | "owned_by"> & Partial<Pick<ModelRecord, "object" | "created" | "owned_by">>) => {
    try {
      const r = await fetch("/proxy/models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(model) });
      if (!r.ok) throw new Error(await readErrorMessage(r));
      const payload = (await r.json()) as { data?: ModelRecord[] };
      setDashboardMeta((prev) => ({ ...prev, models: payload.data ?? prev.models }));
    } catch (e) { console.error(e instanceof Error ? e.message : "添加模型失败"); }
  }, [readErrorMessage]);

  const onDeleteModel = useCallback(async (id: string) => {
    if (!window.confirm(`确定要删除模型 '${id}' 吗？`)) return;
    try {
      const r = await fetch(`/proxy/models/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await readErrorMessage(r));
      const payload = (await r.json()) as { data?: ModelRecord[] };
      setDashboardMeta((prev) => ({ ...prev, models: payload.data ?? prev.models.filter((m) => m.id !== id) }));
    } catch (e) { console.error(e instanceof Error ? e.message : "删除模型失败"); }
  }, [readErrorMessage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await fetchExchanges(nextCursor);
      if (result) {
        setPaginatedItems((prev) => {
          const existingIds = new Set(prev.map((i) => i.id));
          return [...prev, ...result.items.filter((i) => !existingIds.has(i.id))];
        });
        setNextCursor(result.nextCursor);
        setTotalCount(result.total);
      }
    } finally { setLoadingMore(false); }
  }, [nextCursor, loadingMore, fetchExchanges]);

  const loadMoreRef = useRef(loadMore);
  useEffect(() => { loadMoreRef.current = loadMore; }, [loadMore]);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    observerRef.current = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) void loadMoreRef.current(); },
      { threshold: 0.1 }
    );
    observerRef.current.observe(el);
  }, []);

  useEffect(() => {
    if (!expandedId) { setExpandedItemFull(null); return; }
    let cancelled = false;
    fetch(`/exchanges/${expandedId}`)
      .then((r) => r.ok ? r.json() as Promise<ExchangeRecord> : null)
      .then((data) => { if (!cancelled && data) setExpandedItemFull(data); })
      .catch(() => { /* detail stays as list item */ });
    return () => { cancelled = true; };
  }, [expandedId]);

  const handleRowToggle = useCallback((id: string) => {
    setExpandedId((p) => (p === id ? null : id));
  }, []);

  const onSelectItem = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => { const next = new Set(prev); checked ? next.add(id) : next.delete(id); return next; });
  }, []);
  const selectAll = useCallback(() => setSelectedIds(new Set(filteredItems.map((i) => i.id))), [filteredItems]);
  const deselectAll = useCallback(() => setSelectedIds(new Set()), []);
  const toggleSelectMode = useCallback(() => setSelectMode((p) => { if (p) setSelectedIds(new Set()); return !p; }), []);

  const deleteSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setDeleting(true);
    try {
      const r = await fetch("/exchanges", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: Array.from(selectedIds) }) });
      if (!r.ok) throw new Error("删除失败");
      const deletedIds = selectedIds;
      setSelectedIds(new Set());
      setPaginatedItems((prev) => prev.filter((i) => !deletedIds.has(i.id)));
      setTotalCount((prev) => Math.max(0, prev - deletedIds.size));
    } catch (e) { console.error(e); }
    finally { setDeleting(false); }
  }, [selectedIds]);

  const deleteAll = useCallback(async () => {
    if (!window.confirm("确定要删除所有记录吗？此操作不可恢复。")) return;
    setDeleting(true);
    try {
      const r = await fetch("/exchanges", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }) });
      if (!r.ok) throw new Error("删除失败");
      setSelectedIds(new Set()); setSelectMode(false);
      setPaginatedItems([]); setNextCursor(null); setTotalCount(0);
    } catch (e) { console.error(e); }
    finally { setDeleting(false); }
  }, []);

  const [copyDone, setCopyDone] = useState(false);
  const copySelected = useCallback(() => {
    if (selectedIds.size === 0) return;
    const items = filteredItems.filter((i) => selectedIds.has(i.id));
    const text = items.map((item, idx) => {
      const prompt = item.prompt || "";
      const response = getResponseText(item.responseBody);
      const reasoning = getReasoningText(item.responseBody);
      const parts = [`[${idx + 1}] ${item.model} · ${item.createdAt}`, `Prompt:\n${prompt}`];
      if (reasoning) parts.push(`Thinking:\n${reasoning}`);
      if (response) parts.push(`Response:\n${response}`);
      return parts.join("\n\n");
    }).join("\n\n" + "─".repeat(60) + "\n\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopyDone(true);
      setTimeout(() => setCopyDone(false), 2000);
    });
  }, [selectedIds, filteredItems]);

  const clearDateFilter = useCallback(() => { setDateFrom(""); setDateTo(""); }, []);
  const hasDateFilter = dateFrom || dateTo;

  const [dateDropdownOpen, setDateDropdownOpen] = useState(false);
  const dateDropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!dateDropdownOpen) return;
    const h = (e: MouseEvent) => { if (dateDropdownRef.current && !dateDropdownRef.current.contains(e.target as Node)) setDateDropdownOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [dateDropdownOpen]);
  useEffect(() => {
    if (!dateDropdownOpen) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setDateDropdownOpen(false); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [dateDropdownOpen]);

  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const yesterdayStr = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); }, []);
  const datePresets = useMemo(() => [
    { label: "今天",    from: todayStr,     to: todayStr },
    { label: "昨天",    from: yesterdayStr, to: yesterdayStr },
    { label: "近 3 天", from: (() => { const d = new Date(); d.setDate(d.getDate() - 2); return d.toISOString().slice(0, 10); })(), to: todayStr },
    { label: "近 7 天", from: (() => { const d = new Date(); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); })(), to: todayStr },
    { label: "近 30 天",from: (() => { const d = new Date(); d.setDate(d.getDate() - 29); return d.toISOString().slice(0, 10); })(), to: todayStr },
  ], [todayStr, yesterdayStr]);

  const activePresetLabel = useMemo(() => {
    if (!dateFrom && !dateTo) return null;
    return datePresets.find((p) => p.from === dateFrom && p.to === dateTo)?.label ?? null;
  }, [dateFrom, dateTo, datePresets]);

  const applyPreset = useCallback((from: string, to: string) => { setDateFrom(from); setDateTo(to); }, []);

  const dateFilterLabel = useMemo(() => {
    if (activePresetLabel) return activePresetLabel;
    const fmt = (d: string) => { const p = d.split("-"); return `${p[1]}/${p[2]}`; };
    if (dateFrom && dateTo) return dateFrom === dateTo ? fmt(dateFrom) : `${fmt(dateFrom)} ~ ${fmt(dateTo)}`;
    if (dateFrom) return `${fmt(dateFrom)} 起`;
    if (dateTo) return `至 ${fmt(dateTo)}`;
    return null;
  }, [activePresetLabel, dateFrom, dateTo]);

  const { stats } = dashboardMeta;

  const selectedItem = useMemo(
    () => (expandedId ? filteredItems.find((i) => i.id === expandedId) ?? null : null),
    [expandedId, filteredItems]
  );
  const selectedSerial = useMemo(() => {
    if (!selectedItem) return 0;
    const idx = filteredItems.indexOf(selectedItem);
    return idx === -1 ? 0 : totalCount - idx;
  }, [selectedItem, filteredItems, totalCount]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape" && expandedId) setExpandedId(null); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [expandedId]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <ConnectionToast connected={connected} />

      {/* top bar */}
      <header className="z-30 flex shrink-0 items-center justify-between border-b border-base-content/5 bg-base-300 px-4 py-2">
        <div className="flex items-center gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-primary">
            <Server size={15} />
          </div>
          <h1 className="text-sm font-bold">Fake Model Gateway</h1>
          <div className="hidden items-center gap-2 sm:flex">
            <StatusDot ok={connected} label={connected ? "Live" : "Off"} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-3 text-[10px] tabular-nums text-base-content/40 lg:flex">
            <span title="总请求"><Activity size={10} className="inline" /> {stats.totalRequests}</span>
            <span title="Prompt Tokens" className="text-info/60"><Send size={10} className="inline" /> {stats.totalPromptTokens.toLocaleString()}</span>
            <span title="Completion Tokens" className="text-success/60"><Zap size={10} className="inline" /> {totalCompletionTokens.toLocaleString()}</span>
            <span title="总 Tokens"><Coins size={10} className="inline" /> {(stats.totalPromptTokens + totalCompletionTokens).toLocaleString()}</span>
          </div>
          <button className="btn btn-ghost btn-sm btn-circle h-7 w-7 min-h-0" onClick={toggleTheme} title={isDark ? "切换亮色模式" : "切换暗色模式"}>
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <button className="btn btn-ghost btn-sm btn-circle h-7 w-7 min-h-0" onClick={() => setHelpOpen(true)} title="使用说明">
            <BookOpen size={14} />
          </button>
          <button className="btn btn-primary btn-sm gap-1.5 h-7 min-h-0 text-xs" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={13} /> 配置
          </button>
        </div>
      </header>

      {/* stats row */}
      <div className="shrink-0 grid grid-cols-2 gap-2 border-b border-base-content/5 bg-base-300/50 px-4 py-2 sm:grid-cols-3 lg:grid-cols-5">
        <StatMini icon={Activity}    label="请求"    value={stats.totalRequests}                                       delay={0} />
        <StatMini icon={Send}        label="入 Tokens" value={stats.totalPromptTokens.toLocaleString()}               delay={50} />
        <StatMini icon={Zap}         label="出 Tokens" value={totalCompletionTokens.toLocaleString()}                 delay={100} />
        <StatMini icon={Coins}       label="总 Tokens" value={(stats.totalPromptTokens + totalCompletionTokens).toLocaleString()} delay={150} />
        <StatMini icon={ArrowUpDown} label="转发"    value={stats.totalForwarded}                                     delay={200} />
      </div>

      {/* search + filter bar */}
      <div className="shrink-0 flex items-center gap-2 border-b border-base-content/5 bg-base-300/30 px-4 py-2">
        <button
          type="button"
          className={`btn btn-ghost btn-xs gap-1 h-6 min-h-0 ${selectMode ? "text-primary" : "text-base-content/40"}`}
          onClick={toggleSelectMode}
          title={selectMode ? "退出选择" : "选择模式"}
        >
          {selectMode ? <CheckSquare size={13} /> : <Square size={13} />}
        </button>

        {selectMode && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="text-[10px] text-base-content/50 hover:text-base-content/70 transition-colors px-1.5 py-0.5 rounded hover:bg-base-content/5"
              onClick={selectedIds.size === filteredItems.length ? deselectAll : selectAll}
            >
              {selectedIds.size === filteredItems.length
                ? <span className="flex items-center gap-1"><MinusSquare size={10} /> 取消全选</span>
                : <span className="flex items-center gap-1"><CheckSquare size={10} /> 全选</span>}
            </button>
            {selectedIds.size > 0 && (
              <>
                <span className="text-[10px] tabular-nums text-primary font-medium">已选 {selectedIds.size}</span>
                <button type="button" className="btn btn-outline btn-xs gap-1 h-5 min-h-0 text-[10px]" onClick={copySelected}>
                  <Clipboard size={10} /> {copyDone ? "已复制!" : "复制内容"}
                </button>
                <button type="button" className="btn btn-error btn-xs gap-1 h-5 min-h-0 text-[10px]" onClick={deleteSelected} disabled={deleting}>
                  <Trash2 size={10} /> {deleting ? "删除中…" : "删除选中"}
                </button>
              </>
            )}
            <span className="text-base-content/10">|</span>
            <button
              type="button"
              className="text-[10px] text-error/50 hover:text-error transition-colors px-1.5 py-0.5 rounded hover:bg-error/5 flex items-center gap-1"
              onClick={deleteAll}
              disabled={deleting || totalCount === 0}
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
                <button className="absolute right-2 top-1/2 -translate-y-1/2 text-base-content/30 hover:text-base-content/60 transition-colors" onClick={() => { setSearchInput(""); setSearchQuery(""); }} type="button">
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
                  className={`rounded border px-2 py-0.5 text-[10px] font-medium transition-colors ${statusFilter === s ? "border-primary bg-primary/15 text-primary" : "border-base-content/10 text-base-content/40 hover:text-base-content/60"}`}
                  onClick={() => setStatusFilter(s)}
                >
                  {s === "all" ? "全部" : s}
                </button>
              ))}
            </div>
            {dashboardMeta.apiKeys.length > 0 && (
              <div className="flex items-center gap-1">
                <Key size={11} className="text-base-content/30" />
                <select
                  className="select select-bordered select-xs h-6 min-h-0 text-[10px] bg-base-100 py-0 pr-6 pl-2"
                  value={apiKeyFilter}
                  onChange={(e) => setApiKeyFilter(e.target.value)}
                >
                  <option value="">全部密钥</option>
                  {dashboardMeta.apiKeys.map((k) => (
                    <option key={k.id} value={k.id}>{k.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex items-center gap-1">
              <Shield size={11} className="text-base-content/30" />
              {(["all", "openclaw", "hermes"] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  className={`rounded border px-2 py-0.5 text-[10px] font-medium transition-colors ${agentTypeFilter === a ? "border-primary bg-primary/15 text-primary" : "border-base-content/10 text-base-content/40 hover:text-base-content/60"}`}
                  onClick={() => setAgentTypeFilter(a)}
                >
                  {a === "all" ? "全部" : a === "openclaw" ? "OpenClaw" : "Hermes"}
                </button>
              ))}
            </div>
            <div className="relative" ref={dateDropdownRef}>
              <button
                type="button"
                className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium transition-all duration-200 ${hasDateFilter ? "border-primary/30 bg-primary/10 text-primary shadow-sm shadow-primary/5" : dateDropdownOpen ? "border-base-content/20 bg-base-content/5 text-base-content/60" : "border-base-content/10 text-base-content/40 hover:text-base-content/60 hover:border-base-content/20"}`}
                onClick={() => setDateDropdownOpen((p) => !p)}
                title="按日期筛选"
              >
                <Calendar size={11} />
                <span>{dateFilterLabel ?? "日期"}</span>
                {hasDateFilter && (
                  <span className="ml-0.5 rounded-full hover:bg-primary/20 p-0.5 transition-colors" onClick={(e) => { e.stopPropagation(); clearDateFilter(); }} title="清除日期筛选">
                    <X size={9} />
                  </span>
                )}
                {!hasDateFilter && <ChevronDown size={9} className={`transition-transform duration-200 ${dateDropdownOpen ? "rotate-180" : ""}`} />}
              </button>
              {dateDropdownOpen && (
                <DatePickerDropdown
                  dateFrom={dateFrom} dateTo={dateTo}
                  setDateFrom={setDateFrom} setDateTo={setDateTo}
                  presets={datePresets} activePresetLabel={activePresetLabel}
                  applyPreset={applyPreset} clearDateFilter={clearDateFilter}
                  close={() => setDateDropdownOpen(false)} hasDateFilter={!!hasDateFilter}
                />
              )}
            </div>
          </>
        )}
        <span className="text-[10px] text-base-content/25 tabular-nums ml-auto">
          {initialLoaded ? `${filteredItems.length} / ${totalCount} 条` : "加载中…"}
        </span>
      </div>

      {/* split pane */}
      <div className="flex flex-1 overflow-hidden">
        <div className={`flex flex-col overflow-hidden transition-all duration-200 ${selectedItem ? "w-[360px] min-w-[240px] shrink-0" : "flex-1"}`}>
          <div className="flex-1 overflow-y-auto border-r border-base-content/5">
            <div className="space-y-1 p-2">
              {filteredItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-base-content/25 animate-fade-slide-in">
                  <Radio size={28} className="mb-2 opacity-30" />
                  <p className="text-sm">{searchQuery || statusFilter !== "all" || hasDateFilter || apiKeyFilter || agentTypeFilter !== "all" ? "无匹配记录" : "等待请求中…"}</p>
                  {!searchQuery && statusFilter === "all" && !hasDateFilter && !apiKeyFilter && agentTypeFilter === "all" && (
                    <p className="mt-1 text-xs text-base-content/15">发送一个 API 请求到代理端点开始使用</p>
                  )}
                </div>
              ) : (
                filteredItems.map((item, idx) => (
                  <ExchangeRow
                    key={item.id} item={item} serial={totalCount - idx}
                    expanded={expandedId === item.id}
                    onToggle={handleRowToggle}
                    selectMode={selectMode} selected={selectedIds.has(item.id)} onSelect={onSelectItem}
                    compact={!!selectedItem}
                  />
                ))
              )}
              {nextCursor && (
                <div ref={sentinelRef} className="flex justify-center py-3">
                  {loadingMore
                    ? <span className="flex items-center gap-1.5 text-xs text-base-content/40"><Loader2 size={12} className="animate-spin" /> 加载中…</span>
                    : <span className="text-[10px] text-base-content/20">{totalCount - paginatedItems.length > 0 ? `还有 ${totalCount - paginatedItems.length} 条` : ""}</span>
                  }
                </div>
              )}
            </div>
          </div>
        </div>

        {selectedItem && (
          <div className="flex-1 overflow-hidden bg-base-200/30">
            <ExchangeDetail item={expandedItemFull ?? selectedItem} serial={selectedSerial} onClose={() => setExpandedId(null)} />
          </div>
        )}
      </div>

      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        providers={dashboardMeta.providers}
        models={dashboardMeta.models}
        providerLoading={providerLoading}
        providerError={providerError}
        providerSuccess={providerSuccess}
        onAddProvider={onAddProvider}
        onUpdateProvider={onUpdateProvider}
        onDeleteProvider={onDeleteProvider}
        onRefreshProviderModels={onRefreshProviderModels}
        onTestModel={onTestModel}
        onAddModel={onAddModel}
        onDeleteModel={onDeleteModel}
        apiKeys={dashboardMeta.apiKeys}
        apiKeyLoading={apiKeyLoading}
        apiKeyError={apiKeyError}
        apiKeySuccess={apiKeySuccess}
        onCreateApiKey={onCreateApiKey}
        onUpdateApiKey={onUpdateApiKey}
        onDeleteApiKey={onDeleteApiKey}
      />
    </div>
  );
};
