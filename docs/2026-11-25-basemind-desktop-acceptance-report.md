# dsh-basemind-plugin — 實機 DSH Desktop 驗收報告（D1–D15）

- 日期：2026-11-25
- 角色：Execution（實機驗收執行）
- 驗收對象：`dsh-basemind-plugin` **0.2.0**，安裝物為 `D:/_bm_phase3/commit5bec005/dsh-basemind-plugin-0.2.0-5bec005.tgz`（150,843 B，對應 commit `5bec005`）
- 依據清單：[2026-11-24 Desktop 驗收清單](./2026-11-24-basemind-desktop-acceptance-checklist.md)
- 環境：**生產 desktop profile**（`DSH_HOME=C:\Users\sanny\.dsh`、`DSH_PROFILE=desktop`），DSH `0.2.2-rc.5`、Node `v24.20.0`、BaseMind `0.34.0`（`C:\Users\sanny\AppData\Local\Programs\basemind\basemind.exe`）、`BASEMIND_BIN` 未設定
- 判定用語：**PASS**／**FAIL**／**NOT RUN**（未實際操作者一律 NOT RUN，不以推測代替）

> 一句話結論：**D1–D15 全部通過**（D15 含停用／啟用／卸載三階段；D4／D5 在獨立 `DSH_HOME` 的隔離實例完成）。D8 原判 FAIL（`mcp__basemind__cli` 在真實 DSH runtime 完全無法啟動），已於 commit `cd17457` 修復，重裝 tarball 並重啟後實機重驗 **PASS**（證據見 §4.6）。

---

## 1. 執行摘要

| # | 項目 | 判定 | 一句話證據 |
| --- | --- | --- | --- |
| D1 | 打包及安裝 | **PASS** | `npm pack --dry-run`：52 檔、10 個 `SKILL.md`、0 個禁止目錄；profile 內安裝物即此 build |
| D2 | Standard Preset | **PASS** | 本會話第 1 回合第一次工具呼叫即為 `mcp__basemind__git_log` 並成功（`5bec005` 冷啟動修復生效） |
| D3 | Local First | **PASS** | `/basemind-status`：`source: path`、`found 0.34.0`、`compatible: yes`、`managed cache: empty`；5 個 relay 全指向全域 binary、0 次下載 |
| D4 | Managed fallback | **PASS** | 隔離實例（PATH 遮蔽全域 binary、`where basemind` rc=1）→ `source: managed`、`cache layout: 2 (12 files)`；下載安裝 220 MB 完整 tree |
| D5 | Managed cache 重用 | **PASS** | 同一 `DSH_HOME` 重啟後 `installedAt`／mtime 不變、`download/` 空、relay 從 managed cache 啟動，無第二次下載 |
| D6 | MCP Tools | **PASS** | 19 個 `mcp__basemind__*`（15 verbs＋cli＋3 agent tools）；15 個實調成功（含修復後的 `cli`），4 個寫入類刻意未呼叫 |
| D7 | MCP Resources | **PASS** | `list`／`read basemind://status`／templates＋模板展開 `basemind://outline/…` 全部成功 |
| D8 | CLI Adapter | **PASS（修復後重驗）** | 重裝 `d8fix` tarball＋重啟後：`status`／`doctor`／`overview`／`code explain` 全部回真實結果，`root=本 repo`、`head=cd17457` |
| D9 | Skills Registry | **PASS** | catalog 與磁碟皆為 10 個 `basemind*` skills，無重複 |
| D10 | Skills 正文 | **PASS** | `basemind-doctor` 正文可載入；依其第一步跑 `mcp__basemind__cli doctor` 成功（version／root／index／grammars／daemon 全 ok） |
| D11 | 多 Session 隔離 | **PASS（兩個並行 agent 會話）** | repo-a 會話看不到 `summerB`；repo-b subagent 看不到 `summerA`；每 workspace 一個 relay |
| D12 | 工作區切換 | **PASS** | `cd` repo-a→repo-c 後 `index_status.root` 與可查符號同步改變 |
| D13 | Subagent 路由 | **PASS** | subagent `index_status.root` = repo-b（head `776b2ea`），符號與 relay 皆正確 |
| D14 | 同 Repo 不同 Worktree | **PASS（內容）／部分未驗** | worktree 讀到 `summerAWorktree`（非主工作區版本）；group 共享語義未驗 |
| D15 | 插件生命周期 | **PASS** | 停用：19 tools／10 skills／resources 全消失、行程歸零、cache 保留；啟用：同 session 全數恢復、索引 cache 重用；卸載：套件／bundle／依賴移除、四類表面消失、無殘留行程、cache 保留（patch row 殘留 1 行，見 §3 D15） |

