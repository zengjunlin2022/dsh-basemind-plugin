# dsh-basemind-plugin 0.2.0：官方 Pi / Skills / Binary Manager 整合計畫

- 日期：2026-11-24
- 角色：Investigation + Planning（本文件為 Plan，不是 Execution Report）
- 交付版本：**維持 `0.2.0`，不升版**（第四輪裁決）。0.2.0 從未發布，本次是同一交付的同步擴充，不是新版本
- 基線：`dsh-basemind-plugin` **0.2.0**（`main` @ `f278d6c`，工作樹乾淨，`package.json` index 版本已是 0.2.0；尚無 `v0.2.0` tag）
- 上游目標版本：**BaseMind v0.34.0**（tag `v0.34.0`，commit `8e7b149`，published 2026-11-23T06:56:23Z）
- DSH 基線：**0.2.2-rc.5**（`app.asar` 內 `dsh/package.json:4`、`dsh-app-boot/package.json:4`；cordis 4.1.0）
- 狀態：**規劃完成，等待人工確認。未修改任何產品程式碼，未 commit／tag／push／publish**

---

## 1. Executive Summary

### 1.1 結論

現有 0.2.0 已經是一個**可運作且契約正確**的 Workspace-aware MCP Bridge；本次不重寫，只在它上面加四層能力，並補一條可重複執行的上游同步管線：

| 層 | 內容 | 主要新檔案 |
|---|---|---|
| A. 上游版本來源 | 單一 `UPSTREAM` 常數（版本／tag／commit／asset 對照／checksums 檔名／skills 清單） | `lib/upstream.js` |
| B. Binary Manager | Local First 候選矩陣、版本探測、版本相容判定、官方 Release 下載、SHA256、安全解壓、跨 Session／跨 Process 緩存 | `lib/binary/*.js` |
| C. Skills Provider | 用 DSH 原生 `ctx.skills.registerProvider()` 註冊 10 個官方 Skills（低優先序），可用性與 Binary 一致 | `lib/skills/provider.js`、`skills/**` |
| D. Bootstrap + CLI Adapter | 一段與官方 MCP instructions **不重複**的動態 prompt section；一個 argv-only、allowlist 的 CLI 工具，永遠使用與 MCP 相同的 Binary | `lib/prompt/bootstrap.js`、`lib/cli-tool.js` |

### 1.2 四個關鍵技術判斷（皆有證據，見 §2–§4）

1. **不需要複製 Pi 的「compaction 後重新注入」機制。** DSH 的 system prompt 是「每次 model step 重新組裝」（`dsh-agent-loop/src/agent.ts:298-300` 呼叫 `systemPrompt.assemble(...)`），section 來自 registry 而非 session log，所以 compaction（改寫 session events）不會刪掉它。Pi 之所以要 `session_compact → injectBootstrap = true` 再插入訊息，是因為 Pi 的擴展只能改「outgoing messages」。**在 DSH 加入等效重注入只會製造重複**。
2. **Skills 不需要自己寫 catalog／載入器。** DSH 已有 `dsh-skill`（registry）+ `dsh-skill-filesystem`（本地來源）+ `dsh-tool-skill`（`skill` 工具與 durable `<available_skills>` catalog）。插件只要 `ctx.skills.registerProvider()`，就會自動享有「只注入 name+description、body 按需載入、變更時 append 替換 catalog」的漸進揭露。
3. **版本相容的預設必須是 exact-version（0.34.0），不是官方 launcher 的 same-minor。** 理由是本次新增的 Skills 是逐字對應 0.34.0 的 tool 名稱與 CLI 契約；0.34.x 的其他 patch 只有在上游聲明 blob/index 相容且我方實測通過後才可直接用（§9）。這與官方 launcher 的 minor 規則不同，屬**有意偏離**，理由與代價寫在 §9.2。
4. **Managed Binary 必須與用戶全域 Binary 共用 `BASEMIND_DATA_HOME`（預設）。** 因為 index／memory／document store 是資料層而非 binary 層；切換 Data Home 會讓用戶原本的記憶與索引「消失」（`docs/manual/data.md:33` 明確說明 `BASEMIND_COMMS_DIR` 不受 `BASEMIND_DATA_HOME` 管轄，兩者必須分別設定）。代價是必須正面處理「新舊版本搶同一個 repository group」的升級窗口（§11），不能靠隔離閃避。

### 1.3 三項偏離／新增（D2 已於第三輪裁決：預設下載）

| # | 需求寫法 | 本計畫的最終決定 | 理由 |
|---|---|---|---|
| D1 | §7.2 候選順序：explicit → PATH → 緩存 → 下載 | 照列，但**每個候選先做版本判定，不相容就往下**；PATH 不相容時不會中止，只警告後落到下一個候選 | 需求 §7.4 要求「本地 0.33.x → 不相容」；若嚴格「先命中 PATH 即用」會與版本判定衝突。此解讀亦符合官方 launcher 的實際行為（候選必須 exact match 才 `exec`） |
| D2 | 未明示自動下載預設值 | **已裁決（第三輪）：預設下載，`binaryDownload: true`。** 正當性不靠「需求有寫」，而靠三件事：①它只寫入**插件自管快取** `$DSH_HOME/cache/dsh-basemind-plugin/`（可整目錄刪除、不碰 BaseMind 資料目錄、不碰專案、不執行任何安裝程式）；②`cordis.patch.yml` **顯式**寫出 `binaryDownload: true`，不靠隱含預設；③CHANGELOG 的 `Changed` 第一條就是它 | 使用者裁決（第三輪）。與 AGENTS.md 的張力以**精確化紀律**而非繞過紀律解決：AGENTS.md 新增一條，把「啟動副作用」分兩類——寫入使用者資料／專案狀態（一律禁止，`autoProvision:false` 維持）vs 寫入插件自管快取（允許，但必須顯式、可停用、失敗不阻塞）。<br>**若日後被否決**：退路是預設 `false` + 首次啟動一次性提示（給可複製指令），**不得**做成「預設 false 且靜默」。只有在「使用者群體全是既有 basemind 開發者（本地優先永遠命中）」時預設 false 才更乾淨，而此假設無數據支持 |
| D3 | 未提及狀態顯示 | **新增需求**：配置頁顯示「本機是否存在 basemind／版本／是否相容」。查證後 GUI 無 Host-only 呈現面（§7.5），**已裁決（第四輪）：採 A + B** —— 原生 `/basemind-status` 指令 + Plugins 頁靜態文檔；真·配置頁卡片（client half）列為獨立後續項目 | 第四輪裁決。不新增 client half，維持 Host-only 與零建置定位；README／locale 不得宣稱 GUI 內有狀態卡片 |

### 1.4 交付規模（估計）

- 新增 runtime 檔案 10 個（含 `lib/status.js`）、新增腳本 1 個、vendored skills 10 組（上游 1,557 行 + 1 份 provenance）；修改 8 個既有檔案（`index.js`、`lib/config.js`、`lib/executable.js`、`package.json`、`cordis.patch.yml`、`scripts/check-pack.mjs`、`AGENTS.md` + 文件）。
- 新增／擴充測試檔 8 個，新增測試案例約 70–90 個（含 20 個 Binary Manager 決策案例、約 20 個下載／解壓案例、9 個 Skills、9 個 Bootstrap／Lifecycle、6 個狀態指令）。
- **因 `binaryDownload:true` 為預設**，Phase 2 的下載器是**預設路徑**而非 opt-in：實機驗收同時涵蓋「本地命中、0 次網路」與「首次自動安裝」以及「下載失敗時的降級診斷」三條路徑（§19 的 D2／D3／D4）。
- 交付目標版本：**維持 `0.2.0`（不升版）**。0.2.0 尚未發布，本次擴充與既有的 0.34.0 適配屬**同一個交付**；`package.json` 的 `version` 不動，CHANGELOG 的新內容歸入既有的 `[0.2.0]` 條目（詳見 §24.1）。

---

## 2. 官方 Pi Extension 功能分析

依據：上游 tag `v0.34.0` 的 `.pi/extensions/basemind.ts`（127 行）。`opencode-plugin/.pi/extensions/basemind.ts` 與它 **byte-identical**（md5 相同，`diff` 無輸出）。

### 2.1 實際結構（逐段）

| 行 | 作用 |
|---|---|
| 1–11 | 由 `import.meta.url` 推導 `<packageRoot>/skills`，bootstrap 檔案固定為 `<packageRoot>/skills/basemind/SKILL.md` |
| 13 | 模組級 `cachedBootstrap`（`undefined` 未讀、`null` 讀取失敗、字串已快取） |
| 15–52 | 匯出的 extension factory；5 個事件：`resources_discover`、`session_start`、`session_compact`、`agent_end`、`context` |
| 54–76 | `getBootstrapContent()`：讀 `SKILL.md`、去 frontmatter、包上固定信封與 `piToolMapping()` |
| 78–81 | `stripFrontmatter()` |
| 83–104 | `piToolMapping()`：把 MCP 工具能力改寫成 CLI 動詞敘述 |
| 106–119 | `messageContainsBootstrap()`：以 marker 字串掃描 outgoing messages |
| 121–127 | `firstNonCompactionSummaryIndex()`：找第一個非 `compactionSummary` 的索引 |

### 2.2 Skills Discovery

兩条路徑並存：

1. **套件 manifest**：repo 根 `package.json` 的 `pi` 區塊（`extensions`、`skills`），`plugin/package.json` 甚至逐條列出 10 個 skill 目錄。
2. **擴展回報**：`pi.on("resources_discover", () => ({ skillPaths: [skillsDir] }))`，回傳的是**目錄**，由 Pi 自己遞迴走訪（不是 glob）。

**DSH 對照**：DSH 的對應物是 `SkillProvider.list()` 回傳候選（§4.2），目錄走訪由 `dsh-skill-filesystem` 負責，插件不需要自己 walk。→ 採用 provider，不採用目錄掃描。

### 2.3 Bootstrap 載入

- 內容 = `<EXTREMELY_IMPORTANT>` + marker + 一段說明 + **`skills/basemind/SKILL.md` 去掉 frontmatter 的全文** + `piToolMapping()` + `</EXTREMELY_IMPORTANT>`。
- 也就是 **bootstrap 等於把整份 umbrella skill 正文塞進對話**（該檔 238 行 / 13,943 B）。
- 讀取失敗 → `null`，整段 bootstrap 消失（靜默降級，不 fallback 成「請執行 basemind」）。

**DSH 對照**：DSH 的等價物是「供給 description，body 用 `skill` 工具按需載入」。把 238 行正文固定注入每次請求，與需求 §5.1「不將全部 Skills 的正文注入每次模型請求」直接衝突。→ **不移植**。

### 2.4 Session 生命週期

| 事件 | 動作 |
|---|---|
| `session_start` | `injectBootstrap = true`（重新武裝） |
| `session_compact` | `injectBootstrap = true`（重新武裝） |
| `agent_end` | `injectBootstrap = false`（解除武裝，避免每個 turn 都檢查） |
| `context` | 若武裝且 messages 內沒有 marker → 在 `firstNonCompactionSummaryIndex()` 位置插入一則 `role: "user"` 訊息 |

### 2.5 Bootstrap 去重

- **Key**：字面量 `"basemind:using-basemind bootstrap for pi"`，寫在注入文字裡。
- **掃描範圍**：整份 outgoing `messages`（字串或 `{type:'text'}` part 都掃）。
- **生命週期**：`injectBootstrap` 是唯一狀態，`agent_end` 之後就不再掃描，因此「每個 session／compaction 視窗最多注入一次」。
- **內容快取**：`cachedBootstrap` 模組級、**永不失效**（不因 `session_start`／`session_compact` 重讀），所以 0.34 之前的檔案內容在同一 process 內不會更新。

### 2.6 Compaction 後的上下文恢復

機制完全依賴「插入在 summary 之後」：

```
messages = [compactionSummary*, bootstrapMessage, 其餘訊息]
```

`firstNonCompactionSummaryIndex()` 跳過所有 `role === "compactionSummary"`。**這是 Pi 的 message 陣列模型特有的作法**。

### 2.7 Pi 專屬 Tool Mapping

`piToolMapping()` 的內容是一段「Pi 沒有原生 MCP，請用 bash 跑 CLI」的敘述，列出 6 條 CLI 動詞（`code outline/symbols/refs/callers/grep`、`git recent/blame`）＋ `rescan`／`scan` 建議。**沒有** per-tool 對照表，也沒有 `Read→code_read` 這種 shim；本質是「用敘述替換工具面」。

（附註：該段文字宣稱 "pi has no native MCP"，但 pi coding agent 1.6.0 已提供 `registerMcpServer`；此敘述對當前 Pi 已過時。這是「參考設計、不要照抄文案」的另一個理由。）

### 2.8 對本計畫的啟示（保留／不保留）

| Pi 設計 | 是否移植 | 理由 |
|---|---|---|
| Skills 由套件提供、不需用戶安裝第二套 | 保留（改用 provider） | 需求 §5.1 |
| Bootstrap 只用於「第一次讓 agent 知道有這層能力」 | 保留概念 | 需求 §6.1 |
| marker 字串去重 | **不移植** | DSH 的 section 由 registry 組裝，天然只有一份；字串比對是脆弱的補救 |
| compaction 後重新注入 | **不移植** | §1.2 第 1 點 |
| `agent_end` 解除武裝 | **不移植** | 同上（沒有每 turn 掃描的成本） |
| 整份 SKILL.md 注入 | **不移植** | 需求 §5.1 明令禁止 |
| `piToolMapping()` 敘述式替代 | **部分移植** | 改成「CLI 動詞 → `mcp__basemind__cli` 工具」的短映射（§14） |
| 內容快取永不失效 | **不移植** | 我們的 skills 內容隨 binary 版本變，需可失效（用 `control.invalidate()`） |

---

## 3. 官方 OpenCode / Launcher 功能分析

### 3.1 `opencode-plugin/binary-check.js`（159 行）

| 面向 | 官方行為 | 出處 |
|---|---|---|
| 探測方式 | 執行 `basemind --version`；Windows 用 `shell: true` + `file: "basemind --version"`（因為 `pnpm add -g` 會放 `.cmd`／`.ps1` shim，只有 shell 能解析） | `:43-46` |
| 探測超時 | **5000 ms** | `:18-19` |
| 版本解析 | `/^(\d+\.\d+)\./` → `major.minor`；`0.33.1`、`0.33.0-rc.2` 都得 `0.33`；不匹配 → `null` | `:26-29` |
| 期望版本來源 | 自己的 `package.json.version` | `:21-24` |
| 相容規則 | **same minor**（`versionMinor(found) === versionMinor(expected)`），不是 exact、也不是 semver range | `:151-154` |
| Binary 來源 | **只看 PATH**，不支援 `BASEMIND_BIN` | `:86-92` |
| 找不到的判定 | `error.code === "ENOENT"`，或 Windows 退出碼 `9009` | `:36, :49-51` |
| Windows 進程清理 | `taskkill /pid <pid> /T /F`（連 `cmd.exe` 一起殺） | `:62-64, :77-81` |
| Unix 進程清理 | `process.kill(-child.pid, "SIGKILL")`（自成 process group），失敗才 `child.kill` | `:67-76` |
| stdout 上限 | 4096 bytes | `:93-97` |
| stderr | 直接 drain 丟棄 | `:98` |
| 結果 | `{status: "ok"｜"missing"｜"mismatch", message}`，**永不 reject** | `:116-159` |
| 版本不匹配的處理 | **不阻擋**：`mismatch` 仍註冊 server，只印一行 stderr；`missing` 才不註冊 | `basemind.js:99-110` |

**對本計畫的採用**：採用「探測永不 throw、失敗回傳結構化狀態」與「版本不匹配要能診斷」；**不採用** same-minor 作為預設（§9.2）、不採用 shell 字串呼叫（我們用 `argv` + `buildLaunchArgv` 的既有 `.cmd` 包裝規則）、不採用「mismatch 仍照用」（需求 §7.4 明確要求 fallback）。

### 3.2 `plugin/scripts/mcp-launch.sh`（628 行）+ `mcp-launch.cmd`（31 行）

**`.cmd` 是 polyglot trampoline**：`cmd.exe` 段負責尋找 Git Bash（`CLAUDE_CODE_GIT_BASH_PATH` → `%ProgramFiles%\Git\bin\bash.exe` → …），再呼叫 `.sh`。找不到就 `die`，訊息點名安裝 Git for Windows。

**版本解析**：`BASEMIND_FORCE_VERSION` 優先，否則從 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、`.cursor-plugin/plugin.json` **第一個存在的** 取 `version`（`sed`）；三者皆無 → `die`。也就是**這個 launcher 不能在 DSH bundle 內原樣重用**（缺這三個 manifest 之一就會死）。

**候選順序**（`:315-342`）：

1. `BASEMIND_BIN`（fallback `BASEMIND_BINARY`）：**不管版本，直接 exec**（"an explicit operator pin — honour it whatever version it reports"），只印一行警告。
2. 緩存 `$CACHE_ROOT/basemind[.exe]`：**exact** `--version` 相等才用。
3. `$LAUNCH_ROOT/bin/basemind`：exact。
4. `PATH` 上的 `basemind`：exact；**版本不同就被靜默跳過並改為下載**。
5. 下載。

**快取佈局**：`${XDG_CACHE_HOME:-$HOME/.cache}/basemind/versions/<VERSION>/`，附 `.last-used` 標記；`PRUNE_AFTER_DAYS` 預設 14；`STALE_INSTALL_MINUTES = 10` 視為廢棄的 `.lock-*`／`.staging-*`。

**平台／架構 → asset**：`uname -m` + `uname -s`；只有三個 triple：

| 平台 | triple | 副檔名 |
|---|---|---|
| macOS arm64（含 Rosetta 判定） | `aarch64-apple-darwin` | tar.gz |
| macOS x86_64 | **`die`：不支援 Intel macOS** | — |
| Linux aarch64/arm64 | `aarch64-unknown-linux-gnu` | tar.gz |
| Linux x86_64/amd64 | `x86_64-unknown-linux-gnu` | tar.gz |
| MINGW/MSYS/CYGWIN/Windows_NT（不論架構） | `x86_64-pc-windows-msvc` | zip |

**URL 與校驗**：`https://github.com/Goldziher/basemind/releases/download/v<VERSION>/basemind-<triple>.<ext>` 與 `…/basemind_<VERSION>_checksums.txt`。校驗用單一合併 checksums 檔，以最後一個欄位比對（去掉開頭 `*`）；`sha256sum` → `shasum -a 256` → **兩者皆無就 die**。**校驗不符是 hard die**，而下載／取 checksums 失敗走 `fallback_or_die`。

**解壓**：staging 目錄 → `tar -xzf`；zip 依序試 `unzip -qo`、`tar -xf`、`powershell Expand-Archive`。要求 binary **在壓縮檔根目錄**，否則 `die`。安裝是 `rm -rf $CACHE_ROOT && mv $STAGING $CACHE_ROOT`（非嚴格原子，但同一 filesystem）。

**併發**：以目錄鎖 `$PARENT/.lock-$VERSION`（`mkdir` 成功即持有），輪詢 0.2 s，約 120 s 後視為 stale 破鎖；`trap EXIT/HUP/INT/TERM` 確保任何中斷都不留鎖（0.34.0 release notes 明列這是修復項）。

**離線**：`BASEMIND_OFFLINE` 為 true 時，只接受「same-minor 且 ≥ `MIN_SAFE_VERSION`(0.26.0)」的最新緩存，否則 `die` 並給三條補救。`MIN_SAFE_VERSION` 是所有 fallback 路徑的地板（理由是舊版 daemon RSS 無上限）。

**`BASEMIND_FORCE_VERSION` 的真實語義**：**內部專用**——只有 release-window fallback 會 `exec env BASEMIND_FORCE_VERSION=<cand> "$0"` 重跑自己，去安裝「同 minor 的最新已發布版本」。它不是給使用者用的旋鈕。

**鏡像**：`BASEMIND_RELEASE_BASE_URL` 僅允許 `https://`、`file:///` 或 loopback `http://`；裸 `http://` 直接拒絕。鏡像佈局必須與 GitHub 相同（`<base>/v<ver>/…` + checksums 檔）。

**launcher 讀到的環境變數完整清單**（7 個）：`BASEMIND_BIN`、`BASEMIND_BINARY`、`BASEMIND_FORCE_VERSION`、`BASEMIND_HOST`、`BASEMIND_OFFLINE`、`BASEMIND_PRUNE_AFTER_DAYS`、`BASEMIND_RELEASE_BASE_URL`（＋ `XDG_CACHE_HOME`、`HOME`、各 host 的 `*_PLUGIN_ROOT`）。**不讀** `BASEMIND_DATA_HOME`／`BASEMIND_COMMS_DIR`。

### 3.3 Release v0.34.0 的真實資產（GitHub API，release id 455033002）

| # | Asset | 大小 | 平台 |
|---|---|---|---|
| 1 | `basemind-aarch64-apple-darwin.tar.gz` | 88,184,663 | macOS arm64 |
| 2 | `basemind-aarch64-unknown-linux-gnu.tar.gz` | 102,161,826 | Linux arm64 |
| 3 | `basemind-x86_64-unknown-linux-gnu.tar.gz` | 92,214,847 | Linux x64 |
| 4 | `basemind-x86_64-pc-windows-msvc.zip` | 75,627,742 | Windows x64 |
| 5 | `basemind_0.34.0_checksums.txt` | 420 | 合併 checksums（僅含上述 4 個 archive） |
| 6 | `basemind-plugins-v0.34.0.tar.gz` | 334,378 | 其他 harness 的 plugin 打包（本次不使用） |
| 7 | `basemind-plugins-v0.34.0.tar.gz.sha256` | 98 | 同上的 sidecar |

Checksums 檔實際內容（4 行、`sha256sum` 兩空格格式、**不含** plugins tarball）：

```
7f4c954228e38d37bef397484efcdb4598bf80885bd7b8d65366bcfb883932e8  basemind-aarch64-unknown-linux-gnu.tar.gz
a445dcd803391bea82b5c784ed99e49285d726be9194929548cb62a308eec73a  basemind-x86_64-unknown-linux-gnu.tar.gz
ce5ead4dd53f9242539cb87e180451e95676ea82f9b0f04364c9abedec7cadb4  basemind-x86_64-pc-windows-msvc.zip
e865aa6dbb6e898a2f3894df702097313926952207e8a51fb3956240e17c4393  basemind-aarch64-apple-darwin.tar.gz
```

**明確結論**：沒有 macOS x86_64（Intel）、沒有 Windows arm64。專案既有 `.github/workflows/compat.yml` 的 asset 名稱與「macOS 只有 aarch64」註解與此完全一致（該 workflow 已存在，非本計畫新增）。

---

## 4. DSH 原生 API 可行性及實際證據

證據來源三類：
(a) 本 process 的 live introspection：`cordis_inspect_query`（host `Service` / `Event`）；
(b) 安裝中的 `app.asar` 內 `dsh/node_modules/@deepseek-ai/*` 的 `src/*.ts` 原文（以 header-JSON 解析器抽取）；
(c) 現有插件程式碼與其測試。

### 4.1 生命週期／effect／注入

| 能力 | 結論 | 證據 |
|---|---|---|
| `ctx.effect(execute, label?)` | 呼叫時立即執行；回傳的 disposer 在 fiber 卸載時**逆序**執行；重複呼叫 no-op | `cordis/src/fiber.ts:408-424, 437-446` |
| `ctx.on(name, listener)` | 回傳 disposer；fiber 卸載時自動移除 | `cordis/src/events.ts:286-307` |
| `ctx.on('dispose')` | **不存在**（全 `@deepseek-ai/*/lib` grep 0 命中） | 同上；清理只能靠 effect／回傳 disposer |
| optional inject 宣告式 | **不存在**（`Inject = string[] \| Record<string, intercept>`；每個名字都必須解析） | `cordis/src/registry.ts:19`、`fiber.ts:617-628` |
| 取得可選服務 | `ctx.get('skills')`（Service catalog 直接以此作為 "optional access"） | live `skills` service `access.optional.expression = ctx.get("skills")` |
| 現有插件作法 | `inject = ['tools','subprocess','workingDirectory','systemPrompt']` ＋ `ctx.get('mcpResources')`／`ctx.get('agents')` | `index.js:29, 170, 175` |

