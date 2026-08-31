import type { VoteMatrix } from "./matrix";
import type { ConsensusStatement, RepresentativeStatement } from "./types";

// 統計檢定門檻：90% 信賴（z > 1.2816），與官方 polis 相同。
export const Z_90 = 1.2816;

/**
 * 單比例檢定的 z 近似（官方 polismath stats 的 prop-test）：
 * 檢定「投此方向的機率是否顯著大於 0.5」，含 +1/+2 pseudocount。
 */
export function propTest(succ: number, seen: number): number {
  const n = Math.max(seen, 1);
  const p = (succ + 1) / (n + 2);
  return 2 * Math.sqrt(n) * (p - 0.5);
}

/**
 * 雙比例檢定的 z 近似（官方 polismath stats 的 two-prop-test）：
 * 檢定群內與群外投此方向的比例是否顯著不同。
 */
export function twoPropTest(
  succIn: number,
  seenIn: number,
  succOut: number,
  seenOut: number,
): number {
  const p1 = (succIn + 1) / (seenIn + 2);
  const p2 = (succOut + 1) / (seenOut + 2);
  const pHat = (succIn + succOut + 1) / (seenIn + seenOut + 2);
  if (pHat <= 0 || pHat >= 1) return 0;
  const se = Math.sqrt(pHat * (1 - pHat) * (1 / (seenIn + 1) + 1 / (seenOut + 1)));
  return se > 0 ? (p1 - p2) / se : 0;
}

interface DirCounts {
  succ: number;
  seen: number;
}

/** 每群 × 每陳述 × 每方向的票數統計 */
function tallyByGroup(
  matrix: VoteMatrix,
  assignments: number[],
  k: number,
): { agree: DirCounts[][]; disagree: DirCounts[][] } {
  const nS = matrix.sids.length;
  const make = () =>
    Array.from({ length: k }, () => Array.from({ length: nS }, () => ({ succ: 0, seen: 0 })));
  const agree = make();
  const disagree = make();
  for (let i = 0; i < matrix.pids.length; i++) {
    const g = assignments[i]!;
    for (let j = 0; j < nS; j++) {
      const v = matrix.raw[i]![j];
      if (v === null) continue;
      agree[g]![j]!.seen++;
      disagree[g]![j]!.seen++;
      if (v === 1) agree[g]![j]!.succ++;
      if (v === -1) disagree[g]![j]!.succ++;
    }
  }
  return { agree, disagree };
}

const pseudoProb = (c: DirCounts) => (c.succ + 1) / (c.seen + 2);

/**
 * 各群的代表性陳述（官方 polis 的 repness）：
 * 群內機率顯著 > 0.5、且與群外比例顯著不同、且 repness 比 > 1 的陳述，
 * 以 metric = prob × probTest × repness × repnessTest 排序取前 topN。
 * 一個群若沒有任何陳述通過檢定，退而取 metric 最高者，讓每群至少有一句。
 */
export function representativeStatements(
  matrix: VoteMatrix,
  assignments: number[],
  k: number,
  topN = 5,
): RepresentativeStatement[][] {
  const { agree, disagree } = tallyByGroup(matrix, assignments, k);
  const nS = matrix.sids.length;
  const out: RepresentativeStatement[][] = [];

  for (let g = 0; g < k; g++) {
    const candidates: (RepresentativeStatement & { passes: boolean })[] = [];
    for (let j = 0; j < nS; j++) {
      for (const [direction, table] of [
        ["agree", agree],
        ["disagree", disagree],
      ] as const) {
        const inG = table[g]![j]!;
        let succOut = 0;
        let seenOut = 0;
        for (let og = 0; og < k; og++) {
          if (og === g) continue;
          succOut += table[og]![j]!.succ;
          seenOut += table[og]![j]!.seen;
        }
        if (inG.seen === 0) continue;
        const prob = pseudoProb(inG);
        const probZ = propTest(inG.succ, inG.seen);
        const probOut = (succOut + 1) / (seenOut + 2);
        const repness = prob / probOut;
        const repnessZ = k > 1 ? twoPropTest(inG.succ, inG.seen, succOut, seenOut) : 0;
        const passes = k > 1 ? probZ > Z_90 && repnessZ > Z_90 && repness > 1 : probZ > Z_90;
        const metric = prob * Math.max(probZ, 0) * repness * Math.max(repnessZ, k > 1 ? 0 : 1);
        candidates.push({
          sid: matrix.sids[j]!,
          direction,
          prob,
          probTest: probZ,
          repness,
          repnessTest: repnessZ,
          metric,
          nSuccess: inG.succ,
          nSeen: inG.seen,
          passes,
        });
      }
    }
    // 同一陳述兩個方向都入選時只留 metric 較高者
    const bySid = new Map<number, RepresentativeStatement & { passes: boolean }>();
    for (const c of candidates) {
      const prev = bySid.get(c.sid);
      if (!prev || c.metric > prev.metric) bySid.set(c.sid, c);
    }
    const deduped = [...bySid.values()];
    let selected = deduped
      .filter((c) => c.passes)
      .sort((a, b) => b.metric - a.metric)
      .slice(0, topN);
    if (selected.length === 0 && deduped.length > 0) {
      selected = deduped.sort((a, b) => b.metric - a.metric).slice(0, 1);
    }
    out.push(selected.map(({ passes: _passes, ...rest }) => rest));
  }
  return out;
}

/**
 * Group-aware consensus（官方 polis 的 group-informed consensus）：
 * metric 為各群投同方向機率（含 pseudocount）的乘積——必須每一群都
 * 傾向同一邊，分數才會高。另要求全體比例顯著 > 0.5。
 */
export function consensusStatements(
  matrix: VoteMatrix,
  assignments: number[],
  k: number,
  topN = 5,
): { agree: ConsensusStatement[]; disagree: ConsensusStatement[] } {
  const { agree, disagree } = tallyByGroup(matrix, assignments, k);
  const nS = matrix.sids.length;

  const compute = (table: DirCounts[][], direction: "agree" | "disagree") => {
    const list: ConsensusStatement[] = [];
    for (let j = 0; j < nS; j++) {
      let metric = 1;
      let succAll = 0;
      let seenAll = 0;
      for (let g = 0; g < k; g++) {
        const c = table[g]![j]!;
        metric *= pseudoProb(c);
        succAll += c.succ;
        seenAll += c.seen;
      }
      if (seenAll === 0) continue;
      const probZ = propTest(succAll, seenAll);
      if (probZ <= Z_90) continue;
      list.push({
        sid: matrix.sids[j]!,
        direction,
        prob: (succAll + 1) / (seenAll + 2),
        probTest: probZ,
        metric,
      });
    }
    return list.sort((a, b) => b.metric - a.metric).slice(0, topN);
  };

  return { agree: compute(agree, "agree"), disagree: compute(disagree, "disagree") };
}
