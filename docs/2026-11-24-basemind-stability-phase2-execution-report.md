# dsh-basemind-plugin — Phase 2（Integration & Compatibility）Execution Report

- 日期：2026-11-24
- 版本狀態：`package.json` **0.2.0**，本次**未變更、未 `npm version`、未發布**；`CHANGELOG.md` 只有 `[Unreleased]`。**目標發布版本與正式發佈版本均為 0.2.0**（目前仍為開發版本，尚未正式發佈）。
- 角色：Execution（依 [AGENTS.md](../AGENTS.md) §3.4；授權來源：使用者本次 Phase 2 prompt）
- 基線 HEAD：`6375ebd6dd3714e7a812b60fcd0b0dbaab31dad1`（執行前重新確認，與 prompt 一致；工作區乾淨）
- 對應 Plan：[Stability & Feature Parity Plan](./2026-11-24-basemind-stability-feature-parity-plan.md) §10、§11、§12、§19.2
- 狀態：**部分完成**。Task A（真實 Managed Integration）與 Task B（Workflow 定義）已完成本機／靜態驗證；**遠端 CI 三平台尚未執行**（本環境無 GitHub Actions 操作授權）；Task C 只完成 D1 與 D2 的 profile 組裝層，D3–D15 待人工。Task D 的兩個 Minor 已做最小修復。
- Git：**全部變更未提交**（未執行 `git add`／`commit`／`push`／`tag`／`npm version`／`publish`／release script）。

---

## 1. Executive Summary

| 項目 | 結果 |
| --- | --- |
| 真實 Managed Binary Integration Test | **已建立並在 Windows x64 實跑通過（10/10）**：產品自己的 Binary Manager 真實下載 75,627,742 bytes、對官方 checksums 驗 SHA256、解完整 Release Tree、寫 layout-2 `install.json`、真實 `basemind --version`、真實 MCP Relay（18 tools，含 3 個 comms）、真實 CLI（status/doctor/overview/code explain） |
| 強制 Gate | `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1`：未設定時全檔 skip（`npm test` 不會下載）；設定後下載／校驗／解壓／安裝／啟動任一失敗即 fail |
| Cold / Warm | 冷安裝 13,506–55,713 ms（四次成功安裝，差異來自下載速度）；暖快取選型 **57–77 ms、0 次網路** |
| 跨平台 Workflow | 新增 `.github/workflows/managed-binary.yml`（Windows x64／Linux x64／macOS arm64；Linux arm64 透過 `include_linux_arm64` 真正 opt-in，matrix 由 `plan` job 產生；冷快取、無 actions/cache、失敗診斷 artifact）；`ci.yml`（`npm test` ＋ 失敗摘要）／`compat.yml`（每週排程、明確範圍、不再無條件排 arm64）／`release.yml`（`managed-gate`）最小修改；`test/workflows.test.mjs` 靜態守住這些契約 |
| 遠端 CI | **NOT RUN**：未取得 GitHub Actions 授權，未宣稱任何平台遠端通過 |
| DSH Desktop | D1（打包內容）PASS；D2 只在「profile 組裝」層 PASS（獨立 `DSH_HOME` 實測）；D3–D15 **NOT RUN**，已交付可直接執行的 [人工驗收清單](./2026-11-24-basemind-desktop-acceptance-checklist.md) |
| 產品缺陷 | 本階段**未發現新的產品缺陷**；Phase 1 兩個非阻擋 Minor 已做最小修復並補測試 |
| 回歸 | `npm test` **442 tests／432 pass／10 skipped（managed gate）／0 fail**（Review round 1 修正後）；`node --test test/workflows.test.mjs` 9/9、`node --test test/binary-manager.test.mjs` 41/41；`check`、`check:skills`、`check:pack` 全過 |
| 發布阻擋 | 遠端三平台 managed CI 與 Desktop D3–D15 尚未取得證據，屬 **0.2.0 發布阻擋**（依 Plan §20「三平台 managed 冷快取通過前不進入後續階段」） |

---

## 2. 實際 HEAD Commit SHA

```
6375ebd6dd3714e7a812b60fcd0b0dbaab31dad1   (main, 執行前後皆相同)
```

Phase 2 全程未建立 commit，所以「基線 SHA」與「交付 SHA」相同；交付內容等於 `HEAD` 加上本報告 §6 列出的未提交變更。

---

## 3. Phase 2 Scope

依本次 prompt §4：

- **A. 真實 Managed Binary 自動化整合測試**（M1–M7、真實 MCP、真實 CLI、語意／額外依賴能力記錄）。
- **B. Windows／Linux／macOS 跨平台 Compatibility CI**（Workflow 定義與靜態驗證；遠端實際執行不在本環境能力內）。
- **C. DSH Desktop Standard Preset 真實環境驗收**（能自動化的部分 ＋ 可執行的人工清單）。
- **D. 最小必要修復及回歸驗證**（只修與 Managed Integration 直接相關、可用最小修改解決的 Phase 1 Minor）。

本階段**只**在測試發現實際缺陷時才改 Runtime；實際只改了兩處與 Managed cache 診斷／回收直接相關的最小邏輯（§14），沒有重構。

---

## 4. Deferred Scope（本次明確不做）

依 prompt §3、§26，以下暫停開發，且**未刪除任何既有可用能力**：

| 項目 | 狀態 | 現有能力的處置 |
| --- | --- | --- |
| Binary 異常／下載狀態原生通知（Toast） | Deferred（DSH 無適合的原生 API） | 保留 `/basemind-status` 與 logger 診斷 |
| 官方 `/bm`、`/bm-init`、`/bm-scan`、`/bm-doctor`、`/bm-stats`、`/bm-statusline` 快捷命令 | Deferred | 保留 CLI Adapter（`mcp__basemind__cli`）與 10 個官方 Skills |
| Agent Identity 自動綁定、Inbox 主動通知／輪詢 | Deferred | 保留 MCP 原生的 3 個 comms tools（若 build 提供），未新增輪詢或通知 |
| PreToolUse Guard、狀態列、大型 UI、MCP Tasks 擴展、GPT/DeepSeek A/B | 不在本輪 Scope（屬 Phase 3／更後） | 未觸碰 |

Phase 2 沒有因為上述 Deferred 而移除或降級任何既有功能：`/basemind-status`、logger、10 個 skills、MCP tools、MCP resources、CLI Adapter、bootstrap、workspace pool、binary manager 全部維持並有回歸測試。

---

## 5. 可復用的 Phase 1 能力（實際被本次測試使用）

| Phase 1 產出 | 在 Phase 2 的用途 |
| --- | --- |
| `extractArchive()`（完整 Release Tree、路徑防護） | M1 真實解壓；M5b／M6 重裝走同一條產品路徑 |
| layout-2 `install.json`（`files[]`、`binarySha256`） | M1／M2／M5b／M6／M7 逐檔比對磁碟實況與 digest 分離 |
| `readManagedCache()` 完整性檢查（stat-only） | M5-A／M6-A 的「不完整快取不被接受」 |
| `recoverParkedTrees()` | Phase 2 §14 的最小修復對象；既有 `test/binary-manager.test.mjs` 案例沿用 |
| 跨進程 install lock（`fixtures/fake-managed-select.mjs` 模式） | M7 以 `fixtures/managed-real-select.mjs` 擴充為真實安裝版本 |
| `test/integration.test.mjs` 的 relay／adapter／`ensureIndexed` 慣例 | MCP 測試重用同一套 `createStdioClient`＋`createMcpSession`＋`resolveLaunch` |
| `BASEMIND_DATA_HOME`／`BASEMIND_COMMS_DIR` 隔離做法 | 全部測試沿用，並加上 `DSH_HOME` 與 PATH 淨化 |

---

## 6. 文件修改清單

### 6.1 新增

| 檔案 | 用途 |
| --- | --- |
| `test/integration-managed.test.mjs` | 真實 Managed Integration（M1–M7 ＋ 真實 MCP ＋ 真實 CLI），gate `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1` |
| `test/workflows.test.mjs` | CI 靜態回歸測試（9 項）：禁止 job 層 `if` 引用 `matrix`、matrix 由 `plan` job 產生、arm64 只在 `INCLUDE_ARM64 === 'true'` 下加入、`expectedArch` 必須是 `uname -m` 原字串、不得有 `continue-on-error`／`|| true`／`actions/cache`、不得硬寫 BaseMind 版本或 tag、`ci.yml` 必須呼叫 `npm test`、release gate 必須 `needs` 該 workflow |
| `fixtures/managed-real-select.mjs` | 跨進程 install-once 子行程 fixture：跑真實 manager／真實校驗／真實解壓，只把網路傳輸換成已驗證的官方 archive |
| `.github/workflows/managed-binary.yml` | 三平台（＋Linux arm64 opt-in）冷快取 Managed CI，可被 release.yml 以 `workflow_call` 重用 |
| `docs/2026-11-24-basemind-desktop-acceptance-checklist.md` | D1–D15 可執行人工驗收清單 |
| `docs/2026-11-24-basemind-stability-phase2-execution-report.md` | 本報告 |

### 6.2 修改

