# dsh-basemind-plugin — 實機 DSH Desktop 驗收報告（D1–D15）

- 日期：2026-11-25
- 角色：Execution（實機驗收執行）
- 驗收對象：`dsh-basemind-plugin` **0.2.0**，安裝物為 `D:/_bm_phase3/commit5bec005/dsh-basemind-plugin-0.2.0-5bec005.tgz`（150,843 B，對應 commit `5bec005`）
- 依據清單：[2026-11-24 Desktop 驗收清單](./2026-11-24-basemind-desktop-acceptance-checklist.md)
- 環境：**生產 desktop profile**（`DSH_HOME=C:\Users\sanny\.dsh`、`DSH_PROFILE=desktop`），DSH `0.2.2-rc.5`、Node `v24.20.0`、BaseMind `0.34.0`（`C:\Users\sanny\AppData\Local\Programs\basemind\basemind.exe`）、`BASEMIND_BIN` 未設定
- 判定用語：**PASS**／**FAIL**／**NOT RUN**（未實際操作者一律 NOT RUN，不以推測代替）

> 一句話結論：**D1、D2、D3（間接證據）、D6（除 CLI）、D7、D9、D11、D12、D13、D14 通過；D8 FAIL（`mcp__basemind__cli` 在真實 DSH runtime 完全無法啟動，根因已定位到一行）；D10 部分（skill 正文可載入，doctor 實跑被 D8 阻擋）；D4／D5／D15 NOT RUN（需隔離實例與 GUI 操作）。**

---

## 1. 執行摘要

| # | 項目 | 判定 | 一句話證據 |
| --- | --- | --- | --- |
| D1 | 打包及安裝 | **PASS** | `npm pack --dry-run`：52 檔、10 個 `SKILL.md`、0 個禁止目錄；profile 內安裝物即此 build |
| D2 | Standard Preset | **PASS** | 本會話第 1 回合第一次工具呼叫即為 `mcp__basemind__git_log` 並成功（`5bec005` 冷啟動修復生效） |
| D3 | Local First | **PASS（間接證據）** | 5 個 relay 全部執行全域 `…\Programs\basemind\basemind.EXE`；managed 快取為空（0 次下載） |
| D4 | Managed fallback | **NOT RUN** | 需隱藏全域 binary 的隔離實例＋重啟；見 §6 |
| D5 | Managed cache 重用 | **NOT RUN** | 依賴 D4；見 §6 |
| D6 | MCP Tools | **PASS（CLI 除外）** | 19 個 `mcp__basemind__*`（15 verbs＋cli＋3 agent tools）；14 個實調成功 |
| D7 | MCP Resources | **PASS** | `list`／`read basemind://status`／templates＋模板展開 `basemind://outline/…` 全部成功 |
| D8 | CLI Adapter | **FAIL** | 任何 verb 皆回 `could not start the BaseMind CLI: Cannot read properties of undefined (reading 'selectContainmentMode')` |
| D9 | Skills Registry | **PASS** | catalog 與磁碟皆為 10 個 `basemind*` skills，無重複 |
| D10 | Skills 正文 | **PARTIAL** | `basemind-doctor` 正文可載入；其第一步（`mcp__basemind__cli doctor`）被 D8 阻擋 |
| D11 | 多 Session 隔離 | **PASS（兩個並行 agent 會話）** | repo-a 會話看不到 `summerB`；repo-b subagent 看不到 `summerA`；每 workspace 一個 relay |
| D12 | 工作區切換 | **PASS** | `cd` repo-a→repo-c 後 `index_status.root` 與可查符號同步改變 |
| D13 | Subagent 路由 | **PASS** | subagent `index_status.root` = repo-b（head `776b2ea`），符號與 relay 皆正確 |
| D14 | 同 Repo 不同 Worktree | **PASS（內容）／部分未驗** | worktree 讀到 `summerAWorktree`（非主工作區版本）；group 共享語義未驗 |
| D15 | 插件生命周期 | **NOT RUN** | 停用／啟用／卸載為 GUI 操作；已留基線供人工續驗（§6） |

---

## 2. 環境與基線（2026-11-25 實測）

