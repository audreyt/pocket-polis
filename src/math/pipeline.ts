import { buildMatrix, inclusionThreshold } from "./matrix";
import { chooseGroups } from "./kmeans";
import { powerPCA, projectParticipants } from "./pca";
import { consensusStatements, representativeStatements } from "./repness";
import { hashSeed, mulberry32 } from "./rng";
import type {
  GroupResult,
  MathResult,
  OpinionPoint,
  PipelineOutput,
  StatementStat,
  VoteRow,
} from "./types";

const GROUP_LABELS = ["A", "B", "C", "D", "E"];

export interface PipelineInput {
  conversationId: string;
  /** 只包含已核准陳述上的投票 */
  votes: VoteRow[];
  /** 已核准陳述的 id */
  statementIds: number[];
  computedAt: number;
  /** 前一次結果的群數（k-smoothing：差距在 buffer 內時保留） */
  previousK?: number | null;
}

export function computeMath(input: PipelineInput): PipelineOutput {
  const { votes, statementIds } = input;
  const rng = mulberry32(hashSeed(`${input.conversationId}:${votes.length}:${statementIds.length}`));

  const statementStats = tallyStatements(votes, statementIds);
  const allPids = new Set(votes.map((v) => v.pid));

  const threshold = inclusionThreshold(statementIds.length);
  const matrix = buildMatrix(votes, statementIds, threshold);

  const base: MathResult = {
    computedAt: input.computedAt,
    nParticipantsTotal: allPids.size,
    nParticipantsClustered: matrix.pids.length,
    nVotes: votes.length,
    nStatements: statementIds.length,
    inclusionThreshold: threshold,
    k: 0,
    silhouette: null,
    points: [],
    groups: [],
    consensus: { agree: [], disagree: [] },
    statementStats,
  };

  if (matrix.pids.length === 0 || statementIds.length === 0) {
    return { publicResult: base, pidPoints: {} };
  }

  const comps = powerPCA(matrix.centered, statementIds.length, rng);
  const projected = projectParticipants(matrix, comps);
  const grouping = chooseGroups(projected, rng, input.previousK ?? null);

  // 依群大小重新編號（最大的是 A），視覺與敘事穩定
  const sizes = new Array<number>(grouping.k).fill(0);
  for (const a of grouping.assignments) sizes[a]!++;
  const order = [...sizes.keys()].sort((a, b) => sizes[b]! - sizes[a]!);
  const renumber = new Map(order.map((oldId, newId) => [oldId, newId]));

  const assignments = grouping.assignments.map((a) => renumber.get(a)!);
  const points: OpinionPoint[] = projected.map((p, i) => ({
    x: round(p.x),
    y: round(p.y),
    group: assignments[i]!,
  }));

  const reps = representativeStatements(matrix, assignments, grouping.k);
  const groups: GroupResult[] = [];
  for (let g = 0; g < grouping.k; g++) {
    const members = points.filter((p) => p.group === g);
    const cx = members.reduce((s, p) => s + p.x, 0) / Math.max(members.length, 1);
    const cy = members.reduce((s, p) => s + p.y, 0) / Math.max(members.length, 1);
    groups.push({
      id: g,
      label: GROUP_LABELS[g] ?? `${g + 1}`,
      size: members.length,
      center: [round(cx), round(cy)],
      representative: reps[g] ?? [],
    });
  }

  const consensus = consensusStatements(matrix, assignments, grouping.k);

  const pidPoints: Record<string, OpinionPoint> = {};
  matrix.pids.forEach((pid, i) => {
    pidPoints[pid] = points[i]!;
  });

  return {
    publicResult: {
      ...base,
      k: grouping.k,
      silhouette: grouping.silhouette === null ? null : round(grouping.silhouette),
      points,
      groups,
      consensus,
    },
    pidPoints,
  };
}

function tallyStatements(votes: VoteRow[], statementIds: number[]): StatementStat[] {
  const stats = new Map<number, StatementStat>(
    statementIds.map((sid) => [sid, { sid, agrees: 0, disagrees: 0, passes: 0, seen: 0 }]),
  );
  for (const v of votes) {
    const s = stats.get(v.sid);
    if (!s) continue;
    s.seen++;
    if (v.value === 1) s.agrees++;
    else if (v.value === -1) s.disagrees++;
    else s.passes++;
  }
  return [...stats.values()];
}

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}
