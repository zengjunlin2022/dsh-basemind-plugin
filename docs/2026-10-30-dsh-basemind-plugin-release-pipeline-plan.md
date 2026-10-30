# dsh-basemind-plugin 發佈與文件補強計劃

- 日期：2026-10-30
- 狀態：**已確認並實施**（決策記錄見文末 §11）
- 範圍：README 補強（英/中）、DSH 0.2.1-rc.5 兼容性確認、GitHub Releases 自動化、插件發佈自動化、可選上架渠道
- 基準：`main` @ `f122036`，工作區乾淨，尚無任何 tag / workflow

---

## 0. 結論摘要

| 需求 | 結論 | 需要你確認 |
|---|---|---|
| 1. README 安裝/使用 + basemind 文檔入口 | 目前 README 的安裝章節只寫「本地目錄安裝」，且明言「未發佈到 npm」；需改寫為 registry 安裝為主、本地 link 為輔，並新增使用示例與 basemind 文檔入口 | 文檔入口除 introduction 外是否加 installation / quickstart |
| 2. README 中文版 | 建議 `README.zh.md` + 雙向語言切換；內容與英文版同構 | 用 `zh` 還是 `zh-TW` |
| 3. DSH 0.2.1-rc.5 兼容性 | **目前可運行、已實測通過**（9 個工具 + 2 個 resource 已註冊，`mcp__basemind__admin` 實際調用成功）。但 `package.json` 宣告的 `dsh.compatibility` **DSH 根本不讀**，等於沒有版本閘門；需改為 `engines.dsh` | 支援範圍採 `>=0.2.1-rc.3 <0.3.0-0`（建議）或其他 |
| 4. GitHub Releases 自動化 | 可行，且是純 repo 內工作，不需要額外權限（tag push 觸發）；建議與 CI、npm 發佈串成一條 tag 驅動流水線 | 是否允許由 Actions 建立 Release；是否要 pre-release 通道 |
| 5. 發佈插件自動化 | 可行。主渠道 = npm public registry（名稱 `dsh-basemind-plugin` 目前未被佔用）+ GitHub Release tarball；可選 = 自架 market index / awesome-dsh-plugin 上架 PR | npm 帳號與認證方式、套件名、是否做 market index/上架 |

**一句話建議**：以 `v*` tag 為唯一發佈觸發點，一條 workflow 完成「驗證 → npm publish（provenance）→ GitHub Release（含 tarball）」，另以 CI 守 PR；market index 與 awesome-dsh-plugin 列為可選第二階段。

---

## 1. 現況（已確認事實與證據）

| 項目 | 現況 | 證據 |
|---|---|---|
| 套件 | `dsh-basemind-plugin@0.1.0`，`private: true`，零依賴 ESM | `package.json` |
| bundle 宣告 | `dsh.bundle.patch: ./cordis.patch.yml`，patch 插入 `id: dsh-basemind` | `package.json`、`cordis.patch.yml` |
| 兼容宣告 | `dsh.compatibility.dsh: ">=0.2.1-rc.3"`；`engines.node: ">=22"` | `package.json` |
| 已安裝 DSH | **0.2.1-rc.5** | `dsh --version`；`resources/app.asar/package.json` version |
| 插件在 rc.5 的實際狀態 | 已載入：9 個 `mcp__basemind__*` 工具、2 個 resource（`basemind://status`、`basemind://repo/map`）；`mcp__basemind__admin {mode:"repo"}` 回傳本 repo 的 workdir/HEAD | 本會話工具清單、`list_mcp_resources`、實際調用 |
| 版本閘門 | DSH 的 `evaluatePluginCompatibility()` 先讀 `engines.dsh`，否則讀 `@deepseek-ai/dsh*` peerDependencies，並以 `includePrerelease: true` 比對；**全庫搜尋 `dsh.compatibility` 0 命中** | `@deepseek-ai/dsh-app-boot/lib/index.js:279-326` |
| Git | 遠端 `https://github.com/zengjunlin2022/dsh-basemind-plugin.git`（public），單一 commit，無 tag | `git remote -v`、`git tag` |
| 自動化 | 無 `.github/`；無 LICENSE 檔；無 `.gitignore` | 檔案樹 |
| npm | `dsh-basemind-plugin` 在 registry 回應 404（**名稱未佔用**，但未註冊即無保留） | `npm view dsh-basemind-plugin version` |
| 套件內容 | `files` 已含 `index.js`、`lib/**/*.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`README.md`；未含 `docs/`、`test/`、`fixtures/` | `package.json` |
| 本地測試 | **受 sandbox 限制無法執行**：`node --test` 全部失敗於 `spawn EPERM`（預設與 `--test-isolation=none` 皆同） | 實際執行輸出 |
| basemind 文檔入口 | `https://basemind.ai/start/introduction/` HTTP 200；`/start/installation/`、`/start/quickstart/` 亦 200 | `web_fetch` |
| 社群目錄 | `awesome-dsh-plugin` 以 `data/plugins/<owner>__<repo>.yml` 收錄；要求 `dsh.bundle`、`cordis.patch.yml`、repo ≥1 天、`dsh-plugin` topic | 其 `contributing.md` |
| DSH market index | format 1 JSON；本機 DSH 內建 validator；`@deepseek-ai/dsh-plugin-market-index@0.2.1-alpha.4` 已上 npm，可於 CI 驗證 | DSH 原始碼 + npm |

