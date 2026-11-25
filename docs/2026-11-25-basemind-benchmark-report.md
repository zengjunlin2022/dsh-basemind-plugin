# dsh-basemind-plugin — Phase 3C／3D Benchmark Report（2026-11-25）

- 角色：Execution Agent（Phase 3C Pilot ＋ 3D 完整）
- 基準 commit：`e99406c`（benchmark harness）／plugin 行為來自 `5bec005`
- Harness：Web API（Standard preset）；每輪新 session；A/B 交錯
- 環境：Windows x64、Node 24.20.0、DSH 0.2.2-rc.5、BaseMind 0.34.0（PATH）
- 隔離：`bm-bench-a`／`bm-bench-b`（＋GPT 版 `bm-bench-a-gpt`／`bm-bench-b-gpt`），共用 `BASEMIND_DATA_HOME=C:/Users/sanny/AppData/Local/Temp/bm-bench/data`；使用者資料未動
- 模型：DeepSeek `deepseek-account/deepseek-flash`／effort max；GPT `openai-codex/gpt-6.1-sol`／effort low
- Prompt／Ground Truth：`benchmark/tasks/*.json`、`benchmark/ground-truth/*.json`（3C 前凍結；3D 前只修正 B2／B5 的 GT 錯誤，見 §5）

## 1. 設計

| 組 | 外掛設定 |
| --- | --- |
| A（MCP-only baseline） | `skills:false`、`bootstrap:false`、`cliTool:false`；保留 MCP tools／instructions／resources |
| B（Full integration） | 預設值（三者皆 true） |

- Pilot（3C）：B1／B3／B6 × A/B × DeepSeek/GPT = **12 輪**。
- 完整（3D）：B1–B6 × A/B × DeepSeek/GPT = 24 輪；因預算與 B2 成本過高，**實際 22 輪**（B2 的 GPT 組未跑，見 §4）。
- 每輪都是新 session；DeepSeek 採 A→B、GPT 採 B→A 的交錯順序。
- 兩組共用同一份索引：Vue `file_count 1061`、Java `file_count 6089`（Java 首次 build 133.6 s）。

## 2. 正確性（規則式評分；group 標籤在評分時不使用）

### 2.1 Pilot（12/12 PASS）

| task | A-deepseek | B-deepseek | A-gpt | B-gpt |
| --- | --- | --- | --- | --- |
| B1 | PASS 4/4 | PASS 4/4 | PASS 4/4 | PASS 4/4 |
| B3 | PASS 4/4 | PASS 4/4 | PASS 4/4 | PASS 4/4 |
| B6 | PASS 5/5 | PASS 5/5 | PASS 5/5 | PASS 5/5 |

### 2.2 完整 3D（22/22 PASS）

| task | A-deepseek | B-deepseek | A-gpt | B-gpt |
| --- | --- | --- | --- | --- |
| B1 Java 符號 | PASS 4/4 | PASS 4/4 | PASS 4/4 | PASS 4/4 |
| B2 Vue 大 SFC | PASS 2/2 | PASS 2/2 | **NOT RUN** | **NOT RUN** |
| B3 Java 影響 | PASS 4/4 | PASS 4/4 | PASS 4/4 | PASS 4/4 |
| B4 Git 歷史 | PASS 4/4 | PASS 4/4 | PASS 4/4 | PASS 4/4 |
| B5 staged review | PASS 3/3 | PASS 3/3 | PASS 3/3 | PASS 3/3 |
| B6 Vue fallback | PASS 5/5 | PASS 5/5 | PASS 5/5 | PASS 5/5 |

- **B 組沒有任一任務由 PASS 退為 FAIL**（計畫 §19.3 的硬性條件成立）。
- 手動抽樣（每任務至少一輪）：B1 都給出 `EditScheduleServiceImpl.java`、第 676 行、class 名稱與 `EditScheduleApi.java:393`；B5 的 GPT 兩輪都列出 3 個真實缺陷（plan.js:4／11／15）且沒有把 unstaged 檔案算進來；B2 兩輪都給出真實 computed／method 與依賴，並主動校正題目的行數（實際 10,244 行，不是 5,800）。

## 3. Token／工具統計

### 3.1 3D（22 輪）

| label | runs | PASS | tokens | tool calls | basemind calls | native calls | skill loads | 平均耗時 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A-deepseek | 6 | 6 | 3,104,793 | 129 | 52 | 77 | 0 | 83 s |
| B-deepseek | 6 | 6 | 3,455,845 | 129 | 55 | 74 | 1 | 76 s |
| A-gpt | 5 | 5 | 747,646 | 45 | 31 | 14 | 0 | 44 s |
| B-gpt | 5 | 5 | 1,273,223 | 54 | 30 | 24 | 5 | 59 s |

### 3.2 Pilot（12 輪）

