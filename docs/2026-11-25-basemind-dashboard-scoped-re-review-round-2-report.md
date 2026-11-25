# BaseMind Dashboard — Scoped Re-Review（第 2 修復輪）

日期：2026-11-25　前一輪：[Scoped Re-Review](./2026-11-25-basemind-dashboard-scoped-re-review-report.md)（C1/C2/I2 ADDRESSED，I1 未關閉）
修復方報告：[Fix Report](./2026-11-25-basemind-dashboard-review-fix-report.md) §8 Round 2

## 0. 輸入與範圍

- **Findings**：沿用前一輪清單（C1、C2、I1、I2），其中只有 I1 是未關閉項；另含前一輪提出的兩個 Minor 觀察。
- **Base**：前一輪審查所見的 index 內容（`HEAD = 0e94e3e`，全部改動 staged）。
- **Head**：目前 index（`HEAD` 仍為 `0e94e3e`，無新 commit、無 unstaged、無 stash，已用 git 確認）。
- **修復 diff**：與前一輪相同限制——修復仍疊在同一個未提交 index 上，git 無中間 tree 可切分。範圍因此限定於 fix report §8 明列的變更（`contracts.js`、`client.js` 一條渲染行、對應測試）與可觀測的檔案增量（contracts 310→316、client 測試 443→488、docs）。未重跑測試套件。

## 1. Finding Verdicts

### I1 — 增量掃描 scope 可注入 CLI 旗標 — **ADDRESSED**

- 機制：`lib/dashboard/contracts.js:305-313` 先算出真正會進 argv 的 `canonical = withoutDot.join('/')`，再於 `:311` 檢查前導 `-`、`:312` 檢查 NUL，並在 `:313` 才 `push(canonical)`。原始形式被固定的就是這個值，因此 `./-x`、`./--rebuild-git-history`、`./-` 全部在正規化後被擋下；原字串層的 `:296-297` 仍保留作第一道。
- 未破壞合法路徑：`['src/a.js','src\\b.js','./src/c.js','src/a.js']` 仍解析為三個去重後路徑（`test/dashboard-contracts.test.mjs:166-169`），dot segment 在路徑中間時（如 `a/./-x` → `a/-x`）也不會被誤擋。
- 覆蓋測試存在且能失敗：`test/dashboard-contracts.test.mjs:173` 的清單已加入 `['./-x']`、`['./--rebuild-git-history']`、`['./-']`；在修復前這些都會回 `{ ok: true, paths: ['-x' | '--rebuild-git-history' | '-'] }`，斷言必失敗。
- 替代機制是否滿足原要求：是。原要求是「scope entry 不得變成 CLI 旗標」，現在檢查的正是送進 `service.js:458` argv 的那一份字串。

### C1 / C2 / I2 — 沿用前一輪的 ADDRESSED

- 本輪未再變更其修復點（`routes.js` 仍 184 行、`index.js` 84 行、`client.js` 的 `TabBody`／元素化渲染未動）；前一輪引用的機制與測試仍成立，故維持 ADDRESSED，不重新判定。

## 2. 前一輪 Minor 觀察的處置

- **「0 顯示成 —」—— 我的誤判，不是缺陷**：`lib/dashboard/client.js:311-314` 的 `count()` 回傳 `value.toLocaleString()`，即 `count(0)` 是**非空字串** `"0"`，`count(v) || '—'` 只在 `null` 時才給 dash。修復方以 probe 指出此點，經核對原始碼屬實；`test/dashboard-client.test.mjs:386-411` 已用「all-zero summary 顯示 0、不出現 null」把它釘住。
- **「last-scan 狀態是原始 token」—— 已修**：`client.js:803` 改為 `t('scan.state.' + data.lastDashboardScan.status)`，與歷史表一致；`test/dashboard-client.test.mjs:413-428` 同時斷言出現 `scan.state.completed` 且不出現原始 `completed` token。此測試在修復前會失敗。

## 3. New Breakage in the Fix Diff

None。`contracts.js` 的新檢查位於既有驗證之後、`push` 之前，只拒絕正規化後以前導 `-` 開頭或含 NUL 的值；合法 relative path 的既有測試全數維持通過語意。`client.js:803` 只把 `String(...)` 換成既有的 `t(...)` 查表，鍵缺失時仍回傳鍵字串，不會拋錯。

## 4. Out-of-Scope Observations

- `test/dashboard-client.test.mjs:410` 的 `assert.match(text, /scan\.summary\.scanned 0/)` 在修復前也會通過（舊碼是 `String(0)`），屬「釘住正確行為」而非「證明舊碼錯誤」；文件用語一致，無需處理。
- `lib/dashboard/contracts.js:296-297` 與 `:311-312` 現在有重複檢查；保留原字串層屬縱深防禦，可接受。

## 5. Verdict

**All findings addressed, no new Critical/Important breakage.** I1 的繞過形式（`./` 前綴）已由正規化後的檢查關閉並有會失敗的回歸測試；前一輪的兩個 Minor 觀察，一個經核實不是缺陷（`count(0)` 回傳字串 `"0"`），另一個已修並有測試。
