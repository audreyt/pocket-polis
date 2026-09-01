import type { Conversation, ConversationSettings } from "./conversation";
import type { VoteValue } from "./math/types";

export { Conversation } from "./conversation";

const CONVERSATION_ID_PATTERN = /^[a-z0-9]{10}$/;
const PID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_SEED_STATEMENTS = 50;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (!url.pathname.startsWith("/api/")) {
        return servePage(request, env, url);
      }

      if (url.pathname === "/api/health") {
        return json({ ok: true, storage: "durable-object-sqlite", math: "in-worker" });
      }

      if (url.pathname === "/api/conversations") {
        if (request.method !== "POST") return jsonError("method not allowed", 405);
        return createConversation(request, env);
      }

      const match = url.pathname.match(/^\/api\/conversations\/([a-z0-9]{10})(\/.*)?$/);
      if (!match) return jsonError("not found", 404);
      const conversationId = match[1]!;
      const subPath = match[2] ?? "/";
      const stub = env.CONVERSATION.getByName(`conv:${conversationId}`);
      if (!(await stub.isConversation())) return jsonError("conversation not found", 404);
      return handleConversationApi(request, url, stub, subPath);
    } catch (error) {
      console.error("unhandled", error instanceof Error ? error.stack : error);
      return jsonError("internal error", 500);
    }
  },
} satisfies ExportedHandler<Env>;

// ---- pages ----

// 注意：assets binding 預設 html_handling=auto-trailing-slash，
// 直接要 /participate.html 會被 307 轉址；用無副檔名路徑取資產。
const PAGE_REWRITES: [RegExp, string][] = [
  [/^\/c\/[a-z0-9]{10}$/, "/participate"],
  [/^\/r\/[a-z0-9]{10}$/, "/report"],
  [/^\/a\/[a-z0-9]{10}$/, "/admin"],
  [/^\/en$/, "/en"],
  [/^\/guide$/, "/guide"],
  [/^\/en\/guide$/, "/guide-en"],
];

async function servePage(request: Request, env: Env, url: URL): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method)) {
    return new Response("method not allowed", { status: 405 });
  }
  let assetPath: string | null = null;
  if (url.pathname === "/") {
    assetPath = "/";
  } else {
    for (const [pattern, target] of PAGE_REWRITES) {
      if (pattern.test(url.pathname)) {
        assetPath = target;
        break;
      }
    }
  }
  if (!assetPath) return new Response("not found", { status: 404 });
  const assetUrl = new URL(assetPath, url.origin);
  const response = await env.ASSETS.fetch(new Request(assetUrl, request));
  return withSecurityHeaders(response);
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, { status: response.status, headers });
}

// ---- conversation lifecycle ----

async function createConversation(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!isRecord(body)) return jsonError("invalid body", 400);
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
  if (!title) return jsonError("title is required", 400);
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 2000) : "";
  const seedStatements = Array.isArray(body.seedStatements)
    ? body.seedStatements.filter((s): s is string => typeof s === "string").slice(0, MAX_SEED_STATEMENTS)
    : [];

  const settings: ConversationSettings = {
    title,
    description,
    autoApprove: body.autoApprove !== false,
    allowSubmissions: body.allowSubmissions !== false,
    openData: body.openData === true,
    status: "open",
  };

  const now = Date.now();
  const limiter = env.CONVERSATION.getByName("creation-limiter");
  const reservation = await limiter.reserveCreation(now);
  if (!reservation.ok) return jsonError(reservation.error ?? "rate limited", 429);

  const conversationId = randomId();
  const adminToken = randomToken();
  const adminTokenHash = await sha256Hex(adminToken);
  const stub = env.CONVERSATION.getByName(`conv:${conversationId}`);
  const result = await stub.initConversation(conversationId, settings, seedStatements, adminTokenHash, now);
  if (!result.ok) return jsonError(result.error, 500);

  return json(
    {
      conversationId,
      adminToken,
      urls: {
        participate: `/c/${conversationId}`,
        report: `/r/${conversationId}`,
        admin: `/a/${conversationId}#token=${adminToken}`,
      },
    },
    201,
  );
}

// ---- per-conversation API ----