---

## 2. 需求逐項分析

### 2.1 README 安裝與使用方法 + basemind 文檔入口

**現況缺口**

1. §3 Install 只描述「用 DSH plugin manager 指向本目錄」的 linked local install，並明言「套件未發佈到 npm」；一旦發佈，這段就是錯的。
2. 沒有「如何確認裝好了」的步驟（例如呼叫 `mcp__basemind__admin` `mode: status` 看 `root`）。
3. 使用方式散落在 §5/§6，缺少一個可直接照抄的 Quick Start（3–5 個範例）。
4. 沒有任何指向 basemind 官方文檔的入口。
5. §2 Requirements 寫「DSH >= 0.2.1-rc.3，declared in `dsh.compatibility`」——這個宣告 DSH 不讀（見 2.3），敘述與事實不符。

**建議結構**（英文版為主，中文版同構）

```
# dsh-basemind-plugin
English | 繁體中文
badges（npm / CI / license，可選）
> 一句話 + 三個連結：Introduction / Installation / Quickstart

## 1. What it is / why
## 2. Requirements
     - DSH 版本（engines.dsh 實際範圍 + 已驗證 0.2.1-rc.5）
     - basemind 可執行檔 + 安裝入口（官方文檔）
     - Node >= 22（僅 package 宣告）
## 3. Install
     3.1 先安裝 basemind（連官方 Installation 文檔）
     3.2 安裝本 bundle：DSH Plugins 頁 / CLI 指令
     3.3 從原始碼安裝（開發者 link:）
     3.4 驗證安裝（admin status / 9 個工具）
     3.5 更新與移除
## 4. Quick start（使用示例）
     outline / symbols / references / git blame_symbol / graph map
## 5. Configuration
## 6. How it works
## 7. Tools and resources
## 8. Lifecycle
## 9. Known limitations
## 10. Coexistence
## 11. Troubleshooting
## 12. Development
## 13. License
```

**文檔入口**（已驗證 200）

- 主要入口（你指定）：<https://basemind.ai/start/introduction/>
- 建議同時連：Installation <https://basemind.ai/start/installation/>、Quickstart <https://basemind.ai/start/quickstart/>、MCP tools / CLI reference（若你同意，我可再核對實際路徑）

### 2.2 README 中文版

- 建議檔名 `README.zh.md`（DSH 生態與 `awesome-dsh-plugin` 皆以 `zh` 表示中文），內容為完整翻譯而非摘要；英文版維持 source of truth（兩版任一變更需同步）。
- 兩份 README 頂部加語言切換：`English | [繁體中文](README.zh.md)` / `[English](README.md) | 繁體中文`。
- 需確認：內容用**繁體中文**（你的習慣）但檔名用 `zh`，或改用 `README.zh-TW.md`。前者符合生態慣例，後者語系更精確。

### 2.3 DSH 0.2.1-rc.5 兼容性

**已確認（有證據）**

1. 已安裝 DSH = `0.2.1-rc.5`。
2. 插件在 rc.5 下**已載入且可用**：
   - 9 個 `mcp__basemind__*` 工具全部註冊；
   - 2 個 resource 可列出；
   - `mcp__basemind__admin {mode:"repo"}` 回傳本 repo 的 `workdir` / `head_sha`，代表 relay 行程、MCP handshake、工具調用鏈全部正常。
