# Phase 1（P0）Scoped Re-Review — Fix round 1

- 日期：2026-11-24
- 角色：Review（scoped re-review）
- 輸入
  - Findings：上一輪 [Phase 1 Review](./2026-11-24-basemind-stability-phase1-review.md) §1（F1）、§2（F2）——2 個 Important，無 Critical。
  - Fix range：**base** = 上一輪審查所見的 staged tree（`lib/binary/manager.js` blob `e31d70e`、`lib/status.js` `abb89e7`、`test/binary-manager.test.mjs` `14a2a8a`、`test/binary-install-layout.test.mjs` `725edda`、`test/status.test.mjs` `fef5a3f`）；**head** = 目前 index（`manager.js` `2848b40`、`status.js` `0ba019c`、`binary-manager.test.mjs` `4ca78d7`、`binary-install-layout.test.mjs` `72ef197`、`status.test.mjs` `0961983`）。
  - Base 由 git 確認：上一輪 `git add` 留下的 index blob 已不可達但仍在 object DB，以 `git fsck --unreachable --no-reflogs` 取出，逐一以內容特徵（舊的 `String(install.sha256).toLowerCase()` 等）比對，再用 `git diff <base blob> :<path>` 取得**真正的 fix diff**（manager 142+/8−、status 5+、manager test 40+/2−、status test 20+、layout test 6+/2−）。未把整個 staged diff 當 fix diff 使用。
- 範圍：上述 5 個檔案的 fix diff，外加本輪文件 delta（README／CHANGELOG／Execution Report §8）。未重新審查 Phase 1 其餘程式碼。

---

## Finding Verdicts

