# dsh-basemind-plugin — Phase 3 會話交接（2026-11-24 22:37）

- 用途：本會話上下文即將耗盡；新會話從此檔接手。
- 角色：下一個 Agent 為 **Execution Agent**（先修 Review findings，再續 Phase 3）；最終仍由使用者 Review／commit。
- 專案：`D:\02_zengjunlin\github\dsh-basemind-plugin`
- 目前 HEAD：`2a17e9b`（`main`，已 push；`origin/main` 同步）
- 產品版本：`0.2.0`（不 bump、不 publish、不 tag）
- 環境：Node `24.20.0`、DSH `0.2.2-rc.5`、BaseMind pin `0.34.0`
- **本會話未執行任何 local commit／push／merge；所有變更仍待使用者 commit。**

---

## 1. 一句話現況

Phase 1／2 已完成；Phase 3 的 D1a／D1b、3B、Web API driver、3A 主要取證已完成；**冷啟動修復＋Review 的 Important 1／2 已修並驗證、Important 3 已文件化（見 §15 與報告 §11.17）**；**isolated integration 在併行負載下 3 次逾時，安靜重跑 8/8 pass（既有 timing 問題，非本 diff）**；尚未 commit。3C／3D／3E 尚未開始。

---

## 2. 立即第一件事：讀這三份文件

1. `docs/2026-11-24-basemind-agent-effectiveness-plan.md`（§23、§30）
2. `docs/2026-11-24-basemind-agent-effectiveness-report.md`（§11.10–§11.16；最新進度）
3. `docs/2026-11-24-basemind-cold-start-fix-review.md`（冷啟動修復 Review；**先處理這份的 findings**）

---

## 3. 目前 Git 狀態（不可 reset／checkout）

```text
HEAD 2a17e9b
staged（10 檔，Review 修正後，見 §15）：
  CHANGELOG.md
  README.md
  README.zh.md
  docs/2026-11-24-basemind-agent-effectiveness-report.md
  docs/2026-11-24-basemind-cold-start-fix-review.md（新增）
  fixtures/fake-mcp-server.mjs
  index.js
  lib/config.js
  test/config.test.mjs
  test/index.test.mjs
untracked：
  docs/2026-11-24-basemind-phase3-handoff.md（本檔）
```

- 本檔原記「全部已 add、沒有 unstaged」只成立到 22:38；前一段 context 之後仍改了 6 個檔（22:38:52–22:40:09）。2026-11-24 22:41–23:05 接手後已把 Important 1／2 修完並全部 staged，`git diff --cached` 即完整變更。
- 不要 `git reset`、`git checkout --`、`git restore` 或覆寫 staged 內容。
- 下一個 Agent 可以修改 staged 檔案；使用者最後一次性 Review／commit。
- 目前沒有 local commit／push／merge。

---

## 4. 冷啟動修復：已完成什麼

### 4.1 需求

新 session 第一輪必須看到 BaseMind 工具、bootstrap、skills catalog；BaseMind 不可用時要有界 fallback，不 hang。

### 4.2 修復內容（staged）

- `index.js`：`agent/created` listener 由 fire-and-forget 改為 `return adoptAgentRoot(agent, payload?.signal)`；新增 `startPrimary()`、`state.initPromise`、`settleWithin()`、`waitForPrimary()`；有界等待 relay ready。
- `lib/config.js`：新增 `coldStartTimeoutMs`，預設 `15_000`，`0` 停用，上限 `120_000`。
- `fixtures/fake-mcp-server.mjs`：`FAKE_MCP_INIT_DELAY_MS` 模擬慢 handshake。
- `test/index.test.mjs`：5 個 cold-start deterministic cases；fake `emit` 改成會 await listener。
- `test/config.test.mjs`：clamp 測試。
- `CHANGELOG.md`：修正說明。
- 報告：`docs/2026-11-24-basemind-agent-effectiveness-report.md` §11.16（193 行）。

### 4.3 已驗證

