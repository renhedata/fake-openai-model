import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

export type ProxyMode = "forward";
export type ApiType = "chat_completions" | "responses";

export type ProxyConfig = {
  mode: ProxyMode;
  apiType: ApiType;
  baseUrl: string;
  path: string;
  apiKey: string;
  modelOverride: string;
};

export type ProviderFormat = "openai" | "claude" | "gemini" | "ollama";
export type AuthStyle = "bearer" | "x-api-key";

export type Provider = {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  path: string;
  apiType: ApiType;
  format: ProviderFormat;
  authStyle: AuthStyle;
  enabled: boolean;
  models: string[];
  defaultMaxTokens?: number;
  createdAt: string;
};

export type ApiKey = {
  id: string;
  key: string;
  name: string;
  allowedModels: string[] | null;
  enabled: boolean;
  createdAt: string;
};

export type ModelRecord = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  providerId?: string;
};

export type ExchangeRecord = {
  id: string;
  mode: ProxyMode;
  model: string;
  prompt: string;
  promptTokens: number;
  requestBody: unknown;
  translatedRequestBody?: unknown;
  createdAt: string;
  completedAt?: string;
  responseStatus: "pending" | "success" | "error";
  responseBody?: unknown;
  translatedResponseBody?: unknown;
  errorMessage?: string;
  upstreamUrl?: string;
  upstreamStatusCode?: number;
  durationMs?: number;
  apiKeyId?: string;
  apiKeyName?: string;
  agentType?: "openclaw" | "hermes" | null;
};

export type ExchangeStats = {
  totalRequests: number;
  totalPromptTokens: number;
  totalForwarded: number;
};

/** Lightweight version without the heavy items array — used for SSE pushes */
export type DashboardMeta = {
  stats: ExchangeStats;
  config: ProxyConfig;
  providers: Provider[];
  apiKeys: ApiKey[];
  models: ModelRecord[];
};

