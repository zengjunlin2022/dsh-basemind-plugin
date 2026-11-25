# dsh-basemind-plugin — Lightweight Workspace Dashboard Implementation Plan

## 1. 任務授權及執行模式

當前角色：Autonomous Execution Agent。

本文件為已確認產品需求的實施 Plan，而非新的頭腦風暴或 Planning 任務。

使用者已授權 Agent 在本 Plan 範圍內全自動完成：

- Technical Feasibility Investigation。
- 官方 API 及實際 Runtime 契約驗證。
- 技術方案選擇。
- 功能實施。
- 單元測試及整合測試。
- UI 測試。
- 性能回歸測試。
- 問題定位及最小修復。
- 自我審查。
- 文檔更新。
- 最終交付報告。

不需要在每個 Phase 完成後等待人工確認。

本次使用者明確授權取消中間人工停點，但不代表取消項目 AGENTS.md 中的其他安全及質量約束。

只在全部可執行工作完成後停止，等待最終人工 Review。

如果遇到非核心功能的技術限制，自行採用本 Plan 定義的降級策略，繼續完成其他功能。

不得因缺少非必要字段、非核心 API 或單一環境限制而停止整個任務。

但也不得為了完成任務而使用未經驗證的 API、虛構數據、破壞安全約束或修改 DSH 宿主源碼。

---

# 2. 項目背景及基線

項目：

https://github.com/zengjunlin2022/dsh-basemind-plugin

BaseMind 官方項目：

https://github.com/Goldziher/basemind

DSH 官方項目：

https://github.com/deepseek-ai/deepseek-harness

當前預期基線：

- dsh-basemind-plugin：0.2.1。
- BaseMind：0.34.0。
- DSH Desktop：以實際安裝版本及 package.json engines.dsh 為準。
- Node.js：以 package.json 及項目現有工具鏈為準。

執行前重新確認最新本地 Git HEAD、工作區狀態及版本。

不得擅自覆蓋現有未提交改動。

BaseMind 版本以 lib/upstream.js 為唯一來源。

本輪不修改插件版本，不升級 BaseMind，不預設下一個 npm 發布版本。

## 3. 前置資料

閱讀：

- AGENTS.md。
- README.md。
- README.zh.md。
- CHANGELOG.md。
- package.json。
- cordis.patch.yml。
- index.js。
- lib/config.js。
- lib/upstream.js。
- lib/binary/manager.js。
- lib/workspace-pool.js。
- lib/cli-tool.js。
- lib/mcp-session.js。
- lib/tool-bridge.js。
- lib/status.js。
- lib/executable.js。
- 現有 test/、fixtures/、scripts/。
- 現有 CI / Release Workflow。
- 最新 Phase 1、Phase 2、Phase 3 報告。
- 最新 Desktop Acceptance Report。
- 最新 Agent Effectiveness Benchmark Report。

優先復用已實現及驗證的能力。

不要重新設計已經完成的 Binary Manager、Workspace Pool、CLI Adapter 或 MCP Bridge。

---

# 4. 產品定位

新增 BaseMind Workspace Dashboard。

Dashboard 是 DSH Desktop 內的輕量級 BaseMind 項目索引管理及可觀測性頁面。

主要解決：

1. 當前項目索引了多少文件及記錄。
2. 當前索引是否健康。
3. BaseMind 正在執行什麼掃描任務。
4. 最近的掃描結果如何。
5. BaseMind 佔用了多少資源。
6. BaseMind 工具的使用情況如何。
7. 如何在不使用 Agent 的情況下管理項目索引。

Dashboard 不承擔代碼瀏覽、文件級索引分析或 Agent 代碼理解工作。

## 5. 優先級

所有技術決策遵循：

Agent 性能與穩定性 > 數據正確性 > Dashboard 功能完整性 > UI 展示效果。

如果某項功能會引入高成本查詢、額外常駐服務或明顯影響 Agent 性能，優先縮減或取消該功能。

不為追求 UI 功能完整而犧牲插件原有能力。

---

# 6. 已確認產品功能範圍

## 6.1 Dashboard Shell

- DSH 插件管理頁提供 Dashboard 入口。
- 點擊後進入獨立 Dashboard。
- 使用 DSH 原生頁面風格及主題。
- 支持當前 Session 項目及 DSH 已開啟項目切換。
- 首次打開時跟隨當前 Session。
- 後續 Dashboard 項目切換獨立於 Agent。
- Worktree 使用獨立 Workspace 身份。
- 四個功能頁面共享當前項目上下文。

## 6.2 Overview

- 項目索引健康狀態。
- 已索引文件數量。
- Blob 數量。
- 語言分佈。
- 官方可提供的項目級聚合統計。
- 最近掃描狀態及耗時。
- 項目級異常提示。
- 異常提示跳轉至 Scan 或 Diagnostics。

## 6.3 Scan

- 首次掃描。
- 全量掃描。
- 指定文件或目錄的增量掃描。
- 掃描進度。
- 掃描結果摘要。
- 同一 Workspace 或共享索引寫入範圍避免重複掃描。
- 每個 Workspace 保留最近 10 次 Dashboard 發起的掃描摘要。
- 關閉 Dashboard 不取消已提交的掃描。

## 6.4 Diagnostics

- Binary 狀態。
- Binary 版本及兼容性。
- Daemon 狀態。
- MCP Relay 狀態。
- Grammar 狀態。
- Index 健康狀態。
- 異常原因及處理建議。

Diagnostics 為唯讀功能，不自動修復。

## 6.5 Statistics

- 官方磁碟資源統計。
- 進程 RAM。
- 工具調用次數。
- 各工具調用分佈。
- 官方預估 Token Saved。
- 官方支持的統計時間範圍。

必須區分 Workspace、Repository Group、Daemon、Process 及 Global 統計範圍。

