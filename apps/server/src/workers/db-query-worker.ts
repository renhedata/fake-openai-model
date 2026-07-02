import { workerData, parentPort } from "node:worker_threads";
import { createRequire } from "node:module";

type PreparedStatement = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
};

type DatabaseLike = {
  exec: (sql: string) => void;
  prepare: (sql: string) => PreparedStatement;
};

type ExchangeRecord = {
  id: string;
  mode: string;
  model: string;
  prompt: string;
  promptTokens: number;
  completionTokens?: number;
  createdAt: string;
  completedAt?: string;
  responseStatus: "pending" | "success" | "error";
  errorMessage?: string;
  upstreamUrl?: string;
  upstreamStatusCode?: number;
  durationMs?: number;
  apiKeyId?: string;
  apiKeyName?: string;
  agentType?: "openclaw" | "hermes" | null;
  lastUserMessage?: string;
};

type PaginatedResult = {
  items: ExchangeRecord[];
  nextCursor: string | null;
  total: number;
};

type QueryParams = {
  cursor?: string;
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  search?: string;
  apiKeyId?: string;
  agentType?: string;
};

const { sqlitePath } = workerData as { sqlitePath: string };
const require = createRequire(import.meta.url);

const openDb = (): DatabaseLike => {
  try {
    const ns = require("node:sqlite") as { DatabaseSync: new (p: string) => DatabaseLike };
    return new ns.DatabaseSync(sqlitePath);
  } catch {}
  try {
    const bs = require("bun:sqlite") as {
      Database: new (p: string) => { exec: (s: string) => void; query: (s: string) => PreparedStatement };
    };
    const d = new bs.Database(sqlitePath);
    return { exec: (s) => d.exec(s), prepare: (s) => d.query(s) };
  } catch {}
  throw new Error("SQLite not available in worker");
};

const db = openDb();
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA temp_store = MEMORY");
db.exec("PRAGMA cache_size = -16000");

const toFtsQuery = (search: string): string => {
  const cleaned = search.replace(/["""*^()[\]{}!]/g, " ").trim();
  return cleaned ? `"${cleaned}"` : '""';
};

const mapRow = (row: Record<string, unknown>): ExchangeRecord => ({
  id: String(row.id),
  mode: "forward",
  model: String(row.model),
  prompt: String(row.prompt),
  promptTokens: Number(row.prompt_tokens) || 0,
  completionTokens: typeof row.completion_tokens === "number" ? row.completion_tokens : undefined,
  createdAt: String(row.created_at),
  completedAt: typeof row.completed_at === "string" ? row.completed_at : undefined,
  responseStatus:
    row.response_status === "error" ? "error" : row.response_status === "success" ? "success" : "pending",
  errorMessage: typeof row.error_message === "string" ? row.error_message : undefined,
  upstreamUrl: typeof row.upstream_url === "string" ? row.upstream_url : undefined,
  upstreamStatusCode: typeof row.upstream_status_code === "number" ? row.upstream_status_code : undefined,
  durationMs: typeof row.duration_ms === "number" ? row.duration_ms : undefined,
  apiKeyId: typeof row.api_key_id === "string" ? row.api_key_id : undefined,
  apiKeyName: typeof row.api_key_name === "string" ? row.api_key_name : undefined,
  agentType: (typeof row.agent_type === "string" ? row.agent_type : undefined) as ExchangeRecord["agentType"],
  lastUserMessage: typeof row.last_user_message === "string" ? row.last_user_message : undefined,
});

const runQuery = (params: QueryParams): PaginatedResult => {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const conditions: string[] = [];
  const args: unknown[] = [];

  if (params.cursor) {
    const sepIdx = params.cursor.indexOf("||");
    const cursorAt = sepIdx >= 0 ? params.cursor.slice(0, sepIdx) : params.cursor;
    const cursorId = sepIdx >= 0 ? params.cursor.slice(sepIdx + 2) : "";
    conditions.push("(e.created_at < ? OR (e.created_at = ? AND e.id < ?))");
    args.push(cursorAt, cursorAt, cursorId);
  }
  if (params.dateFrom) { conditions.push("e.created_at >= ?"); args.push(params.dateFrom); }
  if (params.dateTo) { conditions.push("e.created_at <= ?"); args.push(params.dateTo); }
  if (params.status && params.status !== "all") { conditions.push("e.response_status = ?"); args.push(params.status); }
  if (params.apiKeyId) { conditions.push("e.api_key_id = ?"); args.push(params.apiKeyId); }
  if (params.agentType) { conditions.push("e.agent_type = ?"); args.push(params.agentType); }

  const ftsQuery = params.search ? toFtsQuery(params.search) : "";
  const useFts = !!ftsQuery && ftsQuery !== '""';
  const joinClause = useFts ? "JOIN exchanges_fts ON exchanges_fts.id = e.id" : "";
  if (useFts) { conditions.push("exchanges_fts MATCH ?"); args.push(ftsQuery); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countConditions = conditions.filter((_, i) => !(params.cursor && i === 0));
  const countArgs = params.cursor ? args.slice(3) : [...args];
  const countWhere = countConditions.length > 0 ? `WHERE ${countConditions.join(" AND ")}` : "";
  const countRow = db
    .prepare(`SELECT COUNT(*) AS count FROM exchanges e ${joinClause} ${countWhere}`)
    .get(...countArgs) as { count: number };
  const total = Number(countRow.count) || 0;

  const rows = db
    .prepare(
      `SELECT e.id, e.mode, e.model, SUBSTR(e.prompt, 1, 300) AS prompt, e.prompt_tokens, e.completion_tokens, e.created_at, e.completed_at,
       e.response_status, e.error_message, e.upstream_url, e.upstream_status_code, e.duration_ms,
       e.api_key_id, e.api_key_name, e.agent_type, SUBSTR(e.last_user_message, 1, 300) AS last_user_message FROM exchanges e ${joinClause} ${where}
       ORDER BY e.created_at DESC, e.id DESC LIMIT ?`
    )
    .all(...args, limit + 1) as Array<Record<string, unknown>>;

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(mapRow);
  const lastItem = items[items.length - 1];
  const nextCursor = hasMore && lastItem ? `${lastItem.createdAt}||${lastItem.id}` : null;

  return { items, nextCursor, total };
};

parentPort!.on("message", ({ id, params }: { id: number; params: QueryParams }) => {
  try {
    const result = runQuery(params);
    parentPort!.postMessage({ id, result });
  } catch (err) {
    parentPort!.postMessage({ id, error: String(err) });
  }
});
