# dsh-basemind-plugin 審查後修正報告

- 日期：2026-10-29
- 對象：`D:\02_zengjunlin\github\dsh-basemind-plugin`
- 基準：repo 尚無 commit（全部交付檔案為 staged/untracked），本報告以工作區現況界定範圍
- 來源：審查結論的 5 個 Important（test isolation、Web audit 引用、failure paths、憑證、報告一致性）
- 對應主報告：`docs/2026-10-29-dsh-basemind-plugin-execution-report.md`
- Git：**未執行** `git commit` / `git push`；所有改動待使用者審查後自行提交

---

## 1. 結果摘要

| # | 審查項目 | 狀態 | 主要證據 |
|---|---|---|---|
| 1 | `node --test` 洩漏預設 BaseMind cache | **已修復並驗證** | integration suite 使用 test-only `BASEMIND_DATA_HOME` / `BASEMIND_COMMS_DIR`；重跑後 registry 54,053 B、mtime 不變，預設 cache 目錄數不變 |
| 2 | Web real-model 證據引用 Desktop audit | **已修復** | 分開產生 `real-session-audit-web.json`（44 tools / 9）與 `real-session-audit-desktop.json`（45 tools / 9）；Web audit 加入 `list_mcp_resources` 與兩個 `basemind://` URI |
| 3 | failure paths 未在官方 surface 執行 | **已補做（官方 Web）** | missing → 0 個 BaseMind tools、DSH 正常 3 回合、有 warning；collision → 插件 registration inactive（row 仍 active）、只有既有 MCP row 的 2 個工具、原 row 呼叫成功 |
| 4 | 測試憑證留在 `.env.local` | **檔案已刪除；輪換待使用者** | `DSH_TEST\.env.local` 已不存在；logs/evidence/scratch/config 掃描 `sk-…` → 0 個檔案 |
| 5 | execution report 矛盾與過時數字 | **已修正** | §3.3 移除「官方 source 未執行」、§8 改 149、移除易過時檔案大小、Web/Desktop audit 引用分離 |
| 額外 | `readVersion` 的 `--version` probe 遺失 `this` | **已修復** | `ctx.subprocess.spawn.bind(ctx.subprocess)`；回歸測試斷言 receiver |

- 測試：`node --test` → **149 tests / 149 pass / 0 fail**（約 8 s；最近一次 7814 ms）。
- 已刪除的預設 cache：`56d019bb…`（**67,271,674 B**），只刪該目錄；registry 未刪未改。
- 正式驗收判斷：5 個 Important 的收尾項已關閉；仍需使用者動作的是 **API key 輪換**（本 Agent 無法在 provider 端代為輪換）。Desktop failure paths 未單獨重跑，列為已知限制（見 §9）。

---

## 2. 項目 1：integration test 的 BaseMind 隔離

### 根因

`test/integration.test.mjs` 以 `resolveConfig({})` 啟動 relay，spawn 出的 `basemind serve` 繼承 process env。沒有 `BASEMIND_DATA_HOME` / `BASEMIND_COMMS_DIR` 時，relay 連到使用者全域 daemon，並把臨時 `%TEMP%\basemind-int-*` workspace 寫進預設 cache 與 registry。

### 修正

檔案：`test/integration.test.mjs`

- 模組載入時建立 `%TEMP%\basemind-test-*`，設定：
  - `BASEMIND_DATA_HOME=<root>\data`
  - `BASEMIND_COMMS_DIR=<root>\comms`
- 明確覆寫繼承值：test run 不依賴、也不修改呼叫者既有的 data home。
- `after` hook：
  1. `basemind comms stop`（Windows 走 `cmd.exe /d /s /c`），只停止 `BASEMIND_COMMS_DIR` 指向的測試 daemon；
  2. 等待 500 ms；
  3. `removeDirectory()` 重試刪除 test data home；
  4. 失敗時 `process.emitWarning`，不以 teardown 失敗掩蓋測試結果。
- `process.on('exit')` 保留同步 `rmSync` 作為最後手段。
- 檔頭註解記錄「relay 會連到 machine-global daemon」與隔離原因。

