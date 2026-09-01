// 壓力測試：模擬 N 位參與者同時走完整投票流程（每票前先抽題 /next），
// 期間另開一條線持續拉 /results 模擬主持人盯著結果頁。
//
//   node scripts/stress-test.mjs <base-url> [participants=500] [statements=20] [concurrency=100]
//
// ⚠️ 只能對自己控制的部署執行。會建立一場標題含「壓力測試」的新討論，
// 結束時自動關閉該討論。金鑰印在終端。
const BASE = process.argv[2];
const N_PARTICIPANTS = Number(process.argv[3] ?? 500);
const N_STATEMENTS = Number(process.argv[4] ?? 20);
const CONCURRENCY = Number(process.argv[5] ?? 100);

if (!BASE) {
  console.error("usage: node scripts/stress-test.mjs <base-url> [participants] [statements] [concurrency]");
  process.exit(1);
}

const latencies = { next: [], vote: [], results: [] };
const errors = [];

async function timed(bucket, fn) {
  const t0 = performance.now();
  try {
    const result = await fn();
    latencies[bucket].push(performance.now() - t0);
    return result;
  } catch (error) {
    errors.push(`${bucket}: ${error.message}`);
    return null;
  }
}

async function api(path, { method = "GET", body, token } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(`${response.status} ${data?.error ?? ""}`);
  }
  return response.json();
}

function percentile(arr, p) {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function report(name, arr) {
  console.log(
    `  ${name}: n=${arr.length} p50=${percentile(arr, 50).toFixed(0)}ms ` +
      `p95=${percentile(arr, 95).toFixed(0)}ms p99=${percentile(arr, 99).toFixed(0)}ms ` +
      `max=${Math.max(...arr).toFixed(0)}ms`,
  );
}

async function main() {
  console.log(`目標：${BASE} · ${N_PARTICIPANTS} 人 × ${N_STATEMENTS} 句 · 並發 ${CONCURRENCY}`);

  const created = await api("/api/conversations", {
    method: "POST",
    body: {
      title: `【壓力測試】${new Date().toISOString()}`,
      description: "stress-test.mjs 自動建立，測試結束即關閉。",
      seedStatements: Array.from({ length: N_STATEMENTS }, (_, i) => `壓力測試意見第 ${i + 1} 句：這是一句用來量測負載的測試內容。`),
      autoApprove: true,
      allowSubmissions: false,
      openData: false,
    },
  });
  const cid = created.conversationId;
  const admin = created.adminToken;
  console.log(`已建立測試討論 ${cid}`);

  let done = 0;
  const t0 = performance.now();

  // 主持人視角：每 5 秒拉一次結果
  let watching = true;
  const watcher = (async () => {
    while (watching) {
      await timed("results", () => api(`/api/conversations/${cid}/results`));
      await new Promise((r) => setTimeout(r, 5000));
    }
  })();

  // 參與者池
  const queue = Array.from({ length: N_PARTICIPANTS }, (_, i) => i);
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const idx = queue.shift();
      if (idx === undefined) return;
      const pid = crypto.randomUUID();
      for (let v = 0; v < N_STATEMENTS; v++) {
        const next = await timed("next", () => api(`/api/conversations/${cid}/next?pid=${pid}`));
        const sid = next?.statement?.sid;
        if (!sid) break;
        const value = [1, 1, -1, 0][Math.floor(Math.random() * 4)];
        await timed("vote", () =>
          api(`/api/conversations/${cid}/votes`, { method: "POST", body: { pid, sid, value } }),
        );
      }
      done++;
      if (done % 50 === 0) {
        const elapsed = (performance.now() - t0) / 1000;
        console.log(`  ${done}/${N_PARTICIPANTS} 人完成（${elapsed.toFixed(0)}s，${((latencies.vote.length) / elapsed).toFixed(0)} 票/秒）`);
      }
    }
  });
  await Promise.all(workers);
  watching = false;
  await watcher;

  const wallSeconds = (performance.now() - t0) / 1000;
  console.log(`\n完成：${latencies.vote.length} 票 / ${wallSeconds.toFixed(1)}s（吞吐 ${(latencies.vote.length / wallSeconds).toFixed(0)} 票/秒；含抽題共 ${(latencies.vote.length + latencies.next.length)} 個請求，${((latencies.vote.length + latencies.next.length) / wallSeconds).toFixed(0)} 請求/秒）`);
  report("next   ", latencies.next);
  report("vote   ", latencies.vote);
  report("results", latencies.results);
  console.log(`  錯誤：${errors.length} 筆`);
  if (errors.length > 0) {
    const sample = [...new Set(errors)].slice(0, 5);
    for (const e of sample) console.log(`    ${e}`);
  }

  // 最終結果重算耗時（強迫重算：等節流窗過再拉一次）
  await new Promise((r) => setTimeout(r, 2500));
  const tFinal = performance.now();
  const final = await api(`/api/conversations/${cid}/results`);
  console.log(`最終 /results：${(performance.now() - tFinal).toFixed(0)}ms · k=${final.result.k} 群 [${final.result.groups.map((g) => g.size).join(", ")}] · ${final.result.nParticipantsClustered} 人納入分群`);

  await api(`/api/conversations/${cid}/admin/settings`, {
    method: "POST",
    token: admin,
    body: { status: "closed" },
  });
  console.log(`測試討論已關閉：${BASE}/r/${cid}（管理金鑰 ${admin}）`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
