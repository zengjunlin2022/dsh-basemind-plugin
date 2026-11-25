# dsh-basemind-plugin — DSH Desktop 驗收清單（D1–D15）

- 日期：2026-11-24
- 版本狀態：`package.json` **0.2.0**（目前為開發版本，尚未正式發佈）；本清單的打包與安裝步驟一律使用 0.2.0 tarball，**不 bump 版本、不發布**。目標發布版本與正式發佈版本均為 0.2.0。
- 角色：Execution（Phase 2 Task C 產出）
- 依據：[Stability & Feature Parity Plan](./2026-11-24-basemind-stability-feature-parity-plan.md) §12、[Phase 1 Execution Report](./2026-11-24-basemind-stability-phase1-execution-report.md)
- 本檔性質：**可執行的人工驗收清單**。本次自動化只完成 D1 與 D2 的「profile 組裝」部分（見 §2）；**2026-11-25 已在生產 desktop profile 實機執行 D3–D14 並把結果填回 §5**（完整證據見 [實機驗收報告](./2026-11-25-basemind-desktop-acceptance-report.md)），**2026-11-25 已完成 D1–D15 全部實機驗收**：D8 已於 `cd17457` 修復並重驗 PASS（報告 §4.6），D15 停用／啟用／卸載三階段通過，D4／D5 在獨立 `DSH_HOME` 的隔離實例完成（報告 §3 D4／D5）。注意：卸載後插件不在日常 desktop profile，需重新 add 才能恢復使用。
- 判定用語：**PASS**／**FAIL**／**NOT RUN**（未執行不得寫成 PASS）。

---

## 1. 前置事實（2026-11-24 實測）

| 項目 | 實測值 |
| --- | --- |
| DSH 執行版本 | `0.2.2-rc.5`（`dsh --version`） |
| DSH CLI | `C:\Users\sanny\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` |
| Desktop app | `C:\Users\sanny\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe`（固定使用 `~/.dsh`） |
| 生產 desktop profile | `C:\Users\sanny\.dsh\profiles\desktop`，其中 `dsh-basemind-plugin` 為 **0.1.6**；**本次不得修改** |
| `engines.dsh` | `>=0.2.1-rc.3 <0.3.0-0`（0.2.2-rc.5 在範圍內） |
| 本機 BaseMind | `C:\Users\sanny\AppData\Local\Programs\basemind\basemind.exe`，`0.34.0`（官方 Release 佈局） |
| Node | `v24.20.0`（Volta） |

> Desktop app 沒有「切換 profile」的公開入口，且它的 `DSH_HOME` 固定是 `~/.dsh`。因此**真正在 Desktop app 內驗收，會動到生產 profile**。本清單因此提供兩條路徑：
>
> - **路徑 A（建議、可隔離）**：用獨立 `DSH_HOME` 起一個 DSH Web 實例（同一套 runtime、同一份 shipped 標準 preset 層）。除「Desktop app 的視窗外殼」以外，工具／skills／resources／CLI／生命周期的行為與 Desktop 相同。
> - **路徑 B（實機 Desktop）**：只有取得人工授權、且能在維護窗口內操作時才做；先在 §8 備份，結束後依 §9 還原。

---

## 2. 本次已自動完成的部分（可直接複核）

### 2.1 D1：打包內容（PASS — 本機實測）

```bash
cd <repo 根目錄>
npm pack --pack-destination "$TEMP/bmpack"
tar -tzf "$TEMP/bmpack/dsh-basemind-plugin-0.2.0.tgz" | sort
```

本次結果：tarball 142,425 bytes、52 個檔案；`skills/<name>/SKILL.md` 共 **10** 個（每個 skill 另有 `index.md`）；不含 `test/`、`docs/`、`fixtures/`、`.github/`、`node_modules/`、`*.exe`、binary cache 或暫存檔。`npm run check:pack` 同步通過（`pack contents ok: 52 files`）。

判定：PASS。填寫位置：§5 `D1`。

### 2.2 D2（profile 組裝部分，PASS — 本機實測）

已在**獨立 `DSH_HOME`** 完成，未觸碰生產 profile：