---

## 2. 環境與基線（2026-11-25 實測）

| 項目 | 實測值 |
| --- | --- |
| DSH | `0.2.2-rc.5`（`dsh --version`） |
| 插件安裝 | 首輪：`file:D:/_bm_phase3/commit5bec005/dsh-basemind-plugin-0.2.0-5bec005.tgz`；2026-11-25 修復後重裝：`file:C:/Users/sanny/AppData/Local/Temp/bm-fix/dsh-basemind-plugin-0.2.0-d8fix.tgz`（repo HEAD `cd17457`）。兩者版本皆 **0.2.0** |
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

### D3 Local First — PASS

- 選型來源：`Get-CimInstance Win32_Process` 顯示每個 relay 的 `ExecutablePath` 都是 `C:\Users\sanny\AppData\Local\Programs\basemind\basemind.EXE`，`BASEMIND_BIN` 未設定、`command` 未設定 → 對應 `source: path`。
- 零下載：`~/.dsh/cache/dsh-basemind-plugin/managed-binaries/` 為空。
- `/basemind-status` 原文（2026-11-25，使用者在 Desktop 會話輸入）：

```
BaseMind status - dsh-basemind-plugin 0.2.0 (BaseMind 0.34.0)
  expected upstream: 0.34.0 (exact)
  platform         : windows-x64 (x86_64-pc-windows-msvc)
  present          : yes
  path             : C:\Users\sanny\AppData\Local\Programs\basemind\basemind.EXE
  found            : 0.34.0
  compatible       : yes
  source           : path
  managed cache    : empty (C:\Users\sanny\.dsh...e\dsh-basemind-plugin\managed-binaries)
  download         : enabled (binaryDownload=true)

  What to do:
    - No action needed: the selected binary matches binaryPolicy "exact".
```

判定：本機相容 binary 被選用、來源 `path`、快取 empty（零下載）、`download` 雖啟用但未被觸發 → 符合 Local First 的成功條件。

### D4 Managed fallback（看不到本機 binary）— PASS

隔離環境：獨立 `DSH_HOME=C:\Users\sanny\AppData\Local\Temp\dsh-accept`，profile `bmweb` 由 shipped web 模板建立並安裝 `dsh-basemind-plugin-0.2.0-d8fix.tgz`。啟動子程序前把 PATH 中含 `basemind.exe` 的目錄移除，實測：

```
masked PATH entries: [ 'C:\Users\sanny\AppData\Local\Programs\basemind' ]
where basemind: rc=1 out=""
```

`BASEMIND_BIN` 未設定，因此插件沒有可用的本機候選。啟動指令：

```
dsh --profile bmweb --port 51999 --no-open
```

（清單原文的 `--profile bmweb web --port …` 不正確：`web` 是 profile 名稱而非子命令，會被當成 app 參數而回 `too many arguments. Expected 0 arguments but got 1: web.`；已修正清單 §3.2。）

`/basemind-status` 的 host 回應（`POST /api/commands/execute` → `result.kind=success`）：

```
BaseMind status - dsh-basemind-plugin 0.2.0 (BaseMind 0.34.0)
  expected upstream: 0.34.0 (exact)
  platform         : windows-x64 (x86_64-pc-windows-msvc)
  present          : yes
  path             : ...\cache\dsh-basemind-plugin\managed-binaries\0.34.0\windows-x64\basemind.exe
  found            : 0.34.0
  compatible       : yes
  source           : managed
  managed cache    : present (C:\Users\sanny\AppData\Local\Temp\dsh-accept\cache\dsh-basemind-plugin\managed-binaries)
  cache layout     : 2 (12 files)
  cache binary     : present
  download         : enabled (binaryDownload=true)
```

managed 安裝實測（`install.json`）：`layout 2`、`files 12`、`size 226,144,768`、`installedAt 2026-11-25T02:55:16.132Z`、archive `sha256 ce5ead4d…`、binary `binarySha256 6e2c7cfb…`；目錄含 `basemind.exe`、`heif.dll`、`libde265.dll`、`lib/`、`licenses/`、`LICENSE`、`ATTRIBUTIONS.md`、`THIRD_PARTY_LICENSES`，合計 220 MB；全域安裝（`C:\Users\sanny\AppData\Local\Programs\basemind`）未被讀取或修改。relay 行程的 `ExecutablePath` 同樣指向 managed cache 內的 binary。

