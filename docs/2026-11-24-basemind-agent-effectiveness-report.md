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
| 本機 HEAD | **`d88a746`**（2026-11-24 20:05，工作區乾淨，ahead origin/main 1；未 push） |
| 測試 Profile tarball | `ad5d8083…`（19:17）**早於 3B**：bootstrap 仍 `glob/bash`、index.js 無 `pool.forget`；需從 `d88a746` 重建 |
| `D:/_bm_phase3/exchange.txt` | 538 bytes、含 `Set-Cookie`（web auth cookie）→ 敏感暫存 |

> 上表是 **19:49 的快照**；最新狀態見 §11.8（20:09–20:35 續跑）與 §11.9（20:36 Review）；冷啟動修復見 §11.16，Review 後修正見 §11.17。

### 0.2 完成度判定（2026-11-24 20:40）

**Phase 3 整體需求：尚未完成。** 目前完成的是「Phase 0 harness、D1a、3B、baseline 重建、CI 修復」，不是 Task A–J 的全部。

| 區塊 | 狀態 | 證據 |
| --- | --- | --- |
| Phase 1 | 完成（POSIX 實機證據仍有遺留） | Phase 1 報告、CI |
| Phase 2 | **部分** | branch managed `45391479254` 三平台全綠；但 PR #1 未 merge、main 仍 `bba170c`；Desktop D3–D15 NOT RUN；`compat.yml` 未遠端跑 |
| 3A Lifecycle | **NOT RUN** | 僅 P3-06 PARTIAL、P3-14 deterministic、P3-25 PASS；其餘待真實 Agent |
| 3B Deterministic | **完成** | F1/F2/F3＋測試，446/436/0/10 |
| 3C/3D Benchmark | **NOT RUN** | 0 tokens；無 `benchmark/` 任務／Ground Truth／結果 |
| 3E Final | **NOT RUN** | README／CHANGELOG／Desktop D6/D9/D10/D11 未做 |
| Release Readiness | **未達** | PR 未 merge、main 未變、tag/publish 未做 |

**這一輪已完成的可交付物**：
- D1a：workflow fix＋PR #1（head `39ef670`、changed_files=2）。
- 3B：F1 relay 恢復、F2 bootstrap 措辭、F3 靜態守衛＋回歸。
- baseline：`d88a746` 的 tarball `173e56dd…` 已重裝到兩個 profile（F1/F2 均在）。
- CI：`39ef670` 的 branch dispatch `45391479254` 三平台全綠；PR CI `45391466446` success。
- 模型 smoke：**仍受阻**（`ACCOUNT_SIGN_IN_REQUIRED`／codex `NO_ADAPTER`）；未消耗 token。

**尚未完成、不能宣稱完成的事**：
- PR #1 merge、`git pull --rebase`、D1b 對 main dispatch。
- 測試 Profile 的模型登入／API key（Web API driver 的前置）。
- 3A 全部（skills catalog／正文、bootstrap、resume、`/compact`、R1/R2、subagent、Vue/Java 邊界、等價性）。
- `benchmark/` 任務／Ground Truth／staged repo／scoring；3C Pilot 12；3D 24 no-reuse。
- 3E README／CHANGELOG、Desktop D6/D9/D10/D11、最終 Review。
- local `d88a746` push（目前 ahead 1、未 push）；本報告未提交。

### 0.3 最新進度快照（2026-11-24 21:40）

> §0.2 是 20:40 快照；以下為最新。詳細證據見 §11.10–§11.14。

| 項目 | 現況 |
| --- | --- |
| `main` / PR | `2a17e9b`；PR #1 **merged**（merge commit `9609872`）；D1b run `45398697251` **三平台全綠**；CI push main success |
| 3A | 暖機後：P3-03／04／05／07／08／11／14／16／25 **PASS**；P3-06 **PARTIAL**；P3-09／10／12／13／15／17／18 **NOT RUN** |
| 3A 成本 | 4 個主要 session 合計 **572,671** tokens＋smoke **25,961** ≈ **598,632**；已超過原 3A 子預算 0.3M（總 12M 仍充足） |
| 3C／3D | **NOT RUN**；`benchmark/` 缺失；無 Pilot／24 次結果 |
| 3E | **NOT RUN**；README／CHANGELOG 未改；Desktop D3–D15 NOT RUN |
| 模型 | 3A sessions：`deepseek-account`／`deepseek-flash`／high；GPT 只有 smoke（`openai-codex`／`gpt-6.1-sol`／low），尚未進 A/B |
| 冷啟動 | session `25e9ef88` 第 1 輪 34 tools／0 `mcp__basemind__`；第 2 輪 56／19；暖機後新 session 第 1 輪即 56／19 |
| 工作區 | 只有本報告未提交（§11.13–§11.14）；main 與 origin 同步；無 local commit／push |

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

> 此表是 **原始 Execution 快照**；後續 3A 進度與最新判定見 **§11.13–§11.17**。

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
   - 3B 已於 2026-11-24 20:05 commit `d88a746`（工作區乾淨）：直接從此 commit `npm pack --pack-destination D:/_bm_phase3`，再對 `bm-bench-a`／`bm-bench-b` 重跑 `dsh plugin --profile <p> add <tgz> --save-exact`，記錄新 SHA256。
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
3. **3B 已 commit `d88a746`**：直接 `npm pack`／重裝 profiles（不再需要選 A/B）。
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
- 3B commit／pack 順序：**已完成 commit `d88a746`**；下一步從此 commit 重建 tarball／重裝（見 11.5.1 的 A 路徑）。
- `exchange.txt`／`jar.txt`／`web-a.log`：**已刪除**。

### 11.7 本輪未做的事（避免誤解）

- 沒有任何模型呼叫、沒有 3C／3D token 消耗（預算 0）。
- 沒有 local commit／push／merge／tag。
- 沒有改 Desktop profile；沒有改業務 repo。
- 沒有 merge PR #1；D1b 未執行。
- 沒有修 macOS／Windows CI 缺陷（新發現）。
- 沒有重建 tarball、沒有重裝 profiles（所以 profiles 仍是 pre-3B）。

### 11.8 2026-11-24 20:09–20:35 續跑（baseline 重建、模型 smoke、CI 修復）

**本節由 Execution Agent 於第二輪續跑後追加；§11.1–§11.7 的判定不變。**

#### (1) Gate 0 — PASS

| 項目 | 證據 |
| --- | --- |
| token | User env = set（process env stale；依 §30.5 以 PowerShell 讀取，只印 set/unset） |
| GET /repos/… | 200；GET /actions/workflows 200 |
| HEAD | d88a746bffa4cc6aba7cb95f00b73368d9ecc5bb（local main ahead 1；origin/main bba170c） |
| npm test baseline | tests 446／pass 436／fail 0／skipped 10（69,614 ms） |

#### (2) Tarball 重建與 profiles 重裝 — PASS

- 舊包保留：D:/_bm_phase3/dsh-basemind-plugin-0.2.0.pre3b.tgz = ad5d8083…8801dcb
- 新包（d88a746）：dsh-basemind-plugin-0.2.0.tgz = **173e56dd1da4940e9eeab0848e9d6673fda84354cf49ccff3c16cf17d7cb1955**
- **坑**：pnpm 對「同路徑 file: 依賴」會回 Already up to date 而不換內容；必須用新檔名（…-d88a746.tgz）add 才會重新解析。
- 兩組驗證（~/.dsh/profiles/<p>/node_modules/dsh-basemind-plugin/）：
  - lib/prompt/bootstrap.js 含 shell tools = 1（F2 已生效）
  - index.js 含 pool.forget = 1（F1 已生效）

