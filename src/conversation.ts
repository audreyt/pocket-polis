import { DurableObject } from "cloudflare:workers";
import { computeMath } from "./math/pipeline";
import { csvEscape, formatCommentsCsv } from "./export";
import type { MathResult, OpinionPoint, VoteRow, VoteValue } from "./math/types";

export interface ConversationSettings {
  title: string;
  description: string;
  autoApprove: boolean;
  allowSubmissions: boolean;
  openData: boolean;
  status: "open" | "closed";
  /** 另一語言版本的連結（選填；顯示在參與與結果頁的切換橫幅） */
  altUrl?: string;
}

export interface PublicInfo {
  id: string;
  title: string;
  description: string;
  status: "open" | "closed";
  allowSubmissions: boolean;
  autoApprove: boolean;
  openData: boolean;
  altUrl: string;
  counts: { statements: number; participants: number; votes: number };
  createdAt: number;
}

export interface StatementView {
  sid: number;
  text: string;
  status: string;
  isSeed: boolean;
  agrees: number;
  disagrees: number;
  passes: number;
  createdAt: number;
}

export interface NextStatement {
  statement: { sid: number; text: string } | null;
  progress: { voted: number; total: number };
}

const MAX_STATEMENTS = 800;
const MAX_STATEMENT_LENGTH = 280;

// ---- 免費額度友善的節流參數 ----
// （Cloudflare 免費方案：每天 10 萬請求、SQLite 讀 500 萬列／寫 10 萬列。
//   投票表的統計一律走 statements 上的反正規化計數欄，不掃 votes 表。）
// 數學重算的最小間隔：隨票數放大（1 萬票 → 12 秒），上限 15 秒
const mathMinIntervalMs = (nVotes: number) => Math.min(15000, Math.max(2000, 2000 + nVotes));
// 快取超過這個年紀就做一次便宜的新鮮度探測（比對計數欄總和）
const MATH_PROBE_AGE_MS = 30000;
// revision 至多每 5 秒落盤一次（DO 存活期間靠記憶體 dirty 旗標）
const REVISION_PERSIST_INTERVAL_MS = 5000;
// 參與者 last_seen 至多每 5 分鐘寫一次
const PARTICIPANT_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const CREATE_PER_HOUR = 10;
const CREATE_PER_DAY = 50;

interface MathCache {
  revision: number;
  publicResult: MathResult;
  pidPoints: Record<string, OpinionPoint>;
}

export class Conversation extends DurableObject<Env> {
  private migrated = false;
  /** DO 存活期間的髒旗標（有投票/審核變動、尚未重算） */
  private dirty = false;
  private lastRevisionPersistAt = 0;
  /** pid → 上次 touch 時間（省去重複的 participants 讀寫） */
  private touchCache = new Map<string, number>();

  private sql() {
    this.migrate();
    return this.ctx.storage.sql;
  }