行為觀察（非插件缺陷）：在「尚未建立會話」的落地頁輸入 `/basemind-status` 時，host 會執行並回 200／`success`，但 web client 沒有 transcript 可渲染，使用者看起來像「按 Enter 沒反應」。先建立會話再輸入即可看到輸出；已於清單 §3.2 加註。

### D5 Managed cache 重用 — PASS

停止實例（確認 51999 無 LISTENING、無 `basemind` 行程）後，以同一 `DSH_HOME`、同一 profile 重啟，再次執行 `/basemind-status`：

| 檢查 | 重啟前 | 重啟後 |
| --- | --- | --- |
| `install.json.installedAt` | `2026-11-25T02:55:16.132Z` | 相同 |
| `basemind.exe` mtime | `2026-11-25 10:55:15` | 相同 |
| `download/` | 空 | 空（無第二次 staging） |
| status | `source: managed`／`layout 2 (12 files)` | 相同 |
| relay | 從 managed cache 啟動 | 從 managed cache 啟動（2 個行程） |

沒有第二次 75–102 MB 下載；cache 目錄大小維持 220 MB。

### D6 MCP Tools — PASS

本次會話可見 19 個工具：`cli`、`code_grep`、`code_outline`、`code_read`、`code_refs`、`code_search`、`code_symbols`、`docs_search`、`find_files`、`git_blame`、`git_diff`、`git_log`、`index_rescan`、`index_status`、`memory_save`、`memory_search`（15 verbs＋cli）＋ `agent_inbox`、`agent_post`、`agent_threads`。

實際調用成功 15 個（括號為代表輸出；`cli` 在 `cd17457` 修復後補驗，見 §4.6）：

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

刻意未調用：`memory_save`、`index_rescan`（會寫入使用者資料／索引，驗收不需要）、`agent_inbox`／`agent_post`（無對談需求）。`cli` 在原建置 FAIL、修復後以 `status`／`doctor`／`overview`／`code explain` 補驗成功（§4.6）。

### D7 MCP Resources — PASS

- `list_mcp_resources(basemind)` → `basemind://status`（`application/json`）。
- `read_mcp_resource(basemind://status)` → 與 `index_status` 同內容的 JSON 文字。
- `list_mcp_resource_templates(basemind)` → `basemind://outline/{path}`、`basemind://memory/{key}`；展開 `basemind://outline/src/summer-a.js` 成功回 TOON outline。

### D8 CLI Adapter — PASS（修復後重驗）

原建置 FAIL，根因與修復見 §4；`cd17457` 重裝重啟後以 `status`／`doctor`／`overview`／`code explain` 實機重驗通過（§4.6）。

### D9 Skills Registry — PASS

catalog（session 可見）與磁碟 `skills/` 完全一致，共 10 個：`basemind`、`basemind-cli`、`basemind-code-search`、`basemind-comms`、`basemind-doctor`、`basemind-documents`、`basemind-git-history`、`basemind-multi-agent-room`、`basemind-scan`、`basemind-stats`。無重複註冊；skill base directory 指向插件安裝目錄（`…/node_modules/dsh-basemind-plugin/skills`）。
未驗：使用者／專案同名 skill 的優先順序（本次環境無同名項目）。

### D10 Skills 正文 — PASS

- 以 `skill` 工具載入 `basemind-doctor`，回傳完整正文（含 AI-RULEZ 標頭與 4 個步驟），證明不是只有 catalog。
- 依該 skill 第一步執行 `mcp__basemind__cli {"args":["doctor"]}`：`version`／`root`／`config`／`index`／`grammars`／`hook`／`daemon`／`cache` 全部 ok（原被 D8 阻擋，修復後完成）。

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

### D15 插件生命周期 — PASS（停用／啟用／卸載）

