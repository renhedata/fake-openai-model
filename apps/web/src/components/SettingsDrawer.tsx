import { memo, useEffect, useMemo, useState } from "react";
import {
  Activity, CheckCircle2, Copy, Key, Loader2,
  Pencil, Plus, RefreshCw, Settings2, Trash2, X, XCircle, Server,
} from "lucide-react";
import type { ModelRecord, Provider, ApiKey, UpstreamTestResult } from "../types";
import { BUILTIN_PROVIDERS, defaultProviderTemplates, generateProviderId, resolveUpstreamUrl } from "../utils";

type TabKey = "providers" | "apikeys";

interface ProviderFormState {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  path: string;
  apiType: "chat_completions" | "responses";
  format: "openai" | "claude" | "gemini" | "ollama";
  authStyle: "bearer" | "x-api-key";
  models: string[];
  defaultMaxTokens: string;
}

const emptyProviderForm = (): ProviderFormState => ({
  id: "", name: "", providerType: "custom", baseUrl: "", apiKey: "", path: "/v1/chat/completions", apiType: "chat_completions", format: "openai", authStyle: "bearer", models: [], defaultMaxTokens: "",
});

const providerFormFromProvider = (p: Provider): ProviderFormState => ({
  id: p.id, name: p.name, providerType: p.providerType, baseUrl: p.baseUrl, apiKey: p.apiKey, path: p.path, apiType: p.apiType, format: p.format, authStyle: p.authStyle, models: p.models ?? [], defaultMaxTokens: p.defaultMaxTokens != null ? String(p.defaultMaxTokens) : "",
});

