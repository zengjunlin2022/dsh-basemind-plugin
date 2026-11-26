# 交接：Dashboard 自動化驗收與收尾（新對話接手用）

日期：2026-11-25　交接者：lead（原會話）　接手者：新對話的 Agent

> **狀態（2026-11-25 晚，接手會話更新）**：T1–T7、T9、T10 已完成，T8（P5）維持 **NOT RUN**。
> 驗收結果見 `docs/2026-11-25-basemind-dashboard-desktop-acceptance-report.md`。
> 下面 §3 的阻塞點結論已被推翻：Configure 控件存在，位於「套件詳情頁 → 包含的組件」，
> 不是「已安裝插件」清單列（證據與可重現步驟見驗收報告 §2）。本文件其餘內容保留為原始交接紀錄。

## 0. 任務目標（已授權）

在 commit `ff70644` 之上，把 BaseMind Dashboard 剩下的「可自動化」工作做完，並把結果回填文件。
使用者已明確授權：版本 **0.2.2**、所有環境操作（隔離 profile、第二個 DSH web 實例、瀏覽器自動化、npm pack、掃描、M8 測試、文件回填）。

**仍然禁止**：`git commit`／`--amend`／`push`（全域規則 critical）；碰 `~/.dsh/profiles/desktop` 或正在運行的桌面實例；把憑證或 token 寫進 repo／log。

## 1. 目前基線

| 項目 | 值 |
| --- | --- |
| HEAD | `ff70644 feat(dashboard): 添加 BaseMind 可选 Dashboard 页面功能`（已含全部 Dashboard 程式、測試、7 份 docs） |
| 工作區未提交 | 只有 4 個檔案：`package.json`（0.2.1→0.2.2）、`CHANGELOG.md`（`[Unreleased]`→`[0.2.2] - 2026-11-25`）、`README.md`／`README.zh.md`（status 範例版本字串） |
| 前次審查結論 | 兩輪 scoped re-review 後 `All findings addressed, no new Critical/Important breakage` |
| 尚未關閉的驗收 | 真實 UI 驗收、P7、P5、M8、遠端 CI（CI 需使用者 push，不在本交接範圍） |

## 2. 已完成並有證據

1. **版本升到 0.2.2**（未提交）：`package.json:3`、`CHANGELOG.md:7`、兩個 README 的 `BaseMind status - dsh-basemind-plugin 0.2.2` 範例。
2. **隔離環境已建好**：`DSH_HOME=C:\Users\sanny\AppData\Local\Temp\dsh-acc022`，`web` profile 由 shipped 模板自動建立，外掛由 `dsh-basemind-plugin-0.2.2.tgz`（59 檔、187 KB）安裝，`dsh.profile.bundles` 自動加入 `dsh-basemind-plugin`。
3. **隔離 web 實例曾啟動，但交接時已結束**：job `bash-1fc6fdc612ec4be6` 以 exit `4294967295` 收尾，`127.0.0.1:57030` 目前無回應。接手第一件事是照 §4 重啟並取得新的 token URL（舊 token 來自已結束的 job，**不要貼進 repo**）。
4. **Host 半已用真實 HTTP 驗證**：
   - `GET /api/dsh-basemind-dashboard/workspaces` → `200 {"source":"workspace-registry","items":[]}`
   - `GET /api/dsh-basemind-dashboard/overview?workspace=x` → `400 unknown-workspace`（路由與 fence 都活著）
5. **Client 半已載入**：boot payload 有 `dsh-basemind-plugin/client.js`（`inject: ["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-plugin-manager"]`），`/plugins/??dsh-basemind-plugin/client.js&rev=…` 回 200、56,681 B。
6. **瀏覽器曾可用**：bsk session `lusd`（browserInstanceId `65a60c40`）曾開到隔離實例的 Plugins 頁；但該實例已結束，頁面現在是斷線狀態，重啟後直接 navigate 到新 token URL 即可。

## 3. 阻塞點（接手第一件事）

**Plugins 頁上 BaseMind 那一列沒有「配置」控件，Dashboard 因此不可達。** 這正是 UI 驗收要抓的東西。