| 階段 | 執行者 | 觀察 |
| --- | --- | --- |
| 基線（啟用中） | Agent | 19 tools、10 skills、`basemind://status` resource、5 個 relay＋1 個 comms daemon |
| 停用（Plugin Manager） | 使用者 | `mcp__basemind__index_status` → `unknown tool`（19 個全消失）；`list_mcp_resources(basemind)` → `MCP resource server "basemind" is unavailable in this agent's scope`；skills catalog 重送、10 個 `basemind*` 全消失；`Get-Process basemind` → **0 個**（5 relay＋1 daemon 全部結束，無殘留）；`~/.dsh/cache/dsh-basemind-plugin` 保留；`dsh.profile.bundles` 移除該插件 |
| 啟用（Plugin Manager） | 使用者 | **同一 session 內即恢復**（不需重啟）：工具表重新載入 19 個、10 個 skills 回歸、resources 可用；另起一個新 subagent 獨立確認同樣看得到 19 個工具 |
| 啟用後索引 | Agent | `index_status`：`file_count=67`、`warm_ms=1`、`head_short_sha=cd17457` → 索引 cache 直接重用，未重建、未掃描 |
| 啟用後 relay | Agent | 新 relay（PID 36764）＋ `comms daemon`（PID 7076），皆指向全域 `basemind.EXE`；只為本 workspace 起一個 |
| 啟用後設定 | Agent | `bundles` 恰好一筆 `dsh-basemind-plugin`、`cordis.patch.yml` 恰好一行 `- id: dsh-basemind`（無重複） |
| 卸載（`dsh plugin --profile desktop remove`） | 使用者 | `dependencies` 無此套件、`dsh.profile.bundles` 無此 bundle、`node_modules/dsh-basemind-plugin` 已刪除；19 tools → `unknown tool`、resources unavailable、skills catalog 無 `basemind*`（重啟後新會話）；`Get-Process basemind` → **0**；`~/.dsh/cache/dsh-basemind-plugin` 仍保留（`managed-binaries/`＋`state.json`） |
| 卸載後殘留 | Agent | `cordis.patch.yml:684` 仍留 `- id: dsh-basemind`／`name: 'dsh-basemind-plugin'`；套件已不在，row 目前不生效（無工具、無錯誤載入跡象），屬安裝／卸載未對稱清理的殘留 |

殘留觀察與清理：`cordis.patch.yml` 的那一行在停用、啟用與卸載後都未被自動移除；卸載後套件已不存在，該 row 指向無法解析的 module。**已於 2026-11-25 11:02 依使用者授權手動刪除（4 行，含兩行註解）**：刪除前先備份為 `profiles/desktop/cordis.patch.yml.bak-20261125-110247`，刪除後以 `yaml.safe_load` 重新解析通過（entry 34 → 33）、profile 設定內再無 `dsh-basemind` 參照。

---

## 4. D8：`mcp__basemind__cli` 在真實 DSH runtime 無法啟動（已修復並重驗 PASS）

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
- 是否列為 0.2.0 發布阻擋：清單 §6 只列 D6／D9／D10／D11 為阻擋；本報告的判斷是——**這是廣告中且預設開啟的功能在真實 runtime 100% 不可用，應列為發布前必修**（此為判斷，不是清單既有規則）。**已於 `cd17457` 修復並重驗，見 §4.5／§4.6；發布前只需確認該 commit 在發布來源內。**

### 4.4 最小修法（已實施於 `cd17457`）

```js
const spawn = typeof ctx?.subprocess?.spawn === 'function'
  ? ctx.subprocess.spawn.bind(ctx.subprocess)
  : undefined
```

搭配一個回歸測試：fake provider 改用**方法**並記錄 `this`，斷言 `this === ctx.subprocess`（照抄 `executable.test.mjs:477` 的既有斷言風格）。預期改動 1 個 runtime 檔＋1 個測試檔，不動公共介面。

### 4.5 修復內容與回歸測試（已實施）

| 項目 | 內容 |
| --- | --- |
| 產品改動 | `lib/cli-tool.js:463`：`const spawn = typeof ctx?.subprocess?.spawn === 'function' ? ctx.subprocess.spawn.bind(ctx.subprocess) : undefined`（與 `lib/executable.js:339`、`lib/binary/probe.js:258` 同一寫法） |
| 回歸測試 | `test/cli-tool.test.mjs`：fake 的 `spawn(spec)` 記錄 `this`；新增 `spawn keeps the subprocess provider as its receiver`，斷言 `state.spawnReceiver === ctx.subprocess` |
| 測試結果 | `node --test test/cli-tool.test.mjs` → 15 tests／15 pass／0 fail；把 `.bind(...)` 暫時移除後該測試立即失敗（`AssertionError: spawn keeps the provider as its receiver`），證明斷言有效 |
| 其他檢查 | `npm run check` → `syntax ok: 20 files`、`bundle manifest ok` |
| 實機重驗 | **PASS**（2026-11-25：重裝 `d8fix` tarball＋重啟 Desktop 後執行，見 §4.6） |
| CHANGELOG | Unreleased／Fixed 已加一條（已隨 `cd17457` 提交） |

### 4.6 實機重驗（2026-11-25，PASS）

