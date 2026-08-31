export interface Point {
  x: number;
  y: number;
}

export interface KMeansResult {
  assignments: number[];
  centers: Point[];
  inertia: number;
}

function dist2(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** 加權 k-means（k-means++ 初始化、Lloyd 迭代、空群修補）。 */
export function kmeans(
  points: Point[],
  weights: number[],
  k: number,
  rng: () => number,
  restarts = 4,
): KMeansResult {
  let best: KMeansResult | null = null;
  for (let r = 0; r < restarts; r++) {
    const result = kmeansOnce(points, weights, k, rng);
    if (!best || result.inertia < best.inertia) best = result;
  }
  return best!;
}

function kmeansOnce(points: Point[], weights: number[], k: number, rng: () => number): KMeansResult {
  const n = points.length;
  const centers: Point[] = [];

  // k-means++ 初始化（依權重）
  const first = weightedPick(weights, rng);
  centers.push({ ...points[first]! });
  while (centers.length < k) {
    const d2 = points.map((p, i) => {
      let min = Infinity;
      for (const c of centers) min = Math.min(min, dist2(p, c));
      return min * weights[i]!;
    });
    const total = d2.reduce((a, b) => a + b, 0);
    if (total < 1e-12) {
      // 所有點都與現有中心重合，隨便補
      centers.push({ ...points[Math.floor(rng() * n)]! });
      continue;
    }
    centers.push({ ...points[weightedPick(d2, rng)]! });
  }

  const assignments = new Array<number>(n).fill(0);
  for (let iter = 0; iter < 100; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let bestC = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(points[i]!, centers[c]!);
        if (d < bestD) {
          bestD = d;
          bestC = c;
        }
      }
      if (assignments[i] !== bestC) {
        assignments[i] = bestC;
        changed = true;
      }
    }

    const sums = Array.from({ length: k }, () => ({ x: 0, y: 0, w: 0 }));
    for (let i = 0; i < n; i++) {
      const s = sums[assignments[i]!]!;
      s.x += points[i]!.x * weights[i]!;
      s.y += points[i]!.y * weights[i]!;
      s.w += weights[i]!;
    }
    for (let c = 0; c < k; c++) {
      const s = sums[c]!;
      if (s.w > 0) {
        centers[c] = { x: s.x / s.w, y: s.y / s.w };
      } else {
        // 空群：把離自己中心最遠的點搬過來
        let farI = 0;
        let farD = -1;
        for (let i = 0; i < n; i++) {
          const d = dist2(points[i]!, centers[assignments[i]!]!);
          if (d > farD) {
            farD = d;
            farI = i;
          }
        }
        centers[c] = { ...points[farI]! };
        assignments[farI] = c;
        changed = true;
      }
    }
    if (!changed && iter > 0) break;
  }

  let inertia = 0;
  for (let i = 0; i < n; i++) inertia += dist2(points[i]!, centers[assignments[i]!]!) * weights[i]!;
  return { assignments, centers, inertia };
}

function weightedPick(weights: number[], rng: () => number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return Math.floor(rng() * weights.length);
  let t = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    t -= weights[i]!;
    if (t <= 0) return i;
  }
  return weights.length - 1;
}

/** 平均 silhouette 係數（單點群的 a 取 0，與常見實作一致）。 */
export function silhouette(points: Point[], assignments: number[], k: number): number {
  const n = points.length;
  if (n < 2 || k < 2) return 0;
  const clusterIdx: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) clusterIdx[assignments[i]!]!.push(i);

  let sum = 0;
  for (let i = 0; i < n; i++) {
    const own = clusterIdx[assignments[i]!]!;
    let a = 0;
    if (own.length > 1) {
      let d = 0;
      for (const j of own) if (j !== i) d += Math.sqrt(dist2(points[i]!, points[j]!));
      a = d / (own.length - 1);
    }
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === assignments[i] || clusterIdx[c]!.length === 0) continue;
      let d = 0;
      for (const j of clusterIdx[c]!) d += Math.sqrt(dist2(points[i]!, points[j]!));
      b = Math.min(b, d / clusterIdx[c]!.length);
    }
    if (!isFinite(b)) continue;
    const denom = Math.max(a, b);
    sum += denom > 0 ? (b - a) / denom : 0;
  }
  return sum / n;
}

export interface GroupingResult {
  k: number;
  assignments: number[];
  centers: Point[];
  silhouette: number | null;
}

/**
 * 官方 polis 的兩段式分群：參與者超過 100 人時先做 k=100 的 base
 * clustering，再對 base center（以群大小加權）做 2..5 群的分群，
 * 以 silhouette 選 k。100 人以下直接對參與者分群。
 * （偏差：官方對 base center 算 silhouette 時的加權細節未公開，
 * 這裡用未加權 silhouette。）
 */
export function chooseGroups(points: Point[], rng: () => number): GroupingResult {
  const n = points.length;
  if (n === 0) return { k: 0, assignments: [], centers: [], silhouette: null };

  const distinct = new Set(points.map((p) => `${p.x.toFixed(9)},${p.y.toFixed(9)}`)).size;
  if (n < 4 || distinct < 2) {
    return {
      k: 1,
      assignments: new Array(n).fill(0),
      centers: [centroid(points)],
      silhouette: null,
    };
  }

  let basePoints = points;
  let baseWeights = new Array<number>(n).fill(1);
  let baseAssignOfParticipant: number[] | null = null;
  if (n > 100) {
    const base = kmeans(points, baseWeights, 100, rng, 2);
    baseAssignOfParticipant = base.assignments;
    basePoints = base.centers;
    baseWeights = new Array<number>(100).fill(0);
    for (const a of base.assignments) baseWeights[a]! += 1;
  }

  const kMax = Math.min(5, distinct, basePoints.length - 1);
  let best: { k: number; result: KMeansResult; sil: number } | null = null;
  for (let k = 2; k <= kMax; k++) {
    const result = kmeans(basePoints, baseWeights, k, rng);
    const sil = silhouette(basePoints, result.assignments, k);
    if (!best || sil > best.sil) best = { k, result, sil };
  }
  if (!best) {
    return {
      k: 1,
      assignments: new Array(n).fill(0),
      centers: [centroid(points)],
      silhouette: null,
    };
  }

  let assignments: number[];
  if (baseAssignOfParticipant) {
    assignments = baseAssignOfParticipant.map((b) => best!.result.assignments[b]!);
  } else {
    assignments = best.result.assignments;
  }
  return { k: best.k, assignments, centers: best.result.centers, silhouette: best.sil };
}

function centroid(points: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}