## 6.6 自動執行所需的交互默認決策

以下是本 Plan 採用的輕量化默認決策，無需另行詢問使用者：

- Dashboard 頂部顯示已知活躍掃描任務。
- 首次及全量掃描需要使用者在 UI 確認。
- 增量掃描在範圍合法且無衝突時直接執行；若會退化為全量掃描，必須重新確認。
- 每次打開 Dashboard 默認進入 Overview。
- 掃描歷史自動保留最近 10 次，不提供手動清除。
- Diagnostics 只提供唯讀診斷及問題說明。
- 使用 DSH 原生 UI 組件、設計 Token 及主題。

上述 UI 確認是產品運行時的交互要求，不是 Agent 開發過程中的人工停點。

---

# 7. 明確排除的功能

以下功能不屬於本輪開發：

- Files 模塊。
- 文件樹。
- 文件列表。
- 文件搜尋。
- 文件級索引詳情。
- 文件符號瀏覽器。
- 全項目符號遍歷。
- 工作樹與索引差異對照。
- 原始 JSON / TOON 展示。
- 完整代碼編輯器。
- 引用關係圖。
- 自動索引修復。
- 強制刪除並重建索引。
- 索引清理。
- BaseMind 配置編輯器。
- 全局項目背景監控。
- 自研 Telemetry 引擎。
- 實際 Agent Token 成本追蹤。
- 官方快捷命令同步。
- Toast 通知。
- Agent Identity 自動綁定。
- Inbox 主動通知。
- MCP Tasks 協議擴展。

不得以完善 Dashboard 為理由重新引入已取消的 Files 模塊。

指定文件路徑進行增量掃描不等於支持文件瀏覽，只保留簡單路徑輸入。

---

# 8. 硬性性能及安全約束

## 8.1 Agent 零額外上下文成本

Dashboard 不得新增：

- Agent Tools。
- MCP Tools。
- Skills。
- System Prompt Section。
- Bootstrap 內容。
- Agent Tool Schema。
- 額外模型請求。

所有 Dashboard 操作由確定性程式碼完成，不經過 LLM。

Dashboard 自身模型 Token 消耗必須為零。

## 8.2 Dashboard 閒置零額外查詢

Dashboard 未打開且沒有已提交掃描任務時：

- 不查詢項目統計。
- 不輪詢 Daemon。
- 不輪詢 Index。
- 不執行 BaseMind CLI。
- 不掃描工作目錄。
- 不初始化新的 Relay。
- 不建立 UI 專屬背景 Timer。
- 不預加載所有項目數據。

允許最小必要的入口註冊及宿主要求的 UI Metadata。

不得在插件 apply() 階段執行 Dashboard 數據初始化。

## 8.3 不新增常駐基礎設施

禁止新增：

- 獨立 HTTP Server。
- 獨立 WebSocket Server。
- 額外 BaseMind Daemon。
- Dashboard 專屬常駐 MCP Relay。
- 額外索引數據庫。
- 大型狀態管理框架。
- 大型圖表框架。
- 不必要的 Runtime 依賴。

優先復用 DSH 官方 Client Extension、RPC、UI 組件及現有插件能力。

## 8.4 不影響現有 Agent 路徑

不修改以下功能的正常執行語義：

- Agent Tool Registration。
- Workspace Routing。
- Binary Selection。
- Cold-start Gate。
- MCP Relay Recovery。
- Skills Provider。
- Bootstrap。
- CLI Adapter。
- MCP Resources。

如確實需要共用既有代碼，優先抽取無副作用的純函數或新增窄接口。

不得為 Dashboard 重寫 Workspace Pool 或 MCP 調度架構。

## 8.5 查看不等於初始化

打開 Dashboard、查看概覽、切換項目、查看診斷及統計：

- 不得意外建立索引。
- 不得意外觸發全量掃描。
- 不得觸發 Binary 自動下載。
- 不得建立新的 Workspace Relay。
- 不得自動修改項目配置。

現有 Binary Manager 的 select() 可能包含自動下載行為。

Dashboard 的被動查看不得直接調用可能觸發下載的選型路徑。

優先復用已存在的選型結果、只讀狀態查詢或經驗證的無副作用探測能力。

如 Binary 不可用，展示明確狀態，不自動修復。

## 8.6 Agent 優先

Dashboard 默認最多只允許一個在途唯讀查詢。

快速切換項目、頁面及統計時間範圍時：

- 合併相同請求。
- 取消可安全取消的過期查詢。
- 忽略不再匹配當前 Workspace 的結果。
- 不累積無界查詢隊列。

若宿主已有 Agent Busy 狀態及安全調度接口，允許在 Agent 執行高負載任務時延後非必要 Dashboard 查詢。

不得為實現優先級而新增 Agent 全局攔截器。

---

# Phase A — Technical Feasibility Investigation

## 9. DSH UI Extension 調研

首先確認實際安裝的 DSH Desktop 版本。

查閱該版本對應的官方文檔、源碼、已安裝 Runtime 及可用 SDK。

重點確認：

- dsh.client package declaration。
- Client Module Loading。
- Client Module Bundle。
- UI Slots。
- Plugin Manager。
- 原生 Page Navigation。
- Native UI Components。
- Host / Client RPC。
- Client Module Lifecycle。
- Locale。
- Theme。

優先核對：

- plugins.bundle.config。
- plugins.row.config。
- plugins.item。
- view: summary / page。
- 插件頁導航及返回行為。

參考：

https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client

https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.md

上述 master 文檔只作為調研入口，不代表當前 Desktop 版本一定支持相同 API。

## 10. UI 最小可行性驗證

在隔離測試環境驗證：