const listeners = new Set<(latest: ExchangeRecord | null, meta: DashboardMeta) => void>();

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
  mode: "forward",
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
        duration_ms INTEGER,
        translated_request_body TEXT,
        translated_response_body TEXT
      );
      `);
    }
  },
  {
    version: 2,
    up: (database) => {
      // Optimize: add indexes for commonly queried columns
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_exchanges_created_at ON exchanges (created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_exchanges_status ON exchanges (response_status);
        CREATE INDEX IF NOT EXISTS idx_exchanges_model ON exchanges (model);
      `);
    }
  },
  {
    version: 3,
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS providers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          base_url TEXT NOT NULL,
          api_key TEXT NOT NULL,
          path TEXT NOT NULL DEFAULT '/v1/chat/completions',
          api_type TEXT NOT NULL DEFAULT 'chat_completions',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          key TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          allowed_models TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
      `);
      // Add provider_id to models if not exists (SQLite doesn't support IF NOT EXISTS on ALTER)
      try {
        database.exec(`ALTER TABLE models ADD COLUMN provider_id TEXT;`);
      } catch { /* already exists */ }
      // Add models column to providers
      try {
        database.exec(`ALTER TABLE providers ADD COLUMN models TEXT DEFAULT '[]';`);
      } catch { /* already exists */ }
      // Migrate existing proxy_config into a default provider
      const configRow = database.prepare("SELECT * FROM proxy_config WHERE id = 1").get() as Record<string, unknown> | undefined;
      if (configRow) {
        const existing = database.prepare("SELECT 1 AS ok FROM providers WHERE id = 'default'").get() as { ok: number } | undefined;
        if (!existing) {
          database.prepare(
            `INSERT INTO providers (id, name, base_url, api_key, path, api_type, enabled, created_at)
             VALUES ('default', 'Default', ?, ?, ?, ?, 1, ?)`
          ).run(
            String(configRow.base_url ?? "https://api.openai.com"),
            String(configRow.api_key ?? ""),
            String(configRow.path ?? "/v1/chat/completions"),
            String(configRow.api_type ?? "chat_completions"),
            new Date().toISOString()
          );
        }
      }
    }
  },
  {
    version: 4,
    up: (database) => {
      // Ensure providers have models column
      try {
        database.exec(`ALTER TABLE providers ADD COLUMN models TEXT DEFAULT '[]';`);
      } catch { /* already exists */ }
      // Sync existing provider_id from models table into providers.models
      const providerRows = database.prepare("SELECT id FROM providers").all() as Array<{ id: string }>;
      for (const p of providerRows) {
        const modelRows = database.prepare("SELECT id FROM models WHERE provider_id = ?").all(p.id) as Array<{ id: string }>;
        if (modelRows.length > 0) {
          database.prepare("UPDATE providers SET models = ? WHERE id = ?")
            .run(JSON.stringify(modelRows.map((m) => m.id)), p.id);
        }
      }
    }
  },
  {
    version: 5,
    up: (database) => {
      try {
        database.exec(`ALTER TABLE providers ADD COLUMN provider_type TEXT DEFAULT 'custom';`);
      } catch { /* already exists */ }
    }
  },
  {
    version: 6,
    up: (database) => {
      try {
        database.exec(`ALTER TABLE providers ADD COLUMN format TEXT DEFAULT 'openai';`);
      } catch { /* already exists */ }
      try {
        database.exec(`ALTER TABLE providers ADD COLUMN auth_style TEXT DEFAULT 'bearer';`);
      } catch { /* already exists */ }
      // Migrate existing providers: kimi/minimax -> claude format + x-api-key
      const claudeProviders = ['kimi', 'minimax'];
      for (const pid of claudeProviders) {
        database.prepare(`UPDATE providers SET format = 'claude', auth_style = 'x-api-key' WHERE id = ?`).run(pid);
      }
    }
  },
  {
    version: 7,
    up: (database) => {
      try {
        database.exec(`ALTER TABLE exchanges ADD COLUMN translated_request_body TEXT;`);
      } catch { /* already exists */ }
      try {
        database.exec(`ALTER TABLE exchanges ADD COLUMN translated_response_body TEXT;`);
      } catch { /* already exists */ }
    }
  },
  {
    version: 8,
    up: (database) => {
      try {
        database.exec(`ALTER TABLE exchanges ADD COLUMN api_key_id TEXT;`);
      } catch { /* already exists */ }
      try {
        database.exec(`ALTER TABLE exchanges ADD COLUMN api_key_name TEXT;`);
      } catch { /* already exists */ }
      try {
        database.exec(`ALTER TABLE exchanges ADD COLUMN agent_type TEXT;`);
      } catch { /* already exists */ }
    }
  },
  {
    version: 9,
    up: (database) => {
      try {
        database.exec(`ALTER TABLE providers ADD COLUMN default_max_tokens INTEGER;`);
      } catch { /* already exists */ }
    }
  },
  {
    version: 10,
    up: (database) => {
      // MiniMax uses only OpenAI-compatible API (/v1/chat/completions); it has no /v1/messages endpoint.
      // Migration v6 incorrectly set it to "claude" format, causing every Anthropic-format request to 404.
      // Kimi is intentionally left as-is — it may be configured to use /v1/messages (Anthropic format).
      database.prepare(
        `UPDATE providers SET format = 'openai' WHERE id = 'minimax' AND format = 'claude'`
      ).run();
    }
  },
  {
    version: 11,
    up: (database) => {
      // Migration v6 set format='claude' for Anthropic-compatible providers but left their path as the
      // OpenAI default '/v1/chat/completions'. Claude-format providers use the Anthropic Messages API
      // at /v1/messages, not /v1/chat/completions.
      database.prepare(
        `UPDATE providers SET path = '/v1/messages' WHERE format = 'claude' AND path = '/v1/chat/completions'`
      ).run();
    }
  },
  {
    version: 12,
    up: (database) => {
      // Migration v11 incorrectly changed kimi's path to '/v1/messages'.
      // Kimi exposes the Anthropic format at '/v1/chat/completions', not '/v1/messages'.
      database.prepare(
        `UPDATE providers SET path = '/v1/chat/completions' WHERE id = 'kimi' AND path = '/v1/messages'`
      ).run();
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
  mode: "forward",
  model: String(row.model),
  prompt: String(row.prompt),
  promptTokens: Number(row.prompt_tokens) || 0,
  requestBody: parseJson(typeof row.request_body === "string" ? row.request_body : undefined),
  translatedRequestBody: parseJson(typeof row.translated_request_body === "string" ? row.translated_request_body : undefined),
  createdAt: String(row.created_at),
  completedAt: typeof row.completed_at === "string" ? row.completed_at : undefined,
  responseStatus: row.response_status === "error" ? "error" : row.response_status === "success" ? "success" : "pending",
  responseBody: parseJson(typeof row.response_body === "string" ? row.response_body : undefined),
  translatedResponseBody: parseJson(typeof row.translated_response_body === "string" ? row.translated_response_body : undefined),
  errorMessage: typeof row.error_message === "string" ? row.error_message : undefined,
  upstreamUrl: typeof row.upstream_url === "string" ? row.upstream_url : undefined,
  upstreamStatusCode: typeof row.upstream_status_code === "number" ? row.upstream_status_code : undefined,
  durationMs: typeof row.duration_ms === "number" ? row.duration_ms : undefined,
  apiKeyId: typeof row.api_key_id === "string" ? row.api_key_id : undefined,
  apiKeyName: typeof row.api_key_name === "string" ? row.api_key_name : undefined,
  agentType: (typeof row.agent_type === "string" ? row.agent_type : undefined) as ExchangeRecord["agentType"]
});

const mapProxyConfigRow = (row: Record<string, unknown>): ProxyConfig => ({
  mode: "forward",
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
  owned_by: String(row.owned_by),
  providerId: typeof row.provider_id === "string" ? row.provider_id : undefined
});

const mapProviderRow = (row: Record<string, unknown>): Provider => {
  let models: string[] = [];
  if (typeof row.models === "string" && row.models) {
    try {
      const parsed = JSON.parse(row.models) as unknown;
      if (Array.isArray(parsed)) models = parsed as string[];
    } catch { /* ignore */ }
  }
  return {
    id: String(row.id),
    name: String(row.name),
    providerType: typeof row.provider_type === "string" ? row.provider_type : "custom",
    baseUrl: String(row.base_url),
    apiKey: String(row.api_key),
    path: String(row.path),
    apiType: row.api_type === "responses" ? "responses" : "chat_completions",
    format: (typeof row.format === "string" ? row.format : "openai") as ProviderFormat,
    authStyle: (typeof row.auth_style === "string" ? row.auth_style : "bearer") as AuthStyle,
    enabled: row.enabled === 1 || row.enabled === true,
    models,
    defaultMaxTokens: typeof row.default_max_tokens === "number" ? row.default_max_tokens : undefined,
    createdAt: String(row.created_at)
  };
};

const mapApiKeyRow = (row: Record<string, unknown>): ApiKey => {
  let allowedModels: string[] | null = null;
  if (typeof row.allowed_models === "string" && row.allowed_models) {
    try {
      const parsed = JSON.parse(row.allowed_models) as unknown;
      if (Array.isArray(parsed)) allowedModels = parsed as string[];
    } catch { /* ignore */ }
  }
  return {
    id: String(row.id),
    key: String(row.key),
    name: String(row.name),
    allowedModels,
    enabled: row.enabled === 1 || row.enabled === true,
    createdAt: String(row.created_at)
  };
};

const emit = (latest: ExchangeRecord | null) => {
  const meta = getDashboardMeta();
  listeners.forEach((listener) => listener(latest, meta));
};

export const addExchange = (params: {
  mode: ProxyMode;
  model: string;
  prompt: string;
  promptTokens: number;
  requestBody: unknown;
  translatedRequestBody?: unknown;
  apiKeyId?: string;
  apiKeyName?: string;
  agentType?: "openclaw" | "hermes" | null;
}) => {
  const record: ExchangeRecord = {
    id: `x_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    mode: params.mode,
    model: params.model,
    prompt: params.prompt,
    promptTokens: params.promptTokens,
    requestBody: params.requestBody,
    translatedRequestBody: params.translatedRequestBody,
    createdAt: new Date().toISOString(),
    responseStatus: "pending",
    apiKeyId: params.apiKeyId,
    apiKeyName: params.apiKeyName,
    agentType: params.agentType
  };
  db.prepare(
    `INSERT INTO exchanges (
      id, mode, model, prompt, prompt_tokens, request_body, translated_request_body, created_at, response_status,
      api_key_id, api_key_name, agent_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.mode,
    record.model,
    record.prompt,
    record.promptTokens,
    JSON.stringify(record.requestBody ?? null),
    record.translatedRequestBody === undefined ? null : JSON.stringify(record.translatedRequestBody),
    record.createdAt,
    record.responseStatus,
    record.apiKeyId ?? null,
    record.apiKeyName ?? null,
    record.agentType ?? null
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
    translatedResponseBody?: unknown;
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
     SET response_status = ?, response_body = ?, translated_response_body = ?, error_message = ?, upstream_url = ?,
         upstream_status_code = ?, duration_ms = ?, completed_at = ?
     WHERE id = ?`
  ).run(
    update.responseStatus,
    update.responseBody === undefined ? null : JSON.stringify(update.responseBody),
    update.translatedResponseBody === undefined ? null : JSON.stringify(update.translatedResponseBody),
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
  apiKeyId?: string;
  agentType?: string;
}): PaginatedResult => {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const conditions: string[] = [];
  const args: unknown[] = [];

  if (params.cursor) {
    // cursor is "created_at||id" of the last item on the current page
    const sepIdx = params.cursor.indexOf("||");
    const cursorAt = sepIdx >= 0 ? params.cursor.slice(0, sepIdx) : params.cursor;
    const cursorId = sepIdx >= 0 ? params.cursor.slice(sepIdx + 2) : "";
    conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
    args.push(cursorAt, cursorAt, cursorId);
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
  if (params.apiKeyId) {
    conditions.push("api_key_id = ?");
    args.push(params.apiKeyId);
  }
  if (params.agentType) {
    conditions.push("agent_type = ?");
    args.push(params.agentType);
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
  const nextCursor = hasMore && lastItem ? `${lastItem.createdAt}||${lastItem.id}` : null;

  return { items, nextCursor, total };
};

export const getExchangeStats = (): ExchangeStats => {
  const row = db
    .prepare(
      `SELECT
        COUNT(*) AS total_requests,
        COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
        COALESCE(SUM(CASE WHEN mode = 'forward' THEN 1 ELSE 0 END), 0) AS total_forwarded
      FROM exchanges`
    )
    .get() as Record<string, unknown>;

  return {
    totalRequests: Number(row.total_requests) || 0,
    totalPromptTokens: Number(row.total_prompt_tokens) || 0,
    totalForwarded: Number(row.total_forwarded) || 0
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
  const rows = db.prepare("SELECT id, object, created, owned_by, provider_id FROM models ORDER BY id ASC").all() as Array<
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
      owned_by: item.owned_by || "upstream",
      providerId: item.providerId
    });
  }

  const nextModels = uniq.size === 0 ? [...defaultModels] : Array.from(uniq.values()).slice(0, 200);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM models").run();
    const insertModel = db.prepare("INSERT INTO models (id, object, created, owned_by, provider_id) VALUES (?, ?, ?, ?, ?)");
    for (const item of nextModels) {
      insertModel.run(item.id, item.object, item.created, item.owned_by, item.providerId ?? null);
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

export const addModel = (item: ModelRecord) => {
  db.prepare("INSERT OR REPLACE INTO models (id, object, created, owned_by, provider_id) VALUES (?, ?, ?, ?, ?)")
    .run(item.id, item.object || "model", Number.isFinite(item.created) ? item.created : Math.floor(Date.now() / 1000), item.owned_by || "upstream", item.providerId ?? null);
  // If bound to a provider, also append to provider's models list (deduped)
  if (item.providerId) {
    const provider = getProviderById(item.providerId);
    if (provider) {
      const models = new Set(provider.models ?? []);
      models.add(item.id);
      db.prepare("UPDATE providers SET models = ? WHERE id = ?")
        .run(JSON.stringify(Array.from(models)), item.providerId);
    }
  }
  emit(null);
  return getModels();
};

export const deleteModel = (id: string): boolean => {
  const existing = db.prepare("SELECT provider_id FROM models WHERE id = ?").get(id) as { provider_id: string | null } | undefined;
  const result = db.prepare("DELETE FROM models WHERE id = ?").run(id);
  const changes = typeof result === "object" && result !== null && "changes" in result
    ? Number((result as { changes: number }).changes)
    : 0;
  if (changes > 0) {
    // Also remove from provider's models list if bound
    if (existing?.provider_id) {
      const provider = getProviderById(existing.provider_id);
      if (provider) {
        const models = (provider.models ?? []).filter((m) => m !== id);
        db.prepare("UPDATE providers SET models = ? WHERE id = ?")
          .run(JSON.stringify(models), existing.provider_id);
      }
    }
    emit(null);
    return true;
  }
  return false;
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

/** Lightweight: stats + config + providers + apiKeys + models, NO items */
export const getDashboardMeta = (): DashboardMeta => ({
  stats: getExchangeStats(),
  config: getProxyConfig(),
  providers: getProviders(),
  apiKeys: getApiKeys(),
  models: getModels()
});

// --- Providers ---

export const getProviders = (): Provider[] => {
  const rows = db.prepare("SELECT * FROM providers ORDER BY created_at ASC").all() as Array<Record<string, unknown>>;
  return rows.map(mapProviderRow);
};

export const getProviderById = (id: string): Provider | null => {
  const row = db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapProviderRow(row) : null;
};

export const setProvider = (provider: Provider): Provider => {
  db.prepare(
    `INSERT INTO providers (id, name, provider_type, base_url, api_key, path, api_type, format, auth_style, enabled, models, default_max_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       provider_type = excluded.provider_type,
       base_url = excluded.base_url,
       api_key = excluded.api_key,
       path = excluded.path,
       api_type = excluded.api_type,
       format = excluded.format,
       auth_style = excluded.auth_style,
       enabled = excluded.enabled,
       models = excluded.models,
       default_max_tokens = excluded.default_max_tokens`
  ).run(
    provider.id,
    provider.name,
    provider.providerType,
    provider.baseUrl,
    provider.apiKey,
    provider.path,
    provider.apiType,
    provider.format,
    provider.authStyle,
    provider.enabled ? 1 : 0,
    JSON.stringify(provider.models ?? []),
    provider.defaultMaxTokens ?? null,
    provider.createdAt
  );
  // Sync provider.models into global models table
  const modelIds = provider.models ?? [];
  if (modelIds.length > 0) {
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM models WHERE provider_id = ?").run(provider.id);
      const insertModel = db.prepare("INSERT INTO models (id, object, created, owned_by, provider_id) VALUES (?, ?, ?, ?, ?)");
      const now = Math.floor(Date.now() / 1000);
      for (const id of modelIds) {
        insertModel.run(id, "model", now, provider.id, provider.id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  emit(null);
  return provider;
};

/** Update models for a specific provider without deleting other providers' models from the global models table. */
export const setProviderModels = (providerId: string, modelIds: string[]): Provider => {
  const provider = getProviderById(providerId);
  if (!provider) {
    throw new Error(`Provider '${providerId}' not found`);
  }
  const updated: Provider = { ...provider, models: modelIds };
  db.prepare("UPDATE providers SET models = ? WHERE id = ?")
    .run(JSON.stringify(modelIds), providerId);
  // Update global models table: remove old models for this provider, add new ones
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM models WHERE provider_id = ?").run(providerId);
    const insertModel = db.prepare("INSERT INTO models (id, object, created, owned_by, provider_id) VALUES (?, ?, ?, ?, ?)");
    const now = Math.floor(Date.now() / 1000);
    for (const id of modelIds) {
      insertModel.run(id, "model", now, providerId, providerId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  emit(null);
  return updated;
};

export const deleteProvider = (id: string): boolean => {
  const result = db.prepare("DELETE FROM providers WHERE id = ?").run(id);
  const changes = typeof result === "object" && result !== null && "changes" in result
    ? Number((result as { changes: number }).changes)
    : 0;
  if (changes > 0) {
    emit(null);
    return true;
  }
  return false;
};

// --- API Keys ---

export const getApiKeys = (): ApiKey[] => {
  const rows = db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
  return rows.map(mapApiKeyRow);
};

export const getApiKeyByKeyString = (key: string): ApiKey | null => {
  const row = db.prepare("SELECT * FROM api_keys WHERE key = ? AND enabled = 1").get(key) as Record<string, unknown> | undefined;
  return row ? mapApiKeyRow(row) : null;
};

export const createApiKey = (params: { id: string; key: string; name: string; allowedModels?: string[] | null }): ApiKey => {
  const record: ApiKey = {
    id: params.id,
    key: params.key,
    name: params.name,
    allowedModels: params.allowedModels ?? null,
    enabled: true,
    createdAt: new Date().toISOString()
  };
  db.prepare(
    `INSERT INTO api_keys (id, key, name, allowed_models, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.key,
    record.name,
    record.allowedModels ? JSON.stringify(record.allowedModels) : null,
    1,
    record.createdAt
  );
  emit(null);
  return record;
};

export const deleteApiKey = (id: string): boolean => {
  const result = db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
  const changes = typeof result === "object" && result !== null && "changes" in result
    ? Number((result as { changes: number }).changes)
    : 0;
  if (changes > 0) {
    emit(null);
    return true;
  }
  return false;
};

export const updateApiKey = (id: string, update: Partial<Pick<ApiKey, "name" | "enabled" | "allowedModels">>): ApiKey | null => {
  const existing = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!existing) return null;
  const current = mapApiKeyRow(existing);
  const next: ApiKey = {
    ...current,
    name: update.name ?? current.name,
    enabled: update.enabled !== undefined ? update.enabled : current.enabled,
    allowedModels: update.allowedModels !== undefined ? update.allowedModels : current.allowedModels
  };
  db.prepare(
    `UPDATE api_keys SET name = ?, enabled = ?, allowed_models = ? WHERE id = ?`
  ).run(
    next.name,
    next.enabled ? 1 : 0,
    next.allowedModels ? JSON.stringify(next.allowedModels) : null,
    id
  );
  emit(null);
  return next;
};

export type SeedRecord = {
  mode: ProxyMode;
  model: string;
  prompt: string;
  promptTokens: number;
  requestBody: unknown;
  responseStatus: "success" | "error";
  responseBody?: unknown;
  errorMessage?: string;
  upstreamStatusCode?: number;
  durationMs?: number;
};

/** Insert many exchanges in a single transaction with one SSE emit at the end */
export const bulkSeedExchanges = (records: SeedRecord[]): number => {
  const stmt = db.prepare(
    `INSERT INTO exchanges (id, mode, model, prompt, prompt_tokens, request_body,
       created_at, completed_at, response_status, response_body,
       error_message, upstream_status_code, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const now = Date.now();
  db.exec("BEGIN");
  try {
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const id = `x_${now - i * 10}_${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = new Date(now - i * 1000).toISOString();
      const completedAt = new Date(now - i * 1000 + (r.durationMs ?? 0)).toISOString();
      stmt.run(
        id, r.mode, r.model, r.prompt, r.promptTokens,
        JSON.stringify(r.requestBody ?? null),
        createdAt, completedAt, r.responseStatus,
        r.responseBody === undefined ? null : JSON.stringify(r.responseBody),
        r.errorMessage ?? null, r.upstreamStatusCode ?? null, r.durationMs ?? null
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  emit(null);
  return records.length;
};

export const subscribeExchangeUpdated = (listener: (latest: ExchangeRecord | null, meta: DashboardMeta) => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
