#!/usr/bin/env node
// 極簡 CLI：目前只有 install-skill——把 skills/polis-serverless 安裝到
// ~/.claude/skills/，讓 coding agent（Claude Code 等）可以直接使用。
//
//   npx --yes github:mashbean/polis-serverless install-skill [--force]
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const command = process.argv[2];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

if (command === "install-skill") {
  const force = process.argv.includes("--force");
  const source = join(repoRoot, "skills", "polis-serverless");
  const target = join(homedir(), ".claude", "skills", "polis-serverless");
  if (existsSync(target) && !force) {
    console.error(`已存在：${target}（用 --force 覆蓋）`);
    process.exit(1);
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  console.log(`已安裝 skill 到 ${target}`);
  console.log("在 Claude Code 裡輸入 /polis-serverless 或直接描述需求即可觸發。");
} else {
  console.log(`polis-serverless CLI

用法：
  install-skill [--force]   安裝 agent skill 到 ~/.claude/skills/

部署與 API 說明見 AGENT.md：
  https://github.com/mashbean/polis-serverless/blob/main/AGENT.md`);
  if (command) process.exit(1);
}
