const PUBLIC_CONVERSATION_CACHE_SUFFIXES = ["synthesis", "results", "statements-public"] as const;

/**
 * Best-effort invalidation for public responses whose content can become unsafe or stale
 * after statement moderation. Cache API operations are local to the serving data center,
 * matching the existing Worker cache strategy.
 */
export async function invalidateConversationPublicCache(origin: string, conversationId: string): Promise<void> {
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  if (!cache) return;

  try {
    await Promise.all(
      PUBLIC_CONVERSATION_CACHE_SUFFIXES.map((suffix) =>
        cache.delete(new Request(`${origin}/api/conversations/${conversationId}/${suffix}`, { method: "GET" })),
      ),
    );
  } catch {
    // Cache invalidation must not turn a successful Durable Object mutation into an error.
  }
}