### 為什麼需要 `comms stop`

第一次修復後，`node --test` 雖然 149/149 通過，但 test worker 懸置約 6 分鐘：`basemind serve` 啟動的 daemon 會繼承 relay 的 stdio，relay 結束後 daemon 仍持有 pipe，Node 的事件迴圈因此不退出。加入 `basemind comms stop` 後：

- `node --test`：約 8 s 結束；
- 無 `basemind-test-*` 目錄殘留；
- 無 3 分鐘內新啟動的 `comms daemon`；
- 使用者既有 daemon（11:11 起的 process）未受影響。

### 驗證

```text
$ node --test
ℹ tests 149
ℹ pass 149
ℹ fail 0
ℹ duration_ms 7813.7622

BEFORE reg=54053 mtime=2026-10-29T14:16:28.4014513+08:00 cacheDirs=21
AFTER  reg=54053 mtime=2026-10-29T14:16:28.4014513+08:00 cacheDirs=21
REG_CHANGED=False
CACHE_CHANGED=False
```

- `%TEMP%\basemind-test-*`：無殘留。
- 測試 daemon：無殘留。
- 之後才刪除審查發現的 `56d019bb…`；刪除前後 registry size/mtime 完全相同（54,053 B / `14:16:28`）。

---

## 3. 項目 2：Web / Desktop session audit 分離

### 修正

- 擴充 `DSH_TEST\scratch\real-session-audit.mjs`：
  - 輸出檔名可指定（第 5 個參數）；
  - 記錄 `list_mcp_resources` / `read_mcp_resource` 的呼叫與參數；
  - 從 `tool/result` 擷取 `basemind://…` URI；
  - 記錄每個 `request/header` 的 tool 數（`headerToolCounts`），top-level 使用**最後一個** header，避免「第一個回合尚未註冊插件」被誤讀。
- 產生兩個獨立檔案：
  - `evidence\real-session-audit-web.json`
  - `evidence\real-session-audit-desktop.json`
- 刪除原本容易誤用的 `evidence\real-session-audit.json`（只含 Desktop session）。

### Web 證據（`real-session-audit-web.json`）

| Session | tools | BaseMind tools | resources |
|---|---:|---:|---|
| `session-f7d0…` | 44 | 9 | `list_mcp_resources {server:'basemind'}` → `basemind://status`、`basemind://repo/map` |
| `session-8bfa…` | 44 | 9 | — |
| `session-48a0…` | 44 | 9 | — |

- `session-f7d0…` 的 `resourceCalls` 與 `resourceUris` 直接寫入 audit，不再只靠截圖。
- 報告引用已改為 `real-session-audit-web.json`；Desktop 報告改為 `real-session-audit-desktop.json`。

### Desktop 證據（`real-session-audit-desktop.json`）

| Session | tools | BaseMind tools |
|---|---:|---:|
| `session-5781…` | 45 | 9 |
| `session-80dd…` | 45 | 9 |
| `session-f38e…` | 45 | 9 |

Desktop 的 45 = Web 的 44 + `load_workspace_dependencies`（Desktop runtime 工具，非 BaseMind）。

---

## 4. 項目 3：官方 surface failure paths

### 測試環境

- 全新 `DSH_HOME`：`D:\02_zengjunlin\DSH_TEST\dsh-home-failure`（未動既有 `dsh-home-web` / Desktop dev home）。
- 插件以官方 `dsh plugin --profile web add` 安裝到該 profile。
- mock LLM：官方 `@deepseek-ai/dsh-mcp-server` test-support，`DEEPSEEK_BASE_URL` 指向它；**不使用真實 API key**。
- 隔離：每個 case 使用自己的 `BASEMIND_DATA_HOME` / `BASEMIND_COMMS_DIR`。
- warning 可觀測性：DSH 預設 cordis logger 只緩衝 warning、不輸出 stdout，且只在啟動失敗時才把 buffer 放進 diagnostic。測試 profile 額外 insert 一個 test-only `failure-log-observer.mjs`，只把 `[dsh-basemind-plugin]` 訊息鏡射到 stderr；被測插件未修改。