  private migrate(): void {
    if (this.migrated) return;
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS _sql_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
    );
    const applied = new Set(
      sql
        .exec(`SELECT version FROM _sql_schema_migrations`)
        .toArray()
        .map((r) => r.version as number),
    );
    const migrations: string[][] = [
      [
        `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
        `CREATE TABLE statements (
           sid INTEGER PRIMARY KEY AUTOINCREMENT,
           text TEXT NOT NULL,
           submitter_pid TEXT,
           status TEXT NOT NULL DEFAULT 'pending',
           is_seed INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL
         )`,
        `CREATE TABLE votes (
           pid TEXT NOT NULL,
           sid INTEGER NOT NULL,
           value INTEGER NOT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY (pid, sid)
         )`,
        `CREATE TABLE participants (
           pid TEXT PRIMARY KEY,
           seq INTEGER NOT NULL,
           created_at INTEGER NOT NULL,
           last_seen INTEGER NOT NULL
         )`,
        `CREATE INDEX idx_votes_sid ON votes(sid)`,
        `CREATE INDEX idx_statements_status ON statements(status)`,
        `CREATE TABLE creation_log (ts INTEGER NOT NULL)`,
      ],
      // v2：statements 反正規化計數欄 + participantCount 計數器（省 rows read）
      [
        `ALTER TABLE statements ADD COLUMN agrees INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE statements ADD COLUMN disagrees INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE statements ADD COLUMN passes INTEGER NOT NULL DEFAULT 0`,
        `UPDATE statements SET
           agrees = (SELECT COUNT(*) FROM votes v WHERE v.sid = statements.sid AND v.value = 1),
           disagrees = (SELECT COUNT(*) FROM votes v WHERE v.sid = statements.sid AND v.value = -1),
           passes = (SELECT COUNT(*) FROM votes v WHERE v.sid = statements.sid AND v.value = 0)`,
        // SELECT 後帶 WHERE 是 SQLite 對 INSERT…SELECT…ON CONFLICT 的解析要求
        `INSERT INTO meta (key, value)
           SELECT 'participantCount', CAST(COUNT(*) AS TEXT) FROM participants WHERE 1
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ],
    ];
    for (let v = 1; v <= migrations.length; v++) {
      if (applied.has(v)) continue;
      // 整個版本包成一筆交易：任何一句失敗就整包回滾，不會留下半套 schema
      this.ctx.storage.transactionSync(() => {
        for (const stmt of migrations[v - 1]!) sql.exec(stmt);
        sql.exec(`INSERT INTO _sql_schema_migrations (version, applied_at) VALUES (?, ?)`, v, Date.now());
      });
    }
    this.migrated = true;
  }

  // ---- meta helpers ----

  private getMeta(key: string): string | null {
    const rows = this.sql().exec(`SELECT value FROM meta WHERE key = ?`, key).toArray();
    return rows.length > 0 ? (rows[0]!.value as string) : null;
  }

  private setMeta(key: string, value: string): void {
    this.sql().exec(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private settings(): ConversationSettings | null {
    const raw = this.getMeta("settings");
    return raw ? (JSON.parse(raw) as ConversationSettings) : null;
  }

  private revision(): number {
    return Number(this.getMeta("revision") ?? "0");
  }

  /** 記憶體 dirty 旗標 + 節流的 revision 落盤（DO 重啟後靠它補救） */
  private markDirty(now: number): void {
    this.dirty = true;
    if (now - this.lastRevisionPersistAt > REVISION_PERSIST_INTERVAL_MS) {
      this.setMeta("revision", String(this.revision() + 1));
      this.lastRevisionPersistAt = now;
    }
  }

  // ---- lifecycle ----

  async initConversation(
    id: string,
    settings: ConversationSettings,
    seedStatements: string[],
    adminTokenHash: string,
    now: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.getMeta("id") !== null) return { ok: false, error: "already initialized" };
    this.setMeta("id", id);
    this.setMeta("settings", JSON.stringify(settings));
    this.setMeta("adminTokenHash", adminTokenHash);
    this.setMeta("createdAt", String(now));
    this.setMeta("revision", "0");
    this.setMeta("participantCount", "0");
    for (const text of seedStatements) {
      const trimmed = text.trim().slice(0, MAX_STATEMENT_LENGTH);
      if (!trimmed) continue;
      this.sql().exec(
        `INSERT INTO statements (text, submitter_pid, status, is_seed, created_at) VALUES (?, NULL, 'approved', 1, ?)`,
        trimmed,
        now,
      );
    }
    this.markDirty(now);
    return { ok: true };
  }

  async isConversation(): Promise<boolean> {
    return this.getMeta("id") !== null;
  }

  async publicInfo(): Promise<PublicInfo | null> {
    const id = this.getMeta("id");
    const settings = this.settings();
    if (!id || !settings) return null;
    const counts = this.sql()
      .exec(
        `SELECT COUNT(*) AS n, COALESCE(SUM(agrees + disagrees + passes), 0) AS v
         FROM statements WHERE status = 'approved'`,
      )
      .one();
    return {
      id,
      title: settings.title,
      description: settings.description,
      status: settings.status,
      allowSubmissions: settings.allowSubmissions,
      autoApprove: settings.autoApprove,
      openData: settings.openData,
      altUrl: settings.altUrl ?? "",
      counts: {
        statements: Number(counts.n),
        participants: Number(this.getMeta("participantCount") ?? "0"),
        votes: Number(counts.v),
      },
      createdAt: Number(this.getMeta("createdAt") ?? "0"),
    };
  }

  private touchParticipant(pid: string, now: number): void {
    const cached = this.touchCache.get(pid);
    if (cached !== undefined && now - cached < PARTICIPANT_TOUCH_INTERVAL_MS) return;
    const rows = this.sql().exec(`SELECT last_seen FROM participants WHERE pid = ?`, pid).toArray();
    if (rows.length === 0) {
      const seq = Number(this.getMeta("participantCount") ?? "0") + 1;
      this.sql().exec(
        `INSERT INTO participants (pid, seq, created_at, last_seen) VALUES (?, ?, ?, ?)`,
        pid,
        seq,
        now,
        now,
      );
      this.setMeta("participantCount", String(seq));
    } else if (now - Number(rows[0]!.last_seen) > PARTICIPANT_TOUCH_INTERVAL_MS) {
      this.sql().exec(`UPDATE participants SET last_seen = ? WHERE pid = ?`, now, pid);
    }
    this.touchCache.set(pid, now);
  }

  // ---- participation ----

  async nextStatement(pid: string, now: number): Promise<NextStatement> {
    this.touchParticipant(pid, now);
    return this.pickNext(pid);
  }

  /** 抽下一句：只讀 statements（含反正規化票數）與該參與者自己的投票 */
  private pickNext(pid: string): NextStatement {
    const rows = this.sql()
      .exec(
        `SELECT sid, text, (agrees + disagrees + passes) AS vc
         FROM statements
         WHERE status = 'approved'
           AND sid NOT IN (SELECT sid FROM votes WHERE pid = ?)`,
        pid,
      )
      .toArray();
    const progress = this.progress(pid);
    if (rows.length === 0) return { statement: null, progress };
    // 票數較少的意見優先被抽到（加速冷啟動的資料蒐集），加權隨機
    const weights = rows.map((r) => 1 / (1 + Number(r.vc)));
    const total = weights.reduce((a, b) => a + b, 0);
    let t = Math.random() * total;
    let picked = rows[0]!;
    for (let i = 0; i < rows.length; i++) {
      t -= weights[i]!;
      if (t <= 0) {
        picked = rows[i]!;
        break;
      }
    }
    return {
      statement: { sid: Number(picked.sid), text: String(picked.text) },
      progress,
    };
  }

  private progress(pid: string): { voted: number; total: number } {
    const row = this.sql()
      .exec(
        `SELECT
           (SELECT COUNT(*) FROM votes v JOIN statements s ON s.sid = v.sid
             WHERE v.pid = ? AND s.status = 'approved') AS voted,
           (SELECT COUNT(*) FROM statements WHERE status = 'approved') AS total`,
        pid,
      )
      .one();
    return { voted: Number(row.voted), total: Number(row.total) };
  }

  async castVote(
    pid: string,
    sid: number,
    value: VoteValue,
    now: number,
  ): Promise<
    | { ok: true; progress: { voted: number; total: number }; next: NextStatement["statement"] }
    | { ok: false; error: string }
  > {
    const settings = this.settings();
    if (!settings) return { ok: false, error: "not found" };
    if (settings.status !== "open") return { ok: false, error: "conversation closed" };
    const stmt = this.sql().exec(`SELECT status FROM statements WHERE sid = ?`, sid).toArray();
    if (stmt.length === 0 || stmt[0]!.status !== "approved") {
      return { ok: false, error: "statement not available" };
    }
    this.touchParticipant(pid, now);

    const prevRows = this.sql().exec(`SELECT value FROM votes WHERE pid = ? AND sid = ?`, pid, sid).toArray();
    const prev = prevRows.length > 0 ? (Number(prevRows[0]!.value) as VoteValue) : null;

    if (prev !== value) {
      this.sql().exec(
        `INSERT INTO votes (pid, sid, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pid, sid) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        pid,
        sid,
        value,
        now,
        now,
      );
      // 反正規化計數欄：新票 +1；改票則舊方向 -1、新方向 +1
      const delta = { agrees: 0, disagrees: 0, passes: 0 };
      const col = (v: VoteValue) => (v === 1 ? "agrees" : v === -1 ? "disagrees" : "passes");
      delta[col(value)] += 1;
      if (prev !== null) delta[col(prev)] -= 1;
      this.sql().exec(
        `UPDATE statements SET agrees = agrees + ?, disagrees = disagrees + ?, passes = passes + ? WHERE sid = ?`,
        delta.agrees,
        delta.disagrees,
        delta.passes,
        sid,
      );
      this.markDirty(now);
    }

    // 一併回傳下一句，參與流程從「抽題+投票」兩個請求減為一個
    const next = this.pickNext(pid);
    return { ok: true, progress: next.progress, next: next.statement };
  }

  async submitStatement(
    pid: string,
    text: string,
    now: number,
  ): Promise<{ ok: true; status: "approved" | "pending" } | { ok: false; error: string }> {
    const settings = this.settings();
    if (!settings) return { ok: false, error: "not found" };
    if (settings.status !== "open") return { ok: false, error: "conversation closed" };
    if (!settings.allowSubmissions) return { ok: false, error: "submissions disabled" };
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "empty statement" };
    if (trimmed.length > MAX_STATEMENT_LENGTH) {
      return { ok: false, error: `statement too long (max ${MAX_STATEMENT_LENGTH})` };
    }
    const count = Number(this.sql().exec(`SELECT COUNT(*) AS n FROM statements`).one().n);
    if (count >= MAX_STATEMENTS) return { ok: false, error: "statement limit reached" };
    this.touchParticipant(pid, now);
    const status = settings.autoApprove ? "approved" : "pending";
    this.sql().exec(
      `INSERT INTO statements (text, submitter_pid, status, is_seed, created_at) VALUES (?, ?, ?, 0, ?)`,
      trimmed,
      pid,
      status,
    now,
    );
    if (status === "approved") this.markDirty(now);
    return { ok: true, status };
  }

  // ---- results ----

  async getResults(
    pid: string | null,
    now: number,
  ): Promise<{ result: MathResult; you: OpinionPoint | null } | null> {
    const id = this.getMeta("id");
    if (!id) return null;
    const cache = this.readMathCache();
    let fresh = cache;
    let stale = !cache || this.dirty || cache.revision !== this.revision();

    // DO 重啟後 dirty 旗標會歸零：老快取用計數欄總和做一次便宜的新鮮度探測
    if (!stale && cache && now - cache.publicResult.computedAt > MATH_PROBE_AGE_MS) {
      const liveVotes = Number(
        this.sql()
          .exec(
            `SELECT COALESCE(SUM(agrees + disagrees + passes), 0) AS v FROM statements WHERE status = 'approved'`,
          )
          .one().v,
      );
      if (liveVotes !== cache.publicResult.nVotes) stale = true;
    }

    if (stale) {
      const lastAt = Number(this.getMeta("mathComputedAt") ?? "0");
      const minInterval = mathMinIntervalMs(cache?.publicResult.nVotes ?? 0);
      if (cache && now - lastAt < minInterval) {
        fresh = cache; // 剛算過：先回稍舊的結果，避免重算風暴
      } else {
        fresh = this.recompute(id, now);
      }
    }
    return {
      result: fresh!.publicResult,
      you: pid ? (fresh!.pidPoints[pid] ?? null) : null,
    };
  }

  private readMathCache(): MathCache | null {
    const raw = this.getMeta("mathCache");
    return raw ? (JSON.parse(raw) as MathCache) : null;
  }

  private recompute(id: string, now: number): MathCache {
    const previousK = this.readMathCache()?.publicResult.k ?? null;
    const statementIds = this.sql()
      .exec(`SELECT sid FROM statements WHERE status = 'approved' ORDER BY sid`)
      .toArray()
      .map((r) => Number(r.sid));
    const votes: VoteRow[] = this.sql()
      .exec(
        `SELECT v.pid, v.sid, v.value FROM votes v JOIN statements s ON s.sid = v.sid
         WHERE s.status = 'approved'`,
      )
      .toArray()
      .map((r) => ({ pid: String(r.pid), sid: Number(r.sid), value: Number(r.value) as VoteValue }));
    const { publicResult, pidPoints } = computeMath({
      conversationId: id,
      votes,
      statementIds,
      computedAt: now,
      previousK: previousK && previousK >= 2 ? previousK : null,
    });
    const cache: MathCache = { revision: this.revision(), publicResult, pidPoints };
    this.setMeta("mathCache", JSON.stringify(cache));
    this.setMeta("mathComputedAt", String(now));
    this.dirty = false;
    return cache;
  }

  // ---- admin ----

  private async verifyAdmin(token: string): Promise<boolean> {
    const expected = this.getMeta("adminTokenHash");
    if (!expected || !token) return false;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const actual = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  }

  /** 只讀 statements（計數欄反正規化，不掃 votes） */
  private listStatements(includeAll: boolean): StatementView[] {
    const where = includeAll ? "" : `WHERE status = 'approved'`;
    return this.sql()
      .exec(
        `SELECT sid, text, status, is_seed, created_at, agrees, disagrees, passes
         FROM statements ${where} ORDER BY sid`,
      )
      .toArray()
      .map((r) => ({
        sid: Number(r.sid),
        text: String(r.text),
        status: String(r.status),
        isSeed: Number(r.is_seed) === 1,
        agrees: Number(r.agrees),
        disagrees: Number(r.disagrees),
        passes: Number(r.passes),
        createdAt: Number(r.created_at),
      }));
  }

  /** 結果頁用：已核准意見的文字（不含統計，統計在 math result 裡） */
  async publicStatements(): Promise<{ statements: { sid: number; text: string }[] }> {
    const rows = this.sql()
      .exec(`SELECT sid, text FROM statements WHERE status = 'approved' ORDER BY sid`)
      .toArray();
    return { statements: rows.map((r) => ({ sid: Number(r.sid), text: String(r.text) })) };
  }

  async adminOverview(
    token: string,
  ): Promise<{ settings: ConversationSettings; statements: StatementView[] } | { error: string }> {
    if (!(await this.verifyAdmin(token))) return { error: "unauthorized" };
    return { settings: this.settings()!, statements: this.listStatements(true) };
  }

  async moderateStatement(
    token: string,
    sid: number,
    action: "approve" | "reject",
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!(await this.verifyAdmin(token))) return { ok: false, error: "unauthorized" };
    const rows = this.sql().exec(`SELECT status FROM statements WHERE sid = ?`, sid).toArray();
    if (rows.length === 0) return { ok: false, error: "not found" };
    const status = action === "approve" ? "approved" : "rejected";
    this.sql().exec(`UPDATE statements SET status = ? WHERE sid = ?`, status, sid);
    this.markDirty(Date.now());
    return { ok: true };
  }

  async addSeedStatement(
    token: string,
    text: string,
    now: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!(await this.verifyAdmin(token))) return { ok: false, error: "unauthorized" };
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_STATEMENT_LENGTH) {
      return { ok: false, error: "invalid statement" };
    }
    this.sql().exec(
      `INSERT INTO statements (text, submitter_pid, status, is_seed, created_at) VALUES (?, NULL, 'approved', 1, ?)`,
      trimmed,
      now,
    );
    this.markDirty(now);
    return { ok: true };
  }

  async updateSettings(
    token: string,
    patch: Partial<ConversationSettings>,
  ): Promise<{ ok: true; settings: ConversationSettings } | { ok: false; error: string }> {
    if (!(await this.verifyAdmin(token))) return { ok: false, error: "unauthorized" };
    const current = this.settings()!;
    const next: ConversationSettings = {
      title: typeof patch.title === "string" && patch.title.trim() ? patch.title.trim().slice(0, 120) : current.title,
      description:
        typeof patch.description === "string" ? patch.description.trim().slice(0, 2000) : current.description,
      autoApprove: typeof patch.autoApprove === "boolean" ? patch.autoApprove : current.autoApprove,
      allowSubmissions:
        typeof patch.allowSubmissions === "boolean" ? patch.allowSubmissions : current.allowSubmissions,
      openData: typeof patch.openData === "boolean" ? patch.openData : current.openData,
      status: patch.status === "open" || patch.status === "closed" ? patch.status : current.status,
      altUrl: typeof patch.altUrl === "string" ? sanitizeAltUrl(patch.altUrl) : current.altUrl,
    };
    this.setMeta("settings", JSON.stringify(next));
    return { ok: true, settings: next };
  }

  // ---- data export ----

  private async canExport(token: string | null): Promise<boolean> {
    const settings = this.settings();
    if (!settings) return false;
    if (settings.openData) return true;
    return token !== null && (await this.verifyAdmin(token));
  }

  async exportStatementsCsv(token: string | null): Promise<string | null> {
    if (!(await this.canExport(token))) return null;
    const rows = this.listStatements(true);
    const header = "statement_id,text,status,is_seed,agrees,disagrees,passes,created_at";
    const lines = rows.map((r) =>
      [r.sid, csvEscape(r.text), r.status, r.isSeed ? 1 : 0, r.agrees, r.disagrees, r.passes, new Date(r.createdAt).toISOString()].join(","),
    );
    return [header, ...lines].join("\n") + "\n";
  }

  /**
   * pol.is 相容的 comments.csv（issue #1，供 Sensemaker 等工具直接讀取）。
   * author-id 用參與者加入順序流水號（同 votes.csv 的 p1、p2⋯ 去掉前綴），種子意見（主持人建立）為 0；
   * 含全部審核狀態，以 moderated 欄區分（1 / 0 / -1），與 statements.csv 一致。
   */
  async exportCommentsCsv(token: string | null): Promise<string | null> {
    if (!(await this.canExport(token))) return null;
    const rows = this.sql()
      .exec(
        `SELECT s.sid, s.text, s.status, s.created_at, s.agrees, s.disagrees, COALESCE(p.seq, 0) AS author
         FROM statements s LEFT JOIN participants p ON p.pid = s.submitter_pid
         ORDER BY s.sid`,
      )
      .toArray()
      .map((r) => ({
        sid: Number(r.sid),
        text: String(r.text),
        status: String(r.status),
        authorId: Number(r.author),
        agrees: Number(r.agrees),
        disagrees: Number(r.disagrees),
        createdAt: Number(r.created_at),
      }));
    return formatCommentsCsv(rows);
  }

  /** 長格式投票匯出。參與者以加入順序匿名化為 p1、p2⋯，不輸出 pid。 */
  async exportVotesCsv(token: string | null): Promise<string | null> {
    if (!(await this.canExport(token))) return null;
    const rows = this.sql()
      .exec(
        `SELECT p.seq, v.sid, v.value, v.updated_at FROM votes v
         JOIN participants p ON p.pid = v.pid
         ORDER BY p.seq, v.sid`,
      )
      .toArray();
    const header = "participant,statement_id,vote,updated_at";
    const lines = rows.map((r) =>
      [`p${Number(r.seq)}`, Number(r.sid), Number(r.value), new Date(Number(r.updated_at)).toISOString()].join(","),
    );
    return [header, ...lines].join("\n") + "\n";
  }

  // ---- 全站建立頻率限制（singleton DO，getByName("creation-limiter")） ----

  async reserveCreation(now: number): Promise<{ ok: boolean; error?: string }> {
    const hourAgo = now - 60 * 60 * 1000;
    const dayAgo = now - 24 * 60 * 60 * 1000;
    this.sql().exec(`DELETE FROM creation_log WHERE ts < ?`, dayAgo);
    const lastHour = Number(
      this.sql().exec(`SELECT COUNT(*) AS n FROM creation_log WHERE ts >= ?`, hourAgo).one().n,
    );
    const lastDay = Number(this.sql().exec(`SELECT COUNT(*) AS n FROM creation_log`).one().n);
    if (lastHour >= CREATE_PER_HOUR || lastDay >= CREATE_PER_DAY) {
      return { ok: false, error: "creation rate limit reached, try again later" };
    }
    this.sql().exec(`INSERT INTO creation_log (ts) VALUES (?)`, now);
    return { ok: true };
  }
}

/** 只接受 https:// 或站內相對路徑，其餘視為清空 */
function sanitizeAltUrl(raw: string): string {
  const trimmed = raw.trim().slice(0, 300);
  if (/^https:\/\/\S+$/.test(trimmed) || /^\/\S*$/.test(trimmed)) return trimmed;
  return "";
}
