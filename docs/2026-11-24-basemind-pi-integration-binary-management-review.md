# dsh-basemind-plugin 0.2.0：Pi / Skills / Binary Manager 整合 Code Review

- 日期：2026-11-24
- 角色：Review（依 [AGENTS.md](../AGENTS.md) §10、`requesting-code-review` skill）
- 受審對象：[Plan](./2026-11-24-basemind-pi-integration-binary-management-plan.md)、[Execution Report](./2026-11-24-basemind-pi-integration-binary-management-report.md)、**staged diff**
- 審查範圍：`git diff --cached`（Base `f278d6c`，Head 同為 `f278d6c`；**75 檔已 staged，無 unstaged、無 untracked**，14,232 insertions / 39 deletions）
- 方法：Plan → modified files/diff stat → Actual diff → Report → validation summary；兩個 Critical 由 Review 直接對 primary source 重驗（DSH 編譯後原始碼、上游打包腳本），其餘 finding 由獨立 reviewer subagent 產出並抽查
- 判定：**No — 不可合併**（2 Critical + 6 Important）
- 本次 Review **未修改任何檔案**（除本文件），未 stage／commit

---

## 1. 優點（先說做對的）

| 項目 | 證據 |
|---|---|
| 單一上游版本來源真的落實，且有測試釘住 | [lib/upstream.js:11-43](../lib/upstream.js)、[test/upstream.test.mjs:77](../test/upstream.test.mjs)、[test/binary-platform.test.mjs:13](../test/binary-platform.test.mjs)；`cordis.patch.yml:8` 有 `check-manifest` 斷言 |
| 下載器是本批最紮實的一塊：非 https／userinfo／非 allowlist host（含逐跳 redirect 重驗）都擋、串流 hash、Content-Length 上限、錯誤路徑清半成品、重試只限 429/5xx/network | [lib/binary/download.js:110-141](../lib/binary/download.js)、[:192-347](../lib/binary/download.js)、[test/binary-download.test.mjs:360-476](../test/binary-download.test.mjs) |
| 併發設計有真材實料：`mkdir` 原子鎖、owner.json stale 回收、atomic rename、single-flight、冷卻；測試用**真子進程**驗「只安裝一次」「stale 接手」「live lock 不搶」 | [lib/binary/manager.js:465-571](../lib/binary/manager.js)、[test/binary-concurrency.test.mjs:301-396](../test/binary-concurrency.test.mjs) |
| CLI adapter 的 argv-only 與 denylist 優先做對：先掃 denylist（任意位置、跳過 `-` 開頭）再判 allowlist；`--root`/`--root=` 直接拒絕；無 shell 字串拼接 | [lib/cli-tool.js:173-240](../lib/cli-tool.js) |
| Bootstrap 與 MCP instructions **零重疊**（逐行比對 fixture）、1,218 bytes（預算 1,600）、無時間戳/絕對路徑、`interpolate:false`、section 名與既有 `mcp:basemind` 不同 | [lib/prompt/bootstrap.js:72-121](../lib/prompt/bootstrap.js)、[test/bootstrap.test.mjs:64-77](../test/bootstrap.test.mjs)、`fixtures/basemind-0.34.0-instructions.txt` |
| Skills 供應鏈可追溯：`${CLAUDE_PLUGIN_ROOT}` 在 `skills/**` 出現 0 次；`license`/`metadata.author`/`metadata.repository` 逐檔保留；`Content-Hash` 原樣；`--check` 無網路可跑 | [scripts/sync-basemind-skills.mjs:220-235](../scripts/sync-basemind-skills.mjs)、[skills/UPSTREAM.json](../skills/UPSTREAM.json) |
| `--tag` 硬編碼有 guard（不是靜默漂移） | [scripts/sync-basemind-skills.mjs:614-615](../scripts/sync-basemind-skills.mjs) 會因 tag 與 `UPSTREAM.tag` 不符而失敗 |
| 狀態輸出無秘密、無 ANSI、寬度受限 | [lib/status.js:55-63](../lib/status.js) |
| 既有 index/config/executable 測試是**擴充**而非刪改 | `git diff --cached -- test/` 檢查：無刪除、無放寬 |

---

## 2. Critical（必修）

### C1 / [lib/skills/provider.js:222-237](../lib/skills/provider.js#L222-L237)

