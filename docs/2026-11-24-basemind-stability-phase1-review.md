# dsh-basemind-plugin 0.3.0 — Phase 1（P0）Review

- 日期：2026-11-24
- 角色：Review（依 [AGENTS.md](../AGENTS.md) §3.5／§10）
- 受審對象：**staged tree**（14 檔，+3,228 / −173）＝ Phase 1 全部改動：`git diff --cached`
- 輸入：[Plan](./2026-11-24-basemind-stability-feature-parity-plan.md)（§3、§7–§9、§19.1、§22、附錄 B）、[Execution Report](./2026-11-24-basemind-stability-phase1-execution-report.md)
- 方法：Requirement → Plan → diff stat → actual diff → Execution Report → validation → 只讀取確認 finding 所需的 source；另由獨立 reviewer subagent 平行審查，兩邊結論由本文件合併並逐項重驗
- 判定：**2 個 Important，無 Critical**
- 本次 Review **未修改任何檔案、未 stage/unstage、未 commit**

---

## 1. Finding 1（Important）— `.old-*` 舊樹沒有回收或還原路徑

- **位置**：[lib/binary/manager.js:670](../lib/binary/manager.js#L670)（產生 `.old-<target>-<rand>`）、[:742-769](../lib/binary/manager.js#L742-L769)（swap／restore／刪除）、[:554-569](../lib/binary/manager.js#L554-L569)（`sweepDownloadRoot`）
- **觸發條件與證據**
  - 成功 swap 後以 `fsp.rm(previous, { recursive, force })` best-effort 刪除；失敗只寫 `logger.debug`。
  - 兩個 rename 之間若 process 被終止，或第二個 rename 失敗而 restore（[:754-763](../lib/binary/manager.js#L754-L763)）本身也失敗，會留下「`targetDir` 不存在 + 舊樹在 `.old-*`」的狀態；restore 失敗只寫一行 `warn`。
  - 全 repo `grep -n "old-" lib/binary/manager.js` 只有建立處一筆；`sweepDownloadRoot()` 只掃 `download/`，`managed-binaries/**/.old-*` 沒有清理或還原路徑，下一次安裝只會刪自己本次的隨機名目錄。
  - 測試只覆蓋「rename 失敗 → restore 成功」（`a locked destination rename…`）；restore 失敗分支無測試，且 restore 走 `fsp.rename` 而非可注入的 `renameFn`，現有 seam 無法觸發。
- **預期與實際**：Plan §8.3 要求「失敗後不比失敗前更糟、絕不留下半套目錄」；實際可能留下完整但不可達的 230–322 MB 舊樹，且 `targetDir` 消失 → 下次啟動重新下載 75–102 MB，磁碟空間永久殘留（`/basemind-status` 看不到）。
- **影響**：磁碟洩漏＋不必要的重新下載；無資料遺失、無安全問題。機率低（crash window／restore 失敗／刪除失敗），但沒有自我修復路徑。
- **最小修復建議**
  1. 在 `installPinned()` **取得鎖之後、`readManagedCache()` 之前**掃 `managedRoot/<expected>/.old-*`：若 `targetDir` 不存在且只有一個 `.old-*` → rename 回 `targetDir`（後續由 `readManagedCache()` 重新驗證）；其餘 `.old-*` best-effort 刪除，失敗升級為 `warn`。
  2. restore 失敗時把「舊樹仍在 `<previous>`」寫進 `warn`，並讓 `managedCacheFacts()` 能回報。
  3. 補一條以 `renameFn` 注入 restore 失敗的測試。

---

## 2. Finding 2（Important）— `install.json.sha256` 是 archive digest，卻被當成主 binary digest 比對

- **位置**：[lib/binary/manager.js:723](../lib/binary/manager.js#L723)（寫入 `sha256: downloaded.sha256`）、[:540-546](../lib/binary/manager.js#L540-L546)（`hasher(file)` 比對 `install.sha256`）、[lib/binary/download.js:319](../lib/binary/download.js#L319)（`return { sha256: actual, bytes: written }`，`actual` 是**下載 archive** 的 digest）
- **觸發條件與證據**
  - 安裝時寫入的 `sha256` 是 archive digest；`readManagedCache()` 在主 binary 的 `size`／`mtimeMs` 與記錄不同時，對**主 binary** 求 digest 再與 `install.sha256` 比對 → 兩者輸入不同，**永遠不相等**。
  - 此缺陷在 HEAD 已存在（`git show HEAD:lib/binary/manager.js` 的 +544 寫 archive digest、+413 對 binary 求 digest），但本次改寫 `readManagedCache()` 並把 layout 2 定義為新契約，同時用測試固化了錯誤語意：
    - [test/binary-manager.test.mjs:126-128](../test/binary-manager.test.mjs#L126-L128) `hasher` 回 `DIGEST`，而 record 的 `sha256` 也是 `DIGEST` → 「digest 相符」案例只在 seam 下成立。
    - [test/binary-install-layout.test.mjs:285](../test/binary-install-layout.test.mjs#L285) 斷言 `install.sha256 === DIGEST`（即 asset digest 語意），等於把「record 存 archive digest」寫成規格。
  - 觸發：主 binary 的 size 或 mtime 與記錄不同（cache 被複製／備份還原、工具 touch、未來安裝流程改動 mtime）。
- **預期與實際**：Plan §9.2 的意圖是「內容未變就接受、被替換才拒絕」；實際一旦觸發就 100% mismatch → `invalidateCache()` 刪掉整棵 230–322 MB tree → 重新下載。方向 fail-safe（不會執行被替換的 binary），但屬確定的 false positive，且「重新 hash 主 binary」在 production **沒有任何可通過的路徑**（只剩 stat + version probe）。
- **影響**：合法安裝被誤判為損壞並清空重下；文件與 Execution Report 宣稱的主 binary 重 hash 校驗實質不可用。無安全漏洞、無使用者資料遺失。
- **最小修復建議**：安裝時對 staged 主 binary 算一次 `binarySha256` 寫進 record（只 hash 一次，符合 Plan §23.2「不在 cache hit 時 hash 整樹」），`readManagedCache()` 改比對 `binarySha256`；`sha256` 保留為 asset digest 以維持欄位相容。測試 fixture 讓兩者為不同 digest，才能區分語意。

---

## 3. 已確認無問題的高風險點（本文件重驗）

| 風險 | 結論 | 確認方式 |
| --- | --- | --- |
| ZIP Slip／路徑逃逸 | 無問題 | 呼叫序 `assertSafeName`（tar 每個 header、zip central directory）→ `normalizeEntryPath` → `targetFor()` 的 `path.resolve` + `startsWith(root + sep)`；惡意名稱（`a/../../b`、`..`、`/abs`、`C:\abs`、`D:rel`、`\\server\share`、`a/./b`）實跑全部拒絕，destDir 外無檔案 |
| 重複 entry 一致性 | 無問題 | tar sink 與 zip scan 共用 `normalizeEntryPath` + `duplicateKey`；`lib/` vs `lib`、`./a` vs `a`、反斜線變體收斂同一 key；win32 case-variant 在 Windows 實跑通過 |
| `extractSingleFile` 行為不變 | 無問題 | 新舊逐段比對：錯誤碼、只寫 `destFile`、`{ bytes }` 回傳一致；新測試「still writes only the binary from a complete release tree」通過 |
| 安裝失敗留下半套目錄 | 除 Finding 1 外的窗口無 | staging 於 `finally` 清除；rename-aside → rename-in；restore 成功路徑有測試 |
| 快取完整性與效能 | 無問題 | `isLayout2()` 拒絕 legacy 單檔／無 record；`files[]` 逐檔 stat（N≤14）；命中不 hash 整樹、零網路 |
| 測試強度 | 無削弱 | 新斷言皆可失敗（layout-1 重下載、缺 `lib/libheif.so.1`／`heif.dll`、strict cache 重用、archive tree/mode、status 欄位）；唯一替換的 adopted-cache 測試是 D4 已核准決策的直接結果，新測試更嚴格 |
| POSIX 模式 | 無問題（未實跑） | `chmod` 僅非 win32；`mode & 0o111` → 0755/0644；zip 預設 0755；entry 用 `path.posix`、destination 用 `path` |
| 文件與行為一致 | 無問題 | 磁碟 230–322 MB、asset 75–102 MB、cache hit 零網路、layout-2 欄位與寫入一致 |

已知但**不列 finding**：swap 窗口與另一 process 的 `invalidateCache()` 競態在 HEAD 已存在，本案明確不改鎖語意；`probe` spawn 繼承環境（PATH 假陽性機制）在整包安裝後不再造成誤判。

---

## 4. 實際執行過的驗證

| 命令 | 結果 |
| --- | --- |
| `npm test`（reviewer 獨立重跑） | `tests 416 / pass 416 / fail 0 / skipped 0`，29.998 s |
| `node --test test/binary-archive.test.mjs test/binary-install-layout.test.mjs test/binary-manager.test.mjs test/status.test.mjs test/index.test.mjs` | `130 / 130 pass` |
| `npm run check` | `syntax ok: 20 files`、`bundle manifest ok` |
| lead 先前獨立執行（Execution Report §3） | `npm run verify` 416 pass；真實 Windows 冷安裝 13.1 s、淨化 PATH 下 `basemind 0.34.0` exit 0；快取重用 39 ms、0 網路 |
| 惡意 archive ad-hoc 探測 | tar／zip 全部 `path-traversal`；`a/./b` 只寫在 destDir 內；空名稱 `malformed` |
| Windows 檔案佔用探測 | 目錄內有開啟中檔案時 `rename(dir)` → `EPERM`（走 5 次重試設計） |

未執行：Ubuntu CI（需 push）、真實 Linux/macOS 整包安裝、`check:pack`（review 授權下不寫 `pack.json`）。

---

## 5. 結論與建議

- **Ready to merge: 修完 F1、F2 後可交付人工審查**。兩者都不是安全或資料遺失問題，但 F2 會讓合法快取被清空重下，F1 會在少數失敗窗口留下 230–322 MB 垃圾且無自我修復路徑；兩者在 Plan 明確要求「不留下半套目錄」「主 binary 重 hash」的語意下屬於應修項。
- 建議修復順序：**F2（幾行 + 一次 hash）→ F1（鎖內 sweep + restore 失敗訊息 + 測試）→ 重跑 `npm run verify` → 更新 Execution Report**。
- 修復由使用者交回 Execution Agent 執行；本次 Review 不進入 Fix 循環。
- 未驗證範圍：Ubuntu CI 綠與 `Run tests` 耗時回到 8–12 s、Linux/macOS 真實整包安裝、Windows 真實 exe 被 image-map 鎖住時的 rename 行為。

---

# 第二輪：Fix round 1 複核（2026-11-24）

## R1. Finding 逐項判定

| # | Finding | 判定 | 證據（現況） |
| --- | --- | --- | --- |
| F1 | `.old-*` 沒有回收或還原路徑 | **ADDRESSED** | [lib/binary/manager.js](../lib/binary/manager.js) 新增 `recoverParkedTrees()`（`runSelection` 起點在**確認無 install lock** 後執行，`installPinned()` 鎖內再執行一次）；target 缺失時把最新 parked tree rename 回 target（零下載），其餘 `.old-*` best-effort 刪除並在失敗時 `warn`；restore 改走 `renameWithRetry()` 且失敗訊息帶 `.old-*` 路徑；成功安裝後刪除失敗由 `debug` 升為 `warn`；`/basemind-status` 新增 `cache parked`。測試：`an interrupted swap is recovered from the parked .old tree without a download`（`binaryDownload:false` 下 0 下載、0 checksums）、`a parked tree from an interrupted swap is named and promised to be restored`（status）。 |
| F2 | `sha256` 是 archive digest 卻比對主 binary | **ADDRESSED** | record 新增 `binarySha256`（安裝時對 staged 主 binary hash 一次）；`isLayout2()` 要求它存在；`readManagedCache()` 改比對 `binarySha256`，`sha256` 保留為 archive digest。測試：`a layout-2 record without a binary digest is treated as incomplete`、layout 測試以兩個不同 digest 分別斷言；真實 Windows e2e 證實「只改 mtime」→ 1 次 hash、0 網路、重用成功。 |

## R2. Fix diff 的新增破損

**None**。逐項確認：

- `recoverParkedTrees()` 在無鎖路徑先檢查 install lock，避免在別的 process swap 期間把 parked tree 搶回（否則對方 rename-in 會失敗）；鎖內呼叫不受此限，並保留 `renameWithRetry` 的 bounded retry。
- 還原後仍走 `readManagedCache()` 全套驗證（layout／`files[]`／probe），不會把不完整或過期版本當成可用。
- `isLayout2()` 收緊只影響「沒有 `binarySha256`」的記錄；本輪之前沒有任何已發布版本寫過這種記錄，且由舊 adoption 路徑產生的 record 本來就不是 layout 2。
- status 新行沿用既有 100 欄截斷與 redaction；`keepTail` 讓 `.old-*` 尾段可見。
- 新增 hash 只在安裝時發生一次（226–313 MB），cache hit 仍不 hash 整樹；`files[]` 仍只 stat。實測安裝仍 13 s（下載主導），重用 39–398 ms。

## R3. 本輪驗證（複核者重跑）

| 命令 | 結果 |
| --- | --- |
| `npm run verify` | **419 tests / 419 pass / 0 fail / 0 skip**；`syntax ok: 20 files`、`bundle manifest ok`、`pack contents ok: 52 files` |
| 真實 Windows 冷安裝（淨化 PATH） | 成功；`sha256` 與 `binarySha256` 不同；`basemind 0.34.0` exit 0 |
| 「只改 mtime」重用 | 0 網路、`hashes = 1`、398 ms |

## R4. 結論

**Fix round: 2 個 Important 全部 addressed，未發現新 Critical/Important。**

- 仍接受一個殘留：成功 swap 後刪除 `.old-*` 失敗時，該目錄留到下一次安裝才清（已 `warn` 且 status 可見），不把掃描放進熱路徑。
- 未驗證範圍與第一輪相同：Ubuntu CI、Linux/macOS 真實安裝、Windows 真實檔案佔用下的 restore。
