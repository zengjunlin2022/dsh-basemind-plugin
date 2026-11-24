# BaseMind Agent Effectiveness — Phase 3 Execution Report

- 日期：2026-11-24（本地 +08:00）
- 依據：[docs/2026-11-24-basemind-agent-effectiveness-plan.md](./2026-11-24-basemind-agent-effectiveness-plan.md) §23、§30
- 角色：Execution Agent；最終 Review 仍待人工
- 基準 commit：`bba170cdaf7329214d7146d2d0636e2b39199be4`（main，未變動）
- 環境：Node `24.20.0`、DSH `0.2.2-rc.5`、BaseMind upstream pin `v0.34.0`

> 判定用語：**PASS／FAIL／NOT RUN／PENDING**。本報告嚴格區分「已實施」「已驗證」「未驗證」。

---

## 0. 停點與結論

本次執行跑到 **D1a 完成、3B 完成**，然後在 **3A 之前**被環境條件擋下：

- **GitHub 端可用**：Gate 0 PASS（token 以 §30.5 的 User env 讀取，GET /repos 200）。
- **模型端不可用**：兩個測試 Profile（bm-bench-a／bm-bench-b）沒有任何可用模型憑證。任何真實 Agent turn（3A）、Pilot（3C）、完整 Benchmark（3D）都無法開始。
  - 實測錯誤（原始文字，未含憑證）：
    dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment
  - 已確認：process env 無 DEEPSEEK_API_KEY；~/.dsh 無可讀的 credentials 檔；Desktop 使用 deepseek-account／Codex subscription，屬 Desktop 專屬帳號登入，未授權且未嘗試複製。
- 因此：**3A、3C、3D 全部 NOT RUN**，G2／G4／G5 未觸發，**本次未消耗任何模型 token（0）**。
- 依 §30.7「token／API 失敗 → 停，回報」，在此停下。

已完成的實質工程：Phase 0 harness、D1a 遠端 commit＋PR、3B 的 F1 重現與修復、F2 措辭、F3 靜態守衛，以及全量回歸。

**2026-11-24 19:49 停止後 Review 補充**：本報告由 Review Agent 重新驗證，並新增 §11「停止後補充清單」。原 §0–§10 的判定不變；§11 另列審查發現。

### 0.1 停止後審查摘要

| 檢查 | 結果 |
| --- | --- |
| `npm test`（重跑） | 446 tests／436 pass／0 fail／10 skip |
| `npm run check`／`check:skills`／`check:pack` | 綠（20 files／10 skills 20 files／52 files） |
| PR #1 | open、`mergeable=clean`、changed_files=1、head `2be18f3`、base `bba170c` |
| `main` | `bba170c`（未變） |
| branch dispatch | `45382691537`、`45383311910` 兩次皆 failure；ubuntu success、macOS／Windows 失敗 |
| 業務 repo 指紋 | Vue `f9fd1a63`／status `e3b0c442`；Java `f6f2988d`／status `52176b2a` → 與 §7 相同 |
| 測試 Profile tarball | `ad5d8083…`（19:17）**早於 3B**：bootstrap 仍 `glob/bash`、index.js 無 `pool.forget` |
| `D:/_bm_phase3/exchange.txt` | 538 bytes、含 `Set-Cookie`（web auth cookie）→ 敏感暫存 |

---

## 1. 基準與 Gate 0

| 項目 | 證據 |
| --- | --- |
| git rev-parse HEAD | bba170cdaf7329214d7146d2d0636e2b39199be4（執行前後相同） |
| git status（執行前） | 僅 ?? docs/2026-11-24-basemind-agent-effectiveness-plan.md |
| npm test baseline | tests 442、pass 432、fail 0、skipped 10（duration_ms 38,412） |
| GH_TOKEN | process env = **unset**、Windows User env = **set**；harness 依 §30.5 以 powershell -Command [Environment]::GetEnvironmentVariable('GH_TOKEN','User') ＋ trim() 只在記憶體使用 |
| GET /repos/zengjunlin2022/dsh-basemind-plugin | **200**（default_branch=main） |
| GET /actions/workflows | 200、total_count=4 |
| GET /git/ref/heads/main | 200、bba170c… |

