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
import { AI_ATTEMPT_WINDOW_MS, SYNTHESIS_AI_CLAIM_KEY } from "../src/ai-budget";
import { Conversation } from "../src/conversation";
import { NeuronCoordinator } from "../src/neuron-coordinator";
import { DETERMINISTIC_MODEL, SENSEMAKING_MODEL } from "../src/sensemaking";

// In-memory mock SQLite storage for DurableObject
class MockSqlStorage {
  private meta = new Map<string, string>();
  statements: Array<{ sid: number; text: string; status: string }> = [];
  votes: Array<{ pid: string; sid: number; value: number }> = [];

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

    if (q.includes("FROM statements") && q.includes("status = 'approved'")) {
      if (q.includes("COALESCE(SUM")) {
        const sum = this.votes.length;
        return { one: () => ({ v: sum }), toArray: () => [{ v: sum }] };
      }
      const approved = this.statements.filter((s) => s.status === "approved");
      return {
        toArray: () => approved,
        one: () => approved[0] || {},
      };
    }

    if (q.includes("FROM votes")) {
      return {
        toArray: () => this.votes,
        one: () => this.votes[0] || {},
      };
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
  it("enqueue 傳輸失敗時 synthesis_failure 實施 30 秒退避與暫時不可用原因，過期後自動恢復", async () => {
    const ctx = {
      storage: {
        sql: new MockSqlStorage(),
        transactionSync: (fn: () => void) => fn(),
      },
    } as unknown as DurableObjectState;

    const conv = new Conversation(ctx, {} as unknown as Env);
    const now = 5000;
    (ctx.storage.sql as any).exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "settings",
      JSON.stringify({ title: "標題", description: "說明", autoApprove: true }),
    );
    (ctx.storage.sql as any).exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "id", "conv123456");
    const mathResult = {
      computedAt: 42,
      k: 2,
      nParticipantsClustered: 10,
      nParticipantsTotal: 10,
      nVotes: 50,
      statementStats: [],
      consensus: { agree: [], disagree: [] },
      groups: [
        { id: 0, label: "A", size: 5, representative: [], statementStats: [] },
        { id: 1, label: "B", size: 5, representative: [], statementStats: [] },
      ],
    };
    vi.spyOn(conv as any, "getResults").mockResolvedValue({ result: mathResult, you: null });
    vi.spyOn(conv as any, "computeResults").mockReturnValue({ result: mathResult, you: null });
    vi.spyOn(conv, "publicStatements").mockResolvedValue({
      statements: [{ sid: 1, text: "s1" }, { sid: 2, text: "s2" }, { sid: 3, text: "s3" }],
    });

    (ctx.storage.sql as any).exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "synthesis_pending",
      JSON.stringify({ jobId: "job-fail", sourceRevision: 42, startedAt: now }),
    );

    // 呼叫 markSensemakingEnqueueFailed（設定 retryAfter = now + 30000）
    await conv.markSensemakingEnqueueFailed("job-fail", now, "Queue enqueue transport timeout");

    // 1. 處於 30 秒退避期內（now + 5000）：回傳 unavailable、保留自訂原因與 retryAfter
    const blockedRes = await conv.checkOrStartSynthesis("conv123456", now + 5000);
    expect(blockedRes.needsEnqueue).toBeUndefined();
    expect(blockedRes.response.status).toBe("unavailable");
    if (blockedRes.response.status === "unavailable") {
      expect(blockedRes.response.reason).toBe("Queue enqueue transport timeout");
      expect(blockedRes.response.retryAfter).toBe(now + 30000);
    }

