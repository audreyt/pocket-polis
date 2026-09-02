# Demo 資料存檔 · Demo data archive

`data/demo/` 保存兩場官方 demo 的每日快照，由 [archive-demo-data workflow](../.github/workflows/archive-demo-data.yml) 於每天 04:00（台北時間）自動更新；**git 歷史就是時間序列**，要看某天的狀態直接 checkout 該日的 commit。

Daily snapshots of the two official demo conversations, updated automatically at 20:00 UTC by the archive workflow; the git history itself is the time series.

| 目錄 | 討論 | 內容 |
|---|---|---|
| `demo/3ovoxq5c6o/` | 【模擬】國防軍購特別預算公投（中文） | `votes.csv`（長格式匿名投票）、`statements.csv`（意見與計數）、`results.json`（分群、代表性意見、共識） |
| `demo/qx7fc5m3ql/` | Simulated defense-budget referendum (English) | same three files |

## 出處與性質 · Provenance

- 兩場討論都以 **113 位虛構立法委員** 的模擬投票起始（[方法](../docs/demo-legislature-sim.md)），其後混入真實訪客的匿名投票與意見。**不是民調、不代表任何真實個人或群體的立場。**
- 參與者一律匿名化為 `p1, p2, …`（依加入順序），不含任何身分資訊。
- 用途：演算法調校的回歸測試（例如比較分群改動前後對同一份投票矩陣的結果）、功能開發的真實資料樣本。

## 授權 · License

Data: **CC BY 4.0**, attribution to "Pocket Polis demo (polis.mashbean.net)". Both conversations start from a fictional simulation and accumulate anonymous public votes; treat accordingly.
