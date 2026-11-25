# BaseMind Dashboard — 暫存改動獨立審查報告

日期：2026-11-25
範圍：`feat/lightweight-workspace-dashboard` 分支的全部暫存改動（staged index vs `0e94e3e`）
性質：**獨立審查**（全新上下文的審查者，非作者自我審查；不取代 [自我審查報告](./2026-11-25-basemind-dashboard-review-report.md)）

## 0. 結論先行

**Blocking: 2 Critical / 2 Important。不建議合併；掃描功能在真實 Host 上完全不可用。**

兩項 Critical 各自獨立、都會讓「掃描」這個 Dashboard 唯一的寫入能力失效；而 515 個測試全綠，
正是因為測試替身沒有模擬真實 Host 契約（路由唯一性）與真實 React 渲染路徑（hook 邊界）。

## 1. 審查方式與證據

| 項目 | 內容 |
| --- | --- |
| Base | `0e94e3e`（plugin 0.2.1），無後續 commit |
| 範圍 | 26 檔、+6158/−7；staged 完整涵蓋，工作區無未暫存／未追蹤檔 |
| 需求來源 | [實作計劃](./2026-11-25-lightweight-workspace-dashboard-implementation-plan.md) §6–§8、§16–§18、§19–§36、§37–§44、§50 |
| 分派 | 3 位審查者（Host 核心／瀏覽器端／接線與打包），互斥檔案範圍；協調者另行複驗結論 |
| 客觀基線 | `npm run check` 通過（syntax 27 檔、bundle manifest ok）；6 個 Dashboard 單元測試 59 pass / 0 fail |
| 實證手段 | 自 `app.asar` 取出 `@deepseek-ai/dsh-host-webserver` 的 `register()` 原始碼；以真實契約重放路由註冊；`basemind rescan --help` 核對 CLI 契約；掃描 asar 內 cordis 事件；核對 desktop profile 的 bundle 順序 |
| 未審查 | 真實 Desktop GUI 驗收（§42）、以真實 binary 執行的 Dashboard integration gate、30 次 P5 延遲 benchmark、20 次開關循環 |

## 2. 已驗證的優點

- **子程序邊界正確**：`run.js` 走 `ctx.subprocess.spawn`，argv-only、經 `assertCmdWrappable`，輸出上限、timeout、abort 後 terminate 與既有 `lib/cli-tool.js` 同構，無 shell 注入面。
- **limiter 實際平衡**：`service.js:244` 的 `await acquire(signal)` 確實在 `try` 之外；`release()` 只在持有 slot 時呼叫；測試斷言 peak concurrency = 1，不只是呼叫次數。
- **route fence 實質有效**：remoteAddress（含 `::1`／`::ffff:127.0.0.1`）、Host 白名單（擋 DNS rebinding）、`sec-fetch-site`、Origin host 相等、method 白名單在 handler 前；64 KiB body cap 在 `JSON.parse` 前觸發。
- **資料誠實性**：未知值一律 `null` →「暫不可用」，不偽造 0；share 僅在 `file_count > 0` 時呈現；machine-global 統計有範圍標註。
- **生命週期骨架**：`registerDashboard()` 在既有單一 effect 內同步執行，service 於 `shutdown()` 最先 dispose，重複呼叫有守衛，`dashboard:false` 在取 webServer 之前 return（不建 service／history、不碰快取目錄）。
- **封裝與契約**：`npm pack --dry-run` 含全部七個 `lib/dashboard/*.js` 且不含 test/docs；`dsh.client` 與 DSH `parseDshClient` 相符；client 註冊契約（`__ModuleLoader__.load`、`exports.inject`、`ctx.slots.inject/register`、row key 格式）與已安裝第三方外掛一致。

## 3. Findings

### Critical

#### C1 / `lib/dashboard/routes.js:140,144`（後果在 `index.js:858-866`）— 同一 path 註冊兩條 exact 路由，真實 WebServer 必拋錯

- **觸發**：外掛啟動、webServer 可用時。
- **證據**：
  - `routes.js:140` 以 `kind: 'exact'`、path `…/scan`、methods `['GET']` 建 route；`routes.js:144` 再以**同一 path**、methods `['POST']` 建第二條。
  - 真實宿主契約（`app.asar` 內 `@deepseek-ai/dsh-host-webserver` 的 `register()`）：

~~~js
register(route) {
  const table = route.kind === 'exact' ? this.exact : this.prefixes
  if (table.has(route.path)) throw new Error('webserver: duplicate ' + route.kind + ' route ' + route.path)
  table.set(route.path, route)
  ...
}
~~~

  → WebRoute 只有 `kind/path/handler`，**沒有 `methods`**；唯一性以 path 判斷。
  - 以真實語意重放 `registerDashboardRoutes`：宣告 6 條 → 第 6 條拋 `duplicate exact route "/api/dsh-basemind-dashboard/scan"`，此時前 5 條已註冊（重放輸出已驗證）。
  - `index.js:858` 的例外在 `state.dashboard = service`（859）、`state.dashboardRegistered = true`（860）、`state.disposers.push`（861）**之前**，被 864 的 catch 吞成一行 warn。
