import { describe, expect, it, vi } from "vitest";
import {
  computeEvidenceBuckets,
  distinguishesPair,
  generateDeterministicSensemaking,
  generateSensemaking,
  inferSourceLanguage,
  pickDeterministicTensionPair,
  rankConsensusSids,
  SENSEMAKING_MODEL,
  type SensemakingResponse,
} from "../src/sensemaking";
import type { MathResult, StatementStat, VoteRow } from "../src/math/types";
import { computeMath, MIN_GROUP_STATS_SIZE } from "../src/math/pipeline";

function createMockMathResult(): { mathResult: MathResult; votes: VoteRow[] } {
  const votes: VoteRow[] = [];
  // 40 人：20 位 X (s1..s4 agree, s5..s8 disagree, s9 agree)
  // 20 位 Y (s1..s4 disagree, s5..s8 agree, s9 agree)
  for (let i = 0; i < 20; i++) {
    for (let s = 1; s <= 4; s++) votes.push({ pid: `x${i}`, sid: s, value: 1 });
    for (let s = 5; s <= 8; s++) votes.push({ pid: `x${i}`, sid: s, value: -1 });
    votes.push({ pid: `x${i}`, sid: 9, value: 1 });
  }
  for (let i = 0; i < 20; i++) {
    for (let s = 1; s <= 4; s++) votes.push({ pid: `y${i}`, sid: s, value: -1 });
    for (let s = 5; s <= 8; s++) votes.push({ pid: `y${i}`, sid: s, value: 1 });
    votes.push({ pid: `y${i}`, sid: 9, value: 1 });
  }

  const { publicResult } = computeMath({
    conversationId: "testconv",
    statementIds: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    votes,
    computedAt: 1000,
    previousK: null,
  });

  return { mathResult: publicResult, votes };
}

describe("inferSourceLanguage 來源語系確定性推論", () => {
  it("標題或陳述含有 3 個以上 CJK 字符時推論為 zh，否則為 en", () => {
    expect(
      inferSourceLanguage("國防預算公投", "討論特別條例", [{ text: "支持國防自主" }]),
    ).toBe("zh");
    expect(
      inferSourceLanguage("Defense Budget Wikisurvey", "Deliberation on budget", [
        { text: "Increase investments" },
        { text: "Fiscal responsibility" },
      ]),
    ).toBe("en");
  });
});

describe("computeEvidenceBuckets 確定性證據過濾（Jigsaw minCommonGroundProb=0.60）", () => {
  it("共識候選池僅包含每個群體偽機率均 >= 0.60 的陳述 (s9)，分歧候選池包含各群代表性陳述", () => {
    const { mathResult } = createMockMathResult();
    const statementIds = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const buckets = computeEvidenceBuckets(mathResult, statementIds);

    // s9 在 Group 0 與 Group 1 同意率均為 100% ((20+1)/(20+2) = 0.95 >= 0.60)
    expect(buckets.eligibleConsensusSids.has(9)).toBe(true);
    expect(buckets.consensusAgreeSids.has(9)).toBe(true);

    // s1 在 Group 1 為不同意，不可能進入共識池
    expect(buckets.eligibleConsensusSids.has(1)).toBe(false);

    // 代表性陳述 s1 與 s5 必須在張力分歧池中
    expect(buckets.eligibleTensionSids.has(1)).toBe(true);
    expect(buckets.eligibleTensionSids.has(5)).toBe(true);
  });

  it("低於 MIN_GROUP_STATS_SIZE 的群體不提供逐陳述統計：不成為張力證據、不阻擋共識，且提示與驗證視為 seen = 0", () => {
    const { mathResult } = createMockMathResult();
    const statementIds = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    // 加入 1 人群：對 s9 不同意、對 s2 100% 同意（若納入，s9 共識會被擋、s2 會因差距成為張力）
    const tiny = {
      id: 2,
      label: "C",
      size: 1,
      center: [0, 0] as [number, number],
      representative: [],
      statementStats: statementIds.map((sid) => ({
        sid,
        agrees: sid === 2 ? 1 : 0,
        disagrees: sid === 9 ? 1 : 0,
        passes: sid === 2 || sid === 9 ? 0 : 1,
        seen: 1,
      })),
    };
    const withTiny: MathResult = { ...mathResult, k: 3, groups: [...mathResult.groups, tiny] };
    const buckets = computeEvidenceBuckets(withTiny, statementIds);
    expect(buckets.groupStatsMap.get(2)?.size ?? 0).toBe(0);
    expect(buckets.consensusAgreeSids.has(9)).toBe(true);
    const base = computeEvidenceBuckets(mathResult, statementIds);
    expect([...buckets.eligibleTensionSids].sort()).toEqual([...base.eligibleTensionSids].sort());
  });
});

describe("generateSensemaking 門檻與防護", () => {
  it("參與者不足 4 人或分群少於 2 群時回傳 insufficient，不發起 AI 呼叫", async () => {
    const aiRun = vi.fn();
    const mockAi = { run: aiRun } as unknown as Ai;

    const dummyMathResult: MathResult = {
      nParticipantsTotal: 3,
      nParticipantsClustered: 3,
      nStatements: 5,
      nVotes: 10,
      k: 1,
      groups: [{ id: 0, label: "A", size: 3, representative: [] }],
      points: [],
      statementStats: [],
      consensus: { agree: [], disagree: [] },
      computedAt: 1000,
      inclusionThreshold: 7,
    };

    const res = await generateSensemaking({
      ai: mockAi,
      reserveGlobal: async () => true,
      lang: "zh",
      title: "測試討論",
      description: "測試說明",
      mathResult: dummyMathResult,
      statements: [
        { sid: 1, text: "s1" },
        { sid: 2, text: "s2" },
        { sid: 3, text: "s3" },
      ],
      mathRevision: 1,
      now: 1000,
    });

    expect(res.status).toBe("insufficient");
    expect(aiRun).not.toHaveBeenCalled();
  });
});

