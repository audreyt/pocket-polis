// 部署契約測試（沿用 call-in / delib 的慣例）：
// 把 wrangler.jsonc、package.json 與 README 的關鍵承諾寫成斷言，防止漂移。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const stripJsonc = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

const wrangler = JSON.parse(stripJsonc(read("wrangler.jsonc")));
const pkg = JSON.parse(read("package.json"));
const readme = read("README.md");

describe("wrangler.jsonc", () => {
  it("worker 名稱與進入點", () => {
    expect(wrangler.name).toBe("polis-serverless");
    expect(wrangler.main).toBe("src/index.ts");
  });

  it("靜態資產 binding 與 run_worker_first 路徑", () => {
    expect(wrangler.assets.directory).toBe("./public");
    expect(wrangler.assets.binding).toBe("ASSETS");
    for (const path of ["/", "/api/*", "/mcp", "/c/*", "/r/*", "/a/*", "/en", "/en/*", "/guide"]) {
      expect(wrangler.assets.run_worker_first).toContain(path);
    }
  });

  it("Durable Object 是唯一資料層，SQLite migration 存在", () => {
    expect(wrangler.durable_objects.bindings).toEqual([
      { name: "CONVERSATION", class_name: "Conversation" },
    ]);
    expect(wrangler.migrations[0].new_sqlite_classes).toContain("Conversation");
    expect(wrangler.kv_namespaces).toBeUndefined();
    expect(wrangler.d1_databases).toBeUndefined();
    expect(wrangler.r2_buckets).toBeUndefined();
    const conversation = read("src/conversation.ts");
    expect(conversation).toContain("CREATE TABLE conversation_registry");
    expect(conversation).toContain("registryVersion");
  });
});

describe("package.json", () => {
  it("MCP runtime 依賴使用官方 server v2 與 Cloudflare handler", () => {
    expect(pkg.dependencies).toMatchObject({
      "@modelcontextprotocol/server": expect.any(String),
      agents: expect.any(String),
      zod: expect.any(String),
    });
  });

  it("CLI bin 指向 install-skill 腳本", () => {
    expect(pkg.bin["pocket-polis"]).toBe("./scripts/cli.mjs");
  });

  it("check 腳本涵蓋 typecheck、測試與 dry-run 部署", () => {
    expect(pkg.scripts.deploy).toBe("wrangler deploy");
    expect(pkg.scripts.check).toContain("typecheck");
    expect(pkg.scripts.check).toContain("test");
    expect(pkg.scripts.check).toContain("deploy:dry");
    expect(pkg.scripts["mcp:backfill"]).toContain("backfill-mcp-registry.mjs");
  });
});

describe("MCP", () => {
  it("使用 stateless Streamable HTTP handler，並完整註冊討論操作工具", () => {
    const source = read("src/mcp.ts");
    expect(read("src/index.ts")).toContain('from "agents/mcp/server"');
    expect(source).toContain('new ResourceTemplate("pocket-polis://conversations/{conversationId}"');
    expect(source).toContain('"analyze_deliberation"');
    for (const tool of [
      "list_conversations",
      "list_active_conversations",
      "get_conversation",
      "get_conversation_results",
      "create_conversation",
      "get_next_statement",
      "cast_vote",
      "submit_statement",
      "export_conversation_data",
      "get_admin_overview",
      "moderate_statement",
      "add_seed_statement",
      "update_conversation_settings",
      "register_conversation",
      "backfill_conversation_registry",
    ]) {
      expect(source).toContain(`"${tool}"`);
    }
  });
});

describe("README", () => {
  it("Deploy Button 指向本 repo", () => {
    expect(readme).toContain(
      "https://deploy.workers.cloudflare.com/?url=https://github.com/mashbean/pocket-polis",
    );
  });

  it("聲明非官方 pol.is", () => {
    expect(readme).toMatch(/不是官方|非官方|not affiliated/i);
  });

  it("指向線上展示站與 AGENT.md", () => {
    expect(readme).toContain("https://polis.mashbean.net");
    expect(readme).toContain("AGENT.md");
  });

  it("宣告 pol.is 相容的 comments.csv 匯出（issue #1）", () => {
    expect(readme).toContain("comments.csv");
    expect(read("AGENT.md")).toContain("export/{comments,votes,statements}.csv");
    expect(read("public/report.html")).toContain('id="export-comments"');
  });
});

describe("品牌與公開版要求", () => {
  it("landing 有一鍵發起與署名，且不再有 Deploy Button", () => {
    const zh = read("public/index.html");
    expect(zh).toContain("一鍵發起");
    expect(zh).toContain("Created and maintained by");
    expect(zh).not.toContain("deploy.workers.cloudflare.com/button");
  });

  it("行為準則存在且含下架規範", () => {
    const coc = read("CODE_OF_CONDUCT.md");
    expect(coc).toContain("mashbean");
    expect(coc).toMatch(/下架|take down/);
  });

  it("品牌名稱中英並列（中文頁）", () => {
    const zh = read("public/index.html");
    expect(zh).toContain("Pocket Polis");
    expect(zh).toContain("口袋審議");
    expect(zh).toContain("A pocket tool for deliberation, anytime");
  });
});

describe("雙語頁面", () => {
  it("中英 landing 與指南頁存在且互相連結", () => {
    const zh = read("public/index.html");
    const en = read("public/en.html");
    expect(zh).toContain('href="/en"');
    expect(zh).toContain('href="/guide"');
    expect(en).toContain('href="/"');
    expect(en).toContain('href="/en/guide"');
    expect(read("public/guide.html")).toContain('href="/en/guide"');
    expect(read("public/guide-en.html")).toContain('href="/guide"');
  });

  it("應用頁掛上 i18n 與回官網的品牌導覽", () => {
    for (const page of ["participate", "report", "admin"]) {
      const html = read(`public/${page}.html`);
      expect(html).toContain("data-i18n");
      expect(html).toContain('id="home-link"');
    }
    expect(read("public/js/i18n.js")).toContain("STRINGS");
  });
});

describe("agent 引導檔案", () => {
  it("AGENT.md 與 skill 存在且包含部署流程", () => {
    const agent = read("AGENT.md");
    expect(agent).toContain("wrangler login");
    expect(agent).toContain("/api/conversations");
    const skill = read("skills/pocket-polis/SKILL.md");
    expect(skill).toMatch(/^---\nname: pocket-polis/);
  });
});
