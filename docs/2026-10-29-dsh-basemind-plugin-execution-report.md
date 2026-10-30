# dsh-basemind-plugin 執行報告（Execution Report）

- 日期：2026-10-29
- 對應計畫：`docs/2026-10-29-dsh-basemind-plugin-plan.md`（執行期間的權威設計基線）
- 審查後修正：`docs/2026-10-29-dsh-basemind-plugin-review-fix-report.md`
- 目標 workspace：`D:\02_zengjunlin\github\dsh-basemind-plugin`
- DSH Runtime：`0.2.1-rc.3`，Desktop profile `desktop`
- BaseMind：本機 `0.29.3`（`C:\Users\sanny\AppData\Local\Volta\bin\basemind.cmd` → `basemind.exe`）
- Git baseline：**無 commit**（`## No commits yet on main`），全部交付檔案皆為 untracked；因此本報告以「工作區現況」而非 SHA 界定範圍
- 未執行任何 `git commit`／`git push`（依規則由使用者審查後自行提交）

---

## 1. 總體狀態

| 項目 | 結果 |
|---|---|
| 實作（T1–T7、T9） | **完成** |
| 單元＋整合測試 | **完成**：`node --test` → 149 tests / 149 pass / 0 fail（約 8 s，含 5 個真實 BaseMind integration test）；integration suite 自帶隔離的 `BASEMIND_DATA_HOME` / `BASEMIND_COMMS_DIR`，結束時停止測試 daemon 並刪除 test data home |
| 語法檢查 | **完成**：20 個 `.js`/`.mjs` 全數 `node --check` 通過 |
| 安裝（T8） | **完成**：`plugin_manager install_bundle` → `application: applied`、`warnings: []` |
| Runtime 驗證（§13.3） | **在已安裝的 Desktop profile 完成**（9 工具、per-workspace routing、`cd` 切換、resources、instructions、unload 清理、重新啟用）；**官方 source `dsh web` 與 `dev:desktop` 也已用真實模型驗證**（見 §6.1） |
| 官方 source 驗收（2026-10-29 第二輪） | **完成**：`dsh web`（source checkout）與 `dev:desktop` 都以**真實 DeepSeek API** 跑完 9 tools / root / `cd` / resources / instructions / toggle-on / 停用重啟；證據在 `D:\02_zengjunlin\DSH_TEST\evidence\real-model-*.md` |
| 官方 surface failure paths（2026-10-29 審查後） | **完成（Web）**：missing binary 與同名 MCP row collision 都在可丟棄的官方 Web profile 執行；missing → DSH 正常、0 個 BaseMind tools、有 warning；collision → 插件 registration inactive（row 仍 active）、只有既有 MCP row 的 2 個工具、原 row 可正常呼叫。Desktop failure paths 未單獨重跑（見 §6.4） |
| Cache 清理（使用者決定） | **完成**：刪除兩個指定的預設 cache 目錄（256.16 MiB）＋審查發現的 `56d019bb…`（67,271,674 B）；registry 未刪未改。`node --test` 隔離修復後重跑，預設 cache 目錄數與 registry mtime/size 均未變 |
| 審查後修正 | **完成**：test isolation、Web/Desktop audit 分離、failure paths、憑證衛生、報告一致性，另修正 `readVersion` 的 `spawn` receiver bug；見 `review-fix-report.md` |
| 正式驗收（review follow-up） | **可交付**：5 個 Important 的收尾項已關閉；API key 輪換待使用者於 provider 端執行；Desktop failure paths 未單獨重跑（已知限制，見 §6.4） |
| 文件 | **完成**：`README.md`（12 節）、本報告、審查修正報告 |

---

## 2. 交付檔案

