# dsh-basemind-plugin

[English](README.md) | 繁體中文

[![npm](https://img.shields.io/npm/v/dsh-basemind-plugin)](https://www.npmjs.com/package/dsh-basemind-plugin)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

DeepSeek Harness 的工作區感知 BaseMind 橋接插件。安裝這個 bundle 之後，每個工作階段都能直接使用 BaseMind 的程式碼理解工具，而且工具會跟隨該工作階段所在的儲存庫——不需要設定 MCP 列，也不需要修改任何 agent preset。

第一次接觸 BaseMind？請先閱讀 [BaseMind 介紹](https://basemind.ai/start/introduction/)。

## 1. 這是什麼

這是一個 DSH bundle。它為工作階段所在的儲存庫啟動 BaseMind 自己的 MCP 伺服器（`basemind serve`），註冊 BaseMind 宣告的工具，並在工作階段移動時讓工具跟著指向正確的工作區。在工作階段內 `cd` 之後，下一次呼叫就會使用新的儲存庫，不需要重啟任何東西。它沒有 UI 頁面，也不會修改任何 agent preset。

| | 手動設定 `basemind` MCP 列 | 這個 bundle |
|---|---|---|
| 工作區根目錄 | 列設定中的靜態 `cwd` | 每次呼叫時由工作階段的工作目錄解析 |
| 工具集 | 連線時固定，只服務那一個根目錄 | 從 `tools/list` 發現 |
| 需要設定的列 | 一列 MCP（外加一筆 manager 記錄） | 無——bundle 自己插入插件列 |
| 多個儲存庫 | 每個再加一列 | 每個根目錄自動一個 relay |

relay 以工作區根目錄為單位。自 BaseMind 0.34.0 起，後方的 index、memory 與 document store 以 **repository group** 為範圍，因此同一儲存庫的兩個 worktree 會共用同一份索引與記憶，不同儲存庫則不會。這是上游行為，不是插件少了隔離層。

## 2. 版本

插件可在 npm 上以 `dsh-basemind-plugin` 取得，上方 badge 顯示目前版本。若要查詢某個 profile 中的版本：

```bash
npm view dsh-basemind-plugin version
```

版本變更記錄見 [CHANGELOG.md](CHANGELOG.md)。

## 3. 相容性

| 元件 | 需求 |
|---|---|
| DeepSeek Harness | `>= 0.2.1-rc.3 < 0.3.0-0`，宣告於 `engines.dsh`，DSH 會在安裝與啟動時檢查。本版本已於 `0.2.2-rc.5` 實測（先前亦於 `0.2.1-rc.5` 實測）。 |
| Node.js | `>= 24.20.0`（宣告於 `engines`，並以 Volta 固定）。插件是純 ESM，沒有依賴。 |
| BaseMind | **0.34.0**，固定於 `lib/upstream.js`，並由 `binaryPolicy: 'exact'`（預設，§8）強制：本機 `basemind` 的 major.minor.patch 不符時，會在日誌與 `/basemind-status` 說明後跳過，不會拿來執行；本機找不到相容 binary 時，`binaryDownload: true`（預設，§7）會從 GitHub 安裝這個固定的目標版本。`binaryPolicy: 'minor'` 與 `'any'` 是逃生門；`'any'` 只保留 MCP bridge，Skills、CLI 工具與版本提示全部關閉。已於 Windows 搭配外部 BaseMind **0.34.0** 實測；插件**自己的** managed 下載／安裝路徑已在 **Windows x64 本機（2026-11-24）** 與 **CI 的 Windows x64／Linux x64／macOS arm64（`Managed binary` workflow，2026-11-25，全綠）** 實測通過——見 §15。0.29.3–0.33.0 提供的是 mode 型工具而非 verb tools（見 §5.2）。 |

## 4. 安裝

### 4.1 安裝 BaseMind

先依 [BaseMind 介紹](https://basemind.ai/start/introduction/)安裝 `basemind` 程式，並確認 DSH 執行環境看得到它：

```bash
basemind --version
```

若 DSH 在 `PATH` 上找不到 `basemind`，請用絕對路徑的 `BASEMIND_BIN`（或插件的 `command` 選項）指向執行檔。

### 4.2 安裝 bundle

- **DSH Desktop：** 開啟插件管理器（**Plugins** 頁），安裝 `dsh-basemind-plugin` 並啟用。
- **CLI 管理的 profile：** 用你要啟動的 profile 安裝：

  ```bash
  dsh plugin --profile <profile> add dsh-basemind-plugin
  ```

安裝是 per profile 的。若執行時要求重新啟動或停用/啟用一次以載入新 bundle，請照做。

### 4.3 驗證

在一個開在專案上的工作階段裡，呼叫 `mcp__basemind__index_status`，參數 `{}`。它會回傳該工作階段的索引根目錄、索引 `schema_version` 與 `indexing` 狀態。在預設 `serverName` 下，會註冊 BaseMind 0.34.0 宣告的 15 個 verb tools：`code_grep`、`code_outline`、`code_read`、`code_refs`、`code_search`、`code_symbols`、`docs_search`、`find_files`、`git_blame`、`git_diff`、`git_log`、`index_rescan`、`index_status`、`memory_save`、`memory_search`。comms build 另會註冊 `agent_inbox`、`agent_post`、`agent_threads`。

### 4.4 更新與移除

- **更新：** Plugins 頁 → Update，或 `dsh plugin --profile <profile> add dsh-basemind-plugin@latest`。
- **移除：** 在插件管理器停用或卸載，或 `dsh plugin --profile <profile> remove dsh-basemind-plugin`。

## 5. 使用

每個工具只做一件事，沒有 `mode`、也沒有 `format` 切換。呼叫名稱帶 `mcp__basemind__<tool>` 前綴。

**先看檔案結構，再決定要不要讀**

```json
{ "tool": "mcp__basemind__code_outline", "arguments": { "path": "index.js" } }
```

**找符號定義位置**

```json
{ "tool": "mcp__basemind__code_symbols", "arguments": { "name": "createWorkspacePool" } }
```

**找某個符號的所有引用**

```json
{ "tool": "mcp__basemind__code_refs", "arguments": { "name": "publicToolName" } }
```

**只讀取某個符號的內容**

```json
{ "tool": "mcp__basemind__code_read", "arguments": { "path": "lib/tool-bridge.js", "symbol": "createToolDefinition" } }
```

**以符號解析度讀 git 歷史**

```json
{ "tool": "mcp__basemind__git_blame", "arguments": { "path": "index.js", "symbol": "activate" } }
```

**看工作區目前的變更**

```json
{ "tool": "mcp__basemind__git_diff", "arguments": {} }
```

**檢查目前工作區的索引狀態**

```json
{ "tool": "mcp__basemind__index_status", "arguments": {} }
```

### 5.1 工具

| 工具 | 涵蓋 |
|---|---|
| `mcp__basemind__code_outline` | 單一檔案中的符號 |
| `mcp__basemind__code_symbols` | 依名稱找符號 |
| `mcp__basemind__code_grep` | 已索引檔案中的字面文字或 regex 搜尋（regex 需 `regex: true`） |
| `mcp__basemind__code_search` | 語意程式碼搜尋 |
| `mcp__basemind__code_read` | 單一符號內容，或精確的行範圍 |
| `mcp__basemind__code_refs` | 引用、呼叫者、實作、importers、定義（用 `relation` 指定） |
| `mcp__basemind__find_files` | 依檔名找檔案 |
| `mcp__basemind__docs_search` | 專案文件 |
| `mcp__basemind__memory_save`、`mcp__basemind__memory_search` | key/value 記憶與其搜尋 |
| `mcp__basemind__git_log`、`mcp__basemind__git_diff`、`mcp__basemind__git_blame` | 歷史、工作區差異、blame |
| `mcp__basemind__index_status`、`mcp__basemind__index_rescan` | 索引狀態與重新掃描（`{}` 代表整個工作區） |
| `mcp__basemind__agent_inbox`、`mcp__basemind__agent_post`、`mcp__basemind__agent_threads` | agent 通訊（僅 comms build） |

工具清單取自執行中的 BaseMind。預設 `binaryPolicy: 'exact'` 下，該 binary 必須是固定的 **0.34.0**（§8）；其他版本只有在 `minor` / `any` 逃生門下才會執行，也只有在那時，較新版本才可能提供不同的工具集。

部分工具以行導向文字或 [TOON](https://toonformat.dev) 回應，而非 JSON（`code_outline`、`code_grep`、`find_files`、`git_diff`）。插件只投影伺服器送來的文字，不做解析；0.34.0 每個結果的機器可讀形式都在 MCP `structuredContent`，插件會將它保留在 result envelope 中。請不要對文字區塊做 `JSON.parse`。

BaseMind 的 MCP resources（`basemind://status`，以及 `basemind://outline/{path}`、`basemind://memory/{key}` 兩個 template）以 resource server `basemind` 提供，因此 `list_mcp_resources` 與 `read_mcp_resource` 都能運作。`basemind://repo/map` 已隨 `graph` 工具在上游移除。

### 5.2 將既有安裝升級到 BaseMind 0.34.0

1. `basemind comms stop`——0.33 的 daemon 無法服務 0.34 client；兩者同時存在時，工具呼叫會得到可重試的 `-32003` / `backend_unavailable`。
2. `basemind scan`——0.34.0 把 release minor 由 33 升到 34，每個 view 會重建一次索引，blob store 移到 `cache/blobs/v34/`。
3. 重開每個 DSH 工作階段——插件會在新的 relay 上重新發現工具清單。

工具名稱已變更：`mcp__basemind__code`、`__git`、`__memory`、`__admin`、`__graph`、`__web`、`__shell`、`__workspace`、`__agents` 已不存在，任何寫死這些名稱的權限設定、preset prompt 或腳本都必須更新。插件不會代為改寫 preset 或權限檔。

### 5.3 新 session 的第一輪

新的 Agent 要等 BaseMind relay 回應之後才會放行第一個 prompt，因此第一輪就已經帶有工具、bootstrap section 與 skills catalog。等待有上限，由 `coldStartTimeoutMs` 控制（預設 15000 ms；`0` 停用等待；可接受最大值 120000）。超過上限後，第一輪照舊在沒有 BaseMind 的情況下繼續，背景 attempt 完成時仍會補註冊工具。

調整時要注意兩件事：

- 預算涵蓋 `workingDirectory.ensure`、relay handshake 與 `tools/list`。工作目錄很慢或位於遠端而錯過預算時，該目錄仍會在背景被採用，這個 session 只是晚一輪才有工具，不會失去它們。
- `binaryDownload` 的全新 managed 安裝第一次啟動可能要下載 75–102 MB、花 13.5–55.7 s。除非把 `coldStartTimeoutMs` 相應調高，那第一次 session 的第一輪仍可能在沒有 BaseMind 工具下執行；後續 session 重用暖快取，只等 handshake。

## 6. 本機優先的 Binary 選擇

每次啟動時，插件依下列順序選一次 binary（同一 process 內固定）：

1. `command` 非預設 `basemind` 時（絕對路徑原樣使用）。
2. `BASEMIND_BIN`（僅當 `command` 仍是預設值）。
3. `PATH` 上的 `basemind`。
4. 目標版本與平台的 managed 快取。
5. 官方 GitHub Release 的目標版本（僅當 `binaryDownload: true`）。
6. `npx -y <npxSpec>`：legacy 路徑，僅當 `autoProvision: true` 且以上全部失敗。

每個候選都必須先通過版本政策才會被採用。本機版本不符時，日誌與 `/basemind-status` 會說明，然後繼續下一個候選；`binaryFallback: false` 會讓不符的顯式 binary 直接停下，而不是往下掉。

選型在同一個 process 內固定：所有 relay、CLI 呼叫與診斷共用同一個 binary，工作階段切換工作目錄不會重新選型。本機命中或有效快取命中都是 0 次網路；只會寫入插件自管快取（每個 workspace 的 state.json、managed 安裝的 install.json）。

## 7. Managed Binary 自動下載（預設開啟）

`binaryDownload: true` 是預設值，並在 `cordis.patch.yml` 顯式宣告。本機沒有相容 binary 時，插件會從 `github.com/Goldziher/basemind/releases/download/v<version>/` 下載目標 asset、用 `basemind_<version>_checksums.txt` 驗證 SHA256、以純 Node 解開**完整 release tree**（tar.gz 或 zip：主 binary、`lib/` 下的 DLL/SO/DYLIB、Windows root DLL、`licenses/**`、`LICENSE`、`ATTRIBUTIONS.md`、`THIRD_PARTY_LICENSES`；拒絕路徑穿越、symlink、hardlink、device entry），探測解出的 binary、把每個實際寫出的檔案記進 `install.json`，再以目錄 rename 原子替換。這個 tree 必須完整：Windows 執行檔靜態 import `heif.dll`，Linux／macOS 則透過 RUNPATH／`@loader_path` 載入 `lib/`，所以只安裝單一 binary 在四個平台都無法啟動。

- 只寫入 `$DSH_HOME/cache/dsh-basemind-plugin/`。
- 不碰 BaseMind data home、專案、npm 安裝目錄或 `PATH`，也不執行任何安裝程式。
- 失敗即封閉：未校驗的 binary 永不執行，插件維持沒有工具，並由 `/basemind-status` 與一行日誌說明原因。
- 重試有上限（最多再加 2 次）；同一目標連續失敗會冷卻 10 分鐘。
- 磁碟用量：每個已安裝平台約 230–320 MB，因為保留的是整棵未壓縮 release tree（asset 下載本身是 75–102 MB）。只安裝 pinned 版本與目標平台。
- 由 layout-1 快取（單一 binary＋舊 install record）升級時，下一次啟動會重新下載完整 tree 一次；舊目錄以原子替換換掉，不會原地修補。
- `binaryDownload: false` 可完全禁止。

## 8. 版本匹配規則

`binaryPolicy` 決定「找到的版本」是否算與目標上游版本（目前 `0.34.0`）相容：

| 值 | 接受 | 說明 |
| --- | --- | --- |
| `exact`（預設） | major.minor.patch 完全相同 | 拒絕 prerelease |
| `minor` | 同一 major.minor | 忽略 patch、仍拒絕 prerelease；請先自行驗證該 patch |
| `any` | 任何可執行檔 | 只保留 MCP bridge：Skills、CLI 工具與版本提示全部關閉 |

若你卡在 `0.34.1`，建議等插件更新到下一個 pin（Skills 文本與 CLI allowlist 會一起驗證），或設 `binaryPolicy: 'minor'` 並自行承擔「Skills 未對該 patch 驗證」的風險。

## 9. 快取、離線與自訂 Binary

- 快取：`$DSH_HOME/cache/dsh-basemind-plugin/managed-binaries/<version>/<platform>/`，platform 為 `windows-x64`、`linux-x64`、`linux-arm64`、`darwin-arm64`；`install.json` 記安裝資訊（layout 2：主 binary、主 binary 自己的 `binarySha256`、檔案數，以及每個已安裝檔案的 `{ path, size }`；`sha256` 仍是下載 archive 的 digest）、`state.json` 記失敗狀態、`download/` 是暫存。`$DSH_HOME` 優先取 `DSH_HOME`，否則 `~/.dsh`。
- 重用：有效快取命中要求每一個記錄中的檔案都存在且大小相符，因此主 binary、bundled libraries 與授權檔缺一不可。大小與 mtime 只用 `stat` 檢查；只有與記錄不同時才重新 hash 主 binary。有效命中完全 0 次網路。刪除快取目錄是安全的，下次啟動會重新選型。
- 布局遷移：layout-1 快取（單一 binary＋舊 install record，或沒有 record）視為不完整；`binaryDownload: true` 時下一次啟動會重新下載完整 tree，不會原地修補。`/basemind-status` 會顯示 layout、記錄的檔案數與第一個缺少的檔案。
- 中斷的替換：若 process 在「舊 tree 移到一旁」與「新 tree 移入」之間結束，舊 tree 會以 `.old-<platform>-*` 留在 target 旁邊。下一次選型會在讀快取之前把它還原（不需下載），並清掉已被取代的殘留，因此 crash 不會遺失快取、也不會留下 230–320 MB 垃圾。
- 離線：`binaryDownload: false` 禁止所有網路請求。支援的離線路徑是 `PATH` 上的完整官方 BaseMind 安裝（完整 release tree，不是只有執行檔）、`command` 或 `BASEMIND_BIN`。手動把單一 binary 放進 managed 快取不是受支援的安裝方式，會被視為不完整。
- 自訂 binary：設 `command: "C:\\tools\\basemind\\basemind.exe"` 或 `BASEMIND_BIN`。`binaryFallback: false` 會讓不符的 pin 成為可診斷的硬停點，而不是靜默換掉。

## 10. 確認本機 Binary：`/basemind-status`

在輸入框打 `/basemind-status`。它是 human command：不經模型、不耗 token。輸出會說明本機是否存在 binary、路徑、找到與期望版本、是否相容、來源、快取狀態、下載狀態，以及兩三個可行的下一步。

```
BaseMind status - dsh-basemind-plugin 0.2.1
  expected upstream : 0.34.0 (exact)
  platform          : windows-x64 (x86_64-pc-windows-msvc)
  present           : yes
  path              : ...\Programs\basemind\basemind.exe
  found             : 0.33.0
  compatible        : NO - minor mismatch (0.33 vs 0.34)
  source            : path
  managed cache     : empty (...\.dsh\cache\dsh-basemind-plugin\managed-binaries)
  download          : enabled (binaryDownload=true)

  What to do:
    - install BaseMind 0.34.0 and point command / BASEMIND_BIN at it, or
    - restart DSH later so the next start retries after a short cooldown, or
    - set binaryPolicy: "minor" to accept 0.34.x only after you have verified it.
```

它不是設定頁，也不會在 Settings 或 Plugins 介面新增狀態卡片。

## 11. 官方 Skills

套件內含 10 個官方 BaseMind Skills（`basemind`、`basemind-cli`、`basemind-code-search`、`basemind-comms`、`basemind-doctor`、`basemind-documents`、`basemind-git-history`、`basemind-multi-agent-room`、`basemind-scan`、`basemind-stats`），以 rank 1000 經 `ctx.skills.registerProvider()` 註冊。專案內、`~/.dsh/skills` 或其他插件的同名 skill 勝出；只有在沒有其他來源提供該名稱時，才會用到插件的副本。catalog 只帶名稱與描述，正文在模型開啟 skill 時才載入。`skills: false` 可停用。

DSH 對上游文字的適配只存在 `skills/.dsh-adapt.json`；用 `npm run sync:skills` 重新產生、`npm run check:skills` 驗證。不要手改 `skills/**`。

## 12. MCP 工具與 CLI 橋接

所有 MCP 工具都來自執行中的 BaseMind，工具集跟著 binary 走。除此之外插件註冊 `mcp__basemind__cli`：純 argv、唯讀、不經 shell，與 relay 用同一個已校驗 binary。它補的是沒有 MCP 工具的能力（`code explain`、`code impact`、`code deadcode`、`code cycles`、`code migration check`、`overview`、`git hotspots`、`doctor`、`status`、`upgrade --plan`、`manual`）。破壞性動詞（`scan`、`rescan`、`serve`、`comms`、`memory put/delete/clear`、`cache clear/gc`、單獨的 `upgrade`）會被拒絕並說明原因。輸出上限 64 KB 並附 spill 路徑，`timeout_ms` 會被 clamp 到工具呼叫 timeout。`cliTool: false` 可停用。

## 13. Bootstrap prompt section

一個短 section，只補 BaseMind 自己的 MCP instructions 沒涵蓋的三件事：CLI-only 動詞、BaseMind 回答不了時改用 harness 原生 read/grep/glob/bash，以及工作區語意。binary 尚未就緒時為空字串，不含時間戳或絕對路徑，上限約 400 tokens。`bootstrap: false` 可停用。

## 14. 同步下一個 BaseMind 版本

`lib/upstream.js` 是唯一寫死版本的地方；升版清單（同步 skills、採集 fixtures、跑 gate）見 [docs/upstream-sync.md](docs/upstream-sync.md)。

## 15. 已驗證範圍

三條 gate，**刻意不可互相代替**：通過其中一條，不代表另外兩條被驗證。

| Gate | 命令 | 證明什麼 | 設定於 | 本次變更實際執行 |
| --- | --- | --- | --- | --- |
| 本機／單元 | `npm test` | 所有不需要真實 BaseMind 當受測對象的測試。兩個真實整合檔只有在 `PATH` 或 `BASEMIND_BIN` 找到相容 BaseMind 時才會真的跑，否則 skip。 | `ci.yml` | Windows x64（本機）：455 tests、445 pass、10 skipped（被 gate 的 managed 套件） |
| 外部 binary 契約 | `BASEMIND_REQUIRE_INTEGRATION=1 node --test test/integration.test.mjs test/integration-legacy.test.mjs` | **由插件外部**安裝、用系統 `tar`／`unzip` 解開的 BaseMind 的 MCP／CLI 契約（`compat.yml`）。結構上測不到 managed 安裝。 | `compat.yml`（Ubuntu x64、macOS arm64、Windows x64） | CI 中**尚未執行**（workflow 可用 dispatch 觸發；兩個套件在 `npm test` 內已對本機真實 0.34.0 實跑過） |
| Managed 安裝 | `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1 node --test test/integration-managed.test.mjs` | 插件**自己的**路徑：真下載官方 asset、驗官方 SHA256、解完整 Release Tree、寫 layout-2 記錄、真跑 `basemind --version`、用該 managed binary 跑真 MCP relay（tools／resources）與真 CLI（`managed-binary.yml`）。 | `managed-binary.yml`（Windows x64、Linux x64、macOS arm64；Linux arm64 只能透過 `include_linux_arm64` 輸入啟用） | **Windows x64 本機：2026-11-24 通過兩次**（冷安裝 13.5–55.7 s，隨下載速度變化；暖選型 57–77 ms、0 次網路）。**CI：2026-11-25 全綠**——Windows x64、Linux x64、macOS arm64（`Managed binary` 手動 dispatch，commit `72d4fde`，run [45538156378](https://github.com/zengjunlin2022/dsh-basemind-plugin/actions/runs/45538156378)）。Linux arm64：**NOT RUN**（僅 opt-in） |

### 15.1 Phase 3 效果 Benchmark（2026-11-25）

另一個 A/B benchmark 量測的是「同樣的 MCP 工具之上，Bootstrap／Skills／CLI 多給了什麼」：A 組關閉這三個面向，B 組用預設值，其餘（commit、BaseMind 0.34.0、索引、模型、prompt、preset）完全相同。Pilot 12 ＋完整 22，共 34 輪，涵蓋兩個模型與六個任務：

- **正確性：兩組相同** — 兩組每一輪都通過 rubric，沒有任何任務退化。
- **成本：混合且樣本小** — DeepSeek 上 B 組多用 11.3% tokens（3.46M vs 3.10M，各 6 輪）；GPT 上多用 70%（1.27M vs 0.75M，各 5 輪）。
- B2 的 GPT 組因成本未跑；多輪超過單輪 400k 上限；兩者都已記錄。

結果與偏差：[docs/2026-11-25-basemind-benchmark-report.md](docs/2026-11-25-basemind-benchmark-report.md)。這是效果證據，不是發布 gate；上面的三條 gate 各自成立。

Gate 契約細節：

- `npm test` 不會下載 release：沒有 `BASEMIND_REQUIRE_MANAGED_INTEGRATION` 時，managed 測試以明確訊息 skip 並指出該變數。
- 設了 gate 之後：無法連線、checksum 不符、安裝不完整、relay 起不來、工具答不出來，全部都是 **fail**，不會降級成 skip。
- 測試會斷言 `PATH` 上沒有任何可解析的 `basemind`，並移除所有帶 BaseMind 私有執行庫的 `PATH` 目錄，避免 Windows 全域安裝的 DLL 讓不完整的 managed tree 看起來可用。
- `DSH_BASEMIND_MANAGED_TEST_KEEP=1` 保留測試暫存根目錄；`MANAGED_DIAGNOSTICS_DIR=<dir>` 額外輸出小型診斷 JSON（選型、cache facts、install 記錄、耗時）供 CI artifact 使用。
- `test/workflows.test.mjs`（屬於 `npm test`）靜態守住 CI 契約：job 層 `if` 不得引用 `matrix`、架構值必須是 `uname -m` 的原字串、不得有偽綠開關、不得硬寫 BaseMind 版本，且 release gate 必須指向同一個 workflow。

managed 路徑只支援 `lib/upstream.js` 列出的 target：`windows-x64`、`linux-x64`、`linux-arm64`、`darwin-arm64`。上游沒有 macOS x64 與 Windows arm64 asset，因此 **不支援**。Linux arm64 預設不排入任何 workflow，因為本 repo 無法確認 `ubuntu-24.04-arm` runner label；要由維護者明確 opt-in。

DSH Desktop 驗收（D1–D15）是另一份人工清單：[docs/2026-11-24-basemind-desktop-acceptance-checklist.md](docs/2026-11-24-basemind-desktop-acceptance-checklist.md)。**D1–D15 已於 2026-11-25 全部驗證**（DSH `0.2.2-rc.5`，含真實 desktop profile，以及 managed fallback 所需的獨立 `DSH_HOME`）：[驗收報告](docs/2026-11-25-basemind-desktop-acceptance-report.md)。

---

MIT © 2026 Ken。見 [LICENSE](LICENSE)。
