import type { VoteRow, VoteValue } from "./types";

export interface VoteMatrix {
  /** 納入分群的參與者（投票數達門檻），順序即列順序 */
  pids: string[];
  /** 欄順序對應的 statement id */
  sids: number[];
  /** 原始投票（null = 未投） */
  raw: (VoteValue | null)[][];
  /** 各欄（陳述）在有投票者上的平均值 */
  colMeans: number[];
  /** 平均插補後再置中的稠密矩陣（插補值置中後為 0） */
  centered: Float64Array[];
  /** 各列的實際投票數 */
  voteCounts: number[];
}

/**
 * 官方 polis 要求參與者至少投 7 票才納入分群（陳述不足 7 則需全投）。
 */
export function inclusionThreshold(nStatements: number): number {
  return Math.max(1, Math.min(7, nStatements));
}

export function buildMatrix(votes: VoteRow[], sids: number[], minVotes: number): VoteMatrix {
  const colIndex = new Map<number, number>();
  sids.forEach((sid, i) => colIndex.set(sid, i));

  const byPid = new Map<string, Map<number, VoteValue>>();
  for (const v of votes) {
    const col = colIndex.get(v.sid);
    if (col === undefined) continue;
    let row = byPid.get(v.pid);
    if (!row) {
      row = new Map();
      byPid.set(v.pid, row);
    }
    row.set(col, v.value);
  }

  const pids: string[] = [];
  const raw: (VoteValue | null)[][] = [];
  const voteCounts: number[] = [];
  for (const [pid, row] of byPid) {
    if (row.size < minVotes) continue;
    pids.push(pid);
    const r: (VoteValue | null)[] = new Array(sids.length).fill(null);
    for (const [col, value] of row) r[col] = value;
    raw.push(r);
    voteCounts.push(row.size);
  }

  const colMeans = new Array<number>(sids.length).fill(0);
  for (let j = 0; j < sids.length; j++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i]![j] ?? null;
      if (v !== null) {
        sum += v;
        n++;
      }
    }
    colMeans[j] = n > 0 ? sum / n : 0;
  }

  const centered = raw.map((r) => {
    const out = new Float64Array(sids.length);
    for (let j = 0; j < sids.length; j++) {
      const v = r[j] ?? null;
      out[j] = v === null ? 0 : v - colMeans[j]!;
    }
    return out;
  });

  return { pids, sids, raw, colMeans, centered, voteCounts };
}