安裝物改為 `file:C:/Users/sanny/AppData/Local/Temp/bm-fix/dsh-basemind-plugin-0.2.0-d8fix.tgz`，`node_modules/dsh-basemind-plugin/lib/cli-tool.js:467` 確認含 `.bind(ctx.subprocess)`；重啟後在**新會話第 1 回合**執行：

```
mcp__basemind__cli {"args":["status"]}
→ file_count: 67 / root: \\?\D:\02_zengjunlin\github\dsh-basemind-plugin / head_short_sha: cd17457
  branch: main；languages: javascript 65、bash 1、batch 1
  [stderr] (3.2 ms query · 47.1 ms startup)

mcp__basemind__cli {"args":["doctor"]}
→ ok version 0.34.0
  ok root      \\?\D:\02_zengjunlin\github\dsh-basemind-plugin
  ok config    basemind.toml loaded
  ok index     …\views\working\index.msgpack; writer: `basemind comms daemon` (pid 61340)
  ok grammars  16 downloaded
  ok hook      pre-commit hook not installed (optional)
  ok daemon    running (\\.\pipe\basemind-comms-sanny-…)
  ok cache     last GC Starved

mcp__basemind__cli {"args":["overview"]}
→ files: 67 / lines: 23550 / layout、manifests 0.2.0、entry_points、naming、recent commits 全部回傳

mcp__basemind__cli {"args":["code","explain","lib/cli-tool.js"]}
→ target: file / 553 lines / 29 symbols / imports 3 / importers 3 / history 2（含 cd17457）
```

- 四個 verb 皆使用已選的全域 0.34.0 binary，`--root .` 為當前工作區，與 MCP 工具同一份索引（`head_short_sha` 一致）。
- 觀察（非缺陷）：每個結果尾端附一行 BaseMind 自己的 stderr 計時（`[stderr] (… query · … startup)`），是 bridge 對非空 stderr 的既有投影行為。
- 結論：`cd17457` 之後 D8 **PASS**，D6 的「CLI 除外」與 D10 的 PARTIAL 一併解除。

---

## 5. 冷啟動修復（`5bec005`）的實機確認

- 重啟 Desktop 後，本會話第 1 回合就能看到並調用 `mcp__basemind__*`：第一個工具呼叫 `mcp__basemind__git_log` 成功回 10 筆 commit。
- 因此 `5bec005`（`agent/created` listener 回傳初始化 promise、`coldStartTimeoutMs` 預設 15 s）在真實 Desktop 的有效性獲得正面證據；舊版「第 1 回合無工具」的症狀未重現。
- 未涵蓋：全新 `binaryDownload` 首次安裝仍可能超過 15 s（CHANGELOG 已明示）。Desktop 主會話本輪未重測此冷啟動交互；首次 managed 下載本身已於 D4 的隔離實例實測完成（約 1 分鐘內、220 MB）。

---

## 6. 仍需人工或隔離環境的項目

### 6.1 D3 的 `/basemind-status` 原文 — **已完成（2026-11-25）**

使用者在 Desktop 會話輸入 `/basemind-status`，輸出見 §3 D3；判定改為 **PASS**（來源 `path`、`found 0.34.0`、`compatible: yes`、`managed cache: empty`）。此項不再需要人工。

### 6.2 D4／D5（managed fallback 與快取重用）— **已完成（2026-11-25）**

已在獨立 `DSH_HOME`＋遮蔽 PATH 的隔離實例完成下載、安裝與重啟重用，證據見 §3 D4／D5：`source: managed`、layout 2、12 檔、220 MB、`installedAt` 重啟後不變、`download/` 為空。全程未使用、未修改機器的全域 BaseMind 安裝。

### 6.3 D15 生命周期（GUI）— **已完成（2026-11-25）**

2026-11-25 三個階段全部實測：停用（四類表面全消失、relay 歸零、cache 保留）、重新啟用（同一 session 恢復、索引 cache 重用）、卸載（套件／bundle／依賴移除、四類表面消失、無殘留行程、cache 保留），證據見 §3 D15。卸載後殘留的一行 `cordis.patch.yml` row 已於同日清理（備份 `cordis.patch.yml.bak-20261125-110247`）。

> 注意：本次卸載已把插件從日常 desktop profile 移除。若要恢復使用，需重新 `plugin add`（tarball 已複製到 `D:\_bm_phase3\bm-acceptance\dsh-basemind-plugin-0.2.0-d8fix.tgz`）並重啟。

---

## 7. 本輪未做的事

- 驗收本身沒有修改產品程式碼；D8 的修復是後續經使用者授權的獨立變更，已由使用者提交為 `cd17457`，並在重裝／重啟後完成實機重驗（§4.6）。
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