→ **新增 `skills` 依賴必須走 `ctx.get('skills')`**，不能加進硬性 `inject`（否則沒有掛載 skills 的 profile 會整個插件不啟動）。

### 4.2 Skills registry（功能 A 的核心）

live 契約（`cordis_inspect_query` → `Service.listService("skills")`）與原始碼逐字一致：

```ts
registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void
register(skill: SkillRegistration): () => void
async list(options: SkillViewOptions = {}): Promise<SkillSummary[]>
async snapshot(options: SkillViewOptions = {}): Promise<SkillCatalogSnapshot>
async get(name: string, options: SkillViewOptions = {}): Promise<SkillDefinition | undefined>

interface SkillProvider { name; list(options): Promise<readonly SkillCandidate[] | SkillProviderObservation>; get(candidate, options): Promise<SkillDefinition | undefined> }
interface SkillProviderControl { signal: AbortSignal; invalidate(): void }
interface SkillSummary { path?; name; description; whenToUse?; invocation; source; provider; resourceBase? }
interface SkillCandidate extends SkillSummary { rank: number; locator: unknown; metadata? }
type SkillResourceBase = {kind:'directory',path} | {kind:'url',url} | {kind:'opaque',description}
```

（`dsh-skill/src/index.ts:43-100, 247-275, 390-517`；`BUNDLED_SKILL_RANK = 600`、`RUNTIME_RANK = 250`。）

**合併與衝突規則**（`dsh-skill/src/index.ts:345-355` 註解 + `:551-581` 實作）：註冊進入「呼叫端 context 的 scope layer」；讀取時合併 global + 檢視 scope 鏈，**較近的 layer 直接勝出**；同一 layer 內依序比 `rank`（小者勝）→ provider 註冊順序 → provider 內部順序。provider 名稱 `'runtime'` 保留。

**filesystem provider 的 rank 表**（`dsh-skill-filesystem/src/index.ts:35-39, 256-268`）：

| rank | source | 根目錄 |
|---|---|---|
| 100 | `project-dsh` | `<project>/.dsh/skills` |
| 200 | `project-agents` | `<project>/.agents/skills` |
| 300 | `custom` | 設定的額外目錄 |
| 400 | `user-dsh` | `$DSH_HOME/skills` |
| 500 | `user-agents` | `~/.agents/skills` |
| 600 | `bundled` | 套件內建（`dsh-doc`、`office` 等） |

**模型端體驗**（`dsh-tool-skill/README.md` + `src/index.ts`）：`skill` 工具存在時，會在第一個請求前發布一則 durable user-role catalog，只含 **name + 截斷到 `catalogDescriptionMaxLength`（預設 500 字）的 description**；`skill({name})` 回傳 `<skill_content>`；成員／描述／可見性變更時 **append 替換 catalog**；全部移除時 append 空 catalog 以撤銷舊名稱。

→ **需求 §5.1 的「按需載入、不注入正文」在 DSH 是既有能力，不需自製。**

### 4.3 System prompt 組裝（功能 B 的核心）

```ts
interface PromptSection { name; order; text: string | ((ctx: AssembleContext) => string); interpolate?: boolean; complete?: boolean }
interface PromptContext  { name; order; text: ...; interpolate?; required? }
interface AssembleContext { scope?: ScopeKey; signal?: AbortSignal }
section(section): () => void        // 同一 layer 內同名 duplicate 會 throw；scoped 會 shadow global
getSectionOrder(name): number       // MCP_SERVERS = 3100
context(context): () => void        // 動態事實（user-role snapshot，每 request attempt refresh）
variable(name, provider): () => void
```

證據：`dsh-system-prompt/src/index.ts:42-90, 136-209, 485-696`。

**三個決定性事實**：

1. **每次 model step 重新組裝**：`AgentLoop.preStep()` → `await systemPrompt.assemble({ ...assembleContextFor(agent, signal), modelSelection, toolSet })`（`dsh-agent-loop/src/agent.ts:298-300`），結果以 `system/message` 形式寫入 session surface。
2. **`scope` 就是 Agent**：`assembleContextFor` 設 `{ agent, scope: agent, signal }`（`dsh-agent/src/dispatch.ts:174-176`），而 Agent 自身即 ScopeKey（`dsh-scope`）。→ section 的 `text` 函式**可以依 agent 給不同內容**。
3. **compaction 只改寫 session events**，section 來自 registry，下一步重新組裝即恢復。→ 需求 §6.2 的「若 DSH 已能在 Compaction 後保持引導，不需複製 Pi 的重注入」**成立**。

其他：`interpolate:false` 必用（否則遠端文字中的 `{{...}}` 會在 `:374` 拋 `unknown prompt variable`）；service 端**沒有**長度上限與內容去重，只有同名 shadow；目前註冊的 prompt variable 只有 `provider`、`model`（`dsh-agent-loop/src/index.ts:336-337`）。

### 4.4 Agent / Session / 工作區

| 能力 | 契約 | 證據 |
|---|---|---|
| 列舉 | `ctx.agents.list()` / `get(id)`；`currentInitiator()` / `requireInitiator()` | live `agents` service |
| `agent/created` | serial，`payload = { agent, source, signal? }`，`source: 'startup'\|'resume'\|'clear'\|'compact'` | live `Event`；`dsh-agent/src/runtime-types.ts:152` |
| `agent/disposed` | emit，`{ agent }` | 同上 |
| 工作區 | `get(session)`（同步）、`ensure(agent, signal?)`、`set(...)`、`defaultDirectory` | live `workingDirectory`；`dsh-working-directory/src/index.ts:141-195` |
| cwd 變更 | **不是 ctx event**：durable session event `working-directory/change`，經 `session/event` 觀察 | `dsh-working-directory/src/index.ts:52-67` |
| compaction | session events `compaction/start`／`compaction/summary`／`compaction/end` | `dsh-compaction/src/types.ts:24,34` |

→ 需求 §6.2 列的 Session 建立／恢復／Agent 建立／Subagent 建立／Compaction／切換目錄，**全部有對應的觀察點**；但「切換目錄後工具路由」在現有設計裡是**呼叫時解析**（`tool-bridge.js:150`），本來就不需要事件。

### 4.5 Tool registration、可見性與權限

```ts
register(definition: ToolDefinition, options: ToolRegistrationOptions = {}): () => void
interface ToolRegistrationOptions { when?: (context: ToolActivationContext) => boolean | Promise<boolean> }
interface ToolActivationContext { agent; modelSelection; signal }
restrict({allow?, deny?}): () => void   // 只能在 scoped context（agent.ctx）呼叫；global 呼叫會 throw
```

證據：`dsh-tools/src/index.ts:128-189, 239-401`；`contracts.ts:27-125`。`when` 由 AgentLoop **每個 step 解析一次**；false 則不進入宣告、也不能 dispatch。

→ 需求 §4.3「不修改 DSH 官方 Standard Preset、不要求用戶改 Persona／Preset」可行：我們全部用 **global 註冊**，可見性靠“有沒有註冊”＋可選的 `{ when }`。

### 4.6 Subprocess

```ts
abstract resolveExecutable(command, env?, signal?): Promise<string>
abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
interface SubprocessSpawnSpec { argv; cwd; stdio; graceMs; signal?; env? }
type SubprocessOutputMode = 'pipe' | 'inherit' | { maxBytes: number; spill?: { maxBytes: number } }
interface SubprocessHandle { stdin?; stdout?; stderr?; control?; collected; done: Promise<{exitCode, signal}>; terminate(): void; waitForExit(signal?): Promise<boolean> }
interface SubprocessOutputReader { readFrom(fromByte): { text; nextOffset; lossy; spillPath? } }
```

證據：live `subprocess` service；`dsh-subprocess/src/types.ts:36-196`。

→ **輸出上限與 spill 是原生能力**（`SubprocessCollect.maxBytes`），正好用來滿足需求 §8「限制輸出大小／不將大量輸出無限制注入」；`terminate()` + `waitForExit()` 足以做有界探測與清理。**注意**：subprocess 本身**沒有 timeout**，caller 自負 deadline（現有 `readVersion` 就是自己上 timer）。

另一個可選項是 `ctx.shell`（`ShellExecRequest.command` 是**字串**，有 timeout／output cap／spill）。→ **本計畫不採用**：需求 §7.11 要求 argv 而非 shell 字串拼接。

### 4.7 持久化與路徑

| 事實 | 證據 |
|---|---|
| **沒有** `ctx.pluginData` / `plugin-data` / `ctx.paths` API（全 lib grep 0 命中） | `@deepseek-ai/*/lib` grep |
| 官方 home 解析契約：explicit → `$DSH_HOME`（空白視為未設）→ `~/.dsh`；`dshCachePath()` = `<home>/cache/...` | `dsh-home-paths/src/index.ts:12-27, 124-137, 160-173` |
| `$DSH_HOME` 目前實際值：`C:\Users\sanny\.dsh` | 本機環境 |
| 既有第三方 bundle 的 de-facto 慣例：`$DSH_HOME/<plugin-name>/` 或 `$DSH_HOME/cache/<plugin-name>/` | `~/.dsh` 實測（`dsh-ops/`、`codegraph/`、`dsh-runtimes/`…） |
| `ctx.storageDomain` 只提供 schema-validated KV（JSON backend 每次覆寫整個單元檔） | `dsh-storage-domain/README.md`；`dsh-base/cordis.patch.yml:185` |

→ 快取目錄用 `$DSH_HOME/cache/dsh-basemind-plugin/`（與 `dshCachePath` 同構），**自己解析**、不 import `@deepseek-ai/dsh-home-paths`（AGENTS.md 明令不得 import DSH 內部模組）。

### 4.8 版本與 `engines`

- `engines.dsh` 由 `dsh-app-boot/src/plugin-compatibility.ts:51-90` 判定（有 `engines.dsh` 就只採用它；`includePrerelease: true`）。目前宣告 `>=0.2.1-rc.3 <0.3.0-0`，對 0.2.2-rc.5 成立，**不需改動**。
- 但**新增 API 的最低版本**需要記錄：`ctx.skills`（0.2.2-rc.5 已確認存在；0.2.1-rc.3 未實測）。→ §22 列為「未驗證」，並在 plan 的相容策略中採「執行時偵測、缺少則降級」而非提高 `engines` 下限。

### 4.9 已確認 / 推論 / 未驗證

- **已確認**：§4.1–§4.8 所有 API 與行號（live inspect + asar 原文）。
- **有證據的推論**：`text: (ctx) => string` 可依 `ctx.scope`（= Agent）給不同內容 → 用於「只有當前 Agent 能真的用 BaseMind 才給引導」。依賴 `AssembleContext.scope === agent`（證據：`dispatch.ts:174-176`），但**未**寫過 runtime 驗證；因此 §13 把它列為「第一階段先做全域可用性，per-agent 為第二階段可選」。
- **未驗證**：`DSH_BUNDLED_SKILL_DIR` 在 Host process 的值；`skills` service 在**使用者 desktop profile 的舊版本**是否一定掛載（本 process 有，但那是本次 session 的 deployment）。**已另證**：`0.2.1-rc.3` 的 asar 內 `@deepseek-ai/dsh-skill@0.2.1-rc.3` 已有 `registerProvider` 與相同 rank 常數，且 `dsh-base` composition 含 `skills` rows（見 §22 的 R6）。

---

## 5. 現有插件可復用能力

### 5.1 直接重用（不改或幾乎不改）

| 既有資產 | 位置 | 本次用途 |
|---|---|---|
| 動態 discovery → `ToolDefinition` 產生器 | `index.js:203-231`（`definitionsFor`） | 完全保留；CLI Adapter 只作為「額外一個 definition」加入同一 generation |
| generation 換裝／回滾／collision 偵測 | `index.js:237-344`（`findCollision`、`installGeneration`、`syncTools`） | 完全保留；新增工具的 collision 走同一條路徑 |
| MCP 結果 envelope（`text/content/isError/structuredContent?`）與錯誤碼後綴 | `lib/tool-bridge.js:53-72, 168-181` | 完全保留 |
| 逐次呼叫解析工作區 | `lib/tool-bridge.js:92-151` | CLI Adapter 沿用同一模式（`ctx.workingDirectory.ensure(agent, signal)`） |
| 每 root 一條 relay + in-flight 去重 + caller 取消只取消自己的等待 | `lib/workspace-pool.js:100-181` | 完全保留；**Binary Manager 的 in-flight 去重直接沿用這個模式**（不共用程式碼，共用設計） |
| stdio client 的 spawn 注入與 `SubprocessHandle` 相容層 | `lib/stdio-client.js`（`spawn` 注入）、`test/index.test.mjs:27-61`（`adapt`） | 版本探測與 CLI 執行同樣用注入，測試不碰真實進程 |
| Windows launcher 形狀（`.cmd` 只能 `cmd.exe /d /s /c` 且不可加引號）與 `scrubEnv` | `lib/executable.js:78-164` | `buildLaunchArgv` 直接用於探測與 CLI 執行；錯誤訊息已含解法 |
| `readVersion`（有界 stdout、timer、terminate、`waitForExit`） | `lib/executable.js:296-391` | 改為回傳**解析後的版本**（新增 `parseBasemindVersion`），並加 result cache |
| 設定驗證風格（逐欄位 clamp、無 Schemastery、invalid → default + 1 warning） | `lib/config.js:41-162` | 新設定項照同一風格 |
| 單一 effect 的清理順序（disposers 逆序 → generation → `terminateSyncAll` → `disposeAll`） | `index.js:516-572` | 新資源（skills provider、prompt section、CLI tool、download abort）全部掛進同一條鏈 |
| 啟動失敗診斷＋背景重試（`5s/30s/300s`） | `index.js:34-35, 360-371` | Binary 下載／探測失敗沿用同一 backoff，**外加**冷卻期避免風暴 |
| fake MCP server（0.34 profile）與 fake cordis context | `fixtures/fake-mcp-server.mjs`、`test/index.test.mjs:67-180` | 擴充：fake `skills` service、fake `systemPrompt`（已有）、fake binary fixture |
| 打包／manifest 檢查 | `scripts/check-manifest.mjs`、`scripts/check-pack.mjs` | 擴充：skills 必須在 pack 內、binary 不得在 pack 內 |
| 既有 integration 隔離策略（`BASEMIND_DATA_HOME`／`BASEMIND_COMMS_DIR` 指到 temp） | `test/integration.test.mjs` | 完全沿用 |

### 5.2 需要擴充

| 既有資產 | 擴充點 | 風險 |
|---|---|---|
| `readVersion` | 回傳 `{ raw, version }`；加 `parseBasemindVersion()`；加 `probeCache`（key = 解析後絕對路徑 + mtime + size） | 低；函式已是 best-effort、never throw |
| `resolveLaunch` | 不再自己 `resolveExecutable(config.command)`，改為接受 Binary Manager 選出的 `{ exe, source, version }` | **中**：這是唯一會改變既有啟動語意的地方，必須保留 explicit／`BASEMIND_BIN` 的優先序與錯誤訊息（§21） |
| `lib/config.js` | 新增 `binaryDownload`、`binaryPolicy`、`binaryFallback`、`skills`、`bootstrap`、`cliTool` 六組設定（§15.3） | 低；全部有 DEFAULT，invalid → default + 1 warning |
| `index.js` 的 `probeVersion()` | 從「只寫 debug log」升級為「驅動 Binary Manager 選型」 | 中：目前它刻意不 gate 任何功能，改動後仍要保證失敗不阻塞 Host |
| `index.js` 的 `registerInstructions()` | 保留，另加**第二個**獨立 section（bootstrap），不與 MCP instructions 混在一個 section | 低 |
| `scripts/check-pack.mjs` | 加：`skills/**` 必存在且 10 個；`lib/binary/**`、`lib/upstream.js` 必在；`fixtures/`、`test/`、`docs/`、任何 `basemind*.exe` 不得在 | 低 |

### 5.3 明確不重用

- **官方 `mcp-launch.sh` / `mcp-launch.cmd`**：它們要求 `.claude-plugin|.codex-plugin|.cursor-plugin/plugin.json` 之一存在（`mcp-launch.sh:89-95`），且以 Bash 為前提（Windows 需 Git Bash）。在 DSH 內原樣重用等於引入額外的 Git Bash 依賴與假 manifest，**不採用**；只借用它的規則（候選順序、exact-match cache hit、checksums 格式、鎖與 trap、`MIN_SAFE_VERSION` 概念）。
- **官方 `binary-check.js`**：只借用「探測 never throw + 結構化狀態 + 3009/ENOENT 判定」；不借用 same-minor 預設、不借用 shell 字串呼叫。
- **Pi extension 的注入／去重機制**（§2.8）。

---

## 6. 功能差異矩陣

| 能力 | BaseMind Pi ext | OpenCode plugin | 官方 launcher | 現有 0.2.0 | 本計畫（0.2.0 擴充） |
|---|---|---|---|---|---|
| Skills 來源 | `<pkg>/skills` 目錄 + `resources_discover` | 同（`skills/`） | — | 無 | 套件內 `skills/**`，經 `ctx.skills.registerProvider()` |
| Skills 註冊 | Pi 自己 walk 目錄 | 同 | — | 無 | provider（rank 1000，最低優先） |
| Skills 揭露 | Pi catalog | 同 | — | 無 | DSH `skill` 工具 + durable catalog（name+description） |
| Skills 正文 | **整份 bootstrap 注入** | 同 | — | 無 | 按需載入（`skill` 工具） |
| Bootstrap 注入面 | outgoing messages（`context` 事件） | 同 | — | MCP `instructions` → 一個 prompt section（2,627 B） | 再加一個獨立 bootstrap section（≤1.6 KB） |
| 去重 | marker 字串掃描 messages | 同 | — | 一次性 `instructionsRegistered` flag | registry 天然唯一；`interpolate:false` + 固定文字 |
| Compaction 後 | `session_compact` 重武裝 + 插在 summary 後 | 同 | — | 不適用（section 每 step 重組） | 不實作重注入（§1.2-1） |
| 生命週期掛鉤 | `session_start`/`session_compact`/`agent_end` | 同 | — | `agent/created`（重試）+ dispose | `agent/created`（root 採用／可用性刷新）+ `agent/disposed`（可選）+ dispose |
| 工具映射 | 敘述式 CLI 替代 | MCP + CLI | — | 純 MCP（動態） | MCP（動態）+ 1 個 argv-only CLI 工具 |
| Binary 來源 | 使用者 PATH | 使用者 PATH | pin → 快取 → 本地 bin → PATH → 下載 | `command`/`BASEMIND_BIN` → （可選）npx | `command`/`BASEMIND_BIN` → PATH → managed 快取 → 下載（**預設啟用**）→ npx（legacy） |
| 版本判定 | — | same-minor | cache/path 用 exact，fallback 用 same-minor | 無（不看版本） | **exact**（預設）／same-minor／any（顯式） |
| 探測 | — | 5 s，taskkill/process-group kill | `awk '{print $2}'` | 10 s，best-effort | 5 s，`terminate` + `waitForExit` + mtime/size 快取 |
| 下載 | — | — | curl/wget 風（bash） | 無 | `fetch` + host allowlist + 串流 + 上限 + sha256（**預設不啟用**） |
| 校驗 | — | — | 合併 checksums，不符即 die | 無 | 合併 checksums，不符即拒絕；缺條目即拒絕 |
| 解壓 | — | — | `tar`/`unzip`/Expand-Archive | 無 | 純 Node（tar.gz + zip），只抽預期 binary，防 traversal |
| 快取位置 | — | — | `~/.cache/basemind/versions/<v>/` | npx 快取 | `$DSH_HOME/cache/dsh-basemind-plugin/managed-binaries/<v>/<os>-<arch>/` |
| 併發 | — | — | 目錄鎖 + trap + stale 120 s | pool in-flight 去重 | process 內 single-flight + 跨 process 目錄鎖 + stale 恢復 |
| 離線 | — | — | `BASEMIND_OFFLINE` | — | `binaryDownload:false` = 離線；本地／快取命中時本來就不碰網 |
| CLI 路由 | bash + PATH | PATH | launcher 自己 | 無 | `mcp__basemind__cli`，永遠用同一 Binary |
| 失敗降級 | bootstrap 消失 | 只印 stderr | die | 背景重試、無工具 | 無工具／無 skills／無 bootstrap；DSH 照常 |
| 可觀測性 | 無 | 1 行 stderr | 日誌 | warn/debug 日誌 | 結構化 `status()` + 一次性診斷日誌 |

---

## 7. 目標架構

### 7.1 分層

```
┌───────────────────────────── DSH Host (cordis) ─────────────────────────────┐
│  index.js  apply(ctx, config)                                                │
│                                                                              │
│  ┌──────────────┐   ┌───────────────┐   ┌────────────────┐   ┌───────────┐  │
│  │ binary/*     │──▶│ workspace-pool│──▶│ tool-bridge    │──▶│ ctx.tools │  │
│  │ (選型/下載)  │   │ (每 root 一條) │   │ (MCP → ToolDef)│   │           │  │
│  └──────┬───────┘   └───────┬───────┘   └────────────────┘   └───────────┘  │
│         │                   │                                               │
│         │ selected exe      │ spawn(argv) ──▶ ctx.subprocess                 │
│         ▼                   ▼                                                │
│  ┌──────────────┐   ┌────────────────┐                                      │
│  │ cli-tool.js  │   │ mcp-session.js │──▶ basemind serve (stdio relay)      │
│  │ (argv 白名單)│   └────────────────┘                                      │
│  └──────────────┘                                                           │
│                                                                              │
│  ┌───────────────────┐   ┌──────────────────────────┐                       │
│  │ skills/provider.js│──▶│ ctx.get('skills')         │ (可選服務)            │
│  └───────────────────┘   └──────────────────────────┘                       │
│  ┌───────────────────┐   ┌──────────────────────────┐                       │
│  │ prompt/bootstrap  │──▶│ ctx.systemPrompt.section │                      │
│  └───────────────────┘   └──────────────────────────┘                       │
│                                                                              │
│  lib/upstream.js  ← 唯一的版本事實來源（version/tag/commit/assets/skills）    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 模組職責（新增）

| 檔案 | 職責 | 對外介面（穩定契約） |
|---|---|---|
| `lib/upstream.js` | 上游版本唯一事實來源；asset 對照；skills 清單與數量 | `UPSTREAM`（凍結常數）、`assetFor(target)`、`skillsNames()` |
| `lib/binary/platform.js` | 平台／架構 → target key + 官方 triple + 副檔名 + binary 名；不支援時給可診斷訊息 | `resolveTarget({platform, arch})` → `{key, triple, ext, binary}` 或 `{unsupported, reason}` |
| `lib/binary/probe.js` | 執行 `--version`、解析版本、結果快取（路徑+mtime+size）、負向快取 | `parseBasemindVersion(text)`、`probeExecutable({ctx, exe, env, timeoutMs, signal, cache, logger})` |
| `lib/status.js` | 人類可讀的狀態快照與渲染（`/basemind-status` 的內容、日誌摘要）；純函式，不觸發 I/O | `statusReport({manager, config, platform})` → `{ present, path, found, expected, compatible, source, reasons[], lines[] }` |
| `lib/binary/download.js` | HTTPS 下載到暫存檔、host/redirect allowlist、逾時、大小上限、sha256 邊寫邊算、取消 | `downloadVerified({url, dest, sha256, …})` |
| `lib/binary/checksums.js` | 解析 `basemind_<v>_checksums.txt`（`sha256sum` 格式、`*` 前綴） | `parseChecksums(text)`、`digestFor(map, asset)` |
| `lib/binary/archive.js` | 純 Node 解 tar.gz 與 zip；只抽預期 entry；防 traversal／絕對路徑／symlink／超限 | `extractSingleFile({archive, kind, entryPath, destFile, limits})` |
| `lib/binary/manager.js` | 選型矩陣、single-flight、跨 process 鎖、原子安裝、快取驗證、失敗冷卻、`status()` | `createBinaryManager({ctx, config, logger, signal})` → `{select(root, signal), status(), dispose()}` |
| `lib/cli-tool.js` | argv-only CLI Adapter（allowlist／denylist、timeout、輸出上限） | `createCliTool({serverName, binary, logger})` → `ToolDefinition` |
| `lib/skills/provider.js` | 讀 vendored skills、frontmatter 解析、`SkillProvider` 實作、可用性 gate、`invalidate()` | `createBasemindSkillProvider({control, readiness, root, logger})` |
| `lib/prompt/bootstrap.js` | bootstrap 文字組裝（純函式，可單測）＋ section 註冊 | `bootstrapText({ready, cliToolName, serverName})`、`registerBootstrapSection(ctx, …)` |
| `scripts/sync-basemind-skills.mjs` | 依指定 tag/commit 同步官方 skills、套用 DSH 適配規則、寫 provenance、`--check` 模式 | CLI：`--tag v0.34.0 [--check] [--source <dir 或 url>]` |

### 7.3 執行期狀態機（Binary Manager）

```
IDLE ──select()──▶ PROBING ──ok(compatible)──▶ READY(selection)
                      │                              │
                      ├─incompatible──▶ FALLBACK ────┤
                      │                    │         │
                      ├─missing────────────┤         │
                      ▼                    ▼         ▼
                  UNAVAILABLE ◀──no candidate & download disabled/failed
                      │
                      └─(冷卻期後，下次 select 才重試)──▶ PROBING
