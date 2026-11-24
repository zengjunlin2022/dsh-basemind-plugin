# dsh-basemind-plugin 0.2.0：Pi / Skills / Binary Manager 整合 Execution Report

- 日期：2026-11-24
- 對應 Plan：[2026-11-24-basemind-pi-integration-binary-management-plan.md](./2026-11-24-basemind-pi-integration-binary-management-plan.md)
- 執行方式：單一 session 內聯執行（executing-plans），Binary I/O、Skills 同步、Status/CLI/Skills provider 三個獨立工作流由並行 subagent 實作，入口整合、設定、封裝、文件與 CI 由 lead 完成。
- 基線：`main` @ `f278d6c`（工作樹僅多出本 Plan 文件）；基線 `npm test` 166 pass / 0 fail。
- **未執行 git commit／add／tag／push／publish**（AGENTS.md §7、Plan §24.4）。所有變更留在工作樹，等待人工審查與手動 commit。

## 1. 完成狀態

**已實施並通過本機 Gate。** 未經獨立 Review；本文件不宣稱 Review 通過。

## 2. 新增檔案

| 檔案 | 內容 |
| --- | --- |
| `lib/upstream.js` | 唯一上游版本來源：0.34.0 / tag / commit / 4 個 asset / checksums 檔名 / 10 個 skills 名稱 |
| `lib/binary/platform.js` | Node platform/arch → asset target（含 `win32`→`windows-x64` 正規化、不支援平台的可行動訊息） |
| `lib/binary/probe.js` | `--version` 探測、版本解析、相容判定、mtime/size 快取（含負向結果） |
| `lib/binary/checksums.js` | sha256sum 格式解析與 asset 查表 |
| `lib/binary/download.js` | HTTPS + host allowlist + 手動 redirect、串流寫入同時算 sha256、大小上限、有限重試、可取消 |
| `lib/binary/archive.js` | 純 Node tar.gz / zip 解壓，只抽根層單一 binary，拒絕 traversal／symlink／hardlink／超限 |
| `lib/binary/manager.js` | Local First 選型、single-flight、跨 process 目錄鎖與 stale 回收、原子安裝、快取驗證、冷卻、狀態、workspace 版本切換提示 |
| `lib/cli-tool.js` | `mcp__basemind__cli`：argv-only、唯讀 allowlist、denylist 優先、無 shell、輸出上限 |
| `lib/status.js` | `/basemind-status` 的狀態快照與穩定渲染（無時間戳／ANSI／敏感值） |
| `lib/skills/provider.js` | 官方 skills provider（rank 1000、READY gate、invalidate、frontmatter 解析） |
| `lib/prompt/bootstrap.js` | 與 MCP instructions 不重複的 bootstrap 文字與 section 註冊；`any` 模式給短句 |
| `scripts/sync-basemind-skills.mjs` | 上游 skills 同步／`--check`／宣告式適配規則，規則失配即失敗 |
| `skills/**` | 10 個官方 skill（20 檔）、MIT 原文、`UPSTREAM.json` provenance、`.dsh-adapt.json` |
| `docs/upstream-sync.md` | 下一個 BaseMind 版本的同步 checklist |
| `fixtures/fake-basemind.{cmd,sh}`、`fake-basemind-cli.mjs`、`fake-managed-select.mjs` | 測試用假 binary 與跨 process fixture |
| `test/*.test.mjs`（12 個新檔） | binary 7 檔、skills、bootstrap、cli-tool、status、upstream |
| `.gitattributes` | 讓 `skills/**` 不經 git 換行轉換（Windows CI 的 sha256 gate） |

## 3. 修改檔案