- **觸發條件與證據**：`get()` 回傳**新物件** `{ name, description, content, path }`，缺 `source`、`provider`、`invocation`。實機 DSH 0.2.2-rc.5 的 `@deepseek-ai/dsh-skill` 在 `get()` 後立刻驗證：`lib/index.js:256` `provider.get(...)` → `:258` `validateDefinition(definition)`，其中 `:486` `if (typeof source !== "string") throw new TypeError('loaded skill "…" source must be a string')`、`:487` 同 `provider`、`:484` 驗 `invocation`。`dsh-tool-skill` 之後還會讀 `skill.invocation.modelInvocable`。
- **預期與實際**：預期 `skill({name:"basemind-…"})` 回 `<skill_content>`；實際每次載入都拋 `TypeError: loaded skill "basemind" source must be a string`。`/basemind-stats` 這類 user-invocable 注入路徑同樣失敗。
- **影響**：本次**第一賣點**（官方 Skills）在 catalog 看得到、正文永遠載不進來；`test/skills.test.mjs:89-108` 只斷言實作自訂欄位，屬對 fixture 自證，抓不到真實 registry 契約。
- **最小修復建議**：`return { ...candidate, content: entry.content, path: entry.path }`（候選若是字串先轉 `{ name }`），確保 `invocation`／`source`／`provider` 都在；補一條以 registry 要求形狀（至少 source/provider/invocation 三欄）為斷言的測試。

### C2 / [lib/binary/archive.js:339](../lib/binary/archive.js#L339)、[lib/binary/archive.js:318-322](../lib/binary/archive.js#L318-L322)

- **觸發條件與證據**：上游以 `tar czf "basemind-${TRIPLE}.tar.gz" -C "$STAGING_DIR" .` 打包（`scripts/package-release.sh:113`、`:181`），member 名稱全部帶 `./`（`./basemind`、`./LICENSE`、`./lib/*.so`）。`parseTarHeader` 原樣保留名稱，`archive.js:339` 用 `header.name === entry` 比對 `'basemind'` → **永遠不命中**，回 `missing-entry`。zip 路徑因為 `:511` 有 `replace(/^\.\//,'')` 才沒事。**第二個缺陷**：`writing` 在目標 entry 資料結束後從未重設為 `false`（只有 `remaining -= take; continue;`），因此目標之後任何 regular file 的 payload 都會被 append 進 destFile。
- **預期與實際**：預期 Linux/macOS 預設下載能解出乾淨的 `basemind`；實際 tar.gz 三個 target 100% 安裝失敗；即使修好名稱，`--version` 也會因為 binary 被後續 member 污染而失敗。
- **影響**：**預設開啟的 managed download 在 linux-x64／linux-arm64／darwin-arm64 全壞**；Windows zip 恰好避開，所以本機 `npm test`／integration 全綠，問題只會在 Linux/macOS 使用者或 CI 上爆發。
- **最小修復建議**：tar 比對前正規化（`name.replace(/^\.\//,'')`）；目標 entry 的 `remaining` 歸零時 `writing = false`；新增一個**照 `package-release.sh` 形狀**的 fixture（`./` 前綴、目標前後都有其他 regular file），並在 manager 測試裡用真實 `extractSingleFile`（不注入 extractor）跑一次，斷言 destFile 內容恰等於目標 bytes。

---

## 3. Important（合併前應修）

### I1 / [lib/binary/manager.js:615](../lib/binary/manager.js#L615)、[lib/cli-tool.js:455](../lib/cli-tool.js#L455)、[index.js:626](../index.js#L626)

- **觸發／證據**：npx legacy 被選中時 `selectNpx` 回 `{ source:'npx', version: undefined, compatible: true, extraArgs:['-y', spec] }`。relay 會用 `extraArgs` 正確組出 `npx -y basemind@latest serve`，但 CLI 只組 `buildLaunchArgv({ exe: npx, args:[...argv,'--root','.'] })`，**漏了 `-y <spec>`** → 實際是 `npx status --root .`。bootstrap 的 `verified = binaryPolicy !== 'any' && compatible === true` 對 npx 為 true，於是宣告版本/來源、開放 CLI 工具名與 skills。
- **預期與實際**：npx 屬**未校驗 legacy** 路徑，CLI／skills／版本型 bootstrap 應一致關閉；實際 relay 正確、CLI 錯誤、prompt 假稱版本。
- **影響**：舊 profile（`autoProvision:true`）會讓 agent 用 `npx` 抓同名 npm 套件執行，且破壞「CLI 與 MCP 同一 binary」的原始目的。
- **修法**：把「是否已驗證」變成 selection 的結構化欄位（`verified` 或直接以 `source`／`version` 判定），`cliDefinition`、skills 註冊、bootstrap 都讀它；最短修法是 `source==='npx'` 時不註冊 CLI/skills 且 `verified:false`，並讓 CLI 疊 `extraArgs`。