| 檔案 | 角色 |
|---|---|
| `index.js` | plugin entry：config、pool、tool/resource/prompt 註冊、generation sync、生命週期 |
| `lib/config.js` | row config 驗證與 clamp，無 `Config` export |
| `lib/executable.js` | `scrubEnv`、`buildLaunchArgv`（Windows `.cmd` wrapper）、`resolveLaunch`、`readVersion` |
| `lib/stdio-client.js` | newline-delimited JSON-RPC over stdio，handshake/timeout/cancel/close |
| `lib/mcp-session.js` | `tools/list` 分頁與快取、`tools/call`、resources 轉發 |
| `lib/schema.js` | MCP JSON Schema → DSH `JsonSchemaNode` 正規化＋嚴格驗證 |
| `lib/result.js` | MCP content → 純 text ContentBlock 投影 |
| `lib/tool-bridge.js` | 每個 MCP tool → DSH `ToolDefinition`（per-call root 解析） |
| `lib/workspace-pool.js` | 每 root 一個 relay、in-flight 去重、`maxClients`、清理 |
| `package.json` | 無 dependencies、`dsh.bundle.patch`、`exports`/`files`/`compatibility` |
| `cordis.patch.yml` | 只 insert `id: dsh-basemind` |
| `locale/en.json`、`locale/zh.json` | Plugin Manager 的 title/description（en/繁中） |
| `icon.svg` | 原創知識圖譜＋B 字標記 |
| `README.md` | 安裝、11 欄位 config 表、運作方式、工具/資源、生命週期、限制、troubleshooting |
| `fixtures/` | 真實 0.29.3 tool schema/instructions fixture＋scripted MCP server（3 檔） |
| `test/*.test.mjs` | 10 個測試檔（單元 9＋integration 1）；integration 自帶 BaseMind 資料隔離 |

---

## 3. 已驗證（有實際證據）

### 3.1 測試與語法

```
node --test                    → tests 149, pass 149, fail 0, duration 7814 ms
node --check（20 個 js/mjs）    → 全部 exit 0
```

- 單元覆蓋：schema 正規化／驗證、result 投影、config clamp、executable（含 Windows wrapper quoting）、stdio client（handshake、timeout、abort→cancelled、partial line、oversized line、protocol fallback、close/terminateSync）、mcp-session（分頁、去重、refresh）、workspace-pool（去重、單一 caller abort 不殺共享 session、maxClients、disposeAll）、tool-bridge（root 解析、fail-closed、isError、degraded schema）、plugin entry（註冊、list_changed re-sync、collision、缺 binary、agent 觸發重試、root fallback、unload 清理、failOnStartupError）。
- `test/integration.test.mjs`：真實 BaseMind 0.29.3 → 9 tools、protocolVersion `2025-06-18`、`serverInfo {name:'rmcp',version:'3.5.1'}`、resources 2 個、`admin status` 回報正確 root、`close()` 後 `waitForExit` 為 true（證明 terminate 真的執行）；缺 `basemind` 時 5 個案例自動 skip。

### 3.2 安裝

- `plugin_manager install_bundle`（target = workspace 絕對路徑）→ `application: applied`、`warnings: []`、`bundle: dsh-basemind-plugin 0.1.0`、`source: link:D:\02_zengjunlin\github\dsh-basemind-plugin`。
- profile `package.json` 由 plugin manager 寫入 `link:` 依賴；`cordis.patch.yml` **未被手動修改**；row `include:dsh-basemind` 由 bundle patch 產生，`plugin_manager list_plugins` 顯示 `enabled: true, fiberPhase: active`。
- `cordis_inspect_query Config.listConfigs({name:'dsh-basemind-plugin'})` → `entry include:dsh-basemind, status: "absent"`：即「無 Config schema」，符合計畫 §10.1 的預期，不是 load failure（fiber 為 active、工具可用）。

### 3.3 Runtime 實機驗證（已安裝的 Desktop profile）

> 範圍聲明：本節全部證據來自**已安裝的 Desktop profile**（`C:\Users\sanny\.dsh\profiles\desktop`，由 Desktop 安裝版 boot）。
> 官方 source checkout 的 `pnpm dsh web --patch` 與 `pnpm run dev:desktop` 另外在 §6.1 以真實模型驗證；
> 兩者是不同 surface，證據不互相推論。