async function handleConversationApi(
  request: Request,
  url: URL,
  stub: DurableObjectStub<Conversation>,
  subPath: string,
): Promise<Response> {
  const now = Date.now();

  if (subPath === "/" && request.method === "GET") {
    return json(await stub.publicInfo());
  }

  if (subPath === "/next" && request.method === "GET") {
    const pid = requirePid(url.searchParams.get("pid"));
    if (!pid) return jsonError("valid pid query param required", 400);
    return json(await stub.nextStatement(pid, now));
  }

  if (subPath === "/votes" && request.method === "POST") {
    const body = await readJson(request);
    if (!isRecord(body)) return jsonError("invalid body", 400);
    const pid = requirePid(body.pid);
    if (!pid) return jsonError("valid pid required", 400);
    const sid = Number(body.sid);
    if (!Number.isInteger(sid) || sid <= 0) return jsonError("valid sid required", 400);
    if (body.value !== 1 && body.value !== -1 && body.value !== 0) {
      return jsonError("value must be 1 (agree), -1 (disagree) or 0 (pass)", 400);
    }
    const result = await stub.castVote(pid, sid, body.value as VoteValue, now);
    return result.ok ? json(result) : jsonError(result.error, 400);
  }

  if (subPath === "/statements" && request.method === "POST") {
    const body = await readJson(request);
    if (!isRecord(body)) return jsonError("invalid body", 400);
    const pid = requirePid(body.pid);
    if (!pid) return jsonError("valid pid required", 400);
    if (typeof body.text !== "string") return jsonError("text required", 400);
    const result = await stub.submitStatement(pid, body.text, now);
    return result.ok ? json(result) : jsonError(result.error, 400);
  }

  if (subPath === "/statements-public" && request.method === "GET") {
    return json(await stub.publicStatements());
  }

  if (subPath === "/results" && request.method === "GET") {
    const pid = requirePid(url.searchParams.get("pid"));
    const results = await stub.getResults(pid, now);
    if (!results) return jsonError("not found", 404);
    return json(results, 200, { "Cache-Control": "no-store" });
  }

  if (subPath === "/export/statements.csv" && request.method === "GET") {
    const csv = await stub.exportStatementsCsv(bearerToken(request, url));
    if (csv === null) return jsonError("unauthorized (data export is not public for this conversation)", 403);
    return csvResponse(csv, "statements.csv");
  }

  if (subPath === "/export/votes.csv" && request.method === "GET") {
    const csv = await stub.exportVotesCsv(bearerToken(request, url));
    if (csv === null) return jsonError("unauthorized (data export is not public for this conversation)", 403);
    return csvResponse(csv, "votes.csv");
  }

  // ---- admin ----

  if (subPath === "/admin" && request.method === "GET") {
    const token = bearerToken(request, url);
    if (!token) return jsonError("unauthorized", 401);
    const overview = await stub.adminOverview(token);
    if ("error" in overview) return jsonError(overview.error, 401);
    return json(overview, 200, { "Cache-Control": "no-store" });
  }

  const moderate = subPath.match(/^\/admin\/statements\/(\d+)$/);
  if (moderate && request.method === "POST") {
    const token = bearerToken(request, url);
    if (!token) return jsonError("unauthorized", 401);
    const body = await readJson(request);
    if (!isRecord(body) || (body.action !== "approve" && body.action !== "reject")) {
      return jsonError("action must be approve or reject", 400);
    }
    const result = await stub.moderateStatement(token, Number(moderate[1]), body.action);
    return result.ok ? json(result) : jsonError(result.error, result.error === "unauthorized" ? 401 : 400);
  }

  if (subPath === "/admin/statements" && request.method === "POST") {
    const token = bearerToken(request, url);
    if (!token) return jsonError("unauthorized", 401);
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.text !== "string") return jsonError("text required", 400);
    const result = await stub.addSeedStatement(token, body.text, now);
    return result.ok ? json(result) : jsonError(result.error, result.error === "unauthorized" ? 401 : 400);
  }

  if (subPath === "/admin/settings" && request.method === "POST") {
    const token = bearerToken(request, url);
    if (!token) return jsonError("unauthorized", 401);
    const body = await readJson(request);
    if (!isRecord(body)) return jsonError("invalid body", 400);
    const result = await stub.updateSettings(token, body as Partial<ConversationSettings>);
    return result.ok ? json(result) : jsonError(result.error, result.error === "unauthorized" ? 401 : 400);
  }

  return jsonError("not found", 404);
}

// ---- helpers ----

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n.toString(36).padStart(10, "0").slice(-10);
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function requirePid(value: unknown): string | null {
  return typeof value === "string" && PID_PATTERN.test(value) ? value : null;
}

function bearerToken(request: Request, url: URL): string | null {
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7).trim() || null;
  // CSV 下載連結無法帶 header，允許 query token（admin 頁自己的分頁內使用）
  const q = url.searchParams.get("token");
  return q && /^[0-9a-f]{32}$/.test(q) ? q : null;
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function jsonError(message: string, status: number): Response {
  return json({ error: message }, status);
}

function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

export const _internal = { randomId, sha256Hex };