3. 插件只 import Node 內建模組與自身 `lib/*`，不 import 任何 `@deepseek-ai/*`（`grep` 確認），因此不存在 DSH 套件 peer 依賴解析問題。

**發現的問題**

- `dsh.compatibility` **不是 DSH 認識的欄位**。DSH 的檢查邏輯是：先看 `engines.dsh`（有就單獨決定），否則檢查 `peerDependencies` 中所有 `@deepseek-ai/dsh*`；任一不滿足即拒絕安裝/啟動（可用 profile 的 `compatibility.json` 做精確版本豁免）。搜尋 0.2.1-rc.5 全部套件，`dsh.compatibility` 0 命中。
- 後果：目前這個 bundle 對 DSH 版本**完全沒有閘門**，任何 DSH 版本都會被允許安裝；若未來 DSH 破壞性變更，使用者會直接撞上執行期錯誤，而不是安裝期提示。

**建議修改**

1. `package.json` 增加
   ```json
   "engines": { "node": ">=22", "dsh": ">=0.2.1-rc.3 <0.3.0-0" }
   ```
   - `includePrerelease: true` 下，`0.2.1-rc.5` 滿足此範圍；同時擋掉未驗證的 `0.3.x`。
   - 若你想放寬到「任何未來版本」，可只用 `>=0.2.1-rc.3`，但不建議（等於沒有上限）。
2. 移除 `dsh.compatibility`（或保留但於 README 標明僅為說明）。保留兩個相似欄位容易誤導後續維護者。
3. README 的 Requirements 改寫為「`engines.dsh` 宣告範圍；本版本已於 0.2.1-rc.5 實測」。
4. CI 加一個「manifest 檢查」步驟：`engines.dsh` 存在、`dsh.bundle.patch` 檔案存在、`files` 涵蓋執行期檔案。
5. 本地測試目前被 sandbox 擋住（spawn EPERM），**兼容性的最終回歸驗證必須在 GitHub Actions 上跑**（或經你批准以 danger-full-access 在本機跑一次）。

### 2.4 GitHub Releases 自動化

**目標**：push `vX.Y.Z` tag → 自動驗證 → 建立 GitHub Release，附上可下載 tarball 與自動 release notes。

**必要條件**（全部可在 repo 內完成，無需外部權限）

- workflow `permissions: contents: write`；
- 用 runner 內建的 `gh release create`（避免第三方 action，供應鏈面更小）；
- tag 與 `package.json.version` 必須一致，不一致直接失敗；
- 先跑測試，測試不過不建 Release；
- 支援 pre-release（版本號含 `-` 時 `--prerelease`）。

**建議併入同一條 release 流水線**（見 §4），而不是獨立 workflow，避免「Release 建了但 npm 沒發」或反之。

### 2.5 發佈插件自動化

「發佈」在 DSH 生態有 4 條渠道，性質不同：

| 渠道 | 是什麼 | 自動化程度 | 是否需要你提供憑證 |
|---|---|---|---|
| **npm public registry** | `dsh plugin add dsh-basemind-plugin` 的來源；DSH plugin manager 以 npm spec 安裝、`saveExact: true` | 可全自動 | 需要（首次發佈 token / 之後 OIDC） |
| **GitHub Release tarball** | 附在 Release 的 `.tgz`，可作為 tarball spec 安裝；也是 awesome-dsh-plugin 的 `tarball:` 欄位來源 | 可全自動 | 否（GITHUB_TOKEN 即可） |
| **自架 market index** | format-1 JSON，使用者在 DSH Discover 加入 URL 後可搜尋/安裝/看版本 | 可全自動（GitHub Pages） | 需啟用 Pages |
| **awesome-dsh-plugin 目錄** | 社群 catalog（dshmarket 與 DSH Discover 共用）；一插件一 YAML，PR 收錄 | 半自動（PR 需人手/憑證） | 需你的 GitHub 授權 |
| （官方 on-demand catalog） | DSH 內建的 `OFFICIAL_ON_DEMAND_CATALOG`，DeepSeek 精選 | 不可自動化 | 需 DeepSeek 審核 |