- Host 契約：`dsh-agent/src/index.ts:174-176`、`:458`；`dsh-agent-loop/src/index.ts:506` → `agent/created` listener 完成前不釋放 queued work。修復位置正確。
- 真實冷 process（修復後）：
  - `0997fd98`：54 tools／19 `mcp__basemind__`／system 10,350 B／10 basemind skills。
  - `2c02a801`（同 process 第 2 個 session）：同上。
- 修復前：`19c321d6`：34 tools／0 `mcp__basemind__`／system 6,334 B。
- `node --test test/index.test.mjs test/config.test.mjs`：**51/51 pass**。
- `npm run check`：syntax ok（20 files）＋bundle manifest ok。
- `node --test test/integration.test.mjs`（isolated）：**8/8 pass**（58.8 s）。
- 完整 `npm test`：**仍不穩定**，會偶發 `test/integration.test.mjs:578` index build timeout；isolated 8/8 通過，與此 diff 無直接關係，但不能宣稱全綠。

---

## 5. Review findings（先修，再 commit）

完整內容見 `docs/2026-11-24-basemind-cold-start-fix-review.md`。

### Important 1 — `agent-first` 初始 root 失敗後跳過 gate

**→ 已修（2026-11-24 23:05）：per-root gate／同一個 promise 內 recheck。見報告 §11.17(2)。**

- 位置：`index.js:631`（`state.attempted = true`）、`index.js:688`（`gate`）、`index.js:692`（`void startPrimary()`）。
- 觸發：`discoveryRoot: 'agent-first'` → apply 先嘗試 deployment default；若它不是 project，`attempted=true`；第一個真實 Agent 建立時 `gate=false`，第一輪可能在 tools 註冊前被釋放。
- 測試缺口：`test/index.test.mjs:509-526` 有 `agent-first`＋失敗 root，但沒有 await `agent/created`／斷言 first-turn tools；新 cold 測試全部是 `discoveryRoot: 'agent'`。
- 建議：記錄 last attempted root，Agent root 不同時 gate；recheck 的新 attempt 也要被 `waitForPrimary` 觀察；加 `agent-first`＋failRoots＋慢 relay 測試。

### Important 2 — `workingDirectory.ensure` timeout 永久放棄 adoption

**→ 已修：timeout 後掛 non-blocking continuation。見報告 §11.17(3)。**

- 位置：`index.js:661-670`、`index.js:630`。
- 觸發：`ensure` 超過 `coldStartTimeoutMs`（慢 cwd）。
- 實際：timeout 只 `scheduleRetry()` 後 return；`preferredRoot` 未設定；`agent` 模式 retry 因 `candidateRoots()` 為空直接 return；晚到的 directory promise 沒有被觀察。
- 建議：timeout 時掛 non-blocking continuation，directory 晚到仍設 `preferredRoot`／`startPrimary()`；加 delayed-ensure 測試。

### Important 3 — 預設 15s 短於 cold managed install

**→ 已決定：文件化，不拉高預設（README §5.3 英文＋中文、CHANGELOG、報告 §11.17(4)）。**

- 位置：`lib/config.js:21`、`index.js:543`。
- Phase 2 實測冷安裝 13,506–55,713 ms；`startupTimeoutMs` 60 s。第一次安裝／全新 cache 的第一個 session 可能在 15s timeout 後才拿到工具。
- 建議：文件化 first-ever install 限制，或另案設計；不建議直接把 15s 拉到 55–60s 而不評估 UX。

### Validation 4 — 完整 `npm test` flaky

**→ 仍未解（既有 timing 問題）。本輪 isolated integration 3 次都在同一測試逾時；見報告 §11.17(6)(7)。**

- `test/integration.test.mjs:578` index build timeout；isolated integration 8/8 pass。
- 建議另案調高 `INDEX_BUILD_TIMEOUT_MS`／retry；本 diff 不擴大 scope。

### Minor 5 — 文件

**→ 已補：README `coldStartTimeoutMs`（§5.3）與報告 §0.2／§10 指標；見 §11.17。**