- **F2 — `install.json.sha256` 是 archive digest，卻被當成主 binary digest 比對** — **ADDRESSED**
  - 記錄端：安裝時對 staged 主 binary 只 hash 一次並寫入 `binarySha256`（[lib/binary/manager.js:820](../lib/binary/manager.js#L820)、[:830](../lib/binary/manager.js#L830)），`sha256` 仍是 archive digest。
  - 契約端：`isLayout2()` 要求 `typeof value.binarySha256 === 'string' && value.binarySha256 !== ''`（[:168-180](../lib/binary/manager.js#L168-L180)），沒有 binary digest 的記錄不再被當成完整快取。
  - 比對端：`hasher(file)` 改與 `install.binarySha256` 比較（[:549-553](../lib/binary/manager.js#L549-L553)）；舊的 `install.sha256` 比較行已移除。
  - 替代機制是否滿足原要求：原 finding 要求「主 binary 內容未變就接受、被換掉才拒絕」——現在兩邊都是主 binary 的 digest，語意成立；同時保留「只在 size／mtime 與記錄不同時 hash」，cache hit 不 hash。
  - 覆蓋測試存在且能失敗：[test/binary-manager.test.mjs](../test/binary-manager.test.mjs) `a layout-2 record without a binary digest is treated as incomplete`（若移除 `binarySha256` 要求，seed 的完整樹會被接受、`download.length` 為 0 → 斷言失敗）；[test/binary-install-layout.test.mjs:288-289](../test/binary-install-layout.test.mjs#L288-L289) 以 `DIGEST`（archive）與 `BINARY_DIGEST`（binary）**兩個不同 digest** 分別斷言，若把 archive digest 寫進 `binarySha256` 即失敗。

- **F1 — `.old-*` 舊樹沒有回收或還原路徑** — **ADDRESSED**
  - 還原：新增 `recoverParkedTrees()`（[lib/binary/manager.js:693](../lib/binary/manager.js#L693)）。target 缺失時取最新 parked tree `renameWithRetry` 回 target 並記 `info`；其餘 `.old-*` best-effort 刪除，失敗寫 `warn`（含路徑）。
  - 呼叫點：`runSelection()` 起點（[:951](../lib/binary/manager.js#L951)）——讓 `binaryDownload:false`／離線啟動也能救回；`installPinned()` 鎖內（[:771](../lib/binary/manager.js#L771)）——race-free。非鎖路徑先檢查 install lock 是否存在（[:694-705](../lib/binary/manager.js#L694-L705)），避免在別的 process swap 期間搶回 parked tree 而讓對方 rename-in 失敗。
  - 失敗訊息：swap 失敗的 restore 改走可注入、會重試的 `renameWithRetry`，並在失敗時記錄 `.old-*` 路徑（[:860-872](../lib/binary/manager.js#L860-L872)）；成功安裝後刪除舊樹失敗由 `debug` 升為 `warn`（[:876-880](../lib/binary/manager.js#L876-L880)）。
  - 可診斷性：`managedCacheFacts().parkedTree`（[:1043](../lib/binary/manager.js#L1043)）與 `/basemind-status` 的 `cache parked` 行（[lib/status.js:457](../lib/status.js#L457)），`target` 缺失時會說明明確原因，而不是只顯示 missing。
  - 覆蓋測試存在且能失敗：`an interrupted swap is recovered from the parked .old tree without a download`（`binaryDownload:false` 下若無 recovery，selection 直接失敗 → 斷言失敗；同時斷言 0 下載、0 checksums、目錄歸位、無 `.old-*` 殘留）；`a parked tree from an interrupted swap is named and promised to be restored`（移除 render 區塊即失敗）；既有 `a locked destination rename…` 的注入器改成只封鎖 swap，restore 若被擋則「舊樹還原＋無 `.old-*`」斷言失敗。

### Fix Report 交叉核對

| Report 宣稱 | 核對 |
| --- | --- |
| 新增 2 條 manager 測試、1 條 status 測試、layout 測試改雙 digest | 全部存在於 fix diff（見上） |
| 「locked-rename 注入器只封鎖 swap」 | 成立（`path.basename(from).startsWith('.old-') === false` 才拋 EBUSY） |
| `npm run verify` 419 pass | 與實作階段實際執行結果一致；本次 re-review 依 read-only 紀律未重跑 |
| 真實 e2e：mtime 變更後 1 次 hash、0 網路 | 屬實作階段證據，本次未重跑；fix diff 的比對語意與該結果一致 |

---

## New Breakage in the Fix Diff

- **Minor** — [lib/binary/manager.js:1039](../lib/binary/manager.js#L1039) — `managedCacheFacts().valid` 只看 `layout === 2` 與 `files[]`，未要求 `binarySha256`，而 `isLayout2()`（:176）已收緊。對「layout-2 但沒有 binary digest」的記錄，`/basemind-status` 會顯示 valid，選型卻會重下載。此形狀不會由本程式碼產生（安裝一律寫入），只影響手造／更早的中間狀態；建議 `valid` 加上同一個 `binarySha256` 條件以保持一致。
- **Minor** — [lib/binary/manager.js:734-744](../lib/binary/manager.js#L734-L744) — 還原時取**最新**的 parked tree，其餘在同一次呼叫內立即刪除，此時選中的 tree 尚未驗證。若同時存在 ≥2 個 parked tree 且最新的那個不完整，較舊但可用的 tree 會被刪掉，之後只能重新下載。觸發需要連續兩次 crash 窗口，機率極低；建議「先還原、等 `readManagedCache()` 驗證失敗後再刪其餘」或只刪超過一定時間的殘留。
- **Minor（報告不精確）** — [docs/2026-11-24-basemind-stability-phase1-execution-report.md](./2026-11-24-basemind-stability-phase1-execution-report.md) §8「接受殘留」寫「留到下一次安裝才由 `recoverParkedTrees()` 清掉」，實際是**下一次選型**（`runSelection()` 起點）就會清；同句「status 可見」只在 target 缺失時成立（`parkedTree` 僅在 `present === false` 時計算）。程式行為正確，屬報告描述偏差。

## Out-of-Scope Observations

- [lib/status.js](../lib/status.js) 既有 `managed cache` 行在 `present && !valid` 且同時缺檔時可能出現 ` - invalid - incomplete` 兩個後綴；本輪未觸及該行（Phase 1 既有）。
- [lib/binary/probe.js](../lib/binary/probe.js) spawn spec 未帶 `env`（繼承 Host PATH）；Phase 1 Review 已記錄為「整包安裝後不再造成誤判」，本輪未改。

## Verdict

**Fix round: All findings addressed, no new Critical/Important breakage.**（2 個 Important 均 ADDRESSED；fix diff 內 3 個 Minor 不阻塞。）