已確認：
- Plugins 頁「已安装插件」有 BaseMind 列，控件只有 `查看 BaseMind（工作區感知）`、`卸载`、`启用/停用` 開關；頁面 VOM 46,467 字元內 **零** 個 `配置`／`Configure`。
- 插件管理器（served bundle `pm.js`）的判定是 `configure(pkg)=>({has:row=>ledger.rows.has(rowConfigKey(pkg.name,row.rowId))})`，`rowConfigKey=(bundle,rowId)=>`${bundle}#${rowId}``，`ledger.rows=keysOf('plugins.row.config')`（來自 `ctx.slots.entries(...).options.key`）。
- 我們的 client（`lib/dashboard/client.js:1017-1030`）以 `key: 'dsh-basemind-plugin#dsh-basemind'` 註冊，composed patch 的 row 正是 `id: dsh-basemind, name: dsh-basemind-plugin`（`dsh --profile web --dump-config` 已核對）。
- `ctx.effect(() => ctx.locale.register(NS, {zh,en}), label)` 與 `ctx.slots.inject(name, () => ctx.slots.register({name,key,locale}, C))` 都是插件管理器自己在用的同一種寫法；`ctx.slots.inject` 確實存在。

未排除的假設（依序測）：
1. **H1：`apply` 根本沒被呼叫**（module loader 靜默跳過）。目前無法從外觀分辨，且 `client.js:1026` 的 `catch { return () => {} }` 會吞掉註冊錯誤。
2. **H2：`row.rowId` 不是 `dsh-basemind`**（例如帶 bundle 前綴或是 entryId），導致 key 對不上。需讀 host inventory 的 row 清單。
3. **H3：`ctx.slots.inject('plugins.row.config', …)` 從未觸發**（slot 由插件管理器 main 註冊時才宣告）。
4. **H4：註冊參數不合**（例如需要 `id` 或 `order`，或 `key` 應為 row 的另一個識別）。

建議的最快判定法（暫時性、必須還原）：在 `exports.apply` 第一行寫 `window.__BM_DIAG__ = { apply: true, effect: typeof ctx.effect, slots: typeof ctx.slots, inject: typeof ctx.slots?.inject }`，並在 inject 回呼、register 前後、catch 內補寫 `fired` / `registered` / `err`；`npm pack` → 用同一 profile 重裝 → 重新載入頁面 → `bsk_interact evaluate` 讀 `window.__BM_DIAG__`；判定完 **立刻還原** 這個檔案。

若確認是產品缺陷：修最小範圍（可能是 key 對不上或 apply 沒跑），補一條能在 pre-fix 失敗的測試，再走一次 scoped re-review（review 不改產品碼）。

## 4. 隔離環境操作手冊

```bash
# 重啟（若舊 job 已死；先把 DSH_WEB_URL 等清掉，否則 token 交換 401）
unset DSH_WEB_URL DSH_PROFILE_DIR DSH_PROFILE DSH_SESSION_ID
export DSH_HOME=C:/Users/sanny/AppData/Local/Temp/dsh-acc022
export BASEMIND_BIN=C:/Users/sanny/.dsh/cache/dsh-basemind-plugin/managed-binaries/0.34.0/windows-x64/basemind.exe
export BASEMIND_DATA_HOME=$DSH_HOME/bmdata BASEMIND_COMMS_DIR=$DSH_HOME/bmcomms
"C:/Users/sanny/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd" web --no-open --port 0
# 讀 job 輸出拿 token URL；curl 時帶 $DSH_HOME/cookies.txt（先用 ?token= 換 cookie，303+Set-Cookie 才算成功）

# 重新打包／重裝（改過程式碼後）
npm pack --pack-destination "$DSH_HOME"
DSH_HOME=$DSH_HOME "…/dsh.cmd" plugin --profile web add "$DSH_HOME/dsh-basemind-plugin-0.2.2.tgz" --save-exact
```

注意：`$DSH_HOME` 內已有 `.credentials.yaml`（隔離實例登入了使用者帳號），**收尾必須整個目錄刪除**，且任何時候都不要把內容印出來或貼進 repo。

## 5. 待辦（依序）

### T1（阻塞）確認 Configure 控件為何不存在
- 完成條件：明確證明是「產品缺陷」還是「我們的註冊方式錯」，並附 `file:line` 與可重現步驟。
- 若缺陷：修 + 回歸測試 + scoped re-review。

### T2 讓隔離實例有一個真實 workspace
- 目前 `items: []`。用 UI 的 `添加工作区`（VOM `@e12`）指向一個**小型測試 repo**（建議在 `$DSH_HOME/ws1` 建 3 檔＋`git init`＋commit），或研究 `$DSH_HOME/storages/workspace.json` 後手動加一筆（格式為 domain data：`unit`/`global.workspaceIds`…，風險較高，優先用 UI）。
- 完成條件：`GET /api/dsh-basemind-dashboard/workspaces` 回 `items` 至少 1 筆。