```

- `READY` 之後**不再探測**（結果快取；binary 檔案 mtime/size 變才重新驗證）。
- `UNAVAILABLE` 時：不註冊 MCP tools、不註冊 CLI tool、skills provider 回空、bootstrap 文字回空。DSH 其餘功能不受影響。

### 7.4 註冊與清理順序（沿用既有單一 effect）

```
apply()
 ├─ 建立 BinaryManager（無網路動作）
 ├─ ctx.effect(() => {
 │    ├─ ctx.on('agent/created', …)            // 採用 root / 刷新可用性
 │    ├─ skills provider 註冊（ctx.get('skills')，缺則跳過並記 1 次 debug）
 │    ├─ bootstrap section 註冊（ctx.systemPrompt）
 │    ├─ 背景 ensurePrimary()（→ 可能需要 binary）
 │    └─ return async () => { 逆序 dispose；abort 下載；terminal relay 清理 }
 └─ })
```

**順序約束**（沿用既有不變量）：tools → prompt section／resources 必須在工具註冊成功之後才掛（`index.js:416-426` 的註解說明理由：不能讓 prompt 指向一個實際沒有工具的來源）。bootstrap 與 skills 額外要求「binary READY」。

### 7.5 狀態顯示（「配置頁」需求）— 可行性與設計

需求（2026-11-24 第二輪）：**配置頁顯示本機是否存在 `basemind`、其版本、以及是否與插件當前版本相容。**

#### 7.5.1 查證結果：GUI 沒有 Host-only 的「動態狀態」呈現面

| 面 | 能否顯示**執行期探測結果** | 證據 |
|---|---|---|
| **Settings 頁的表單**（`ui-settings`） | **不能**。表單只渲染「作用中、可唯一定址的 profile entry 的 **volatile** 欄位」，值來自插件宣告的 `Config`；且 `describe()` 回的是 schema + 值，沒有「唯讀動態文字」這種欄位型別 | `@deepseek-ai/dsh-settings/README.md`：「Forms expose only volatile fields from active, uniquely addressed profile entries」「Each form reports `autoGenerate` … no shipped client does so yet」 |
| **Settings 頁的 plugin 清單** | 不能（**唯讀**） | `@deepseek-ai/dsh-plugin-manager/README.md:31`：「the Settings Plugin list stays read-only」 |
| **Plugins 頁的 bundle 詳情文檔** | 不能（**靜態**套件內文）。`readBundleDetail()` 讀 locale 的 `meta.detail`，否則讀 README；上限 `detailMaxBytes = 1 MiB`；不讀 repository | `dsh-plugin-manager/README.md:100,108,114` |
| **自帶頁面** | 可以，但需要 **client half**：`configure({ auto: false }, ctx.fiber)` 只宣告「本插件自帶頁」，真正渲染要靠 bundle 的 `dsh.client`；client 端的 settings 框架提供的擴展點是「settings chrome／pages／header actions／**plugin tabs**」，且官方那 4 個 plugin 頁是「**one companion package each**」（各自一個 client 套件） | `dsh-settings/README.md`（同上段）；`dsh-package-manifest/README.md:26-64`（`dsh.client = { platform: 'web' }`）；`dsh-client-ui-settings/README.md`（extension points 與 companion package 的描述） |

**結論（已確認）**：本 bundle 目前是 **Host-only、零建置**（`package.json` 無 `dsh.client`、無 bundler）。要在「配置頁」出現一張顯示探測結果的卡片，**必須新增 client half**（新增前端來源、建置產物、`files` 白名單、`dsh.client` 宣告、以及對 DSH client plugin／Slot 契約的調研）。這與 AGENTS.md 的「Host-only」定位與「零 runtime dependency、無前端 build」直接衝突，屬**架構級變更**，不是一個設定項。

#### 7.5.2 Host-only 的等效方案（建議實作）

用 DSH 原生的 **human command** 面（使用者輸入 `/指令`，不經模型、不耗 token）：

```js
const commands = ctx.get?.('commands')            // 可選服務，同 skills 的處理方式
const dispose = commands?.register({
  name: 'basemind-status',
  description: 'Show this machine\'s BaseMind binary, its version, and whether it matches this plugin',
  handler: async (invocation) => ({ kind: 'success', text: renderStatus(report) }),
})
```

`CommandDefinition` / `CommandResult` 契約（live `commands` service）：`{ name, description, input?, handler }` → `{ kind: 'success', text? } | { kind: 'error', text }`；從 plain context 註冊即為 global，可由 `/name` 觸發。

輸出樣例（`lib/status.js` 純函式渲染，寬度對齊、無 ANSI、無敏感資訊）：

```
BaseMind status — dsh-basemind-plugin 0.2.0
  expected upstream : 0.34.0 (exact)
  platform          : windows-x64 (x86_64-pc-windows-msvc)
  present           : yes
  path              : ...\Programs\basemind\basemind.exe
  found             : 0.33.0
  compatible        : NO — minor mismatch (0.33 vs 0.34)
  source            : path
  managed cache     : empty (...\.dsh\cache\dsh-basemind-plugin\managed-binaries)
  download          : enabled (binaryDownload=true) — last attempt failed 3m ago (HTTP 403)

  What to do:
    - Install BaseMind 0.34.0 (https://github.com/Goldziher/basemind/releases/tag/v0.34.0)
      and set `command` / BASEMIND_BIN to that executable, or
    - let the plugin's download retry later (it backs off; nothing else is blocked), or
    - set binaryPolicy: "minor" to accept 0.34.x only after you have verified it.
  Tools are not registered until a compatible binary is available.
```

**降級行為**（與 §13.5 一致）：

| 情境 | `/basemind-status` 顯示 |
|---|---|
| 沒有 binary | `present: no` + 安裝指引 + 「工具未註冊」 |
| 版本不符 | `found` / `expected` / `compatible: NO` + 具體原因（minor / patch / prerelease）+ 兩個可行動選項 |
| 平台不支援 | `unsupported platform` + 自建指引（Intel Mac／Windows arm64） |
| 已在 managed 快取 | `source: managed` + 快取路徑 + `download: disabled` |
| 尚未完成首次探測 | 觸發一次同步探測（有界 5 s），不阻塞 UI 超過該上限 |

補充（低成本、純靜態）：把同一份說明寫入 **Plugins 頁的詳細文檔**（locale `meta.detail` 或 README 的新章節），讓使用者在 GUI 內也能看到「怎麼判讀狀態」——但那份是靜態文字，**不含實際版本值**，不得宣稱它是狀態顯示。

#### 7.5.3 成本與風險

| 方案 | 新增程式 | 建置 | 風險 |
|---|---|---|---|
| A. `/basemind-status` 指令（**建議**） | ~120 行（`lib/status.js` + 註冊） | 無 | 低：`commands` 是既有可選服務，缺則跳過 |
| B. Plugins 頁靜態文檔 | 文件 1 節 | 無 | 無（但靜態） |
| C. 真·配置頁卡片（client half） | client 入口 + Slot 貢獻 + 建置設定 | **需要**（`dsh.client`、bundler、產物） | 高：改變專案定位、增加供應鏈與打包複雜度、需大量 DSH client 契約調研 |

#### 7.5.4 裁決結果（第四輪）

需求寫的是「配置頁」。**已裁決：採 A + B**（`/basemind-status` 指令 + Plugins 頁靜態文檔），C（真·配置頁卡片／client half）列為**獨立後續項目**，不在本次 Scope；若日後要做，應另寫一份 client-half 的 Plan（需先調研 DSH client plugin 與 Slot 契約）。

因此本次交付的「狀態顯示」定義為：

1. `/basemind-status` 是一條 **human command**（使用者輸入才執行、不經模型、不耗 token），輸出見 §7.5.2；
2. Plugins 頁的詳細文檔（locale `meta.detail` 或 README 章節）說明**怎麼判讀**，但**不含**實際版本值；
3. 文件與 UI 文案**不得**把這兩者稱為「配置頁」或「狀態卡片」。

---

## 8. Local First Binary 選擇流程

### 8.1 候選（依需求 §7.2，逐項判定）

```
select(root, signal):
  candidates = []
  1. explicit := config.command ≠ 'basemind'（含路徑或自訂命令）   // 最高優先，既有語意
  2. env-pin  := env.BASEMIND_BIN（僅當 config.command 為預設）
  3. path     := resolveExecutable('basemind')
  4. managed-cache := cache/<UPSTREAM.version>/<target>/
  5. download := 官方 release（**預設啟用**：binaryDownload:true 且上面都不成立）
  6. legacy-npx := 僅當 autoProvision 且 5 不可用（列在最後，見 §9.5）
```

> **D2 第三輪裁決後的行為**：`binaryDownload` 預設 `true`，但**本地優先的順序不變**——任何一處已有相容 binary 就直接使用，**0 次網路**（§18.4）。
> 只有 1–4 全部不成立時才下載；下載失敗就進 `UNAVAILABLE`，由 `/basemind-status`（§7.5）與日誌說明原因，DSH 其餘功能不受影響。
> 「explicit」在本計畫中**不新增欄位**：它就是既有的 `config.command`（非預設值或含路徑）與 `BASEMIND_BIN`（僅當 `command` 為預設），這正是 0.2.0 的語意（`lib/executable.js:242-245`），也避免「同一個需求三種寫法」（需求 §9）。

需求 §7.2 的順序是 explicit → PATH → managed 快取 → 下載。本計畫的實際順序 **explicit（`command`／`BASEMIND_BIN`）→ PATH → managed 快取 → 下載（預設啟用）** 與它 1→2→3→4 完全一致，且**每個候選都要通過版本判定才會被採用**：

| 候選 | 判定 | 不相容時 |
|---|---|---|
| explicit `config.command`（非預設，或含路徑） | 存在？可執行？版本相容？ | 警告（含實際版本、來源、期望版本）→ 繼續往下；若 `binaryFallback:false` → 直接 UNAVAILABLE（**顯式停用 fallback**） |
| `BASEMIND_BIN`（僅當 `command` 為預設） | 同上 | 同上；訊息要說明「這是 operator pin，但與插件上游版本不符」 |
| PATH `basemind` | `resolveExecutable('basemind')` 成功？版本相容？ | 警告一次（每個 process 一次）→ 繼續 |
| managed 快取 | 目錄存在？binary 存在？可執行？版本相符？manifest 的 sha256 與檔案相符？ | 標記快取失效 → 重建（`binaryDownload:false` 時視為缺失） |
| 下載（**預設啟用**） | §10 | 進 `UNAVAILABLE` 並冷卻 |

**為什麼不照字面「PATH 命中就用」**：需求 §7.4 明確要求「本地 0.33.x → 不相容」。若取「先命中即用」，使用者 PATH 上的 0.33 會被拿去跑 0.34 的 Skills，反而違反 §5.1「Skills 可用性必須與實際 Binary 能力一致」。官方 launcher 也是「候選必須 exact match 才 exec」。→ 此解讀同時滿足需求與官方行為。

**與需求 §7.4 的關係（第三輪裁決後已對齊）**：需求 §7.4 假設「本地不相容 → 自動下載 0.34.0」，在預設設定下**就是如此**。唯二的差異出現在 `binaryFallback:false`（顯式停用 fallback）與 `binaryDownload:false`（離線／自管版本）這兩個**顯式**設定下——結果是「不註冊工具 + 可診斷訊息」，而不是靜默降級。

### 8.2 相容判定（`binaryPolicy`）

| `binaryPolicy` | 接受 | 預設 | 用途 |
|---|---|---|---|
| `exact`（預設） | `major.minor.patch` **完全相等**（忽略 build metadata；**不接受** prerelease） | ✅ | 本次交付的正式策略 |
| `minor` | `major.minor` 相等（忽略 patch 與 prerelease 標籤） | — | 給「上游聲明 patch 相容 + 我方實測」的場景；需在 README 說明風險 |
| `any` | 任意可執行 `basemind` | — | 舊版 MCP-only 模式（例如使用者被釘在 0.33）；**Skills 不註冊**（§9.4） |

### 8.3 明確的不變量

1. **不覆蓋、不卸載**使用者全域安裝的 BaseMind；不執行 `npm install -g`／`pip install`；不改 `PATH`；不需管理員權限；不寫入工作專案。
2. **不自動執行** `scan`／`rescan`／`comms stop`／`cache clear`／`memory clear`／`upgrade`（除 `--plan` 且由使用者／agent 明確要求）。
3. 選定的 binary **在整個 process 內固定**（`config` 改變才重新選型）；所有 workspace relay、CLI Adapter、版本診斷都用同一個（需求 §7.11）。
4. 選型結果是**每個目標**（version+platform）一份；不同 workspace 不會各自下載（需求 §7.8）。
5. 選型失敗**不阻塞 Host**：`apply()` 不 throw（除非 `failOnStartupError:true`，沿用既有語意）。

---

## 9. Binary 版本管理策略

### 9.1 單一版本來源

`lib/upstream.js` 匯出（凍結物件）：

```js
export const UPSTREAM = Object.freeze({
  version: '0.34.0',
  tag: 'v0.34.0',
  commit: '8e7b149',                     // v0.34.0 輕量 tag 的 commit（同步腳本記錄用）
  releaseBase: 'https://github.com/Goldziher/basemind/releases/download',
  checksums: { name: 'basemind_{version}_checksums.txt', format: 'sha256sum' },
  assets: Object.freeze({
    'windows-x64':  { triple: 'x86_64-pc-windows-msvc',      ext: 'zip',    binary: 'basemind.exe', bytes: 75627742 },
    'linux-x64':    { triple: 'x86_64-unknown-linux-gnu',   ext: 'tar.gz', binary: 'basemind',     bytes: 92214847 },
    'linux-arm64':  { triple: 'aarch64-unknown-linux-gnu',  ext: 'tar.gz', binary: 'basemind',     bytes: 102161826 },
    'darwin-arm64': { triple: 'aarch64-apple-darwin',       ext: 'tar.gz', binary: 'basemind',     bytes: 88184663 },
  }),
  skills: Object.freeze({ count: 10, names: [...], minLines: … }),
})
```

**其他所有地方都必須從這裡取值**：`fixtures/`、`test/`、`.github/workflows/compat.yml`、`release.yml` 的 pinned 版本、README 的「已驗證版本」、skills provenance。

- `package.json` 的 `version`（插件版本）**與此無關**，永不共用、永不推導。
- 禁止 `latest`：下載 URL 一律 `v${UPSTREAM.version}`；`npxSpec` 的 `basemind@latest` 只存在於 legacy 路徑（§9.5）。
- 一致性由測試強制：`test/upstream.test.mjs` 斷言 `UPSTREAM.assets` 的 key 集合 = platform 模組支援的集合、`skills.names.length === count`、`fixtures/basemind-0.34.0-*` 存在、README 提到的版本字串與 `UPSTREAM.version` 相同。

### 9.2 exact vs same-minor：完整解釋與裁決

#### 9.2.1 兩種規則到底在管什麼

兩者都只回答一個問題：**「這台機器上找到的 `basemind X.Y.Z`，可以拿來服務『為 0.34.0 寫的插件』嗎？」**
差別在「憑什麼相信」：

| 規則 | 判定式 | 隱含的假設 | 誰在用 |
|---|---|---|---|
| **exact** | `major.minor.patch` 完全相等（忽略 `+build`） | 我只相信我逐字對照過的那一版 | 本計畫預設 |
| **same-minor** | `major.minor` 相等（patch 任意） | 同一 minor 內，MCP tool 面／CLI 參數／錯誤碼集合不變；只有修 bug | 官方 `binary-check.js`（`versionMinor(found) === versionMinor(expected)`，`:151-154`）；官方 launcher 的 *fallback* 路徑（`version_minor()`，`mcp-launch.sh:259-262`） |

值得注意的是**官方自己也不是純 same-minor**：`mcp-launch.sh` 對「快取命中／`bin/basemind`／PATH」三條路徑都用 **exact** `--version` 相等（`try_exec`，`:307-313`），只有「要下載哪個版本」與「下載失敗後退到哪個已發布版本」才用 same-minor。OpenCode 插件是唯一把 same-minor 當成「接受現有 binary」的地方，而且它的失敗模式是**只印一行 stderr 然後照用**（`basemind.js:99-110`）。

#### 9.2.2 為什麼本插件的風險剖面和 OpenCode 不同

OpenCode 插件只把 `basemind serve` 掛上去當 MCP server：它對 binary 的假設只有「MCP protocol 能握手、tool 名對得上」。本插件在本次擴充後多了三種**更細的耦合**：

| 耦合面 | 依賴什麼 | 0.34.0 內是否凍結 | 跨 patch 是否保證 |
|---|---|---|---|
| MCP tool 契約 | 15+3 個 tool 名、input schema、`structuredContent`、錯誤碼 | 是（fixture 採集） | **沒有書面保證**；上游只保證 patch 不改 blob/index schema |
| **Skills 文本** | 逐字引用 0.34.0 的 tool 名與 **CLI 動詞/選項**（`code explain`、`git hotspots`、`admin telemetry --json`…） | 是（vendored 快照 + 雜湊） | **不保證**：CLI 是 `clap` 定義，patch 可以新增/改名 flag 而不動 schema |
| **CLI Adapter 白名單** | 允許的動詞／子命令／`--plan` 等 | 是（allowlist 表） | 不保證：patch 可能新增子命令（安全，只是用不到）或改名（會變成 usage error） |
| 索引／記憶 | `RELEASE_MINOR` | 是（34） | **有保證**：patch 必須保持 blob/index 相容（`src/version.rs:14-26`） |

也就是說：**exact 保護的是「MCP tool 面 + Skills 文本 + CLI 契約」三者的一致性；same-minor 只保護索引相容性。** 這兩件事的風險等級完全不同——索引不相容會壞掉資料（有上游保證），CLI/tool 面漂移只會讓 agent 拿到 usage error 或走錯技能（看起來像插件 bug）。

#### 9.2.3 兩個方向的錯判成本

| 錯判 | 後果 | 誰承擔 |
|---|---|---|
| **過嚴**（實際相容卻拒絕） | 使用者看到「不相容」→ 手動升級或改 `binaryPolicy`；功能暫時不可用，但沒有錯誤資料 | 使用者一次操作 |
| **過寬**（實際不相容卻接受） | Skills 教 agent 呼叫不存在的 flag／工具；錯誤訊息來自 BaseMind 而非插件；使用者以為「插件壞了」；最壞情況把 0.35 的 binary 指向 0.34 的索引目錄 → 上游 `RELEASE_MINOR` 保護會重建索引（非破壞性，但耗時且可能讓舊 session 進 `-32003`） | 使用者＋排查成本，且難以自我診斷 |

**不對稱**：過嚴是「可見且可逆的一次操作」，過寬是「不可見、難歸因、可能牽動索引重建」。需求 §7.4 明文要求「默認安全策略優先考慮精確匹配上游目標版本」，因此預設取 exact。

#### 9.2.4 那什麼情況下該允許 same-minor

只有在**兩個條件同時成立**時才值得：

1. 上游對該 patch 有書面說明「無 tool／CLI 契約變更」（CHANGELOG 的 `Fixed`-only）；
2. 我方對該 patch 跑過 integration gate（`BASEMIND_REQUIRE_INTEGRATION=1`，含 CLI adapter 的 `doctor`／`status`／`code outline`）。

因此 `binaryPolicy: 'minor'` 是**使用者側的逃生門**，不是預設：

```
binaryPolicy: 'minor'   → 接受 X.Y.*（含 prerelease 標籤？見 §9.3：不接受 prerelease）
```

副檔帶的邊界要說清楚，避免誤解：
- `'minor'` **不**等於「accept anything」：不同 minor（0.33、0.35）仍然拒絕。
- `'minor'` **不**等於放行 prerelease：`0.34.1-beta` 仍在拒絕之列（§9.3）。
- 放行只影響「要不要用你機器上那一版」；要不要下載仍由 `binaryDownload` 決定（預設開啟，但本地優先，命中就不下載）。

#### 9.2.5 實際決策表（0.34.0 為目標）

| 本機版本 | `exact`（預設） | `minor` | `any` |
|---|---|---|---|
| 0.34.0 | ✅ 使用 | ✅ 使用 | ✅ 使用（但無 Skills／CLI） |
| 0.34.1 | ❌ 不相容（提示可切 `minor`） | ✅ 使用 | ✅ 使用（無 Skills／CLI） |
| 0.34.0-rc.1 | ❌ | ❌ | ✅ 使用（無 Skills／CLI） |
| 0.33.0 / 0.35.0 | ❌ | ❌ | ✅ 使用（無 Skills／CLI） |
| 無 binary | ❌ → 安裝指引 | 同左 | 同左 |

> **D2 第三輪裁決的連動**：預設會下載，所以「不相容」的預設結果是「自動取得 0.34.0 後可用」。`/basemind-status`（§7.5）因此不再是「沒有下載時的唯一出口」，而是**失敗診斷面**（離線、403／404、不支援平台、`binaryFallback:false`、快取損壞）。仍列為必要功能：沒有它，上述情況使用者只會看到「BaseMind 工具不見了」。

#### 9.2.6 為什麼不改用 semver range（例如 `~0.34.0`）

`~0.34.0` 在語意上等於 `>=0.34.0 <0.35.0`，也就是 same-minor，只是寫法不同；`^0.34.0` 在 0.x 下同樣是 same-minor。也就是說「range」不會帶來比 `binaryPolicy` 更多的能力，只會多一層需要解析、驗證與解釋的設定。**不採用**：`binaryPolicy: 'exact' | 'minor' | 'any'` 是三個可窮舉、可測試、可寫進文件的語意。

#### 9.2.7 維護成本：升一個 patch 是「改 1 行 + 跑 3 個動作」

exact 策略最常被質疑的點是維護成本。實測估算如下（全部是既有機械流程，不需要重新調研）：

| 動作 | 成本 |
|---|---|
| 改 `lib/upstream.js` 的 `version`（以及 `commit`、`bytes`） | **1 行**（+ 2 個欄位） |
| 重跑 `node scripts/sync-basemind-skills.mjs --tag v0.34.1` | 1 個命令；任何適配規則失配會**失敗**而不是靜默漂移（§12.3） |
| 跑 `BASEMIND_REQUIRE_INTEGRATION=1 npm run verify` | 1 個命令（既有 gate） |
| 更新 `fixtures/basemind-0.34.1-*`（只有 MCP tool 面真的變了才需要） | 通常 0，由 schema/integration 測試告訴你是否需要 |

把這四步寫成 `docs/upstream-sync.md` 的 checklist（本次交付文件之一），並在 AGENTS.md 指向它。**相對於「錯了之後 agent 拿到不存在的 CLI 指令、使用者以為插件壞了」的除錯成本，這個維護成本明顯更低**（§9.2.3 的不對稱）。

### 9.3 版本分類決策表（對應需求 §7.4；D2 第三輪裁決：預設下載）

| 本地版本 | 判定（`exact`） | 動作（**預設** `binaryDownload:true`） | 動作（`binaryDownload:false`） |
|---|---|---|---|
| 0.34.0 | 相容 | 直接使用，**不訪問網路** | 同左 |
| 0.34.x（x≠0） | 未驗證 | 警告 + 下載 0.34.0（或使用者自開 `minor` 直接用） | 警告 + `UNAVAILABLE` + 指引（可切 `minor`） |
| 0.33.x 及以下 | 不相容 | 警告 + 下載 0.34.0 | 警告 + `UNAVAILABLE` + 升級指引 |
| 0.35.x 及以上 | 未驗證（可能已 bump `RELEASE_MINOR`） | 同上 | 同上 |
| `0.34.0-rc.N` / `0.34.1-alpha` | prerelease → 不相容 | 同上（訊息明說「不接受預發布版本」） | 同上 |
| 檔案存在但無法執行 | 不可執行 | 下載 | `UNAVAILABLE` + 可診斷訊息 |
| 無 binary | 缺失 | 下載 | `UNAVAILABLE` + 安裝指引 |
| 不支援的 OS／arch | 不支援 | `UNAVAILABLE` + 自建指引（Intel Mac／Windows arm64） | 同左（官方無此資產） |

版本解析規則（與官方一致的最小充分版）：`/^basemind\s+(\S+)/` 取第一段，再以 semver 解析 `major.minor.patch[-pre][+build]`；解析失敗 → 不相容（附原始輸出的前 128 字元，已去除控制字元）。

### 9.4 Perl-release 與 `any` 模式的邊界

`binaryPolicy: 'any'` 的語義（需求 §7.4 要求分析是否保留 MCP-only 模式）：

- 保留 MCP Bridge（動態 discovery 本來就跨版本）。
- **不註冊 Skills**、**不註冊 CLI Adapter**、bootstrap 改為「BaseMind 可用但版本未驗證」的短句。
- 必須顯式開啟；預設不啟用。
- 理由：Skills 文本與 CLI 契約是版本相關資產，在未驗證版本上曝露它們等於製造錯誤引導。

### 9.5 `autoProvision` / `npxSpec` 的處置

| 設定 | 現況 | 本計畫 |
|---|---|---|
| `autoProvision`（預設 false） | `resolveExecutable` 失敗時 fallback 到 `npx -y basemind@latest` | **保留為 legacy**，但當 `binaryDownload` 可用時**不再走 npx**（記錄 1 次 deprecation 警告）；順序排在最後 |
| `npxSpec`（預設 `basemind@latest`） | 只用於上面的 fallback | 保留，僅 legacy 路徑可達 |

**理由**：`npx` 會即時抓 `latest`（違反「不得使用 latest 作為自動下載的預設版本」），且不可校驗 sha256、不可控版本。保留是為了不破壞既有設定語意（有人的 profile 依賴它）；deprecation 訊息指向 `binaryDownload`／`command`。
**不新增**第三套安裝設定（避免重疊）。

---

## 10. Binary 下載、校驗、緩存及併發設計

> **D2 第三輪裁決後的定位**：本節描述的整條下載路徑**在預設設定下會執行**，但只在「本地沒有任何相容 binary」時才走。
> 三個不變的紀律仍然成立：
> 1. 需求 §7.5–§7.9 的安全要求（HTTPS、官方 checksums、SHA256、防遍歷解壓、併發鎖、離線降級）全部照做，不做任何簡化；
> 2. 本地命中時**不觸發任何網路或寫入**（§18.4），managed 快取命中時亦然；
> 3. `binaryDownload:false` 時**不得**觸發任何網路或寫入——這一條必須有測試（§17.2 案例 10）。
>
> 換句話說：**下載器是預設路徑，但不是預設行為的起點**——起點永遠是「本機有沒有相容的 binary」。

### 10.1 快取佈局

```
$DSH_HOME/cache/dsh-basemind-plugin/
  managed-binaries/
    .lock-0.34.0-windows-x64/            # 目錄鎖（mkdir 原子）
    0.34.0/
      windows-x64/
        basemind.exe
        install.json                     # sha256, source url, upstream tag, installedAt, size
      linux-arm64/
        basemind
        install.json
  state.json                             # lastVersion per target, lastFailureAt, cooldown
  download/                              # 暫存（下載與解壓），啟動時清掃超過 24 h 的殘留
    0.34.0-windows-x64-<rand>/
```

- `$DSH_HOME` 解析：`process.env.DSH_HOME`（trim 後非空）→ 否則 `path.join(os.homedir(), '.dsh')`；`~` 展開；最後 `path.resolve`。與 `dsh-home-paths` 契約一致（§4.7）。
- 佈局按 **version + platform** 隔離（需求 §7.7）；同名 platform key 使用 `windows-x64`／`linux-arm64`／`darwin-arm64` 這種可讀形式，triple 只在 `install.json` 與下載 URL 出現。
- 不寫入工作專案、不寫入 npm 安裝目錄、不寫入 `$DSH_HOME/profiles/**`。

### 10.2 下載流程（嚴格順序）

```
1. 取得 checksums 檔（有界逾時）→ 找目標 asset 的 sha256；找不到 → 失敗（不允許「無 checksum 也裝」）
2. 建立 download/<target>-<rand>/
3. fetch(assetUrl)：
   - 只允許 https:
   - redirect 手動處理，最多 5 次，host allowlist：
       github.com, objects.githubusercontent.com, release-assets.githubusercontent.com
   - 連線/首包逾時 30 s；總體逾時 15 min；`AbortSignal` 可取消
   - Content-Length 存在時 > 上限（400 MB）→ 立即失敗
   - 串流寫入 asset 檔，同時 update sha256（不把整包讀進記憶體）
4. 比對 sha256；不符 → 刪檔、記失敗、不進入解壓
5. 解壓到同層 staging/：只抽預期 entry（§10.4）
6. 驗證：檔案存在、大小 > 0、sha256（解壓後 binary 無官方 digest，改驗「可執行 + 版本」）
7. 版本驗證：對 staging binary 執行 `--version`，必須等於 UPSTREAM.version
8. chmod 0o755（非 Windows）
9. 原子提交：fs.rename(stagingDir, 正式目錄)（同 filesystem；目標已存在則先確認有效或移到 .old-<rand> 後刪）
10. 寫 install.json（含 sha256、url、tag、時間）
11. 回傳 selection；通知所有等待者
```

**原子性**：正式目錄只在第 9 步出現，且由單次 `rename` 產生；中斷只會留下 `download/` 殘留（啟動清掃），不會出現「半完成被視為成功」。

### 10.3 校驗與信任

| 項目 | 規則 |
|---|---|
| 來源 | 只允許 `https://github.com/Goldziher/basemind/releases/download/v<UPSTREAM.version>/…`；`releaseBase` 可被設定覆寫，但**必須 https**（或測試用的 `file://`，僅透過內部注入，不開放給使用者設定） |
| 憑證 | 不關閉 TLS 驗證、不加入 `NODE_TLS_REJECT_UNAUTHORIZED`、不信任自簽 |
| checksums 來源 | 同一個 release 的 `basemind_<v>_checksums.txt`；解析失敗或缺少目標行 → 拒絕 |
| 完整性 | 下載後 sha256 比對；不一致立即刪除並記為失敗（hard fail，不 fallback 到別的鏡像） |
| 代理 | **不主動使用** `HTTP(S)_PROXY`（Node fetch 預設不讀）；文件明說「需要代理的環境請用 `BASEMIND_BIN` 指向自建 binary」。不做「把 API key／敏感環境變數送給下載服務」這種事 |
| 鏡像 | 本次**不開放**使用者自訂鏡像。理由：需求 §7.5 只允許「保持官方校驗及可信來源」；開放鏡像需要額外的信任模型，屬非目標 |

### 10.4 解壓安全（純 Node）

`lib/binary/archive.js` 的契約：`extractSingleFile({ archive, kind, entryPath, destFile, limits })`。

- **tar.gz**：`zlib.createGunzip()` → 512-byte block 解析：`name`、`prefix`(ustar)、`size`、`typeflag`。只接受 `typeflag === '0'|'\0'` 的 regular file；`'5'`(dir) 跳過；`'1'`(hardlink)、`'2'`(symlink)、`'3/4/6'` 一律拒絕（即使不是目標 entry）。目標 entry 必須是 `basemind` 或 `basemind.exe` 且**在根層**（與官方 launcher 的 `[ -f "$STAGING/$BINARY_NAME" ]` 一致）。**Pax/長檔名 header（typeflag `x`/`g`/`L`）跳過內容但不拼接**——我們只找根層固定名，不需要長檔名支援。
- **zip**：掃 EOCD → 中央目錄 → 找目標 entry → 讀 local header → `zlib.inflateRawSync`（method 8）或直接取樣（method 0）；只寫目標檔案。
- 防護（皆有對應測試）：
  | 攻擊 | 防護 |
  |---|---|
  | ZIP Slip / `../` | 只寫 `destFile`（固定路徑，由呼叫端組合），完全不使用 archive 內名稱作為路徑 |
  | 絕對路徑 | 同上 |
  | symlink/hardlink | typeflag 檢查 + zip 的外部屬性檢查（`0o120000`）→ 拒絕 |
  | 覆蓋其他檔案 | 解壓到專屬 staging 目錄，只寫一個檔名 |
  | 解壓炸彈 | `maxEntryBytes`（400 MB）、`maxTotalBytes`、`maxEntries`（1,000） |
  | 異常壓縮包 | 任何 header 不一致 → throw（`BasemindArchiveError` with code） |

**為什麼不用系統 `tar`/`unzip`**：Windows 的 `tar.exe` 是 bsdtar（支援 zip），但依賴系統版本；`unzip` 在精簡 Linux 映像可能缺席；官方 launcher 自己就 fallback 三種工具。純 Node 實作約 200–250 行、零依賴、可用 fixture 完整測試（含惡意 zip），符合需求「避免為簡單功能引入大型依賴」且跨平台一致。

### 10.5 併發控制（需求 §7.8）

| 層級 | 機制 |
|---|---|
| Process 內 single-flight | `Map<targetKey, Promise<Selection>>`；第二個 caller 直接 await 同一個 promise（沿用 `workspace-pool.js:139-181` 的模式） |
| 跨 process 鎖 | 目錄鎖 `<cacheRoot>/managed-binaries/.lock-<version>-<platform>`：`fs.mkdir` 成功即持有（`EEXIST` = 已被持有）→ 進入等待 |
| 等待策略 | 每 200 ms 重試，最多 120 s；等待期間若正式目錄已出現且有效 → 直接使用 |
| Lock 持有者崩潰 | 鎖目錄內寫 `owner.json`（pid、startedAt、hostname）；等待者可判定：(a) `startedAt` 超過 120 s → stale，嘗試 `fs.rmdir` 後重取；(b) 同 host 且 pid 不存在 → stale 立即回收。`rmdir` 失敗（他人在用）→ 繼續等 |
| 原子提交 | 只有取鎖成功者能 `rename` 進入正式目錄；其他人只讀 |
| 單一 session 取消 | 等待者可用自己的 `signal` 取消**自己的等待**；**不影響**共用下載（下載由鎖持有者進行，與任何單一 caller 的 signal 脫鉤——沿用 pool 的「caller signal 只取消自己的等待」設計） |
| 重試風暴防護 | (a) 每個 target 在 process 內最多嘗試 1 次自動下載，失敗後進入 `UNAVAILABLE`；(b) `state.json` 記錄 `lastFailureAt`，跨 process 冷卻 10 分鐘內不再自動嘗試；(c) 下載內部重試上限 2 次（間隔 1 s、4 s，含 jitter） |

### 10.6 快取驗證與失效

| 情境 | 行為 |
|---|---|
| 快取目錄存在且 `install.json` 與 binary sha256 相符 + `--version` 相符 | 直接使用，**不訪問網路、不重抓 checksums** |
| `install.json` 缺失（例如使用者手動放了 binary） | 執行 `--version` 驗證；相符則補寫 `install.json`（`source: 'adopted'`）；不符則視為失效 |
| sha256 不符（檔案被改／半完成） | 標記失效 → 刪除該 target 目錄 → 重新下載（同一冷卻規則） |
| 目錄不可寫 | 記警告 → `UNAVAILABLE`（不重試下載，避免每次啟動打網路） |
| 磁碟空間不足（`ENOSPC`） | 刪除暫存 → 記警告 → `UNAVAILABLE`；訊息給出快取路徑與所需大小 |
| 插件升級（0.2.0 → 之後的修補版本） | 快取**保留**：目錄只依 BaseMind version + platform，不依插件版本 |
| BaseMind 上游升版（0.34.0 → 0.35.0） | 舊目錄保留（不自動刪除，因為可能仍有 relay 在用）；新目錄另建。文件說明可手動清理 |
| 下載中斷 | 只有 `download/` 殘留；啟動清掃 >24 h 的殘留 |

### 10.7 失敗降級矩陣（需求 §7.9）

| 失敗 | 使用者看到 | DSH 行為 |
|---|---|---|
| 無網路 / DNS / TLS | 1 行 warn（含 target、URL host、原因） | 照常啟動；無 BaseMind 工具 |
| HTTP 403／404 | warn（含 status；404 特別提示「該平台可能沒有 asset」） | 同上 |
| HTTP 429／5xx | warn + 退避（≤2 次重試） | 同上 |
| 下載逾時 | warn | 同上；abort 後清理暫存 |
| 磁碟不足／目錄不可寫 | warn（含路徑、所需大小） | 同上 |
| SHA256 不符 | **error 級 warn**（明確寫「拒絕使用未校驗的 binary」） | 同上；不 fallback 到其他來源 |
| 解壓失敗／無預期 entry | warn（含 code） | 同上 |
| Binary 不可執行 | warn | 同上 |
| 不支援的 arch | warn（Intel Mac／Windows arm64 → 指向自建或官方文件） | 同上 |
| 版本驗證失敗 | warn | 同上 |

**統一要求**：所有這些都不 throw 到 Host；`apply()` 正常返回；`failOnStartupError:true` 時才 fail-fast（既有語意）。

### 10.8 可觀測性介面

`binaryManager.status()` 回傳（給日誌與未來 UI，不新增 UI）：

```js
{ pluginVersion, upstreamVersion,
  selection: { source: 'command'|'env'|'path'|'managed'|'npx'|undefined,
               path, version, compatible, reason },
  cache: { root, target, present, valid, sha256, installedAt },
  download: { state: 'idle'|'running'|'failed'|'cooldown', attempts, lastError, nextAttemptAt } }
```

日誌格式固定前綴 `[dsh-basemind-plugin]`，每類事件**每個 process 最多一次**（避免刷屏）：selection、fallback、download-start、download-done、download-failed、skills-registered(count)、tools-registered(count)、relay-ready(root)、daemon-conflict。
**禁止**輸出：API key、token、password、secret、完整環境變數、「看起來像憑證」的值（沿用 `lib/executable.js:43` 的 `SECRET_ENV_KEY` 判定）。

---

## 11. Daemon 及索引相容性安全策略

### 11.1 已確認的上游事實（決定設計的硬約束）

| 事實 | 出處 |
|---|---|
| `RELEASE_MINOR` 是**唯一**的持久化 schema 版本來源；bump 後每個 view 第一次開啟就重置 `index.msgpack` 與 group 的 fjall index，並重新 extract 每個檔案 | `src/version.rs:3-11, 30` |
| 0.34.0 的 `RELEASE_MINOR = 34`（0.33 為 33）→ blob store 移到 `cache/blobs/v34/`，每份 document/code chunk 重新 embed 一次 | `version.rs:30`；`CHANGELOG.md:15-18`；`UPGRADING.md:34-37` |
| 0.34.0：daemon protocol **7**（0.33 為 4）、relay protocol **2**（0.33 為 1） | `UPGRADING.md:415-416, 677` |
| socket／lock／log／comms store 移到 `comms/g1/`，registry 移到 `daemons/g1/`；**每個 binary 只看自己的 generation**，所以 0.33 與 0.34 不共用 daemon | `UPGRADING.md:451-461` |
| **但 index／memory／git-history 不是 per-generation**：一個 generation 的 daemon 持有某 workspace 時，另一代無法服務它的 index；持續到第一個 daemon 放手（最後一個 client 關閉後 **10 分鐘**） | `UPGRADING.md:474-479` |
| 被擋住的一方的具體行為：`initialize` 最多等 10 s、照樣列出工具、每個工具呼叫回 **retryable `backend_unavailable`（JSON-RPC `-32003`）**，並自帶「另一個 basemind 持有此 workspace 的索引（版本、pid）」訊息；一分鐘內自動重連並送 `notifications/tools/list_changed` | `UPGRADING.md:480-494` |
| 一個 **repository group** 一份索引，group key = 主 worktree 根的 blake3；一個 group 只有一個 writer；「新版本掃過一個 worktree 就會把舊版本鎖在整個 group 之外」 | `docs/adr/0028-content-keyed-group-index.md:45-47, 86-97` |
| `BASEMIND_COMMS_DIR` **不受** `BASEMIND_DATA_HOME` 管轄；要完整隔離必須兩個都設 | `docs/manual/data.md:33` |
| `comms stop`、`scan`、`cache clear`（`blobs` 是**機器全域**）、`memory clear` 都是破壞性或全域操作 | `src/cli/admin.rs:140-143`；`src/cli/memory.rs:85-92` |

### 11.2 設計決策

| # | 決策 | 理由 |
|---|---|---|
| S1 | **預設共用使用者的 `BASEMIND_DATA_HOME` 與 `BASEMIND_COMMS_DIR`**（插件不設定、不覆寫） | 切換 Data Home 會讓「用戶原有記憶不可用」（需求 §7.10 明令禁止）；memory notes 在 `cache/repos/<group>/`，與版本無關，換 home 等於換資料庫 |
| S2 | **不自動停止任何 daemon、不自動 `comms stop`、不自動 `scan`/`rescan`/`cache clear`/`memory clear`** | 需求 §7.10；AGENTS.md §5 |
| S3 | **不做 per-version Data Home 隔離** | 需求 §7.10 明確列為「默認不得」的行為之一（任意切換 Data Home） |
| S4 | 版本切換時**只提示，不遷移** | 遷移必然涉及重建索引；是否重建由使用者決定 |
| S5 | 兩個版本同時存在時，**降級為可診斷**而非重試風暴 | 上游已保證一分鐘內自動重連；我們不額外輪詢 |

### 11.3 版本切換偵測與提示

在 `state.json` 記錄每個 workspace root（或 group 根）「上次成功使用的 BaseMind 版本」。選型完成後：

```
if (state.lastVersion[root] !== undefined && state.lastVersion[root] !== selected.version) {
  warnOnce(
    `BaseMind ${state.lastVersion[root]} → ${selected.version}：` +
    `上游 bump RELEASE_MINOR 時，每個 view 第一次開啟會重建索引（0.34 為 33→34，` +
    `blob store 移到 cache/blobs/v34/）。若舊版 daemon 仍在跑，工具呼叫會回 -32003 直到它放手。` +
    `建議：basemind comms stop → basemind scan → 重開 session。插件不會自動執行這些操作。`
  )
}
```

- 只在**版本真的改變**時提示一次（不是每次啟動）。
- 提示文字不含絕對 host 路徑（沿用上游「錯誤訊息不指名 host 路徑」的習慣，也避免日誌洩漏）。

### 11.4 `-32003` 的處理

現有 `lib/tool-bridge.js:69-72` 已把 JSON-RPC code 附加到錯誤訊息（`[jsonrpc=-32003]`）。本次再加：

1. **診斷線索**：`-32003` 時錯誤訊息後面追加一段固定說明（一次性，不是每次呼叫）：
   `另一個 BaseMind daemon 持有此 workspace 的索引；執行 'basemind comms stop'（或等它在最後一個 client 關閉後 10 分鐘自行退出）再重試。`
2. **不自動重試工具呼叫**：維持「一次呼叫一次結果」的既有語意（AGENTS.md §5）。上游的 `notifications/tools/list_changed` 重連路徑已經讓工具集自動更新（`index.js:107-109`）。
3. **不自動 `comms stop`**——即使是「明顯可修」的情況。這是硬約束。

### 11.5 索引風險的呈現（文件與診斷）

- README 的「升級到 0.34.0」章節（已存在，內容正確）保留並擴充：加入「Managed Binary 也會共用同一份索引」的說明。
- 新增診斷入口（文件層級，不新增 CLI 工具）：使用者可要求 agent 執行 `mcp__basemind__cli` 的 `doctor`、`status`、`upgrade --plan`（皆為唯讀）。
- **不**在插件內自動呼叫 `upgrade --plan`（讀整個 data home，成本不可控）。

### 11.6 明確不做的遷移

| 情境 | 不做的事 | 使用者做法 |
|---|---|---|
| 0.33 → 0.34 | 不自動 `comms stop`／不自動 `scan` | 依 README 三步 |
| 索引 schema 不符 | 不刪除 `cache/groups/<group>/` | 讓 0.34 自己重建（上游設計就是「非破壞性失效」） |
| 磁碟不足 | 不執行 `cache gc`／`cache clear` | 文件說明 `--dry-run` 觀察後自行決定 |
| 記憶體／document store | 不 `memory clear`、不刪 `cache/repos/` | — |

---

## 12. 官方 Skills 同步及註冊設計

### 12.1 官方資產的既知事實

- 10 個 skill，`skills/` 與 `plugin/skills/` **byte-identical**（`skills/.ai-rulez-public-skills.json` 指明 source = `plugin/skills`，`skill_count: 10`）。另有 5 處鏡像（`opencode-plugin/skills/`、`.codex-plugin/skills/`、`.cursor-plugin/skills/`、`plugin/.pi/skills/`、`plugin/.hermes/…`）全部相同。
- 每個 skill 目錄 = `SKILL.md` + `index.md`（共 20 檔）；**沒有** `references/`、`scripts/`、`assets/` 子目錄。
- frontmatter **固定 4 個 key**：`description`、`name`、`license: MIT`、`metadata.{author, repository}`。沒有 `allowed-tools`、`version`、`disable-model-invocation`。
- 正文開頭有生成標記：
  ```
  <!--
  AI-RULEZ :: GENERATED FILE — DO NOT EDIT
  Content-Hash: blake3:…
  Source-Hash: blake3:…
  Schema-Version: v1
  -->
  ```
  上游由 `scripts/sync_public_skills.py` 生成，`tests/plugin_manifest_smoke.rs` 斷言各鏡像 byte 相等 → **上游文字是凍結資產，任何 DSH 適配都必須是「建置步驟」而非 hand-edit**。
- `LICENSE`：MIT，`Copyright (c) 2026 Na'aman Hirschfeld`（`LICENSE:1-3`），無 SPDX 行。

### 12.2 需要 DSH 適配的具體位置（全部已定位）

| # | 位置 | 原文性質 | DSH 問題 | 適配動作 |
|---|---|---|---|---|
| R1 | `basemind-cli/SKILL.md:30`、`basemind-doctor/SKILL.md:32`、`basemind-scan/SKILL.md:55`、`basemind-stats/SKILL.md:22` | `` `${CLAUDE_PLUGIN_ROOT}/scripts/mcp-launch.sh <args>` `` | DSH 沒有這個檔案；且直接叫 agent 用 PATH 上的 `basemind` 會拿到**版本不符**的 binary（需求 §7.11 明令禁止） | 替換為「用 `mcp__basemind__cli` 工具（它與 MCP 使用同一個已校驗的 binary）」，並保留「CLI 與 MCP 共用同一份 cache」的語意 |
| R2 | `basemind/SKILL.md:142-143` | "The MCP server is launched by the host (`basemind serve`, wired up in `.claude-plugin/plugin.json` for you)" | 點名 Claude Plugin | 替換為 DSH 事實：「由 dsh-basemind-plugin 啟動 `basemind serve`，你不需要自己啟動」 |
| R3 | `basemind-doctor/SKILL.md:98-104` | 只列 Claude Code／Cursor 的重連建議 | DSH 使用者無對應操作 | 追加 DSH 段落（停用／重新啟用插件、重開 session） |
| R4 | `basemind-comms/SKILL.md:38-40` | "In Claude Code the plugin's PreToolUse hook injects a session or subagent `as` when you give none." | DSH 沒有 PreToolUse hook（且本次不實作，需求 §10 明列非目標） | 替換為「DSH 不會注入 `as`；subagent 每次呼叫都必須自己帶 `as`」 |
| R5 | `basemind-stats/SKILL.md:2,28,57`（`/bm-stats`）、`basemind-doctor/SKILL.md:41`（`/bm-scan`） | Claude slash command | DSH 的 user-invocable 是 `/<skill-name>` | 追加一行：「DSH：`/basemind-stats` 直接載入本 skill」 |
| R6 | `basemind/SKILL.md:20-21` | "The job tools are always loaded: call them directly, no tool search needed." | DSH 沒有 tool-search 延遲載入（工具 schema 本來就全在） | **不改**（敘述仍成立），但在同步清單中標記為「已檢查、無需改」 |

**不適配**（保持原樣）：所有 MCP 工具名稱（15 + 3，DSH 也是同名）、所有 CLI 動詞、所有 `basemind manual` 主題名、`BASEMIND_*` 變數名。

### 12.3 同步腳本設計（`scripts/sync-basemind-skills.mjs`）

```
node scripts/sync-basemind-skills.mjs --tag v0.34.0 [--source <local-dir>] [--check]
```

流程：

1. **解析來源**：預設從 `https://raw.githubusercontent.com/Goldziher/basemind/<tag>/skills/` 取得 20 個檔案；`--source <dir>` 供離線／CI 用既有 clone（本次規劃已在 `/tmp/basemind-research/upstream` 驗證 tag 內容）。
2. **驗證數量與名稱**：必須正好 10 個目錄，名稱集合等於 `UPSTREAM.skills.names`；每個目錄必須有 `SKILL.md`，`:---:` frontmatter 必須含 `name`、`description`、`license`、`metadata.author`、`metadata.repository`；`index.md` 一併帶（保留完整性）。
3. **檢查上游版本一致性**：從 tag 的 `Cargo.toml`（或 `src/version.rs` 的 `RELEASE_MINOR`）或 tag 本身讀出 0.34.0，與 `UPSTREAM.version` 比對；不符即失敗（避免把 main 分支的內容當成已發布版本）。
4. **套用適配規則（declarative，逐條錨定）**：
   ```json
   { "id": "R1", "skill": "basemind-cli", "find": "${CLAUDE_PLUGIN_ROOT}/scripts/mcp-launch.sh <args>",
     "replace": "`mcp__basemind__cli`（DSH 內與 MCP 使用同一個已校驗 binary）<args>",
     "expectOccurrences": 1 }
   ```
   - **每條規則必須恰好命中 `expectOccurrences` 次**；任何一條 0 命中或次數變動 → **同步失敗**（這就是「檢測 DSH 適配規則是否失效」）。
   - 規則檔獨立存放（`skills/.dsh-adapt.json`），與 vendored 內容一起提交，讓 review 看得到「我們改了官方文字的哪幾行」。
5. **寫出**：`skills/<name>/SKILL.md`、`skills/<name>/index.md`、`skills/LICENSE-basemind.txt`（原文照錄）、`skills/UPSTREAM.json`：
   ```json
   { "upstream": { "repository": "...", "tag": "v0.34.0", "commit": "8e7b149",
                   "license": "MIT", "copyright": "Copyright (c) 2026 Na'aman Hirschfeld" },
     "syncedAt": "2026-11-24",
     "skills": { "basemind": { "sourcePath": "skills/basemind/SKILL.md",
                               "sourceSha256": "...", "outputSha256": "...",
                               "adaptations": ["R2","R6"] }, ... } }
   ```
6. **`--check` 模式**：不寫檔，若任何檔案內容或雜湊與 `UPSTREAM.json` 不符 → exit 1（CI 用）。這同時保證「npm 發布包內是完整且已驗證的 Skills」（需求 §5.3）。
7. **不做的事**：不在插件啟動時從網路抓 skills；不讀 `main` 分支；不覆寫使用者目錄；不改動上游檔案的 `Content-Hash` 行（保留可追溯性——我們的轉換會記在 `UPSTREAM.json` 的 `outputSha256` 與 `adaptations`）。

### 12.4 執行期註冊（`lib/skills/provider.js`）

```js
const PROVIDER_NAME = 'basemind'
const SKILL_RANK = 1000            // 低於 filesystem 全部層級（bundled 600 最高）

const provider = {
  name: PROVIDER_NAME,
  async list() {
    const readiness = await readiness.get({ signal })   // 已選型並 READY？
    if (!readiness.ok) return []                        // 不可用 → 目錄中不存在
    return SKILLS.map((entry) => ({
      name: entry.name,                                  // 例如 'basemind-code-search'
      description: entry.description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER_NAME,
      source: 'bundled',
      resourceBase: { kind: 'directory', path: SKILLS_ROOT },
      path: entry.absPath,                               // 真實檔案，讓 UI 可預覽
      rank: SKILL_RANK,
      locator: entry.name,
    }))
  },
  async get(candidate) {
    if (!readiness.cached().ok) return undefined         // 載入瞬間再次確認
    const entry = BY_NAME.get(candidate.name)
    if (!entry) return undefined                         // 回 undefined 讓 registry 當成 stale
    return { ...candidate, content: entry.body, path: entry.absPath }
  },
}
```

註冊與失效：

```js
const skills = ctx.get?.('skills')
if (skills === undefined || skills === null) {
  logger?.debug?.('[dsh-basemind-plugin] ctx.skills 不可用；本次不註冊官方 Skills')
} else {
  let control                                  // 來自 registerProvider 的 factory 參數
  const dispose = skills.registerProvider((c) => { control = c; return provider })
  disposers.push(dispose)
  readiness.onChange(() => control?.invalidate())   // READY ↔ UNAVAILABLE 時重發 catalog
}
```

**逐條回應需求 §5.1**：

| 要求 | 實現 |
|---|---|
| 安裝後自動可被發現 | provider 在 `apply()` 內同步註冊；DSH 在首個請求前發布 catalog |
| 不需手動安裝第二套 | skills 隨 npm 套件出貨（`files` 加 `skills/**`） |
| 不需改 Agent Preset | 使用 global 註冊（host row 的 context 無 scope） |
| 按需載入、不注入全文 | DSH `skill` 工具載入 body；catalog 只有 name+description（≤500 字） |
| 停用／卸載／重載正確清理 | `registerProvider` 回傳的 disposer 進既有 `state.disposers`，由單一 effect 逆序執行 |
| 不刪除／不覆蓋其他同名 Skills | `SKILL_RANK = 1000`：任何 filesystem 層級（100–600）或 runtime（250）的同名 skill 都勝出；我們只在「沒有任何其他來源」時提供 |
| 明確處理名稱衝突 | 若同一 workspace 已有同名 skill（可用 `ctx.skills.list({cwd})` 比較 provider 欄位），記一次 info：「`basemind` skill 由 <provider> 提供，插件的官方副本未被使用」 |
| 重載不重複註冊 | provider 名稱固定；`registerProvider` 對同 layer 同名 duplicate 會拋錯 → 我們用單一 effect 保證只註冊一次；重載是「先 dispose 再 apply」，天然不重複 |
| 可用性與 Binary 一致 | `list()` 在 binary 未 READY 時回 `[]`；`get()` 再檢查一次；readiness 變更觸發 `invalidate()` |

### 12.5 衝突與 rank 的實際行為（可測）

`dsh-skill` 的合併順序是「近 layer 直接勝出；同 layer 內 rank 小者勝」。因此：

| 情境 | 結果 |
|---|---|
| 使用者在 `~/.dsh/skills/basemind/` 自建同名 skill（rank 400） | 使用者版本勝出；我們的副本隱藏（符合需求） |
| 專案內 `.dsh/skills/basemind/`（rank 100） | 專案版本勝出 |
| `@wenaixi/dsh-superpower` 之類的 runtime 註冊（rank 10 或 250） | 對方勝出 |
| 無任何其他來源 | 我們的副本提供 |
| 我們的 provider 停用後 | 目錄中消失；DSH 追加空 catalog 撤銷舊名稱（`dsh-tool-skill` 行為） |

### 12.6 授權保存

- `skills/LICENSE-basemind.txt` 逐字保存上游 MIT 全文（含 `Copyright (c) 2026 Na'aman Hirschfeld`）。
- `skills/UPSTREAM.json` 記錄 repository／tag／commit／license／copyright 與每個檔案的 sha256。
- 每個 `SKILL.md` 的 frontmatter `license: MIT` 與 `metadata.{author,repository}` **原樣保留**。
- README 的 License 段落補一句：內含的 `skills/` 來自 BaseMind，MIT，著作權屬原作者；本專案對其的修改（DSH 適配）逐條列於 `skills/.dsh-adapt.json`。

---

## 13. Bootstrap 及 Lifecycle 設計

### 13.1 與既有 MCP instructions 的重疊分析（先做減法）

現有 `registerInstructions()` 已把 BaseMind 的 server instructions（2,627 B）掛成 prompt section。該文字的內容（`fixtures/basemind-0.34.0-instructions.txt`）已包含：

- 「basemind 是本 repo 的索引與上下文層」
- 「**先用它的工具，再用 shell `rg`/`grep`/`find`/`git`，也不要在讀整檔前先讀」→ 需求 §6.1 的「優先使用 BaseMind 定位符號」**已被覆蓋**
- 每個工具的呼叫範例、路徑與行號慣例、paging／budget／truncated 語意
- `isError` + `structuredContent.{error,retryable}` 的錯誤碼清單
- agent tools 的存在

因此 bootstrap **不得**重複上述內容。它只補 MCP instructions **沒有**的三件事：

1. **CLI 補充路徑**（MCP 沒有的高階分析：`code explain`／`impact`／`deadcode`／`cycles`／`migration check`／`git hotspots`／`overview`／`doctor`／`status`／`upgrade --plan`／`manual`）→ 用哪個工具、不要用 PATH 上的 `basemind`。
2. **Fallback 規則**：BaseMind 覆蓋不到（語言未索引、檔案非索引範圍、`index_unavailable`、空索引、搜尋結果不足）→ 正常改用 DSH 原生 read／grep／glob／bash。
3. **工作區語意**：BaseMind 的索引針對「當前 session 的工作區」；切換目錄後下一次呼叫即生效；不要在錯誤的 repo 上解讀結果。

### 13.2 文字內容（定稿，≤1,600 bytes）

```
BaseMind is wired into this session as the workspace-aware MCP server "<serverName>"
(dsh-basemind-plugin, BaseMind <version>, binary source: <explicit|path|managed>).

Use the tools' own instructions first — they are the authoritative playbook.
This note only covers what they do not:

- Advanced analysis with no MCP tool: <cliToolName> runs the same verified binary
  as the MCP server with argv (no shell). Read-only verbs:
    code explain <path|symbol>   code impact <path>   code deadcode
    code cycles                  code migration check  overview
    git hotspots                 doctor   status   upgrade --plan   manual [topic]
  Do not invoke a bare `basemind` from PATH: it may be a different version.
- When BaseMind cannot answer — the file/language is outside the index, a result is
  empty, or it reports index_unavailable / stale — fall back to the harness's own
  read/grep/glob/bash tools instead of retrying BaseMind.
- The index belongs to the workspace this session is working in; after changing
  directory, the next call is routed to the new workspace automatically.
- The `basemind` skill holds the long-form playbook for each capability; load it
  through the skill tool only when you need that detail.
```

- 這是**動態文字**：`<version>`、`<serverName>`、`<source>`、`<cliToolName>` 在 READY 時填入；未 READY 時整段回 `''`。
- **不含時間戳、不含工作區絕對路徑**（保持 prompt 前綴穩定，KV cache 友好；需求 §18）。
- `interpolate: false`（既有不變量；避免 `{}` 被當變數）。

### 13.3 註冊方式

```js
const section = {
  name: `mcp:${serverName}:bootstrap`,
  order: sectionOrder() + 10,          // 緊接在 MCP_SERVERS(3100) 之後；沿用既有 fallback 邏輯
  interpolate: false,
  text: () => (readiness.ready ? bootstrapText(...) : ''),
}
disposers.push(ctx.systemPrompt.section(section))
```

- `text` 是**函式**：每 step 呼叫；READY 之後才有內容，避免「先注入再撤回」（撤回會讓 system prompt 變動、破壞前綴快取）。
- 名稱與既有 `mcp:${serverName}` 不同 → 不衝突；既有 section 不動。
- **只註冊一次**（`state.bootstrapRegistered` flag，與 `instructionsRegistered` 同模式）。

### 13.4 Lifecycle 對照（需求 §6.2）

| 事件 | 本計畫的處理 | 依據 |
|---|---|---|
| Session 建立 | 什麼都不做（bootstrap section 已是 registry 的一部分） | §4.3 |
| Session 恢復 | 什麼都不做 | 同上 |
| Agent 建立 | `agent/created`：若尚未 READY，採用其 working directory 作為 discovery root（**沿用既有邏輯**）；若已 READY，僅在該 root 未被記錄時刷新可用性快照（不 spawn relay） | `index.js:475-493` |
| Subagent 建立 | 同上；subagent 的 `ctx.workingDirectory.ensure` 已由既有 tool-bridge 在呼叫時解析 | `lib/tool-bridge.js:150` |
| Context compaction | **不實作重注入**；新增測試斷言「compaction 後 section 仍存在且只有一份」 | §4.3；`dsh-compaction/src/types.ts:24,34` |
| Session 切換工作目錄 | 不做事（工具呼叫時解析）；bootstrap 文字**刻意不提固定路徑** | `working-directory/change` 是 session event，非 ctx event |
| 插件重新載入 | 既有單一 effect 先 dispose（逆序）再 apply；provider／section／tools 都重建 | `index.js:552-572` |
| 插件停用 | 同上；`binaryManager.dispose()` 會 abort 進行中的下載並清除 timer | 新增 |
| 插件卸載 | 同上 + `pool.terminateSyncAll()`／`disposeAll()`（既有） | 同上 |

**明確不做**（需求 §6.2 的「不得」）：
- 不在 `agent/pre-step` 或每個 turn 追加任何 bootstrap 訊息。
- 不把 bootstrap 狀態放進模組級變數（不同 Session／Agent 會互相污染）；狀態全部在 `apply()` 的閉包內，且 per-agent 的可用性用 `WeakMap<Agent, snapshot>`（以 Agent 物件為 key，不會跨 Session 洩漏）。
- 不在 compaction 後補訊息。

### 13.5 可用性感知（需求 §6.3）

單一 `readiness` 物件（`EventEmitter` 最小實作或 callback 陣列）提供同步查詢：

```js
readiness = {
  ready: boolean,                    // binary 已選型且相容
  primaryRootReady: boolean,         // 至少一條 relay 成功
  reason: string | undefined,        // 最後一次不可用的原因（供日誌與測試）
  onChange(listener): dispose,
  cached(agent?): { ok: boolean, reason?: string },
}
```

| 條件 | 行為 |
|---|---|
| Binary 尚未就緒／下載失敗 | `ready=false` → 無 MCP tools、無 CLI tool、skills 空、bootstrap 空 |
| MCP relay 啟動失敗 | `primaryRootReady=false`；tools 依既有邏輯未註冊；bootstrap 空 |
| 當前工作區不適合索引（BaseMind 拒絕非專案 root） | 既有行為：`tryInitialize` 失敗 → `retry` + 背離快取；bootstrap 仍顯「可用」但文字中的 workspace 語意已提示；**不再逐 workspace 展開提示**（最小充分） |
| 工具被使用者權限／策略排除 | 我們不做 per-agent 偵測（`AssembleContext` 有 scope 但查權限需要 toolSet）。文字**不宣稱「你一定有這些工具」**，而是「MCP server `<name>` 已接上」——若工具被砍，模型會看到 schema 裡沒有它們，不會硬編。<br>（第二階段可選：用 `ctx.tools.get(name, agent)` 判斷，見 §13.6） |
| 索引尚未建立 | 不注入「索引已就緒」的假設；既有 MCP instructions 已教 agent 用 `index_status`。bootstrap 只說 fallback |
| 工具在當前 build 不可用 | 依賴動態 discovery：未提供的工具不會註冊；bootstrap 的 CLI 清單是**固定**的，故清單中若某命令在此 build 不存在，CLI tool 會回傳 BaseMind 自己的 usage error（可診斷），不會假裝成功 |

### 13.6 第二階段（可選，預設不做）

若第一階段實測發現「工具被權限砍掉但 bootstrap 仍存在」造成誤導，再加：

```js
text: (assembly) => {
  if (!readiness.ready) return ''
  if (assembly.scope !== undefined && !agentSeesTools(assembly.scope)) return ''
  return bootstrapText(...)
}
```

`agentSeesTools(agent)` 用 `ctx.tools.get(cliToolName, agent, undefined)` 判斷（`dsh-tools/src/index.ts:239-255`，第三參數省略代表「檢視已註冊定義」）。**先不做**：`AssembleContext.scope` 是 Agent 的推論雖有原始碼證據（`dispatch.ts:174-176`），但尚未 runtime 驗證；且此判斷每 step 執行一次，屬額外成本。列入 §22 的「未驗證／後續」。

---

## 14. MCP / CLI 一致性設計

### 14.1 問題陳述

需求 §7.11：managed fallback 之後，PATH 上的 `basemind` 可能仍是舊版；官方 `basemind-cli` skill 若直接引導 agent 執行 `basemind ...`，就會拿到不同版本 → Skills 契約與實際 binary 不一致。

### 14.2 方案比較

| 方案 | 做法 | 優點 | 缺點 | 裁決 |
|---|---|---|---|---|
| A. 只在 bootstrap 寫絕對路徑 | 把 `selection.path` 寫進 prompt | 零新工具 | 路徑含空格／特殊字元時 agent 仍需自行引號處理；Windows 上有 `.cmd` 限制；每次選型變動都要改 prompt（破壞前綴快取） | 否 |
| B. 讓 agent 用 bash 跑絕對路徑 | skill 改成「跑 `<abs path> code explain …`」 | 簡單 | 依賴 bash 工具存在與其引號處理；無法限制輸出大小；path 動態 | 否 |
| C. **一個 argv-only CLI 工具** | `mcp__basemind__cli({ args: [...] })` | 無 shell、無引號問題、統一輸出上限、可 denylist、與 MCP 同一 binary | 多一個工具 schema（約 400 bytes） | **採用** |
| D. 每個 CLI 命令一個工具 | `basemind_explain`、`basemind_impact`… | 最易用 | 需求 §8 明令「不要求將每個 CLI 命令都包裝成獨立 DSH Tool」；schema 成本高 | 否 |

### 14.3 CLI Adapter 契約

```js
{
  name: publicToolName(serverName, 'cli'),          // mcp__basemind__cli
  description: 'Run the BaseMind CLI verb (same verified binary as the MCP tools): ' +
               'advanced analysis that has no MCP tool — code explain/impact/deadcode/cycles/' +
               'migration check, overview, git hotspots, doctor, status, upgrade --plan, manual. ' +
               'Read-only verbs only. Arguments are passed as argv, never through a shell.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      args: { type: 'array', items: { type: 'string' },
              description: 'Full argv after the program name, e.g. ["code","explain","lib/x.js"].' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 },
    },
    required: ['args'],
  },
  output: { schema: RESULT_SCHEMA, render: (a, v) => projectContent(v) },
  timeoutMs: config.toolCallTimeoutMs + 5_000,
  isConcurrencySafe: () => true,                    // 只允許唯讀動詞
  async execute({ args, timeout_ms }, exec) { … }
}
```

### 14.4 允許與禁止（雙層）

**第一層：動詞 allowlist**（第一段 + 第二段的組合）：

| 允許 | 說明 |
|---|---|
| `code` 的 `outline`／`symbols`／`read`／`grep`／`search`／`refs`／`callers`／`implementations`／`dependents`／`definition`／`find`／`files`／`chunk` | 唯讀 |
| `code` 的 `impact`／`cycles`／`explain`／`deadcode` | 唯讀（CLI only） |
| `code migration check` | 唯讀；必須第二段是 `migration` 且第三段是 `check` |
| `git` 的 `log`／`blame`／`diff`／`status`／`recent`／`touching`／`search`／`show`／`symbol-history`／`blame-symbol`／`diff-outline`／`churn`／`hotspots`／`by-path` | 唯讀 |
| `memory` 的 `search`／`get`／`list` | 唯讀（`put`／`delete`／`clear` 禁止） |
| `docs search` | 唯讀 |
| `status`、`doctor`、`overview`、`statusline`、`sessions`、`manual`、`man`、`completions` | 唯讀 |
| `upgrade --plan` | 唯讀；**必須**含 `--plan` |
| `admin` 的 `repo`／`telemetry`／`tokens`／`eval` | 唯讀（`admin` 目前無寫入子命令） |
| `cache stats` | 唯讀（`gc`／`clear` 禁止） |

**第二層：denylist（優先於 allowlist，任何出現都拒絕）**：

```
init, scan, rescan, watch, serve, hook, lang, daemon, comms, agent, workspace,
memory put|documents|delete|clear, cache gc|clear, upgrade（無 --plan）, admin（未知子命令）
```

拒絕時回傳**錯誤結果**（不是 throw 靜默），訊息示例：
`dsh-basemind-plugin: "cache clear" is a destructive machine-global command; run it yourself in a terminal. Allowed: <list>`

### 14.5 執行細節

| 需求（§8 / §7.11） | 實作 |
|---|---|
| 使用 argv 而非 shell 字串 | `buildLaunchArgv({ exe: selection.path, args: [...args, '--root', '.'] })` → `ctx.subprocess.spawn({ argv, cwd: root, … })` |
| 工作區來自當前 Agent | `root = await ctx.workingDirectory.ensure(agent, exec.signal)`；`cwd: root`；**工作區路徑不進 argv**（沿用既有 `--root .` 慣例，`lib/executable.js:11-13` 已解釋原因） |
| 超時 | 以 `timeout_ms`（clamp 到 `config.toolCallTimeoutMs`）為上限；逾時 → `handle.terminate()` → 回傳 `{ timedOut: true, stdout, stderr }` 的錯誤結果 |
| 取消 | `exec.signal` abort → terminate + 清理 |
| 限制輸出 | `stdio: { stdout: { maxBytes: 64*1024, spill: { maxBytes: 2*1024*1024 } }, stderr: { maxBytes: 8*1024 } }`；用 `handle.collected.stdout.readFrom(0)` 取回 `{ text, lossy, spillPath }`；結果文字附註 `[output truncated; full stream: <spillPath>]` |
| 不把大量輸出注入 | 上限 64 KB；超出時提示可加 `--json`／`limit`／`cursor` 縮小（沿用上游 paging/budget 機制） |
| 不暴露任意命令 | 無 shell、無 `cwd` 參數、無 env 參數、無 stdin、argv 必經 allowlist/denylist |
| 使用同一 Binary | `selection.path`（與 MCP relay 相同來源）；binary 重新選型時 CLI tool 一併重註冊 |
| Windows 空格路徑 | 走既有 `buildLaunchArgv`：真 `.exe` 直接 spawn（路徑含空格也可以）；`.cmd` 才需要 wrapper 限制（既有 `assertCmdWrappable` 會給可診斷錯誤） |

### 14.6 Skills 端的映射（R1 替換文字）

四個含 `${CLAUDE_PLUGIN_ROOT}` 的位置統一替換為：

```
`mcp__basemind__cli` with `args: [...]` — the plugin runs the same verified binary as the
MCP tools (no shell, argv only), so <command>
```

替換後的句子仍保留原本的 CLI 動詞（例如 `code explain`／`admin telemetry --json`），只把「怎麼執行」換成 DSH 的說法。**不動**任何命令語意與參數。

### 14.7 不做的事

- 不新增 `basemind-*` 的其他工具（需求 §8）。
- 不代理 `basemind serve`（既有 relay 已負責）。
- 不提供 `--root <任意路徑>`（避免繞過 workspace 路由）。
- 不執行 `memory clear`／`cache clear`／`comms stop`／`scan`／`rescan`。

---

## 15. 文件級修改矩陣

### 15.1 新增

| 檔案 | 行數（估） | 職責 | 對應需求 |
|---|---|---|---|
| `lib/status.js` | ~130 | 狀態快照與人類可讀渲染（`/basemind-status`） | §7.5（D3） |
| `lib/upstream.js` | ~90 | 版本唯一來源 | §7.1 |
| `lib/binary/platform.js` | ~70 | target 解析 | §7.5 |
| `lib/binary/probe.js` | ~110 | 版本探測＋快取 | §7.3 |
| `lib/binary/checksums.js` | ~50 | checksums 解析 | §7.6 |
| `lib/binary/download.js` | ~190 | 下載＋sha256 | §7.5 |
| `lib/binary/archive.js` | ~240 | 安全解壓（tar.gz/zip） | §7.6 |
| `lib/binary/manager.js` | ~330 | 選型／鎖／安裝／狀態 | §7.2, §7.7, §7.8 |
| `lib/cli-tool.js` | ~190 | CLI Adapter | §8, §7.11 |
| `lib/skills/provider.js` | ~200 | Skills provider | §5 |
| `lib/prompt/bootstrap.js` | ~80 | bootstrap 文字與 section | §6 |
| `scripts/sync-basemind-skills.mjs` | ~260 | 上游同步＋`--check` | §5.3 |
| `skills/<10 names>/SKILL.md`、`index.md` | 上游 1,557 行 | vendored 官方 skills（已適配） | §5.1 |
| `skills/LICENSE-basemind.txt` | 21 | 上游 MIT 原文 | §5.3 |
| `skills/UPSTREAM.json` | ~120 | provenance | §5.3 |
| `skills/.dsh-adapt.json` | ~80 | 適配規則（可審查） | §5.2, §5.3 |
| `test/upstream.test.mjs` | ~120 | 版本一致性 | §12.1 |
| `test/binary-platform.test.mjs` | ~80 | 平台矩陣（含 Intel Mac／Windows arm64） | §12.2 #15 |
| `test/binary-probe.test.mjs` | ~150 | 探測／快取失效／超時／無法執行 | §12.2 #11,#12,#18 |
| `test/binary-manager.test.mjs` | ~320 | 19 個決策案例 | §12.2 |
| `test/binary-download.test.mjs` | ~300 | mock HTTP、sha256、失敗 | §12.3 |
| `test/binary-archive.test.mjs` | ~220 | tar.gz／zip／惡意壓縮包 | §12.3 |
| `test/binary-concurrency.test.mjs` | ~200 | 多 process 鎖、stale、single-flight | §12.4 |
| `test/skills.test.mjs` | ~220 | 10 skills、frontmatter、衝突、重載 | §12.5 |
| `test/bootstrap.test.mjs` | ~180 | 文字內容、可用性、不重複 | §12.6 |
| `test/cli-tool.test.mjs` | ~220 | allowlist／denylist／輸出上限／同一 binary | §12.2 #19 |
| `test/status.test.mjs` | ~170 | `/basemind-status` 的六種情境與渲染穩定性 | §7.5（D3） |
| `docs/upstream-sync.md` | ~120 | 下一個 BaseMind 版本的同步指引 | §15 |

### 15.2 修改

| 檔案 | 變更 | 風險 |
|---|---|---|
| `index.js` | 引入 `binaryManager`、`skills provider`、`bootstrap section`、`cli-tool`、`status command`；`createSession` 改用選型結果；新增 readiness 狀態與 `agent/created` 的可用性刷新；`shutdown` 增加新 disposer 與 `binaryManager.dispose()` | **中**：核心入口，必須保持既有註冊／清理順序不變量 |
| `lib/config.js` | 新增 6 組設定（§15.3）；既有 12 個設定不變 | 低 |
| `lib/executable.js` | `readVersion` 改為 `probeVersion`（回傳解析後版本）；`resolveLaunch` 接受 `selection`；保留 `buildLaunchArgv`／`scrubEnv`／`assertCmdWrappable` 行為 | **中**：`resolveLaunch` 的錯誤訊息與優先序是既有契約 |
| `lib/tool-bridge.js` | 只加一個可選的「工具前置檢查」導出（給 CLI tool 重用 agent 解析），或完全複製 6 行解析邏輯（**選後者**，避免改動已穩定的模組） | 低 |
| `package.json` | **`version` 不動**（維持 `0.2.0`；第四輪裁決：0.2.0 未發布，本次屬同一交付）；`files` 加 `skills/**`、`lib/binary/**`、`lib/upstream.js`；scripts 加 `sync:skills`、`check:skills` | 低 |
| `cordis.patch.yml` | **顯式**寫出 `binaryDownload: true`（連同既有 `serverName`），讓「會上網」這件事在檔案裡看得見、可審計；其餘 5 項**不**寫入，避免把預設值釘死在 patch 裡（未來調預設時，舊安裝才不會被鎖住） | 低 |
| `scripts/check-manifest.mjs` | 新增斷言：本插件的 patch row 必須顯式含 `binaryDownload: true`（防止它在後續編輯中被靜默拿掉） | 低 |
| `scripts/check-pack.mjs` | 白名單／黑名單檢查（§20） | 低 |
| `AGENTS.md` | 新增「上游版本同步規則」、「Binary Manager 測試要求」、「Skills 適配規則不可手改」，以及**啟動副作用兩分類**（寫入使用者資料／專案狀態＝禁止；寫入插件自管快取＝允許，但必須顯式、可停用、失敗不阻塞） | 低 |
| `README.md` / `README.zh.md` | 新增章節（§15.4） | 低（但內容量大） |
| `CHANGELOG.md` | **歸入既有的 `## [0.2.0]` 條目**（Added／Changed），不新增版本區塊；`Changed` 的**第一條**必須是「預設會下載 managed binary」 | 低 |
| `.github/workflows/compat.yml` | 版本從 `lib/upstream.js` 讀（或加一個 `node -e` 步驟斷言一致）；不新增矩陣 | 低 |
| `.github/workflows/release.yml` | 同上；pinned 版本改讀 `UPSTREAM` | 低 |
| `.github/workflows/ci.yml` | 新增 `npm run check:skills`（`--check` 模式） | 低 |
| `test/index.test.mjs` | fake context 加 `skills` service、`systemPrompt` 支援函式 text；新增「READY 註冊／UNAVAILABLE 不註冊」案例 | 低 |
| `fixtures/fake-mcp-server.mjs` | 不變（CLI adapter 不走 MCP） | — |
| `fixtures/`（新增） | 假 binary（`fake-basemind.cmd`/`.sh`、可偽造 `--version`）、測試用 zip/tar.gz（含惡意案例） | — |
| `locale/en.json`、`locale/zh.json` | 描述文字補「official skills + managed binary」 | 低 |

### 15.3 新設定：完整說明（名稱、預設值、理由、替代方案）

#### 15.3.1 命名原則（為什麼是這 6 個名字）

1. **同族前綴**：binary 相關的全部以 `binary` 開頭（`binaryDownload`、`binaryPolicy`、`binaryFallback`），功能開關用名詞（`skills`、`bootstrap`、`cliTool`）。理由：使用者只要記得「binary 三項 + 功能三項」＝6 個名字。
2. **不重複表達同一個需求**：既有 `command` 已完整表達「指定執行檔」——[lib/executable.js](../lib/executable.js) 直接把它交給 `resolveExecutable`，絕對路徑原樣回傳，且已有測試；`BASEMIND_BIN` 則在 `command` 為預設時生效。**再新增 `binaryPath` 會讓同一個需求有三種寫法**，正是需求 §9 的禁令。→ explicit 來源沿用 `command`／`BASEMIND_BIN`；`binaryFallback:false` 的「顯式」判別就用「`command` 非預設」與「`BASEMIND_BIN` 有值」。
3. **布林欄位用「功能名」而不是 `enableXxx`**：DSH 其他插件（含 superpowers）的慣例是短名詞（`providerName`、`switches`），且 `config.skills: false` 讀起來就是「skills 關掉」。避免 `enableSkills`／`skillsEnabled` 這種兩三種寫法並存的風格混亂。
4. **enum 欄位用「它回答的問題」命名**：`binaryPolicy` 回答「用什麼政策判斷相容」，所以值是 `exact`／`minor`／`any`（政策名），而不是 `versionMatch: 'exact'`（會讓人以為是比對方式而非接受範圍）。
5. **不用否定式命名**：沒有 `binaryNoDownload`／`disableFallback`。否定式欄位在 YAML 裡讀起來容易反直覺（`binaryNoDownload: false` = 會下載）。

#### 15.3.2 逐項說明

| 設定 | 型別 | 預設 | 語意 | 為什麼需要（沒有它會怎樣） | 替代方案與否決理由 | 代價 |
|---|---|---|---|---|---|---|
| `binaryDownload` | boolean | **`true`** | 是否允許從官方 GitHub Release 下載與 `UPSTREAM.version` 相符的 binary | **D2 第三輪裁決：預設下載。** 沒有它，新使用者裝完插件會拿到一個「0 工具、0 skills、0 引導」的空插件，而他們不會知道要翻 README 才能救（需求 §5／§6／§7 全部落空） | ①預設 `false` + 一次性提示：功能不減，但新使用者多一步；②完全刪除下載器：失去 §7.5–§7.9 的能力；③環境變數開關：不進 profile、設定頁看不到、難以診斷 | 首次需要時 2 次 HTTPS 與 75–102 MB 寫入插件快取（§18.4）；本地命中時為 0 |
| `binaryPolicy` | `'exact'\|'minor'\|'any'` | `'exact'` | 版本接受範圍（見 §9.2 全文） | 沒有它時，「版本不符」只有一條路：拒絕。使用者若刻意要跑 0.34.1 或舊版 MCP-only，完全無路可走 | ①自動 same-minor：等於把風險預設給所有人（§9.2.3 不對稱成本）；②semver range 字串：能力等價於 `minor`，但多一層解析與誤用空間（§9.2.6）；③三個獨立布林：組合爆炸且難解釋 | 三個值都要測；`any` 會停用 Skills／CLI（§9.4） |
| `binaryFallback` | boolean | `true` | 顯式 binary 不相容時，是否繼續往後面的候選找；`false` = 立刻 `UNAVAILABLE` 並只報錯 | 需求 §7.2：「明確配置的無效或不相容 Binary 不得被靜默忽略；應提供可診斷提示。默認可以在提示後 fallback」＋「研究是否需要提供禁止 fallback 的顯式設定」→ 這是那個設定。沒有它時，使用者在「我就是要用這一版，不相容就別跑」的情境下無法表達意圖，會被靜默換成別的 binary | ①只警告不提供開關：無法滿足「禁止 fallback」的顯式需求；②反向欄位 `binaryStrict`：語意更隱晦，且與 `binaryPolicy` 的「strict」混淆 | 多一條分支與測試；預設 `true` 保持既有「盡量可用」的期待 |
| `skills` | boolean | `true` | 是否向 `ctx.skills` 註冊官方 10 個 Skills | 沒有它時，無法在不卸載插件的情況下只關掉 skills（例如使用者已有自己的 `basemind` skill 家族、或想省 catalog token） | 用 `/skills` 之類的外部機制：那是 DSH 全域開關，關掉會影響所有來源，不精確 | catalog 約 800 tokens（§18） |
| `bootstrap` | boolean | `true` | 是否註冊 bootstrap prompt section | 沒有它時，只能整段刪除；而 bootstrap 的內容（CLI 路由＋fallback 規則）對某些使用者是多餘的（例如他自己在 persona 裡寫了） | 併進 MCP instructions section：會讓「遠端文字」與「本地文字」混在一起，且無法單獨關閉 | ≤400 tokens（§18） |
| `cliTool` | boolean | `true` | 是否註冊 `mcp__basemind__cli` | 沒有它時，agent 只能靠 PATH 上的 `basemind`（版本可能不符，§14.1），或者完全沒有 CLI-only 能力（`code explain`／`impact`／`deadcode`／`cycles`／`migration check`／`git hotspots`） | ①每個 CLI 命令一個工具：需求 §8 明令不做；②不加工具、只在 skill 裡寫絕對路徑：路徑動態且引號/平台問題多（§14.2 方案 A/B） | 一個工具 schema（~100 tokens）；allowlist 需維護 |

#### 15.3.3 與既有 12 個設定的關係（不變者）

`serverName`、`command`、`args`、`env`、`toolCallTimeoutMs`、`startupTimeoutMs`、`maxClients`、`autoProvision`、`npxSpec`、`failOnStartupError`、`logStderr`、`discoveryRoot` —— **名稱、預設值、語意全部不變**（§21.1）。其中：

- `autoProvision`／`npxSpec`：降為 legacy 路徑（§9.5），但仍會被讀取，行為不變。
- `command`：仍可指定非預設執行檔；它與 `BASEMIND_BIN` 就是「顯式來源」的**全部**定義（§8.1），不新增 `binaryPath`。

#### 15.3.4 為什麼不是一個「auto」布林

曾有替代設計：`binary: 'auto' | 'off' | 'path'`。否決理由：它把「要不要下載」與「用哪個來源」混成一個 enum，導致 `binary: 'path'` 時仍需要另一個欄位放路徑，且無法表達「允許下載但優先本機」這種正交組合。三個獨立欄位（download／policy／fallback）在語意上是正交的——能不能上網拿／什麼算相符／不符時要不要往下走——合併任兩個都會讓某個已文件化的場景無法表達；測試也一一對應（§17.2 的 20 個案例）。

（其餘設定維持不重複列出。）

### 15.4 README 新增章節（兩語言同步）

1. **Local First Binary 策略**（候選順序、每個候選都要版本判定、explicit 就是 `command`／`BASEMIND_BIN`）
2. **Managed Binary 自動下載（預設開啟）**（何時會下載、如何完全關閉、來源與校驗、快取位置與重用、失敗如何降級）
3. **版本匹配規則**（exact 預設、`minor`／`any` 的風險；含 §9.2 的決策表）。<br>**必須寫出「卡在 0.34.1 時」的兩條路**：①等插件更新（建議，因為 Skills 與 CLI allowlist 會一起更新）；②`binaryPolicy: 'minor'`（自負風險，且必須明寫「Skills 未對該版本驗證」）
4. **緩存位置**（`$DSH_HOME/cache/dsh-basemind-plugin/…`、如何清理、為何只在本地無相容版本時才寫入）
5. **如何確認本機 BaseMind 狀態**（`/basemind-status` 的輸出範例與判讀；版本不符、下載失敗、離線怎麼辦）
6. **如何使用自訂本地 Binary**（`command` 指向絕對路徑／`BASEMIND_BIN`／`binaryFallback:false`）
7. **離線使用**（`binaryDownload:false`，或預先放好的快取如何被重用；離線時的行為與訊息）
8. **支援的平台及架構**（明確列出 4 個 target；Intel Mac／Windows arm64 不支援與自建指引）
9. **Skills 自動註冊**（10 個名稱、如何停用、衝突時誰勝出）
10. **MCP / CLI 使用方式**（15+3 MCP tools、`mcp__basemind__cli` 的唯讀動詞）
11. **Daemon 版本衝突與索引升級風險**（擴充既有 §5.2）
12. **如何同步下一個 BaseMind 官方版本**（指向 `docs/upstream-sync.md`）

> 明確禁止的措辭：不得把 `/basemind-status` 稱為「配置頁」，也不得在 README 宣稱 GUI 內有狀態卡片（除非 D3 裁決改走 client half 並實作完成）。

### 15.5 不在本次修改範圍

`lib/schema.js`、`lib/result.js`、`lib/mcp-session.js`、`lib/stdio-client.js`、`lib/workspace-pool.js`（除必要的一行註解）不修改——它們是已驗證的穩定層。

---

## 16. 分階段實施步驟

> 每個 Phase 結束都必須「可回退、可驗證」。Execution 需在每個 Phase 後自檢並回報，不得跨 Phase 混做。

### Phase 0：凍結基線與證據（0.5 天）

1. 記錄 `git rev-parse HEAD`、`git status`、`npm test` 基線結果（預期 166 tests 全綠，依 0.2.0 report）。
2. 把本次調研的上游證據寫入 `docs/`（本文件即是）；不修改產品碼。
3. **出口條件**：基線測試結果與 0.2.0 Execution Report 一致；工作樹乾淨。

### Phase 1：上游版本來源 + Skills 同步管線（1–1.5 天）

1. `lib/upstream.js` + `test/upstream.test.mjs`。
2. `scripts/sync-basemind-skills.mjs`（含 `--check`、規則檔、provenance）。
3. 執行同步產生 `skills/**`（從 `/tmp/basemind-research/upstream` 或 raw.githubusercontent 取 v0.34.0）。
4. `package.json` 的 `files` 與 scripts；`scripts/check-pack.mjs` 擴充。
5. **出口條件**：`node scripts/sync-basemind-skills.mjs --tag v0.34.0 --check` exit 0；`npm run check:pack` 顯示 skills 在、binary 不在；尚未接 runtime。

### Phase 2：Binary Manager（3–4 天，最大塊）

1. `platform` → `probe` → `checksums` → `download` → `archive` → `manager`，依此順序、每步帶測試。
2. `lib/config.js` 新設定 + `test/config.test.mjs` 擴充（`binaryDownload` 預設 `true`、其餘 5 項的預設值都必須有專門斷言）。
3. `lib/executable.js` 的 `probeVersion` 重構（保留 `readVersion` 的既有測試通過，或同步更新測試）。
4. `lib/status.js`（純函式渲染，先不接 runtime）。
5. **出口條件**：§17.2 的 20 個案例、§17.3 的 20 個案例（下載案例在預設 `binaryDownload:true` 下執行，另有兩條「`false` 時 0 網路、0 寫入」反向斷言）、§17.4 的 8 個案例全綠；`npm test` 仍全綠。

### Phase 3：接上 runtime（1.5–2 天）

1. `index.js` 引入 manager：`createSession` 用 `selection.path`；`probeVersion` 改為驅動選型。
2. readiness 狀態 + `agent/created` 刷新。
3. `lib/cli-tool.js` 並納入 generation（`definitionsFor` 額外加入）。
4. `/basemind-status` 指令（`ctx.get('commands')`，缺則跳過）＋ 一次性啟動日誌。
5. **出口條件**：`test/index.test.mjs` 既有案例全綠；新增「UNAVAILABLE 時 0 工具、0 bootstrap、狀態指令仍可用」「READY 時 N+1 工具」案例；`test/status.test.mjs` 全綠；真實 integration 仍通過（用 `BASEMIND_BIN`）。

### Phase 4：Skills provider + Bootstrap section（1.5 天）

1. `lib/skills/provider.js`（含 rank、readiness gate、invalidate）。
2. `lib/prompt/bootstrap.js`（純函式 + 註冊）。
3. fake context 擴充（`skills` service）。
4. **出口條件**：§12.5、§12.6 的測試全綠；重載／卸載不重複、不殘留。

### Phase 5：文件、CI、打包（1 天）

1. README×2、CHANGELOG、AGENTS、`docs/upstream-sync.md`。
2. `ci.yml` 加 `check:skills`；`compat.yml`／`release.yml` 改讀 `UPSTREAM`。
3. **出口條件**：`npm run verify` 全綠；`npm pack` 內容正確；四個 workflow YAML 可解析。

### Phase 6：真實驗證（1–2 天，需環境）

1. 真實 Binary integration（Windows 本機 + 官方 asset）。
2. 可選：`compat.yml` dispatch 取得 Linux／macOS 證據。
3. DSH Desktop test profile 驗收（需人工授權；見 §19）。
4. Agent 使用效果對照（§13 of 需求；見 §17.6）。
5. **出口條件**：§17 的 Gate 全綠或明確列為未執行；Execution Report。

### 依賴圖

```
P0 ─▶ P1 ─▶ P2 ─▶ P3 ─▶ P4 ─▶ P5 ─▶ P6
                └──▶ P4（P4 只需 upstream + readiness 介面，可與 P3 並行）
```

---

## 17. 完整測試矩陣

### 17.1 既有回歸（不得刪除、不得弱化）

| 套件 | 現有案例 | 本次要求 |
|---|---|---|
| `test/mcp-session.test.mjs` | initialize、capabilities、tools/list 分頁、resources、錯誤 | 不改，全綠 |
| `test/schema.test.mjs` | 0.34 的 18 工具、retired 名稱、正規化無損、禁用關鍵字 | 不改，全綠 |
| `test/tool-bridge.test.mjs` | envelope、structuredContent、錯誤碼、JSON-RPC code、TOON 投影 | 不改，全綠 |
| `test/stdio-client.test.mjs` | framing、pending、timeout、cancel、close | 不改，全綠 |
| `test/workspace-pool.test.mjs` | 去重、caller 取消不影響他人、容量、disposal | 不改，全綠 |
| `test/result.test.mjs` | 文字投影 | 不改，全綠 |
| `test/executable.test.mjs` | `.cmd` wrapper、路徑、scrubEnv、版本探測 | **允許擴充**，既有斷言不得刪 |
| `test/index.test.mjs` | 註冊、collision、prompt section、resources、dispose | **必須擴充**（新 fake service），既有案例全綠 |
| `test/config.test.mjs` | 每個欄位的 clamp／fallback | **擴充**新欄位 |

驗收標準：`git diff` 不得出現「刪除既有 test case」或「把 assert 改寬」。

### 17.2 Binary Manager 單元（對應需求 §12.2 的 19 項 → 實測 20 項）

| # | 案例 | 期望 |
|---|---|---|
| 1 | 本地 0.34.0 相符 | `source: 'path'`（或 `'command'`），**不下載**（以 fetch spy 斷言 0 次） |
| 2 | 本地不存在，快取存在且有效 | `source: 'managed'`，不探測網路（預設設定下仍必須通過：快取是唯讀來源） |
| 3 | 本地不存在，快取不存在，`binaryDownload:true` | `source: 'managed'` + 下載 1 次 |
| 4 | 本地 0.33.0 | 不相容 → 繼續候選；預設設定下最終 `UNAVAILABLE`（警告含實際版本） |
| 5 | 本地 0.35.0 | 同上 |
| 6 | 本地 0.34.1 | 預設不相容；`binaryPolicy:'minor'` 才接受 |
| 7 | `0.34.0-rc.1` | 不相容（prerelease）；`minor` 模式亦不接受 |
| 8 | 顯式 `command` 指向相符 binary | 採用，`source: 'command'` |
| 9 | 顯式 `command`／`BASEMIND_BIN` 指向 0.33 或不存在 | 警告 + 繼續候選；`binaryFallback:false` → UNAVAILABLE |
| 10 | `binaryDownload:false` + 無本地 | UNAVAILABLE、**0 次網路、0 次寫入快取** |
| 10b | **預設** `binaryDownload:true` + 無本地 | 下載 1 次 → READY（D2 第三輪的核心案例） |
| 10c | `binaryDownload:false` + 快取有有效 binary | 使用快取（證明「不下載」不等於「不用快取」） |
| 11 | 探測逾時（fake binary sleep 10s，timeout 5s） | 子進程被 terminate、`waitForExit` 完成、判定失敗 |
| 12 | binary 存在但不可執行（chmod 644／非 PE） | 判定失敗並繼續候選 |
| 13 | Windows `.cmd` launcher | 走 `cmd.exe /d /s /c`；含空格路徑給可診斷錯誤（沿用既有 `assertCmdWrappable`） |
| 14 | Windows 含空格路徑的 `.exe` | 直接 spawn 成功 |
| 15 | 不支援的 OS／arch（`darwin`+`x64`、`win32`+`arm64`、`freebsd`） | `unsupported` + 訊息（含自建指引），且不嘗試下載 |
| 16 | 快取重用（第二次 select） | 0 次探測（快取命中）、0 次網路 |
| 17 | 快取損壞（binary sha256 與 install.json 不符） | 標記失效 → `binaryDownload:false` 時視為缺失（不重建） |
| 18 | binary 檔案變更（mtime/size 改變） | 重新探測（不是沿用舊結果） |
| 19 | MCP 與 CLI 使用同一 binary | 兩者 `selection.path` 相同；manager 重新選型後 CLI tool 一併更新 |
| 20 | 候選順序 | explicit → command → `BASEMIND_BIN` → PATH → managed 快取；以 spy 斷言順序與短路 |

### 17.3 下載與安裝（對應需求 §12.3）

> 這些案例在**預設 `binaryDownload:true`** 下執行（下載器會啟動）。另外**必須**有兩條反向斷言：
> (a) `binaryDownload:false` 時任何單元測試都不得產生網路呼叫或快取寫入（以 fetch spy + fs spy 斷言）；
> (b) 下載相關程式碼即使未被呼叫，也必須被覆蓋（用直接 import 模組的方式測，不靠配置繞道）。

| 案例 | 手法 |
|---|---|
| 成功下載 | 本地 `node:http` mock server 提供 asset + checksums |
| HTTP 400／403／404／429／500 | mock server 回對應 status；斷言重試次數與最終失敗 |
| 網路中斷（socket destroy） | mock server 中途斷開 → 失敗、暫存清理 |
| 逾時 | mock server 不回應 → `AbortSignal` 觸發、暫存清理 |
| 取消 | caller abort → 下載中止、等待者都收到取消 |
| SHA256 成功／失敗 | fixture 檔與竄改檔 |
| Checksum 缺失 | checksums 檔不含目標行 → 拒絕 |
| 解壓失敗 | 損壞的 gzip／截斷的 zip |
| 路徑穿越 | 自製 zip 內含 `../../evil.txt` → 拒絕（且不寫入任何檔案） |
| 惡意壓縮包 | symlink entry、hardlink entry、超多 entry、宣告超大 size |
| 磁碟不足 | 注入 `ENOSPC` 的 fs adapter（dependency injection） |
| 快取目錄不可寫 | 注入 `EACCES` |
| 原子提交 | 中斷在 staging → 正式目錄不存在；重跑成功 |
| 中斷後恢復 | 存在 `download/` 殘留 → 啟動清掃後重跑成功 |
| 臨時檔清理 | 成功與失敗路徑都斷言暫存目錄被移除 |
| 不執行未校驗 binary | 在 sha256 失敗後斷言**沒有**任何 `--version` 呼叫 |

**要求**：全部使用 mock server／fixture／依賴注入，**不得**在單元測試中從 GitHub 下載真實 binary（需求 §12.3 明文）。

### 17.4 併發與快取（對應需求 §12.4）

| 案例 | 手法 |
|---|---|
| 多 Session 同時首次啟動只下載一次 | 10 個並行 `select()`，mock server 計數 = 1 |
| 多 workspace 同時首次呼叫共享 binary | 兩個 root 同時 `clientFor` → 一個下載、兩條 relay 用同一個 exe |
| 多進程安裝鎖 | 兩個 child process 同時跑 manager（fixture 腳本），斷言只有一個下載 |
| 鎖持有者異常退出 | 殺掉持鎖 process，等待者偵測 stale（pid 不存在）後接手 |
| 下載成功後所有等待者恢復 | 全部拿到同一 selection |
| 單一等待者取消 | 其他等待者仍成功；共用的下載不中斷 |
| 下載失敗後不形成重試風暴 | 連續 5 次 select（模擬 5 個 session）→ 總網路嘗試 = 1（冷卻期內） |
| 插件重啟後重用快取 | 新 process（child）→ 0 次網路 |
| 插件重新載入後不重複下載 | dispose 再 apply → 0 次網路 |

### 17.5 Skills（對應需求 §12.5）

| 案例 | 期望 |
|---|---|
| 10 個 skills 完整打包 | `check:pack` + `test/skills.test.mjs` 斷言名稱集合 = `UPSTREAM.skills.names` |
| Frontmatter 與附屬資源完整 | 每個 `SKILL.md` 有 `name`/`description`/`license`/`metadata`；`index.md` 存在 |
| 正常註冊 | fake `skills` service 收到 `registerProvider`；`list()` 回 10 筆、rank 1000 |
| 同名衝突 | fake registry 已有 `basemind`（rank 400）→ 我們的候選不勝出（用 registry 的 rank 規則模擬）；插件記一次 info |
| 多 Agent 按需載入 | `get(name)` 回完整 body；`get('unknown')` 回 `undefined` |
| 重載無重複註冊 | dispose 再 apply → `registerProvider` 只被呼叫一次（第二次是新的 provider 物件） |
| 卸載後正確清理 | dispose → fake registry 的 provider 集合為空 |
| Binary 不可用時降級 | `list()` 回 `[]`；`get()` 回 `undefined` |
| Skills 與 Binary 版本一致 | `UPSTREAM.version` 與 `skills/UPSTREAM.json.upstream.tag` 對應 |
| DSH Tool Mapping 正確名稱 | vendored 文字中出現的 MCP 工具名 ⊆ 0.34 fixture 的 18 個名稱 |
| CLI Mapping 不呼叫 PATH 舊版 | 適配後文字中**不得**出現 `PATH` 上的 `basemind ` 直接執行建議；`${CLAUDE_PLUGIN_ROOT}` 出現 0 次 |

### 17.6 Bootstrap 與 Lifecycle（對應需求 §12.6）

| 案例 | 期望 |
|---|---|
| Session 建立時提供引導 | READY 後 section 文字非空、含 `mcp__basemind__cli` |
| MCP Server Instructions 不重複注入 | 兩個 section 名稱不同；bootstrap 文字**不含** `code_outline {"path"` 這類 instructions 原文片段 |
| Agent Turn 不累積重複 Bootstrap | 連續 5 次 `assemble()` → `sections` 中 bootstrap 名稱只出現 1 次、長度不變 |
| Compaction 後仍保留 | 模擬 `session/event` 的 `compaction/end` → 再 `assemble()` → section 仍在 |
| 多 Session 狀態不污染 | 兩個 fake agent 交錯 assemble → 各自文字正確（或都為空） |
| Subagent 使用正確工作區 | tool-bridge / cli-tool 的 `ensure(agent)` 被呼叫時帶入該 agent |
| Session 切換項目後路由正確 | 改 `workingDirectory.current` → 下一次呼叫用新 root（沿用既有案例） |
| 插件不可用時不誤導 | UNAVAILABLE → 0 tools、skills `[]`、section `''` |
| 停用後清理 prompt 與 skills | dispose → fake `systemPrompt.sections` 為空、provider 已移除 |

### 17.7 真實 Binary 整合（對應需求 §12.7）

沿用既有兩個 integration 檔，新增/擴充：

| 案例 | 環境 |
|---|---|
| 相容本地 binary（`BASEMIND_BIN`） | 隔離 `BASEMIND_DATA_HOME`／`BASEMIND_COMMS_DIR`／快取／測試 workspace |
| 不相容本地 + Managed fallback | fake `0.33.0` stub 當 `command`，manager 走 fallback（下載以 mock mirror 提供 fixture archive，或用預先 seed 的快取） |
| 無本地 + Managed fallback | 同上（無 stub） |
| Managed 快取重用 | 第二次啟動 0 次網路 |
| MCP tools 正常呼叫 | 既有（`index_status`、`code_outline`、`code_read`…） |
| 官方 CLI 正常呼叫 | `mcp__basemind__cli` 跑 `status`、`code outline`、`doctor` |
| MCP 與 CLI 工作區一致 | 兩者在同一 root 得到相同 repo 資訊 |
| 多 Repository 隔離 | 兩個臨時 repo，各自的索引互不干擾 |
| 同 repo 不同 worktree 的 view 隔離 | 既有 group index 語意（0.34 起共用 group，view 分離） |
| 取消／逾時／Relay 清理 | terminate 後 `waitForExit` 成功、無孤兒 |
| 新舊 Daemon 衝突診斷 | 起一個舊 stub daemon？**無法可靠模擬** → 此項列為「以單元測試驗證訊息格式」，実機列未驗證 |

**Gate**：`BASEMIND_REQUIRE_INTEGRATION=1` 時，任何 skip 都算失敗（沿用既有機制）。**必須防止「binary 不存在 → skip → 假通過」**：CI 與 release 都以「先下載並 checksum 驗證」為前置（既有 workflow 已如此）。

### 17.8 跨平台矩陣（對應需求 §12.8）

| 平台 | Runner | 本次狀態 |
|---|---|---|
| Windows x64 | `windows-latest`（本機也有） | 可實跑 |
| Linux x64 | `ubuntu-latest` | CI 實跑（本計畫只寫 workflow，不在本機執行） |
| Linux arm64 | 需 arm runner（`ubuntu-24.04-arm`，若組織可用） | **未驗證**；若無 runner 則明確標示 |
| macOS arm64 | `macos-15` | **未驗證**（本機為 Windows；workflow 已有） |
| macOS x64 | — | 官方無 asset：驗證「不支援」訊息 + 自建指引（單元測試） |
| Windows arm64 | — | 同上 |

**紀律**：不得宣稱未實測平台已通過；README 的相容性表要維持「已驗證版本」的既有精確度。

### 17.9 命令與 Gate

```bash
# 定向（開發中）
node --test test/upstream.test.mjs test/binary-platform.test.mjs test/binary-probe.test.mjs \
            test/binary-archive.test.mjs test/binary-download.test.mjs test/binary-manager.test.mjs \
            test/binary-concurrency.test.mjs test/skills.test.mjs test/bootstrap.test.mjs \
            test/cli-tool.test.mjs test/status.test.mjs

# 既有全套
npm test

# 真實 binary（Windows 本機 / CI）
BASEMIND_REQUIRE_INTEGRATION=1 node --test test/integration.test.mjs
BASEMIND_BIN=<0.33 asset> node --test test/integration-legacy.test.mjs

# 完整
npm run verify            # check + check:pack + test
node scripts/sync-basemind-skills.mjs --tag v0.34.0 --check
```

**交付 Gate（全部必綠，否則不得聲稱完成）**：
1. `npm run check`
2. `npm run check:pack`（skills 在、binary 不在）
3. `npm test`（含新測試，0 skip）
4. `npm run verify`
5. `BASEMIND_REQUIRE_INTEGRATION=1` 的真實 integration
6. `sync-basemind-skills --check`

### 17.10 Agent 實際使用效果驗證（對應需求 §13）

**設計**：A/B 對照，同一 preset、同一模型與 reasoning effort、同一測試 repo 與索引狀態、同一任務 prompt、同一檔案版本。

| 組 | 條件 |
|---|---|
| A（before） | 現行 0.2.0 程式（`f278d6c`：僅 MCP tools + instructions） |
| B（after） | 同一 0.2.0 加上本次擴充（+ skills + bootstrap + CLI adapter） |

> 因為 0.2.0 不升版，對照組必須以 **git 內容**區分（`f278d6c` 的工作樹 vs 本次交付的工作樹），不能靠版本號區分。兩組都要在同一台機器、同一個 DSH profile 的兩份 checkout 上跑，且 BaseMind binary 與索引狀態相同。

11 個場景（需求 §13 的 1–11）：定位函數定義、符號引用、檔案結構、大型檔案理解、Java 方法呼叫關係、Vue SFC、改動影響範圍、git 歷史、文件搜尋、staged changes 審查、BaseMind 無效結果時的原生 fallback。

**記錄欄位**（每個場景一列，寫入 `docs/2026-11-24-basemind-agent-effectiveness-report.md`，Execution 階段產出）：
是否主動使用 BaseMind（是／否）、BaseMind 呼叫次數、原生 grep/read/bash 次數、失敗呼叫次數、工具返回 bytes、任務耗時、token 消耗（若 DSH 可取得）、結果正確性（人工評分 1–5 + 理由）。

**判讀規則**：
- 不得只看「BaseMind 使用率」；正確性下降即視為失敗。
- Vue SFC 解析不足屬上游能力限制，不得記為插件路由缺陷（需附上游證據）。
- 若 A/B 差異不顯著，應在報告中明說，不得美化。

**成本**：11 場景 × 2 組 = 22 次任務；建議由使用者在測試 profile 執行，Agent 只負責準備 fixture 與記錄模板。

### 17.11 狀態顯示（D3，`/basemind-status`）

| 案例 | 期望 |
|---|---|
| 沒有 binary | 文字含 `present: no`、`expected: 0.34.0`、安裝指引；`kind: 'success'`（不是 error） |
| 有相符 binary | `present: yes`、`found: 0.34.0`、`compatible: yes`、`source`、`path` |
| 有不相容 binary（0.33.0） | `compatible: NO`、原因 `minor mismatch`、兩個可行動選項（升版／`binaryPolicy`） |
| 版本解析失敗（`--version` 輸出亂碼） | `found: unknown`、`compatible: NO`、原因 `unparsable`，且附已去控制字元的原始片段 |
| 平台不支援（`darwin`+`x64`） | `unsupported platform` + 自建指引；不嘗試探測 |
| 探測本身失敗（不可執行／逾時） | `compatible: NO`、原因 `probe failed`；整個指令仍在 5 s 內回 |
| 渲染穩定性 | 同一輸入渲染兩次完全相同（無時間戳、隨機、ANSI）；行寬 ≤ 100 字元 |
| 敏感性 | 輸出不含任何 `KEY`／`TOKEN`／`PASSWORD`／`SECRET` 形式的環境變數值 |
| 指令不可用時 | `ctx.get('commands')` 為空 → 不註冊、記 1 次 debug，插件其餘功能正常 |
| 卸載清理 | dispose 後 fake `commands` registry 中不存在 `basemind-status` |
| README 聲明一致 | 文件不得把 `/basemind-status` 描述成「配置頁」 |

---

## 18. 性能及 Token 開銷分析

### 18.1 每次請求的固定成本（估算）

| 項目 | 大小 | Token（≈4 B/token） | 何時存在 |
|---|---|---|---|
| MCP tools schema（0.34.0 實測） | ~20 KB compact | ~5,000 | 既有，本計畫不改 |
| MCP server instructions section | 2,627 B | ~660 | 既有 |
| **bootstrap section（新）** | ≤1,600 B | **≤400** | READY 時；其他時候 `''` |
| **skills catalog message（新）** | 10 × (name + description 截斷 500) ≈ 3.2 KB | **~800** | durable，**一次**（變更時 append 替換） |
| **CLI tool schema（新）** | ~400 B | **~100** | READY 時，且只在 step 的工具集內 |
| **合計新增** | ~5.2 KB | **~1,300** | — |

與現況（~5,660 tokens 的既有固定成本）相比，**新增約 +23%**（一次性 catalog 除外，每請求約 +500 tokens）。
若使用者覺得太重，可分別關閉：`skills:false`（省 catalog）、`bootstrap:false`（省 400）、`cliTool:false`（省 100）。

### 18.2 KV cache 影響（重要）

- bootstrap 文字**不含時間戳、不含路徑、不含計數**；READY 後內容固定 → 系統提示前綴穩定。
- `text` 是函式但輸出穩定 → 不會每次請求改變 system prompt（否則每次都要重算 prefix cache）。
- skills catalog 是 durable user-role 訊息，只在成員／描述變更時 append 替換（`dsh-tool-skill` 的 digest 機制），**不是每請求重發**。
- **刻意不做**：把「當前工作區路徑」寫進 bootstrap（會讓每個不同 workspace 的 session 產生不同前綴，且 session 內 `cd` 也會變動）。

### 18.3 啟動成本

| 動作 | 成本 | 頻率 |
|---|---|---|
| `resolveDshHome` + 快取目錄 stat | <1 ms | 每次 apply |
| 版本探測（`--version`） | 30–120 ms（Windows 實測 spawn 成本較高） | 每個 binary 每 process 一次；mtime/size 不變則不重探 |
| managed 快取驗證（sha256 重算） | 75–102 MB → 約 100–300 ms | **只在第一次驗證**；之後以 `install.json` 記錄 + mtime 判定（不每次重算） |
| 下載 | 75–102 MB，視網路 | 每 version+platform 一次（跨 session 共用） |
| Skills 讀取 | 10 檔 × ~1–14 KB，首次 `list()` 讀入並快取 | 每 process 一次 |
| MCP relay 啟動 | 既有（0.9–1.3 s handshake，實測） | 每個 root 一次 |

**空間**：每個 target 一份 binary（75–102 MB）＋ 短暫的 `download/`（同上，完成後刪除）。文件需提醒使用者可用系統工具清理舊版本目錄。

### 18.4 網路行為（可預期性）

| 情境 | 連線 |
|---|---|
| **`binaryDownload:false` 的任何路徑** | **0 次**（唯一許可的網路動作被關閉） |
| 本地 0.34.0 相容 | **0** 次（需求 §7.7：已存在有效快取不訪問網路） |
| managed 快取有效（唯讀使用） | **0** 次 |
| 預設（`true`）且首次需要安裝 | 2 次（checksums + asset）；重試上限 2 |
| 預設（`true`）失敗後冷卻期內 | **0** 次（`state.json` 的 `lastFailureAt`） |
| 一般啟動（已就緒） | **0** 次 |

---

## 19. DSH Desktop 驗收方案

> 需求 §12.9 要求真實環境驗收。**在取得人工授權的獨立 test profile 之前，此節全部標為「未執行」**；不得以 mock 測試替代實機結論。

### 19.1 前置

1. 建立獨立 test profile（不碰 `desktop`）：`DSH_HOME=<writable temp>` + shipped headless profile `--patch` 疊上測試 `cordis.patch.yml`（本機既有可行手法，見 `docs/` 以外的操作筆記；Desktop profile 由 Electron 直管，不可直接 `dsh --profile desktop`）。
2. 以 `npm pack` 產出的 tarball 安裝（不是 `link:`），驗證真實打包內容。
3. 使用**官方 Standard Preset**，不修改 Persona／Preset／YAML。

### 19.2 驗收項目

| # | 項目 | 通過標準 |
|---|---|---|
| D1 | 插件可正常安裝 | 安裝無 `incompatible-version`；profile 可啟動 |
| D2 | 本地版本相容時直接使用 | 日誌顯示 `source: path`，**0 次網路、0 次快取寫入** |
| D3 | **本地不存在時自動安裝 managed binary（D2 第三輪）** | 日誌顯示下載 → 校驗 → 安裝 → READY；`/basemind-status` 顯示 `source: managed`；另以 `binaryDownload:false` 驗「不下載、0 工具、`/basemind-status` 給指引」 |
| D3b | **本地不相容時的行為** | `/basemind-status` 顯示 `found:`／`expected:`／`compatible: NO` + 原因；預設繼續自動取得 0.34.0；`binaryDownload:false` 時不下載並維持 `UNAVAILABLE` |
| D3c | 關閉下載（`binaryDownload:false`，可選） | 0 次網路、0 次寫入；`/basemind-status` 顯示 `download: disabled` + 指引；DSH 其餘功能正常 |
| D4 | Agent 可發現官方 Skills | session 的 skill catalog 列出 10 個 `basemind*`（僅 READY 時） |
| D5 | MCP Tools 正常調用 | `mcp__basemind__index_status` 回該 session 的 root |
| D6 | CLI 使用與 MCP 一致的 Binary | `mcp__basemind__cli` 的 `status` 與 MCP `index_status` 指向同一 repo；日誌 binary path 相同 |
| D7 | 多 Session 不同項目正確路由 | 兩個 session 各自 `index_status` 回各自 root |
| D8 | Context Compaction 後正常 | 強制 compaction 後 system prompt 仍有 bootstrap、skills catalog 仍可載入 |
| D9 | 停用／卸載後無殘留 | 無 BaseMind 工具、無 skills、無 `basemind-status` 指令、無 relay 進程（`tasklist` 檢查） |
| D10 | 插件失敗不影響其他 DSH 功能 | 無 binary 或 binary 損壞 → DSH 正常開 session、其他工具可用 |
| D11 | **狀態顯示（D3 已裁決 A+B）** | `/basemind-status` 可用且輸出符合 §7.5.2；Plugins 頁詳細文檔可讀；Settings／Plugins 頁**沒有**動態狀態卡片（本就不宣稱有） |

### 19.3 記錄格式

每個項目記：時間、profile、DSH 版本、BaseMind 版本與來源、實際命令／工具呼叫、日誌片段（去敏感）、結果（通過／失敗／未執行）、證據截圖或日誌路徑。

**若無法取得環境**：在 report 中寫「D1–D10 未執行（需 test profile 授權）」，並在 README 不宣稱 Desktop 已驗證。

---

## 20. CI 及打包驗證

### 20.1 CI（`.github/workflows/ci.yml`）

保留既有 matrix（`ubuntu-latest`、`windows-latest`，Node 24.20.0），新增：

```yaml
- name: Check the vendored skills against upstream provenance
  run: node scripts/sync-basemind-skills.mjs --tag v0.34.0 --check
```

（`--check` 只讀本地 `skills/**` 與 `UPSTREAM.json`，**不打網路**；避免 CI 依賴 GitHub raw。）

### 20.2 compat / release workflow

- `compat.yml` 與 `release.yml` 的 `version=0.34.0` 與 asset 名稱改為從 `lib/upstream.js` 讀：

```yaml
- name: Resolve the pinned BaseMind version
  shell: bash
  run: echo "BM_VERSION=$(node -e "import('./lib/upstream.js').then(m=>console.log(m.UPSTREAM.version))")" >> "$GITHUB_ENV"
```

- 後續步驟用 `${{ env.BM_VERSION }}`，asset 名用 `basemind-x86_64-unknown-linux-gnu.tar.gz`（既有值，與 §3.3 一致）。
- **Release 不得使用未驗證的 latest**：既有 workflow 已是 pinned，本次只是把 pin 收斂到單一來源。

### 20.3 打包（`npm pack`）

必須包含：

```
index.js
lib/*.js, lib/binary/*.js
lib/upstream.js
cordis.patch.yml
locale/*.json, icon.svg
skills/**            ← 新增（10 個 SKILL.md + index.md + UPSTREAM.json + LICENSE-basemind.txt + .dsh-adapt.json）
README.md, README.zh.md, CHANGELOG.md
```

必須排除：`test/`、`fixtures/`、`docs/`、`scripts/`、`pack.json`、任何 `basemind`／`basemind.exe`、任何 `.zip`／`.tar.gz`、`node_modules`。

`scripts/check-pack.mjs` 擴充為三類檢查：

1. **必須存在**：runtime JS、bundle patch、locale、icon、10 個 skill 目錄與 `UPSTREAM.json`。
2. **禁止出現**：`test/`、`fixtures/`、`docs/`、`scripts/`、`pack.json`、`*.exe`、`*.zip`、`*.tar.gz`、`node_modules/`、`.github/`。
3. **大小上限**：tarball < 6 MB（skills 約 200 KB；若超過代表誤打包）。

### 20.4 發布流程（不變）

- `release.yml` 仍由 tag 觸發、仍以 `BASEMIND_REQUIRE_INTEGRATION=1` 跑真實 integration、仍用 trusted publishing + provenance。
- **本次不修改 `package.json` 的 release scripts**，不執行 `npm run release`。
- 不自動發布；tag／push／publish 由人工決定（需求 §14）。

---

## 21. 向後相容及回滾方案

### 21.1 不變的契約（必須保持）

| 契約 | 保證 |
|---|---|
| `inject = ['tools','subprocess','workingDirectory','systemPrompt']` | 不新增硬性依賴（`skills` 走 `ctx.get`） |
| 公開工具名 `mcp__<serverName>__<raw>` | 前綴與命名規則不變；只多一個 `mcp__basemind__cli` |
| 既有 12 個設定項 | 名稱、預設、語意全部不變 |
| `command` 語意 | 使用者指定非預設命令 → 仍優先，且不再被靜默忽略（改為「警告 + 判定」） |
| `BASEMIND_BIN` 語意 | 仍只在 `command` 為預設時生效（既有邏輯 `lib/executable.js:242-245`） |
| `discoveryRoot`、`maxClients`、timeout | 不變 |
| 錯誤訊息格式（`[error=…]`、`[jsonrpc=…]`） | 不變 |
| 單一 effect 清理順序 | 不變（新資源插在既有順序之後、generation 之前） |
| `failOnStartupError` | 不變（true 才 fail-fast） |

### 21.2 行為變更清單（必須寫進 CHANGELOG 的 **Changed** / **Added**）

| # | 變更 | 影響 | 緩解 |
|---|---|---|---|
| B1 | **預設會自動下載 managed binary**（D2 第三輪裁決） | 首次啟動在「本地無相容 binary」時會有 2 次 HTTPS 請求與 75–102 MB 寫入**插件自管快取**；本地已相容時 0 次網路 | 歸類為「插件自管快取寫入」而非「使用者資料／專案狀態」：`cordis.patch.yml` 顯式宣告、CHANGELOG `Changed` 第一條、`check-manifest` 斷言、`binaryDownload:false` 可完全關閉、失敗不阻塞 Host |
| B2 | 本地 binary 版本不符時**不再直接使用** | 原本「任何版本都能跑」變成「exact 0.34.0，否則不註冊工具」 | `binaryPolicy:'minor'`／`'any'` 可放寬；`/basemind-status` 說明原因與做法 |
| B3 | 新增 `mcp__basemind__cli` 工具 | 工具數 +1 | `cliTool:false` |
| B4 | 新增 10 個 skills | catalog 多 ~800 tokens | `skills:false` |
| B5 | 新增 bootstrap prompt section | +≤400 tokens | `bootstrap:false` |
| B6 | `autoProvision` 順位降到最後且警告 | 依賴 npx 的使用者會看到 deprecation | 訊息說明替代方案 |
| B7 | **新增 `/basemind-status` 指令** | Composer 的 `/` 選單多一項；不耗 token、不經模型 | 無需開關（純唯讀）；若要移除可停用插件 |
| B8 | 不相容時「工具消失」成為**可預期行為**，並有明確診斷 | 使用者會先看到工具不見 | `/basemind-status` + 日誌 + README 的「版本不符怎麼辦」章節（三者都必須寫） |

### 21.3 回滾

| 層級 | 做法 | 效果 |
|---|---|---|
| 單一功能 | `binaryDownload:false` / `skills:false` / `bootstrap:false` / `cliTool:false` / `binaryPolicy:'any'` | 回到接近 0.2.0 的行為，不需降版 |
| 整個插件 | 降到 0.2.0（`dsh plugin … add dsh-basemind-plugin@0.2.0 --save-exact`） | 完全回到舊行為；快取目錄留存但不被使用（可手動刪） |
| 快取 | 刪 `$DSH_HOME/cache/dsh-basemind-plugin/` | 下次重新選型／下載；**不影響** BaseMind 的索引與記憶 |
| Skills vendor | 同步腳本可重跑；`git checkout skills/` 還原 | — |
| 資料層 | **不回滾**（插件從不修改 BaseMind 資料） | 無風險 |

**特別註明**：回滾不會、也不能復原「BaseMind 自己因為 0.34 升級而重建的索引」——那是上游行為，且是非破壞性失效（重建而非刪除使用者記憶）。

---

## 22. 風險及未確認事項

### 22.1 風險表

| # | 風險 | 等級 | 依據 | 緩解 | 驗證狀態 |
|---|---|---|---|---|---|
| R1 | 「預設自動下載」與既有紀律的張力 | 低（已處理） | 需求 §7 vs AGENTS.md §5 | **精確化紀律而非繞過**：AGENTS.md 把啟動副作用分兩類（使用者資料／專案狀態＝禁止；插件自管快取＝允許但須顯式、可停用、不阻塞），再加 `cordis.patch.yml` 顯式宣告 + CHANGELOG 第一條 + `check-manifest` 斷言三處審計痕跡 | 機制已定；**殘留假設**：假設使用者群體並非「全部都已裝 basemind」。若該假設為真，預設 `false` 更乾淨——此假設未經數據驗證，已在 §24.4 列為可回頭的決策 |
| R1b | **「配置頁」需求在 Host-only 架構下無原生呈現面**，只能以 `/basemind-status` 近似 | 低（已裁決） | §7.5.1 的四個 GUI 面查證 | **第四輪裁決 A+B**：`/basemind-status` + Plugins 頁靜態文檔；client half 另案（§23.3） | 已裁決；client half 未實作（明確非目標） |
| R1c | 下載路徑失敗（離線、403／404、不支援平台）→ 使用者「工具突然不見」且不知為何 | 中 | §9.3、§10.7 | `/basemind-status`（§7.5）、啟動日誌（每類事件一次）、README 專章；三者都在本次範圍 | 需 Phase 3／6 驗證 |
| R2 | 0.33→0.34 升級窗口：使用者的 0.33 daemon 佔住 workspace，工具回 `-32003` | 中 | `UPGRADING.md:474-494` | 診斷訊息 + 文件升級三步；不自動停 daemon | 上游已文件化；實機未模擬 |
| R3 | 0.34 首次開啟舊索引會**重建**（耗時、耗磁碟） | 中 | `version.rs:3-11` | 版本切換一次性提示；`upgrade --plan` 可先看成本 | 上游文件；本機冷索引實測 29–106 s |
| R4 | 純 Node 解壓實作有正確性／安全風險 | 中 | 自研 | 只抽單一固定 entry；完整惡意樣本測試；上限；拒絕 symlink/hardlink | 需 Phase 2 測試證據 |
| R5 | 下載在企業網路／代理環境失敗 | 中 | Node fetch 不用系統代理 | 明確訊息 + `BASEMIND_BIN` 指引；不支援代理列為非目標 | 已知限制 |
| R6 | DSH `ctx.skills` 在更舊的 DSH（`0.2.1-rc.3`）不存在 | 低 | 0.2.2-rc.5 live 實證；**另在 0.2.1-rc.3 的 asar 抽取中確認**：`@deepseek-ai/dsh-skill@0.2.1-rc.3` 的 `lib/index.js` 含 `registerProvider`、`BUNDLED_SKILL_RANK = 600`、`RUNTIME_RANK = 250`；同版 `dsh-base/cordis.patch.yml` 含 `id: skill / skill-filesystem / tool-skill` rows | `ctx.get('skills')` 缺失時靜默跳過（1 次 debug log）；`engines` 不動 | 套件層已證；**rc.3 實機載入插件仍未跑** |
| R7 | Skills 上游文字變動（patch release）使適配規則失效 | 中 | 上游 byte-frozen + Python 同步器 | `sync --check` 在 CI 失敗 → 不會靜默漂移 | 機制已設計 |
| R8 | `rank: 1000` 使我們永遠輸給任何同名 skill—包含「使用者不小心裝了舊版 basemind skill」 | 低 | 需求「不覆蓋用戶同名 skills」 | 記 info 告知由誰提供；文件說明如何移除 | — |
| R9 | 新增工具／skills 造成 token 成本上升 | 低 | §18 | 三個獨立開關 | — |
| R10 | `AssembleContext.scope === Agent` 只用於第二階段，若推論錯誤也不會影響第一階段 | 低 | `dispatch.ts:174-176` | 第一階段不依賴它 | 未 runtime 驗證 |
| R11 | Windows `.cmd` 形式的 BaseMind（npm 全域安裝）路徑含空格 → 既有 `assertCmdWrappable` 會拒絕 | 中（既有） | `lib/executable.js:46, 129-141` | 既有可診斷錯誤；managed binary 是 `.exe`，正好繞開 | 既有測試覆蓋 |
| R12 | 併發鎖在 NFS／網路磁碟上的 `mkdir` 語意 | 低 | 自研 | 文件說明快取應在本機磁碟；失敗視為 `UNAVAILABLE` | 未驗證 |
| R13 | `fetch` 對超大 asset 的記憶體行為 | 低 | Node 24 fetch | 以串流寫入 + Content-Length 上限 + 總量計數 | 需測試 |
| R14 | Skills 的 `path` 指向 npm 安裝目錄，使用者可能誤編輯 | 低 | — | `UPSTREAM.json` 與 `--check` 會發現；README 說明「請改上游並重新同步」 | — |
| R15 | 官方 release 資產改名（未來版本） | 中 | §3.3 | 明確 pin 版本；升版時同步腳本與 `UPSTREAM` 一起改；啟動時 404 → 明確訊息 | — |

### 22.2 未確認事項（必須在 Execution 或後續驗證）

| # | 未確認 | 需要的證據 |
|---|---|---|
| U1 | `ctx.skills` 在 DSH `0.2.1-rc.3` 的**執行期**是否掛載 | 已確認套件層存在（`dsh-skill@0.2.1-rc.3` 有 `registerProvider`；`dsh-base` composition 有 `id: skill` row），**未**在 rc.3 實機載入插件。→ README 仍標明「實測於 0.2.2-rc.5」，不得宣稱 rc.3 已驗證 |
| U2 | `AssembleContext.scope` 在 `systemPrompt.section` 的 text 函式中確實是 Agent | 在 test profile 印一次 `typeof scope`；失敗則放棄第二階段 |
| U3 | 真實 DSH Desktop 安裝 tarball、skills catalog 出現、compaction 後仍存在 | §19 的 D1–D10 |
| U4 | `comms stop` 之後 `-32003` 是否如上游描述消失 | 需要同時起 0.33 與 0.34 daemon 的受控實驗 |
| U5 | macOS arm64／Linux x64 的 managed **下載與解壓**（預設路徑的一部分） | CI（`compat.yml`）或人工；本地就緒時的探測／拒絕／狀態顯示不依賴下載，可在各平台先用 `BASEMIND_BIN` 驗證 |
| U6 | Linux arm64 runner 可用性 | GitHub 帳號權限 |
| U7 | Intel Mac 上「不支援」訊息的實機呈現 | 無機器 → 只能單元測試 |
| U8 | Agent 使用效果 A/B（§17.10） | 需 22 次任務執行與人工評分 |
| U9 | `DSH_BUNDLED_SKILL_DIR` 的真實值 | 與本計畫無直接關係（我們用自己的 provider），但影響「同名 shadow」的理解 |
| U10 | 官方 `plugin/scripts/mcp-launch.*` 在未來的相容性 | 本計畫不重用，無需確認 |

### 22.3 對抗性檢查（設計自我質疑）

1. **「不用重注入」會不會錯？** 若 DSH 的 section 在某個版本只組裝一次並快取整個 prompt，那 compaction 後可能失效。證據顯示 `assemble()` 每 step 呼叫（`agent.ts:298-300`）且 `refreshContext` 每 request attempt 執行。→ 仍要求 Phase 4 有一條「compaction 後 section 仍在」的測試（以 fake assemble 模擬，而非依賴真實 compaction）。
2. **「rank 1000」會不會讓使用者拿不到官方 skills？** 只有在「同 workspace 已有同名 skill」時才被遮蔽，而那正是需求要求保留使用者版本的情況。訊息會說明由誰提供。
3. **「exact 版本」會不會讓使用者卡住？** 上游 0.34.0 是本次驗證版本；0.34.1 出現時使用者可用 `binaryPolicy:'minor'` 或等我們更新 `UPSTREAM`。文件要寫清楚這個升級路徑。
4. **「純 Node 解壓」是否必要？** 替代方案是系統 `tar`／`unzip`／PowerShell。缺點是平台差異與錯誤處理不可控（官方 launcher 就 fallback 三種）。以 240 行 + 20 個測試換取可預測性，值得。若 review 認為成本過高，最小替代是「Windows 用 `tar.exe`（Win10 1803+ 內建）、Unix 用 `tar`/`unzip`」，但需接受平台差異並加更多錯誤分支。
5. **「CLI 工具」是否擴大攻擊面？** 它不提供 shell、不接受 cwd/env/stdin、argv 必經 allowlist+denylist、輸出有上限。攻擊面小於現有的 MCP `code_read` 類工具。

---

## 23. 最小實施範圍與明確非目標

### 23.1 最小充分範圍（本次必做）

1. `lib/upstream.js` 單一版本來源。
2. Binary Manager：Local First 選型 + 探測 + exact 相容 + 官方下載 + sha256 + 安全解壓 + 跨 session 快取 + 跨 process 鎖 + 失敗降級。
3. Skills：10 個官方 skills vendored（含適配規則與 provenance）＋ `ctx.skills.registerProvider` ＋ 可用性 gate。
4. Bootstrap：一個短 section，內容與 MCP instructions 不重複。
5. CLI Adapter：一個 argv-only 工具，與 MCP 同一 binary。
6. 可觀測性：結構化 `status()` + 一次性日誌。
7. 文件、CI、打包、測試（§17 全部 Gate）。

### 23.2 明確非目標（本次不做）

| 項目 | 理由 |
|---|---|
| Claude Code 式 PreToolUse Guard、攔截 `grep`/`read`/`git`/`bash` | 需求 §10；DSH 的 `tools/pre-execute` 可做但不屬本次 |
| 大型插件 UI／Statusline／Web 頁面 | 需求 §10 |
| 真·配置頁狀態卡片（client half：`dsh.client`、bundler、Slot 貢獻） | D3 第四輪裁決採 A+B；client half 需另案 Plan（§7.5.4、§23.3） |
| Agent 未讀訊息通知、Agent 身份自動改寫、Lead Agent 自動啟動 | 需求 §10 |
| 重寫 DSH 智能團隊／Workspace Pool／MCP Bridge | 需求 §10 |
| MCP Tasks 完整協議 | 需求 §10；0.34 fixture 也無 outputSchema |
| 把每個 CLI 命令包成獨立工具 | 需求 §8 |
| 自動執行 `scan`/`rescan`/`comms stop`/`cache clear`/`memory clear` | 需求 §7.10；AGENTS.md |
| 自訂下載鏡像／代理支援 | 需求 §7.5 的信任邊界；列為文件限制 |
| per-agent 可用性精細判斷（`when`／`ctx.tools.get`） | 第二階段可選（§13.6）；先驗證 `scope` |
| 修改 DSH 官方 Preset／Persona／YAML | 需求 §4 |
| 新增任何 runtime dependency | 需求 §4；目前 0 dependency 是資產。若 §22.3-4 的替代方案被採用，仍不新增 dependency |
| 版本號修改、tag、push、publish | 需求 §14 |

### 23.3 後續擴展方向（只記錄，不實施）

- per-agent bootstrap（用 `scope` 判斷工具可見性）。
- `agent/TurnStopping` 上的「未讀 comms 訊息」提示（需求 §10 明確排除）。
- `basemind sessions`（token 節省統計）作為可觀測性面板。
- 把 `binaryPolicy:'minor'` 升級為「查上游是否有 patch release + 自動驗證」。
- Windows arm64／macOS Intel 的「從源碼建置」指引（目前只給訊息）。

---

## 24. 最終版本發布建議

### 24.1 版本

- **版本：維持 `0.2.0`，不升版**（第四輪裁決）。理由：`0.2.0` 從未發布（npm 上最新仍是 0.1.6，repo 內也尚無 `v0.2.0` tag），本次的 Skills／Binary Manager／CLI 工具與既有的 0.34.0 適配屬**同一個尚未交付的版本**；把它拆成 0.3.0 會讓一份工作產生兩個版本號，還需要額外維護一組「0.2.0 已發布」的假設。
- 因此：`package.json` 的 `version` **不動**；`CHANGELOG.md` 的新內容**併入既有的 `## [0.2.0]` 條目**（Added／Changed），不新增 `[0.3.0]` 區塊；`[Unreleased]` 的比較連結維持 `v0.2.0...HEAD`。
- **例外情況**（若 review 後決定升版）：由於 0.2.0 未發布，升版不會造成 npm 上的版本倒退；但需同時改 `package.json`、CHANGELOG 標題與 release workflow 的 tag 檢查，屬一次性人工決定，不由 Agent 代做。
- 依賴需求不變：`engines.node >= 24.20.0`（`fetch` 為 Node 18+ 內建、`zlib`/`crypto` 更早）；`engines.dsh >= 0.2.1-rc.3 < 0.3.0-0`（README 註明 skills 需 `>= 0.2.2-rc.5` 實測）。
- **`git tag v0.2.0`、`git push`、`npm publish` 一律由人工執行**（需求 §14；AGENTS.md §7）。

### 24.2 發布前檢查清單（人工）

1. `git diff` 全量審查（含 `skills/**` 的 vendored 內容與 `.dsh-adapt.json` 的每一條規則）。
2. `package.json` 的 `version` 仍是 `0.2.0`（未被誤升）；CHANGELOG 的新內容在既有的 `[0.2.0]` 段落內。
3. `npm run verify` 全綠（含真實 integration；0 skip）。
4. `node scripts/sync-basemind-skills.mjs --tag v0.34.0 --check` exit 0。
5. `npm pack` 內容核對（skills 在、無 binary／無 test／無 docs）。
6. CHANGELOG 的 `Changed` 段完整列出 §21.2 的 B1–B6，且**第一條是「預設會下載 managed binary」**。
7. `cordis.patch.yml` 顯式含 `binaryDownload: true`（`npm run check` 的 manifest 斷言會擋）；AGENTS.md 的「啟動副作用兩分類」已寫入。
8. README 兩語言章節同步（§15.4 的 12 個主題），含「卡在 0.34.1 的兩條路」。
9. DSH Desktop 驗收結果（§19）已記錄；未執行則明確標示。
10. §17.10 的 Agent 效果對照結果已附（或明確標示未執行）。

### 24.3 建議 commit 訊息（繁中，僅供參考，不代表代為提交）

```
feat: 整合 BaseMind 官方 Skills 與 Local First Binary Manager

- 新增 lib/upstream.js 單一上游版本來源（0.34.0）
- 新增 Binary Manager：本地優先、exact 版本相容、官方 Release 下載與
  SHA256 校驗、純 Node 安全解壓、跨 Session／跨 Process 共用快取
- 以 ctx.skills.registerProvider 註冊 BaseMind 官方 10 個 Skills（rank 1000）
- 新增 bootstrap prompt section（與 MCP instructions 不重複）
- 新增 mcp__basemind__cli：argv-only 唯讀 CLI adapter，與 MCP 同一 binary
- 新增 scripts/sync-basemind-skills.mjs 與 skills provenance
- 文件、CI、打包與測試同步更新
```

### 24.4 交付後的停點

本文件是 **Plan**。依指示：

- **不進入 Execution**、不修改產品程式碼、不 commit／tag／push／publish。
- 第三輪已裁決（寫入本文件）：
  1. **D2：預設下載**（`binaryDownload: true`），以「插件自管快取 + 三處審計痕跡 + AGENTS.md 兩分類」取得正當性；退路（若日後否決）是預設 false + 一次性提示，不得靜默。
  2. **版本策略：exact**（§9.2 全文），維護成本壓到「改 `lib/upstream.js` 一行 + 重跑同步 + 跑 integration gate」，並寫成 `docs/upstream-sync.md` 的 checklist。
  3. **新設定 6 項，刪除 `binaryPath`**：explicit 來源沿用 `command`／`BASEMIND_BIN`；三軸（download／policy／fallback）正交。
- 第四輪已裁決（寫入本文件）：
  4. **D3：接受 §7.5.2 的 `/basemind-status` + Plugins 頁靜態文檔**；不新增 client half，不在 GUI 宣稱狀態卡片。
  5. **交付版本：維持 `0.2.0`，不升版**（§24.1）。
- 目前沒有未決事項；確認後即開始 Phase 0–6。

---

## 附錄 A：證據索引（本次調研實際讀過的位置）

| 類別 | 位置 |
|---|---|
| 上游原始碼（tag v0.34.0，clone 於 `/tmp/basemind-research/upstream`） | `.pi/extensions/basemind.ts`、`opencode-plugin/binary-check.js`、`plugin/scripts/mcp-launch.{sh,cmd}`、`skills/**`、`src/version.rs`、`src/main.rs`、`docs/UPGRADING.md`、`docs/manual/{data,environment}.md`、`docs/adr/0028-*`、`LICENSE`、`package.json` |
| 上游 release metadata | `https://api.github.com/repos/Goldziher/basemind/releases/tags/v0.34.0`（7 assets，§3.3）；checksums 檔內容 |
| DSH live API | 本 session 的 `cordis_inspect_query`（host `Service`：`skills`、`systemPrompt`、`tools`、`subprocess`、`workingDirectory`、`agents`；host `Event` 全表） |
| DSH 原始碼 | `app.asar` 內 `@deepseek-ai/dsh-skill/src/index.ts`、`dsh-skill-filesystem/src/index.ts`、`dsh-tool-skill/{README.md,src/index.ts}`、`dsh-system-prompt/src/index.ts`、`dsh-tools/src/{index.ts,contracts.ts}`、`dsh-subprocess/src/{index.ts,types.ts}`、`dsh-home-paths/src/index.ts`、`dsh-agent-loop/src/agent.ts`、`dsh-agent/src/dispatch.ts`、`dsh-working-directory/src/index.ts`、`dsh-compaction/src/types.ts`、`dsh-app-boot/src/plugin-compatibility.ts` |
| 既有插件 | `index.js`、`lib/{config,executable,mcp-session,stdio-client,workspace-pool,tool-bridge,schema,result}.js`、`cordis.patch.yml`、`package.json`、`test/**`、`fixtures/**`、`scripts/**`、`.github/workflows/**` |
| 既有文件 | `AGENTS.md`、`README.md`、`README.zh.md`、`CHANGELOG.md`、`docs/2026-11-24-basemind-0.34.0-{upgrade-plan,upgrade-report,review}.md` |
| 本機實測 | `basemind --version` → `basemind 0.34.0`；`basemind --help`、`basemind code --help`、`basemind git --help`（命令面與 CLI-only 動詞確認）；`~/.dsh` 佈局；`~/.dsh/skills`、`~/.dsh/cache`、`~/.dsh/storages` 實際內容 |

## 附錄 B：需求條目 → 本計畫章節對照

| 需求 | 章節 |
|---|---|
| §5 功能 A Skills | §12、§15、§17.5 |
| §6 功能 B Bootstrap/Lifecycle | §13、§17.6 |
| §7 功能 C Binary Manager | §8、§9、§10、§11、§17.2–17.4 |
| §8 功能 D MCP 優先與 CLI 補充 | §14 |
| §9 功能 E 可觀測性與配置 | §10.8、§15.3 |
| §10 非目標 | §23.2 |
| §11 文件影響分析 | §15 |
| §12 測試 | §17 |
| §13 Agent 效果驗證 | §17.10 |
| §14 CI／打包／發布 | §20、§24 |
| §15 文件更新 | §15.4 |
| §16 Plan 交付 | 本文件 |

---

## 附錄 C：人工裁決紀錄

| 輪次 | 項目 | 裁決 | 對計畫的影響 |
|---|---|---|---|
| 第一輪 | 初版 Plan（§1–§24） | 接受為討論基礎 | — |
| 第二輪 | D2 自動下載預設值 | 暫定 **`false`**（使用者自行管理版本） | §8／§9／§10／§15.3／§19／§21／§22 一度改寫為「opt-in」敘事 |
| 第二輪 | D3 狀態顯示（配置頁） | 暫緩裁決（第四輪定案 A+B） | 新增 §7.5、`lib/status.js`、`test/status.test.mjs` |
| 第三輪 | **D2 反向**：預設下載 | **改回 `true`**，但以「插件自管快取」+ 三處審計痕跡 + AGENTS.md 啟動副作用兩分類取得正當性；退路＝預設 false + 一次性提示（不得靜默） | §1.3、§1.4、§7.5、§8.1、§9.2.5、§9.2.7、§9.3、§9.5、§10 前言、§15.2–§15.4、§17.2、§17.7、§19.2、§21.2、§22 R1、§24 全部同步 |
| 第三輪 | 版本策略 | **確認 exact**；理由精確化為「same-minor 只保證 blob/index 相容，不保證 CLI/Skills 契約」；維護成本壓到 1 行 + 3 動作 | 新增 §9.2.7；README 必須寫「卡在 0.34.1 的兩條路」 |
| 第三輪 | 新設定數量 | **6 項，刪除 `binaryPath`**；explicit 來源＝`config.command`／`BASEMIND_BIN` | §15.3.1／§15.3.2／§15.3.3／§15.3.4 改寫 |
| 第四輪 | **D3 狀態顯示** | **接受 A + B**：`/basemind-status` + Plugins 頁靜態文檔；不新增 client half | §1.3、§7.5.4、§19.2 D11、§22 R1b 改為已裁決 |
| 第四輪 | **交付版本** | **維持 `0.2.0`，不升版**（0.2.0 從未發布，本次屬同一交付） | 標題、檔頭、§1.4、§6、§7.5.2、§9.2.2、§10.6、§15.2、§17.10、§24 全部改為 0.2.0；CHANGELOG 併入既有 `[0.2.0]` 段落 |

### 未隨輪次改變的決策（仍有效）

- 預設 `binaryPolicy: 'exact'`、`binaryFallback: true`、`skills: true`、`bootstrap: true`、`cliTool: true`。
- 共用使用者 `BASEMIND_DATA_HOME`／`BASEMIND_COMMS_DIR`，不自動停止 daemon、不自動 scan／clear。
- `npm` 發布需完整 skills；`binaryDownload` 之外的預設值**不**寫入 `cordis.patch.yml`。
- 版本號、tag、push、publish 全部由人工執行。
