# dsh-basemind-plugin — Phase 1（P0 穩定性）Execution Report

> 版本狀態（2026-11-24 人工裁決）：`package.json` 為 **0.2.0**，目標發布版本與正式發佈版本均為 0.2.0（目前仍為開發版本，尚未正式發佈）。本報告原標題中的「0.3.0」已更正。

- 日期：2026-11-24
- 角色：Execution（依 [AGENTS.md](../AGENTS.md) §3.4；授權來源：使用者確認 [Plan](./2026-11-24-basemind-stability-feature-parity-plan.md) 附錄 B 全部建議）
- 基線：`HEAD f87b58309d06a6cf0d2aa14ea04abd3ceb6ffeca`（工作區乾淨）
- 對應 Plan：§3（CI fixture）、§7／§8（完整安裝、layout 2）、§9（舊快取遷移）、§19.1（檔案矩陣）、§22（測試矩陣）
- 狀態：**完成**（POSIX-only 行為未在本機 Windows 實跑，見 §6）
- Git：全部變更**未提交**；唯一 staged 項是 `fixtures/fake-basemind.sh` 的模式變更（D2=A）

---

## 1. 根因確認

| # | 根因 | 確認方式 |
| --- | --- | --- |
| 1 | `test/index.test.mjs` 在 POSIX 把 `fixtures/fake-basemind.sh` 複製到 `os.tmpdir()`，而該腳本用 `$BASH_SOURCE` 解析同目錄的 `fake-mcp-server.mjs`，複製後解析失敗 → `serve` 起不來 → 3 個測試各 15 s timeout（Ubuntu 48 s、Windows 8 s） | 程式碼閱讀＋MSYS bash 重現（複製後 `--version` OK、`serve` 噴 `MODULE_NOT_FOUND`）＋CI step 耗時 |
| 2 | `installPinned()` 只解壓主 binary（`extractSingleFile` + root-level entry），丟掉 `lib/`、root DLL 與 9–11 個授權檔；`install.json` 只有主 binary 的 size/mtime，無法發現不完整 | 四平台 archive entry 清單＋PE／ELF／Mach-O 依賴分析＋Windows 實測 `0xC0000135` |

---

## 2. 修改檔案與關鍵行為

### 2.1 CI 測試夾具

| 檔案 | 變更 |
| --- | --- |
| [fixtures/fake-basemind.sh](../fixtures/fake-basemind.sh) | 內容 0 行變更；git index 模式 `100644 → 100755`（`git update-index --chmod=+x`），磁碟同步 `chmod +x` |
| [test/index.test.mjs](../test/index.test.mjs) | 移除「複製到 tmpdir＋chmod」分支與 `fakeBasemindPath` 狀態；POSIX 直接就地使用 `FAKE_BASEMIND`；新增 POSIX preflight `assert.ok((statSync(...).mode & 0o111) !== 0, '…git update-index --chmod=+x…')` |

### 2.2 完整安裝（layout 2）

