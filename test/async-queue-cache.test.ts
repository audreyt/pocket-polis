import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import worker, { type SensemakingQueueMessage } from "../src/index";
import { Conversation } from "../src/conversation";
import { SENSEMAKING_MODEL } from "../src/sensemaking";

// In-memory mock SQLite storage for DurableObject
class MockSqlStorage {
  private meta = new Map<string, string>();

  exec(query: string, ...params: unknown[]) {
    const q = query.trim();

    if (q.startsWith("CREATE TABLE")) {
      return { toArray: () => [], one: () => ({}) };
    }

    if (q.startsWith("SELECT version FROM _sql_schema_migrations")) {
      return { toArray: () => [{ version: 1 }] };
    }

    if (q.startsWith("SELECT key, value FROM meta")) {
      const arr = [...this.meta.entries()].map(([key, value]) => ({ key, value }));
      return { toArray: () => arr };
    }

    if (q.startsWith("SELECT value FROM meta WHERE key = ?")) {
      const key = String(params[0]);
      const val = this.meta.get(key);
      return {
        toArray: () => (val !== undefined ? [{ value: val }] : []),
        one: () => (val !== undefined ? { value: val } : undefined),
      };
    }

    if (q.startsWith("INSERT INTO meta") || q.startsWith("INSERT OR REPLACE INTO meta")) {
      this.meta.set(String(params[0]), String(params[1]));
      return { toArray: () => [], one: () => undefined };
    }

    if (q.startsWith("DELETE FROM meta WHERE key = ?")) {
      this.meta.delete(String(params[0]));
      return { toArray: () => [] };
    }

    return { toArray: () => [], one: () => ({}) };
  }
}

