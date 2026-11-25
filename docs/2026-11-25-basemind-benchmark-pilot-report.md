# dsh-basemind-plugin — 3C Pilot Report（2026-11-25）

- 角色：Execution Agent（Phase 3C）
- 基準 commit：`5bec005`（plugin 0.2.0，未 bump、未 publish）
- Harness：**Web API**（Standard preset，非 headless；3A-9 已判定 headless 不等價）
- 環境：Windows x64、Node 24.20.0、DSH 0.2.2-rc.5、BaseMind 0.34.0（PATH）
- Profile：`bm-bench-a`（group A：skills/bootstrap/cliTool=false）、`bm-bench-b`（group B：預設）
- 模型：DeepSeek `deepseek-account/deepseek-flash`／effort `max`；GPT `openai-codex/gpt-6.1-sol`／effort `low`
- BaseMind 隔離：兩組共用 `BASEMIND_DATA_HOME=C:/Users/sanny/AppData/Local/Temp/bm-bench/data`（使用者資料未動）
- Ground truth：`benchmark/ground-truth/*.json`，在 A/B 之前以原生 git／grep／閱讀建立

## 1. 執行順序（交錯）

| # | task | group | model | session |
| --- | --- | --- | --- | --- |
| 1 | B6-vue-fallback | A | deepseek | `39127a7c` |
| 2 | B6-vue-fallback | B | deepseek | `c77dc7cc` |
| 3 | B6-vue-fallback | B | gpt | `6cccb3a9` |
| 4 | B6-vue-fallback | A | gpt | `25d32400` |
| 5 | B1-java-symbol | A | deepseek | `c864bcf7` |
| 6 | B1-java-symbol | B | deepseek | `2d573224` |
| 7 | B1-java-symbol | B | gpt | `a9e443b8` |
| 8 | B1-java-symbol | A | gpt | `560f9600` |
| 9 | B3-java-impact | A | deepseek | `2eed09c4` |
| 10 | B3-java-impact | B | deepseek | `17a217ff` |
| 11 | B3-java-impact | B | gpt | `b753893f` |
| 12 | B3-java-impact | A | gpt | `7399c130` |

DeepSeek 採 A→B，GPT 採 B→A（計畫 §18.1 的交錯要求）。

## 2. 正確性（規則式評分，group 標籤在評分時不使用）

| task | label | verdict | 必要元素 | total tokens | tool calls | basemind calls | 耗時 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | A-deepseek | PASS | 4/4 | 319,499 | 14 | 11 | 33.3 s |
| B1 | B-deepseek | PASS | 4/4 | 202,762 | 9 | 9 | 19.7 s |
| B1 | A-gpt | PASS | 4/4 | 104,074 | 6 | 5 | 22.7 s |
| B1 | B-gpt | PASS | 4/4 | 316,400 | 9 | 7 | 48.4 s |
| B3 | A-deepseek | PASS | 4/4 | **418,519** | 32 | 32 | 60.5 s |
| B3 | B-deepseek | PASS | 4/4 | 335,742 | 24 | 24 | 51.4 s |
| B3 | A-gpt | PASS | 4/4 | 169,552 | 18 | 15 | 72.6 s |
| B3 | B-gpt | PASS | 4/4 | 313,668 | 18 | 14 | 75.6 s |
| B6 | A-deepseek | PASS | 5/5 | 291,548 | 15 | 11 | 32.5 s |
| B6 | B-deepseek | PASS | 5/5 | 375,513 | 19 | 11 | 37.9 s |
| B6 | A-gpt | PASS | 5/5 | 101,096 | 9 | 5 | 29.5 s |
| B6 | B-gpt | PASS | 5/5 | 213,347 | 9 | 5 | 37.3 s |

- **12/12 PASS**；B 組沒有任一任務由 PASS 退為 FAIL。
- 抽樣核對：B1 的回答都給出 `EditScheduleServiceImpl.java`、方法宣告第 676 行、class 名稱與 `EditScheduleApi.java:393` 呼叫者（A/GPT 甚至標了 675/676 兩行）。
- 兩組都使用 `mcp__basemind__*`（每輪 5–32 次），代表 A 組仍是「MCP-only」，不是原生工具 baseline（計畫 §16.1 的已知混淆因子）。
- **B3 A-deepseek 418,519 tokens 超過單輪 400k 上限**（計畫 §18.3）；該輪已完成，按規則記為超限，不重跑。
- Pilot 總用量 **3,163,622 tokens**（12 輪加總；含 cacheRead），略超 Pilot 3M 上限約 0.16M；使用者在本次授權「無預算上限」，因此不中止，但需在報告標明。

## 3. 流程與環境驗證（Pilot gate）

- Web API 建 session、送固定 prompt、等 `turn/end`、解析 session log 的 usage／工具序列：**可重跑**（12/12 完成，無 timeout）。
- 每輪都是新 session；A/B 使用同一個 BaseMind data home 與同一份索引。
- 索引：Vue `file_count 1061`（index_build_ms 9,028）、Java `file_count 6089`（index_build_ms 133,570）。**Java 首次索引 133.6 s** 才完成（extract 7692 檔 → resolve），符合「大型 repo 首次索引很慢」的預期。
- 環境問題與處置：全新的 `BASEMIND_DATA_HOME` 會先下載 tree-sitter language pack；本次該下載停住（目錄只有 `.download.lock`／`manifest.json`、無 `libs`），導致 index 停在 `extract 0/N`。把使用者 data home 已下載的 `tree-sitter-language-pack/v1.25.2`（33 MB）複製到 benchmark data home 後，Vue/Java 索引立即完成。此為**Benchmark 設定步驟**，不改產品程式碼；已記錄於 `benchmark/README.md` 的必要環境條件。
- 工具指標修正：第一版 harness 從 `tool/call.name` 取工具名（實際在 `data.name`），導致 basemind 呼叫數誤報 0；已修正並用 backfill 重新計算全部 12 輪（見上表）。

## 4. 初步觀察（Pilot 僅供流程驗證，不作效果結論）

- B 組在 GPT 的 B6 有 `skill` 載入（1 次），A 組沒有——符合 B 組多了 skills catalog 的設計。
- 同一任務內，A/B 的 token 差異不一致（B6-deepseek B 組較高、B1-deepseek B 組較低），Pilot 樣本太小，不能下結論；3D 才做統計。
- 兩個模型都大量使用 `mcp__basemind__code_*`，Vue 任務也一樣；B6 的「BaseMind 無 Vue 符號」限制並未造成無限重試（12/12 完成）。

## 5. 未完成／風險

- 3D（24 次 no-reuse：B1/B3/B6 重跑＋B2/B4/B5 各 4 次）尚未開始。
- 評分為規則式，尚未做人工抽樣（計畫 §19.3 要求抽樣）。
- 只驗 Windows x64；GPT／DeepSeek 的 usage 欄位已用 session log 統一換算（total = input + output + cacheRead）。
- Pilot 成本略超 3M 上限、單輪 B3 A-deepseek 超 400k，均如實記錄。

## 6. 產物位置

- 結果 JSON（每輪 usage／工具／耗時／最終答案）：`D:/_bm_phase3/bench/results/`
- 評分：`D:/_bm_phase3/bench/results/scores.json`（`node benchmark/score.mjs`）
- Harness：`benchmark/run.mjs`、`benchmark/score.mjs`、`benchmark/tasks/`、`benchmark/ground-truth/`
