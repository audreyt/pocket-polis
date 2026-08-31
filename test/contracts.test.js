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
    for (const path of ["/", "/api/*", "/c/*", "/r/*", "/a/*"]) {
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
  });
});

describe("package.json", () => {
  it("零 runtime 依賴", () => {
    expect(pkg.dependencies).toBeUndefined();
  });

  it("check 腳本涵蓋 typecheck、測試與 dry-run 部署", () => {
    expect(pkg.scripts.deploy).toBe("wrangler deploy");
    expect(pkg.scripts.check).toContain("typecheck");
    expect(pkg.scripts.check).toContain("test");
    expect(pkg.scripts.check).toContain("deploy:dry");
  });
});

describe("README", () => {
  it("Deploy Button 指向本 repo", () => {
    expect(readme).toContain(
      "https://deploy.workers.cloudflare.com/?url=https://github.com/mashbean/polis-serverless",
    );
  });

  it("聲明非官方 pol.is", () => {
    expect(readme).toMatch(/不是官方|非官方|not affiliated/i);
  });
});
