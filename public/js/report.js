import { api, conversationIdFromPath, el, groupColor, show } from "./common.js";
import { applyI18n, lang, mountLangSwitch, t } from "./i18n.js";

applyI18n();
mountLangSwitch(document.getElementById("lang-switch"));
if (lang === "en") {
  const methodLink = document.getElementById("method-link");
  if (methodLink) methodLink.href = "/en/guide#how-it-works";
}

const convId = conversationIdFromPath();
const SVG_NS = "http://www.w3.org/2000/svg";
let statementIndex = new Map();

function fail(message) {
  document.getElementById("conv-title").textContent = t("r.loadFail");
  const node = document.getElementById("load-error");
  node.textContent = message;
  show(node, true);
}

function pidForReadOnly() {
  // 只讀取，不建立：沒投過票的人看結果頁不該產生參與者身分
  try {
    return localStorage.getItem(`polis-serverless:pid:${convId}`);
  } catch {
    return null;
  }
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function renderStats(result) {
  const row = document.getElementById("stats-row");
  row.replaceChildren();
  const items = [
    [result.nParticipantsTotal, t("r.participants")],
    [result.nVotes, t("r.votes")],
    [result.nStatements, t("r.statements")],
    [result.k > 1 ? result.k : "—", t("r.groups")],
  ];
  for (const [value, label] of items) {
    row.append(
      el("div", { class: "stat" }, [
        el("div", { class: "value", text: String(value) }),
        el("div", { class: "label", text: label }),
      ]),
    );
  }
}

function renderMap(result, you) {
  const container = document.getElementById("map-container");
  container.replaceChildren();
  if (result.points.length === 0) {
    container.append(el("p", { class: "muted card", text: t("r.mapEmpty") }));
    return;
  }
  const W = 720;
  const H = 460;
  const pad = 40;
  const xs = result.points.map((p) => p.x);
  const ys = result.points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  // 某一軸退化（所有點同值）時置中，不要貼邊
  const sx = (x) => (spanX > 0 ? pad + ((x - minX) / spanX) * (W - 2 * pad) : W / 2);
  const sy = (y) => (spanY > 0 ? H - pad - ((y - minY) / spanY) * (H - 2 * pad) : H / 2);

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "map-svg", role: "img" });
  svg.append(el("title", { text: t("r.mapTitle") }));

  for (const p of result.points) {
    svg.append(
      svgEl("circle", {
        cx: sx(p.x).toFixed(1),
        cy: sy(p.y).toFixed(1),
        r: 5,
        fill: groupColor(p.group),
        "fill-opacity": 0.7,
      }),
    );
  }
  for (const g of result.groups) {
    if (result.k < 2) continue;
    const cx = sx(g.center[0]);
    const cy = sy(g.center[1]);
    svg.append(svgEl("circle", { cx, cy, r: 14, fill: "none", stroke: groupColor(g.id), "stroke-width": 2 }));
    const label = svgEl("text", {
      x: cx,
      y: cy + 5,
      "text-anchor": "middle",
      "font-size": 13,
      "font-weight": 700,
      fill: groupColor(g.id),
    });
    label.textContent = g.label;
    svg.append(label);
  }
  if (you) {
    const star = svgEl("text", {
      x: sx(you.x),
      y: sy(you.y) + 6,
      "text-anchor": "middle",
      "font-size": 18,
      fill: "currentColor",
    });
    star.textContent = "★";
    svg.append(star);
    show(document.getElementById("you-note"), true);
  }
  container.append(svg);

  const legend = document.getElementById("legend");
  legend.replaceChildren();
  for (const g of result.groups) {
    if (result.k < 2) continue;
    const dot = el("span", { class: "dot" });
    dot.style.background = groupColor(g.id);
    legend.append(el("span", {}, [dot, t("r.groupLabel", { label: g.label, size: g.size })]));
  }
}

function statementLine(sid, extraNodes) {
  const stat = statementIndex.get(sid);
  if (!stat) return null;
  return el("div", { class: "statement-row" }, [
    el("div", { class: "text" }, [stat.text, el("div", {}, extraNodes)]),
  ]);
}

function percent(x) {
  return `${Math.round(x * 100)}%`;
}