1. 插件能夠載入 Client Module。
2. 插件管理頁能展示 BaseMind 入口。
3. 點擊入口能進入專屬頁面。
4. Client Module 能調用 Host 端唯讀接口。
5. 插件停用或卸載後入口正常消失。
6. Headless / CLI 環境不載入瀏覽器專用代碼。

只建立最小必要的 Spike。

不在正式產品中保留無用 Demo、臨時 API 或測試頁面。

### 自主技術決策順序

A. 優先使用宿主支持的 Bundle 專屬 Page。

B. 若不能註冊自定義 Router，但可以使用原生 Row / Bundle Configuration Page 作為獨立內容頁，採用該方案。

C. 若只能使用插件頁內嵌小型區域，且無法滿足獨立 Dashboard 需求，不擅自改為完整內嵌 Dashboard。

D. 若當前 DSH 不支持可靠的 Client Extension 或 Host RPC，將 UI 接入標記為 BLOCKED。

不得以修改 DSH 宿主、DOM 注入、Monkey Patch、外部 Web Server 或私有 Electron API 的方式繞過限制。

若遇到 D 類阻擋，繼續完成已證實可用且可復用的最小 Host 端能力及測試，不構建無法接入的完整前端。

## 11. Workspace API 調研

確認如何取得：

- 當前活動 Session。
- 當前 Session Workspace。
- DSH 已開啟的項目。
- Workspace 真實路徑。
- Worktree 身份。
- 項目名稱。
- 項目選擇變更事件。

禁止掃描整個硬盤或所有 BaseMind Cache 來尋找項目。

只使用 DSH 已授權及已知的 Workspace 集合。

如無可靠的已開啟項目列表接口：

- 優先支持當前 Session Workspace。
- 若可從原生 Session Registry 安全取得其他已開啟 Workspace，使用該集合。
- 否則標記多項目選擇為 PARTIAL。
- 不建立任意文件系統瀏覽器作為替代。

## 12. BaseMind 數據契約調研

以 lib/upstream.js 的上游版本為準。

參考候選接口：

- basemind status --json。
- basemind doctor --json。
- basemind cache stats --json。
- basemind admin telemetry --window ... --json。
- basemind scan。
- basemind rescan。
- index_status。
- index_rescan。

具體指令、參數、輸出格式及副作用必須通過：

- 官方目標版本文檔。
- CLI --help。
- 官方源碼。
- 隔離環境中的真實 Binary。

不得只根據 README 示例推測接口。

為每個候選接口建立契約矩陣：

| 項目           | 說明                            |
| -------------- | ------------------------------- |
| Data Source    | 真實指令或 API                  |
| JSON Schema    | 實際字段及類型                  |
| Scope          | Workspace / Group / Global      |
| Side Effects   | 是否建立索引、Daemon 或寫入數據 |
| Query Cost     | 執行耗時及資源消耗              |
| Error Contract | Exit Code、Error、Timeout       |
| Availability   | 目標版本是否支持                |
| Decision       | 採用、降級或排除                |

重點驗證：

- 未建立索引的項目執行 status 是否會自動初始化。
- status 是否會啟動 Daemon。
- doctor 是否會觸發配置或索引寫入。
- cache stats 是否需要高成本磁碟遍歷。
- telemetry 是否具有項目級統計範圍。
- scan / rescan 是否提供結構化結果。
- 是否可查詢真實掃描階段及進度。
- 增量掃描何時退化為全量掃描。
- 如何辨識共享索引寫入範圍。

如某個查詢接口存在不可接受的副作用，不使用該接口進行被動展示。

## 13. Feasibility 自動決策

將調研結果分類：

- SUPPORTED：接口已確認，直接實施。
- CONDITIONAL：具備明確前置條件，條件成立時提供。
- DEGRADED：只能提供低成本替代能力。
- UNSUPPORTED：不實施。
- BLOCKED：需要宿主或上游提供新能力。

不得因 UNSUPPORTED 或 BLOCKED 而虛構實現。

輸出：

docs/YYYY-MM-DD-basemind-dashboard-feasibility-report.md

完成後直接進入 Phase B，不等待人工確認。

---

# Phase B — Dashboard Architecture

## 14. 架構原則

推薦最小架構：

DSH Plugin Manager

→ Dashboard Client Module

→ DSH 原生 Host RPC

→ Dashboard Service

→ 官方唯讀查詢接口 / 顯式掃描操作

→ 現有 BaseMind Binary 及索引

Dashboard Service 與 Agent Tool Bridge 保持獨立。

共享：

- 已選擇的 Binary。
- 官方版本信息。
- 必要的 Workspace Identity。
- 已存在且可安全讀取的 Runtime 狀態。

不共享：

- Agent 上下文。
- Agent Tool Call Lifecycle。
- Agent cwd。
- Agent Prompt Assembly。

## 15. 文件級修改建議

以下為候選結構，允許根據實際 DSH Client Module 契約作最小調整：

lib/dashboard/

- service.js：Dashboard 服務協調。
- query.js：官方低成本查詢適配。
- scan.js：手動掃描生命周期。
- history.js：最近 10 次掃描摘要。
- contracts.js：輸出驗證及狀態正規化。

client/dashboard/

- DashboardPage。
- OverviewPage。
- ScanPage。
- DiagnosticsPage。
- StatisticsPage。
- 共用 Workspace Context。

如使用更少文件即可完成，應合併簡單模塊。

不要求為每個 API 或 UI 組件建立獨立文件。

優先修改：

- package.json：必要的 Client Module Declaration 及 Pack 白名單。
- cordis.patch.yml：必要且已驗證的宿主註冊。
- index.js：最小 Dashboard 接入點及 disposer。
- locale/：中英文 UI 文案。
- scripts/check-pack.mjs：新增必要的打包驗證。

禁止與 Dashboard 無關的大規模格式化、命名調整或文件重構。

## 16. Host API 設計

候選操作：