### I2 / [index.js:119](../index.js#L119)、[lib/binary/manager.js:217](../lib/binary/manager.js#L217)

- **觸發／證據**：`apply()` 建立 manager 時未注入 `cacheRoot`，manager 走 `resolveDshHome()` → **使用者真實 `$DSH_HOME`**。實測：`~/.dsh/cache/dsh-basemind-plugin/state.json` 於 2026-11-24 15:06／15:17 被寫出，內容是本 repo root 與 `fixtures` 兩個 `lastVersion`。這違反本次自己寫進 AGENTS.md §8.3 的「單元測試不得寫出 tmpdir」。
- **預期與實際**：預期單元測試 0 次寫入使用者 DSH home；實際會寫 `state.json`（失敗時還有 `lastFailureAt` 冷卻），若使用者剛好有有效 `managed-binaries`，`readManagedCache` 可能選中它並 spawn 真正的 `basemind serve`。
- **影響**：污染使用者 home、測試結果依環境而異且不可並行。
- **修法**：`apply()` 增設可注入 seam（`config.cacheRoot` 或測試用 env），test harness 一律給 `mkdtemp`；最低限度在 `test/index.test.mjs` 把 `DSH_HOME` 指向 temp 並於 teardown 清除。

### I3 / [scripts/sync-basemind-skills.mjs:686](../scripts/sync-basemind-skills.mjs#L686)、[test/upstream.test.mjs:132-138](../test/upstream.test.mjs)、[.github/workflows/ci.yml:43-44](../.github/workflows/ci.yml)

- **觸發／證據**：`check:skills` 與 upstream 測試對**工作目錄原文**算 sha256；repo **沒有 `.gitattributes`**（已確認不存在），vendored 檔目前 `git ls-files --eol` = `i/lf w/lf`。reviewer 把 `skills/` 轉 CRLF 後跑 `checkSkills()` → 30 筆 drift（`sha256 differs`、`missing YAML frontmatter block`）。GitHub Actions `windows-latest` 預設 `core.autocrlf=true` 且 `actions/checkout` 不覆寫。
- **預期與實際**：預期 Windows CI leg 能跑新 gate；實際第一次 push 就會紅。
- **影響**：Plan §17.9 Gate 6 與 Windows CI 直接失敗；任何 `autocrlf=true` 的貢獻者都會誤報 drift。
- **修法**：加 `.gitattributes`（`* text=auto eol=lf`，或至少 `skills/** -text`），或 hash 前 normalize `\r\n`→`\n`；同步腳本寫檔固定 LF。

### I4 / [.github/workflows/compat.yml:105-106](../.github/workflows/compat.yml#L105-L106)

- **觸發／證據**：`if: env.BM_VERSION == '0.34.0'` 仍硬編版本字面值（已確認）。報告 §3 宣稱「compat/release 版本改讀 `lib/upstream.js`」只涵蓋安裝步驟。升到 0.35.0 後，**最重要的 verb-tool contract suite 會靜默跳過**。
- **預期與實際**：預期 gate 條件跟 pin 走；實際需人工記得改 workflow。
- **影響**：下次升版悄悄失去契約覆蓋，release gate 變弱。
- **修法**：Resolve step 另外輸出 `BM_PIN`，條件改成 `env.BM_VERSION == env.BM_PIN`。

### I5 / [skills/basemind-multi-agent-room/SKILL.md:37](../skills/basemind-multi-agent-room/SKILL.md#L37)、[skills/basemind-scan/SKILL.md:2](../skills/basemind-scan/SKILL.md#L2)、[skills/basemind-scan/SKILL.md:45-50](../skills/basemind-scan/SKILL.md#L45-L50)