| 檔案 | 變更 |
| --- | --- |
| `lib/binary/manager.js` | 新增 `managedCacheComplete()`（與 `isLayout2()` 一致的 stat-only 完整度判定），`/basemind-status` 的 `valid` 改用它；`recoverParkedTrees()` 只在 target 已完整時才刪除 `.old-*`，並在**安裝 swap 成功後（仍在鎖內）再回收一次**（詳見 §14）；`managedCacheComplete()` 的 JSDoc 改為「stat-complete（pre-probe）」，不再宣稱與 selection 完全等價 |
| `test/binary-manager.test.mjs` | +4 案例：無 binary digest 的記錄不得被 status 報為 valid；target 不完整時保留 parked 備份；target 完整時回收 parked；**成功安裝後同一輪回收 superseded parked tree** |
| `.github/workflows/ci.yml` | `Run tests` 改為同時輸出 `_ci/test-summary.txt`；`if: failure()` 上傳 `test-summary-<os>` artifact |
| `.github/workflows/compat.yml` | 加每週 `schedule`；加 `ubuntu-24.04-arm` matrix 列；檔頭補「這條路徑測不到 managed 安裝」的範圍說明 |
| `.github/workflows/release.yml` | 新增 `managed-gate` job（`uses: ./.github/workflows/managed-binary.yml`），`release` 加 `needs: [managed-gate]` |
| `docs/2026-11-24-basemind-stability-phase1-execution-report.md` | §8 加勘誤（`recoverParkedTrees()` 的實際觸發時機與 status 顯示條件） |
| `README.md`、`README.zh.md` | 新增「已驗證範圍與 CI 分層」章節；§3 相容性表更新 managed 驗證範圍 |
| `CHANGELOG.md` | `[Unreleased]` 新增 Added／Fixed／Changed 條目 |
| `docs/upstream-sync.md` | 升版清單加入 managed gate 命令與「pin 一改，managed 證據要重取」的說明 |
| `docs/2026-11-24-basemind-stability-feature-parity-plan.md` | 新增附錄 C：Phase 2 執行狀態、Deferred 範圍、未驗證項 |

---

## 7. 真實 Managed Integration 設計

### 7.1 Gate 契約（與既有 `BASEMIND_REQUIRE_INTEGRATION` 分離）

| 變數 | 語意 |
| --- | --- |
| `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1` | 必須真下載／真校驗／真解壓／真安裝／真啟動；任何環節失敗 → **fail**，不得 skip |
| 未設定 | 全檔 10 個測試 skip，訊息為 `set BASEMIND_REQUIRE_MANAGED_INTEGRATION=1 to download and install the pinned BaseMind release`；`npm test` 不會下載 75–102 MB |
| `DSH_BASEMIND_MANAGED_TEST_KEEP=1` | 保留暫存根目錄以便除錯 |
| `MANAGED_DIAGNOSTICS_DIR=<dir>` | 額外寫一份小型 JSON 診斷（selection／cache facts／install.json／metrics／warnings），不含 token、環境變數或 binary cache |

### 7.2 隔離設計（已對照 BaseMind 0.34.0 實際環境契約）

| 資源 | 做法 |
| --- | --- |
| `DSH_HOME` | 每個測試檔自建 `mkdtemp()`，managed cache 落在它底下（M1 不傳 `cacheRoot`，讓產品用 `DSH_HOME` 推導，順便驗證 `resolveDshHome()`） |
| `BASEMIND_DATA_HOME` / `BASEMIND_COMMS_DIR` | 同一暫存根目錄的兩個子目錄，確保 daemon、索引、comms broker 都是私有的 |
| `BASEMIND_BIN` | 測試啟動時從 `process.env` 移除（繼承會讓 M1 變成 local-first） |
| `PATH` | 移除任何含 `basemind` 啟動器或 BaseMind 私有執行庫（`heif.dll`、`libde265.dll`、`libheif*.so*`、`libde265*.dylib`、`onnxruntime*.dll`）的目錄；之後斷言 `basemind` 不可解析 → 這是 Windows「PATH 上的 DLL 造成假陽性」的結構性防線 |
| Git | 測試 repo 自建（`git init` ＋ 3 檔 ＋ 1 commit），`GIT_CONFIG_GLOBAL`／`GIT_CONFIG_NOSYSTEM`／author 全部隔離，不動使用者的 git 設定 |
| Daemon | 測試結束以 managed binary 對測試 `BASEMIND_COMMS_DIR` 執行 `comms stop`，只停自己的 daemon |

### 7.3 場景與斷言（實際測試名稱）

| # | 測試 | 關鍵斷言 |
| --- | --- | --- |
| M1 | `M1 cold cache: the product downloads, verifies and installs the complete pinned release` | 前後皆無本機 `basemind`；下載 1 次官方 asset ＋ 1 次 checksums（含 GitHub 302 轉址）；archive bytes == `lib/upstream.js` 的 75,627,742；`install.sha256` == 官方 checksums 的 digest；`binarySha256` 存在且與 archive digest **不同**；`layout===2`；`files[]` 與磁碟樹逐檔一致；主 binary＋`lib/`／root DLL＋`LICENSE`＋`ATTRIBUTIONS.md`＋`THIRD_PARTY_LICENSES` 齊全；POSIX 權限可執行；`basemind --version` exit 0；`selection.source==='managed'`、`version==='0.34.0'`、`verified===true`；安裝目錄 == `managed-binaries/0.34.0/<target>`；無 staging／lock／`.old-*`；本機全局 BaseMind 的 size／mtime 未變 |
| M2 | `M2 a new manager instance reuses the managed cache with zero network` | 新 manager 實例；`fetchImpl` 一呼叫就拋錯 → 0 次網路；路徑與 M1 相同；`install.json.installedAt` 未變（沒有重裝）；整棵樹逐檔不變；`--version` 可用；無 staging |
| M3 | `M3 a compatible local binary wins over the populated managed cache` | `BASEMIND_BIN` 指向真實 0.34.0 → `source==='env'`；0 次網路；cache 未被重裝；`resolveLaunch` 的 `argv[0]` == 選型路徑且 `mode==='direct'` |
| M4 | `M4 a local binary with the wrong version falls back to the managed install` | 受控 0.33.0 launcher（Windows `.cmd`／POSIX script）→ 被跳過、warning 指出 `0.33.0` 不相容、改用 managed、0 次網路、本地檔未被修改 |
| M5-A | `M5 an incomplete managed cache is refused while downloads are disabled` | 從真實 Release 記錄挑選最大的非主 binary 執行庫（實測 Windows 為 `heif.dll`）刪除；`binaryDownload:false` → 選型失敗、`source` 不存在（不會有 relay 可啟動）、0 次網路、`cache.valid===false`、`missingFile` 指出該檔、目錄與 `install.json` 都保留、warning 說明 incomplete、錯誤文字說明 `binaryDownload is false` |
| M5-B | `M5b the official archive repairs the incomplete managed cache` | 同一個 cache root，用 M1 真實下載保留下來的官方 bytes 重放（產品仍做真實 SHA256 校驗、真實解壓、真實安裝）；1 次 checksums ＋ 1 次 asset；layout 2；archive digest 與 binary digest 都與 M1 相同；被刪的執行庫以原 size 復原；`cache.valid===true`；`--version` exit 0 |
| M6 | `M6 a layout-1 cache is not adopted and is replaced only by a full install` | 手造 layout-1（單一 binary ＋ 舊記錄）→ 禁止下載時選型失敗、0 次網路、`cache.layout===1`、`cache.valid===false`、舊目錄與舊記錄都保留；允許下載時換成完整 layout-2、`installedAt` 已更新、樹與記錄一致、`BASEMIND_DATA_HOME` 完全沒被寫入 |
| M7 | `M7 concurrent callers reuse one real install instead of copying or re-downloading` | 同 process 兩個 manager 併發 → 同一路徑、`installedAt` 不變；兩個**真實子行程**同時對空 cache root 安裝 → 總共只有 **1** 次 asset 下載與 1 次 checksums、兩個都成功、只產生一個 target 目錄、無 staging／`.old-*`、每個 cache root 只有自己那一份（沒有 per-session 副本） |

### 7.4 真實 MCP 驗證（不是只跑 `--version`）

`the managed binary serves the real MCP relay: initialize, tools, resources, tools that answer`

- `resolveLaunch()` → `createStdioClient()` → `createMcpSession()`，relay 的可執行檔就是 managed binary（`argv[0]` 相同、`mode==='direct'`）。
- `initialize`：protocolVersion `2025-06-18`、`serverInfo.name/version`、非空 `instructions`。
- `tools/list`：15 個 verb tools 全部存在；9 個已退役名稱不存在；額外工具只能是 3 個 agent tools（本次實測 18 tools ＝ 15 ＋ 3 comms）。
- `index_status`：回報 fixture repo 的 root；冷索引輪詢到 `indexing !== true`。
- `code_outline`（TOON `path: ` 開頭）、`code_symbols`、`code_read`（回傳函式本體）、`code_refs`、`code_grep`（`structuredContent.hits` 被保留且帶 `src/math.js`）、`git_log`（回報 fixture commit）。
- `resources/list`（含 `basemind://status`）、`resources/templates/list`、`resources/read`（JSON 可解析）。
- `close()` 後 relay 子行程確實結束（`waitForExit` 為 true）。
- comms：本次官方 build 宣告 `agent_inbox`／`agent_post`／`agent_threads`，測試只驗證「被宣告且 discovery 正常」，**沒有**新增 Agent Identity 綁定、Inbox 輪詢或通知（Deferred）。