describe("Async Queue & 24小時預算快取生命週期", () => {
  it("未變更之資料永久有效且 isStale 為 false", async () => {
    const ctx = {
      storage: {
        sql: new MockSqlStorage(),
        transactionSync: (fn: () => void) => fn(),
      },
    } as any;

    const env = { AI: { run: vi.fn() } } as any;
    const conv = new Conversation(ctx, env);

    const now = 1000000;
    const dummySynthesis = {
      version: "v1",
      status: "ready",
      model: SENSEMAKING_MODEL,
      generatedAt: now - 5000,
      mathRevision: 1,
      lang: "zh",
      overview: { summary: "Overview", participantContext: "", citedStatementIds: [1] },
      themes: [],
      commonGround: { summary: "CG", keyPoints: [] },
      groupPortraits: [],
      tensions: [],
      provenance: {
        generatedAt: now - 5000,
        mathRevision: 1,
        participantCount: 10,
        clusteredCount: 10,
        statementCount: 5,
        voteCount: 50,
        groupCount: 2,
      },
    };

    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "settings",
      JSON.stringify({ title: "標題", description: "說明", autoApprove: true }),
    );
    ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "revision", "1");
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "synthesis_data",
      JSON.stringify(dummySynthesis),
    );

    vi.spyOn(conv as any, "getResults").mockResolvedValue({
      result: { computedAt: 1, nParticipantsClustered: 10, groups: [{}, {}], nParticipantsTotal: 10, nVotes: 50 },
    });
    vi.spyOn(conv, "publicStatements").mockResolvedValue({
      statements: [{ sid: 1, text: "s1" }, { sid: 2, text: "s2" }, { sid: 3, text: "s3" }],
    });

    const res = await conv.checkOrStartSynthesis("conv123456", now);
    expect(res.response.status).toBe("ready");
    if (res.response.status === "ready") {
      expect(res.response.isStale).toBe(false);
      expect((res.response as any).refreshPending).toBeUndefined();
    }
    expect(res.needsEnqueue).toBeUndefined();
  });

  it("資料變更但未滿 24 小時：回傳舊快取並標記 isStale: true，不重複發送佇列", async () => {
    const ctx = {
      storage: {
        sql: new MockSqlStorage(),
        transactionSync: (fn: () => void) => fn(),
      },
    } as any;

    const env = { AI: { run: vi.fn() } } as any;
    const conv = new Conversation(ctx, env);

    const generatedAt = 1000000;
    const now = generatedAt + 2 * 60 * 60 * 1000; // 2 小時後（< 24h）

    const dummySynthesis = {
      version: "v1",
      status: "ready",
      model: SENSEMAKING_MODEL,
      generatedAt,
      mathRevision: 1,
      lang: "zh",
      overview: { summary: "Overview", participantContext: "", citedStatementIds: [1] },
      themes: [],
      commonGround: { summary: "CG", keyPoints: [] },
      groupPortraits: [],
      tensions: [],
      provenance: {
        generatedAt,
        mathRevision: 1,
        participantCount: 10,
        clusteredCount: 10,
        statementCount: 5,
        voteCount: 50,
        groupCount: 2,
      },
    };

    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "settings",
      JSON.stringify({ title: "標題", description: "說明", autoApprove: true }),
    );
    ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "revision", "2");
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "synthesis_data",
      JSON.stringify(dummySynthesis),
    );

    vi.spyOn(conv as any, "getResults").mockResolvedValue({
      result: { computedAt: 2, nParticipantsClustered: 12, groups: [{}, {}], nParticipantsTotal: 12, nVotes: 60 },
    });
    vi.spyOn(conv, "publicStatements").mockResolvedValue({
      statements: [{ sid: 1, text: "s1" }, { sid: 2, text: "s2" }, { sid: 3, text: "s3" }],
    });

    const res = await conv.checkOrStartSynthesis("conv123456", now);
    expect(res.response.status).toBe("ready");
    if (res.response.status === "ready") {
      expect(res.response.isStale).toBe(true);
      expect((res.response as any).refreshPending).toBeUndefined();
    }
    expect(res.needsEnqueue).toBeUndefined();
  });

  it("資料變更且已滿 24 小時：回傳舊快取標記 isStale: true, refreshPending: true，並回傳 needsEnqueue", async () => {
    const ctx = {
      storage: {
        sql: new MockSqlStorage(),
        transactionSync: (fn: () => void) => fn(),
      },
    } as any;

    const env = { AI: { run: vi.fn() } } as any;
    const conv = new Conversation(ctx, env);

    const generatedAt = 1000000;
    const now = generatedAt + 25 * 60 * 60 * 1000; // 25 小時後（>= 24h）

    const dummySynthesis = {
      version: "v1",
      status: "ready",
      model: SENSEMAKING_MODEL,
      generatedAt,
      mathRevision: 1,
      lang: "zh",
      overview: { summary: "Overview", participantContext: "", citedStatementIds: [1] },
      themes: [],
      commonGround: { summary: "CG", keyPoints: [] },
      groupPortraits: [],
      tensions: [],
      provenance: {
        generatedAt,
        mathRevision: 1,
        participantCount: 10,
        clusteredCount: 10,
        statementCount: 5,
        voteCount: 50,
        groupCount: 2,
      },
    };

    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "settings",
      JSON.stringify({ title: "國防軍購討論", description: "說明", autoApprove: true }),
    );
    ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "revision", "2");
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "synthesis_data",
      JSON.stringify(dummySynthesis),
    );

    vi.spyOn(conv as any, "getResults").mockResolvedValue({
      result: { computedAt: 2000000, nParticipantsClustered: 20, groups: [{}, {}], nParticipantsTotal: 20, nVotes: 100 },
    });
    vi.spyOn(conv, "publicStatements").mockResolvedValue({
      statements: [{ sid: 1, text: "支持國防自主" }, { sid: 2, text: "s2" }, { sid: 3, text: "s3" }],
    });

    const res = await conv.checkOrStartSynthesis("conv123456", now);
    expect(res.response.status).toBe("ready");
    if (res.response.status === "ready") {
      expect(res.response.isStale).toBe(true);
      expect((res.response as any).refreshPending).toBe(true);
    }
    expect(res.needsEnqueue).toBeDefined();
    expect(res.needsEnqueue?.conversationId).toBe("conv123456");
    expect(res.needsEnqueue?.sourceRevision).toBe(2000000);
  });

  it("佇列發送失敗時透過 markSensemakingEnqueueFailed 恢復狀態，不殘留 15 分鐘 pending", async () => {
    const ctx = {
      storage: {
        sql: new MockSqlStorage(),
        transactionSync: (fn: () => void) => fn(),
      },
    } as any;

    const conv = new Conversation(ctx, {} as any);
    const now = 5000;
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "synthesis_pending",
      JSON.stringify({ jobId: "job-123", sourceRevision: 1, startedAt: now }),
    );

    // 呼叫 markSensemakingEnqueueFailed
    await conv.markSensemakingEnqueueFailed("job-123", now, "Network transport timeout");

    // 驗證 pending 被清空
    const pendingVal = ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", "synthesis_pending").one()?.value;
    expect(pendingVal).toBeFalsy();

    // 驗證短暫傳輸失敗紀錄存在（30s 退避）
    const failureVal = ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", "synthesis_failure").one()?.value;
    expect(failureVal).toContain("Network transport timeout");
  });

  it("Queue Handler 冪等性與過期 sourceRevision 驗證", async () => {
    const ctx = {
      storage: {
        sql: new MockSqlStorage(),
        transactionSync: (fn: () => void) => fn(),
      },
    } as any;

    const aiRun = vi.fn();
    const conv = new Conversation(ctx, { AI: { run: aiRun } } as any);

    // 目前 pending 是 jobId: "job-new", revision: 5
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "synthesis_pending",
      JSON.stringify({ jobId: "job-new", sourceRevision: 5, startedAt: 1000 }),
    );

    // 舊任務嘗試執行（revision: 4 或 jobId: "job-old"）
    const resultOld = await conv.processSensemakingJob(4, "job-new", 2000);
    expect(resultOld.ok).toBe(true);
    expect(aiRun).not.toHaveBeenCalled();

    const resultOldJob = await conv.processSensemakingJob(5, "job-old", 2000);
    expect(resultOldJob.ok).toBe(true);
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("進行中 refresh 任務在再次輪詢時維持 refreshPending: true，不遺失狀態", async () => {
    const ctx = {
      storage: {
        sql: new MockSqlStorage(),
        transactionSync: (fn: () => void) => fn(),
      },
    } as any;

    const conv = new Conversation(ctx, {} as any);
    const generatedAt = 1000000;
    const now = generatedAt + 25 * 60 * 60 * 1000;

    const dummySynthesis = {
      version: "v1",
      status: "ready",
      model: SENSEMAKING_MODEL,
      generatedAt,
      mathRevision: 1000,
      lang: "zh",
      overview: { summary: "Overview", participantContext: "", citedStatementIds: [1] },
      themes: [],
      commonGround: { summary: "CG", keyPoints: [] },
      groupPortraits: [],
      tensions: [],
      provenance: {
        generatedAt,
        mathRevision: 1000,
        participantCount: 10,
        clusteredCount: 10,
        statementCount: 5,
        voteCount: 50,
        groupCount: 2,
      },
    };

    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "settings",
      JSON.stringify({ title: "標題", description: "說明", autoApprove: true }),
    );
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "synthesis_data",
      JSON.stringify(dummySynthesis),
    );

    vi.spyOn(conv as any, "getResults").mockResolvedValue({
      result: { computedAt: 2000, nParticipantsClustered: 10, groups: [{}, {}], nParticipantsTotal: 10, nVotes: 50 },
    });
    vi.spyOn(conv, "publicStatements").mockResolvedValue({
      statements: [{ sid: 1, text: "s1" }, { sid: 2, text: "s2" }, { sid: 3, text: "s3" }],
    });

    // 第一次發起：產生 needsEnqueue 與 pending 狀態
    const firstRes = await conv.checkOrStartSynthesis("conv123456", now);
    expect(firstRes.response.status).toBe("ready");
    expect(firstRes.needsEnqueue).toBeDefined();
    if (firstRes.response.status === "ready") {
      expect(firstRes.response.isStale).toBe(true);
      expect(firstRes.response.refreshPending).toBe(true);
    }

    // 第二次輪詢（同一 sourceRevision、仍在 pending timeout 內）：不得再次 enqueue
    const secondRes = await conv.checkOrStartSynthesis("conv123456", now + 3000);
    expect(secondRes.response.status).toBe("ready");
    expect(secondRes.needsEnqueue).toBeUndefined();
    if (secondRes.response.status === "ready") {
      expect(secondRes.response.isStale).toBe(true);
      expect(secondRes.response.refreshPending).toBe(true);
    }
    expect(firstRes.needsEnqueue?.jobId).toBeDefined();
    expect(firstRes.needsEnqueue?.sourceRevision).toBe(2000);
  });

  it("meta revision 未變但 math.result.computedAt 改變時（滿 24h）能正確判定 stale 並觸發 enqueue", async () => {
    const ctx = {
      storage: {
        sql: new MockSqlStorage(),
        transactionSync: (fn: () => void) => fn(),
      },
    } as any;

    const conv = new Conversation(ctx, {} as any);
    const generatedAt = 1000000;
    const now = generatedAt + 25 * 60 * 60 * 1000;

    const dummySynthesis = {
      version: "v1",
      status: "ready",
      model: SENSEMAKING_MODEL,
      generatedAt,
      mathRevision: 1000, // 舊的 math computedAt
      lang: "zh",
      overview: { summary: "Overview", participantContext: "", citedStatementIds: [1] },
      themes: [],
      commonGround: { summary: "CG", keyPoints: [] },
      groupPortraits: [],
      tensions: [],
      provenance: {
        generatedAt,
        mathRevision: 1000,
        participantCount: 10,
        clusteredCount: 10,
        statementCount: 5,
        voteCount: 50,
        groupCount: 2,
      },
    };

    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "settings",
      JSON.stringify({ title: "標題", description: "說明", autoApprove: true }),
    );
    // meta 的 revision 保持 "1" 不變（例如 5 秒節流未更新）
    ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "revision", "1");
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "synthesis_data",
      JSON.stringify(dummySynthesis),
    );

    // 但 math 重新計算產生的 computedAt 為 1005 (不同於 cached.mathRevision 1000)
    vi.spyOn(conv as any, "getResults").mockResolvedValue({
      result: { computedAt: 1005, nParticipantsClustered: 10, groups: [{}, {}], nParticipantsTotal: 10, nVotes: 50 },
    });
    vi.spyOn(conv, "publicStatements").mockResolvedValue({
      statements: [{ sid: 1, text: "s1" }, { sid: 2, text: "s2" }, { sid: 3, text: "s3" }],
    });

    const res = await conv.checkOrStartSynthesis("conv123456", now);
    expect(res.response.status).toBe("ready");
    if (res.response.status === "ready") {
      expect(res.response.isStale).toBe(true);
      expect(res.response.refreshPending).toBe(true);
    }
    expect(res.needsEnqueue).toBeDefined();
    expect(res.needsEnqueue?.sourceRevision).toBe(1005);
  });

  it("SENSEMAKING_QUEUE 缺失時清理 pending 狀態並回傳 fallback，不遺留 false pending", async () => {
    const markFailedSpy = vi.fn().mockResolvedValue(undefined);
    const stubMock = {
      isConversation: vi.fn().mockResolvedValue(true),
      checkOrStartSynthesis: vi
        .fn()
        .mockResolvedValueOnce({
          response: { status: "pending", jobId: "job-missing-queue", startedAt: 1000 },
          needsEnqueue: { conversationId: "conv123456", sourceRevision: 1, jobId: "job-missing-queue" },
        })
        .mockResolvedValueOnce({
          response: { status: "unavailable", reason: "AI synthesis is temporarily unavailable." },
        }),
      markSensemakingEnqueueFailed: markFailedSpy,
    };

    const envMockWithoutQueue = {
      CONVERSATION: { getByName: vi.fn().mockReturnValue(stubMock) },
      // SENSEMAKING_QUEUE is undefined
    } as any;

    const ctx = { waitUntil: (p: Promise<unknown>) => p } as any;
    const synthReq = new Request("https://polis.tw/api/conversations/conv123456/synthesis");
    const res = await worker.fetch(synthReq, envMockWithoutQueue, ctx);

    expect(markFailedSpy).toHaveBeenCalledWith("job-missing-queue", expect.any(Number), expect.any(String));
    const data = (await res.json()) as any;
    expect(data.status).toBe("unavailable");
  });
});