| 檔案 | 變更 |
| --- | --- |
| [lib/binary/archive.js](../lib/binary/archive.js) | 新增 `export async function extractArchive({ archive, kind, destDir, limits, fs })` → `{ files: [{ path, size }], bytes }`（path 排序、forward slash）。單檔與整樹共用同一組 tar／zip 解析器（`walkTarGz` + sink、`scanZipDirectory` + `readZipEntryData`）。保留全部既有防護，另加「`path.resolve` 後必須在解析後 `destDir` 內」。支援 nested 路徑、目錄 entry（含 Windows zip 的空 `lib/`）、POSIX `0755/0644` 模式、宣告大小校驗（`size-mismatch`）、失敗時關閉 handle 並由 caller 清 destDir（JSDoc 明示契約）。`DEFAULT_MAX_*` 未動；`extractSingleFile` 簽名／錯誤碼／行為不變 |
| [lib/binary/manager.js](../lib/binary/manager.js) | `INSTALL_LAYOUT = 2`、`INSTALL_LIMITS = { maxTotalBytes: 2 GiB, maxEntryBytes: 1 GiB }`、`RENAME_ATTEMPTS = 5`／`RENAME_RETRY_MS = 200`。`installPinned()`：解整包到 `staging/extracted/` → 驗證 root-level 主 binary 是 regular file → POSIX `chmod 0755` → probe＋exact policy → 走訪磁碟樹產生 `files[]` → 寫 `install.json`（`layout, version, target, sha256, url, tag, installedAt, binary, size, mtimeMs, files`）並**讀回確認** → 舊目錄 rename 成 `.old-*` → bounded retry rename 新目錄進 target → 成功後刪舊；失敗則還原 `.old-*` 並丟出含「close other DSH windows and restart DSH」的錯誤。`readManagedCache()`：要求 `layout === 2` 且 `files[]` 非空，否則回 `undefined`（**不先刪除**）；逐檔 stat 檢查存在／regular／大小；probe＋policy 如舊；只在 size/mtime 與記錄不同時 hash 主 binary。`binaryPath()` 讀 `install.json.binary`（fallback `target.binary`）。新增 `renameFn` 測試 seam |

### 2.3 診斷

| 檔案 | 變更 |
| --- | --- |
| [lib/status.js](../lib/status.js) | cache facts 增加 `layout`、`fileCount`、`missingFile`、`present`；`managed cache` 行在不完整時加 ` - incomplete`；新增 `cache layout : 2 (N files)`（非 2 顯示 `- re-download required`）、`cache binary : present\|missing`、`cache missing : <第一個缺檔>`；沿用 100 欄上限與 redaction |

### 2.4 測試

| 檔案 | 新增／調整 |
| --- | --- |
| [test/binary-archive.test.mjs](../test/binary-archive.test.mjs) | +9 案例：tar.gz `./` 前綴整樹＋mode、zip root DLL＋空 `lib/`＋licenses、nested `..` 逃逸、duplicate、win32 case-variant、symlink/hardlink/device、entry/size/count 上限、mid-tree 失敗後 caller 清空、`extractSingleFile` 仍只寫主 binary |
| [test/binary-manager.test.mjs](../test/binary-manager.test.mjs) | `seedCache` 改寫 layout-2、新增 `seedLayout1Cache`；+8 案例：完整樹記錄、layout-1 視為不完整並重裝、缺 `lib/libheif.so.1`／Windows `heif.dll` 偵測重裝、`binaryPath` 跟隨記錄、安裝失敗保留舊目錄並清 staging、rename 鎖定 5 次後 actionable 失敗且舊樹還原 |
| [test/binary-install-layout.test.mjs](../test/binary-install-layout.test.mjs)（新） | 以**真實 `extractArchive`**（只 mock 網路／downloader／probe）驗證 Windows-shaped zip 與 Linux-shaped tar.gz 的實體目錄樹、`install.json` 內容、POSIX 模式（win32 跳過）、layout-2 快取零網路零解壓重用 |
| [test/status.test.mjs](../test/status.test.mjs) | +4 案例：完整 layout-2、缺檔、layout-1 需重下載、主 binary 遺失 |

### 2.5 文件

| 檔案 | 變更 |
| --- | --- |
| [README.md](../README.md)、[README.zh.md](../README.zh.md) | §6 移除「adopting a cache」；§7 改為「安裝完整 release tree（binary＋`lib/`／root DLL＋授權檔）＋磁碟 230–320 MB＋layout-1 一次性重下載」，並說明四平台為何單檔不可啟動；§9 快取說明改為 layout 2、快取命中需整棵樹存在、移除「pre-seed 單一 binary」建議 |
| [CHANGELOG.md](../CHANGELOG.md) | `[Unreleased]` 新增 Fixed（Critical managed install、CI fixture）與 Changed（layout 2、一次性重下載、`/basemind-status` 新欄位）；未 bump `package.json` |