| 驗收 | 證據 |
|---|---|
| 不新增 MCP row 即可用（A1） | 未建立任何 MCP row；`Tool` 清單出現 9 個 `mcp__basemind__*` |
| 9 個 domain tools（A2） | `admin, agents, code, git, graph, memory, shell, web, workspace`，schema 為 BaseMind 實際回報 |
| per-workspace routing（A3） | `admin {mode:'status'}` → `root = \\?\D:\02_zengjunlin\github\dsh-basemind-plugin`；`cd` 到臨時 git repo 後同工具 → `root = \\?\C:\Users\sanny\AppData\Local\Temp\basemind-routing-check`；`cd` 回 workspace 後 → 回到原 root（未重建索引） |
| resources（A4） | `list_mcp_resources {server:'basemind'}` → `basemind://status`、`basemind://repo/map`；`read_mcp_resource basemind://status` → JSON 內容 |
| instructions 進入 prompt（A5） | system prompt 的 MCP server section 出現 BaseMind 的 `initialize.instructions`（含「basemind first, shell/grep/git fallback」等原文），resource server 清單含 `basemind` |
| code outline 有實際內容 | `code {mode:'outline', path:'index.js'}` 回傳 6 個 symbol + 8 個 import（真實索引） |
| unload 清理（A7） | `set_plugin(enabled:false)` 後：runtime 的 MCP server 清單只剩 `context7`、工具 schema 消失、resource provider 消失；plugin 的兩個 relay process **皆已消失**（由 DSH Job 樹終止，非按名稱掃描） |
| 重新啟用 + 延後 discovery（§4.3 修正後） | `set_plugin(enabled:true)` 後 6 秒內 `basemind.exe` 數量為 **0**（`discoveryRoot: agent` 不啟動任何 relay）；新 agent 建立後才出現 1 個 relay（+ 其 `comms daemon`），9 工具、resource server、instructions 全部回來 |

- 啟動效能：實測 `initialize` 178 ms、`tools/list` 數十毫秒，遠低於計畫的 < 3 s 目標（不含 DSH 端 agent 建立時間）。
- schema token 成本：9 個 inputSchema 原始 29.4 KiB，正規化後 26.8 KiB（README 記錄約 30 KB）。

---

## 4. 實作期間發現並修正的兩個實質缺陷（計畫未預見）

### 4.1 兩個 workspace root 的第二個 relay 沒有工具清單（Critical，已修正）

- 現象：`cd` 到另一個 workspace 後第一次呼叫失敗，錯誤為
  `BaseMind tool admin is not exposed by the BaseMind version serving <root>`。
- 根因：`pool.clientFor(root)` 建立的第二個 session 只做了 `initialize`，沒有 `tools/list`；`ToolDefinition` 以 `session.hasTool()` 守門，而快取為空即誤判「該版本沒有這個工具」。
- 修正：`index.js` 的 `createSession` 在 handshake 後一律 `await session.listTools(poolSignal)`（每個 relay 一次，成本一次 `tools/list`）。
- 回歸測試：`test/index.test.mjs` →「routes each call to the relay of the calling workspace directory」。

### 4.2 以 deployment 預設目錄做 discovery root 在真實 profile 必然失敗（Critical，已修正）

- 現象：安裝後 fiber active、無任何工具、無 relay process。
- 診斷：以臨時診斷 bundle 在真實 host 內重現 → `ctx.workingDirectory.defaultDirectory = C:\Users\sanny\.dsh\profiles\desktop`，BaseMind 對「非 git repo 且無 `basemind.toml`」的 root 直接拒絕（exit 126）：
  `refusing to use ... as a basemind workspace root: it is neither a git repository nor a directory containing a basemind config`
