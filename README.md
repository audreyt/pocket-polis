# polis-serverless

**用一個 Cloudflare Worker 走完一輪 Polis 式意見調查——只需要 GitHub + Cloudflare，沒有伺服器要維護。**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mashbean/polis-serverless)

線上展示：**<https://polis.mashbean.net>** · Demo 案例：[【模擬】國防軍購特別預算公投](https://polis.mashbean.net/r/3ovoxq5c6o)（113 位虛構立委的模擬樣本，見 [docs/demo-legislature-sim.md](docs/demo-legislature-sim.md)）

[Polis](https://pol.is)（[compdemocracy/polis](https://github.com/compdemocracy/polis)）是大規模意見調查工具：參與者對彼此提出的陳述投「同意／不同意／略過」，系統即時把投票矩陣降維、分群，找出意見群、各群代表性陳述與跨群共識。官方實作需要 Node API、Clojure math worker 與 PostgreSQL——這個 repo 的研究問題是：**能不能把「完整的一輪」壓進 serverless 原語裡？**（研究脈絡見 [docs/research.md](docs/research.md)）

答案是可以。本 repo 是一個可部署的完整實作：

- **發起討論**：設定題目、種子陳述、審核模式，取得參與／結果／管理三條連結
- **參與**：匿名投票（同意／不同意／略過）、提出新陳述、陳述路由（票少的優先被抽到）
- **審核**：主持人核准／退回陳述、開關討論、隨時加種子陳述
- **數學**：平均插補 → PCA（power iteration、sparsity-aware projection）→ k-means（silhouette 選 2–5 群）→ 各群代表性陳述（repness＋比例檢定）→ group-aware 共識——全部在 Worker 內即時計算
- **結果**：即時意見地圖（SVG）、「你在這裡」、各群代表句、共識句、全陳述統計、匿名化 CSV 匯出

## 架構

```text
瀏覽器（原生 ES modules，零 framework、零 build）
   │
Cloudflare Worker（src/index.ts：路由、驗證、安全標頭、靜態資產）
   │
Durable Object「Conversation」（一場討論一個 DO）
   ├─ 內建 SQLite：statements / votes / participants / meta
   └─ 數學管線（src/math/*）：投票變動時在 DO 內重算，結果快取於 meta
```

- 沒有 KV、D1、R2、Queues，也沒有任何外部服務；**Durable Object SQLite 是唯一的資料庫**（模式沿用 [call-in](https://github.com/mashbean/call-in)）。
- GitHub 的角色：原始碼、Deploy Button 來源。部署由 `wrangler deploy` 或 Cloudflare Workers Builds 完成。
- 零 runtime 依賴：`package.json` 只有 devDependencies。

## 快速開始

```bash
npm install
npm run dev        # 本機開發（wrangler dev）
npm run check      # tsc + vitest + wrangler deploy --dry-run
npm run deploy     # 部署到你的 Cloudflare 帳號（workers.dev 網址）
```

或直接按上面的 **Deploy to Cloudflare** 按鈕，讓 Cloudflare fork 這個 repo 並自動部署。要綁自訂網域：改 `wrangler.jsonc` 的 `env.production.routes` 後 `npm run deploy:production`。

### 讓 AI agent 幫你部署

把這段貼給 Claude Code / Cursor 等 coding agent（你只需要自己完成 `wrangler login` 的瀏覽器登入）：

> 請照 https://github.com/mashbean/polis-serverless/blob/main/AGENT.md 的說明，把 polis-serverless 部署到我的 Cloudflare 帳號（wrangler login 那一步我自己完成），部署完成後用 API 幫我建立第一場討論。

完整的 agent 操作手冊在 [AGENT.md](AGENT.md)；Claude Code 使用者可安裝 skill：

```bash
npx --yes github:mashbean/polis-serverless install-skill
```

## 一輪的走法

1. 首頁建立討論 → 立刻拿到三條連結（參與 `/c/<id>`、結果 `/r/<id>`、管理 `/a/<id>#token=…`）。管理金鑰放在 URL fragment，不會送到伺服器；伺服器只存 SHA-256。
2. 把參與連結發給大家。參與者一句一句投票，也可以提出新陳述（依設定直接公開或待審）。
3. 結果頁即時更新：4 人以上（各投滿門檻票數，官方的 7 票規則）就會開始分群。
4. 收尾：管理頁關閉討論，下載 `statements.csv` 與匿名化的 `votes.csv`（長格式，可直接餵給 [red-dwarf](https://github.com/polis-community/red-dwarf) 等工具交叉驗證）。

## API

| Method | Path | 說明 |
|---|---|---|
| POST | `/api/conversations` | 建立討論（回傳一次性管理金鑰） |
| GET | `/api/conversations/:id` | 公開資訊與計數 |
| GET | `/api/conversations/:id/next?pid=` | 下一句要投的陳述（加權隨機路由） |
| POST | `/api/conversations/:id/votes` | 投票 `{pid, sid, value: 1\|-1\|0}` |
| POST | `/api/conversations/:id/statements` | 提出陳述 `{pid, text}` |
| GET | `/api/conversations/:id/statements-public` | 已公開陳述的文字 |
| GET | `/api/conversations/:id/results?pid=` | 數學結果（含請求者自己的座標） |
| GET | `/api/conversations/:id/export/*.csv` | 資料匯出（管理者；openData 開啟時公開） |
| GET/POST | `/api/conversations/:id/admin*` | 審核、設定（`Authorization: Bearer <token>`） |

## 演算法

依 Polis 公開文獻（[The Computational Democracy Project — algorithms](https://compdemocracy.org/algorithms/)、Small et al. 2021《Polis: Scaling Deliberation by Mapping High Dimensional Opinion Spaces》）**重新實作**，未使用官方 AGPL 程式碼。細節與已知偏差列在 [docs/algorithm.md](docs/algorithm.md)。測試（`npm test`）包含合成資料的黃金案例：兩派對立票型必須分出兩群、共識句必須浮上共識清單。

已用官方 Polis 開放資料（CC BY 4.0）實測（[docs/validation-opendata.md](docs/validation-opendata.md)）：vTaiwan UberX、Brexit、Bowling Green 三個資料集**群數全對、與官方分群的 Adjusted Rand Index 0.78–0.86、purity 0.94–0.96**；最大資料集（22.5 萬票、607 句、2,010 人）236ms 算完。

## 限制（誠實條款）

- **防灌票是弱的**：參與者身分是瀏覽器 localStorage 裡的隨機 UUID，換瀏覽器＝新身分。適合信任圈內的社群、課堂、工作坊；不適合有對抗性的公共諮詢。這是 serverless 換來的取捨——官方 pol.is 用 cookie/xid 也只比這強一點。
- **規模**：數學在單一 DO 內同步重算，設計目標是數百～低千位參與者、數百句陳述（osccai-simulation 的量測：這個規模在 JS 是次秒級）。再大就該用官方 polis。
- **不是官方 pol.is**：與 The Computational Democracy Project 無隸屬關係；「Polis」用於描述方法論。分群結果與官方實作在細節上（base clustering 的 silhouette 加權、comment routing 公式）有已記載的偏差。

## License

MIT（見 [LICENSE](LICENSE)）。官方 polis 為 AGPL-3.0，本 repo 未使用其程式碼。
