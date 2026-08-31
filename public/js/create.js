import { api, copyText, show } from "./common.js";

const form = document.getElementById("create-form");
const errorNode = document.getElementById("create-error");
const createdPanel = document.getElementById("created");
const button = document.getElementById("create-button");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  show(errorNode, false);
  button.disabled = true;
  try {
    const seeds = document
      .getElementById("seeds")
      .value.split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const data = await api("/api/conversations", {
      method: "POST",
      body: {
        title: document.getElementById("title").value,
        description: document.getElementById("description").value,
        seedStatements: seeds,
        autoApprove: document.getElementById("auto-approve").checked,
        allowSubmissions: document.getElementById("allow-submissions").checked,
        openData: document.getElementById("open-data").checked,
      },
    });
    const origin = location.origin;
    const participate = `${origin}${data.urls.participate}`;
    const report = `${origin}${data.urls.report}`;
    const admin = `${origin}${data.urls.admin}`;
    document.getElementById("participate-url").textContent = participate;
    document.getElementById("report-url").textContent = report;
    document.getElementById("admin-url").textContent = admin;
    document.getElementById("admin-link").href = admin;
    document.getElementById("participate-link").href = participate;
    show(createdPanel, true);
    form.classList.add("hidden");
    createdPanel.scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    errorNode.textContent = `建立失敗：${error.message}`;
    show(errorNode, true);
    button.disabled = false;
  }
});

document.addEventListener("click", (event) => {
  const target = event.target.closest("button[data-copy]");
  if (!target) return;
  copyText(document.getElementById(target.dataset.copy).textContent.trim(), target);
});
