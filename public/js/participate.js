import { api, conversationIdFromPath, getPid, show } from "./common.js";
import { applyI18n, mountLangSwitch, t } from "./i18n.js";

applyI18n();
mountLangSwitch(document.getElementById("lang-switch"));

const convId = conversationIdFromPath();
const pid = convId ? getPid(convId) : null;

const titleNode = document.getElementById("conv-title");
const descNode = document.getElementById("conv-description");
const loadError = document.getElementById("load-error");
const voteSection = document.getElementById("vote-section");
const doneSection = document.getElementById("done-section");
const submitSection = document.getElementById("submit-section");
const statementText = document.getElementById("statement-text");
const progressFill = document.getElementById("progress-fill");
const progressText = document.getElementById("progress-text");
const submitMessage = document.getElementById("submit-message");

let current = null;
let busy = false;

function fail(message) {
  titleNode.textContent = t("p.loadFail");
  loadError.textContent = message;
  show(loadError, true);
}

async function loadInfo() {
  const info = await api(`/api/conversations/${convId}`);
  titleNode.textContent = info.title;
  descNode.textContent = info.description;
  document.title = `${info.title} — polis-serverless`;
  const reportUrl = `/r/${convId}`;
  document.getElementById("report-link").href = reportUrl;
  document.getElementById("footer-report").href = reportUrl;
  if (info.status !== "open") {
    show(document.getElementById("closed-note"), true);
    return { open: false, info };
  }
  show(submitSection, info.allowSubmissions);
  return { open: true, info };
}

function renderProgress(progress) {
  const percent = progress.total > 0 ? Math.round((progress.voted / progress.total) * 100) : 0;
  progressFill.style.width = `${percent}%`;
  progressText.textContent = t("p.progress", { voted: progress.voted, total: progress.total });
}

async function loadNext() {
  const data = await api(`/api/conversations/${convId}/next?pid=${pid}`);
  renderProgress(data.progress);
  if (data.statement) {
    current = data.statement;
    statementText.textContent = current.text;
    show(voteSection, true);
    show(doneSection, false);
  } else {
    current = null;
    show(voteSection, false);
    show(doneSection, true);
  }
}

document.querySelector(".vote-buttons").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-vote]");
  if (!button || !current || busy) return;
  busy = true;
  try {
    await api(`/api/conversations/${convId}/votes`, {
      method: "POST",
      body: { pid, sid: current.sid, value: Number(button.dataset.vote) },
    });
    await loadNext();
  } catch (error) {
    fail(t("p.voteFail", { msg: error.message }));
  } finally {
    busy = false;
  }
});

document.getElementById("check-again").addEventListener("click", () => loadNext().catch((e) => fail(e.message)));

document.getElementById("submit-statement").addEventListener("click", async () => {
  const textarea = document.getElementById("new-statement");
  const text = textarea.value.trim();
  if (!text || busy) return;
  busy = true;
  try {
    const result = await api(`/api/conversations/${convId}/statements`, {
      method: "POST",
      body: { pid, text },
    });
    textarea.value = "";
    submitMessage.textContent = result.status === "approved" ? t("p.submitApproved") : t("p.submitPending");
    show(submitMessage, true);
    if (result.status === "approved") await loadNext();
  } catch (error) {
    submitMessage.textContent = t("p.submitFail", { msg: error.message });
    show(submitMessage, true);
  } finally {
    busy = false;
  }
});

(async () => {
  if (!convId) return fail(t("app.badUrl"));
  try {
    const { open } = await loadInfo();
    if (open) await loadNext();
    else {
      show(voteSection, false);
      show(doneSection, true);
    }
  } catch (error) {
    fail(error.message);
  }
})();
