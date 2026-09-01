import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  CATEGORIZE_BATCH_PROMPT_MAX_BYTES,
  CATEGORIZE_BATCH_SIZE,
  CATEGORIZE_MAX_OUTPUT_TOKENS,
  CHAT_TEMPLATE_OVERHEAD_TOKENS,
  DISCOVER_MAX_OUTPUT_TOKENS,
  DISCOVERY_PROMPT_MAX_BYTES,
  formatStatementsUtf8,
  GENERATION_NEURON_CEILING,
  inputTokenUpperBound,
  MAX_CONSENSUS_PROMPT_STATEMENTS,
  MAX_TENSION_PROMPT_STATEMENTS,
  NEURONS_PER_M_INPUT,
  NEURONS_PER_M_OUTPUT,
  NeuronLedger,
  neuronsForCall,
  neuronsForPrompts,
  QUEUE_MAX_RETRIES,
  QUEUE_OPS_UPPER_BOUND_ONE_REVISION,
  SYNTHESIS_MAX_OUTPUT_TOKENS,
  SYNTHESIS_PROMPT_MAX_BYTES,
  synthesisPhaseHoldNeurons,
  truncateUtf8,
  utf8ByteLength,
} from "../src/ai-budget";
import { computeMath } from "../src/math/pipeline";
import type { VoteRow } from "../src/math/types";
import {
  generateSensemaking,
  rankConsensusSids,
  type SensemakingResponse,
} from "../src/sensemaking";

function clusteredMath() {
  const votes: VoteRow[] = [];
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
    conversationId: "budget-test",
    statementIds: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    votes,
    computedAt: 1000,
    previousK: null,
  });
  return publicResult;
}

function payloadNeurons(payload: { messages: { content: string }[]; max_tokens: number }): number {
  const sys = payload.messages[0]?.content ?? "";
  const user = payload.messages[1]?.content ?? "";
  return neuronsForPrompts(sys, user, payload.max_tokens);
}

describe("UTF-8 byte bound (not JS string.length)", () => {
  it("測 is 3 bytes and truncateUtf8 never keeps more bytes than the cap", () => {
    expect(utf8ByteLength("測")).toBe(3);
    expect("測".repeat(10).length).toBe(10);
    expect(utf8ByteLength("測".repeat(10))).toBe(30);
    const sliced = truncateUtf8("測".repeat(10), 10);
    expect(utf8ByteLength(sliced)).toBeLessThanOrEqual(10);
    expect(sliced.length).toBeLessThanOrEqual(3);
    expect(utf8ByteLength(sliced)).toBeLessThan(30);
  });

  it("formatStatementsUtf8 keeps every sid even when text is truncated to empty", () => {
    const statements = Array.from({ length: 20 }, (_, i) => ({ sid: i + 1, text: "測".repeat(40) }));
    const out = formatStatementsUtf8(statements, 400);
    for (let i = 1; i <= 20; i++) {
      expect(out).toContain(`[#${i}]`);
    }
    expect(utf8ByteLength(out)).toBeLessThanOrEqual(400);
  });

  it("fails closed when even statement IDs cannot fit the byte cap", () => {
    const statements = Array.from({ length: 20 }, (_, i) => ({ sid: i + 1, text: "x" }));
    expect(() => formatStatementsUtf8(statements, 10)).toThrow(/formatStatementsUtf8/);
    expect(() => formatStatementsUtf8([{ sid: 1, text: "hello" }], 0)).toThrow(/formatStatementsUtf8/);
  });

  it("returns ID-only form when spaced headers overflow but compact IDs fit", () => {
    const statements = [
      { sid: 1, text: "aaaa" },
      { sid: 2, text: "bbbb" },
    ];
    const idOnly = "[#1]\n[#2]";
    expect(utf8ByteLength(idOnly)).toBe(9);
    const out = formatStatementsUtf8(statements, 10);
    expect(out).toBe(idOnly);
    expect(utf8ByteLength(out)).toBeLessThanOrEqual(10);
    expect(out).toContain("[#1]");
    expect(out).toContain("[#2]");
  });

  it("configured discovery and categorize caps still fit all 800 IDs", () => {
    const statements = Array.from({ length: 800 }, (_, i) => ({ sid: i + 1, text: "測".repeat(280) }));
    const discovery = formatStatementsUtf8(statements, DISCOVERY_PROMPT_MAX_BYTES);
    for (let i = 1; i <= 800; i++) {
      expect(discovery).toContain(`[#${i}]`);
    }
    expect(utf8ByteLength(discovery)).toBeLessThanOrEqual(DISCOVERY_PROMPT_MAX_BYTES);

    const batch = statements.slice(0, CATEGORIZE_BATCH_SIZE);
    const cat = formatStatementsUtf8(batch, CATEGORIZE_BATCH_PROMPT_MAX_BYTES);
    for (const s of batch) {
      expect(cat).toContain(`[#${s.sid}]`);
    }
    expect(utf8ByteLength(cat)).toBeLessThanOrEqual(CATEGORIZE_BATCH_PROMPT_MAX_BYTES);
  });

  it("inputTokenUpperBound uses UTF-8 bytes plus template overhead, not char length", () => {
    const cjk = "測".repeat(10);
    expect(inputTokenUpperBound(cjk, "")).toBe(30 + CHAT_TEMPLATE_OVERHEAD_TOKENS);
    expect(inputTokenUpperBound(cjk, "")).not.toBe(10 + CHAT_TEMPLATE_OVERHEAD_TOKENS);
  });
});