- getWorkspaces。
- getOverview。
- getDiagnostics。
- getStatistics。
- getScanState。
- startScan。
- getScanHistory。
- getActiveScans。

名稱可依官方 RPC 命名規則調整。

每個請求必須具有明確 Workspace Identity。

不得提供：

- 任意 CLI Command。
- 任意 Shell Command。
- 任意 cwd。
- 任意 Environment Variables。
- 任意文件讀取。
- 任意 BaseMind 原始 Tool Call 轉發。

Dashboard RPC 使用窄接口及固定操作集合。

## 17. Workspace 身份及安全

使用經驗證的：

- Canonical Workspace Path。
- Worktree Identity。
- Repository Group Identity（如官方提供）。
- Scan Write Scope（如官方提供）。

不能只使用項目名稱作為唯一標識。

Windows 路徑大小寫、UNC、長路徑、Symlink、Junction、POSIX Case-sensitive Path 均按實際平台語義處理。

不得在 POSIX 平台無條件將路徑轉為小寫。

Client 傳入的 Workspace 必須由 Host 重新驗證。

不得信任 Client 任意傳入的絕對路徑。

增量掃描路徑必須限制於已授權 Workspace 範圍及官方支持的掃描範圍。

拒絕：

- 路徑穿越。
- 任意外部目錄。
- Shell 注入。
- CLI 參數注入。
- 未授權 Symlink / Junction 跳轉。

不使用 Shell 字符串拼接執行掃描。

## 18. Dashboard 狀態管理

四個頁面共享：

- selectedWorkspace。
- overviewSnapshot。
- scanState。
- queryState。
- lastUpdatedAt。

不為每個頁面建立獨立項目狀態源。

快照使用小型、有界、短期內存緩存。

候選初始策略：

- 同一查詢結果短期復用約 5–10 秒。
- 最多保存最近使用的少量 Workspace 快照。
- 掃描完成後使對應 Workspace 快照失效。
- 關閉 Dashboard 後釋放 UI 專用狀態及非必要緩存。

具體 TTL 及上限依真實查詢成本決定，不建立額外持久化統計數據庫。

---

# Phase C — Dashboard UI Shell

## 19. 插件管理頁入口

在 BaseMind 插件管理區域增加：

BaseMind Dashboard / 索引管理

使用 DSH 原生入口樣式。

要求：

- 不新增全局側邊欄入口。
- 不修改 DSH 原生插件管理頁源碼。
- 不新增 Toast。
- 不要求使用者修改 Standard Preset。
- 插件停用或卸載後入口自動消失。
- 未支持 Client Extension 的宿主仍可正常使用原有插件。

## 20. Dashboard 主界面

採用緊湊型管理頁布局：

頂部：

- 返回插件管理頁。
- BaseMind Dashboard 標題。
- 當前 Workspace 選擇器。
- 當前索引狀態。
- 已知活躍掃描任務入口。
- 人工刷新入口。

導航：

- Overview。
- Scan。
- Diagnostics。
- Statistics。

不包含 Files。

頁面使用 DSH 原生：

- Theme。
- Typography。
- Button。
- Select。
- Table。
- Dialog。
- Progress。
- Empty State。
- Loading State。
- Error State。

若某個原生組件不可用，使用最小自定義組件，不引入另一套大型 UI 框架。

## 21. 頁面切換

首次打開：

- 選中當前 Session 的 Workspace。
- 默認進入 Overview。
- 只加載 Overview 所需數據。

Dashboard 內切換 Workspace：

- 不修改 Agent Session cwd。
- 不切換 Agent 工作區。
- 不重新建立 Agent Relay。
- 不預先查詢所有其他 Workspace。
- 舊 Workspace 的請求結果不得覆蓋新 Workspace。

切換頁籤時只查詢該頁面需要的數據。

返回 Dashboard 或重新進入頁面時，不恢復複雜歷史交互狀態。

---

# Phase D — Overview

## 22. 核心統計

優先展示官方低成本聚合字段：

- Index Status。
- Indexed File Count。
- Blob Count。
- Indexed Bytes。
- Language Distribution。
- Last Scan Timestamp。
- Last Scan Duration。
- Index Freshness。
- Index Health。

以上均為候選字段，不假設全部存在。

若官方直接提供 Symbol Count、Reference Count 或其他項目級聚合數據，可一併展示。

不得自行遍歷文件或逐文件調用 code_outline 來計算統計數字。

無法取得的字段：

- 顯示「暫不可用」或不展示。
- 不使用 0 代替未知。
- 不使用模擬數據。
- 不推測不存在的統計結果。

## 23. 語言分佈

優先使用官方聚合數據。

以緊湊的 CSS 橫條及表格呈現：

- 語言。
- 文件數量。
- 佔比。

只有分母及字段語義明確時才計算百分比。

不使用大型 Chart Library。

若官方沒有低成本語言聚合接口，取消語言分佈區域並記錄原因。

## 24. 索引健康狀態

根據真實上游證據展示：

- Ready。
- Not Indexed。
- Indexing。
- Stale。
- Degraded。
- Error。
- Unavailable。
- Unknown。

不要將 Binary Ready 等同於 Index Ready。

不要將 CLI 查詢失敗等同於索引已損壞。

Overview 必須區分：

- 索引不存在。
- 索引正在建立。
- 無法取得索引狀態。
- 最後一次查詢失敗。
- 已知的索引異常。

## 25. 頁面聯動

索引缺失：

→ Scan。

Binary 或 Daemon 異常：

→ Diagnostics。

索引正在掃描：

→ Scan。

不提供文件級異常列表。

不因為某個語言缺少符號解析能力而自動宣告整個索引不健康。

---

# Phase E — Scan Management

## 26. 掃描操作

支持：

### 首次掃描

當項目尚未索引時，提示使用者手動執行。

