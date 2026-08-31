# 研究筆記：有沒有人做過 serverless Polis？（2026-08-31）

研究問題：像 call-in.mashbean.net 或 lifeboat.matters.town 那樣，**只用 GitHub + Cloudflare、不自架伺服器**，能不能走完一輪 Polis（提陳述 → 投票 → 分群 → 代表性陳述與共識）？如果有人做過，他怎麼做？

## 結論

**截至 2026-08，沒有找到任何「免 server 走完整輪」的 Polis 實作。** 所有完整產品都需要傳統伺服器＋資料庫；已存在的 serverless 化嘗試都只做了「分析」那一半，沒有投票後端。因此本 repo 補上缺的另一半。

## 已存在的東西（調查範圍：awesome-polis 全清單 + GitHub 搜尋）

### 完整實作——全部需要伺服器

| 專案 | 技術 | 為什麼不是 serverless |
|---|---|---|
| [compdemocracy/polis](https://github.com/compdemocracy/polis)（官方，AGPL-3.0） | Node API + Clojure math worker + PostgreSQL | 三個常駐服務＋資料庫；Cloudflare 上沒有對應原語（delib 的 `docs/polis-hosting.md` 已做過這個評估，結論是走共用 VM） |
| [canvasxyz/metropolis](https://github.com/canvasxyz/metropolis) | 新前端＋GitHub 整合 | 仍是 polis 後端架構 |
| [Goodheart-Labs/viewpoints.xyz](https://github.com/Goodheart-Labs/viewpoints.xyz) | Next.js + Postgres | 需要資料庫服務 |
| [zkorum/agora](https://github.com/zkorum/agora)、EJ Platform（巴西）、[partici.app](https://partici.app/)（荷蘭）、suburb、PolisOrbis、DigiFinland/Voxit（芬蘭） | 各式 | 全部有自己的 server + DB |

### 演算法重實作——只有數學，沒有調查後端

| 專案 | 說明 |
|---|---|
| [raykyri/osccai-simulation](https://github.com/raykyri/osccai-simulation)（[demo](https://polis-simulation.vercel.app/)） | **關鍵先例**：Polis 核心分析演算法的 TypeScript 瀏覽器實作，用 CC 授權的真實 Polis 資料驗證過，數百～數千參與者 × 數百陳述跑 300ms–1s。證明「Polis 數學不需要 Clojure worker，JS 就夠快」。但它吃現成 CSV，沒有投票收集；**且 repo 無授權條款，程式碼不能取用**。 |
| [polis-community/red-dwarf](https://github.com/polis-community/red-dwarf) | Python 重實作，宣稱「exactly reproduces the stock Polis calculation pipeline」。可作為本 repo 匯出資料的交叉驗證工具。 |
| [eterps/polislite](https://github.com/eterps/polislite)、[NewJerseyStyle/LitePolis](https://github.com/NewJerseyStyle/LitePolis) | Python 輕量重實作，同樣是 library 不是服務。 |

### 判斷

拼圖兩塊都已被別人各自證明：
1. **數學可以進 JS**（osccai-simulation 的量測數據）；
2. **調查型應用的狀態可以全部塞進 Durable Object SQLite**（call-in 的既有實踐，連 20MB PDF 都存 DO）。

沒有人把兩塊拼在一起。本 repo 做的就是這件事：投票、陳述、審核狀態放 DO SQLite；PCA + k-means + repness 在 Worker 內重算並快取。

## 本工作區的既有脈絡

- `repos/delib` 的 polis 整合目前是嵌官方 pol.is iframe（`public/integrations/polis.js`），`docs/polis-hosting.md` 評估過自架、結論是排除 Cloudflare-native、規劃共用 VM——本 repo 是那份評估的第三條路：**不搬官方 codebase，改為重新實作**。
- 若 polis-serverless 成熟，delib 的 polis 整合可以多一個「self-hosted serverless」選項，解掉 `polis-hosting.md` 記載的 implicit-creation／moderation 連結歸屬問題（每場討論的管理金鑰直接交給發起人，不經過任何 operator）。

## 授權注意

官方 polis 是 AGPL-3.0，osccai-simulation 無授權條款：**兩者的程式碼都不能進本 repo**。本 repo 的演算法依公開文獻（compdemocracy.org/algorithms、Small et al. 2021）重新實作，授權 MIT。「Polis」一詞僅用於描述方法論。