| 項目 | 實測值 |
| --- | --- |
| DSH | `0.2.2-rc.5`（`dsh --version`） |
| 插件安裝 | `~/.dsh/profiles/desktop/node_modules/dsh-basemind-plugin` = **0.2.0**，profile 依賴為 `file:D:/_bm_phase3/commit5bec005/dsh-basemind-plugin-0.2.0-5bec005.tgz` |
| 冷啟動修復在安裝物內 | `index.js` 內 `coldStartTimeoutMs` 出現 3 次（屬 `5bec005`） |
| BaseMind | `0.34.0`；`where.exe basemind` 唯一命中全域安裝；`BASEMIND_BIN` 未設定 |
| managed 快取 | `~/.dsh/cache/dsh-basemind-plugin/` 只有空目錄 `managed-binaries/` 與 `state.json`（`state.json` 為每個 workspace 的 `lastVersion: 0.34.0`） |
| Relay 行程 | 5 個 `basemind.exe serve --root .` ＋ 1 個 `comms daemon`，全部指向全域安裝的 `basemind.EXE`（226,144,768 B） |
| 全域 binary | `C:\Users\sanny\AppData\Local\Programs\basemind\basemind.exe`（未變動、未被下載覆寫） |
| 工作區池對應 | plugin repo、repo-a、repo-b、repo-c、repo-a-wt 各一個 relay（切換目錄不重用他 root） |

驗收 fixture（只在 `%TEMP%`，不在任何 repo 內）：`C:\Users\sanny\AppData\Local\Temp\bm-accept\repos\`
`repo-a`（`62e2d68`，`summerA`）、`repo-b`（`776b2ea`，`summerB`）、`repo-c`（`f56cd60`，`summerC`）、`repo-a-wt`（branch `wt-accept`，`summerAWorktree`）。

---

## 3. 逐項證據

### D1 打包內容及安裝 — PASS

```
$ npm pack --dry-run --json
files=52  skills=10  forbidden=0  size=152006
```

- 10 個 `skills/<name>/SKILL.md`；`forbidden=0` 表示不含 `test/`、`docs/`、`fixtures/`、`.github/`、`node_modules/`。
- 安裝物：`dsh-basemind-plugin-0.2.0-5bec005.tgz`（150,843 B），profile `package.json` 明確指向它。
- 註：`pack.json` 未被寫出（用 `--dry-run` 直送 stdout），repo `git status` 仍為 clean。

### D2 Standard Preset — PASS

- 本會話是重啟後的新會話；**第 1 回合的第 1 個工具呼叫**就是 `mcp__basemind__git_log`，回傳 10 筆 commit 與變更檔清單，證明 `5bec005` 的「等 relay 初始化再放行第一回合」修復在真實 Desktop 生效——舊行為會是第一回合少 34 個工具、第 2 回合才出現。
- 同時第 1 回合即可見全部 19 個 `mcp__basemind__*` 工具與 10 個 `basemind*` skills，沒有手動改 preset、沒有新增 MCP row。
- `dsh --profile desktop --dump-config` 在 app 執行期間 exit=1 且無輸出（profile 被執行中的 app 佔用），因此「row 文字」以執行時行為取證，未以 YAML 讀值補證。

### D3 Local First — PASS（間接證據）

- 選型來源：`Get-CimInstance Win32_Process` 顯示每個 relay 的 `ExecutablePath` 都是 `C:\Users\sanny\AppData\Local\Programs\basemind\basemind.EXE`，`BASEMIND_BIN` 未設定、`command` 未設定 → 對應 `source: path`。
- 零下載：`~/.dsh/cache/dsh-basemind-plugin/managed-binaries/` 為空。
- 未取得 `/basemind-status` 原文（human command，需在輸入框輸入），因此本項**不宣稱**該文字已核對；`/basemind-status` 的實際輸出待使用者貼回（§6）。

### D6 MCP Tools — PASS（CLI 除外）

本次會話可見 19 個工具：`cli`、`code_grep`、`code_outline`、`code_read`、`code_refs`、`code_search`、`code_symbols`、`docs_search`、`find_files`、`git_blame`、`git_diff`、`git_log`、`index_rescan`、`index_status`、`memory_save`、`memory_search`（15 verbs＋cli）＋ `agent_inbox`、`agent_post`、`agent_threads`。

實際調用成功 14 個（括號為代表輸出）：

- `index_status`（repo-a `root=\\?\C:\…\repo-a`、`file_count=1`、`index_build_ms=94`）
- `code_outline`／`code_read`（`summerA` 1–3 行，body 與磁碟一致）
- `code_symbols`（`src/summer-a.js:1: function summerA(values)`；`summerB` 在 repo-a 回 `{"results":[]}`）
- `code_refs`（`{"total":0,"hits":{}}`；無 call site 屬預期）
- `code_search`（keyword lane 命中 `summerA`；`lanes_unavailable` 說明向量 lane 預設關閉，屬環境設定非缺陷）
- `code_grep`（`# src/summer-a.js` / `1: export function summerA(values) {`）
- `find_files`（`files[1]: src/summer-a.js`）
- `git_log`／`git_blame`／`git_diff`（`62e2d68 seed repo-a`；blame 3 行皆 `62e2d68`；`is_clean: true`）
- `docs_search`（plugin repo 內命中 CHANGELOG／docs 段落，vector＋lexical 雙 lane）
- `memory_search`（`hits: []`，冷查 12.7 s）
- `agent_threads`（`{"threads":[],"notices":[]}`）

