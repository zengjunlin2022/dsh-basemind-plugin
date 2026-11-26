# BaseMind Dashboard：真實 Web UI 驗收報告

日期：2026-11-25　執行者：lead（自動化驗收會話）　範圍：0.2.2 的 Dashboard（`lib/dashboard/`、Host 路由族與 client 半）

本報告記錄在 **隔離的 DSH_HOME＋真實 DSH Web GUI＋真實 BaseMind 0.34.0** 上執行 Dashboard 驗收的完整
步驟、證據與結論。它取代 `docs/2026-11-25-basemind-dashboard-execution-report.md` §4.2／§4.3 的
「真實 UI 驗收 NOT RUN」，並把 §6 的 P5／P7 與 §10 的 UI／Performance／Compatibility 表更新為以下結論。

> **2026-11-26 補充**：本報告標為 NOT RUN 的兩項已在官方測試環境（`D:\02_zengjunlin\DSH_TEST`）補完，
> 見 `docs/2026-11-26-basemind-dashboard-testenv-acceptance-report.md`：
> P5 延遲取樣已量測（60 個樣本，未偵測到回歸），headless 組合已取得工具註冊實證（模型回合仍受限於
> 憑證只對 Desktop 進程可用）。以下 §6.3、§9、§11 的 NOT RUN 標記以該報告為準。

## 0. 結論摘要

| 項目 | 結果 |
| --- | --- |
| 原本的阻塞點（Plugins 頁找不到 Configure 控件） | **不是產品缺陷**：控件存在且可用，只是位於「套件詳情頁 → 包含的組件」而非「已安裝插件」清單列。證據與可重現步驟見 §2 |
| 四個 tab（Overview／Scan／Diagnostics／Statistics） | **PASS**，都有真實資料與 VOM 證據（§4） |
| 語言 zh／en、主題深／淺 | **PASS**；8 種語言清單已記錄，未支援語言乾淨 fallback 到英文（§5） |
| 停用／重新啟用 bundle | **PASS**：控件與路由族消失、回復（§6） |
| 20 次以上開關循環（P7） | **PASS**：22 次循環、DOM 節點數與 host 子程序數不變、閒置無輪詢（§7） |
| M8 index-level wiring 測試 | **PASS**：新增 4 條測試，`test/index.test.mjs` 34/34 通過（§8） |
| headless（無 Web server）組合 | **PARTIAL**：組合與啟動有證據；完整 headless 會話因缺少模型憑證 **NOT RUN**（2026-11-26 已補：工具註冊實證，模型回合仍受憑證限制） |
| P5 30 次以上 Agent 延遲取樣 | **2026-11-26 已量測**：60 個樣本（40 真實負載 + 20 飽和負載），未偵測到可重複回歸 — 見 `docs/2026-11-26-basemind-dashboard-testenv-acceptance-report.md` §4 |
| 文件回填 | 本報告 + execution report + CHANGELOG + README 路徑說明 |

## 1. 環境與方法

| 項目 | 值 |
| --- | --- |
| DSH | `0.2.2-rc.5`（Settings → General 顯示 `Current version: 0.2.2-rc.5`） |
| 基線 | commit `ff70644`，工作區僅有 4 個版本修改（未提交）＋本會話產生的文件 |
| 隔離的 DSH_HOME | `C:\Users\sanny\AppData\Local\Temp\dsh-acc022`（收尾時整個刪除） |
| 安裝方式 | `dsh plugin --profile web add dsh-basemind-plugin-0.2.2.tgz --save-exact`（tarball 187,089 B） |
| Web 實例 | `dsh web --no-open --port 0` → `http://127.0.0.1:50551`（token 只在 job 輸出中，未寫入 repo） |
| BaseMind | 受管 binary 0.34.0；`BASEMIND_DATA_HOME`／`BASEMIND_COMMS_DIR` 都在隔離目錄內 |
| 工作區 | `default-workspace`（registry id `b1692f52-…`）：2,061 個已索引檔案、7 種語言、索引 50.9 MB |
| 瀏覽器 | bsk session `ucjh`；以 `?token=` 交換 cookie 後操作真實 GUI |