- **觸發／證據**：`multi-agent-room` 仍寫「In Claude Code the PreToolUse hook injects `<agent_type>-<8 hex>` when a call has no `as`」——DSH 沒有這個 hook（Plan R4 只改 `basemind-comms`，報告 §7 已自認殘留；已確認 `PreToolUse` 在 comms 為 0 次、multi-agent-room 為 1 次）。`basemind-scan` 的 frontmatter description 仍說「Build or refresh the index by running `basemind scan` via the CLI」，內文 code block 也列 `basemind scan`／`basemind rescan`，但 CLI adapter 明文拒絕這兩個動詞、bootstrap 又叫 agent 不要用 PATH 上的裸 `basemind`。
- **預期與實際**：預期 vendored 文字在 DSH 內不教 agent 做 plugin 明確禁止或不存在的事；實際會引導少帶 `as`（subagent 收不到 parent 回訊）或直接 shell out 跑 `basemind scan`（繞過版本紀律）。
- **影響**：錯的行為指引直接進模型 context，且 `basemind-*` 正是本次賣點。
- **修法**：在 [skills/.dsh-adapt.json](../skills/.dsh-adapt.json) 新增 R7（multi-agent-room 的 PreToolUse 句）與 R8（scan 的 description／run code block 導向 `index_rescan` 或「使用者終端」），重跑 `npm run sync:skills`，由 `check:skills` 守住；**不要手改 `skills/**`**。

### I6 / [README.md:41](../README.md#L41)、[README.zh.md:41](../README.zh.md#L41)、[README.md:138](../README.md#L138)

- **觸發／證據**：§3 相容性表仍寫「BaseMind | Any version. The plugin does not pin or gate BaseMind…」，與本次 `binaryPolicy:'exact'` 預設（不相容就忽略並下載）直接衝突；§5.1「a newer version may expose more」同理。
- **預期與實際**：預期公開契約反映新行為；實際仍是 0.1.x 的「不 pin 不 gate」。
- **影響**：使用者依表格判斷「我的 0.33 可以直接用」，實際被忽略並觸發下載或工具消失。AGENTS.md §7 要求行為變更同步 README。
- **修法**：改寫 §3 的 BaseMind 列（pin exact、預設下載、`binaryPolicy` 逃生門、0.33 需 `any` 或升級），§5.1 改成「工具集仍取自 `tools/list`，但預設只接受 pin 版本」。

---

## 4. Minor（記錄，不阻塞）

| # | 位置 | 問題 | 最小修法 |
|---|---|---|---|
| M1 | [lib/status.js:387-389](../lib/status.js)、[README.md:214](../README.md) | 下載失敗後 status/README 說「會 backoff 重試」，但 `select()` 把失敗也永久快取，process 內不會再試（Plan §10.5(a) 寫的是「最多 1 次」），診斷面誤導 | 文字改「restart the plugin / 下次啟動在冷卻期後重試」 |
| M2 | [README.md:154](../README.md)、[:165](../README.md)、[lib/binary/manager.js:599-603](../lib/binary/manager.js) | 同節先說「切目錄會重新選 binary」，又說「每 process 只選一次」；「cache hit writes nothing」也不精確（首次每 workspace 寫 `state.json`、adopted 補 `install.json`） | 刪掉矛盾句，改成「process 內固定；只寫插件自管快取」 |
| M3 | [package.json:66-67](../package.json) | `sync:skills`／`check:skills` 寫死 `--tag v0.34.0`，與 AGENTS.md §8.1「一律取自 upstream.js」不一致（有 guard，不會靜默） | 拿掉 `--tag`，讓腳本預設 `UPSTREAM.tag` |
| M4 | [scripts/check-pack.mjs:31-41](../scripts/check-pack.mjs)、[scripts/check-manifest.mjs:18-24](../scripts/check-manifest.mjs) | `check-pack` 只靠副檔名擋 binary，`skills/**` 下一個無副檔名的 `basemind` 仍可打包；`check-manifest` 的 `/binaryDownload:\s*true/` 可被一行註解滿足 | `check-pack` 限制 `skills/**` 只允許已知副檔名；`check-manifest` 要求命中非註解行 |
| M5 | [lib/binary/manager.js:502-523](../lib/binary/manager.js)、[:648-659](../lib/binary/manager.js) | `installPinned` 先設 `running`，若鎖內發現別人已裝完就 `return existing`，state 停在 `running`；`attempts` 重複 +1；shutdown abort 會被記成 10 分鐘冷卻 | 提前 return 時設回 `idle`；`attempts` 只在真正發起時 +1；`AbortError` 不寫 cooldown |
| M6 | [lib/binary/manager.js:756-764](../lib/binary/manager.js)、[index.js:734-741](../index.js) | 尚未選型時 `/basemind-status` 與 `failOnStartupError` preflight 可能觸發 75–102 MB 下載（status 只包 5 s timeout，下載在背景繼續） | status 首次探測只做 probe；fail-fast 加時間預算或文件註明 |
| M7 | [lib/prompt/bootstrap.js:117-118](../lib/prompt/bootstrap.js) | bootstrap 無條件說「the `basemind` skill holds the long-form playbook」，`skills:false` 時該 skill 不存在 | `bootstrapText` 多收 `skills` 旗標，關閉時省略該行 |
| M8 | Plan §11.4.1 vs [lib/tool-bridge.js](../lib/tool-bridge.js) | Plan 說「本次再加 `-32003` 固定說明」，實作沒做（報告 §5 #10 已宣告，§15.5 又把 tool-bridge 列為不改，屬 plan 自身矛盾） | 補一行 suffix，或把 §11.4.1 標為撤回 |
| M9 | [test/upstream.test.mjs](../test/upstream.test.mjs) 等 | 報告稱「13 個新 test 檔」，實際 12 個 | 修報告數字 |

