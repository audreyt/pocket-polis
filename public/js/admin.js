import { api, conversationIdFromPath, copyText, el, show } from "./common.js";

const convId = conversationIdFromPath();
const storageKey = `polis-serverless:admin:${convId}`;
const panel = document.getElementById("panel");
const tokenSection = document.getElementById("token-section");
const loadError = document.getElementById("load-error");

let token = null;

function fail(message) {
  loadError.textContent = message;
  show(loadError, true);
}

function extractToken(raw) {
  const match = String(raw).match(/[0-9a-f]{32}/);
  return match ? match[0] : null;
}

function loadToken() {
  const fromHash = extractToken(location.hash);
  if (fromHash) {
    try {
      sessionStorage.setItem(storageKey, fromHash);
    } catch {
      /* 無法保存則僅用於本次 */
    }
    // 把金鑰從網址列拿掉，避免截圖或分享時外洩
    history.replaceState(null, "", location.pathname);
    return fromHash;
  }
  try {
    return sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

const authHeaders = () => ({ Authorization: `Bearer ${token}` });

async function refresh() {
  const overview = await api(`/api/conversations/${convId}/admin`, { headers: authHeaders() });
  const { settings, statements } = overview;
  document.getElementById("conv-title").textContent = `管理：${settings.title}`;
  document.title = `管理：${settings.title} — polis-serverless`;

  const origin = location.origin;
  document.getElementById("participate-url").textContent = `${origin}/c/${convId}`;
  document.getElementById("report-url").textContent = `${origin}/r/${convId}`;

  document.getElementById("setting-status").checked = settings.status === "open";
  document.getElementById("setting-autoApprove").checked = settings.autoApprove;
  document.getElementById("setting-allowSubmissions").checked = settings.allowSubmissions;
  document.getElementById("setting-openData").checked = settings.openData;

  const pending = statements.filter((s) => s.status === "pending");
  const pendingContainer = document.getElementById("pending-container");
  pendingContainer.replaceChildren();
  document.getElementById("pending-heading").textContent = `待核准陳述（${pending.length}）`;
  if (pending.length === 0) {
    pendingContainer.append(el("p", { class: "muted", text: "沒有待核准的陳述。" }));
  }
  for (const s of pending) {
    const approve = el("button", { class: "primary", text: "核准" });
    approve.addEventListener("click", () => moderate(s.sid, "approve"));
    const reject = el("button", { text: "退回" });
    reject.addEventListener("click", () => moderate(s.sid, "reject"));
    pendingContainer.append(
      el("div", { class: "statement-row" }, [
        el("div", { class: "text", text: s.text }),
        el("div", { class: "actions" }, [approve, reject]),
      ]),
    );
  }

  const all = document.getElementById("all-statements");
  all.replaceChildren();
  const statusText = { approved: "公開中", pending: "待核准", rejected: "已退回" };
  for (const s of statements) {
    const nodes = [
      el("span", { class: `tag ${s.status === "pending" ? "pending" : ""}`, text: statusText[s.status] || s.status }),
      " ",
      el("span", { class: "muted", text: `同意 ${s.agrees} · 不同意 ${s.disagrees} · 略過 ${s.passes}${s.isSeed ? " · 種子" : ""}` }),
    ];
    const row = el("div", { class: "statement-row" }, [
      el("div", { class: "text" }, [s.text, el("div", {}, nodes)]),
    ]);
    if (s.status === "approved") {
      const rejectButton = el("button", { text: "下架" });
      rejectButton.addEventListener("click", () => moderate(s.sid, "reject"));
      row.append(el("div", { class: "actions" }, [rejectButton]));
    } else if (s.status === "rejected") {
      const approveButton = el("button", { text: "重新上架" });
      approveButton.addEventListener("click", () => moderate(s.sid, "approve"));
      row.append(el("div", { class: "actions" }, [approveButton]));
    }
    all.append(row);
  }

  document.getElementById("export-statements").href =
    `/api/conversations/${convId}/export/statements.csv?token=${token}`;
  document.getElementById("export-votes").href =
    `/api/conversations/${convId}/export/votes.csv?token=${token}`;
}

async function moderate(sid, action) {
  try {
    await api(`/api/conversations/${convId}/admin/statements/${sid}`, {
      method: "POST",
      headers: authHeaders(),
      body: { action },
    });
    await refresh();
  } catch (error) {
    fail(`操作失敗：${error.message}`);
  }
}

async function saveSettings() {
  const message = document.getElementById("settings-message");
  try {
    await api(`/api/conversations/${convId}/admin/settings`, {
      method: "POST",
      headers: authHeaders(),
      body: {
        status: document.getElementById("setting-status").checked ? "open" : "closed",
        autoApprove: document.getElementById("setting-autoApprove").checked,
        allowSubmissions: document.getElementById("setting-allowSubmissions").checked,
        openData: document.getElementById("setting-openData").checked,
      },
    });
    message.textContent = "已儲存。";
    show(message, true);
    setTimeout(() => show(message, false), 1500);
  } catch (error) {
    message.textContent = `儲存失敗：${error.message}`;
    show(message, true);
  }
}

for (const id of ["setting-status", "setting-autoApprove", "setting-allowSubmissions", "setting-openData"]) {
  document.getElementById(id).addEventListener("change", saveSettings);
}

document.getElementById("seed-add").addEventListener("click", async () => {
  const textarea = document.getElementById("seed-text");
  const text = textarea.value.trim();
  if (!text) return;
  try {
    await api(`/api/conversations/${convId}/admin/statements`, {
      method: "POST",
      headers: authHeaders(),
      body: { text },
    });
    textarea.value = "";
    await refresh();
  } catch (error) {
    fail(`新增失敗：${error.message}`);
  }
});

panel.addEventListener("click", (event) => {
  const target = event.target.closest("button[data-copy]");
  if (!target) return;
  copyText(document.getElementById(target.dataset.copy).textContent, target);
});

document.getElementById("token-save").addEventListener("click", async () => {
  const candidate = extractToken(document.getElementById("token-input").value);
  if (!candidate) return fail("看不出金鑰格式（應為 32 碼十六進位）。");
  token = candidate;
  try {
    sessionStorage.setItem(storageKey, token);
  } catch {
    /* ignore */
  }
  await start();
});

async function start() {
  show(loadError, false);
  try {
    await refresh();
    show(tokenSection, false);
    show(panel, true);
  } catch (error) {
    show(panel, false);
    show(tokenSection, true);
    if (error.message !== "unauthorized") fail(error.message);
    else fail("金鑰無效或已失效。");
  }
}

(async () => {
  if (!convId) return fail("網址不正確。");
  token = loadToken();
  if (!token) {
    show(tokenSection, true);
    return;
  }
  await start();
})();