- **預期 vs 實際**：預期六個 operation 上線、失敗時完整回滾。實際只有 5 條路由存活；POST `/scan` 落到 GET handler 被 **405**；`service` 永不 dispose；5 條路由永不卸載。
- **影響**：
  1. Dashboard 唯一的寫入能力（啟動全量／增量掃描）不可達。
  2. 違反 AGENTS.md「每個 registration 必須由 effect 擁有並 dispose」：卸載後仍有路由指向未 dispose 的 service。
  3. 之後任何 plugin reload／hot update 再註冊時，第一條 `/workspaces` 就 duplicate → Dashboard 永久消失直到重啟 Host。
- **最小修復**：`/scan` 只註冊**一條** exact 路由，handler 內依 `req.method` 分派 GET／POST（其餘 405）；或改用不同 path。`registerDashboardRoutes` 改成 per-route try/catch，失敗時把已取得的 disposer 全部呼叫，成功後才設定 `state.dashboardRegistered`。
- **必要回歸測試**：測試替身的 `register` 目前只 push（`test/dashboard-routes.test.mjs:198,211`，並斷言 6 條），需改成「(kind,path) 唯一、重複即 throw」，否則測試永遠抓不到。

#### C2 / `lib/dashboard/client.js:688`（`ScanView` 定義於 790，hooks 於 793-796）— 以普通函式呼叫含 hook 的元件，切到「掃描」分頁必拋 hook 順序錯誤

- **觸發**：頁面載入後點「掃描」分頁（`tab: 'overview' → 'scan'`）。
- **證據**：
  - 四個 view 都是直接呼叫：`:685 OverviewView(…)`、`:688 ScanView(…)`、`:691 DiagnosticsView(…)`、`:694 StatisticsView(…)`——React 不把它們當獨立元件。
  - `ScanView` 內含 4 個 hook：`:793 pendingFull`、`:794 pathsText`、`:795 actionError`、`:796 busy`。
  - `DashboardPage` 自身在 `:482-492`、`:503/522/541/560/579` 已有 16 個 hook，而 `ScanView` 只在 `tab === 'scan'` 時被呼叫。
  - → hook 鏈在 16／20 之間變動：Overview→Scan 拋 `Rendered more hooks than during the previous render`；反向拋 `Rendered fewer hooks than expected`。
- **預期 vs 實際**：預期點 Scan 顯示掃描頁；實際該次 render 直接拋錯。全量／增量掃描提交、確認對話框、10 筆歷史全部不可用（§6.3／§26／§32／§50）。
- **影響**：Scan 分頁在真實瀏覽器不可用；即使 C1 修好，使用者仍無法操作掃描。
- **最小修復**：四個 view 一律改 `React.createElement(OverviewView, props)` 等（建立真正的元件邊界）；或把 `ScanView` 的 4 個 `useState` 上提到 `DashboardPage`。
- **為何測試沒抓到**：`test/dashboard-client.test.mjs` 的假 `useState` 沒有「每次 render 的 hook 邊界」概念，且直接呼叫 `__internals.ScanView(…)`（`:239`、`:276`），完全繞過 `DashboardPage` 的渲染路徑。

### Important

#### I1 / `lib/dashboard/contracts.js:284-305`（argv 組裝在 `service.js:436-438`）— 增量掃描路徑可注入 BaseMind CLI 旗標

- **觸發**：`POST /api/dsh-basemind-dashboard/scan`，body `{"mode":"incremental","paths":["--rebuild-git-history"]}`（或 `["--no-git-history"]`、`["--view","staged"]`）。
- **證據**：`normalizeScopePaths` 只擋空字串、`/`、`~`、`X:`、`..`、`.`、長度與數量上限，**沒有擋前導 `-`**；路徑接著被原樣拼進 argv：`['rescan', ...job.scope, '--json', '--root', '.']`。以真實 binary 核對：`basemind rescan [OPTIONS] [PATH]...`，其中 `--rebuild-git-history`＝「Wipe and fully rebuild the git-history index」、`--view <VIEW>` 可切換查詢 view。同一 repo 的 `lib/cli-tool.js` 對使用者 argv 有對等的旗標防線，此處沒有。
- **預期 vs 實際**：計劃 §17 明文要求「拒絕 CLI 參數注入」、增量掃描限於已授權 workspace 範圍。實際可被要求把一次「增量掃描」變成 machine-global git-history index 的破壞性重建。
- **影響**：契約／安全要求被繞過（非 RCE、非 shell；可達者限於 loopback 同源 client，故非 Critical）。
- **最小修復**：`normalizeScopePaths` 對每個 entry 增加前導 `-` 的拒絕（可一併拒 NUL），與 `cli-tool` 的 argv 驗證對齊；補一條 contracts 測試。

#### I2 / `index.js:939-943` — 用不存在的 Cordis `'ready'` 事件做 webServer 補註冊