**G0：PASS**（token 可見、repo 200、profiles 可 boot、baseline 綠）。token 從未寫入檔案、log、報告或 console。

---

## 2. Phase 0：Harness（PASS，但 smoke 在模型呼叫處受阻）

新增檔案（全部在 scripts/phase3/，不進 npm 包）：

| 檔案 | 作用 |
| --- | --- |
| scripts/phase3/lib/token.mjs | §30.5 token 解析順序（process env → PowerShell User env → %USERPROFILE%\.dsh\phase3-gh-token）與 redact |
| scripts/phase3/gate0.mjs | Gate 0：token 可見性（只印 set/unset）＋ repo／workflows／ref 檢查 |
| scripts/phase3/d1-remote.mjs | D1a：GitHub API 建分支、PUT contents、開 PR（idempotent，不 merge） |
| scripts/phase3/d1-verify.mjs | 檢查 branch runs 與 dispatch 可用性 |
| scripts/phase3/d1-jobs.mjs | 列出 run 的 job／step 結論 |
| scripts/phase3/d1-logs.mjs | 以記憶體內 token 下載 job log |
| scripts/phase3/session-usage.mjs | session log 多 frame zstd → usage／工具／prompt 指標（§20.1 語義） |

### 2.1 測試 Profile（D6）

- dsh bm-bench-a --from-default-profile web --dump-config／dsh bm-bench-b --from-default-profile web：兩者都從 **shipped web 模板**建立，位於既有 ~/.dsh/profiles/，**desktop profile 未被修改**。
- 安裝同一 tarball：npm pack → D:/_bm_phase3/dsh-basemind-plugin-0.2.0.tgz，sha256 ad5d8083d2639ff5701be57606dfd27deb26428da708887cf6a6dd2158801dcb；兩個 profile 都安裝 0.2.0。
  - **注意**：此 tarball 建於 19:17，早於 §5 的 3B 變更；其 `lib/prompt/bootstrap.js` 仍是 `glob/bash`，`index.js` 也沒有 `pool.forget`。3A／3C／3D 前必須從最終樹重建並重裝（見 §11.2）。
- A 組（bm-bench-a）patch 只改三個布林值（--dump-config 已確認 row 生效、無新增 MCP row）：skills: false、bootstrap: false、cliTool: false；B 組維持預設。

### 2.2 Smoke 結果