### 7.5 真實 CLI 驗證

`the managed binary answers the real CLI verbs through the CLI adapter`

- 用產品自己的 `createCliTool()`，binary 傳入同一份 selection；`ctx.workingDirectory.ensure()` 回傳 fixture repo。
- 每次呼叫都斷言：只 spawn 一個行程、`argv[0]` == managed binary、`cwd` == Agent 工作區、`argv` 尾巴是 `--root .`（沒有 shell 拼接、沒有 `--root` 參數可被模型指定）。
- `status`（exit 0、輸出有 index 相關資訊）、`doctor`（有輸出，且兩個指令都沒有動態庫載入失敗訊息）、`overview`、CLI-only 的 `code explain src/math.js`。
- Allowlist 未被削弱：`scan` 被拒絕（`destructive machine-global command`）；預先 abort 的呼叫直接失敗且**不 spawn** 任何行程。
- MCP／CLI binary 一致性：`resolveLaunch()` 的 `argv[0]` 與 CLI 的 `argv[0]` 都是同一條 managed 路徑。

### 7.6 語意搜尋與額外依賴能力（未納入 gate，如實記錄）

| 能力 | 本輪狀態 |
| --- | --- |
| `code_search`（語意／embedding） | **未在 gate 驗證**：需要額外模型或大型資源，普通 CI 與 managed CI 都不下載。工具本身存在於 `tools/list`。 |
| `docs_search`（文件管線）、OCR／HEIF 影像解析 | **未驗證**：需要 documents 特徵與額外資源；本輪只驗證它所依賴的 `libheif`／`libde265` 執行庫隨 Release Tree 完整安裝並可被 `--version`／MCP／CLI 正常載入。 |
| tree-sitter grammars | 首次啟動時由 daemon 自行下載到 `BASEMIND_DATA_HOME`（本次實測冷啟動索引 6.7 s，含此步驟）；文件中已標明「第一次啟動需要網路」。 |
| 動態依賴庫功能（本輪有驗證的部分） | M5-A 刪掉真實 Release 的 `heif.dll` 後，快取被判定不完整且不被接受；M5-B 復原後 `basemind --version` 與 MCP／CLI 全部正常 → 這是「動態依賴庫缺失會被抓到、復原後功能回來」的直接證據。 |

---

## 8. Managed Integration 測試結果（Windows x64，本機實跑）

| # | 測試 | 結果 | 時間 |
| --- | --- | --- | --- |
| M1 | 冷快取真實下載＋安裝 | **PASS** | 13,506 ms（五次成功安裝：13,506／24,969／29,646／41,652／55,713；差異來自下載速度，安裝流程相同） |
| M2 | 暖快取零網路重用 | **PASS** | 109 ms（選型 57 ms） |
| M3 | Local First 零下載 | **PASS** | 55 ms |
| M4 | 不相容本地版 fallback | **PASS** | 131 ms |
| M5-A | 缺依賴拒絕 | **PASS** | 203 ms（含 230 MB tree 複製） |
| M5-B | 官方 archive 修復 | **PASS** | 1,987 ms（安裝 1,948 ms） |
| M6 | Layout 1 遷移 | **PASS** | 2,225 ms |
| M7 | 併發（in-process ＋ cross-process） | **PASS** | 2,009 ms（race 1,944 ms；1 次下載） |
| MCP | 真實 MCP Relay 功能 | **PASS** | 8,212 ms（索引 6,666 ms） |
| CLI | 真實 CLI 功能 | **PASS** | 1,180 ms |
| 總計 | | **10 tests / 10 pass / 0 fail / 0 skip** | 42,017 ms |

實際命令（PowerShell／CMD／POSIX 皆可用同一形式，只有環境變數語法不同）：

```bash
# POSIX shell
BASEMIND_REQUIRE_MANAGED_INTEGRATION=1 MANAGED_DIAGNOSTICS_DIR=/tmp/bmdiag \
  node --test --test-reporter=spec test/integration-managed.test.mjs
```

```powershell
# Windows PowerShell
$env:BASEMIND_REQUIRE_MANAGED_INTEGRATION="1"; $env:MANAGED_DIAGNOSTICS_DIR="$env:TEMP\bmdiag"
node --test --test-reporter=spec test/integration-managed.test.mjs
```

```bat
:: Windows CMD
set BASEMIND_REQUIRE_MANAGED_INTEGRATION=1
set MANAGED_DIAGNOSTICS_DIR=%TEMP%\bmdiag
node --test --test-reporter=spec test\integration-managed.test.mjs
```

實際 `install.json`（Windows x64）：

```json
{
  "layout": 2,
  "version": "0.34.0",
  "target": "windows-x64",
  "sha256": "ce5ead4dd53f9242539cb87e180451e95676ea82f9b0f04364c9abedec7cadb4",
  "binarySha256": "6e2c7cfbd56255ba86a7dd17df367f63cb61668e8de8efff8ed0e465fa973f30",
  "url": "https://github.com/Goldziher/basemind/releases/download/v0.34.0/basemind-x86_64-pc-windows-msvc.zip",
  "tag": "v0.34.0",
  "binary": "basemind.exe",
  "size": 226144768
}
```

檔案清單（12 項，與官方 zip 的 12 個 regular entry 完全一致）：`ATTRIBUTIONS.md`、`LICENSE`、`THIRD_PARTY_LICENSES`、`basemind.exe`、`heif.dll`、`libde265.dll`、`licenses/` 內 6 個授權檔。

### 8.1 與 Phase 1 歷史數據的對照

| 指標 | Phase 1（歷史） | Phase 2（本次實測） |
| --- | --- | --- |
| 冷安裝 | 13,068 ms | 13,506／24,969／29,646／41,652／55,713 ms（五次成功安裝；差異幾乎完全來自 GitHub 下載速度） |
| 暖選型 | 39 ms | 57／63／64／77 ms |
| 官方 Release bytes | 75,627,742 | 75,627,742（一致） |

226 MB 主 binary 的 hash、12 個檔案的逐檔記錄與解壓是固定成本；**兩者都不是跨平台固定門檻**。

---

## 9. Cold Cache / Warm Cache 性能記錄

| 指標 | 實測（Windows x64） |
| --- | --- |
| Cold Cache 安裝耗時 | 13,506 ms（五次成功安裝：13,506／24,969／29,646／41,652／55,713） |
| Warm Cache 選型耗時 | **57 ms**（另四次 60／63／64／65／77 ms 級的實測，全部 0 次網路） |
| 網路請求次數（冷安裝） | **4**（checksums URL 302 → 200、asset URL 302 → 200） |
| 下載檔案大小 | 75,627,742 bytes（與 `lib/upstream.js` 記載一致） |
| 完整安裝大小 | 12 個檔案；主 binary 226,144,768 bytes；整棵樹約 230 MB |
| MCP 初始化耗時 | 約 0.4 s（relay 測試 8.2 s 中其餘為冷索引） |
| 代表性 MCP Tool Call | `code_grep` 等單次呼叫在索引就緒後為數十 ms 級（含於 8.2 s 總時間內） |
| 代表性 CLI Call | `status` 926／910／944 ms（首次含 daemon 冷啟動）、`doctor` 89–97 ms、`overview` 78–92 ms、`code explain` 73–95 ms |
| 重裝（replay）| 1,948 ms（M5-B）、2,225 ms（M6） |
| 跨進程安裝一次 | 1,944 ms，1 次下載 |

已確認**不存在**下列退化：重複下載（M2／M3／M7 反向斷言）、每次 Tool Call 重複解壓（M2 斷言 `installedAt` 不變、無 staging）、每次 Tool Call 複製 binary（M7 斷言每個 cache root 只有一份）、多 Session 重複安裝（M7）、大量不必要的檔案 hash（`readManagedCache()` 只在 size／mtime 變動時 hash 主 binary）。

---

## 10. 跨平台 CI 修改及實際結果

### 10.1 `.github/workflows/managed-binary.yml`（新增）