### 執行方式

`DSH_TEST\scratch\failure-web-driver.mjs`：

1. 啟動 mock LLM 與官方 `dsh web --patch <case>.yml --no-open --port 0`；
2. 用 launch token 換 cookie，呼叫 `/api/workspace/create`、`/api/session/create`；
3. 送第一個 prompt（觸發 `agent/created` 與插件 discovery）；
4. 等待預期的 plugin warning；
5. 送第二個 prompt，讀取第二回合的 tools（第一回合的 tool list 在插件註冊前就已組好，不能當穩定證據）；
6. 收集 plugin row 狀態、tools、mock behaviors，寫入 evidence；
7. 以 PID `taskkill /T /F` 停止 host tree，關閉 mock。

### 結果

| Case | Plugin row | 第二回合 tools | BaseMind tools | Warning | 結論 |
|---|---|---|---:|---:|---|---|
| control（真實 `basemind`） | active | 44 | 9 | —（`BaseMind launcher reports 0.29.3`） | 同一 profile 會載入插件 |
| missing（`command` 指向不存在路徑） | active | 32 | **0** | `BaseMind startup failed … is not an executable file` | DSH 正常完成 3 個 mock 回合；插件不註冊工具 |
| collision（既有 `serverName: basemind` MCP row） | active（registration inactive） | 37 | **2**（`admin`、`code`） | `… staying inactive to avoid duplicate tools` | 不重複註冊；既有 row 的 `mcp__basemind__admin` 回 `isError: false` |

- collision 的既有 MCP row 是 `fixtures/fake-mcp-server.mjs`，只廣告 `code`、`admin`；若插件也註冊，第二回合會出現 11 個 BaseMind tools，實際只有 2 個。
- 完整證據：`evidence\failure-{control,missing,collision}.json`、`logs\failure-{control,missing,collision}.log`、`evidence\failure-session-audit.json`、`evidence\failure-paths-2026-10-29.md`。
- **限制**：Desktop dev 未單獨重跑。Web/Desktop 共用同一個 host plugin 載入路徑；若需要 Desktop 的直接證據，套用同一 overlay 到一個可丟棄的 Desktop profile 即可，不影響本次 Web 的結論。

---

## 5. 項目 4：憑證衛生

- 刪除 `D:\02_zengjunlin\DSH_TEST\.env.local`（43 B，單行 `API_KEY=…`）。
- 掃描 `DSH_TEST\logs`、`evidence`、`scratch`、`dsh-home-web`、`dsh-home-failure`、插件 repo：`sk-[A-Za-z0-9]{20,}` → **0 個檔案**。
- 該 key 曾出現在對話與 `.env.local`，因此**視為已暴露**。
- **輪換仍待使用者執行**：本 Agent 無法在 DeepSeek provider 端代為輪換；請在 console 產生新 key，舊 key 撤銷。
- 文件已改寫為「key 僅在 `.env.local` 短期存在，檔案已刪除；輪換待使用者」，不再聲稱「未寫入任何檔案」。

---

## 6. 項目 5：報告一致性

`docs/2026-10-29-dsh-basemind-plugin-execution-report.md`：

- §1：測試改 149；新增官方 surface failure paths、cache 清理、審查後修正的狀態列。
- §2：移除「大小」欄，避免檔案大小快速過時。
- §3.3：刪除「官方 source 沒有執行」的矛盾宣告，改為「本節是 installed Desktop profile；官方 source 見 §6.1」。
- §6.1：Web 的 failure paths 由「未執行」改為「已完成」；Desktop 明確標示未單獨重跑。
- §6.2：A6/A8 由「只以單元測試」改為官方 Web 已驗證。
- §6.3：更新 cache/registry/credential/process 數字；新增 §6.4 failure paths。
- §7：加入 test data home 與 test daemon 清理。
- §8：`144` → `149`，註明 integration 自帶隔離。
- §9：加入 key 輪換、Desktop failure paths、`readVersion` 的殘餘風險。

`DSH_TEST\evidence\real-model-web.md`：