- 根因：計畫假設 `defaultDirectory` 是一個專案目錄；實際是 profile 目錄。插件因此永遠重試同一個不可用 root。
- 修正：discovery 改為「候選 root 序列」——優先採用**最近一個 Agent 的 `workingDirectory.ensure()` 結果**（使用者真正選擇的目錄），其次才是 `defaultDirectory`；`agent/created` 會立即採用該 agent 的目錄並重試，backoff 仍保留為 fallback。碰撞檢查（collision）提前到任何 surface 註冊之前。
- 回歸測試：`test/index.test.mjs` →「adopts an Agent working directory when the deployment default is not a usable root」、「an agent creation retries a failed startup immediately」。
- 行為副作用（已寫入 README §5/§10）：比插件更早存在的 session 不會重新宣告自己，工具會在**下一個新 session 建立時**（或重啟 DSH）才出現。

### 4.3 程式碼審查後的兩項修正（本輪）

#### (a) `dsh web` 會用 launch directory 做初始 discovery root（Important，已修正）

- 審查指出：`@deepseek-ai/dsh-working-directory` README 明示「`defaultDirectory` 省略時使用 launch directory」；官方 `pnpm dsh web` 從 checkout 啟動時，該目錄是 git repo，BaseMind 會接受它。舊行為會在**任何 session 出現前**就對 harness checkout 啟動 `basemind serve` 並索引它。
- 已核實：上述 README 原文（`...omission uses the launch directory`）；舊 `candidateRoots()` 無條件加入 `defaultDirectory`。
- 修正：新增 `discoveryRoot` 設定，預設 **`agent`**：
  - `agent`（預設）：只用 Agent 的 working directory；**第一個 session 出現前不 spawn 任何 relay**。`dsh web` 從 checkout 啟動時不會索引 checkout。
  - `agent-first`：Agent 目錄優先，其次 `defaultDirectory`（舊行為）。
  - `default`：只用 `defaultDirectory`（明確要 launch-directory discovery 的部署；含 agent 目錄在內皆不採用）。
  - 未知值 → 一個 warning + 回退 `agent`。無候選 root 時不排 retry（避免空轉）。
- 證據：
  - 單元：`test/index.test.mjs` →「the shipped discoveryRoot default starts nothing before a session exists」（200 ms 內 0 個 relay、0 工具；`agent/created` 後才註冊）、「discoveryRoot: default ignores Agent directories and stays on the deployment default」；`test/config.test.mjs` → 預設／三種合法值／非法值回退。
  - 實機（已安裝 profile）：重新啟用插件後 6 秒內 `basemind.exe` 數量為 **0**；建立一個新 session 後才出現 1 個 relay，且 `admin status` 回報 `root = \\?\D:\02_zengjunlin\github\dsh-basemind-plugin`。

#### (b) tools 註冊失敗時仍留下 instructions／resources（一致性，已修正）

- 審查指出：`tryInitialize` 先 `registerInstructions` / `registerResources`，再 `syncTools`；失敗後 relay 被 drop、但兩個 flag 不會回滾，可能留下「有 instructions/resources、沒有 tools」且 instructions 來自已被放棄的 root。
- 已核實：舊程式碼順序確實如此（`index.js`）。
- 修正：改為 **tools 註冊成功之後**才註冊 instructions 與 resource provider。collision 檢查本來就在兩者之前。
- 證據：單元測試「a failed tool registration leaves no instructions section and no resource provider」（fake registry 拒絕註冊 → 0 工具、0 section、0 provider）。
- 與計畫的差異：計畫 §11 允許「tools 為空時仍可註冊 resources/instructions」；現在空工具清單一律視為失敗並重試，不留下孤立 surface。

---

## 5. 與計畫的偏離（Deliberate deviations）