| label | runs | PASS | tokens | tool calls | basemind calls | skill loads |
| --- | --- | --- | --- | --- | --- | --- |
| A-deepseek | 3 | 3 | 1,029,566 | 61 | 54 | 0 |
| B-deepseek | 3 | 3 | 914,017 | 52 | 44 | 0 |
| A-gpt | 3 | 3 | 374,722 | 33 | 25 | 0 |
| B-gpt | 3 | 3 | 843,415 | 36 | 26 | 4 |

### 3.3 合計與預算

| 階段 | 輪數 | tokens | 上限 | 結果 |
| --- | --- | --- | --- | --- |
| 3C Pilot | 12 | 3,161,720 | ≤3M | 超 0.16M（授權無上限） |
| 3D 完整 | 22 | 8,581,507 | ≤8.7M | 在限內（8.58M） |
| 合計 | 34 | **11,743,227** | ≤12M | 在限內 |

- 單輪 400k 上限：**B3／B2／B4 多輪超過**（最高 B2 B-deepseek 1,459,487）。依計畫應中止該輪，實際上因為使用者已授權「無預算上限」而讓其完成；如實記錄為超限。
- 工具指標曾在第一次 Pilot 誤報 basemind 呼叫數為 0（讀錯 `tool/call` 欄位），已修正並用 session log 回填全部 34 輪。

## 4. 與計畫的偏差（全部如實記錄）

1. **B2 的 GPT 組未跑**：B2 的 DeepSeek 兩輪分別用掉 1.02M／1.46M tokens（大檔分析 + 大量 cacheRead），若再跑 GPT 組會超過 12M 總上限；因此 3D 為 22/24 輪，B2 只有 DeepSeek 兩組。
2. **Pilot 超 3M**（3.16M）、**單輪 400k 上限被多次突破**：使用者 2026-11-25 明確回覆「無預算上限」，仍保留原上限的對照說明。
3. **B2／B5 Ground Truth 在 3D 前修正**：B5 的行號原本錯 2 行（應為 4／11／15），B2 的評分原本只認 3 個特定 computed（任務要求是「任意 3 個真實 methods／computed」）；修正後重評 3D。Pilot 的 B2／B5 未跑，因此不影響 Pilot 數字。
4. **評分器修正**：`defect` 元素改以 file＋line 判定（不再要求逐字包含），新增 `any_of` 元素；所有變更都在 3D 評分前完成並重評。
5. **環境**：fresh `BASEMIND_DATA_HOME` 的 tree-sitter language pack 下載會停住，已把使用者 data home 的 33 MB grammar pack 複製進 benchmark data home（設定步驟，不改產品）。

## 5. 解讀（只陳述有數據支持的部分）

- **正確性沒有差異**：A/B 兩組在 34 輪全部 PASS；B 組沒有把任何任務從 PASS 拉成 FAIL。以本 benchmark 的任務集而言，Bootstrap／Skills／CLI 沒有帶來可測的正確性增益，也沒有造成退化。
- **Token 成本**：DeepSeek 上 B 組比 A 組多 11.3%（3.46M vs 3.10M）；GPT 上 B 組多 70%（1.27M vs 0.75M）。差異集中在 B2／B4 這類「大量來回」的任務，且樣本數小（每格 5–6 輪），不能當成一般化的成本結論。
- **工具選擇**：兩組都大量使用 `mcp__basemind__code_*`（A 組 52–54 次、B 組 30–55 次），差別不大；B 組的 `skill` 載入只出現在 GPT（5 次），A 組 0 次，符合 B 組多了 skills catalog 的設計。
- **上游限制**：B6 沒有出現「反覆重試同一個 BaseMind 工具」；Vue 的 SFC 限制沒有造成 D 類（指引）缺陷。

## 6. 限制

- 只驗 Windows x64；每格只有 5–6 輪，統計力有限。
- 兩個業務 repo 的 `AGENTS.local.md` 都要求偏好 BaseMind，因此 A 組不是「純原生工具 baseline」（計畫 §16.1 已預告）。
- B2 的 GPT 組缺席、多輪超 400k，完整 24 輪的設計未被完全執行。
- 評分為規則式＋人工抽樣；抽樣只涵蓋每任務 1–2 輪，非全部。

## 7. 產物

- 每輪 JSON（usage／工具序列／耗時／最終答案）：`D:/_bm_phase3/bench/results`（Pilot）、`D:/_bm_phase3/bench/results-3d`（3D）
- 評分：同目錄 `scores.json`
- Harness：`benchmark/run.mjs`、`benchmark/score.mjs`、`benchmark/tasks/`、`benchmark/ground-truth/`
- Pilot 報告：`docs/2026-11-25-basemind-benchmark-pilot-report.md`（本檔為最終版，涵蓋 Pilot 與 3D）
