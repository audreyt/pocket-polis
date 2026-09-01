export function conversationIdFromPath() {
  const parts = location.pathname.split("/");
  const id = parts[2] || "";
  return /^[a-z0-9]{10}$/.test(id) ? id : null;
}

export function getPid(conversationId) {
  const key = `polis-serverless:pid:${conversationId}`;
  try {
    let pid = localStorage.getItem(key);
    if (!pid) {
      pid = crypto.randomUUID();
      localStorage.setItem(key, pid);
    }
    return pid;
  } catch {
    // localStorage 不可用（隱私模式等）：本分頁內臨時身分
    if (!window.__polisPid) window.__polisPid = crypto.randomUUID();
    return window.__polisPid;
  }
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* 非 JSON 回應 */
  }
  if (!response.ok) {
    throw new Error((data && data.error) || `HTTP ${response.status}`);
  }
  return data;
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

export function show(node, visible) {
  node.classList.toggle("hidden", !visible);
}

export async function copyText(text, button) {
  const isEn = document.documentElement.lang === "en";
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = isEn ? "Copied" : "已複製";
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
  } catch {
    prompt(isEn ? "Copy manually:" : "請手動複製：", text);
  }
}

export const GROUP_COLORS = ["--group-0", "--group-1", "--group-2", "--group-3", "--group-4"];

export function groupColor(index) {
  const name = GROUP_COLORS[index] || GROUP_COLORS[0];
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function srgbChannelToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(colorStr) {
  const str = (colorStr || "").trim();
  let r = 0;
  let g = 0;
  let b = 0;
  if (str.startsWith("#")) {
    const hex = str.slice(1);
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length === 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }
  } else if (str.startsWith("rgb")) {
    const match = str.match(/\d+/g);
    if (match && match.length >= 3) {
      r = Number(match[0]);
      g = Number(match[1]);
      b = Number(match[2]);
    }
  }
  const linR = srgbChannelToLinear(r);
  const linG = srgbChannelToLinear(g);
  const linB = srgbChannelToLinear(b);
  return 0.2126 * linR + 0.7152 * linG + 0.0722 * linB;
}

function contrastRatio(l1, l2) {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function accessibleTextColor(bgHexOrColor) {
  const lum = relativeLuminance(bgHexOrColor);
  const crWhite = contrastRatio(1.0, lum);
  const crBlack = contrastRatio(lum, 0.0);
  return crBlack >= crWhite ? "#000000" : "#ffffff";
}

export function statementRowAttrs(sid, options = {}) {
  const attrs = { class: "statement-row" };
  if (options && options.canonical) {
    attrs.id = `stmt-${sid}`;
    attrs.tabindex = "-1";
  }
  return attrs;
}
