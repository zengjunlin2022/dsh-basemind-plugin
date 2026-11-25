# BaseMind Dashboard — Scoped Re-Review（修復輪）

日期：2026-11-25　前次審查：[獨立審查報告](./2026-11-25-basemind-dashboard-independent-review-report.md)
修復方報告：[Fix Report](./2026-11-25-basemind-dashboard-review-fix-report.md)

## 0. 輸入與範圍

- **Findings**：上一輪 Critical 2（C1 路由、C2 hook）、Important 2（I1 argv 注入、I2 死 `ready`），逐字沿用上一輪報告，未重新推導。
- **Base**：前次審查所見的 index 內容（`HEAD = 0e94e3e`，全部改動 staged，工作區無未暫存檔）。
- **Head**：目前 index（`HEAD` 仍為 `0e94e3e`，無新 commit、無 unstaged、無 stash）。以 git 確認。
- **修復 diff**：git 無法把修復從同一個未提交 index 中分離（沒有可供比對的中間 tree）。因此範圍限定為 fix report 明列的檔案、四處 finding 站點所在行、以及對應測試；其餘未動程式碼不在本輪判定內。
- 依 scoped re-review 規則未重跑測試套件；只在讀碼產生具體疑問時做了一次定向 probe（直接呼叫 `normalizeScopePaths`，未寫入任何檔案）。

## 1. Finding Verdicts

### C1 — 同一 path 兩條 exact route，註冊失敗後殘留 5 條 — **ADDRESSED**

- 機制：`lib/dashboard/routes.js:143` 只剩**一條** `/scan`，`methods: ['GET','POST']`，`:144-147` 依 `method` 分派 GET、`:148-157` 為 POST；路由表共 5 個 path 涵蓋 6 個 operation。
- 回滾：`routes.js:167-184` 逐條 register，任何失敗先反向呼叫已取得的 disposer 再 rethrow；`index.js:866-873` 重設 `state.dashboard`/`dashboardRegistered` 並 `service.dispose()`，因此不再有未 dispose 的 service 掛在路由後。
- 覆蓋測試確實存在且能失敗：`test/dashboard-routes.test.mjs:45-60` 的 `strictWebServer` 以 `kind + ':' + path` 判重並 throw（與宿主 `register()` 一致）；`:85-104` 斷言 5 條唯一 path 與 `/scan` 的 `['GET','POST']`；`:219-221` 斷言 `count() === 5`；`:235-245` 的 rollback 測試先佔用一條 path，斷言只剩 blocker。前版 6 條路由會同時違反唯一性與 strict double。
- 替代機制是否滿足原要求：是。原缺陷是「同一 path 註冊兩次」，替代方案為單次註冊＋method 分派，POST 仍可達（16 個 operation 不變）。

### C2 — view 以普通函式呼叫，Scan 分頁 hook 數變動 — **ADDRESSED**

- 機制：`lib/dashboard/client.js:716-731` 的 `TabBody` 只回傳 `React.createElement(OverviewView | ScanView | DiagnosticsView | StatisticsView, props)`；頁面在 `:687-704` 改為 `createElement(TabBody, {...})`。四個 view 不再於 `DashboardPage` 的 render 中被呼叫，hook 鏈固定為 `DashboardPage` 自己的 16 個。
- 傳參一致：`TabBody:719-728` 傳給各 view 的 props 名稱與各 view 的取用一致（`activeScan`、`onRefresh`/`onScan`、`workspace`/`onStart`/`onReload`、`window`/`onWindow`）。
- 覆蓋測試存在且能失敗：`test/dashboard-client.test.mjs:52-60` 的替身在 `endRender()` 比對 hook 數並拋 `Rendered N hooks but expected M`；`:201-227` 斷言每個 tab 的 `TabBody` 回傳 `type` 為對應元件且本次 render 執行 0 個 hook；`:229-252` 走「載入 workspace → 選取 → 切到 scan」的實際轉換，並斷言 hook 順序穩定。舊碼在第二次 render 會變成 20 個 hook 而拋錯。

### I1 — 增量掃描 scope 可注入 CLI 旗標 — **NOT ADDRESSED**

