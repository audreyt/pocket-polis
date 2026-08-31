# 開放資料驗證報告（2026-09-01）

用官方 Polis 公開的真實對話資料，驗證本 repo 數學管線的分群結果與計算效能。可重現：

```bash
# 資料來源：github.com/compdemocracy/openData（CC BY 4.0）
npx tsx scripts/validate-opendata.ts <dataset-dir> [...]
```

方法：把 `participants-votes.csv` 的投票矩陣餵進 `computeMath`（與正式站完全相同的程式碼），與官方發佈的分群（`group-id` 欄）比較。指標：

- **ARI**（Adjusted Rand Index）：分群一致性，1＝完全一致、0≈隨機。
- **purity**：我們的每一群落在官方同一群的比例——ARI 低但 purity 高＝我們只是把官方的群「再細分」，不是亂分。

## 結果

| 資料集 | 參與者（納入分群） | 投票 | 陳述 | ours k / official k | ARI | purity | 計算時間 |
|---|---|---|---|---|---|---|---|
| brexit-consensus | 204（189） | 5,303 | 50 | 2 / 2 | **0.857** | 0.963 | 24ms |
| vtaiwan.uberx | 1,912（1,218） | 49,348 | 119 | 2 / 2 | **0.775** | 0.942 | 58ms |
| american-assembly.bowling-green | 2,010（1,576） | 225,040 | 607 | 2 / 2 | **0.835** | 0.957 | 236ms |
| football-concussions | 1,468（582） | 13,784 | 161 | 4 / 2 | 0.161 | **0.835** | 51ms |

### 讀法

- 四個資料集中三個：**k 全對、ARI 0.78–0.86、purity 0.94–0.96**。考慮到 PCA 初始化、k-means 隨機重啟與實作細節都不同，這是「同一張意見地圖」等級的一致性。
- **vtaiwan.uberx**（2015 年 vTaiwan UberX 案，台灣脈絡）：完整重現官方的兩群結構，且共識第一名正是當年著名的「安全第一」句：「我覺得應該審核人員。乘客保障。駕駛權益都要兼顧。最重要還是安全第一」（92% 同意）。兩群的代表句也正確落在「Uber 未依法營業有風險」對「自用車載客威脅公安」的軸線上。
- **football-concussions 是已知偏差的實例**：這個資料集特別稀疏（582 位納入分群者平均只投了 24/161 句）。官方的 k=2 來自其線上服務的 **k-smoothing**（k 只有在 silhouette 明顯改善時才會改變，歷史路徑依賴）；我們是批次重算，silhouette 在 k=4（0.354）確實高於 k=2（0.303）。purity 0.835 顯示我們的四群大致是官方兩群的再細分。這記載於 [algorithm.md](algorithm.md) 的偏差表。
- **效能**：最大的資料集（22.5 萬票、607 句、2,010 人）在 Node 上 236ms——遠低於 Durable Object 的請求預算，證實「數學放在 Worker 內同步重算」的設計在目標規模（數百～低千人）完全可行。

### 曾嘗試並否決的變更

把 base-cluster silhouette 改成以群大小加權（直覺上更貼近官方）實測反而更差：brexit 從 ARI 0.857 掉到 0.624（k 誤選 3）。未加權版本在 3/4 資料集選中正確的 k，故維持未加權，並記入偏差表。

## 資料授權

Data was gathered using the Polis software (compdemocracy.org/polis) and is sub-licensed under CC BY 4.0 with Attribution to The Computational Democracy Project. The data and more information about how the data was collected can be found at: https://github.com/compdemocracy/openData
