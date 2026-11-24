# dsh-basemind-plugin 0.3.0：穩定性完善與官方插件能力對齊（調查 + 實作計畫）

- 日期：2026-11-24
- 角色：Investigation + Planning（依本倉庫 [AGENTS.md](../AGENTS.md) §3.2／§3.3 與全域 Agent 工作規則）
- 基線：`main` @ `f87b58309d06a6cf0d2aa14ea04abd3ceb6ffeca`（與 `origin/main` 同步，工作區乾淨）
- 插件版本：`package.json` 0.2.0（開發基線，本次不改版本）
- 目標上游：BaseMind **0.34.0**（取自 [lib/upstream.js](../lib/upstream.js)，非硬編）
- 目前實際 runtime：DSH `0.2.2-rc.5`（見 §18.1）
- 狀態：**Plan 完成，等待人工確認後才進入 Execution**
- 本次未修改任何產品程式碼、未 stage／commit／push／tag／publish；`_scratch/` 為調查暫存（交付前清除，見 §25.4）

---

## 0. 閱讀指引

本文件依需求 §23 的 26 項交付要求組織，但**先講三個必須先知道的事實**，其餘細節再展開：

1. **CI 的 Ubuntu 失敗是測試夾具缺陷，不是產品缺陷**，而且根因可以定位到三行測試程式碼，並且已在本機以 POSIX 方式重現（§3）。修復是 1 個檔案模式 + 少量測試程式碼。
2. **Managed Binary 的「只解壓主 binary」不只是遺漏 DLL，而是四個平台都裝出一個無法啟動的 binary**。Windows 已用實測證明（`0xC0000135`），Linux／macOS 由 ELF／Mach-O 依賴分析支持。這代表**預設開啟的 `binaryDownload` 目前在乾淨環境從未真正可用**，只是在本機被 PATH 上的 DLL 意外救活（§6、§7）。這是本次唯一的 Critical 產品缺陷。
3. **上一輪 Review 的 C1／C2／I1–I6 已在現行程式碼修好**（§5.3 逐項抽查），本次不重複開發；Pi／OpenCode 的其餘能力差異中，真正有價值且 DSH 有原生接口的是 **Commands**（§15），**通知／Toast 與 Agent Inbox 在 DSH Host 側沒有受支援接口**（§16、§17、§18.3），只能降級或延後。

建議交付節奏：**先修 P0（§3、§7）→ 補真實 Managed Binary 測試與 CI 分層（§10、§11）→ 再做 Desktop 驗收與 A/B（§12–§14）→ 最後 Commands（§15）**；P3 Inbox 建議本輪不實作（§17）。

---

## 1. Executive Summary

### 1.1 三個確定的 P0 結論