    // 2. 測試原因為空時退避預設 reason 為 "AI synthesis is temporarily unavailable."
    (ctx.storage.sql as any).exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "synthesis_failure",
      JSON.stringify({ failedAt: now, retryAfter: now + 30000, reason: "" }),
    );
    const defaultReasonRes = await conv.checkOrStartSynthesis("conv123456", now + 6000);
    expect(defaultReasonRes.response.status).toBe("unavailable");
    if (defaultReasonRes.response.status === "unavailable") {
      expect(defaultReasonRes.response.reason).toBe("AI synthesis is temporarily unavailable.");
    }

    // 3. 超過 30 秒退避期（now + 30000）：退避結束，成功發起新生成任務
    const recoveredRes = await conv.checkOrStartSynthesis("conv123456", now + 30000);
    expect(recoveredRes.response.status).toBe("pending");
    expect(recoveredRes.needsEnqueue).toBeDefined();
    expect(recoveredRes.needsEnqueue?.conversationId).toBe("conv123456");
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
    const thirdRes = await conv.checkOrStartSynthesis("conv123456", now + 6000);
    expect(thirdRes.needsEnqueue).toBeUndefined();
    expect(thirdRes.response.status).toBe("ready");
  });

  it("same sourceRevision pending GET/check exposes needsEnqueue only once via persisted jobId", async () => {
    const ctx = {
      storage: {
        sql: new MockSqlStorage(),
        transactionSync: (fn: () => void) => fn(),
      },
    } as any;

    const conv = new Conversation(ctx, {} as any);
    const now = 1000;
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "settings",
      JSON.stringify({ title: "標題", description: "說明", autoApprove: true }),
    );
    ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "id", "conv123456");

    vi.spyOn(conv as any, "getResults").mockResolvedValue({
      result: { computedAt: 42, nParticipantsClustered: 10, groups: [{}, {}], nParticipantsTotal: 10, nVotes: 50 },
    });
    vi.spyOn(conv, "publicStatements").mockResolvedValue({
      statements: [{ sid: 1, text: "s1" }, { sid: 2, text: "s2" }, { sid: 3, text: "s3" }],
    });

    const first = await conv.checkOrStartSynthesis("conv123456", now);
    expect(first.response.status).toBe("pending");
    expect(first.needsEnqueue).toBeDefined();
    expect(first.needsEnqueue?.jobId).toBeDefined();
    expect(first.needsEnqueue?.sourceRevision).toBe(42);
    expect(first.needsEnqueue?.conversationId).toBe("conv123456");
    if (first.response.status === "pending") {
      expect(first.response.jobId).toBe(first.needsEnqueue?.jobId);
    }

    const second = await conv.checkOrStartSynthesis("conv123456", now + 1000);
    expect(second.needsEnqueue).toBeUndefined();
    expect(second.response.status).toBe("pending");
    if (second.response.status === "pending") {
      expect(second.response.jobId).toBe(first.needsEnqueue?.jobId);
    }

    const third = await conv.checkOrStartSynthesis("conv123456", now + 2000);
    expect(third.needsEnqueue).toBeUndefined();
    if (third.response.status === "pending") {
      expect(third.response.jobId).toBe(first.needsEnqueue?.jobId);
    }
  });

  it("repeated GET /synthesis for the same revision sends the queue once", async () => {
    const ctx = {
      storage: {
        sql: new MockSqlStorage(),
        transactionSync: (fn: () => void) => fn(),
      },
    } as any;

    const conv = new Conversation(ctx, {} as any);
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "settings",
      JSON.stringify({ title: "標題", description: "說明", autoApprove: true }),
    );
    ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "id", "conv123456");

    vi.spyOn(conv as any, "getResults").mockResolvedValue({
      result: { computedAt: 42, nParticipantsClustered: 10, groups: [{}, {}], nParticipantsTotal: 10, nVotes: 50 },
    });
    vi.spyOn(conv, "publicStatements").mockResolvedValue({
      statements: [{ sid: 1, text: "s1" }, { sid: 2, text: "s2" }, { sid: 3, text: "s3" }],
    });
    vi.spyOn(conv, "isConversation").mockResolvedValue(true);

    const send = vi.fn().mockResolvedValue(undefined);
    const env = {
      CONVERSATION: { getByName: vi.fn().mockReturnValue(conv) },
      SENSEMAKING_QUEUE: { send },
    } as any;
    const execCtx = { waitUntil: (p: Promise<unknown>) => p } as any;
    const req = new Request("https://example.com/api/conversations/conv123456/synthesis", {
      headers: { "Cache-Control": "no-cache" },
    });

    const res1 = await worker.fetch(req, env, execCtx);
    const res2 = await worker.fetch(req, env, execCtx);
    expect(send).toHaveBeenCalledTimes(1);
    const body1 = (await res1.json()) as { status: string; jobId?: string };
    const body2 = (await res2.json()) as { status: string; jobId?: string };
    expect(body1.status).toBe("pending");
    expect(body2.status).toBe("pending");
    expect(body1.jobId).toBeDefined();
    expect(body2.jobId).toBe(body1.jobId);
    expect(send.mock.calls[0]![0]).toEqual({
      conversationId: "conv123456",
      sourceRevision: 42,
      jobId: body1.jobId,
    });
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
    const synthReq = new Request("https://example.com/api/conversations/conv123456/synthesis");
    const res = await worker.fetch(synthReq, envMockWithoutQueue, ctx);
    expect(markFailedSpy).toHaveBeenCalledWith("job-missing-queue", expect.any(Number), expect.any(String));
    const data = (await res.json()) as any;
    expect(data.status).toBe("unavailable");
  });

  it("舊版或無 schemaVersion 之 legacy mathCache 立即判定失效並重算，持久化 schemaVersion: 2 與 group statementStats", async () => {
    const sqlStorage = new MockSqlStorage();
    sqlStorage.statements = [
      { sid: 1, text: "s1", status: "approved" },
      { sid: 2, text: "s2", status: "approved" },
      { sid: 3, text: "s3", status: "approved" },
      { sid: 4, text: "s4", status: "approved" },
    ];
    sqlStorage.votes = [
      // Group 1 participants: agree 1, 2; disagree 3, 4
      { pid: "p1", sid: 1, value: 1 }, { pid: "p1", sid: 2, value: 1 }, { pid: "p1", sid: 3, value: -1 }, { pid: "p1", sid: 4, value: -1 },
      { pid: "p2", sid: 1, value: 1 }, { pid: "p2", sid: 2, value: 1 }, { pid: "p2", sid: 3, value: -1 }, { pid: "p2", sid: 4, value: -1 },
      { pid: "p3", sid: 1, value: 1 }, { pid: "p3", sid: 2, value: 1 }, { pid: "p3", sid: 3, value: -1 }, { pid: "p3", sid: 4, value: -1 },
      // Group 2 participants: disagree 1, 2; agree 3, 4
      { pid: "p4", sid: 1, value: -1 }, { pid: "p4", sid: 2, value: -1 }, { pid: "p4", sid: 3, value: 1 }, { pid: "p4", sid: 4, value: 1 },
      { pid: "p5", sid: 1, value: -1 }, { pid: "p5", sid: 2, value: -1 }, { pid: "p5", sid: 3, value: 1 }, { pid: "p5", sid: 4, value: 1 },
      { pid: "p6", sid: 1, value: -1 }, { pid: "p6", sid: 2, value: -1 }, { pid: "p6", sid: 3, value: 1 }, { pid: "p6", sid: 4, value: 1 },
    ];

    const ctx = {
      storage: {
        sql: sqlStorage,
        transactionSync: (fn: () => void) => fn(),
      },
    } as any;

    const conv = new Conversation(ctx, {} as any);
    const now = 1000000;

    // 模擬舊版未含 schemaVersion 且 groups 缺少 statementStats 的 mathCache
    const legacyMathCache = {
      revision: 1,
      publicResult: {
        conversationId: "conv123456",
        computedAt: now - 1000,
        nVotes: 24,
        nParticipantsTotal: 6,
        nParticipantsClustered: 6,
        inclusionThreshold: 1,
        k: 2,
        groups: [
          { id: 0, label: "0", size: 3, center: [0, 0], representative: [] },
          { id: 1, label: "1", size: 3, center: [1, 1], representative: [] },
        ],
        consensus: { agree: [], disagree: [] },
        statementStats: [],
        points: [],
      },
      pidPoints: {},
    };

    sqlStorage.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "id", "conv123456");
    sqlStorage.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "revision", "1");
    sqlStorage.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "mathCache", JSON.stringify(legacyMathCache));
    // mathComputedAt 距今僅 1000ms（遠小於 minInterval 30000ms）
    sqlStorage.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "mathComputedAt", String(now - 1000));

    // 執行真實 production getResults（不 mock recompute），驗證在 minInterval 內因 schema 失效而立即重算
    const results = await conv.getResults(null, now);
    expect(results).toBeDefined();
    expect(results?.result.groups.length).toBeGreaterThanOrEqual(2);
    expect(results?.result.groups[0].statementStats).toBeDefined();
    expect(results?.result.groups[0].statementStats.length).toBeGreaterThan(0);

    // 驗證 SQLite meta 中實際持久化了 schemaVersion: 2 的結構
    const storedRaw = sqlStorage.exec("SELECT value FROM meta WHERE key = ?", "mathCache").one()?.value;
    expect(storedRaw).toBeDefined();
    const storedCache = JSON.parse(storedRaw!);
    expect(storedCache.schemaVersion).toBe(2);
    expect(storedCache.publicResult.groups.every((g: any) => Array.isArray(g.statementStats) && g.statementStats.length > 0)).toBe(true);
  });

  it("確定性 fallback (persistDeterministicReady) 僅在 mathRevision 一致時重用現有 ready 快取，revision 變更時重新生成", async () => {
    const ctx = {
      storage: {
        sql: new MockSqlStorage(),
        transactionSync: (fn: () => void) => fn(),
      },
    } as any;

    const conv = new Conversation(ctx, {} as any);
    const now = 1000000;

    const oldSynthesis = {
      version: "v1",
      status: "ready",
      model: DETERMINISTIC_MODEL,
      generatedAt: now - 50000,
      mathRevision: 1,
      lang: "zh",
      overview: { summary: "Revision 1 Synthesis", participantContext: "", citedStatementIds: [] },
      themes: [],
      commonGround: { summary: "", keyPoints: [] },
      groupPortraits: [],
      tensions: [],
      provenance: {
        generatedAt: now - 50000,
        mathRevision: 1,
        participantCount: 10,
        clusteredCount: 10,
        statementCount: 5,
        voteCount: 50,
        groupCount: 2,
      },
    };

    ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "synthesis_data", JSON.stringify(oldSynthesis));

    const mathResult = {
      conversationId: "conv123456",
      computedAt: now,
      nVotes: 60,
      nParticipantsTotal: 12,
      nParticipantsClustered: 12,
      inclusionThreshold: 1,
      k: 2,
      groups: [
        { id: 0, label: "0", size: 6, center: [0, 0], representative: [], statementStats: [] },
        { id: 1, label: "1", size: 6, center: [1, 1], representative: [], statementStats: [] },
      ],
      consensus: { agree: [], disagree: [] },
      statementStats: [],
      points: [],
    };
    const statements = [{ sid: 1, text: "s1" }, { sid: 2, text: "s2" }, { sid: 3, text: "s3" }];

    // 1. 相同 mathRevision (1)：重用現有快取
    const reused = (conv as any).persistDeterministicReady("zh", "標題", mathResult, statements, 1, now);
    expect(reused.mathRevision).toBe(1);
    expect(reused.overview.summary).toBe("Revision 1 Synthesis");

    // 2. 新 mathRevision (2)：不重用舊快取，重新生成 mathRevision 2 之確定性綜整
    const regenerated = (conv as any).persistDeterministicReady("zh", "標題", mathResult, statements, 2, now);
    expect(regenerated.mathRevision).toBe(2);
    expect(regenerated.provenance.mathRevision).toBe(2);
  });
});