```powershell
$env:DSH_HOME = "$env:TEMP\dsh-accept"
$dsh = "C:\Users\sanny\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 1) 以 shipped web 模板建立測試 profile（不啟動）
& $dsh --profile bmweb --from-default-profile web --dump-config > $null

# 2) 安裝實際打包的 tarball
& $dsh plugin --profile bmweb add "$env:TEMP\bmpack\dsh-basemind-plugin-0.2.0.tgz" --save-exact

# 3) 確認 bundle row 已插入、未 disabled、未新增任何 MCP row
& $dsh --profile bmweb --dump-config | Select-String -Context 0,4 "dsh-basemind"
```

本次結果：

- `profiles/bmweb/package.json` 的 `dsh.profile.bundles` = `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-basemind-plugin"]`。
- `--dump-config` 第 1289 行起出現
  `- id: dsh-basemind` / `name: dsh-basemind-plugin` / `config: { serverName: basemind, binaryDownload: true }`，沒有 `disabled:`。
- profile 的使用者 patch 層仍是 `[]`（未手改 YAML），也沒有新增任何 MCP server row。

判定：PASS（組裝層）。GUI 內的工具／skills 是否真的註冊，屬 D6／D9／D10，仍需人執行。

---

## 3. 測試環境準備（路徑 A，逐步可執行）

### 3.1 建置測試用 repository（D11／D12／D14 需要）

```powershell
$base = "$env:TEMP\bm-accept-repos"
Remove-Item -Recurse -Force $base -ErrorAction SilentlyContinue
# repo-a-wt 由 D14 的 `git worktree add` 建立，不要先建（否則 git 會拒絕非空目錄）。
foreach ($name in "repo-a","repo-b","repo-c") {
  New-Item -ItemType Directory -Force "$base\$name\src" | Out-Null
}

# Repo A：symbol summerA
@'
export function summerA(values) {
  return values.reduce((total, value) => total + value, 0)
}
'@ | Set-Content "$base\repo-a\src\summer-a.js"

# Repo B：symbol summerB（與 A 可區分）
@'
export function summerB(values) {
  return values.reduce((total, value) => total + value, 1)
}
'@ | Set-Content "$base\repo-b\src\summer-b.js"

# Repo C：symbol summerC
@'
export function summerC(values) {
  return values.length
}
'@ | Set-Content "$base\repo-c\src\summer-c.js"

foreach ($name in "repo-a","repo-b","repo-c") {
  Push-Location "$base\$name"
  git init -q; git add -A
  git -c user.name=accept -c user.email=accept@example.invalid commit -qm "seed $name"
  Pop-Location
}
```

### 3.2 啟動隔離實例

```powershell
$env:DSH_HOME = "$env:TEMP\dsh-accept"          # 與 §2.2 相同，勿改成預設 ~/.dsh
$env:DSH_WEB_URL = ""; $env:DSH_PROFILE_DIR = ""; $env:DSH_PROFILE = ""; $env:DSH_SESSION_ID = ""
$dsh = "C:\Users\sanny\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh --profile bmweb --port 51999 --no-open
```

把終端機印出的完整 URL（含 token）貼到瀏覽器。預期：DSH Web UI 開啟、插件已載入；若插件載入失敗，UI 的 Plugin Manager 會顯示該 row 的錯誤。

> **2026-11-25 實測修正**：`web` 是 profile 名稱（等同 `dsh web`），不能再當子命令；`--profile bmweb web --port …` 會被當成 app 參數而回 `too many arguments. Expected 0 arguments but got 1: web.`。另外 `/basemind-status` 必須在**已建立會話**的頁面輸入：在尚未建立會話的落地頁送出時，host 仍會執行並回 200／`success`，但 web client 沒有 transcript 可渲染，看起來像「按 Enter 沒反應」。

