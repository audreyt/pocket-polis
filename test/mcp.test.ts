import { describe, expect, it } from "vitest";
import { isGlobalMcpAdmin, MCP_TOOL_NAMES } from "../src/mcp";

describe("MCP authorization and surface", () => {
  it("recognizes only an exact configured bearer service token", () => {
    const env = { MCP_ADMIN_TOKEN: "local-secret" } as Env;
    expect(isGlobalMcpAdmin(new Request("https://example.test/mcp"), env)).toBe(false);
    expect(
      isGlobalMcpAdmin(
        new Request("https://example.test/mcp", { headers: { Authorization: "Bearer wrong" } }),
        env,
      ),
    ).toBe(false);
    expect(
      isGlobalMcpAdmin(
        new Request("https://example.test/mcp", { headers: { Authorization: "Bearer local-secret" } }),
        env,
      ),
    ).toBe(true);
  });

  it("does not grant global access when MCP_ADMIN_TOKEN is unset", () => {
    expect(
      isGlobalMcpAdmin(
        new Request("https://example.test/mcp", { headers: { Authorization: "Bearer anything" } }),
        {} as Env,
      ),
    ).toBe(false);
  });

  it("exposes the complete discussion lifecycle tool set", () => {
    expect(MCP_TOOL_NAMES).toHaveLength(15);
    expect(new Set(MCP_TOOL_NAMES).size).toBe(MCP_TOOL_NAMES.length);
  });
});
