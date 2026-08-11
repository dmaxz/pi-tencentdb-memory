/**
 * tencentdb-memory — pi extension for TencentDB Agent Memory
 *
 * Talks to the MemoryCore Gateway (the `memory-core` service of
 * https://github.com/Tencent/TencentDB-Agent-Memory) over its v3 HTTP API.
 *
 * Features
 *   - 8 memory tools (L0-L3) + 12 knowledge tools (Skills / Wiki / CodeGraph)
 *     the LLM can call:
 *       td_memory_health          → GET  /health
 *       td_memory_search          → POST /v3/atomic/search        (L1 memory recall)
 *       td_memory_add             → POST /v3/conversation/add     (L0 write)
 *       td_memory_query           → POST /v3/conversation/query   (L0 read)
 *       td_memory_core_read       → POST /v3/core/read            (L3 persona)
 *       td_memory_core_write      → POST /v3/core/write
 *       td_memory_scenario_list   → POST /v3/scenario/ls          (L2 scenarios)
 *       td_memory_stats           → counts across L0/L1/L2/L3
 *       td_skill_search / list / create          → POST /v3/skill/*  (gateway :8420)
 *       td_wiki_create / search / page_read / page_write  → POST /v3/wiki/* (knowledge :8424)
 *       td_codegraph_create / sync / search / callers / impact    → /v3/code-graph/*
 *   - A /tdmem command: config (system-wide), config-local (per-project
 *     agent_id/session_id/user_id/capture cadence), status, help.
 *   - Auto-capture: buffers each completed turn and writes it to L0 memory
 *     in batches of N (config key `captureEveryNTurns`, 0 = off).
 *   - Manual sync commands: `/tdmem-sync:chat-memory`, `/tdmem-sync:wiki-knowledge`,
 *     `/tdmem-sync:code-graph` — flush the pending buffer to each target on demand.
 *     Wiki and codegraph are manual-only (no auto-flush every N turns).
 *
 * Configuration (priority: env vars > project config > system-wide config > defaults):
 *   Env vars:  TD_MEMORY_ENDPOINT, TD_MEMORY_API_KEY (or TDAI_GATEWAY_API_KEY),
 *              TD_MEMORY_SERVICE_ID, TD_MEMORY_TEAM_ID, TD_MEMORY_AGENT_ID,
 *              TD_MEMORY_USER_ID, TD_MEMORY_SESSION_ID, TD_MEMORY_CAPTURE_N,
 *              TD_KNOWLEDGE_ENDPOINT (wiki/codegraph service, default :8424/v3)
 *   Project config:  <project>/.pi/tencentdb-memory.json   (written by `/tdmem config-local`)
 *   System-wide:     ~/.pi/tencentdb-memory.json           (written by `/tdmem config`)
 *   Defaults:  endpoint http://127.0.0.1:8420, serviceId/teamId "default",
 *              agentId "pi", userId "local" (matches the standalone gateway)
 *
 * The standalone MemoryCore gateway listens on 127.0.0.1:8420 and needs no
 * API key by default — only a configured LLM for extraction. Everything runs
 * locally, so there are no external API bills.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ──────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────

interface MemoryConfig {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  teamId: string;
  agentId: string;
  userId: string;
  sessionId: string;
  /** Auto-capture cadence: write a batch of turns to L0 every N turns. 0 = off. */
  captureEveryNTurns: number;
  /** Knowledge service base URL (wiki/codegraph; memory-hub :8424). */
  knowledgeEndpoint: string;
  /** Wiki id to archive captured turns to (empty = off). */
  captureWikiId: string;
  /** Page ref prefix for the captured-turns wiki archive page. */
  captureWikiRef: string;
  /** CodeGraph id to re-sync after each capture flush (empty = off). */
  captureCodeGraphId: string;
}

const DEFAULTS: MemoryConfig = {
  endpoint: "http://127.0.0.1:8420",
  apiKey: "",
  serviceId: "default",
  teamId: "default",
  agentId: "pi",
  userId: "local",
  sessionId: "pi-session",
  captureEveryNTurns: 0, // off by default — auto-capture costs LLM extraction tokens
  knowledgeEndpoint: "http://127.0.0.1:8424/v3",
  captureWikiId: "",
  captureWikiRef: "chat-archive",
  captureCodeGraphId: "",
};

function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "tencentdb-memory.json");
}

function homeConfigPath(): string {
  return path.join(os.homedir(), ".pi", "tencentdb-memory.json");
}

/** Read one config file; missing file → {}. Bad JSON/permissions throw loudly. */
function readConfigFile(filePath: string): Partial<MemoryConfig> {
  try {
    return sanitizeConfig(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `tencentdb-memory: cannot read config file ${filePath}: ${err instanceof Error ? err.message : err}`,
      );
    }
    return {};
  }
}

const STRING_KEYS = ["endpoint", "apiKey", "serviceId", "teamId", "agentId", "userId", "sessionId", "knowledgeEndpoint", "captureWikiId", "captureWikiRef", "captureCodeGraphId"] as const;


/** Keep only fields we know about with the right types; drop anything malformed. */
function sanitizeConfig(parsed: unknown): Partial<MemoryConfig> {
  if (typeof parsed !== "object" || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  const out: Partial<MemoryConfig> = {};
  for (const key of STRING_KEYS) {
    const value = record[key];
    if (typeof value === "string") out[key] = value;
  }
  const n = record["captureEveryNTurns"];
  if (typeof n === "number" && Number.isInteger(n) && n >= 0) out.captureEveryNTurns = n;
  else if (typeof n === "string" && /^\d+$/.test(n)) out.captureEveryNTurns = Number(n);

  return out;
}

function loadConfig(cwd: string): MemoryConfig {
  const fromEnv: Partial<MemoryConfig> = {};
  const env = process.env;
  if (env.TD_MEMORY_ENDPOINT) fromEnv.endpoint = env.TD_MEMORY_ENDPOINT;
  if (env.TD_MEMORY_API_KEY) fromEnv.apiKey = env.TD_MEMORY_API_KEY;
  else if (env.TDAI_GATEWAY_API_KEY) fromEnv.apiKey = env.TDAI_GATEWAY_API_KEY;
  if (env.TD_MEMORY_SERVICE_ID) fromEnv.serviceId = env.TD_MEMORY_SERVICE_ID;
  if (env.TD_MEMORY_TEAM_ID) fromEnv.teamId = env.TD_MEMORY_TEAM_ID;
  if (env.TD_MEMORY_AGENT_ID) fromEnv.agentId = env.TD_MEMORY_AGENT_ID;
  if (env.TD_MEMORY_USER_ID) fromEnv.userId = env.TD_MEMORY_USER_ID;
  if (env.TD_MEMORY_SESSION_ID) fromEnv.sessionId = env.TD_MEMORY_SESSION_ID;
  if (env.TD_MEMORY_CAPTURE_N !== undefined && env.TD_MEMORY_CAPTURE_N !== "") {
    const n = Number(env.TD_MEMORY_CAPTURE_N);
    if (Number.isInteger(n) && n >= 0) fromEnv.captureEveryNTurns = n;
  }
  if (env.TD_KNOWLEDGE_ENDPOINT) fromEnv.knowledgeEndpoint = env.TD_KNOWLEDGE_ENDPOINT;
  if (env.TD_MEMORY_CAPTURE_WIKI_ID) fromEnv.captureWikiId = env.TD_MEMORY_CAPTURE_WIKI_ID;
  if (env.TD_MEMORY_CAPTURE_WIKI_REF) fromEnv.captureWikiRef = env.TD_MEMORY_CAPTURE_WIKI_REF;
  if (env.TD_MEMORY_CAPTURE_CODEGRAPH_ID) fromEnv.captureCodeGraphId = env.TD_MEMORY_CAPTURE_CODEGRAPH_ID;


  // Resolution: env vars > project config > system-wide config (home) > defaults.
  const fromHome = readConfigFile(homeConfigPath());
  const fromProject = readConfigFile(projectConfigPath(cwd));

  return { ...DEFAULTS, ...fromHome, ...fromProject, ...fromEnv };
}

/** Persist config to ~/.pi/tencentdb-memory.json. */
function saveConfig(cwd: string, cfg: MemoryConfig): string {
  const candidates = [homeConfigPath(), projectConfigPath(cwd)];
  for (const filePath of candidates) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // 0o600: the file may contain an API key — owner-only on Unix.
      fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      return filePath;
    } catch {
      /* try next location */
    }
  }
  throw new Error("could not write config file");
}

