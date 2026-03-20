import { memo, useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowUpDown, CheckCircle2, Loader2, RefreshCw, Settings2, Shield, X, XCircle,
} from "lucide-react";
import type { ApiType, ProxyConfig, ModelRecord, UpstreamTestResult } from "../types";
import { formatTimeFull } from "../utils";

export const SettingsDrawer = memo(function SettingsDrawer({
  open, configForm, models, saving, isDirty, saveHint, lastSavedAt, saveError,
  syncingModels, syncSuccess, syncError, testingUpstream, testResult, testError,
  onClose, onConfigChange, onApiTypeChange, onRefreshModels, onRunTest,
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
      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-200 ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={onClose}
      />
      <aside className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-base-content/10 bg-base-200 shadow-2xl transition-transform duration-200 ${open ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex shrink-0 items-center justify-between border-b border-base-content/5 px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <Settings2 size={16} /> 配置
          </h3>
          <button className="btn btn-ghost btn-sm btn-circle h-7 w-7 min-h-0" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>

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
                  {m === "capture_only"
                    ? <span className="flex items-center justify-center gap-1.5"><Shield size={12} /> 仅捕获</span>
                    : <span className="flex items-center justify-center gap-1.5"><ArrowUpDown size={12} /> 转发</span>}
                </button>
              ))}
            </div>
          </div>

          {/* api type + base url */}
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
            {syncError   && <p className="rounded bg-error/10 px-2 py-1 text-error">{syncError}</p>}
            {saveError   && <p className="rounded bg-error/10 px-2 py-1 text-error">{saveError}</p>}
            {testError   && <p className="rounded bg-error/10 px-2 py-1 text-error">{testError}</p>}
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