---

## 5. Declined to Judge（不列為 finding）

- `--view` 未封鎖：plan §14.4 只禁止 `--root`；`--view` 是同一 workspace 的唯讀 view，不是路由繞過。
- PATH 與 managed cache 順序：task brief 提到「PATH 應輸給快取」，但 plan §8.1 明確是 explicit→env→PATH→cache→download；實作照 plan，不把 plan 當錯。
- `autoProvision`/`npxSpec` 保留 `latest` 語意：plan §9.5 已裁決為 legacy。
- `binaryDownload:true` 首次 75–102 MB 寫入：Plan D2 第三輪裁決，已有 patch 顯式宣告與斷言。
- 0.33 daemon 與 0.34 撞 `-32003`：plan §11.1/§11.2 S5 接受為可診斷降級。
- `binaryPolicy:'minor'` 接受未逐版驗證 patch：plan §9.2.4 定位為使用者逃生門。
- CLI tool `isConcurrencySafe() === true`：plan §14.3 明確要求，且只允許唯讀動詞。
- probe spawn 未 `scrubEnv`：與舊 `readVersion` 一致，屬既有行為。
- 下載 allowlist 允許非 443 埠：仍要求 https + allowlist host + TLS 驗證，不構成 host 繞過。
- `skills/index.md`、`UPSTREAM.json`、`.dsh-adapt.json` 保留：plan §12.1/§12.3 要求完整 vendoring 與 provenance。
- Plan §17.10 A/B、§19 DSH Desktop、macOS/Linux 實機下載、0.33 legacy integration 未執行：報告 §6 已如實列出，屬環境／授權範圍。
- README §10 的 `/basemind-status` 樣板輸出與實際 reason 字串不同：示意文字，併入 M1。

---

## 6. Review 自行重驗的 primary evidence

| 主張 | 我怎麼驗 | 結論 |
|---|---|---|
| C1 Skills 載入必拋錯 | 讀 [lib/skills/provider.js:222-237](../lib/skills/provider.js)；從 `app.asar` 抽 `@deepseek-ai/dsh-skill/lib/index.js`，確認 `:256` `provider.get(...)` → `:258` `validateDefinition(definition)`，`:486-487` 要求 `source`／`provider` 為 string，`:484` 驗 `invocation` | **成立** |
| C2 tar.gz 解壓必失敗 | 讀 [lib/binary/archive.js:339](../lib/binary/archive.js)（`header.name === entry`，無 `./` 正規化）；讀上游 `scripts/package-release.sh:113`、`:181`（`tar czf … -C "$STAGING_DIR" .` → `./` 前綴）；讀 `archive.js:318-322` 確認 `writing` 未重設 | **成立（兩個缺陷並存）** |
| I2 單元測試污染使用者 home | 實查 `~/.dsh/cache/dsh-basemind-plugin/state.json` 存在，mtime 2026-11-24 15:06/15:17，內容為本 repo root 與 `fixtures`；`index.js:119` 未注入 cacheRoot | **成立** |
| I3 CRLF 會讓 Windows CI 紅 | `ls .gitattributes` 不存在；`git ls-files --eol skills` = `i/lf w/lf` | **成立（風險已具備條件）** |
| I4 compat 硬編版本 | 實讀 `.github/workflows/compat.yml:105` | **成立** |
| I1 npx 不一致 | 實讀 `manager.js:615`（`source:'npx'`、`compatible:true`、`extraArgs`）、`cli-tool.js:455`（無 extraArgs）、`index.js:626`（`verified` 只看 policy+compatible） | **成立** |
| I6 README 相容性表過時 | 我在規劃期已讀 `README.md:41`，內容確實是「Any version… does not pin or gate」 | **成立** |

