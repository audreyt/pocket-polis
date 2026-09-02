#!/usr/bin/env node
// One-time migration for conversations created before conversation_registry existed.
// Cloudflare credentials stay in this local process and are never sent to the Worker;
// the Worker receives only Durable Object hash IDs in batches of 100.

const args = parseArgs(process.argv.slice(2));
const accountId = args.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN;
const mcpAdminToken = process.env.MCP_ADMIN_TOKEN;

if (!args.baseUrl || !accountId || !cloudflareToken || !mcpAdminToken) {
  console.error(`Usage:
  CLOUDFLARE_API_TOKEN=... MCP_ADMIN_TOKEN=... \\
  node scripts/backfill-mcp-registry.mjs --base-url https://polis.example.com \\
    --account-id <cloudflare-account-id> [--namespace-id <durable-object-namespace-id>]

The tokens are read from the environment and are never printed.`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const namespaceId = args.namespaceId ?? (await discoverNamespace(accountId, cloudflareToken));
  const objectIds = await listObjectIds(accountId, namespaceId, cloudflareToken);
  console.log(`Found ${objectIds.length} stored Durable Objects; inspecting them in MCP batches…`);

  let registered = 0;
  let skipped = 0;
  for (let offset = 0; offset < objectIds.length; offset += 100) {
    const batch = objectIds.slice(offset, offset + 100);
    const result = await callBackfillTool(args.baseUrl, mcpAdminToken, batch, offset / 100 + 1);
    registered += result.registered.length;
    skipped += result.skipped.length;
    console.log(`  inspected ${Math.min(offset + batch.length, objectIds.length)}/${objectIds.length}`);
  }
  console.log(`Registry backfill complete: ${registered} conversations registered, ${skipped} non-conversation objects skipped.`);
}

async function discoverNamespace(accountId, token) {
  const response = await cloudflareApi(
    `/accounts/${encodeURIComponent(accountId)}/workers/durable_objects/namespaces?per_page=1000`,
    token,
  );
  const candidates = response.result.filter(
    (item) => item.class === "Conversation" && (!args.scriptName || item.script === args.scriptName),
  );
  if (candidates.length !== 1) {
    const suffix = candidates.length === 0 ? "none found" : `${candidates.length} found`;
    throw new Error(`Could not select one Conversation namespace (${suffix}); pass --namespace-id explicitly.`);
  }
  return candidates[0].id;
}

async function listObjectIds(accountId, namespaceId, token) {
  const ids = [];
  let cursor;
  do {
    const query = new URLSearchParams({ limit: "10000" });
    if (cursor) query.set("cursor", cursor);
    const response = await cloudflareApi(
      `/accounts/${encodeURIComponent(accountId)}/workers/durable_objects/namespaces/${encodeURIComponent(namespaceId)}/objects?${query}`,
      token,
    );
    for (const item of response.result ?? []) {
      if (item.hasStoredData && /^[0-9a-f]{64}$/.test(item.id ?? "")) ids.push(item.id);
    }
    cursor = response.result_info?.cursor || undefined;
  } while (cursor);
  return ids;
}

async function cloudflareApi(path, token) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    throw new Error(`Cloudflare API ${response.status}: ${body?.errors?.[0]?.message ?? "request failed"}`);
  }
  return body;
}

async function callBackfillTool(baseUrl, token, objectIds, requestId) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/mcp`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "backfill_conversation_registry",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: {
        name: "backfill_conversation_registry",
        arguments: { objectIds },
        _meta: {
          "io.modelcontextprotocol/clientInfo": { name: "pocket-polis-registry-backfill", version: "1.0.0" },
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`MCP backfill ${response.status}: ${body?.error?.message ?? "request failed"}`);
  const result = body?.result;
  if (result?.isError) throw new Error(result.content?.[0]?.text ?? "MCP backfill failed");
  const data = result?.structuredContent?.data;
  if (!data || !Array.isArray(data.registered) || !Array.isArray(data.skipped)) {
    throw new Error("MCP backfill returned an unexpected response");
  }
  return data;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === "--base-url") parsed.baseUrl = value;
    else if (flag === "--account-id") parsed.accountId = value;
    else if (flag === "--namespace-id") parsed.namespaceId = value;
    else if (flag === "--script-name") parsed.scriptName = value;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return parsed;
}