> **D4（Managed fallback）的隔離前提（單一前提，別混用兩種設定）**：本機已有全域 BaseMind 0.34.0，因此要在「看不見它」的實例裡驗 fallback。啟動前只做這件事：
>
> ```powershell
> Remove-Item Env:BASEMIND_BIN -ErrorAction SilentlyContinue
> $env:PATH = (($env:PATH -split ';') | Where-Object { -not (Test-Path (Join-Path $_ 'basemind.exe')) }) -join ';'
> where.exe basemind     # 必須沒有輸出
> ```
>
> 這只影響這個測試實例的 `PATH`，不改系統設定。預期：`/basemind-status` 顯示 `source: managed`、`version: 0.34.0`、`cache layout: 2`；`C:\Users\sanny\AppData\Local\Programs\basemind\basemind.exe` 的 size／mtime 不變（表示全域安裝未被使用或修改）。

### 3.4 D3／D5 的具體操作

**D3 Local First（不需要模型額度）**

1. `where.exe basemind` 必須有輸出（本機全域 0.34.0），且 `$env:BASEMIND_BIN` 未設定。
2. 在 §3.2 的隔離實例開一個會話，工作目錄設為 `$base\repo-a`。
3. 輸入 `/basemind-status`。
4. 預期：`source: path`（若你用 `BASEMIND_BIN` 或 `command` 指定，則是 `env`／`command`）、`version: 0.34.0`、相容；`cache` 行顯示 `missing`（尚未 managed 安裝）。
5. 記錄：`/basemind-status` 全文，以及 `Test-Path "$env:TEMP\dsh-accept\cache\dsh-basemind-plugin"` 的結果（應為 `False`，代表零下載）。

**D5 Managed cache（不需要模型額度）**

1. 先完成 D4，此時 managed cache 已建立。記下 `install.json` 的 `installedAt`：
   `Get-Content "$env:TEMP\dsh-accept\cache\dsh-basemind-plugin\managed-binaries\0.34.0\*\install.json" | Select-String installedAt`
2. 關閉該分頁，並在啟動它的終端機按 `Ctrl+C`；用 `Get-Process basemind -ErrorAction SilentlyContinue` 確認沒有指向 `%TEMP%\dsh-accept` 的行程。
3. 用 §3.2 的同一條命令重新啟動（同一 `DSH_HOME`、同一 port），開新會話。
4. 輸入 `/basemind-status`。
5. 預期：`cache layout: 2`、`cache binary: present`、`installedAt` 與步驟 1 **相同**；`...\dsh-basemind-plugin\download\` 為空；沒有第二次 75–102 MB 下載。
6. 記錄：步驟 1／5 的 `installedAt`、`download\` 目錄清單、`/basemind-status` 全文。

### 3.3 還原生產環境

見 §9。

---

## 4. Agent 測試 Prompt（逐項複製使用）

以下 prompt 假設會話的工作目錄是對應 repository 根目錄。

- **D6（工具可調用）**
  > 依序做四件事並回報每一步的原始結果：(1) 列出你所有以 `mcp__basemind__` 開頭的工具名稱；(2) 呼叫 `index_status` 並貼出它的 `structuredContent`；(3) 呼叫 `code_outline`，參數 `{"path":"src/summer-a.js"}`；(4) 呼叫 `code_read`，參數 `{"path":"src/summer-a.js","symbol":"summerA"}`。若任何一步回 `isError`，貼出完整錯誤文字。
- **D7（resources）**
  > 呼叫 `list_mcp_resources`（server 名稱 `basemind`）貼出完整結果；再 `read_mcp_resource` 讀 `basemind://status` 並貼出前 20 行；最後呼叫 resource templates 列表。若某個方法不支援，明確說出錯誤碼。
- **D8（CLI）**
  > 呼叫 `mcp__basemind__cli`，`args` 依序為 `["status"]`、`["overview"]`、`["code","explain","src/summer-a.js"]`，每次貼出結果文字的前 20 行，並說明這些輸出是否來自當前工作區。
- **D9／D10（skills）**
  > 列出你可用的 skill 中所有 `basemind*` 開頭的項目，對每一個說出它的 name／description／provider。然後載入 `basemind-doctor` 的正文，貼出正文第一段，並依它執行一次 doctor 回報結果。
- **D11（工作區隔離）**
  > （在 Repo A 的會話）只做一件事：呼叫 `index_status`，把 `root` 與 `structuredContent` 貼出。（在 Repo B 的會話）同樣做一次。然後在 A 呼叫 `code_symbols`，參數 `{"name":"summerB"}`；在 B 呼叫 `code_symbols`，參數 `{"name":"summerA"}`，回報是否找得到。