**建議**

- **P0（必做）**：npm publish + GitHub Release。這是「安裝得到、更新得到」的最小閉環。
- **P1（可選）**：自架 market index（一個 JSON 放 GitHub Pages，workflow 發版後自動更新）。成本低，能讓使用者在 Discover 裡直接看到。
- **P2（可選）**：向 `awesome-dsh-plugin` 提一個 `data/plugins/zengjunlin2022__dsh-basemind-plugin.yml`。此後版本更新由 catalog 自動從 npm 讀取，**不需要每次發版都提 PR**。
- **P3（可選）**：官方 catalog 收錄，只能透過 DeepSeek 渠道申請，不納入本次自動化。

---

## 3. 推薦流水線架構

### 3.1 分支與版本模型

- `main` 永遠可發佈；版本以**手動 bump `package.json` + annotated tag `vX.Y.Z`** 為準。
- 第一版 `v0.1.0`；pre-release 用 `v0.2.0-rc.1`（npm dist-tag `next`）。
- 不引入 release-please / changesets（單一維護者、無依賴、changelog 可由 GitHub 自動 notes 產生；等版本節奏變快再升級）。

### 3.2 `.github/workflows/ci.yml`（PR / main）

- 觸發：`pull_request` + `push` to `main`。
- 矩陣：`ubuntu-latest` × Node 22/24、`windows-latest` × Node 24（Windows 是本插件的主要使用平台，`.cmd` launcher 邏輯需覆蓋）。
- 步驟：checkout → setup-node → `node --test` → `node --check index.js` 與 `lib/*.js` → `npm pack --dry-run` 檢查打包內容 → manifest 檢查（`engines.dsh`、patch 檔存在）。
- 只讀權限 `contents: read`。

### 3.3 `.github/workflows/release.yml`（tag `v*.*.*`）

- 權限：`contents: write`、`id-token: write`（npm provenance / Trusted Publishing）。
- 併發：`concurrency: release-<tag>`，禁止並行。
- 建議加 `environment: release`（可選 required reviewers，作為發佈閘門）。
- 步驟順序：
  1. checkout（`fetch-depth: 0`）
  2. 驗證 tag 與 `package.json.version` 一致（不一致即 fail）
  3. `node --test`
  4. `npm pack`（產生 `dsh-basemind-plugin-<version>.tgz`）
  5. **npm publish**（見 3.3.1 認證）
  6. `gh release create <tag> --verify-tag --generate-notes`，附 tgz（+ `sha256` 檔）
  7. 發佈後驗證：`npm view dsh-basemind-plugin@<version> version`；失敗則整個 job 紅
- 冪等：若 `npm view` 已存在同版本，跳過 publish（可重跑）；Release 已存在則 `gh release upload --clobber` 更新資產。

**3.3.1 npm 認證（已定：Trusted Publishing / OIDC）**

- workflow 具 `id-token: write`，`npm publish` 不帶 token；npm CLI 會把 GitHub OIDC token 換成短效發佈憑證。
- 前置：npm CLI ≥ 11.5.1（Node 24 runner 內建），且套件已存在於 registry。
- npmjs.com → Packages → `dsh-basemind-plugin` → Settings → Trusted publishing → GitHub Actions：
  - Organization or user：`zengjunlin2022`
  - Repository：`dsh-basemind-plugin`
  - Workflow filename：`release.yml`
  - Environment name：留空
  - **Allowed actions：必須勾選 `npm publish`**（2026-09-03 之後建立的設定預設只允許 `npm stage publish`）
- 首發 bootstrap（必要，無法省略）：
  1. 本機 `npm login`（2FA）後手動 `npm publish --access public` 發佈 0.1.0；
  2. 在 npmjs.com 設定上述 trusted publisher；
  3. **2 天內**完成第一次 trusted publish 以驗證設定（逾期設定失效，只能刪除重建）。
- provenance：Trusted Publishing 在公開 repo + 公開套件下自動產生，`--provenance` 不再需要。
- 不再使用 `NPM_TOKEN` 或任何長期 token，GitHub repo 也不需要設定 secret。

### 3.4 `.github/workflows/market-index.yml`（可選 P1）

