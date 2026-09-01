# Pocket Polis 口袋審議

**讓你可以隨時發起審議的口袋工具（A pocket tool for deliberation, anytime）——由 AI Agent 設計打造的輕量版 [Polis](https://compdemocracy.org/polis/)，在單一 Cloudflare Worker 上走完完整的一輪意見調查，沒有伺服器要維護。**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mashbean/pocket-polis)

線上：**<https://polis.mashbean.net>** · Demo：[【模擬】國防軍購特別預算公投](https://polis.mashbean.net/r/3ovoxq5c6o)（113 位虛構立委的模擬樣本，見 [docs/demo-legislature-sim.md](docs/demo-legislature-sim.md)）· English: [README.md](README.md)

給審議工作者的實務指南：<https://polis.mashbean.net/guide>

## 它做什麼

- **一鍵發起**：設定題目與種子意見，拿到參與／結果／管理三條連結
- **參與**：匿名投票（同意／不同意／略過）、提出新意見，票少的意見優先曝光
- **審核**：核准或退回意見、開關討論
- **即時計算**：平均插補 → PCA（power iteration、sparsity-aware projection）→ k-means（silhouette 選 2–5 群，含 k-smoothing 讓群數在重新整理間保持穩定）→ 各群代表性意見（repness＋比例檢定）→ 跨群共識——全部在 Worker 內完成
- **結果頁**：含群體輪廓的即時意見地圖、「你在這裡」、各群代表意見、共識清單、匿名化 CSV 匯出
- **雙語**：完整中英介面（`?lang=`，自動偵測）

## 架構

```text
瀏覽器（原生 ES modules，零 framework、零 build）
   │
Cloudflare Worker（路由、驗證、安全標頭、靜態資產）
   │
Durable Object「Conversation」（一場討論一個）
   ├─ 內建 SQLite：statements / votes / participants
   └─ 數學管線（src/math/*）：變動時重算並快取
```

沒有 KV、D1、R2、Queues 或外部服務——Durable Object SQLite 是唯一的資料庫。零 runtime 依賴。Cloudflare 免費方案即可運作（每天 10 萬請求、5GB 儲存）。「這真的是 serverless 嗎」的完整討論：[docs/is-this-serverless.md](docs/is-this-serverless.md)。

## 快速開始

```bash
npm install
npm run dev        # 本機開發
npm run check      # tsc + vitest + wrangler deploy --dry-run
npm run deploy     # 部署到你的 Cloudflare 帳號
```

或按上方 **Deploy to Cloudflare** 按鈕。要綁自訂網域：改 `wrangler.jsonc` 的 `env.production.routes` 後 `npm run deploy:production`。

### 讓 AI agent 幫你部署

把這段貼給 Claude Code / Cursor 等 coding agent（你只需自己完成 `wrangler login` 的瀏覽器登入）：

> 請照 https://github.com/mashbean/pocket-polis/blob/main/AGENT.md 的說明，把 Pocket Polis 部署到我的 Cloudflare 帳號（wrangler login 那一步我自己完成），部署完成後用 API 幫我建立第一場討論。

完整的 agent 操作手冊在 [AGENT.md](AGENT.md)；Claude Code 使用者可安裝 skill：

```bash
npx --yes github:mashbean/pocket-polis install-skill
```

## 演算法忠實度

演算法依 Polis 公開文獻（[compdemocracy.org/algorithms](https://compdemocracy.org/algorithms/)、Small et al. 2021）clean-room 重新實作，未使用官方 AGPL 程式碼。已用官方開放資料（CC BY 4.0）驗證（[docs/validation-opendata.md](docs/validation-opendata.md)）：vTaiwan UberX、Brexit、Bowling Green 三個資料集群數全對、ARI 0.78–0.86、purity 0.94–0.96；最大資料集（22.5 萬票、607 句、2,010 人）236ms 算完。已知偏差：[docs/algorithm.md](docs/algorithm.md)。

## 授權與命名

- **程式碼採 MIT**（[LICENSE](LICENSE)）。官方 polis 是 AGPL-3.0，但本專案完全沒有使用其程式碼——演算法依公開論文與文件重新實作，著作權不及於方法本身，AGPL 的義務跟著程式碼走，因此 MIT 與上游規則相容，毋須改採 AGPL。
- 名稱中的「Polis」指方法論（如 polislite、LitePolis、PolisOrbis、Polis Japan 等社群慣例）。Pocket Polis 與 The Computational Democracy Project 的 pol.is **無隸屬關係**。

## 社群

- [行為準則](CODE_OF_CONDUCT.md)——含示範站的下架規範
- Issue 與 PR 歡迎：<https://github.com/mashbean/pocket-polis/issues>

## 使用上的限制

- **防灌票是弱的**：參與者身分是瀏覽器 localStorage 裡的隨機 UUID。適合信任圈內的社群、課堂、工作坊；高對抗性的公共諮詢請用官方 pol.is。
- **規模**：數學在單一 Durable Object 內同步重算，設計目標是數百～低千位參與者、數百句意見。

Created and maintained by [mashbean](https://github.com/mashbean).
