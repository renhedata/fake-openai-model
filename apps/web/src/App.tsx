import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

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

type ModelRecord = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
};

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

type DetailModalState = {
  title: string;
  markdown: string;
};

type SettingsModalProps = {
  open: boolean;
  configForm: ProxyConfig;
  modeDescription: string;
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
};

const PAGE_SIZE = 20;
const apiTypeToPath = (apiType: ApiType) => (apiType === "responses" ? "/v1/responses" : "/v1/chat/completions");
const pathToApiType = (path: string): ApiType => (path.includes("/responses") ? "responses" : "chat_completions");

const normalizeConfig = (value?: Partial<ProxyConfig>): ProxyConfig => {
  const rawPath = value?.path ?? "/v1/chat/completions";
  const apiType = value?.apiType ?? pathToApiType(rawPath);
  return {
    mode: value?.mode ?? "capture_only",
    apiType,
    baseUrl: value?.baseUrl ?? "https://api.openai.com/v1",
    path: value?.path ?? apiTypeToPath(apiType),
    apiKey: value?.apiKey ?? "",
    modelOverride: value?.modelOverride ?? ""
  };
};

const defaultConfig: ProxyConfig = normalizeConfig();

const emptyState: DashboardState = {
  items: [],
  stats: {
    totalRequests: 0,
    totalPromptTokens: 0,
    totalForwarded: 0,
    totalCaptureOnly: 0
  },
  config: defaultConfig,
  models: []
};

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

const safeStringify = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const getResponseText = (value: unknown): string => {
  if (!value || typeof value !== "object") {
    return "";
  }
  const asRecord = value as {
    choices?: Array<{ message?: { content?: string } }>;
    assistant?: string;
    content?: string;
    output_text?: string;
  };
  if (typeof asRecord.assistant === "string") {
    return asRecord.assistant;
  }
  if (typeof asRecord.output_text === "string") {
    return asRecord.output_text;
  }
  if (typeof asRecord.content === "string") {
    return asRecord.content;
  }
  const messageContent = asRecord.choices?.[0]?.message?.content;
  return typeof messageContent === "string" ? messageContent : "";
};

const buildResponseMarkdown = (value: unknown) => {
  const text = getResponseText(value);
  if (text.trim()) {
    return text;
  }
  return `\`\`\`json\n${safeStringify(value ?? {})}\n\`\`\``;
};