---

## 7. Execution Report 宣稱的重驗

| 宣稱 | 結果 |
|---|---|
| `npm run check`：syntax 20 files；manifest ok | 重現 |
| `npm run check:skills`：10 skills / 20 files match v0.34.0 | 重現（LF checkout）；CRLF checkout 30 筆 drift |
| `npm run check:pack`：52 files | 重現 |
| `npm test`：387 / 387 pass / 0 skip | 重現（實測 93.3 s，數量一致） |
| `BASEMIND_REQUIRE_INTEGRATION=1 … integration.test.mjs`：8 pass | 重現（69.5 s，非 skip） |
| 既有 test case 未刪除、未放寬 | 重現 |
| 「單元測試不連網、不寫出 tmpdir、不呼叫真實 basemind」 | **不成立**（見 I2） |
| 「workflow 版本改讀 lib/upstream.js」 | 大部分成立；compat 的 suite gate 仍硬編（I4） |
| 13 個新 test 檔 | 實際 12 個（M9） |

**注意**：`npm test` 全綠**不證明** C1／C2 —— 這兩個缺陷分別落在「fake registry 自證」與「Windows zip 路徑」的盲區，正是本次 Review 的主要價值。

---

## 8. 建議修復順序（交回 Execution）

1. **C1**（Skills definition shape）——幾行改動 + 一個契約測試。
2. **C2**（tar `./` 正規化 + `writing` 收尾 + 照 `package-release.sh` 形狀的 fixture）。
3. **I1**（selection 的 verified 語意統一）——與 C1 同屬「下游一致讀同一旗標」，建議一起做。
4. **I2**（cacheRoot 注入 seam）——同時讓「單元測試 0 次寫入使用者 home」變成可斷言事實。
5. **I3**（`.gitattributes`）——這是 hash gate 的前置條件，最便宜。
6. **I4**、**I5**（adapt rules R7/R8 + 重跑同步）、**I6**（README 相容性表）。
7. M1–M9 可延後，M8 至少要決定「實作」或「在 plan 標撤回」。

修完 C1–C2 + I1–I6 後再交付人工審查；本 Review **不進入 Fix 循環**（AGENTS.md §3.5、§10），修復由使用者交回 Execution Agent。

---

## 9. 結論

**No blocking issues found 不適用** —— 有 2 個阻塞缺陷。

- **Ready to merge: No。**
- 兩個 Critical 都直接打斷本次主賣點，且**本機所有測試與 integration 都無法發現**（C1 是對 fixture 自證、C2 只在非 Windows asset 上觸發）。
- 六個 Important 都是「幾行到一個檔案」等級，但每一項都會在真實使用者或 CI 上立刻顯現。
- Minor 不阻塞，但 M8（plan 與實作對 `-32003` 的矛盾）需要一次明確裁決，避免留到下一輪。

---

## 10. 本次 Review 的狀態與邊界

- 已審：staged 全部 75 檔（runtime 全讀；`skills/**` 以機械檢查 + 抽樣；測試以執行 + 抽樣）、Plan、Report、AGENTS.md。
- 未審／未驗：DSH Desktop 實機（D1–D11）、macOS/Linux 實機下載與解壓、0.33 legacy integration、Agent A/B 效果對照 —— 與執行報告 §6 一致，屬環境／授權範圍。
- 本 Review 只新增本文件；未修改產品程式碼、未 stage、未 commit、未 tag、未 push。

---

# 第二輪：Scoped Re-Review（2026-11-24，Fix Round 1）

