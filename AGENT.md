# AGENT.md — 給 AI agent 的操作手冊

你是一個 coding agent，使用者想要「自己的 Polis」。這份文件讓你在使用者只做**一件事**（登入他自己的 Cloudflare）的前提下，替他完成其餘全部工作。

polis-serverless 是跑在單一 Cloudflare Worker + Durable Object 上的完整 Polis 式意見調查（提陳述→投票→PCA+k-means 意見分群→代表性陳述與跨群共識）。免費方案即可運作，沒有伺服器與資料庫要維護。

## 部署流程（使用者只需要登入 Cloudflare）

```bash
git clone https://github.com/mashbean/polis-serverless.git
cd polis-serverless
npm install
npx wrangler login   # ← 唯一需要使用者動手的一步：瀏覽器會開啟 Cloudflare 授權頁
npm run check        # tsc + 測試 + dry-run，全綠再部署
npm run deploy       # 完成後輸出 https://polis-serverless.<subdomain>.workers.dev
```

- `npx wrangler login` 會開瀏覽器做 OAuth。**請使用者本人**在瀏覽器完成登入與授權，你只負責執行指令與等待；不要向使用者索取 API token 或密碼。若在無瀏覽器的環境，改請使用者到 Cloudflare dashboard 建立 API Token（Edit Workers 權限）並自行設定 `CLOUDFLARE_API_TOKEN` 環境變數。
- 沒有 Cloudflare 帳號的使用者：請他先到 <https://dash.cloudflare.com/sign-up> 註冊（免費方案即可），你不能代辦註冊。
- 部署成功的判準：`npm run deploy` 輸出 workers.dev 網址，且 `GET <網址>/api/health` 回 `{"ok":true,...}`。

### 綁自訂網域（選用）

使用者的網域需已在他的 Cloudflare 帳號託管。在 `wrangler.jsonc` 的 `env.production.routes` 改成他的網域：

```jsonc
"routes": [{ "pattern": "polis.example.com", "custom_domain": true }]
```

然後 `npm run deploy:production`。Cloudflare 會自動建立 DNS 與憑證。

## 替使用者走完一輪 Polis（API）

部署完成後，你可以直接用 API 幫使用者發起與管理討論。`BASE` 是他的部署網址。

```bash
# 1. 建立討論（回傳一次性 adminToken——交給使用者保存，不要印進共享的 log）
curl -X POST $BASE/api/conversations -H 'Content-Type: application/json' -d '{
  "title": "…", "description": "…",
  "seedStatements": ["…", "…"],
  "autoApprove": true, "allowSubmissions": true, "openData": false
}'
# → {conversationId, adminToken, urls:{participate, report, admin}}
```

| 端點 | 用途 |
|---|---|
| `GET /api/conversations/:id` | 公開資訊與計數 |
| `GET /api/conversations/:id/next?pid=<uuid>` | 抽下一句給參與者投 |
| `POST /api/conversations/:id/votes` `{pid,sid,value:1\|-1\|0}` | 投票（1=同意） |
| `POST /api/conversations/:id/statements` `{pid,text}` | 提出新陳述（≤280 字） |
| `GET /api/conversations/:id/results` | 分群、代表句、共識（JSON） |
| `GET /api/conversations/:id/export/{votes,statements}.csv` | 匿名化匯出（帶 `?token=` 或 openData 時公開） |
| `GET/POST /api/conversations/:id/admin*` | 審核與設定（`Authorization: Bearer <adminToken>`） |

- `pid` 是參與者自產的 UUID（網頁版存 localStorage）。程式化代理多位參與者時，每位一個固定 UUID。
- 分享連結：參與 `/c/:id`、結果 `/r/:id`、管理 `/a/:id#token=…`（金鑰在 fragment，不會進 server log）。

## 安全與禮貌規則

- **管理金鑰**：只把 adminToken 交給使用者（或存進他指定的秘密管理處）。不要印進會被分享的輸出、不要 commit。遺失無法找回，只能重建對話。
- **不要對別人的部署灌資料**：只在使用者自己的部署（或他明確授權的站點）上建立對話與模擬投票。官方展示站 polis.mashbean.net 有建立頻率限制（10 場/小時、50 場/天）。
- **模擬資料要標示**：像 `scripts/seed-demo-legislature.mjs` 那樣的模擬樣本，標題與描述必須明示「模擬／虛構」，人物一律化名。
- 預設**不要**代替使用者把 repo fork 成公開、也不要動 DNS，除非他明確要求。
- 升級檢查：`git pull && npm install && npm run check && npm run deploy`（Durable Object 資料在 Cloudflare 端，重新部署不會消失）。

## 給人類的替代路徑

不想用 agent 的使用者可以直接按 README 的 **Deploy to Cloudflare** 按鈕（Cloudflare 會 fork repo 並自動部署），或照上面六行指令手動執行。
