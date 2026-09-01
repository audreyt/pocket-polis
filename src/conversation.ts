import { DurableObject } from "cloudflare:workers";
import { computeMath } from "./math/pipeline";
import type { MathResult, OpinionPoint, VoteRow, VoteValue } from "./math/types";

export interface ConversationSettings {
  title: string;
  description: string;
  autoApprove: boolean;
  allowSubmissions: boolean;
  openData: boolean;
  status: "open" | "closed";
}

export interface PublicInfo {
  id: string;
  title: string;
  description: string;
  status: "open" | "closed";
  allowSubmissions: boolean;
  autoApprove: boolean;
  openData: boolean;
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

const MAX_STATEMENTS = 800;
const MAX_STATEMENT_LENGTH = 280;
// 投票或陳述有變動時，最快每 2 秒重算一次數學結果；其餘時間先回快取
const MATH_MIN_INTERVAL_MS = 2000;

const CREATE_PER_HOUR = 10;
const CREATE_PER_DAY = 50;

interface MathCache {
  revision: number;
  publicResult: MathResult;
  pidPoints: Record<string, OpinionPoint>;
}

export class Conversation extends DurableObject<Env> {
  private migrated = false;

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
    ];
    for (let v = 1; v <= migrations.length; v++) {
      if (applied.has(v)) continue;
      for (const stmt of migrations[v - 1]!) sql.exec(stmt);
      sql.exec(`INSERT INTO _sql_schema_migrations (version, applied_at) VALUES (?, ?)`, v, Date.now());
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

  private bumpRevision(): void {
    const rev = Number(this.getMeta("revision") ?? "0") + 1;
    this.setMeta("revision", String(rev));
  }

  private revision(): number {
    return Number(this.getMeta("revision") ?? "0");
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
    for (const text of seedStatements) {
      const trimmed = text.trim().slice(0, MAX_STATEMENT_LENGTH);
      if (!trimmed) continue;
      this.sql().exec(
        `INSERT INTO statements (text, submitter_pid, status, is_seed, created_at) VALUES (?, NULL, 'approved', 1, ?)`,
        trimmed,
        now,
      );
    }
    this.bumpRevision();
    return { ok: true };
  }

  async isConversation(): Promise<boolean> {
    return this.getMeta("id") !== null;
  }

  async publicInfo(): Promise<PublicInfo | null> {
    const id = this.getMeta("id");
    const settings = this.settings();
    if (!id || !settings) return null;
    const one = (q: string) => Number(this.sql().exec(q).one().n);
    return {
      id,
      title: settings.title,
      description: settings.description,
      status: settings.status,
      allowSubmissions: settings.allowSubmissions,
      autoApprove: settings.autoApprove,
      openData: settings.openData,
      counts: {
        statements: one(`SELECT COUNT(*) AS n FROM statements WHERE status = 'approved'`),
        participants: one(`SELECT COUNT(*) AS n FROM participants`),
        votes: one(
          `SELECT COUNT(*) AS n FROM votes v JOIN statements s ON s.sid = v.sid WHERE s.status = 'approved'`,
        ),
      },
      createdAt: Number(this.getMeta("createdAt") ?? "0"),
    };
  }

  private touchParticipant(pid: string, now: number): void {
    const existing = this.sql().exec(`SELECT pid FROM participants WHERE pid = ?`, pid).toArray();
    if (existing.length > 0) {
      this.sql().exec(`UPDATE participants SET last_seen = ? WHERE pid = ?`, now, pid);
    } else {
      const seq = Number(this.sql().exec(`SELECT COUNT(*) AS n FROM participants`).one().n) + 1;
      this.sql().exec(
        `INSERT INTO participants (pid, seq, created_at, last_seen) VALUES (?, ?, ?, ?)`,
        pid,
        seq,
        now,
        now,
      );
    }
  }

  // ---- participation ----

  async nextStatement(
    pid: string,
    now: number,
  ): Promise<{ statement: { sid: number; text: string } | null; progress: { voted: number; total: number } }> {
    this.touchParticipant(pid, now);
    const rows = this.sql()
      .exec(
        `SELECT s.sid, s.text, (SELECT COUNT(*) FROM votes v WHERE v.sid = s.sid) AS vc
         FROM statements s
         WHERE s.status = 'approved'
           AND s.sid NOT IN (SELECT sid FROM votes WHERE pid = ?)`,
        pid,
      )
      .toArray();
    const progress = this.progress(pid);
    if (rows.length === 0) return { statement: null, progress };
    // 票數較少的陳述優先被抽到（加速冷啟動的資料蒐集），加權隨機
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
    const voted = Number(
      this.sql()
        .exec(
          `SELECT COUNT(*) AS n FROM votes v JOIN statements s ON s.sid = v.sid
           WHERE v.pid = ? AND s.status = 'approved'`,
          pid,
        )
        .one().n,
    );
    const total = Number(
      this.sql().exec(`SELECT COUNT(*) AS n FROM statements WHERE status = 'approved'`).one().n,
    );
    return { voted, total };
  }

  async castVote(
    pid: string,
    sid: number,
    value: VoteValue,
    now: number,
  ): Promise<{ ok: true; progress: { voted: number; total: number } } | { ok: false; error: string }> {
    const settings = this.settings();
    if (!settings) return { ok: false, error: "not found" };
    if (settings.status !== "open") return { ok: false, error: "conversation closed" };
    const stmt = this.sql()
      .exec(`SELECT status FROM statements WHERE sid = ?`, sid)
      .toArray();
    if (stmt.length === 0 || stmt[0]!.status !== "approved") {
      return { ok: false, error: "statement not available" };
    }
    this.touchParticipant(pid, now);
    this.sql().exec(
      `INSERT INTO votes (pid, sid, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(pid, sid) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      pid,
      sid,
      value,
      now,
      now,
    );
    this.bumpRevision();
    return { ok: true, progress: this.progress(pid) };
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
    if (status === "approved") this.bumpRevision();
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
    const rev = this.revision();
    let fresh = cache;
    if (!cache || cache.revision !== rev) {
      const lastAt = Number(this.getMeta("mathComputedAt") ?? "0");
      if (cache && now - lastAt < MATH_MIN_INTERVAL_MS) {
        fresh = cache; // 剛算過：先回稍舊的結果，避免重算風暴
      } else {
        fresh = this.recompute(id, rev, now);
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

  private recompute(id: string, revision: number, now: number): MathCache {
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
    const cache: MathCache = { revision, publicResult, pidPoints };
    this.setMeta("mathCache", JSON.stringify(cache));
    this.setMeta("mathComputedAt", String(now));
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

  private listStatements(includeAll: boolean): StatementView[] {
    const where = includeAll ? "" : `WHERE s.status = 'approved'`;
    return this.sql()
      .exec(
        `SELECT s.sid, s.text, s.status, s.is_seed, s.created_at,
                SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END) AS agrees,
                SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END) AS disagrees,
                SUM(CASE WHEN v.value = 0 THEN 1 ELSE 0 END) AS passes
         FROM statements s LEFT JOIN votes v ON v.sid = s.sid
         ${where}
         GROUP BY s.sid ORDER BY s.sid`,
      )
      .toArray()
      .map((r) => ({
        sid: Number(r.sid),
        text: String(r.text),
        status: String(r.status),
        isSeed: Number(r.is_seed) === 1,
        agrees: Number(r.agrees ?? 0),
        disagrees: Number(r.disagrees ?? 0),
        passes: Number(r.passes ?? 0),
        createdAt: Number(r.created_at),
      }));
  }

  /** 結果頁用：已核准陳述的文字（不含統計，統計在 math result 裡） */
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
    this.bumpRevision();
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
    this.bumpRevision();
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

function csvEscape(text: string): string {
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}