describe("Per-conversation AI claim and deployment coordinator", () => {
  function convCtx() {
    const sql = new MockSqlStorage();
    const ctx = {
      storage: {
        sql,
        transactionSync: (fn: () => void) => fn(),
      },
    } as any;
    return { ctx, sql };
  }

  function makeCoordinator() {
    const { ctx } = convCtx();
    return new NeuronCoordinator(ctx, {} as Env);
  }

  function seedSynthesisReady(conv: Conversation, ctx: any, now: number) {
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "settings",
      JSON.stringify({ title: "標題", description: "說明", autoApprove: true }),
    );
    ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "id", "conv123456");
    const mathResult = {
      computedAt: 42,
      k: 2,
      nParticipantsClustered: 10,
      nParticipantsTotal: 10,
      nVotes: 50,
      statementStats: [],
      consensus: { agree: [], disagree: [] },
      groups: [
        { id: 0, label: "A", size: 5, representative: [], statementStats: [] },
        { id: 1, label: "B", size: 5, representative: [], statementStats: [] },
      ],
    };
    vi.spyOn(conv as any, "getResults").mockResolvedValue({ result: mathResult, you: null });
    vi.spyOn(conv as any, "computeResults").mockReturnValue({ result: mathResult, you: null });
    vi.spyOn(conv, "publicStatements").mockResolvedValue({
      statements: [{ sid: 1, text: "s1" }, { sid: 2, text: "s2" }, { sid: 3, text: "s3" }],
    });
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "synthesis_pending",
      JSON.stringify({ jobId: "job-1", sourceRevision: 42, startedAt: now }),
    );
  }

  function topicAi() {
    return vi.fn(async (_model: string, payload: { messages: { content: string }[] }) => {
      const sys = payload.messages[0]?.content ?? "";
      if (sys.includes("mutually exclusive")) {
        return {
          response: JSON.stringify({
            topics: [
              { id: "t1", title: "Theme 1", description: "Desc 1" },
              { id: "t2", title: "Theme 2", description: "Desc 2" },
              { id: "t3", title: "Theme 3", description: "Desc 3" },
            ],
          }),
        };
      }
      if (sys.includes("precise classifier")) {
        return { response: JSON.stringify({ assignments: [] }) };
      }
      return {
        response: JSON.stringify({
          overview: { summary: "Sum", citedStatementIds: [1] },
          commonGround: { keyPoints: [] },
          groupPortraits: [],
          tensions: [],
        }),
      };
    });
  }

  it("writes synthesis_ai_claim before the first mocked ai.run", async () => {
    const { ctx } = convCtx();
    const order: string[] = [];
    const coord = makeCoordinator();
    const innerReserve = coord.reserve.bind(coord);
    coord.reserve = async (neurons: number, now: number) => {
      order.push("reserve");
      return innerReserve(neurons, now);
    };
    const responder = topicAi();
    const aiRun = vi.fn(async (model: string, payload: { messages: { content: string }[] }) => {
      const row = ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", SYNTHESIS_AI_CLAIM_KEY).one() as
        | { value: string }
        | undefined;
      expect(row?.value).toBeTruthy();
      expect(JSON.parse(row!.value).claimedAt).toBe(1000);
      order.push("ai");
      return responder(model, payload);
    });
    const conv = new Conversation(ctx, {
      AI: { run: aiRun },
      NEURON_COORDINATOR: { getByName: () => coord },
    } as any);
    seedSynthesisReady(conv, ctx, 1000);
    await conv.processSensemakingJob(42, "job-1", 1000);
    expect(aiRun.mock.calls.length).toBeGreaterThan(0);
    expect(order[0]).toBe("reserve");
    for (let i = 0; i < order.length; i++) {
      if (order[i] === "ai") expect(order[i - 1]).toBe("reserve");
    }
  });

  it("same job retry after a claimed attempt does not call AI again", async () => {
    const { ctx } = convCtx();
    const coord = makeCoordinator();
    const aiRun = topicAi();
    const conv = new Conversation(ctx, {
      AI: { run: aiRun },
      NEURON_COORDINATOR: { getByName: () => coord },
    } as any);
    seedSynthesisReady(conv, ctx, 1000);
    await conv.processSensemakingJob(42, "job-1", 1000);
    const calls = aiRun.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "synthesis_pending",
      JSON.stringify({ jobId: "job-1", sourceRevision: 42, startedAt: 1000 }),
    );
    await conv.processSensemakingJob(42, "job-1", 1500);
    expect(aiRun.mock.calls.length).toBe(calls);
  });

  it("a different job and source revision inside 24h does not call AI", async () => {
    const { ctx } = convCtx();
    const coord = makeCoordinator();
    const aiRun = topicAi();
    const conv = new Conversation(ctx, {
      AI: { run: aiRun },
      NEURON_COORDINATOR: { getByName: () => coord },
    } as any);
    seedSynthesisReady(conv, ctx, 1000);
    await conv.processSensemakingJob(42, "job-1", 1000);
    const calls = aiRun.mock.calls.length;
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "synthesis_pending",
      JSON.stringify({ jobId: "job-2", sourceRevision: 99, startedAt: 2000 }),
    );
    await conv.processSensemakingJob(99, "job-2", 2000);
    expect(aiRun.mock.calls.length).toBe(calls);
  });

  it("updateSettings does not clear the AI claim window", async () => {
    const { ctx } = convCtx();
    const coord = makeCoordinator();
    const aiRun = topicAi();
    const token = "admin-token";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const conv = new Conversation(ctx, {
      AI: { run: aiRun },
      NEURON_COORDINATOR: { getByName: () => coord },
    } as any);
    seedSynthesisReady(conv, ctx, 1000);
    await conv.processSensemakingJob(42, "job-1", 1000);
    const claimBefore = ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", SYNTHESIS_AI_CLAIM_KEY).one() as {
      value: string;
    };
    ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "adminTokenHash", hash);
    const updated = await conv.updateSettings(token, { title: "新標題" });
    expect(updated.ok).toBe(true);
    const claimAfter = ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", SYNTHESIS_AI_CLAIM_KEY).one() as {
      value: string;
    };
    expect(claimAfter.value).toBe(claimBefore.value);
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "synthesis_pending",
      JSON.stringify({ jobId: "job-3", sourceRevision: 42, startedAt: 3000 }),
    );
    const calls = aiRun.mock.calls.length;
    await conv.processSensemakingJob(42, "job-3", 3000);
    expect(aiRun.mock.calls.length).toBe(calls);
  });

  it("updateSettings with only operational fields keeps a valid ready synthesis; title/description change invalidates it", async () => {
    const { ctx } = convCtx();
    const conv = new Conversation(ctx, {} as any);
    const token = "admin-token";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "adminTokenHash", hash);
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "settings",
      JSON.stringify({ title: "標題", description: "說明", autoApprove: true, allowSubmissions: true, openData: false, status: "open", altUrl: "" }),
    );
    const ready = JSON.stringify({ status: "ready", mathRevision: 42, overview: { summary: "x" } });
    const readMeta = (key: string) =>
      (ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0] as { value: string } | undefined)?.value ?? "";
    ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", "synthesis_data", ready);

    // 營運開關：openData / status / allowSubmissions 不得清掉報告
    expect((await conv.updateSettings(token, { openData: true })).ok).toBe(true);
    expect(readMeta("synthesis_data")).toBe(ready);
    expect((await conv.updateSettings(token, { status: "closed", allowSubmissions: false })).ok).toBe(true);
    expect(readMeta("synthesis_data")).toBe(ready);
    // 同值標題（no-op）也不清
    expect((await conv.updateSettings(token, { title: "標題" })).ok).toBe(true);
    expect(readMeta("synthesis_data")).toBe(ready);
    // 說明變更才失效
    expect((await conv.updateSettings(token, { description: "新說明" })).ok).toBe(true);
    expect(readMeta("synthesis_data")).toBe("");
  });

  it("a job superseded while the model call is in flight is discarded and does not clobber the newer pending state", async () => {
    const { ctx } = convCtx();
    const coord = makeCoordinator();
    const readMeta = (key: string) =>
      (ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0] as { value: string } | undefined)?.value ?? "";
    const replacePending = () =>
      ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        "synthesis_pending",
        JSON.stringify({ jobId: "job-newer", sourceRevision: 42, startedAt: 5000 }),
      );
    // ready 路徑：AI 呼叫期間 pending 被替換
    {
      const inner = topicAi();
      const aiRun = vi.fn(async (model: string, payload: any) => {
        replacePending();
        return inner(model, payload);
      });
      const conv = new Conversation(ctx, {
        AI: { run: aiRun },
        NEURON_COORDINATOR: { getByName: () => coord },
      } as any);
      seedSynthesisReady(conv, ctx, 1000);
      await conv.processSensemakingJob(42, "job-1", 1000);
      expect(aiRun.mock.calls.length).toBeGreaterThan(0);
      expect(readMeta("synthesis_data")).toBe("");
      expect(JSON.parse(readMeta("synthesis_pending")).jobId).toBe("job-newer");
    }
    // deterministic fallback 路徑：AI 拋錯前 pending 已被替換
    {
      const { ctx: ctx2 } = convCtx();
      const readMeta2 = (key: string) =>
        (ctx2.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0] as { value: string } | undefined)?.value ?? "";
      const aiRun = vi.fn(async () => {
        ctx2.storage.sql.exec(
          "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
          "synthesis_pending",
          JSON.stringify({ jobId: "job-newer", sourceRevision: 42, startedAt: 5000 }),
        );
        throw new Error("boom");
      });
      const conv = new Conversation(ctx2, {
        AI: { run: aiRun },
        NEURON_COORDINATOR: { getByName: () => makeCoordinator() },
      } as any);
      seedSynthesisReady(conv, ctx2, 1000);
      await conv.processSensemakingJob(42, "job-1", 1000);
      expect(readMeta2("synthesis_data")).toBe("");
      expect(JSON.parse(readMeta2("synthesis_pending")).jobId).toBe("job-newer");
    }
  });

  it("persisted claim survives a simulated process restart inside 24h", async () => {
    const { ctx } = convCtx();
    const aiRun = topicAi();
    const conv = new Conversation(ctx, {
      AI: { run: aiRun },
      NEURON_COORDINATOR: { getByName: () => makeCoordinator() },
    } as any);
    seedSynthesisReady(conv, ctx, 1000);
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      SYNTHESIS_AI_CLAIM_KEY,
      JSON.stringify({ claimedAt: 1000 }),
    );
    await conv.processSensemakingJob(42, "job-1", 1000 + 60_000);
    expect(aiRun).not.toHaveBeenCalled();
    const data = JSON.parse(
      (ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", "synthesis_data").one() as { value: string }).value,
    );
    expect(data.model).toBe(DETERMINISTIC_MODEL);
    expect(data.status).toBe("ready");
  });

  it("after >=24h exactly one new AI attempt is allowed", async () => {
    const { ctx } = convCtx();
    const coord = makeCoordinator();
    const aiRun = topicAi();
    const conv = new Conversation(ctx, {
      AI: { run: aiRun },
      NEURON_COORDINATOR: { getByName: () => coord },
    } as any);
    seedSynthesisReady(conv, ctx, 1000);
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      SYNTHESIS_AI_CLAIM_KEY,
      JSON.stringify({ claimedAt: 1000 }),
    );
    const later = 1000 + AI_ATTEMPT_WINDOW_MS + 1;
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "synthesis_pending",
      JSON.stringify({ jobId: "job-1", sourceRevision: 42, startedAt: later }),
    );
    await conv.processSensemakingJob(42, "job-1", later);
    expect(aiRun.mock.calls.length).toBeGreaterThan(0);
    const calls = aiRun.mock.calls.length;
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "synthesis_pending",
      JSON.stringify({ jobId: "job-4", sourceRevision: 42, startedAt: later + 10 }),
    );
    await conv.processSensemakingJob(42, "job-4", later + 10);
    expect(aiRun.mock.calls.length).toBe(calls);
  });

  it("missing AI binding persists deterministic ready without unavailable", async () => {
    const { ctx } = convCtx();
    const conv = new Conversation(ctx, {} as any);
    seedSynthesisReady(conv, ctx, 1000);
    const result = await conv.processSensemakingJob(42, "job-1", 1000);
    expect(result.ok).toBe(true);
    const data = JSON.parse(
      (ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", "synthesis_data").one() as { value: string }).value,
    );
    expect(data.status).toBe("ready");
    expect(data.model).toBe(DETERMINISTIC_MODEL);
  });

  it("missing coordinator means zero AI calls and a deterministic report", async () => {
    const { ctx } = convCtx();
    const aiRun = topicAi();
    const conv = new Conversation(ctx, { AI: { run: aiRun } } as any);
    seedSynthesisReady(conv, ctx, 1000);
    await conv.processSensemakingJob(42, "job-1", 1000);
    expect(aiRun).not.toHaveBeenCalled();
    const data = JSON.parse(
      (ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", "synthesis_data").one() as { value: string }).value,
    );
    expect(data.model).toBe(DETERMINISTIC_MODEL);
  });

  it("malformed claim fails closed without AI", async () => {
    const { ctx } = convCtx();
    const aiRun = topicAi();
    const conv = new Conversation(ctx, {
      AI: { run: aiRun },
      NEURON_COORDINATOR: { getByName: () => makeCoordinator() },
    } as any);
    seedSynthesisReady(conv, ctx, 1000);
    ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", SYNTHESIS_AI_CLAIM_KEY, "{");
    await conv.processSensemakingJob(42, "job-1", 1000);
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("GET/check with an in-window claim does not enqueue", async () => {
    const { ctx } = convCtx();
    const conv = new Conversation(ctx, {} as any);
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      "settings",
      JSON.stringify({ title: "標題", description: "說明", autoApprove: true }),
    );
    const mathResult = {
      computedAt: 42,
      k: 2,
      nParticipantsClustered: 10,
      nParticipantsTotal: 10,
      nVotes: 50,
      statementStats: [],
      consensus: { agree: [], disagree: [] },
      groups: [
        { id: 0, label: "A", size: 5, representative: [], statementStats: [] },
        { id: 1, label: "B", size: 5, representative: [], statementStats: [] },
      ],
    };
    vi.spyOn(conv as any, "getResults").mockResolvedValue({ result: mathResult, you: null });
    vi.spyOn(conv as any, "computeResults").mockReturnValue({ result: mathResult, you: null });
    vi.spyOn(conv, "publicStatements").mockResolvedValue({
      statements: [{ sid: 1, text: "s1" }, { sid: 2, text: "s2" }, { sid: 3, text: "s3" }],
    });
    ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      SYNTHESIS_AI_CLAIM_KEY,
      JSON.stringify({ claimedAt: 1000 }),
    );
    const res = await conv.checkOrStartSynthesis("conv123456", 2000);
    expect(res.needsEnqueue).toBeUndefined();
    expect(res.response.status).toBe("ready");
    if (res.response.status === "ready") {
      expect(res.response.model).toBe(DETERMINISTIC_MODEL);
    }
  });

  it("two conversations share the deployment-wide 9000 cap", async () => {
    const coord = makeCoordinator();
    expect(await coord.reserve(5000)).toBe(true);
    const { ctx } = convCtx();
    const aiRun = topicAi();
    const conv = new Conversation(ctx, {
      AI: { run: aiRun },
      NEURON_COORDINATOR: { getByName: () => coord },
    } as any);
    seedSynthesisReady(conv, ctx, 1000);
    await coord.reserve(4000);
    await conv.processSensemakingJob(42, "job-1", 1000);
    expect(aiRun).not.toHaveBeenCalled();
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
    const infoReq = new Request("https://example.com/api/conversations/testconv01");
    const infoRes = await worker.fetch(infoReq, envMock, ctx);
    expect(infoRes.headers.get("Cache-Control")).toContain("max-age=10");
    expect(cacheMatchSpy).toHaveBeenCalled();
    expect(cachePutSpy).toHaveBeenCalled();

    cacheMatchSpy.mockClear();
    cachePutSpy.mockClear();

    // 2. /synthesis 帶有任意 query 參數 (例如 ?lang=en&ref=share) -> 快取 key 移除所有 query
    const synthReq = new Request("https://example.com/api/conversations/testconv01/synthesis?lang=en&ref=share");
    const synthRes = await worker.fetch(synthReq, envMock, ctx);
    expect(synthRes.headers.get("Cache-Control")).toContain("max-age=300");

    const matchedReq = cacheMatchSpy.mock.calls[0][0] as Request;
    expect(matchedReq.url).toBe("https://example.com/api/conversations/testconv01/synthesis");
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

    const req = new Request("https://example.com/api/conversations/testconv01");
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

    const req = new Request("https://example.com/api/conversations/testconv01", {
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

    const unknownReq = new Request("https://example.com/api/unknown-endpoint");
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
    const req404 = new Request("https://example.com/c/notanactualid123");
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
      "https://example.com/api/conversations/testconv01/results?pid=00000000-0000-0000-0000-000000000001",
    );
    const pidRes = await worker.fetch(pidReq, envMock, ctx);
    expect(pidRes.headers.get("Cache-Control")).toContain("no-store");
    expect(cacheMatchSpy).not.toHaveBeenCalled();
    expect(cachePutSpy).not.toHaveBeenCalled();

    // 2. 帶 Authorization -> no match, no put
    cacheMatchSpy.mockClear();
    cachePutSpy.mockClear();
    const authReq = new Request("https://example.com/api/conversations/testconv01/admin", {
      headers: { Authorization: "Bearer 00000000000000000000000000000000" },
    });
    await worker.fetch(authReq, envMock, ctx);
    expect(cacheMatchSpy).not.toHaveBeenCalled();
    expect(cachePutSpy).not.toHaveBeenCalled();

    // 3. 管理頁面 /a/testconv01 -> no match, no put
    cacheMatchSpy.mockClear();
    cachePutSpy.mockClear();
    const adminPageReq = new Request("https://example.com/a/testconv01");
    await worker.fetch(adminPageReq, envMock, ctx);
    expect(cacheMatchSpy).not.toHaveBeenCalled();
    expect(cachePutSpy).not.toHaveBeenCalled();

    // 4. 資料匯出 /export/votes.csv -> no match, no put
    cacheMatchSpy.mockClear();
    cachePutSpy.mockClear();
    const exportReq = new Request("https://example.com/api/conversations/testconv01/export/votes.csv");
    await worker.fetch(exportReq, envMock, ctx);
    expect(cacheMatchSpy).not.toHaveBeenCalled();
    expect(cachePutSpy).not.toHaveBeenCalled();

    // 5. POST /votes -> no match, no put
    cacheMatchSpy.mockClear();
    cachePutSpy.mockClear();
    const voteReq = new Request("https://example.com/api/conversations/testconv01/votes", {
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
    const headReq = new Request("https://example.com/api/conversations/testconv01", { method: "HEAD" });
    await worker.fetch(headReq, envMock, ctx);
    expect(cacheMatchSpy).not.toHaveBeenCalled();
    expect(cachePutSpy).not.toHaveBeenCalled();
  });

  it("Request 帶有大小寫混合之 Cache-Control (例如 No-Cache, NO-STORE, max-age=0) 均正確略過快取直通 DO", async () => {
    const stubMock = {
      isConversation: vi.fn().mockResolvedValue(true),
      publicInfo: vi.fn().mockResolvedValue({ id: "testconv01", title: "Fresh Title" }),
    };
    const envMock = {
      CONVERSATION: { getByName: vi.fn().mockReturnValue(stubMock) },
    } as any;
    const ctx = { waitUntil: (p: Promise<unknown>) => p } as any;

    for (const headerVal of ["No-Cache", "NO-STORE", "Max-Age=0", "no-cache, no-store"]) {
      cacheMatchSpy.mockClear();
      cachePutSpy.mockClear();
      stubMock.publicInfo.mockClear();

      const req = new Request("https://example.com/api/conversations/testconv01", {
        headers: { "Cache-Control": headerVal },
      });
      const res = await worker.fetch(req, envMock, ctx);
      expect(res.status).toBe(200);
      expect(cacheMatchSpy).not.toHaveBeenCalled();
      expect(cachePutSpy).not.toHaveBeenCalled();
      expect(stubMock.publicInfo).toHaveBeenCalled();
    }
  });
});