describe("NeuronLedger concurrent reservation", () => {
  it("shares one ledger without overshoot under concurrent tryReserve", async () => {
    const ledger = new NeuronLedger(100);
    const results = await Promise.all([40, 40, 40].map(async (n) => ledger.tryReserve(n)));
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(ledger.reserved).toBe(80);
    expect(ledger.reserved).toBeLessThanOrEqual(ledger.ceiling);
  });
});

describe("Queue op bound is not neurons", () => {
  it("one revision <64KB max_retries comes from wrangler.jsonc, not a copied constant", () => {
    const wranglerText = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const wrangler = JSON.parse(
      wranglerText
        .split("\n")
        .filter((line) => !/^\s*\/\//.test(line))
        .join("\n"),
    ) as {
      queues: { consumers: { max_retries: number }[] };
      env: { production: { queues: { consumers: { max_retries: number }[] } } };
    };
    const topRetries = wrangler.queues.consumers[0]!.max_retries;
    const prodRetries = wrangler.env.production.queues.consumers[0]!.max_retries;
    expect(topRetries).toBe(1);
    expect(prodRetries).toBe(1);
    expect(QUEUE_MAX_RETRIES).toBe(topRetries);
    expect(QUEUE_MAX_RETRIES).toBe(prodRetries);
    expect(QUEUE_OPS_UPPER_BOUND_ONE_REVISION).toBe(1 + (1 + topRetries) + 1);
    expect(QUEUE_OPS_UPPER_BOUND_ONE_REVISION).toBe(4);
    expect(QUEUE_OPS_UPPER_BOUND_ONE_REVISION).not.toBe(GENERATION_NEURON_CEILING);
  });
});

describe("evidence caps", () => {
  it("rankConsensusSids then slice never exceeds MAX_CONSENSUS_PROMPT_STATEMENTS", () => {
    const groupStatsMap = new Map<number, Map<number, { sid: number; agrees: number; disagrees: number; passes: number; seen: number }>>();
    groupStatsMap.set(0, new Map());
    groupStatsMap.set(1, new Map());
    const sids = Array.from({ length: 80 }, (_, i) => i + 1);
    const ranked = rankConsensusSids(sids, groupStatsMap as never, [{ id: 0 }, { id: 1 }]);
    expect(ranked.slice(0, MAX_CONSENSUS_PROMPT_STATEMENTS)).toHaveLength(MAX_CONSENSUS_PROMPT_STATEMENTS);
    expect(MAX_CONSENSUS_PROMPT_STATEMENTS).toBe(24);
    expect(MAX_TENSION_PROMPT_STATEMENTS).toBe(24);
  });
});

describe("generateSensemaking 免費額度硬上限", () => {
  it("800×280 CJK statements never cross the 9000 neuron ceiling", async () => {
    const mathResult = clusteredMath();
    const glyph = "測";
    expect(utf8ByteLength(glyph)).toBe(3);
    const text = glyph.repeat(280);
    expect(text.length).toBe(280);
    expect(utf8ByteLength(text)).toBe(840);

    const statements = Array.from({ length: 800 }, (_, i) => ({ sid: i + 1, text }));

    const calls: { messages: { content: string }[]; max_tokens: number }[] = [];
    const aiRun = vi.fn(async (_model: string, payload: { messages: { content: string }[]; max_tokens: number }) => {
      calls.push(payload);
      const sys = payload.messages[0]?.content ?? "";
      const user = payload.messages[1]?.content ?? "";
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
        const sids = [...user.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]));
        return {
          response: JSON.stringify({
            assignments: sids.map((sid) => ({ sid, primaryTopicId: "t1", secondaryTopicId: null })),
          }),
        };
      }
      return {
        response: JSON.stringify({
          overview: { summary: "Sum", citedStatementIds: [9] },
          commonGround: { keyPoints: [] },
          groupPortraits: [],
          tensions: [],
        }),
      };
    });

    const res = (await generateSensemaking({
      ai: { run: aiRun } as unknown as Ai,
      lang: "zh",
      title: "國防",
      description: "預算",
      mathResult,
      statements,
      mathRevision: 1,
      now: 1000,
    })) as SensemakingResponse;

    expect(res.status).toBe("ready");

    const discoverCalls = calls.filter((p) => (p.messages[0]?.content ?? "").includes("mutually exclusive"));
    const categorizeCalls = calls.filter((p) => (p.messages[0]?.content ?? "").includes("precise classifier"));
    expect(discoverCalls).toHaveLength(1);
    expect(categorizeCalls).toHaveLength(Math.ceil(800 / CATEGORIZE_BATCH_SIZE));

    let reserved = synthesisPhaseHoldNeurons();
    for (const p of calls) {
      const sys = p.messages[0]?.content ?? "";
      const user = p.messages[1]?.content ?? "";
      const bytes = utf8ByteLength(sys) + utf8ByteLength(user);
      expect(p.max_tokens).toBeGreaterThan(0);
      if (sys.includes("mutually exclusive")) {
        expect(p.max_tokens).toBe(DISCOVER_MAX_OUTPUT_TOKENS);
        expect(bytes).toBeLessThanOrEqual(DISCOVERY_PROMPT_MAX_BYTES);
        reserved += payloadNeurons(p);
      } else if (sys.includes("precise classifier")) {
        expect(p.max_tokens).toBe(CATEGORIZE_MAX_OUTPUT_TOKENS);
        expect(bytes).toBeLessThanOrEqual(CATEGORIZE_BATCH_PROMPT_MAX_BYTES);
        reserved += payloadNeurons(p);
      } else {
        expect(p.max_tokens).toBe(SYNTHESIS_MAX_OUTPUT_TOKENS);
        expect(bytes).toBeLessThanOrEqual(SYNTHESIS_PROMPT_MAX_BYTES);
      }
    }
    expect(reserved).toBeLessThanOrEqual(GENERATION_NEURON_CEILING);
  });

  it("optional categorize retries stop when the ledger is exhausted", async () => {
    const mathResult = clusteredMath();
    const statements = [
      { sid: 1, text: "s1" },
      { sid: 2, text: "s2" },
      { sid: 3, text: "s3" },
    ];
    let classifyCalls = 0;
    const aiRun = vi.fn(async (_model: string, payload: { messages: { content: string }[]; max_tokens: number }) => {
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
        classifyCalls++;
        return { response: JSON.stringify({ assignments: [] }) };
      }
      return {
        response: JSON.stringify({
          overview: { summary: "Sum", citedStatementIds: [9] },
          commonGround: { keyPoints: [] },
          groupPortraits: [],
          tensions: [],
        }),
      };
    });
    const res = await generateSensemaking({
      ai: { run: aiRun } as unknown as Ai,
      lang: "en",
      title: "T",
      description: "D",
      mathResult,
      statements,
      mathRevision: 1,
      now: 1,
    });
    expect(res.status).toBe("ready");
    // first pass + at most one retry for the single batch
    expect(classifyCalls).toBeGreaterThanOrEqual(1);
    expect(classifyCalls).toBeLessThanOrEqual(2);
  });

  it("deterministic fallback never reports Gemma and covers every statement with valid citations", async () => {
    const mathResult = clusteredMath();
    const statements = Array.from({ length: 9 }, (_, i) => ({ sid: i + 1, text: `s${i + 1}` }));
    const res = await generateSensemaking({
      ai: { run: vi.fn().mockRejectedValue(new Error("nope")) } as unknown as Ai,
      lang: "en",
      title: "Budget",
      description: "Desc",
      mathResult,
      statements,
      mathRevision: 7,
      now: 42,
    });
    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;
    expect(res.generationMode).toBe("deterministic");
    expect(res.model).toBe("deterministic");
    expect(String(res.model).toLowerCase()).not.toContain("gemma");
    const union = new Set(res.themes.flatMap((t) => t.statementIds));
    expect([...union].sort((a, b) => a - b)).toEqual(statements.map((s) => s.sid));
    for (const kp of res.commonGround.keyPoints) {
      expect(kp.citedStatementIds.length).toBeGreaterThan(0);
      expect(kp.direction === "agree" || kp.direction === "disagree").toBe(true);
    }
    for (const t of res.tensions) {
      for (const sid of t.citedStatementIds) {
        expect(statements.some((s) => s.sid === sid)).toBe(true);
      }
    }
    expect(res.groupPortraits.length).toBe(mathResult.groups.length);
  });
});