| 檢查 | 結果 |
| --- | --- |
| 隔離 web 實例可 boot（--profile bm-bench-a --port 0 --no-open，清除 DSH_WEB_URL/DSH_PROFILE_DIR/DSH_PROFILE/DSH_SESSION_ID） | PASS：http://127.0.0.1:52810/?token=…，已停止，無殘留 basemind.exe |
| token 交換（GET /?token=） | PASS：303 ＋ Set-Cookie: dsh-auth-… |
| Web API 建 session | **NOT RUN**：/api/* 探測全 404，該 harness 的 API 由 @deepseek-ai/dsh-api-gateway 以插件模組形式提供，未在本階段逆向出穩定呼叫面；沒有用它做任何未驗證的假設 |
| Headless 一鍵執行（--json） | **FAIL（環境）**：MISSING_CREDENTIAL（見 §0）；這同時也是 3A-9 等價性檢查的前置條件 |
| usage 量測腳本 | PASS（量測方法可驗證，見下） |

session-usage.mjs 對真實 session log（929 節點、389 個 zstd frame、0 skipped）實測：
inputTokens=119127、outputTokens=55339、cacheReadTokens=9348480、totalTokens=9522946，
且 totalTokens = input + output + cacheRead（9,522,946），與 §20.1 的語義一致 → **P3-06 的量測方法已驗證**，但 BaseMind session 的實際 bytes 仍是 NOT RUN。

---

## 3. D1a（F3 遠端修復）— PASS

| 欄位 | 值 |
| --- | --- |
| Branch | phase3/d1-managed-workflow-fix |
| Base SHA | bba170cdaf7329214d7146d2d0636e2b39199be4 |
| Commit | 2be18f32876d42de283e7c459ecab4dfb5bb349a（verified: true） |
| PR | https://github.com/zengjunlin2022/dsh-basemind-plugin/pull/1（state=open、changed_files=1） |
| 遠端唯一變更 | .github/workflows/managed-binary.yml |

**修法（最小）**：job 層 env: 讀 runner.temp 是 GitHub 拒絕整份 workflow 的原因（Invalid workflow file … Line: 88, Col: 32: Unrecognized named-value: 'runner'）。移除 job env，把 MANAGED_DIAGNOSTICS_DIR 掛到真正讀它的三個 step（managed gate／Step Summary／失敗 artifact），行為不變。

**語法驗證**

1. node --test test/workflows.test.mjs：11/11 綠（含新增 job env 守衛）。
2. PyYAML 解析通過；jobs.managed 已無 env 鍵，三個 step 各自帶 env。
3. GitHub 端：對 **branch** POST …/dispatches 回 **204 accepted**（GitHub 已接受該檔語法並排程）。
4. PR CI run 45382669305：conclusion=success。
5. 對照：對 **main** dispatch 回 **422**，錯誤仍是 Unrecognized named-value: 'runner' → 證明修復只在 branch、main 尚未變更。

**Dispatch 實跑（run 45382691537，branch）**：plan job success；三個平台 job 都真的被排程（先前 jobs.total_count=0）：

| Job | 結果 | 失敗點 |
| --- | --- | --- |
| managed install (ubuntu-latest) | **success**（含 managed gate） | — |
| managed install (macos-15) | failure | test/integration-managed.test.mjs:1710 index_status root 比較（/private/var/… vs /var/…） |
| managed install (windows-latest) | failure | test/integration-managed.test.mjs:1300（C:\Users\RUNNER~1\… 8.3 短路徑無法承載 .cmd launcher）＋ 同一 root 比較（\\?\C:\… 前綴） |

**第二個 dispatch run**：`45383311910`（11:20:43Z，同 branch／同 commit `2be18f3`）結果與 `45382691537` 相同（plan success、ubuntu success、macOS／Windows 失敗），不是新問題。

**未確認的 0-job run**：`45382651669`（11:16:23Z、event=push、`main`、`bba170c`、jobs=0）與 10:17 的 invalid workflow run 同型；但 GitHub events API 未見對應的 main PushEvent，`GET /git/ref/heads/main` 仍是 `bba170c`。此 run 的來源未確認，**不宣稱 main 被改動，也不宣稱完全沒有**；如需確定，請查 GitHub Audit log。

**判定**：P3-01 的 D1a 部分 **PASS**（PR 已開、push 後無 invalid workflow、local test 綠）；**D1b PENDING**（PR 未 merge，依規定不 merge）。上面兩個平台失敗是這次 dispatch 才首次暴露的**真實 CI 缺陷**，屬後續修復範圍（見 §8），不在本次授權的 diff 內。

---

## 4. 3A Lifecycle Investigation — NOT RUN（被環境阻擋）

3A 的每一項都需要「真實 Agent turn」（模型呼叫）。目前無法取得模型憑證，**沒有任何一項以真實 Agent 驗證**：

| # | 項目 | 判定 | 說明 |
| --- | --- | --- | --- |
| P3-03 | Skills catalog 可見 | NOT RUN | 需真實 session |
| P3-04 | Skill 正文可載入 | NOT RUN | 同上 |
| P3-05 | Bootstrap 段存在且穩定 | NOT RUN | 同上（test/bootstrap.test.mjs 只驗文字契約） |
| P3-06 | Prompt 成本可量測 | **PARTIAL** | 量測腳本已在真實 session log 驗證（§2.2）；BaseMind session 的 bytes NOT RUN |
| P3-07 | Session resume（GUI） | NOT RUN | — |
| P3-08 | Session resume（process） | NOT RUN | --session-id 路徑未執行 |
| P3-09 | Compaction 前後引導 | NOT RUN | /compact 需真實 session |
| P3-10 | 連續 Compaction | NOT RUN | 同上 |
| P3-11 | Relay R1 | **PARTIAL** | 真實終止 NOT RUN；但 F1 已在 deterministic 層重現並修復（§5.1） |
| P3-12 | Relay R2 | NOT RUN | 需兩個真實 workspace session |
| P3-13 | Relay R3 | NOT RUN | — |
| P3-14 | Tools list 變更（fake server） | **PASS（deterministic）** | 既有測試「re-registers the tool generation when BaseMind announces a tool list change」通過；**不是**真實 Agent 證據 |
| P3-15 | 多 Session 隔離 | NOT RUN | — |
| P3-16 | Subagent | NOT RUN | — |
| P3-17 | 插件停用／重載 | NOT RUN | — |
| P3-18 | 上游邊界已記錄 | NOT RUN | Vue／Java 邊界未實測（本次未對業務 repo 執行任何 BaseMind 呼叫） |
| P3-25 | 業務 repo 未被修改 | **PASS** | 見 §7 |

3A-9（Web vs Headless 等價性）**無法進行**：headless 路徑在憑證缺失時即失敗，沒有可比較的 system/message／request/header.tools。依 D10，Benchmark harness 仍**未決定**（未取得等價性證據，不得宣稱可用 Headless）。

---

## 5. 3B Deterministic Verification — PASS

### 5.1 F1（Relay 意外退出不恢復）— 重現 → 修復 → 回歸

**重現**（修復前，node --test test/index.test.mjs）：

✖ a relay that closed on its own is replaced on the next call (F1)
  Error: BaseMind tool admin failed in D:\02_zengjunlin\github\dsh-basemind-plugin:
  basemind relay is closed; cannot send 'tools/call': basemind relay ended: stdout closed (exit code null)

與 §21 F1 的假設一致：relay 死後 pool 仍保留死 session，下一次呼叫直接失敗，readiness 不變。

**最小修復（方案 A）**

- lib/workspace-pool.js：新增 forget(root)（只刪 entry、**不** close 已死 relay）。
- index.js：onClose（非預期關閉）→ pool.forget(root)，若是 primary 則清 state.primarySession（避免下一次 tool-list re-sync 讀死 session）。刻意關閉仍走 error === undefined 分支，不受影響。
- 未新增 timer／輪詢、未改 readiness 語義（方案 B 保留給「primary readiness 也必須翻 false」的後續需求）。

**回歸**（修復後）：node --test test/index.test.mjs test/workspace-pool.test.mjs → 38/38 綠；新增兩個測試：

1. 終止 relay → 下一次呼叫在同一 root 成功、只重建一個 relay、工具 registry 不重複。
2. 連續兩次終止仍能恢復（每次一個新 relay）。

### 5.2 F2（Bootstrap 措辭）— 已修

lib/prompt/bootstrap.js 的 fallback 句由 read/grep/glob/bash 改為 read/grep/glob and shell tools（shell 在 Windows preset 是 pwsh，不該硬寫 bash）；test/bootstrap.test.mjs 同步改為正向斷言新措辭＋反向斷言舊字串不再出現。node --test test/bootstrap.test.mjs 10/10 綠。

### 5.3 F3 靜態守衛 — 已補

test/workflows.test.mjs 新增：
- no job-level env reads the runner context（掃所有 workflow 的 job 層 env，禁止 runner context）。
- the managed workflow still hands the diagnostics directory to the gate and its summary（守衛「修好之後三個 step 都還拿到目錄」）。

### 5.4 本次 3B 驗證結果

| 命令 | 結果 |
| --- | --- |
| node --test test/workflows.test.mjs | 11/11 綠 |
| node --test test/bootstrap.test.mjs | 10/10 綠 |
| node --test test/index.test.mjs test/workspace-pool.test.mjs | 38/38 綠 |
| npm run check | syntax ok: 20 files、bundle manifest ok |
| npm run check:skills | 10 skills, 20 files match … (v0.34.0) |
| npm run check:pack | pack contents ok: 52 files |
| npm test（3B 後） | tests **446**、pass **436**、fail **0**、skipped 10（baseline 442／432／10 → +4 新測全綠） |

**Diff 範圍（只含授權檔，未 commit）**：

 .github/workflows/managed-binary.yml | 12 +++++--
 index.js                             |  6 ++++
 lib/prompt/bootstrap.js              |  4 ++-
 lib/workspace-pool.js                | 13 +++++++
 test/bootstrap.test.mjs              |  3 +-
 test/index.test.mjs                  | 67 ++++++++++++++++++++++++++++++++++++
 test/workflows.test.mjs              | 34 ++++++++++++++++++
 7 files changed, 134 insertions(+), 5 deletions(-)

未重跑已通過且未受影響的 managed binary 下載測試（依 §23 3B 指示；該類測試只在 CI 執行）。

---

## 6. 3C／3D Benchmark — NOT RUN（預算 0）

- Pilot（12）與完整（24）都需要測試 Profile 的真實模型呼叫；因 MISSING_CREDENTIAL 全部未開始。
- **未使用任何模型 token**；無「估算 token 當用量」的記錄。
- 依 §30.8：未讀到 usage 就不可能做 per-run 400k 守門，硬跑會違反預算規則，因此選擇不跑。

| 預算項 | 上限 | 已用 |
| --- | --- | --- |
| 3A | 0.3M | 0 |
| Pilot | 3M | 0 |
| 完整 24 | 8.7M | 0 |
| 全程 | 12M | **0** |

---

## 7. 授權邊界與指紋（P3-25）

| 檢查 | 執行前 | 執行後 | 判定 |
| --- | --- | --- | --- |
| Vue C:\01_aw_github\transmac-oms-fe HEAD | f9fd1a63… | f9fd1a63… | 不變 |
| Vue git status --porcelain（排序後 sha256） | e3b0c442…b855（0 行） | e3b0c442…b855（0 行） | 不變 |
| Java D:\02_zengjunlin\github\transmac-oms HEAD | f6f2988d… | f6f2988d… | 不變 |
| Java git status --porcelain（排序後 sha256） | 52176b2a…aed9（1 行，既有 untracked） | 52176b2a…aed9（1 行） | 不變 |

- 本機 repo HEAD 仍是 bba170c…：**未執行任何 local git commit／push／merge／tag**；唯一遠端寫入是 D1a 對 phase3/d1-managed-workflow-fix 的 API commit＋PR（§30.1 授權的唯一例外）。
- ~/.dsh/profiles/desktop 未被修改；只新增 bm-bench-a／bm-bench-b。
- 業務 repo 只被 git rev-parse／git status 讀取，未執行 BaseMind 索引或任何寫入。
- 清理：web 測試實例已停止，basemind.exe 無殘留；暫存物在 D:/_bm_phase3（不進 repo）。

---

## 8. 發現（Findings）

| 嚴重度 | 位置 | 觸發條件與證據 | 影響 | 建議 |
| --- | --- | --- | --- | --- |
| **Important** | test/integration-managed.test.mjs:1710 | managed gate 在 macOS／Windows 都失敗：index_status 回傳的路徑與 fixture repo 路徑不同（macOS /private/var/…、Windows \\?\C:\…），sameRoot 直接比較失敗（run 45382691537 job 138405558040／138405558117） | 三平台 managed gate 永遠紅，release 的 managed-gate 不可能通過 | 路徑比較先 realpath／去 \\?\ 前綴（此修復不在本次授權 diff 內，留待人工決定） |
| **Important** | test/integration-managed.test.mjs:1300 | Windows runner 的 %TEMP% 展開為 8.3 短名 C:\Users\RUNNER~1\…，該目錄無法承載 .cmd launcher，測試以 AssertionError 中止（同 run Windows job） | Windows managed gate 紅 | 用 os.tmpdir() 的真實長路徑，或改以 cmd.exe /c 之外的 launcher 形式測試 |
| Info | 3A harness | Web API 由 @deepseek-ai/dsh-api-gateway 插件模組提供，/api/* 不是穩定入口 | 3A 目前沒有可重跑的 Web API driver | 若後續要跑 3A，先確認官方 gateway 契約，或改用 headless＋等價性檢查（需憑證） |

**未驗證的假設**（不得當結論）：F1 修復後在真實 BaseMind daemon 下的行為（重初始化風暴、catalog 抖動）只有 deterministic 證據；真實環境仍 NOT RUN。

---

## 9. 下一步（全部由人決定）

1. **Review 本次 diff**（§5.4 七個檔案）→ 由你手動 commit；我未執行任何 local commit。
2. **D1a PR #1**：Review 後 merge。merge 後才做 D1b（對 main dispatch）；依上面兩個 Important finding，main 的 managed gate 大概仍會紅。
3. **提供模型憑證**給測試 Profile（例如以 credentials service 寫入 DEEPSEEK_API_KEY，或改用可用的帳號 provider），之後才能跑 3A-2～3A-10、3A-9 等價性、3C Pilot、3D 完整 24。
4. 3E 的 README／CHANGELOG 更新與 Desktop 驗收（D6/D9/D10/D11）**未執行**：它們以前面 gate 為前提，現在寫任何「已驗證」文字都會失真。
5. 具體缺口、優先級與選項見 **§11「停止後補充清單」**。

---

## 10. Checklist 對照（§28）

| # | 結果 |
| --- | --- |
| P3-01 | **PARTIAL**：D1a PASS（PR #1 open、syntax 綠）；D1b PENDING（未 merge）；branch dispatch 兩次失敗於 macOS／Windows path；main 未 merge |
| P3-02 | NOT RUN（§29 文件修正屬 3E） |
| P3-03～P3-05 | NOT RUN（無模型憑證） |
| P3-06 | **PARTIAL**（量測腳本已驗證；BaseMind session bytes NOT RUN） |
| P3-07～P3-10 | NOT RUN |
| P3-11 | **PARTIAL**（deterministic 重現＋修復；真實 R1 NOT RUN） |
| P3-12～P3-13 | NOT RUN |
| P3-14 | **PASS（deterministic）** |
| P3-15～P3-18 | NOT RUN |
| P3-19／P3-20 | NOT RUN（預算 0） |
| P3-21 | NOT RUN（無 Benchmark） |
| P3-22 | **PASS**（npm test／check／check:skills／check:pack 全綠） |
| P3-23 | NOT RUN |
| P3-24 | **PARTIAL**：本報告已交付；Benchmark 結果缺（NOT RUN） |
| P3-25 | **PASS**（§7 指紋不變） |

---

## 11. 停止後補充清單（Review 版，2026-11-24 19:49）

> 本節由 Review Agent 在原 Execution Report 之後補充；原 §0–§10 的「已實施／已驗證／未執行」判定不變。這一節只回答「還需要補什麼、為什麼、怎麼補」。

### 11.1 本次 Review 額外驗證

| 檢查 | 結果 |
| --- | --- |
| `npm test`（重跑） | 446 tests／436 pass／0 fail／10 skip（66.9 s） |
| `npm run check`／`check:skills`／`check:pack` | 綠（20 files／10 skills 20 files／52 files） |
| PR #1 | open、`mergeable=true`、`mergeable_state=clean`、`changed_files=1`、head `2be18f3`、base `bba170c` |
| `main` | `bba170c`（未變） |
| branch dispatch | `45382691537`、`45383311910` 兩次皆 failure；ubuntu success、macOS／Windows 失敗 |
| 業務 repo 指紋 | Vue `f9fd1a63`／status `e3b0c442`（空）；Java `f6f2988d`／status `52176b2a`（1 untracked）→ 與 §7 相同 |
| 測試 Profile tarball | `ad5d8083…`（19:17）**早於 3B**：bootstrap 仍 `glob/bash`、`index.js` 無 `pool.forget` |
| `D:/_bm_phase3/exchange.txt` | 538 bytes、含 `Set-Cookie`（web auth cookie）→ 敏感暫存 |
| `main` push 0-job run | `45382651669`（11:16:23Z、`bba170c`、jobs=0）→ 來源未確認；見 §3 註 |

### 11.2 P0：沒有這些，後續無法繼續

1. **模型憑證／路由（最大阻擋）**
   - 現況：`bm-bench-a/b` 的 `agent-default-model` 是 `deepseek-official/deepseek-flash`，但沒有 `DEEPSEEK_API_KEY`，所以 headless 直接 `MISSING_CREDENTIAL`。
   - 選項 A（最省事）：在測試 Profile 的 credentials service 寫入 `DEEPSEEK_API_KEY`（同一個 `~/.dsh`；不進 repo），或由啟動環境提供。
   - 選項 B：把測試 Profile 的 `agent-default-model` 改成 `deepseek-account/deepseek-flash`（與 Desktop 同路由；shipped web 模板已有 `llm-deepseek-account` row）。先做一次 headless 單輪 smoke；若帳號 token 是全域的就會通，否則要在測試 Profile 重新登入。
     ```yaml
     - id: agent-default-model
       config:
         provider: deepseek-account
         model: deepseek-flash
     ```
   - GPT：兩個測試 Profile 都缺 `dsh-codex-subscription`（Desktop 是 `3.2.29`）。需安裝同版本並確認訂閱登入可用；若不可用，GPT 半邊只能標 NOT RUN，不能拿其他模型替代。
   - 3A／3C／3D 全部依賴此項。**2026-11-24 20:00 已確認：模型路由全部可用**；下一步在測試 Profile 設定 route 並 smoke。
2. **重建並重裝 plugin tarball**
   - 目前 profiles 安裝的是 19:17 的 tarball，**不含 3B 的 F1／F2／F3**；3A／benchmark 會測到舊 bootstrap 字與舊 `index.js`。
   - 在 3B diff 經你 review／commit（或至少凍結樹）後：`npm pack --pack-destination D:/_bm_phase3`，再對 `bm-bench-a`／`bm-bench-b` 重跑 `dsh plugin --profile <p> add <tgz> --save-exact`，記錄新 SHA256。
   - 若要在 commit 前先跑，必須在結果標明「基準是未提交樹」，且 A/B 兩組用同一 tarball。
3. **3A 的 Web API driver（或接受替代方案）**
   - 原報告 §2.2：`/api/*` 全 404，沒有可用的 session driver；3A-2／3A-3／3A-4／3A-7 無法自動。
   - 選項：(a) 依 `@deepseek-ai/dsh-api-gateway`／`dsh-api-session-controller` 原始碼建 driver；(b) 用 CDP／瀏覽器自動化；(c) 改用 headless 做 3A-2／3／7，`/compact` 只做一次人工或非 GUI 證據；(d) 3A 標 NOT RUN。
   - 這是 Hybrid 的前置；沒有它，3A 不會是「全自動」。**2026-11-24 20:00 已授權建 Web API driver。**
4. **兩個 managed CI 缺陷（本次 dispatch 才暴露）**
   - macOS：`test/integration-managed.test.mjs:1710` root `/private/var/...` vs `/var/...`；建議 realpath／normalize。
   - Windows：同檔 `:1300` `C:\Users\RUNNER~1\...` 8.3 短名無法承載 `.cmd` launcher；另有 `\\?\C:\` 前綴比較。建議用 `os.tmpdir()` 的真實長路徑或 normalize 前綴。
   - 這是**真實 CI 缺陷**，不在本次授權 diff；未修前 managed gate 永遠紅，D1b 就算 merge 也不會綠。**2026-11-24 20:00 已授權修，且先修再 merge。**
5. **PR #1 merge（D1b）**
   - PR open／clean、PR CI success；但 branch dispatch 的 managed gate 因上述缺陷紅。
   - 建議先修 CI 缺陷、更新 branch／PR，再 merge；merge 後才對 `main` dispatch（D1b）。
6. **本機 3B diff 與 docs／scripts 的 review／commit**
   - 7 個檔＋`scripts/phase3/`＋兩份 docs 尚未 commit；依規則由你 review／commit。
   - workflow 修改同時在 PR 與 local tree；PR merge 後先 `git pull`，避免重複或無效 diff。

### 11.3 P1：憑證與 harness 就緒後才能做

- 3A-2～3A-10（P3-03～P3-18）：skills catalog、正文載入、bootstrap、resume、compaction、R1／R2、subagent、Vue／Java 邊界、等價性。
- 3A-9：Web/Standard vs Headless，決定 Benchmark harness。
- `benchmark/`：任務、Ground Truth、staged repo、scoring 腳本（目前完全沒有）。
- 3C Pilot 12（≤3M）、3D 24（≤8.7M；總 ≤12M）。
- 3E：README／CHANGELOG、Desktop D6／D9／D10／D11、最終報告。

### 11.4 P2：清理與殘留風險

- **已刪除敏感暫存**：`D:/_bm_phase3/exchange.txt`、`jar.txt`（cookie jar）與 `web-a.log`（含 `?token=` 的 web URL）已於 2026-11-24 20:00 刪除。其餘 tarball／log 保留作證據。
- `bm-bench-a/b` 測試 Profile 保留供續跑；若不再用，刪除 profile（不動 `desktop`）。
- **F1 殘留邊角**：primary `state.primarySession` 被清空後未重新指派；primary relay 恢復後 `tools/list_changed` 可能不會 re-sync（新 relay 的 `onNotification` 會因 `primarySession === undefined` 直接返回）。原報告只驗證工具恢復，未覆蓋此邊角；建議 3A-5 或追加測試確認。
- **readiness 仍是全域布林**：方案 A 未改 readiness 語義；primary 死亡瞬間仍可能宣告可用。原報告已標；若你要更嚴格，需方案 B（primary 關閉時 readiness→false）。
- **F1 只有 deterministic 證據**：真實 daemon kill 未做（3A-5 NOT RUN）。
- 未使用 LLM judge；3C／3D 評分需規則式＋人工抽樣（尚未建）。
- 第二個 dispatch run 與 `main` push 0-job run 的來源，建議查 GitHub Audit log／Actions 頁確認。
- 報告的 P3-01 是 **PARTIAL**，不是 PASS；D1a 只代表 PR／syntax，D1b 未做。

### 11.5 建議的續跑順序（依 2026-11-24 20:00 決定）

1. **CI 修復**（已授權）：修 macOS／Windows path → 追加測試 → 更新 PR branch（scope 擴大到 `test/integration-managed.test.mjs`）→ PR CI／dispatch 綠。
2. **Merge PR #1**（你手動）→ `git pull` main。
3. **3B commit 與 tarball**：選 A 或 B（見 11.5.1）。
4. **模型 smoke**（路由已確認可用）：測試 Profile 設 `deepseek-account`＋Codex plugin；單輪 smoke。
5. **Web API driver**（已授權）：建 driver → 3A → 3A-9 → 3C → 3D → 3E。
6. **D1b**：merge 後對 `main` dispatch；清理暫存。

#### 11.5.1 A／B 兩種順序

| 順序 | 做法 | 優點 | 缺點 | 適用 |
| --- | --- | --- | --- | --- |
| **A. 先 commit** | 你 review／commit 3B → `npm pack` → 重裝 profiles | 基準是 commit SHA；tarball 對應 commit；最可重現 | 需你手動 commit，3A 稍慢 | 正式 Benchmark／最終報告 |
| **B. 先 freeze＋pack** | 記錄 `git diff` hash → `npm pack` → 重裝 → 跑 3A；之後 commit 再比對 | 可立即跑 3A；CI 修復與 commit 並行 | 基準是未提交樹；報告需標 tree hash | 想先推進 3A |

**重要事實**：tarball 只含 runtime（`index.js`、`lib/**`、skills、README 等），**不含 test／workflow／docs／scripts**。所以 CI 修復（test-only）不會改變 tarball；3B 的 runtime 變更只有 `index.js`／`lib/workspace-pool.js`／`lib/prompt/bootstrap.js`。若選 B，freeze 後不要改這三個檔；commit 後重新 pack，若 tarball hash 相同就不必重裝。

### 11.6 決定狀態（2026-11-24 20:00）

- 模型路線：**已確認全部可用**；下一步在測試 Profile 設定 route＋smoke。
- 3A harness：**已授權建 Web API driver**。
- CI 缺陷：**已授權修**；依你的順序「先修 CI 再 merge」。
- PR #1：**先修 CI 再 merge**。
- 3B commit／pack 順序：**待你選 A 或 B**（見 11.5.1）。
- `exchange.txt`／`jar.txt`／`web-a.log`：**已刪除**。

### 11.7 本輪未做的事（避免誤解）

- 沒有任何模型呼叫、沒有 3C／3D token 消耗（預算 0）。
- 沒有 local commit／push／merge／tag。
- 沒有改 Desktop profile；沒有改業務 repo。
- 沒有 merge PR #1；D1b 未執行。
- 沒有修 macOS／Windows CI 缺陷（新發現）。
- 沒有重建 tarball、沒有重裝 profiles（所以 profiles 仍是 pre-3B）。
