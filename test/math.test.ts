import { describe, expect, it } from "vitest";
import { MIN_GROUP_STATS_SIZE, redactSmallGroupStats } from "../src/math/pipeline";
import { buildMatrix, inclusionThreshold } from "../src/math/matrix";
import { chooseGroups, K_SMOOTHING_BUFFER, kmeans, selectK, silhouette } from "../src/math/kmeans";
import { computeMath } from "../src/math/pipeline";
import { propTest, twoPropTest, Z_90 } from "../src/math/repness";
import { hashSeed, mulberry32 } from "../src/math/rng";
import type { VoteRow, VoteValue } from "../src/math/types";

describe("inclusionThreshold", () => {
  it("是官方的 7 票門檻，陳述不足 7 句時需全投", () => {
    expect(inclusionThreshold(20)).toBe(7);
    expect(inclusionThreshold(7)).toBe(7);
    expect(inclusionThreshold(3)).toBe(3);
    expect(inclusionThreshold(0)).toBe(1);
  });
});

describe("buildMatrix", () => {
  it("平均插補後置中，插補格為 0", () => {
    const votes: VoteRow[] = [
      { pid: "p1", sid: 1, value: 1 },
      { pid: "p1", sid: 2, value: -1 },
      { pid: "p2", sid: 1, value: 1 },
      { pid: "p2", sid: 2, value: 1 },
      { pid: "p3", sid: 1, value: -1 },
    ];
    const m = buildMatrix(votes, [1, 2], 1);
    expect(m.pids).toHaveLength(3);
    expect(m.colMeans[0]).toBeCloseTo(1 / 3);
    expect(m.colMeans[1]).toBeCloseTo(0);
    const p3 = m.pids.indexOf("p3");
    expect(m.centered[p3]![1]).toBe(0); // p3 沒投 s2 → 插補置中後為 0
    expect(m.centered[p3]![0]).toBeCloseTo(-1 - 1 / 3);
  });

  it("投票數不足門檻的參與者不納入", () => {
    const votes: VoteRow[] = [
      { pid: "p1", sid: 1, value: 1 },
      { pid: "p2", sid: 1, value: 1 },
      { pid: "p2", sid: 2, value: 1 },
    ];
    const m = buildMatrix(votes, [1, 2], 2);
    expect(m.pids).toEqual(["p2"]);
  });
});

describe("統計檢定", () => {
  it("propTest：全體同意時顯著為正、五五波時為零", () => {
    expect(propTest(10, 10)).toBeGreaterThan(Z_90);
    expect(propTest(5, 10)).toBeCloseTo(2 * Math.sqrt(10) * (6 / 12 - 0.5));
    expect(propTest(0, 10)).toBeLessThan(-Z_90);
  });

  it("twoPropTest：群內外一致時為零、群內壓倒性偏高時顯著", () => {
    expect(Math.abs(twoPropTest(5, 10, 5, 10))).toBeLessThan(1e-9);
    expect(twoPropTest(19, 20, 2, 20)).toBeGreaterThan(Z_90);
    expect(twoPropTest(2, 20, 19, 20)).toBeLessThan(-Z_90);
  });
});

describe("kmeans 與 silhouette", () => {
  it("清楚分開的兩坨點：k-means 完整分開、silhouette 高", () => {
    const rng = mulberry32(42);
    const points = [
      ...Array.from({ length: 10 }, (_, i) => ({ x: 0 + i * 0.01, y: 0 })),
      ...Array.from({ length: 10 }, (_, i) => ({ x: 10 + i * 0.01, y: 10 })),
    ];
    const result = kmeans(points, points.map(() => 1), 2, rng);
    const groupOfFirst = result.assignments[0];
    expect(result.assignments.slice(0, 10).every((a) => a === groupOfFirst)).toBe(true);
    expect(result.assignments.slice(10).every((a) => a !== groupOfFirst)).toBe(true);
    expect(silhouette(points, result.assignments, 2)).toBeGreaterThan(0.8);
  });

  it("chooseGroups 在兩坨點時選 k=2", () => {
    const rng = mulberry32(7);
    const points = [
      ...Array.from({ length: 12 }, (_, i) => ({ x: rngJitter(i), y: rngJitter(i + 99) })),
      ...Array.from({ length: 12 }, (_, i) => ({ x: 8 + rngJitter(i + 7), y: 8 + rngJitter(i + 3) })),
    ];
    const result = chooseGroups(points, rng);
    expect(result.k).toBe(2);
  });

  it("selectK：k-smoothing 在差距未超過 buffer 時保留前一次的 k", () => {
    const scores = [
      { k: 2, sil: 0.4 },
      { k: 3, sil: 0.41 },
      { k: 4, sil: 0.3 },
    ];
    expect(selectK(scores, null)).toBe(3); // 無歷史：取最高
    expect(selectK(scores, 2)).toBe(2); // 差 0.01 ≤ buffer：保留
    expect(selectK([{ k: 2, sil: 0.3 }, { k: 3, sil: 0.3 + K_SMOOTHING_BUFFER + 0.01 }], 2)).toBe(3); // 超過 buffer：換
    expect(selectK(scores, 5)).toBe(3); // 歷史 k 不在候選中：取最高
  });

  it("點太少時不分群", () => {
    const rng = mulberry32(1);
    const result = chooseGroups([{ x: 0, y: 0 }, { x: 1, y: 1 }], rng);
    expect(result.k).toBe(1);
  });
});

