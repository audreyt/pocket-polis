# Pocket Polis 口袋審議

**讓你可以隨時發起審議的口袋工具（A pocket tool for deliberation, anytime）——由 AI Agent 設計打造的輕量版 [Polis](https://compdemocracy.org/polis/)，在單一 Cloudflare Worker 上走完完整的一輪意見調查，沒有伺服器要維護。**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mashbean/pocket-polis)

線上：**<https://polis.tw>** · Demo：[【模擬】國防軍購特別預算公投](https://polis.tw/r/likyl6aasu)（113 位虛構立委的模擬樣本，見 [docs/demo-legislature-sim.md](docs/demo-legislature-sim.md)）· English: [README.md](README.md)

給審議工作者的實務指南：<https://polis.tw/guide>

## 它做什麼

- **一鍵發起**：設定題目與種子意見，拿到參與／結果／管理三條連結
- **參與**：匿名投票（同意／不同意／略過）、提出新意見，票少的意見優先曝光
- **審核**：核准或退回意見、開關討論
- **即時計算**：平均插補 → PCA（power iteration、sparsity-aware projection）→ k-means（silhouette 選 2–5 群，含 k-smoothing 讓群數在重新整理間保持穩定）→ 各群代表性意見（repness＋比例檢定）→ 跨群共識——全部在 Worker 內完成
- **結果頁與 AI 審議綜整**：含群體輪廓的即時意見地圖、「你在這裡」、議題分類焦點、跨群共通價值與關鍵張力分析附精確引用（原生 Cloudflare Workers AI `@cf/google/gemma-4-26b-a4b-it`）、各群代表意見、共識清單、匿名化 CSV 匯出（含 pol.is 相容的 `comments.csv`，可直接上傳 [Sensemaker](https://make.vtaiwan.tw/) 做 AI 綜整）
- **雙語**：完整中英介面（`?lang=`，自動偵測）

## 架構

```text
瀏覽器（原生 ES modules，零 framework、零 build）
   │
Cloudflare Worker（路由、驗證、安全標頭、Workers Cache、靜態資產）
   │
Durable Object「Conversation」（一場討論一個）
   ├─ 內建 SQLite：statements / votes / participants / 審議綜整快照
   ├─ 數學管線（src/math/*）：變動時重算並快取
   └─ AI 佇列消費者：Workers AI（@cf/google/gemma-4-26b-a4b-it）透過 Cloudflare Queues 非同步綜整
```

單場討論的自架部署完全運行在 Cloudflare Workers 免費額度內：每日 10 萬次請求、1 萬顆 Workers AI 神經元、1 萬次 Queues 操作與 5GB 儲存。零外部付費依賴。AI 審議綜整在資料成功生成後採用 24 小時滾動新鮮度週期（未變更資料永久快取，每日至多背景刷新 1 次；若失敗或遇配額上限則退避至隔日 00:00 UTC 重置），並透過 Workers Cache API 明確白名單進行公開邊緣快取。

**免費神經元硬契約：** `@cf/google/gemma-4-26b-a4b-it` 計費為 `neurons = input_tokens × 9091 / 1e6 + output_tokens × 27273 / 1e6`（[官方價目](https://developers.cloudflare.com/workers-ai/platform/pricing/)）。輸入 token 採保守**上限** `utf8_bytes(system)+utf8_bytes(user)+256`（chat template 開銷）——不是 JS `string.length`，也不是精確 tokenizer 計數。輸出以各次呼叫強制的 `max_tokens` 計（主題發現 2048、歸類批次 1536、最終綜整 4096）。每次 `ai.run` 前同步預留該次最壞神經元，單次生成總帳本上限 **9,000**（低於每日 10,000 免費額）。最終綜整額度先扣留，避免歸類重試吃掉最後一階段。Prompt 以 UTF-8 位元組封頂（發現 240,000、歸類批次 32,000、綜整 48,000），所有陳述 ID 都會保留；共識與張力證據各排序上限 24 筆。若入場或某階段放不進預算，改回可快取的確定性統計摘要（`generationMode: "deterministic"`，`model: "deterministic"`），絕不標成 Gemma。**Queue 是耐久與延遲隔離，不是神經元節省。** 一則 `<64KB` 訊息、`max_retries: 1` 最多 **4 次 Queue 操作**（1 寫 + 2 讀 + 1 刪；成功路徑 3 次），與神經元分開計算。
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

純數學 Polis 運算管線（PCA、k-means 分群、共識檢定與代表性意見分析）依 Polis 公開文獻（[compdemocracy.org/algorithms](https://compdemocracy.org/algorithms/)、Small et al. 2021）clean-room 重新實作，未使用官方 AGPL 程式碼。原生 AI 審議綜整管線設計概念參考了 [g0v/sensemaker-frontend](https://github.com/g0v/sensemaker-frontend/tree/6303d8)（鎖定 commit `6303d8`）、[bestian/sensemaker-backend](https://github.com/bestian/sensemaker-backend/tree/164a71)（鎖定 commit `164a71`）以及 [bestian/sensemaking-tools](https://github.com/bestian/sensemaking-tools/tree/b5fb897b13c3f25aaffb8fb0d453b4defde1962a)（鎖定 commit `b5fb897b13c3f25aaffb8fb0d453b4defde1962a`），並針對 Serverless 邊緣運行進行了完整重構。已用官方開放資料（CC BY 4.0）驗證（[docs/validation-opendata.md](docs/validation-opendata.md)）：vTaiwan UberX、Brexit、Bowling Green 三個資料集群數全對、ARI 0.78–0.86、purity 0.94–0.96；最大資料集（22.5 萬票、607 句、2,010 人）236ms 算完。已知偏差：[docs/algorithm.md](docs/algorithm.md)。

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