function renderConsensus(result) {
  const container = document.getElementById("consensus-container");
  container.replaceChildren();
  const entries = [
    ...result.consensus.agree.map((c) => ({ ...c, tag: t("r.mostlyAgree"), cls: "agree" })),
    ...result.consensus.disagree.map((c) => ({ ...c, tag: t("r.mostlyDisagree"), cls: "disagree" })),
  ];
  if (entries.length === 0) {
    container.append(el("p", { class: "muted", text: t("r.consensusEmpty") }));
    return;
  }
  for (const c of entries) {
    const line = statementLine(c.sid, [
      el("span", { class: `tag ${c.cls}`, text: `${c.tag} ${percent(c.prob)}` }),
    ]);
    if (line) container.append(line);
  }
}

function renderGroups(result) {
  const container = document.getElementById("groups-container");
  container.replaceChildren();
  if (result.k < 2) {
    container.append(el("p", { class: "muted card", text: t("r.groupsEmpty") }));
    return;
  }
  for (const g of result.groups) {
    const card = el("div", { class: "card" });
    const heading = el("h2", { text: t("r.groupLabel", { label: g.label, size: g.size }) });
    heading.style.marginTop = "0";
    heading.style.color = groupColor(g.id);
    card.append(heading);
    if (g.representative.length === 0) {
      card.append(el("p", { class: "muted", text: t("r.groupNone") }));
    }
    for (const r of g.representative) {
      const dirText = r.direction === "agree" ? t("r.agreeWord") : t("r.disagreeWord");
      const line = statementLine(r.sid, [
        el("span", {
          class: `tag ${r.direction}`,
          text: t("r.repLine", { p: Math.round(r.prob * 100), dir: dirText, x: r.repness.toFixed(1) }),
        }),
      ]);
      if (line) card.append(line);
    }
    container.append(card);
  }
}

function renderStatements(result) {
  const container = document.getElementById("statements-container");
  container.replaceChildren();
  const stats = [...result.statementStats].sort((a, b) => b.agrees - a.agrees);
  if (stats.length === 0) {
    container.append(el("p", { class: "muted", text: t("r.allEmpty") }));
    return;
  }
  for (const s of stats) {
    const total = Math.max(s.seen, 1);
    const bar = el("div", { class: "vote-bar" });
    for (const [cls, n] of [
      ["agree", s.agrees],
      ["disagree", s.disagrees],
      ["pass", s.passes],
    ]) {
      const seg = el("div", { class: cls });
      seg.style.width = `${(n / total) * 100}%`;
      bar.append(seg);
    }
    const stat = statementIndex.get(s.sid);
    container.append(
      el("div", { class: "statement-row" }, [
        el("div", { class: "text" }, [
          stat ? stat.text : `#${s.sid}`,
          bar,
          el("div", { class: "muted", text: t("r.counts", { a: s.agrees, d: s.disagrees, p: s.passes }) }),
        ]),
      ]),
    );
  }
}

async function loadStatementTexts() {
  const data = await api(`/api/conversations/${convId}/statements-public`);
  statementIndex = new Map(data.statements.map((s) => [s.sid, s]));
}

async function refresh() {
  const info = await api(`/api/conversations/${convId}`);
  document.getElementById("conv-title").textContent = info.title;
  document.getElementById("conv-description").textContent = info.description;
  document.title = `${info.title} · ${t("r.title")} — polis-serverless`;
  document.getElementById("participate-link").href = `/c/${convId}`;

  await loadStatementTexts();
  const pid = pidForReadOnly();
  const query = pid ? `?pid=${pid}` : "";
  const { result, you } = await api(`/api/conversations/${convId}/results${query}`);
  renderStats(result);
  renderMap(result, you);
  renderConsensus(result);
  renderGroups(result);
  renderStatements(result);
  document.getElementById("computed-at").textContent = t("r.computedAt", {
    time: new Date(result.computedAt).toLocaleString(lang === "en" ? "en-US" : "zh-TW"),
    n: result.nParticipantsClustered,
    m: result.inclusionThreshold,
  });
}

document.getElementById("refresh").addEventListener("click", () => refresh().catch((e) => fail(e.message)));

(async () => {
  if (!convId) return fail(t("app.badUrl"));
  try {
    await refresh();
    setInterval(() => refresh().catch(() => {}), 30000);
  } catch (error) {
    fail(error.message);
  }
})();
