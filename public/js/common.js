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
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = "已複製";
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
  } catch {
    prompt("請手動複製：", text);
  }
}

export const GROUP_COLORS = ["--group-0", "--group-1", "--group-2", "--group-3", "--group-4"];

export function groupColor(index) {
  const name = GROUP_COLORS[index] || GROUP_COLORS[0];
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