- 觸發：`release: published`。
- 由 `package.json` + `locale/*.json` 產生 format-1 `index.json`（`title`/`description` 用 `{en, zh}`；`source: {type:"npm"}`；`engines.dsh` 帶入）。
- 以 `@deepseek-ai/dsh-plugin-market-index` 在 CI 驗證（npm 上已有 0.2.1-alpha.4）。
- 部署到 GitHub Pages（`gh-pages` 分支）→ 使用者 index URL：`https://zengjunlin2022.github.io/dsh-basemind-plugin/index.json`。
- 需在 GitHub repo Settings → Pages 啟用 Pages。

### 3.5 awesome-dsh-plugin 上架（可選 P2）

- 一次性 PR：新增 `data/plugins/zengjunlin2022__dsh-basemind-plugin.yml`：
  ```yaml
  url: https://github.com/zengjunlin2022/dsh-basemind-plugin
  name: zengjunlin2022/dsh-basemind-plugin
  category: dev            # 待確認：dev / tools
  description:
    en: Workspace-aware BaseMind MCP bridge for DeepSeek Harness.
    zh: 讓 DeepSeek Harness 每個工作階段直接使用 BaseMind 的程式碼理解能力。
  ```
- 前置：repo 加 `dsh-plugin` topic（≥1 天已滿足）、描述必須與實作相符。
- 若同時做了 npm 發佈，catalog 會自動關聯下載量；後續版本不需要再提 PR。

### 3.6 安全與供應鏈

- Actions 以 `uses: actions/checkout@v4` 等主流版本（或 pin SHA）；不引入來源不明的 action。
- `permissions` 最小化；`pull_request_target` 一律不用。
- npm `--provenance` 產生可驗證的來源證明（public repo 可行）。
- Release 附 `sha256sums.txt`，README 提供校驗方式（可選）。
- 不把任何 token 寫進 repo；secret 只在 GitHub Settings 設定。

---

## 4. README 改版要點（需求 1 + 2）

### 4.1 英文版

1. 標題下加 `English | [繁體中文](README.zh.md)`。
2. 開頭加「本文件 + basemind 官方文檔」三個連結。
3. 重寫 §2 Requirements：
   - DSH：`engines.dsh` 實際範圍 + 「已於 0.2.1-rc.5 實測」；
   - basemind：安裝入口（官方文檔），並說明 plugin 不會自動安裝/掃描索引。
4. 重寫 §3 Install：
   - 3.1 Install basemind（連官方 Installation）
   - 3.2 Install this bundle（DSH Plugins 頁 / `dsh plugin --profile <profile> add dsh-basemind-plugin`）
   - 3.3 From source（`link:`，開發用）
   - 3.4 Verify（`mcp__basemind__admin` `{mode:"status"}`；確認 9 個工具）
   - 3.5 Update / remove
5. 新增 §4 Quick start：5 個可複製示例（outline、symbols、references、blame_symbol、graph map），並說明 `mode` 與 `mcp__basemind__` 前綴。
6. 後續章節順延；修正「未發佈到 npm」「dsh.compatibility」等過時敘述。
7. 可選：npm / CI / license badges。

### 4.2 中文版

- `README.zh.md` 完整對譯，結構與英文版一致；頂部 `[English](README.md) | 繁體中文`。
- 專有名詞保留英文（MCP、bundle、workspace、relay、profile）。
- 兩版同步維護規則寫在 Development 章節。

---

## 5. `package.json` 調整清單（發佈前置）

| 欄位 | 現在 | 建議 | 原因 |
|---|---|---|---|
| `private` | `true` | 移除 | 否則 `npm publish` 直接拒絕 |
| `engines.dsh` | 無 | `">=0.2.1-rc.3 <0.3.0-0"` | 讓 DSH 真正做版本閘門 |
| `dsh.compatibility` | `{dsh: ">=0.2.1-rc.3"}` | 移除（或保留但標註說明） | DSH 不讀，避免誤導 |
| `publishConfig` | 無 | `{ "access": "public" }` | 明確公開發佈 |
| `repository` | 無 | `git+https://github.com/zengjunlin2022/dsh-basemind-plugin.git` | npm 頁面/dependents 關聯；awesome-dsh-plugin 也要求套件 repository 指回原 repo |
| `homepage` | 無 | GitHub README 或 basemind.ai 頁 | npm 頁面 |
| `bugs` | 無 | GitHub issues | npm 頁面 |
| `keywords` | 無 | `dsh`, `dsh-plugin`, `basemind`, `mcp`, `deepseek-harness` | 搜尋 |
| `files` | 已列執行期檔案 | 保持；新增 `LICENSE` 由 npm 自動包含 | — |
| `scripts` | `test` | 可加 `check`（`node --check`）供 CI 用 | 可選 |