Dashboard 被動查看不得發起首次掃描。

### 全量掃描

使用官方 scan 語義掃描工作樹。

不刪除現有索引，不執行 Cache Clear，不強制重建。

執行前在 UI 展示：

- Workspace 路徑。
- 掃描類型。
- 可能的 CPU、RAM 及 IO 開銷。
- 可能影響正在工作的 Agent。

由使用者確認後執行。

### 增量掃描

輸入 Workspace 內合法的文件或目錄相對路徑。

使用官方支持的 rescan 或等效操作。

如根據官方契約可能退化成全量掃描，必須提前告知並確認。

若無法提供可靠的範圍限制或預測退化行為，停用該操作或明確按可能全量掃描的方式確認。

## 27. 掃描併發控制

同一 Workspace 或共享索引寫入範圍不允許重複提交掃描。

優先使用官方提供的：

- Scan State。
- Daemon Job State。
- Index Write Scope。
- Store Lock。
- Busy Error。

Dashboard 自身至少防止：

- 重複點擊。
- 多個 Dashboard Client 重複提交。
- 同一 Host Process 重複啟動相同掃描。
- 同一共享索引範圍的已知衝突。

不同 Workspace 只有在已確認索引寫入範圍獨立且上游允許時才可併發掃描。

若無法可靠確認共享寫入範圍，保守地串行執行 Dashboard 自己的掃描任務，並依賴上游鎖處理外部衝突。

不能聲稱插件可完全阻止 Agent 或外部 CLI 發起競爭掃描。

不實現第二套全局 Daemon Lock。

## 28. 掃描任務生命周期

候選狀態：

- Queued。
- Starting。
- Running。
- Completed。
- Failed。
- Interrupted。
- Unknown。

只有真實支持取消時才加入 Cancelled。

第一版不要求取消功能。

不得將終止 CLI 子進程直接解讀為 Daemon 掃描已取消。

Dashboard 切換項目時：

- 已提交掃描繼續執行。
- UI 不丟失已知任務身份。

關閉 Dashboard 時：

- 停止 UI 輪詢。
- 已提交掃描繼續。
- 保留必要的 Host 端任務完成處理。
- 不為此維持額外常駐監控服務。

插件停用、Host 結束或 Desktop 重啟時：

- 安全釋放插件擁有的資源。
- 不終止共享 BaseMind Daemon。
- 不假設已提交的上游掃描一定繼續或一定取消。
- 對無法重新確認的任務標記為 Interrupted 或 Unknown。
- 不自動重新提交掃描。

## 29. 掃描進度

優先使用官方可取得的：

- Scan Phase。
- Processed Count。
- Total Count。
- Updated Count。
- Skipped Count。
- Error Count。
- Elapsed Time。

只有存在可靠總數及已處理數時才展示百分比。

否則顯示：

- Scanning。
- 當前可取得階段。
- 已耗時。
- 不確定進度指示器。

不模擬進度。

不依靠 Timer 自行增加百分比。

如掃描進度只能透過脆弱的人類可讀日誌解析，優先降級為執行狀態及耗時。

## 30. 掃描刷新策略

Dashboard 可見且存在活躍掃描時：

- 優先使用官方事件或低成本狀態查詢。
- 如必須輪詢，初始間隔約 3 秒。
- 根據查詢成本自適應延長。
- 不允許前一次查詢未完成時啟動下一次。
- 不同頁面不得各自建立掃描輪詢。
- 掃描完成後立即停止輪詢。

如果官方查詢進度會產生高成本操作，取消即時百分比，只保留可靠的任務狀態。

普通 Overview 不執行持續輪詢。

## 31. 掃描結果

掃描完成後展示實際可取得的：

- 掃描類型。
- 掃描範圍。
- 執行結果。
- 開始時間。
- 完成時間。
- 耗時。
- 掃描文件數量。
- 新增數量。
- 更新數量。
- 跳過數量。
- 錯誤數量。

可取得低成本掃描前後快照時，展示索引數量變化。

必須區分：

- 上游掃描操作直接返回的統計。
- 掃描前後項目統計差值。

兩者不可混用。

有其他 Agent 或 Watcher 同時更新索引時，快照差值不一定全部由本次掃描造成。

## 32. 掃描歷史

只記錄 Dashboard 主動提交的掃描。

每個 Workspace 保留最近 10 次已結束的任務摘要。

正在執行的任務獨立管理，不因歷史裁剪而丟失。

保存：

- Task ID。
- Workspace ID。
- Scan Type。
- Scan Scope。
- Started At。
- Finished At。
- Duration。
- Result Status。
- 官方結果摘要。
- BaseMind Version。
- 必要錯誤摘要。

不保存：

- 完整源碼。
- 全量掃描日誌。
- 每個文件的解析結果。
- 原始大型 JSON。
- 完整索引快照。
- 模型上下文。

優先使用 DSH 官方插件數據存儲接口。

如沒有合適接口，允許在插件專屬 Data Home 保存小型 JSON，採用原子寫入、Schema 校驗、併發保護及有界歷史裁剪。

不新增數據庫依賴。

---

# Phase F — Diagnostics

## 33. 診斷項目

展示：

- 插件版本。
- BaseMind 版本。
- Binary Source。
- Version Compatibility。
- Managed Cache State。
- Daemon State。
- Relay State。
- Workspace State。
- Grammar State。
- Index Health。
- 可取得的錯誤及處理建議。

復用現有 /basemind-status 相關可復用數據。

不需要將其文字輸出重新解析成 Dashboard 數據；優先復用既有結構化狀態或抽取純函數。

## 34. 診斷約束

Diagnostics：

- 不持續健康檢查。
- 不自動重新連接 Relay。
- 不自動下載 Binary。
- 不自動建立索引。
- 不執行 Cache GC。
- 不執行 Cache Clear。
- 不停止 Daemon。
- 不修改項目規則文件。