## R0. 輸入與範圍聲明

| 輸入 | 內容 |
|---|---|
| Findings | 本文件 §2（C1、C2）與 §3（I1–I6），即上一輪 Review 的 Critical/Important 清單 |
| Fix range（base） | 上一輪 Review 看到的 staged tree（當時 75 檔 staged，HEAD `f278d6c`） |
| Fix range（head） | 目前 staged tree（77 檔 staged，HEAD 仍 `f278d6c`；無 commit、無 stash、無 unstaged） |
| Fix diff | 由 git 還原：`git fsck --unreachable` 找到 45 個 pre-fix blob，逐檔比對後確認 6 個 runtime 檔的 base blob（`provider e81453f2`、`archive 166f8773`、`manager ecced023`、`cli-tool 08175e03`、`index accc85d9`、`bootstrap 0ecbf579`），再以 `<blob> → <index blob>` 取得**真正的 fix diff**。其餘變更（`.gitattributes` 新檔、README/workflow/adapt-rules/tests）以「當前內容 + numstat 差異」核對，未重跑整套測試。 |

base 由 git object 還原（非 artifact header）；head 由 `git diff --cached` 確認。**完整 staged diff 沒有被當成 fix diff 使用**。

## R1. Finding 逐項判定

| # | Finding | 判定 | 證據（現況） |
|---|---|---|---|
| C1 | `get()` 回傳的 definition 缺 `source`/`provider`/`invocation`，DSH registry `validateDefinition` 必拋 TypeError | **ADDRESSED** | `lib/skills/provider.js:168` 新增 `definitionEntry()`（含 `invocation`/`provider`/`source`/`resourceBase`/`rank`/`locator`），`:250` `get()` 改為 `{ ...candidateEntry, ...definitionEntry(entry), content: entry.content }`；`list()` 共用同一 builder（`:231-236`）。覆蓋測試 `test/skills.test.mjs:97-111` 的 `assertCompleteDefinition()` 直接斷言 registry 要求的欄位（`source==='bundled'`、`provider==='basemind'`、invocation 兩布林），不是自證 fixture |
| C2 | tar 比對未剝 `./`（官方 `tar czf … -C DIR .`）＋ `writing` 未收尾導致 payload 串接 | **ADDRESSED** | `lib/binary/archive.js:211` `normalizeTarEntryName()`、`:361` `normalizeTarEntryName(header.name) === entry`、`:337` `if (remaining === 0) writing = false`、`:365` `writing = remaining > 0`（零長度 entry 也安全）。覆蓋測試 `test/binary-archive.test.mjs:409-459` 以 `./` 前綴 + 前後夾雜 regular file 的真實形狀，並 `assert.deepEqual(await readFile(dest), BINARY, 'only the target payload is written')`——兩個缺陷同時被這條斷言擋住 |
| I1 | npx 被當 verified；CLI 漏 `-y <spec>`；bootstrap 假稱版本 | **ADDRESSED** | selection 新增 `verified`：`manager.js:342`（any+unparsable → false）、`:363`（`policy !== 'any'`）、`:420`/`:568`（managed → true）、`:618`（npx → false）；下游統一讀它：`index.js:328`（CLI）、`:593`（skills）、`:626`（bootstrap）；`cli-tool.js:455-458` 疊 `binary.extraArgs`。覆蓋測試 `test/cli-tool.test.mjs`（npx argv）與 `test/binary-manager.test.mjs`（verified 斷言）存在 |
| I2 | 單元測試寫入使用者真實 `$DSH_HOME` | **ADDRESSED**（採先前允許的最小修法） | `test/index.test.mjs:11-16` 以 `mkdtemp` 擁有 `DSH_HOME` 並在 `after` 清除；被污染的 `~/.dsh/cache/dsh-basemind-plugin/` 已經不存在（實查）。殘留：`apply()` 仍無 `cacheRoot` seam，未來新測試若直接呼叫 `apply()` 需自行設定 `DSH_HOME` |
| I3 | CRLF checkout 會讓 skills hash 誤報 drift（無 `.gitattributes`） | **ADDRESSED** | 新增 `.gitattributes:1-8`，內容 `skills/** -text`（理由寫在檔內）。實測 `git check-attr text skills/basemind/SKILL.md` → `unset`、`git ls-files --eol` → `attr/-text` |
| I4 | `compat.yml` 的 contract suite gate 硬編 `'0.34.0'`，pin bump 後靜默跳過 | **ADDRESSED** | `compat.yml:67` Resolve step 輸出 `BM_PIN`（讀 `lib/upstream.js`）、`:111` gate 改 `if: env.BM_VERSION == env.BM_PIN` |
| I5 | vendored 文字教 DSH 沒有的行為（multi-agent-room 的 PreToolUse、basemind-scan 的 CLI scan） | **ADDRESSED** | `.dsh-adapt.json` 新增 R7×1、R8×3（id 清單可見 `:77/:85/:93/:101`）；`skills/basemind-multi-agent-room/SKILL.md:37` 改為「DSH does not inject `as` (there is no PreToolUse hook), so every call must pass it explicitly」；`skills/basemind-scan/SKILL.md:2` description 改為 `index_rescan`／使用者終端並明說 CLI 工具拒絕 `scan`/`rescan`。`npm run check:skills` exit 0（10 skills / 20 files match v0.34.0） |
| I6 | README §3 仍寫「BaseMind any version, does not pin or gate」，與 exact pin + 預設下載矛盾 | **ADDRESSED** | `README.md:41` / `README.zh.md:41` 改寫為「**0.34.0**, pinned in `lib/upstream.js` and enforced by `binaryPolicy: 'exact'`… `binaryDownload: true` installs that pinned release…'any' keeps only the MCP bridge and disables skills/CLI/version notice」，並保留平台驗證範圍的誠實說明；舊句 `does not pin or gate` 在兩份 README 皆為 0 次 |

