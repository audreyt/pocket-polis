/**
 * Hard free-tier neuron contract for @cf/google/gemma-4-26b-a4b-it.
 *
 * Official Workers AI pricing (2026-08-28):
 *   9091 neurons / M input tokens
 *   27273 neurons / M output tokens
 *   10_000 free neurons / day (resets 00:00 UTC)
 *
 * Input tokens are NOT counted with JS string.length. The hard upper bound is
 * UTF-8 bytes of the messages plus a conservative chat-template overhead:
 * each tokenizer token consumes ≥ 1 content byte; special-token wrappers are
 * covered by CHAT_TEMPLATE_OVERHEAD_TOKENS. This is an upper bound, not an
 * exact token count.
 *
 * Queues are a separate meter (operations), not neurons.
 */

export const NEURONS_PER_M_INPUT = 9091;
export const NEURONS_PER_M_OUTPUT = 27273;
export const FREE_NEURONS_PER_DAY = 10_000;
/** Per-generation and deployment-wide UTC-day ceiling (1,000 headroom below 10k free). */
export const GENERATION_NEURON_CEILING = 9_000;
/** Per-conversation rolling window: at most one AI-backed generateSensemaking. */
export const AI_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SYNTHESIS_AI_CLAIM_KEY = "synthesis_ai_claim";
/** Conservative special-token / chat-template overhead (not content bytes). */
export const CHAT_TEMPLATE_OVERHEAD_TOKENS = 256;

/** Smallest output ceilings that can represent the validated JSON schemas. */
export const DISCOVER_MAX_OUTPUT_TOKENS = 2048;
/** 50-record JSON {sid, primaryTopicId, secondaryTopicId}. 1024 is not proven against Gemma. */
export const CATEGORIZE_MAX_OUTPUT_TOKENS = 1536;
export const SYNTHESIS_MAX_OUTPUT_TOKENS = 4096;

/**
 * Combined UTF-8 byte caps for system+user prompts (content only).
 * Sized so worst-case 800 statements × 16 categorize batches + synthesis
 * cannot exceed GENERATION_NEURON_CEILING even with full output tokens.
 */
export const DISCOVERY_PROMPT_MAX_BYTES = 240_000;
export const CATEGORIZE_BATCH_PROMPT_MAX_BYTES = 32_000;
export const SYNTHESIS_PROMPT_MAX_BYTES = 48_000;

export const MAX_CONSENSUS_PROMPT_STATEMENTS = 24;
export const MAX_TENSION_PROMPT_STATEMENTS = 24;
export const CATEGORIZE_BATCH_SIZE = 50;
export const CATEGORIZE_CONCURRENCY = 3;

/** Cloudflare Queues: 1 operation per 64 KB chunk written, read, or deleted. */
export const QUEUE_CHUNK_BYTES = 64_000;
export const QUEUE_MAX_RETRIES = 1;
/**
 * One source revision, message < 64 KB, no DLQ:
 * 1 write + (1 + max_retries) reads + 1 delete = 4 operations.
 * Success path is 3. This is Queue ops, not neurons.
 */
export const QUEUE_OPS_UPPER_BOUND_ONE_REVISION = 1 + (1 + QUEUE_MAX_RETRIES) + 1;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).length;
}

/** Truncate to max UTF-8 bytes on a code-unit boundary. Never uses string.length as a byte budget. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = utf8Encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) {
    end--;
  }
  return utf8Decoder.decode(bytes.slice(0, end));
}

/**
 * Include every statement ID. Truncate each statement's text so the joined
 * payload is ≤ maxBytes. IDs are never dropped. Throws if even the ID-only
 * payload cannot fit — callers must not send an over-budget prompt.
 */
export function formatStatementsUtf8(
  statements: { sid: number; text: string }[],
  maxBytes: number,
): string {
  if (statements.length === 0) return "";
  const idOnly = statements.map((s) => `[#${s.sid}]`).join("\n");
  const idOnlyBytes = utf8ByteLength(idOnly);
  if (idOnlyBytes > maxBytes) {
    throw new Error(
      `formatStatementsUtf8: ${statements.length} statement IDs require ${idOnlyBytes} bytes which exceeds cap ${maxBytes}`,
    );
  }
  const headers = statements.map((s) => `[#${s.sid}] `);
  const newlineBytes = statements.length > 1 ? utf8ByteLength("\n") * (statements.length - 1) : 0;
  const headerBytes = headers.reduce((n, h) => n + utf8ByteLength(h), 0) + newlineBytes;
  if (headerBytes > maxBytes) {
    return idOnly;
  }
  const per = Math.floor((maxBytes - headerBytes) / statements.length);
  return statements.map((s, i) => headers[i]! + (per > 0 ? truncateUtf8(s.text, per) : "")).join("\n");
}

export function inputTokenUpperBound(systemPrompt: string, userPrompt: string): number {
  return utf8ByteLength(systemPrompt) + utf8ByteLength(userPrompt) + CHAT_TEMPLATE_OVERHEAD_TOKENS;
}

export function neuronsForCall(inputTokenUpper: number, maxOutputTokens: number): number {
  return (inputTokenUpper / 1_000_000) * NEURONS_PER_M_INPUT + (maxOutputTokens / 1_000_000) * NEURONS_PER_M_OUTPUT;
}

export function neuronsForPrompts(
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens: number,
): number {
  return neuronsForCall(inputTokenUpperBound(systemPrompt, userPrompt), maxOutputTokens);
}

/** Worst-case hold for the final synthesis phase (max prompt bytes + max output tokens). */
export function synthesisPhaseHoldNeurons(): number {
  return neuronsForCall(SYNTHESIS_PROMPT_MAX_BYTES + CHAT_TEMPLATE_OVERHEAD_TOKENS, SYNTHESIS_MAX_OUTPUT_TOKENS);
}

export class NeuronLedger {
  readonly ceiling: number;
  reserved = 0;

  constructor(ceiling = GENERATION_NEURON_CEILING) {
    this.ceiling = ceiling;
  }

  remaining(): number {
    return this.ceiling - this.reserved;
  }

  /** Synchronous reservation. Concurrent batches must call this before every ai.run. */
  tryReserve(neurons: number): boolean {
    if (!Number.isFinite(neurons) || neurons < 0) return false;
    if (this.reserved + neurons > this.ceiling) return false;
    this.reserved += neurons;
    return true;
  }
}