| 項目 | 計畫 | 實作 | 理由 |
|---|---|---|---|
| `--root` 參數 | §6.1 寫 `--root <absolute root>` | 一律 `--root .`，且 `cwd = root` | 已實測 BaseMind 接受相對 root；如此可完全避開 Windows `cmd.exe` wrapper 的引號限制（計畫 §15.3 第 1 項的延伸）。README 已說明 |
| Windows `.cmd` | §15.3 建議 wrapper，必要時要求 `.exe` | 實作為：`.exe` 直接 spawn；`.cmd`/`.bat` 走 `cmd.exe /d /s /c`，且 token 含空白或 `" % & | < > ^ ( ) !` 時**明確報錯**並要求在 `BASEMIND_BIN` 指向 `.exe` | 實測證明 libuv 會把內層 `"` 轉義為 `\"`，cmd.exe 無法接受；沒有可靠的一般解 |
| discovery root | §5.5/§7.11：primary 用 `defaultDirectory` | 新增 `discoveryRoot` 設定，預設 `agent`（只用 Agent working directory，session 出現前不 spawn）；`agent-first`＝Agent 優先再退回 `defaultDirectory`；`default`＝只用 `defaultDirectory` | 見 §4.2、§4.3(a)：`defaultDirectory` 在 `dsh web` 下是 launch directory（可能是 harness checkout） |
| collision 時機 | §7.11：先註冊 prompt/resources，再檢查 collision | 先檢查 collision，再註冊任何 surface；`syncTools` 成功後才註冊 instructions/resources | 避免 resources/prompt 指向沒有工具可用的來源（見 §4.3(b)） |
| `failOnStartupError` | 「sync preflight 失敗才讓 activation 失敗」 | `apply` 回傳 promise：launcher 無法解析時 reject；完整 handshake 一律背景 | `resolveExecutable` 是 async，真正的 sync preflight 不可能；此為誠實的最佳近似（README 已按實作描述） |
| `readVersion` | §6.7：診斷用，spawn 一次、背景 | 每個 plugin activation 背景探測一次，只寫 debug log | 補上計畫要求但未被消費的診斷能力 |
| 測試檔名 | §13.1 列 `index-sync.test.mjs` | `test/index.test.mjs` | 以真實 stdio client＋fixture MCP server＋fake ctx 做端到端 plugin entry 測試，涵蓋同一組情境 |
| fixture 位置 | §7 佈局把 fixtures 放 `test/` 下 | `fixtures/`（repo root） | Node 的 `--test` 會把 `test/**/*.mjs` 當測試檔收集；fixture MCP server 等待 stdin 會讓裸 `node --test` 永不結束。移出後 `node --test` 149/149 通過 |
| `lib/config.js` | 計畫已列 | 同計畫（由主 agent 實作） | — |

---

## 6. 驗證狀態（明確區分 mock smoke / real model / 未執行）

### 6.1 Host surface 驗證矩陣

官方測試環境於 2026-10-29 由另一個 Agent 建立完成：`D:\02_zengjunlin\DSH_TEST`，source checkout HEAD `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`（`dsh-v0.2.2-alpha.2`），runbook 與逐項證據都在該目錄。

| Surface | mock smoke | **real model**（真實 DeepSeek API） | 未完成項 |
|---|---|---|---|
| **已安裝 Desktop profile**（`C:\Users\sanny\.dsh`） | — | 見 §3.3（9 工具、routing、resources、instructions、unload、延後 discovery） | 視覺截圖（GUI 需授權 URL）；failure paths 未在此 profile 重跑（官方 Web 已驗證，見 §6.4） |
| **官方 source `pnpm dsh web --patch`** | 已做（該環境的既有證據：9 tools、root、`cd`、resources、instructions） | **已做**：9 工具、`admin status` root=project-a（`blob_count=2`）、`cd`→project-b、兩個 resources、instructions 8103 B、Plugin Manager **toggle=on**、停用/重新啟用與 relay 清理（`evidence\real-model-web.md`） | 無（failure paths 已補，見 §6.4） |
| **官方 `pnpm run dev:desktop`** | 已做（同上） | **已做**：9 工具、root=project-a、`cd`→project-b、兩個 resources、instructions、toggle off→on、relay 清理（`evidence\real-model-desktop.md`） | failure paths 未單獨重跑（同一 host 行為已在 Web surface 驗證） |

