import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

export type ProxyMode = "capture_only" | "forward";
export type ApiType = "chat_completions" | "responses";

export type ProxyConfig = {
  mode: ProxyMode;
  apiType: ApiType;
  baseUrl: string;
  path: string;
  apiKey: string;
  modelOverride: string;
};

export type ModelRecord = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
};

export type ExchangeRecord = {
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

export type ExchangeStats = {
  totalRequests: number;
  totalPromptTokens: number;
  totalForwarded: number;
  totalCaptureOnly: number;
};

export type DashboardState = {
  items: ExchangeRecord[];
  stats: ExchangeStats;
  config: ProxyConfig;
  models: ModelRecord[];
};

const listeners = new Set<(latest: ExchangeRecord | null, state: DashboardState) => void>();

const defaultModels: ModelRecord[] = [
  {
    id: "fake-gpt-4o-mini",
    object: "model",
    created: 1710000000,
    owned_by: "fake-model"
  }
];

const pathFromApiType = (apiType: ApiType) => (apiType === "responses" ? "/v1/responses" : "/v1/chat/completions");
const apiTypeFromPath = (path: string): ApiType => (path.includes("/responses") ? "responses" : "chat_completions");

const envApiType: ApiType = process.env.UPSTREAM_API_TYPE === "responses" ? "responses" : "chat_completions";
const envPath = process.env.UPSTREAM_PATH ?? pathFromApiType(envApiType);

const proxyConfig: ProxyConfig = {
  mode: process.env.PROXY_MODE === "forward" ? "forward" : "capture_only",
  apiType: apiTypeFromPath(envPath),
  baseUrl: process.env.UPSTREAM_BASE_URL ?? "https://api.openai.com",
  path: envPath,
  apiKey: process.env.UPSTREAM_API_KEY ?? "",
  modelOverride: process.env.UPSTREAM_MODEL ?? ""
};

const sqlitePath = resolve(process.cwd(), process.env.SQLITE_PATH ?? "data/fake-model.db");
mkdirSync(dirname(sqlitePath), { recursive: true });
type PreparedStatement = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown;
};

type DatabaseLike = {
  exec: (sql: string) => void;
  prepare: (sql: string) => PreparedStatement;
};

const require = createRequire(import.meta.url);

const createDatabase = (path: string): DatabaseLike => {
  try {
    const nodeSqlite = require("node:sqlite") as { DatabaseSync: new (dbPath: string) => DatabaseLike };
    return new nodeSqlite.DatabaseSync(path);
  } catch {}

  try {
    const bunSqlite = require("bun:sqlite") as { Database: new (dbPath: string) => { exec: (sql: string) => void; query: (sql: string) => PreparedStatement } };
    const bunDb = new bunSqlite.Database(path);
    return {
      exec: (sql: string) => bunDb.exec(sql),
      prepare: (sql: string) => bunDb.query(sql)
    };
  } catch {}

  throw new Error("SQLite module not available. Use Bun (bun:sqlite) or Node with node:sqlite.");
};

const db = createDatabase(sqlitePath);

type Migration = {
  version: number;
  up: (database: DatabaseLike) => void;
};

const migrations: Migration[] = [
  {
    version: 1,
    up: (database) => {
      database.exec(`
      CREATE TABLE IF NOT EXISTS proxy_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL,
        api_type TEXT NOT NULL,
        base_url TEXT NOT NULL,
        path TEXT NOT NULL,
        api_key TEXT NOT NULL,
        model_override TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        object TEXT NOT NULL,
        created INTEGER NOT NULL,
        owned_by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exchanges (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        request_body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        response_status TEXT NOT NULL,
        response_body TEXT,
        error_message TEXT,
        upstream_url TEXT,
        upstream_status_code INTEGER,
        duration_ms INTEGER
      );
      `);
    }
  }
];

const getUserVersion = () => {
  const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  if (!row || typeof row !== "object") {
    return 0;
  }
  const value = (row.user_version ?? Object.values(row)[0]) as unknown;
  return typeof value === "number" ? value : Number(value) || 0;
};