另需新增：`LICENSE`（MIT，需著作權人/年份）、`.gitignore`（`node_modules/`、`.npm-cache/`、`*.tgz`）、可選 `CHANGELOG.md`。

---

## 6. 驗證計畫

| 驗證 | 方式 | 備註 |
|---|---|---|
| 單元/整合測試 | GitHub Actions：Ubuntu Node 22/24、Windows Node 24 | 本地被 sandbox 擋（spawn EPERM），需 CI 或批准 danger-full-access |
| 打包內容 | `npm pack --dry-run` + 檢查 tgz 檔案清單 | 確認 `cordis.patch.yml`、`lib/`、`locale/` 都在 |
| 版本閘門 | 在 CI 以 `engines.dsh` 範圍對 0.2.1-rc.5 做 semver 檢查 | 可用 `node -e` 直接驗 |
| 安裝驗證 | 在乾淨 profile 以 `dsh plugin add` 從 npm 安裝，開 session 呼叫 `admin status` | 需在真實 DSH 環境；可由你在本機做一次 |
| Release | 推 `v0.1.0` 後檢查 Release 資產、notes、npm 版本、provenance | 首次發佈後人工確認 |

---

## 7. 風險

1. **首發憑證**：Trusted Publishing 需套件已存在；首發必須有 token 或手動發佈。若未處理，自動化只能從第二版開始。
2. **名稱被搶**：`dsh-basemind-plugin` 目前未被佔用，但註冊前不具保留效力；建議確認後儘快首發。
3. **版本閘門過嚴**：加上 `engines.dsh` 後，未來 DSH 0.3.x 會擋安裝；需在每次 DSH minor 升級時驗證並放寬。
4. **本地測試不可跑**：目前只能用 CI 驗證，回饋迴路比本地慢；必要時需你批准一次 danger-full-access。
5. **雙語 README 漂移**：兩份文件需同步；建議在 CI 加一個「語言切換連結存在」的輕量檢查。
6. **awesome-dsh-plugin 人工審核**：描述不實或 repo 太新會被退回；目前 repo 已 ≥1 天，描述需與實作一致。
7. **market index 格式**：format 1 有嚴格欄位（`en` 必填、`publishTimestamp` 必填、版本不可重複等）；若做，必須用官方 validator 在 CI 驗證。

---

## 8. 需要你確認或提供的資料（一次性清單）

### A. npm 發佈身份（必選其一）

1. 你的 npm 帳號名稱，以及是否已開啟 2FA。
2. 認證方式（**已定：Trusted Publishing**，見 §11）：
   - **A1（採用）**：Trusted Publishing。首發仍需手動 `npm publish` 一次以建立套件，之後在 npmjs.com 綁定 workflow。
   - **A2（未採用）**：建立 Granular Access Token，放入 GitHub repo secret `NPM_TOKEN`。
3. 是否同意由我在 workflow 中使用 `--provenance`（會公開 repo/commit 與 build 資訊）。

### B. GitHub 權限與設定

1. 確認 repo 為 public（已確認）。
2. Actions 是否已啟用（預設啟用，但請確認沒有被組織政策關閉）。
3. 是否授權我建立 `.github/workflows/*`、`LICENSE`、`.gitignore` 等檔案（**我只會改檔案，不會自行 commit / push / 建 tag**；依全域規則，commit 與 push 由你執行）。
4. 是否要對 `main` 設 branch protection（要求 PR + CI）？若要，release 流程仍由 tag 觸發，不受影響。
5. 是否啟用 GitHub Pages（僅在要做 market index 時需要）。

### C. 版本與發佈策略

1. 版本節奏：手動 bump + tag `vX.Y.Z`（建議）或 release-please 自動 PR。
2. 是否要 pre-release 通道（`v0.2.0-rc.1` → npm `next`）。
3. Release notes：GitHub 自動生成（建議）或手寫 CHANGELOG。
4. 套件名：`dsh-basemind-plugin`（未佔用，建議）或 scoped `@<你的scope>/dsh-basemind-plugin`。
5. LICENSE 著作權人與年份（例如 `Copyright (c) 2026 <name>`）。
6. `homepage` 用 GitHub 還是 basemind.ai 相關頁面。