- mock smoke 與 real model 是兩套獨立證據：mock 只證明「surface 會把哪些 tools 送給模型」，real model 證明「模型真的會呼叫、且結果正確」。本表 real-model 欄位全部來自真實 API 呼叫（`DeepSeek-V4.1-Flash`），沒有用 mock 冒充。
- real-model 回合必要的環境修正：`DEEPSEEK_BASE_URL` 必須是 `https://api.deepseek.com/anthropic`（DSH 呼叫 `<base>/v1/messages`；`https://api.deepseek.com` 實測 404）。這是環境設定，與插件無關。
- 官方 Web 的 toggle-on 做法（本次實測）：把插件留在 `dsh.profile.bundles`，overlay 改成 id-targeted `config` 覆寫（不再 `insert`）；`--dump-config` 只出現 1 個 `id: dsh-basemind`，toggle 變 on 且 9 tools 正常。
- 重跑配方：`D:\02_zengjunlin\DSH_TEST\runbook.md` §4.2/§4.3/§5.1。

### 6.2 其餘未驗證項目

1. **Plugin Manager 的視覺呈現（A9）**：官方 Web 與 Desktop dev **已截圖確認** icon（深藍底白色 B）、title（BaseMind（工作區感知））、description 與 toggle 狀態；已安裝 Desktop profile 的 GUI 因需要 `dsh web` 授權 URL，未截圖。
2. **缺 binary（A6）與既有 `basemind` MCP row 的 collision（A8）已在官方 Web surface 驗證**（2026-10-29 審查後補做）：可丟棄的 `dsh-home-failure` profile、mock LLM、隔離的 `BASEMIND_DATA_HOME` / `BASEMIND_COMMS_DIR`。missing → 0 個 BaseMind tools、DSH 正常完成 3 個回合、warning `BaseMind startup failed … is not an executable file`；collision → 插件 inactive、只剩既有 MCP row 的 2 個工具、原 row 的 `mcp__basemind__admin` 呼叫成功。Desktop dev 未單獨重跑，殘餘風險見 §6.4。
3. **BaseMind 0.30 / 0.31 未實測**（本機 0.29.3；npm latest 0.30.0；GitHub 0.31.0）。設計上不做版本 gate，功能集合＝`tools/list` 實際結果。
4. **PTC preset（`run_code` 內嵌呼叫）的 `exec.agent`／`currentInitiator()` 行為未實測**（計畫 Q15）。實作為 fail-closed。
5. **remote/SSH workspace 未測**（計畫 §1.3 非目標）。
6. **packaged Desktop**（非 dev build）未測。
7. **`notifications/tools/list_changed`** 只以 fixture MCP server 驗證；真實 BaseMind 0.29.3 未觀察到此 notification。

### 6.3 Cache / registry 副作用（real-model 回合）

| 項目 | 結果 |
|---|---|
| 使用者決定的清理 | **只**刪除 `2edd1fb8…`、`0fbd3647…` 兩個預設 cache 目錄，合計 **256.16 MiB**；registry 未刪未改、未跑 `basemind cache gc` |
| project-a / project-b 是否回到預設 cache | **沒有**（清理後兩個 hash 一直不存在） |
| 兩個 real-model host 的資料 | 落在 `DSH_TEST\basemind-data-web` / `basemind-data-desktop`（各含 project-a、project-b）→ **host 隔離有效** |
| integration test 造成的預設 cache entry | `56d019bb…`（67,271,674 B，root = `%TEMP%\basemind-int-*`）已於審查後**只刪除該目錄**；registry 保留。test isolation 修復後重跑 `node --test` 未新增 entry；刪除後 cache 目錄數 21 → 20，之後未再變動 |
| registry | 54,053 B（mtime `14:16:28`）；刪除 `56d019bb…` 前後 size/mtime 完全相同。歷史上 `node --test` 造成的 +189 B 記錄仍在 registry，未手改 binary 檔 |
| 憑證 | `DSH_TEST\.env.local`（43 B，單行 `API_KEY=…`）已刪除；logs/evidence/scratch/config 掃描 `sk-…` → **0 個檔案**。同一把 key 曾出現在對話中，**輪換仍待使用者執行** |
| process | 測試 host 全部停止，6 個測試 port 全 free；只終止本次啟動的 process tree（PID），未按名稱掃描；測試 daemon 由 `basemind comms stop` 依 `BASEMIND_COMMS_DIR` 停止，無殘留 |

