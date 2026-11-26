# BaseMind Dashboard：官方測試環境（DSH_TEST）複驗與 P5 量測報告

日期：2026-11-26　執行者：lead　範圍：0.2.2 Dashboard，於 `D:\02_zengjunlin\DSH_TEST` 的官方 DSH Desktop Development
環境複驗，並補完前一份報告標為 NOT RUN 的兩項：**P5 30 次以上 Agent 延遲取樣**與**headless（無 Web server）組合**。

與前一份報告的關係：`docs/2026-11-25-basemind-dashboard-desktop-acceptance-report.md` 是「隔離 `DSH_HOME` ＋
`dsh web` 實例」的驗收（結論不變）；本報告是**官方測試環境**（真實 DSH Desktop Host、同一 checkout
`dsh-v0.2.2-rc.5`、測試 BaseMind data home）的複驗與量測，兩者互補、不互相取代。

## 0. 結論摘要

| 項目 | 結果 |
| --- | --- |
| 測試環境基線 | **PASS**：`status-test.ps1` 乾淨、`verify-test.ps1` **22 passed / 0 failed**（Desktop 運行中） |
| 插件在測試 Desktop 載入 | **PASS**：`entryId` 對應 row `dsh-basemind`、`dsh-basemind-plugin`、`运行中` |
| Configure 控件（T1 結論複驗） | **PASS**：`配置 BaseMind（工作區感知）` 存在於套件詳情頁的「包含的組件」列，按下即開 Dashboard |
| Dashboard 路由在 Desktop Host | **PASS**：renderer 內 `fetch('/api/dsh-basemind-dashboard/workspaces')` → **200**（vue3-demo registry id） |
| 四個 tab（真實 Desktop） | **PASS**：Overview／Scan／Diagnostics／Statistics 都有測試 fixture 的真實資料 |
| 增量掃描（真實 Desktop） | **PASS**：`src/main.js` → 完成 `214 ms`、歷史列 `2026/11/26 11:26:26`、3 秒輪詢可見 |
| **P5 Agent 延遲取樣** | **PASS（已量測）**：60 個樣本（40 真實負載 + 20 飽和負載），**未偵測到可重複的回歸**（§4） |
| **headless 組合** | **PARTIAL**：組合無 webServer、插件 19 個 BaseMind 工具照常註冊；模型回合因**憑證只在 Desktop 可用**而 `MISSING_CREDENTIAL`（§5） |
| 環境收尾 | Desktop 還原為「已停止」、63 個量測 session 刪除、headless profile 與其插件掛載移除、正式環境未觸碰 |

## 1. 環境與隔離

| 項目 | 值 |
| --- | --- |
| 測試根目錄 | `D:\02_zengjunlin\DSH_TEST` |
| 官方 checkout | `src\deepseek-harness`，tag `dsh-v0.2.2-rc.5`，HEAD `9c2670d3bc` |
| DSH_HOME | `desktop-home`（正式 `C:\Users\sanny\.dsh` 未觸碰） |
| BaseMind data／comms | `basemind\data`／`basemind\comms`（測試 daemon 與正式 pid 11048 分離） |
| 插件掛載 | `link:D:/02_zengjunlin/github/dsh-basemind-plugin`，profile bundles 含 `dsh-basemind-plugin` |
| 驅動方式 | renderer CDP（`http://127.0.0.1:19222`）以 `Runtime.evaluate` 操作真實 UI 與 `/api/*` |
| 測試 fixture | `fixtures\vue3-demo`（4 檔、2 語言、索引 1.2 KB） |

所有操作都在測試環境內；正式 Desktop（15 個進程）與正式 BaseMind daemon（pid 11048）全程存活、未受影響。

## 2. T1 複驗：Configure 控件在官方環境同樣存在

- Plugins 頁 → `查看 BaseMind（工作區感知）` → 詳情頁「包含的組件」區塊：
  `[data-plugin-rows]` 內有 row `dsh-basemind`／`dsh-basemind-plugin`／`运行中`，控制項為
  `配置 BaseMind（工作區感知）` 與 `启用组件 BaseMind（工作區感知）`。
- 按下配置 → `[data-plugin-config]` 掛載，出現「專案／總覽／掃描／診斷／統計」。
- 因此前一日的結論（控件存在，只是不在「已安裝插件」清單列）在官方 Desktop 也成立；
  README 兩份 §16 已改為「Plugins → 查看 BaseMind → 包含的組件 → 配置」。