---

## 3. 驗證結果

工作目錄：`D:\02_zengjunlin\github\dsh-basemind-plugin`

| # | 命令 | 結果 |
| --- | --- | --- |
| 1 | `node --test test/binary-archive.test.mjs test/binary-install-layout.test.mjs test/binary-manager.test.mjs test/binary-concurrency.test.mjs test/status.test.mjs test/index.test.mjs` | **137 tests / 137 pass / 0 fail / 0 skip** |
| 2 | `npm run check` | `syntax ok: 20 files`、`bundle manifest ok` |
| 3 | `npm run check:skills` | `10 skills, 20 files match skills/UPSTREAM.json (v0.34.0)` |
| 4 | `npm run check:pack` | `pack contents ok: 52 files`（`pack.json` 已刪除） |
| 5 | `npm run verify`（lead 獨立重跑） | **416 tests / 416 pass / 0 fail / 0 skip**，`duration_ms 29113.65`；check／check:skills／check:pack 全過 |
| 6 | MSYS bash：`bash fixtures/fake-basemind.sh --version` | `basemind 0.34.0`（exit 0） |
| 7 | MSYS bash：`timeout 5 bash fixtures/fake-basemind.sh serve < /dev/null` | exit 0、stderr 空（不再 `MODULE_NOT_FOUND`） |

### 3.1 真實 Managed Binary 端到端（Windows，lead 獨立執行）

用一次性腳本（不進 repo）直接驅動 `createBinaryManager`，**先**把 `PATH` 設成 `C:\Windows\system32;C:\Windows`（排除本機 `C:\Users\sanny\AppData\Local\Programs\basemind` 的 DLL 假陽性），`DSH_HOME` 級 cache 指到暫存目錄：

| 項目 | 結果 |
| --- | --- |
| 冷啟動安裝（真實下載 75,627,742 bytes、真實 SHA256、真實整包解壓、真實 probe） | **成功，13,068 ms** |
| `selection` | `{ ok: true, source: 'managed', version: '0.34.0', verified: true, policy: 'exact' }` |
| 安裝目錄 | `ATTRIBUTIONS.md`、`LICENSE`、`THIRD_PARTY_LICENSES`、`basemind.exe`、`heif.dll`、`libde265.dll`、`lib/`、`licenses/`（6 檔）、`install.json` |
| `install.json` | `layout 2`、`binary basemind.exe`、`files 12`、`size 226,144,768`、`tag v0.34.0` |
| 以淨化 PATH 直接執行已安裝 binary | `basemind 0.34.0`，**exit 0**（修復前同樣條件是 `0xC0000135`） |
| 第二次 `select()`（`fetchImpl` 直接拋錯＝斷網） | **重用成功、0 次網路、39 ms**，路徑相同 |

這一組是 §7.2 缺陷的直接反面證據：同一個淨化 PATH 下，修復前無法啟動，修復後可啟動，且快取重用零網路。

---

## 4. 與 Plan 的偏差

| # | 偏差 | 理由 | 影響 |
| --- | --- | --- | --- |
| 1 | `install.json.files[]` 由解壓後的 staging 目錄**實際走訪**產生（`listInstalledFiles`），而非直接採用 `extractArchive()` 的回傳 | record 必須等於磁碟實況；且既有 `extractor` seam 的 fixtures（`fixtures/fake-managed-select.mjs`、concurrency 測試）只寫 `destFile`，不在本次允許修改清單 | 無（`extractArchive` 仍依規格回傳 deterministic `files`，並有獨立測試） |
| 2 | 既有測試「an adopted cache without an install record gains one」替換為「single binary is incomplete: not adopted, not deleted」 | 與已確認決策 D4／Plan §9.2 直接衝突；新測試更嚴格（不 adopt、不刪除、斷言 0 網路、不寫 record） | 行為變更已寫入 README／CHANGELOG |
| 3 | zip 單檔解壓仍走原本 `fs.writeFile` 路徑，整樹才用 open handle | 讓 `extractSingleFile` 行為完全一致，降低回歸風險 | 無 |
| 4 | `extractArchive` 未新增 `signal` 參數 | 原本就沒有取消入口；Plan 明令不發明 caller 用不到的公開參數 | 取消語意＝manager 中止下載＋清 staging |
| 5 | `/basemind-status` 把缺檔放在獨立 `cache missing` 行，而非 `cache: incomplete (missing …)` 單行 | 既有 100 欄硬限制 | 資訊等價 |
| 6 | 新增 `renameFn` 測試 seam 與 install record 讀回驗證 | 完成本次正確性所需的最小擴充 | 無 |