- `index.js`：Binary Manager、readiness、CLI tool 進 generation、skills provider、bootstrap section、`/basemind-status`、shutdown 順序、`failOnStartupError` 改走選型。
- `lib/config.js`：新增 `binaryDownload`（true）、`binaryPolicy`（exact）、`binaryFallback`（true）、`skills`、`bootstrap`、`cliTool`（皆 true）。
- `lib/executable.js`：`resolveLaunch` 接受 manager 的 `selection`（含 npx `extraArgs`），保留既有 `command`／`BASEMIND_BIN`／autoProvision 語意。
- `package.json`：`files` 加 `skills/**`；scripts 加 `sync:skills`／`check:skills`；版本維持 0.2.0。
- `cordis.patch.yml`：顯式 `binaryDownload: true`。
- `scripts/check-manifest.mjs`：斷言 patch 內顯式 `binaryDownload: true`。
- `scripts/check-pack.mjs`：要求 10 個 skills 與 provenance，禁止 fixtures／binary／test／docs／scripts。
- `scripts/check-syntax.mjs`：改為遞迴檢查 `lib/**/*.js`（原本只檢查 `lib/*.js`）。
- `.github/workflows/{ci,compat,release}.yml`：CI 加 `check:skills`；compat/release 的 BaseMind 版本改讀 `lib/upstream.js`。
- `AGENTS.md`：新增 §8（單一版本來源、skills 不可手改、Binary Manager 測試紀律），並把啟動副作用改成「使用者資料／專案狀態禁止 vs 插件自管快取允許」兩分類。
- `README.md`／`README.zh.md`：新增 §6–§14（Local First 選型、預設下載、版本政策、快取／離線／自訂 binary、`/basemind-status`、官方 Skills、MCP＋CLI、bootstrap、上游同步）。未把 `/basemind-status` 稱為配置頁。
- `CHANGELOG.md`：新內容併入既有 `[0.2.0]`；`Changed` 第一條是「預設會下載 managed binary」。
- `locale/{en,zh}.json`：描述補上 official skills／managed binary／CLI。
- `test/{config,executable,index}.test.mjs`：新設定斷言、selection 契約、READY／UNAVAILABLE／any 模式／CLI 端到端案例；既有案例未刪除、未放寬（index 測試改為使用 `binaryPolicy: any` + `binaryDownload: false` 保持離線）。

## 4. 實際驗證（全部在本機 Windows、Node v24.20.0）

| 命令 | 結果 |
| --- | --- |
| `node --test test/config.test.mjs test/executable.test.mjs` | 50 pass |
| `node --test test/binary-{platform,probe,checksums,download,archive}.test.mjs` | 109 pass（subagent 執行；platform 9/9 於 win32 修正後重跑） |
| `node --test test/binary-manager.test.mjs test/binary-concurrency.test.mjs` | 35 pass |
| `node --test test/{status,cli-tool,skills,bootstrap}.test.mjs` | 51 pass |
| `node --test test/index.test.mjs` | 21 pass（含 READY 註冊 CLI／bootstrap／10 skills／`/basemind-status`、UNAVAILABLE 仍可用 status、skills/cliTool 關閉、CLI 與 relay 同一 binary、any 模式降級） |
| `node --test test/upstream.test.mjs` | 13 pass |
| `npm run check` | syntax ok: 20 files；bundle manifest ok |
| `npm run check:skills` | 10 skills / 20 files match `UPSTREAM.json`（v0.34.0） |
| `npm run check:pack` | pack contents ok: 52 files（skills 在、無 binary／test／docs） |
| `npm run verify`（check + check:pack + npm test） | exit 0；**393 tests, 393 pass, 0 fail, 0 skipped**（含真實 BaseMind integration；Review 修復後重跑） |
| `BASEMIND_REQUIRE_INTEGRATION=1 node --test test/integration.test.mjs` | 8 pass（真實 BaseMind 0.34.0，隔離 data home） |

真實 integration 覆蓋：MCP handshake／動態 discovery、per-root 路由、resources、真實工具呼叫與文字投影、relay 終止、錯誤契約（`invalid_argument`、`-32602`）。