- 觸發：`workflow_dispatch`、每週 `schedule`、`workflow_call`（供 release gate 重用）。`include_linux_arm64`（boolean，預設 false）同時宣告在 `workflow_dispatch` 與 `workflow_call`。
- **matrix 由 `plan` job 產生**：GitHub 的 `jobs.<id>.if` **不能**讀 `matrix` context（可用的是 `github`／`needs`／`vars`／`inputs`），所以「job 層 `if: matrix.optIn`」會恆為 true、opt-in 形同虛設（Review round 1 的 Critical 2；已修）。現在 `plan` job 用 Node 產生 matrix JSON（3 個必要平台，或在使用者 opt-in 時加上 `ubuntu-24.04-arm`），`managed` job 以 `needs: [plan]` ＋ `matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}` 消費。
- 平台：`ubuntu-latest`（linux x86_64）、`windows-latest`（win32 x64）、`macos-15`（darwin arm64）為預設；`ubuntu-24.04-arm`（aarch64）只在 opt-in 時加入。
- **架構真實性檢查**：比對 `uname -m`（原字串）、`node -p process.platform`／`process.arch` 與 matrix 期望值，再確認 `lib/upstream.js` 解析出的 release target 與這個 runner 相符；任一不符即 `::error::` 失敗。matrix 的 `expectedArch` 存放的是該 runner **`uname -m` 的原字串**（`x86_64`／`arm64`／`aarch64`），workflow 不做任何 arm64→aarch64 正規化（Review round 1 的 Critical 1：舊版把 macOS 的 `arm64` 正規化成 `aarch64` 再與 matrix 的 `arm64` 比較，macOS job 必然失敗並擋住 release；已修）。
- 冷快取：**不使用 `actions/cache`**；不預先解壓任何 binary；不設 `BASEMIND_BIN`；測試自己建立並斷言 cache root 不存在。
- 版本來源：全部由 `lib/upstream.js` 的 `UPSTREAM`／`assetFor()`／`resolveTarget()` 取得；`test/workflows.test.mjs` 靜態斷言 workflow 內不得出現該版本或 tag 字面值。
- 超時：job `timeout-minutes: 60`；測試內 per-test timeout（冷安裝 600 s、其餘 240 s、MCP／CLI 420 s）、下載 timeout 走產品既有上限、MCP startup 120 s、tool call 120 s。job 上限刻意大於測試內最壞總和，避免「測試 hang → job 先被砍 → 診斷 artifact 來不及上傳」。
- 診斷：`MANAGED_DIAGNOSTICS_DIR` 設在 **job 層 `env`**（Review round 1 的 Important 1：原寫在測試 step，summary step 讀不到，`measured` 區塊永遠空白；已修）；`if: always()` 把 metrics／selection／cache facts／install digest 與測試摘要寫入 Step Summary，讀 JSON 時以 **argv 傳路徑**而不是把 Windows 路徑插進 JS 字串；`if: failure()` 上傳 `managed-diagnostics-<os>`（只有小型 JSON 與文字摘要，**不含** binary cache、環境變數或憑證）。
- 「Record the cold-cache starting point」排在架構斷言**之前**，讓「測試尚未開始就失敗」的情況仍留下 pin／target／matrix 期望值。

### 10.2 `.github/workflows/ci.yml`（最小修改）

- `Run tests` 改為 `npm test -- <雙 reporter 參數>`：`npm test` 仍是執行測試的唯一來源（Review round 1 Minor 2），額外輸出 `_ci/test-summary.txt`。
- `if: failure()` 上傳 `test-summary-<os>` artifact（7 天）。這是 Plan §11.4 的「CI 紅但拿不到日誌」結構性解法。
- 普通 CI **不**因新增 Managed Integration 而下載大型 binary（測試在無 gate 變數時 skip）。

### 10.3 `.github/workflows/compat.yml`（最小修改）

- 加 `schedule`（每週）。
- **沒有**把 `ubuntu-24.04-arm` 加進矩陣：無法從本環境確認該 label 可排程，而排不到的 GitHub-hosted job 會一直 queued（job timeout 只在開始執行後才計時），會讓每週排程卡住；原註解聲稱「label 不可用時會失敗並印出訊息」也不成立（Review round 1 的 Important 2，已改為明確說明與移除）。Linux arm64 的契約／managed 證據改由 `managed-binary.yml` 的 `include_linux_arm64` 由人工確認 runner 後 opt-in。
- 檔頭補上範圍聲明：這條路徑用系統 `tar`／`unzip` 解官方 asset，測的是**外部 binary 的契約**，結構上測不到 managed 安裝 → 與 `managed-binary.yml` 不可互相代替。

### 10.4 `.github/workflows/release.yml`（最小修改）

- 新增 `managed-gate` job：`uses: ./.github/workflows/managed-binary.yml`（`permissions: contents: read`）。
- `release` job 加 `needs: [managed-gate]`。
- 效果：同一個 tag／同一個 commit SHA、同一份 `lib/upstream.js` pin、同一組平台；local `uses:` 固定取 caller 的 commit，不會拿舊 commit 的成功結果當證據。Linux arm64 不在預設 gate 內（`include_linux_arm64` 預設 false），避免未確認的 runner label 阻擋發布。
- 本階段**未實際發布 npm**，也未 push tag。

### 10.5 實際執行結果

| Workflow | 本機／靜態驗證 | 遠端實際執行 |
| --- | --- | --- |
| `ci.yml` | YAML 解析（PyYAML）；`npm test -- <reporter>` 形式在本機 Node 24.20.0 可用（本次所有測試即以此形式執行）；`test/workflows.test.mjs` 斷言它仍呼叫 `npm test` | **NOT RUN** |
| `compat.yml` | matrix／asset／arch 對照 `lib/upstream.js` 靜態核對；`test/workflows.test.mjs` 斷言沒有無條件 arm64 列、且範圍聲明存在 | **NOT RUN** |
| `managed-binary.yml` | `test/workflows.test.mjs` 9 項靜態斷言全過（job 層 `if` 不引用 matrix、matrix 由 plan job 產生、arm64 在 `INCLUDE_ARM64 === 'true'` 之下、arch 值為原字串、無 `continue-on-error`／`|| true`／`actions/cache`、不得硬寫版本、release gate 接線）；YAML 解析通過；Resolve 與架構斷言的 Node/bash 片段以本機等價命令驗證 | **NOT RUN** |
| `release.yml` | `needs`／`workflow_call` 結構人工核對 ＋ `test/workflows.test.mjs` 斷言 gate 接線；未觸發 | **NOT RUN** |

**未取得 GitHub Actions 操作授權（本環境無 `gh`／token），因此不宣稱任何平台遠端 CI 已通過。** 需要人工 `workflow_dispatch` 觸發 `managed-binary.yml` 取得三平台證據；第一次觸發請保留失敗 artifact 以驗證診斷路徑。

---

## 11. 各平台 PASS / FAIL / NOT RUN 矩陣

| 平台 | 架構 | Managed 冷安裝 | Warm 重用 | 真實 MCP | 真實 CLI | 證據來源 |
| --- | --- | --- | --- | --- | --- | --- |
| Windows | x64 | **PASS**（本機實跑） | **PASS** | **PASS** | **PASS** | §8 本機 `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1` 全綠 |
| Linux | x64 | **NOT RUN** | NOT RUN | NOT RUN | NOT RUN | `managed-binary.yml` 已定義；待人工觸發 |
| macOS | arm64 | **NOT RUN** | NOT RUN | NOT RUN | NOT RUN | `managed-binary.yml` 已定義；待人工觸發 |
| Linux | arm64 | **NOT RUN**（**opt-in**：`managed-binary.yml` 的 `include_linux_arm64` 預設 false，因為本環境無法確認 `ubuntu-24.04-arm` runner 可用性；`compat.yml` 刻意沒有無條件 arm64 列） | NOT RUN | NOT RUN | NOT RUN | `managed-binary.yml` 的 plan job 會在使用者 opt-in 時加入此 entry |
| macOS | x64 | **不支援**（上游未提供 macOS x64 Release） | — | — | — | `lib/upstream.js` 只有 `darwin-arm64` |
| Windows | arm64 | **不支援**（上游未提供） | — | — | — | `lib/upstream.js` 只有 `windows-x64` |

本機普通 CI（`npm test`）與靜態 Gate 在 Windows 全部通過；Ubuntu 的普通 CI 與 `index.test.mjs` 的 POSIX 分支仍待遠端執行。

---

## 12. 真實 MCP / CLI 驗證結果

### 12.1 MCP

| 驗證 | 結果 |
| --- | --- |
| `initialize` | PASS（`2025-06-18`、serverInfo、非空 instructions） |
| `tools/list` | PASS（15 verb ＋ 3 agent ＝ 18；9 個退役名稱不存在） |
| MCP Server Instructions | PASS（非空且由 `ctx.systemPrompt.section()` 帶入的既有行為未改動） |
| `index_status` | PASS（root == fixture repo；冷索引輪詢到 `indexing:false`） |
| `code_outline` | PASS（TOON `path: ` 開頭） |
| `code_symbols` | PASS（找到 `sumFiles`，`structuredContent` 帶 `src/math.js`） |
| `code_read` | PASS（回傳函式本體） |
| `code_refs` | PASS（回報 `math.js`） |
| `code_grep` | PASS（`structuredContent.hits` 保留且帶 `src/math.js`） |
| `git_log` | PASS（回報 fixture commit `add the sample sources`） |
| `resources/list` | PASS（含 `basemind://status`） |
| `resources/templates/list` | PASS（回傳 `resourceTemplates` 陣列） |
| `resources/read` | PASS（JSON 可解析） |
| StructuredContent 保留 | PASS（`code_grep.hits`、`code_symbols` 皆驗證） |
| Relay 正常關閉 | PASS（`waitForExit` 為 true） |

### 12.2 CLI

| 驗證 | 結果 |
| --- | --- |
| `status` | PASS（exit 0，926／910／944 ms） |
| `doctor` | PASS（有輸出；與 status 皆無動態庫載入失敗訊息；本次 exit code 為 0） |
| `overview` | PASS（描述 fixture repo） |
| CLI-only 高級分析 `code explain src/math.js` | PASS |
| 使用正確 Binary | PASS（每次 spawn 的 `argv[0]` == managed binary） |
| 使用正確 Agent Workspace | PASS（`cwd` == fixture repo，`--root .`） |
| 不錯誤調用 PATH 中的 BaseMind | PASS（PATH 已淨化且斷言不可解析） |
| argv 調用方式正確 | PASS（無 shell 拼接；`--root` 由插件強制） |
| Result Envelope | PASS（`{text, content, isError}`，`content` 為空陣列，與既有契約一致） |
| 超時及取消 | PASS（預先 abort 立即失敗且不 spawn；既有 timeout 邏輯未改） |
| 唯讀 Allowlist 未被削弱 | PASS（`scan` 被拒絕） |
| MCP／CLI Binary 一致性 | PASS（同一份 selection） |