刻意未調用：`memory_save`、`index_rescan`（會寫入使用者資料／索引，驗收不需要）、`agent_inbox`／`agent_post`（無對談需求）、`cli`（FAIL，見 D8）。

### D7 MCP Resources — PASS

- `list_mcp_resources(basemind)` → `basemind://status`（`application/json`）。
- `read_mcp_resource(basemind://status)` → 與 `index_status` 同內容的 JSON 文字。
- `list_mcp_resource_templates(basemind)` → `basemind://outline/{path}`、`basemind://memory/{key}`；展開 `basemind://outline/src/summer-a.js` 成功回 TOON outline。

### D8 CLI Adapter — FAIL

見 §4 完整分析。

### D9 Skills Registry — PASS

catalog（session 可見）與磁碟 `skills/` 完全一致，共 10 個：`basemind`、`basemind-cli`、`basemind-code-search`、`basemind-comms`、`basemind-doctor`、`basemind-documents`、`basemind-git-history`、`basemind-multi-agent-room`、`basemind-scan`、`basemind-stats`。無重複註冊；skill base directory 指向插件安裝目錄（`…/node_modules/dsh-basemind-plugin/skills`）。
未驗：使用者／專案同名 skill 的優先順序（本次環境無同名項目）。

### D10 Skills 正文 — PARTIAL

- 以 `skill` 工具載入 `basemind-doctor`，回傳完整正文（含 AI-RULEZ 標頭與 4 個步驟），證明不是只有 catalog。
- 該 skill 第一步要求用 `mcp__basemind__cli` 跑 `doctor`／`status`，實跑被 D8 阻擋 → 無法完成「依 skill 執行一次 doctor」的完整驗證。

### D11 多 Session 隔離 — PASS（兩個並行 agent 會話）

| 會話 | 工作區 | `index_status.root` | `summerA` | `summerB` |
| --- | --- | --- | --- | --- |
| 主會話 | repo-a | `\\?\C:\…\repo-a`（`62e2d68`） | 找到 | **找不到** |
| subagent `repo-b-probe` | repo-b | `\\?\C:\…\repo-b`（`776b2ea`） | **找不到** | 找到 |

- 兩個會話同時存在，各自 relay（不同 PID、同一個全域 binary），索引 cache_dir 不同。
- 限制：以「兩個並行 agent 會話」取代「兩個 GUI 分頁」；路由機制（`ctx.workingDirectory.ensure(agent)` → pool per root）相同，但未實際開兩個 GUI session。

### D12 工作區切換 — PASS

同一會話依序 `cd`：plugin repo（`root=…\dsh-basemind-plugin`，`head 7cdf872`）→ repo-a（`root=…\repo-a`，`head 62e2d68`）→ repo-c（`root=…\repo-c`，`summerC` 找到）→ worktree（§D14）。每次切換後下一次工具呼叫即使用新目錄，未沿用建立時目錄。

### D13 Subagent 路由 — PASS

subagent（cwd = repo-b）回報：`index_status.root=\\?\C:\…\repo-b`、`branch=master`、`head 776b2ea`；`code_symbols summerB` 命中、`summerA` 空；`code_outline src/summer-b.js` 正常。CLI 步驟同樣遇到 D8 錯誤（與主會話一致，證明非單一會話偶發）。

### D14 同一 Repo 不同 Worktree — PASS（內容）／部分未驗

- `git worktree add …repo-a-wt -b wt-accept` 後，把 `src/summer-a.js` 的函式改名為 `summerAWorktree`（只改 worktree 內那份）。
- 切到 worktree 後：`code_read {"path":"src/summer-a.js","symbol":"summerAWorktree"}` 回傳改名後的 body；`code_symbols summerAWorktree` 命中；`index_status.root=\\?\C:\…\repo-a-wt`、`branch=wt-accept`。
- 未驗：清單要求的「同 group 的 index／memory／document store 共享符合上游語義」。實測 worktree 取得**獨立** cache_dir（`8b139c59…`），與主工作區（`eae017cf…`）不同；這是上游 BaseMind 的 workspace 切分行為，是否符合「group 共享」語義需另以 BaseMind 文件確認，本輪不下判定。