- **觸發**：composition 的 webServer 晚於本 row 掛載（bundle 順序可由使用者調整；亦可因 webServer 的 `apply` 晚於本 row 而出現）。
- **證據**：
  - `registerDashboard()` 在 `ctx.get('webServer')` 為空時直接 return（`index.js:839-842`），只留一行 debug log。
  - 補救手段是 `ctx.on?.('ready', …)`（`:941`）。掃描已安裝 DSH 0.2.2-rc.5 的 `app.asar`：cordis 內不存在 `emit('ready')`／`internal/ready`；`on('ready'` 僅出現在 fs watcher → 該 listener 永不被觸發，屬死代碼。
  - 宿主自身的可選服務寫法是 `ctx.inject(['webServer'], registerWebCarrier)`（`@deepseek-ai/dsh-client-modules`）。
- **預期 vs 實際**：預期 webServer 晚掛載時補註冊（註解與 README 均如此宣稱）；實際 Dashboard 靜默缺席，且無任何錯誤回報。
- **影響**：非預設 bundle 順序下功能消失且不可診斷；與 README 對外說明不符。
- **最小修復**：改 `ctx.inject(['webServer'], registerDashboard)`（服務出現時重跑、隨 fiber dispose），或移除該 listener 與註解並收斂文件；保留 `dashboardRegistered` 守衛。

### Minor（不阻塞，記錄備查）

| # | 位置 | 問題 | 建議 |
| --- | --- | --- | --- |
| M1 | `history.js:48` vs `contracts.js` 的 `MAX_SCOPE_PATHS=256` | 歷史只留前 64 筆 scope，無 truncated 標記 | 改用同一上限或標示截斷 |
| M2 | `service.js:209`、`538-558` | `dispose()` 只 abort `disposeController`；route 每次都傳自己的 signal，故在途讀取的子程序不會被中止，晚到結果仍會 cacheSet | 以 `AbortSignal.any` 合併兩個 signal |
| M3 | `service.js:143-167`、`250-252` | `invalidate()` 不清在途 loader，舊查詢完成後會回填快取 | per-workspace epoch，丟棄早於最後一次 invalidate 的寫入 |
| M4 | `client.js:594` | 3 秒輪詢用 `setInterval`，可能與上一輪重疊（§30 要求不得重疊） | 改 `setTimeout` 鏈，完成後再排下一次 |
| M5 | `client.js:769,774,836-840` | 掃描摘要用原始 `String(...)`，null 會顯示 `null`、狀態顯示英文 token | 改用 `text/count` 與 `t('scan.state.' + s)` |
| M6 | `client.js:648,665` | 索引健康徽章只從 Overview 取得，切到其他分頁即消失 | 於 diagnostics 分頁 fallback |
| M7 | `lib/config.js` 的 `dashboard` / `dashboardHistory` | 新增設定無任何測試 | 補 default true／顯式 false／字串 "false" 三例 |
| M8 | `index.js:831-867` | 無 index-level wiring 測試 | 補「無 webServer 不註冊／重複 apply 只註冊一次／shutdown 先 dispose service」 |

## 4. 與既有報告的落差

- [Execution Report](./2026-11-25-basemind-dashboard-execution-report.md) §5 與 [自我審查報告](./2026-11-25-basemind-dashboard-review-report.md) §5 以 `npm run verify` 全綠與 `1 pass` 的真實 gate 作為完成證據，並判定「No blocking issues found」。本審查不同意該結論：兩項 Critical 都不在測試覆蓋範圍內，原因是**測試替身與真實契約脫節**（fake `register` 不模擬 path 唯一性；fake `useState` 不模擬 hook 邊界、且繞過組合頁面），不是運氣不好。
- 「Desktop UI 驗收 NOT RUN」的自述是誠實的；但 C1／C2 屬於**不依賴 UI 驗收即可靜態確認**的缺陷，不應被標為「未驗證風險」。

## 5. 未驗證範圍與剩餘風險（非 finding）

1. 真實 Desktop GUI 驗收、真實 binary 的 Dashboard integration gate、P5 延遲 benchmark、20 次開關循環：本次皆未執行。
2. workspace registry 是否允許兩個 id 指向同一 canonical path（目前 cache／job 以 path 為 key，回應卻內嵌 workspace id/title）。
3. `normalizeScopePaths` 只做字面驗證，不解析 symlink／junction；依賴上游再驗證。
4. 最低支援版 DSH 0.2.1-rc.3 的 webServer 契約未實測；0.2.2-rc.5 已確認以 path 唯一。
5. `resolveApiBase` 以 `document.baseURI` 推導前綴，無測試；子路徑部署會請求到不存在的 URL。

## 6. Verdict

**Blocking: 2 Critical / 2 Important。** 掃描能力在真實 Host 上不可用（C1 路由註冊失敗、C2 分頁崩潰），
增量掃描仍有 argv 注入面（I1），webServer 晚掛載的補註冊是死代碼（I2）。

C1、C2 修復後必須各補一條能真正抓到問題的回歸測試（路由唯一性替身、組合頁面渲染），再重跑 `npm run verify`；
I1 另需 contracts 測試。本審查未修改任何產品程式碼。