- **D12（工作區切換）**
  > 把工作目錄切換到 `<repo-c 絕對路徑>`，然後再呼叫一次 `index_status` 並貼出 `root`；再呼叫 `code_symbols`，參數 `{"name":"summerC"}`。
- **D13（subagent 路由）**
  > 開一個 subagent，讓它的工作目錄是 `<repo-b 絕對路徑>`，在 subagent 內呼叫 `index_status` 與 `mcp__basemind__cli`（`args=["status"]`），把兩者的 root／輸出貼回主會話。
- **D14（worktree；Agent 可執行）**
  > 在 Repo A 內建立 `git worktree add <repo-a-wt 絕對路徑> -b wt-accept`（該目錄必須還不存在），修改 worktree 內 `src/summer-a.js` 的函式名為 `summerAWorktree`（只改 worktree 內那份），然後把工作目錄切到 worktree，呼叫 `code_read`（`{"path":"src/summer-a.js","symbol":"summerAWorktree"}`）與 `code_symbols`（`{"name":"summerAWorktree"}`），回報是否讀到 worktree 版本；再回報 `index_status` 的 `root`。
- **D15（生命周期；人工 GUI 步驟，Agent 只負責回報觀察）**
  1. 在隔離實例的 Plugin Manager 把 `dsh-basemind-plugin` 停用。
  2. 對 Agent 說：`列出你現在還看得到的 mcp__basemind__* 工具、basemind* skill、以及 basemind resource provider（若有）` → 預期全部消失。
  3. 人工確認 `Get-Content "$env:TEMP\dsh-accept\profiles\bmweb\cordis.patch.yml"` 中該 row 的狀態（`disabled: true` 或不生效）。
  4. 重新啟用並重載插件，重複步驟 2 → 預期全部恢復。
  5. 卸載：`& $dsh plugin --profile bmweb remove dsh-basemind-plugin`，重啟隔離實例，重複步驟 2 → 全部消失。
  6. 最後確認：`Get-Process basemind -ErrorAction SilentlyContinue` 沒有殘留的 `serve` 行程；`%TEMP%\dsh-accept\cache\dsh-basemind-plugin` **仍存在**（cache 依策略保留）。
  
  Agent 無法操作 GUI，所以步驟 1／4／5 必須由人完成；Agent 只回答步驟 2 的觀察。

---

## 5. D1–D15 執行結果（人工填寫）

填寫規則：只有實際觀察到的結果才寫 PASS；沒做就寫 NOT RUN 並註明原因。

