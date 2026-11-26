# BaseMind Dashboard：人工審查操作步驟（0.2.2）

日期：2026-11-26　審查對象：commit `1ebec3b`（0.2.2 版本）中的 Dashboard 功能　環境：`D:\02_zengjunlin\DSH_TEST`（官方 DSH Desktop Development，DSH `0.2.2-rc.5`）

本文件是**給你照著做的人工審查腳本**，不是驗收報告。每一步都寫明「怎麼做、應該看到什麼、不對時去哪裡找證據」。
自動化已經跑過的項目對照見 §11，避免重複回報；已知限制見 §10。

- 預估時間：45–60 分鐘（§2–§8 是主體，§9 可選）
- 你可以邊做邊記錄，最後用 §12 的格式回報

## 0. 審查範圍與原則

**本次要審的功能**（0.2.2 新增）：

1. Plugins 頁 BaseMind 列上的 **Configure → Dashboard 頁**（Overview／Scan／Diagnostics／Statistics 四個 tab）
2. 只讀優先的 Host 路由族 `/api/dsh-basemind-dashboard/*`（五條 exact 路由、六個 operation）
3. 兩個設定：`dashboard`（預設 true）、`dashboardHistory`（預設 true，唯一寫入檔案是插件自己的掃描歷史）
4. 安裝、卸載、停用時的行為，以及它對 Agent 的零影響

**原則**：

- 只動測試環境；不要開正式 DSH Desktop（`C:\Users\sanny\.dsh`）。
- 不要 commit、不要改 repo 檔案；發現問題只記錄「檔案:行號＋觸發條件＋預期 vs 實際」。
- 這是**功能與契約審查**：重點是看資料是否真實、有沒有編造、錯誤狀態是否誠實、有沒有偷偷多做事情。

## 1. 啟動與確認（我已完成啟動）

我已用 `start-test.ps1` 啟動測試 Desktop，視窗標題為 `dsh-app://app/` 的 Electron 應用（左上角顯示
`DSH 本地构建` 與版本 `0.2.2-rc.5-9c2670d`）。

確認清單：

| 檢查 | 方法 | 預期 |
| --- | --- | --- |
| 實例是測試版 | 視窗左上角 | `DSH 本地构建`＋`0.2.2-rc.5-9c2670d` |
| 隔離正確 | 另開 PowerShell 執行 `pwsh -File D:\02_zengjunlin\DSH_TEST\scripts\status-test.ps1` | `DSH_HOME` 指向 `D:\02_zengjunlin\DSH_TEST\desktop-home`，與 FORMAL 不同 |
| 插件已載入 | Plugins 頁 → 已安裝插件 | 有 `BaseMind（工作區感知）`，版本 `v0.2.2` |
| 有可審的工作區 | 左側工作區清單 | 至少 `vue3-demo`（測試 fixture，已建索引）與 `默认工作区` |

如果視窗停在 Welcome 或一直 `Loading plugins…`：等 10–60 秒；仍失敗看
`D:\02_zengjunlin\DSH_TEST\logs\desktop-dev.err.log`。

## 2. 入口與頁面骨架（必做）

1. 左側導航點 **插件**。
2. 在「**已安装插件**」找到 `BaseMind（工作區感知）`，按右側 **查看 BaseMind（工作區感知）**。
3. 進入詳情頁後，往下找「**包含的组件**」區塊；在 `dsh-basemind` / `dsh-basemind-plugin` / `运行中` 那一列
   按 **配置**（齒輪／開啟圖示）。
4. 應該進入 Dashboard 頁面。

**重點**：Configure 控件**只出現在詳情頁的「包含的组件」列**，不在「已安装插件」清單列上。這是插件管理器
（`PackageDetail`）的設計，不是我們的缺陷；README 已改成完整路徑。

應該看到：

- 標題 `BaseMind（工作區感知）`、版本 `0.2.2`
- 專案選擇器（預設第一個 registry 工作區，含路徑）、右側 `索引可用` 徽章與 `重新整理`
- 一行說明「清單來自 DSH Workspace Registry；切換專案不會改動 Agent 的工作區。」
- tab 列：`總覽 / 掃描 / 診斷 / 統計`

不對時：`lib/dashboard/client.js:26`（key）、`:1017-1030`（`apply` 註冊）；Host 端 `index.js:831-874`。

## 3. Overview（總覽）

逐項核對（把畫面上的數字與 `mcp__basemind__index_status` 的結果對照，可在任一會話裡呼叫該工具）：

