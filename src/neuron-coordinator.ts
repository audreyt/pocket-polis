import { DurableObject } from "cloudflare:workers";
import { GENERATION_NEURON_CEILING } from "./ai-budget";

export const NEURON_COORDINATOR_INSTANCE = "app";
const DAY_STATE_KEY = "day";

export interface DailyNeuronState {
  utcDay: string;
  reserved: number;
}

export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function parseDailyNeuronState(raw: unknown): DailyNeuronState | "absent" | "malformed" {
  if (raw == null || raw === "") return "absent";
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return "malformed";
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "malformed";
  const rec = value as Record<string, unknown>;
  if (typeof rec.utcDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rec.utcDay)) return "malformed";
  if (typeof rec.reserved !== "number" || !Number.isFinite(rec.reserved) || rec.reserved < 0) {
    return "malformed";
  }
  return { utcDay: rec.utcDay, reserved: rec.reserved };
}

/**
 * Pure UTC-day reservation. Malformed state fails closed. Reservations are never refunded.
 */
export function tryReserveDailyNeurons(
  raw: unknown,
  neurons: number,
  now: number,
  ceiling = GENERATION_NEURON_CEILING,
): { ok: true; next: DailyNeuronState } | { ok: false } {
  if (!Number.isFinite(neurons) || neurons < 0) return { ok: false };
  const parsed = parseDailyNeuronState(raw);
  if (parsed === "malformed") return { ok: false };
  const day = utcDayKey(now);
  const current =
    parsed === "absent" || parsed.utcDay !== day ? { utcDay: day, reserved: 0 } : parsed;
  if (current.reserved + neurons > ceiling) return { ok: false };
  return { ok: true, next: { utcDay: day, reserved: current.reserved + neurons } };
}

export class NeuronCoordinator extends DurableObject<Env> {
  private migrated = false;

  private sql() {
    this.migrate();
    return this.ctx.storage.sql;
  }

  private migrate(): void {
    if (this.migrated) return;
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.migrated = true;
  }

  /**
   * Atomically reserve conservative neurons for the coordinator's current UTC day.
   * Billing day is always taken from coordinator-side time at THIS reservation —
   * never from a caller-supplied timestamp (a long generation must not charge
   * post-midnight usage to yesterday while Cloudflare meters the new day).
   * Mutates storage before returning true. No refunds. Fail-closed.
   */
  async reserve(globalNeurons: number): Promise<boolean> {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const rows = this.sql().exec(`SELECT value FROM meta WHERE key = ?`, DAY_STATE_KEY).toArray();
      const raw = rows.length > 0 ? (rows[0]!.value as string) : null;
      const result = tryReserveDailyNeurons(raw, globalNeurons, now);
      if (!result.ok) return false;
      this.sql().exec(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        DAY_STATE_KEY,
        JSON.stringify(result.next),
      );
      return true;
    });
  }
}

