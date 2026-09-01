import { afterEach, describe, expect, it, vi } from "vitest";

import { GENERATION_NEURON_CEILING } from "../src/ai-budget";
import {
  NeuronCoordinator,
  parseDailyNeuronState,
  tryReserveDailyNeurons,
  utcDayKey,
} from "../src/neuron-coordinator";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

class MockSqlStorage {
  private meta = new Map<string, string>();

  exec(query: string, ...params: unknown[]) {
    const q = query.trim();
    if (q.startsWith("CREATE TABLE")) {
      return { toArray: () => [], one: () => ({}) };
    }
    if (q.startsWith("SELECT value FROM meta WHERE key = ?")) {
      const key = String(params[0]);
      const val = this.meta.get(key);
      return {
        toArray: () => (val !== undefined ? [{ value: val }] : []),
        one: () => (val !== undefined ? { value: val } : undefined),
      };
    }
    if (q.startsWith("INSERT INTO meta")) {
      this.meta.set(String(params[0]), String(params[1]));
      return { toArray: () => [], one: () => undefined };
    }
    return { toArray: () => [], one: () => ({}) };
  }
}

function makeCoordinator(): NeuronCoordinator {
  const ctx = {
    storage: {
      sql: new MockSqlStorage(),
      transactionSync: <T>(fn: () => T): T => fn(),
    },
  };
  return new NeuronCoordinator(ctx, {} as Env);
}

describe("tryReserveDailyNeurons", () => {
  const noon = Date.UTC(2026, 8, 1, 12, 0, 0);

  it("accepts exact ceiling then denies the next neuron", () => {
    const first = tryReserveDailyNeurons(null, GENERATION_NEURON_CEILING, noon);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.next.reserved).toBe(9000);
    expect(first.next.utcDay).toBe("2026-09-01");
    const denied = tryReserveDailyNeurons(first.next, 1, noon);
    expect(denied.ok).toBe(false);
  });

  it("never lets concurrent simulated conversations exceed 9000", () => {
    let raw: unknown = null;
    const granted: number[] = [];
    for (const n of [4000, 4000, 4000]) {
      const result = tryReserveDailyNeurons(raw, n, noon);
      if (result.ok) {
        raw = result.next;
        granted.push(n);
      }
    }
    expect(granted).toEqual([4000, 4000]);
    expect(parseDailyNeuronState(raw)).toEqual({ utcDay: "2026-09-01", reserved: 8000 });
    expect(tryReserveDailyNeurons(raw, 1001, noon).ok).toBe(false);
    const last = tryReserveDailyNeurons(raw, 1000, noon);
    expect(last.ok).toBe(true);
    if (!last.ok) return;
    expect(last.next.reserved).toBe(9000);
    expect(tryReserveDailyNeurons(last.next, 1, noon).ok).toBe(false);
  });

  it("resets reserved when the UTC date changes", () => {
    const day1 = tryReserveDailyNeurons(null, 9000, noon);
    expect(day1.ok).toBe(true);
    if (!day1.ok) return;
    const nextDay = noon + 24 * 60 * 60 * 1000;
    const day2 = tryReserveDailyNeurons(day1.next, 100, nextDay);
    expect(day2.ok).toBe(true);
    if (!day2.ok) return;
    expect(day2.next.utcDay).toBe(utcDayKey(nextDay));
    expect(day2.next.reserved).toBe(100);
  });

  it("malformed state fails closed", () => {
    expect(tryReserveDailyNeurons("{", 1, noon).ok).toBe(false);
    expect(tryReserveDailyNeurons({ utcDay: "nope", reserved: 0 }, 1, noon).ok).toBe(false);
    expect(tryReserveDailyNeurons({ utcDay: "2026-09-01", reserved: -1 }, 1, noon).ok).toBe(false);
    expect(tryReserveDailyNeurons(null, Number.NaN, noon).ok).toBe(false);
  });
});

describe("NeuronCoordinator.reserve", () => {
  const noon = Date.UTC(2026, 8, 1, 12, 0, 0);
  const beforeMidnight = Date.UTC(2026, 8, 1, 23, 59, 50);
  const afterMidnight = Date.UTC(2026, 8, 2, 0, 0, 10);

  afterEach(() => {
    vi.useRealTimers();
  });

  it("atomically denies over-ceiling concurrent reserves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(noon);
    const coord = makeCoordinator();
    const results = await Promise.all([4000, 4000, 4000].map((n) => coord.reserve(n)));
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await coord.reserve(1001)).toBe(false);
    expect(await coord.reserve(1000)).toBe(true);
    expect(await coord.reserve(1)).toBe(false);
  });

  it("malformed persisted state fails closed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(noon);
    const sql = new MockSqlStorage();
    sql.exec("INSERT INTO meta (key, value) VALUES (?, ?)", "day", "{not-json");
    const coord = new NeuronCoordinator(
      { storage: { sql, transactionSync: <T>(fn: () => T): T => fn() } },
      {} as Env,
    );
    expect(await coord.reserve(1)).toBe(false);
  });

  it("UTC rollover allows a new day's reservation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(noon);
    const coord = makeCoordinator();
    expect(await coord.reserve(9000)).toBe(true);
    expect(await coord.reserve(1)).toBe(false);
    vi.setSystemTime(noon + 24 * 60 * 60 * 1000);
    expect(await coord.reserve(50)).toBe(true);
  });
  it("each reservation bills the coordinator clock day, not a fixed job start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(beforeMidnight);
    const coord = makeCoordinator();

    // Pre-midnight: fill yesterday's 9,000 ceiling.
    expect(await coord.reserve(9000)).toBe(true);
    expect(await coord.reserve(1)).toBe(false);

    // Same coordinator instance, generation still running — clock crosses 00:00 UTC.
    // Post-midnight reserves MUST open a fresh day; they must not hide under yesterday.
    vi.setSystemTime(afterMidnight);
    expect(await coord.reserve(100)).toBe(true);
    expect(await coord.reserve(8900)).toBe(true);
    expect(await coord.reserve(1)).toBe(false);

    // Pure helper still accepts explicit now for deterministic unit tests.
    const pure = tryReserveDailyNeurons(
      { utcDay: "2026-09-01", reserved: 9000 },
      50,
      afterMidnight,
    );
    expect(pure.ok).toBe(true);
    if (!pure.ok) return;
    expect(pure.next).toEqual({ utcDay: "2026-09-02", reserved: 50 });
  });
});