- `coldStartTimeoutMs` 未寫進 `README.md`／`README.zh.md`（新預設會多等最多 15s，`0` 可停用）。
- 報告頂部 §0.2／§10 仍是舊快照；最新看 §11.16。

---

## 6. 已完成的其他 Phase 3 工作

### 6.1 D1（managed workflow）— 完成

- PR #1 **已 merge**（merge commit `9609872`）。
- D1b：main dispatch run `45398697251` → plan／ubuntu／macos／windows **全 success**。
- CI push main `45403114842` success。
- `main` = `2a17e9b`。

### 6.2 3B（deterministic）— 完成

- F1 relay 恢復：`lib/workspace-pool.js` `forget()`＋`index.js` `onClose` 清理；deterministic 測試＋真實 web 測試（R1）通過。
- F2 bootstrap 措辭：`read/grep/glob and shell tools`。
- F3 workflow 靜態守衛＋CI path 修正（`39ef670`）。
- `npm test` 基線 446/436/0/10；cold 修復後 452 tests（含新增）。

### 6.3 3A（部分完成）

- PASS（暖機後）：P3-03 catalog、P3-04 skill 正文＋實際使用、P3-05 bootstrap、P3-07/08 resume、P3-11 R1（真實 relay kill）、P3-14 deterministic、P3-16 subagent（基本）、P3-25 業務 repo 指紋。
- PARTIAL：P3-06 prompt／usage 量測。
- 3A-9 結論：headless 不等價，Benchmark 用 Web API。
- Web API driver：`scripts/phase3/web-api.mjs`（token exchange＋`/api/session/*`）。
- 3A usage 實測：25e9ef88 88,910＋8a1f9e4c 138,163＋5916a54c 253,024＋8427cca6 92,574 = **572,671**；加 smoke 25,961 ≈ **598,632**，已超過原 0.3M 子預算；總 12M 仍充足。
- 模型：3A sessions 使用 `deepseek-account`／`deepseek-flash`／high；GPT 只 smoke（`openai-codex`／`gpt-6.1-sol`／low），尚未進 A/B。

---

## 7. 尚未完成

### 7.1 3A 剩餘

- P3-09／P3-10 compaction：Web API session-controller 沒有 compact 端點；需 GUI `/compact` 或 `commands` namespace。
- P3-12 R2 secondary relay（需第二個真實 repo）。
- P3-13 R3 daemon unavailable。
- P3-15 多 session 隔離（需兩個真實 repo；之前用非專案目錄失敗，不是插件路由錯誤）。
- P3-17 插件停用／重載。
- P3-18 Vue／Java 邊界（BaseMind 對 Vue 無專屬查詢；Java 多模組 source root 限制）。
- 3A-10 業務 repo 指紋（目前未變，但未做 BaseMind 查詢）。

### 7.2 Benchmark 與最終

- `benchmark/` 目錄仍不存在：任務、Ground Truth、staged repo、scoring 都要建。
- 3C Pilot 12（≤3M）、3D 24 no-reuse（≤8.7M；總 ≤12M）尚未開始。
- 3E：README／CHANGELOG（cold 修復已在 CHANGELOG［Unreleased］，但 README 未補 coldStartTimeoutMs）、Desktop D6/D9/D10/D11、最終報告。
- Phase 2 Desktop D3–D15、`compat.yml` 遠端仍 NOT RUN。
- Release Readiness 未達。

---

## 8. 已確認的決策／授權

- 全自動 Phase 3；預算 **12M tokens、no-reuse**；Pilot 3M；完整 8.7M；per-run 400k。
- GitHub：C1 遠端 commit 已用於 PR #1；PR 已 merge；**不得再 local commit／push／merge**。
- Harness：Hybrid → 3A 用 Web API；Benchmark 也因 headless 不等價而用 Web API。
- 測試 repo：Vue `C:\01_aw_github\transmac-oms-fe`；Java `D:\02_zengjunlin\github\transmac-oms`；**全程唯讀、不改程式碼、不 commit**。
- 模型路由全部可用（`deepseek-account`；`openai-codex` 已 smoke）；測試 Profile `bm-bench-a/b` 已有 `agent-default-model`＋`dsh-codex-subscription@3.2.29`。
- 不修改 Desktop 生產 profile；不新增常駐服務／runtime dependency。