所有 UI 證據都是「真實瀏覽器 → 真實 Host → 真實 BaseMind」取得，不是 mock 或單元測試渲染。
未授權或未碰觸：使用者的 `~/.dsh/profiles/desktop`、正在運行的桌面實例、任何 commit／push。

## 2. T1（原阻塞點）：Configure 控件為何「看不到」

**結論：不是產品缺陷，`lib/dashboard/client.js` 的註冊方式正確，cell key 與 Host row 完全對得上。**
先前判定為阻塞，是**檢查路徑錯誤**：只看「已安裝插件」清單列，沒有進入套件詳情頁。

### 2.1 插件管理器的實際判定（served bundle `pm.js`）

```js
configure = pkg => ({
  has: row => ledger.rows.has(rowConfigKey(pkg.name, row.rowId)),
  open: row => setView({ kind: 'row', name: pkg.name, rowId: row.rowId }),
})
// rowConfigKey(bundle, rowId) => `${bundle}#${rowId}`
// ledger.rows = keysOf('plugins.row.config')  (entry.options.key)
```

`RowsSection` 只有在 `configure?.has(row) === true` 時才渲染 `button[class*="rowOpen"]`（`aria-label` =
`configureRow`），而 `configure` 只由 `PackageDetail` 傳入 —— 也就是**必須先按「查看 BaseMind」進入詳情頁**，
「已安裝插件」清單列本來就只有 `查看`／`啟用-停用`。

### 2.2 我們的註冊與 Host row 對照

| 位置 | 值 |
| --- | --- |
| `cordis.patch.yml` | `- id: dsh-basemind`、`name: 'dsh-basemind-plugin'` |
| `lib/dashboard/client.js:26` | `ROW_KEY = 'dsh-basemind-plugin#dsh-basemind'` |
| 組合後 | `rowConfigKey('dsh-basemind-plugin', 'dsh-basemind')` = `dsh-basemind-plugin#dsh-basemind` ✔ |
| 註冊方式 | `client.js:1017-1030`：`ctx.effect(ctx.locale.register)`、`ctx.slots.inject('plugins.row.config', …)`、`ctx.slots.register({ name, key: ROW_KEY, locale: NS }, DashboardPage)` |
| `inject` 宣告 | `client.js:1011`：`['slots', 'locale']` |

### 2.3 實機證據

```text
read [data-plugin-rows]  → "包含的组件共 1 个 · 1 运行中 BaseMind（工作區感知）… dsh-basemind dsh-basemind-plugin 运行中"
read [data-plugin-rows] button[0] → { class: "V7pFBG_rowOpen", aria-label: "配置 BaseMind（工作區感知）" }
click 該按鈕 → [data-plugin-config] 掛載，出現「專案／總覽／掃描／診斷／統計」與真實索引數字
```

### 2.4 可重現步驟

1. Plugins 頁 → 已安裝插件 → 按 **查看 BaseMind（工作區感知）**（不是清單列上的其它控件）。
2. 詳情頁的「包含的組件」區塊，組件 `dsh-basemind` 那一列的右側即是 **配置**（齒輪／開啟）按鈕。
3. 按下後即為 Dashboard 頁面；同頁的返回鍵（`aria-label` 結尾 `に戻る`／`Back to`／`返回`）回到詳情頁。

### 2.5 由 T1 衍生的文件缺陷（本會話修正）

`README.md`／`README.zh.md` §16 原文寫「Plugins → the BaseMind row → **Configure**」，省略了「先按
**查看** 進入套件詳情」這一步，正是本次卡住的原因。已改為完整路徑。（`docs/` 內既有報告的敘述一併以本
報告為準。）

## 3. T2：隔離實例的專案清單

- `GET /api/dsh-basemind-dashboard/workspaces` →
  `{"source":"workspace-registry","items":[{"id":"b1692f52-…","title":"default-workspace","path":"C:\\Users\\sanny\\Documents\\deepseek-harness\\default-workspace",…}],"capabilities":{"followCurrentSession":false,"worktreeIdentity":"path"}}`
  → **items ≥ 1，條件成立**（不需要額外註冊工作區）。