---

## 5. 本輪額外確認（不屬於修改，但屬審查結論）

- `lib/binary/probe.js` 的 spawn spec **不帶 `env`**，因此 probe 繼承 Host 環境（含 PATH）。這正是修復前「PATH 上的 DLL 讓單檔安裝看起來可用」的機制；修復後整包已含所有依賴，該繼承不再造成假陽性，**故不改**（避免為既有行為引入無必要差異）。
- 本機 BaseMind 已是 0.34.0（官方 Release 佈局），修正 Plan §6.6 引用的舊版本記憶。

---

## 6. 未驗證與剩餘風險

| 項目 | 說明 |
| --- | --- |
| POSIX 權限與 preflight 斷言 | tar `0755/0644`、zip `0755`、`test/index.test.mjs` 的 POSIX 分支只會在 Linux／macOS 執行；本機 Windows 依設計跳過。**需下一次 Ubuntu CI 證實** |
| Ubuntu CI 由 48 s 回到約 8–12 s | 需 push 後的 run URL 佐證；本機無法代替 |
| Windows rename 真實檔案佔用 | 只以注入 fs 失敗驗證（5 次嘗試、可診斷訊息、舊樹還原）；真實被佔用的行為待 CI／實機 |
| Linux／macOS 真實整包安裝 | Windows 已用真實 230 MB 樹證明；Linux／macOS 的 `lib/*.so`／`*.dylib` 尚待 Phase 2 的 managed CI |
| 完整性檢查為 stat-only | 同大小但內容損壞的 `lib/*.so*` 不會被偵測（Plan 明確選擇不 hash 整樹）；主 binary 在 size/mtime 變動時仍會 hash |
| Managed integration test | 本輪**未新增**（屬 Phase 2）；目前 `npm test` 的 integration 走 PATH 上的本機 BaseMind，不覆蓋 managed 路徑 |
| 舊 adoption 行為移除 | 手放的單一 binary 快取視為不完整；升級會有一次 75–102 MB 下載與 230–320 MB 磁碟成本（已寫入 README／CHANGELOG） |

---

## 7. 交付狀態

```
 M CHANGELOG.md
 M README.md
 M README.zh.md
M  fixtures/fake-basemind.sh          (僅模式 100644 → 100755，內容 0 行變更)
 M lib/binary/archive.js
 M lib/binary/manager.js
 M lib/status.js
 M test/binary-archive.test.mjs
 M test/binary-manager.test.mjs
 M test/index.test.mjs
 M test/status.test.mjs
?? docs/2026-11-24-basemind-stability-feature-parity-plan.md
?? docs/2026-11-24-basemind-stability-phase1-execution-report.md
?? test/binary-install-layout.test.mjs
```

- 未執行 `git add`（fixture 模式除外，D2=A 明列）、`git commit`、`git push`、`git tag`、`npm publish`、`npm version`、`release*`。
- 未修改 desktop profile、使用者 BaseMind data home、PATH 或任何全域設定。
- 臨時端到端腳本位於系統暫存目錄，已於跑完後刪除。

**下一步（等人工確認）：** Phase 2 —— `test/integration-managed.test.mjs`、`managed-binary.yml` 冷快取三平台、CI 失敗摘要 artifact、Desktop 驗收 D1–D15。