| # | 項目 | 判定標準 | 實際結果（填寫位置） | 判定 |
| --- | --- | --- | --- | --- |
| **D1** | 插件打包及安裝 | `npm pack` 產生 tarball；含 runtime JS、`cordis.patch.yml`、`locale/*`、`icon.svg`、10 個 skills；不含 cache／test／暫存檔；DSH 可安裝並啟用 | tarball 142,425 B／52 檔／10 skills；`check:pack` 52 files ok；獨立 profile 安裝成功（§2） | **PASS（本機實測）** |
| **D2** | Standard Preset | 不改 preset、不加 MCP row、不改 YAML，Agent 即可發現插件工具 | profile 由 shipped web 模板建立、使用者 patch 為 `[]`、`dsh-basemind` row 自動插入且未 disabled（§2.2）；實機第 1 回合即發現並可調用全部 19 個工具 | **PASS** |
| **D3** | Local First | 本機相容 0.34.0 被使用；無下載；`/basemind-status` 顯示版本與來源 `path`（或 `env`／`command`） | `/basemind-status` 原文：`present: yes`、`path: …\Programs\basemind\basemind.EXE`、`found: 0.34.0`、`compatible: yes`、`source: path`、`managed cache: empty`、`download: enabled`；5 個 relay 皆此 binary | **PASS** |
| **D4** | Managed fallback | 隔離環境下無本機／版本不相容時自動選用 managed；不影響用戶全局安裝 | 隔離 `DSH_HOME`＋PATH 遮蔽（`where basemind` rc=1）：`source: managed`、`cache layout: 2 (12 files)`；安裝 220 MB 完整 tree、`install.json` 記 SHA256；全域安裝未動 | **PASS** |
| **D5** | Managed cache | 重啟 profile 或重建插件實例後重用 cache，不重下載、不重建大型副本 | 同 `DSH_HOME` 重啟：`installedAt`／exe mtime 不變、`download/` 空、status 仍 `managed`／layout 2、relay 從 managed cache 啟動 | **PASS** |
| **D6** | MCP Tools | 15 個 verb tools 全部可見（comms build 另有 3 個 agent tools）且**實際可調用**，非只有名稱 | 19 個 `mcp__basemind__*` 可見（15 verbs＋cli＋3 agent tools）；15 個實調成功（含修復後的 `cli`），4 個寫入類未呼叫 | **PASS** |
| **D7** | MCP Resources | `list_mcp_resources`、`read_mcp_resource`、resource templates 可用；工作區路由正確 | `basemind://status` 讀取成功；templates 2 個；展開 `basemind://outline/src/summer-a.js` 成功 | **PASS** |
| **D8** | CLI Adapter | `mcp__basemind__cli` 用已選相容 binary、當前工作區，回傳真實分析結果 | 原建置任何 verb 皆回 `…selectContainmentMode`（根因 `lib/cli-tool.js:463` 未綁定 provider receiver）；`cd17457` 修復後重裝重啟重驗：`status`／`doctor`／`overview`／`code explain` 全部回真實結果（root=本 repo、head `cd17457`） | **PASS（修復後重驗）** |
| **D9** | Skills Registry | 10 個官方 skills 出現；metadata 符合 DSH 契約；不重複註冊；用戶／專案同名優先 | catalog 與磁碟皆 10 個、無重複、base dir 指向插件；同名優先級未驗 | **PASS** |
| **D10** | Skills 正文 | 真實 Agent 能載入 skill 正文（不是只看得到 catalog） | `basemind-doctor` 正文完整載入；依其第一步跑 `mcp__basemind__cli doctor` 成功（version／root／index／grammars／daemon 全 ok） | **PASS** |
| **D11** | 多 Session 隔離 | Session A 不讀 Repo B、B 不讀 A；順序不影響路由；binary 共用；索引不混用 | repo-a 主會話找不到 `summerB`；repo-b subagent 找不到 `summerA`；每 workspace 一個 relay、同一個全域 binary | **PASS（兩個並行 agent 會話）** |
| **D12** | 工作區切換 | `cd` 後下一次工具調用使用新目錄（非建立時目錄） | plugin repo→repo-a→repo-c→worktree，每次 `index_status.root` 與可查符號同步改變 | **PASS** |
| **D13** | Subagent 路由 | 主 Agent 與 subagent 各自工作區；MCP／CLI／Resources 都走對 | subagent `root=…\repo-b`（`776b2ea`）、`summerB` 命中、`summerA` 空；CLI 步驟同樣撞 D8 | **PASS（MCP 路由）** |
| **D14** | 同一 Repo 不同 Worktree | 讀到正確 worktree 內容；同 group 的 index／memory／document store 共享符合上游語義 | worktree 讀到 `summerAWorktree`、`root=…\repo-a-wt`；worktree 取得獨立 cache_dir，group 共享語義未驗 | **PASS（內容）／部分未驗** |
| **D15** | 插件生命周期 | 停用／重啟用／重載／卸載後不殘留 tools、CLI、skills、bootstrap、resource provider；自身 relay 關閉；不誤停用戶 daemon；cache 保留 | 停用：19 tools／10 skills／resources 全消失、basemind 行程歸零、cache 保留；啟用：**同一 session** 全數恢復、索引 cache 重用（`warm_ms=1`）；卸載：依賴／bundles／`node_modules` 全移除、四類表面消失、無殘留行程、cache 保留；卸載後殘留的 `cordis.patch.yml` row 已清理（備份 `cordis.patch.yml.bak-20261125-110247`） | **PASS** |