const applyMigrations = () => {
  db.exec("PRAGMA journal_mode = WAL");
  let userVersion = getUserVersion();
  for (const migration of migrations.sort((a, b) => a.version - b.version)) {
    if (migration.version <= userVersion) {
      continue;
    }
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
      userVersion = migration.version;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
};

applyMigrations();

const hasConfig = db.prepare("SELECT 1 AS ok FROM proxy_config WHERE id = 1").get() as { ok: number } | undefined;
if (!hasConfig) {
  db.prepare(
    `INSERT INTO proxy_config (id, mode, api_type, base_url, path, api_key, model_override)
     VALUES (1, ?, ?, ?, ?, ?, ?)`
  ).run(
    proxyConfig.mode,
    proxyConfig.apiType,
    proxyConfig.baseUrl,
    proxyConfig.path,
    proxyConfig.apiKey,
    proxyConfig.modelOverride
  );
}

const existingModels = db.prepare("SELECT COUNT(*) AS count FROM models").get() as { count: number };
if (!existingModels.count) {
  const insertModel = db.prepare("INSERT INTO models (id, object, created, owned_by) VALUES (?, ?, ?, ?)");
  for (const item of defaultModels) {
    insertModel.run(item.id, item.object, item.created, item.owned_by);
  }
}

const parseJson = (value: string | null | undefined): unknown => {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

const mapExchangeRow = (row: Record<string, unknown>): ExchangeRecord => ({
  id: String(row.id),
  mode: row.mode === "forward" ? "forward" : "capture_only",
  model: String(row.model),
  prompt: String(row.prompt),
  promptTokens: Number(row.prompt_tokens) || 0,
  requestBody: parseJson(typeof row.request_body === "string" ? row.request_body : undefined),
  createdAt: String(row.created_at),
  completedAt: typeof row.completed_at === "string" ? row.completed_at : undefined,
  responseStatus: row.response_status === "error" ? "error" : row.response_status === "success" ? "success" : "pending",
  responseBody: parseJson(typeof row.response_body === "string" ? row.response_body : undefined),
  errorMessage: typeof row.error_message === "string" ? row.error_message : undefined,
  upstreamUrl: typeof row.upstream_url === "string" ? row.upstream_url : undefined,
  upstreamStatusCode: typeof row.upstream_status_code === "number" ? row.upstream_status_code : undefined,
  durationMs: typeof row.duration_ms === "number" ? row.duration_ms : undefined
});

const mapProxyConfigRow = (row: Record<string, unknown>): ProxyConfig => ({
  mode: row.mode === "forward" ? "forward" : "capture_only",
  apiType: row.api_type === "responses" ? "responses" : "chat_completions",
  baseUrl: String(row.base_url ?? ""),
  path: String(row.path ?? pathFromApiType(row.api_type === "responses" ? "responses" : "chat_completions")),
  apiKey: String(row.api_key ?? ""),
  modelOverride: String(row.model_override ?? "")
});

const mapModelRow = (row: Record<string, unknown>): ModelRecord => ({
  id: String(row.id),
  object: String(row.object),
  created: Number(row.created) || Math.floor(Date.now() / 1000),
  owned_by: String(row.owned_by)
});

const emit = (latest: ExchangeRecord | null) => {
  const state = getDashboardState();
  listeners.forEach((listener) => listener(latest, state));
};

export const addExchange = (params: {
  mode: ProxyMode;
  model: string;
  prompt: string;
  promptTokens: number;
  requestBody: unknown;
}) => {
  const record: ExchangeRecord = {
    id: `x_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    mode: params.mode,
    model: params.model,
    prompt: params.prompt,
    promptTokens: params.promptTokens,
    requestBody: params.requestBody,
    createdAt: new Date().toISOString(),
    responseStatus: "pending"
  };
  db.prepare(
    `INSERT INTO exchanges (
      id, mode, model, prompt, prompt_tokens, request_body, created_at, response_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.mode,
    record.model,
    record.prompt,
    record.promptTokens,
    JSON.stringify(record.requestBody ?? null),
    record.createdAt,
    record.responseStatus
  );
  // No longer delete old records — allow unlimited accumulation
  emit(record);
  return record;
};

export const completeExchange = (
  id: string,
  update: {
    responseStatus: "success" | "error";
    responseBody?: unknown;
    errorMessage?: string;
    upstreamUrl?: string;
    upstreamStatusCode?: number;
    durationMs?: number;
  }
) => {
  const found = db.prepare("SELECT id FROM exchanges WHERE id = ?").get(id) as { id: string } | undefined;
  if (!found) {
    return null;
  }
  const completedAt = new Date().toISOString();
  db.prepare(
    `UPDATE exchanges
     SET response_status = ?, response_body = ?, error_message = ?, upstream_url = ?,
         upstream_status_code = ?, duration_ms = ?, completed_at = ?
     WHERE id = ?`
  ).run(
    update.responseStatus,
    update.responseBody === undefined ? null : JSON.stringify(update.responseBody),
    update.errorMessage ?? null,
    update.upstreamUrl ?? null,
    update.upstreamStatusCode ?? null,
    update.durationMs ?? null,
    completedAt,
    id
  );
  const targetRow = db.prepare("SELECT * FROM exchanges WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!targetRow) {
    return null;
  }
  const target = mapExchangeRow(targetRow);
  emit(target);
  return target;
};

export const getExchanges = () => {
  const rows = db.prepare("SELECT * FROM exchanges ORDER BY created_at DESC, id DESC LIMIT 200").all() as Array<
    Record<string, unknown>
  >;
  return rows.map(mapExchangeRow);
};

export type PaginatedResult = {
  items: ExchangeRecord[];
  nextCursor: string | null;
  total: number;
};

export const getExchangesPaginated = (params: {
  cursor?: string;
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  search?: string;
}): PaginatedResult => {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const conditions: string[] = [];
  const args: unknown[] = [];

  if (params.cursor) {
    // cursor is the created_at of the last item on the current page
    conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
    args.push(params.cursor, params.cursor, params.cursor);
  }
  if (params.dateFrom) {
    conditions.push("created_at >= ?");
    args.push(params.dateFrom);
  }
  if (params.dateTo) {
    conditions.push("created_at <= ?");
    args.push(params.dateTo);
  }
  if (params.status && params.status !== "all") {
    conditions.push("response_status = ?");
    args.push(params.status);
  }
  if (params.search) {
    conditions.push("(prompt LIKE ? OR model LIKE ? OR error_message LIKE ?)");
    const like = `%${params.search}%`;
    args.push(like, like, like);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Get total count matching filters (without cursor)
  const countConditions = conditions.filter((_, i) => {
    // Skip cursor condition (first condition if cursor was provided)
    if (params.cursor && i === 0) return false;
    return true;
  });
  const countArgs = params.cursor ? args.slice(3) : [...args];
  const countWhere = countConditions.length > 0 ? `WHERE ${countConditions.join(" AND ")}` : "";
  const countRow = db.prepare(`SELECT COUNT(*) AS count FROM exchanges ${countWhere}`).get(...countArgs) as { count: number };
  const total = Number(countRow.count) || 0;

  const rows = db.prepare(
    `SELECT * FROM exchanges ${where} ORDER BY created_at DESC, id DESC LIMIT ?`
  ).all(...args, limit + 1) as Array<Record<string, unknown>>;

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(mapExchangeRow);
  const lastItem = items[items.length - 1];
  const nextCursor = hasMore && lastItem ? lastItem.createdAt : null;

  return { items, nextCursor, total };
};

export const getExchangeStats = (): ExchangeStats => {
  const row = db
    .prepare(
      `SELECT
        COUNT(*) AS total_requests,
        COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
        COALESCE(SUM(CASE WHEN mode = 'forward' THEN 1 ELSE 0 END), 0) AS total_forwarded,
        COALESCE(SUM(CASE WHEN mode = 'capture_only' THEN 1 ELSE 0 END), 0) AS total_capture_only
      FROM exchanges`
    )
    .get() as Record<string, unknown>;

  return {
    totalRequests: Number(row.total_requests) || 0,
    totalPromptTokens: Number(row.total_prompt_tokens) || 0,
    totalForwarded: Number(row.total_forwarded) || 0,
    totalCaptureOnly: Number(row.total_capture_only) || 0
  };
};

export const getProxyConfig = (): ProxyConfig => {
  const row = db.prepare("SELECT * FROM proxy_config WHERE id = 1").get() as Record<string, unknown> | undefined;
  if (!row) {
    return { ...proxyConfig };
  }
  return mapProxyConfigRow(row);
};

export const setProxyConfig = (next: Partial<ProxyConfig>) => {
  const current = getProxyConfig();
  const updated: ProxyConfig = { ...current };

  if (next.mode) {
    updated.mode = next.mode;
  }
  if (next.apiType) {
    updated.apiType = next.apiType;
    updated.path = pathFromApiType(next.apiType);
  }
  if (typeof next.baseUrl === "string") {
    updated.baseUrl = next.baseUrl.trim();
  }
  if (typeof next.path === "string") {
    updated.path = next.path.trim();
    updated.apiType = apiTypeFromPath(updated.path);
  }
  if (typeof next.apiKey === "string") {
    updated.apiKey = next.apiKey.trim();
  }
  if (typeof next.modelOverride === "string") {
    updated.modelOverride = next.modelOverride.trim();
  }
  db.prepare(
    `INSERT INTO proxy_config (id, mode, api_type, base_url, path, api_key, model_override)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mode = excluded.mode,
       api_type = excluded.api_type,
       base_url = excluded.base_url,
       path = excluded.path,
       api_key = excluded.api_key,
       model_override = excluded.model_override`
  ).run(updated.mode, updated.apiType, updated.baseUrl, updated.path, updated.apiKey, updated.modelOverride);
  emit(null);
  return updated;
};

export const getModels = () => {
  const rows = db.prepare("SELECT id, object, created, owned_by FROM models ORDER BY id ASC").all() as Array<
    Record<string, unknown>
  >;
  if (rows.length === 0) {
    return [...defaultModels];
  }
  return rows.map(mapModelRow);
};

export const setModels = (items: ModelRecord[]) => {
  const uniq = new Map<string, ModelRecord>();
  for (const item of items) {
    const id = item.id.trim();
    if (!id) {
      continue;
    }
    uniq.set(id, {
      id,
      object: item.object || "model",
      created: Number.isFinite(item.created) ? item.created : Math.floor(Date.now() / 1000),
      owned_by: item.owned_by || "upstream"
    });
  }

  const nextModels = uniq.size === 0 ? [...defaultModels] : Array.from(uniq.values()).slice(0, 200);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM models").run();
    const insertModel = db.prepare("INSERT INTO models (id, object, created, owned_by) VALUES (?, ?, ?, ?)");
    for (const item of nextModels) {
      insertModel.run(item.id, item.object, item.created, item.owned_by);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const config = getProxyConfig();
  if (config.modelOverride && !nextModels.some((item) => item.id === config.modelOverride)) {
    setProxyConfig({ modelOverride: "" });
    return getModels();
  }
  emit(null);
  return getModels();
};

export const deleteExchanges = (ids: string[]) => {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  const result = db.prepare(`DELETE FROM exchanges WHERE id IN (${placeholders})`).run(...ids);
  emit(null);
  return typeof result === "object" && result !== null && "changes" in result
    ? Number((result as { changes: number }).changes)
    : ids.length;
};

export const deleteAllExchanges = () => {
  db.prepare("DELETE FROM exchanges").run();
  emit(null);
};

export const getDashboardState = (): DashboardState => ({
  items: [...getExchanges()],
  stats: getExchangeStats(),
  config: getProxyConfig(),
  models: getModels()
});

export const subscribeExchangeUpdated = (listener: (latest: ExchangeRecord | null, state: DashboardState) => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