---

## 8. Fix round 1（回應 [Phase 1 Review](./2026-11-24-basemind-stability-phase1-review.md)）

| Finding | 判定 | 實作 |
| --- | --- | --- |
| F1 `.old-*` 沒有回收／還原路徑 | 成立，已修 | 新增 `recoverParkedTrees()`：在 `runSelection()` 起點（**先確認沒有進行中的 install lock**，避免打斷別的 process 的 swap）與 `installPinned()` 鎖內各執行一次；若 target 不存在且只有 parked tree → 把最新的 rename 回 target（零下載），其餘 `.old-*` best-effort 刪除、失敗升級為 `warn`。restore 改走 `renameWithRetry()`（可注入、會重試），失敗訊息帶 `.old-*` 路徑；成功安裝後刪除舊樹失敗也從 `debug` 升為 `warn`。`/basemind-status` 新增 `cache parked` 行。 |
| F2 `install.json.sha256` 是 archive digest 卻比對主 binary | 成立，已修 | 安裝時對 staged 主 binary 計算一次 `binarySha256` 寫入 record；`isLayout2()` 要求它存在（沒有它無法自證內容 → 視為不完整）；`readManagedCache()` 改比對 `binarySha256`；`sha256` 保留為下載 archive 的 digest。`files[]` 仍只做 stat。 |

**新增／調整測試**

| 檔案 | 案例 |
| --- | --- |
| [test/binary-manager.test.mjs](../test/binary-manager.test.mjs) | `a layout-2 record without a binary digest is treated as incomplete`、`an interrupted swap is recovered from the parked .old tree without a download`；locked-rename 的注入器改為只封鎖 swap、放行 restore |
| [test/binary-install-layout.test.mjs](../test/binary-install-layout.test.mjs) | `sha256` 與 `binarySha256` 用不同 digest，並分別斷言兩者語意 |
| [test/status.test.mjs](../test/status.test.mjs) | `a parked tree from an interrupted swap is named and promised to be restored` |

**驗證**

| 命令／情境 | 結果 |
| --- | --- |
| `npm run verify`（Fix round 後重跑） | **419 tests / 419 pass / 0 fail / 0 skip**；`syntax ok: 20 files`、`bundle manifest ok`、`pack contents ok: 52 files` |
| 真實 Windows 冷安裝（淨化 PATH） | 成功；record 為 `layout 2`，`sha256`（archive）與 `binarySha256`（binary）**不相同** |
| 真實「只改 mtime、內容不變」 | 換一個 manager（`fetchImpl` 直接拋錯）→ **重用成功**、`hashes = 1`、**0 次網路**、398 ms、`basemind 0.34.0`。修復前此情境會判定 mismatch、刪掉整棵樹並重下 75 MB |
| 快取重用（第二次 select） | 39 ms、0 網路（先前 e2e 結果維持） |

**接受殘留**：若「成功 swap 後刪除 `.old-*`」失敗，該目錄會留到下一次選型（`runSelection()` 起點）或下一次安裝（鎖內）才由 `recoverParkedTrees()` 處理。不在每次 `select()` 掃描，以免把診斷成本放進熱路徑。

> **勘誤（2026-11-24，Phase 2 補正）**：上一版此段寫「留到下一次**安裝**才清掉」，實際是**下一次選型**就會執行 `recoverParkedTrees()`；同句「status 可見」只在 target 缺失時成立（`parkedTree` 僅在 `present === false` 時計算）。程式行為正確，屬描述偏差。另外 Phase 2 已把清除條件收緊為「target 本身是完整 layout-2 安裝」才刪除 `.old-*`，詳見 [Phase 2 Execution Report](./2026-11-24-basemind-stability-phase2-execution-report.md) §14。

**仍未驗證**：與 §6 相同（POSIX 實跑、Ubuntu CI、真實 Linux/macOS 整包安裝、Windows 真實檔案佔用下的 restore）。