首次進入 Diagnostics 時，執行經驗證的低成本唯讀查詢。

如完整 doctor 成本較高，改為使用者主動點擊「執行診斷」。

Relay 尚未啟動時顯示 Not Started 或 Unknown，不為填充狀態而建立 Relay。

---

# Phase G — Statistics

## 35. 資源統計

使用官方可用的資源統計：

- Cache Disk Usage。
- Blob Storage。
- Views。
- Git History。
- Telemetry Storage。
- Process RSS。
- Peak RSS。

字段以真實官方輸出為準。

明確展示統計範圍。

若 RAM 為共享 Daemon 進程的數據，不得標記為當前項目獨享 RAM。

如果 Cache 統計需要高成本完整掃描磁碟，使用人工刷新或取消該字段。

## 36. 使用統計

使用官方 telemetry 接口，支持實際可用的時間窗口：

- Today。
- 1h。
- 24h。
- All。

展示：

- Tool Call Count。
- Per-tool Call Distribution。
- Estimated Tokens Saved。

不建立自研 Tool Call 攔截器。

不讀取所有 Agent Session Logs 來生成 Dashboard 統計。

不新增實際模型 Token 統計能力。

官方 Estimated Tokens Saved 必須標注為啟發式估算，不是實際 API 計費節省。

如果 All 統計窗口成本過高，允許改為顯式人工查詢或移除該選項。

---

# Phase H — Performance Isolation

## 37. 性能基線

在實施 Dashboard 前記錄當前插件基線。

使用相同：

- Git Baseline。
- BaseMind Binary。
- DSH Runtime。
- Workspace。
- Index State。
- Node.js 版本。
- 測試機器。

測量：

- 插件 apply / init 耗時。
- Agent First-turn Tool Registration。
- MCP Tool Schema。
- Skills Catalog。
- Bootstrap。
- Relay 數量。
- CLI / MCP 调用耗時。
- 閒置 Timer。
- 額外進程。
- 可測量的 RSS / Heap。

優先使用確定性測試及真實唯讀 BaseMind 查詢。

不需要調用付費 GPT 或 DeepSeek 完成 Dashboard 性能測試。

## 38. 性能測試場景

### P1：Dashboard 未打開

驗證：

- 不新增 Dashboard CLI Call。
- 不新增 Dashboard MCP Call。
- 不新增 Dashboard Timer。
- 不新增 Dashboard Relay。
- 不新增 Daemon。
- 不修改 Agent Tool Schema。
- 不修改 Skills Catalog。
- 不修改 Bootstrap。
- 不改變 Agent 原有 Tool Call 路徑。

### P2：Dashboard 打開且空閒

驗證：

- Overview 只執行必要的初始查詢。
- 空閒 60 秒內不持續刷新。
- 不批量查詢其他 Workspace。
- 不自動建立索引。

### P3：Dashboard 頁面切換

驗證：

- 只加載當前頁面數據。
- 重複查詢可合併。
- 不累積無界請求。
- 不重複初始化 Binary。

### P4：快速切換 Workspace

驗證：

- 過期查詢被安全取消或忽略。
- 不出現跨 Workspace 數據污染。
- 不影響 Agent cwd。

### P5：Agent 正常工作時打開 Dashboard

使用已索引的小型及代表性大型測試 Repository。

交錯執行：

- Agent 原有 MCP 查詢。
- Dashboard Overview 查詢。
- Dashboard Diagnostics 查詢。
- Dashboard Statistics 查詢。

驗證是否存在：

- 明顯 Tool Call 延遲。
- Relay 重複建立。
- Daemon 資源競爭。
- 索引寫入衝突。
- 無界查詢隊列。

### P6：Dashboard 掃描期間

驗證：

- 不重複提交掃描。
- 進度查詢成本有界。
- 不因 UI 輪詢增加無限負載。
- 關閉頁面後停止 UI 刷新。
- 掃描完成後停止任務監控。

手動掃描的 BaseMind CPU、RAM 及 IO 開銷應與 Dashboard 查詢開銷分開記錄。

不能將全量掃描本身的資源消耗描述為 UI 零開銷。

### P7：多次打開及關閉

建議執行至少 20 次 Dashboard Lifecycle 循環。

確認：

- Timer 不累積。
- Listener 不累積。
- RPC 註冊不累積。
- 快照緩存保持有界。
- 不存在殘留 CLI 進程。
- 不存在明顯持續增長的資源佔用。

## 39. 性能驗收標準

硬性要求：

- Dashboard 額外模型 Token = 0。
- Dashboard 未打開時額外數據查詢 = 0。
- Dashboard 未打開時額外輪詢 Timer = 0。
- 額外 Agent Tools / Skills / Prompt = 0。
- 額外常駐 Daemon = 0。
- Dashboard 唯讀查詢不觸發 Index Build。
- Dashboard 不導致工作區污染。

延遲測試：

- 對代表性 MCP 查詢進行至少 30 次交錯測量。
- 報告 Median、P95、Error Count。
- 使用相同預熱及索引狀態。
- 記錄測試環境的自然波動。
- 不只根據一次執行結果下結論。

初始性能警戒線：

- 閒置 Dashboard 整合造成的 Median 回歸超過 10%。
- 閒置 Dashboard 整合造成的 P95 回歸超過 20%。
- Dashboard 可見時存在可重複的明顯延遲或超時。

上述為調查警戒線，不是允許無條件增加開銷的預算。

若觸發警戒線，必須定位根因、最小修復並重測。

不能以刪除測試、延長超時或降低樣本數掩蓋性能問題。

---

# Phase I — Testing & Compatibility

## 40. 單元測試

覆蓋：