---

## 9. 環境與工具

| 項目 | 值 |
| --- | --- |
| GH_TOKEN | Windows **User env** 已設；process env 可能是 stale；用 `scripts/phase3/lib/token.mjs`（process env → PowerShell User env → `%USERPROFILE%\.dsh\phase3-gh-token`）；**禁止輸出 token** |
| 測試 Profile | `~/.dsh/profiles/bm-bench-a`、`bm-bench-b`；另有 cold 驗證用的 `bm-bench-c`／`bm-bench-d` |
| bm-bench-a/b 目前 tarball | `D:/_bm_phase3/dsh-basemind-plugin-0.2.0-d88a746.tgz`（`173e56dd…`），內含 3B，**不含 staged cold 修復** |
| cold 驗證 | working-tree pack 安裝到 `bm-bench-c`；log／pack 在 `D:/_bm_phase3/cold/` |
| Web API driver | `scripts/phase3/web-api.mjs`：`exchangeToken`、`createSession`、`prompt`、`page`、`list`、`cancel` |
| Session usage | `scripts/phase3/session-usage.mjs <session.v4.jsonl.zstd>` |
| 真實 session log | `~/.dsh/sessions/--D-02_zengjunlin-github-dsh-basemind-plugin--/` |
| DSH 原始碼 | `app.asar/dsh/node_modules/@deepseek-ai/...`；可用 `C:\Users\sanny\Documents\deepseek-harness\default-workspace\_diag\asar.mjs` |
| 業務 repo 指紋 | Vue `f9fd1a63`／status `e3b0c442`（空）；Java `f6f2988d`／status `52176b2a`（1 untracked） |

---

## 10. 已知陷阱

1. **dsh-ops shell 的 process env 可能是 stale**：GH_TOKEN 在 User env，`process.env` 看不到；用 PowerShell 讀 User 變數（token.mjs）。
2. **啟動測試 web 實例前**清 `DSH_WEB_URL`／`DSH_PROFILE_DIR`／`DSH_PROFILE`／`DSH_SESSION_ID`；否則 `?token=` 交換 401。
3. **pnpm 對同路徑 `file:` 依賴可能回 Already up to date**：重建 tarball 後用新檔名（例如 `…-<sha>.tgz`）再 `dsh plugin add`。
4. **cold managed install 13.5–55.7s**，大於預設 15s；first-ever session 第一輪仍可能沒工具。
5. **integration index build 62–152s**，門檻 150s；完整 `npm test` 會偶發 timeout；isolated 8/8 通過。
6. **BaseMind 要求 project root**；非專案目錄的 `index_status` 會報錯，不是插件路由錯誤。
7. **BaseMind data home 與 binary 不同磁碟**可能 `acquire daemon lock: 拒絕存取 (os error 5)`；測試資料目錄要同磁碟。
8. **不要重跑已通過且未受影響的 managed 下載**（75–102 MB）；需要時用 branch dispatch。
9. 不要修改 staged 的 7 個檔案以外的產品檔，除非先確認 scope。

---

## 11. 建議的下一個 Execution 順序

### Phase A（先修 Review findings）— **已完成（2026-11-24 23:05，見 §15）**