### 12.3 契約差異與缺陷

本輪測試**未發現** CLI 指令與既有 Allowlist 的契約差異：`status`、`doctor`、`overview`、`code explain` 都在既有 allowlist 內並正常運作，因此沒有修改 `lib/cli-tool.js`。

---

## 13. Desktop D1–D15 驗收結果

| # | 項目 | 結果 | 說明 |
| --- | --- | --- | --- |
| D1 | 插件打包及安裝 | **PASS（本機實測）** | `npm pack` 產生 142,425 bytes／52 檔／10 skills；無 cache／test／暫存檔；`check:pack` 通過；獨立 profile 安裝成功 |
| D2 | Standard Preset | **PASS（profile 組裝層）／GUI NOT RUN** | 獨立 `DSH_HOME`（`%TEMP%\dsh-accept`）以 shipped web 模板建立 profile，安裝實際 tarball 後 `--dump-config` 顯示 `dsh-basemind` row 自動插入且未 disabled，使用者 patch 層仍為 `[]`，未新增任何 MCP row。GUI 內「Agent 發現工具」未驗 |
| D3 | Local First | NOT RUN | 需人工（可用 §3 路徑 A 的隔離實例） |
| D4 | Managed fallback | NOT RUN | 需人工；步驟已在清單中（先移除 `BASEMIND_BIN` 與 PATH 中的 basemind） |
| D5 | Managed cache 重用 | NOT RUN | 需人工重啟測試 profile |
| D6 | MCP Tools（可調用） | NOT RUN | 需真實 Agent 回合（會消耗模型額度，未取得授權） |
| D7 | MCP Resources | NOT RUN | 同上 |
| D8 | CLI Adapter | NOT RUN | 同上 |
| D9 | Skills Registry | NOT RUN | 同上 |
| D10 | Skills 正文載入 | NOT RUN | 同上 |
| D11 | 多 Session 工作區隔離 | NOT RUN | 同上 |
| D12 | 工作區切換 | NOT RUN | 同上 |
| D13 | Subagent 路由 | NOT RUN | 同上 |
| D14 | 同一 Repo 不同 Worktree | NOT RUN | 同上 |
| D15 | 插件生命周期 | NOT RUN | 同上 |

**未執行原因（誠實記錄）**：D6–D15 需要真實 Agent 與模型互動（消耗使用者模型額度，未取得授權），且 Desktop app 固定使用 `~/.dsh`，直接操作會修改生產 profile（prompt §19 明確禁止）。因此本階段不自稱 Desktop 驗收完成，交付 [可執行的人工驗收清單](./2026-11-24-basemind-desktop-acceptance-checklist.md)（含指令、Prompt、預期結果、判定標準、回滾方式）。

**未污染使用者環境的證據**：`~/.dsh/profiles/desktop/package.json` 仍為 `dsh-basemind-plugin: 0.1.6`；`node_modules/dsh-basemind-plugin/package.json` 的 `version` 仍為 `0.1.6`；未修改任何 preset、persona 或全域設定。所有自動化動作都在 `%TEMP%` 下的一次性目錄中。

---

## 14. 新發現的產品缺陷及修復證據（含 Phase 1 非阻擋 Minor）

本階段**沒有**發現新的產品缺陷（Managed Integration 一次修好測試自身的 3 個 bug 後全綠；那些是測試程式缺陷，未動產品碼）。Phase 1 Scoped Re-Review 記錄的 3 個非阻擋 Minor 處置如下：

### 14.1 `managedCacheFacts().valid` 與 `isLayout2()` 判定不一致 — **已修（最小）**

- 現象：layout-2 但缺 `binarySha256` 的記錄，`/basemind-status` 會顯示 valid，選型卻會重下載。
- 根因：`managedCacheFacts()` 自己重寫了一遍完整度條件（`present && layout===2 && records.length>0 && !missingFile`），沒有要求 `binarySha256`。
- 修法：新增 `managedCacheComplete()`（stat-only：`isLayout2()` ＋ 主 binary 存在 ＋ `files[]` 全部存在且 size 相符），`valid` 改用它。`/basemind-status` 與 parked-tree 回收共用這一個判定；**selection 仍走 `readManagedCache()`**，它套用同一段 stat gate 之後還會 probe、比對版本與 digest（這些需要 I/O），所以 `valid` 的語意是「stat-complete（pre-probe）」而不是「選型一定成功」。JSDoc 已照此收斂（Review round 1 Minor 5 指出的過度宣稱）。
- 證據測試：`a cache record without a binary digest is not reported as valid by status()`（若移除修復，`valid` 會是 `true` → 斷言失敗）。

### 14.2 多個 `.old-*` 存在時，可能在驗證較新的快取前刪除較舊但有效的快取 — **已修（最小、保守）**

- 現象：`recoverParkedTrees()` 還原**最新**的 parked tree 後，立刻刪除其餘所有 `.old-*`，而此時被還原的 tree 尚未驗證；另一個分支（target 存在）則無條件刪除所有 `.old-*`。
- 根因：刪除決策只依「有沒有 parked tree」，沒有依「活下來的 target 是否真的完整」。
- 修法（不改整體流程、不新增狀態）：兩個分支都改成「**只有當 target 是完整 layout-2 安裝時**才刪除 `.old-*`」；不完整時保留全部 parked tree 並記一筆 `warn`（含數量）。另外在 `installPinned()` **swap 成功後（仍在鎖內）**再呼叫一次回收，讓「安裝已經把 target 補完整」的那一輪就清掉舊 parked tree，而不是多佔一份 230–322 MB 到下一次啟動（Review round 1 Minor 2）。
- 代價：連續失敗時 parked tree 可能暫時累積（每次失敗最多一個）；只要有一次成功安裝或 target 本來就完整，下一次選型就會清掉。
- 證據測試：
  - `an intact parked tree is kept while the surviving cache is incomplete`（若移除修復，parked 會被刪 → 斷言失敗）；
  - `a parked tree is removed once the target is a complete install`（防止變成「永不回收」）；
  - `a successful install reclaims a superseded parked tree in the same run`（若移除 swap 後的回收，舊 parked tree 會留下 → 斷言失敗）；
  - 既有 `an interrupted swap is recovered from the parked .old tree without a download` 與 `a locked destination rename …` 兩案仍通過（回歸）。

### 14.3 Execution Report 描述偏差 — **已更正**

- Phase 1 報告 §8「接受殘留」原寫「留到下一次**安裝**才清掉」，實際是下一次**選型**（`runSelection()` 起點）就會執行；「status 可見」只在 target 缺失時成立（`parkedTree` 僅在 `present === false` 時計算）。
- 處置：在 [Phase 1 Execution Report](./2026-11-24-basemind-stability-phase1-execution-report.md) §8 加「勘誤」段，並依 14.2 的修復更新語意。程式行為本身正確，屬文件描述偏差。

### 14.4 Review round 1 在交付內容發現的缺陷（都已修，附回歸證據）

獨立的兩個唯讀 reviewer（runtime／CI＋docs）對 staged tree 做審查，發現下列問題。全部在本次交付內修正，並在可行處補了會對舊版失敗的測試。

