// 用官方 Polis 公開資料（compdemocracy/openData，CC BY 4.0）驗證本 repo 的數學管線：
// 把匯出的投票矩陣餵進 computeMath，與官方發佈的分群（participants-votes.csv 的
// group-id 欄）計算 Adjusted Rand Index。
//
//   npx tsx scripts/validate-opendata.ts <dataset-dir> [<dataset-dir> ...]
//
// dataset-dir 需含 participants-votes.csv 與 comments.csv（官方匯出格式）。
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { computeMath } from "../src/math/pipeline";
import type { VoteRow, VoteValue } from "../src/math/types";

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

/** Adjusted Rand Index：兩組分群標籤的一致性（1=完全一致、0≈隨機） */
function adjustedRandIndex(a: number[], b: number[]): number {
  const n = a.length;
  const labelsA = [...new Set(a)];
  const labelsB = [...new Set(b)];
  const table = labelsA.map(() => labelsB.map(() => 0));
  for (let i = 0; i < n; i++) {
    table[labelsA.indexOf(a[i]!)]![labelsB.indexOf(b[i]!)]!++;
  }
  const comb2 = (x: number) => (x * (x - 1)) / 2;
  const sumRows = table.map((r) => r.reduce((s, v) => s + v, 0));
  const sumCols = labelsB.map((_, j) => table.reduce((s, r) => s + r[j]!, 0));
  const sumComb = table.flat().reduce((s, v) => s + comb2(v), 0);
  const sumCombRows = sumRows.reduce((s, v) => s + comb2(v), 0);
  const sumCombCols = sumCols.reduce((s, v) => s + comb2(v), 0);
  const expected = (sumCombRows * sumCombCols) / comb2(n);
  const max = (sumCombRows + sumCombCols) / 2;
  return max === expected ? 1 : (sumComb - expected) / (max - expected);
}

function validate(dir: string): void {
  const name = basename(dir);
  const pv = parseCsv(readFileSync(join(dir, "participants-votes.csv"), "utf8"));
  const cm = parseCsv(readFileSync(join(dir, "comments.csv"), "utf8"));

  // comments.csv: timestamp,datetime,comment-id,author-id,agrees,disagrees,moderated,comment-body
  const cmHeader = cm[0]!;
  const cIdx = (col: string) => cmHeader.indexOf(col);
  const comments = new Map<number, { body: string; moderated: number; agrees: number }>();
  for (const row of cm.slice(1)) {
    comments.set(Number(row[cIdx("comment-id")]), {
      body: row[cIdx("comment-body")] ?? "",
      moderated: Number(row[cIdx("moderated")]),
      agrees: Number(row[cIdx("agrees")]),
    });
  }

  // participants-votes.csv: participant,group-id,n-comments,n-votes,n-agree,n-disagree,<cid...>
  const header = pv[0]!;
  const firstVoteCol = header.findIndex((h) => /^\d+$/.test(h));
  const commentIds = header.slice(firstVoteCol).map(Number);
  // 官方預設 moderation：只排除被退回（moderated = -1）的陳述
  const includedSids = commentIds.filter((cid) => (comments.get(cid)?.moderated ?? 0) >= 0);

  const votes: VoteRow[] = [];
  const officialGroup = new Map<string, number>();
  for (const row of pv.slice(1)) {
    const pid = `p${row[0]}`;
    if (row[1] !== "" && row[1] !== undefined) officialGroup.set(pid, Number(row[1]));
    for (let j = 0; j < commentIds.length; j++) {
      const raw = row[firstVoteCol + j];
      if (raw === "" || raw === undefined) continue;
      const v = Number(raw);
      if (v !== 1 && v !== -1 && v !== 0) continue;
      votes.push({ pid, sid: commentIds[j]!, value: v as VoteValue });
    }
  }

  // 驗證編碼方向：匯出矩陣的 +1 應該就是 agree（與 comments.csv 的 agrees 對照）
  const probe = commentIds
    .map((cid) => ({ cid, official: comments.get(cid)?.agrees ?? 0 }))
    .filter((x) => x.official > 5)
    .slice(0, 5);
  for (const { cid, official } of probe) {
    const plusOnes = votes.filter((v) => v.sid === cid && v.value === 1).length;
    const minusOnes = votes.filter((v) => v.sid === cid && v.value === -1).length;
    if (Math.abs(plusOnes - official) > Math.abs(minusOnes - official)) {
      throw new Error(`${name}: 投票編碼方向與 comments.csv 不一致（cid ${cid}）`);
    }
  }

  const filteredVotes = votes.filter((v) => includedSids.includes(v.sid));
  const t0 = performance.now();
  const { publicResult, pidPoints } = computeMath({
    conversationId: name,
    votes: filteredVotes,
    statementIds: includedSids,
    computedAt: Date.now(),
  });
  const elapsed = performance.now() - t0;

  // 只比對「雙方都納入分群」的參與者
  const ours: number[] = [];
  const theirs: number[] = [];
  for (const [pid, point] of Object.entries(pidPoints)) {
    const official = officialGroup.get(pid);
    if (official === undefined) continue;
    ours.push(point.group);
    theirs.push(official);
  }
  const officialK = new Set(theirs).size;
  const ari = ours.length > 1 ? adjustedRandIndex(ours, theirs) : NaN;

  // purity：我們的每一群，落在「官方同一群」的比例（加權平均）。
  // ARI 低但 purity 高＝我們只是把官方的群再細分，不是亂分。
  let purityNum = 0;
  const ourLabels = [...new Set(ours)];
  for (const label of ourLabels) {
    const officialOfMembers = theirs.filter((_, i) => ours[i] === label);
    const counts = new Map<number, number>();
    for (const o of officialOfMembers) counts.set(o, (counts.get(o) ?? 0) + 1);
    purityNum += Math.max(...counts.values());
  }
  const purity = ours.length > 0 ? purityNum / ours.length : NaN;

  const text = (sid: number) => (comments.get(sid)?.body ?? "").replaceAll("\n", " ").slice(0, 72);

  console.log(`\n=== ${name} ===`);
  console.log(
    `參與者 ${publicResult.nParticipantsTotal}（納入分群 ${publicResult.nParticipantsClustered}）· ` +
      `投票 ${publicResult.nVotes} · 陳述 ${publicResult.nStatements} · 計算 ${elapsed.toFixed(0)}ms`,
  );
  console.log(
    `分群：ours k=${publicResult.k} [${publicResult.groups.map((g) => g.size).join(", ")}] vs ` +
      `official k=${officialK} · 交集 ${ours.length} 人 · Adjusted Rand Index = ${ari.toFixed(3)} · purity = ${purity.toFixed(3)}`,
  );
  console.log(`silhouette = ${publicResult.silhouette}`);
  const topConsensus = publicResult.consensus.agree[0];
  if (topConsensus) {
    console.log(
      `共識第一名（${Math.round(topConsensus.prob * 100)}% 同意）: ${text(topConsensus.sid)}`,
    );
  }
  for (const g of publicResult.groups) {
    const rep = g.representative[0];
    if (!rep) continue;
    const dir = rep.direction === "agree" ? "同意" : "不同意";
    console.log(
      `群 ${g.label}（${g.size} 人）代表句 [${Math.round(rep.prob * 100)}% ${dir}, repness ${rep.repness.toFixed(1)}]: ${text(rep.sid)}`,
    );
  }
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: npx tsx scripts/validate-opendata.ts <dataset-dir> [...]");
  process.exit(1);
}
for (const dir of dirs) validate(dir);