1. ✅ Important 1：per-root gate／recheck（`state.attemptedRoots`、同一 promise 內重跑候選 root、retry 走 `startPrimary`）＋測試。
2. ✅ Important 2：directory timeout 後仍背景 adoption（`adoptLateDirectory`）＋delayed-ensure 測試。
3. ✅ Important 3：文件化（README §5.3 英文＋中文、CHANGELOG、報告 §11.17(4)），不拉高預設。
4. ✅ 報告新增 §11.17；§0.2／§10 指標指向它。
5. 驗證：targeted **53/53 pass**、`npm run check` 綠、真實冷 process 第 1 輪 **54 tools／19 `mcp__basemind__`／system 10,350 B／bootstrap／catalog 18 entries／10 basemind skills**（create1 1,432 ms）；isolated integration **安靜重跑 8/8 pass（48.6 s）**，併行負載下 3 次逾時（既有 timing 問題）。
6. 停點：已 staged，等使用者 Review／commit。**integration timing 需人工決定**：另案提高 `INDEX_BUILD_TIMEOUT_MS`，或接受 deterministic＋真實冷作為本次驗收證據。

### Phase B（commit 後）

1. 從新 commit 重建 tarball、重裝 `bm-bench-a/b`；驗證 F1／F2／cold-start。
2. 補完 3A 剩餘：P3-09/10（GUI／commands API）、P3-12/13（R2/R3）、P3-15（兩個真實 repo）、P3-17（reload）、P3-18（Vue/Java 邊界）。
3. 建 `benchmark/`：任務／Ground Truth／staged repo／scoring；3C Pilot 12（≤3M）→ 3D 24（≤8.7M；總 ≤12M）。
4. 3E：README／CHANGELOG、Desktop D6/D9/D10/D11、最終報告。
5. 3A 子預算已超 0.3M；Phase B 前先確認新的子預算。

---

## 12. 禁止事項

- local `git commit`／`git push`／`git merge`；merge PR；改 `main`；force push；tag／release。
- 修改 Desktop 生產 profile；修改兩個業務 repo；業務 repo 寫入。
- 輸出 GH_TOKEN／cookie／token。
- 改 DSH host 原始碼；新增 runtime dependency；重寫 Workspace Pool／MCP Bridge／Skills Provider。
- `git reset`／`git checkout --`／`git restore` 清掉 staged changes。

---

## 13. 交接完成條件

- ✅ Review findings 1／2 已修並有測試（報告 §11.17）。
- ✅ Important 3 已文件化；Finding 4（integration index build timeout）仍另案，但本輪 isolated 安靜重跑 8/8 pass。
- ✅ Targeted＋real cold＋isolated integration（安靜重跑 8/8，48.6 s）；完整 `npm test` 的並行 flake 已如實記錄（另一併行 context：454／442／2）。
- ☐ Staged changes 待使用者 Review／commit；沒有 local commit 由 Agent 執行。
- ✅ 報告與 README 狀態一致（README §5.3、CHANGELOG、報告 §11.17）。
- ☐ Phase B 的 tarball／profiles 待從新 commit 重建（目前 `bm-bench-c` 指向 working tree pack `…-phaseA3.tgz`）。

---

## 14. 文件索引

- 計畫：`docs/2026-11-24-basemind-agent-effectiveness-plan.md`
- 執行報告（最新 §11.17）：`docs/2026-11-24-basemind-agent-effectiveness-report.md`
- 冷啟動 Review：`docs/2026-11-24-basemind-cold-start-fix-review.md`
- 專案規則：`AGENTS.md`
- Phase 2 報告（managed install 時間）：`docs/2026-11-24-basemind-stability-phase2-execution-report.md`
- 測試 profile：`~/.dsh/profiles/bm-bench-a`、`bm-bench-b`、`bm-bench-c`、`bm-bench-d`
- 暫存 tarball／log：`D:/_bm_phase3/`

---

## 15. 2026-11-24 22:41–23:05 接手執行紀錄（Phase A 完成）

### 15.1 接手時的工作區實況