/**
 * Apply project-level overrides to <cwd>/.pi/tencentdb-memory.json.
 * A `null` value removes that key so it falls through to the system-wide
 * setting. The file is deleted if it ends up empty.
 */
function saveProjectConfig(
  cwd: string,
  patch: Partial<{ [K in keyof MemoryConfig]: MemoryConfig[K] | null }>,
): string {
  const filePath = projectConfigPath(cwd);
  const existing = readConfigFile(filePath);
  for (const [key, value] of Object.entries(patch) as Array<[keyof MemoryConfig, MemoryConfig[keyof MemoryConfig] | null]>) {
    if (value === null) delete existing[key];
    else (existing as Record<string, unknown>)[key] = value;
  }
  if (Object.keys(existing).length === 0) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already gone */
    }
    return filePath;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return filePath;
}


// ──────────────────────────────────────────────────────────────────────────
// HTTP client (mirrors the official v3 SDK transport, no SDK dependency)
// ──────────────────────────────────────────────────────────────────────────

interface Envelope<T = unknown> {
  code: number;
  message?: string;
  data?: T | null;
  request_id?: string;
}

interface AbortHandle {
  controller: AbortController;
  cleanup: () => void;
}

/** Wire an outer signal + fixed timeout onto an inner AbortController. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortHandle {
  const controller = new AbortController();
  if (signal?.aborted) {
    controller.abort(); // caller already cancelled — honor it immediately
    return { controller, cleanup: () => {} };
  }
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    controller,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function request<T>(
  cfg: MemoryConfig,
  method: "GET" | "POST",
  apiPath: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const { controller, cleanup } = withTimeout(signal, 15_000);
  try {
    const headers: Record<string, string> = { "x-tdai-service-id": cfg.serviceId };
    if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
    const hasBody = body !== undefined;
    const res = await fetch(`${cfg.endpoint.replace(/\/+$/, "")}${apiPath}`, {
      method,
      headers: hasBody ? { ...headers, "Content-Type": "application/json" } : headers,
      body: hasBody ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new Error(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 200) || "(empty)"}`);
    }
    if (!res.ok || envelope.code !== 0) {
      throw new Error(envelope.message || `HTTP ${res.status} (code ${envelope.code})`);
    }
    return (envelope.data ?? {}) as T;
  } finally {
    cleanup();
  }
}

/** /health is a plain (non-envelope) endpoint. */
async function health(cfg: MemoryConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const { controller, cleanup } = withTimeout(signal, 10_000);
  try {
    const res = await fetch(`${cfg.endpoint.replace(/\/+$/, "")}/health`, {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    cleanup();
  }
}

/** Isolation fields required by the v3 API on every call. */
function isoBody(cfg: MemoryConfig, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { team_id: cfg.teamId, agent_id: cfg.agentId, user_id: cfg.userId, ...extra };
}

/** Shared error text when the gateway is unreachable / unconfigured. */
function friendlyError(cfg: MemoryConfig, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network|abort/i.test(msg)) {
    return `${msg}\n→ Gateway unreachable at ${cfg.endpoint}. Start MemoryCore (see README) or run /tdmem config.`;
  }
  if (/401|403|unauthorized/i.test(msg)) {
    return `${msg}\n→ Check TD_MEMORY_API_KEY / TDAI_GATEWAY_API_KEY and that auth is enabled on the gateway.`;
  }
  return msg;
}

/** Never leak a short API key when masking. */
function maskKey(key: string): string {
  if (!key) return "(none — gateway auth off)";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

// ── Knowledge service (Skills / Wiki / CodeGraph) ────────────────────────

/** POST to the knowledge service (memory-hub :8424). Service-id header only, no Bearer. */
function krequest<T>(
  cfg: MemoryConfig,
  apiPath: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  return request<T>({ ...cfg, endpoint: cfg.knowledgeEndpoint, apiKey: "" }, "POST", apiPath, body, signal);
}

/** Pull a list out of an unknown-shaped response (items/results/hits/pages/callers/...). */
function asList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const k of ["items", "results", "hits", "skills", "pages", "callers", "callees", "impacted_files", "files"]) {
      if (Array.isArray(o[k])) return o[k] as unknown[];
    }
  }
  return [];
}

/** Render an unknown-shaped hit/item defensively. */
function fmtItem(item: unknown): string {
  if (typeof item !== "object" || item === null) return String(item);
  const o = item as Record<string, unknown>;
  const title = (["name", "title", "ref", "path", "symbol", "file", "skill_id", "wiki_id", "code_graph_id"] as const)
    .map((k) => o[k])
    .find((v): v is string => typeof v === "string" && v.length > 0);
  const score = typeof o.score === "number" ? ` [score ${o.score.toFixed(3)}]` : "";
  const body = (["description", "summary", "snippet", "content"] as const)
    .map((k) => o[k])
    .find((v): v is string => typeof v === "string" && v.length > 0);
  const head = title ?? JSON.stringify(o).slice(0, 160);
  return body ? `${head}${score}: ${body}` : `${head}${score}`;
}

