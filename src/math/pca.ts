import type { VoteMatrix } from "./matrix";

/**
 * Power iteration 求置中矩陣的前兩個主成分（官方 polis 亦以 power method
 * 逼近 PCA）。矩陣以列（參與者）稠密向量表示，X^T X v 以兩段乘法累加，
 * 不需要展開共變異數矩陣。
 */
export function powerPCA(
  rows: Float64Array[],
  nCols: number,
  rng: () => number,
): [Float64Array, Float64Array] {
  const comp1 = powerIterate(rows, nCols, rng, null);
  const comp2 = powerIterate(rows, nCols, rng, comp1);
  return [comp1, comp2];
}

function powerIterate(
  rows: Float64Array[],
  nCols: number,
  rng: () => number,
  deflate: Float64Array | null,
): Float64Array {
  let v = new Float64Array(nCols);
  for (let j = 0; j < nCols; j++) v[j] = rng() - 0.5;
  orthogonalize(v, deflate);
  if (!normalize(v)) return new Float64Array(nCols);

  const maxIter = 300;
  const tol = 1e-10;
  for (let iter = 0; iter < maxIter; iter++) {
    const next = new Float64Array(nCols);
    for (const row of rows) {
      let dot = 0;
      for (let j = 0; j < nCols; j++) dot += row[j]! * v[j]!;
      for (let j = 0; j < nCols; j++) next[j] = next[j]! + row[j]! * dot;
    }
    orthogonalize(next, deflate);
    if (!normalize(next)) return new Float64Array(nCols);
    let diff = 0;
    for (let j = 0; j < nCols; j++) diff += Math.abs(next[j]! - v[j]!);
    v = next;
    if (diff < tol) break;
  }

  // 固定符號（絕對值最大的分量為正），讓結果在重算間穩定
  let maxAbs = 0;
  let maxIdx = 0;
  for (let j = 0; j < nCols; j++) {
    if (Math.abs(v[j]!) > maxAbs) {
      maxAbs = Math.abs(v[j]!);
      maxIdx = j;
    }
  }
  if (v[maxIdx]! < 0) for (let j = 0; j < nCols; j++) v[j] = -v[j]!;
  return v;
}

function orthogonalize(v: Float64Array, against: Float64Array | null): void {
  if (!against) return;
  let dot = 0;
  for (let j = 0; j < v.length; j++) dot += v[j]! * against[j]!;
  for (let j = 0; j < v.length; j++) v[j] = v[j]! - dot * against[j]!;
}

function normalize(v: Float64Array): boolean {
  let norm = 0;
  for (let j = 0; j < v.length; j++) norm += v[j]! * v[j]!;
  norm = Math.sqrt(norm);
  if (norm < 1e-12) return false;
  for (let j = 0; j < v.length; j++) v[j] = v[j]! / norm;
  return true;
}

/**
 * Sparsity-aware projection（官方 polis 作法）：只用參與者實際投過的欄位
 * 投影，再乘上 sqrt(全部陳述數 / 該參與者投票數)，避免投票少的人
 * 被平均插補拉往中心。
 */
export function projectParticipants(
  matrix: VoteMatrix,
  comps: [Float64Array, Float64Array],
): { x: number; y: number }[] {
  const nCols = matrix.sids.length;
  return matrix.raw.map((row, i) => {
    let x = 0;
    let y = 0;
    for (let j = 0; j < nCols; j++) {
      const v = row[j] ?? null;
      if (v === null) continue;
      const centered = v - matrix.colMeans[j]!;
      x += centered * comps[0][j]!;
      y += centered * comps[1][j]!;
    }
    const nVotes = matrix.voteCounts[i]!;
    const scale = nVotes > 0 ? Math.sqrt(nCols / nVotes) : 0;
    return { x: x * scale, y: y * scale };
  });
}
