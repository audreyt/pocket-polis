// Demo 連結一致性與存活檢查。
// 2026-09-03 的教訓：demo 對話只活在某個環境的 Durable Object 命名空間裡，
// 而首頁/文件裡的 /c/<id>、/r/<id> 是寫死的；production 命名空間是空的，
// 首頁示範連結就全站 404。因此兩件事都要鎖住：
//   1. 靜態：repo 內所有引用的 demo ID，必須等於 docs/demo-legislature-sim.md
//      所記載的正式 ID 集合（重建 demo 後漏改任一處就會失敗）。
//   2. 存活：正式 ID 在指定站點的 API 必須 200（抓出「連結對了但資料不在這個環境」的情況）。
//
//   node scripts/verify-demo-links.mjs                    # 只做靜態檢查
//   node scripts/verify-demo-links.mjs https://polis.tw   # 靜態＋存活檢查
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = (override) => (override ? resolve(override) : join(HERE, ".."));

// /c/<10碼>、/r/<10碼>；後面不可再接英數字（避免把更長的 token 誤判）。
const DEMO_LINK_PATTERN = /\/(?:c|r)\/([a-z0-9]{10})(?![a-z0-9])/g;

// 正式 ID 的唯一出處：demo 說明文件。
const CANONICAL_DOC = "docs/demo-legislature-sim.md";

// 所有可能引用 demo 連結的檔案（新增引用位置時請一併加到這裡）。
const SCANNED_FILES = [
  "README.md",
  "README.zh-TW.md",
  "public/index.html",
  "public/en.html",
  "public/guide.html",
  "public/guide-en.html",
  CANONICAL_DOC,
];

function extractIds(text) {
  const ids = new Set();
  for (const match of text.matchAll(DEMO_LINK_PATTERN)) ids.add(match[1]);
  return ids;
}

export function canonicalDemoIds(root = join(HERE, "..")) {
  const text = readFileSync(join(root, CANONICAL_DOC), "utf8");
  return extractIds(text);
}

export function referencedDemoIds(root = join(HERE, "..")) {
  const byFile = new Map();
  for (const file of SCANNED_FILES) {
    const text = readFileSync(join(root, file), "utf8");
    byFile.set(file, extractIds(text));
  }
  return byFile;
}

// 靜態檢查：引用集合必須恰好等於正式集合。
// 重建 demo 只改了文件、漏改首頁（或反之）都會在這裡被抓到。
export function checkStatic(root = join(HERE, "..")) {
  const canonical = canonicalDemoIds(root);
  const byFile = referencedDemoIds(root);
  const referenced = new Set([...byFile.values()].flatMap((s) => [...s]));
  const errors = [];
  if (canonical.size === 0) errors.push(`${CANONICAL_DOC} 裡找不到任何 /c/<id> 或 /r/<id>`);
  for (const [file, ids] of byFile) {
    for (const id of ids) {
      if (!canonical.has(id)) errors.push(`${file} 引用了非正式 demo ID: ${id}`);
    }
  }
  for (const id of canonical) {
    if (!referenced.has(id)) errors.push(`正式 demo ID ${id} 在 repo 內無任何引用`);
  }
  return { ok: errors.length === 0, errors, canonical: [...canonical], referenced: [...referenced] };
}

export async function checkLive(base, root = join(HERE, "..")) {
  const canonical = canonicalDemoIds(root);
  const errors = [];
  for (const id of canonical) {
    let response;
    try {
      response = await fetch(`${base}/api/conversations/${id}`);
    } catch (error) {
      errors.push(`${id}: 連線失敗 ${error.message}`);
      continue;
    }
    if (!response.ok) {
      errors.push(`${id}: GET /api/conversations/${id} -> ${response.status}（資料不在 ${base} 的命名空間？）`);
      continue;
    }
    const data = await response.json().catch(() => null);
    if (data?.id !== id) errors.push(`${id}: 回應 id 不符 ${JSON.stringify(data)?.slice(0, 120)}`);
  }
  return { ok: errors.length === 0, errors };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = repoRoot(process.env.REPO_ROOT);
  const staticResult = checkStatic(root);
  if (!staticResult.ok) {
    console.error("靜態檢查失敗：");
    for (const error of staticResult.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`靜態檢查通過：正式 demo ID = ${staticResult.canonical.join(", ")}`);

  const base = process.argv[2];
  if (base) {
    const live = await checkLive(base.replace(/\/$/, ""), root);
    if (!live.ok) {
      console.error(`存活檢查失敗（${base}）：`);
      for (const error of live.errors) console.error(`  - ${error}`);
      process.exit(1);
    }
    console.log(`存活檢查通過：${staticResult.canonical.length} 場 demo 在 ${base} 皆可讀取`);
  }
}