- audit 引用改為 `real-session-audit-web.json`；
- 補上 `list_mcp_resources` / resource URI 的 audit 證據；
- §5 failure paths 由「未執行」改為「已在官方 Web 完成」；
- 憑證敘述改為「`.env.local` 已刪除；輪換待使用者」。

`DSH_TEST\evidence\real-model-desktop.md`、`environment.md`、`runbook.md`、`cache-cleanup-2026-10-29.md`：

- audit 引用分離；
- `node --test` 洩漏段落改為「已修復」；
- `56d019bb…` 已刪除、registry 未變；
- 憑證檔已刪除、輪換待使用者。

---

## 7. 額外修正：`readVersion` 的 `spawn` receiver

### 發現

failure-path control 與 collision 的 log 出現與案例無關的 warning：

```text
basemind: '--version' probe failed: Cannot read properties of undefined (reading 'selectContainmentMode')
```

### 根因

`lib/executable.js` 的 `readVersion`：

```js
const spawn = ctx?.subprocess?.spawn;
handle = spawn({ ... });
```

把方法拆下來後以裸函式呼叫，`this` 變成 `undefined`；`subprocess-local` 的 `spawn()` 內部呼叫 `this.selectContainmentMode()` 時失敗。這只影響診斷 probe，不影響 relay（relay 以 `ctx.subprocess.spawn(spec)` 呼叫）。

### 修正

```js
const spawn = typeof ctx?.subprocess?.spawn === 'function'
  ? ctx.subprocess.spawn.bind(ctx.subprocess)
  : undefined;
```

`test/executable.test.mjs` 的 `createVersionCtx()` 記錄 `spawn` 的 receiver，第一個 `readVersion` 測試斷言 `calls.receiver === ctx.subprocess`。

### 驗證

```text
$ node test/executable.test.mjs
ℹ tests 26
ℹ pass 26
ℹ fail 0
```

failure-path 重跑後，control 只剩 `BaseMind launcher reports 0.29.3`，不再有 probe warning。

---

## 8. 修改檔案

| 檔案 | 變更 |
|---|---|
| `test/integration.test.mjs` | test-only BaseMind data home、繼承值覆寫、`after` 停止 test daemon、移除 data home、exit fallback |
| `test/executable.test.mjs` | `spawn` receiver 回歸斷言 |
| `lib/executable.js` | `readVersion` 綁定 `ctx.subprocess` 作為 receiver |
| `docs/2026-10-29-dsh-basemind-plugin-execution-report.md` | 一致性修正與 §6.4 |
| `docs/2026-10-29-dsh-basemind-plugin-review-fix-report.md` | 本報告 |
| `DSH_TEST\scratch\real-session-audit.mjs` | 分檔、resource calls/URIs、per-header counts |
| `DSH_TEST\scratch\failure-web-driver.mjs` | 官方 Web failure-path driver |
| `DSH_TEST\scratch\failure-{control,missing,collision}.yml` | 可丟棄 profile overlays |
| `DSH_TEST\scratch\failure-log-observer.mjs` | test-only warning → stderr |
| `DSH_TEST\evidence\real-session-audit-{web,desktop}.json` | 分離後的 session audit |
| `DSH_TEST\evidence\failure-{control,missing,collision}.json` | failure-path 摘要 |
| `DSH_TEST\evidence\failure-session-audit.json` | failure-path session 稽核 |
| `DSH_TEST\evidence\failure-paths-2026-10-29.md` | failure-path 證據文件 |
| `DSH_TEST\evidence\real-model-{web,desktop}.md`、`environment.md`、`cache-cleanup-2026-10-29.md`、`runbook.md` | 引用、數字、憑證敘述更新 |

---

## 9. 未完成 / 剩餘風險

1. **API key 輪換**：使用者在 provider 端執行；本 Agent 無法代為完成。
2. **Desktop failure paths 未單獨重跑**：官方 Web 已驗證；Desktop 的直接證據仍缺一角。
3. **BaseMind 0.30 / 0.31 未實測**：與本次審查修正無關，維持原報告的殘餘風險。
4. **未提交 git**：所有改動待使用者審查後自行 commit。