- 新增的防線在 `lib/dashboard/contracts.js:296`：只檢查 **trim 後的原字串** 是否以 `-` 開頭。
- 但同一函式在 `:305-307` 會濾掉 `.`／空 segment 後重新 join，再於 `:307` 推入結果，`service.js:522` 存的就是這份**正規化後**路徑，`service.js:458` 直接放進 argv。
- 定向 probe（實際呼叫 `normalizeScopePaths`）：`['./-x'] → {ok:true, paths:['-x']}`、`['./--rebuild-git-history'] → {ok:true, paths:['--rebuild-git-history']}`、`['./-'] → {ok:true, paths:['-']}`。
- 因此原始觸發條件仍成立：POST body 送 `paths: ['./--rebuild-git-history']` 即可讓 BaseMind 執行 destructive 的 git-history 重建；只是繞過形式從 `'--x'` 變成 `'./--x'`。覆蓋測試 `test/dashboard-contracts.test.mjs:172` 只驗證了**字面**形式 `['--rebuild-git-history']`、`['-x']`、`['--view','staged']`、`['-']`，未涵蓋正規化後才產生的前導 `-`。
- 最小修復：把前導 `-` 與 NUL 的檢查移到**正規化之後**（對 `withoutDot.join('/')` 的結果檢查），或在 join 之後再驗一次；測試補一例 `['./-x']` 與 `['./--rebuild-git-history']`。

### I2 — 用不存在的 Cordis `ready` 事件補註冊 — **ADDRESSED**

- 機制：`index.js:946-953` 已無 `ctx.on('ready')`（全檔 grep 為 none），改為 `if (typeof ctx.inject === 'function') ctx.inject(['webServer'], () => { registerDashboard() })`；`index.js:945` 仍先同步嘗試一次，`registerDashboard():832` 的 `dashboardRegistered` 守衛保證不重複註冊。
- 與宿主一致：`ctx.inject(deps, cb)` 正是 `@deepseek-ai/dsh-client-modules` 等待可選 `webServer` 的寫法；服務晚到時會觸發，`ctx.get('webServer')` 在回呼內可用。
- 限制（fix report 已自述，非新問題）：此路徑沒有專屬回歸測試（M8 延後），且 webServer 被**替換**而非首次提供時不會重綁。

## 2. New Breakage in the Fix Diff

| 嚴重程度 | 位置 | 內容與觸發 |
| --- | --- | --- |
| Minor | `lib/dashboard/client.js:808` | M5 把 `String(...)` 改成 `count(...) \|\| '—'`：`count(0)` 回傳 0，被 `\|\|` 吞成 `—`，於是「本次掃描 0 個檔案」顯示為「不可用」，與其他地方的「0 就是 0」不一致。觸發：summary 的 scanned/updated/removed 為 0。 |
| Minor | `lib/dashboard/client.js:803` | 同一 finding 的另一半未改：最近一次掃描的狀態仍以 `String(data.lastDashboardScan.status)` 顯示英文 token（歷史表用 `t('scan.state.' + status)`），fix report 的「states were already translated」與此處不符。 |

C1／C2 的新機制本身未引入 Critical 或 Important 破壞：路由合併後 GET/POST 分派與 client 的呼叫方式一致；`TabBody` 由函式宣告提升，頁面與測試都走同一條路徑；`index.js` 失敗路徑改為重設狀態並 dispose，未見殘留註冊。

## 3. Out-of-Scope Observations

- `lib/dashboard/service.js:221-226`：`AbortSignal.any` 的 fallback 分支（舊 Node）會退回只用 client signal，dispose 仍不會中止該讀取；目標 runtime 為 Node 24，實務不可達。
- `test/index.test.mjs` 未新增 webServer 注入案例（M8 延後）；本輪不因此重判 I2。
- `README.md`／`CHANGELOG.md` 宣稱的操作數與現在「5 條 path／6 個 operation」一致，未見矛盾。

## 4. Verdict

**Findings remain open: I1。** C1、C2、I2 已由機制層面修好並有能失敗的回歸測試；I1 只擋住字面形式，`./` 前綴在正規化後仍會產生前導 `-` 並進入 BaseMind argv，原始缺陷與影響不變。

修復方向明確且極小：把前導 `-`／NUL 的檢查移到正規化之後，並補 `['./-x']`、`['./--rebuild-git-history']` 兩條案例。其餘 Minor（0 顯示成 dash、狀態未本地化）不阻塞。
