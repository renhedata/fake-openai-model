import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowUpDown, BookOpen, Calendar, CheckSquare, ChevronDown,
  Coins, Filter, Loader2, MinusSquare, Moon, Radio, Search, Send,
  Server, Settings2, Shield, Square, Sun, Trash2, X, Zap,
} from "lucide-react";
import type { ApiType, DashboardEvent, ExchangeRecord, ModelRecord, ProxyConfig, UpstreamTestResult } from "./types";
import { type PaginatedResult } from "./types";
import {
  PAGE_SIZE, RENDER_BATCH_SIZE,
  apiTypeToPath, normalizeConfig, defaultConfig, emptyMeta,
  getCompletionTokens,
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
  const [helpOpen, setHelpOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "error" | "pending">("all");

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

  const dirtyRef = useRef(false);
  const lastSavedSignatureRef = useRef(JSON.stringify(defaultConfig));

  const fetchExchanges = useCallback(async (cursor?: string) => {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    if (cursor) params.set("cursor", cursor);
    if (dateFrom) params.set("dateFrom", new Date(dateFrom + "T00:00:00").toISOString());
    if (dateTo) params.set("dateTo", new Date(dateTo + "T23:59:59.999").toISOString());
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (searchQuery.trim()) params.set("search", searchQuery.trim());
    const r = await fetch(`/exchanges?${params.toString()}`);
    if (!r.ok) return null;
    return (await r.json()) as PaginatedResult;
  }, [dateFrom, dateTo, statusFilter, searchQuery]);

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
          const meta = data.meta ?? (data.state ? { stats: data.state.stats, config: data.state.config, models: data.state.models } : null);
          if (meta) {
            const nc = normalizeConfig(meta.config);
            setDashboardMeta({ stats: meta.stats, config: nc, models: meta.models });
            if (!dirtyRef.current) { setConfigForm(nc); lastSavedSignatureRef.current = JSON.stringify(nc); }
          }
          if (data.latest) {
            const latest = data.latest;
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
    const q = searchQuery.trim().toLowerCase();
    if (q) items = items.filter((i) =>
      i.prompt.toLowerCase().includes(q) || i.model.toLowerCase().includes(q) ||
      i.id.toLowerCase().includes(q) || (i.errorMessage ?? "").toLowerCase().includes(q)
    );
    return items;
  }, [paginatedItems, statusFilter, searchQuery]);

  const [renderCount, setRenderCount] = useState(RENDER_BATCH_SIZE);
  useEffect(() => { setRenderCount(RENDER_BATCH_SIZE); }, [filteredItems]);
  useEffect(() => {
    if (renderCount >= filteredItems.length) return;
    const raf = requestAnimationFrame(() => setRenderCount((prev) => Math.min(prev + RENDER_BATCH_SIZE, filteredItems.length)));
    return () => cancelAnimationFrame(raf);
  }, [renderCount, filteredItems.length]);
  const visibleItems = filteredItems.slice(0, renderCount);

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
      setDashboardMeta((p) => ({ ...p, config: updated }));
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
      setDashboardMeta((p) => ({ ...p, models: m }));
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
          const existingIds = new Set(prev.map((i) => i.id));
          return [...prev, ...result.items.filter((i) => !existingIds.has(i.id))];
        });
        setNextCursor(result.nextCursor);
        setTotalCount(result.total);
      }
    } finally { setLoadingMore(false); }
  }, [nextCursor, loadingMore, fetchExchanges]);

  const onListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const t = e.currentTarget;
    if (t.scrollTop + t.clientHeight < t.scrollHeight - 200) return;
    void loadMore();
  }, [loadMore]);

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
      setSelectedIds(new Set());
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
    () => (expandedId ? visibleItems.find((i) => i.id === expandedId) ?? null : null),
    [expandedId, visibleItems]
  );
  const selectedSerial = useMemo(() => {
    if (!selectedItem) return 0;
    const idx = visibleItems.indexOf(selectedItem);
    return idx === -1 ? 0 : totalCount - idx;
  }, [selectedItem, visibleItems, totalCount]);

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
            <Badge variant={dashboardMeta.config.mode === "forward" ? "info" : "default"}>
              {dashboardMeta.config.mode === "forward" ? "Forward" : "Capture"}
            </Badge>
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
      <div className="shrink-0 grid grid-cols-2 gap-2 border-b border-base-content/5 bg-base-300/50 px-4 py-2 sm:grid-cols-4 lg:grid-cols-6">
        <StatMini icon={Activity}    label="请求"    value={stats.totalRequests}                                       delay={0} />
        <StatMini icon={Send}        label="入 Tokens" value={stats.totalPromptTokens.toLocaleString()}               delay={50} />
        <StatMini icon={Zap}         label="出 Tokens" value={totalCompletionTokens.toLocaleString()}                 delay={100} />
        <StatMini icon={Coins}       label="总 Tokens" value={(stats.totalPromptTokens + totalCompletionTokens).toLocaleString()} delay={150} />
        <StatMini icon={ArrowUpDown} label="转发"    value={stats.totalForwarded}                                     delay={200} />
        <StatMini icon={Shield}      label="捕获"    value={stats.totalCaptureOnly}                                   delay={250} />
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
          <div className="flex-1 overflow-y-auto border-r border-base-content/5" onScroll={onListScroll}>
            <div className="space-y-1 p-2">
              {visibleItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-base-content/25 animate-fade-slide-in">
                  <Radio size={28} className="mb-2 opacity-30" />
                  <p className="text-sm">{searchQuery || statusFilter !== "all" || hasDateFilter ? "无匹配记录" : "等待请求中…"}</p>
                  {!searchQuery && statusFilter === "all" && !hasDateFilter && (
                    <p className="mt-1 text-xs text-base-content/15">发送一个 API 请求到代理端点开始使用</p>
                  )}
                </div>
              ) : (
                visibleItems.map((item, idx) => (
                  <ExchangeRow
                    key={item.id} item={item} serial={totalCount - idx}
                    expanded={expandedId === item.id}
                    onToggle={() => setExpandedId((p) => (p === item.id ? null : item.id))}
                    selectMode={selectMode} selected={selectedIds.has(item.id)} onSelect={onSelectItem}
                  />
                ))
              )}
              {nextCursor && (
                <div className="flex justify-center py-2">
                  <button className="btn btn-ghost btn-sm gap-1.5 text-xs" onClick={() => void loadMore()} disabled={loadingMore}>
                    {loadingMore ? <><Loader2 size={12} className="animate-spin" /> 加载中…</> : <><ChevronDown size={12} /> 加载更多 ({totalCount - paginatedItems.length > 0 ? totalCount - paginatedItems.length : "..."} 条)</>}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {selectedItem && (
          <div className="flex-1 overflow-hidden bg-base-200/30">
            <ExchangeDetail item={selectedItem} serial={selectedSerial} onClose={() => setExpandedId(null)} />
          </div>
        )}
      </div>

      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      <SettingsDrawer
        open={settingsOpen} configForm={configForm} models={dashboardMeta.models}
        saving={saving} isDirty={isDirty} saveHint={saveHint} lastSavedAt={lastSavedAt} saveError={saveError}
        syncingModels={syncingModels} syncSuccess={syncSuccess} syncError={syncError}
        testingUpstream={testingUpstream} testResult={testResult} testError={testError}
        onClose={() => setSettingsOpen(false)} onConfigChange={onConfigChange}
        onApiTypeChange={onApiTypeChange} onRefreshModels={refreshUpstreamModels} onRunTest={runUpstreamTest}
      />
    </div>
  );
};