describe("Workers Cache 策略與標頭排除矩陣", () => {
  let cacheMatchSpy: any;
  let cachePutSpy: any;

  beforeEach(() => {
    cacheMatchSpy = vi.fn().mockResolvedValue(null);
    cachePutSpy = vi.fn().mockResolvedValue(undefined);
    (globalThis as any).caches = {
      default: {
        match: cacheMatchSpy,
        put: cachePutSpy,
      },
    };
  });

  it("公開 GET 請求觸發快取 match 與 put，且正則化快取鍵值移除所有 query", async () => {
    const stubMock = {
      isConversation: vi.fn().mockResolvedValue(true),
      publicInfo: vi.fn().mockResolvedValue({ id: "testconv01", title: "Title" }),
      publicStatements: vi.fn().mockResolvedValue({ statements: [] }),
      getResults: vi.fn().mockResolvedValue({ result: { nParticipantsClustered: 5 } }),
      checkOrStartSynthesis: vi.fn().mockResolvedValue({
        response: { status: "ready", isStale: false, generatedAt: 1000 },
      }),
    };

    const envMock = {
      CONVERSATION: { getByName: vi.fn().mockReturnValue(stubMock) },
      ASSETS: { fetch: vi.fn().mockResolvedValue(new Response("<html></html>", { status: 200 })) },
    } as any;

    const ctx = { waitUntil: (p: Promise<unknown>) => p } as any;

    // 1. 公開 Info -> 觸發快取 match & put
    const infoReq = new Request("https://polis.tw/api/conversations/testconv01");
    const infoRes = await worker.fetch(infoReq, envMock, ctx);
    expect(infoRes.headers.get("Cache-Control")).toContain("max-age=10");
    expect(cacheMatchSpy).toHaveBeenCalled();
    expect(cachePutSpy).toHaveBeenCalled();

    cacheMatchSpy.mockClear();
    cachePutSpy.mockClear();

    // 2. /synthesis 帶有任意 query 參數 (例如 ?lang=en&ref=share) -> 快取 key 移除所有 query
    const synthReq = new Request("https://polis.tw/api/conversations/testconv01/synthesis?lang=en&ref=share");
    const synthRes = await worker.fetch(synthReq, envMock, ctx);
    expect(synthRes.headers.get("Cache-Control")).toContain("max-age=300");

    const matchedReq = cacheMatchSpy.mock.calls[0][0] as Request;
    expect(matchedReq.url).toBe("https://polis.tw/api/conversations/testconv01/synthesis");
    expect(matchedReq.url).not.toContain("?");
  });

  it("快取命中 (cache hit) 時直接回傳快取，完全不呼叫 DO", async () => {
    const cachedResponse = new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    cacheMatchSpy.mockResolvedValueOnce(cachedResponse);

    const stubMock = {
      isConversation: vi.fn(),
      publicInfo: vi.fn(),
    };
    const envMock = {
      CONVERSATION: { getByName: vi.fn().mockReturnValue(stubMock) },
    } as any;
    const ctx = { waitUntil: (p: Promise<unknown>) => p } as any;

    const req = new Request("https://polis.tw/api/conversations/testconv01");
    const res = await worker.fetch(req, envMock, ctx);
    const data = await res.json();
    expect(data).toEqual({ cached: true });
    expect(stubMock.isConversation).not.toHaveBeenCalled();
    expect(stubMock.publicInfo).not.toHaveBeenCalled();
  });

  it("Request 帶有 Cache-Control: no-cache 或 no-store 略過快取 match 直通 DO", async () => {
    const stubMock = {
      isConversation: vi.fn().mockResolvedValue(true),
      publicInfo: vi.fn().mockResolvedValue({ id: "testconv01", title: "Fresh Title" }),
    };
    const envMock = {
      CONVERSATION: { getByName: vi.fn().mockReturnValue(stubMock) },
    } as any;
    const ctx = { waitUntil: (p: Promise<unknown>) => p } as any;

    const req = new Request("https://polis.tw/api/conversations/testconv01", {
      headers: { "Cache-Control": "no-cache" },
    });
    const res = await worker.fetch(req, envMock, ctx);
    expect(res.status).toBe(200);
    expect(cacheMatchSpy).not.toHaveBeenCalled();
    expect(cachePutSpy).not.toHaveBeenCalled();
    expect(stubMock.publicInfo).toHaveBeenCalled();
  });

  it("未在白名單之路徑（例如未知端點）絕不呼叫 Cache API", async () => {
    const envMock = {} as any;
    const ctx = { waitUntil: (p: Promise<unknown>) => p } as any;

    const unknownReq = new Request("https://polis.tw/api/unknown-endpoint");
    await worker.fetch(unknownReq, envMock, ctx);
    expect(cacheMatchSpy).not.toHaveBeenCalled();
    expect(cachePutSpy).not.toHaveBeenCalled();
  });

  it("非 200 回應（例如 404 或 400）絕不寫入快取 (no cache.put)", async () => {
    const envMock = {
      ASSETS: { fetch: vi.fn().mockResolvedValue(new Response("Not found", { status: 404 })) },
    } as any;
    const ctx = { waitUntil: (p: Promise<unknown>) => p } as any;

    // 404 請求
    const req404 = new Request("https://polis.tw/c/notanactualid123");
    const res404 = await worker.fetch(req404, envMock, ctx);
    expect(res404.status).toBe(404);
    expect(cachePutSpy).not.toHaveBeenCalled();
  });

  it("敏感、個人化、管理頁面、HEAD 請求及非 200 回應嚴格排除於快取之外", async () => {
    const stubMock = {
      isConversation: vi.fn().mockResolvedValue(true),
      getResults: vi.fn().mockResolvedValue({ result: { nParticipantsClustered: 5 } }),
      nextStatement: vi.fn().mockResolvedValue({ statement: null }),
      castVote: vi.fn().mockResolvedValue({ ok: true }),
      exportVotesCsv: vi.fn().mockResolvedValue("participant,vote\n"),
      adminOverview: vi.fn().mockResolvedValue({ settings: {} }),
    };

    const envMock = {
      CONVERSATION: { getByName: vi.fn().mockReturnValue(stubMock) },
      ASSETS: { fetch: vi.fn().mockResolvedValue(new Response("<html></html>", { status: 200 })) },
    } as any;

    const ctx = { waitUntil: (p: Promise<unknown>) => p } as any;

    // 1. 個人化 Results (with pid) -> no match, no put
    cacheMatchSpy.mockClear();
    cachePutSpy.mockClear();
    const pidReq = new Request(
      "https://polis.tw/api/conversations/testconv01/results?pid=00000000-0000-0000-0000-000000000001",
    );
    const pidRes = await worker.fetch(pidReq, envMock, ctx);
    expect(pidRes.headers.get("Cache-Control")).toContain("no-store");
    expect(cacheMatchSpy).not.toHaveBeenCalled();
    expect(cachePutSpy).not.toHaveBeenCalled();

    // 2. 帶 Authorization -> no match, no put
    cacheMatchSpy.mockClear();
    cachePutSpy.mockClear();
    const authReq = new Request("https://polis.tw/api/conversations/testconv01/admin", {
      headers: { Authorization: "Bearer 00000000000000000000000000000000" },
    });
    await worker.fetch(authReq, envMock, ctx);
    expect(cacheMatchSpy).not.toHaveBeenCalled();
    expect(cachePutSpy).not.toHaveBeenCalled();

    // 3. 管理頁面 /a/testconv01 -> no match, no put
    cacheMatchSpy.mockClear();
    cachePutSpy.mockClear();
    const adminPageReq = new Request("https://polis.tw/a/testconv01");
    await worker.fetch(adminPageReq, envMock, ctx);
    expect(cacheMatchSpy).not.toHaveBeenCalled();
    expect(cachePutSpy).not.toHaveBeenCalled();

    // 4. 資料匯出 /export/votes.csv -> no match, no put
    cacheMatchSpy.mockClear();
    cachePutSpy.mockClear();
    const exportReq = new Request("https://polis.tw/api/conversations/testconv01/export/votes.csv");
    await worker.fetch(exportReq, envMock, ctx);
    expect(cacheMatchSpy).not.toHaveBeenCalled();
    expect(cachePutSpy).not.toHaveBeenCalled();

    // 5. POST /votes -> no match, no put
    cacheMatchSpy.mockClear();
    cachePutSpy.mockClear();
    const voteReq = new Request("https://polis.tw/api/conversations/testconv01/votes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid: "00000000-0000-0000-0000-000000000001", sid: 1, value: 1 }),
    });
    await worker.fetch(voteReq, envMock, ctx);
    expect(cacheMatchSpy).not.toHaveBeenCalled();
    expect(cachePutSpy).not.toHaveBeenCalled();

    // 6. HEAD 請求 -> no match, no put
    cacheMatchSpy.mockClear();
    cachePutSpy.mockClear();
    const headReq = new Request("https://polis.tw/api/conversations/testconv01", { method: "HEAD" });
    await worker.fetch(headReq, envMock, ctx);
    expect(cacheMatchSpy).not.toHaveBeenCalled();
    expect(cachePutSpy).not.toHaveBeenCalled();
  });
});