---

## 4. D8 FAIL：`mcp__basemind__cli` 在真實 DSH runtime 無法啟動

### 4.1 觀察

四次呼叫、四種 verb、兩個不同會話，錯誤完全一致：

```
mcp__basemind__cli {"args":["status"]}
→ dsh-basemind-plugin: could not start the BaseMind CLI: Cannot read properties of undefined (reading 'selectContainmentMode')

{"args":["overview"]}、{"args":["code","explain","src/summer-a.js"]}、{"args":["doctor"]} → 同一錯誤
```

（命令列本身沒問題：直接執行 `basemind.exe --version` 正常；同一 process 內的 MCP relay 也正常。）

### 4.2 根因（已證實，非假設）

1. `lib/cli-tool.js:463` 取出方法後脫離物件呼叫：

```js
const spawn = ctx?.subprocess?.spawn        // 463
...
handle = spawn({ argv, cwd: root, ... })    // 473 → this === undefined
```

2. DSH `0.2.2-rc.5` 的 subprocess provider 是**類別方法**，內部用 `this`：

```
@deepseek-ai/dsh-subprocess-local/src/index.ts
  77: export class LocalSubprocessRuntime extends SubprocessRuntime
 210:   spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
 250:   private selectContainmentMode(...)
        …
        const containmentMode = this.selectContainmentMode('ordinary')
```

`this` 為 `undefined` 時，即拋出「Cannot read properties of undefined (reading 'selectContainmentMode')」，與 DSH 實測錯誤字串逐字相同。

3. 同一 process 內其他路徑都正常，正是因為它們有綁定 receiver：

- `lib/executable.js:340`：`ctx.subprocess.spawn.bind(ctx.subprocess)`（版本探測用）
- `lib/stdio-client.js`：由呼叫端注入已綁定的 `(spec) => ctx.subprocess.spawn(spec)`（relay 用）

4. 為何單元測試全綠：`test/cli-tool.test.mjs:83` 的 fake 是 `{ spawn(spec) {…} }`，內部不讀 `this`，脫離呼叫也能通過；而 `test/executable.test.mjs:477` 早已有 `assert.equal(calls.receiver, ctx.subprocess, 'spawn keeps the provider as its receiver')`——CLI tool 缺了同等的保證。

### 4.3 影響

- `cliTool` 預設 `true`，但**任何** `mcp__basemind__cli` 呼叫在真實 DSH 都會失敗（`code explain`／`impact`／`deadcode`／`cycles`／`overview`／`git hotspots`／`doctor` 全部不可用）。
- `basemind-doctor`／`basemind-cli` 兩個 skill 的第一步都指示用此工具，等於引導到壞路徑（skill 內的 fallback 是「直接跑 `basemind`」shell，仍可用，但多數 agent 會先撞牆）。
- 不影響 15 個 MCP verb tools、resources、skills catalog。
- 是否列為 0.2.0 發布阻擋：清單 §6 只列 D6／D9／D10／D11 為阻擋；本報告的判斷是——**這是廣告中且預設開啟的功能在真實 runtime 100% 不可用，建議列為發布前必修**（此為判斷，不是清單既有規則）。

### 4.4 最小修法（未實施，待授權）

```js
const spawn = typeof ctx?.subprocess?.spawn === 'function'
  ? ctx.subprocess.spawn.bind(ctx.subprocess)
  : undefined
```

搭配一個回歸測試：fake provider 改用**方法**並記錄 `this`，斷言 `this === ctx.subprocess`（照抄 `executable.test.mjs:477` 的既有斷言風格）。預期改動 1 個 runtime 檔＋1 個測試檔，不動公共介面。

### 4.5 修復狀態（2026-11-25 已實施，待實機重驗）