| # | 級別 | 缺陷 | 修法與證據 |
| --- | --- | --- | --- |
| R1 | **Critical** | `managed-binary.yml` 把 `uname -m` 的 `arm64` 正規化成 `aarch64` 再與 matrix 的 `darwin` 列 `arm64` 比較 → macOS job 必紅，而 `release` job `needs: [managed-gate]`，等於**任何 tag 都無法發布** | 移除正規化，matrix 直接存 `uname -m` 原字串並逐一比對；`test/workflows.test.mjs` 斷言 4 個 entry 的 platform/arch 組合合法、darwin 必為 `arm64`、workflow 不得出現 `arm64\|aarch64)` 正規化 |
| R2 | **Critical** | job 層 `if: matrix.optIn != true \|\| inputs.include_linux_arm64 == true`：GitHub 的 `jobs.<id>.if` 不提供 `matrix` context，條件恆為 true → Linux arm64「opt-in」不存在，release gate 實際無條件依賴未確認的 runner label | 改為 `plan` job 產生 matrix JSON，`managed` job 以 `fromJSON(needs.plan.outputs.matrix)` 消費；`include_linux_arm64` 同時宣告於 `workflow_dispatch` 與 `workflow_call`（預設 false）；`test/workflows.test.mjs` 斷言「job 層 `if` 不得含 `matrix`」與 plan/arm64 的產生順序 |
| R3 | Important | `MANAGED_DIAGNOSTICS_DIR` 只掛在測試 step，Step Summary 的 `measured` 區塊永遠讀不到（等於 §17 要求的失敗診斷在 summary 缺失）；且把 Windows 路徑插進 `node -e` 字串會被反斜線轉義破壞 | 移到 job 層 `env`；讀 JSON 改以 argv 傳路徑；無檔案時明確輸出「gate 在測試前就失敗」 |
| R4 | Important | `compat.yml` 無條件加入 `ubuntu-24.04-arm`，且註解聲稱「label 不可用時會失敗並印訊息」——實際上排不到的 job 只會 queued，註解與實作都不成立 | 移除該矩陣列，改在註解說明由 `managed-binary.yml` 的 opt-in 取得 arm64 證據（runner 可用性確認後）；`test/workflows.test.mjs` 斷言 compat 沒有無條件 arm64 列 |
| R5 | Important | README（兩語言）§15 的「實際執行處」欄把「已設定」寫成「已執行」（`ci.yml`／`compat.yml` 從未在遠端跑過），且 `npm test` 的 skip 說明寫成「兩個真實套件一律 skip」 | 表格改成「設定於」＋「本次變更實際執行」兩欄；CI 一律標 **NOT RUN**；`npm test` 的說明改成「只有在 `PATH`／`BASEMIND_BIN` 找不到相容 BaseMind 時才 skip」 |
| R6 | Important | Desktop 清單不是全部可直接執行：§3.1 先建了 `repo-a-wt` 讓 D14 的 `git worktree add` 必失敗；D3／D5 沒有操作步驟；D4 的兩個前提互相矛盾；D15 要求 Agent 操作 GUI | §3.1 不再預建 worktree 目錄；新增 §3.4 的 D3／D5 逐步操作；D4 改成單一可執行前提（移除 `BASEMIND_BIN`、從 `PATH` 移除 basemind、`where.exe basemind` 必須無輸出）並寫出預期 `source: managed`；D15 改為人工 GUI 步驟，Agent 只負責回報觀察 |
| R7 | Important | M1 斷言 `recorder.calls.asset === 1`：`downloadVerified()` 對 429／5xx 會合法重試，一次 GitHub 抖動就會讓 gate 偽紅 | 改成 `>= 1` 並把 attempts 寫進 metrics；「只安裝一次」改由單一 target 目錄、M2 的 `installedAt` 不變與 M7 的跨進程 1 次下載證明 |
| R8 | Minor | 版本標籤在 index 仍為 0.3.0（已在 worktree 修正但未 stage），與 `package.json` 0.2.0 不一致 | 依人工裁決全面改為 0.2.0（報告／清單標題、發布阻擋標籤、Plan 檔頭更正註記）；交付前需重新 stage |
| R9 | Minor | `test/integration-managed.test.mjs` 證據強度與預算：archive／binary 的 digest 只取自產品記錄；`licenses/**` 無斷言；per-test timeout 小於內層 timeout 之和；M7 子行程無 timeout／kill；`ensureIndexed()` 對非預期 payload 會提前返回 | M1 用 `node:crypto` 自行 hash archive 與安裝後的 binary 並比對公開 digest／記錄；斷言 `licenses/` 必須存在；新增 `RUNTIME_TIMEOUT_MS = 420 s`（MCP／CLI）、冷安裝降為 600 s、job timeout 60 分鐘；M7 子行程加 180 s timeout＋SIGKILL＋`cwd`；`ensureIndexed()` 要求 `indexing === false`，payload 不合法即 `assert.fail` 並印出原文 |
| R10 | Minor | M6 的「不改 BaseMind data home」是在空目錄上比對空目錄；M1 的「no lock」沒檢查 `.lock-*`；Windows 的 `BM_TARGET` 比對用了 Node 命名（`win32-x64`）→ 每次多一筆 warning | M6 先寫 sentinel 檔再比對內容與清單；M1 斷言 `managed-binaries/.lock-*` 不存在；workflow 改成由 `process.platform`／`arch` 推導 `windows-x64` 等 target 並在**不符時直接失敗**（不再只是 warning） |
| R11 | Important | `ensureIndexed()` 的就緒判定與 0.34.0 實際契約不符（就緒 payload **省略** `indexing`；建索引初期還可能給 `structuredContent: {}`）。R9 之後我第一次收緊成「必須 `indexing === false`」，結果每次都在 150 s 後才失敗——同時反向證實了舊版「一旦不是 `indexing: true` 就返回」會在空物件時誤判就緒（即先前那次未定位偶發失敗的機制） | 新增 `looksLikeIndexStatus()`／`indexPayload()`：優先採用能描述 workspace 的來源（structuredContent 或文字），就緒條件為 `typeof root === 'string' && indexing !== true`；10 秒內從未取得可辨識 payload 就 fail 並印出原文。修正後 managed gate 恢復 10/10（見 §15.1） |

**未採納的建議（附理由）**：reviewer 建議把 `createSubprocessAdapter`／`ensureIndexed`／`statusPayload`／`stopTestDaemon` 抽成 `test/helpers/*` 並讓 `test/integration.test.mjs` 一起改用。本輪**不採納**：那會改動已穩定通過的真實整合套件（Phase 1 驗證過的檔案），風險大於收益，而且 `node --test` 以檔案為單位隔離，自包含的測試檔反而降低互相污染。重複的 helper 已列為 §17 的 known debt，另立重構項處理。

### 14.5 未修、僅記錄風險

| 項目 | 風險 | 為何本輪不動 |
| --- | --- | --- |
| `lib/binary/probe.js` 的 spawn spec 不帶 `env`（繼承 Host PATH） | 理論上仍可能被 PATH 上的 DLL 影響；但整包安裝後不再造成假陽性（Phase 1 已論證），且測試以淨化 PATH 斷言 | 需改動 probe 的環境契約，屬跨模組行為變更，不在 Phase 2 Scope |
| `firstBrokenFile` 只做 size 檢查 | 同大小但內容損壞的 `lib/*.so*` 不會被發現（主 binary 在 size/mtime 變動時會 hash） | Plan 明確選擇不 hash 整樹；改變它會顯著增加每次冷啟動成本 |
| 語意搜尋／OCR／文件管線 | 未在 CI 驗證 | 需要額外模型或大型資源，prompt §12 明確允許記錄限制 |

---

## 15. 所有實際執行的測試命令及結果

工作目錄：`D:\02_zengjunlin\github\dsh-basemind-plugin`；Node `v24.20.0`；Windows 10/11 x64。

| # | 命令 | 結果 |
| --- | --- | --- |
| 1 | `node --check test/integration-managed.test.mjs && node --check fixtures/managed-real-select.mjs` | OK（無語法錯誤） |
| 2 | `node --test test/integration-managed.test.mjs`（無 gate） | 10 tests / 10 skipped / 0 fail，訊息明確指出需要 `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1` |
| 3 | `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1 node --test --test-reporter=spec test/integration-managed.test.mjs`（第 1 次） | **FAIL**：測試自身 bug（`const` TDZ：regex 常數宣告在隔離區塊之後）→ 已修 |
| 4 | 同上（第 2 次） | **FAIL**（5 fail）：測試自身 bug（recording fetch 未處理 GitHub 302，導致 checksums 未記錄；`code_grep` 在文件索引尚未就緒時抓 docs）→ 已修 |
| 5 | 同上（第 3 次） | **FAIL**（1 fail）：測試自身 bug（M6 的 `copyFile` 傳入 install record 而非 binary 路徑）→ 已修 |
| 6 | 同上（第 4 次，最終） | **PASS**：10 tests / 10 pass / 0 fail / 0 skip，42,017 ms |
| 7 | `node --test test/binary-manager.test.mjs` | 40 tests / 40 pass / 0 fail（加入 swap 後回收修復前）；修復後 41 tests / 41 pass / 0 fail |
| 8 | `npm test` | **432 tests / 422 pass / 10 skipped / 0 fail**，58,010 ms（10 skipped ＝ managed gate 未啟用） |
| 8.1 | 同上，最終程式版本（`npm run verify` 內） | **432 tests / 422 pass / 10 skipped / 0 fail**，38,092 ms。這 422 個 pass **包含**兩個真實外部整合檔（`integration.test.mjs`、`integration-legacy.test.mjs` 以機器上的 BaseMind 0.34.0 實跑）；10 個 skip 正好是 gated 的 managed 套件 |
| 9 | `npm run check` | `syntax ok: 20 files`、`bundle manifest ok` |
| 10 | `npm run check:skills` | `skills check ok: 10 skills, 20 files match skills/UPSTREAM.json (v0.34.0)` |
| 11 | `npm run check:pack` | `pack contents ok: 52 files`（`pack.json` 已刪除） |
| 12 | `npm run verify` | 見 §15.1（最終 Gate，於文件完成後重跑） |
| 13 | `npm pack --pack-destination %TEMP%\bmpack` ＋ `tar -tzf` | 52 files／142,425 bytes／10 skills；無禁止項目（D1） |
| 14 | `dsh --profile bmweb --from-default-profile web --dump-config` | exit 0；profile 由 shipped web 模板建立 |
| 15 | `dsh plugin --profile bmweb add <tarball> --save-exact` | `+ dsh-basemind-plugin 0.2.0`，pnpm 432 ms |
| 16 | `dsh --profile bmweb --dump-config` | exit 0；`- id: dsh-basemind` 出現在 dump 的 `dsh-basemind-plugin` 段落，`config.serverName=basemind`、`binaryDownload=true`、無 `disabled`（以 `Select-String -Context 0,4` 定位，未記行號） |
| 17 | `dsh --version` | `0.2.2-rc.5` |
| 18 | `node --test test/workflows.test.mjs`（Review round 1 後新增） | **9 tests / 9 pass / 0 fail**（含兩次先失敗後修正的迭代：`actions/cache` 誤匹配註解、跨行註解的正則） |
| 19 | `node --test test/binary-manager.test.mjs`（swap 後回收修復後） | **41 tests / 41 pass / 0 fail** |
| 20 | PyYAML `yaml.safe_load` 解析 4 個 workflow（唯讀） | 全部通過；jobs 分別為 `['test']`、`['compat']`、`['plan','managed']`、`['managed-gate','release']` |