- 本檔寫於 22:37–22:38 之後，前一段 context 仍繼續改了 `index.js`、`test/index.test.mjs`、`README.md`、`README.zh.md`、`CHANGELOG.md` 與報告（22:38:52–22:40:09），所以接手時 Git 狀態與 §3 原記載不同：**Important 1／2 的程式與 2 個新測試已在 working tree，但未 staged、未驗證，報告也只有「見 §11.17」的指標而沒有 §11.17 本體**。
- 處理方式：不 reset／不 checkout；先完整讀 Review、報告 §11.16 與相關程式，再補齊缺口、驗證、文件。
- 另一個併行的 Execution context 也在同一個 working tree 工作：報告裡的第二份紀錄（現為 §11.18）是它寫的，它在 22:5x–23:01 跑了完整 `npm test`。兩邊同時對真實 BaseMind 建索引，是本輪 integration 3 次逾時的原因；本檔與報告 §11.17 以本 context 的驗證為準。

### 15.2 本輪做的事

1. 逐行核對 working tree 的修正（`attemptedRoots`、`ensurePrimary` 的 `for(;;)` recheck、`scheduleRetry → startPrimary`、`adoptLateDirectory`），確認符合 Review 建議。
2. 補一個語意缺口：`gate` 原本只看「Agent root 未嘗試過」。在 `discoveryRoot: 'default'` 下，Agent 目錄根本不是候選 root，卻仍會被 gate 到一個不可能產生該 session 工具的 attempt（等於把失敗的 deployment default 延遲轉嫁給每個 session）。改為「該 root 必須是這個 mode 的候選 root」才算未見。
3. 驗證：targeted ×1（修正前後各一次）、`npm run check`、isolated integration ×3、真實冷 process（重新 pack → `bm-bench-c` → 冷啟 → 2 個 session 立即送 prompt → 解析 session log）。
4. 文件：報告新增 §11.17；本檔更新 §1／§3／§5／§11／§13／§14 並新增本節。

### 15.3 驗證結果

| 項目 | 結果 |
| --- | --- |
| `node --test test/index.test.mjs test/config.test.mjs` | **53/53 pass**（9.3 s） |
| `npm run check` | syntax ok（20 files）＋bundle manifest ok |
| `node --test test/integration.test.mjs` | 併行負載下 3 次逾時（`int2.log` 6／2、`int3.log` 7／1，失敗全是 `:578` 的 index build timeout）；**安靜重跑 8/8 pass（48.6 s）**，index build 36.1 s（`int4.log`） |
| 真實冷 process（final tree） | create1 1,432 ms／prompt1 33 ms／create2 65 ms；session `5687fce4`、`8e78f854` 第 1 輪皆 54 tools／19 `mcp__basemind__`／system 10,350 B／bootstrap／catalog 18 entries／10 basemind skills |

- 冷驗證用的 tarball：`D:/_bm_phase3/cold/pack2/dsh-basemind-plugin-0.2.0-phaseA3.tgz`；log `D:/_bm_phase3/cold/cold-f.log`。
- integration 的三份 log 在 `D:/_bm_phase3/cold/int2.log`、`int3.log`（第一次執行未保留輸出）。

### 15.4 未完成／待使用者決定

1. **integration 的 timing**：fresh `BASEMIND_DATA_HOME` 首次 index build 在併行負載下可達 152–160 s、越過 150 s 門檻（安靜時 36.1 s）。這是既有 flake（Finding 4），建議另案提高 `INDEX_BUILD_TIMEOUT_MS`／改 retry；本輪已用安靜重跑取得 8/8。
2. `agent-first`／late-directory 只有 deterministic 覆蓋，沒有真實 session 重現。
3. 完整 `npm test` 本輪未重跑（唯一已知失敗就是上述 integration timeout）；README 的測試數列仍是 Phase 2 快照（432），屬 3E。
4. Phase B 全部未開始（tarball／bm-bench-a/b 重裝、3A 剩餘、benchmark、3E）。

### 15.5 工作區與 Git

- 10 個檔案已 staged（見 §3），本檔與 review 檔的狀態見 §3；**無 local commit／push／merge**；`main` 仍 `2a17e9b`。
- 未動 Desktop profile；兩個業務 repo 只讀；未新增 runtime dependency。
- 測試 profile：`bm-bench-c` 現指向 `…-phaseA3.tgz`（本輪 final tree）；`bm-bench-a/b` 未動。