詳細 before/after：`D:\02_zengjunlin\DSH_TEST\evidence\cache-cleanup-2026-10-29.md`。

### 6.4 Failure paths（2026-10-29 審查後補做，官方 Web surface）

可丟棄 profile：`D:\02_zengjunlin\DSH_TEST\dsh-home-failure`（全新 `DSH_HOME`，未動既有 web/desktop profile）；mock LLM；`BASEMIND_DATA_HOME` / `BASEMIND_COMMS_DIR` 指向 case 專屬目錄。因為 DSH 預設只緩衝 plugin warning、不輸出到 stdout，測試 profile 額外插入一個 test-only log observer，把 `[dsh-basemind-plugin]` warning 鏡射到 stderr；observer 不在被測插件內。

| 案例 | 結果 | 證據 |
|---|---|---|
| control（真實 basemind） | 第二個回合 44 tools / 9 個 `mcp__basemind__*`；證明同一 profile 會載入插件 | `evidence\failure-control.json`、`logs\failure-control.log` |
| missing binary（`command` 指向不存在路徑） | host 正常 boot、3 個 mock 回合全部完成；32 tools / **0** BaseMind tools；plugin row `enabled: true, fiberPhase: active`；warning `BaseMind startup failed … is not an executable file` | `evidence\failure-missing.json`、`logs\failure-missing.log`、`evidence\failure-session-audit.json` |
| collision（既有 `serverName: basemind` MCP row） | plugin row active 但 registration inactive；第二回合 37 tools / **只有既有 row 的 2 個工具**（`admin`、`code`）；warning `… staying inactive to avoid duplicate tools`；原 row 的 `mcp__basemind__admin` 呼叫回 `isError: false` | `evidence\failure-collision.json`、`logs\failure-collision.log`、`evidence\failure-session-audit.json` |

- 判定：A6「缺 binary 時 DSH 仍可用」與 A8「同名 MCP row 不重複註冊」已在官方 surface 取得證據。
- 限制：Desktop dev 未單獨重跑 failure paths（需要另一個可丟棄 Electron profile 的 install+boot 週期）；Web 與 Desktop 共用同一個 host plugin 載入路徑，但這不是 Desktop 的直接證據。
- 重跑配方：`D:\02_zengjunlin\DSH_TEST\scratch\failure-web-driver.mjs` + `failure-{control,missing,collision}.yml`；細節見 `evidence\failure-paths-2026-10-29.md`。

---

## 7. 環境衛生與回復