### 15.1 `npm run verify` 最終結果

在程式碼與文件全部定稿後執行（工作目錄 `D:\02_zengjunlin\github\dsh-basemind-plugin`，Node v24.20.0）：

| 子步驟 | 結果 |
| --- | --- |
| `node scripts/check-syntax.mjs` | `syntax ok: 20 files` |
| `node scripts/check-manifest.mjs` | `bundle manifest ok` |
| `npm run check:pack` | `pack contents ok: 52 files`（執行後已刪除 `pack.json`） |
| `npm test` | **432 tests / 422 pass / 10 skipped / 0 fail**，`duration_ms 38092.07` |

`npm run verify` 退出碼 **0**（Review round 1 之前的程式版本）。Review round 1 修正後重跑：

| 命令 | 結果 |
| --- | --- |
| `node --test test/workflows.test.mjs` | **9 tests / 9 pass / 0 fail** |
| `node --test test/binary-manager.test.mjs` | **41 tests / 41 pass / 0 fail**（含 swap 後回收的新案例） |
| `node --test test/integration-managed.test.mjs`（無 gate） | 10 skipped / 0 pass，skip 訊息正確；repo 與網路皆無副作用 |
| `npm run check` | `syntax ok: 20 files`、`bundle manifest ok` |
| PyYAML 解析 4 個 workflow | 全部通過（jobs：`['test']`／`['compat']`／`['plan','managed']`／`['managed-gate','release']`） |
| `npm test`（修正後完整套件） | **442 tests / 432 pass / 10 skipped / 0 fail**，`duration_ms 55502.42`；新增的 10 個測試為 `test/workflows.test.mjs` 9 個 ＋ `binary-manager` 的 swap 後回收案例 |
| `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1 node --test --test-reporter=spec test/integration-managed.test.mjs` | 見下方最終表格 |

managed gate 的完整執行紀錄（同一台機器）：

| 執行 | 結果 |
| --- | --- |
| Review round 1 之前（第 1 次） | **10/10 pass**，39,785 ms；冷安裝 13,506 ms、暖選型 77 ms、修復 2,607 ms、layout-1 替換 2,536 ms、race 2,013 ms、MCP 16,342 ms、CLI 1,193 ms |
| Review round 1 之前（第 2 次） | **10/10 pass**，84,201 ms；冷安裝 55,713 ms、暖選型 64 ms、MCP 18,459 ms、CLI 1,143 ms |
| 修正後（第 3 次，R11 之前） | **9/10**，MCP 測試失敗：`indexing` 就緒判定錯誤（見 §14.4 R11），150 s 後失敗並印出實際 payload |
| 修正後（第 4 次，最終） | **10/10 pass**，66,708 ms；冷安裝 41,652 ms、暖選型 65 ms、修復 1,991 ms、layout-1 替換 2,107 ms、cross-process race 1,848 ms（1 次下載）、CLI 1,104 ms（status 869／doctor 80／overview 71／explain 82 ms） |

---

## 16. 未執行測試及原因

| 未執行項 | 原因 |
| --- | --- |
| `managed-binary.yml` 三平台遠端執行 | 本環境無 GitHub Actions 觸發授權（無 `WORKFLOW` token／`gh` 認證）；不得代替人工觸發 |
| `compat.yml`（含新的 arm64 列與排程）遠端執行 | 同上 |
| `ci.yml` / `release.yml` 遠端執行 | 同上；本階段也不允許觸發發布流程 |
| Ubuntu 本機驗證 | 本機只有 Windows；POSIX 分支（`chmod`、tar `0755`、POSIX preflight）需 Ubuntu runner |
| macOS arm64 managed 安裝 | 同上（無 macOS 機器） |
| Linux x64 managed 安裝 | 同上（無 Linux 機器／WSL 未使用） |
| D6–D15 Desktop 驗收 | 需真實 Agent 與模型額度（未授權）＋ Desktop app 固定使用 `~/.dsh`（禁止改生產 profile） |
| `code_search` 語意搜尋、`docs_search` 文件管線、OCR／HEIF 影像解析功能驗證 | 需要額外模型／大型資源，prompt §12 明確允許排除並記錄限制 |
| Phase 3（Compaction、A/B Token 效果） | 不屬本階段 Scope |

---

## 17. 已知風險及環境限制

1. **遠端 CI 未取證**：`managed-binary.yml` 從未在 GitHub 上跑過。任何 `${{ }}` 運算式、bash 片段或 runner 差異都可能讓它在第一次執行時失敗。這是 0.2.0 發布前最大的未驗證風險。
2. **Linux arm64 runner 可用性未知**：`ubuntu-24.04-arm` 在本 repo 是否可排程未驗證，因此 `managed-binary.yml` 把它做成**真正的** `include_linux_arm64` opt-in（plan job 產生 matrix），`compat.yml` 則完全不排它。若 label 不可用，只有明確 opt-in 的 run 會卡住，release gate 與每週排程不受影響。
3. **冷安裝耗時差異**：本機量到 13.5 s、25.0 s、29.6 s、55.7 s（下載速度主導）。workflow 給 60 分鐘 job 上限、測試內冷安裝 600 s，都只是上界而非效能門檻。
4. **M5b／M6／M7 的「replay」性質**：這三個場景的**網路傳輸**用同一輪真實下載取得的官方 bytes 重放（產品仍做真實 SHA256／解壓／安裝／probe）。這是 prompt 明確允許的降本做法，但報告中已標明「不是第二次真實網路下載」；M1 另以 `node:crypto` 獨立 hash archive 與安裝後 binary（§14.4 R9）。
5. **Windows rename 真實佔用**：安裝 swap 的 `EBUSY` 重試只以注入式測試覆蓋，未在真實檔案被其他行程鎖住時驗證。
6. **`doctor` 的 exit code 可能因環境而異**：測試對 `doctor` 只要求「有輸出且不是動態庫載入失敗」，不強制 exit 0，以避免把環境噪音誤判成產品缺陷；`status` 則要求 exit 0。
7. **docs 的 grep 時序**：以 MCP 呼叫 `code_grep` 搜尋 markdown 文件時，document 管線可能比 code 索引晚就緒；因此 gate 用 code 檔案 pattern（`src/math.js`）作為必要斷言，避免把索引暖機時序當作產品缺陷。文件搜尋本身不列入 gate。
8. **Desktop 未驗**：D3–D15 完全沒有實機證據；`/basemind-status` 在 Desktop GUI 中的實際顯示、skills catalog 的實際註冊情形都**未驗證**。
9. **先前的「未定位偶發失敗」已定位到機制（強證據，原始 log 未保留）**：Review round 1 之後重跑 managed gate 時，實測到 0.34.0 的 `index_status` 有兩個容易誤判的形狀——(a) 建索引中可能回 `structuredContent: {}` 而文字區塊才是完整 payload；(b) **就緒後的 payload 不再帶 `indexing` 欄位**（只有建索引中才有 `"indexing": true`）。舊的 `ensureIndexed()` 一旦拿到「沒有 `indexing: true`」的 payload 就立刻返回，所以拿到 (a) 的空物件時會誤判為就緒，後續 `code_*` 才以 “index is empty” 失敗——正好對應先前那次失敗的形狀。測試現在改為：優先採用能描述 workspace 的來源（structuredContent 或文字），只有 `root` 是字串且 `indexing !== true` 才視為就緒；10 秒內從未取得可辨識 payload 就 `assert.fail` 並印出原文（不會再偽裝成「root 是 undefined」）。
10. **Known debt（既有、非本次回歸，另立清理項）**：
    - `test/integration-managed.test.mjs` 與 `test/integration.test.mjs` 有重複的 helper（subprocess adapter、`statusPayload`、`ensureIndexed`、`stopTestDaemon`）與另一份 child fixture。本輪刻意不改動已穩定的既有整合檔（理由見 §14.4 末段）。
    - `release.yml` 的「Install a real BaseMind for the integration gate」步驟仍以硬編碼的 Linux triple 組 asset 名稱（版本本身取自 `lib/upstream.js`）；`compat.yml` 的 `basemind_version` 說明仍以 `0.33.0` 為例。兩者皆為既有內容，未在本次改動範圍。
    - `lib/binary/manager.js` 既有的 `lockIsStale()` 對缺少 `owner.json` 的 lock 回 false（stale lock 可能卡住），以及未取鎖的 `recoverParkedTrees()` 先查 lock 再 readdir 的 TOCTOU。與本次 diff 無關，未修。
    - `managedCacheComplete()`（sync，status／回收用）與 `readManagedCache()` 的 pre-probe stat gate（async，selection 用）仍是兩段等價實作；本輪只收斂了語意與註解，未抽共用函式（會動到 selection 的錯誤路徑與 `invalidateCache()` 行為）。已知風險：未來只改一邊會再現同类分叉。