function rngJitter(seed: number): number {
  return mulberry32(seed)() * 0.5;
}

describe("computeMath 整條管線", () => {
  it("兩派對立＋一句全體同意：分成兩群、代表性與共識正確", () => {
    // 陣營 X（20 人）：同意 s1..s4、不同意 s5..s8
    // 陣營 Y（20 人）：相反
    // s9：兩派都同意（共識句）
    const votes: VoteRow[] = [];
    const vote = (pid: string, sid: number, value: VoteValue) => votes.push({ pid, sid, value });
    for (let i = 0; i < 20; i++) {
      const x = `x${i}`;
      const y = `y${i}`;
      for (let s = 1; s <= 4; s++) {
        vote(x, s, 1);
        vote(y, s, -1);
      }
      for (let s = 5; s <= 8; s++) {
        vote(x, s, -1);
        vote(y, s, 1);
      }
      vote(x, 9, 1);
      vote(y, 9, 1);
    }
    const { publicResult, pidPoints } = computeMath({
      conversationId: "testconv123",
      votes,
      statementIds: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      computedAt: 1000,
    });

    expect(publicResult.nParticipantsTotal).toBe(40);
    expect(publicResult.nParticipantsClustered).toBe(40);
    expect(publicResult.k).toBe(2);
    expect(publicResult.groups.map((g) => g.size)).toEqual([20, 20]);

    // 兩陣營各自被分到同一群
    const groupOfX = pidPoints["x0"]!.group;
    const groupOfY = pidPoints["y0"]!.group;
    expect(groupOfX).not.toBe(groupOfY);
    for (let i = 0; i < 20; i++) {
      expect(pidPoints[`x${i}`]!.group).toBe(groupOfX);
      expect(pidPoints[`y${i}`]!.group).toBe(groupOfY);
    }

    // 代表性陳述：X 群的代表句應是 s1..s8 其中之一，且方向正確
    const gx = publicResult.groups.find((g) => g.id === groupOfX)!;
    expect(gx.representative.length).toBeGreaterThan(0);
    for (const r of gx.representative) {
      expect(r.sid).not.toBe(9); // 共識句不該是代表性陳述
      if (r.sid <= 4) expect(r.direction).toBe("agree");
      else expect(r.direction).toBe("disagree");
      expect(r.repness).toBeGreaterThan(1);
    }

    // 群內統計：X 群對 s1 應全投同意 (20 票)，對 s5 應全投不同意 (20 票)
    expect(gx.statementStats).toBeDefined();
    expect(gx.statementStats?.find((s) => s.sid === 1)?.agrees).toBe(20);
    expect(gx.statementStats?.find((s) => s.sid === 5)?.disagrees).toBe(20);

    // 共識：s9 應該是同意方向的第一名
    expect(publicResult.consensus.agree.length).toBeGreaterThan(0);
    expect(publicResult.consensus.agree[0]!.sid).toBe(9);
    // 對立句不該出現在共識清單
    for (const c of publicResult.consensus.agree) expect(c.sid).toBe(9);
  });

  it("同輸入重算結果一致（決定性）", () => {
    const votes: VoteRow[] = [];
    for (let i = 0; i < 10; i++) {
      for (let s = 1; s <= 7; s++) {
        votes.push({ pid: `p${i}`, sid: s, value: ((i + s) % 3 === 0 ? 1 : -1) as VoteValue });
      }
    }
    const input = { conversationId: "abc", votes, statementIds: [1, 2, 3, 4, 5, 6, 7], computedAt: 0 };
    const a = computeMath(input);
    const b = computeMath(input);
    expect(a.publicResult).toEqual(b.publicResult);
  });

  it("沒有投票時回傳空結果不噴錯", () => {
    const { publicResult } = computeMath({
      conversationId: "abc",
      votes: [],
      statementIds: [1, 2],
      computedAt: 0,
    });
    expect(publicResult.nParticipantsTotal).toBe(0);
    expect(publicResult.k).toBe(0);
    expect(publicResult.points).toEqual([]);
  });
});

describe("rng", () => {
  it("hashSeed 對相同字串穩定", () => {
    expect(hashSeed("abc")).toBe(hashSeed("abc"));
    expect(hashSeed("abc")).not.toBe(hashSeed("abd"));
  });
});

describe("redactSmallGroupStats（k-匿名）", () => {
  it(`size < ${MIN_GROUP_STATS_SIZE} 的群移除 statementStats，其餘群與其他欄位原樣保留`, () => {
    const stat = { sid: 1, agrees: 1, disagrees: 0, passes: 0, seen: 1 };
    const result: any = {
      computedAt: 1,
      k: 2,
      nParticipantsClustered: 4,
      nParticipantsTotal: 4,
      nVotes: 4,
      points: [],
      statementStats: [stat],
      consensus: { agree: [], disagree: [] },
      groups: [
        { id: 0, label: "A", size: MIN_GROUP_STATS_SIZE, center: [0, 0], representative: [], statementStats: [stat] },
        { id: 1, label: "B", size: 1, center: [0, 0], representative: [], statementStats: [stat] },
      ],
    };
    const redacted = redactSmallGroupStats(result);
    expect(redacted.groups[0]!.statementStats).toEqual([stat]);
    expect("statementStats" in redacted.groups[1]!).toBe(false);
    expect(redacted.groups[1]!.size).toBe(1);
    expect(redacted.statementStats).toEqual([stat]);
    // 原物件不被修改
    expect(result.groups[1].statementStats).toEqual([stat]);
  });
});