| 項目 | 應該是什麼 | 常見錯誤 |
| --- | --- | --- |
| 已索引文件 / Blob 數量 / 索引大小 | 真實數字（vue3-demo 約 4 檔） | 顯示 0、或每次重新整理都變 |
| 語言 + 語言分佈 | 語言數與表格一致；佔比合計 100% | 某語言 `file_count` 為 0 卻出現該列 |
| 索引健康 | `索引可用` / 未索引 / 損壞…等**原文** | 把 unknown 顯示成 0 |
| 分支 / HEAD | 有 git 時顯示 `branch / sha`；不是 git repo 顯示 `—` | 顯示 `0` 或空白 |
| 最多被引用 / 超長文件 | 真實清單；沒有就顯示空狀態 | 編造條目 |
| BaseMind 的 notice | 有就**原文**顯示（例如 `nothing scanned`） | 改寫成自己的文案 |
| 最近一次 Dashboard 掃描 | 沒做過顯示「尚未由 Dashboard 發起掃描」；做過顯示時間／類型／耗時／統計 | 把 BaseMind 的掃描時間冒名成 Dashboard 的 |

按 `重新整理` 應該重新查一次（Overview 有 5 秒快取，狂按不會每次打 Host）。

## 4. Scan（掃描）

**4.1 全量掃描要「先確認」**

1. 點 `掃描` tab → 在 `全量掃描` 按 **開始掃描**。
2. 應出現確認框，內容需包含：**明確的專案絕對路徑**、**CPU／RAM／磁碟 IO 風險提醒**、
   **不會刪除現有索引** 的說明，以及 `取消`／`確認執行`。
3. 按 **取消** → 不應該有任何掃描開始（`目前任務` 仍是空的）。

**4.2 增量掃描是真的**

1. 在 `增量掃描` 輸入框填 `src/main.js`（每行一個相對路徑）。
2. 按 `增量掃描`（輸入為空時按鈕應為停用狀態）。
3. 觀察：`目前任務` 顯示 `執行中` 與已耗時 → 完成後顯示 `完成`、`耗時`、`掃描／更新／移除／略過／錯誤` 數字；
   `最近 10 次 Dashboard 掃描` 多一列。
4. 開著「掃描」tab 時，Host 應該每 **3 秒**輪詢一次 `GET /scan`（可在 DevTools Network 觀察）；
   **完成後就停止**，不再有請求。

**4.3 邊界**

- 輸入 `../x` 或絕對路徑 → 應該被拒絕（不得送出）。
- 同一時間機器上已有 Dashboard 掃描在跑時，再送一次 → 應該被拒絕並說明（machine-wide 序列化）。
- 掃描進行中關閉頁面 → 掃描**不會**被取消（重新打開可看到結果）；但輪詢會停。

## 5. Diagnostics（診斷）

| 觀察 | 應該是什麼 |
| --- | --- |
| 外掛版本 / Binary | `0.2.2`、`BaseMind 0.34.0`＋`match` |
| 索引 | 目前狀態 |
| MCP Relay | 這個插件自己的 relay 數（正常 1） |
| 檢查表 | `version / root / config / index / grammars / hook / daemon / cache` 每列都有 `ok` 或失敗與細節 |
| 結尾聲明 | 「診斷為唯讀：不修復、不下載、不重建索引、不重連 Relay」 |

這頁**不可以**有任何修復／下載／重建／重連的按鈕或副作用。測試方法：停在這一頁觀察，不應該觸發下載或索引變動。

## 6. Statistics（統計）

| 觀察 | 應該是什麼 |
| --- | --- |
| 時間範圍 | `今天 / 近 1 小時 / 近 24 小時 / 全部`，切換會重查 |
| 工具呼叫 / 預估節省 Tokens / 回應位元組 | 真實數字 |
| 磁碟用量 / 查詢程序峰值 RSS | 有標示為 machine-global（RSS 是查詢程序自己的峰值） |
| 各工具分佈 | 工具名、呼叫數 |
| 快取組成 | 各快取目錄的 bytes |
| 統計範圍說明 | 至少要有「整台機器」與「Estimated Tokens Saved 是啟發式估算、不是 API 計費」的說明 |

**文案（2026-11-26 已修）**：中文介面下，「統計範圍」原本最後兩條是英文
（`machine-global cache directory …`、`machine-global BaseMind tool telemetry …`），來源是 Host payload
硬編字串 `lib/dashboard/service.js:396-397`。現已改由 client 字典輸出
（`statistics.scope.cache`／`statistics.scope.telemetry`），zh 顯示中文、en 顯示英文；
你在審查時應該只看到四條中文說明，若仍出現 `machine-global` 就是回歸。

## 7. 錯誤與未知狀態（誠實性審查）

- 切到 `默认工作区`（較大的工作區）或任何沒有索引的專案：`索引健康` 應該是「未索引」或其他真實狀態，
  `已索引文件` 等欄位應顯示「不可用／—」，**不得顯示 0**。
- 若 BaseMind binary 尚未被選到（例如剛啟用插件、還沒開過任何 Agent 會話），頁面會顯示
  `binary-unavailable` 的錯誤訊息並說「Open a BaseMind session once…」。這是設計行為，不是當機。