11. **arm64 的契約證據缺口**：移除 compat 的無條件 arm64 列後，Linux arm64 目前**沒有任何**已排程的自動證據，只能靠人工 opt-in 的 managed run。這是刻意的取捨（避免排不到的 label 卡住排程），但必須在 release note 標明。

---

## 18. 與原 Plan 的偏差

| # | Plan 內容 | 實際做法 | 理由與影響 |
| --- | --- | --- | --- |
| 1 | §10.5 允許用 `BASEMIND_RELEASE_BASE_URL` 指向鏡像 | **未實作**該環境變數；改用「同一輪真實下載的官方 bytes 重放」作為修復場景的傳輸 | 不新增產品 API／設定；重放仍是官方 bytes 且產品仍做真實校驗，證據強度不變。若未來需要鏡像，應另立需求 |
| 2 | §10.3 場景 A–G 編號 | 實作為 M1–M7（語意對應），M5 拆成 A／B 兩個測試（拒絕 vs 修復） | 斷言更精確；數量與內容等價 |
| 3 | §10.4 清單包含 `code_search`／`docs` 相關驗證 | 只驗證工具存在，未驗證語意／文件檢索能力 | 需額外模型／資源；已依 prompt §12 記錄為未驗證 |
| 4 | §11.1 Linux arm64 在「有可用 runner 時納入」 | 做成 `managed-binary.yml` 的 `include_linux_arm64` 輸入（預設 false），matrix 由 `plan` job 產生；`compat.yml` **不**排 arm64 | Review round 1 證實 job 層 `if` 讀不到 `matrix`，原設計的 opt-in 恆為 true；改以 plan job 實現真正 opt-in，並避免未確認的 label 卡住排程／release gate。矩陣與文件維持 NOT RUN |
| 5 | §11.4 建議在 `ci.yml` 用 `--test-reporter` 產生摘要 | 以 `npm test -- <reporter…>` 實作（不複製 `npm test` 的指令內容），並保留 stdout 的 `spec` reporter | `npm test` 仍是唯一來源；Review round 1 Minor 2 |
| 6 | §12.2 要求「獨立測試 profile」 | 以獨立 `DSH_HOME` ＋ shipped web 模板 profile 實測 profile 組裝；Desktop GUI 未動 | Desktop app 固定 `~/.dsh`，無授權不得改生產 profile |
| 7 | Plan §22 測試矩陣要求 `test/index.test.mjs` 等全綠 | 已全綠（432 tests；另新增 `test/workflows.test.mjs` 9 項、`binary-manager` 41 項） | 無偏差 |
| 8 | Phase 2 預估「2–3 個工作日，主要成本是 CI 迭代」 | 本環境無法迭代遠端 CI，改為本機真實安裝 ＋ Workflow 靜態驗證 ＋ 靜態回歸測試 | 遠端迭代需求仍存在，列為交付後人工項 |
| 9 | Plan §1.3／§20 建議發布 **0.3.0** | 依人工裁決，**目標發布版本與正式發佈版本均為 0.2.0**（現為開發版本，尚未正式發佈）；本次未 bump 版本、未建 tag、未發布 | 本文書名與「發布阻擋」標籤一律使用 0.2.0；Plan 本文的「0.3.0」屬歷史建議，已於 Plan 檔頭加註更正 |
| 10 | 未規劃「CI 靜態回歸測試」 | 新增 `test/workflows.test.mjs`（零依賴、純文字解析 workflow） | Review round 1 的兩個 Critical 都是「YAML 看起來對、GitHub 語意錯」，一次 review 無法防再犯；靜態測試成本極低 |
| 11 | 未規劃 `installPinned()` swap 後回收 parked tree | 安裝成功後（鎖內）再呼叫 `recoverParkedTrees({locked:true})` | 縮短「已修復但仍多佔一份 230–322 MB 到下一個 DSH 程序」的窗口；`test/binary-manager.test.mjs` 有對應案例 |

---

## 19. Phase 2 驗收 Checklist

- [x] 真實 Managed Binary Integration Test 已建立（`test/integration-managed.test.mjs`）
- [x] 強制 Managed Integration Gate 已建立（`BASEMIND_REQUIRE_MANAGED_INTEGRATION=1`，未設定時明確 skip）
- [x] 真實 Cold Cache 安裝通過（Windows x64，13,506 ms／75,627,742 bytes；同版本另三次 24,969／29,646／55,713 ms）
- [x] Warm Cache 離線重用通過（57 ms，0 次網路）
- [x] Local First 零下載驗證通過（`source==='env'`，0 次網路）
- [x] 不相容 Binary fallback 驗證通過（受控 0.33.0 fixture → managed）
- [x] 缺失依賴文件的快取恢復驗證通過（`heif.dll` 移除 → 拒絕 → 修復）
- [x] Layout 1 遷移回歸驗證通過（拒絕 + 完整替換）
- [x] 真實 Managed MCP 功能通過（initialize／18 tools／6 個 verb tool／3 個 resource 方法／structuredContent／關閉）
- [x] 真實 Managed CLI 功能通過（status／doctor／overview／code explain／allowlist／取消）
- [x] MCP / CLI Binary 一致性驗證通過
- [x] Managed Binary 跨平台 Workflow 已建立（`managed-binary.yml`，含 `test/workflows.test.mjs` 的 9 項靜態契約）
- [ ] Windows x64 真實整合測試通過 — **本機 PASS**；「遠端 CI」未跑（本項以本機證據視為部分完成）
- [ ] Linux x64 真實整合測試通過 — **NOT RUN**
- [ ] macOS arm64 真實整合測試通過 — **NOT RUN**
- [ ] Linux arm64 已驗證或明確記錄環境限制 — 已記錄限制（NOT RUN，opt-in）
- [x] 普通 CI 回歸通過（`npm test` 432 tests／0 fail）
- [x] Skills / Pack / Manifest Gate 通過
- [ ] DSH Desktop D1–D15 驗收完成 — D1 PASS、D2 組裝層 PASS、D3–D15 NOT RUN；已列明人工待驗收項目
- [x] 未污染用戶真實 DSH / BaseMind 環境（desktop profile 仍為 0.1.6；所有動作在 `%TEMP%`）
- [x] 未擴大至 Deferred 功能（未新增命令／通知／Inbox／UI）
- [x] Phase 2 Execution Report 已完成（本文件）

---

## 20. Phase 3 交接事項

1. **先補三平台證據**（發布阻擋）：人工 `workflow_dispatch` `.github/workflows/managed-binary.yml`（必要時勾 `include_linux_arm64`），把 run URL／Step Summary／失敗 artifact 追加到本報告 §10.5 與 §11 矩陣。只有那之後才能把 Windows／Linux／macOS 的 managed 項標成 PASS。
2. **Desktop D3–D15**：依 [人工驗收清單](./2026-11-24-basemind-desktop-acceptance-checklist.md) 在獨立 `DSH_HOME` 執行；D6／D9／D10／D11 為發布阻擋項。
3. **Compaction／Bootstrap 9 項與 A/B 效果測試**（Plan §13、§14）尚未開始；本輪未做任何相關改動，Phase 2 的 MCP／skills 行為可作為其基線。
4. **`code_search`／`docs_search` 能力驗證**需要能在 CI 提供小型模型的方案；在此之前保持「未驗證」標記，不要寫成通過。
5. **可考慮的後續最小工作**（需另立授權）：`lib/binary/probe.js` 的 spawn env 契約（§14.4 第一項）、以及 `firstBrokenFile` 是否要對 `lib/*` 做內容 hash。兩者都不應在 Phase 3 之前順手改。
6. **升版流程**：`docs/upstream-sync.md` 已加入 managed gate；任何 pin 變更都要重跑 `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1` 並重取三平台證據。

---

## 21. 交付狀態（未提交）

```
 M .github/workflows/ci.yml
 M .github/workflows/compat.yml
 M .github/workflows/release.yml
 M CHANGELOG.md
 M README.md
 M README.zh.md
 M lib/binary/manager.js
 M test/binary-manager.test.mjs
 M docs/2026-11-24-basemind-stability-phase1-execution-report.md
 M docs/2026-11-24-basemind-stability-feature-parity-plan.md
 M docs/upstream-sync.md
?? .github/workflows/managed-binary.yml
?? fixtures/managed-real-select.mjs
?? test/integration-managed.test.mjs
?? docs/2026-11-24-basemind-desktop-acceptance-checklist.md
?? docs/2026-11-24-basemind-stability-phase2-execution-report.md
```

- 未執行 `git add`（含 `git update-index`）、`git commit`、`git push`、`git tag`、`npm version`、`npm publish`、任何 release script。
- 未修改生產 DSH profile、使用者 BaseMind data home、系統 `PATH` 或任何全域設定。
- 暫存目錄（`%TEMP%\dsh-accept`、`%TEMP%\bmpack`、`%TEMP%\bmdiag`、`%TEMP%\bmgrep`、`%TEMP%\pin-resolve.mjs`、`%TEMP%\unused.mjs` 與 managed 測試自建的 `basemind-managed-*`）已於驗收後刪除；`pack.json` 未留在 repo。