## 5. 與 Plan 的偏差／Rulings

1. **無 git commit**：依 AGENTS.md §7 與 Plan §24.4，Agent 不 commit；以此報告與 ledger（`.superpowers/sdd/…/progress.md`，git-ignored）代替 commit 範圍。
2. **Plan 用 Phase 而非 Task 標題**：executing-plans 的 `task-brief`／`task-done` 腳本只解析 `Task N`，不適用；改以 §16 的 Phase 作為任務清單。
3. **`binaryPolicy: any` 接受「跑得動但沒有版本字串」的 binary**；同模式下 CLI、官方 skills、版本型 bootstrap 一律關閉（改為短句）。
4. **skills provider 的 `root` 語意是 package root**（provider 自行接 `skills`）；index.js 傳入 `PACKAGE_ROOT`。
5. **`win32` → `windows-x64`**：platform 模組在整合時發現 Node 平台名與 asset key 不一致，已修正並有測試。
6. **`/basemind-status` 的 `found`／`path`**：manager 的失敗 selection 會保留最後探測到的 binary，status 因此能顯示「找到 0.33.0」。
7. **下載不重試 timeout**（僅 429／5xx／網路錯誤重試 2 次），避免啟動被 15 分鐘 timeout 重試放大；Plan §10.7 把下載逾時視為單次警告。
8. **archive 對任何 entry 的 traversal／絕對路徑直接拒絕**（不只是忽略），並在解壓失敗時刪除半成品。
9. **R1 的 `scan` 措辭**：`basemind-scan` skill 保留「CLI 與 MCP 共用同一 binary」，但把寫入動詞導向 `index_rescan`／使用者終端，因 §14.4 denylist 禁止 CLI adapter 執行 `scan`。
10. **Plan §11.4.1（`-32003` 追加說明）判定為撤回，不實作**：Plan §15.5 明確把 `lib/tool-bridge.js` 列為不改，兩條互相矛盾。既有錯誤訊息已附 `[jsonrpc=-32003]`，診斷能力不變；若要加固定句，需另案授權修改 `lib/tool-bridge.js`。

## 6. 未執行／未驗證

| 項目 | 狀態 | 原因 |
| --- | --- | --- |
| Plan §17.10 Agent A/B 效果對照（22 次任務） | 未執行 | 需兩個 checkout、同 preset／模型與人工評分 |
| Plan §19 DSH Desktop 驗收 D1–D11 | 未執行 | 需另開測試 profile 的人工授權；本 session 未改動 Desktop profile |
| macOS arm64 / Linux x64 的 managed 下載與解壓 | 未實跑 | 本機為 Windows；CI（`compat.yml`）會在 push 後覆蓋 |
| BaseMind 0.33 legacy integration | 未實跑 | 本機只有 0.34.0 asset |
| Windows arm64 / Intel macOS「不支援」實機呈現 | 未實跑 | 無機器；僅單元測試 |
| 獨立 Code Review | 未執行 | 依 AGENTS.md，最終 Review 由使用者另行交接 |

## 7. 已知殘留風險

- 跨 process 鎖測試依賴真實 timer（400 ms downloader + 200 ms 重試），是唯一時序敏感測試。
- 純 Node zip 解壓不驗 CRC；損壞但可 inflate 的 payload 依賴安裝後的 `--version` 驗證攔下。
- `skills/basemind-scan/index.md` 的 concept 摘要仍是舊的「run `basemind scan` via the CLI」措辭；provider 只載入 `SKILL.md`，不影響模型 context，但 vendored 檔案內仍看得到。
- 首次無本地相容 binary 時會在插件自管快取寫入 75–102 MB；`binaryDownload: false` 可完全關閉。

## 8. Review 修復（第二輪）

Review 文件：[2026-11-24-basemind-pi-integration-binary-management-review.md](./2026-11-24-basemind-pi-integration-binary-management-review.md)。2 Critical + 6 Important 全部修復；另修了 5 個 Minor（M1、M2、M3、M4、M5、M7）並修正 M9 的數字。

