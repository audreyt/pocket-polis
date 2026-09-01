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

/** Andrew monotone chain 凸包 */
function convexHull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** 凸包外擴 + 中點平滑，畫成柔軟的群體輪廓 */
function hullPath(points, padding) {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const hull = convexHull(points).map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * padding, y: p.y + (dy / len) * padding };
  });
  if (hull.length < 3) {
    const r = padding + 14;
    return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;
  }
  // 以頂點為控制點、通過各邊中點的封閉貝茲曲線
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  let d = "";
  for (let i = 0; i < hull.length; i++) {
    const curr = hull[i];
    const next = hull[(i + 1) % hull.length];
    const m = mid(curr, next);
    if (i === 0) {
      const prevMid = mid(hull[hull.length - 1], curr);
      d = `M ${prevMid.x.toFixed(1)} ${prevMid.y.toFixed(1)}`;
    }
    d += ` Q ${curr.x.toFixed(1)} ${curr.y.toFixed(1)} ${m.x.toFixed(1)} ${m.y.toFixed(1)}`;
  }
  return d + " Z";
}

function renderMap(result, you) {
  const container = document.getElementById("map-container");
  container.replaceChildren();
  if (result.points.length === 0) {
    container.append(el("p", { class: "muted card", text: t("r.mapEmpty") }));
    return;
  }
  const W = 860;
  const H = 520;
  const pad = 56;
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

  // 淡淡的十字座標軸，給地圖一點空間感
  const axisColor = "color-mix(in srgb, currentColor 10%, transparent)";
  svg.append(svgEl("line", { x1: W / 2, y1: 16, x2: W / 2, y2: H - 16, stroke: axisColor, "stroke-width": 1 }));
  svg.append(svgEl("line", { x1: 16, y1: H / 2, x2: W - 16, y2: H / 2, stroke: axisColor, "stroke-width": 1 }));

  const screenPoints = result.points.map((p) => ({ x: sx(p.x), y: sy(p.y), group: p.group }));

  // 群體輪廓（柔軟色暈）
  if (result.k >= 2) {
    for (const g of result.groups) {
      const members = screenPoints.filter((p) => p.group === g.id);
      if (members.length < 2) continue;
      svg.append(
        svgEl("path", {
          d: hullPath(members, 22),
          fill: groupColor(g.id),
          "fill-opacity": 0.08,
          stroke: groupColor(g.id),
          "stroke-opacity": 0.35,
          "stroke-width": 1.2,
          "stroke-dasharray": "5 5",
        }),
      );
    }
  }

  // 參與者點：白邊、依序彈出
  screenPoints.forEach((p, i) => {
    const dot = svgEl("circle", {
      cx: p.x.toFixed(1),
      cy: p.y.toFixed(1),
      r: 5.5,
      class: "dot",
      fill: groupColor(p.group),
      "fill-opacity": 0.85,
      stroke: "var(--surface)",
      "stroke-width": 1.4,
    });
    dot.style.animationDelay = `${Math.min(i * 8, 600)}ms`;
    svg.append(dot);
  });

  // 群標籤章
  if (result.k >= 2) {
    for (const g of result.groups) {
      const members = screenPoints.filter((p) => p.group === g.id);
      if (members.length === 0) continue;
      const topY = Math.min(...members.map((p) => p.y));
      const cx = members.reduce((s, p) => s + p.x, 0) / members.length;
      const label = t("r.groupChip", { label: g.label, size: g.size });
      const chipW = label.length * 8.2 + 26;
      const chipY = Math.max(topY - 46, 8);
      const chip = svgEl("g", {});
      chip.append(
        svgEl("rect", {
          x: cx - chipW / 2,
          y: chipY,
          width: chipW,
          height: 26,
          rx: 13,
          fill: "var(--surface)",
          stroke: groupColor(g.id),
          "stroke-width": 1.4,
        }),
      );
      const text = svgEl("text", {
        x: cx,
        y: chipY + 17.5,
        "text-anchor": "middle",
        "font-size": 12.5,
        "font-weight": 700,
        fill: groupColor(g.id),
      });
      text.textContent = label;
      chip.append(text);
      svg.append(chip);
    }
  }

  // 你的位置
  if (you) {
    const yx = sx(you.x);
    const yy = sy(you.y);
    svg.append(
      svgEl("circle", {
        cx: yx,
        cy: yy,
        r: 10,
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 1.6,
      }),
    );
    const star = svgEl("text", {
      x: yx,
      y: yy + 4.5,
      "text-anchor": "middle",
      "font-size": 13,
      fill: "currentColor",
    });
    star.textContent = "★";
    svg.append(star);
    const youLabel = svgEl("text", {
      x: yx,
      y: yy - 16,
      "text-anchor": "middle",
      "font-size": 12,
      "font-weight": 700,
      fill: "currentColor",
    });
    youLabel.textContent = `★ ${t("r.you")}`;
    svg.append(youLabel);
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
          el("div", {
            class: "muted",
            text: t("r.counts", {
              a: s.agrees,
              d: s.disagrees,
              p: s.passes,
              ap: Math.round((s.agrees / total) * 100),
              dp: Math.round((s.disagrees / total) * 100),
            }),
          }),
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
  document.title = `${info.title} · ${t("r.title")} — Pocket Polis`;
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