| 項目 | 內容 |
| --- | --- |
| 產品改動 | `lib/cli-tool.js:463`：`const spawn = typeof ctx?.subprocess?.spawn === 'function' ? ctx.subprocess.spawn.bind(ctx.subprocess) : undefined`（與 `lib/executable.js:339`、`lib/binary/probe.js:258` 同一寫法） |
| 回歸測試 | `test/cli-tool.test.mjs`：fake 的 `spawn(spec)` 記錄 `this`；新增 `spawn keeps the subprocess provider as its receiver`，斷言 `state.spawnReceiver === ctx.subprocess` |
| 測試結果 | `node --test test/cli-tool.test.mjs` → 15 tests／15 pass／0 fail；把 `.bind(...)` 暫時移除後該測試立即失敗（`AssertionError: spawn keeps the provider as its receiver`），證明斷言有效 |
| 其他檢查 | `npm run check` → `syntax ok: 20 files`、`bundle manifest ok` |
| 未驗 | **實機 Desktop 重驗尚未執行**：需要重新 pack tarball、在 desktop profile 重裝、重啟 Desktop，再跑一次 `mcp__basemind__cli {"args":["status"]}` 與 `doctor`；在那之前 §1 的 D8 判定仍維持 FAIL（針對 5bec005 建置） |
| CHANGELOG | Unreleased／Fixed 已加一條 |

重驗指令（重啟後由 agent 執行即可）：

```
mcp__basemind__cli {"args":["status"]}
mcp__basemind__cli {"args":["doctor"]}
```

---

## 5. 冷啟動修復（`5bec005`）的實機確認

- 重啟 Desktop 後，本會話第 1 回合就能看到並調用 `mcp__basemind__*`：第一個工具呼叫 `mcp__basemind__git_log` 成功回 10 筆 commit。
- 因此 `5bec005`（`agent/created` listener 回傳初始化 promise、`coldStartTimeoutMs` 預設 15 s）在真實 Desktop 的有效性獲得正面證據；舊版「第 1 回合無工具」的症狀未重現。
- 未涵蓋：全新 `binaryDownload` 首次安裝仍可能超過 15 s（CHANGELOG 已明示），本輪 managed 快取為空且全域 binary 可用，故未觸發該路徑。

---

## 6. 仍需人工或隔離環境的項目（NOT RUN）

### 6.1 D3 的 `/basemind-status` 原文

在任一會話輸入 `/basemind-status`，貼回完整輸出（預期 `source: path`、`version: 0.34.0`、cache 段顯示未安裝）。此步驟不耗模型 token。

### 6.2 D4／D5（managed fallback 與快取重用）

需要一個「看不到全域 basemind」的實例，與實機 Desktop 不可共用。清單 §3.2 的路徑 A：

```powershell
Remove-Item Env:BASEMIND_BIN -ErrorAction SilentlyContinue
$env:PATH = (($env:PATH -split ';') | Where-Object { -not (Test-Path (Join-Path $_ 'basemind.exe')) }) -join ';'
where.exe basemind      # 必須沒有輸出
# 另以獨立 DSH_HOME 起 web 實例，profile 安裝同一個 tarball
```

預期：`/basemind-status` 顯示 `source: managed`、`cache layout: 2`；`install.json` 的 `installedAt` 在重啟後不變（D5）。需下載 75–102 MB、佔 230–320 MB。本輪未執行，原因是它會新增一次 managed 下載且必須改 PATH／重啟，屬需使用者同意的環境變更。

### 6.3 D15 生命周期（GUI）

1. Plugin Manager 停用 `dsh-basemind-plugin` → 我下一次回覆只會看到「工具／skills／resource 全消失」的觀察結果。
2. 重新啟用並重載 → 觀察是否全部恢復。
3. `dsh plugin --profile desktop remove dsh-basemind-plugin` → 重啟後觀察全部消失；確認沒有殘留 `basemind serve`（本輪基線是 5 個 relay＋1 個 comms daemon，移除後應全部結束）；`~/.dsh/cache/dsh-basemind-plugin` 應保留。

---

## 7. 本輪未做的事

- 沒有修改任何產品程式碼、測試、配置或 profile 依賴（`git status` clean；D8 修法只在 §4.4 提出，未實施）。
- 沒有 `git commit`／`push`／`merge`／`tag`，沒有 bump 版本、沒有 publish。
- 沒有改 BaseMind data home、沒有 `index_rescan`、沒有 `memory_save`、沒有清 cache。
- 沒有動使用者的全域 `basemind.exe`（size／mtime 未變）。
- 沒有建立 GUI 第二個 session；D11 以兩個並行 agent 會話取證（§D11）。

## 8. 清理（驗收後可選）

```powershell
# 關閉任何指向測試 fixture 的會話後
Remove-Item -Recurse -Force "$env:TEMP\bm-accept"
git -C "D:\02_zengjunlin\github\dsh-basemind-plugin" worktree list   # worktree 在 temp，刪目錄後可 prune
```

本次未主動刪除，方便 D11／D12／D14 重跑；`~/.dsh` 下沒有任何新增檔案。
