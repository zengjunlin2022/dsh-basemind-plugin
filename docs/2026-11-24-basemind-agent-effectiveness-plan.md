# dsh-basemind-plugin — Phase 3：Agent Effectiveness 實施計畫

- 日期：2026-11-24（Asia/Taipei / Etc/GMT-8）
- 角色：Investigation + Planning（已完成；**未修改任何產品程式碼**）
- 狀態：**2026-11-24 第二輪確認：GitHub=C1、Harness=Hybrid、Budget=12M/no-reuse、全自動執行；本文件是 Execution Agent 的執行依據（交接見 §30）**
- 插件版本：`0.2.0`（`package.json` 未變更；本階段不 bump、不 publish、不 tag）
- BaseMind 目標版本：`0.34.0`（唯一來源 [lib/upstream.js](../lib/upstream.js)）
- DSH 實測版本：`0.2.2-rc.5`（`dsh --version`；`engines.dsh` 範圍 `>=0.2.1-rc.3 <0.3.0-0`）
- 停點：Planning 已完成。Execution Agent 依 §30 全自動執行 Phase 0→D1a→3A→3B→3C→3D→3E；只在 PR merge、gate 失敗、預算上限（12M）、`GH_TOKEN` 不可見或 repo 指紋變動時停下回報；最終 diff 仍由人工 Review，不自動 commit／merge。

### 證據等級標記（全文通用）

| 標記 | 意義 |
| --- | --- |
| **A（源碼直證）** | 直接來自本 repo 或已安裝 DSH runtime 的原始碼／設定，附檔案與行號 |
| **B（實測）** | 本次調查實際執行命令取得的輸出（含日期與命令） |
| **C（推論）** | 由 A/B 證據導出，尚未以真實 Agent 或實跑驗證 |
| **D（未驗證）** | 尚無充分證據；不得在後續當成已知事實 |

---

## 1. Executive Summary

### 1.1 結論先行