**由此確認 Desktop 也會組合 web server**：測試 profile 的 bundles 含 `@deepseek-ai/dsh-web-app`，
所以 Host 有 webServer，Dashboard 路由族在 Desktop 內同樣註冊（renderer 以 `dsh-app://app` 相對路徑
`fetch('/api/dsh-basemind-dashboard/…')` 取得 200）。

## 3. 四個 tab 與掃描（真實 Desktop 資料）

| Tab | 實測（節錄） |
| --- | --- |
| Overview | 專案 `vue3-demo`；已索引文件 `4`、Blob `4`、索引大小 `1.2 KB`、語言 `2`、索引健康 `索引可用`、分支/HEAD `master`；語言分佈 javascript 2（50%）／vue 2（50%）；最多被引用 `src/App.vue 1`；「最近一次 Dashboard 掃描」 |
| Scan | 目前任務、全量掃描（確認式）、增量掃描輸入、最近 10 次、「BaseMind 0.34.0 沒有掃描進度 API」 |
| Diagnostics | 外掛版本 `0.2.2`、Binary `BaseMind 0.34.0 match`、索引 `索引可用`、`1 relay`；檢查 `version/root/config/index/grammars(9 downloaded)/hook(pre-commit hook not installed (optional))/daemon(running, pipe)/cache(no GC recorded yet)`；唯讀聲明 |
| Statistics | 工具呼叫 `5`（index_status 3、code_symbols 2）、回應位元組 `2.3 KB`、磁碟用量 `198 KB`、查詢程序峰值 RSS `41.9 MB`、快取組成、三條統計範圍說明 |

增量掃描（UI 操作）：輸入 `src/main.js` → 按下「增量掃描」→ 約 5 秒內看到 `完成`，`已耗時 214 ms`、
`掃描 1 更新 0 移除 0 略過 0 錯誤 0`，歷史列 `2026/11/26 11:26:26　增量掃描　完成　214 ms　1`。

截圖：`D:\02_zengjunlin\DSH_TEST\scratch\p5-acceptance\overview-desktop.png`（真實 Desktop、淺色主題、zh）。

語言觀察與前一份報告一致：Statistics 的「統計範圍」在中文介面仍有兩條英文（Host payload 硬編字串
`lib/dashboard/service.js:396-397`），本會話未改產品碼。

## 4. P5：Dashboard 負載下的 Agent 延遲（已量測）

### 4.1 方法

- 在**同一個真實 Desktop Host** 上，以 renderer 的 `/api/session/create`＋`/api/session/prompt`
  建立新 session（cwd = `fixtures\vue3-demo`），送固定 prompt（只呼叫一次
  `mcp__basemind__code_symbols`，回答路徑與行號）。
- 時間戳全部取自 session log 自己的 `time` 欄位：`turnMs = turn/end.time − turn/start.time`；
  `toolMs` = 同一組 `tool/call` → `tool/result` 的差值。不依賴外部時鐘。
- 條件 A（baseline）= 沒有 Dashboard 負載；條件 B（loaded）= 該回合進行期間持續跑 Dashboard 負載。
  **交錯執行 A,B,A,B…**，讓 provider 漂移對兩邊影響相同。
- 負載兩種強度：

  | 模式 | 每輪負載 | 樣本 |
  | --- | --- | --- |
  | 真實（頁面本身的行為） | `POST /scan` → 每 3 秒 `GET /scan` 輪詢 → `GET /overview?refresh=1`，共 80 個 dashboard 請求 | 20 輪＝40 樣本 |
  | 飽和（探靈敏度上限） | `scan`＋`diagnostics`＋`statistics`＋`overview(refresh)` 連續無間隙，共 124 個請求 | 10 輪＝20 樣本 |

- 所有樣本都以「1 次工具呼叫、答案 `src/main.js:5`」完成（40 + 20 個全部 completed），
  沒有任何工具錯誤或答案差異。

### 4.2 結果

真實負載（20 vs 20）：

| 指標 | baseline | loaded | 配對差（loaded − baseline） |
| --- | --- | --- | --- |
| turn 中位數 | 2160 ms | 2107 ms | **中位數 −114 ms** |
| turn 平均 | 2193 ms | 2128 ms | 平均 −66 ms |
| turn IQR | 2014–2365 | 1903–2268 | 配對 IQR −351 … +266，loaded 較快 9/20 |
| tool 中位數 | 21 ms | 21 ms | — |
| tool 範圍 | 8–49 ms | 5–37 ms | — |

飽和負載（10 vs 10）：