- Dashboard Config。
- Workspace Validation。
- Snapshot Cache。
- Request Deduplication。
- Stale Response Handling。
- Query Timeout。
- Scan State Machine。
- Duplicate Scan Prevention。
- Scan Scope Validation。
- History Retention。
- Statistics Scope Mapping。
- Unsupported Fields。
- Error Normalization。
- Lifecycle Dispose。

優先復用現有 node:test 測試架構。

不引入新的大型測試框架。

## 41. 真實 BaseMind Integration

使用隔離的：

- DSH_HOME。
- BASEMIND_DATA_HOME。
- BASEMIND_COMMS_DIR。
- Test Repository。
- Managed Cache 或已存在的相容 Binary。

不得操作用戶正式索引。

至少驗證：

1. 已建立索引項目的 Overview。
2. 未建立索引項目的 Overview。
3. Dashboard 查看不觸發自動索引。
4. Binary 不可用時安全降級。
5. 結構化索引統計。
6. Diagnostics。
7. Statistics。
8. 手動全量掃描。
9. 手動增量掃描。
10. 掃描結果摘要。
11. 掃描歷史保留 10 次。
12. 多 Workspace 隔離。
13. 掃描併發及 Busy Error。
14. Dashboard 關閉後的掃描生命周期。

真實 Integration Gate 與普通 npm test 分開。

普通 npm test 不無條件下載大型 Binary 或額外模型。

如果已存在真實 Managed Binary Integration，優先復用其隔離及測試工具。

## 42. DSH Desktop UI 驗收

使用隔離測試 Profile 或可安全自動化的 Desktop 測試環境。

必須使用真實 DSH Client Module Loading 契約。

測試：

- 插件打包及安裝。
- 插件頁入口。
- Dashboard 獨立頁面。
- 項目切換。
- Overview。
- Scan。
- Diagnostics。
- Statistics。
- 原生主題切換。
- 中英文文案。
- Loading / Empty / Error State。
- 頁面關閉。
- 插件停用。
- 插件重載。
- 插件卸載。

可使用現有瀏覽器自動化工具及 DSH 測試接口。

不需要人工逐步確認。

不得修改用戶正在使用的 Desktop Profile，不得擅自重啟生產 Desktop。

如果當前 Agent 無法操作真實 Desktop：

- 使用可用的隔離 DSH Web Runtime 完成 Client/Host 整合測試。
- 將真實 Desktop 驗收標記為 NOT RUN。
- 提供剩餘的最小人工驗收步驟。
- 繼續完成其他工作。

不可將 Web Runtime 或 Mock UI 測試冒充 Desktop 實機通過。

## 43. Headless Compatibility

驗證沒有 DSH Client UI 的環境：

- 插件可以正常啟動。
- Agent Tools 正常。
- Skills 正常。
- Bootstrap 正常。
- CLI Adapter 正常。
- MCP Resources 正常。
- 不嘗試載入瀏覽器專用組件。
- 不因 UI API 不存在而拋出全局錯誤。

Dashboard 為可選 UI 擴展能力。

不支持 Dashboard 的舊版宿主仍應保留原有插件功能。

## 44. 原有功能回歸

必須確認：

- 原有 MCP Tools 數量及契約不變。
- 官方 10 個 Skills 不變。
- Bootstrap 不變。
- /basemind-status 正常。
- Local First 正常。
- Managed Binary Cache 正常。
- Workspace Routing 正常。
- Multi-session Isolation 正常。
- Relay Recovery 正常。
- Cold-start Gate 正常。
- 插件停用及卸載正常。

不得新增 Dashboard 相關 Agent Tools。

---

# Phase J — Automated Review & Repair

## 45. 自我審查

完成實施後檢查完整 Git Diff。

依照 Critical / Important / Minor 分級進行自我審查。

重點：

- 安全。
- Workspace 隔離。
- 掃描併發。
- 副作用。
- 進程管理。
- UI Lifecycle。
- Timer 洩漏。
- 請求競爭。
- 路徑驗證。
- 性能回歸。
- Headless Compatibility。
- 打包兼容性。
- 舊版 DSH 降級。
- 與凍結產品 Scope 的一致性。

如環境具備獨立 Reviewer Subagent 且已獲授權使用，可以委派獨立審查。

不要在未經授權時消耗額外付費模型額度。

## 46. 自動修復規則

發現 Critical / Important：

1. 提供重現證據。
2. 確認根因。
3. 新增或更新針對性回歸測試。
4. 進行最小必要修復。
5. 執行受影響測試。
6. Scoped Re-Review。

Minor 不作為反覆重構的理由。

同一問題最多執行 3 輪針對性修復。

若仍未解決：

- 記錄阻擋問題。
- 保留可審查的代碼及證據。
- 不弱化測試。
- 不宣告全部完成。
- 繼續完成不依賴該問題的其他工作。

避免無限制 Review → Fix → Review 循環。

---

# Phase K — Final Verification & Delivery

## 47. 最終測試命令

以當前 package.json 實際存在的命令為準。

至少執行：

- npm run check。
- npm run check:skills。
- npm run check:pack。
- npm test。
- npm run verify。

另外執行：

- Dashboard 專項測試。
- Dashboard 真實 Integration。
- UI Integration。
- Performance Regression。
- 必要的 Managed Binary 回歸測試。

重複命令可以合併為等效完整 Gate，避免無意義重複執行。

如果本輪沒有改動 Binary Manager 及安裝契約，不需要無條件重新下載所有平台 Binary。

但必須保留現有 CI / Release Gate，不削弱測試要求。

遠端 CI 如未執行，明確標記 NOT RUN，不宣告已通過。

## 48. 打包檢查

確認 npm Package 包含：

- 必要的 Dashboard Host Module。
- 必要的 Dashboard Client Module。
- 正式 UI Assets。
- Locale。
- 既有 Runtime。
- 既有 Skills。