- 另建了一個 3 檔＋`git init` 的小型 fixture repo `$DSH_HOME/ws1` 備用，但**未**加入 registry：
  在這個 Web GUI 按「添加工作区」沒有任何對話框或原生選取器出現（瀏覽器實例無法開原生資料夾選擇器），
  而手動改 `storages/workspace.json` 屬於交接文件標為「風險較高」的做法，未採用。此為環境限制，不影響驗收。

## 4. T3：四個 tab（真實資料）

全部在 `http://127.0.0.1:50551` 的真實頁面上取得（`[data-plugin-config]` 的文字內容與截圖）。

| Tab | 實測內容（節錄） |
| --- | --- |
| Overview | 已索引文件 `2,061`、Blob `1,042`、索引大小 `50.9 MB`、語言 `7`、索引健康 `索引可用`、分支/HEAD `—`；語言分佈表（typescript 1,332 / 65%、javascript 493 / 24%、tsx 168 / 8.2%…）；最多被引用；超長文件 `53`；「最近一次 Dashboard 掃描」 |
| Scan | 目前任務、全量掃描（確認式）、增量掃描輸入框、「最近 10 次 Dashboard 掃描」、「BaseMind 0.34.0 沒有掃描進度 API」說明 |
| Diagnostics | 外掛版本 `0.2.2`、Binary `BaseMind 0.34.0 match`、索引 `索引可用`、`1 relay`；檢查表 `version/root/config/index/grammars(12 downloaded)/hook(not a git repository)/daemon(running (\\\\.\\pipe\\basemind-comms-…))/cache(no GC recorded yet)`；「診斷為唯讀」聲明 |
| Statistics | 時間範圍（今天／近 1 小時／近 24 小時／全部）、工具呼叫 `2`、預估節省 Tokens `0`、回應位元組 `3.5 KB`、磁碟用量 `311 MB`、查詢程序峰值 RSS `74.6 MB`、各工具分佈 `index_status 2`、快取組成（blobs 161 MB…other 8.6 KB）、統計範圍三條說明 |

### 4.1 驗收細項