/** Render captured turns as a markdown archive page. */
function renderWikiArchive(messages: Array<{ role: string; content: string }>, sessionId: string): string {
  const lines = [`# Chat archive — session ${sessionId}`, ""];
  for (const m of messages) {
    lines.push(`- **${m.role}**: ${m.content.replace(/\n/g, "\n  ")}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Max chars per raw wiki source chunk.
 * The default VPS LLM (deepseek-v4-flash-free) abandons the ingest FILE-block
 * protocol on sources > ~1.5 KB — smaller chunks keep ingests reliable.
 */
const WIKI_CHUNK_MAX = 1400;

/**
 * Split long content into ≤maxChars chunks on paragraph boundaries so ingest
 * stays reliable. Each chunk becomes its own raw file (`<base>.part-N.md`).
 */
function chunkContent(filename: string, content: string, maxChars: number = WIKI_CHUNK_MAX): Array<{ filename: string; content: string }> {
  if (content.length <= maxChars) return [{ filename, content }];
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : ".md";
  const paragraphs = content.split(/\n{2,}/);
  const chunks: Array<{ filename: string; content: string }> = [];
  let buf = "";
  let idx = 1;
  const push = () => {
    if (!buf.trim()) return;
    chunks.push({ filename: `${base}.part-${idx}${ext}`, content: buf.trim() });
    buf = "";
    idx += 1;
  };
  for (const p of paragraphs) {
    if ((buf + "\n\n" + p).length > maxChars) push();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  push();
  return chunks;
}

/**
 * Archive a batch of turns to the wiki (raw source, auto-chunked, then ingest).
 * Throws on failure so callers can restore the buffer / report errors. The
 * initial read is best-effort (a missing file is a normal first write of the
 * day); genuine errors surface at the write/ingest step.
 */
async function flushWikiArchive(
  cfg: MemoryConfig,
  batch: Array<{ role: string; content: string }>,
): Promise<void> {
  if (!cfg.captureWikiId) return;
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${cfg.captureWikiRef || "chat-archive"}-${date}.md`;
  let content = renderWikiArchive(batch, cfg.sessionId);
  try {
    const existing = await krequest<unknown>(cfg, "/wiki/raw/read", { wiki_id: cfg.captureWikiId, filenames: [filename] }, undefined);
    const prior = asList(existing)[0] as Record<string, unknown> | undefined;
    if (prior && typeof prior.content === "string" && prior.content) {
      content = `${prior.content}\n${content}`;
    }
  } catch {
    /* first write of the day */
  }
  const files = chunkContent(filename, content, WIKI_CHUNK_MAX);
  await krequest(cfg, "/wiki/raw/write", {
    team_id: cfg.teamId,
    wiki_id: cfg.captureWikiId,
    files,
  }, undefined);
  await krequest(cfg, "/wiki/ingest", { wiki_id: cfg.captureWikiId }, undefined);
}

/** Re-sync the codegraph index. Never throws. */
async function flushCodeGraphSync(cfg: MemoryConfig): Promise<void> {
  if (!cfg.captureCodeGraphId) return;
  try {
    await krequest(cfg, "/code-graph/sync", { code_graph_id: cfg.captureCodeGraphId }, undefined);
  } catch {
    /* best-effort */
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Shared result rendering
// ──────────────────────────────────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

interface AtomicHit {
  id: string;
  type: string;
  content: string;
  background?: string;
  score?: number;
  created_at?: string;
  updated_at?: string;
}

interface MessageItem {
  id?: string;
  role: string;
  content: string;
  timestamp?: string;
  score?: number;
}

function renderAtomicHits(items: AtomicHit[]): string {
  if (!items.length) return "No matching memories found.";
  return items
    .map((h, i) => {
      const score = typeof h.score === "number" ? ` [score ${h.score.toFixed(3)}]` : "";
      const bg = h.background ? `\n  background: ${h.background}` : "";
      return `${i + 1}. [${h.type}]${score} (${h.id})\n   ${h.content}${bg}`;
    })
    .join("\n\n");
}

function renderMessages(msgs: MessageItem[]): string {
  if (!msgs.length) return "No messages found.";
  return msgs
    .map((m, i) => {
      const score = typeof m.score === "number" ? ` [score ${m.score.toFixed(3)}]` : "";
      return `${i + 1}. ${m.role}${score}: ${m.content}`;
    })
    .join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────────

export default function tencentdbMemoryExtension(pi: ExtensionAPI) {
  // ── Custom tools ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "td_memory_health",
    label: "TD Memory: health",
    description:
      "Check whether the TencentDB Agent Memory gateway (MemoryCore) is reachable and healthy.",
    promptSnippet: "td_memory_health — check TencentDB Agent Memory gateway status",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const h = await health(cfg, signal);
        const services = (h.services ?? h) as Record<string, unknown>;
        const lines = Object.entries(services).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`);
        return textResult(`MemoryCore gateway OK at ${cfg.endpoint}\n${lines.join("\n")}`);
      } catch (err) {
        return textResult(`MemoryCore gateway NOT healthy at ${cfg.endpoint}\n${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_memory_search",
    label: "TD Memory: search",
    description:
      "Search the agent's L1 atomic memory (facts, decisions, preferences distilled from past conversations) " +
      "by keyword or semantic query. Use this to recall what this project/agent already knows before asking the user again.",
    promptSnippet: "td_memory_search — recall previously learned facts/decisions/preferences from the agent memory store",
    promptGuidelines: [
      "Before re-asking the user something they may have told you before, try td_memory_search first.",
      "When the user states a durable fact, preference, or decision, persist it with td_memory_add.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Keyword or semantic query, e.g. 'database credentials policy'" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
      type: Type.Optional(Type.String({ description: "Optional L1 memory type filter (e.g. fact, preference, decision)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await request<{ items: AtomicHit[] }>(
          cfg, "POST", "/v3/atomic/search",
          isoBody(cfg, {
            session_id: cfg.sessionId || undefined,
            query: params.query,
            limit: params.limit ?? 10,
            type: params.type || undefined,
          }),
          signal,
        );
        return textResult(renderAtomicHits(data.items ?? []));
      } catch (err) {
        return textResult(`td_memory_search failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_memory_add",
    label: "TD Memory: remember",
    description:
      "Write a message to the agent's L0 conversation memory (session-scoped). " +
      "Use it to record durable facts, preferences, decisions, or conversation turns so future sessions can recall them.",
    promptSnippet: "td_memory_add — save a fact/preference/decision to the agent memory store",
    parameters: Type.Object({
      content: Type.String({ description: "The fact, preference, decision, or message to remember" }),
      role: Type.Optional(Type.Union([
        Type.Literal("user"),
        Type.Literal("assistant"),
        Type.Literal("system"),
      ], { description: "Role of the message (default user)" })),
      session_id: Type.Optional(Type.String({ description: "Session id (defaults to configured session)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      const sessionId = params.session_id ?? cfg.sessionId;
      if (!sessionId) {
        return textResult("td_memory_add requires a session_id — set one via /tdmem config or pass session_id.");
      }
      try {
        const data = await request<{ accepted_ids: string[]; total_count: number }>(
          cfg, "POST", "/v3/conversation/add",
          isoBody(cfg, {
            session_id: sessionId,
            messages: [{ role: params.role ?? "user", content: params.content }],
          }),
          signal,
        );
        return textResult(
          `Saved message to memory (session ${sessionId}). accepted_ids: ${data.accepted_ids?.join(", ") || "—"}, total messages: ${data.total_count ?? "?"}`,
        );
      } catch (err) {
        return textResult(`td_memory_add failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_memory_query",
    label: "TD Memory: history",
    description:
      "Query the agent's L0 conversation history for a session (most recent messages). " +
      "Useful to see what was previously said in this session's memory.",
    promptSnippet: "td_memory_query — read recent conversation history from the agent memory store",
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ description: "Session id (defaults to configured session)" })),
      limit: Type.Optional(Type.Number({ description: "Max messages (default 20)" })),
      offset: Type.Optional(Type.Number({ description: "Pagination offset (default 0)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await request<{ messages: MessageItem[]; total: number }>(
          cfg, "POST", "/v3/conversation/query",
          isoBody(cfg, {
            session_id: params.session_id ?? (cfg.sessionId || undefined),
            limit: params.limit ?? 20,
            offset: params.offset ?? 0,
          }),
          signal,
        );
        return textResult(
          `Conversation history (${data.total ?? "?"} total, showing ${data.messages?.length ?? 0}):\n` +
          renderMessages(data.messages ?? []),
        );
      } catch (err) {
        return textResult(`td_memory_query failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_memory_core_read",
    label: "TD Memory: persona",
    description:
      "Read the agent's L3 core memory (the distilled persona/profile of the user, generated from accumulated conversations).",
    promptSnippet: "td_memory_core_read — read the distilled user persona/profile",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await request<{ content: string | null; created_at?: string | null; updated_at?: string | null }>(
          cfg, "POST", "/v3/core/read", isoBody(cfg), signal,
        );
        if (!data.content) return textResult("No L3 core memory has been generated yet.");
        return textResult(`L3 core memory (updated ${data.updated_at ?? "?"}):\n${data.content}`);
      } catch (err) {
        return textResult(`td_memory_core_read failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_memory_core_write",
    label: "TD Memory: set persona",
    description:
      "Overwrite the agent's L3 core memory (persona/profile) with the given content. " +
      "Use to seed or correct the distilled profile of the user.",
    promptSnippet: "td_memory_core_write — overwrite the distilled user persona/profile",
    parameters: Type.Object({
      content: Type.String({ description: "New core memory content (markdown/text profile)" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await request<{ updated_at?: string }>(
          cfg, "POST", "/v3/core/write", isoBody(cfg, { content: params.content }), signal,
        );
        return textResult(`L3 core memory written (updated ${data.updated_at ?? "?"}).`);
      } catch (err) {
        return textResult(`td_memory_core_write failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_memory_scenario_list",
    label: "TD Memory: scenarios",
    description:
      "List the agent's L2 scenario memory files (persistent notes organized by scenario/context path).",
    promptSnippet: "td_memory_scenario_list — list scenario memory files",
    parameters: Type.Object({
      path_prefix: Type.Optional(Type.String({ description: "Optional path prefix filter, e.g. 'projects/'" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await request<{ items?: Array<{ path: string; summary?: string; updated_at?: string }> }>(
          cfg, "POST", "/v3/scenario/ls",
          isoBody(cfg, { path_prefix: params.path_prefix || undefined }),
          signal,
        );
        const items = data.items ?? [];
        if (!items.length) return textResult("No scenario memory files found.");
        return textResult(
          "Scenario memory files:\n" +
          items.map((s) => `  ${s.path}${s.summary ? ` — ${s.summary}` : ""}${s.updated_at ? ` (updated ${s.updated_at})` : ""}`).join("\n"),
        );
      } catch (err) {
        return textResult(`td_memory_scenario_list failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_memory_stats",
    label: "TD Memory: stats",
    description:
      "Show item counts for the agent's L0 conversations, L1 atomic memories, L2 scenarios, and L3 core memory.",
    promptSnippet: "td_memory_stats — show memory store item counts",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const settled = await Promise.allSettled([
          request<{ total: number }>(cfg, "POST", "/v3/conversation/count", isoBody(cfg), signal),
          request<{ total: number }>(cfg, "POST", "/v3/atomic/count", isoBody(cfg), signal),
          request<{ total: number }>(cfg, "POST", "/v3/scenario/count", isoBody(cfg), signal),
          request<{ total: number }>(cfg, "POST", "/v3/core/count", isoBody(cfg), signal),
        ]);
        const fmt = (r: PromiseSettledResult<{ total: number }>): string =>
          r.status === "fulfilled" ? String(r.value.total ?? 0) : `error (${r.reason instanceof Error ? r.reason.message : r.reason})`;
        const [conv, atomic, scenario, core] = settled;
        const anyFailed = settled.some((r) => r.status === "rejected");
        return textResult(
          `Memory store (team=${cfg.teamId}, agent=${cfg.agentId}, user=${cfg.userId}):\n` +
          `  L0 conversations: ${fmt(conv)}\n` +
          `  L1 atomic memories: ${fmt(atomic)}\n` +
          `  L2 scenario files: ${fmt(scenario)}\n` +
          `  L3 core memory: ${fmt(core)}` +
          (anyFailed ? "\n(partial — some count endpoints failed)" : ""),
        );
      } catch (err) {
        return textResult(`td_memory_stats failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  // ── Knowledge tools: Skills (gateway :8420) ───────────────────────────

  pi.registerTool({
    name: "td_skill_search",
    label: "TD Skills: search",
    description:
      "Search the team's Skill library (reusable procedures/checklists distilled from past work) by keyword. " +
      "Use when a task matches something you or the team have done before.",
    promptSnippet: "td_skill_search — find a reusable skill/procedure in the team skill library",
    parameters: Type.Object({
      query: Type.String({ description: "Search query, e.g. 'release checklist'" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await request<unknown>(cfg, "POST", "/v3/skill/search", isoBody(cfg, {
          query: params.query,
          limit: params.limit ?? 10,
        }), signal);
        const items = asList(data);
        if (!items.length) return textResult("No skills found.");
        return textResult("Skills:\n" + items.map((s, i) => `${i + 1}. ${fmtItem(s)}`).join("\n"));
      } catch (err) {
        return textResult(`td_skill_search failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_skill_list",
    label: "TD Skills: list",
    description: "List all skills in the team's Skill library.",
    promptSnippet: "td_skill_list — list available skills",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await request<unknown>(cfg, "POST", "/v3/skill/list", isoBody(cfg), signal);
        const items = asList(data);
        if (!items.length) return textResult("No skills yet.");
        return textResult("Skills:\n" + items.map((s, i) => `${i + 1}. ${fmtItem(s)}`).join("\n"));
      } catch (err) {
        return textResult(`td_skill_list failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_skill_create",
    label: "TD Skills: create",
    description:
      "Create a new skill in the team Skill library (name + description + the skill's content/prompt body). " +
      "Use after completing a reusable procedure so the team can reuse it later.",
    promptSnippet: "td_skill_create — save a reusable procedure as a skill",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name, e.g. 'deploy-checklist'" }),
      description: Type.Optional(Type.String({ description: "Short description of when to use it" })),
      content: Type.Optional(Type.String({ description: "The skill body: steps/prompt/instructions" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await request<{ skill_id?: string }>(cfg, "POST", "/v3/skill/create", isoBody(cfg, {
          name: params.name,
          description: params.description || undefined,
          content: params.content || undefined,
        }), signal);
        return textResult(`Skill created: ${data.skill_id ?? JSON.stringify(data)}`);
      } catch (err) {
        return textResult(`td_skill_create failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  // ── Knowledge tools: Wiki (knowledge service :8424) ────────────────────

  pi.registerTool({
    name: "td_wiki_create",
    label: "TD Wiki: create",
    description: "Create a new wiki knowledge base (metadata + directory shell). Returns the wiki_id used by the other wiki tools.",
    promptSnippet: "td_wiki_create — create a wiki knowledge base",
    parameters: Type.Object({
      name: Type.String({ description: "Wiki name, e.g. 'product-docs'" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await krequest<{ wiki_id?: string }>(cfg, "/wiki/create", { team_id: cfg.teamId, name: params.name }, signal);
        return textResult(`Wiki created: ${data.wiki_id ?? JSON.stringify(data)}`);
      } catch (err) {
        return textResult(`td_wiki_create failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_wiki_search",
    label: "TD Wiki: search",
    description: "Search a wiki knowledge base for pages matching a query.",
    promptSnippet: "td_wiki_search — search wiki pages",
    parameters: Type.Object({
      wiki_id: Type.String({ description: "Wiki id (see td_wiki_create / panel)" }),
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await krequest<unknown>(cfg, "/wiki/search", { wiki_id: params.wiki_id, query: params.query, limit: params.limit ?? 20 }, signal);
        const items = asList(data);
        if (!items.length) return textResult("No wiki pages found.");
        return textResult("Wiki hits:\n" + items.map((h, i) => `${i + 1}. ${fmtItem(h)}`).join("\n"));
      } catch (err) {
        return textResult(`td_wiki_search failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_wiki_page_read",
    label: "TD Wiki: read page",
    description: "Read one or more wiki pages by their refs (paths).",
    promptSnippet: "td_wiki_page_read — read wiki page content",
    parameters: Type.Object({
      wiki_id: Type.String({ description: "Wiki id" }),
      refs: Type.Array(Type.String({ description: "Page ref/path, e.g. 'getting-started'" }), { description: "Page refs to read (max 20)" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await krequest<unknown>(cfg, "/wiki/page/read", { wiki_id: params.wiki_id, refs: params.refs }, signal);
        const pages = asList(data);
        if (!pages.length) return textResult(`No page content returned for ${params.refs.join(", ")}.`);
        return textResult("Wiki pages:\n" + pages.map((p, i) => `${i + 1}. ${fmtItem(p)}`).join("\n\n"));
      } catch (err) {
        return textResult(`td_wiki_page_read failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_wiki_page_write",
    label: "TD Wiki: write page",
    description:
      "Write/update wiki pages (ref + markdown content). Use to persist project knowledge " +
      "(architecture notes, runbooks, API docs) into the team wiki.",
    promptSnippet: "td_wiki_page_write — save knowledge to the wiki",
    parameters: Type.Object({
      wiki_id: Type.String({ description: "Wiki id" }),
      pages: Type.Array(Type.Object({
        ref: Type.String({ description: "Page ref/path, e.g. 'auth/overview'" }),
        content: Type.String({ description: "Markdown content" }),
      }), { description: "Pages to write" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await krequest<unknown>(cfg, "/wiki/page/write", {
          team_id: cfg.teamId,
          wiki_id: params.wiki_id,
          pages: params.pages,
        }, signal);
        return textResult(`Wiki pages written: ${JSON.stringify(data)}`);
      } catch (err) {
        return textResult(`td_wiki_page_write failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_wiki_ingest",
    label: "TD Wiki: ingest",
    description:
      "Trigger ingest for a wiki so its pages become indexed/queryable (draft → ready). " +
      "Newly created wikis start in draft until ingested; the capture ride-along ingests " +
      "automatically, but use this for wikis created manually or to re-ingest after edits.",
    promptSnippet: "td_wiki_ingest — make a wiki queryable (draft → ready)",
    parameters: Type.Object({
      wiki_id: Type.String({ description: "Wiki id to ingest" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await krequest<unknown>(cfg, "/wiki/ingest", { wiki_id: params.wiki_id }, signal);
        return textResult(`Wiki ingest triggered: ${JSON.stringify(data)} — status moves to ready shortly.`);
      } catch (err) {
        return textResult(`td_wiki_ingest failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_wiki_ingest_source",
    label: "TD Wiki: ingest source",
    description:
      "Upload a raw source file to a wiki and trigger ingest so it becomes queryable in the hub. " +
      "Content larger than ~1.4 KB is automatically split into multiple source chunks — the " +
      "default VPS model (deepseek-v4-flash-free) abandons the FILE-block protocol on large " +
      "sources, which makes ingest fail. Chunking keeps ingests reliable.",
    promptSnippet: "td_wiki_ingest_source — upload + ingest wiki source (auto-chunked)",
    parameters: Type.Object({
      wiki_id: Type.String({ description: "Wiki id" }),
      filename: Type.String({ description: "Source filename, e.g. 'module-overview.md'" }),
      content: Type.String({ description: "Markdown source content" }),
      max_chunk_chars: Type.Optional(Type.Number({ description: "Max chars per chunk (default 1400)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const chunks = chunkContent(params.filename, params.content, params.max_chunk_chars ?? WIKI_CHUNK_MAX);
        const data = await krequest<unknown>(cfg, "/wiki/raw/write", {
          team_id: cfg.teamId,
          wiki_id: params.wiki_id,
          files: chunks,
        }, signal);
        await krequest<unknown>(cfg, "/wiki/ingest", { wiki_id: params.wiki_id }, signal);
        const split = chunks.length > 1 ? ` (split into ${chunks.length} chunks)` : "";
        return textResult(`Source uploaded${split} + ingest triggered: ${JSON.stringify(data)}`);
      } catch (err) {
        return textResult(`td_wiki_ingest_source failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  // ── Knowledge tools: CodeGraph (knowledge service :8424) ───────────────

  pi.registerTool({
    name: "td_codegraph_create",
    label: "TD CodeGraph: index repo",
    description: "Register a git repository for code indexing. Returns the code_graph_id needed by the other codegraph tools.",
    promptSnippet: "td_codegraph_create — register a repo for code indexing",
    parameters: Type.Object({
      repo_url: Type.String({ description: "Git repo URL, e.g. https://github.com/org/repo.git" }),
      branch: Type.Optional(Type.String({ description: "Branch (default main)" })),
      repo_name: Type.Optional(Type.String({ description: "Optional display name" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await krequest<{ code_graph_id?: string }>(cfg, "/code-graph/create", {
          team_id: cfg.teamId,
          repo_url: params.repo_url,
          branch: params.branch || undefined,
          repo_name: params.repo_name || undefined,
        }, signal);
        return textResult(`CodeGraph created: ${data.code_graph_id ?? JSON.stringify(data)}`);
      } catch (err) {
        return textResult(`td_codegraph_create failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_codegraph_sync",
    label: "TD CodeGraph: sync",
    description: "Trigger (re)indexing of a registered repository. Returns sync status; indexing can take minutes for large repos.",
    promptSnippet: "td_codegraph_sync — (re)index a registered repo",
    parameters: Type.Object({
      code_graph_id: Type.String({ description: "CodeGraph id (see td_codegraph_create)" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await krequest<unknown>(cfg, "/code-graph/sync", { code_graph_id: params.code_graph_id }, signal);
        return textResult(`CodeGraph sync: ${JSON.stringify(data)}`);
      } catch (err) {
        return textResult(`td_codegraph_sync failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_codegraph_search",
    label: "TD CodeGraph: search",
    description: "Search an indexed codebase for symbols or files.",
    promptSnippet: "td_codegraph_search — find symbols/files in an indexed repo",
    parameters: Type.Object({
      code_graph_id: Type.String({ description: "CodeGraph id" }),
      query: Type.String({ description: "Search query, e.g. 'UserService'" }),
      kind: Type.Optional(Type.Union([Type.Literal("symbol"), Type.Literal("file"), Type.Literal("any")], { description: "Kind filter (default any)" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await krequest<unknown>(cfg, "/code-graph/search", {
          code_graph_id: params.code_graph_id,
          query: params.query,
          kind: params.kind || undefined,
          limit: params.limit ?? 10,
        }, signal);
        const items = asList(data);
        if (!items.length) return textResult("No code matches.");
        return textResult("Code matches:\n" + items.map((h, i) => `${i + 1}. ${fmtItem(h)}`).join("\n"));
      } catch (err) {
        return textResult(`td_codegraph_search failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_codegraph_callers",
    label: "TD CodeGraph: callers",
    description: "Find who calls a symbol in the indexed codebase (blast-radius read for refactors).",
    promptSnippet: "td_codegraph_callers — who calls this symbol",
    parameters: Type.Object({
      code_graph_id: Type.String({ description: "CodeGraph id" }),
      symbol: Type.String({ description: "Symbol name, e.g. 'getUserById'" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await krequest<unknown>(cfg, "/code-graph/callers", {
          code_graph_id: params.code_graph_id,
          symbol: params.symbol,
          limit: params.limit ?? 20,
        }, signal);
        const items = asList(data);
        if (!items.length) return textResult(`No callers found for ${params.symbol}.`);
        return textResult(`Callers of ${params.symbol}:\n` + items.map((h, i) => `${i + 1}. ${fmtItem(h)}`).join("\n"));
      } catch (err) {
        return textResult(`td_codegraph_callers failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  pi.registerTool({
    name: "td_codegraph_impact",
    label: "TD CodeGraph: impact",
    description: "Estimate the impact of changing a symbol (affected callers up to a depth).",
    promptSnippet: "td_codegraph_impact — what breaks if I change this symbol",
    parameters: Type.Object({
      code_graph_id: Type.String({ description: "CodeGraph id" }),
      symbol: Type.String({ description: "Symbol name" }),
      depth: Type.Optional(Type.Number({ description: "Impact depth (default 2, max 10)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      try {
        const data = await krequest<unknown>(cfg, "/code-graph/impact", {
          code_graph_id: params.code_graph_id,
          symbol: params.symbol,
          depth: params.depth ?? 2,
        }, signal);
        const items = asList(data);
        if (!items.length) return textResult(`No impact data for ${params.symbol}.`);
        return textResult(`Impact of ${params.symbol}:\n` + items.map((h, i) => `${i + 1}. ${fmtItem(h)}`).join("\n"));
      } catch (err) {
        return textResult(`td_codegraph_impact failed: ${friendlyError(cfg, err)}`);
      }
    },
  });

  // ── Auto-capture (optional) ──────────────────────────────────────────
  // When captureEveryNTurns > 0, each completed turn is buffered and written
  // to L0 memory in batches of N (0 = off). Uses the same layered config as
  // the tools, so per-project agent/session/capture settings apply.
  //
  // Each turn is queued into TWO independent buffers: the chat buffer is
  // drained by auto-capture and /tdmem-sync:chat-memory; the wiki buffer is
  // drained only by /tdmem-sync:wiki-knowledge (manual). Splitting them keeps
  // auto-capture from stealing turns that were meant for the wiki archive.

  let lastUserInput = "";
  let turnsSinceFlush = 0;
  const pendingChatMessages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
  const pendingWikiMessages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];

  /** pi's message content is a string or an array of content blocks. */
  function extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((b): b is { type: string; text: unknown } => typeof b === "object" && b !== null)
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");
    }
    return "";
  }

  /** Max characters per message content for /v3/conversation/add. */
  const MAX_MSG_LEN = 8192;

  /**
   * Split a long message into chunks under MAX_MSG_LEN, breaking at paragraph
   * boundaries (\n\n) to preserve structure and meaning.
   */
  function chunkMessage(text: string): string[] {
    if (text.length <= MAX_MSG_LEN) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > MAX_MSG_LEN) {
      // Find the last paragraph break within the limit
      let split = remaining.lastIndexOf("\n\n", MAX_MSG_LEN);
      if (split <= 0) {
        // No paragraph break — try line break
        split = remaining.lastIndexOf("\n", MAX_MSG_LEN);
        if (split <= 0) {
          // No line break — hard cut at limit
          split = MAX_MSG_LEN;
        }
      }
      chunks.push(remaining.slice(0, split));
      remaining = remaining.slice(split).replace(/^\n+/, "");
    }
    if (remaining.trim()) chunks.push(remaining);
    return chunks;
  }

  /** Get all user + assistant messages from the current pi session context. */
  function getSessionMessages(ctx: ExtensionContext): Array<{ role: "user" | "assistant"; content: string }> {
    const entries = ctx.sessionManager.getEntries();
    const leafId = ctx.sessionManager.getLeafId();
    const sessionCtx = buildSessionContext(entries, leafId);
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const m of sessionCtx.messages) {
      const role = (m as { role?: string }).role;
      if (role === "user" || role === "assistant") {
        const text = extractText((m as { content?: unknown }).content);
        if (text.trim()) {
          const chunks = chunkMessage(text);
          for (const chunk of chunks) {
            messages.push({ role, content: chunk } as { role: "user" | "assistant"; content: string });
          }
        }
      }
    }
    return messages;
  }

  /** Write the buffered turns to L0 chat memory; keep on failure for the next retry. */
  async function flushCapturedMessages(ctx: ExtensionContext): Promise<void> {
    if (pendingChatMessages.length === 0) return;
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.sessionId) return;
    const batch = pendingChatMessages.splice(0);
    try {
      await request(cfg, "POST", "/v3/conversation/add", isoBody(cfg, {
        session_id: cfg.sessionId,
        messages: batch,
      }), ctx.signal);
    } catch {
      pendingChatMessages.unshift(...batch);
    }
  }

  pi.on("input", (event) => {
    lastUserInput = event.text;
  });

  pi.on("turn_end", async (event, ctx) => {
    try {
      const n = loadConfig(ctx.cwd).captureEveryNTurns;
      const assistant = extractText((event.message as unknown as { content?: unknown }).content);
      if (lastUserInput.trim()) {
        const userMsg = { role: "user" as const, content: lastUserInput.trim() };
        pendingChatMessages.push(userMsg);
        pendingWikiMessages.push(userMsg);
      }
      lastUserInput = "";
      if (assistant.trim()) {
        const assistantMsg = { role: "assistant" as const, content: assistant };
        pendingChatMessages.push(assistantMsg);
        pendingWikiMessages.push(assistantMsg);
      }
      // Auto-flush to L0 only when N > 0; manual /tdmem-sync:* commands use the buffer regardless.
      if (n > 0) {
        turnsSinceFlush += 1;
        if (turnsSinceFlush >= n) {
          turnsSinceFlush = 0;
          await flushCapturedMessages(ctx);
        }
      }
    } catch {
      /* capture must never break a turn */
    }
  });

  /** Drain the wiki buffer to the wiki archive on shutdown (best-effort, logged). */
  async function flushPendingWikiArchive(ctx: ExtensionContext): Promise<void> {
    if (pendingWikiMessages.length === 0) return;
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.captureWikiId) return;
    const batch = pendingWikiMessages.splice(0);
    await flushWikiArchive(cfg, batch);
  }

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await flushCapturedMessages(ctx); // flush any leftover partial chat batch
    } catch (err) {
      console.error(`[tdmem] chat-memory shutdown flush failed: ${err instanceof Error ? err.message : err}`);
    }
    try {
      await flushPendingWikiArchive(ctx); // flush leftover wiki turns too
    } catch (err) {
      console.error(`[tdmem] wiki shutdown flush failed: ${err instanceof Error ? err.message : err}`);
    }
  });

  // ── /tdmem-sync:* manual sync commands ─────────────────────────────────

  pi.registerCommand("tdmem-sync:chat-memory", {
    description: "Flush pending turns to chat memory (L0). Use 'all' to sync the entire session.",
    getArgumentCompletions: (prefix) => {
      return ["all"].filter((s) => s.startsWith(prefix.toLowerCase())).map((s) => ({ value: s, label: s }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (args.trim().toLowerCase() === "all") {
        const messages = getSessionMessages(ctx);
        if (messages.length === 0) {
          ctx.ui.notify("No session messages to sync.", "info");
          return;
        }
        pendingChatMessages.splice(0);
        turnsSinceFlush = 0;
        const cfg = loadConfig(ctx.cwd);
        if (!cfg.sessionId) {
          ctx.ui.notify("No sessionId configured.", "error");
          return;
        }
        await request(cfg, "POST", "/v3/conversation/add", isoBody(cfg, {
          session_id: cfg.sessionId,
          messages,
        }), ctx.signal);
        ctx.ui.notify(`Synced ${messages.length} message(s) from session to chat memory.`, "info");
        return;
      }
      const count = pendingChatMessages.length;
      if (count === 0) {
        ctx.ui.notify("No pending turns to sync.", "info");
        return;
      }
      await flushCapturedMessages(ctx);
      ctx.ui.notify(`Synced ${count} turn(s) to chat memory.`, "info");
    },
  });

  pi.registerCommand("tdmem-sync:wiki-knowledge", {
    description: "Archive pending turns to wiki knowledge base. Use 'all' to archive the entire session.",
    getArgumentCompletions: (prefix) => {
      return ["all"].filter((s) => s.startsWith(prefix.toLowerCase())).map((s) => ({ value: s, label: s }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cfg = loadConfig(ctx.cwd);
      if (!cfg.captureWikiId) {
        ctx.ui.notify("No wiki ID configured. Set captureWikiId via /tdmem config or /tdmem config-local.", "error");
        return;
      }
      if (args.trim().toLowerCase() === "all") {
        const messages = getSessionMessages(ctx);
        if (messages.length === 0) {
          ctx.ui.notify("No session messages to archive.", "info");
          return;
        }
        pendingWikiMessages.splice(0);
        try {
          await flushWikiArchive(cfg, messages);
          ctx.ui.notify(`Archived ${messages.length} message(s) to wiki (${cfg.captureWikiId}).`, "info");
        } catch (err) {
          ctx.ui.notify(`Wiki archive failed: ${err instanceof Error ? err.message : err}`, "error");
        }
        return;
      }
      const count = pendingWikiMessages.length;
      if (count === 0) {
        ctx.ui.notify("No pending turns to sync.", "info");
        return;
      }
      const batch = pendingWikiMessages.splice(0);
      try {
        await flushWikiArchive(cfg, batch);
        ctx.ui.notify(`Archived ${count} turn(s) to wiki (${cfg.captureWikiId}).`, "info");
      } catch (err) {
        pendingWikiMessages.unshift(...batch);
        ctx.ui.notify(
          `Wiki sync failed — turns restored to buffer. ${err instanceof Error ? err.message : err}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("tdmem-sync:code-graph", {
    description: "Re-sync codegraph index",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const cfg = loadConfig(ctx.cwd);
      if (!cfg.captureCodeGraphId) {
        ctx.ui.notify("No codegraph ID configured. Set captureCodeGraphId via /tdmem config or /tdmem config-local.", "error");
        return;
      }
      try {
        await flushCodeGraphSync(cfg);
        ctx.ui.notify(`Codegraph re-synced (${cfg.captureCodeGraphId}).`, "info");
      } catch (err) {
        ctx.ui.notify(`Codegraph sync failed: ${err instanceof Error ? err.message : err}`, "error");
      }
    },
  });

  // ── /tdmem command ────────────────────────────────────────────────────

  const HELP = `TencentDB Agent Memory (pi extension)

Usage:
  /tdmem config          System-wide setup (endpoint, API key, isolation ids,
                         auto-capture cadence, knowledge URL)
  /tdmem config-local    Per-project agent_id / session_id / user_id /
                         capture cadence + wiki/codegraph targets
                         (Enter on a prompt = use the system-wide setting)
  /tdmem-sync:chat-memory [all]  Flush pending turns to L0
                           (all = sync the entire session)
  /tdmem-sync:wiki-knowledge [all]  Archive pending turns to wiki
                           (all = archive the entire session)
  /tdmem-sync:code-graph     Re-sync codegraph index
  /tdmem status          Show resolved config and run a connectivity check
  /tdmem help            Show this help

Auto-capture (chat memory only): set "Auto-capture every N turns" in
/tdmem config (0 = off). Each completed turn is buffered; when N > 0 the
buffer is flushed to L0 every N turns and on session shutdown.
Wiki and codegraph are manual-only — use /tdmem-sync:wiki-knowledge and
/tdmem-sync:code-graph when you want to archive turns or re-index code.
Set captureWikiId / captureCodeGraphId via /tdmem config or
/tdmem config-local to tell the sync commands where to write.

Tools registered: td_memory_health, td_memory_search, td_memory_add,
td_memory_query, td_memory_core_read, td_memory_core_write,
td_memory_scenario_list, td_memory_stats,
td_skill_search, td_skill_list, td_skill_create,
td_wiki_create, td_wiki_search, td_wiki_page_read, td_wiki_page_write,
td_wiki_ingest, td_wiki_ingest_source,
td_codegraph_create, td_codegraph_sync, td_codegraph_search,
td_codegraph_callers, td_codegraph_impact

Config priority: env vars (TD_MEMORY_*) > <project>/.pi/tencentdb-memory.json
                 > ~/.pi/tencentdb-memory.json > defaults
Default endpoint: http://127.0.0.1:8420 (local MemoryCore gateway — no external API bills)`;

  pi.registerCommand("tdmem", {
    description: "TencentDB Agent Memory: configure connection and check status",
    getArgumentCompletions: (prefix) => {
      const subs = ["config", "config-local", "status", "help"];
      return subs.filter((s) => s.startsWith(prefix.toLowerCase())).map((s) => ({ value: s, label: s }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = args.trim().toLowerCase() || "help";
      const cfg = loadConfig(ctx.cwd);

      if (sub === "config") {
        if (!ctx.hasUI) {
          ctx.ui.notify("Interactive config requires TUI mode. Set TD_MEMORY_* env vars instead.", "error");
          return;
        }
        // ctx.ui.input returns string | undefined — empty input keeps the current value.
        const keep = async (title: string, current: string): Promise<string> => {
          const entered = await ctx.ui.input(title, `${current} (press Enter to keep)`);
          return entered?.trim() || current;
        };
        const endpoint = await keep("MemoryCore gateway URL", cfg.endpoint);
        const apiKeyRaw = (await ctx.ui.input("API key (Enter = keep, type 'clear' to remove)")) ?? "";
        const apiKey = apiKeyRaw.trim() === "clear" ? "" : apiKeyRaw.trim() || cfg.apiKey;
        const serviceId = await keep("x-tdai-service-id (memory instance id)", cfg.serviceId);
        const teamId = await keep("team_id", cfg.teamId);
        const agentId = await keep("agent_id", cfg.agentId);
        const userId = await keep("user_id", cfg.userId);
        const sessionId = await keep("session_id (used by writes)", cfg.sessionId);
        const captureRaw = (await ctx.ui.input("Auto-capture every N turns (0 = off)", String(cfg.captureEveryNTurns))) ?? "";
        const captureEveryNTurns = /^\d+$/.test(captureRaw.trim()) ? Number(captureRaw.trim()) : cfg.captureEveryNTurns;
        const captureWikiId = await keep("Wiki id to archive captured turns (empty = off)", cfg.captureWikiId);
        const captureWikiRef = await keep("Wiki page ref prefix for archive", cfg.captureWikiRef);
        const captureCodeGraphId = await keep("CodeGraph id to re-sync after capture (empty = off)", cfg.captureCodeGraphId);
        const knowledgeEndpoint = await keep("Knowledge base URL (wiki/codegraph, :8424/v3)", cfg.knowledgeEndpoint);

        const next: MemoryConfig = {
          endpoint,
          apiKey,
          serviceId,
          teamId,
          agentId,
          userId,
          sessionId,
          captureEveryNTurns,
          captureWikiId,
          captureWikiRef,
          captureCodeGraphId,
          knowledgeEndpoint,
        };
        try {
          const filePath = saveConfig(ctx.cwd, next);
          ctx.ui.notify(`Config saved to ${filePath}`, "info");
          ctx.ui.notify("Run /tdmem status to verify the connection.", "info");
        } catch (err) {
          ctx.ui.notify(`Could not save config: ${err instanceof Error ? err.message : err}`, "error");
        }
        return;
      }

      if (sub === "config-local" || sub === "config-project") {
        if (!ctx.hasUI) {
          ctx.ui.notify("Interactive local config requires TUI mode. Set TD_MEMORY_* env vars instead.", "error");
          return;
        }
        // Empty input removes the local override → the system-wide value applies.
        const ask = async (title: string, current: string): Promise<string> => {
          const entered = await ctx.ui.input(title, `current: ${current} (Enter = system-wide)`);
          return entered?.trim() ?? "";
        };
        const agentId = await ask("agent_id for THIS project", cfg.agentId);
        const sessionId = await ask("session_id for THIS project", cfg.sessionId);
        const userId = await ask("user_id for THIS project", cfg.userId);
        const nRaw = (await ctx.ui.input(
          "capture every N turns for THIS project (0 = off, Enter = system-wide)",
          `current: ${cfg.captureEveryNTurns > 0 ? `every ${cfg.captureEveryNTurns} turns` : "off"}`,
        )) ?? "";
        const nTrim = nRaw.trim();
        const captureEveryNTurns: number | null = /^\d+$/.test(nTrim) ? Number(nTrim) : null;
        const captureWikiId = await ask("wiki id to archive captures for THIS project (Enter = system-wide)", cfg.captureWikiId);
        const captureWikiRef = await ask("wiki archive page ref for THIS project (Enter = system-wide)", cfg.captureWikiRef);
        const captureCodeGraphId = await ask("codegraph id to re-sync for THIS project (Enter = system-wide)", cfg.captureCodeGraphId);

        const patch: Partial<{ [K in keyof MemoryConfig]: MemoryConfig[K] | null }> = {
          agentId: agentId || null,
          sessionId: sessionId || null,
          userId: userId || null,
          captureEveryNTurns,
          captureWikiId: captureWikiId || null,
          captureWikiRef: captureWikiRef || null,
          captureCodeGraphId: captureCodeGraphId || null,
        };
        try {
          const filePath = saveProjectConfig(ctx.cwd, patch);
          const summary = (["agentId", "sessionId", "userId", "captureEveryNTurns", "captureWikiId", "captureWikiRef", "captureCodeGraphId"] as const)
            .map((k) => `${k}: ${patch[k] === null || patch[k] === undefined ? "(system-wide)" : String(patch[k])}`)
            .join(", ");
          ctx.ui.notify(`Local config updated: ${summary}`, "info");
          ctx.ui.notify(`File: ${filePath}`, "info");
          ctx.ui.notify("Run /tdmem status to confirm the resolved values.", "info");
        } catch (err) {
          ctx.ui.notify(`Could not save local config: ${err instanceof Error ? err.message : err}`, "error");
        }
        return;
      }

      if (sub === "status") {
        const projectPath = projectConfigPath(ctx.cwd);
        const projectExists = fs.existsSync(projectPath);
        const lines = [
          "Resolved configuration:",
          `  endpoint    ${cfg.endpoint}`,
          `  api key     ${maskKey(cfg.apiKey)}`,
          `  service id  ${cfg.serviceId}`,
          `  team/agent/user/session  ${cfg.teamId} / ${cfg.agentId} / ${cfg.userId} / ${cfg.sessionId}`,
          `  auto-capture  ${cfg.captureEveryNTurns > 0 ? `every ${cfg.captureEveryNTurns} turn(s)` : "off"}`,
          `  sync targets  wiki: ${cfg.captureWikiId || "(none)"}${cfg.captureWikiRef ? ` (ref: ${cfg.captureWikiRef})` : ""} | codegraph: ${cfg.captureCodeGraphId || "(none)"}`,
          `  knowledge    ${cfg.knowledgeEndpoint}`,
          `  project config     ${projectExists ? projectPath : "(none — using system-wide)"}`,
          `  system-wide config ${homeConfigPath()}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        try {
          const h = await health(cfg);
          ctx.ui.notify(`Health check: OK — ${JSON.stringify(h)}`, "info");
        } catch (err) {
          ctx.ui.notify(`Health check: FAILED — ${friendlyError(cfg, err)}`, "error");
        }
        return;
      }

      ctx.ui.notify(HELP, "info");
    },
  });
}