1. **Phase 1／Phase 2 的程式與本機證據成立，但 Phase 2 的交付尚未完整**：HEAD `bba170c` 的 `CI` 綠燈、本機 `npm test` 442 測試（432 pass / 10 skip / 0 fail）成立；但**最新 `managed-binary.yml` 從未真正執行**——GitHub 在 2026-11-24T10:17:43Z 以 `Invalid workflow file ... (Line: 88, Col: 32): Unrecognized named-value: 'runner'` 直接拒絕（run `45373407690`），這是 Phase 2「Managed Binary Integration Gate」的實質缺口（A+B）。
2. **Skills 契約正確，Catalog 成本可控**：10 個官方 skills 與 BaseMind `0.34.0` 同源（tag `v0.34.0`、commit `8e7b149`），DSH `registerProvider()` 契約完整；模型只看到 **name + description**（依實際 descriptions 與 DSH catalog 格式計算 ≈ 4,177 字元，約 1.0k 估算 token），正文只在 `get()`／`skill` 工具／使用者 `/skill-name` 手勢時載入（A）。
3. **不需要 Compaction Hook**：DSH 的 system prompt 每個 model step 重新 `assemble()`，`system/message` 位於 surface node 0 **永不進入壓縮範圍**；skills catalog 是 DSH 自行維護的 `user/message`（`source.kind='skill-catalog'`），被壓縮隱藏後下一次 `agent/pre-step` 會自動重發。Pi 的 `session_compact → 重注入` 機制在 DSH 沒有對應需求（A）。
4. **Readiness 存在一個真實的程式缺口，但尚未重現**：Relay 意外退出時 `onClose` 只寫 log（[index.js:173-177](../index.js#L173-L177)），Workspace Pool 不會移除已死 session（[lib/workspace-pool.js:139-181](../lib/workspace-pool.js#L139-L181)），`readiness.ready` 也不會翻回 false；primary relay 死亡後同一個 process 內**沒有任何自動恢復路徑**。這是本階段唯一可能修改 Runtime 的候選（C，需 3B 重現）。
5. **Bootstrap 內容大致正確，只有一處與 Windows 事實不符**：`Standard Preset` 在 Windows 使用 `pwsh`（shipped config：`tool-bash` `disabled: platform === 'win32'`、`tool-pwsh` 反之），而 bootstrap 寫「read/grep/glob/bash」。其餘（CLI-only 動詞、fallback、workspace 語義、skills 按需載入）與 MCP instructions 無明顯重疊（A）。
6. **上游能力邊界必須寫進 Benchmark 設計**：BaseMind `v0.34.0` **沒有 Vue/SFC 專屬支援**（`src/queries/` 無 `vue.scm`，`.vue` 只能落到 TSLP 通用 grammar），因此 Vue SFC 的 `code_outline`／`code_symbols`／`code_refs` 預期沒有結構化結果；Java 符號抽取完整，但 **method reference（`::`）不產生 call site、static import 不跨檔解析、source roots 固定**；`git_diff` **沒有 `git diff --cached` 語義**，只審 staged 變更必須用原生 Git（A）。
7. **Benchmark 可以設計得又小又準**：以「同 commit、同 binary、同索引、同 prompt、同模型」的 同 build config 對照（A：`skills:false, bootstrap:false, cliTool:false`；B：預設），先跑 12 次 Pilot（3 任務 × 2 組 × 2 模型），確認流程與 usage 可取得後，再決定是否擴到 24 次。Pilot 與完整測試的估算 Token 預算見 §18。

### 1.2 本階段建議的最小實施範圍

- **必須做（前置依賴，不屬於 Phase 3 功能；D1=C1 已授權：遠端 commit＋PR，不 merge）**：修好 `.github/workflows/managed-binary.yml` 的 job-level `runner.temp`；否則 release 的 `managed-gate` 永遠不會通過（A+B）。
- **Phase 3A（Investigation）**：以獨立測試 Profile（`bm-bench-a`／`bm-bench-b`）做真實 Desktop/Web 會話、Session Resume、`/compact`、Relay 終止、Subagent 可見性與 Prompt/Usage 取證。
- **Phase 3B（Deterministic）**：只補缺失測試與**已重現**的 Runtime 缺陷修復；若 F1 重現，採最小修復（移除死 session + primary 重初始化）；若未重現，不動 Runtime。
- **Phase 3C／3D（Benchmark）**：Pilot 需人工授權模型消耗；完成後才決定完整 24 次與 GPT/DeepSeek、Vue/Java 的分組結論。
- **Phase 3E（Final）**：回歸、Desktop 驗收補完、Execution Report、等待 Review。

### 1.3 明確不在本階段修改的項目

- 不新增/修改 Persona、Agent Preset、使用者 YAML。
- 不新增 MCP row、不新增常駐服務、不新增 runtime dependency。
- 不實作 Binary 異常原生通知、官方 `/bm-*` 快捷命令、Agent Identity／Inbox（見 §5）。
- 不做 Claude Code 式 PreToolUse Guard、不強制 BaseMind 路由、不禁止原生工具。
- 不重寫 Workspace Pool／Binary Manager／MCP Bridge／Skills Provider。
- 不修改 `cordis.patch.yml` 的既有預設（`binaryDownload: true` 保持）。

### 1.4 已確認決策（2026-11-24 人工審核）

- **測試專案授權**：Vue 用 `C:\01_aw_github\transmac-oms-fe`，Java 用 `D:\02_zengjunlin\github\transmac-oms`；**全程唯讀，不修改程式碼、不 commit、不切 branch、不建 worktree、不執行 build／format／install**。
- **2026-11-24 第二輪確認**：GitHub=**C1**（遠端 commit 到 `phase3/d1-managed-workflow-fix`＋PR，不 merge）；Harness=**Hybrid**（3A 用 Web API，Benchmark 用 Headless 但需先過等價性檢查）；Budget=**12M／no-reuse**（Pilot 12＋完整 24 新跑＝36 次）；全自動執行，機器 gate 取代 3A／3B 人手停點。
- **D1–D19 已全部定案**：D12 改為 **12M／no-reuse**；D18 批准完整 24 次；D17 保留 repo 指引；D19 由 3A-1 probe 凍結；D1 以 C1 遠端 commit 執行。
- **執行狀態**：本文件已定稿並交由 Execution Agent；**尚未執行**。**Gate 0 已驗證**：Windows User 環境的 `GH_TOKEN` 可讀、`GET /repos` 200；但 `ops_bash` process env 仍 stale，harness 依 §30.5 從 User 變數讀取（不輸出）。
- **交接**：Execution Agent 從 §30 開始，全自動跑到 3E；機器 gate 見 §30.7；最終停在 PR／dispatch／報告，等人 Review。
- 目前唯一變更仍是本計畫文件；產品程式碼、Desktop Profile、兩個業務 repo 都未變更。

---

## 2. 最新 HEAD 與工作區狀態（B）

| 項目 | 實測值 | 命令 |
| --- | --- | --- |
| HEAD | `bba170cdaf7329214d7146d2d0636e2b39199be4` | `git rev-parse HEAD` |
| 分支 | `main`，與 `origin/main` 同步、無 ahead/behind | `git status -sb` |
| 工作區 | 乾淨（`git status --porcelain` 無輸出） | 同上 |
| 最近 commit | `bba170c feat(ci): 添加托管二进制集成测试套件与CI门控`（2026-11-24） | `git log -1` |
| 最新 tag | `v0.1.6`（無 `v0.2.0`） | `git tag --list` |
| 插件版本 | `0.2.0`（未發布；Desktop Profile 目前安裝 `0.1.6`） | `package.json`、profile `package.json` |
| BaseMind（本機 PATH） | `0.34.0`，`C:\Users\sanny\AppData\Local\Programs\basemind\basemind.exe` | `basemind --version` |
| BaseMind（pin） | `0.34.0`／`v0.34.0`／`8e7b149` | [lib/upstream.js](../lib/upstream.js) |
| Node | `v24.20.0` | `node --version` |
| DSH | `0.2.2-rc.5` | `dsh --version` |

### 2.1 已授權的測試 Repository（B）

| 用途 | 路徑 | HEAD | 分支 | 工作區 | 規模 |
| --- | --- | --- | --- | --- | --- |
| Vue 3 | `C:\01_aw_github\transmac-oms-fe` | `f9fd1a63b43a` | `dev_v73_推薦車長修改` | 乾淨（`git status` 空；SHA256 `e3b0c442…`） | 2,889 tracked；`src/**/*.vue` 348 個；`vue 3.5.38`、`element-plus 2.14.2` |
| Java | `D:\02_zengjunlin\github\transmac-oms` | `f6f2988d74cf` | `dev_v72_澳琴聯乘` | **1 個 untracked**：`docs/2026-11-04-Timefold…-report.md`（status SHA256 `52176b2a…`） | 7,705 tracked；`.java` 5,334；Maven 多模組（root＋`driverServApi`／`common`／`bi-diagnosis`／`collect-aw`） |
| Synthetic | `$TEMP/bm-staged`（3C 建立） | — | — | 全新 | 3–5 檔，只供 B5 |

- 兩個 repo 都有 `AGENTS.md` 與 `AGENTS.local.md`；後者由 `basemind init` 產生，含「prefer basemind over grep/read/git」與 `/bm-init` 等字樣。Vue repo 另有未追蹤的 `basemind.toml`（scan excludes）。
- 檔案 SHA256：Vue `AGENTS.md` `65b8fb50…`、`AGENTS.local.md` `3777a55f…`、`basemind.toml` `6b127da9…`；Java `AGENTS.md` `f469ff0c…`、`AGENTS.local.md` `52ee7505…`。
- 這些檔案會被 DSH 當專案指示載入；A/B 兩組相同，但屬已知混淆因子（見 §16.4、D17）。
- **唯讀授權**：不修改、不新增、不刪除、不 commit；前後比對 `git status` fingerprint（P3-25）。

---

## 3. Phase 1、Phase 2 實際完成證據與未完成項

### 3.1 Phase 1（Stability）— 已完成並已 commit（`6375ebd`）

| # | 完成項 | 證據 |
| --- | --- | --- |
| 1 | CI fixture 修復：`fixtures/fake-basemind.sh` git mode `100755`；`test/index.test.mjs` 就地執行 + POSIX preflight | [Phase 1 Execution Report](./2026-11-24-basemind-stability-phase1-execution-report.md) §2.1、本機 `npm test` 全綠（B） |
| 2 | `lib/binary/archive.js` 的 `extractArchive()`：整棵 release tree、路徑邊界、mode、size 驗證 | 同上 §2.2；`test/binary-archive.test.mjs` |
| 3 | `lib/binary/manager.js`：layout 2、原子 swap、`install.json` 檔案清單、`recoverParkedTrees()`、`binarySha256` 分離 | 同上 §2.2、§8；`test/binary-install-layout.test.mjs` |
| 4 | `lib/status.js`：cache layout／檔案數／missing file | 同上 §2.3 |
| 5 | 真實 Windows 冷安裝 75,627,742 bytes（13,068 ms）、暖快取 39 ms、0 網路 | 同上 §3、§3.1 |
| 4 | Review／Re-Review 結論：2 Important（F1/F2）皆 ADDRESSED，0 Critical；3 Minor 不阻塞 | [Phase 1 Review](./2026-11-24-basemind-stability-phase1-review.md)、[Re-Review](./2026-11-24-basemind-stability-phase1-rereview.md) |

**未完成（Phase 1 遺留，非本階段阻擋）**：POSIX 模式／preflight 只在 Linux/macOS 執行；完整性僅以 stat 檢查（同大小損壞不會被抓）。

**本次補齊的證據（B）**：HEAD `bba170c` 的 `CI` run `45373410429` 兩個 job 皆 success——`test (ubuntu-latest, node 24.20.0)` 與 `test (windows-latest, node 24.20.0)`。Phase 1 報告當時缺少的 Ubuntu 綠燈 URL 自此補上；這**不**代表 managed 安裝或 `compat.yml` 已驗證（見 §3.3）。

### 3.2 Phase 2（Integration & Compatibility）— 已完成並已 commit（`bba170c`）

| # | 完成項 | 證據 |
| --- | --- | --- |
| 1 | `test/integration-managed.test.mjs`（1,864 行）：真實下載、SHA256、整樹安裝、真實 MCP relay（15 verb + 3 agent tools）、resources、CLI adapter、暖快取 0 網路、同/跨進程只裝一次 | [Phase 2 Execution Report](./2026-11-24-basemind-stability-phase2-execution-report.md) §7–§8、§12 |
| 2 | Gate 契約 `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1`（未設時 10 tests skip，設後失敗即 fail） | 同上 §7.1、§15 |
| 3 | Windows x64 實跑 10/10 PASS（66,708 ms）；冷安裝 13.5–55.7 s；MCP 8.2 s；CLI 1.1 s | 同上 §8、§15.1 |
| 4 | `managed-binary.yml`（230 行）、`ci.yml` 失敗摘要 artifact、`compat.yml` 每週排程、`release.yml` 的 `managed-gate` | 同上 §10 |
| 5 | `test/workflows.test.mjs`（9 項靜態契約） | 同上 §15 |
| 6 | 回歸：`npm run check`（20 files）、`check:skills`（10 skills/20 files）、`check:pack`（52 files）、`npm test` 442（432 pass/10 skip/0 fail） | 同上 §15；**本次重跑**：`npm test` 442/432/10/0（27.3 s）、`npm run check` `syntax ok: 20 files`＋`bundle manifest ok`、`npm run check:skills` `10 skills, 20 files match ... (v0.34.0)`（B；`check:pack` 未重跑，因會覆寫根目錄 `pack.json`） |
| 7 | Desktop D1 打包 PASS（142,425 B、52 檔、10 skills）；D2 profile 組裝 PASS | [Desktop Acceptance Checklist](./2026-11-24-basemind-desktop-acceptance-checklist.md) §2 |

### 3.3 Phase 2 尚未完成／本次新發現的阻擋（必須列為 Phase 3 前置依賴）

| # | 項目 | 現況與證據 | 判定 |
| --- | --- | --- | --- |
| G1 | **`managed-binary.yml` 從未執行** | GitHub run `45373407690`（`bba170c`，2026-11-24T10:17:43Z）：`conclusion=failure`、`jobs.total_count=0`；HTML 註解：`Invalid workflow file: .github/workflows/managed-binary.yml#L1 (Line: 88, Col: 32): Unrecognized named-value: 'runner'`。根因：`MANAGED_DIAGNOSTICS_DIR: ${{ runner.temp }}/...` 位於 **job-level `env:`**，而 GitHub 不允許 job env 使用 `runner` context（A+B） | **P0 前置：D1=C1 已授權（PR，不 merge）** |
| G2 | Desktop D3–D15 | 全部 **NOT RUN**（D6/D9/D10/D11 是 0.2.0 發布阻擋） | Phase 3A 補做（測試 Profile） |
| G3 | 跨平台 managed／compat 遠端證據 | Linux x64／macOS arm64／Linux arm64、`compat.yml` 三平台皆 **NOT RUN** | 需人工安排 runner，Phase 3 不重複下載 75–102 MB |
| G4 | 文件不一致 | README 兩語言稱 DSH 已驗證 `0.2.1-rc.5`，實際安裝為 `0.2.2-rc.5`；README 測試數字 432/422/10 與最終 442/432/10 不同；`README.zh.md` §15 有整段重複 | 文件修正，Phase 3E 一併處理 |
| G5 | Phase 2 Review／Scoped Re-Review | `docs/` **不存在** Phase 2 Review 檔案 | 由人工決定是否需要獨立 Review |

> 注意：G1 的修復本身不在 Phase 3 的 Agent Effectiveness scope 內，但它是「最新 GitHub Actions 結果」與 Release Readiness 的必要條件；本計畫將其列為 **前置依賴 P0**，需另取得人工授權後以最小 diff 修復（見 §21 F3）。

---

## 4. Phase 3 Scope

本階段只驗證並完善「Agent 使用 BaseMind 的實際效果」，不新增 BaseMind 功能。對應需求 Task A–I：

| Task | 內容 | 本計畫段落 |
| --- | --- | --- |
| A | Skills 完整性、Discovery、Progressive Disclosure、實際選擇效果 | §6–§8、§17、§23（3A/3C） |
| B | Bootstrap 與 Prompt 效果、Token／Cache | §6–§9 |
| C | Session 恢復、Context Compaction（含連續 Compaction） | §10–§11 |
| D | Relay Readiness 與異常恢復（R1–R5） | §12 |
| E | 多 Session、Subagent、工作區切換 | §13 |
| F | GPT／DeepSeek A/B Benchmark（設計、授權、成本） | §14–§18 |
| G | 指標與評估標準（正確性、Tool、Token、時間） | §19–§20 |
| H | Vue／Java 上游能力邊界與問題分類 | §16–§17 |
| I | 最小必要 Runtime 修復（只有實證缺陷才修） | §21 |

### 4.1 成功的最低標準（不預設虛構的節省百分比）

1. 不出現插件造成的關鍵正確性退化（B 組不得在任一任務由 PASS 退為 FAIL）。
2. 不出現跨 Session／跨工作區污染。
3. 官方 10 個 Skills 在真實 Agent 中可被發現、可按需載入正文。
4. Compaction 後工具、Skills、Bootstrap 引導仍存在，且不重複累積。
5. 不出現無限重試、明顯工具延遲回歸或 readiness 長期錯誤。
6. 無必要的 Prompt 重複注入。
7. BaseMind 不適用時 Agent 能合理 fallback，且最終答案正確。
8. 效率改善只有在有實際證據時才寫成結論；沒改善就如實記錄。

---

## 5. Deferred Scope（本階段不調研、不實作）

依最新 Scope 約束，以下三項已明確暫停；本計畫不重新調研、不設計、不實作，除非人工另外授權：

1. **Binary 異常及下載狀態原生通知**：DSH 目前沒有適合的原生 Toast API；現況為 Logger + `/basemind-status` + `state.json`。
2. **官方 Pi／OpenCode 快捷命令同步**：`/bm`、`/bm-init`、`/bm-scan`、`/bm-doctor`、`/bm-stats`、`/bm-statusline`。本階段不改為 DSH 命令，也不改寫成新的 slash command。
3. **Agent Identity 自動綁定及 Inbox 主動通知**：不新增身份注入、不輪詢、不通知；保留上游 3 個 agent tools 的原生能力。

保留且不在本階段重做的既有能力：`/basemind-status`、Logger、Local First Binary Manager、完整 Managed Binary 安裝、Workspace Pool、MCP Bridge、MCP Resources、CLI Adapter、10 個官方 Skills、Bootstrap System Prompt Section。

---

## 6. 官方 Pi Bootstrap／Lifecycle 參考分析（A）

基準：BaseMind `v0.34.0`（commit `8e7b149`）。`.pi/extensions/basemind.ts` 與 `opencode-plugin/.pi/extensions/basemind.ts` 內容相同（127 行）。

### 6.1 Pi extension

| 事件 | 行為 | 對 DSH 的含意 |
| --- | --- | --- |
| `resources_discover` | 回 `{ skillPaths: [<packageRoot>/skills] }`，由宿主掃目錄 | Pi 用「目錄」暴露 skills；DSH 插件用 `ctx.skills.registerProvider()`，語義等價 |
| `session_start` | `injectBootstrap = true` | DSH 沒有等價事件；插件在 `agent/created` 只做 relay root 採納 |
| `session_compact` | 重設 `injectBootstrap = true` | **只在「訊息型 bootstrap」下必要**；DSH 的 bootstrap 是 system prompt section，不受壓縮影響 |
| `context` | 若旗標為真且歷史無 marker，插入一則 `role:"user"` 訊息；位置在開頭連續 `compactionSummary` 之後 | DSH 不應複製：不建立偽造 user message |
| `agent_end` | `injectBootstrap = false` | 上游的「每 session 一次 + 每次壓縮一次」頻率；DSH 不需要旗標 |

- 去重是兩層：旗標 + 內容 marker `basemind:using-basemind bootstrap for pi`；bootstrap 內容 = 固定包裝 + `skills/basemind/SKILL.md` 全文（去 frontmatter）+ `pi tool mapping`，合計約 **15.0 KB**（約 3.7k 估算 token），且每次注入都帶 `timestamp: Date.now()`。
- 上游 bootstrap 是靜態文字、不含 repo／索引狀態；Pi 端沒有原生 MCP，因此需要 `pi tool mapping` 把 MCP 動詞降級成 CLI 命令。

### 6.2 OpenCode 插件（`opencode-plugin/basemind.js`）

- 只做兩件事：`ctx.mcp.transform`（註冊 `basemind serve`，binary missing 就不註冊）與 `ctx.skill.transform`（**解析 SKILL.md 後以資料註冊**，不是掛目錄）。
- **沒有** system prompt／instructions 注入；**沒有** compaction 處理；**沒有** commands。
- 對 DSH 的含意：上游只有 Pi 需要「compaction 後重注入」，因為只有 Pi 用訊息通道；DSH 應維持 section 通道。

### 6.3 差異結論

| 能力 | Pi | OpenCode | 本插件（DSH） |
| --- | --- | --- | --- |
| Skills 暴露 | 目錄（`skillPaths`） | 資料註冊（`skill.transform`） | `registerProvider()`（catalog 由 DSH 管理） |
| Bootstrap 通道 | user 訊息 | 無 | systemPrompt section（`interpolate:false`） |
| Bootstrap 體積 | ~15 KB / 次 | 0 | **1,218 B**（實測，§9） |
| Compaction 恢復 | 需要（重注入） | 不適用 | **不需要**（每 step 重組 + catalog 自動重發） |
| 動態時間戳 | 有（message timestamp） | 無 | **無**（byte-stable） |
| 工具面 | 只有 CLI | MCP + CLI | MCP（動態 discovery）+ argv-only CLI adapter |

**不做的事**：不把 Pi 的 15 KB bootstrap 搬進 DSH；不建立偽造 user message；不在每次 Agent turn 重新注入核心 Skill；不新增 compaction hook。

---

## 7. DSH 原生 API 實際能力分析（A）

以下皆以 **已安裝的 `0.2.2-rc.5` runtime 原始碼**為準（`app.asar` 內 `dsh/node_modules/@deepseek-ai/...`），不依 Pi／其他 Agent API 猜測。

### 7.1 `ctx.systemPrompt`

| 項目 | 事實 | 證據（package／symbol） |
| --- | --- | --- |
| 方法集 | `section`、`context`、`suppressRuntimeContext`、`tools`、`variable`、`getSectionOrder`、`getContextOrder`、`assemble`、`refreshContext` | `dsh-system-prompt/src/index.ts`（`class SystemPrompt`） |
| `section()` 參數 | `{ name, order, text: string \| (ctx) => string, interpolate?, complete? }` | 同上 `PromptSection` |
| 回傳 | **disposer**（Cordis effect disposer） | 同上 `section()` |
| `text` 求值時機 | **每次 `assemble()` 呼叫函式**；`assemble()` 由每個 model step 的 pre-step 觸發 | `dsh-system-prompt` + `dsh-agent-loop/src/agent.ts`（唯一 `systemPrompt.assemble()` 呼叫點） |
| 重複 name | 同 layer 直接 throw；跨 layer 是 scoped 覆蓋 | `dsh-system-prompt` |
| 排序 | 固定順序表（identity −1000、persona 0、工具/政策 1000–3100、MCP 3100、harness 10000、persona suffix 10200）；升序、同 order 以 name code-unit 排；`\n\n` 串接、空段丟棄 | 同上 `SECTION_ORDERS` |
| 長度上限 | **未找到**（無 truncate／max） | 同上 |
| `interpolate:false` | 不解析 `{{var}}`，保留原文 | 同上 |

**對插件的含意**：現有 `registerInstructions()`（字串）與 `registerBootstrapSection()`（函式）都符合契約；動態 `text()` 不會被快照，readiness 變化後下一個 step 就會反映，不需要重新註冊。

### 7.2 一次模型請求的 prompt 組成

| 部分 | 形式 | 插件相關性 |
| --- | --- | --- |
| system 文字 | session surface 的 `system/message`（node 0） | MCP instructions＋bootstrap 兩個 section 在此 |
| 對話 | `session.deriveMessages()` | skills catalog 是其中一則 user 訊息 |
| tools | 獨立的 `request.tools`，由 tool provider 收集、`toolOrder` 排序 | MCP 18 tools + `mcp__basemind__cli` |
| runtime context | user-role `<system-reminder>` 快照（working dir、sandbox、approval、subagent…） | 非插件控制 |
| skills catalog | **user-role 訊息**，`source.kind='skill-catalog'`，每 step 以 digest 比較，變更才重發 | 插件提供 provider，DSH 負責渲染 |
| 穩定前綴 | 同文字不重寫 node 0；新 series 且文字不同才 replace；工具變更以 `developer/message` 的 tool-addition／tool-removal 表示 | bootstrap 必須 byte-stable |

### 7.3 Compaction

| 項目 | 事實 | 證據 |
| --- | --- | --- |
| 服務 | `ctx.compaction`：`compactIfNeeded(agent, 'pressure'\|'context-overflow', signal)`、`compactNow(agent, signal, commandId?)`、`compactRegion(start, end, agent, signal?)` | `dsh-compaction` |
| 自動壓縮 | 預設 `auto: true`；`agent/pre-step` 壓力觸發；`agent/request-error` context overflow 觸發 | `dsh-compaction-basic/src/config.ts`、`index.ts` |
| 門檻 | `thresholdRatio = 0.8`、`retainRatio = 0.16`（預設；可按 model 覆寫） | 同上 |
| 摘要模型 | `summarizationProvider/Model`；空則退回 routed model → **每次 compaction 一次額外 LLM 呼叫** | `dsh-compaction-basic/src/summarizer.ts` |
| 產出 | surface 區段換成 `source.kind='compact-checkpoint'` 的 user 訊息；寫 `compaction/start`／`compaction/end` | `dsh-compaction` |
| 事件 | **沒有** `session_compact`；只有 `compaction/summary-error`（waterfall） | `dsh-compaction` |
| system node 0 | **永不進入壓縮範圍**（`firstIdx` 從 1 起算） | `dsh-compaction-basic/src/region.ts` |
| 使用者入口 | `/compact` slash command（無參數），handler 直接呼叫 `compactNow`；需 agent idle、system 之後至少 2 個 surface 節點、摘要需小於被取代內容 | `dsh-command-compact` |
| CLI | **沒有** CLI 子命令可觸發 compaction | runtime grep 0 命中 |

### 7.4 Session Resume

| 項目 | 事實 |
| --- | --- |
| API | `ctx.agents.resume(ownerCtx, { resumeSessionId, agentOptions?, signal?, setup? })`；先載入持久化 session，再跑 setup，最後註冊 agent |
| 插件是否重新 apply | 是（新 process 重新 apply）；root context 的全域註冊是 process 級，不需重新註冊；agent scope 每次 create/resume 都是新的 |
| cwd | `WorkingDirectoryService` 投影初值 `header.cwd`；`ensure(agent)` 取投影值 |
| 事件 | `agent/created`（`source: 'startup'\|'resume'\|'clear'\|'compact'`）、`agent/disposed`、`session/created` 等 |

**對插件的含意**：Resume 後工具與 prompt section 由全域註冊自動生效；Bootstrap 的 `getText()` 會用當下 readiness/selection 重新求值；工具呼叫仍以 `exec.agent` 的 cwd 路由。**不需要** resume hook。

### 7.5 `ctx.skills`（Registry 契約）

| 項目 | 事實 |
| --- | --- |
| 註冊 | `registerProvider(create)`，`create(control) => SkillProvider`，**同步回傳**；`control = { signal, invalidate() }`；同名同 layer throw；保留名 `runtime` |
| Provider | `{ name, list(options) => SkillCandidate[] \| { candidates, complete }, get(candidate, options) => SkillDefinition \| undefined }`；`options = { cwd?, signal? }` |
| Candidate 必填 | `name`、`description`、`invocation{modelInvocable,userInvocable}`、`source`、`provider`（必須等於 provider.name）、`rank`、`locator`；可選 `path`、`resourceBase`、`metadata` |
| rank | **只在同一 layer 內**比較（小者勝）；跨 layer 是「最近 scope 覆蓋」 |
| 內建 rank | runtime 250、bundled 600；filesystem：project 100、`.agents` 200、custom 300、`$DSH_HOME` 400、user agents 500、bundled 600 |
| catalog 快取 | 只快取 candidates；**body 只在 `get()` 讀取** |
| 變更通知 | `skills/change`（emit）；`invalidate()` 清快取 |

### 7.6 `ctx.tools`

| 項目 | 事實 |
| --- | --- |
| 註冊 | `register(definition) => disposer`；同 layer 同名 throw；**沒有 update API** |
| 動態變更 | 每 step 重新 `resolve()`／`assemble()`；工具增減以 `developer/message`（tool-addition／tool-removal）告知模型 |
| per-agent 可見性 | 以呼叫 ctx 的 scope 註冊；`restrict()` 只能在 agent scope |
| Subagent | **不是 scope 繼承**：每個 agent 的 scope 都掛在 loopCtx 下（兄弟）；子 agent 因重新 mount 同一 preset 而取得同一組全域＋preset scoped 工具；父 agent 臨時 scoped 註冊不會被子看到 |

### 7.7 MCP instructions

- DSH 自己的 MCP client 也是用 `ctx.systemPrompt.section({ name: 'mcp:<server>', order: MCP_SERVERS(3100), interpolate: false, text })`；格式 `### MCP server: <name>\n\n<instructions>`；上限 `maxInstructionBytes = 32768`，超過是 **throw** 而非截斷。
- 本插件不經 DSH 的 mcp-client，而是自己註冊 section，並在 32 KB 內截斷（[index.js:198-218](../index.js#L198-L218)），所以不會觸發 DSH 的 throw。

### 7.8 Human command

- `ctx.commands.register({ name, description, handler })`，名稱 `^[a-z][a-z0-9_-]*$`；`/basemind-status` 目前是唯一命令，正確使用此 API。
- **Skills 不會自動變成 slash command**；使用者訊息中的 `/<skill-name>` 是 `dsh-tool-skill` 在 server 端 pre-step 掃描的手勢（詳見 §8.3）。

---

## 8. Skills Discovery 及正文載入分析

### 8.1 官方 Skills 完整性（10 項檢查）

| # | 檢查 | 結論 | 證據 |
| --- | --- | --- | --- |
| 1 | Skills 來源版本 = Binary 目標版本 | ✅ 一致：`UPSTREAM.json` tag `v0.34.0`、commit `8e7b149`、10 個名稱；`lib/upstream.js` 同值 | [skills/UPSTREAM.json](../skills/UPSTREAM.json)、[lib/upstream.js](../lib/upstream.js)、`test/upstream.test.mjs` |
| 2 | DSH Skill Registry 契約 | ✅ `definitionEntry()` 提供 name／description／invocation／provider／source／rank／locator／resourceBase／path；`list()` 回 candidates、`get()` 回完整 definition | [lib/skills/provider.js:168-180](../lib/skills/provider.js#L168-L180)、[test/skills.test.mjs](../test/skills.test.mjs) |
| 3 | Description 準確表達用途 | ✅ 10 個 description 與正文「When to use」一致（抽樣核對）；`basemind-stats` 的 YAML 單引號由 `unquote()` 正確去除 | provider.js `parseSkillFrontmatter`、實測 description 長度 191–384 字元 |
| 4 | 正文可被真實 Agent 載入 | **待 3A 實測**（D9/D10 NOT RUN）；靜態契約正確，且 DSH `skill` 工具只透過 `get()` 取 body | §7.5、§11 |
| 5 | 官方工具名稱已映射到 DSH | ✅ 文字層：技能只使用 18 個 0.34.0 工具名 + `mcp__basemind__cli`；**沒有**虛構的 snake_case 工具名（本次以 fixture 對照掃描） | `fixtures/basemind-0.34.0-tools.json`、本次掃描（B） |
| 6 | CLI 指引使用插件已選擇的 Binary | ✅ `.dsh-adapt.json` R1 把 `mcp-launch.sh` 改為 `mcp__basemind__cli`；R8 把 `scan` 導向 `index_rescan`，CLI 明確拒絕 `scan`/`rescan` | [skills/.dsh-adapt.json](../skills/.dsh-adapt.json)、[lib/cli-tool.js:131-150](../lib/cli-tool.js#L131-L150) |
| 7 | 不引導調用不存在的工具 | ✅ 就 MCP 工具面而言無虛構名稱；`agent_*` 工具在 0.34.0 官方 binary 存在（fixture），但屬 **deferred**，若實際未暴露則 `basemind-comms`／`basemind-multi-agent-room` 會指向不存在的工具（§21 F5，待驗證） | 同上 |
| 8 | 不引導使用 PATH 中不相容的 BaseMind | ✅ R1 明說「bare `basemind` from PATH 只在 plugin disabled 時 fallback」；bootstrap 也警告不要呼叫 PATH 上的 `basemind` | [lib/prompt/bootstrap.js:101-109](../lib/prompt/bootstrap.js#L101-L109) |
| 9 | 附屬資源可用 | ✅ 每個 skill 有 `index.md`；DSH 的 `resourceBase` 只把目錄寫進 `<skill_resources>` 提示，模型用原生 `read` 讀取。上游與 DSH 都不自動讀 `index.md` | §7.5、上游 `skills/*/index.md` |
| 10 | 沒有要求 DSH 尚未提供的操作 | ✅ 沒有 PreToolUse／hook／slash command 實作要求；`comms`／`agent`／`scan` 在 CLI 被拒，skills 已改寫指引 | `.dsh-adapt.json` R3/R4/R5/R7/R8 |

**已知措辭風險（低）**：`basemind-stats` 仍 3 次提到 `/bm-stats`、`basemind-doctor` 1 次提到 `/bm-scan`；DSH 只支援 `/basemind-stats`／`/basemind-scan`（skill 名稱手勢）。因 `/bm-*` 屬 Deferred，本階段**不新增命令**；是否清理文字留待 §21 F4 人工裁決。

### 8.2 Catalog Discovery 的實際成本（關鍵分析）

| 成本類型 | 實測／契約 | 是否注入模型上下文 |
| --- | --- | --- |
| 檔案讀取 | 插件 `list()` 第一次呼叫時 `loadCatalog()` 會讀 **全部 10 個 `SKILL.md`**（約 104 KB）並快取 body 於 Map；之後 `get()` 直接命中記憶體 | ❌ 不是 |
| 記憶體 | 約 104 KB（10 個 body + metadata），每個 provider 實例一份 | ❌ 不是 |
| Catalog metadata | DSH 只渲染 `- \`name\`: description`；**只有 name + description**，description 上限 500 字元；實測 10 筆 catalog 共 **4,177 字元**（框架 683 + entries 3,494） | ✅ 是（約 1.0k 估算 token，見 §9） |
| Skill 正文 | 只在 `skill` 工具或使用者 `/<name>` 手勢時載入；單一正文 3.2–18.7 KB | 僅按需 |

> **判讀原則**：檔案已讀入插件記憶體 ≠ 正文已注入模型上下文。本次未發現因 `loadCatalog()` 造成的可感知效能問題（一次性 10 次本地讀取）；**不修改現有快取策略**。若 3A 實測出現 catalog 更新延遲或重複讀檔，再另行評估。

### 8.3 Discovery／Progressive Disclosure 行為（A）

- **Catalog 形式**：`dsh-tool-skill` 在每個 `agent/pre-step` 取 `ctx.skills.snapshot({ cwd, scope: agent })`，只保留 `modelInvocable`，渲染成 `<system-reminder> ... <available_skills> - \`name\`: description ...` 的 **user 訊息**；digest 未變就不重送，變更時送「完整取代先前清單」的更新訊息。
- **正文載入**：模型呼叫 `skill` 工具（`name` 參數）或使用者訊息第一行以 `/<skill-name>` 開頭（server 端 pre-step 掃描 `source.kind==='user'`），兩者都走 `ctx.skills.get()`；**`/bm-*` 不是命令、也不會載入任何東西**。
- **重複註冊**：插件在 `ctx.effect` 內只註冊一次；卸載時 dispose provider；DSH 會 invalidate 快取。`test/index.test.mjs` 已覆蓋「verified binary 註冊 skills」與「卸載清理」。
- **優先級**：project／user filesystem skills 位於 **更近的 agent scope**，會覆蓋 root scope 的 provider；插件 rank 1000 只在同 layer 內有意義。結果仍是「使用者／專案同名優先」。
- **停用／不相容**：`skills:false` 或 `selection.verified !== true` 時 `list()` 回空 → catalog 不含 basemind skills、bootstrap 也不提 skill（[lib/skills/provider.js:143-151](../lib/skills/provider.js#L143-L151)、[index.js:616-643](../index.js#L616-L643)）。
- **Compaction 後**：catalog 訊息可能被壓縮隱藏；下一個 pre-step 回掃 surface 找不到可見 digest，會自動重發完整 catalog。**插件不需介入**（詳細證據見 §11）。

### 8.4 Agent 實際選擇效果（待 3A／3C 驗證）

- 需要區分：
  - **A 類**：Agent 沒有載入 Skill，但依 MCP instructions 正確完成任務 → 正常，不視為缺陷。
  - **B 類**：Agent 因缺少必要指引而選錯工具／參數 → 才可能是 Discovery 或 Bootstrap 問題。
- 只有在 3A 觀察到 B 類，才提出內容調整；不以「BaseMind Tool Call 比例」為目標。
- 需要實測的最小問題：理解使用方式、代碼搜尋、Git 歷史、文件搜尋、索引診斷、CLI-only 高級分析（§17 的 B1–B6 已涵蓋大部分）。

---

### 8.5 Skills 選擇效果的最小測試（3A-2 內執行，成本低）

在真實測試 Profile 中，用以下最小 prompt 觀察一次即可（每個 prompt 一個新 session）：

| # | Prompt（固定文字） | 觀察重點 | 通過條件 |
| --- | --- | --- | --- |
| S1 | 「這個 repo 的程式碼要怎麼用 basemind 找某個函式的呼叫者？先不要實際查詢，只說明步驟與工具名稱。」 | 是否載入 `basemind`／`basemind-code-search`，或直接說出正確 MCP 工具名 | 工具名與參數正確（載不載入 skill 都可） |
| S2 | 「找出 `<真實符號>` 的定義與至少一個呼叫者。」 | 是否先用 `code_symbols`／`code_refs`，而非全文 grep | 使用 BaseMind 或合理 fallback，答案正確 |
| S3 | 「`index_status` 顯示 index 是空的，接下來該怎麼做？」 | 是否載入 `basemind-doctor`／`basemind-scan`，是否知道 `index_rescan` 與 CLI 的限制 | 不叫 Agent 執行被 CLI 拒絕的 `scan`；指引可執行 |
| S4 | 「用 BaseMind 做 deadcode 分析。」 | 是否使用 `mcp__basemind__cli` 的 `code deadcode` | 正確使用 CLI adapter（A 組不適用，只在 B 組） |

- 允許 A 類（不載入 Skill 但正確）；只有 B 類（選錯工具／參數）才列為 Discovery 或 Bootstrap 問題。
- S1–S3 可在同一批 3A 驗收中完成；S4 只在 B 組觀察。不得為這 4 個 prompt 增加重複跑次。

---

## 9. Bootstrap 及 Prompt Token 分析

### 9.1 實測大小（B）

| 項目 | 大小 | 備註 |
| --- | --- | --- |
| MCP Server Instructions（fixture） | **2,627 bytes**（14 行） | 真實 0.34.0 隔離採集；插件上限 32 KB |
| Bootstrap section（verified） | **1,218 bytes**（1,212 chars、19 行） | 無時間戳、無絕對路徑、`interpolate:false` |
| Bootstrap section（`binaryPolicy: any`） | **269 bytes** | 只說明 MCP 可用、版本未驗證 |
| Skills catalog（10 筆） | **4,177 chars**（框架 683 + entries 3,494） | 依 DSH 渲染格式與實際 descriptions 計算；每筆 `- \`name\`: description`；description 191–384 字元 |
| MCP tool schemas（18 個，fixture JSON） | **23,675 bytes** | 隨每個請求的 `tools` 欄位送出 |
| `mcp__basemind__cli` schema | **655 bytes**（description 301 + params 294 + name） | 只在 verified + `cliTool:true` 時註冊 |
| 真實 Desktop session 的全工具 payload（71 tools） | **71,465 bytes** | 2026-11-24 實測 session header；含大量其他插件工具，非 BaseMind 專屬 |

**估算 Token（僅供預算，非計費值）**：以 `bytes / 4` 粗估——instructions ≈ 657、bootstrap ≈ 305、catalog ≈ 1,044、MCP schemas ≈ 5,919、CLI schema ≈ 164。**Group B 相對 Group A 的固定增量約 6,050 bytes ≈ 1.5k tokens**（bootstrap + catalog + CLI schema），加上按需載入的 skill 正文（3.2–18.7 KB／次）。實際 token 必須用供應商 usage 或 tokenizer，不得把估算當計費值。

### 9.2 穩定性與 Cache（A+C）

| 問題 | 結論 |
| --- | --- |
| Bootstrap 是否 byte-stable | 是（同一 readiness/selection 快照完全相同，測試斷言 `first === second`）；文字含 version 與 source，**binary source／版本變更才會改變前綴** |
| 是否每次請求重複追加 | 否：section 是 system prompt 的一部分，每 step 重新求值但同文字不改寫 node 0；DSH 以 `system/message` 投影，`in-history` provider 只在文字變化時 append 新的 system 訊息 |
| Binary 變更對 Prompt Cache 的影響 | 只影響一次（source/version 改變）；不應為了 cache 移除必要指引 |
| Session 恢復是否改變前綴 | 不會：resume 後重新 assemble，文字相同則不重寫 node 0；若 binary 版本/來源變了才會更新 |
| Compaction 是否改變前綴 | 不會：node 0 不在壓縮範圍；catalog 可能被隱藏但會重發（user 訊息，不影響 system 前綴） |
| 是否有不必要重疊 | MCP instructions 已含工具用法與慣例；bootstrap 只補 CLI-only、fallback、workspace、skills 按需載入；重疊約 1 句（"Use the tools' own instructions first"），可接受 |

### 9.3 是否調整 Bootstrap

**預設不改內容**，除非 3A／3C 觀察到 B 類選擇錯誤或明確誤導。唯一已確認的措辭問題是 `bash`（Windows Standard Preset 是 `pwsh`）；這是文字級修正，列入 §21 F2（需授權，低風險）。

### 9.4 可重複測量方式（供 3A／3C 使用）

1. 由 session log 解壓（`session.v4.jsonl.zstd` 是多個 zstd frame）取得：
   - `system/message`：精確 system prompt 文字與 bytes；
   - `request/header`：`header.config`（provider/model/reasoningEffort）、`header.tools`（schema 數量與 bytes）；
   - `assistant/message.usage`：每步 usage。
2. 由插件直接量：`bootstrapText(snapshot)`、catalog 渲染文字（模擬 DSH 格式）、fixture tool JSON。
3. 每次 Benchmark 都對 Group A/B 各記一次，禁止只憑估算。

---

## 10. Session Resume 驗證方案（C）

**目標**：確認 resume 後工具、Skills、Bootstrap、工作區與 binary 選擇都正確。

| 步驟 | 操作 | 預期 | 證據 |
| --- | --- | --- | --- |
| R-S1 | 測試 Profile 開新 session，工作目錄 = `bm-java`，呼叫 `index_status` 與 `mcp__basemind__cli status` | 工具可見、root 正確、BaseMind 0.34.0 | session log tool/call |
| R-S2 | 結束進程（關閉測試實例），以 `dsh --profile <test> --session-id <id> "continue"` 或 GUI 重開同一 session | 同一 session id；工具仍可見；bootstrap 仍在；skills catalog 仍在 | `session/system/message`、catalog 訊息 |
| R-S3 | 檢查是否重複註冊／重複 prompt | system message 只有一份、catalog 只有一份、工具名無重複 | session log |
| R-S4 | 在新 process 觀察 managed binary 是否重下載 | 使用既有 cache／PATH，不下載（暖快取 0 網路） | plugin log、`/basemind-status` |
| R-S5 | 變更 `cd` 到另一個 repo 後再呼叫 | 下一個呼叫路由到新 workspace，不沿用舊 root | `index_status` root |

**風險**：headless `--session-id` 需要真實 session id；GUI 重啟後 session 恢復由 DSH 處理。若無法在 Desktop 外取得 id，改用 GUI 手動 resume（記錄 session id 與 log）。
**不做**：不為 resume 新增程式碼；不修改 session 檔案。

---

## 11. Compaction 驗證方案（本階段重點）

### 11.1 先行結論（A）

- DSH **沒有** `session_compact` 事件，也**不需要**插件在壓縮後重注入 Bootstrap：system prompt 每個 step 重新 `assemble()`，`system/message` node 0 不在壓縮範圍。
- Skills catalog 是 user 訊息，可能被壓縮隱藏；`dsh-tool-skill` 每 step 由 `session.surface.nodes` 回掃，找不到可見 digest 就重發完整 catalog。**插件不需新增 hook**。
- 官方 Pi 的 `session_compact` 只對「訊息型注入」必要；DSH 不應複製。

### 11.2 測試設計（C1–C4）

#### C1（Compaction 前）

| 記錄項 | 取得方式 |
| --- | --- |
| 工具清單 | `request/header.tools` 或 Agent 回報 `mcp__basemind__*` |
| Skills catalog | session log 的 `source.kind='skill-catalog'` 訊息（name+description 清單） |
| MCP instructions | system message 內 `### MCP server: basemind` 段 |
| Bootstrap section | system message 內 `mcp:basemind:bootstrap` 文字（以「BaseMind is wired into this session」定位） |
| 當前工作區 | `index_status.root` |
| BaseMind 可用性 | `/basemind-status`、`mcp__basemind__cli status` |

#### C2（觸發真實 Compaction）

- **首選**：GUI composer 輸入 `/compact`（無參數）。前置：agent idle、system 之後至少 2 個 surface 節點（user + assistant）、摘要需小於被取代內容；否則回 `No compactable history yet.` 或 `ManualCompactionError`。
- 成本：**一次摘要 LLM 呼叫**（用 routed model 或 `summarizationProvider/Model`）。這是 Phase 3 唯一必須的額外模型消耗，需人工授權。
- **不得**用偽造 `compaction/start` 事件或直接寫 session 檔代替真實 GUI 驗收；自動化只可用 `commands.execute`（若有 API 曝露）或 `ctx.compaction.compactNow`，且須標記為「非 GUI」證據。
- 若使用 headless：**`/compact` 文字不會觸發**（command 在 client 端解析），本階段不假設 headless 可觸發；以 GUI 為準。

#### C3（Compaction 後）

| 檢查 | 預期 |
| --- | --- |
| MCP Tools 仍可用 | 呼叫 `code_symbols` 成功；`index_status` root 正確 |
| Skills 仍可發現／載入 | catalog 訊息重新出現；`skill` 可載入 `basemind-code-search` 正文 |
| Bootstrap 必要引導仍在 | system message 仍含 bootstrap 段（或 system 文字未變） |
| 無重複 Bootstrap | 不存在兩份 bootstrap 段；不存在舊版工具名 |
| 工作區正確 | 無跨 repo root |
| 新任務可完成 | 執行一個小型 BaseMind 任務並正確回答 |

#### C4（連續 Compaction）

- 連續做 2–3 次 `/compact`（每次之間完成一個小任務），檢查：
  - bootstrap 不累積（system 文字仍是同一份）；
  - catalog 不重複（只有一份可見清單；更新訊息取代先前清單）；
  - 工具 registry 不重複（`request/header.tools` 中 `mcp__basemind__*` 名稱不重複）；
  - 無 relay 洩漏（`basemind serve` 數量 = 活躍 workspace 數）；
  - 工作區狀態不混用。

### 11.3 修復原則

- 若 C3/C4 顯示引導仍在且新任務成功 → **不新增 Compaction Hook、不複製 Pi Context Injection**，只補測試與驗收文件。
- 若出現缺失 → 必須以真實 session log 重現、定位根因（DSH prompt assembly / 插件註冊 / catalog），才提最小修復；不得新增偽造 user message、不得每 turn 重注入核心 skill。

---

## 12. Relay Readiness 及可用性恢復驗證

### 12.1 現況分析（A）

| 面向 | 現況 | 判定 |
| --- | --- | --- |
| 1. 插件全局初始化 | `readiness.ok() = state.ready && selection.ok && selection.compatible !== false` | ✅ 正確 |
| 2. 已選 Binary 有效性 | `selection.verified` 決定 skills／CLI／bootstrap 版本文字 | ✅ 正確 |
| 3. Primary Relay 存活 | `onClose` 只 log（[index.js:173-177](../index.js#L173-L177)）；`state.ready` 不變 | ❌ **缺口** |
| 4. 當前 Workspace Relay 可用性 | Workspace Pool 沒有「移除死亡 entry」路徑；`clientFor` 回傳已死 session | ❌ **缺口** |
| 5. 當前 Agent 工具可見性 | 工具註冊是全域的；實際每個 step 重新 resolve；relay 死亡後工具仍列在 schema 中但呼叫失敗 | ⚠️ 由 (3)(4) 導致 |
| 6. Skills 與實際可用工具匹配 | 只按 binary verified 全開／全關，沒有按工具存在性 gating | ⚠️ 0.34.0 官方 binary 18 tools 正常；agent tools 若缺席則 2 個 skills 會指向不存在的工具（§21 F5） |

補充：
- 全域 readiness 適合「bootstrap／skills 是否描述一個可用服務」；**不適合**表達每個 workspace 的健康度。需求也明確要求「不能因為某個 workspace relay 異常就停用其他 session」；現況符合後者，但沒有前者。
- `syncTools()` 成功後未 `readiness.notify()`：**經分析不是缺陷**。skills catalog 只依賴 binary verified 與 provider 清單，不依賴工具名稱；notify 只會重送相同 catalog。**本階段不修**（與 Phase 1 計畫的推測不同，以本次源碼分析為準）。

### 12.2 測試設計（R1–R5）

| ID | 場景 | 方法（3A／3B） | 預期／判定 |
| --- | --- | --- | --- |
| R1 | Primary Relay 意外退出 | 真實測試 Profile 中先呼叫一次工具，再以 `taskkill`／`Stop-Process` 終止該 workspace 的 `basemind serve`；再呼叫同一工具 2 次 | 目前**預期失敗且不恢復**（重現 F1）；修復後應自動重建並成功 |
| R2 | Secondary Workspace Relay 退出 | Session A（repo1）與 B（repo2）各建立 relay；只殺 repo2 的 relay；兩邊再呼叫 | A 不受影響；B 應能重建（目前不會）；不得停用 A |
| R3 | BaseMind Daemon 暫時不可用 | 終止 `basemind` daemon／讓 `serve` 啟動失敗（用不存在但可執行的 fake binary 或封鎖 port）；觀察 retry 次數與間隔 | retry 有界（5 s → 30 s → 300 s）、無風暴、Agent 可 fallback、恢復後可再用；**不自動停止用戶全局 daemon** |
| R4 | Tools List 變更 | 以 fake server 在 `tools/list_changed` 後回傳少一個工具／多一個工具；觀察 generation 替換、舊名移除、resources 不受影響 | 新舊 generation 正確替換；無重複；bootstrap／skills 不引用已消失工具（目前文字靜態，需人工確認） |
| R5 | 插件停用／重載 | 測試 Profile 的 Plugin Manager 停用→啟用→卸載；復用 Phase 2 D15 | 所有 surface 消失／恢復；無殘留 relay；cache 保留 |

### 12.3 若 F1 重現的最小修復邊界（僅供 3B 使用，需授權）

- **方案 A（最小）**：`onClose` 非預期關閉時，呼叫 pool 新增的 `forget(root)`（只刪 entry，不 close），下一次 `clientFor()` 自然重建；primary 另外清除 `state.primarySession`。
- **方案 B（較完整）**：primary 非預期關閉時設 `readiness.ready = false`、`state.ready = false`、`state.primarySession = undefined`，`pool.forget(primaryRoot)` 後 `void ensurePrimary()`；重試沿用既有 backoff。
- 禁止：每 tool call spawn CLI、高頻健康檢查輪詢、per-agent binary manager、重寫 pool、把全局與工作區狀態混在一起。
- **決策點**：3B 重現後由人工選擇 A 或 B；若重現失敗則不修。

---

## 13. 多 Session／Subagent 使用效果驗證

### 13.1 復用 Phase 2（不重複機械性測試）

Phase 2 已有 `test/workspace-pool.test.mjs`（per-root 單一 relay、容量、取消只取消等待、dispose）與 `test/index.test.mjs`（per-call working directory 路由、collision、失敗回滾）。這些**直接復用**，不再重建同等測試。

### 13.2 Phase 3 只補「真實 Agent 的上下文感知」

| 檢查 | 方法 | 預期 |
| --- | --- | --- |
| Agent 是否理解工具指向自己的工作區 | 兩個 session 分別在 repo A/B，問「這個 workspace 的 root 是什麼」並要求呼叫 `index_status` | 各自回自己的 root，不交叉 |
| 是否錯誤指定其他專案路徑 | 給定不在當前 repo 的檔案路徑，要求 `code_read` | 明確失敗或指出路徑不屬於 workspace，不跨 root |
| 切換工作區後是否仍依賴舊結果 | `cd` 到另一個 repo，再問同一符號 | 使用新 root 的結果，不引用舊快取 |
| Subagent 的工具／Skills／Bootstrap | 主 Agent 在 A，subagent cwd = B；subagent 呼叫 MCP／CLI | subagent 有相同工具與 skills catalog；路由到 B；Bootstrap 是 host 級同一份 |
| 多 session 同時執行 | A/B 交錯呼叫工具 | 無 root 混用、無 relay 串錯 |

### 13.3 真實工作區測試（優先順序）

1. **首選**：兩個本機 repo（Vue 3 與 Java）唯讀 clone 到暫存目錄，固定 commit；主 Agent／Subagent／worktree 三個案例。
2. **次選**：公開 OSS repo（若業務 repo 未授權）。
3. **使用業務 repo**：需人工授權，只讀，不執行 `scan`／`rescan`／任何寫入；結果可匿名化。
4. 同一 repo 不同 worktree：驗證讀到 worktree 內容；**不得**把同 group index／memory 共享當成隔離失敗。

不新增 Agent Identity 綁定。

---

## 14. GPT／DeepSeek A/B Benchmark 設計

### 14.1 對照組（同 build、同 binary、同索引）

| 組 | 配置 |
| --- | --- |
| **A（MCP-only Baseline）** | `skills:false`、`bootstrap:false`、`cliTool:false`；保留 MCP tools、MCP instructions、MCP resources、binary 版本、workspace 路由 |
| **B（Full Integration）** | 預設值（`skills:true`、`bootstrap:true`、`cliTool:true`），其餘與 A 完全相同 |

- 使用**同一個 commit** 的 tarball、同一個 BaseMind binary、同一份索引與同一個 repo commit。
- **不**使用 `binaryPolicy: any` 當 A 組切換方式（會同時改變 binary 契約與其他行為，混淆因果）。
- 兩組各用獨立 Profile（`bm-bench-a`、`bm-bench-b`），除上述三個布林值外 config 相同；不修改使用者生產 Profile。

### 14.2 執行環境與 Session 規則

- 每個測試使用**獨立新 Session**；不得在同一個 session 先跑 A 再跑 B。
- 每個 prompt、AGENTS.md、工作目錄、模型、reasoning effort、Standard Preset、工具權限都相同。
- 交錯或平衡執行順序（例如 A1,B1,B2,A2,…），避免 A 組全冷啟動、B 組全熱啟動；固定隨機種子記錄順序。
- 每輪開始前記錄：`index_status`（root／indexing／file_count）、binary 版本與 source、DSH 版本、模型與 effort、profile 名、commit SHA。
- 每輪結束後保存：session log（zstd）、最終答案、工具序列；（可選）截圖。

### 14.3 Harness 選擇（D10：Hybrid）

| 方案 | 優點 | 缺點 | 建議 |
| --- | --- | --- | --- |
| **H1：Web Profile + Standard Preset（GUI）** | 完全符合「Standard Preset」要求；與 Desktop 行為一致 | 每輪需人工操作；24 輪人力成本高 | **Pilot 首選**（12 輪） |
| **H2：Headless Profile（自動化）** | 可用 `dsh --profile bm-bench-a "<prompt>"` 一鍵執行、自動收集；無 GUI 操作 | headless profile **沒有** `agent-preset-registry`（shipped headless 直接組 agent），嚴格說不是 Standard Preset | 需先做「等價性檢查」並取得人工同意才能當主要 harness |
| **H3：Web GUI + 瀏覽器自動化** | 兼顧標準 preset 與自動化 | 需額外自動化依賴／腳本，穩定性與權限風險 | 本階段不建議 |

**決策（2026-11-24，第二輪）**：**Hybrid** — 3A 用 **Web API**（標準 preset、`/compact`、resume）；Benchmark 用 **Headless**，但必須先通過等價性檢查（`system/message`、`request/header.tools`、catalog 與 Web/Standard 一致）；不通過則 Benchmark 也改用 Web API。H3 不採用。

**等價性檢查（H2 前置）**：在同一測試 Profile 下，各跑一個最小 session（Web/Standard vs Headless），比較 `system/message`、`request/header.tools` 名稱清單、skills catalog、persona prefix。若工具與 prompt 除 runtime context 外一致，才可把 H2 當自動化 harness；否則 Pilot 使用 H1。

### 14.4 Benchmark 生命週期

1. 在既有 `~/.dsh` 建立 `bm-bench-a`／`bm-bench-b` 測試 Profile（D6；從 shipped web 模板，不碰 `desktop`），安裝同一 tarball；Harness=Hybrid。
2. 使用已授權的兩個 repo（唯讀，D8）與一份 synthetic staged repo；記錄 commit／dirty 指紋並建立／確認索引（見 §16.3）。
3. 等價性檢查：Web/Standard vs Headless 的 `system/message`、`request/header.tools`、skills catalog；通過才用 Headless 跑 Benchmark，否則改用 Web API。
4. Pilot（§18）：3 任務 × 2 組 × 2 模型 = 12 次（≤3M）。
5. 完整（no-reuse）：6 任務 × 2 組 × 2 模型 = 24 次新跑；總上限 12M。
6. 評分與分析（§19–20），輸出報告。5. 評分與分析（§19–20），輸出報告。

---

## 15. A/B 控制變量

每次 A/B 任務保持以下項目完全相同，並記錄於結果表：

| 類別 | 控制項 | 確認方式 |
| --- | --- | --- |
| 版本 | Plugin commit（tarball SHA256）、BaseMind 版本與 source、DSH 版本 | `npm pack` SHA256、`/basemind-status`、`dsh --version` |
| 環境 | 同一 Profile 模板、同一模型 provider 與 model id、同一 reasoning effort、同一 Standard Preset、同一工具權限、同一 approval policy | `request/header.config`、profile dump |
| 專案 | 同一 repo、同一 commit、同一 cwd、同一 AGENTS.md（或無）、同一 `.gitignore` | `git rev-parse`、session header |
| 專案指示 | 同一 `AGENTS.md`／`AGENTS.local.md`／`basemind.toml`（SHA256 記錄）；A/B 相同 | `sha256sum`（2026-11-24 已記錄，見 §2.1） |
| 業務 repo 唯讀 | 執行前後 `git status --porcelain` fingerprint 一致；不得新增／修改任何檔案 | P3-25 |
| 索引 | 同一 `BASEMIND_DATA_HOME`（或同一份已建索引）、同一 `index_status` | 執行前後記錄 |
| Prompt | 逐字相同（含標點、任務要求、輸出格式） | prompt 檔 SHA256 |
| Session | 全新 session、不重用 | session id |
| 模型隨機性 | 同模型、同 effort；記錄 provider 與時間；不跨模型比較 | usage/session log |
| 干擾插件 | 關閉／不載入 Mnemon、其他 code-search 插件、長期記憶 | profile 清單 |
| 快取 | Prompt cache 由 provider 決定；記錄 input/cacheRead 分開；不強制清 cache；交錯順序平衡冷熱 | usage 欄位 |

**不得**：以同一 session 連續跑 A/B；以估算 token 當實際用量；以 BaseMind 自報 savings 當 API 節省；把不同模型差異歸因於插件。

---

## 16. Vue／Java 測試項目選擇

### 16.1 測試項目（已授權，唯讀）

| 類型 | 路徑 | 版本／規模 | 用途 | 備註 |
| --- | --- | --- | --- | --- |
| Vue 3 | `C:\01_aw_github\transmac-oms-fe` | `driver-server-admin-ui`；Vue 3.5.38；Element Plus 2.14.2；2,889 tracked；348 個 `.vue` | B2、B6 | 最大 SFC：`src/views/driverSchedule/arrangeSchedule.vue`（373,783 B）；`src/components/businessDrivingRecordQueryDialog/index.vue`（257,415 B） |
| Java | `D:\02_zengjunlin\github\transmac-oms` | Maven 多模組；7,705 tracked；5,334 `.java` | B1、B3、B4 | 候選大型類：`driverServApi/src/main/java/com/transmac/driverServ/service/driverSchedule/impl/EditScheduleServiceImpl.java`（291,243 B） |
| Synthetic | `$TEMP/bm-staged`（3C 建立） | 3–5 檔 | B5 | 只為 staged review，不涉及業務碼 |

**已知混淆因子（重要）**：兩個業務 repo 的 `AGENTS.md` 與 `AGENTS.local.md` 都要求「代碼理解與定位優先使用 basemind」；A/B 兩組都會載入同一份指示。因此 A 組不是「純原生工具 baseline」，而是「MCP-only ＋ repo 內建 BaseMind 指引」。結果必須解讀為插件 Bootstrap／Skills 的**增量效果**；若 A 組的 BaseMind 使用率已接近 B 組，需依 D17 追加 stripped-clone 對照（另需授權）。

### 16.2 上游能力邊界（必須納入 Ground Truth）

| 能力 | BaseMind 0.34.0 事實 | Benchmark 含意 |
| --- | --- | --- |
| Vue SFC 解析 | **沒有 Vue 專屬查詢**（`src/queries/` 無 `vue.scm`）；`.vue` 由 TSLP 偵測，落到通用 tags 或無查詢來源 | 不要設計「用 code_outline 找 Vue component 符號」的正確答案；Vue 任務應測 **fallback 與文字搜尋** |
| Vue template／script／style 分層 | 沒有 SFC 分解、沒有 injection；`<script setup>` 不會以 TS/JS 解析 | 同上 |
| Java 符號 | class/method/interface/enum/record/annotation/constructor/field 完整，且有 parity 測試 | B1／B3 可以 Java 為主 |
| Java method reference | `Foo::bar` 不產生 call site | Ground Truth 不得把 `::` 用法算成 caller |
| Java static import | 不支援跨檔解析 | 影響分析需排除此類呼叫 |
| Java 多模組 | source roots 固定（`src/main/java` 等），不探測 Maven/Gradle 多模組佈局 | 跨模組引用可能缺失；Ground Truth 以實際可解析者為限 |
| Git | git history／blame 可用；`git_diff` **無 cached/staged 語義** | B5 必須用原生 `git diff --cached`；不得把 whole worktree 當 staged |
| 文件 | `docs_search` 可用（需文件索引） | 可作可選擴展任務 |

### 16.3 索引與隔離

- 為 Benchmark 使用**獨立 `BASEMIND_DATA_HOME`**（暫存目錄），避免污染使用者索引；兩組共用同一份資料目錄以確保相同索引。
- 第一次索引：以同一個 BaseMind binary 在 repo 根執行 `basemind scan`（**這是測試設定步驟，不是產品行為**；產品 plugins 不自動 scan）。等待 `index_status` 的 `indexing` 不為 true。
- 每次執行前記錄 `index_status`；若索引重建中，暫停測試。
- 主要使用已授權的兩個路徑（唯讀）；只有 D17 的 stripped-clone 對照或需要凍結 commit 時，才在 `$TEMP` 建 `git clone --no-hardlinks` 副本（原目錄不動）。B5 使用獨立 synthetic repo。
- 已知環境風險：若 binary 與 `BASEMIND_DATA_HOME` 在不同磁碟，BaseMind comms daemon 可能以 `acquire daemon lock: 拒絕存取 (os error 5)` 失敗（本機歷史問題）；Benchmark 設定需把資料目錄放在與 binary 相同磁碟，或先以 3A 驗證。
- 不修改業務 repo 的任何檔案；不 commit 任何 benchmark 產物到公開 repo（除了可公開的 fixture 與匿名摘要）。

### 16.4 唯讀授權邊界

- **允許**：`read`／`grep`／`glob`、唯讀 Git（`rev-parse`／`status`／`log`／`show`／`diff`／`blame`）、BaseMind 讀取類工具、`index_status`；索引寫入只到**隔離的 `BASEMIND_DATA_HOME`**（不寫 repo）。
- **禁止**：修改／新增／刪除 repo 檔案；`git add`／`commit`／`push`／`tag`／`checkout`／`switch`／`branch`／`worktree`／`stash`；`npm install`／build／lint／formatter；對業務 repo 執行任何會寫檔的腳本。
- **允許的索引設定**：以同一個 BaseMind binary 對授權路徑執行 `basemind scan`（只寫隔離 data home）；若發現任何 repo 檔案變動，立即停止並回報，不自行 revert。
- 執行前後記錄 `git status --porcelain` 與 `git rev-parse HEAD`；兩者都不得改變（P3-25）。
- 若 D17 選擇 stripped clone，clone 只存在 `$TEMP`，原目錄完全不動。

---

## 17. 測試任務及 Ground Truth

### 17.1 六個核心任務

> 所有任務的 prompt 固定、存於 `benchmark/tasks/*.json`（不進 npm 包）。Ground Truth 由獨立 Reviewer（不是被測 Agent）以原生 Git／閱讀／腳本建立，存於 `benchmark/ground-truth/`，測試期間不提供給 Agent。

| ID | 任務 | 目標專案 | Prompt 要點 | Ground Truth 建立方式 | PASS 條件 | 不可接受 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | 符號定位（Java） | `transmac-oms` | 「找出方法 `<method>`（3C 凍結）的定義：檔案、行號、類別；列出 1–2 個直接呼叫者；不要修改任何檔案」 | `git grep -n` + 人工確認；多模組下以檔案內定義為準 | 檔案＋行號正確、類別正確、caller 至少 1 個正確 | 錯檔案／錯行／虛構 caller |
| B2 | 大型 Vue SFC 理解 | `transmac-oms-fe` | 「分析 `src/views/driverSchedule/arrangeSchedule.vue`：主要職責、核心 methods/computed、主要依賴、template 與 script 的關係；引用必要行號」 | 人工閱讀（373 KB SFC），列出 3 個核心項與 2 個依賴 | 3 個核心項正確、無虛構方法、依賴正確 | 把不存在的方法當事實；只抄檔頭註解 |
| B3 | 引用／影響分析（Java） | `transmac-oms` | 「分析 `<method>` 的呼叫者與可能受影響的模組；區分已確認與不確定」 | `git grep` + 人工檢視；排除 method reference／static import；多模組 source root 限制列入已知 | 至少 2 個正確 caller／模組；不確定性誠實標示 | 把 `::` 當呼叫；虛構呼叫者 |
| B4 | Git 歷史（Java） | `transmac-oms` | 「找出 `<file>` 中 `<method>` 最近 3 次相關變更：commit、日期、摘要、變更原因（若可推論），並說明符號歷史與檔案歷史的差異」 | `git log --follow -L :<method>:<file>`、`git log -S` | 3 個 commit SHA 正確、摘要與日期正確 | 虛構 commit／把檔案歷史當符號歷史 |
| B5 | Staged Changes Review | `bm-staged`（synthetic） | 「只審查已 staged 的變更，找出 Critical／Important 問題，提供 file:line、影響與最小修復；不要審查未 staged 或未追蹤的變更」 | 預先設計 3 個缺陷（off-by-one、null check、resource leak）＋1 個非缺陷＋1 個 unstaged 干擾變更 | 找出 ≥2 個真實缺陷、不誤報 unstaged、file:line 正確 | 把 unstaged 當 staged、漏掉 Critical、虛構問題 |
| B6 | Fallback（Vue SFC 限制） | `transmac-oms-fe` | 「在 `src/components/businessDrivingRecordQueryDialog/index.vue` 中找出 `<handler>` 的所有使用位置，並說明你用了哪些工具；若某工具沒有結果，說明原因並改用其他方式」 | `grep -rn` + 人工確認；已知 BaseMind Vue 結構化能力不足 | 最終位置正確、承認工具限制、沒有無限重試 | 反覆重試同一 BaseMind 工具；捏造結果 |

> `<method>`／`<handler>` 於 3C 凍結並記錄檔案 SHA256；Ground Truth 凍結後不得改動。註：兩個業務 repo 的 `AGENTS.local.md` 都會要求偏好 BaseMind（見 §16.1 混淆因子），A/B 兩組相同。

### 17.2 任務與專案分佈

- Java：B1、B3、B4（3 個）；Vue：B2、B6（2 個）；Synthetic：B5（1 個）。
- 若人工決定把 B4 換成 Vue 專案的檔案歷史，仍屬可接受（Git 能力與語言無關），但需在結果中註明。
- 可選擴展任務（Pilot 後再決定）：`docs_search`、`code_search`、deadcode／cycles、Java 跨模組呼叫鏈、CLI-only `code impact`。**不預先執行**。

### 17.3 Ground Truth 檔案格式（建議）

```json
{
  "id": "B1-java-symbol",
  "project": "bm-java",
  "prompt": "…",
  "required_elements": [
    { "kind": "file", "value": "src/main/java/…/X.java" },
    { "kind": "line", "value": 123, "slack": 0 },
    { "kind": "symbol", "value": "X.method" },
    { "kind": "ref", "value": "Y.java", "optional": false }
  ],
  "acceptable_alternatives": ["overload at L130 if the answer explains both"],
  "unacceptable": ["another module", "fabricated commit"],
  "scoring": { "pass_min": 3, "partial_min": 2 },
  "established_by": "reviewer+script",
  "evidence": "git grep / manual read on <sha>"
}
```

- Ground Truth 必須在 A/B 執行**之前**凍結（記錄 SHA256）；不得由被測 Agent 產生或修改。
- 評分時隱藏組別標籤（A/B），由獨立 Reviewer 或腳本按 rubric 評分。

---

## 18. Pilot Test 及 Token 預算

### 18.1 Pilot（12 次）

- 任務：B1（Java 符號）、B3（Java 引用）、B6（Vue fallback）。
- 設計：3 任務 × 2 組 × 2 模型 = **12 次**，每次獨立 session。
- 目的：驗證流程、usage 可取得、Ground Truth 有效、發現明顯工具路由問題、估算完整成本。
- 執行順序：交錯（例如 DeepSeek A→B→A→B；GPT 反向），並記錄順序。

### 18.2 完整（24 次，no-reuse）

- 6 任務 × 2 組 × 2 模型 = **24 次新跑**；Pilot 的 12 次**不重用**。
- 本次總量 = Pilot 12 ＋ 完整 24 = **36 次任務執行**。
- D18 已批准；總上限 **12M tokens**。

### 18.3 Token 預算（估算，非報價）

以本機既有 Desktop session 的 usage 為參考（input 多為 cache hit；uncached input 每步數百至數千 tokens；output 每步數百至數千），單次任務估計如下（**估算，不是實測**）：

| 情境 | 每輪總 tokens（估） | 12 輪 Pilot | 24 輪完整（新跑） |
| --- | --- | --- | --- |
| 小任務（B1/B5/B6，4–8 steps） | 60k–180k | 0.7M–2.2M | 0.7M–2.2M |
| 大任務（B2/B3/B4，8–15 steps） | 120k–350k | — | 1.4M–4.2M |
| 小計 | — | 0.7M–2.2M | 2.1M–6.4M |
| 加上重試／失敗重跑（+20–30%） | — | 0.9M–2.9M | 2.5M–8.3M |
| 3A 驗收（短 turn＋compaction） | — | 0.1M–0.3M | — |
| **合計** | — | **1.0M–3.2M** | **3.5M–11.5M** |

- **上限**：3A ≤0.3M；Pilot ≤3M；完整 ≤8.7M；全程 ≤**12M**。超過即停止並回報，不自動加預算。
- **每次 run ≤400k tokens**；單次超過即中止該 run 並記錄。
- GPT（Codex subscription）與 DeepSeek 的計價方式不同：前者可能無 per-token 帳單但有速率限制；後者按實際 usage 計價。**本計畫不虛構單價**；結果表分開列出。
- 不使用 LLM judge 評分（避免額外 token 與偏差）；用規則式＋人工抽樣。
- 每次 compaction 的摘要呼叫已含在 3A 的 0.1M–0.3M。

### 18.4 成本控制規則

- 先 Pilot，Pilot gate 通過才跑完整 24（no-reuse）。
- 每個任務只跑一次 A/B；只有「A/B 結果矛盾」「模型輸出波動明顯」「關鍵正確性退化」「接近需要更可靠判斷」才加跑；加跑也計入 12M。
- 不在同一 session 重跑；不重複呼叫已成功的驗證。
- 任何未經授權的付費模型呼叫都不得執行；本計畫在 Execution 前不執行任何模型呼叫。

---

## 19. 正確性評分方式

### 19.1 評分等級

| 等級 | 定義（依 Ground Truth） |
| --- | --- |
| **PASS** | 所有必要元素正確；無虛構；無越界；回答可被 Ground Truth 直接驗證 |
| **PARTIAL** | 核心答案正確，但缺少 1 個非關鍵元素或有 1 個非重大錯誤；無虛構 |
| **FAIL** | 缺關鍵元素、錯誤檔案／符號／commit、虛構證據、越過 Scope、誤讀其他 repo、或未完成 |

### 19.2 記錄欄位（每輪）

- 任務 ID、組別（A/B，評分時隱藏）、模型、effort、session id、開始／結束時間。
- 必要元素逐項 ✓／✗（檔案、行號、符號、引用、commit、缺陷）。
- 虛構內容（有／無）、越界（有／無）、其他 repo 誤讀（有／無）。
- 任務是否完成、是否需人工重導。
- Reviewer 備註（最多 3 行）。

### 19.3 判定規則

- 正確性優先：B 組不得在任一任務由 PASS 退為 FAIL；若出現，先查是否為插件造成（Skills／Bootstrap／路由），不得直接歸因模型。
- 不以工具使用率當成功標準；A 組即使不用 BaseMind 但正確，也是有效結果。
- Vue 的上游解析限制（Task H 的 A/B 類）不得記為插件缺陷；但 Agent 若因錯誤引導反覆重試，則屬 D 類（指引缺陷），需記錄。
- 評分前不得知道組別；同一 Reviewer 對同一任務的 A/B 使用同一 rubric。

---

### 19.4 失敗分類（Task H 要求）

每個 FAIL／PARTIAL 都必須歸類，避免把上游限制記成插件缺陷：

| 類別 | 定義 | 例 |
| --- | --- | --- |
| A. 上游語言解析限制 | BaseMind parser／grammar 不支援 | Vue SFC 的 template 符號、`<script setup>` 綁定 |
| B. 上游搜尋／索引限制 | grammar 有但查詢／索引不完整 | Java method reference 不成為 call site、static import 無跨檔解析、多模組 source root |
| C. 插件 MCP／CLI 路由缺陷 | 插件把呼叫送到錯 workspace／binary、CLI 被錯誤拒絕 | root 混用、CLI allowlist 誤擋 |
| D. Skills／Bootstrap 指引缺陷 | 文字誤導導致選錯工具或反覆重試 | 指向不存在的工具、錯誤的 fallback 指示 |
| E. 模型工具選擇／參數錯誤 | 指引正確但模型選錯或參數錯 | 用 `code_read` 讀不存在的 symbol、路徑寫錯 |
| F. 測試環境／權限／索引狀態 | index 未就緒、權限、daemon 不可用 | `index_status.indexing=true`、cross-drive daemon lock |

- A／B 類：只在報告記錄，不以 DSH 私有解析邏輯修補；插件只需提供正確 fallback 指引。
- C／D 類：進入 §21 的修復評估；E 類：記錄並在後續 prompt 設計中避免；F 類：重跑或修正環境。

---

## 20. Token、工具調用及耗時指標

### 20.1 資料來源與語義

- **Session log**（`$DSH_HOME/sessions/<project>/<session>/session.v4.jsonl.zstd`）：
  - 格式為**多個 zstd frame**串接，每個 frame 含 JSONL 行；需逐 frame 解壓（Node 24 `zlib.zstdDecompressSync` 只解第一個 frame）。本次已用此方法取得真實 session 的 usage（B）。
  - `assistant/message.usage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens }`。
  - **實測關係**：`totalTokens = inputTokens + outputTokens + cacheReadTokens`（例：706 + 315 + 505,216 = 506,237）。**inputTokens 不含 cacheReadTokens**，不得重複相加。
  - `request/header.tools` 提供每次請求的完整 tool schema（可量大小與名稱）。
  - `system/message` 提供精確 system prompt；`user/message` 的 `source.kind` 可辨識 skills catalog。
- **供應商 usage**：以 session log 的 `usage` 為第一來源；若 provider 另回 `reasoningTokens`／`cachedInputTokens` 等欄位，需先確認語義再記錄，避免重複計算。GPT／Codex 的欄位語義在 Pilot 前確認。

### 20.2 工具指標（每輪）

| 指標 | 來源 |
| --- | --- |
| BaseMind MCP calls | `tool/call` 的 name 前綴 `mcp__basemind__`（不含 `__cli`） |
| BaseMind CLI adapter calls | `mcp__basemind__cli` |
| Skills load 次數 | `tool/call` name = `skill`，且 args.name 以 basemind 開頭 |
| 原生 Read／Grep／Glob／Bash（或 pwsh） | 對應 tool name |
| Tool errors | `tool/result` 的 `isError`／throw |
| 無效／重複呼叫 | 連續相同 name+args；或錯誤後立即重試同工具 ≥3 次 |
| Fallback 次數 | 在 BaseMind 空結果後改用原生工具（人工＋序列判定） |
| 全文讀取次數 | `read` 讀整檔（>200 行或無 offset/limit） |
| 工具呼叫總數 | 每輪所有 `tool/call` |

### 20.3 Token 指標（每輪、每組、每模型）

- Input（uncached）、Cache read、Cache write、Output、Total。
- System prompt bytes、tool schema bytes、skills catalog bytes、載入的 skill 正文 bytes。
- 工具回傳內容 bytes（`tool/result`）。
- BaseMind 自報 `estimated tokens saved` **單獨一欄**，不得當實際節省。

### 20.4 時間指標

- 任務總耗時：`turn/start` → `turn/end`（或第一次 user message → 最後 assistant message）。
- 模型推理時間：若 usage/事件可取得；否則標 N/A。
- MCP tool 耗時、CLI tool 耗時（`tool/call` → `tool/result` 時間戳）。
- Skills load 耗時、Relay 初始化耗時（首次 vs 暖）。
- 工具重試／錯誤等待時間。
- 冷啟動（新 process、首次 relay）與已建立 relay 分開記錄。

### 20.5 比較表與公式

| 指標 | Group A | Group B | 差異 |
| --- | --- | --- | --- |
| 正確性（PASS/PARTIAL/FAIL） | | | |
| Input tokens（uncached） | | | |
| Cached input tokens | | | |
| Output tokens | | | |
| Total tokens | | | |
| BaseMind MCP calls | | | |
| BaseMind CLI calls | | | |
| 原生工具 calls | | | |
| Tool errors | | | |
| 任務耗時 | | | |

- 節省率 = `(A − B) / A`，僅當 A 與 B 都有可比較數值且 A ≠ 0；否則 **N/A**。
- 成本比較需用當時實際單價（含 cache 單價），不以 token 數直接當費用。
- 不輸出無意義百分比（基線為 0 或資料不可取得時標 N/A）。

---

## 21. 候選 Runtime 修復及必要性

> 規則：每個修復都必須有實際缺陷證據。沒有證據的標「待驗證」，不提前承諾修改。

| ID | 問題／證據 | 根因 | 影響檔案 | 最小方案 | 風險 | 針對性測試 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **F1** | Relay 意外退出後不恢復：`onClose` 只 log（[index.js:173-177](../index.js#L173-L177)）；pool 保留死 session（[workspace-pool.js:139-181](../lib/workspace-pool.js#L139-L181)）；readiness 不翻 false | 沒有「非預期關閉」的池清理與 primary 重初始化 | `index.js`、`lib/workspace-pool.js`、`test/index.test.mjs`（或新 test） | 3B 先重現；方案 A：`forget(root)` 惰性重建；方案 B：primary 關閉時 readiness→false + `ensurePrimary()` | 重初始化風暴（用既有 backoff 限制）、catalog 短暫消失 | 新 test：終止 fake relay 後下一次呼叫成功；連續終止 2 次仍成功；不重複註冊 | **待重現 → 若重現則必修（需授權）** |
| **F2** | Bootstrap 說「read/grep/glob/bash」，但 Windows Standard Preset 的 shell 工具是 `pwsh`（shipped config：`tool-bash` 在 win32 disabled、`tool-pwsh` 反之） | 文字用語泛化 | `lib/prompt/bootstrap.js`、`test/bootstrap.test.mjs` | 改成「the harness's own file and shell tools」或「read/grep/glob and its shell」 | 極低（文字） | 更新既有 bootstrap 測試斷言 | **建議修（需授權，低優先）** |
| **F3** | `managed-binary.yml` job-level `env` 使用 `runner.temp` → GitHub 拒絕整個 workflow（run `45373407690`） | job env 不允許 `runner` context | `.github/workflows/managed-binary.yml`、`test/workflows.test.mjs`、`scripts/phase3/d1-remote.mjs` | D1a：移除 job env（step 以 `$GITHUB_ENV` 寫入）；GitHub API 遠端 commit 到 `phase3/d1-managed-workflow-fix`＋PR；不 merge；merge 後 dispatch `main`；3B 補靜態守衛 | branch protection／token 權限；PR 未 merge 前無法完整 dispatch | `test/workflows.test.mjs`＋PR syntax 驗證＋dispatch | **必修（D1=C1 已授權）** |
| **F4** | Skills 文字仍有 `/bm-stats`（3 次）、`/bm-scan`（1 次）；DSH 只認 `/skill-name` 手勢 | 上游文字 + 部分適配 | `skills/.dsh-adapt.json` → `skills/**`（同步產生） | 擴充 adapt 規則移除 DSH 不需要的 `/bm-*` 提及（**不新增命令**） | 文字變更需重新同步與 `check:skills`；屬 Deferred 邊界 | `npm run check:skills` + 人工校對 | **不做（Deferred；僅記錄）** |
| **F5** | `basemind-comms`／`basemind-multi-agent-room` 假設 `agent_post`／`agent_inbox`／`agent_threads` 存在；0.34.0 將它們列為 deferred，若未暴露則 skills 指向不存在的工具 | skills 只按 binary verified gating，未按工具存在性 | `lib/skills/provider.js`（可選） | 目前**不改**；若 3A 實測發現 agent tools 缺席，再考慮按 `tools/list` 過濾 2 個 skills | 需要 provider 感知 tool 清單，複雜度上升 | 3A 用 fake server 省略 agent tools 驗證 | **待驗證；預設不做** |
| **F6** | `syncTools()` 成功後未 `readiness.notify()` | 無 | — | 不需要（catalog 不依賴工具名） | 無 | — | **不需要修（本次源碼分析結論）** |
| **F7** | 文件不一致：README DSH 版本、測試數字、重複段落 | 文件落後 | `README.md`、`README.zh.md`、`CHANGELOG.md` | 3E 一併更新 | 無 | 人工校對 | **文件修正（非 Runtime）** |

**各修復的預期改善**

- **F1**：Relay 意外死亡後，下一次呼叫能自動重建 relay（或由 primary 重初始化恢復），不必重啟整個 DSH；錯誤只影響該 workspace，不長期宣稱工具可用。
- **F2**：Windows 上的 fallback 指引不再指向不存在的 `bash`，降低一次無效工具呼叫。
- **F3**：`managed-binary.yml` 可被 GitHub 接受並排程，release 的 `managed-gate` 才有機會成立。
- **F4**：Skills 不再提示 `/bm-*`（若人工決定處理），減少使用者照著輸入卻無效果的情況；不新增命令。
- **F5**：若 agent tools 確實可能缺席，skills 不再教 Agent 呼叫不存在的工具（預設先觀察，不急著改）。

**明確不修**：Workspace Pool 重寫、Binary Manager 重寫、MCP Bridge 重寫、Skills Provider 大規模重寫、per-agent Binary Manager、高頻健康檢查、每次 tool call spawn CLI、每個請求重跑 `index_status`。

---

## 22. 文件級修改矩陣

| 階段 | 檔案 | 動作 | 內容 | 進包？ |
| --- | --- | --- | --- | --- |
| 3A | `docs/2026-11-24-basemind-agent-effectiveness-plan.md` | 新增（本檔） | 本計畫 | ❌ |
| 3A | 暫存目錄（不進 repo） | 新增 | session log、截圖、量測輸出 | ❌ |
| 3B | `.github/workflows/managed-binary.yml` | 修改 | F3 最小修復 | ❌ |
| 3B | `test/workflows.test.mjs` | 修改 | 新增 job-level env 禁 `runner` context 的靜態守衛 | ❌ |
| 3B | `test/readiness-recovery.test.mjs`（或 `test/index.test.mjs`） | 新增／修改 | F1 重現與修復後回歸 | ❌ |
| 3B | `lib/workspace-pool.js` | 修改（僅 F1 若重現） | `forget(root)`（只刪 entry，不 close） | ✅ |
| 3B | `index.js` | 修改（僅 F1 若重現） | `onClose` 清理；primary 重初始化；不新增常駐 timer | ✅ |
| 3B | `lib/prompt/bootstrap.js`、`test/bootstrap.test.mjs` | 修改（僅 F2 若授權） | 措辭修正 | ✅ |
| 3B | `skills/.dsh-adapt.json`、`skills/**` | 不改（F4 Deferred） | — | ✅ |
| 3C | `benchmark/README.md`、`benchmark/tasks/*.json`、`benchmark/ground-truth/*` | 新增 | 任務、Ground Truth、操作說明 | ❌ |
| 3C | `scripts/benchmark/collect-usage.mjs` | 新增 | 解析 session log（多 frame）→ JSON/CSV | ❌ |
| Phase 0／3C | `scripts/phase3/*`（含 `d1-remote.mjs`） | 新增 | profiles、Web API session driver、compaction、fingerprint、scoring、D1 遠端 commit | ❌ |
| 3C | `scripts/benchmark/run-headless.mjs`（僅 H2 獲准） | 新增 | 一鍵跑 headless 任務 | ❌ |
| 3D | `docs/2026-11-24-basemind-agent-effectiveness-benchmark-results.md` | 新增 | 匿名化結果與分析 | ❌ |
| 3E | `docs/2026-11-24-basemind-agent-effectiveness-report.md` | 新增 | Execution Report | ❌ |
| 3E | `README.md`、`README.zh.md`、`CHANGELOG.md` | 修改 | F7＋本次驗證結果（只寫已驗證事實） | ✅（README/CHANGELOG） |

- `package.json` 的 `files` 白名單不變；`benchmark/`、`scripts/`、`test/`、`docs/` 不會進 npm 包。
- 任何產品檔案修改都必須先經人工 Review；本階段（Planning）不改任何產品檔案。

---

## 23. 分階段實施步驟（3A–3E）

**交接順序**：Execution Agent 全自動執行 Phase 0（harness＋token gate）→ D1a（遠端 commit／PR）→ 3A → 3B → 3C → 3D → 3E；機器 gate 見 §30.7。PR merge 仍由人完成；D1b（merge 後 dispatch）可在 merge 後任意時點插入，不阻塞後續階段。

### Phase 3A：Lifecycle Investigation（D12 已批；少量模型呼叫另計）

**產出**：調查報告（可併入本檔附錄或另存）、可重現的 session log、問題清單、F1 是否重現的結論。

| 步驟 | 內容 | 完成條件 |
| --- | --- | --- |
| 3A-1 | 建立 `bm-bench-a`／`bm-bench-b`（既有 `~/.dsh`，D6；shipped web 模板；A 組 `skills/bootstrap/cliTool=false`；不碰 `desktop`）；安裝 0.2.0 tarball；確認 `GH_TOKEN` 可見 | `--dump-config` 顯示 row、無 MCP row、patch `[]`；`GH_TOKEN=set` |
| 3A-2 | 啟動隔離 web 實例（D7）；用 Web API 建 session；在授權 repo 確認工具、skills catalog、bootstrap | session log 有 15 verb tools（+3 agent）、catalog、bootstrap |
| 3A-3 | Session resume：API 重開／`--session-id`；比較 prompt 與工具 | 不重複、不丟失；root 正確 |
| 3A-4 | Compaction：Web API `commands.execute('/compact')`；C1/C3/C4 記錄 | bootstrap 仍在；catalog 重發；工具可用；無累積 |
| 3A-5 | Relay 終止：R1／R2；記錄是否恢復 | 預期 F1 重現；保存 log |
| 3A-6 | Subagent：D13 風格；確認工具／skills／Bootstrap／cwd | 父／子互不污染 |
| 3A-7 | Prompt／usage 量測：session log 解析；catalog／instructions／bootstrap bytes | 數據可重現 |
| 3A-8 | Vue／Java 邊界實測：隔離 data home 建索引；測 `code_outline`／`code_symbols`／`code_refs`／`code_grep` | 記錄支援／不支援；repo 唯讀 |
| 3A-9 | 等價性檢查：Web/Standard vs Headless 的 prompt／tools／catalog | 一致→Benchmark 用 Headless；不一致→用 Web API |
| 3A-10 | 業務 repo 指紋：執行前後 `git status`／HEAD | 與 §2.1 一致（P3-25） |

**Gate 3A**：P3-03～P3-18 有證據；F1 是否重現已有結論；repo 指紋不變；成本 ≤3.3M。

### Phase 3B：Deterministic Verification

- 修 F3 的靜態守衛（workflow 本體已在 D1a 修；3B 只補 `test/workflows.test.mjs`）。
- 為 F1 寫重現測試；重現則依 D2 用最小方案 A，不重現則只保留測試或標記 skip。
- 修 F2（D3 已授權）bootstrap 措辭並更新測試。
- 執行：`node --test test/<target>.test.mjs`、`npm run check`、`npm run check:skills`、`npm test`。
- **不重跑**已通過且未受影響的 Managed Binary 下載測試。

**Gate 3B**：測試綠；diff 只含授權檔案（workflow、test、bootstrap 文字、F1 若重現）；無無關變更；不 commit。Diff 最終仍交人 Review；機器 gate 只確認範圍與測試。

### Phase 3C：Benchmark Pilot（Pilot 上限 3M）

- 建 benchmark 任務／Ground Truth／usage 收集腳本；依 3A-9 決定 Harness。
- 跑 12 次 Pilot（順序交錯）；記錄成本。
- 檢查：流程可行、usage 可取得、Ground Truth 有效、是否有明顯工具路由問題。

**Gate 3C**：正確性無 PASS→FAIL；成本 ≤3M；流程可重跑；無大量 tool error／重試。

### Phase 3D：Effectiveness Evaluation（24 次，no-reuse；上限 8.7M）

- 完成 24 次新跑；分模型、分專案、分任務統計。
- 分析正確性、Token、工具、耗時、上游限制。
- 如實記錄「未改善」的類別（例如 Vue SFC）。
- 產出匿名化結果文件。

**Gate 3D**：24 次完成；總成本 ≤12M；B 組無 PASS→FAIL；資料可重跑。

### Phase 3E：Final Verification

- 必要回歸：`npm test`、`npm run check`、`npm run check:skills`、`npm run check:pack`；受影響時才跑 integration。
- 補完 Desktop 驗收清單（至少 D6/D9/D10/D11；其餘能跑就跑）。
- 更新 README／CHANGELOG 的已驗證範圍（只寫實測）。
- 輸出 Execution Report；等待人工 Review。
- **不** commit／push／tag／publish；PR 不 merge。

---

## 24. 自動化測試及人工驗收矩陣

| 驗證項目 | 自動化（deterministic） | 真實 Desktop／Agent | 模型 Benchmark |
| --- | --- | --- | --- |
| Skills 註冊／catalog 形狀 | ✅ 既有 `test/skills.test.mjs`、`test/index.test.mjs` | 觀察 catalog 文字 | — |
| Skill 正文載入 | 契約測試（`get()`） | ✅ D9/D10；載入正文並執行 | 觀察是否載入 |
| Bootstrap 內容／去重／穩定性 | ✅ `test/bootstrap.test.mjs` | 觀察 system message | — |
| Bootstrap 不被 compaction 影響 | 契約＋source 證據 | ✅ C1–C4 `/compact` | — |
| Session Resume | 契約 | ✅ GUI 重開／`--session-id` | — |
| Relay readiness／恢復 | ✅ fake relay 終止測試（3B 新增） | ✅ R1/R2 真實終止 | — |
| Workspace 路由 | ✅ 既有 pool／index 測試 | ✅ D11/D12 | 觀察跨 repo 誤讀 |
| Subagent | 契約 | ✅ D13 | — |
| 插件停用／卸載 | ✅ 既有 lifecycle 測試 | ✅ D15 | — |
| 工具選擇效果／正確性 | — | — | ✅ Pilot／完整 |
| Token／耗時 | — | 可從 session log 取 | ✅ |
| Compaction 成本 | — | ✅ 一次摘要呼叫 | — |

**不得**以 Mock Agent 的 deterministic 行為替代模型 Benchmark；也不得以 Benchmark 結果替代 Runtime 正確性測試。

---

## 25. 性能及安全風險

| 風險 | 影響 | 機率 | 緩解 |
| --- | --- | --- | --- |
| Group B 固定 prompt 增量 ~6 KB（≈1.5k tokens） | 每請求多一點成本；cache hit 後較低 | 高 | 以 cacheRead 與 uncached 分開記錄；不以總量直接判定 |
| Skill 正文載入（3–19 KB） | 單次任務 token 上升 | 中 | 只在需要時載入；Benchmark 記錄載入次數 |
| Compaction 摘要呼叫 | 額外成本／延遲 | 中 | 每個模型最多 1 次；記錄 usage |
| F1 修復造成重初始化風暴 | 工具短暫不可用、catalog 抖動 | 低 | 沿用 backoff；只對非預期關閉；測試連續終止 |
| Relay 重複 spawn | 資源洩漏 | 低 | pool de-dup＋dispose 測試 |
| F3 修好後暴露下一個 workflow 錯誤 | CI 仍紅 | 中 | 修完立即 dispatch 驗證；每次只做最小 diff |
| Benchmark 資料含敏感內容 | 隱私／合規 | 中 | 只公開匿名摘要與 fixture；session log 不進 repo；業務 repo 需授權 |
| 憑證外洩 | 安全 | 低 | 不複製 secrets；不把 `settings`/token 寫入報告；session log 只在暫存 |
| 業務 repo 被修改 | 汙染／違反授權 | 低 | 全程唯讀；前後 fingerprint（P3-25）；B5 用 synthetic repo；`scan` 只寫隔離 data home |
| 業務 repo 的 `AGENTS.local.md` 要求偏好 basemind | A 組不是純 baseline，效果可能被低估 | 高 | A/B 相同並記錄；依 D17 決定是否追加 stripped-clone 對照 |
| Java 多模組／5,334 `.java` | 索引時間長、跨模組 refs 可能缺失 | 中 | 先建索引並記錄時間；Ground Truth 只納入可解析者；不重複 rescan |
| 373 KB 的 Vue SFC | 單檔超出工具／context 上限 | 中 | B2 以分段讀取與摘要為評分對象；記錄工具錯誤 |
| Java repo 有 untracked 文件 | 索引／`git status` 與乾淨 clone 不同 | 低 | 記錄 fingerprint；不刪不改；Ground Truth 以 HEAD 為準 |
| BaseMind data home 與 binary 跨磁碟 | daemon lock 失敗（歷史問題） | 中 | 測試資料目錄與 binary 同磁碟；先做 3A-8 |
| DSH 版本漂移 | 契約改變 | 中 | 固定 0.2.2-rc.5；升級另案 |
| Benchmark 汙染（Mnemon、其他插件） | 混淆因果 | 中 | 測試 Profile 只載入必要插件；記錄 profile |
| 模型服務排隊／速率限制 | 耗時波動 | 中 | 交錯順序；記錄時間；不把網路差異歸因插件 |
| `GH_TOKEN` process env stale／401／403 | D1a 無法遠端 commit | 中 | 已改讀 User env（§30.5）；`GET repo` 200 已驗證；401／403 即停 |
| PR 未 merge 導致 D1b 無法 dispatch | CI 證據延後 | 中 | 3A–3E 照跑；D1b 標 PENDING；merge 後補 |
| Web API spike 失敗 | 3A 無法自動 `/compact` | 中 | 降級 Headless（需接受 3A-4 NOT RUN）或改 CDP；停下回報 |
| Codex provider 在新 Profile 無法登入 | GPT 半邊跑不起來 | 中 | 3A-1 先驗證；失敗則停下，不改用其他模型 |
| 12M／no-reuse 接近上限 | 完整 24 可能中止 | 中 | per-run 400k；Pilot 後重新估算；超限即停 |

---

## 26. 已確認決策（2026-11-24 第二輪定稿）

> 2026-11-24 第二輪確認：**GitHub=C1、Harness=Hybrid、Budget=12M/no-reuse、全自動執行**。D1–D19 全部定案；PR merge 與最終 Review 仍由人完成。

| ID | 決策 | 結果（2026-11-24） | 執行備註 |
| --- | --- | --- | --- |
| **D1** | 修 F3（CI workflow）並取證據 | **已授權 C1**：Agent 用 GitHub API 遠端 commit 到 `phase3/d1-managed-workflow-fix`、開 PR 到 `main`；**不 merge** | 只改 `.github/workflows/managed-binary.yml`；`GH_TOKEN` 從 env 讀；PR 後由人 merge；merge 後 Agent dispatch `main` |
| **D2** | F1 readiness 修復範圍 | **已授權 (b)**：3B 先重現；重現後用最小方案 A；若 primary 需要恢復 readiness 再加 B | 未重現則不改 Runtime |
| **D3** | 修 F2（bootstrap 的 `bash` 措辭） | **已授權 (a)**：修文字 | 更新 `test/bootstrap.test.mjs` |
| **D4** | F5（agent tools 缺席） | **已確認 (a)**：3A 先驗證再決定 | 預設不改 |
| **D5** | F4（Skills 內 `/bm-*` 文字） | **已確認 (a)**：保留（Deferred） | 不改 skills |
| **D6** | 測試 Profile | **已確認 (a)**：既有 `~/.dsh` 新增 `bm-bench-a/b` | 不碰 `desktop` |
| **D7** | GUI 驗收 | **已確認 (a)**：隔離 web 實例 | 不碰 Desktop app |
| **D8** | 測試專案 | **已確認**：Vue `C:\01_aw_github\transmac-oms-fe`；Java `D:\02_zengjunlin\github\transmac-oms`；唯讀 | 不改程式碼、不提交 |
| **D9** | 索引隔離 | **已確認 (a)**：獨立 `BASEMIND_DATA_HOME` | 同磁碟 |
| **D10** | Harness | **已確認 Hybrid**：3A 用 Web API；Benchmark 用 Headless，需先過等價性檢查；否則用 Web API | 等價性見 3A-9 |
| **D11** | 模型與 effort | **已確認**：3A-1 probe 凍結；DeepSeek 預期 `deepseek-flash`／`max`；GPT 用 Codex subscription 當下 planning 模型 | 不硬編產品 |
| **D12** | 預算 | **已確認 12M／no-reuse**：Pilot 12（≤3M）＋完整 24 新跑（≤8.7M）＋3A（≤0.3M）；per-run ≤400k | 超限即停 |
| **D13** | 結果公開 | **已確認 (a)**：匿名摘要＋fixture | 完整 log 留本機 |
| **D14** | Phase 2 Review | **已確認 (a)**：不補 | 3E 一併 Review |
| **D15** | Desktop 驗收 | **已確認 (a)**：先做阻擋項 | 其餘 3E 補 |
| **D16** | 停點 | **已確認：全自動**；只在 PR merge、gate 失敗、預算上限、`GH_TOKEN` 不可見、repo 指紋變動時停 | 最終 diff 仍人工 Review |
| **D17** | `AGENTS.local.md` 混淆 | **已確認 (a)**：保留（兩組相同） | (b) 需另授權 |
| **D18** | 完整 24 次 | **已批准**：no-reuse，總上限 12M | 與 D12 一致 |
| **D19** | GPT model id／effort | **已確認**：3A-1 probe 凍結 | 你日後指定則從其指定 |

### 26.1 授權狀態（給 Execution Agent）

- **立即授權**：Phase 0 harness；D1a 遠端 commit／PR／syntax 驗證；3A-1～3A-10；3B 測試與 F1/F2 最小修復；3C Pilot（≤3M）；3D 完整 24（no-reuse，總 ≤12M）；3E 報告。
- **仍由人做**：PR merge；最終 Review；任何 local commit／push／tag／publish。
- **Gate 0 已驗證**：User 環境 `GH_TOKEN` 可讀、`GET /repos` 200；`ops_bash` process env stale，harness 依 §30.5 從 User 變數讀取。
- **禁止**：local `git commit`／`git push`／`git merge`；直接改 `main`；改其他檔案；force push；tag／release；Desktop 生產 profile；業務 repo 寫入。

---

## 27. 回滾方案

| 項目 | 回滾方式 |
| --- | --- |
| 產品程式碼修改（F1/F2） | `git revert <commit>`（由使用者執行）；或 `git checkout -- <file>`；先保存 diff 與測試證據 |
| F3 workflow 修復 | 還原單一檔案；不影響產品 runtime |
| 測試 Profile | `dsh plugin --profile bm-bench-a remove dsh-basemind-plugin`；刪除 `~/.dsh/profiles/bm-bench-a`、`bm-bench-b`；不動 `desktop` |
| 測試實例 | 停掉進程；確認無殘留 `basemind serve`；刪除暫存 DSH_HOME／repo 副本／managed cache（僅測試目錄） |
| Benchmark 產物 | 全部在 `$TEMP`／`benchmark/`；刪除即可；不進 Git 的 session log 不提交 |
| 索引／資料 | 使用獨立 `BASEMIND_DATA_HOME`；結束刪除；不動使用者全局 index／memory |
| 文件 | 本計畫與報告皆為新增檔；刪除即可；README/CHANGELOG 修改可用 `git checkout` 還原 |
| Release 相關 | 不執行任何 version／tag／publish；若日後 release 失敗，依 `docs/upstream-sync.md` 與 Phase 2 程序處理 |

回滾後必檢：
- `~/.dsh/profiles/desktop` 未被修改（`git`/檔案時間與內容比對）。
- 無殘留 `basemind serve` 指向測試目錄。
- `dsh-basemind-plugin` 套件版本與 profile 設定回到原狀。
- 使用者全局 BaseMind cache／index 未被刪除。

---

## 28. Phase 3 驗收 Checklist

> 判定用語：**PASS／FAIL／NOT RUN**。沒有實際證據不得寫 PASS。每個項目都需附 session id、log 位置或命令輸出。

| # | 項目 | 判定標準 | 方法 | 結果 |
| --- | --- | --- | --- | --- |
| P3-01 | 前置：managed workflow 有效 | D1a：PR 已開、push 後無 `Invalid workflow file`、local test 綠；D1b：merge 後 dispatch 成功 | GitHub Actions／PR | NOT RUN |
| P3-02 | 前置：Phase 2 文件缺口 | README 版本／測試數／重複段落修正 | 人工 | NOT RUN |
| P3-03 | Skills catalog 可見 | 真實 Agent 看到 10 個 `basemind*` skills（name+description） | 3A-2 | NOT RUN |
| P3-04 | Skill 正文可載入 | `skill` 工具或 `/basemind-code-search` 載入正文並可用 | 3A-2 | NOT RUN |
| P3-05 | Bootstrap 段存在且穩定 | system message 含 bootstrap；同一 session 多輪不累積 | 3A-2／3A-7 | NOT RUN |
| P3-06 | Prompt 成本可量測 | instructions／bootstrap／catalog／schemas bytes 與 usage 可取得 | 3A-7 | NOT RUN |
| P3-07 | Session resume（GUI） | 重開後工具／skills／bootstrap 仍正確、不重複 | 3A-3 | NOT RUN |
| P3-08 | Session resume（process） | 新 process 使用同一 session，路由與 binary 正確、不重下載 | 3A-3 | NOT RUN |
| P3-09 | Compaction 前後引導 | `/compact` 後 bootstrap 仍在、catalog 重發、工具可用 | 3A-4 | NOT RUN |
| P3-10 | 連續 Compaction | 2–3 次不累積、不重複註冊、無 relay 洩漏 | 3A-4 | NOT RUN |
| P3-11 | Relay R1（primary） | 終止後可恢復（或已重現 F1 並修復） | 3A-5／3B | NOT RUN |
| P3-12 | Relay R2（secondary） | 只影響該 workspace，其他正常；可重建 | 3A-5／3B | NOT RUN |
| P3-13 | Relay R3（daemon 不可用） | 有界 retry、可 fallback、恢復後可用、不停用戶 daemon | 3A-5 | NOT RUN |
| P3-14 | Tools list 變更（R4） | generation 正確替換、無重複、resources 正常 | 3B fake server | NOT RUN |
| P3-15 | 多 Session 隔離 | A/B 不互相讀取；切換 cwd 正確 | 3A-6 | NOT RUN |
| P3-16 | Subagent | 工具／skills／bootstrap 正確、cwd 正確、不污染父 | 3A-6 | NOT RUN |
| P3-17 | 插件停用／重載 | surface 全部消失／恢復、無殘留 relay、cache 保留 | 3A-6／Phase 2 D15 | NOT RUN |
| P3-18 | 上游邊界已記錄 | Vue／Java 實際能力與限制有實測證據，Ground Truth 已校正 | 3A-8 | NOT RUN |
| P3-19 | Pilot 完成 | 12 次 Pilot 完成，usage／正確性可評分，成本 ≤3M | 3C | NOT RUN |
| P3-20 | 完整 Benchmark | 24 次新跑（no-reuse）完成，分模型／專案／任務分析，總 ≤12M | 3D | NOT RUN |
| P3-21 | 正確性無退化 | B 組無任一任務由 PASS 退 FAIL | 3D | NOT RUN |
| P3-22 | 回歸測試 | `npm test`、`check`、`check:skills`、`check:pack` 綠 | 3E | NOT RUN |
| P3-23 | Desktop 驗收 | 至少 D6/D9/D10/D11 PASS；其餘有證據或 NOT RUN | 3E | NOT RUN |
| P3-24 | 報告與停點 | Execution Report／Benchmark 結果／剩餘風險已交付，等待 Review | 3E | NOT RUN |
| P3-25 | 業務 repo 未被修改 | 兩個 repo 的 `git status` fingerprint 與 HEAD 與 §2.1 一致；無新增／修改／刪除 | 前後比對 | NOT RUN |

---

## 29. Release Readiness 建議

**結論：0.2.0 目前不具備 Release Readiness，且 Phase 3 完成前不建議發布。**

理由（依現有證據）：

1. **G1（P0，D1=C1 已授權）**：`managed-binary.yml` 從未執行；`release.yml` 的 `managed-gate` 會在 tag 後被觸發並失敗（或根本無法排程）。目前只有 Phase 2 的**本機 Windows x64** 實跑證據，CI 三平台 managed 證據為 0；D1a 只做到 PR，D1b 要 merge 後 dispatch。
2. **Desktop 驗收**：D3–D15 全部 NOT RUN；其中 D6／D9／D10／D11 是 0.2.0 的發布阻擋。
3. **跨平台**：Linux／macOS 的 managed 安裝與 POSIX 分支未實跑；`compat.yml` 未遠端執行。
4. **Phase 3 目的**：本階段要回答「Skills／Bootstrap／CLI 是否真的改善 Agent 效果」；在 Benchmark 完成前，無法對外宣稱效果。
5. **文件**：README 的 DSH 版本與測試數字需校正；Desktop 驗收清單需補結果。

**建議順序**：

1. D1a 遠端 commit＋PR（C1）→ 你 merge → Agent 對 `main` dispatch，取得三平台綠（或至少 Windows＋Linux x64）。
2. 完成 Phase 3A 的 Desktop 驗收（測試 Profile），優先 D6／D9／D10／D11；必要時 D3–D5、D7–D8、D12–D15。
3. 完成 Phase 3B 的 targeted 修復與回歸。
4. 依 D12 跑 Pilot（≤3M）；Gate 3C 過後自動跑完整 24（no-reuse，總 ≤12M）。
5. 完成 Phase 3E：更新 README／CHANGELOG、Execution Report、Review。
6. 以上全部 PASS 後，才由人工決定 0.2.0 的 tag／publish；本計畫不預設下一個發布版本，也不執行任何發布命令。

---

## 30. Execution Agent 交接（2026-11-24 第二輪）

> 本節是給 Execution Agent 的執行依據。全自動跑到 3E；只在 §30.7 的 gate 失敗、PR merge、預算上限、token 不可見、repo 指紋變動時停下回報。

### 30.1 授權與角色

- 角色：Execution Agent（依 `AGENTS.md` §3.4）。
- 授權：Phase 0；D1a C1 遠端 commit（branch `phase3/d1-managed-workflow-fix`＋PR，不 merge）；3A；3B 最小修復；3C Pilot；3D 24 no-reuse；3E 報告。
- **唯一 Git 例外**：D1a 用 GitHub API 遠端 commit；**不得** local `git commit`／`push`／`merge`，不得改 `main`，不得 merge PR。
- 不得重新規劃或改寫本計畫；證據推翻假設就停下回報並提出最小調整。

### 30.2 執行順序

1. **Gate 0**：確認 token 可用（process env 或 User env；只印 set/unset）、`git status`、HEAD、`npm test` baseline；以 `GET /repos` 200 為準。
2. **Phase 0**：建 harness（`scripts/phase3/`）、A/B profiles、smoke（Web API 建 session、讀 session log、usage、skills catalog）。
3. **D1a**：修 workflow → local `node --test test/workflows.test.mjs` → GitHub API branch commit → 開 PR → 驗證 push 後無 `Invalid workflow file` run。
4. **3A**：Web API 跑 3A-2～3A-10；3A-9 決定 Benchmark harness。
5. **3B**：F1 重現測試（重現才修 A）、F2 文字、F3 靜態守衛；跑 targeted＋`npm test`。
6. **3C**：Pilot 12（≤3M）；gate。
7. **3D**：24 no-reuse（總 ≤12M）；gate。
8. **3E**：回歸＋報告；停在人工 Review。
9. **D1b**：PR merge 後（人做），Agent 對 `main` dispatch 並收集 run／jobs；若 merge 尚未發生，3A–3E 照跑，D1b 標 PENDING。

### 30.3 必須回報的證據

- Phase 0：harness 檔案、smoke session log、token 可見性（只寫 set/unset）。
- D1a：commit SHA、PR URL、branch、syntax 驗證結果；D1b：dispatch run URL、jobs、logs 摘要。
- 3A：P3-03～P3-18 的 PASS/FAIL/NOT RUN、session id、log 路徑、prompt/usage bytes、F1 結論。
- 3B：diff、測試命令與結果、F1 是否重現。
- 3C/3D：每 run 的模型／組別／usage／工具序列／評分；總 token；gate 結果。
- 業務 repo 前後 fingerprint；未 local commit／未 merge 的證明。
- 報告：`docs/2026-11-24-basemind-agent-effectiveness-report.md`（新增）。
- 不把「已實施」寫成「已驗證」；不把 PARTIAL 寫成 PASS。

### 30.4 硬性禁止

- local `git commit`／`push`／`merge`；直接改 `main`；merge PR；force push。
- 改 `.github/workflows/managed-binary.yml` 以外的遠端檔案。
- 改 `package.json` 版本、Persona／Preset／使用者 YAML。
- 改兩個業務 repo（含 `git add`／branch／worktree／stash）；fingerprint 必須不變。
- 新增 runtime dependency、常駐服務、MCP row。
- 超預算：per-run 400k、3A 0.3M、Pilot 3M、總 12M。
- 把 token／session log／內部代碼貼進公開報告。
- 在 gate 未過時硬跑下一階段。

### 30.5 Gate 0：`GH_TOKEN`

- 現況（2026-11-24 重啟後實測）：Windows **User 環境變數已設**（`[Environment]::GetEnvironmentVariable('GH_TOKEN','User')` 非空），但 `ops_bash` 的 process env 仍是 **stale**（顯示 unset）；`dsh-ops` shell manager 不會隨 DSH 重啟更新。
- **Harness 讀取順序**：
  1. `process.env.GH_TOKEN`；
  2. 若空，呼叫 PowerShell 讀 User 變數（只在記憶體使用，不輸出）：
     ```powershell
     [Environment]::GetEnvironmentVariable('GH_TOKEN','User')
     ```
     Node 以 `execFileSync('powershell', [...])` 取得 stdout 後 `trim()`；**不得** console.log 原值。
  3. 若仍空，才讀 `%USERPROFILE%\.dsh\phase3-gh-token`。
- 已驗證：以 User 變數讀取的 token 執行 `GET /repos/zengjunlin2022/dsh-basemind-plugin` 回 **200**（public repo、default `main`）；`GET /actions/workflows`、`GET /git/ref/heads/main` 亦 200。
- Token 需 fine-grained：Contents RW、Workflows RW、Actions RW、Metadata R、Pull requests RW（C1）；7 天到期。
- 任何 401／403：停止 D1，回報；不要重試風暴。
- 不得把 token 寫入 repo、session log、報告或 console。

### 30.6 交接完成條件

- Phase 0 smoke 成功；token 可見。
- D1a PR 已開、syntax 驗證完成；D1b（若 merge）run 結果已收集。
- 3A／3B／3C／3D gate 全過（或已記錄失敗與停點）。
- 業務 repo 指紋不變；Desktop profile 不變；無 local commit／push／merge。
- 報告已寫入 `docs/`。

### 30.7 Gate 定義

| Gate | 條件 | 未過時 |
| --- | --- | --- |
| **G0** | token 可用（process env 或 User env；`GET repo` 200）；profiles 可 boot；baseline tests 綠 | 停，回報 |
| **G1** | D1a PR 已開；push 後無 invalid workflow；local test 綠 | 停，回報 |
| **G2** | 3A P3-03～P3-18 有證據；F1 結論；repo 指紋不變；≤3.3M | 停，回報 |
| **G3** | 3B targeted＋`npm test` 綠；diff 只含授權檔 | 停，回報 |
| **G4** | Pilot 正確性無退化；≤3M；流程可重跑 | 停，回報 |
| **G5** | 24 次完成；總 ≤12M；無 PASS→FAIL | 停，回報 |
| **G6** | 3E 回歸綠；報告完成 | 停，人工 Review |

### 30.8 成本守門

- 每 run 後讀 usage；單 run >400k → 中止該 run。
- 3A 累計 >0.3M → 停；Pilot >3M → 停；全程 >12M → 停。
- 不用 LLM judge；評分規則式＋人工抽樣。
- 加跑（矛盾／波動）也計入 12M；超過即停。

### 30.9 D1a API 流程（C1）

1. `GET /repos/{owner}/{repo}`：確認 token 與 repo。
2. `GET /git/ref/heads/main`：取得 base SHA。
3. `POST /git/refs`：建立 `refs/heads/phase3/d1-managed-workflow-fix`。
4. `GET /contents/.github/workflows/managed-binary.yml?ref=main`：取得 blob SHA。
5. `PUT /contents/...`：base64 內容＋繁中 commit message＋branch。
6. `POST /pulls`：head=`phase3/d1-managed-workflow-fix`、base=`main`。
7. 驗證：push 後 `GET /actions/runs?branch=...` 不應出現 `Invalid workflow file`；local `node --test test/workflows.test.mjs` 綠。
8. 嘗試 `POST /actions/workflows/managed-binary.yml/dispatches`（`ref`=branch）；404／422 → 等 PR merge 後對 `main` dispatch。
9. 全程 redact token；不寫入檔案或輸出。

## 附錄 A：Benchmark 任務檔與 Ground Truth 範本

```json
// benchmark/tasks/B1-java-symbol.json
{
  "id": "B1-java-symbol",
  "project": "bm-java",
  "cwd": "<bench>/repos/bm-java",
  "prompt": "找出方法 `<name>` 的定義：檔案路徑、行號、所屬類別；再列出至少 1 個直接呼叫者。不要修改任何檔案。",
  "ground_truth": "benchmark/ground-truth/B1-java-symbol.json",
  "timeout_minutes": 10,
  "scoring": "B1"
}
```

- Ground Truth 凍結後記錄 SHA256；A/B 執行時只讀不寫。
- 每個任務的 prompt 逐字相同；不得在 A/B 之間改字。

## 附錄 B：Session Log 量測腳本設計（3C 實作）

- 檔案：`scripts/benchmark/collect-usage.mjs`（零依賴，Node 24）。
- 功能：
  1. 以 zstd magic（`28 B5 2F FD`）切 frame，逐 frame `zstdDecompressSync`，解析 JSONL（本次已驗證可行）。
  2. 輸出每 session：`sessionId`、header（cwd、agentPreset）、每次 `request/header`（provider/model/effort、tools 名稱與 bytes）、每個 `assistant/message.usage`、`system/message` bytes、skills catalog 訊息 bytes、tool/call 與 tool/result 統計、時間戳。
  3. 聚合：per turn、per run 合計；輸出 JSON 與 CSV。
- 不做：不上傳、不呼叫模型、不改 session 檔。
- 只讀取暫存目錄中的 log；不提交到 repo。

## 附錄 C：證據索引

| 主題 | 位置 |
| --- | --- |
| 插件入口／readiness／onClose | [index.js:98-117](../index.js#L98-L117)、[index.js:173-177](../index.js#L173-L177)、[index.js:484-534](../index.js#L484-L534)、[index.js:591-643](../index.js#L591-L643) |
| Workspace Pool | [lib/workspace-pool.js:139-208](../lib/workspace-pool.js#L139-L208) |
| Stdio client「無自動重啟」 | [lib/stdio-client.js:1-12](../lib/stdio-client.js#L1-L12) |
| Skills provider | [lib/skills/provider.js](../lib/skills/provider.js)（`list`／`get`／`definitionEntry`） |
| Bootstrap | [lib/prompt/bootstrap.js](../lib/prompt/bootstrap.js)（`bootstrapText`） |
| 上游版本 | [lib/upstream.js](../lib/upstream.js) |
| Skills 適配 | [skills/.dsh-adapt.json](../skills/.dsh-adapt.json) |
| Skills provenance | [skills/UPSTREAM.json](../skills/UPSTREAM.json) |
| MCP instructions fixture | [fixtures/basemind-0.34.0-instructions.txt](../fixtures/basemind-0.34.0-instructions.txt) |
| Tools fixture | [fixtures/basemind-0.34.0-tools.json](../fixtures/basemind-0.34.0-tools.json) |
| Phase 1／2 證據 | [Phase 1 ER](./2026-11-24-basemind-stability-phase1-execution-report.md)、[Phase 1 Review](./2026-11-24-basemind-stability-phase1-review.md)、[Phase 2 ER](./2026-11-24-basemind-stability-phase2-execution-report.md)、[Desktop Checklist](./2026-11-24-basemind-desktop-acceptance-checklist.md) |
| CI 失敗 run | `https://github.com/zengjunlin2022/dsh-basemind-plugin/actions/runs/45373407690` |
| DSH runtime（安裝版） | `app.asar/dsh/node_modules/@deepseek-ai/dsh-system-prompt`、`dsh-skill`、`dsh-tool-skill`、`dsh-compaction-basic`、`dsh-agent-loop`、`dsh-commands`、`dsh-command-compact` |
| 上游 Pi／OpenCode | `https://github.com/Goldziher/basemind/blob/8e7b149/.pi/extensions/basemind.ts`、`.../opencode-plugin/basemind.js` |
| 上游 Vue／Java | `https://github.com/Goldziher/basemind/blob/8e7b149/src/lang.rs`、`src/queries/java.scm`、`src/intel/resolver.rs`、`src/engine/types/git.rs` |

---

**本文件是 Phase 3 第二輪定稿與 Execution Agent 交接依據；所有「NOT RUN」項目仍尚未執行。Execution 依 §30 全自動跑到 3E，只在 gate／PR merge／預算／token 問題時停下。**