const toPreviewText = (markdown: string, limit = 220) => {
  const compact = markdown.replace(/```[\s\S]*?```/g, "[代码块]").replace(/[#>*_`\-]/g, " ").replace(/\s+/g, " ").trim();
  if (compact.length <= limit) {
    return compact;
  }
  return `${compact.slice(0, limit)}...`;
};

const isLongMarkdown = (value: string) => value.length > 900 || value.split("\n").length > 24;

const MarkdownSurface = ({ markdown }: { markdown: string }) => (
  <div className="markdown-body markdown-surface">
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
      {markdown}
    </ReactMarkdown>
  </div>
);

const ExchangeCard = memo(function ExchangeCard(props: {
  item: ExchangeRecord;
  serial: number;
  onOpenDetail: (title: string, markdown: string) => void;
}) {
  const { item, serial, onOpenDetail } = props;
  const promptMd = item.prompt || "_空_";
  const responseMd = buildResponseMarkdown(item.responseBody);
  const promptLong = isLongMarkdown(promptMd);
  const responseLong = isLongMarkdown(responseMd);

  return (
    <article className="rounded-box border border-base-300 bg-base-100 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-base-content/70">
        <span className="badge badge-outline">#{serial}</span>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge ${item.mode === "forward" ? "badge-info" : "badge-neutral"}`}>{item.mode}</span>
          <span
            className={`badge ${
              item.responseStatus === "success"
                ? "badge-success"
                : item.responseStatus === "error"
                  ? "badge-error"
                  : "badge-warning"
            }`}
          >
            {item.responseStatus}
          </span>
          <span className="badge badge-ghost">{item.promptTokens} tokens</span>
          <span>{formatTime(item.createdAt)}</span>
        </div>
      </div>

      <p className="mb-1 text-xs text-base-content/60">
        model: {item.model}
        {typeof item.durationMs === "number" ? ` · ${item.durationMs}ms` : ""}
        {typeof item.upstreamStatusCode === "number" ? ` · upstream ${item.upstreamStatusCode}` : ""}
      </p>
      {item.upstreamUrl ? <p className="mb-2 text-xs text-base-content/60">upstream: {item.upstreamUrl}</p> : null}
      {item.errorMessage ? <p className="mb-2 text-sm text-error">{item.errorMessage}</p> : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <section className="rounded-box border border-base-300 bg-base-200/50 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">请求 Prompt</h3>
            <button className="btn btn-xs btn-outline" onClick={() => onOpenDetail(`Prompt · ${item.id}`, promptMd)}>
              查看
            </button>
          </div>
          <p className="line-clamp-5 text-sm text-base-content/80">{toPreviewText(promptMd)}</p>
          {promptLong ? <span className="mt-2 inline-block text-xs text-base-content/60">长内容，建议弹窗查看</span> : null}
        </section>

        <section className="rounded-box border border-base-300 bg-base-200/50 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">响应</h3>
            <button className="btn btn-xs btn-outline" onClick={() => onOpenDetail(`Response · ${item.id}`, responseMd)}>
              查看
            </button>
          </div>
          {item.responseStatus === "pending" ? (
            <p className="text-sm text-base-content/70">等待响应中...</p>
          ) : (
            <>
              <p className="line-clamp-5 text-sm text-base-content/80">{toPreviewText(responseMd)}</p>
              {responseLong ? <span className="mt-2 inline-block text-xs text-base-content/60">长内容，建议弹窗查看</span> : null}
            </>
          )}
        </section>
      </div>
    </article>
  );
});

const SettingsModal = memo(function SettingsModal(props: SettingsModalProps) {
  const {
    open,
    configForm,
    modeDescription,
    models,
    saving,
    isDirty,
    saveHint,
    lastSavedAt,
    saveError,
    syncingModels,
    syncSuccess,
    syncError,
    testingUpstream,
    testResult,
    testError,
    onClose,
    onConfigChange,
    onApiTypeChange,
    onRefreshModels,
    onRunTest
  } = props;

  const [modelQuery, setModelQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setModelQuery("");
    }
  }, [open]);

  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    const source = query ? models.filter((item) => item.id.toLowerCase().includes(query)) : models;
    return source.slice(0, 60);
  }, [models, modelQuery]);

  if (!open) {
    return null;
  }

  return (
    <dialog className="modal" open={open}>
      <div className="modal-box max-w-3xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">设置</h3>
          <button className="btn btn-sm btn-ghost" onClick={onClose} type="button">
            关闭
          </button>
        </div>

        <div className="space-y-3">
          <label className="form-control">
            <span className="label-text mb-1 text-sm">模式</span>
            <div role="tablist" className="tabs tabs-boxed grid w-full grid-cols-2">
              <button
                role="tab"
                type="button"
                className={`tab ${configForm.mode === "capture_only" ? "tab-active" : ""}`}
                onClick={() => onConfigChange("mode", "capture_only")}
              >
                仅抓请求
              </button>
              <button
                role="tab"
                type="button"
                className={`tab ${configForm.mode === "forward" ? "tab-active" : ""}`}
                onClick={() => onConfigChange("mode", "forward")}
              >
                抓取并转发
              </button>
            </div>
            <span className="mt-1 text-xs text-base-content/70">{modeDescription}</span>
          </label>

          <label className="form-control">
            <span className="label-text mb-1 text-sm">API Type</span>
            <select className="select select-bordered" value={configForm.apiType} onChange={(event) => onApiTypeChange(event.target.value as ApiType)}>
              <option value="chat_completions">Chat Completions</option>
              <option value="responses">Responses</option>
            </select>
          </label>

          <label className="form-control">
            <span className="label-text mb-1 text-sm">Base URL</span>
            <input
              className="input input-bordered"
              value={configForm.baseUrl}
              onChange={(event) => onConfigChange("baseUrl", event.target.value)}
              placeholder="https://api.openai.com/v1"
            />
            <span className="mt-1 text-xs text-base-content/70">建议填写到 /v1 结尾</span>
          </label>

          <label className="form-control">
            <span className="label-text mb-1 text-sm">API Key（可选）</span>
            <input
              className="input input-bordered"
              type="password"
              value={configForm.apiKey}
              onChange={(event) => onConfigChange("apiKey", event.target.value)}
              placeholder="sk-..."
            />
          </label>

          <label className="form-control">
            <span className="label-text mb-1 text-sm">模型覆盖（可选）</span>
            <input
              className="input input-bordered"
              value={configForm.modelOverride}
              onChange={(event) => onConfigChange("modelOverride", event.target.value)}
              placeholder="输入模型名或从下方列表选择"
            />
            <input
              className="input input-bordered mt-2"
              value={modelQuery}
              onChange={(event) => setModelQuery(event.target.value)}
              placeholder="筛选模型（支持模糊匹配）"
            />
            <div className="mt-2 max-h-32 overflow-auto rounded-box border border-base-300 bg-base-100 p-2">
              {filteredModels.length === 0 ? (
                <p className="text-xs text-base-content/60">无匹配模型</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {filteredModels.map((model) => (
                    <button className="btn btn-xs btn-outline" key={model.id} onClick={() => onConfigChange("modelOverride", model.id)} type="button">
                      {model.id}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </label>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button className={`btn btn-outline ${syncingModels ? "btn-disabled" : ""}`} onClick={onRefreshModels} disabled={syncingModels} type="button">
              {syncingModels ? "同步中..." : "手动同步上游模型"}
            </button>
            <button className={`btn btn-outline ${testingUpstream ? "btn-disabled" : ""}`} onClick={onRunTest} disabled={testingUpstream} type="button">
              {testingUpstream ? "测试中..." : "测试上游模型"}
            </button>
          </div>

          <div className="min-h-5 text-xs text-base-content/70">
            {saving ? "自动保存中..." : saveHint ? saveHint : "配置自动保存已开启"}
            {!saving && !isDirty && lastSavedAt ? ` · ${formatTime(lastSavedAt)}` : ""}
          </div>
          {syncSuccess ? <p className="text-xs text-success">{syncSuccess}</p> : null}
          {syncError ? <p className="text-sm text-error">{syncError}</p> : null}
          {testError ? <p className="text-sm text-error">{testError}</p> : null}
          {testResult ? (
            <div className={`rounded-box border p-3 text-xs ${testResult.ok ? "border-success/40 bg-success/5" : "border-error/40 bg-error/5"}`}>
              <p className="font-semibold">
                测试结果: {testResult.ok ? "可用" : "失败"} · HTTP {testResult.upstreamStatusCode} · {testResult.durationMs}ms
              </p>
              <p className="mt-1 break-all text-base-content/70">{testResult.upstreamUrl}</p>
              <p className="mt-1 text-base-content/80">model: {testResult.model}</p>
              {testResult.preview ? <p className="mt-1 whitespace-pre-wrap text-base-content/80">{testResult.preview}</p> : null}
            </div>
          ) : null}
          {saveError ? <p className="text-sm text-error">{saveError}</p> : null}
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button onClick={onClose} type="button" aria-label="关闭设置">
          关闭
        </button>
      </form>
    </dialog>
  );
});

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
  const [detailModal, setDetailModal] = useState<DetailModalState | null>(null);

  const dirtyRef = useRef(false);
  const lastSavedSignatureRef = useRef(JSON.stringify(defaultConfig));

  useEffect(() => {
    const eventSource = new EventSource("/events/prompts");

    eventSource.onopen = () => setConnected(true);
    eventSource.onerror = () => setConnected(false);
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as DashboardEvent;
        const nextState = data.state ?? emptyState;
        const normalizedConfig = normalizeConfig(nextState.config);
        setDashboard({ ...nextState, config: normalizedConfig });
        if (!dirtyRef.current) {
          setConfigForm(normalizedConfig);
          lastSavedSignatureRef.current = JSON.stringify(normalizedConfig);
        }
      } catch {
        setConnected(false);
      }
    };

    return () => {
      eventSource.close();
      setConnected(false);
    };
  }, []);

  useEffect(() => {
    setVisibleCount((prev) => {
      if (dashboard.items.length <= PAGE_SIZE) {
        return dashboard.items.length;
      }
      return Math.max(Math.min(prev, dashboard.items.length), PAGE_SIZE);
    });
  }, [dashboard.items.length]);

  const statusLabel = useMemo(() => (connected ? "SSE 已连接" : "SSE 断开"), [connected]);
  const modeDescription = useMemo(
    () =>
      configForm.mode === "capture_only"
        ? "仅抓取请求，返回本地假响应。"
        : "抓取请求后转发上游并回传上游响应。",
    [configForm.mode]
  );

  const readErrorMessage = useCallback(async (response: Response) => {
    const raw = await response.text();
    if (!raw) {
      return "请求失败";
    }
    try {
      const payload = JSON.parse(raw) as { error?: { message?: string; detail?: string } };
      if (payload?.error?.detail) {
        return `${payload.error.message ?? "请求失败"}: ${payload.error.detail}`;
      }
      if (payload?.error?.message) {
        return payload.error.message;
      }
      return raw;
    } catch {
      return raw;
    }
  }, []);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setIsDirty(true);
    setSaveError("");
    setSaveHint("已修改，稍后自动保存...");
  }, []);

  const onConfigChange = useCallback(
    <K extends keyof ProxyConfig>(key: K, value: ProxyConfig[K]) => {
      setConfigForm((prev) => ({ ...prev, [key]: value }));
      markDirty();
    },
    [markDirty]
  );

  const onApiTypeChange = useCallback(
    (apiType: ApiType) => {
      setConfigForm((prev) => ({
        ...prev,
        apiType,
        path: apiTypeToPath(apiType)
      }));
      markDirty();
    },
    [markDirty]
  );

  const saveConfig = useCallback(
    async (nextConfig: ProxyConfig) => {
      const nextSignature = JSON.stringify(nextConfig);
      if (nextSignature === lastSavedSignatureRef.current) {
        dirtyRef.current = false;
        setIsDirty(false);
        setSaveHint("已自动保存");
        return true;
      }

      setSaving(true);
      setSaveError("");
      try {
        const response = await fetch("/proxy/config", {
          method: "PUT",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(nextConfig)
        });
        if (!response.ok) {
          throw new Error(await readErrorMessage(response));
        }
        const updated = normalizeConfig((await response.json()) as ProxyConfig);
        setConfigForm(updated);
        setDashboard((prev) => ({ ...prev, config: updated }));
        lastSavedSignatureRef.current = JSON.stringify(updated);
        dirtyRef.current = false;
        setIsDirty(false);
        setLastSavedAt(new Date().toISOString());
        setSaveHint("已自动保存");
        return true;
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : "保存失败");
        setSaveHint("");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [readErrorMessage]
  );

  useEffect(() => {
    if (!isDirty) {
      return;
    }
    const timer = window.setTimeout(() => {
      void saveConfig(configForm);
    }, 1000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [configForm, isDirty, saveConfig]);

  const refreshUpstreamModels = useCallback(async () => {
    setSyncingModels(true);
    setSyncError("");
    setSyncSuccess("");

    if (dirtyRef.current) {
      const saved = await saveConfig(configForm);
      if (!saved) {
        setSyncingModels(false);
        return;
      }
    }

    try {
      const response = await fetch("/proxy/models/refresh", { method: "POST" });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      const payload = (await response.json()) as { data?: ModelRecord[] };
      const models = payload.data ?? [];
      setDashboard((prev) => ({ ...prev, models }));
      setSyncSuccess(`已同步 ${models.length} 个模型`);
      if (configForm.modelOverride && !models.some((model) => model.id === configForm.modelOverride)) {
        onConfigChange("modelOverride", "");
      }
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "同步失败");
    } finally {
      setSyncingModels(false);
    }
  }, [configForm, onConfigChange, readErrorMessage, saveConfig]);

  const runUpstreamTest = useCallback(async () => {
    setTestingUpstream(true);
    setTestError("");
    setTestResult(null);

    if (dirtyRef.current) {
      const saved = await saveConfig(configForm);
      if (!saved) {
        setTestingUpstream(false);
        return;
      }
    }

    try {
      const response = await fetch("/proxy/test", { method: "POST" });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      setTestResult((await response.json()) as UpstreamTestResult);
    } catch (error) {
      setTestError(error instanceof Error ? error.message : "测试失败");
    } finally {
      setTestingUpstream(false);
    }
  }, [configForm, readErrorMessage, saveConfig]);

  const openDetail = useCallback((title: string, markdown: string) => {
    setDetailModal({
      title,
      markdown
    });
  }, []);

  const visibleItems = useMemo(() => dashboard.items.slice(0, visibleCount), [dashboard.items, visibleCount]);

  const onListScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const target = event.currentTarget;
      if (target.scrollTop + target.clientHeight < target.scrollHeight - 220) {
        return;
      }
      setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, dashboard.items.length));
    },
    [dashboard.items.length]
  );

  return (
    <main className="mx-auto max-w-[1880px] space-y-4 px-4 py-5 md:px-6">
      <header className="card border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body gap-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="card-title text-2xl">Fake OpenAI Model Gateway</h1>
            <button className="btn btn-primary btn-sm" onClick={() => setSettingsOpen(true)}>
              打开设置
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`badge ${dashboard.config.mode === "forward" ? "badge-info" : "badge-neutral"}`}>
              {dashboard.config.mode === "capture_only" ? "仅抓请求" : "抓取并转发"}
            </span>
            <span className={`badge ${connected ? "badge-success" : "badge-error"}`}>{statusLabel}</span>
            <span className="text-xs text-base-content/70">{modeDescription}</span>
          </div>
        </div>
      </header>

      <section className="stats w-full border border-base-300 bg-base-100 shadow-sm">
        <div className="stat">
          <div className="stat-title">总请求数</div>
          <div className="stat-value text-3xl">{dashboard.stats.totalRequests}</div>
        </div>
        <div className="stat">
          <div className="stat-title">累计 Prompt Token</div>
          <div className="stat-value text-3xl">{dashboard.stats.totalPromptTokens}</div>
        </div>
        <div className="stat">
          <div className="stat-title">转发请求</div>
          <div className="stat-value text-3xl">{dashboard.stats.totalForwarded}</div>
        </div>
        <div className="stat">
          <div className="stat-title">仅抓请求</div>
          <div className="stat-value text-3xl">{dashboard.stats.totalCaptureOnly}</div>
        </div>
      </section>

      <section className="card border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="card-title text-base">请求与响应记录</h2>
            <span className="badge badge-ghost">
              已加载 {visibleItems.length}/{dashboard.items.length}
            </span>
          </div>

          <div className="max-h-[78vh] space-y-3 overflow-auto pr-1" onScroll={onListScroll}>
            {visibleItems.length === 0 ? (
              <p className="rounded-box border border-base-300 bg-base-200 p-4 text-sm text-base-content/70">暂无数据</p>
            ) : (
              visibleItems.map((item, idx) => <ExchangeCard item={item} serial={dashboard.items.length - idx} onOpenDetail={openDetail} key={item.id} />)
            )}
            {visibleItems.length < dashboard.items.length ? (
              <div className="flex items-center justify-center py-2">
                <button className="btn btn-sm btn-outline" onClick={() => setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, dashboard.items.length))}>
                  加载更多
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <SettingsModal
        open={settingsOpen}
        configForm={configForm}
        modeDescription={modeDescription}
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

      {detailModal ? (
        <dialog className="modal" open>
          <div className="modal-box max-w-5xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold">{detailModal.title}</h3>
              <button className="btn btn-sm btn-ghost" onClick={() => setDetailModal(null)} type="button">
                关闭
              </button>
            </div>
            <div className="max-h-[72vh] overflow-auto pr-1">
              <MarkdownSurface markdown={detailModal.markdown} />
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={() => setDetailModal(null)} type="button" aria-label="关闭内容弹窗">
              关闭
            </button>
          </form>
        </dialog>
      ) : null}
    </main>
  );
};