describe("generateSensemaking 多階段生成與嚴格引用驗證", () => {
  it("完整走完主題發現、歸類與最終綜整，若引用非法則整條捨棄", async () => {
    const { mathResult } = createMockMathResult();
    const statements = [
      { sid: 1, text: "支持擴大國防投資" },
      { sid: 2, text: "國防應發展不對稱戰力" },
      { sid: 3, text: "預算需經立法院嚴格監督" },
      { sid: 4, text: "採購流程應提高透明度" },
      { sid: 5, text: "優先編列民生與社福預算" },
      { sid: 6, text: "應評估舉債對財政之衝擊" },
      { sid: 7, text: "軍購項目的必要性需再釐清" },
      { sid: 8, text: "應重視國防自主與研發" },
      { sid: 9, text: "國家安全是全體國民的共同基石" },
    ];

    const aiRun = vi.fn();

    // 階段 1：主題發現回應
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        topics: [
          { id: "t1", title: "國防安全與戰力發展", description: "聚焦國防投資與戰略方向" },
          { id: "t2", title: "財政平衡與民生優先", description: "關注預算分配與財政紀律" },
          { id: "t3", title: "透明監督與國家基石", description: "重視國會監督與國安共識" },
        ],
      }),
    });

    // 階段 2：歸類回應
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        assignments: [
          { sid: 1, primaryTopicId: "t1", secondaryTopicId: null },
          { sid: 2, primaryTopicId: "t1", secondaryTopicId: "t3" },
          { sid: 3, primaryTopicId: "t3", secondaryTopicId: null },
          { sid: 4, primaryTopicId: "t3", secondaryTopicId: null },
          { sid: 5, primaryTopicId: "t2", secondaryTopicId: null },
          { sid: 6, primaryTopicId: "t2", secondaryTopicId: null },
          { sid: 7, primaryTopicId: "t2", secondaryTopicId: "t3" },
          { sid: 8, primaryTopicId: "t1", secondaryTopicId: null },
          { sid: 9, primaryTopicId: "t3", secondaryTopicId: null },
        ],
      }),
    });

    // 階段 4：最終綜整回應
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        overview: {
          summary: "本場討論呈現高度關注國家安全但對預算優先序有鮮明立場之兩大陣營。",
          citedStatementIds: [1, 9],
        },
        commonGround: {
          keyPoints: [
            {
              title: "國安是共同基石",
              description: "跨群普遍同意國家安全的重要性不可動搖。",
              citedStatementIds: [9],
            },
            {
              title: "不實陳述點",
              description: "這條引用了非共識陳述，應被整條剔除。",
              citedStatementIds: [1, 999],
            },
          ],
        },
        groupPortraits: [
          {
            groupId: 0,
            title: "國防戰力積極投資者",
            summary: "主張加速強化國防戰備能力。",
            keyStances: [{ sid: 1, summary: "強力支持擴大投資" }],
          },
          {
            groupId: 1,
            title: "民生財政優先倡議者",
            summary: "主張兼顧民生需求與財政紀律。",
            keyStances: [{ sid: 5, summary: "優先考量民生" }],
          },
        ],
        tensions: [
          {
            groupAId: 0,
            groupBId: 1,
            topic: "預算分配優先順序",
            groupAPerspective: "應以國防投資為重",
            groupBPerspective: "應以民生社福為先",
            tensions: "資源有限下國防與民生的配置取捨",
            bridgingQuestion: "如何在確保基本國安防衛的同時設定民生投資的保障底線？",
            citedStatementIds: [1, 5],
          },
          {
            groupAId: 0,
            groupBId: 1,
            topic: "非法張力點",
            groupAPerspective: "A",
            groupBPerspective: "B",
            tensions: "T",
            bridgingQuestion: "Q",
            citedStatementIds: [9, 888],
          },
        ],
      }),
    });

    const mockAi = { run: aiRun } as unknown as Ai;

    const res = (await generateSensemaking({
      ai: mockAi,
      reserveGlobal: async () => true,
      lang: "zh",
      title: "國防預算討論",
      description: "探討預算分配",
      mathResult,
      statements,
      mathRevision: 2,
      now: 5000,
    })) as SensemakingResponse;

    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;

    expect(res.model).toBe(SENSEMAKING_MODEL);
    expect(res.provenance.participantCount).toBe(40);
    expect(res.provenance.statementCount).toBe(9);
    expect(res.themes).toHaveLength(3);

    // 驗證 keyPoints：只保留合法的第 1 條，第 2 條被整條捨棄，且包含方向
    expect(res.commonGround.keyPoints).toHaveLength(1);
    expect(res.commonGround.keyPoints[0]!.title).toBe("國安是共同基石");
    expect(res.commonGround.keyPoints[0]!.direction).toBe("agree");
    expect(res.commonGround.keyPoints[0]!.citedStatementIds).toEqual([9]);

    // 驗證 tensions：只保留合法的第 1 條，第 2 條被整條捨棄，且包含群體 ID 與標籤
    expect(res.tensions).toHaveLength(1);
    expect(res.tensions[0]!.groupAId).toBe(0);
    expect(res.tensions[0]!.groupBId).toBe(1);
    expect(res.tensions[0]!.topic).toBe("預算分配優先順序");
    expect(res.tensions[0]!.citedStatementIds).toEqual([1, 5]);

    // 驗證 overview 引用與確定性脈絡
    expect(res.overview.citedStatementIds).toEqual([1, 9]);
    expect(res.overview.participantContext).toContain("40");

    // 驗證群體畫像生成完整，且包含 derived citations
    expect(res.groupPortraits).toHaveLength(2);
    expect(res.groupPortraits[0]!.groupLabel).toBe("A");
    expect(res.groupPortraits[0]!.citedStatementIds).toEqual([1]);
    expect(res.groupPortraits[1]!.groupLabel).toBe("B");
    expect(res.groupPortraits[1]!.citedStatementIds).toEqual([5]);
  });

  it("歸類未匹配之陳述自動分入 other 主題，不靜默分入第一主題", async () => {
    const { mathResult } = createMockMathResult();
    const statements = [
      { sid: 1, text: "s1" },
      { sid: 2, text: "s2" },
      { sid: 3, text: "s3" },
    ];

    const aiRun = vi.fn();
    // 階段 1：主題發現
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        topics: [
          { id: "t1", title: "Theme 1", description: "Desc 1" },
          { id: "t2", title: "Theme 2", description: "Desc 2" },
          { id: "t3", title: "Theme 3", description: "Desc 3" },
        ],
      }),
    });

    // 階段 2：歸類（只歸類了 sid 1，遺漏 sid 2 與 sid 3）
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        assignments: [{ sid: 1, primaryTopicId: "t1", secondaryTopicId: null }],
      }),
    });

    // 重試仍未歸類
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({ assignments: [] }),
    });

    // 階段 4：綜整
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        overview: { summary: "Sum", citedStatementIds: [1] },
        commonGround: { keyPoints: [] },
        groupPortraits: [],
        tensions: [],
      }),
    });

    const mockAi = { run: aiRun } as unknown as Ai;
    const res = (await generateSensemaking({
      ai: mockAi,
      reserveGlobal: async () => true,
      lang: "en",
      title: "Title",
      description: "Desc",
      mathResult,
      statements,
      mathRevision: 1,
      now: 1000,
    })) as SensemakingResponse;

    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;

    const otherTheme = res.themes.find((t) => t.id === "other");
    expect(otherTheme).toBeDefined();
    expect(otherTheme?.primaryStatementIds).toContain(2);
    expect(otherTheme?.primaryStatementIds).toContain(3);
    // 第一主題絕不包含遺漏的 sid 2, 3
    const t1 = res.themes.find((t) => t.id === "t1");
    expect(t1?.primaryStatementIds).toEqual([1]);
  });
  it("次要主題聯集入 theme.statementIds 並剔除跨批次外來 SID", async () => {
    const { mathResult } = createMockMathResult();
    const statements = [
      { sid: 1, text: "s1" },
      { sid: 2, text: "s2" },
      { sid: 3, text: "s3" },
    ];

    const aiRun = vi.fn();
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        topics: [
          { id: "t1", title: "Theme 1", description: "Desc 1" },
          { id: "t2", title: "Theme 2", description: "Desc 2" },
          { id: "t3", title: "Theme 3", description: "Desc 3" },
        ],
      }),
    });

    // 包含合法次要主題分配與外來非法 sid 999
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        assignments: [
          { sid: 1, primaryTopicId: "t1", secondaryTopicId: "t2" },
          { sid: 2, primaryTopicId: "t2", secondaryTopicId: "t1" },
          { sid: 3, primaryTopicId: "t3", secondaryTopicId: null },
          { sid: 999, primaryTopicId: "t1", secondaryTopicId: "t2" },
        ],
      }),
    });

    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        overview: { summary: "Overview", citedStatementIds: [1] },
        commonGround: { keyPoints: [] },
        groupPortraits: [],
        tensions: [],
      }),
    });

    const mockAi = { run: aiRun } as unknown as Ai;
    const res = (await generateSensemaking({
      ai: mockAi,
      reserveGlobal: async () => true,
      lang: "zh",
      title: "Title",
      description: "Desc",
      mathResult,
      statements,
      mathRevision: 1,
      now: 1000,
    })) as SensemakingResponse;

    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;

    const t1 = res.themes.find((t) => t.id === "t1")!;
    const t2 = res.themes.find((t) => t.id === "t2")!;
    expect(t1.primaryStatementIds).toEqual([1]);
    expect(t1.secondaryStatementIds).toEqual([2]);
    expect(t1.statementIds).toEqual([1, 2]); // statementIds 為 primary + secondary 之聯集
    expect(t1.statementIds).not.toContain(999); // 外來 SID 被剔除

    expect(t2.primaryStatementIds).toEqual([2]);
    expect(t2.secondaryStatementIds).toEqual([1]);
    expect(t2.statementIds).toEqual([2, 1]);
  });

  it("Overview 引用無效時中立化為確定性結構句且空引用，不保留模型幻覺文本", async () => {
    const { mathResult } = createMockMathResult();
    const statements = [
      { sid: 1, text: "s1" },
      { sid: 2, text: "s2" },
      { sid: 3, text: "s3" },
    ];

    const aiRun = vi.fn();
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        topics: [
          { id: "t1", title: "Theme 1", description: "Desc 1" },
          { id: "t2", title: "Theme 2", description: "Desc 2" },
          { id: "t3", title: "Theme 3", description: "Desc 3" },
        ],
      }),
    });
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        assignments: [
          { sid: 1, primaryTopicId: "t1", secondaryTopicId: null },
          { sid: 2, primaryTopicId: "t2", secondaryTopicId: null },
          { sid: 3, primaryTopicId: "t3", secondaryTopicId: null },
        ],
      }),
    });

    // 模型回傳了無效的 overview 引用 (sid 999 不存在) 與模型生造的文本
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        overview: {
          summary: "模型自己生造的不實概論文本，不應被採納。",
          citedStatementIds: [999],
        },
        commonGround: { keyPoints: [] },
        groupPortraits: [],
        tensions: [],
      }),
    });

    const mockAi = { run: aiRun } as unknown as Ai;
    const res = (await generateSensemaking({
      ai: mockAi,
      reserveGlobal: async () => true,
      lang: "zh",
      title: "人工智慧監管討論",
      description: "探討規範架構",
      mathResult,
      statements,
      mathRevision: 1,
      now: 1000,
    })) as SensemakingResponse;

    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;

    expect(res.overview.citedStatementIds).toEqual([]);
    expect(res.overview.summary).not.toContain("不實概論文本");
    expect(res.overview.summary).toContain("人工智慧監管討論");
    expect(res.overview.summary).toContain("審議綜整");
  });

  it("Overview 引用超過 5 則合約上限時中立化為確定性結構句且空引用，不截斷保留模型文本", async () => {
    const { mathResult } = createMockMathResult();
    const statements = [
      { sid: 1, text: "s1" },
      { sid: 2, text: "s2" },
      { sid: 3, text: "s3" },
      { sid: 4, text: "s4" },
      { sid: 5, text: "s5" },
      { sid: 6, text: "s6" },
      { sid: 9, text: "s9" },
    ];

    const aiRun = vi.fn();
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        topics: [
          { id: "t1", title: "Theme 1", description: "Desc 1" },
          { id: "t2", title: "Theme 2", description: "Desc 2" },
          { id: "t3", title: "Theme 3", description: "Desc 3" },
        ],
      }),
    });
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        assignments: [
          { sid: 1, primaryTopicId: "t1", secondaryTopicId: null },
          { sid: 2, primaryTopicId: "t2", secondaryTopicId: null },
          { sid: 3, primaryTopicId: "t3", secondaryTopicId: null },
          { sid: 4, primaryTopicId: "t1", secondaryTopicId: null },
          { sid: 5, primaryTopicId: "t2", secondaryTopicId: null },
          { sid: 6, primaryTopicId: "t3", secondaryTopicId: null },
          { sid: 9, primaryTopicId: "t1", secondaryTopicId: null },
        ],
      }),
    });

    // 模型回傳了 6 則合法的 overview 引用 (超過 1..5 則合約上限) 與自造文本
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        overview: {
          summary: "模型生成了超過引用上限的概論文本，不應被採納。",
          citedStatementIds: [1, 2, 3, 4, 5, 9],
        },
        commonGround: { keyPoints: [] },
        groupPortraits: [],
        tensions: [],
      }),
    });

    const mockAi = { run: aiRun } as unknown as Ai;
    const res = (await generateSensemaking({
      ai: mockAi,
      reserveGlobal: async () => true,
      lang: "zh",
      title: "人工智慧監管討論",
      description: "探討規範架構",
      mathResult,
      statements,
      mathRevision: 1,
      now: 1000,
    })) as SensemakingResponse;

    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;

    expect(res.overview.citedStatementIds).toEqual([]);
    expect(res.overview.summary).not.toContain("超過引用上限的概論文本");
    expect(res.overview.summary).toContain("人工智慧監管討論");
    expect(res.overview.summary).toContain("審議綜整");
  });

  it("共識點若引用混合方向（同時引用同意與不同意共識）則整條捨棄", async () => {
    const { mathResult } = createMockMathResult();
    // 手動加入同意共識 sid 9 與不同意共識 sid 8
    mathResult.consensus.disagree.push({ sid: 8, prob: 0.95 });
    const statements = [
      { sid: 1, text: "s1" },
      { sid: 2, text: "s2" },
      { sid: 3, text: "s3" },
      { sid: 8, text: "s8" },
      { sid: 9, text: "s9" },
    ];

    const aiRun = vi.fn();
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        topics: [
          { id: "t1", title: "Theme 1", description: "Desc 1" },
          { id: "t2", title: "Theme 2", description: "Desc 2" },
          { id: "t3", title: "Theme 3", description: "Desc 3" },
        ],
      }),
    });
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        assignments: [
          { sid: 1, primaryTopicId: "t1", secondaryTopicId: null },
          { sid: 2, primaryTopicId: "t2", secondaryTopicId: null },
          { sid: 3, primaryTopicId: "t3", secondaryTopicId: null },
          { sid: 8, primaryTopicId: "t1", secondaryTopicId: null },
          { sid: 9, primaryTopicId: "t2", secondaryTopicId: null },
        ],
      }),
    });

    // 模型回傳了一條同時引用 sid 9 (agree) 與 sid 8 (disagree) 的混合方向 keyPoint
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        overview: { summary: "Overview", citedStatementIds: [9] },
        commonGround: {
          keyPoints: [
            {
              title: "混合方向共識點（應被捨棄）",
              description: "同時引用了同意與不同意共識",
              citedStatementIds: [9, 8],
            },
            {
              title: "純同意共識點（應保留）",
              description: "全體一致同意之原則",
              citedStatementIds: [9],
            },
          ],
        },
        groupPortraits: [],
        tensions: [],
      }),
    });

    const mockAi = { run: aiRun } as unknown as Ai;
    const res = (await generateSensemaking({
      ai: mockAi,
      reserveGlobal: async () => true,
      lang: "zh",
      title: "Title",
      description: "Desc",
      mathResult,
      statements,
      mathRevision: 1,
      now: 1000,
    })) as SensemakingResponse;

    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;

    // 驗證混合方向的第 1 條被剔除，只有第 2 條純同意點保留
    expect(res.commonGround.keyPoints).toHaveLength(1);
    expect(res.commonGround.keyPoints[0]!.title).toBe("純同意共識點（應保留）");
    expect(res.commonGround.keyPoints[0]!.direction).toBe("agree");
  });

  it("張力引用若含未在兩群均觀測到的陳述（部分有效如 [1, unseen]），嚴格 Fail Closed 捨棄整條張力", async () => {
    const { mathResult } = createMockMathResult();
    // 模擬 sid 5 在 Group 1 的 seen 為 0
    const g1 = mathResult.groups.find((g) => g.id === 1)!;
    const g1Stat5 = g1.statementStats?.find((s) => s.sid === 5);
    if (g1Stat5) g1Stat5.seen = 0;

    const statements = [
      { sid: 1, text: "s1" },
      { sid: 2, text: "s2" },
      { sid: 3, text: "s3" },
      { sid: 5, text: "s5" },
      { sid: 9, text: "s9" },
    ];

    const aiRun = vi.fn();
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        topics: [
          { id: "t1", title: "Theme 1", description: "Desc 1" },
          { id: "t2", title: "Theme 2", description: "Desc 2" },
          { id: "t3", title: "Theme 3", description: "Desc 3" },
        ],
      }),
    });
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        assignments: [
          { sid: 1, primaryTopicId: "t1", secondaryTopicId: null },
          { sid: 2, primaryTopicId: "t2", secondaryTopicId: null },
          { sid: 3, primaryTopicId: "t3", secondaryTopicId: null },
          { sid: 5, primaryTopicId: "t1", secondaryTopicId: null },
          { sid: 9, primaryTopicId: "t2", secondaryTopicId: null },
        ],
      }),
    });

    // 模型回傳張力 1 引用了 [1, 5]（sid 5 在 Group 1 seen=0，部分違規）；張力 2 引用了合法 [1]
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        overview: { summary: "Overview", citedStatementIds: [1] },
        commonGround: { keyPoints: [] },
        groupPortraits: [],
        tensions: [
          {
            groupAId: 0,
            groupBId: 1,
            topic: "部分無效張力（應被整條捨棄）",
            groupAPerspective: "A",
            groupBPerspective: "B",
            tensions: "T",
            bridgingQuestion: "Q",
            citedStatementIds: [1, 5],
          },
          {
            groupAId: 0,
            groupBId: 1,
            topic: "純合法張力（應保留）",
            groupAPerspective: "A",
            groupBPerspective: "B",
            tensions: "T",
            bridgingQuestion: "Q",
            citedStatementIds: [1],
          },
        ],
      }),
    });

    const mockAi = { run: aiRun } as unknown as Ai;
    const res = (await generateSensemaking({
      ai: mockAi,
      reserveGlobal: async () => true,
      lang: "zh",
      title: "Title",
      description: "Desc",
      mathResult,
      statements,
      mathRevision: 1,
      now: 1000,
    })) as SensemakingResponse;

    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;

    // 驗證含有未觀測 sid 的張力整條被捨棄，只保留純合法張力
    expect(res.tensions).toHaveLength(1);
    expect(res.tensions[0]!.topic).toBe("純合法張力（應保留）");
    expect(res.tensions[0]!.citedStatementIds).toEqual([1]);
  });

  it("共識點若 raw 引用超過 4 則視為合約違規整條捨棄，不截斷保留", async () => {
    const { mathResult } = createMockMathResult();
    const statements = [
      { sid: 1, text: "s1" },
      { sid: 2, text: "s2" },
      { sid: 3, text: "s3" },
      { sid: 9, text: "s9" },
    ];

    const aiRun = vi.fn();
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        topics: [
          { id: "t1", title: "Theme 1", description: "Desc 1" },
          { id: "t2", title: "Theme 2", description: "Desc 2" },
          { id: "t3", title: "Theme 3", description: "Desc 3" },
        ],
      }),
    });
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        assignments: [
          { sid: 1, primaryTopicId: "t1", secondaryTopicId: null },
          { sid: 2, primaryTopicId: "t2", secondaryTopicId: null },
          { sid: 3, primaryTopicId: "t3", secondaryTopicId: null },
          { sid: 9, primaryTopicId: "t1", secondaryTopicId: null },
        ],
      }),
    });

    // 模型回傳了 5 則引用的共識點（合約上限 4）
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        overview: { summary: "Overview", citedStatementIds: [9] },
        commonGround: {
          keyPoints: [
            {
              title: "超額引用共識點",
              description: "引用了 5 個 sid 違反 1..4 上限",
              citedStatementIds: [9, 9, 9, 9, 9],
            },
          ],
        },
        groupPortraits: [],
        tensions: [],
      }),
    });

    const mockAi = { run: aiRun } as unknown as Ai;
    const res = (await generateSensemaking({
      ai: mockAi,
      reserveGlobal: async () => true,
      lang: "zh",
      title: "Title",
      description: "Desc",
      mathResult,
      statements,
      mathRevision: 1,
      now: 1000,
    })) as SensemakingResponse;

    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;

    // 模型產生的 keyPoint 被整條捨棄，由確定性備援共識接管
    expect(res.commonGround.keyPoints).toHaveLength(1);
    expect(res.commonGround.keyPoints[0]!.title).not.toBe("超額引用共識點");
  });

  it("群體畫像若 keyStances 格式錯誤、非代表性或重複，中立化為確定性中立標題與摘要", async () => {
    const { mathResult } = createMockMathResult();
    const statements = [
      { sid: 1, text: "s1" },
      { sid: 2, text: "s2" },
      { sid: 3, text: "s3" },
      { sid: 9, text: "s9" },
    ];

    const aiRun = vi.fn();
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        topics: [
          { id: "t1", title: "Theme 1", description: "Desc 1" },
          { id: "t2", title: "Theme 2", description: "Desc 2" },
          { id: "t3", title: "Theme 3", description: "Desc 3" },
        ],
      }),
    });
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        assignments: [
          { sid: 1, primaryTopicId: "t1", secondaryTopicId: null },
          { sid: 2, primaryTopicId: "t2", secondaryTopicId: null },
          { sid: 3, primaryTopicId: "t3", secondaryTopicId: null },
          { sid: 9, primaryTopicId: "t1", secondaryTopicId: null },
        ],
      }),
    });

    // 模型回傳了 Group 0 的畫像，但 keyStances 引用了非代表性 sid 999
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        overview: { summary: "Overview", citedStatementIds: [1] },
        commonGround: { keyPoints: [] },
        groupPortraits: [
          {
            groupId: 0,
            title: "模型生造標題",
            summary: "模型生造摘要",
            keyStances: [{ sid: 999, summary: "無效陳述" }],
          },
        ],
        tensions: [],
      }),
    });

    const mockAi = { run: aiRun } as unknown as Ai;
    const res = (await generateSensemaking({
      ai: mockAi,
      reserveGlobal: async () => true,
      lang: "zh",
      title: "Title",
      description: "Desc",
      mathResult,
      statements,
      mathRevision: 1,
      now: 1000,
    })) as SensemakingResponse;

    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;

    const p0 = res.groupPortraits.find((p) => p.groupId === 0)!;
    expect(p0.title).toBe("第 A 群觀點");
    expect(p0.summary).toContain("位參與者呈現此群體的代表性投票特徵");
    expect(p0.title).not.toContain("模型生造標題");
  });
  it("Gemma 回傳標題／數字／裸陣列／snake_case 時仍正確歸類，不整批落入 other", async () => {
    const { mathResult } = createMockMathResult();
    const statements = [
      { sid: 1, text: "Fund large-scale procurement via a special budget." },
      { sid: 2, text: "Prioritize domestically built weapons." },
      { sid: 3, text: "The legislature needs real oversight of classified budgets." },
    ];

    const aiRun = vi.fn();
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        topics: [
          { id: "t1", title: "Fiscal Strategy", description: "How to fund defense spending" },
          { id: "t2", title: "Procurement Mix", description: "Import versus domestic industry" },
          { id: "t3", title: "Legislative Oversight", description: "Transparency and audit" },
        ],
      }),
    });
    // 模擬 EN Gemma 常見走樣：前言 + 裸陣列、標題當 id、數字 id、snake_case、字串 sid
    aiRun.mockResolvedValueOnce({
      response:
        "Here are the assignments:\n" +
        JSON.stringify([
          { statement_id: "1", primary_topic_id: "Fiscal Strategy", secondary_topic_id: null },
          { sid: 2, primaryTopicId: 2 },
          { statementId: 3, topicId: "T3" },
        ]),
    });
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        overview: { summary: "Sum", citedStatementIds: [1] },
        commonGround: { keyPoints: [] },
        groupPortraits: [],
        tensions: [],
      }),
    });

    const mockAi = { run: aiRun } as unknown as Ai;
    const res = (await generateSensemaking({
      ai: mockAi,
      reserveGlobal: async () => true,
      lang: "en",
      title: "Defense budget",
      description: "Simulated referendum",
      mathResult,
      statements,
      mathRevision: 1,
      now: 1000,
    })) as SensemakingResponse;

    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;
    expect(res.themes.find((t) => t.id === "other")).toBeUndefined();
    expect(res.themes.find((t) => t.id === "t1")?.primaryStatementIds).toEqual([1]);
    expect(res.themes.find((t) => t.id === "t2")?.primaryStatementIds).toEqual([2]);
    expect(res.themes.find((t) => t.id === "t3")?.primaryStatementIds).toEqual([3]);
  });

  it("Workers AI thinking/text 區塊陣列被剝除後仍能解析 JSON 歸類", async () => {
    const { mathResult } = createMockMathResult();
    const statements = [
      { sid: 1, text: "s1" },
      { sid: 2, text: "s2" },
      { sid: 3, text: "s3" },
    ];
    const topics = [
      { id: "t1", title: "Theme 1", description: "Desc 1" },
      { id: "t2", title: "Theme 2", description: "Desc 2" },
      { id: "t3", title: "Theme 3", description: "Desc 3" },
    ];
    const aiRun = vi.fn();
    aiRun.mockResolvedValueOnce({
      response: [
        { type: "thinking", content: "I will invent ids that must be ignored." },
        { type: "text", content: JSON.stringify({ topics }) },
      ],
    });
    aiRun.mockResolvedValueOnce({
      response: [
        { type: "thinking", content: "[{sid:1, primaryTopicId:'nope'}]" },
        {
          type: "text",
          content: JSON.stringify({
            assignments: [
              { sid: 1, primaryTopicId: "t1" },
              { sid: 2, primaryTopicId: "t2" },
              { sid: 3, primaryTopicId: "t3" },
            ],
          }),
        },
      ],
    });
    aiRun.mockResolvedValueOnce({
      response: JSON.stringify({
        overview: { summary: "Sum", citedStatementIds: [1] },
        commonGround: { keyPoints: [] },
        groupPortraits: [],
        tensions: [],
      }),
    });

    const mockAi = { run: aiRun } as unknown as Ai;
    const res = (await generateSensemaking({
      ai: mockAi,
      reserveGlobal: async () => true,
      lang: "en",
      title: "Title",
      description: "Desc",
      mathResult,
      statements,
      mathRevision: 1,
      now: 1000,
    })) as SensemakingResponse;

    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;
    expect(res.themes.find((t) => t.id === "other")).toBeUndefined();
    expect(res.themes.find((t) => t.id === "t1")?.primaryStatementIds).toEqual([1]);
    expect(res.themes.find((t) => t.id === "t2")?.primaryStatementIds).toEqual([2]);
    expect(res.themes.find((t) => t.id === "t3")?.primaryStatementIds).toEqual([3]);
    const payload = aiRun.mock.calls[0]![1] as { chat_template_kwargs?: { enable_thinking?: boolean } };
    expect(payload.chat_template_kwargs?.enable_thinking).toBe(false);
  });

  it("AI 呼叫拋出異常時回傳確定性統計摘要，不宣稱 Gemma、不崩潰", async () => {
    const { mathResult } = createMockMathResult();
    const aiRun = vi.fn().mockRejectedValue(new Error("Cloudflare AI Gateway 429 Rate Limit"));
    const mockAi = { run: aiRun } as unknown as Ai;

    const res = await generateSensemaking({
      ai: mockAi,
      reserveGlobal: async () => true,
      lang: "en",
      title: "Title",
      description: "Desc",
      mathResult,
      statements: [
        { sid: 1, text: "s1" },
        { sid: 2, text: "s2" },
        { sid: 3, text: "s3" },
      ],
      mathRevision: 1,
      now: 1000,
    });

    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;
    expect(res.generationMode).toBe("deterministic");
    expect(res.model).toBe("deterministic");
    expect(res.model).not.toContain("gemma");
    const covered = new Set(res.themes.flatMap((t) => t.statementIds));
    expect([...covered].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

// ---- 可報告群（k-匿名）與張力配對證據 ----

function stat(sid: number, agrees: number, disagrees: number, passes = 0): StatementStat {
  return { sid, agrees, disagrees, passes, seen: agrees + disagrees + passes };
}

/** 手工三群結果：群 0 與群 1 對 s1 完全一致（都同意），群 2 不同意；s2 三群皆一致；s3 群 0 與群 1 分歧 */
function threeGroupMathResult(sizes: [number, number, number] = [10, 10, 10]): MathResult {
  const mk = (id: number, label: string, size: number, s1: [number, number], s3: [number, number]) => ({
    id,
    label,
    size,
    center: [id, id] as [number, number],
    representative: [],
    statementStats: [stat(1, s1[0], s1[1]), stat(2, size, 0), stat(3, s3[0], s3[1]), stat(4, size, 0)],
  });
  const total = sizes[0] + sizes[1] + sizes[2];
  return {
    nParticipantsTotal: total,
    nParticipantsClustered: total,
    nStatements: 4,
    nVotes: total * 4,
    k: 3,
    inclusionThreshold: 4,
    computedAt: 1000,
    points: [],
    statementStats: [stat(1, sizes[0] + sizes[1], sizes[2]), stat(2, total, 0), stat(3, sizes[0] + sizes[2], sizes[1]), stat(4, total, 0)],
    consensus: { agree: [], disagree: [] },
    groups: [
      mk(0, "A", sizes[0], [sizes[0], 0], [sizes[0], 0]),
      mk(1, "B", sizes[1], [sizes[1], 0], [0, sizes[1]]),
      mk(2, "C", sizes[2], [0, sizes[2]], [sizes[2], 0]),
    ],
  } as MathResult;
}

const fourStatements = [
  { sid: 1, text: "statement one" },
  { sid: 2, text: "statement two" },
  { sid: 3, text: "statement three" },
  { sid: 4, text: "statement four" },
];

function queuePhases(aiRun: ReturnType<typeof vi.fn>, synthesis: unknown) {
  aiRun.mockResolvedValueOnce({
    response: JSON.stringify({
      topics: [
        { id: "t1", title: "Topic one", description: "d1" },
        { id: "t2", title: "Topic two", description: "d2" },
        { id: "t3", title: "Topic three", description: "d3" },
      ],
    }),
  });
  aiRun.mockResolvedValueOnce({
    response: JSON.stringify({
      assignments: fourStatements.map((s, i) => ({ sid: s.sid, primaryTopicId: `t${(i % 3) + 1}`, secondaryTopicId: null })),
    }),
  });
  aiRun.mockResolvedValueOnce({ response: JSON.stringify(synthesis) });
}

describe("可報告群：低於 MIN_GROUP_STATS_SIZE 的群不進提示、不被畫像、不可被張力指名", () => {
  it("單人群的代表性方向不會送進 Workers AI，模型替它產出的畫像與張力一律捨棄", async () => {
    const mathResult = threeGroupMathResult([10, 10, 1]);
    // 單人群 C 有一句退而求其次的代表性陳述（就是那個人的投票）
    mathResult.groups[2]!.representative = [
      { sid: 1, direction: "disagree", prob: 0.67, probTest: 0.5, repness: 3, repnessTest: 0.5, metric: 1, nSuccess: 1, nSeen: 1 },
    ];
    const aiRun = vi.fn();
    queuePhases(aiRun, {
      overview: { summary: "S", citedStatementIds: [1] },
      commonGround: { keyPoints: [] },
      groupPortraits: [
        { groupId: 0, title: "A", summary: "a", keyStances: [] },
        { groupId: 2, title: "Lone voter", summary: "c", keyStances: [{ sid: 1, summary: "x" }] },
      ],
      tensions: [
        { groupAId: 0, groupBId: 2, topic: "A vs C", groupAPerspective: "a", groupBPerspective: "c", tensions: "t", bridgingQuestion: "q", citedStatementIds: [1] },
        { groupAId: 0, groupBId: 1, topic: "A vs B on s3", groupAPerspective: "a", groupBPerspective: "b", tensions: "t", bridgingQuestion: "q", citedStatementIds: [3] },
      ],
    });
    const res = (await generateSensemaking({
      ai: { run: aiRun } as unknown as Ai,
      reserveGlobal: async () => true,
      lang: "en",
      title: "Title",
      description: "Desc",
      mathResult,
      statements: fourStatements,
      mathRevision: 1,
      now: 1000,
    })) as SensemakingResponse;
    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;

    const synthesisPayload = aiRun.mock.calls[2]![1] as { messages: { content: string }[] };
    const userPrompt = synthesisPayload.messages[1]!.content;
    expect(userPrompt).toContain("Group A (ID 0");
    expect(userPrompt).toContain("Group B (ID 1");
    expect(userPrompt).not.toContain("Group C");
    expect(userPrompt).not.toContain("(ID 2");
    expect(userPrompt).toContain("(2 large enough to report");

    expect(res.groupPortraits.map((p) => p.groupId)).toEqual([0, 1]);
    expect(res.tensions).toHaveLength(1);
    expect(res.tensions[0]!.groupAId).toBe(0);
    expect(res.tensions[0]!.groupBId).toBe(1);
    expect(res.tensions[0]!.citedStatementIds).toEqual([3]);
    expect(res.provenance.groupCount).toBe(3);
  });

  it("確定性 fallback 的畫像與「代表性意見」主題只含可報告群", () => {
    const mathResult = threeGroupMathResult([10, 10, MIN_GROUP_STATS_SIZE - 1]);
    mathResult.groups[2]!.representative = [
      { sid: 4, direction: "agree", prob: 0.67, probTest: 0.5, repness: 3, repnessTest: 0.5, metric: 1, nSuccess: 1, nSeen: 1 },
    ];
    mathResult.groups[0]!.representative = [
      { sid: 3, direction: "agree", prob: 0.9, probTest: 1, repness: 3, repnessTest: 1, metric: 1, nSuccess: 10, nSeen: 10 },
    ];
    const det = generateDeterministicSensemaking({
      lang: "en",
      title: "T",
      mathResult,
      statements: fourStatements,
      mathRevision: 1,
      now: 1000,
    });
    expect(det.groupPortraits.map((p) => p.groupId)).toEqual([0, 1]);
    for (const tn of det.tensions) {
      expect([tn.groupAId, tn.groupBId]).not.toContain(2);
    }
    const titles = det.themes.map((t) => t.title);
    expect(titles).toContain("Distinctive to group A");
    expect(titles.some((t) => t.includes("group C"))).toBe(false);
    // 小群的陳述仍由「全部意見」主題涵蓋
    const all = det.themes.flatMap((t) => t.statementIds);
    expect(all).toContain(4);
  });
});

describe("共識排序不受無統計小群影響", () => {
  it("rankConsensusSids 跳過空的群統計，強證據仍排在前面而非退化為 sid 順序", () => {
    const groupStatsMap = new Map<number, Map<number, StatementStat>>([
      [0, new Map([[1, stat(1, 12, 8)], [2, stat(2, 15, 5)], [9, stat(9, 20, 0)]])],
      [1, new Map([[1, stat(1, 11, 9)], [2, stat(2, 16, 4)], [9, stat(9, 20, 0)]])],
      [2, new Map()], // 小群：無統計
    ]);
    const groups = [{ id: 0 }, { id: 1 }, { id: 2 }];
    expect(rankConsensusSids([1, 2, 9], groupStatsMap, groups)).toEqual([9, 2, 1]);
  });
});

describe("張力配對證據：引用必須真的區分被指名的那一對群體", () => {
  it("distinguishesPair：極差 >= 0.35 才成立；代表性陳述只在恰好兩個可報告群時當作證據", () => {
    const m = threeGroupMathResult();
    const buckets = computeEvidenceBuckets(m, [1, 2, 3, 4]);
    const [gA, gB, gC] = m.groups as [MathResult["groups"][0], MathResult["groups"][0], MathResult["groups"][0]];
    // s1：A/B 一致（都 100% 同意），C 不同意
    expect(distinguishesPair(buckets.groupStatsMap, 3, 1, gA, gB)).toBe(false);
    expect(distinguishesPair(buckets.groupStatsMap, 3, 1, gA, gC)).toBe(true);
    // s2：三群一致
    expect(distinguishesPair(buckets.groupStatsMap, 3, 2, gA, gC)).toBe(false);
    // 代表性陳述規則：三群時不算，雙群時算
    const withRep = { ...gA, representative: [{ sid: 2, direction: "agree" as const, prob: 1, probTest: 1, repness: 1, repnessTest: 1, metric: 1, nSuccess: 10, nSeen: 10 }] };
    expect(distinguishesPair(buckets.groupStatsMap, 3, 2, withRep, gB)).toBe(false);
    expect(distinguishesPair(buckets.groupStatsMap, 2, 2, withRep, gB)).toBe(true);
    // 任一群無觀測即不成立
    const noObs = new Map(buckets.groupStatsMap);
    noObs.set(gC.id, new Map([[1, stat(1, 0, 0)]]));
    expect(distinguishesPair(noObs, 3, 1, gA, gC)).toBe(false);
  });

  it("三群以上：模型把 A/B 一致的陳述指名為 A/B 張力會被整條捨棄，指名真正分歧的一對才保留", async () => {
    const mathResult = threeGroupMathResult();
    const aiRun = vi.fn();
    queuePhases(aiRun, {
      overview: { summary: "S", citedStatementIds: [1] },
      commonGround: { keyPoints: [] },
      groupPortraits: [],
      tensions: [
        // s1 在張力池（因 C 不同）但 A/B 對 s1 完全一致 → 捨棄
        { groupAId: 0, groupBId: 1, topic: "bogus A vs B", groupAPerspective: "a", groupBPerspective: "b", tensions: "t", bridgingQuestion: "q", citedStatementIds: [1] },
        // s1 真正區分 A 與 C → 保留
        { groupAId: 0, groupBId: 2, topic: "real A vs C", groupAPerspective: "a", groupBPerspective: "c", tensions: "t", bridgingQuestion: "q", citedStatementIds: [1] },
        // 混入一筆不區分該對的引用（s2 三群一致）→ 整條捨棄
        { groupAId: 1, groupBId: 2, topic: "mixed B vs C", groupAPerspective: "b", groupBPerspective: "c", tensions: "t", bridgingQuestion: "q", citedStatementIds: [1, 2] },
      ],
    });
    const res = (await generateSensemaking({
      ai: { run: aiRun } as unknown as Ai,
      reserveGlobal: async () => true,
      lang: "en",
      title: "Title",
      description: "Desc",
      mathResult,
      statements: fourStatements,
      mathRevision: 1,
      now: 1000,
    })) as SensemakingResponse;
    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;
    expect(res.tensions.map((t) => [t.groupAId, t.groupBId, t.topic])).toEqual([[0, 2, "real A vs C"]]);
  });

  it("確定性 fallback 依實際極差選配對，不寫死最大兩群；無證據則不產生張力", () => {
    const m = threeGroupMathResult([12, 11, 10]);
    const buckets = computeEvidenceBuckets(m, [1, 2, 3, 4]);
    // s1 區分 (A,C)、(B,C)；s3 區分 (A,B)、(B,C)。B/C 兩筆證據最多 → 選 B/C
    const pair = pickDeterministicTensionPair(m.groups, buckets.groupStatsMap, buckets.eligibleTensionSids, new Set([1, 2, 3, 4]));
    expect(pair).not.toBeNull();
    expect([pair!.gA.id, pair!.gB.id]).toEqual([1, 2]);
    expect(pair!.cites.sort()).toEqual([1, 3]);

    const det = generateDeterministicSensemaking({ lang: "zh", title: "T", mathResult: m, statements: fourStatements, mathRevision: 1, now: 1 });
    expect(det.tensions).toHaveLength(1);
    expect([det.tensions[0]!.groupAId, det.tensions[0]!.groupBId]).toEqual([1, 2]);
    for (const sid of det.tensions[0]!.citedStatementIds) {
      expect(distinguishesPair(buckets.groupStatsMap, 3, sid, m.groups[1]!, m.groups[2]!)).toBe(true);
    }

    // 三群對每一句都一致 → 張力池空 → 無張力
    const flat = threeGroupMathResult();
    for (const g of flat.groups) g.statementStats = [stat(1, g.size, 0), stat(2, g.size, 0), stat(3, g.size, 0), stat(4, g.size, 0)];
    const flatDet = generateDeterministicSensemaking({ lang: "en", title: "T", mathResult: flat, statements: fourStatements, mathRevision: 1, now: 1 });
    expect(flatDet.tensions).toEqual([]);
  });
});