| # | 結論 | 性質 | 證據 |
| --- | --- | --- | --- |
| P0-A | Ubuntu CI 在 `npm test` 失敗，根因是 [test/index.test.mjs:30-40](../test/index.test.mjs#L30-L40) 把 [fixtures/fake-basemind.sh](../fixtures/fake-basemind.sh) 複製到暫存目錄後執行，而該腳本用 `$BASH_SOURCE` 找同目錄的 `fake-mcp-server.mjs`，複製後找不到 → relay 起不來 → 3 個測試各等 15 s timeout | **測試缺陷**（非產品、非 flake） | CI run #14 jobs API（Ubuntu test step 48 s／Windows 8 s）；本機以 POSIX 方式重現 `MODULE_NOT_FOUND`（§3.4） |
| P0-B | Managed Binary 只抽 `basemind(.exe)` 一個檔案，丟掉 `heif.dll`＋`libde265.dll`（Windows）、`lib/*.so`（Linux）、`lib/*.dylib`（macOS）與 9 個授權檔；四平台產出的 binary **都無法啟動** | **產品缺陷（Critical）** | 四平台 archive 完整 entry 清單＋SHA256 校驗（§6）；Windows 實測只有 exe → `0xC0000135`，補齊 2 個 DLL → 正常（§7.2）；ELF `RUNPATH=$ORIGIN/lib`／Mach-O `@loader_path/lib/libheif.1.dylib`（§7.3） |
| P0-C | 目前沒有任何「插件自己下載安裝」的真實測試；現有 integration 只用外部已安裝 binary，且 compat workflow **從未執行過**（GitHub Actions 最近 20 次 run 只有 CI 與 Release） | **驗證缺口（P0 阻擋發布）** | [.github/workflows/compat.yml:16-22](../.github/workflows/compat.yml#L16-L22) 僅 `workflow_dispatch`；runs API 無該 workflow 紀錄 |

### 1.2 已確認「不需要重做」的項目

- 官方 10 個 Skills 同步、vendoring、provenance、`check:skills` gate：完成且有守門測試（[skills/UPSTREAM.json](../skills/UPSTREAM.json)、[scripts/sync-basemind-skills.mjs](../scripts/sync-basemind-skills.mjs)）。
- 動態工具註冊、StructuredContent、MCP Resources、Workspace Pool、CLI Adapter、Bootstrap section、`/basemind-status`、版本策略（exact／minor／any）、single-flight、跨進程鎖、SHA256 校驗、下載 host allowlist：完成（§5）。
- 上一輪 2 個 Critical（skills definition 缺 `source`/`provider`/`invocation`、tar `./` 前綴＋`writing` 未收尾）與 6 個 Important：**已修**，本次只做回歸確認（§5.3）。

### 1.3 建議版本

本次完成後建議發布 **0.3.0**（有行為變更：managed binary 安裝布局、CI／測試契約、新增命令）；不自動改版、不建 tag、不發布（§26）。

---

## 2. 最新 HEAD 與工作區狀態

| 項目 | 值 |
| --- | --- |
| HEAD | `f87b58309d06a6cf0d2aa14ea04abd3ceb6ffeca` |
| HEAD 提交時間 | 2026-11-24 15:51:27 +0800 |
| `origin/main` | 同 SHA（`git ls-remote` 確認） |
| 落後／領先 | 0 / 0 |
| 工作區 | 乾淨（無 staged／unstaged／untracked，除本次調查新增的 `_scratch/`） |
| 最近提交 | `f87b583 feat(binary): 新增 managed binary 下载与功能门控`、`f278d6c feat(basemind): 适配 BaseMind 0.34.0 verb tools 契约`、`1cf61a8 chore(release): v0.1.6` |
| 本機測試基線 | `npm test` → **393 pass / 0 fail / 0 skip，62.1 s**（2026-11-24 本機實跑） |

> 注意：本機 `npm test` 全綠，**不代表** CI 會綠（§3）也**不代表** managed 下載可用（§7）。這正是本輪要補的兩個盲區。

---

## 3. 最新 CI 實際狀態與失敗證據

### 3.1 最新 Run 與對照組

| Run | Commit | 結論 | Ubuntu `Run tests` | Windows `Run tests` |
| --- | --- | --- | --- | --- |
| **#14** `45351249215` | `f87b583`（HEAD） | **failure** | **48 s → failure** | 8 s → success |
| #13 `45336679024` | `f278d6c`（前一 commit） | success | 1 s → success | 3 s → success |

- 失敗 job：`test (ubuntu-latest, node 24.20.0)`，id `138297953728`，失敗步驟 **僅** `Run tests`（後續 `check`／`check:skills`／`check:pack` 全部 `skipped`）。
- Windows job id `138297953904` 全部步驟 success。
- 也就是：**失敗只發生在新 commit 新增的測試上，且只發生在 Linux**。

### 3.2 取得日誌的限制（必須誠實記錄）

- GitHub Actions **job log 端點需要授權**：`GET /repos/.../actions/jobs/138297953728/logs` → **HTTP 403 `Must have admin rights to Repository.`**
- 本機無 `gh` CLI、無 `GITHUB_TOKEN`／`GH_TOKEN`、git 未設 credential helper（`git config --get credential.helper` 空），因此**無法取得原始日誌文字**。
- 替代證據：`/commits/{sha}/check-runs` 與 `/check-runs/{id}/annotations` 可匿名讀取，但註解只有一句 `Process completed with exit code 1.`（無測試名）。
- 因此本節的根因判定建立在**三重證據**上：步驟耗時（可匿名取得）、程式碼閱讀、**本機重現同一失敗機制**。§3.6 說明如何用下一次 CI run 確認。

### 3.3 耗時證據（匿名可取得的硬數據）

| Job | `Run tests` 耗時 | 全部測試數 | 推論 |
| --- | --- | --- | --- |
| Ubuntu #14 | **48 s** | 393 | 3 個測試各卡 `waitFor` 15 s ≈ 45 s，其餘測試約 3 s |
| Windows #14 | **8 s** | 393 | 無 timeout，正常跑完 |

`test/index.test.mjs` 的 `waitFor` 預設 `timeoutMs = 15_000`（[:45-53](../test/index.test.mjs#L45-L53)）。**45 s 的時間簽名與 3 個失敗測試完全吻合**，而這 3 個測試正是唯一需要 relay 真的啟動的測試（§3.4）。

### 3.4 根因（可定位到行，且已重現）

**程式碼事實：**

1. [test/index.test.mjs:22](../test/index.test.mjs#L22) POSIX 用 `fixtures/fake-basemind.sh`。
2. [:30-40](../test/index.test.mjs#L30-L40) 在非 Windows 上把它**複製到 `os.tmpdir()`** 再 `chmod 0o755`，註解寫明理由是「the repository does not carry an exec bit」。
3. [fixtures/fake-basemind.sh:4-8](../fixtures/fake-basemind.sh#L4-L8) 用腳本自身目錄解析同目錄模組：
   ```sh
   here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
   if [ "${1:-}" = "--version" ]; then echo "basemind 0.34.0"; exit 0; fi
   if [ "${1:-}" = "serve" ]; then exec node "$here/fake-mcp-server.mjs" "$@"; fi
   exec node "$here/fake-basemind-cli.mjs" "$@"
   ```
   複製到暫存目錄後，`$here` 指向暫存目錄，`fake-mcp-server.mjs` **不在那裡**。
4. 3 個受影響測試都需要 relay 真的啟動：[test/index.test.mjs:518](../test/index.test.mjs#L518)（CLI＋bootstrap＋skills）、[:564](../test/index.test.mjs#L564)、[:578](../test/index.test.mjs#L578)，全部用 `command: fakeBasemind(), args: ['serve']`。
5. Windows 走 `fixtures/fake-basemind.cmd`（不複製、用 `%~dp0` 找同目錄），所以 Windows 綠。

**本機重現（POSIX 機制等價）：**

```
$ cp fixtures/fake-basemind.sh /tmp/xxx/ && chmod 755 /tmp/xxx/fake-basemind.sh
$ /tmp/xxx/fake-basemind.sh --version   →  basemind 0.34.0        (EXIT 0)
$ /tmp/xxx/fake-basemind.sh serve       →  Cannot find module '.../fake-mcp-server.mjs'   (EXIT 1)
```

`--version` 成功、`serve` 失敗 —— 與「探測通過、relay 起不來、測試 15 s timeout」的預期失敗模式完全一致。

**輔助證據：** `git ls-files -s fixtures/` 顯示 `fixtures/fake-basemind.sh` 是 **100644**（沒有執行位），這也是測試作者當初改成「複製＋chmod」的原因。

### 3.5 最小修復方案（測試專用，不動產品碼）

**採用方案 A（推薦）：讓 fixture 以正確權限存在，並就地執行。**

| 步驟 | 動作 |
| --- | --- |
| A1 | 將 [fixtures/fake-basemind.sh](../fixtures/fake-basemind.sh) 在 git index 設為 **100755**（`git update-index --chmod=+x`，由使用者 commit）。Linux／macOS checkout 會自帶執行位；Windows 本來就用 `.cmd`。 |
| A2 | 刪除 [test/index.test.mjs:30-40](../test/index.test.mjs#L30-L40) 的「複製到 tmpdir」分支，POSIX 直接回傳 `FAKE_BASEMIND`。 |
| A3 | 新增一條 **preflight 斷言**（POSIX 才跑）：fixture 必須可執行，否則立刻以清楚訊息失敗（避免再次退化為 45 s timeout）：`assert.ok((statSync(FAKE_BASEMIND).mode & 0o111) !== 0, 'fixtures/fake-basemind.sh must be executable in git (mode 100755)')`。 |

**備選方案 B**（若維護者堅持檔案保持 100644）：複製時連同 `fake-mcp-server.mjs` 與 `fake-basemind-cli.mjs` 一起複製（3 個檔案），成本是每次測試多 2 次檔案複製與「同目錄模組」隱含契約。**不推薦**：它把「腳本與其依賴同目錄」變成測試端手工維護的知識。

**為什麼不是別的原因（排除法）：**

| 假設 | 排除理由 |
| --- | --- |
| 產品碼在 Linux 有 bug | 失敗步驟只涵蓋 `npm test`；`npm run check` 等後續步驟被 skip，沒有其他平台證據；且同一個 commit 的 Windows leg 全綠，差異只在測試夾具的 `.sh` vs `.cmd` 路徑。 |
| Runner 資源／flaky timeout | 若是資源問題，Windows（較慢的 checkout／setup）也應受影響；且 3 個測試同步失敗、總時長精確吻合 3×15 s。且 run #13 的 Ubuntu 是綠的。 |
| 測試「刪掉或放寬」也算修好 | 明確不做：§22 要求保留斷言強度，本方案反而**新增**一條更嚴格的 preflight 斷言。 |

### 3.6 驗收與確認方式

1. 下一次 push 後，Ubuntu `Run tests` 應由 **48 s → 約 8–12 s** 且 success；Windows 不變。這是最直接的確認。
2. 若仍有失敗（表示還有第二個 Linux-only 缺陷），§22 的 CI 契約要求提供**認證日誌**：請維護者以 `gh run view --log` 或帶 token 的 API 抓取；計畫已預留「CI 失敗時把 `node --test` 的失敗摘要寫成 artifact」的選項（§11.4），可在無法提供 token 時自助。
3. 本地無法完全替代：Windows 上不能重現 Linux 的行為，本節只能證明「機制」；**最終證據仍是下一次 CI run 的 URL + SHA**。

> 交付要求：Execution 必須在 Execution Report 貼上「修復後 Ubuntu job 的 run URL、SHA、`Run tests` 耗時」；若仍紅，貼上受限說明與 artifact 連結。

---

## 4. 與 Pi／OpenCode 的最新功能差異矩陣

### 4.1 Pi extension（`v0.34.0` `.pi/extensions/basemind.ts`，127 行；與 `opencode-plugin/.pi/extensions/basemind.ts` byte-identical）

| 事實 | 內容 |
| --- | --- |
| 註冊事件 | 只有 5 個：`resources_discover`、`session_start`、`session_compact`、`agent_end`、`context`。**沒有** tool 事件。 |
| Skills discovery | `resources_discover` 回 `{ skillPaths: [<packageRoot>/skills] }`；由宿主載入 `skills/<id>/SKILL.md`。 |
| Bootstrap 形態 | **不是 system prompt**，是插入一則 **user 訊息**；內容 = 固定包裝（272 字）＋`skills/basemind/SKILL.md` body（13,409 字）＋`pi tool mapping`（1,103 字）＝ **14,809 字元**。 |
| 去重 | ① 每次 `context` 掃描全部訊息找 marker `basemind:using-basemind bootstrap for pi`；② `injectBootstrap` 旗標：`session_start`／`session_compact` 設 true，`agent_end` 設 false。 |
| 插入位置 | 跳過開頭所有 `role === "compactionSummary"` 後的第一個位置（即壓縮摘要之後）。 |
| 快取 | `cachedBootstrap` 進程內快取，讀檔失敗則永久不注入（`null`）。 |
| 官方 prompts | `plugin/.pi/prompts/*.md` 6 個，全部是**模型提示詞**，用 `$ARGUMENTS` 佔位。 |

### 4.2 OpenCode plugin（`v0.34.0`）

| 事實 | 內容 |
| --- | --- |
| MCP 註冊 | `ctx.mcp.transform()`：`basemind` 已在則略過；binary `missing` → **不註冊**；`mismatch` → **仍註冊**（只警告）。指令是 PATH 上的 `basemind serve`。 |
| binary 檢查 | `basemind --version`（Windows 經 shell），5 s timeout，只看是否 `major.minor` 等於套件版本；**沒有最低版本常數**。 |
| Skills | `ctx.skill.transform()` 加入 `Skill.Info`（`id`／`name`／`description`／`autoinvoke`／`content`／`path`），已存在則略過。 |
| 通知 | `context.ui.toast.show({ title: 'basemind', message, variant })`；setup 時一則（`missing`→error、`mismatch`→warning）。 |
| Inbox | 監聽 `session.created` 與 `session.tool.success`，執行 `agent inbox --announce --root <dir> --json --limit 10`（timeout 6 s），把摘要以 `info` toast 顯示；**去重靠上游 daemon 記錄已 announce**。 |
| 清理 | `tui.js` 的 `setup` 回傳取消訂閱函式。 |

### 4.3 差異矩陣（能力 × 上游 → 本插件 → 判定）

| 能力 | Pi | OpenCode | 本插件現況 | 判定 |
| --- | --- | --- | --- | --- |
| Skills 目錄暴露 | `resources_discover` | `skill.transform` | `ctx.skills.registerProvider()`，10 個，rank 1000（使用者/專案優先） | **已完成**（§9.3 需實機驗證正文可載入） |
| Bootstrap 注入 | user 訊息（14,809 字元） | 無 | `systemPrompt.section()`，~1.2 KB，只在 verified 時非空 | **等價且更省**；DSH 每 step 重新組裝 → 不需要 Pi 的「壓縮後重注入」（§13） |
| 壓縮後恢復 | `session_compact` 重設旗標 | 無 | DSH 無 `session_compact` 事件；system prompt 每 step 重組，skills 目錄由 DSH 自行恢復 | **不需實作**；改以 §13 的驗證確認 |
| Session 起始 | `session_start` | `session.created` | `agent/created` 監聽 → `adoptAgentRoot` | **已等價** |
| MCP 工具 | 無原生 MCP（走 CLI） | `mcp.transform` | 動態 `tools/list` 註冊（15 verb + 3 agent） | **已完成** |
| Binary 可用性檢查 | 無 | `--version` + `major.minor` 閘門 + 3 則訊息 | Local first + exact/minor/any + SHA256 + 狀態命令 | **已超越上游**（但安裝布局壞，§7） |
| Binary 完整安裝 | 官方 launcher 解整包 | 依賴用戶自行安裝 | **只解壓單檔 → 四平台都裝不起來** | **P0 必修**（§7、§8） |
| 異常通知 | 無 | Toast（3 種狀態） | 只有 logger + `/basemind-status` | DSH Host 側無 toast 接口（§16）→ **降級實作** |
| 快捷命令 | 6 個 model prompt（`$ARGUMENTS`） | 同 6 個 | 只有 `/basemind-status`（確定性） | **P2 補 3 個確定性命令**（§15） |
| Agent Inbox 通知 | 無 | `session.tool.success` 每成功一次 spawn CLI | 無 | DSH 無 toast；每次 tool success spawn 違反效能約束 → **P3 評估、預設不做**（§17） |
| Statusline | 無 | 無 | 無 | CLI 有 `basemind statusline`，但 DSH 無 statusline 擴充面 → **暫緩**（§15.5） |

### 4.4 一個關鍵結論：官方 6 個命令全部是「模型提示詞」

`plugin/commands/*.md`、`plugin/.pi/prompts/*.md`、`opencode-plugin/commands/*.md` 各 6 個檔案，內容只有 frontmatter + Markdown 指示；`.toml` 版本也只有 `description` + `prompt`（grep `^(command|type|shell)\s*=` → 0 命中）。**沒有任何一個是確定性 shell 執行。**

因此本插件不應照搬「命令＝提示詞」，而應依 DSH 能力分流（需求 §12 的要求）：

- **可以用 CLI 確定性完成、不消耗 token 的**：`/bm-doctor`、`/bm-stats`、`/bm-scan` → **DSH Human Command**（`ctx.commands`）。
- **需要模型推理的**：`/bm`（問答路由）→ DSH 的 user-invocable skill 已經提供（§15.3）。
- **會修改檔案的**：`/bm-init` → **不自動實作**，只在命令輸出中給出「先看清楚再做」的指引（§15.4）。
- **需要 UI 的**：`/bm-statusline` → DSH 沒有 statusline 擴充面 → 暫緩。

---

## 5. 現有功能與可復用模塊

### 5.1 模組責任（現況實測）

| 模組 | 行數 | 現況 |
| --- | --- | --- |
| [index.js](../index.js) | 748 | 入口；`inject = ['tools','subprocess','workingDirectory','systemPrompt']`；`agent/created` → `adoptAgentRoot` → `ensurePrimary`；readiness 全域旗標；`ctx.effect` 內統一清理 |
| [lib/binary/archive.js](../lib/binary/archive.js) | 632 | 純 Node tar.gz／zip 解析；**只能取單一 root-level 檔案**（`entryPath` 含 `/` 直接拒，[:618-624](../lib/binary/archive.js#L618-L624)）；traversal／link／device／加密／zip64／重複／大小上限全部拒絕 |
| [lib/binary/download.js](../lib/binary/download.js) | 419 | https＋host allowlist（含逐跳 redirect）、串流 hash、Content-Length 上限、429/5xx/network 重試 |
| [lib/binary/manager.js](../lib/binary/manager.js) | 786 | 候選順序、single-flight、`mkdir` 原子鎖、冷卻、原子 rename 安裝、`readManagedCache` 校驗 |
| [lib/binary/probe.js](../lib/binary/probe.js) | 421 | `--version` 探測＋快取＋timeout／abort |
| [lib/cli-tool.js](../lib/cli-tool.js) | 548 | argv-only 只讀 CLI 工具；denylist 優先；`--root` 拒絕；stdout 64 KB／stderr 8 KB 預算 |
| [lib/skills/provider.js](../lib/skills/provider.js) | 265 | 10 個 vendored skills；`invocation: { modelInvocable: true, userInvocable: true }`（[:168-180](../lib/skills/provider.js#L168-L180)） |
| [lib/prompt/bootstrap.js](../lib/prompt/bootstrap.js) | 165 | 1,218 bytes 預算內、無時間戳／路徑、`interpolate:false` |
| [lib/status.js](../lib/status.js) | 552 | `/basemind-status` 診斷文字（無秘密、無 ANSI） |
| [lib/workspace-pool.js](../lib/workspace-pool.js) | — | 每 workspace 一個 relay、容量、disposal |
| 測試 | 23 檔 | `npm test` 393 pass |

### 5.2 可直接複用的能力（本次不重寫）

- 安全解壓：**保留全部既有檢查**，只把「取單一檔案」擴充為「安全地取出整棵樹」，見 §8.2。
- 原子安裝／跨進程鎖／冷卻／single-flight：沿用，只調整「安裝什麼」與「如何驗證完整性」。
- CLI 執行器：`/bm-doctor`、`/bm-stats` 直接複用現有 argv 驗證與輸出預算（`doctor`、`status`、`cache stats`、`admin telemetry` 都已在 allowlist，[lib/cli-tool.js:131-138](../lib/cli-tool.js#L131-L138)）。
- `resolveLaunch`／`scrubEnv`／`buildLaunchArgv`：命令走同一條啟動路徑，確保「同一個已驗證 binary」。

### 5.3 上一輪 findings 的現況抽查（不沿用結論，逐項確認）

| 上輪 | 現況 | 證據位置 |
| --- | --- | --- |
| C1 skills definition 缺 `source`/`provider`/`invocation` | **已修** | [lib/skills/provider.js:168-180](../lib/skills/provider.js#L168-L180) `definitionEntry()`；`get()` 以 `{...candidateEntry, ...definitionEntry(entry), content}` 回傳 |
| C2 tar `./` 前綴＋`writing` 未收尾 | **已修** | `normalizeTarEntryName` 比對；`remaining === 0 → writing = false`（[:337](../lib/binary/archive.js#L337)） |
| I1 npx 被當 verified／CLI 漏 `-y` | **已修** | selection 帶 `verified`（`policy !== 'any'`、managed `true`、npx `false`）；`cliDefinition` 讀 `verified` |
| I2 單元測試寫使用者 `$DSH_HOME` | **已緩解** | [test/index.test.mjs:11-17](../test/index.test.mjs#L11-L17) 自建 `DSH_HOME` 並清理；`apply()` 仍無 `cacheRoot` seam（殘留風險，本次不擴大處理） |
| I3 CRLF 導致 skills hash 誤報 | **已修** | [.gitattributes](../.gitattributes) `skills/** -text` |
| I4 compat gate 硬編版本 | **已修** | [compat.yml:67](../.github/workflows/compat.yml#L67) 匯出 `BM_PIN`、[:111](../.github/workflows/compat.yml#L111) `if: env.BM_VERSION == env.BM_PIN` |
| I5 vendored 文字教 DSH 沒有的行為 | **已修** | `skills/.dsh-adapt.json` R7/R8；`check:skills` 守門 |
| I6 README 相容性表過時 | **已修** | README／README.zh §3 已改為 pin + exact 語意 |

**本輪不重開這些項目**；只在 §22 的回歸矩陣中保留對應測試。

---

## 6. 官方 Release Archive 真實結構分析

### 6.1 取得方式與校驗

四平台 archive 全部下載到暫存目錄，逐一比對 `basemind_0.34.0_checksums.txt`（4 行，420 bytes），**4/4 全部 SHA256 相符**（下載後已刪除，僅保留 entry 清單 JSON 於 `_scratch/release/`）。

| asset | 下載大小 | sha256 前 16 | 校驗 |
| --- | ---: | --- | --- |
| `basemind-x86_64-pc-windows-msvc.zip` | 75,627,742 | `ce5ead4dd53f9242` | ✅ |
| `basemind-x86_64-unknown-linux-gnu.tar.gz` | 92,214,847 | `a445dcd803391bea` | ✅ |
| `basemind-aarch64-unknown-linux-gnu.tar.gz` | 102,161,826 | `7f4c954228e38d37` | ✅ |
| `basemind-aarch64-apple-darwin.tar.gz` | 88,184,663 | `e865aa6dbb6e898a` | ✅ |

（這 4 個數字與 [lib/upstream.js:22-27](../lib/upstream.js#L22-L27) 的 `bytes` 完全一致，可作為下載完整性的交叉驗證。）

### 6.2 Windows x64（zip，14 entries，12 regular + 2 dir）

```
00000  regular     39,365  ATTRIBUTIONS.md
00000  regular 226,144,768  basemind.exe
00000  regular   1,490,944  heif.dll
00000  dir(0x10)          0  lib/                     ← 空目錄
00000  regular     377,344  libde265.dll
00000  regular       1,096  LICENSE
00000  dir(0x10)          0  licenses/
00000  regular      47,781  licenses/heif.dll.txt
00000  regular       1,547  licenses/leptonica.txt
00000  regular      47,579  licenses/libde265.dll.txt
00000  regular     344,457  licenses/onnxruntime-ThirdPartyNotices.txt
00000  regular       1,094  licenses/onnxruntime.txt
00000  regular      11,560  licenses/tesseract.txt
00000  regular   1,231,454  THIRD_PARTY_LICENSES
```

- zip 以 Windows 打包（`version made by` platform 63），**無 Unix mode、無 symlink 語意**；全部 deflate，無 zip64。
- 未壓縮 total 229,738,989 bytes。

### 6.3 Linux x64（tar.gz，17 entries，14 regular + 3 dir）

```
00755  5 dir              0  ./
00644  0 regular  1,231,454  ./THIRD_PARTY_LICENSES
00755  5 dir              0  ./licenses/
00644  0 regular     46,672  ./licenses/libde265.so.0.txt
00644  0 regular    344,457  ./licenses/onnxruntime-ThirdPartyNotices.txt
00644  0 regular     11,358  ./licenses/tesseract.txt
00644  0 regular     39,656  ./licenses/libstdc++.so.6.txt
00644  0 regular      1,094  ./licenses/onnxruntime.txt
00644  0 regular      1,521  ./licenses/leptonica.txt
00644  0 regular     46,872  ./licenses/libheif.so.1.txt
00644  0 regular      1,075  ./LICENSE
00644  0 regular     38,708  ./ATTRIBUTIONS.md
00755  5 dir              0  ./lib/
00755  0 regular    984,241  ./lib/libde265.so.0
00755  0 regular  2,962,025  ./lib/libheif.so.1
00755  0 regular  2,401,161  ./lib/libstdc++.so.6
00755  0 regular 313,997,465  ./basemind
```

### 6.4 Linux arm64（17 entries）與 macOS arm64（15 entries）

- Linux arm64：`./basemind` 303,460,281；`lib/libde265.so.0` 926,897、`lib/libheif.so.1` 2,863,777、`lib/libstdc++.so.6` 2,007,833；`licenses/` 7 個檔。
- macOS arm64：`./basemind` 297,529,456；`lib/libheif.1.dylib` 1,951,440、`lib/libde265.0.dylib` 513,808；`licenses/` 6 個檔（無 `libstdc++`）。
- **四個 archive 都沒有**：launcher script、manifest／json metadata、symlink、hardlink、pax/gnu 擴充 header。主 binary 一律在 **archive root**（tar 內為 `./basemind`）。

### 6.5 與官方打包腳本的一致性

`scripts/package-release.sh`（`v0.34.0`）明確規定：

- 打包註解：`# NOTE: the archive contents are at the ROOT ... tar czf "basemind-${TRIPLE}.tar.gz" -C "$STAGING_DIR" .` → 這就是 `./` 前綴的來源（上一輪 C2 的根因，已修）。
- Linux：用 `ldd` 收集**非系統庫**的閉包放進 `lib/`，再 `patchelf --set-rpath '$ORIGIN/lib' // basemind`、`--set-rpath '$ORIGIN' // lib/*.so*`。
- macOS：`otool -L` 閉包放進 `lib/`，`install_name_tool -add_rpath '@loader_path/lib'`、重新 ad-hoc 簽名。
- Windows：把 `release/deps/*.dll`、vcpkg 的 `libheif`／`libde265`、onnxruntime 的 DLL **複製到 archive root**（不是 `lib/`）。
- 每個平台都複製 `LICENSE`、`ATTRIBUTIONS.md`、`THIRD_PARTY_LICENSES`、`licenses/*`。
- **腳本不提供 launcher、不寫 manifest、不產生 checksums**；執行位由消費者設定（官方 launcher `chmod +x`、npm installer `chmodSync(0o755)`）。

### 6.6 與本機實裝的比對（Windows）

`C:\Users\sanny\AppData\Local\Programs\basemind` 的 14 個項目與 zip **逐檔 CRC32 相同**（`basemind.exe` 226,144,768 bytes 完全一致，`allMatch: true`，雙向無差異）。結論：**官方安裝結果＝zip 完整解壓**，不存在「安裝器另外生成」的檔案。

> 這也順帶修正一條舊記憶：本機 BaseMind 已是 **0.34.0**（不是 0.31.0），且是官方 Release 佈局安裝。

---

## 7. Managed Binary 安裝缺陷確認（Critical）

### 7.1 代碼路徑

[lib/binary/manager.js:501-574](../lib/binary/manager.js#L501-L574) 的安裝流程只有一個檔案：

```js
const extracted = path.join(staging, target.binary)                 // :528
await extractor({ archive: archiveFile, kind: target.ext,          // :529
                  entryPath: target.binary, destFile: extracted })
…
const installed = path.join(tmp, target.binary)                    // :537
await fsp.rename(extracted, installed)                             // :538
if (platform !== 'win32') await fsp.chmod(installed, 0o755)        // :539
await writeJson(path.join(tmp, 'install.json'), { …, size, mtimeMs })  // :541-550
await fsp.rename(tmp, targetDir())                                 // :558
```

而 [lib/binary/archive.js:618-624](../lib/binary/archive.js#L618-L624) 明確拒絕含 `/` 的 `entryPath`：

```js
const entry = typeof entryPath === 'string' ? entryPath.replace(/\\/g, '/').replace(/^\.\//, '') : ''
if (entry === '' || entry.includes('/')) throw new ArchiveError('bad-entry', …)
```

因此 `lib/`（`.so`／`.dylib`）、root 層 DLL、`licenses/**`、`LICENSE`、`ATTRIBUTIONS.md`、`THIRD_PARTY_LICENSES` **全部不會被安裝**，且 install.json 只記錄主 binary 的 `size`／`mtimeMs`／`sha256`，所以**沒有任何欄位能發現「安裝不完整」**。

### 7.2 Windows 實測（決定性）

把官方 `basemind.exe` 複製到獨立暫存目錄，`PATH` 只保留 `C:\Windows\system32;C:\Windows`（排除 PATH 干擾）：

| 目錄內容 | 結果 |
| --- | --- |
| 只有 `basemind.exe` | **Exit `-1073741515` = `0xC0000135`（STATUS_DLL_NOT_FOUND）**，stdout／stderr 全空 |
| `basemind.exe` + `heif.dll` | 同樣 `0xC0000135`（`heif.dll` 本身需要 `libde265.dll`） |
| `basemind.exe` + `heif.dll` + `libde265.dll` | `basemind 0.34.0`，exit 0 |

PE import 分析：`basemind.exe` **靜態 import `heif.dll`**（不是延遲載入，`delayImports = []`），`heif.dll` 靜態 import `libde265.dll`。→ **這是 loader 階段失敗，與是否使用 HEIF 功能無關**，`--version` 也會失敗。

**為什麼本機先前「看起來可用」**：本機 `PATH` 含有 `C:\Users\sanny\AppData\Local\Programs\basemind`，loader 從 PATH 找到了 `heif.dll`／`libde265.dll`（`System32` 沒有這兩個檔）。這是一個**假陽性陷阱**：任何「在開發機測得過」的 managed 安裝，都可能只是借用了 PATH 上的另一個安裝。本計畫的 managed integration test（§10）必須**主動把該目錄從 PATH 移除**並斷言，否則會再次得到假陽性。

### 7.3 Linux／macOS（靜態分析，高可信度推論）

- Linux x64／arm64 `basemind`：`DT_NEEDED` 含 `libheif.so.1`、`libstdc++.so.6`、`libgcc_s.so.1`…，`RUNPATH = $ORIGIN/lib`；`lib/libheif.so.1` 再 `NEEDED libde265.so.0`（`RUNPATH=$ORIGIN`）。少了 `lib/` → `ld.so` 直接 `error while loading shared libraries`，`--version` 亦失敗。
- macOS arm64：`LC_LOAD_DYLIB @loader_path/lib/libheif.1.dylib`、`LC_RPATH @loader_path/lib`；少了 `lib/` → dyld `Library not loaded`。
- 附帶：Linux 版**自帶 `libstdc++.so.6`**（避免系統 GLIBCXX 版本過舊），所以「系統已有 libheif」也不保證可用。

> 限制：無法在 Windows 上實際執行 ELF／Mach-O，故標為「靜態分析支持的推論」；§10 的真實 managed test 會在 Ubuntu／macOS runner 上把它變成實測。

### 7.4 授權合規損失

每個平台被丟掉 9–11 個檔案（`LICENSE`、`ATTRIBUTIONS.md`、`THIRD_PARTY_LICENSES`、`licenses/**`，約 1.66 MB）。上游 `ATTRIBUTIONS.md` 明寫「其 release archive bundle 的原生庫授權文字以 `licenses/<library>.txt` 隨 archive 散布」，因此只留 binary 等於**再散布時缺少必要的授權檔案**。這是法律面與「與官方安裝一致」兩個層面的缺陷。

### 7.5 影響面與嚴重度

| 情境 | 現況結果 |
| --- | --- |
| 乾淨機器（PATH 無 BaseMind、`binaryDownload:true`） | 下載→校驗→解壓單檔→`probe` 失敗（`0xC0000135`／`ld.so` 找不到庫）→ 安裝失敗 → **完全沒有工具**（只剩 `/basemind-status` 診斷） |
| 開發機（PATH 上剛好有完整安裝） | 安裝「成功」，但 cache 裡的 binary **不自足**：PATH 一改（或使用者解除安裝本機 BaseMind）就壞 |
| 已手動把整個 archive 解到 PATH 的機器 | 走 PATH 分支，正常（這也是本專案目前唯一被真實驗證過的路徑） |

**判定：Critical，唯一真正的發布阻擋產品缺陷**（CI 失敗是測試缺陷，另計）。

### 7.6 與需求 §6.2 九項檢查的對照

| 要求 | 結果 |
| --- | --- |
| 驗證 SHA256 | ✅ 4/4 相符（§6.1） |
| 列出完整 entries | ✅（§6.2–6.4） |
| Binary 實際位置 | archive root（tar 帶 `./`） |
| 動態依賴目錄 | Windows：root 的 DLL；Linux／macOS：`lib/` |
| 授權檔與附屬資源 | 9–11 個檔案，全部被丟棄 |
| symlink／hardlink | **不存在**，因此「拒絕連結」政策不需放寬（§8.2） |
| 官方 launcher 安裝結果 | 官方 launcher 解整包＋`chmod +x`；本機實裝與 zip 逐檔 CRC 相同（§6.6） |
| 延遲載入依賴 | Windows **不是**延遲載入，是靜態 import（§7.2） |
| 平台依賴解析方式 | Windows 同目錄／PATH；Linux `RUNPATH=$ORIGIN/lib`；macOS `@loader_path/lib` |

---

## 8. 安全解壓及完整安裝方案

### 8.1 方案比較與裁決

| 方案 | 內容 | 安全性 | 維護成本 | 兼容性 | 判定 |
| --- | --- | --- | --- | --- | --- |
| **A. 安全解壓整個官方 archive** | 保留 archive 的完整目錄結構（root 檔案＋`lib/`＋`licenses/`），套用同一組安全檢查 | 高（沿用現有全部防護，只需支援多 entry 與目錄） | 低（上游新增檔案自動跟上） | 最高（等於官方 launcher） | **採用** |
| B. 依 manifest 只抽必要檔案 | 在 `lib/upstream.js` 為每 target 列出要抽的清單 | 中（清單漏檔即靜默壞掉） | 高（每次升版要逐平台維護） | 中 | 不採用（§6.3 明令「不得自行猜測需要哪些 DLL／SO」） |

**採用 A，並補一個由 archive 自身推導的完整性清單**（不是人手維護的清單）：解壓時把「實際寫出的相對路徑 + 大小」記進 `install.json.files[]`；快取命中時逐項核對存在與大小。這樣「完整性」的來源是本次下載的真實 archive，而不是猜測。

### 8.2 解壓契約（保留舊防護 + 明確定義新增行為）

新增 `extractArchive({ archive, kind, destDir, limits, fs })`（保留 `extractSingleFile` 給既有測試與相容呼叫）：

| 項目 | 規則 |
| --- | --- |
| 路徑來源 | entry 名稱一律**只用來計算相對路徑**，最後解析出的絕對路徑必須在 `destDir` 之內（`path.resolve` 後前綴檢查，杜絕 ZIP Slip） |
| 絕對路徑／磁碟機／UNC | 拒絕（沿用 `assertSafeName`，另加 `\\server\share` 形式） |
| `..` 段 | 拒絕（沿用） |
| 前綴 | strip 單一前導 `./`（沿用 `normalizeTarEntryName`） |
| 目錄 entry | 允許，`mkdir -p`；空目錄（Windows zip 的 `lib/`）也要建立 |
| symlink／hardlink／device／fifo | **一律拒絕**（官方四個 archive 都沒有，因此不需要放寬——這是本輪的重要事實） |
| 重複 entry | 拒絕（正規化後同名；Windows 另以 case-insensitive 比較） |
| 加密／zip64 | 拒絕（沿用） |
| 大小上限 | 單檔 400 MB 沿用；**整包上限提高**（見下） |
| 檔案數上限 | 沿用 1,000 |
| 內容校驗 | 每個 regular entry 的實際寫出位元組數必須等於 header 宣告值，否則 `size-mismatch` |
| 取消 | 沿用 `signal`；中斷後刪除整個 staging 目錄 |
| 失敗清理 | 沿用 `try/finally` 刪 staging／tmp |

**大小上限調整**：預設 400 MB 對 linux-x64（未壓縮 total 322 MB）只剩 20% 餘裕，未來版本很容易撞到。建議把 `manager` 呼叫時的 `maxTotalBytes` 設為 **2 GiB**、`maxEntryBytes` 設為 **1 GiB**，`archive.js` 的**預設值不動**（單元測試與既有語意不變）。

### 8.3 原子安裝、權限與 Windows 檔案佔用

| 議題 | 做法 |
| --- | --- |
| 原子性 | 解壓到 `staging/extracted/` → 在其中寫 `install.json` → `rename` 成 `managed-binaries/<version>/<target>`（同一檔案系統，目錄 rename 原子）。沿用現有 `tmp` 命名與「先刪舊 target 再 rename」，但**刪舊之前**要確認沒有本進程 relay 正在使用（manager 的 `select()` 發生在任何 relay 啟動之前，因此原本就安全；若日後有「熱替換」需求另議） |
| 執行權限 | POSIX：`chmod 0o755` 主 binary（`lib/*.so*` 由 tar 的 0755 保留即可，額外統一設 0o755 較省事）；Windows：不動 |
| 目錄權限 | 一律 0o755，不因 umask 差異造成不可讀 |
| Windows 檔案佔用 | `rename` 失敗（`EBUSY`／`EPERM`／`EACCES`）→ 有限次退避重試（例如 5 次 × 200 ms）後，回報「另一個進程正在使用快取，請重啟 DSH」；**絕不**在失敗時留下半套目錄（rename 前失敗＝staging 被清掉；rename 後失敗＝舊目錄仍在） |
| 舊目錄刪不掉 | 沿用 `fsp.rm(..., { force, recursive })` 的 best-effort；若刪不掉就不 rename，讓 `select()` 回報可診斷原因，不覆蓋 |
| 磁碟用量 | 每平台約 230–322 MB（未壓縮）。README 需明確寫出，避免使用者誤以為「下載 75 MB 就只佔 75 MB」 |

### 8.4 `install.json` 布局版本（layout 2）

```jsonc
{
  "layout": 2,                       // 新增：安裝布局版本；舊記錄沒有這個欄位
  "version": "0.34.0",
  "target": "linux-x64",
  "sha256": "<asset sha256>",
  "url": "https://github.com/…/basemind-x86_64-unknown-linux-gnu.tar.gz",
  "tag": "v0.34.0",
  "installedAt": "2026-11-24T…Z",
  "binary": "basemind",              // 新增：主 binary 相對路徑（Windows 為 basemind.exe）
  "size": 313997465,                 // 保留：主 binary 大小（相容既有欄位語意）
  "mtimeMs": 1732…,                  // 保留
  "files": [                         // 新增：本次 archive 實際寫出的 regular files
    { "path": "basemind", "size": 313997465 },
    { "path": "lib/libheif.so.1", "size": 2962025 },
    { "path": "licenses/onnxruntime.txt", "size": 1094 }
  ]
}
```

### 8.5 需要的程式改動（最小）

| 檔案 | 改動 |
| --- | --- |
| [lib/binary/archive.js](../lib/binary/archive.js) | 新增 `extractArchive()`；抽出共用的 entry 安全檢查與大小累計；`extractSingleFile()` 行為不變（可由 `extractArchive` 的單檔模式實作，但**必須保留對外簽名與錯誤碼**） |
| [lib/binary/manager.js](../lib/binary/manager.js) | `installPinned` 改為「解整包到 staging → 寫 install.json(layout 2, files) → 原子 rename 整個目錄」；`readManagedCache` 增加布局與 `files[]` 完整性檢查；`binaryPath()` 改讀 `install.json.binary`（預設仍為 `target.binary`） |
| [lib/status.js](../lib/status.js) | `/basemind-status` 顯示「布局版本、檔案數、主 binary、缺少的檔案（若有）」 |
| [lib/upstream.js](../lib/upstream.js) | **不改**（archive 結構由實際下載推導，不新增手維護清單） |
| [test/binary-archive.test.mjs](../test/binary-archive.test.mjs)、[test/binary-manager.test.mjs](../test/binary-manager.test.mjs) | 新增整包解壓／布局／遷移／缺檔／Windows 佔用等案例（§22） |
| 新增 `test/binary-install-layout.test.mjs` | 以「照真實 archive 形狀」的 fixture 走完整 install 路徑（含 `./` 前綴、`lib/`、`licenses/`、空 `lib/`、root DLL） |

**不做**：不重寫 manager、不改候選順序、不改鎖／冷卻／single-flight 語意、不新增依賴。

---

## 9. 舊快取兼容及遷移

### 9.1 現況

舊快取 = `managed-binaries/<version>/<target>/{basemind(.exe), install.json}`，`install.json` 沒有 `layout`／`files`。這正是 §7 會產生「無法啟動」或「不自足」的目錄。

### 9.2 遷移規則（安全、可預期、只寫插件自管快取）

| 情況 | 判定 | 動作 |
| --- | --- | --- |
| `install.json` 缺失，但目錄只有主 binary | 舊布局 | 視為**不完整**；在鎖內重新下載並整包替換 |
| `install.json.layout !== 2` | 舊布局 | 同上 |
| `layout === 2`，`files[]` 每一項存在且大小相符 | 完整 | **零網路**重用（只做 stat，不做 hash） |
| `layout === 2`，但缺檔或大小不符 | 損壞 | 重新下載並替換；日誌一行、`/basemind-status` 可見 |
| 主 binary 大小／mtime 與記錄不符 | 可能被替換 | 沿用現有 `sha256` 校驗（只 hash 主 binary，不 hash 整個樹） |
| 多進程同時遇到舊快取 | 鎖保護 | `installPinned` 內 `readManagedCache()` 二次檢查（[:511-516](../lib/binary/manager.js#L511-L516)）已能避免重複下載；新增的完整性檢查要在**鎖內**執行 |
| 安裝失敗（磁碟滿／校驗失敗） | 保留舊目錄 | 舊目錄不動、staging 清理、回報可診斷原因；不要讓「失敗後比失敗前更糟」 |

### 9.3 明確不做

- 不刪除其他版本目錄、不 `gc`、不動 `state.json` 以外的檔案。
- 不因為「主 binary `--version` 成功」就認定完整（§7 的教訓）。
- 不在每次 Tool Call 重新校驗整棵樹（只在 `select()` 一次，且只 stat）。
- 不遷移 BaseMind 的 data home／index／memory。

### 9.4 代價

舊使用者第一次升級會重下 75–102 MB 並多佔 230–322 MB 磁碟。這是**唯一能保證正確**的做法（單檔快取無法補齊缺檔），必須在 CHANGELOG 與 README 寫明。想避免下載者可先 `binaryDownload:false` 並自行安裝官方完整版到 PATH。

---

## 10. 真實 Managed Binary Integration Test（新增能力）

### 10.1 目標

證明**插件自己的**下載→校驗→解壓→安裝→啟動全流程在真實環境可用。現有 `test/integration.test.mjs` 只驗證「外部已安裝 binary」的 MCP 契約，且 CI 用系統 `tar`／`unzip` 解整包（[compat.yml:90-93](../.github/workflows/compat.yml#L90-L93)）——**它結構上不可能發現 §7 的缺陷**。

### 10.2 隔離設計

| 變數／資源 | 設定 |
| --- | --- |
| `DSH_HOME` | `mkdtemp()`；managed cache 落在其下 |
| `BASEMIND_DATA_HOME` | 同一個 temp 下的子目錄 |
| `BASEMIND_COMMS_DIR` | 同上（避免碰到使用者 daemon） |
| `PATH` | **主動移除任何含 `heif.dll`／`libde265.dll`／`basemind` 的目錄**；測試斷言 `resolveExecutable('basemind')` 失敗（避免 §7.2 的假陽性） |
| 工作區 | 測試自建的**小型 git repo**（`git init`＋3–5 個檔案＋1 個 commit），避免索引本 repo 需要 30 s 以上 |
| 環境 | 測試結束刪除整個 temp；不呼叫 `comms stop`、不停止使用者 daemon |

### 10.3 必測場景（需求 §7.2 A–G）

| # | 場景 | 斷言 |
| --- | --- | --- |
| A | 無 BaseMind、無快取 | 下載 1 次、checksums 1 次；安裝目錄含 `basemind`＋`lib/*`（非 Windows）或 `*.dll`（Windows）＋授權檔；`install.json.layout === 2` 且 `files[]` 與實際目錄一致 |
| B | 本地存在不相容 BaseMind（例如 0.33.0 shim） | fallback 到 managed；日誌／狀態標明「本地版本不相容」 |
| C | 本地存在相容 BaseMind（`command` 指向官方 0.34.0） | **0 次網路、0 次快取寫入**（反向斷言） |
| D | 快取已存在 | 第二次 `select()` 0 次網路；只 stat，不 hash |
| E | 快取缺 `lib/libheif.so.1`（或 Windows 缺 `heif.dll`） | 偵測為不完整 → 安全重新安裝 → 安裝後可執行 |
| F | 舊單檔快取（手造：只有 binary + layout 1 install.json） | 被判定不完整 → 重裝；不刪使用者其他資料 |
| G | 多 session／多進程同時首次啟動 | 只下載一次（沿用真實子進程 fixture 模式，擴充為 managed 路徑） |

### 10.4 運行驗證清單（不得只 `--version`）

| # | 驗證 | 方式 |
| --- | --- | --- |
| 1 | `basemind --version` | 直接 spawn 已驗證 binary |
| 2 | `basemind status` | CLI（回傳 index 健康狀態；空索引也算成功，檢查 `state: empty_index`） |
| 3 | `basemind doctor` | CLI（在測試 repo 內應 exit 0 或只含可接受的 warn；若 exit 1 需記錄原因並斷言「不是因為 binary 缺庫」） |
| 4 | MCP `initialize` | 走插件自己的 `createStdioClient`＋`createMcpSession` |
| 5 | `tools/list` | 15 verb tools（＋3 agent tools 若 build 支援） |
| 6 | `index_status` | 輪詢直到 `indexing: false`（冷索引，含 timeout） |
| 7 | `code_outline` | 對測試 repo 的檔案 |
| 8 | `code_read` | 取一段內容 |
| 9 | `code_refs` | 對已知符號 |
| 10 | `git_log` | 一筆 commit |
| 11 | 一項 CLI-only 高級分析 | `basemind code callers <path> <name>` 或 `basemind overview`（MCP 沒有對應 verb 的能力） |
| 12 | 附屬運行庫相關功能 | `basemind docs search <term>`（文件管線）或 `basemind code search`；若需要額外模型／OCR，**明確標記為未在 CI 驗證** |

**限制（必須記錄，不得假裝通過）：**

- 語意搜尋／OCR／HEIF 影像解析：需要額外模型或大型資源，CI 不下載 → **本輪不納入 gate**，在文件中列為未驗證。
- `code search`（語意）可能需要 embedding 模型；若 CI 無模型則只驗證它能回報可診斷錯誤。
- tree-sitter grammar：首次執行會下載約 22 MB parser bundle 到 `BASEMIND_DATA_HOME`（實測 §6 附帶發現）；測試要允許這個下載，或先 `basemind lang install` 預熱；文件要寫明「第一次啟動需要網路」。

### 10.5 強制 Gate 契約

| 變數 | 語意 |
| --- | --- |
| `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1` | 必須真實下載／安裝／執行；binary 不存在、下載失敗、校驗失敗、安裝不完整 → **fail**（不得 skip） |
| 未設定 | 一般 `npm test` 時 **skip**（不從 GitHub 下載 75–102 MB），輸出明確 skip 訊息 |
| `DSH_BASEMIND_MANAGED_TEST_KEEP=1` | 保留 temp 目錄以便除錯（預設刪除） |

- 與既有 `BASEMIND_REQUIRE_INTEGRATION` 的關係：兩者是**不同**契約（一個驗外部 binary、一個驗插件安裝），不合併、不互相隱含。文件與 CI 都要寫清楚。
- 「只有 mock installer」不得算通過：managed test 必須用**真實 `extractArchive` ＋真實 `downloadVerified`**（只有在「下載來源」上允許用 `BASEMIND_RELEASE_BASE_URL` 指向鏡像，預設走官方 GitHub）。

### 10.6 時間預算

| 平台 | 下載 | 解壓＋安裝 | 索引（小型 repo） | 合計（估） |
| --- | --- | --- | --- | --- |
| Windows x64 | 75 MB | ~5 s（DOS 掃描） | ~5–15 s | 1.5–3 min |
| Linux x64 | 92 MB | ~2 s | ~3–10 s | 1–2 min |
| macOS arm64 | 88 MB | ~2 s | ~3–10 s | 1–2 min |

單一 job `timeout-minutes: 20` 足夠。

---

## 11. 跨平台 CI 方案

### 11.1 三層分層

| 層 | Workflow | 平台 | 內容 | 觸發 |
| --- | --- | --- | --- | --- |
| L1 快速 | [ci.yml](../.github/workflows/ci.yml)（既有） | ubuntu-latest、windows-latest | `npm test`（managed integration **skip**）、`check`、`check:skills`、`check:pack` | push / PR |
| L2 真實契約 | [compat.yml](../.github/workflows/compat.yml)（既有，微調） | ubuntu-latest、macos-15、windows-latest（+ 嘗試 `ubuntu-24.04-arm`） | 外部官方 binary 的 MCP／CLI 契約（`BASEMIND_REQUIRE_INTEGRATION=1`） | `workflow_dispatch`（保留）＋ 每日排程（新增，見 11.4） |
| L3 Managed 冷啟動 | **新增** `managed-binary.yml` | ubuntu-latest、macos-15、windows-latest（+ `ubuntu-24.04-arm` 有條件） | `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1 node --test test/integration-managed.test.mjs`；**不用 actions cache**（真正冷快取）；第二個 step 驗證「重用不連網」 | `workflow_dispatch`、每週排程、`release.yml` 前置 job |

### 11.2 `managed-binary.yml` 關鍵設計

1. **冷快取**：`DSH_HOME: ${{ runner.temp }}/dsh-home-<run_id>`；**禁止** `actions/cache`，並在 step 內 `ls -la` 斷言目錄一開始不存在。
2. **PATH 淨化**：把 `$RUNNER_TOOL_CACHE` 之外任何含 `basemind` 的路徑從 PATH 移除；斷言 `command -v basemind` 為空（避免 §7.2 假陽性）。
3. **第一次跑**（網路）：完整 A–G 中 A／D／E／G；斷言安裝目錄樹與 `install.json`。
4. **第二次跑**（斷網）：用環境變數把 `BASEMIND_RELEASE_BASE_URL` 指向不可達位址（或直接設 `binaryDownload:false`），斷言 **0 次網路**仍能啟動。
5. **失敗時保留證據**：把 `/basemind-status` 文字、`install.json`、`ls -R` 快取目錄寫進 artifact（`if: failure()`）。
6. 版本一律從 `lib/upstream.js` 取值（沿用 compat.yml 的 Resolve step 模式），**不得**出現 `0.34.0` 字面值。

### 11.3 compat.yml 的三個小缺口

| 缺口 | 現況 | 建議 |
| --- | --- | --- |
| Linux arm64 完全沒有覆蓋 | matrix 只有 ubuntu／macos-15／windows | 加 `os: ubuntu-24.04-arm`（公開 repo 可用），若 runner 不可用則 job 以清楚的 `::warning` 跳過並記錄（**不得**假裝通過） |
| 從未執行過 | 只有 `workflow_dispatch` | 加 `schedule`（每日或每週）＋ 保留手動；讓平台契約有持續證據 |
| 只用系統 `tar`／`unzip` 解包 | [compat.yml:90-93](../.github/workflows/compat.yml#L90-L93) | 保持（外部 binary 契約測試理應用官方方式解包），但要在文件寫明「這條路徑測不到插件自己的解壓」 |

### 11.4 讓 CI 失敗可自助診斷（解決 §3.2 的取證困難）

在 `ci.yml` 的 `Run tests` 加：

```yaml
- name: Run tests
  run: npm test
  # 失敗時仍輸出結構化摘要，供無 token 的人（含 Agent）讀取
- name: Upload the test summary
  if: failure()
  uses: actions/upload-artifact@v4
  with:
    name: test-summary-${{ matrix.os }}
    path: |
      _ci/test-summary.txt
```

並讓 `npm test` 以 `--test-reporter=spec --test-reporter-destination=_ci/test-summary.txt` 產生摘要。這只在失敗時花幾 KB，不影響成功路徑；**它是本輪之後「CI 紅但拿不到日誌」的結構性解法**。

### 11.5 Release Gate

[release.yml](../.github/workflows/release.yml) 目前是單一 ubuntu job、裝外部 binary 後跑 `npm test`。建議：

- 在 `publish` 之前加一個 `managed-gate` job（`needs: [managed-gate]`），矩陣 ubuntu／macos／windows，跑 L3 的冷快取 managed test。
- 保留現有「外部 binary + 全測試」job。
- 文件明確寫：「Release 前必須三個平台 managed 冷快取通過；Linux arm64 若 runner 不可用，需在 Release note 標明未驗證」。

---

## 12. DSH Desktop 驗收方案

### 12.1 前置事實

- 本機 Desktop profile（`~/.dsh/profiles/desktop`）目前安裝的是 **`dsh-basemind-plugin@0.1.6`**，且 [cordis.patch.yml:677-679](../cordis.patch.yml) 對應 row 是 `disabled: true`。
- 因此**任何驗收都不得動 desktop profile**，必須用獨立測試 profile。

### 12.2 測試環境

| 步驟 | 命令／說明 |
| --- | --- |
| 建 profile | `dsh plugin --profile dsh-bm-accept add <tarball 路徑> --save-exact`（用 `npm pack` 產出的 0.3.0 tarball，不用 registry） |
| 啟動 | `DSH_HOME=<temp> dsh web --profile dsh-bm-accept`；測試 workspace 指向一個小型 git repo |
| 清理 | 驗收後刪除整個 profile 目錄；不動 desktop |

### 12.3 驗收清單（需求 §9）

| # | 項目 | 通過標準 |
| --- | --- | --- |
| D1 | 從 npm tarball 安裝 | 插件 row 出現、啟用後 Host 無 error log |
| D2 | 本地 binary 匹配 | 用官方 0.34.0 在 PATH → source 顯示 PATH、`/basemind-status` 顯示 match |
| D3 | 不相容 binary + managed fallback | 用 0.33.x shim → 顯示不相容並改走 managed（或依 `binaryFallback` 語意） |
| D4 | 無本地 binary → managed 安裝 | **冷 `DSH_HOME`** 下載成功；安裝目錄完整（layout 2） |
| D5 | `/basemind-status` | 顯示版本、來源、cache、布局、檔案數、可行動建議 |
| D6 | 停用／重載／卸載 | 停用後工具消失、skill 目錄消失、prompt section 消失；重載不重複註冊；卸載無殘留 relay（`tasklist`／`ps` 檢查） |
| D7 | 15 個 verb tools + 3 agent tools | `tools/list` 與 fixture 一致（comms build 才有 agent tools） |
| D8 | 真實 Agent Tool Call | 在對話中讓 agent 用 `code_grep`／`code_outline` 完成一件小事 |
| D9 | StructuredContent | 回傳含 `structuredContent`，且 render 文字不是 JSON 假設 |
| D10 | CLI Adapter | `mcp__basemind__cli` 可跑 `status`、`doctor`；`scan` 被拒且訊息清楚 |
| D11 | MCP Resources | `basemind://outline/{path}` 可讀；錯誤路徑有可診斷錯誤 |
| D12 | 10 個 Skills 進原生 registry | `/` 命令目錄或 skill catalog 可見 10 個；**Agent 實際載入正文**（`skill({name})` 回 `<skill_content>`） |
| D13 | 同名衝突 | 專案放一個同名 skill → 專案版勝出（rank 1000 低於 bundled/project 層） |
| D14 | 工作區隔離 | Session A→RepoA、Session B→RepoB、A 切到 RepoC、subagent、同 repo 兩個 worktree；每次呼叫都走實際 agent 目錄 |
| D15 | 不可用時不誤導 | `binaryDownload:false` 且無 binary → 無工具、無 skills、bootstrap 為空 |

> D12–D13 是本輪**最需要實機證據**的兩項：上一輪 Review 的 C1 就是在這一層被發現的（fixture 自證抓不到 registry 契約）。

---

## 13. Compaction 及 Bootstrap 驗證

### 13.1 DSH 的實際機制（已用 runtime 與原始碼確認）

| 事實 | 證據 |
| --- | --- |
| System prompt 是**每個 model step 重新組裝**的 | `ctx.systemPrompt.section()` / `assemble()` / `context()` 註冊表；事件 `system-prompt/assemble`（waterfall） |
| **沒有** `session_compact` 事件 | 事件目錄只有 `compaction/summary-error`（waterfall，失敗摘要補救）；`ctx.compaction` 提供 `compactIfNeeded`／`compactNow`／`compactRegion` 服務 |
| Skills 目錄由 DSH 自行維護 | `skills.md`：每次 model step 前比較可見目錄與最新目錄訊息，「compaction 若把歷史目錄訊息藏起來，下一次觀測會重新建立目前目錄」 |
| Bootstrap 是 section，不是訊息 | [index.js:616-643](../index.js#L616-L643) `registerBootstrap` → `getText()` 每次呼叫時求值 |

**推論（高可信度）**：Pi 的 `session_compact → 重設 injectBootstrap` 機制在 DSH **不需要**，因為 section 每 step 重新求值、不會被 compaction 刪掉。**本輪不新增任何 compaction hook**（需求 §10 明確要求：只有真實證據顯示缺失才修）。

### 13.2 需要驗證的 9 項（需求 §10）

| # | 項目 | 現況判斷 | 驗證方式 |
| --- | --- | --- | --- |
| 1 | Session 首次建立時引導存在 | ✅ 設計成立（section 常駐，ready 後非空） | Desktop：開新 session，檢查 system prompt 含 bootstrap |
| 2 | 多輪對話後不重複累積 | ✅（section 只有一份，`getText()` 每次重算） | 連問 5 輪後檢查 prompt 長度不變 |
| 3 | Compaction 前後仍有效 | ✅ 推論（每 step 重組） | 觸發 compaction（`/compact` 或自動），檢查 bootstrap 仍在 |
| 4 | Session 恢復後有效 | ✅（section 屬於 plugin fiber，session 恢復不重建 plugin） | 重啟 DSH 後回到同一 session，檢查 prompt |
| 5 | Subagent 使用正確工作區 | ✅（`ctx.workingDirectory.ensure(agent)` 用實際 agent） | D14 案例 |
| 6 | 不可用時不宣告不存在的工具 | ✅（`readiness.ok()` 才輸出；測試 [:547-562](../test/index.test.mjs#L547-L562) 已覆蓋） | D15 |
| 7 | Relay 異常退出時 readiness 不會永久錯誤 | ⚠️ **有落差**：`onClose` 只記 log（[index.js:173-177](../index.js#L173-L177)），不改 `state.ready`；readiness 是**全域**而非 per-agent／per-workspace | 需實測：殺掉某 workspace 的 relay → 下一次呼叫是否自動重建？readiness 是否仍宣稱可用？ |
| 8 | 工具重新發現後引導能恢復 | ⚠️ 僅在 `selection` 變更時 `readiness.notify()`；`scheduleToolSync` 成功後沒有 notify（[:435-446](../index.js#L435-L446)） | 用 fake server 送 `tools/list_changed`，檢查 skills invalidate 是否被觸發 |
| 9 | 插件停用後 prompt section 被清理 | ✅（`ctx.effect` cleanup → `shutdown()` → 逐個 dispose） | D6 |

### 13.3 只有在實測證明缺失時才做的「最小修復」（預先界定，避免擴散）

| 缺口 | 最小修復 |
| --- | --- |
| #7 relay 死亡後 readiness 仍 true | `onClose` 時若該 session 是 `primarySession`，把 `readiness.ready` 設 false 並 notify；下一次 `clientFor(root)` 成功後再設回 true。**不新增 per-agent 狀態機**。 |
| #8 工具重發現後未通知 skills | `syncTools()` 成功後呼叫 `readiness.notify()`（一行）。 |

兩者都必須有 targeted test；若實測沒有問題，**不做**（需求 §10 最後一段）。

---

## 14. Agent A/B 效果測試方案

### 14.1 對照組設計（不需要兩個版本）

需求寫「A. 改造前的 0.2.0 MCP Bridge」與「B. 最新 Skills + Bootstrap + CLI」。因為 0.2.0 已經把三個表面做成**開關**，最乾淨的對照是**同一個 build、同一份 binary、同一份索引**，只切 config：

| 組 | config |
| --- | --- |
| A（MCP-only） | `{ skills: false, bootstrap: false, cliTool: false }` |
| B（完整） | 預設值 |

這樣可以排除「不同 build 的其它差異」與「不同 binary 版本」兩個混淆因子。若維護者仍要對照真正的 0.1.6，需另外建立 profile（成本高、混淆多）→ 建議不做。

### 14.2 固定條件

- DSH Standard Preset（不修改）；模型與 reasoning effort 由當次配置決定並記錄（**不在插件硬編**）。
- 同一專案、同一 git commit（記錄 SHA）、同一 BaseMind 0.34.0、同一索引狀態。
- 每個場景使用**同一句 prompt**，先跑 A 再跑 B（或反之），各 1–2 次。

### 14.3 專案與場景

| 專案 | 狀態 |
| --- | --- |
| Vue 3 專案 | 建議用使用者已授權的 `transmac-oms-fe`（唯讀，不改業務碼） |
| 大型 Java 專案 | 建議 `transmac-oms`（唯讀） |

11 個場景：定位函式／分析檔案結構／查符號引用／查方法呼叫關係／理解大型 Vue SFC／分析 Java 類與依賴／分析修改影響範圍／查 Git 歷史／搜尋專案文檔／審查 staged changes／BaseMind 不適用時的 fallback。

### 14.4 記錄表（每次一行）

| 欄位 | 來源 |
| --- | --- |
| 任務結果正確性 | 人工判定（0/1 + 錯在哪） |
| 是否主動選 BaseMind | 工具呼叫序列 |
| BaseMind Tool Calls／Skill 載入次數／原生 Read·Grep·Bash 次數 | session log 的 tool 事件 |
| 無效工具呼叫／工具錯誤與重試 | session log |
| CLI Adapter 使用次數 | tool name `mcp__basemind__cli` |
| 輸出大小 | tool result bytes |
| 任務總耗時 | session 時間戳 |
| 實際 token（input／output／cached） | **模型供應商回報**的 usage；DSH `tokenMeter` 只能作參考 |
| BaseMind 自報 token saved | 單獨一欄，**不得與實際計費 token 混用** |

### 14.5 成功標準

1. **正確性優先**：B 不得比 A 差。
2. 其次才是 token 與時間；若 B 的 token 沒有下降但正確性提升，仍算成功（需說明）。
3. 不以「BaseMind 呼叫比例」當唯一指標。
4. 若無法取得供應商計費 token，明確寫「無法取得，僅有 DSH 估算」。
5. Vue SFC 的上游解析限制（例如 template 內符號）**不得記為插件缺陷**。

### 14.6 成本控制

每個場景 A/B 各 1 次、兩個專案共約 22 次對話；建議先跑 4 個代表場景（定位／引用／影響範圍／fallback）做試點，再決定是否全跑。

---

## 15. Commands / Prompts 接入方案

### 15.1 DSH 原生命令契約（已從安裝版文件確認）

`@deepseek-ai/dsh/docs/subsystems/commands.md`（取自本機 `app.asar`）：

```ts
interface CommandDefinition {
  readonly definitionId?: CommandDefinitionId
  readonly name: string              // 小寫、不含前導斜線
  readonly description: string
  readonly input?: { hint: string; attachments?: boolean }
  readonly recordInput?: boolean     // 預設 true
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}
interface CommandInvocation {
  readonly commandId: CommandId
  readonly agent: Agent              // 收到命令的確切 Agent
  readonly rawInput: string          // 名稱後的全部文字（含分隔空白）
  readonly attachments: readonly (ImageBlock | FileBlock)[]
  readonly signal: AbortSignal       // 由 UI 請求擁有
}
type CommandResult = { kind: 'success'; text?: string; sourceEventSeq?: SessionSeq }
                   | { kind: 'error'; text: string }
```

- 命令**不進模型、不消耗 token**，結果由 UI 直接顯示。
- 事件：`commands/change`（註冊／取消註冊）；服務：`register`／`list`／`find`／`execute`。
- 既有 `/basemind-status`（[index.js:646-667](../index.js#L646-L667)）就是這個契約，已可用。

### 15.2 六個目標命令的分流與設計

| 命令 | 類型 | 動作（argv，固定模板） | 工作區 | 人工確認 | 逾時 |
| --- | --- | --- | --- | --- | --- |
| `/bm-doctor` | **確定性** | `doctor`（若 exit 1，仍回 success 並附「發現問題」摘要；argv 不含任何使用者輸入） | `invocation.agent` | 無 | 120 s |
| `/bm-stats [today\|1h\|24h\|all]` | **確定性** | ① `cache stats` ② `admin telemetry --window <enum>`（預設 `24h`） | `invocation.agent` | 無 | 各 60 s |
| `/bm-scan [path]` | **確定性（會寫索引）** | 無 path：`scan`；有 path：`rescan <path>`。**兩段式**：第一次只回「將執行什麼＋影響範圍」，需 `/bm-scan --yes` 才真的執行 | `invocation.agent` | **必要** | 首次 5 s；執行 300 s |
| `/basemind-status` | 既有 | — | — | 無 | 5 s |
| `/bm` | **模型提示** | 無需新增：10 個 vendored skills 已設 `userInvocable: true`（[lib/skills/provider.js:172](../lib/skills/provider.js#L172)），官方 `/bm` 的「問答路由」由 `basemind`／`basemind-code-search` skill 在使用者側承擔 | — | — | — |
| `/bm-init` | **只讀預覽** | `init --print`（**只印計畫，不寫檔**）；若該 binary 不支援 `--print`，顯示官方 CLI 指引並停止 | `invocation.agent` | 只讀，不需確認 | 60 s |
| `/bm-statusline` | **暫緩** | CLI 有 `basemind statusline`（fast、無 daemon 時 exit 0），但 **DSH 沒有 statusline 擴充面**；不得把它說成 statusline | — | — | — |

**為什麼 `/bm-scan` 可以存在（需要人工裁決 D1）**：本專案 [AGENTS.md](../AGENTS.md) §5 目前寫「scan／rescan 一律禁止」。需求 §13 明確把 `/bm-scan` 定義為「人工主動觸發的索引管理操作」。本計畫的立場是：**使用者親手輸入的命令**屬於人工觸發，可以執行；**插件啟動、工具呼叫、工具發現**一律不得自動觸發。若裁決通過，AGENTS.md §5 需要補一句這個例外（文件修改，非行為擴張）。

**為什麼 `/bm-init` 只做預覽**：官方 `basemind init` 會寫 `basemind.toml`、注入 rules block、改 `.gitignore`。需求 §13 明令「禁止未經確認修改 AGENTS.md／basemind.toml／…」。DSH 命令沒有互動確認 UI，因此**只提供預覽＋指引**，由使用者在終端自行執行。

### 15.3 實作落點（最小）

| 檔案 | 內容 |
| --- | --- |
| **新增** `lib/commands.js` | `registerBasemindCommands(ctx, { manager, settings, logger })`：解析 `rawInput`、驗證、以 `resolveLaunch`＋`ctx.subprocess.spawn` 執行已驗證 binary、套用輸出上限、回傳 `CommandResult`。**不新增依賴、不新增常駐資源** |
| [index.js](../index.js) | 在 `ctx.effect` 內呼叫一次（與 `registerStatusCommand` 並列），`state.disposers` 統一清理 |
| [lib/cli-tool.js](../lib/cli-tool.js) | 抽出可複用的「執行一次 CLI 並做輸出上限」的內部函式（`/bm-doctor`、`/bm-stats` 的 argv 已在 allowlist：`doctor`／`status`／`cache stats`／`admin telemetry`，[lib/cli-tool.js:131-138](../lib/cli-tool.js#L131-L138)）；`/bm-scan` 與 `/bm-init` 用命令專屬的固定模板驗證，**不擴充模型可見的 allowlist** |
| [lib/status.js](../lib/status.js) | 佈局／檔案數／缺檔顯示（§8.5） |

### 15.4 安全與體驗約束

| 約束 | 做法 |
| --- | --- |
| argv 注入 | 不用 shell；`rawInput` 先 trim、拒絕任何以 `-` 開頭的 token、拒絕 `..`、拒絕絕對路徑與磁碟機、`path` 只能是單一相對路徑；`window` 只能是指定 enum |
| 工作區 | `await ctx.workingDirectory.ensure(invocation.agent, invocation.signal)`；不得用 `process.cwd()` |
| binary | 只使用 `binaryManager` 選出的已驗證 binary；不得呼叫 PATH 上的裸 `basemind`（避免版本不一致） |
| 取消／逾時 | 把 `invocation.signal` 傳進 spawn；每個命令有自己的 timeout；逾時→`{kind:'error'}` 並附「可用／basemind-status 診斷」 |
| 輸出 | ANSI 關閉（`--no-color` 或 `NO_COLOR=1`）、上限 64 KB、超出截斷並註明 |
| 不進模型 | 全部走 `CommandResult`，不注入 system prompt、不產生 tool result |
| 註冊衝突 | `commands.register` 若因同名衝突拋錯 → 捕捉、記一行 log、**不覆蓋**；測試覆蓋 |
| 清理 | `ctx.effect` cleanup 逐個 dispose；停用後命令消失（D6 驗證） |
| 來源／版本 | 命令的說明文字要寫明「使用 pin 的 0.34.0 binary」，並取自 `lib/upstream.js` |

### 15.5 為什麼不把官方 6 個 prompt 原樣 vendored

- 它們全部是「叫模型去跑 CLI」的提示詞（§4.4）。本插件已經有 `mcp__basemind__cli` 這個**真正可執行**的工具，再引入一份提示詞只會增加 prompt 長度與維護成本。
- 官方 `bm-statusline` 直接改 `~/.claude/settings.json`，在 DSH 語意下是錯的。
- 官方 `bm-init` 會寫專案檔案，需要人工確認（本計畫只做預覽）。
- 因此**同步官方 commands 資源**（需求 §14）在本輪的結論是：**不需要 vendoring**；需要時只同步「語意」到 `lib/commands.js`，並在 `docs/upstream-sync.md` 記錄對照表。若日後 DSH 提供 prompt 型命令（可送訊息給模型），再評估 vendoring。

---

## 16. Binary / Relay 異常通知方案

### 16.1 DSH 是否有原生通知接口（結論：Host 側沒有）

| 檢查 | 結果 |
| --- | --- |
| Host Service 目錄 | 109 個 service，**沒有** `notifications`／`toast`／`notice` 類服務（完整清單見 §18.1） |
| Host Event 目錄 | 沒有通知類事件（最接近的是 `plugin-manager/*`、`deepseek-account/*`，都與本插件無關） |
| 原始碼掃描 | `toast` 只出現在 9 個 **client UI** 檔案（`@deepseek-ai/dsh-client-ui-workspace`、`…-schedule`、`…-open-in-app`、`…-plugin-manager` 等），都是各自頁面內部的元件，不是跨插件接口 |
| `actionCards` | 名為「status notices」，但那是**寫進 session log 給模型看**的卡片機制，不是使用者通知；用它會增加 token 與 session 雜訊 → **不採用** |

**因此**：本輪**不開發** toast／通知 UI（需求 §15.2：若沒有受支援接口，不得使用非公開 API 或侵入式 UI Patch）。

### 16.2 最小可行降級（本輪實作）

| 場景 | 現況 | 本輪改動 |
| --- | --- | --- |
| 首次下載中／成功／失敗 | 只有 `logger.info`／`warn`（[lib/binary/manager.js:560](../lib/binary/manager.js#L560)） | 保持 log，但把狀態寫進 `state.json`，讓 `/basemind-status` 能顯示「上次嘗試時間／結果／下一步」 |
| SHA256 失敗／下載失敗／不支援平台 | `reason` 字串 | 同上；`/basemind-status` 顯示可執行建議 |
| 舊快取不完整／損壞 | 新增（§9） | `/basemind-status` 顯示「cache: incomplete (missing lib/libheif.so.1)」 |
| Daemon 版本衝突 | `noteWorkspaceVersion` 的 `warnOnce` | 保持，並在 status 顯示 |
| Relay 持續不可用 | `retry` 退避 + 一行 warn | 保持；`/basemind-status` 顯示最近一次 relay 失敗原因 |

**去重**：沿用 `warnOnce`（進程內、以 key 去重）；跨 session 不重複提示同一 binary 問題（key 已含路徑／版本）。恢復成功後 `verify` 會清掉對應 key（沿用現有語意，需補測試）。

**成本**：零額外網路、零輪詢、零模型 token。

### 16.3 若未來 DSH 提供通知接口

在 `lib/status.js` 旁保留一個 `notify(level, code, message)` 的最小 seam（單一函式、預設只寫 log），未來只要換掉實作即可，不需要改業務邏輯。**本輪不建立**（避免為假設性需求預留抽象，[AGENTS.md](../AGENTS.md) §14.1）。

---

## 17. Agent Inbox 通知可行性（P3，建議不做）

### 17.1 上游做法與其成本

OpenCode 在 **`session.created` 與每一次 `session.tool.success`** 都 spawn 一次 `basemind agent inbox --announce --root <dir> --json --limit 10`（timeout 6 s）。在 DSH 直接照搬會違反需求 §16.2 的全部四條：每次 tool call 額外 spawn、無上限輪詢、可能影響 MCP 延遲。

### 17.2 與 DSH 原生機制的重疊

| DSH 原生 | BaseMind comms |
| --- | --- |
| `agent/inbox/inserted`／`claimed`／`discarded`、`subagents.sendMessage`、`agentTeams` | `agent inbox`／`agent_post`／`agent_threads`，跨 harness 的檔案式 broker |
| 只用於同一 DSH 內的 agent 協作 | 用於不同 harness（Claude Code／Codex／pi）之間共享同一 repo 的訊息 |

**結論**：對「只用 DSH」的使用者，價值接近 0；對「同時跑多個 harness」的使用者才有意義。且 **DSH Host 沒有通知接口**（§16.1），能做的只有「寫 log」或「在 `/basemind-status` 顯示未讀數」。

### 17.3 若未來要做的最小設計（本輪不實作）

| 決策 | 建議 |
| --- | --- |
| 觸發點 | **`agent/turn-stopping`**（每輪最多一次），不用 tool success |
| 節流 | 每 session 至少間隔 60 s；single-flight；`AbortSignal` 2 s 逾時 |
| 身份 | 只用 `invocation.agent` 對應的 workspace 當 `--root`；不猜 agent 名稱 |
| 顯示 | 只能寫進 log／`/basemind-status`；**不做 toast** |
| 預設 | **關閉**（`commsNotify: false`） |
| 風險 | 每次 turn 多一個子進程；與 DSH 原生 team 語意重疊 |

**建議**：本輪**不納入**，只在文件記錄可行性與成本（滿足需求 §16.1「獨立評估，不阻塞 P0–P2」）。

---

## 18. DSH 原生 API 可用性及證據

### 18.1 Host Service（109 個，節錄與本插件相關者）

| Service | 簽名（節錄） | 本插件用途 |
| --- | --- | --- |
| `tools` | `register()`／`resolve()`／`execute()`／`guard()` | MCP 工具註冊（已用） |
| `skills` | `registerProvider((control) => SkillProvider)`／`register(skill)`／`list`／`get` | 官方 skills（已用） |
| `systemPrompt` | `section()`／`context()`／`variable()`／`assemble()` | bootstrap section（已用） |
| `mcpResources` | `register(server, provider)` | MCP resources（已用） |
| `commands` | `register(CommandDefinition)`／`list`／`find`／`execute` | `/basemind-status`（已用）；本輪新增 `/bm-*` |
| `workingDirectory` | `ensure(agent, signal)`／`set`／`get`／`defaultDirectory` | 工作區解析（已用） |
| `subprocess` | `resolveExecutable`／`spawn`／`spawnTerminal` | relay 與 CLI（已用） |
| `compaction` | `compactIfNeeded`／`compactNow`／`compactRegion` | 本輪不主動呼叫 |
| `sessionSkillCatalog` | `list(request, signal)` | 不直接使用（由 skills 內部使用） |
| `mcpManager` | `register(name, entry)`／`probe`／`watch` | 不直接使用（本插件自管 relay，避免與 MCP row 衝突） |
| `actionCards` | `register`／`record`／`view`／`act` | 不採用（§16.1） |

**不存在**：`notifications`、`toast`、`statusline`、`session_compact` 事件。

### 18.2 Host Event（節錄）

| Event | 模式 | 用途 |
| --- | --- | --- |
| `agent/created` | serial | 等價 session start（已用） |
| `agent/turn-stopping` | serial | 每輪收尾（P3 若做 inbox 才用） |
| `system-prompt/assemble` | waterfall | 可觀察／替換 prompt 呈現（本輪不用） |
| `tools/change`、`skills/change`、`commands/change` | emit | 訂閱變更（本輪不用） |
| `compaction/summary-error` | waterfall | 壓縮失敗補救（本輪不用） |

### 18.3 Client（未取得）

- `cordis_inspect_query(platform: client, provider: Service, method: listService)` **10 s timeout**（目前這個 GUI 頁面沒有回應 inspect 請求）。
- 因此「client 側是否有可用 toast 接口」目前**未能用 inspect 確認**；已用 `app.asar` 原始碼掃描作為替代證據（§16.1），結論是「toast 屬於各 client UI 套件內部元件，沒有跨插件接口」。
- 若需要 100% 確認，可在 Desktop 頁面連線時重跑一次 inspect；本計畫不依賴此結論（因為我們不打算做 toast）。

### 18.4 DSH 版本

- 執行期套件版本：`@deepseek-ai/dsh-action-cards` **0.2.2-rc.5**（asar 內 `package.json`）。
- 桌面程式版本檔（`DeepSeek Harness/version`）為 `44.7.0`，那是 Electron 外殼版本，**不是 DSH 版本**，文件不得混用。
- [package.json](../package.json) 宣告 `engines.dsh: ">=0.2.1-rc.3 <0.3.0-0"`，本輪新增的 API（`commands.register` 的 `input`／`signal`）需要確認在 `0.2.1-rc.3` 是否已存在 → **Execution 必須先驗證**（見 §24 R2）。

---

## 19. 文件級修改矩陣

### 19.1 Phase 1（P0）

| 檔案 | 動作 | 說明 |
| --- | --- | --- |
| `fixtures/fake-basemind.sh` | **mode 100755** | §3.5 A1（不刪不改內容） |
| `test/index.test.mjs` | 改 | 刪除 tmp 複製、就地執行、加 preflight 斷言 |
| `lib/binary/archive.js` | 改 | 新增 `extractArchive()`；保留 `extractSingleFile()` |
| `lib/binary/manager.js` | 改 | 整包安裝、layout 2、完整性檢查、遷移 |
| `lib/status.js` | 改 | 顯示布局／檔案數／缺檔 |
| `test/binary-archive.test.mjs` | 改 | 整包解壓／安全案例 |
| `test/binary-manager.test.mjs` | 改 | 布局／遷移／缺檔／原子性 |
| `test/binary-install-layout.test.mjs` | **新增** | 照真實 archive 形狀的端到端安裝（mock 網路、真實解壓） |
| `test/status.test.mjs` | 改 | 新欄位 |
| `README.md`、`README.zh.md` | 改 | §7 安裝布局、磁碟用量、舊快取遷移、平台驗證範圍 |
| `CHANGELOG.md` | 改 | `[Unreleased]` 加 Fixed（Critical） |

### 19.2 Phase 2（P0 測試與 CI）

| 檔案 | 動作 |
| --- | --- |
| `test/integration-managed.test.mjs` | **新增**（A–G 場景＋運行清單） |
| `.github/workflows/managed-binary.yml` | **新增**（冷快取三平台＋重用驗證＋arm64 有條件） |
| `.github/workflows/ci.yml` | 改（失敗 artifact 摘要，§11.4） |
| `.github/workflows/compat.yml` | 改（arm64 有條件、排程） |
| `.github/workflows/release.yml` | 改（managed gate 前置） |
| `docs/2026-11-24-…-execution-report.md` | 新增（Execution 產出） |

### 19.3 Phase 3（P1 驗證）

| 檔案 | 動作 |
| --- | --- |
| `docs/2026-11-24-basemind-desktop-ab-report.md` | **新增**（Desktop 驗收＋A/B 數據） |
| `index.js` | **僅在 §13.3 實測證明缺失時**才改（2 處、各 1–3 行） |
| `test/index.test.mjs` | 對應 targeted test（僅在有改動時） |

### 19.4 Phase 4（P2 Commands）

| 檔案 | 動作 |
| --- | --- |
| `lib/commands.js` | **新增** |
| `index.js` | 改（註冊／清理） |
| `lib/cli-tool.js` | 改（抽出可複用的執行器） |
| `test/commands.test.mjs` | **新增** |
| `README.md`、`README.zh.md` | 改（命令表） |
| `docs/upstream-sync.md` | 改（Commands 對照與「不 vendoring」的理由） |
| `AGENTS.md` | 改（§5 的 `/bm-scan` 例外，需 D1 裁決） |

### 19.5 Phase 5（P3）

| 檔案 | 動作 |
| --- | --- |
| `docs/…-agent-inbox-feasibility.md` | **新增**（評估結論，無程式碼） |

---

## 20. P0–P3 優先級

| 優先級 | 項目 | 阻擋發布 | 依據 |
| --- | --- | --- | --- |
| **P0** | CI 測試夾具修復（§3.5） | 是 | 目前 main 紅燈 |
| **P0** | Managed Binary 完整安裝＋舊快取遷移（§7–§9） | **是（Critical）** | 預設路徑不可用 |
| **P0** | 真實 Managed Binary Integration Test＋Gate（§10） | 是 | 沒有它就無法證明 P0 修好 |
| **P0** | CI 分層與 Release Gate（§11） | 是 | 需求 §8 |
| **P1** | DSH Desktop 驗收 D1–D15（§12） | 是 | 需求 §9 |
| **P1** | Compaction／Bootstrap 9 項驗證（§13） | 否（但需結論） | 需求 §10 |
| **P1** | A/B 效果測試（§14） | 否 | 需求 §11 |
| **P2** | `/bm-doctor`、`/bm-stats`、`/bm-scan`（§15） | 否 | 需求 §13 第一批 |
| **P2** | 狀態／診斷強化（§16.2 降級方案） | 否 | 需求 §15 |
| **P2（暫緩）** | `/bm-init` 預覽、`/bm-statusline` | 否 | 需求 §13 |
| **P3（建議不做）** | Agent Inbox 通知（§17） | 否 | 需求 §16 |

順序硬約束：**P0 未取得「三平台 managed 冷快取通過」證據前，不進入 P2 功能擴展**（需求 §4.15）。

---

## 21. 分階段實施步驟及停點

### Phase 1：P0 Investigation & Stability（預估 1–2 個工作日）

| 步驟 | 內容 | 驗證 |
| --- | --- | --- |
| 1.1 | CI 修復（§3.5）：fixture 100755、刪 tmp 複製、preflight 斷言 | `node --test test/index.test.mjs`；push 後 Ubuntu 綠（附 run URL） |
| 1.2 | `extractArchive()`（§8.2）＋單元測試 | `node --test test/binary-archive.test.mjs` |
| 1.3 | manager 整包安裝＋layout 2＋完整性（§8.3–8.4） | `node --test test/binary-manager.test.mjs test/binary-install-layout.test.mjs` |
| 1.4 | 舊快取遷移（§9） | 同上（layout 1 案例） |
| 1.5 | status 顯示布局（§8.5） | `node --test test/status.test.mjs` |
| 1.6 | 文件（README／README.zh／CHANGELOG） | 人工閱讀 + `npm run check:pack` |
| 1.7 | 全套 | `npm run verify` |

**停點 1**：提交 Execution Report（含 P0 修復證據、`npm run verify` 結果、仍未驗證項），**等待人工確認**才進 Phase 2。

### Phase 2：P0 Integration & Compatibility（預估 2–3 個工作日，主要成本是 CI 迭代）

| 步驟 | 內容 | 驗證 |
| --- | --- | --- |
| 2.1 | `test/integration-managed.test.mjs`（A–G＋運行清單＋PATH 淨化） | 本機 `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1 node --test test/integration-managed.test.mjs`（Windows 實跑） |
| 2.2 | `managed-binary.yml`（冷快取、三平台、重用 step、failure artifact） | 首次 `workflow_dispatch` 三平台綠 |
| 2.3 | `ci.yml` 失敗摘要 artifact（§11.4） | 故意讓一個測試失敗，確認 artifact 可下載（本地驗證 workflow 邏輯） |
| 2.4 | `compat.yml` 加 arm64／排程；`release.yml` 加 managed gate | workflow lint（`actionlint` 不可用時人工複核 YAML） |
| 2.5 | Desktop 驗收 D1–D15（§12） | 專屬 profile，逐項截圖／log |
| 2.6 | 產出 Desktop 報告 | `docs/2026-11-24-basemind-desktop-ab-report.md` |

**停點 2**：明確記錄「每個平台、每個驗收項」的真實結果（含未執行項與原因）。**Linux arm64 若 runner 不可用，必須寫明未驗證**。

### Phase 3：P1 Agent Effectiveness（預估 1–2 個工作日）

| 步驟 | 內容 | 驗證 |
| --- | --- | --- |
| 3.1 | Compaction／Bootstrap 9 項（§13.2） | Desktop 實測；只有 #7／#8 可能需要 §13.3 的最小修復 |
| 3.2 | A/B 試點 4 場景 | 記錄表（§14.4） |
| 3.3 | 全量 11 場景（可選） | 同上 |
| 3.4 | 報告 | 與 Desktop 報告合併 |

**停點 3**：確認「工具使用效果＋任務正確性」有結論（不以 token 比例當唯一標準）。

### Phase 4：P2 Commands & Diagnostics（預估 1–2 個工作日）

| 步驟 | 內容 | 驗證 |
| --- | --- | --- |
| 4.1 | `lib/commands.js`＋註冊＋清理 | `node --test test/commands.test.mjs` |
| 4.2 | `/bm-doctor`、`/bm-stats`、`/bm-scan` | 同上＋Desktop 手動 |
| 4.3 | `/bm-init` 預覽（若 D5 裁決要做） | 只讀斷言（不寫檔） |
| 4.4 | status 強化（§16.2） | `test/status.test.mjs` |
| 4.5 | 文件＋`docs/upstream-sync.md` 對照表 | `npm run verify` |

**停點 4**：確認沒有破壞 MCP／Skills／Binary 行為（`npm run verify` ＋回歸清單 §22.1）。

### Phase 5：P3 Collaboration（可延期）

| 步驟 | 內容 |
| --- | --- |
| 5.1 | 只產出可行性文件（§17），**不寫程式碼** |

**停點 5**：可延後到下一輪；不阻塞 0.3.0。

---

## 22. 測試矩陣及驗收標準

### 22.1 既有功能回歸（不得破壞）

| 類別 | 測試檔 | 驗收 |
| --- | --- | --- |
| MCP initialize／動態工具／schema／StructuredContent／錯誤碼 | `test/mcp-session.test.mjs`、`test/schema.test.mjs`、`test/tool-bridge.test.mjs`、`test/result.test.mjs` | 全綠、無刪減 |
| MCP Resources | `test/index.test.mjs` | 全綠 |
| Binary resolver／版本匹配／Local First／exact-minor-any | `test/binary-manager.test.mjs`、`test/binary-platform.test.mjs`、`test/binary-probe.test.mjs` | 全綠 |
| 官方 SHA256／下載／cache／single-flight／跨進程鎖 | `test/binary-checksums.test.mjs`、`test/binary-download.test.mjs`、`test/binary-concurrency.test.mjs` | 全綠 |
| CLI Adapter | `test/cli-tool.test.mjs` | 全綠 |
| Skills Provider／Bootstrap／Human Command | `test/skills.test.mjs`、`test/bootstrap.test.mjs`、`test/status.test.mjs` | 全綠 |
| Workspace Pool／多 session 路由 | `test/workspace-pool.test.mjs`、`test/index.test.mjs` | 全綠 |
| 插件生命週期 | `test/index.test.mjs` | 全綠（含 unload 後無殘留） |
| 上游版本單一來源 | `test/upstream.test.mjs` | 全綠（不得出現 `0.34.0` 硬編新位置） |

### 22.2 新增測試（僅對應實際改動）

| 類別 | 案例 | 檔案 |
| --- | --- | --- |
| Archive | 多檔 tar.gz（`./` 前綴＋`lib/*.so`＋`licenses/**`＋其他 regular file 夾雜） | `binary-archive.test.mjs` |
| Archive | 多檔 zip（root DLL＋空 `lib/` 目錄＋`licenses/`） | 同上 |
| Archive | 路徑逃逸／絕對路徑／`..`／重複／symlink／hardlink／device／加密／zip64／超大（沿用＋新增多檔情境） | 同上 |
| Archive | 取消（abort）後 staging 清空 | 同上 |
| Install | Windows DLL 保留、Linux `lib/` 保留、macOS `dylib` 保留 | `binary-install-layout.test.mjs` |
| Install | 舊單檔快取 → 遷移；缺 `lib/heif` → 偵測＋重裝 | `binary-manager.test.mjs` |
| Install | 原子性：寫入中途失敗 → 舊目錄仍在、staging 清空 | 同上 |
| Install | 並行安裝只下一次；離線重用 0 網路 | `binary-concurrency.test.mjs` |
| Install | `chmod` 0755（POSIX）／不變（Windows） | `binary-install-layout.test.mjs` |
| Lifecycle | session 恢復、relay 退出、readiness 恢復、多 agent 可見性、reload/unload | `index.test.mjs` |
| Commands | 註冊／清理、同名衝突、正確工作區、正確 binary、參數安全（`--root`／`..`／絕對路徑／`-` 前綴）、取消、逾時、錯誤提示 | `commands.test.mjs`（新增） |
| Diagnostics | 布局／缺檔／下載狀態顯示 | `status.test.mjs` |

**不製造**：通知（§16 未實作 toast）、Inbox（§17 未實作）的測試檔。

### 22.3 強制 Gate 與失敗語意

| Gate | 指令 | 失敗語意 |
| --- | --- | --- |
| 單元＋既有回歸 | `npm test` | fail 即阻擋 |
| 語法／manifest | `npm run check` | fail 即阻擋 |
| Skills 來源 | `npm run check:skills` | fail 即阻擋 |
| 打包內容 | `npm run check:pack` | fail 即阻擋 |
| 真實外部 binary 契約 | `BASEMIND_REQUIRE_INTEGRATION=1 node --test test/integration.test.mjs` | 缺 binary／失敗 → fail（不得 skip） |
| **真實 managed 安裝** | `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1 node --test test/integration-managed.test.mjs` | **任何 skip 都算失敗** |

### 22.4 驗收標準（Phase 停點的定義）

1. Phase 1：`npm run verify` 全綠；Ubuntu CI 綠（run URL＋耗時）；§22.2 的 Archive／Install 案例全綠。
2. Phase 2：`managed-binary.yml` 三平台冷快取綠；Desktop D1–D15 有結論（通過／未驗證都要寫）。
3. Phase 3：9 項 bootstrap 驗證有結論；A/B 至少 4 場景有數據。
4. Phase 4：`/bm-*` 三個命令在 Desktop 可用；既有回歸全綠。
5. 全程：README／README.zh／CHANGELOG 與實際行為一致；未執行項如實列出。

---

## 23. 性能及 Token 開銷

### 23.1 現有可量測基線

| 指標 | 值 | 來源 |
| --- | --- | --- |
| `npm test` 全套 | 393 pass，62.1 s | 本機實跑 |
| CI Windows `Run tests` | 8 s | run #14 |
| CI Ubuntu `Run tests` | 48 s（失敗，3×15 s timeout） | run #14 |
| `basemind --version` | < 1 s（含 226 MB binary 啟動） | §7.2 實測 |
| `basemind status` 冷啟動 | **> 20 s**（需下載 22 MB tree-sitter parser bundle） | §6 附帶實測 |
| `basemind status` 熱啟動 | ~1.3 ms query／943 ms startup | 同上 |
| 本 repo 冷索引 | 約 30 s（歷史量測） | AGENTS.md §6 |

### 23.2 改造不得引入的成本（驗收門檻）

| 約束 | 設計對策 |
| --- | --- |
| 不每次 Tool Call 重新探測 binary | 沿用「每 process 只選一次」＋ probe cache |
| 不每次 Tool Call 重新校驗所有檔案 | 快取命中只做 **N 次 stat**（N ≤ 14），不做 hash、不做解壓 |
| 不每次 Tool Call 複製／解壓 | 安裝只在 `select()` 且快取不完整時發生 |
| 不重複載入 skills 正文 | 既有 provider 記憶體快取 |
| 不重複注入 bootstrap | section 每 step 求值但**只回傳字串**，長度固定 ~1.2 KB |
| 不新增網路請求 | 只有「需要安裝」時下載；`/bm-*` 命令不連網（除 BaseMind 自身行為） |
| 不高頻查詢 Inbox | §17 不做 |
| 不重複建立 MCP Relay | 沿用 workspace pool |
| 不無理由增加 System Prompt | 不變（Bootstrap 已在 1.6 KB 預算內） |

### 23.3 需要實測的數字（Execution 產出）

| 指標 | 方法 | 預期 |
| --- | --- | --- |
| 插件冷啟動（無 cache、已有 binary） | `apply()` 到 ready 的時間戳 | 與 0.2.0 相同（±10%） |
| 首次 managed 安裝 | 下載→可執行 | 1–3 min（視頻寬） |
| 快取命中 | `select()` 到 ready | 與 0.2.0 相同 |
| MCP Tool Call 延遲 | 20 次 `code_outline` 平均 | 與 0.2.0 相同（±10%） |
| CLI Tool Call 延遲 | 10 次 `cli status` 平均 | 同上 |
| System prompt 大小 | assemble 後字元數 | 與 0.2.0 相同（±5%） |
| 模型 token | 供應商 usage；若不可得則**不宣稱** | — |

---

## 24. 風險及回滾

| # | 風險 | 機率 | 影響 | 對策／回滾 |
| --- | --- | --- | --- | --- |
| R1 | 整包解壓引入新的安全漏洞（ZIP Slip／連結穿越） | 低 | 高（可寫任意路徑） | 保留全部既有守門＋新增「解析後路徑必須在 destDir 內」＋專門的惡意 fixture 測試；安全測試不得刪減 |
| R2 | `commands.register` 的 `input`／`signal` 在最低支援版本 `0.2.1-rc.3` 不存在 | 中 | 中（命令不可用） | Execution 先用 `ctx.get('commands')` 做**能力探測**（嘗試註冊一個最小定義），失敗則只註冊 `/basemind-status` 並記一行 log；或提高 `engines.dsh`（需評估） |
| R3 | 舊快取遷移在下載失敗時讓使用者從「可用」變「不可用」 | 中 | 中 | 遷移只在下載成功後才替換；失敗時保留舊目錄（即使不完整），`/basemind-status` 明確說明 |
| R4 | Windows 上 rename 因檔案佔用失敗（防毒／正在執行的 relay） | 中 | 中 | 有限次退避重試＋可診斷錯誤；不覆蓋舊目錄 |
| R5 | mac / Linux 的 managed 安裝仍失敗（靜態分析推論有誤） | 低 | 高 | Phase 2 的 managed CI 會在真實 runner 上第一次證明；若失敗，退回「官方解壓方式」並記錄差異 |
| R6 | 新增 CI 成本過高（每週 3 平台 × 100 MB） | 中 | 低 | 只在排程與 release 跑，push 不跑；job timeout 20 min；可改為僅 release |
| R7 | `/bm-scan` 與 AGENTS.md §5 衝突 | 確定 | 低 | 需 D1 裁決；未裁決前不實作該命令 |
| R8 | Desktop 驗收無法完成（環境／授權） | 中 | 中 | 如實標記未驗證；不阻擋 P0 修復，但 Release note 必須寫明 |
| R9 | 本輪改動意外影響 legacy MCP-only 模式（`binaryPolicy:'any'`） | 低 | 中 | 保留既有測試；新增「layout 無關、any 模式不註冊 skills/CLI」斷言 |

**回滾方案**：

- 產品碼：`git revert` 對應 commit（不 rewrite history）；managed 安裝修復與 CI 分層是獨立 commit，可分開回滾。
- 快取：使用者可刪 `$DSH_HOME/cache/dsh-basemind-plugin/`（文件已寫明安全）；插件不自動刪。
- 配置：`binaryDownload:false` 立即回到「只用本地 binary」的舊行為。

---

## 25. 非目標及延期

### 25.1 本輪明確不做（需求 §21）

- 不重寫 MCP Bridge／Binary Manager／Workspace Pool／Skills Provider。
- 不新增大型插件 UI、不做完整 statusline。
- 不強制 PreToolUse Guard、不攔截 DSH 原生 read／grep／bash／git。
- 不自動啟動 BaseMind Lead Agent、不取代 DSH 智能團隊。
- 不做 MCP Tasks 完整協議擴展。
- 不做與本需求無關的性能重構。

### 25.2 已知但本輪不修（記錄，不擴散）

| # | 問題 | 建議 |
| --- | --- | --- |
| N1 | `apply()` 沒有 `cacheRoot` seam（測試需自行設 `DSH_HOME`） | 下次重構入口時處理 |
| N2 | Plan 舊文件 §11.4.1 與實作對 `-32003` 的描述不一致（M8） | 下次同步舊 plan 時補註「撤回」 |
| N3 | npx legacy 路徑仍存在（`autoProvision`） | 保持 legacy 語意，不擴大 |
| N4 | `probe` spawn 未 `scrubEnv`（既有行為） | 保持 |
| N5 | BaseMind 需要系統 VC++ runtime（`MSVCP140.dll` 等，archive 未附） | 文件寫明為上游前提；`/basemind-status` 在 Windows loader 失敗時給出提示 |
| N6 | tree-sitter parser bundle 首次需下載 ~22 MB | 文件寫明「首次啟動需要網路」；不預先快取 |

### 25.3 延期（不是不做，是不阻塞 0.3.0）

- `/bm-init` 的完整引導（含寫檔）：等 DSH 有互動確認機制，或使用者明確要求。
- `/bm-statusline`：等 DSH 有 statusline 擴充面。
- Agent Inbox 通知：見 §17。

### 25.4 交付前清理

- 刪除 `_scratch/`（本輪調查暫存：GitHub API 回應、archive entry 清單、上游來源副本、輔助腳本）。**不得**把它留在工作區（`git status` 要保持乾淨）。
- 不得把 `_scratch/` 內任何內容放進 npm 套件或 docs。

---

## 26. 版本發布建議

| 項目 | 建議 |
| --- | --- |
| 版本 | **0.3.0**（行為變更：managed 安裝布局、cache 遷移、CI／測試契約、新增命令） |
| 時機 | Phase 1＋2 完成且取得三平台 managed 冷快取證據之後；Phase 3 的 A/B 可與 0.3.0 同時或之後 |
| Changelog 重點 | Fixed（Critical：managed binary 四平台不可啟動）、Changed（cache layout 2＋舊快取重裝、磁碟用量）、Added（`/bm-doctor`、`/bm-stats`、`/bm-scan`、managed integration gate）、Docs（平台驗證範圍） |
| 發布動作 | **本輪不做**：不改 `package.json.version`、不建 tag、不 `npm publish`、不觸發 release workflow（[AGENTS.md](../AGENTS.md) §7） |
| 發布前檢查 | `npm run verify`、`BASEMIND_REQUIRE_INTEGRATION=1`、`BASEMIND_REQUIRE_MANAGED_INTEGRATION=1`（三平台 CI）、Desktop 驗收報告 |

---

## 附錄 A：證據索引（可重跑）

| 證據 | 取得方式 |
| --- | --- |
| CI run #14 job／step 耗時 | `GET https://api.github.com/repos/zengjunlin2022/dsh-basemind-plugin/actions/runs/45351249215/jobs`（匿名可讀） |
| Job log（需授權，本次 403） | `GET …/actions/jobs/138297953728/logs` |
| Check-run annotations | `GET …/commits/f87b583…/check-runs`、`…/check-runs/{id}/annotations` |
| 官方 asset 清單／大小 | `GET https://api.github.com/repos/Goldziher/basemind/releases/tags/v0.34.0` |
| Checksums | `https://github.com/Goldziher/basemind/releases/download/v0.34.0/basemind_0.34.0_checksums.txt` |
| Archive 結構 | 下載 4 個 asset → Node 解析 zip central directory／tar 512-byte block → `_scratch/release/*.json` |
| Windows DLL 實測 | 複製 exe 到暫存目錄、`PATH=C:\Windows\system32;C:\Windows`、觀察 `0xC0000135` |
| PE import | 解析 `.exe` import table（`heif.dll` 為 static、`delayImports=[]`） |
| ELF／Mach-O 依賴 | 解析 `DT_NEEDED`／`RUNPATH`、`LC_LOAD_DYLIB`／`LC_RPATH` |
| Pi／OpenCode 事實 | `raw.githubusercontent.com/Goldziher/basemind/v0.34.0/…` |
| DSH 契約 | `cordis_inspect_list`／`cordis_inspect_query`（host Service／Event）；`app.asar` 內 `dsh/docs/subsystems/commands.md`、`skills.md` |

## 附錄 B：待人工裁決的決策

| # | 問題 | 建議 | 影響 |
| --- | --- | --- | --- |
| D1 | `/bm-scan`（會寫索引）與 AGENTS.md §5「禁止 scan／rescan」衝突 | 允許「使用者親手輸入的命令」執行，並在 AGENTS.md §5 補一句例外 | 不做則 `/bm-scan` 無法實作 |
| D2 | CI fixture 修復走 A（commit 100755）或 B（複製 3 檔） | A | 影響測試程式碼風格 |
| D3 | 整包解壓上限提高到 2 GiB／單檔 1 GiB | 同意（預設值不動） | 影響未來大版本兼容 |
| D4 | 舊快取一律重下載（一次 75–102 MB） | 同意（正確性優先） | 影響升級體驗 |
| D5 | `/bm-init` 只做 `--print` 預覽、`/bm-statusline` 暫緩 | 同意 | 影響 P2 範圍 |
| D6 | DSH 沒有 toast 接口，通知只做 log＋status 降級 | 同意 | 影響 §15 交付形式 |
| D7 | Agent Inbox 通知建議本輪不做（P3 只出文件） | 同意 | 影響 P3 |

---

**本文件完成即停止。未經人工確認不進入 Execution，不修改產品程式碼，不執行 git add／commit／push／tag／npm publish。**