#### (3) 模型設定 — 設定完成；smoke 受阻

- 兩個 profile patch 加入 agent-default-model → deepseek-account／deepseek-flash（--dump-config 已驗證）。
- dsh-codex-subscription@3.2.29 已裝入兩個 profile（dump 可見 codex 條目）。
- 兩個 profile 的 web app 都能 boot，無 activation warning；但 **spawned CLI 取不到 app 內憑證**：

| 路由 | smoke 結果 |
| --- | --- |
| deepseek-account／deepseek-flash | ACCOUNT_SIGN_IN_REQUIRED：Sign in to DeepSeek to use the account provider. The request destination must allow account authentication. |
| openai-codex／gpt-6.1-sol（shipped headless ＋ 插入 profile 的 codex plugin） | codex-subscription pending (waiting for service: credentials) → NO_ADAPTER |

- 依指示未以其他模型替代；**模型 token 消耗仍為 0**；3A／3C／3D 仍 **NOT RUN**。
- 結論：解鎖方式只有兩條——(a) 在已登入的 web app 內建 Web API driver；(b) 由 credentials service 寫入 DEEPSEEK_API_KEY。

#### (4) CI 修復 — 已實施並本地驗證

- 遠端 commit **39ef670c982c9c108014bb09b8cb1b1c7568dc9e**（parent 2be18f3），**只改 test/integration-managed.test.mjs（+52/−2）**。
- normalizeRoot → 新增 resolveRealPath：strip \\?\ → path.resolve → realpathSync.native（不存在時 fallback 原路徑）。
- M4 version-shim：fake local launcher 改在 resolveRealPath(ROOT) 的**真實長路徑**建立；guard（空格／metacharacter）保留、未放寬、未 skip。
- 新增 unit test（無 skip）：verbatim 前綴、..、空字串、子目錄不符、macOS /var↔/private/var、win32 temp 前綴。
- 本機 worktree（detached 2be18f3）：node --test **443 tests／433 pass／0 fail／10 skip**、npm run check 綠；**未**下載 managed 套件（完整驗證交給 dispatch）。

#### (5) 遠端 CI 驗證 — 三平台全綠

| 項目 | 結果 |
| --- | --- |
| branch dispatch run 45391479254 | plan success、ubuntu-latest success、windows-latest success、macos-15 success → **ALL GREEN** |
| PR CI run 45391466446（pull_request） | success |
| PR #1 | open、head 39ef670、changed_files=2、mergeable=true、mergeable_state=clean |

**停點：PR 可 merge（本輪不 merge、不 push main、無 local commit）。**

#### (6) 邊界與清理

- local HEAD 仍 d88a746；工作區只有本報告未提交；未改 Desktop profile；業務 repo 只讀。
- 已移除暫存 worktree D:/_bm_phase3/wt-pr1；含 ?token= 的 boot log 與 cookie jar 等敏感暫存已刪除。

#### (7) 仍未完成

- **D1b**：PR merge 後才對 main dispatch（本輪不做）。
- **3A／3C／3D**：被模型 driver 阻擋（§11.2 第 3 項），本輪未開始。
- 3E 的 README／CHANGELOG／Desktop 驗收仍未做。

### 11.9 Review 驗證（2026-11-24 20:36）