- 執行期間建立的臨時目錄（`%TEMP%\bmspike`、`dsh-basemind-probe`、`basemind-routing-check`、`ndtest`、暫存 log/result）全部已刪除。
- 早期手動 spike 遺留的 2 個 `basemind` process（PID 16900、32796，09:55 啟動，路徑為 Volta 安裝的 `basemind.exe`）由本報告作者以 **PID** 明確終止；插件自身 spawn 的 relay 只在 unload 時由 DSH provider 終止，從不按名稱掃描或殺 process。
- 另有一個 relay（PID 32080/10116）是作者以強制終止中斷逾時的 `node --test` 當下留下的：測試 teardown 沒機會執行，屬測試中斷的預期副產物，已按 PID 清除。單獨重跑 `test/integration.test.mjs` 前後 `basemind` process 集合完全相同（5/5 pass），證明測試本身不洩漏 relay。
- 最終 `basemind` process 僅剩插件為本 workspace 建立的 relay 及其 `comms daemon`（每次 reload 後 PID 會變；以 `Get-CimInstance Win32_Process -Filter "Name='basemind.exe'"` 觀察到 1 個 relay + 1 個 daemon），符合計畫 §2.2/§9.5 對 BaseMind 程序樹的描述。
- 插件最終狀態：`include:dsh-basemind` **enabled、fiber active**，profile 內無任何新增或修改的 MCP row；測試用的 probe bundle 已 `remove_bundle` 完全移除。
- 審查後新增的測試隔離：每次 `node --test` 使用 `%TEMP%\basemind-test-*`，test data home 在 suite 結束時刪除；測試 daemon 以 `basemind comms stop` 搭配 `BASEMIND_COMMS_DIR` 停止，避免繼承 stdio 造成 test worker 懸置。重跑後預設 cache/registry 未變。
- 未提交任何 git commit。

---

## 8. 重現指令

```powershell
# 在 D:\02_zengjunlin\github\dsh-basemind-plugin
node --check index.js        # 以及 lib\*.js
node --test                  # 149 tests / 149 pass；integration 自帶 BaseMind 資料隔離，缺 basemind 時自動 skip

# 安裝（由 plugin manager 執行，不手寫 profile 設定）
# plugin_manager install_bundle, target = D:\02_zengjunlin\github\dsh-basemind-plugin
```

Runtime 檢查（在 DSH 內）：

- `mcp__basemind__admin {mode:'status'}` → `root` 應等於目前 session 的 workspace
- `list_mcp_resources {server:'basemind'}` / `read_mcp_resource {server:'basemind', uri:'basemind://status'}`
- `cd` 到另一個 repo 後再呼叫 `admin status`，`root` 應切換

---

## 9. 剩餘風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| 既有 session 不會取得工具，直到有新 session | 安裝後當下看起來「沒有工具」 | 預設 `discoveryRoot: agent` 的設計即如此；README §5/§10 明示，開新 session 或重啟 DSH |
| `dsh web` 從 harness checkout 啟動時索引該 checkout | 不必要的索引與慢啟動 | **已修正**：預設 `agent` 不 spawn、不索引 launch directory；只有明確選 `agent-first`/`default` 才會 |
| 既有 `basemind` MCP row 與本插件同時啟用 | 其中一方工具註冊失敗（load order 決定哪一方） | 插件偵測同名工具後保持 inactive；README 要求先停用舊 row |
| 每個 workspace root 一個 relay，`comms daemon` 可能共享 | unload 時 daemon 被一起終止 | v1 只在 unload 時 terminate；BaseMind 會重建；實測 unload 後無殘留 process |
| Windows `.cmd` launcher 只能無空白/無中介字元 | 某些安裝路徑下無法啟動 | 明確錯誤訊息指向 `BASEMIND_BIN` 的 `.exe`；README 已記錄 |
| 兩套 relay 對同一 repo 的不同子目錄各自建索引 | 記憶體／索引重複 | 計畫 §9.6 已接受；`maxClients` 保護 |
| 9 個大 schema 隨每次請求送出 | context 成本約 30 KB | README 記錄；未來可評估 `deferLoading`（非 v1） |
| 測試 API key 曾出現在對話與 `DSH_TEST\.env.local` | 任何取得對話或舊檔的人可使用 | `.env.local` 已刪除；**輪換 key** 仍待使用者於 provider 端執行 |
| Desktop failure paths 未單獨重跑 | Desktop 的直接 failure-path 證據缺一角 | 已在官方 Web surface 完成；Desktop 與 Web 共用 host plugin 載入路徑，必要時用 `dsh-home-failure` 的同一 overlay 重跑 |
| `readVersion` 的 `--version` 診斷失敗 | 只影響診斷 log，不影響工具 | 已修正 `spawn` 的 receiver 綁定並加回歸測試 |