### T3 UI 驗收（四個 tab）
- Overview／Scan／Diagnostics／Statistics 各自載入；驗「未知值顯示不可用而非 0」、語言 share 只在 `file_count>0` 時出現、notice 原文、歷史 10 筆、3 秒輪詢只在下單後出現。
- 用 `bsk_*`：`sync` → 取 `context_id`／`observation_id`（**snake_case**）→ `click`；`evaluate` 需帶同一次 sync 的 top-level `observation_id`。
- 完成條件：四個 tab 都有截圖或 VOM 證據；任何 FAIL 需 `file:line`。

### T4 locale 與 theme
- 語言切成 English（設定頁）確認四 tab 文案；主題深／淺各看一次。
- 完成條件：至少 zh、en 各一輪，記錄實際語言清單（此 build 預設 zh-CN）。

### T5 disable／uninstall 與 headless
- 停用 bundle：Configure 控件與頁面消失；重新啟用後回來。
- headless：用 `headless` profile 起一次（同一 DSH_HOME 或另一個），確認 `dsh-basemind-dashboard` 路由不存在（curl 應 404）、工具與 skills 仍正常。

### T6 P7：20 次開關循環
- 在 UI 裡開／關 Dashboard 20 次，確認沒有 timer／listener／child 累積（可用 `bsk_inspect network` 看輪詢是否停止、`Get-Process node` 前後計數）。

### T7 M8：index-level wiring 測試
- 新增（或擴充 `test/index.test.mjs`）「webServer 經 `ctx.inject` 晚到時註冊一次」「無 webServer 不註冊」「shutdown 先 dispose service 再終止 relay」三例；fake ctx 需長出 `inject`、`webServer`、`workspaceRegistry`。
- 驗證：`node --test test/index.test.mjs`、`npm run check`。

### T8 P5：30 次 Agent 延遲取樣
- 成本最高。repo 內 `benchmark/` 有可複用的 Web API harness（dev tooling，不在 npm files）。需指定 provider/model 與預算；若不做，必須在文件標明 NOT RUN，不可寫成 PASS。

### T9 文件回填
- `CHANGELOG.md` §Notes 目前寫「real Desktop UI acceptance … NOT RUN」，驗收後改成實際結果。
- `docs/2026-11-25-basemind-dashboard-execution-report.md` §4／§50 的 PARTIAL/NOT RUN 改成 PASS 或 FAIL，附證據與日期。
- 新增一份 `docs/2026-11-25-basemind-dashboard-desktop-acceptance-report.md` 記錄步驟與結果。

### T10 收尾
- 舊 job `bash-1fc6fdc612ec4be6` 已自行結束，無需 kill；重啟後的新 job 才需要。`bsk_session stop`（session `lusd`）仍要收。
- 刪除 `C:/Users/sanny/AppData/Local/Temp/dsh-acc022`（含 `.credentials.yaml`、tgz、cookies）。
- `git status` 應只剩 T9 的文件與 4 個版本修改；不得有 temp 檔進 repo。

## 6. 關鍵檔案

| 檔案 | 用途 |
| --- | --- |
| `lib/dashboard/client.js` | 瀏覽器半；`ROW_KEY`／`exports.apply` 在 `:26`／`:1017-1030` |
| `lib/dashboard/routes.js` | 六 operation／五條 exact 路由、註冊回滾 |
| `index.js` | `registerDashboard()` `:831-874`、`ctx.inject` `:946-953` |
| `lib/dashboard/service.js` | limiter、掃描狀態機、epoch 快取 |
| `test/dashboard-client.test.mjs` | 假 React（hook 邊界）與元素化渲染 |
| `docs/2026-11-25-basemind-dashboard-*.md` | 計劃、執行、自我審查、獨立審查、修復、兩輪 scoped re-review |

## 7. 新對話開場建議

1. 先 `git log --oneline -2` 與 `git status` 確認仍在 `ff70644`、只有 4 個版本修改。
2. `curl` 一次 `http://127.0.0.1:57030/api/dsh-basemind-dashboard/workspaces`；若不通就照 §4 重啟。
3. 從 **T1** 開始；沒有 T1 的結論，T3–T5 的 PASS/FAIL 都不能算數。
