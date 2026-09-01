#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const queueName = process.argv[2] || "pocket-polis-sensemaking";

function runWrangler(args) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

// 1. Check if queue already exists
const info1 = runWrangler(["queues", "info", queueName]);
if (info1.status === 0) {
  process.exit(0);
}

// 2. If info failed (nonzero exit), attempt to create the queue
const create = runWrangler(["queues", "create", queueName]);
if (create.status === 0) {
  process.exit(0);
}

// 3. If create failed (e.g. concurrent creation race), check info once more
const info2 = runWrangler(["queues", "info", queueName]);
if (info2.status === 0) {
  process.exit(0);
}

// 4. Fail closed: emit captured errors and exit with code 1
console.error(`Failed to ensure queue "${queueName}":`);
if (info1.stderr || info1.stdout) {
  console.error(`[info 1]:\n${info1.stderr || info1.stdout}`.trim());
}
if (create.stderr || create.stdout) {
  console.error(`[create]:\n${create.stderr || create.stdout}`.trim());
}
if (info2.stderr || info2.stdout) {
  console.error(`[info 2]:\n${info2.stderr || info2.stdout}`.trim());
}

process.exit(1);