describe("official neuron formula constants", () => {
  it("matches published Gemma 4 26B rates", () => {
    expect(NEURONS_PER_M_INPUT).toBe(9091);
    expect(NEURONS_PER_M_OUTPUT).toBe(27273);
    expect(GENERATION_NEURON_CEILING).toBe(9000);
    expect(DISCOVER_MAX_OUTPUT_TOKENS).toBe(2048);
    expect(CATEGORIZE_MAX_OUTPUT_TOKENS).toBe(1536);
    expect(SYNTHESIS_MAX_OUTPUT_TOKENS).toBe(4096);
  });

  it("16-batch first pass at 1536 still fits under the 9000 ceiling", () => {
    const batches = Math.ceil(800 / CATEGORIZE_BATCH_SIZE);
    expect(batches).toBe(16);
    const discovery = neuronsForCall(
      DISCOVERY_PROMPT_MAX_BYTES + CHAT_TEMPLATE_OVERHEAD_TOKENS,
      DISCOVER_MAX_OUTPUT_TOKENS,
    );
    const categorize = neuronsForCall(
      CATEGORIZE_BATCH_PROMPT_MAX_BYTES + CHAT_TEMPLATE_OVERHEAD_TOKENS,
      CATEGORIZE_MAX_OUTPUT_TOKENS,
    );
    const synthesis = synthesisPhaseHoldNeurons();
    const firstPass = discovery + batches * categorize + synthesis;
    expect(firstPass).toBeLessThan(GENERATION_NEURON_CEILING);
    expect(GENERATION_NEURON_CEILING - firstPass).toBeGreaterThan(categorize);
    expect(GENERATION_NEURON_CEILING - firstPass).toBeLessThan(3 * categorize);
  });
});