| 指標 | baseline | loaded | 配對差 |
| --- | --- | --- | --- |
| turn 中位數 | 2191 ms | 2152 ms | **中位數 −281 ms** |
| turn 平均 | 2233 ms | 2062 ms | 平均 −171 ms |
| tool 中位數 | 25 ms | 27 ms | — |
| tool 範圍 | 10–77 ms | 9–67 ms | — |

### 4.3 判讀與限制

- **未偵測到 Dashboard 負載造成的可重複延遲**：兩種強度的配對差中位數都是負值（loaded 略快），
  且 IQR 跨零；工具回合（~20–30 ms）在中位數與尾部都沒有系統性上升。
- **靈敏度**：turn 由 provider 延遲主導（~2.1 s），配對 IQR 約 ±350 ms。以 n=20 的樣本量，
  小於約 300 ms 的回歸不會被偵測到；本次負載沒有產生這種量級的變化。
- 這是「沒有觀察到回歸」而非「證明不存在」。要更嚴格，需固定 provider 延遲或用 mock LLM
  只量工具段（見 §5 的 mock 路徑說明）。
- 樣本數 60（≥ 前次要求的 30）。

## 5. headless（無 Web server）組合

在測試 home 內以官方 CLI 建立 shipped `headless` profile 並掛上本插件（`link:`），再跑一個回合：

| 檢查 | 結果 |
| --- | --- |
| 組合沒有 Web app | **PASS**：`profiles/headless/package.json` 的 bundles = `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-headless`（無 `@deepseek-ai/dsh-web-app`）→ 沒有 `webServer` 服務，`registerDashboard()` 直接返回（`index.js:831-874`，並由 `test/index.test.mjs` 的「without a Web server…」覆蓋） |
| 插件在該組合載入 | **PASS**：session log 的 `request/header` 記錄 45 個工具，其中 **19 個 `mcp__basemind__*`**：`code_grep, code_outline, code_read, code_refs, code_search, code_symbols, docs_search, find_files, git_blame, git_diff, git_log, index_rescan, index_status, memory_save, memory_search, agent_inbox, agent_post, agent_threads, cli`；skill catalog 訊息同樣存在 |
| 模型回合 | **NOT RUN（憑證）**：`turn_end` 回 `MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"`。同一個測試 home 的 **Desktop Host 可以**完成真實回合（§4 的 60 個樣本），所以限制在「憑證對非 Desktop 進程不可用」，不是插件接線問題 |

要補完這一項只需環境層的動作（`D:\02_zengjunlin\DSH_TEST\docs\README.md` §7 的三種做法之一）：
在 headless profile patch 把 route 的 `apiKeyEnv` 指向專用變數並在啟動時設定，或直接在啟動環境提供
`DEEPSEEK_API_KEY`。**本會話沒有讀取、複製或寫入任何憑證**。

## 6. 與前一份報告的差異

| 項目 | 2026-11-25 報告 | 本報告（2026-11-26） |
| --- | --- | --- |
| 環境 | 手建隔離 `DSH_HOME` ＋ `dsh web` 實例 | 官方 DSH_TEST Desktop（同版本 checkout） |
| P5 | **NOT RUN**（無模型憑證） | **PASS（已量測，60 樣本）** |
| headless | **NOT RUN**（`MISSING_CREDENTIAL`） | **PARTIAL**：工具註冊與無路由有實證；模型回合仍受憑證限制 |
| 其餘驗收 | PASS | 複驗 PASS（四 tab、Configure、掃描、locale 觀察一致） |

## 7. 環境收尾（已執行）

- `stop-test.ps1`：測試 Desktop 與其 BaseMind daemon 已停止；正式 daemon pid 11048 全程存活。
- 未啟動模型回合的 headless profile 與其 `link:` 掛載已移除（`profiles/headless` 目錄刪除）。
- 本次量測產生的 **63 個 session** 目錄已按 results 檔內的 sessionId 精確刪除；`fixtures\vue3-demo`
  的既有 3 個 session 保留。
- `verify-test.ps1`（Desktop 運行中）→ **22 passed, 0 failed**；之後再次 `stop-test.ps1`，環境回到
  「Desktop 已停止」的原始狀態。
- 量測 artifacts 只在測試環境：`D:\02_zengjunlin\DSH_TEST\scratch\p5-acceptance\`
  （`cdp.mjs`、`p5.mjs`、`analyze.mjs`、`results.json`、`results-heavy.json`、`overview-desktop.png`），
  **沒有一個檔案進到插件 repo**。