- §11.8 的 PR／CI 宣稱已覆核：PR #1 head `39ef670`、changed_files=2、mergeable_state=clean；run `45391479254` 的 plan／ubuntu／windows／macos **全 success**；PR CI `45391466446` success。
- CI 修復 diff 已審：`normalizeRoot → resolveRealPath`（strip `\\?\`、`path.resolve`、`realpathSync.native`，不存在時 fallback）；M4 fake launcher 改用真實長路徑；guard 未放寬、未 skip；新增 unit test。**未發現 blocking issue。**
- Tarball `173e56dd…` 與兩個 profile 安裝內容已核對：`bootstrap.js` 含 `shell tools`、`index.js` 含 `pool.forget`。
- **模型 smoke 的阻擋仍成立**：test profile 的 headless 取不到 app 內憑證（`ACCOUNT_SIGN_IN_REQUIRED`／codex `NO_ADAPTER`）。Desktop 已登入 ≠ 測試 Profile 已登入；需在測試 Profile 的 web app 登入，或由 credentials service 寫入 API key。Web API driver 只有在已登入的 web app 內才有意義。
- 本機狀態：HEAD `d88a746`、工作區只有本報告未提交；未 push、未 merge；docs 與 `D:/_bm_phase3` 的 secret scan 無命中。
- **結論**：從 CI 角度 PR #1 可 merge；merge 後你需 `git pull --rebase origin main` 把 `d88a746` 接到新 main，並完成模型登入／API key，才可進 3A。

### 11.10 2026-11-24 20:39–21:10 續跑（第三輪）：D1b 前置未成立；模型路由可用（更正 §11.8）；3A harness 受限

#### (1) Gate 0／baseline — PASS

- token：User env = set（process env stale）；GET /repos 200；HEAD d88a746；npm test **446／436 pass／0 fail／10 skip**（44.2 s）。

#### (2) D1b — BLOCKED（前置與宣稱不符）

| 檢查 | 結果 |
| --- | --- |
| PR #1 | state=open、**merged=false**、head=39ef670、base=bba170c |
| main ref | bba170c（未 merge） |
| POST dispatch(ref=main) | **422** Invalid Argument — Line: 88, Col: 32: Unrecognized named-value: 'runner' |

→ main 仍是舊 workflow；依禁止條款未 merge、未 push，D1b 維持 **PENDING**。

#### (3) 模型路由 — 兩條都可用（**更正 §11.8**）

§11.8 的「spawned CLI 取不到憑證」是 overlay 少插 credentials service 造成的誤判；補上 dsh-credentials-local 後：

| 路由 | provider／model | effort | usage | 結果 |
| --- | --- | --- | --- | --- |
| DeepSeek | deepseek-official／deepseek-flash | high | 12,783（input 12,735／output 48） | completed，text "OK" |
| GPT | openai-codex／gpt-6.1-sol | low | 13,178（input 13,173／output 5） | completed，text "OK" |

- 累計模型 token 約 26k（2 次 smoke）；失敗的 probe 沒有 usage。

#### (4) 3A harness 探測 — 未通過（plugin 在 headless 未生效）

- 以 --patch 插入 profile 的 plugin build（file:// 與 overlay 目錄名稱兩種解析都試）：
  - --dump-config 可見 id: dsh-basemind 的 row；
  - runtime request/header 仍只有 **24 個原生工具、無 mcp__basemind__***；system message 3,130 bytes 無 bootstrap 段；無 skills catalog；
  - 即使 discoveryRoot: default 亦相同。
- 推定（未證實）：headless 的 agent 建立不會觸發 plugin 的 agent/created、也沒有 deployment default directory，relay 未啟動，且 plugin 未輸出 warning。
- 結論：3A 仍需可用的 Web API driver。本輪已讀 client bundle：gateway 是自訂 remote-stream RPC（rpcId／rpc.open／RemoteStream／WebSocket），**driver 未完成**。

#### (5) 未執行

3A-2～3A-10、3A-9、3C、3D、3E（前置未成立）。

#### (6) 需要的人工動作

1. 在 GitHub merge PR #1（我不 merge），之後才能做 D1b。
2. 決定 3A harness：完成 Web API driver（需先取得 gateway 契約），或授權 headless 之外的替代方案。

#### (7) 邊界

無 local commit／push／merge；未 merge PR；main 未改；Desktop profile 未改；業務 repo 未動；未輸出 token；測試 web 實例已停止，含 token 的暫存檔已刪除。


### 11.11 2026-11-24 20:58–21:08 續跑（第四輪）：PR #1 merge、D1b 三平台全綠

#### (1) merge 確認

| 檢查 | 結果 |
| --- | --- |
| PR #1 | state=closed、**merged=true**、merge_commit=**9609872ec9b262be58fbebe1c66c7b4ca99ea037**、head=39ef670 |
| origin/main（fetch 後） | 9609872ec（本機 HEAD 仍 d88a746，未 rebase／未 push） |
| main workflow | 已可解析（先前 422 的 Line 88 runner 錯誤消失） |

#### (2) D1b — PASS

- POST dispatch(ref=main) → **204 accepted**。
- run [45398697251](https://github.com/zengjunlin2022/dsh-basemind-plugin/actions/runs/45398697251)：conclusion=**success**、head=9609872ec。
- jobs：plan the matrix **success**、managed install (ubuntu-latest) **success**、managed install (macos-15) **success**、managed install (windows-latest) **success**。

→ P3-01 的 D1a＋D1b 兩段都成立：PR 已 merge、push 後無 invalid workflow、local test 綠、main dispatch 三平台全綠。

#### (3) 3A Web API driver — 契約已定位（driver 尚未實作）

從 app.asar 抽出原始碼（dsh-api-gateway、dsh-api-session-controller）後確認：

- **unary**：Client 以 connection 的 RPC 呼叫，路徑 **/api**（endpoint＋named args）；Host 由 Gateway 驗證後派發。
- **stream**：WebSocket **/api/remote.mux**（rpcId／open／item／end／cancel 帧）。
- session controller 的 Remote 端點：list／search／create／selectModel／modelCatalog／openWorkspacePath／workspacePathApplications／rename／fork／prompt／attachment／updateQueue／cancel／page，另有 mode: stream 的端點。
- 仍需補：unary 請求 envelope（peer、correlation）與 /api/remote.mux 握手細節後才能實作 driver。
- 因此 **3A-2～3A-10 仍 NOT RUN**；3C／3D／3E 亦未開始。

#### (4) 邊界

無 local commit／push／merge／rebase；未改 main；Desktop profile 未改；業務 repo 未動；未輸出 token。

### 11.12 2026-11-24 21:10–21:20 續跑（第五輪）：Web API driver 完成，3A-2 首次取得真實證據

#### (1) Driver（新增 scripts/phase3/web-api.mjs）

- 契約（來自 app.asar 原始碼）：unary 以 POST /api/<namespace>/<method>，body 為 { type: 'client-request', rpcId, method, payload: { args } }；回應 { rpcId, result: { ok, value } }；Peer 由已驗證連線提供，不在 payload。
- args 是 **named 參數**：session/create、session/prompt 等都要包成 { request: {...} }（第一次直送 cwd 得到 gateway/arguments-invalid：missing "request"）。
- 認證：GET /?token=… → 303 + dsh-auth cookie；之後帶 cookie 呼叫 /api。
- 已封裝：exchangeToken、createClient（call／createSession／prompt／page／list／cancel）。

#### (2) 3A-2 實測（profile bm-bench-b，Standard preset）

- 建 session：sessionId session-25e9ef88-7ab2-47a1-aa06-639bb39871cf、**agentPreset=standard**。
- prompt 受理：{ accepted: true }；兩輪完成（turn/end ×2）。
- **冷啟動差異（重要）**：
  | 請求 | 工具總數 | mcp__basemind__ | bootstrap |
  | --- | --- | --- | --- |
  | 第 1 輪 | 34 | **0** | 無 |
  | 第 2 輪 | 56 | **19**（18 verb ＋ cli） | 有（system message 10,350 bytes） |
- 第 2 輪 Agent 實際呼叫 index_status，回報 root = **\\?\D:\02_zengjunlin\github\dsh-basemind-plugin**（Win32 verbatim 前綴；與 CI 修復的是同一類問題），並指出索引仍在 scan/extract。
- usage（整段 session）：input 32,787／output 1,211／cacheRead 54,912／**total 88,910**。
- skills catalog：未觀察到（user/message 全部沒有 skill/catalog source）→ **P3-03 仍未取得證據**；需再查 catalog 注入時機或 provider 是否註冊。

#### (3) 判定

- P3-04／P3-05 的第 2 輪有初步證據（工具與 bootstrap 存在），但尚未做「載入 skill 正文」與「多輪不累積」的正式檢查 → 仍 **PARTIAL**。
- 3A-3～3A-10、3A-9、3C、3D、3E **NOT RUN**。

#### (4) 下一步（可直接續跑）

1. 以「暖機後再量測」的方式重跑 3A-2（第一輪只暖機，第二輪起取證），並確認 skills catalog 的注入條件。
2. 續做 3A-3（resume）、3A-4（/compact；可能需要 GUI 或 commands API）、3A-5（relay R1/R2）、3A-6（subagent／多 session）。
3. 以 driver 建 benchmark runner：每 run 新 session、暖機一輪、記錄 usage、套 per-run 400k 守門。

### 11.13 2026-11-24 21:25–21:50 續跑（第六輪）：3A-2 取證完成（暖機法）、catalog 與 skill 載入通過

#### (1) 暖機法（重要操作結論）

冷 process 的第一個 session 第 1 輪沒有 BaseMind 工具（34 tools、無 mcp__basemind__、無 bootstrap）；先跑一個暖機會話後，**新 session 的第 1 輪即有 56 tools／19 mcp__basemind__／bootstrap 10,350 bytes**。benchmark 與 3A 都必須「暖機後再量測」。

#### (2) skills catalog（P3-03 PASS）

- 量測修正：web session 的 user/message 文字在 data.content（不是 data.message.content）。
- 實測：skill-catalog 訊息 1 則、**6,076 bytes**，列出 **10 個 basemind skills**（code-search、cli、comms、doctor、documents、git-history、multi-agent-room、scan、stats、basemind 本體）。

#### (3) skill 正文載入＋實際使用（P3-04 PASS）

session session-8a1f9e4c：tool 序列 skill → mcp__basemind__code_symbols → mcp__basemind__code_read；結果正確指出 scripts/phase3/web-api.mjs 的 createClient 在 line 19（本體 19–43），回答中明寫載入 basemind-code-search；tool errors = 0；usage total 138,163。

#### (4) 其他量測

- P3-05（bootstrap）：system message 10,350 bytes 含 BaseMind 段；同一 session 多輪仍只有 1 個 system message（未累積）。
- P3-06（成本量測）：system 10,350 bytes、tool schema 36,531 bytes、catalog 6,076 bytes；usage 可由 session log 取得（例：63,547／88,910／138,163）。
- P3-15（跨工作區）：session 指向非專案目錄 D:/_bm_phase3/ws-a 時 index_status 直接報錯（BaseMind 要求 project root），不是插件路由錯誤；跨 repo 隔離測試需改用兩個真實 repo。

#### (5) 3A-9 等價性結論

headless + --patch 插入 plugin 時 request/header 從未出現 mcp__basemind__*（重複驗證）→ headless 不等價。依 D10 fallback：**Benchmark harness 改用 Web API**（driver 已可用）。

#### (6) 仍未完成

3A-3 resume（跨 process）、3A-4／P3-09／P3-10 compaction（session-controller 無 compact 端點）、3A-5 R1／R2 relay 終止、3A-6 subagent、3A-8 Vue／Java 邊界、3C Pilot、3D 24、3E。

### 11.14 2026-11-24 21:36–21:52 續跑（第七輪）：resume、R1 relay 恢復、subagent 實測

#### (1) P3-07／P3-08 resume — PASS

- session session-5916a54c 在**換 process**（原實例終止、重新開機同 profile／同 port）後成功續跑：
  - turn 數 4（重啟前 3、重啟後 1）、session 檔仍只有 1 個（未分裂）；
  - 兩次 request 都是 56 tools／19 mcp__basemind__；system message 只有 1 份（未重複）；
  - Agent 正確回顧先前 4 次 root 回報（verbatim 前綴 + D:/02_zengjunlin/github/dsh-basemind-plugin、HEAD 2a17e9b、索引 64 檔）；
  - 整段 usage total 253,024。

#### (2) P3-11 R1（primary relay 終止）— PASS（真實環境）

- 以 Stop-Process 終止 basemind serve（PID 16844）。
- 之後 3 次 index_status 呼叫**全部成功、0 tool error**，並自動長出新的 serve process（PID 2712）。
- 回報值正確（root／branch main／HEAD 2a17e9b／索引 64 檔）→ **3B 的 F1 修復在真實 web app + 真實 relay 下成立**。

#### (3) P3-12 R2 — NOT RUN

需要第二個真實專案 repo 與其獨立 relay；本輪只有一個 workspace，未測。

#### (4) P3-16 subagent — PASS（基本）

- 父 session session-8427cca6：tool 序列 subagent → wait_agent；無 tool error。
- 子代理（root-reporter）回覆 verbatim 前綴 + D:/02_zengjunlin/github/dsh-basemind-plugin，與父層一致 → 子代理有 MCP 工具且 cwd 正確，未污染父層。
- 父 session usage total 92,574。

#### (5) P3-09／P3-10 compaction — NOT RUN

- dsh-api-session-controller 沒有任何 compact 端點（原始碼僅有 "compact stream" 等無關字樣）；Web API 無法觸發 /compact。
- 依計畫 §11.2，compaction 需 GUI（或 commands API）；本輪不改產品程式碼。

#### (6) 仍未完成

3A-8（Vue／Java 邊界）、3C Pilot、3D 24、3E（3A-9 已下結論：Web API）。

### 11.15 當期進度檢查（2026-11-24 21:40）

**已完成**
- `main` = `2a17e9b`；PR #1 merged；D1b `45398697251` 三平台全綠；CI push main success。
- 3A 暖機後：P3-03／04／05／07／08／11／14／16／25 PASS；P3-06 PARTIAL；3A-9 結論 Web API。
- 3A usage（4 個主要 session）：25e9ef88 88,910＋8a1f9e4c 138,163＋5916a54c 253,024＋8427cca6 92,574 = **572,671**；加 smoke 25,961 ≈ **598,632**。

**Open findings**
1. **冷啟動 gap（Important candidate）**：`25e9ef88` 第 1 輪 34 tools／0 `mcp__basemind__`、無 bootstrap、catalog 4,809 B；第 2 輪 56／19、bootstrap 10,350 B、catalog 12,020 B。暖機後新 session 第 1 輪就有 56／19。這表示真實新 session 的第一輪可能沒有 BaseMind 工具／引導；benchmark 的暖機法會掩蓋它。**P3-03／P3-05 應標「暖機後 PASS」，不是無條件 PASS。** 需決定：最小 readiness 修復，或在文件明示 first-turn 限制。
2. **3A 子預算超支**：≈598,632 > 原 0.3M；總 12M 仍充足。需調整 3A 子預算或停止再花。
3. **Compaction 仍 NOT RUN**：session-controller 無 compact 端點；commands namespace／GUI 尚未探索；P3-09／10 不能算完成。
4. **P3-12／13／15／17／18 NOT RUN**：R2 secondary relay、R3 daemon unavailable、多 session 隔離（需兩個真實 repo）、插件停用／重載、Vue／Java 邊界。
5. **3C／3D／3E 未開始**：`benchmark/` 缺失、README／CHANGELOG 未改、Desktop D3–D15 NOT RUN。
6. **GPT 尚未進 A/B**：只有 smoke（`openai-codex`／`gpt-6.1-sol`／low）；3A 全部是 DeepSeek。需確認 GPT route 在 benchmark profile 可重現。
7. **報告／工作區**：§11.13–§11.14 未提交；main 與 origin 同步；無 local commit／push。
8. **時戳**：§11.14 寫 21:36–21:52，但目前 21:40；以 session log 時間為準，建議校正。

### 11.16 2026-11-24 21:48–22:15 Phase A：新 session 第一輪冷啟動修復

#### (1) 結論

冷啟動 gap 已修復並在真實冷 process 驗證：第一個 session 的第 1 輪由 **34 tools／0 `mcp__basemind__`／無 bootstrap／catalog 無 basemind skills** 變成 **54 tools／19 `mcp__basemind__`／bootstrap（system 10,350 B）／10 個 basemind skills**；同一 process 的第二個 session、以及第 2 輪都正常。根因是插件違反 host 的「`agent/created` listener 完成前不釋放排隊工作」契約，不是 DSH host 問題。

#### (2) 重現（修復前，冷 process）

- 新 web 實例：`dsh bm-bench-b --no-open --port 0`（先清 `DSH_WEB_URL`／`DSH_PROFILE_DIR`／`DSH_PROFILE`／`DSH_SESSION_ID`），log `D:/_bm_phase3/cold/cold-a.log`。
- 同一 process 連續建兩個 session、各自在 `session/create` 後立刻送第一個 prompt（不暖機）。
- 讀 `session.v4.jsonl.zstd` 的第一個 `request/header` 與 `system/message`：

| session | 第 1 輪 tools | `mcp__basemind__` | system bytes | bootstrap | catalog entries／basemind skills |
| --- | --- | --- | --- | --- | --- |
| 19c321d6（第 1 個） | 34 | **0** | 6,334 | 無 | 8／0 |
| 2eae3750（第 2 個，同 process） | 34 | **0** | 6,334 | 無 | 8／0 |

重現成功。

#### (3) 根因（先證據）

- **host 契約**：`dsh-agent-loop/src/index.ts` 建立 agent 時 `await loopCtx.agents.announce(agent, …)`（:638）；`dsh-agent/src/index.ts` 對 `createAgent` 的說明明寫「awaits serial `agent/created` listeners **before releasing queued work**」（:176）；`dsh-agent-loop/src/index.ts:506` 在 publication 未完成時 `await publication.promise`，因此第一個 prompt 的 turn 一定等 announce（含 listener）完成。
- **插件行為**：`index.js` 的 listener 是 `void adoptAgentRoot(agent)`（fire-and-forget）。announce 立即完成，relay 的 spawn／`initialize`／`tools/list` 仍在背景跑，於是第一輪在 `agent/pre-step` 之前的 `tools.resolve`（`agent-loop/src/agent.ts:298`）與 `systemPrompt.assemble`（:300）就已定稿，工具與 prompt section 都還沒註冊。
- **skills catalog 同理**：catalog 由 `dsh-tool-skill` 在第一個 `agent/pre-step` 以 `ctx.skills.snapshot()` 計算（`dsh-tool-skill/src/index.ts:217–230`）；插件 readiness 未成立時 provider 回空清單。
- **為何不在 `agent/pre-step` gate**：pre-step waterfall 在工具解析與 prompt 組裝**之後**才 dispatch（agent.ts:298–303），在那裡等待無法補上本輪工具；`agent/created` 才是正確且 host 已 await 的位置。**不是 host bug，也不需要改 DSH。**

#### (4) 最小修復

- `index.js`：`agent/created` listener 改為 `return adoptAgentRoot(agent, payload?.signal)`，把初始化 promise 交回 host。
- 新增 `settleWithin()`（timeout／AbortSignal race）、`startPrimary()` 與 `state.initPromise`：併發建立會加入同一個 attempt；`waitForPrimary()` 有界等待直到 ready／blocked／attempt 結束。
- 邊界與 fallback：預設 `coldStartTimeoutMs = 15000`（`lib/config.js`，0 = 停用 gate，上限 120,000）；timeout／abort／失敗只記一則 warn（或 debug）後照常進行。**只有第一次 attempt 會 gate**（`!state.attempted || state.initPromise !== undefined`）：失敗後的背景重試維持原行為，避免每個新 session 都被失敗時間拖慢。
- 未新增常駐服務、未改 Workspace Pool／MCP Bridge／Skills Provider、未改 DSH host、未新增 dependency。
- 同步更新：`test/index.test.mjs`（fake ctx 的 `emit` 改成會 await listener，模擬 `ctx.serial`）、`fixtures/fake-mcp-server.mjs`（`FAKE_MCP_INIT_DELAY_MS` 模擬慢 handshake）、`test/config.test.mjs`、`CHANGELOG.md`。

#### (5) 驗證

**(a) deterministic（新增 5 個 case）**

| case | 結果 |
| --- | --- |
| 慢 relay（500 ms）下建 agent | creation 等 ≥300 ms；resolve 時 tools 與 `mcp:basemind` section 已存在；無 timeout warn |
| 同時兩個 agent | 兩者都等同一個 relay，只 spawn 1 個 relay |
| budget 200 ms＋relay 1500 ms | creation < 3 s；warn 含 `not ready within 200 ms`；背景仍補註冊，工具無重複 |
| `coldStartTimeoutMs: 0` | 立即返回（<400 ms），工具之後出現 |
| BaseMind 不可用（`launchable:false`） | creation < 5 s；有 `BaseMind startup failed`；無 tools、無 sections |

`npm run check`：syntax ok（20 files）、bundle manifest ok。

**(b) 真實冷 process（修復後）**

- 以 working tree `npm pack`（未 commit）安裝到新 test profile `bm-bench-c`，冷啟 `dsh bm-bench-c --no-open --port 0`。
- `create1 = 694 ms`（gate 等待 relay handshake）、`prompt1 = 17 ms`；第二個 session `create2 = 51 ms`。
- 第 1 輪（兩個 session 都是）：**54 tools／19 `mcp__basemind__`**、system **10,350 B**（含 bootstrap）、catalog **18 entries／10 basemind skills**。
- 第 2 輪：`turn/end` 正常；`request/header` 全 session 只記一次（工具集未變，agent.ts `toolsChanged`），無重複註冊、無 tool error。

| session | 第 1 輪 tools | `mcp__basemind__` | system bytes | bootstrap | catalog entries／basemind skills |
| --- | --- | --- | --- | --- | --- |
| 0997fd98 | 54 | **19** | 10,350 | 有 | 18／**10** |
| 2c02a801（同 process，第 2 個） | 54 | **19** | 10,350 | 有 | 18／**10** |

**(c) 失敗路徑（真實冷 process）**

- `bm-bench-d`：plugin row 設 `command: basemind-missing-for-the-cold-start-probe`、`binaryDownload: false`、`binaryFallback: false`。
- `create1 = 85 ms`、`create2 = 69 ms`（**無 15 s hang**）；第 1 輪 **32 tools／0 `mcp__basemind__`**（fallback 照常進行，與修復前一致）。
- 專屬可診斷訊息由 `test/index.test.mjs` 斷言（`not ready within …`／`BaseMind startup failed`）；host 的 plugin logger 不寫入 web process stdout，故真實 run 以行為（不 hang、照常進行）為證據。

**(d) `npm test`**

- 完整 `npm test` 共 4 次（21:5x–22:3x，最後一次含 diagnostic 微調）：

| run | 模式 | 結果 |
| --- | --- | --- |
| 1 | 並行（預設） | 452 tests／441 pass／10 skipped／**1 fail** |
| 2 | 並行 | 452／440／10／**2 fail** |
| 3 | 序列 `--test-concurrency=1` | **452／442／10／0 fail**（100 s） |
| 4 | 序列（diag 微調後） | 452／441／10／1 fail |

- 5 次失敗全部是 `test/integration.test.mjs` 的真實 BaseMind index build 超時（`the BaseMind index did not finish building within 150000 ms`，:578）；其餘 441–442 個測試（含 5 個新 cold-start case）每次全綠。
- 該測試與本次 diff 無關：未 import `apply()`、不觸發 `agent/created`，以 `createStdioClient`＋`createMcpSession` 直接驅動真實 relay。
- 隔離重跑 integration：working tree **8/8 pass**（132 s）、`2a17e9b` pristine worktree **8/8 pass**（74 s）。同一 index build 實測 **62–152 s**、門檻 150 s → 既有 timing flake，不是本次 regression。

#### (6) 殘留風險／未驗證

1. 只驗 **Windows**；macOS／Linux 未實跑真實冷啟動（CI 只跑單元測試）。
2. gate 會把 relay 初始化時間加到「session 建立」延遲（實測 694 ms，上限 15 s）。
3. 只有第一次 attempt 會 gate：若第一個 session 的 root 不可用（BaseMind 拒絕非專案目錄），在 retry backoff 內建立的新 session 第一輪仍可能沒有工具（與修復前行為相同，未惡化）。→ **此限制已由 §11.17 修正**（改為「每個 root 第一次嘗試才 gate」）。
4. 真實驗證使用 working tree pack（未 commit）；Phase B 需從新 commit 重建 tarball 重驗 F1／F2／cold-start。
5. 新增 test profile `bm-bench-c`（修復驗證）與 `bm-bench-d`（失敗路徑，刻意壞設定）；Desktop profile 未動。probe／log／pack 都在 `D:/_bm_phase3/cold/`。
6. `npm test` 的 integration index build 在本機為 62–152 s、門檻 150 s，**並行與序列都可能超時**（4 次完整 run 中 3 次有 1–2 個 integration 失敗，全部同一測試）。建議另案把 `INDEX_BUILD_TIMEOUT_MS` 提高或改為 retry/skip（本次未改，避免擴大 Phase A scope）。

#### (7) 工作區狀態

- 未提交：`index.js`、`lib/config.js`、`test/index.test.mjs`、`test/config.test.mjs`、`fixtures/fake-mcp-server.mjs`、`CHANGELOG.md`、本報告。
- 無 local commit／push／merge；`main` 仍 `2a17e9b`；Desktop profile 未動；業務 repo 只讀。
- 停點：Phase A 完成，等待 review／commit 後才進 Phase B。

---

### 11.17 2026-11-24 22:41–23:05 Phase A：冷啟動 Review findings 修正

#### (1) 結論

Review 的 Important 1、2 已修並新增 deterministic 測試；Important 3 以文件化處理；Finding 4（integration index build timeout）維持另案、未改測試門檻。目標檔案無新增 runtime dependency、未改 DSH host、未改 Workspace Pool／MCP Bridge／Skills Provider、未動 Desktop profile。

#### (2) Important 1 — `agent-first` per-root gate

- `state.attempted`（單一 boolean）改為 `state.attemptedRoots`（lower-case `Set`）；每次 attempt 前以**實際要試的 root** 記錄。
- `ensurePrimary()` 的候選 root 迴圈外層改為 `for (;;)`：mid-attempt 才出現的 root 由 `state.recheck` 在**同一個 promise** 內再跑一輪，因此 `waitForPrimary()` 等的是「含 recheck 的 attempt」，不會先被舊 attempt 的失敗放行。
- `scheduleRetry()` 改走 `startPrimary()`，retry attempt 也進 `state.initPromise`，建立中的 Agent 會等它。
- `gate` 條件改為 `state.initPromise !== undefined || (本次 Agent 的 root 屬於此 mode 的候選 root 且尚未嘗試過)`。第三個條件是刻意加的：`default` mode 不採用 Agent 目錄，若只因 Agent root 未見就 gate，等於讓每個 session 都去等一個不可能產生它工具的 attempt。

#### (3) Important 2 — directory timeout 後仍背景 adoption

- `adoptAgentRoot()` 在 budget 到期、且不是 abort 時，對 `directoryPromise` 掛 non-blocking continuation；`adoptLateDirectory()` 在 `!disposed && !ready && !blocked` 時設 `preferredRoot`、`retryIndex = 0`；若 attempt 正在跑就設 `state.recheck` 併入同一個 attempt，否則 `startPrimary()`。
- 不 await、不延長第一輪；aborted creation 不追蹤（該 Agent 已不存在）。

#### (4) Important 3 — 決策：文件化，不拉高預設

- `README.md`／`README.zh.md` 新增 §5.3「新 session 的第一輪」：預算涵蓋 `workingDirectory.ensure`＋handshake＋`tools/list`；`0` 停用、上限 120000；late directory 仍會在背景被採用；**first-ever `binaryDownload` 安裝（75–102 MB、13.5–55.7 s）不在 15 s 預算內**，第一次 session 第一輪仍可能沒有工具。
- `CHANGELOG.md` Unreleased Fixed 同步寫入同一條件（含 per-root gate 與 late adoption）。
- 不拉高 `coldStartTimeoutMs`：`startupTimeoutMs` 已是 60 s，把 agent creation 擋到 55 s 不是可接受的 UX；要真的覆蓋需另案設計（例如 first-install 專用預算）。

#### (5) 測試

| case（`test/index.test.mjs`） | 斷言 |
| --- | --- |
| `agent-first still gates the first turn after the deployment default failed` | `failRoots` 讓 deployment default 失敗、500 ms handshake；`agent/created` resolve 時 tools 與 `mcp:basemind` section 已存在，creation ≥300 ms |
| `a working directory that arrives after the cold-start budget still starts the relay` | `ensureDelayMs: 600`、budget 150 ms；creation 在預算內返回且當下無 tools；晚到的目錄仍啟動 relay，`admin status` 回 `root = ROOT_A` |

- fake context 新增 `ensureDelayMs`（模擬慢／遠端 cwd）；既有 5 個 cold-start case 不變。
- 這兩個 case 對應的舊行為（舊 `gate` 在 `agent-first` 首輪為 false；舊 timeout 分支直接 return、沒有後續 adoption）是程式碼路徑推論，未在舊版程式碼上實跑重現。

#### (6) 驗證

| 命令 | 結果 |
| --- | --- |
| `node --test test/index.test.mjs test/config.test.mjs` | **53/53 pass**（9.3 s） |
| `npm run check` | syntax ok（20 files）＋bundle manifest ok |
| `node --test test/integration.test.mjs`（isolated） | **安靜重跑 8/8 pass**（48.6 s）；併行負載下的 3 次失敗見下 |
| 真實冷 process（working tree pack → `bm-bench-c`） | create1 **1,432 ms**、prompt1 33 ms、create2 65 ms；兩個 session 第 1 輪皆 **54 tools／19 `mcp__basemind__`／system 10,350 B／bootstrap／catalog 18 entries／10 basemind skills** |

- 真實冷 evidence：session `5687fce4`（第 1 個）與 `8e78f854`（同 process 第 2 個）第 1 輪指標相同；profile tarball `D:/_bm_phase3/cold/pack2/dsh-basemind-plugin-0.2.0-phaseA3.tgz`，log `D:/_bm_phase3/cold/cold-f.log`。gate 成本 1.4 s（上限 15 s）。
- isolated integration：本輪前 3 次都失敗；保留 log 的 2 次是 **8 tests／6 pass／2 fail**（313.9 s）與 **8 tests／7 pass／1 fail**（255.7 s），失敗全部是 `test/integration.test.mjs:578` 的 `the BaseMind index did not finish building within 150000 ms`（每次 151.8 s）；第一次執行未保留輸出。
- 原因確認：那 3 次是**資源競爭**。另一個併行的 Execution context 同時段跑了完整 `npm test`（§11.18(6)），兩個 suite 都在對真實 BaseMind 建索引。等其他 BaseMind 測試結束後重跑：**8/8 pass（48.6 s）**，同一個 index build 只要 **36.1 s**（`D:/_bm_phase3/cold/int4.log`，23:02:57 起跑）。integration 本身沒有 regression；`INDEX_BUILD_TIMEOUT_MS` 仍建議另案處理，因為負載下確實會超過 150 s。
- 與本 diff 無關的直接證據：`test/integration.test.mjs` 只 import `lib/config.js`、`lib/executable.js`、`lib/mcp-session.js`、`lib/result.js`、`lib/schema.js`、`lib/stdio-client.js`，不 import `index.js`；本次 `lib` 變更只有新增 `coldStartTimeoutMs`，不在 relay／index 路徑上。
- 另一個併行的 Execution context 同時段跑了完整 `npm test`：**454 tests／442 pass／2 fail／10 skipped**（316.9 s），2 個失敗同樣是這個 index build timeout（§11.18(6)）。本輪未重跑完整 `npm test`：已知失敗就是同一個 timing 問題。

#### (7) 殘留風險／未驗證

1. `agent-first` 與 late-directory 只有 deterministic 覆蓋，沒有真實 session 重現（需要 deployment default 非 project 的 profile）。
2. 真實冷驗證只跑 Windows、只跑預設 `agent` mode；macOS／Linux 未實跑。
3. isolated integration 已用安靜重跑 8/8 補上；但它在併行負載下會逾時（本輪 3 次），建議另案提高 `INDEX_BUILD_TIMEOUT_MS`／改 retry（§11.16(6)）。
4. README 的測試數列（`432 tests／422 pass`）仍是 Phase 2 快照；本輪新增 2 個 case 後全套為 454（452＋2，未重跑全套確認）。屬 3E 文件工作。
5. 真實冷驗證使用未 commit 的 working tree pack；Phase B 必須從新 commit 重建 tarball 重驗 F1／F2／cold-start。

#### (8) 工作區狀態

- 變更（皆未 commit）：`index.js`、`lib/config.js`、`test/index.test.mjs`、`test/config.test.mjs`、`fixtures/fake-mcp-server.mjs`、`CHANGELOG.md`、`README.md`、`README.zh.md`、本報告。
- 無 local commit／push／merge；`main` 仍 `2a17e9b`；Desktop profile 未動；業務 repo 只讀。
- 停點：Phase A 程式與文件完成；integration timing 決策待使用者；經使用者 Review／commit 後才進 Phase B。

### 11.18 2026-11-24 22:40–23:20 Review 後修正（cold-start Findings 1–2）＋文件

> 本節是同一輪工作的另一份紀錄（另一個併行的 Execution context 寫入），與 §11.17 記錄同一批修正；程式結論以 §11.17 為準，本節保留其紅→綠測試與完整 `npm test` 數據。§11.17(2) 之後又補上一個 gate 條件：該 root 必須是此 mode 的候選 root。

#### (1) 依據與範圍

- 依據：[`docs/2026-11-24-basemind-cold-start-fix-review.md`](./2026-11-24-basemind-cold-start-fix-review.md)（Review Agent 的 §3 Findings）。
- 角色：Execution Agent。處理 **Finding 1、Finding 2、Finding 3（僅文件化）與 Minor 5**。
- 非目標：Finding 4（`test/integration.test.mjs:578` 的 index build timeout）另案；不改 `INDEX_BUILD_TIMEOUT_MS`、不改 DSH host、**不**把 `coldStartTimeoutMs` 預設值拉高。
- 本節是 §11.16 的後續；§11.16 的實作與真實驗證仍有效，其「只 gate 第一次 attempt」的描述已被本節取代。

#### (2) Finding 1 — `agent-first` 在 deployment default 失敗後跳過 gate（已修）

- **根因**：gate 只判斷「是否曾有 attempt」（`state.attempted`）。`agent-first` 在 apply 時先嘗試 deployment default，失敗後 `attempted = true`；第一個真實 Agent 的 root 從未被嘗試，卻不再 gate，第一輪照舊在 tools 註冊前釋放。另外，`recheck` 觸發的第二個 attempt 不在 `state.initPromise` 內，`waitForPrimary()` 只等得到失敗的那個 attempt。
- **修正**（[`index.js`](../index.js)）：
  - `state.attempted` → `state.attemptedRoots`（lower-case 集合）；gate 改為「`state.initPromise` 存在」或「目前 Agent 的 `preferredRoot` 還沒被嘗試過」。同一 root 重複失敗仍不 gate，不會拖慢每個新 session。
  - `ensurePrimary()` 的 `recheck` 改為**同一個 `initPromise` 內**的候選 root 迴圈：新的 root 抵達後的重試仍屬於 host 正在 await 的那個 promise，`waitForPrimary()` 觀察得到。
  - `scheduleRetry()` 的 timer 改走 `startPrimary()`，retry attempt 也有 `initPromise`，可被等待。
- **回歸測試**：`test/index.test.mjs` 新增「agent-first still gates the first turn after the deployment default failed」：deployment default 先失敗、relay 慢 500 ms，`await ctx.emit('agent/created')` resolve 後**立即**斷言 tools 與 `mcp:basemind` section 存在。修正前紅（2 ms 就 resolve，無 tools）、修正後綠（633 ms）。

#### (3) Finding 2 — directory timeout 永久放棄 adoption（已修）

- **根因**：`settleWithin()` 逾時後只 `scheduleRetry()`；`discoveryRoot: 'agent'` 下沒有 root，retry 的 `ensurePrimary()` 直接 return，晚到的 directory promise 無人觀察，該 session 到下次 Agent 建立前都沒有工具。
- **修正**（`index.js`）：新增 `adoptLateDirectory()`；逾時分支對 `directoryPromise` 掛一個 non-blocking continuation，settle 後在 `!disposed && !ready && !blocked` 時設 `preferredRoot`、`retryIndex = 0`，若 `initializing` 則設 `recheck`，否則 `startPrimary()`。第一輪仍在上限內放行。
- **回歸測試**：新增「a working directory that arrives after the cold-start budget still starts the relay」：`workingDirectory.ensure` 延遲 600 ms、`coldStartTimeoutMs: 150`；creation 在 2 s 內返回且當下無工具，之後背景補上工具，`admin status` 的 `root` 為該 Agent 目錄。修正前紅（5 s 等待逾時、無工具）、修正後綠（1.36 s）。

#### (4) Finding 3 — cold managed install 大於預設預算（文件化，未改預設）

- **決策**：**不**把 `coldStartTimeoutMs` 由 15 s 拉高（Review 已指出把 agent creation 擋到 55 s 不是好方案，也會拖慢每個新 session）。把限制寫進 README（en／zh）與 CHANGELOG。
- **使用者可見行為**：全新 `binaryDownload` 安裝（下載 75–102 MB，實測 13.5–55.7 s）若超過預算，第一次 session 的第一輪仍在沒有 BaseMind 工具下執行；工具在背景安裝／handshake 完成後可用。後續 session 使用暖快取，只等 handshake（實測 creation 51–694 ms）。
- **未驗證**：本次**沒有**在全新 cache 冷安裝下重跑真實 session 驗證上述文字；它取自既有的 managed 冷安裝實測（13.5–55.7 s）與 15 s 預算的算術關係。

#### (5) Minor 5 — 文件

- [`README.md`](../README.md)／[`README.zh.md`](../README.zh.md) 新增 §5.3「新 session 的第一輪」：`coldStartTimeoutMs` 預設／停用方式／上限 120000、預算涵蓋範圍（`workingDirectory.ensure`、handshake、`tools/list`）、late directory adoption、first-ever managed install 限制。
- [`CHANGELOG.md`](../CHANGELOG.md)：`Fixed` 的冷啟動條目補充「每個 discovery root 第一次嘗試才 gate」、late adoption，以及 first-ever install 的限制。
- 本報告頂部 §0.1 指標與 §10 指標都加上 §11.16／§11.17；§11.16 (6) 的殘留風險 3 標註已由本節修正。

#### (6) 驗證（本次實跑；Windows x64、Node 24.20.0）

| 命令 | 結果 |
| --- | --- |
| `node --test test/index.test.mjs test/config.test.mjs` | **53/53 pass**（9.2 s；含 2 個新 case） |
| `npm run check` | syntax ok（20 files）＋bundle manifest ok |
| `npm test`（完整、並行） | **454 tests／442 pass／2 fail／10 skipped**（316.9 s）；2 個失敗都是 `test/integration.test.mjs:578` 的 `the BaseMind index did not finish building within 150000 ms`（既有 flake，Finding 4，與本次 diff 無關） |

- 新 case 的紅→綠順序已實跑：修正前 2 個新 case 皆 fail（2 ms 就 resolve／5 s 等待逾時），修正後皆 pass。
- **未重跑** isolated integration（`test/integration.test.mjs` 不 import `apply()`、不觸發 `agent/created`，本次未觸及）；報告沿用 §11.16 的 isolated 8/8 與 Review 的獨立重跑。

#### (7) 殘留風險／未驗證

1. Finding 4 未處理：`npm test` 仍可能因真實 BaseMind index build 超時而 flake。
2. 只驗 **Windows**；macOS／Linux 的 cold start 與 late directory 行為未實跑。
3. Finding 1／2 的證據是單元層 fake context（含 slow relay、slow cwd），**未**在真實 `agent-first` profile 或真實遠端 cwd 重現。
4. Finding 3 的文件敘述未以全新 cache 冷安裝實測。
5. 未 commit、未 push；`main` 仍 `2a17e9b`；工作區修改範圍見 §11.16 (7) 加上本節的 README／CHANGELOG／報告。

---
### 11.19 2026-11-24 23:16–23:35 Phase B：重建＋3A 剩餘取證（P3-06／12／13／15／17／18）

#### (1) 環境

- `bm-bench-e`（新）：從 commit `5bec005` 的 tarball 安裝；`BASEMIND_DATA_HOME`／`BASEMIND_COMMS_DIR` 指到 `C:/Users/sanny/AppData/Local/Temp/bm-phase3e/`，與使用者預設 BaseMind 狀態完全隔離；web 實例 `127.0.0.1:52474`（測試後關閉）。
- 三個 workspace：本 repo（128 files）、Vue `C:/01_aw_github/transmac-oms-fe`（2,101 files）、Java `D:/02_zengjunlin/github/transmac-oms`（7,692 files）。全部唯讀。
- session：`5bc5c294`（repo）、`3d8ac6c0`（Vue）、`18597c46`（Java）。

#### (2) P3-15 多 session 隔離 — PASS（Vue 部分）

- 三個 session 的 `index_status` 分別回自己的 root：`\\?\D:\02_zengjunlin\github\dsh-basemind-plugin`、`\\?\C:\01_aw_github\transmac-oms-fe`、`\\?\D:\02_zengjunlin\github\transmac-oms`。
- 交叉讀取（`code_grep` 同一 pattern）：repo session 搜 `preview-diff-core` → `{"hits":{}}`（0）；Vue session → **7 處匹配／6 個檔**（`passenger_notice_template/*`）。repo session 搜 `DiagnosisController` → 0。
- 路由與隔離成立；三個 workspace 共用同一個 0.34.0 binary。

#### (3) P3-12 R2 secondary relay — PASS

- relay 建立時間：repo 7564（23:18:47）、另外兩個 23:18:53（Vue／Java）。
- 殺掉 10216 後：repo 與 Vue 的 `index_status` 都成功且**沒有**新 relay；Java session 下一次呼叫觸發新 relay **58944**（23:21:09）並回成功結果。
- 結論：終止 secondary relay 只影響該 workspace，下一次呼叫會重建。

#### (4) P3-17 停用／重載 — PASS

- `bm-bench-c` patch 加 `- id: dsh-basemind / disabled: true`：session 32 tools／**0** `mcp__basemind__`／system 6,334 B／無 bootstrap；測試前後 `basemind.exe` 數皆 4（**沒有** spawn relay）。
- 移除 disable 後：54 tools／19 `mcp__basemind__`／system 10,350 B／bootstrap／cli；create1 1,389 ms（gate 生效）。

#### (5) P3-13 R3 daemon unavailable — PASS

- `basemind comms stop`（只針對隔離 namespace）被拒：`daemon_busy: refusing to stop while persistent clients or work are active (relays=1, http=0, work=0)`。
- 直接結束隔離 daemon（PID 52128）後，下一次 `index_status` **1,567 ms** 內回完整 index（`file_count 64`）；relay 5320 自行重啟 daemon（新 PID 60080，23:30:16）。無 hang、沒有 120 s timeout；使用者的預設 daemon 不受影響。

#### (6) P3-18 Vue／Java 邊界 — PARTIAL

- Vue SFC：`code_outline src/components/Breadcrumb/index.vue` → `language: vue, total: 0, symbols: []`（0.34.0 不對 SFC 產出符號）。
- `code_search {"query":"breadcrumb navigation","lane":"keyword"}` → top hit `src/views/login/DingTalkLoginCallback.vue`（相關性低）；`code_grep "<template>"` → 29 處（`total_is_partial: true`）。
- Java：`bi-diagnosis` 多模組 repo（7,692 files）的首次 index build 在隔離 data home **超過 15 分鐘仍未完成**（23:18 起、23:33 停在 extract 5120/7692，daemon CPU 持續上升、WorkingSet 1.37 GB）；因此 Java 的 `code_*` 查詢無有效結果（`code_grep DiagnosisController` 回 0 並附 `building_index` notice）。**Java 邊界未取得可用證據**。

#### (7) P3-06 prompt／usage 量測 — PASS

- 同一 session：system **10,350 B**、skills catalog **6,076 B／18 entries（10 basemind）**、54 tools。
- tool schema JSON：全部 54 個 **54,869 B**，其中 19 個 basemind **21,652 B**。
- 4 個 model step 合計：input 13,856、output 204、cacheRead 105,856、total **119,916**。

#### (8) Phase B-1 重建（commit `5bec005`）

- tarball：`D:/_bm_phase3/commit5bec005/dsh-basemind-plugin-0.2.0-5bec005.tgz`（150,843 B）；`bm-bench-a`／`bm-bench-b` 已重裝。
- `bm-bench-b` 冷啟（真實 web 實例）：create1 **1,514 ms**；兩個 session 第 1 輪都是 19 `mcp__basemind__`／system 10,350 B／bootstrap／catalog 18 entries／10 basemind skills（56 tools，含 codex 插件的 2 個）。
- F1：手動殺掉 relay（PID 12432）後，下一次 `index_status` 成功，插件長出新 relay（PID 59604）。F2：bootstrap 句 `read/grep/glob and shell tools` 在。
- 回歸：`npm test` **454 tests／444 pass／0 fail／10 skipped**（37.7 s），integration 已包含在內。

#### (9) compat.yml 遠端 dispatch — BLOCKED

- `POST /repos/zengjunlin2022/dsh-basemind-plugin/actions/workflows/compat.yml/dispatches` 回 **204**，但 `GET /actions/workflows` 與 `/actions/runs` 都是 **404**（`Not Found`）→ 目前的 `GH_TOKEN`（user-env）沒有 Actions 權限，無法查詢或觸發 workflow。
- 需要具 `Actions: read/write` 的 token，或由使用者在 GitHub UI 手動 dispatch；在那之前 compat.yml 維持 **NOT RUN**。

#### (10) 殘留

- 新測試 profile：`bm-bench-e`（隔離 3A）、`bm-bench-f`（R3）；`bm-bench-c` 的 patch 留有 P3-17 的註解紀錄。
- Java 索引在建置超過 15 分鐘後連同 bench-e 實例一起停止（`basemind.exe` 歸零），該項維持 PARTIAL，未取得 Java 查詢證據。
- 本輪未 commit、未 push；working tree 有 `README.md`、`README.zh.md`、`test/integration.test.mjs` 與本報告的未提交修改。

---

### 11.20 2026-11-25 3C Pilot／3D 完整 Benchmark（34 輪）

- 12 輪 Pilot ＋ 22 輪完整（B2 的 GPT 組未跑），A/B × DeepSeek/GPT × 6 任務；**34 輪全部 PASS**，B 組沒有任何任務由 PASS 退為 FAIL。
- Token：Pilot 3,161,720（超 3M 上限）、完整 8,581,507（8.7M 內）、合計 11,743,227（12M 內）；多輪超過單輪 400k（最高 B2 B-deepseek 1,459,487）。
- DeepSeek 上 B 組 tokens 多 11.3%（3.46M vs 3.10M）；GPT 上多 70%（1.27M vs 0.75M）；工具呼叫數相近（129 vs 129／45 vs 54），B 組的 skill 載入只出現在 GPT（5 次）。
- 評分器與 Ground Truth 修正：B5 行號（4／11／15）、B2 改為 whitelist 任選 3 symbols＋2 deps、defect 以 file＋line 判定；全部在 3D 評分前完成並重評。
- 完整數據、偏差與限制：`docs/2026-11-25-basemind-benchmark-report.md`；harness 在 `benchmark/`。
- 3E 回歸：`npm test` 454/444/0/10（29.2 s）、`npm run check`、`check:skills`、`check:pack`（52 files）全部通過。
- 尚未完成：實機 Desktop 驗收（D3–D15，需使用者操作）；compat.yml 遠端仍因 token 無 Actions 權限而 NOT RUN。