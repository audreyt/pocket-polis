import type { Conversation, ConversationSettings } from "./conversation";

const MAX_SEED_STATEMENTS = 50;

export interface CreatedConversation {
  conversationId: string;
  adminToken: string;
  urls: { participate: string; report: string; admin: string };
}

export type CreateConversationResult =
  | { ok: true; value: CreatedConversation }
  | { ok: false; error: string; status: number };

export async function createConversationFromInput(env: Env, input: unknown): Promise<CreateConversationResult> {
  if (!isRecord(input)) return { ok: false, error: "invalid body", status: 400 };
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 120) : "";
  if (!title) return { ok: false, error: "title is required", status: 400 };
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 2000) : "";
  const seedStatements = Array.isArray(input.seedStatements)
    ? input.seedStatements.filter((s): s is string => typeof s === "string").slice(0, MAX_SEED_STATEMENTS)
    : [];

  const settings: ConversationSettings = {
    title,
    description,
    autoApprove: input.autoApprove !== false,
    allowSubmissions: input.allowSubmissions !== false,
    openData: input.openData === true,
    status: "open",
  };

  const now = Date.now();
  const limiter = env.CONVERSATION.getByName("creation-limiter");
  const reservation = await limiter.reserveCreation(now);
  if (!reservation.ok) return { ok: false, error: reservation.error ?? "rate limited", status: 429 };

  const conversationId = randomId();
  const adminToken = randomToken();
  const adminTokenHash = await sha256Hex(adminToken);
  const stub = env.CONVERSATION.getByName(`conv:${conversationId}`);
  const result = await stub.initConversation(conversationId, settings, seedStatements, adminTokenHash, now);
  if (!result.ok) return { ok: false, error: result.error, status: 500 };

  return {
    ok: true,
    value: {
      conversationId,
      adminToken,
      urls: {
        participate: `/c/${conversationId}`,
        report: `/r/${conversationId}`,
        admin: `/a/${conversationId}#token=${adminToken}`,
      },
    },
  };
}

export async function getConversation(env: Env, conversationId: string): Promise<DurableObjectStub<Conversation> | null> {
  if (!/^[a-z0-9]{10}$/.test(conversationId)) return null;
  const stub = env.CONVERSATION.getByName(`conv:${conversationId}`);
  return (await stub.isConversation()) ? stub : null;
}

export function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n.toString(36).padStart(10, "0").slice(-10);
}

export function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