| Finding | 修復 | 證據 |
| --- | --- | --- |
| C1 skills definition 缺 source/provider/invocation | `get()` 回傳完整 definition（spread candidate + `definitionEntry`）；新增 registry 契約測試 | `test/skills.test.mjs` 先 RED（source undefined）→ GREEN；11/11 |
| C2 tar `./` 前綴與 `writing` 未收尾 | 比對前正規化 `./`；目標資料結束即 `writing=false`；新增 4 個 package-release 形狀的真實解壓測試 | `test/binary-archive.test.mjs` 40/40（修復前 36/40） |
| I1 npx 被當成 verified、CLI 漏 `-y <spec>` | selection 新增 `verified`；CLI/skills/bootstrap 一律讀它；CLI argv 疊 `extraArgs` | manager 28/28（新增 verified 斷言）、cli-tool 14/14（新增 npx argv 測試）、index 21/21 |
| I2 單元測試寫入使用者 `$DSH_HOME` | `test/index.test.mjs` 以 `mkdtemp` 擁有 `DSH_HOME` 並在 `after` 清除；已刪除被污染的 `~/.dsh/cache/dsh-basemind-plugin/state.json`（內容只有本 repo/fixtures 的測試紀錄，無 managed binary） | index 21/21；`state.json` 不再出現 |
| I3 Windows CRLF 破壞 skills hash | 新增 `.gitattributes`：`skills/** -text` | `git check-attr text skills/basemind/SKILL.md` → `unset`；`git ls-files --eol skills` → `attr/-text` |
| I4 compat gate 硬編 0.34.0 | Resolve step 匯出 `BM_PIN`；gate 改 `env.BM_VERSION == env.BM_PIN` | workflow diff；PyYAML parse ok |
| I5 vendored 文字教 DSH 沒有的行為 | 新增 R7 ×1、R8 ×3（description、run block、CLI 句）並重跑 sync | `--check` exit 0；skills+upstream 24/24 |
| I6 README 相容性表過時 | 兩語言改寫 §3 BaseMind 列與 §5.1 caveat（pin exact、下載、逃生門、平台未宣稱） | grep 舊句為 0；新句各 1 |
| M1 status 說會 backoff 重試 | 改為「restart DSH，下次啟動在冷卻期後重試」 | status 18/18 |
| M2 README 選型矛盾 | 改為「每 process 固定、切目錄不重選；只寫插件自管快取」 | 兩語言各 1 處 |
| M3 npm scripts 硬編 tag | 移除 `--tag`，改用腳本預設 `UPSTREAM.tag` | `npm run check:skills` ok |
| M4 pack/manifest 檢查太寬 | `skills/**` 只允許已知檔名；`basemind(.exe)` 一律禁止；manifest 需非註解行 | `npm run check`／`check:pack` ok（52 files） |
| M5 manager 狀態卡在 running／abort 記冷卻 | 鎖內早退設回 idle；移除重複 attempts；AbortError 不寫冷卻 | manager+concurrency 35/35 |
| M7 bootstrap 在 skills:false 仍提 basemind skill | `bootstrapText` 接受 `skills` 旗標；index 傳入設定 | bootstrap+index 31/31 |
| M9 報告說 13 個新 test 檔 | 已改為 12 | 本文件 §2 |

未修（明示 defer，不阻塞）：M6（`/basemind-status` 首次探測可能觸發 managed 下載；仍受 5 s 回應上限，下載在背景完成）、M8（改為撤回，見 §5 #10）。

## 9. 交付後停點

- 等待使用者人工審查 `git diff` 與 `skills/**`、`.dsh-adapt.json`、`UPSTREAM.json`。
- 建議 commit 訊息沿用 Plan §24.3，由使用者手動 commit／tag／publish。
