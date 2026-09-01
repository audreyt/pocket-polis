# 演算法說明與已知偏差

本文件記錄 `src/math/` 的計算管線，以及與官方 polismath（Clojure）之間的已知偏差。實作依據為公開文獻：[compdemocracy.org/algorithms](https://compdemocracy.org/algorithms/) 與 Small et al. 2021《Polis: Scaling Deliberation by Mapping High Dimensional Opinion Spaces》。未閱讀、未取用官方 AGPL 程式碼。

## 管線

### 1. 投票矩陣（`matrix.ts`）

- 列＝參與者、欄＝已核准陳述；同意 = **+1**、不同意 = **−1**、略過 = **0**、未投 = 缺值。
  （注意：官方資料庫的原始編碼相反，agree 為 −1；red-dwarf 與本實作同用 agree=+1。匯出 CSV 時以本表示法為準。）
- **納入門檻**：參與者至少投 `min(7, 陳述數)` 票才進入分群（官方的 in-conversation 規則）。
- **插補**：缺值以該陳述的平均票值填補；再逐欄置中（置中後插補格為 0）。

### 2. 降維（`pca.ts`）

- Power iteration 求前兩主成分（官方同樣以 power method 逼近 PCA），收斂容忍 1e-10、上限 300 迭代，第二主成分以 Gram–Schmidt 對第一主成分正交化。
- **Sparsity-aware projection**（官方作法）：參與者座標只用實際投過的欄位計算，再乘 `sqrt(全部陳述數 / 該參與者投票數)`，避免投票少的人被插補值拉往原點。
- 決定性：PRNG（mulberry32）以 conversation id ＋資料規模為種子，同輸入必得同輸出（有測試）。

### 3. 分群（`kmeans.ts`）

- 參與者 >100 時先做 k=100 的 base clustering，再對 base centers（以群大小加權）分群；≤100 直接分。
- 群數 k 從 2 到 5 逐一嘗試，以 **silhouette 係數**最高者為準（官方相同）。
- k-means：k-means++ 初始化、加權 Lloyd 迭代、空群修補、4 次重啟取 inertia 最低。
- 參與者不足 4 人或所有點重合時不分群（k=1），只出地圖不出群報告。

### 4. 代表性陳述（`repness.ts`）

對每（群 g、陳述 s、方向 d ∈ {agree, disagree}）：

- `prob = (succ_in + 1) / (seen_in + 2)`（pseudocount 平滑）
- `probTest`：單比例 z 近似 `2·√n·(p − 0.5)`，檢定群內是否顯著傾向 d
- `repness = prob / prob_out`（群內機率 ÷ 群外機率，各含 pseudocount）
- `repnessTest`：雙比例 z 檢定（pooled 比例、+1 pseudocount）
- 入選門檻：`probTest > 1.2816`（90% 信賴，官方同值）且 `repnessTest > 1.2816` 且 `repness > 1`
- 排序 metric：`prob × probTest × repness × repnessTest`，每群取前 5；同一陳述兩方向皆入選時取 metric 高者；全滅時退取 metric 最高的一句（每群至少一句）。

### 5. 跨群共識（`repness.ts`）

- Group-aware consensus：對每陳述、每方向，metric ＝ **各群** `(succ_g+1)/(seen_g+2)` 的**乘積**——任何一群不買單，分數就垮。
- 另要求全體單比例檢定 `probTest > 1.2816`。同意與不同意各取前 5。

### 6. 陳述路由（`conversation.ts`）

下一句抽選：在參與者未投過的已核准陳述中，以 `1/(1+已得票數)` 加權隨機——票少的新陳述優先曝光。

## 與官方的已知偏差

| 項目 | 官方 | 本實作 | 理由 |
|---|---|---|---|
| base clustering 的 silhouette | 對 base centers 的加權細節未見於公開文獻 | 未加權 silhouette | 實測（[validation-opendata.md](validation-opendata.md)）：未加權在 3/4 開放資料集選中官方的 k；加權版反而誤選 |
| k 的選擇 | 線上 k-smoothing（k 只在 silhouette 明顯改善時改變，路徑依賴） | 已實作同款 k-smoothing（buffer 0.02，`selectK`）：線上重算時保留前一次的 k，除非新 k 明顯更好；批次（無歷史）仍取最高分 | 批次驗證在稀疏資料上仍可能比官方細分（見 football-concussions 案例，purity 0.835 顯示是再細分而非亂分） |
| comment routing | 帶 extremity 等因子的 priority 公式 | `1/(1+票數)` 加權隨機 | 簡化；效果同向（新句優先） |
| PCA 增量更新 | EMPCA 增量演算法（票進來就更新） | 每次全量重算＋快取（變動後最快 2 秒一次） | 規模目標內全量重算 <1s，簡單勝出 |
| moderation 分級 | strict/moderate 多段 | approve/reject 兩段 | 夠用 |
| 群數上限 | k ≤ 5 | 同 | — |

## 交叉驗證

管理頁匯出的 `votes.csv`（長格式、參與者匿名化為 p1、p2⋯）可轉成官方 participants-votes 格式後餵給 [red-dwarf](https://github.com/polis-community/red-dwarf)（宣稱完整重現官方管線）比對分群結果。歡迎把比對結果開 issue。
