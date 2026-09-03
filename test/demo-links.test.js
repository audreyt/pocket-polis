// Demo 連結迴歸測試：2026-09-03 polis.tw 示範連結全站 404 的教訓。
// demo 對話活在特定環境的 Durable Object 命名空間，
// 而站內連結是寫死的 ID —— 兩邊漂移就斷掉。這裡鎖住靜態面
// （repo 內引用 == 文件記載的正式 ID）；存活面由
// scripts/verify-demo-links.mjs + .github/workflows/demo-links.yml 每天檢查。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isNotFoundMessage } from "../public/js/common.js";
import { STRINGS } from "../public/js/i18n.js";
import { canonicalDemoIds, checkStatic } from "../scripts/verify-demo-links.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("demo 連結一致性", () => {
  it("文件記載中英兩場正式 demo", () => {
    const canonical = canonicalDemoIds();
    expect(canonical.size).toBe(2);
  });

  it("repo 內所有 /c/<id>、/r/<id> 引用恰好等於正式 ID", () => {
    const result = checkStatic();
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("中英文首頁的參與按鈕連到各自語言的 demo", () => {
    // 中文首頁另有「English demo」跨語連結，故只比對每頁的主要參與（/c/）CTA：
    // 中文頁的 /c/ 必須等於 README.zh-TW 宣傳的 demo，英文頁的 /c/ 等於 README 宣傳的，
    // 且兩者不同（不可把兩個語言的首頁連到同一場）。
    const cta = (file) => {
      const ids = new Set(
        [...read(file).matchAll(/\/c\/([a-z0-9]{10})(?![a-z0-9])/g)].map((m) => m[1]),
      );
      return ids;
    };
    const advertised = (file) => {
      const ids = new Set(
        [...read(file).matchAll(/\/r\/([a-z0-9]{10})(?![a-z0-9])/g)].map((m) => m[1]),
      );
      return ids;
    };
    const canonical = canonicalDemoIds();
    const zhCta = cta("public/index.html");
    const enCta = cta("public/en.html");
    expect(zhCta).toEqual(advertised("README.zh-TW.md"));
    expect(enCta).toEqual(advertised("README.md"));
    expect(zhCta.size).toBe(1);
    expect(enCta.size).toBe(1);
    for (const id of [...zhCta, ...enCta]) expect(canonical.has(id)).toBe(true);
    expect([...zhCta].some((id) => enCta.has(id))).toBe(false);
  });
});

describe("討論不存在時的友善訊息", () => {
  it("app.notFound 中英字串存在且非空", () => {
    expect(STRINGS["app.notFound"]).toHaveLength(2);
    expect(STRINGS["app.notFound"][0].length).toBeGreaterThan(0);
    expect(STRINGS["app.notFound"][1].length).toBeGreaterThan(0);
  });

  it("isNotFoundMessage 只認 404 類訊息", () => {
    expect(isNotFoundMessage("conversation not found")).toBe(true);
    expect(isNotFoundMessage("not found")).toBe(true);
    expect(isNotFoundMessage("HTTP 404")).toBe(false);
    expect(isNotFoundMessage("internal error")).toBe(false);
    expect(isNotFoundMessage(null)).toBe(false);
  });

  it("參與／結果／管理頁都把 404 轉為在地化訊息", () => {
    for (const page of ["participate", "report", "admin"]) {
      const js = read(`public/js/${page}.js`);
      expect(js).toContain("isNotFoundMessage");
      expect(js).toContain('t("app.notFound")');
    }
    expect(read("public/js/common.js")).toContain("export function isNotFoundMessage");
  });
});