## R2. Fix diff 的新增破損

**None（Critical/Important/Minor 皆無）**。逐項檢查過：

- `definitionEntry()` 多帶 `rank`/`locator` 進 definition：DSH `validateDefinition` 只驗已知欄位，額外屬性被忽略，不影響載入。
- `get()` 以 candidate 先 spread、`definitionEntry` 後 spread：name/description 一律以本次載入的 entry 為準，符合 registry 的 stale 檢查。
- tar 的 `writing = remaining > 0`：零長度 entry 仍會建立空檔並 `found=true`；目標 entry 之後的 member 不再被寫入（測試已斷言 dest 內容完全等於目標 bytes）。
- `download.attempts` 只剩 `installPinned` 開頭一處 +1（`manager.js:503`），語意為「安裝嘗試次數」，status 讀值正常。
- `check-manifest` 收緊後（去註解、要求整行 `binaryDownload: true`）在真實 patch 上通過：`npm run check` → syntax ok 20 files / bundle manifest ok。

## R3. Out-of-Scope Observations（不阻塞，不擴大本輪）

- `plan §11.4.1`（`:987`）仍寫「本次再加」`-32003` 固定說明；撤回只記在 execution report `§5 #10`（`:81`）。M8 的「在計畫裡標撤回」這半步沒做，建議下次同步 plan 時補一行。
- Minors 實際處置：M1（`status.js:387/389`、`README.md:214` 改為「restart DSH，下次啟動在冷卻期後重試」）、M2、M3（`package.json:66-67` 已無 `--tag`）、M4、M5、M7、M9 已修；M6、M8 明示 defer。
- `binaryPolicy:'minor'` + 0.34.1 時 status 會顯示 `compatible: YES`，而 skills/CLI 已啟用但版本未逐版驗證——這是 plan §9.2.4 已接受的逃生門語意，非本輪新問題。
- `apply()` 仍無 `cacheRoot` seam（I2 的結構性殘留），目前由測試端 `DSH_HOME` 緩解。

## R4. 結論

**Fix round: All findings addressed, no new Critical/Important breakage.**

- 2 Critical + 6 Important 全部以「現況程式碼 + 可定位行號」證明原觸發條件已消失；兩個 Critical 的覆蓋測試都直接斷言修復後的行為（skills 的 registry 契約、tar 的「只寫目標 payload」），不是裝飾性斷言。
- 未重跑整套測試（依 skill 的 read-only 紀律）；只跑了 `npm run check` 與 `npm run check:skills` 兩個與修復直接相關的 gate，皆 exit 0。
- 仍未驗證（與前一輪相同，屬環境範圍）：DSH Desktop D1–D11、macOS/Linux 實機下載與解壓、0.33 legacy integration、Agent A/B 效果對照。