| 細項 | 結果與證據 |
| --- | --- |
| 未知值顯示「不可用」而非 0 | **PASS**：分支/HEAD 顯示 `—`（工作區不是 git repo）；未知欄位的 null→unavailable 由 `test/dashboard-client.test.mjs:296` 覆蓋（`state.unavailable`、notice 原文 `nothing scanned`） |
| 語言 share 只在 `file_count>0` 時出現 | **PASS（單元層）**：`test/dashboard-client.test.mjs:277`；實機工作區 7 種語言都 >0，無法在實機製造 0 檔語言 |
| notice 原文顯示 | **PASS（單元層）**：`test/dashboard-client.test.mjs:296` 斷言 notice `message` 原文輸出；實機索引健康無 notice 可顯示 |
| 歷史 10 筆 | **PASS（單元層）**：`test/dashboard-history.test.mjs:30`「keeps the newest ten entries per workspace」；實機只做了 1 次增量掃描，歷史列為 `2026/11/25 20:18:49 增量掃描 完成 423 ms 2` |
| 全量掃描先確認並具名風險 | **PASS**：按下「開始掃描」出現「確認全量掃描／將對 `C:\Users\sanny\Documents\deepseek-harness\default-workspace` 執行 BaseMind 全量掃描。掃描會消耗 CPU、RAM 與磁碟 IO，可能影響正在工作的 Agent。不會刪除現有索引。／確認執行・取消」，按「取消」確實未啟動 |
| 增量掃描可執行並回報真實結果 | **PASS**：輸入 `AGENTS.local.md` + `basemind.toml` → 執行中（已耗時 30 ms）→ 完成 `423 ms`、`掃描 2 更新 0 移除 0 略過 0 錯誤 0`（`elapsedMs 190`） |
| 歷史檔案落在插件自管快取 | **PASS**：`$DSH_HOME/cache/dsh-basemind-plugin/dashboard/dashboard-history.json` 內容為單筆紀錄（taskId、scope、startedAt/finishedAt、summary、baseMindVersion `0.34.0`） |
| 3 秒輪詢只在提交後出現、完成即停 | **PASS**：`SCAN_POLL_MS = 3000`（`client.js:30`）、鏈式下一次輪詢（`client.js:595`）。網路序列：進入 Scan tab `GET /scan`(#62) → `POST /scan` 202(#63) → `GET /workspaces`(#64) → `GET /scan`(#65, #66) 之後停止；完成後閒置 12 秒沒有任何 dashboard 請求 |
| Overview 反映 Dashboard 自己的掃描紀錄 | **PASS**：掃描後 Overview 由「尚未由 Dashboard 發起掃描」變成「完成／增量掃描／2026/11/25 20:18:49／423 ms／Scanned 2 · Updated 0 · Removed 0」 |

### 4.2 語言混排觀察（低嚴重度，未修）

Statistics 的「統計範圍」在中文介面下有兩條說明是英文：
`machine-global cache directory (shared by every workspace on this machine)`、
`machine-global BaseMind tool telemetry; not filtered per workspace`。
來源是 Host payload 的硬編字串 `lib/dashboard/service.js:396-397`，client 直接輸出（`client.js` 的
`data.scopes.cache`／`data.scopes.telemetry`），不像另外兩條走自己的字典（`client.js:221`）。
影響：中文介面文案不一致，無功能影響。**修正與否待使用者決定**（本會話未改產品碼）。

## 5. T4：locale 與 theme

| 檢查 | 結果 |
| --- | --- |
| 語言清單 | Settings → General → 語言共 8 種：`中文、English、日本語、Español、Français、Deutsch、Русский、Português`；此 build 預設 `中文`（zh-CN，DSH 殼層為簡體） |
| English | **PASS**：專案選擇器、`Index ready`、`Overview / Scan / Diagnostics / Statistics`、`Tool calls / Estimated tokens saved / Response bytes / Disk usage / Query process peak RSS / Per-tool distribution / Cache components / Scope`、`Last 10 Dashboard scans`、`BaseMind 0.34.0 exposes no scan progress API…` 全部為英文 |
| 中文（zh-CN） | **PASS**：四個 tab 全為中文；本外掛文案是**繁體**（外掛自己的字典與 `locale/zh.json` 一貫如此），與 DSH 殼層的簡體並存但不影響可讀性 |
| 未支援語言（日本語） | **PASS（fallback）**：整頁乾淨回退英文，沒有出現 raw key |
| 主題 | **PASS**：外觀 `浅色／深色／跟随系统`（預設 system → 淺色）。切到 `深色` 後 Overview 以深色背景、可讀文字與可見的 share bar 呈現（截圖已留存於會話附件） |

## 6. T5：停用／重新啟用與 headless

### 6.1 停用（bundle 層開關）

| 觀察點 | 停用後 | 重新啟用後 |
| --- | --- | --- |
| 「包含的組件」區的控件 | `[data-plugin-rows] button` = **0**（配置鈕與組件列開關都消失） | 回到 `配置 BaseMind（工作區感知）`＋組件列開關，狀態 `稼働中` |
| `GET /api/dsh-basemind-dashboard/workspaces`（不帶 cookie） | **401**（路由族不存在，落到 `dsh-client-connection` 自己的請求政策） | **200**，回傳 registry 清單 |

註：交接文件預期 headless／停用時 curl 應為 `404`；實測為 **401**，因為未註冊的 `/api/*` 會落到
`dsh-client-connection` 這個 route owner（它自己做驗證），不是 404。判定方式以「200 vs 401」即可。

### 6.2 重新啟用後的一個狀態（值得記錄）

重新啟用後、在下一次 Agent 會話解析工作區之前，Dashboard 的讀取會回
`503 {"error":"No verified BaseMind binary is selected yet. Open a BaseMind session once so the plugin selects its binary, then retry.","code":"binary-unavailable"}`。
這是 `discoveryRoot: 'agent'` 的既有設計（沒有 Agent 就不選 binary），錯誤訊息本身已指出解法；
不是本次改動造成的回歸。

### 6.3 headless（無 Web server）

| 檢查 | 結果 |
| --- | --- |
| headless profile 也安裝同一 tarball | 完成（`dsh plugin --profile headless add …`） |
| 組合是否含 Web app | **無**：`dsh --profile headless --dump-config` 有 `- id: dsh-basemind`，但沒有任何 `patched by @deepseek-ai/dsh-web-app`；`web` profile 則全部是 web-app patched → headless 組合沒有 `webServer` 服務 |
| 啟動是否正常 | **PASS**：`dsh --profile headless --approval-policy never --json "…"` 走到 `turn_start`／`step_start`，外掛沒有拋錯或阻塞 |
| 完整一輪（含工具清單） | **NOT RUN**：隔離的 DSH_HOME 內沒有 LLM 憑證，於 `step_end` 失敗 `MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"`。把使用者的真實 API key 放進這個環境不在授權內。（2026-11-26 在測試環境補到：工具清單 19 個 `mcp__basemind__*` 有實證；模型回合仍受同一憑證限制） |
| 路由族是否未註冊 | **PASS（結構＋單元）**：`index.js:831-874` 以 `ctx.get('webServer')` 讀取，沒有就 silent return；`test/index.test.mjs` 新增「without a Web server …」用例 |

### 6.4 uninstall

停用（§6.1）已同時驗證 client 半與 Host 路由族的卸載路徑；UI 的 `卸载` 按鈕未按，改以 CLI 移除作為等價
證據：

```text
dsh plugin --profile web remove dsh-basemind-plugin
  → dependencies: - dsh-basemind-plugin 0.2.2
  → profiles/web/package.json 的 dsh.profile.bundles 只剩 [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]
dsh --profile web --dump-config | grep -c dsh-basemind  →  0
```

也就是移除後組合裡完全沒有 `dsh-basemind` row，重新啟動的實例不會再有 Configure 控件或路由族。

## 7. T6／P7：22 次開關循環

| 觀察 | 結果 |
| --- | --- |
| 循環次數 | **22** 次（Dashboard 掛載 → 返回詳情頁 → 再開），由 `evaluate` 以真實 DOM 點擊驅動，逐次確認 `[data-plugin-config]` 掛載 |
| DOM 節點數 | 每次循環後 `document.querySelectorAll('*').length` 都是 **1224**（首末一致，無 DOM 累積） |
| host 子程序 | 前：basemind 6 / node 12 / DeepSeek Harness 18；後：**完全相同** |
| 閒置輪詢 | 循環結束後閒置 12 秒，dashboard 路由 **0** 個新請求（只有一個與本功能無關的 `/api/account/getNotifications`） |
| 每個 effect 的清理 | 程式面：`client.js` 每個 view effect 都回傳 cleanup（abort + `clearTimeout`）；Host 面：路由 disposer 由插件的 effect 持有 |

過程備註（非產品缺陷）：循環要來回經過「套件詳情頁」，該頁會重新抓 README 與 `img.shields.io` 徽章，
渲染偶爾超過 6 秒；放寬等待後即穩定。第一次嘗試在第 11 次、第二次在第 3 次因為等待過短而中止，
第三次改為狀態驅動迴圈後一次完成 8 次。

## 8. T7／M8：index-level wiring 測試

新增 4 條測試於 `test/index.test.mjs`（fake ctx 長出 `inject`、`provide` 與 `webServer`）：

| 測試 | 內容 |
| --- | --- |
| `a Web server mounted before apply registers the Dashboard route family exactly once` | `apply` 直接註冊與 `ctx.inject` 回呼同時發生，仍只有 **5** 條 exact 路由（`/workspaces`、`/overview`、`/diagnostics`、`/statistics`、`/scan`），且沒有落入失敗路徑 |
| `a Web server that arrives after the row mounted still registers the Dashboard once` | 先無 `webServer` → 不註冊；`provide('webServer')` 後才註冊一次；重複 `provide` 不再註冊 |
| `without a Web server the Dashboard registers no route and leaves the agent surfaces intact` | 無 `webServer` 時 0 條路由、工具照常註冊、沒有 warning（靜默降級） |
| `shutdown disposes the Dashboard routes before it terminates the relays` | 關閉時 **5 條路由的 disposer 全部先於** relay 終止執行；關閉後路由表為空。測試需把 version probe 子程序與 `serve` relay 區分開（probe 在 binary manager dispose 時結束） |

驗證：`node --test test/index.test.mjs` → **34 pass / 0 fail**；`npm run check` → `syntax ok: 27 files`、
`bundle manifest ok`。

## 9. P5（30 次 Agent 延遲取樣）：NOT RUN（2026-11-26 已補測）

> 後續：已在官方測試環境以 60 個樣本完成量測，結論與數據見
> `docs/2026-11-26-basemind-dashboard-testenv-acceptance-report.md` §4。以下保留當時未執行的理由。

- 需要 30 輪真實 Agent 會話的延遲取樣，成本最高；交接文件要求「需指定 provider／model 與預算」。
- 本環境**沒有可用的 LLM 憑證**（見 §6.3 的 `MISSING_CREDENTIAL`），把使用者憑證帶進隔離環境不在授權內。
- 因此維持執行報告的 **NOT RUN**，不寫成 PASS。可替代的既有證據：Dashboard 讀取在 Host 端序列化
  （同一時間一個 BaseMind 子程序、佇列上限 4、相同請求合併），且本功能沒有修改任何 Agent 路徑。

## 10. 協定與安全觀察（by design，供使用者知情）

`@deepseek-ai/dsh-host-webserver` 的 README（DSH 0.2.2-rc.5，asar 內）寫明：

> **No server-wide authentication or origin policy** — route owners such as `dsh-client-connection`
> enforce their own request policy. Binding a non-loopback address still exposes unprotected routes
> and static assets to that network.

實測與此一致：

| 請求（不帶 session cookie） | 結果 |
| --- | --- |
| `GET /` 、`GET /api/session/list`、`GET /open-in-app/apps` | 401（`dsh-client-connection` 自己的政策） |
| `GET /api/dsh-basemind-dashboard/workspaces`（外掛註冊） | 200 |
| bundle 停用後同一路徑 | 401（回到 owner 的政策） |

外掛自己的防線是 `lib/dashboard/routes.js:20-40` 的 **loopback-only fence**：來源位址、`Host`、
`Sec-Fetch-Site: cross-site`、以及 `Origin` 必須與 `Host` 同源，否則 `403 loopback-only`
（單元測試 `test/dashboard-routes.test.mjs:106`）。因此：

- **不會**因為 Web server 綁到 `0.0.0.0` 而對外暴露（非 loopback peer 一律 403）。
- 殘餘風險：**同機的其他行程**可以讀取 workspace 路徑、索引統計，並可 `POST /scan` 觸發昂貴掃描
  （本機行程信任邊界與 `dsh` CLI 相同）。若之後要收緊，需自行加上與 `dsh-client-connection` 等價的
  請求政策；本會話未改產品碼，交由使用者決定。

## 11. 未執行與剩餘風險

| 項目 | 狀態 / 原因 |
| --- | --- |
| P5 30 次 Agent 延遲取樣 | **2026-11-26 已補測**（60 樣本；見 2026-11-26 測試環境報告 §4） |
| headless 完整會話與工具清單 | **2026-11-26 已補**：工具清單有實證（19 個 `mcp__basemind__*`），模型回合仍 **NOT RUN**（憑證只對 Desktop 進程可用） |
| 實機「未知值 / notice / 0 檔語言」 | 實機工作區是已索引狀態，這三條以單元測試為證據（§4.1） |
| UI `卸载` 按鈕 | 未按；以 CLI `plugin remove` 作等價證據：profile 依賴與 `dsh.profile.bundles` 均移除，`--dump-config` 的 `dsh-basemind` 筆數為 0（§6.4） |
| 遠端 CI | 需要 push，不在授權內 |
| 真實桌面包（Electron 桌面 profile） | 依規則不碰；本報告是「同一 DSH build 的 Web GUI＋隔離 profile」驗收 |

## 12. 收尾（可重現指令）

```bash
# 移除隔離環境（含 .credentials.yaml、tarball、cookies）
rm -rf "C:/Users/sanny/AppData/Local/Temp/dsh-acc022"
# 停掉本會話啟動的 Web 實例與瀏覽器 session
job_kill <web-job-id>; bsk_session stop
```

repo 內不得留下任何臨時檔（`git status` 只應有版本修改與文件）。