- 任何看起來像「猜出來」的數字（例如 scans 次數、掃描時間戳）都應被視為缺陷。

## 8. locale 與主題

1. `账号菜单 → 设置 → 通用设置 → 语言`：清單應有 8 種（中文、English、日本語、Español、Français、Deutsch、Русский、Português）。
2. 切 **English** → 回 Dashboard：四個 tab 與所有標籤應為英文（`Overview / Scan / Diagnostics / Statistics`、
   `Tool calls`、`Estimated tokens saved`、`Last 10 Dashboard scans`…）。
3. 切 **日本語**（本插件未提供日文字典）→ 應**乾淨回退英文**，不得出現 `tab.overview` 這種 raw key。
4. `外观`：`浅色 / 深色 / 跟随系统` 各看一次；Dashboard 的卡片、表格、share bar 在深色下仍可讀。
5. 看完切回你習慣的語言與主題。

## 9. 生命週期（選做，但很有價值）

- **停用**：在詳情頁把 bundle 開關關掉 → `配置` 控件消失、Dashboard 不可進入；
  再打開 → 控件回來。停用期間 `GET /api/dsh-basemind-dashboard/workspaces` 應該從 200 變成 401
  （路由族不存在，落到 Host 自己的請求政策）。
- **開關頁面 20 次**：Dashboard ↔ 詳情頁來回 20 次，觀察記憶體／CPU 沒有持續上升；
  停在同一頁閒置 1 分鐘，Network 不該有 dashboard 請求。
- **關頁不影響 Agent**：Dashboard 開著跑一次 Agent 會話（例如問 fixture 的符號），
  不應變慢或有錯誤（P5 已量測 60 個樣本，未發現回歸）。

## 10. 已知限制（不要當缺陷回報）

| 限制 | 說明 |
| --- | --- |
| 沒有掃描進度／百分比／取消 | BaseMind 0.34.0 沒有這個 API；頁面只顯示真實狀態與耗時，並明說 |
| 沒有 BaseMind 的「最後掃描時間」 | 上游不提供；Overview 只顯示 **Dashboard 自己提交**的掃描，且有標示 |
| 不「跟隨目前會話」 | Host-only 插件沒有可靠的 current-session 解析；清單取 DSH Workspace Registry，預設選第一個 |
| 磁碟/telometry 是機器全域 | 頁面已標示，不是本專案獨享 |
| Diagnostics/Statistics 不快取 | 每次打開都會查（0.4–1.4 秒），這是刻意行為 |
| Dashboard 只在有 web server 的組合存在 | 桌面與 web 都有；headless 沒有（不註冊任何路由） |
| 路由族不加驗證、但只接受 loopback 同源請求 | Host 沒有全站驗證（官方 `dsh-host-webserver` 明確如此）；外掛自己做 loopback＋Host＋`Sec-Fetch-Site`＋Origin 檢查，非 loopback 一律 403 |

## 11. 自動化已驗證的證據（避免重複回報）

| 項目 | 結果 | 證據 |
| --- | --- | --- |
| 四個 tab、真實資料、掃描、locale、主題、停用/啟用、22 次開關循環 | PASS | `docs/2026-11-25-basemind-dashboard-desktop-acceptance-report.md` |
| 官方測試 Desktop 複驗（Configure 控件、四 tab、214 ms 增量掃描） | PASS | `docs/2026-11-26-basemind-dashboard-testenv-acceptance-report.md` |
| P5 Agent 延遲（60 樣本，含飽和負載） | 未偵測到回歸 | 同上 §4 |
| 路由／歷史／服務／client 契約、index-level wiring | `npm test` 526 tests / 506 pass / 0 fail / 20 skipped（gated 真實 binary） | 執行 `npm test` |
| Statistics「統計範圍」文案（zh 中文、en 英文、payload 英文不外洩） | PASS（2026-11-26 修正＋回歸測試，`npm test` 527 / 507 pass） | `test/dashboard-client.test.mjs`；實機見 2026-11-26 報告 §3.1 |

## 12. 回報格式（建議）

```text
嚴重程度（Critical / Important / Minor / 待確認）
位置：檔案:行號（或 UI 元素）
觸發條件：
預期行為 / 實際行為：
影響：
建議的最小修復：
```

## 13. 停止與清理

```powershell
pwsh -File D:\02_zengjunlin\DSH_TEST\scripts\stop-test.ps1    # 只停測試 Desktop 與其 BaseMind daemon
pwsh -File D:\02_zengjunlin\DSH_TEST\scripts\status-test.ps1  # 確認 0 個測試進程、正式 daemon 仍活著
```

不要用工作管理員批次結束 node/electron 進程，也不要碰 `C:\Users\sanny\.dsh`。