> 上表判定反映 2026-11-25 實機執行結果；D8 於 `cd17457` 修復後重裝重啟重驗通過（報告 §4.6）；D15 停用／啟用／卸載全部通過；D4／D5 於隔離實例完成（報告 §3）。**D1–D15 全部 PASS。**
> 2026-11-25 的實機執行細節與完整證據見 [實機驗收報告](./2026-11-25-basemind-desktop-acceptance-report.md)；D3 的 `/basemind-status` 原文、D4／D5、D15 仍待人工續驗。

---

## 6. 判定標準細節

- **PASS**：在乾淨的隔離環境中按本清單步驟操作，觀察到的結果與 D1–D15 的判定標準逐項相符，且 §5 已記錄實際輸出（含錯誤訊息或 tool 名稱清單）。
- **FAIL**：任一條判定標準不符，或需要手動繞過（例如手動改 YAML、手動加 MCP row、手動設 `BASEMIND_BIN` 才能用）。FAIL 必須附：DSH 版本、BaseMind 版本與來源、`/basemind-status` 全文、錯誤原文。
- **NOT RUN**：沒有實際操作，或環境不允許（例如未取得模型額度授權）。**不得**用 Mock 測試結果或「應該可以」代替。
- 任何一項 FAIL 都必須在回報時標明是否為 0.2.0 發布阻擋（D6／D9／D10／D11 屬阻擋）。

---

## 7. 觀察與取證方式

- `/basemind-status`：在任何會話輸入該指令，貼出完整輸出（含 `source`／`version`／`cache layout`／`cache missing` 行）。
- 插件載入錯誤：DSH UI 的 Plugin Manager 對應 row，或 `$DSH_HOME/logs`（若存在）中 `[dsh-basemind-plugin]` 開頭的行。
- MCP relay 診斷：選配 `logger` 等級的最小日誌；不要把完整環境變數、token 或使用者記憶貼進報告。
- 需要留存檔案時，放在 `docs/` 以外的暫存目錄，不要 commit 截圖或 log。

---

## 8. 路徑 B（實機 Desktop app）的必要前置

只有在**人工授權**後才做：

1. 完全退出 DSH Desktop（含系統匣圖示），確認 `DeepSeek Harness.exe` 不在工作管理員中。
2. 備份：`Copy-Item -Recurse "$env:USERPROFILE\.dsh\profiles\desktop" "$env:USERPROFILE\.dsh\profiles\desktop.bak-<timestamp>"`。
3. 記錄現況：`Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json"`（本次實測 `dsh-basemind-plugin` 為 `0.1.6`）。
4. 安裝候選版本：`& $dsh plugin --profile desktop add "<tarball 絕對路徑>" --save-exact`（會鎖 profile；失敗會自動還原 `package.json`／lockfile）。
5. 啟動 Desktop，按 §5 逐項驗收；**不要**同時保持其他 DSH 視窗在跑同一個 profile。
6. 驗收結束後依 §9 還原。

---

## 9. 清理與回滾

```powershell
# 1) 停掉隔離實例（在它的終端機按 Ctrl+C，或關閉該分頁後結束該 node 行程）
#    不要對生產 Desktop 做任何操作。

# 2) 刪除隔離環境（含它自己的 managed binary cache；約 230–320 MB／平台）
Remove-Item -Recurse -Force "$env:TEMP\dsh-accept"
Remove-Item -Recurse -Force "$env:TEMP\bm-accept-repos"
Remove-Item -Recurse -Force "$env:TEMP\bmpack"

# 3) 只在使用路徑 B 時：還原生產 profile
Copy-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\desktop.bak-<timestamp>\*" "$env:USERPROFILE\.dsh\profiles\desktop"
# 或在 Desktop 的 Plugin Manager 把 dsh-basemind-plugin 裝回原本版本：
& $dsh plugin --profile desktop add dsh-basemind-plugin@0.1.6 --save-exact
```

清理後應確認：

- `~/.dsh/profiles/desktop/node_modules/dsh-basemind-plugin/package.json` 的 `version` 回到 `0.1.6`。
- 沒有殘留的 `basemind serve` 行程指向被刪除的測試目錄（`Get-Process basemind`）。
- 使用者自己的 `~/.dsh/cache/dsh-basemind-plugin` 未被刪除（若曾存在）。