export const SettingsDrawer = memo(function SettingsDrawer({
  open,
  // Providers tab
  providers,
  models,
  providerLoading,
  providerError,
  providerSuccess,
  onAddProvider,
  onUpdateProvider,
  onDeleteProvider,
  onRefreshProviderModels,
  onTestModel,
  onAddModel,
  onDeleteModel,
  // API Keys tab
  apiKeys,
  apiKeyLoading,
  apiKeyError,
  apiKeySuccess,
  onCreateApiKey,
  onUpdateApiKey,
  onDeleteApiKey,
  onClose,
}: {
  open: boolean;
  // Providers
  providers: Provider[];
  models: ModelRecord[];
  providerLoading: boolean;
  providerError: string;
  providerSuccess: string;
  onAddProvider: (provider: Omit<Provider, "id" | "createdAt" | "enabled">) => void;
  onUpdateProvider: (id: string, provider: Partial<Provider>) => void;
  onDeleteProvider: (id: string) => void;
  onRefreshProviderModels: (id: string) => Promise<void>;
  onTestModel: (modelId: string) => Promise<UpstreamTestResult>;
  onAddModel: (model: Omit<ModelRecord, "object" | "created" | "owned_by"> & Partial<Pick<ModelRecord, "object" | "created" | "owned_by">>) => void;
  onDeleteModel: (id: string) => void;
  // API Keys
  apiKeys: ApiKey[];
  apiKeyLoading: boolean;
  apiKeyError: string;
  apiKeySuccess: string;
  onCreateApiKey: (name: string, allowedModels: string[] | null) => void;
  onUpdateApiKey: (id: string, allowedModels: string[] | null) => void;
  onDeleteApiKey: (id: string) => void;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<TabKey>("providers");
  useEffect(() => { if (!open) setActiveTab("providers"); }, [open]);

  // Provider form state
  const [providerForm, setProviderForm] = useState<ProviderFormState>(emptyProviderForm());
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [providerTemplate, setProviderTemplate] = useState<string>("");

  // Provider refresh state (per-provider)
  const [syncingProviderId, setSyncingProviderId] = useState<string | null>(null);
  const [syncProviderError, setSyncProviderError] = useState("");
  const [syncProviderSuccess, setSyncProviderSuccess] = useState("");

  // Model test state
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [testModelResult, setTestModelResult] = useState<UpstreamTestResult | null>(null);
  const [testModelError, setTestModelError] = useState("");

  // Manual model add state
  const [manualModelProviderId, setManualModelProviderId] = useState("");
  const [manualModelId, setManualModelId] = useState("");

  // API Key form state
  const [apiKeyName, setApiKeyName] = useState("");
  const [apiKeyAllowedModels, setApiKeyAllowedModels] = useState("");

  // API Key edit state
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [editingKeyModels, setEditingKeyModels] = useState("");

  // Copy key state
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);

  // Filter models: only show those bound to a provider
  const boundModels = useMemo(() => models.filter((m) => !!m.providerId), [models]);

  // Group models by provider
  const modelsByProvider = useMemo(() => {
    const map = new Map<string, ModelRecord[]>();
    for (const m of boundModels) {
      const pid = m.providerId!;
      if (!map.has(pid)) map.set(pid, []);
      map.get(pid)!.push(m);
    }
    return map;
  }, [boundModels]);

  const handleApplyTemplate = (templateId: string) => {
    const tmpl = defaultProviderTemplates[templateId];
    if (!tmpl) return;
    setProviderForm((prev) => ({
      ...prev,
      providerType: templateId,
      name: tmpl.name,
      baseUrl: tmpl.baseUrl,
      path: tmpl.path,
      apiType: tmpl.apiType,
      format: tmpl.format,
      authStyle: tmpl.authStyle,
      models: tmpl.models ?? [],
    }));
  };

  const handleProviderSubmit = () => {
    const isCustom = providerForm.providerType === "custom";
    const name = providerForm.name.trim();
    const baseUrl = providerForm.baseUrl.trim();
    if (!name || (isCustom && !baseUrl)) return;
    const id = providerForm.id.trim() || generateProviderId(name);
    const payload = {
      id,
      name,
      providerType: providerForm.providerType,
      baseUrl: isCustom ? baseUrl : providerForm.baseUrl.trim(),
      apiKey: providerForm.apiKey.trim(),
      path: isCustom ? (providerForm.path.trim() || "/v1/chat/completions") : providerForm.path.trim(),
      apiType: providerForm.apiType,
      format: providerForm.format,
      authStyle: providerForm.authStyle,
      models: providerForm.models ?? [],
      ...(providerForm.defaultMaxTokens.trim() ? { defaultMaxTokens: parseInt(providerForm.defaultMaxTokens, 10) } : {}),
    };
    if (editingProviderId) {
      onUpdateProvider(editingProviderId, payload);
    } else {
      onAddProvider(payload);
    }
    setShowProviderForm(false);
    setEditingProviderId(null);
    setProviderForm(emptyProviderForm());
    setProviderTemplate("");
  };

  const handleEditProvider = (p: Provider) => {
    setProviderForm(providerFormFromProvider(p));
    setEditingProviderId(p.id);
    setShowProviderForm(true);
    setProviderTemplate("");
  };

  const handleCancelProviderForm = () => {
    setShowProviderForm(false);
    setEditingProviderId(null);
    setProviderForm(emptyProviderForm());
    setProviderTemplate("");
  };

  const handleRefreshProviderModels = async (id: string) => {
    setSyncingProviderId(id);
    setSyncProviderError("");
    setSyncProviderSuccess("");
    try {
      await onRefreshProviderModels(id);
      setSyncProviderSuccess("同步完成");
    } catch (e) {
      setSyncProviderError(e instanceof Error ? e.message : "同步失败");
    } finally {
      setSyncingProviderId(null);
    }
  };

  const handleTestModel = async (modelId: string) => {
    setTestingModelId(modelId);
    setTestModelResult(null);
    setTestModelError("");
    try {
      const result = await onTestModel(modelId);
      setTestModelResult(result);
    } catch (e) {
      setTestModelError(e instanceof Error ? e.message : "测试失败");
    } finally {
      setTestingModelId(null);
    }
  };

  const handleCreateApiKey = () => {
    const name = apiKeyName.trim();
    if (!name) return;
    const allowed = apiKeyAllowedModels.trim()
      ? apiKeyAllowedModels.split(",").map((s) => s.trim()).filter(Boolean)
      : null;
    onCreateApiKey(name, allowed && allowed.length > 0 ? allowed : null);
    setApiKeyName("");
    setApiKeyAllowedModels("");
  };

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKeyId(id);
      setTimeout(() => setCopiedKeyId((prev) => (prev === id ? null : prev)), 2000);
    } catch { /* ignore */ }
  };

  const tabs: { key: TabKey; label: string; icon: typeof Server }[] = [
    { key: "providers", label: "提供商", icon: Server },
    { key: "apikeys", label: "密钥", icon: Key },
  ];

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-200 ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={onClose}
      />
      <aside className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-2xl flex-col border-l border-base-content/10 bg-base-200 shadow-2xl transition-transform duration-200 ${open ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex shrink-0 items-center justify-between border-b border-base-content/5 px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <Settings2 size={16} /> 配置
          </h3>
          <button className="btn btn-ghost btn-sm btn-circle h-7 w-7 min-h-0" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 border-b border-base-content/5">
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTab(t.key)}
                className={`flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
                  activeTab === t.key
                    ? "border-b-2 border-primary text-primary"
                    : "text-base-content/40 hover:text-base-content/60"
                }`}
              >
                <Icon size={13} /> {t.label}
              </button>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* ===== Providers Tab ===== */}
          {activeTab === "providers" && (
            <>
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-base-content/60">上游提供商</h4>
                <button
                  type="button"
                  className="btn btn-primary btn-xs gap-1 h-6 min-h-0 text-xs"
                  onClick={() => { setShowProviderForm(true); setEditingProviderId(null); setProviderForm(emptyProviderForm()); setProviderTemplate(""); }}
                  disabled={showProviderForm}
                >
                  <Plus size={11} /> 添加
                </button>
              </div>

              {providerError && <p className="rounded bg-error/10 px-2 py-1 text-xs text-error">{providerError}</p>}
              {providerSuccess && <p className="rounded bg-success/10 px-2 py-1 text-xs text-success">{providerSuccess}</p>}

              {/* Provider Form */}
              {showProviderForm && (
                <div className="rounded-lg border border-base-content/10 bg-base-100 p-3 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <h5 className="text-xs font-semibold">{editingProviderId ? "编辑提供商" : "添加提供商"}</h5>
                    <button type="button" className="text-base-content/30 hover:text-base-content/60" onClick={handleCancelProviderForm}>
                      <X size={13} />
                    </button>
                  </div>

                  {/* Provider Type */}
                  <div>
                    <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-base-content/40">提供商类型</label>
                    <select
                      className="select select-bordered select-sm w-full bg-base-100 text-xs"
                      value={providerForm.providerType}
                      onChange={(e) => { const val = e.target.value; setProviderTemplate(val); handleApplyTemplate(val); }}
                    >
                      {Object.entries(BUILTIN_PROVIDERS).map(([key, cfg]) => (
                        <option key={key} value={key}>{cfg.name}</option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-base-content/40">名称</label>
                      <input
                        className="input input-bordered input-sm w-full bg-base-100 text-xs"
                        value={providerForm.name}
                        onChange={(e) => setProviderForm((p) => ({ ...p, name: e.target.value }))}
                        placeholder="显示名称"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-base-content/40">ID</label>
                      <input
                        className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                        value={providerForm.id}
                        onChange={(e) => setProviderForm((p) => ({ ...p, id: e.target.value }))}
                        placeholder={generateProviderId(providerForm.name)}
                        disabled={!!editingProviderId}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-base-content/40">API Key</label>
                    <input
                      className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                      type="password"
                      value={providerForm.apiKey}
                      onChange={(e) => setProviderForm((p) => ({ ...p, apiKey: e.target.value }))}
                      placeholder="sk-..."
                    />
                  </div>

                  {/* Show baseUrl/path/apiType for custom or in a collapsed section */}
                  {providerForm.providerType === "custom" && (
                    <>
                      <div>
                        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-base-content/40">Base URL</label>
                        <input
                          className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                          value={providerForm.baseUrl}
                          onChange={(e) => setProviderForm((p) => ({ ...p, baseUrl: e.target.value }))}
                          placeholder="https://api.example.com/v1"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-base-content/40">路径</label>
                          <input
                            className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                            value={providerForm.path}
                            onChange={(e) => setProviderForm((p) => ({ ...p, path: e.target.value }))}
                            placeholder="/v1/chat/completions"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-base-content/40">API 类型</label>
                          <select
                            className="select select-bordered select-sm w-full bg-base-100 text-xs"
                            value={providerForm.apiType}
                            onChange={(e) => setProviderForm((p) => ({ ...p, apiType: e.target.value as "chat_completions" | "responses" }))}
                          >
                            <option value="chat_completions">Chat</option>
                            <option value="responses">Responses</option>
                          </select>
                        </div>
                      </div>
                    </>
                  )}

                  {providerForm.providerType !== "custom" && (
                    <div className="rounded bg-base-200/50 px-2 py-1.5 space-y-0.5">
                      <p className="font-mono text-[10px] text-base-content/40 truncate">{resolveUpstreamUrl(providerForm.baseUrl, providerForm.path || "")}</p>
                      <div className="flex items-center gap-1.5 text-[10px] text-base-content/30">
                        <span>API: {providerForm.apiType === "chat_completions" ? "Chat" : "Responses"}</span>
                        <span className={`rounded px-1 py-0 text-[9px] ${providerForm.format === 'claude' ? 'bg-purple-500/10 text-purple-500/70' : 'bg-base-content/5 text-base-content/30'}`}>{providerForm.format}</span>
                        <span className={`rounded px-1 py-0 text-[9px] ${providerForm.authStyle === 'x-api-key' ? 'bg-orange-500/10 text-orange-500/70' : 'bg-base-content/5 text-base-content/30'}`}>{providerForm.authStyle}</span>
                      </div>
                    </div>
                  )}

                  {providerForm.format === "claude" && (
                    <div>
                      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-base-content/40">默认 Max Tokens（留空则用 4096）</label>
                      <input
                        className="input input-bordered input-sm w-full bg-base-100 font-mono text-xs"
                        type="number"
                        min={1}
                        value={providerForm.defaultMaxTokens}
                        onChange={(e) => setProviderForm((p) => ({ ...p, defaultMaxTokens: e.target.value }))}
                        placeholder="4096"
                      />
                    </div>
                  )}

                  <div className="flex justify-end gap-2 pt-1">
                    <button type="button" className="btn btn-ghost btn-xs h-6 min-h-0 text-xs" onClick={handleCancelProviderForm}>取消</button>
                    <button
                      type="button"
                      className="btn btn-primary btn-xs h-6 min-h-0 text-xs"
                      onClick={handleProviderSubmit}
                      disabled={!providerForm.name.trim() || (providerForm.providerType === "custom" && !providerForm.baseUrl.trim()) || providerLoading}
                    >
                      {providerLoading ? <Loader2 size={11} className="animate-spin" /> : editingProviderId ? "保存" : "添加"}
                    </button>
                  </div>
                </div>
              )}

              {/* Provider List */}
              <div className="space-y-2">
                {providers.length === 0 ? (
                  <p className="py-6 text-center text-xs text-base-content/30">暂无提供商，点击上方按钮添加</p>
                ) : (
                  providers.map((p) => (
                    <div key={p.id} className="rounded-lg border border-base-content/10 bg-base-100 p-3 space-y-2">
                      <div className="flex items-start justify-between">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold">{p.name}</span>
                            <span className={`rounded px-1 py-0 text-[9px] font-medium ${p.enabled ? "bg-success/10 text-success" : "bg-base-content/5 text-base-content/30"}`}>
                              {p.enabled ? "启用" : "禁用"}
                            </span>
                            <span className="rounded bg-base-200 px-1 py-0 text-[9px] text-base-content/30">
                              {p.providerType}
                            </span>
                            <span className={`rounded px-1 py-0 text-[9px] font-medium ${p.format === 'claude' ? 'bg-purple-500/10 text-purple-500/70' : 'bg-base-content/5 text-base-content/30'}`}>
                              {p.format}
                            </span>
                            <span className={`rounded px-1 py-0 text-[9px] font-medium ${p.authStyle === 'x-api-key' ? 'bg-orange-500/10 text-orange-500/70' : 'bg-base-content/5 text-base-content/30'}`}>
                              {p.authStyle}
                            </span>
                            {p.models && p.models.length > 0 && (
                              <span className="rounded bg-primary/5 px-1 py-0 text-[9px] text-primary/60">
                                {p.models.length} 模型
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 font-mono text-[10px] text-base-content/40 truncate">{resolveUpstreamUrl(p.baseUrl, p.path || "")}</p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs btn-circle h-6 w-6 min-h-0"
                            onClick={() => handleEditProvider(p)}
                            title="编辑"
                          >
                            <Settings2 size={11} />
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs btn-circle h-6 w-6 min-h-0 text-error/50 hover:text-error"
                            onClick={() => onDeleteProvider(p.id)}
                            title="删除"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          className="btn btn-outline btn-xs gap-1 h-5 min-h-0 text-[10px]"
                          onClick={() => handleRefreshProviderModels(p.id)}
                          disabled={syncingProviderId === p.id}
                        >
                          <RefreshCw size={10} className={syncingProviderId === p.id ? "animate-spin" : ""} />
                          {syncingProviderId === p.id ? "同步中…" : "同步模型"}
                        </button>
                        <span className="ml-auto text-[9px] text-base-content/25 tabular-nums">{p.id}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Sync feedback */}
              {syncProviderError && (
                <p className="rounded bg-error/10 px-2 py-1 text-xs text-error">{syncProviderError}</p>
              )}
              {syncProviderSuccess && (
                <p className="rounded bg-success/10 px-2 py-1 text-xs text-success">{syncProviderSuccess}</p>
              )}

              {/* ===== Model Management Section ===== */}
              <div className="border-t border-base-content/5 pt-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-base-content/60">模型管理</h4>
                  <span className="shrink-0 text-[10px] text-base-content/30">{boundModels.length} 个</span>
                </div>

                {/* Manual add model */}
                <div className="mt-2 rounded-lg border border-base-content/10 bg-base-100 p-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <select
                      className="select select-bordered select-sm bg-base-100 text-xs flex-1"
                      value={manualModelProviderId}
                      onChange={(e) => setManualModelProviderId(e.target.value)}
                    >
                      <option value="">选择提供商</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    <input
                      className="input input-bordered input-sm bg-base-100 font-mono text-xs flex-[2]"
                      value={manualModelId}
                      onChange={(e) => setManualModelId(e.target.value)}
                      placeholder="模型 ID，例如 gpt-4o"
                    />
                    <button
                      type="button"
                      className="btn btn-primary btn-xs h-6 min-h-0 text-xs"
                      onClick={() => {
                        const pid = manualModelProviderId.trim();
                        const mid = manualModelId.trim();
                        if (!pid || !mid) return;
                        onAddModel({ id: mid, providerId: pid });
                        setManualModelId("");
                      }}
                      disabled={!manualModelProviderId.trim() || !manualModelId.trim()}
                    >
                      <Plus size={11} />
                    </button>
                  </div>
                </div>

                {/* Models grouped by provider */}
                <div className="mt-2 space-y-3">
                  {providers.map((p) => {
                    const providerModels = modelsByProvider.get(p.id) ?? [];
                    if (providerModels.length === 0) return null;
                    return (
                      <div key={p.id} className="rounded-lg border border-base-content/10 bg-base-100">
                        <div className="flex items-center gap-1.5 border-b border-base-content/5 px-2.5 py-1.5">
                          <span className="text-[10px] font-semibold">{p.name}</span>
                          <span className="text-[9px] text-base-content/30">({providerModels.length})</span>
                        </div>
                        <div className="divide-y divide-base-content/5">
                          {providerModels.map((m) => (
                            <div key={m.id} className="flex items-center justify-between px-2.5 py-1.5">
                              <div className="min-w-0 flex-1">
                                <p className="font-mono text-[10px] truncate">{p.id}/{m.id}</p>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-xs btn-circle h-5 w-5 min-h-0 text-base-content/30 hover:text-primary"
                                  onClick={() => handleTestModel(m.id)}
                                  disabled={testingModelId === m.id}
                                  title="测试"
                                >
                                  <Activity size={10} className={testingModelId === m.id ? "animate-pulse" : ""} />
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-xs btn-circle h-5 w-5 min-h-0 text-error/40 hover:text-error"
                                  onClick={() => onDeleteModel(m.id)}
                                  title="删除"
                                >
                                  <Trash2 size={10} />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {boundModels.length === 0 && (
                    <p className="py-4 text-center text-[10px] text-base-content/30">暂无模型，点击提供商的「同步模型」拉取</p>
                  )}
                </div>

                {/* Model test feedback */}
                {testModelError && (
                  <p className="mt-2 rounded bg-error/10 px-2 py-1 text-xs text-error">{testModelError}</p>
                )}
                {testModelResult && (
                  <div className={`mt-2 rounded-lg border p-2.5 ${testModelResult.ok ? "border-success/20 bg-success/5" : "border-error/20 bg-error/5"}`}>
                    <p className="font-semibold">
                      {testModelResult.ok ? <CheckCircle2 size={11} className="inline text-success" /> : <XCircle size={11} className="inline text-error" />}
                      {" "}HTTP {testModelResult.upstreamStatusCode} · {testModelResult.durationMs}ms
                    </p>
                    <p className="mt-0.5 font-mono text-base-content/40 text-[10px] break-all">{testModelResult.upstreamUrl}</p>
                    <p className="text-base-content/50">model: {testModelResult.model}</p>
                    {testModelResult.preview && <p className="mt-1 whitespace-pre-wrap text-base-content/60">{testModelResult.preview}</p>}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ===== API Keys Tab ===== */}
          {activeTab === "apikeys" && (
            <>
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-base-content/60">API 密钥</h4>
              </div>

              {apiKeyError && <p className="rounded bg-error/10 px-2 py-1 text-xs text-error">{apiKeyError}</p>}
              {apiKeySuccess && <p className="rounded bg-success/10 px-2 py-1 text-xs text-success">{apiKeySuccess}</p>}

              {/* Create Key Form */}
              <div className="rounded-lg border border-base-content/10 bg-base-100 p-3 space-y-2.5">
                <h5 className="text-xs font-semibold">生成新密钥</h5>
                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-base-content/40">名称</label>
                  <input
                    className="input input-bordered input-sm w-full bg-base-100 text-xs"
                    value={apiKeyName}
                    onChange={(e) => setApiKeyName(e.target.value)}
                    placeholder="例如：生产环境"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-base-content/40">
                    允许模型 <span className="font-normal text-base-content/25">（留空表示全部）</span>
                  </label>
                  <input
                    className="input input-bordered input-sm w-full bg-base-100 text-xs"
                    value={apiKeyAllowedModels}
                    onChange={(e) => setApiKeyAllowedModels(e.target.value)}
                    placeholder="kimi-k2.5, MiniMax-M2, ..."
                  />
                  <p className="mt-0.5 text-[9px] text-base-content/25">用逗号分隔多个模型 ID</p>
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="btn btn-primary btn-xs gap-1 h-6 min-h-0 text-xs"
                    onClick={handleCreateApiKey}
                    disabled={!apiKeyName.trim() || apiKeyLoading}
                  >
                    {apiKeyLoading ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                    生成密钥
                  </button>
                </div>
              </div>

              {/* API Key List */}
              <div className="space-y-2">
                {apiKeys.length === 0 ? (
                  <p className="py-6 text-center text-xs text-base-content/30">暂无密钥，使用上方表单生成</p>
                ) : (
                  apiKeys.map((k) => (
                    <div key={k.id} className="rounded-lg border border-base-content/10 bg-base-100 p-3 space-y-2">
                      <div className="flex items-start justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold">{k.name}</span>
                            <span className={`rounded px-1 py-0 text-[9px] font-medium ${k.enabled ? "bg-success/10 text-success" : "bg-base-content/5 text-base-content/30"}`}>
                              {k.enabled ? "启用" : "禁用"}
                            </span>
                          </div>
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <code className="rounded bg-base-200 px-1.5 py-0.5 font-mono text-[10px] text-base-content/50 truncate max-w-[200px]">
                              {k.key.slice(0, 16)}…
                            </code>
                            <button
                              type="button"
                              className="text-base-content/30 hover:text-primary transition-colors"
                              onClick={() => copyToClipboard(k.key, k.id)}
                              title="复制"
                            >
                              {copiedKeyId === k.id ? <CheckCircle2 size={12} className="text-success" /> : <Copy size={12} />}
                            </button>
                          </div>
                          {k.allowedModels && k.allowedModels.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {k.allowedModels.map((m) => (
                                <span key={m} className="rounded bg-primary/5 px-1 py-0 font-mono text-[9px] text-primary/60">{m}</span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs btn-circle h-6 w-6 min-h-0 text-base-content/30 hover:text-primary"
                            onClick={() => {
                              setEditingKeyId(k.id);
                              setEditingKeyModels(k.allowedModels ? k.allowedModels.join(", ") : "");
                            }}
                            title="编辑模型权限"
                          >
                            <Pencil size={11} />
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs btn-circle h-6 w-6 min-h-0 text-error/50 hover:text-error"
                            onClick={() => onDeleteApiKey(k.id)}
                            title="删除"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </div>
                      {editingKeyId === k.id && (
                        <div className="pt-1 space-y-2 border-t border-base-content/10 mt-1">
                          <label className="block text-[10px] font-semibold uppercase tracking-wider text-base-content/40">
                            允许模型 <span className="font-normal text-base-content/25">（留空表示全部）</span>
                          </label>
                          <input
                            className="input input-bordered input-sm w-full bg-base-100 text-xs"
                            value={editingKeyModels}
                            onChange={(e) => setEditingKeyModels(e.target.value)}
                            placeholder="kimi-k2.5, MiniMax-M2, ..."
                          />
                          <p className="text-[9px] text-base-content/25">用逗号分隔多个模型 ID</p>
                          <div className="flex justify-end gap-1.5">
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs h-6 min-h-0 text-xs"
                              onClick={() => setEditingKeyId(null)}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="btn btn-primary btn-xs h-6 min-h-0 text-xs"
                              disabled={apiKeyLoading}
                              onClick={() => {
                                const models = editingKeyModels.trim()
                                  ? editingKeyModels.split(",").map((s) => s.trim()).filter(Boolean)
                                  : null;
                                onUpdateApiKey(k.id, models);
                                setEditingKeyId(null);
                              }}
                            >
                              {apiKeyLoading ? <Loader2 size={11} className="animate-spin" /> : null}
                              保存
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
});