### D. 上架渠道（可選）

1. 是否要做自架 market index（GitHub Pages）？
2. 是否要向 `awesome-dsh-plugin` 提收錄 PR？分類建議 `dev`（開發工具）或 `tools`，請擇一；PR 需以你的 GitHub 帳號提交（或你授權我準備好檔案、由你提交）。
3. 是否要嘗試 DeepSeek 官方 catalog（需另行申請，非自動化）？

### E. 文件

1. 中文版檔名：`README.zh.md`（建議，繁中內容）或 `README.zh-TW.md`。
2. basemind 文檔入口：只放 introduction，還是同時放 installation / quickstart（三條都已驗證 200）。
3. 是否需要 npm / CI badges。

### F. 本機驗證

1. 目前 sandbox 禁止子行程，`node --test` 無法在本機跑。是否批准一次 `danger-full-access` 於本機執行測試（僅讀取與執行測試，不修改 repo），或接受「測試只在 CI 驗證」？

---

## 9. 建議實施順序（確認後）

1. `package.json` / `LICENSE` / `.gitignore` / `engines.dsh` 調整（不改行為）。
2. 英文 README 改版 → 中文 README → 交叉連結。
3. `.github/workflows/ci.yml`。
4. `.github/workflows/release.yml`（先以 `workflow_dispatch` 或 dry-run 驗證）。
5. 首次 npm 發佈 bootstrap（你操作或提供 token 設定）。
6. 推 `v0.1.0` tag → 驗證 Release + npm。
7. （可選）market index workflow + Pages。
8. （可選）awesome-dsh-plugin 收錄 PR。

---

## 10. 未決事項（需你拍板）

- [x] npm 認證：**Trusted Publishing（OIDC，無 token）**；首發需手動發一次 0.1.0
- [x] 套件名：unscoped `dsh-basemind-plugin`
- [x] `engines.dsh` 範圍：`>=0.2.1-rc.3 <0.3.0-0`
- [x] 中文 README 檔名：`README.zh.md`（繁體中文內容）
- [x] 上架渠道：不做 market index、不做 awesome-dsh-plugin、不做官方 catalog、不啟用 GitHub Pages
- [x] 本機 danger-full-access 測試：已批准並執行，149 tests 全過
- [x] 授權建立 `.github/workflows/*`、`LICENSE`、`.gitignore`（commit 仍由你執行）
- [x] GitHub：repo public、Actions 可用、要 branch protection（需你或 repo admin 在設定中啟用，見 §11）

---

## 11. 決策記錄（2026-10-30 確認）

| 項目 | 決定 |
|---|---|
| npm 帳號 | `sannyzeng`，已開 2FA |
| npm 認證 | Trusted Publishing（OIDC）：`id-token: write`，workflow 無 token；npmjs.com 綁定 `zengjunlin2022/dsh-basemind-plugin` + `release.yml`，並勾選 Allow npm publish |
| provenance | 由 Trusted Publishing 自動產生（公開 repo + 公開套件），不需 `--provenance` |
| GitHub Actions | 可用；已建立 `ci.yml`、`release.yml` |
| branch protection | 需要；但屬 repo 設定，需 repo admin 以 UI 或 `gh api` 啟用（Agent 無憑證） |
| GitHub Pages | 不啟用 |
| 版本策略 | 手動 bump `package.json` + tag `vX.Y.Z` |
| pre-release | 不支援；workflow 會拒絕含 `-` 的版本號 |
| 套件名 | `dsh-basemind-plugin`（unscoped） |
| LICENSE | MIT，Copyright (c) 2026 Ken |
| homepage | GitHub repo |
| 上架渠道 | 無（npm + GitHub Release 為唯一渠道） |
| 中文 README | `README.zh.md`，繁體中文 |
| basemind 入口 | 只放 `https://basemind.ai/start/introduction/` |
| badges | npm / CI / license / dsh 四個 |
| 本機測試 | 已以 danger-full-access 執行 `node --test`：149 pass / 0 fail |