不得包含：

- node_modules。
- 測試 Profile。
- 私有索引數據。
- Binary Cache。
- 使用者憑證。
- 臨時測試產物。
- 大型 Benchmark Logs。
- 無用 Spike。

使用 npm pack --dry-run 或實際 npm pack 驗證。

記錄改動前後 Package 大小。

不執行 npm publish。

## 49. 文檔更新

更新必要的：

- README.md。
- README.zh.md。
- CHANGELOG.md。
- Dashboard 使用說明。
- 已知兼容性限制。

CHANGELOG 記錄於 [Unreleased]。

README 必須說明：

- Dashboard 入口。
- 項目切換。
- 四個功能頁面。
- 掃描操作。
- 未索引項目的行為。
- 統計數據來源及範圍。
- 零模型 Token。
- 按需查詢策略。
- Dashboard 關閉後的掃描行為。
- 全量掃描可能影響 Agent 性能。
- 舊版 DSH 的安全降級。
- 官方不提供的數據字段。

不宣稱未驗證的功能或平台已支持。

## 50. 最終驗收 Checklist

### UI

- [ ] DSH 插件頁入口正常。
- [ ] 獨立 Dashboard 或符合需求的宿主原生專屬頁面正常。
- [ ] Workspace 選擇器正常。
- [ ] Overview、Scan、Diagnostics、Statistics 正常。
- [ ] 沒有 Files 模塊。
- [ ] 原生 Theme 及 Locale 正常。
- [ ] 停用及卸載後 UI 入口消失。

### 數據

- [ ] 使用官方真實數據。
- [ ] 不虛構統計字段。
- [ ] 未知數據不顯示為 0。
- [ ] 統計範圍標記正確。
- [ ] 不讀取私有索引數據庫格式。
- [ ] 不逐文件遍歷計算統計。

### Scan

- [ ] 首次掃描由使用者主動提交。
- [ ] 全量掃描正常。
- [ ] 增量掃描正常。
- [ ] 掃描範圍安全驗證。
- [ ] 避免同一索引範圍的重複掃描。
- [ ] 掃描進度及狀態真實。
- [ ] 關閉 Dashboard 不取消已提交掃描。
- [ ] 最近 10 次歷史摘要正常。

### Performance

- [ ] Dashboard 自身模型 Token 為零。
- [ ] 未打開時零額外數據查詢。
- [ ] 未打開時零額外輪詢。
- [ ] 未新增 Agent Tools。
- [ ] 未新增 Skills。
- [ ] 未修改 Bootstrap。
- [ ] 未新增常駐 Daemon。
- [ ] 未新增 UI 專屬常駐 Relay。
- [ ] 被動查看不觸發索引。
- [ ] 無明顯且可重複的 Agent 性能退化。
- [ ] 無 Timer、Listener、Process 洩漏。

### Compatibility

- [ ] 原有插件功能回歸通過。
- [ ] Headless 正常。
- [ ] UI 不可用時安全降級。
- [ ] Manifest Check 通過。
- [ ] Skills Check 通過。
- [ ] Pack Check 通過。
- [ ] 完整 Regression Gate 通過。

所有項目使用 PASS / FAIL / PARTIAL / NOT RUN / BLOCKED 標記。

只有具備實際證據的項目才能判為 PASS。

## 51. 最終交付文件

在 docs/ 下輸出以下文件，日期使用實際執行日期。

### Feasibility Report

YYYY-MM-DD-basemind-dashboard-feasibility-report.md

內容：

- 實際 DSH API 契約。
- 實際 BaseMind 數據契約。
- UI 接入方案。
- 數據來源矩陣。
- 性能成本。
- 副作用。
- 降級決策。

### Execution Report

YYYY-MM-DD-basemind-dashboard-execution-report.md

內容：

- 基準 HEAD。
- 實際實施範圍。
- 文件改動清單。
- 架構說明。
- UI 功能結果。
- 各接口實測結果。
- 測試結果。
- 性能前後對比。
- 打包大小變化。
- 已知限制。
- 未實施字段或功能。
- 自動修復記錄。
- 最終驗收 Checklist。

### Review Report

YYYY-MM-DD-basemind-dashboard-review-report.md

內容：

- 自我審查結果。
- Critical / Important / Minor。
- 修復證據。
- Scoped Re-Review 結果。
- 回歸測試結果。
- 未解決風險。
- 最終交付判定。

如項目已有等效報告規範，可合併文件，但不得丟失必要證據。

## 52. 全自動執行及最終停點

按照以下順序連續執行：

Phase A → B → C → D → E → F → G → H → I → J → K。

中間不需要人工確認。

遇到可解決問題：

- 自主調研。
- 自主定位。
- 自主修復。
- 自主驗證。
- 繼續執行下一項。

遇到未支持能力：

- 按本 Plan 降級。
- 記錄證據。
- 不擴大 Scope。
- 繼續其他可完成工作。

遇到環境或權限阻擋：

- 不繞過安全限制。
- 不虛構結果。
- 保留最小人工後續操作清單。

完成全部可執行工作後：

1. 輸出最終交付摘要。
2. 提供所有修改文件。
3. 提供完整測試結果。
4. 提供 Agent 性能前後比較。
5. 提供 Dashboard 實際截圖（如環境支持）。
6. 提供已知限制及未完成事項。
7. 提供最終人工 Review 建議。
8. 停止執行。

不得自行執行：

- git add。
- git commit。
- git push。
- git tag。
- npm version。
- npm publish。
- release scripts。
- 生產 DSH Profile 修改。

最終人工 Review 是本任務唯一正常人工停點。

最高優先級始終是：

保護 dsh-basemind-plugin 現有 Agent 性能、穩定性及多工作區隔離能力，而不是不計成本地完成 Dashboard 所有候選字段。
