# AGENTS.md — dsh-basemind-plugin

本文件適用於此儲存庫及其子目錄，供開發 Agent 使用。更具體的目錄規則及使用者當次明確要求優先；不得據此擴張任務授權。

## 1. 專案定位與工作方式

- 本專案是 DeepSeek Harness（DSH）的 **Host-only Cordis bundle**，橋接 BaseMind MCP；不是 DSH 主程式、獨立 MCP server、profile 或 Client UI 插件。
- 以最小充分修改完成當前任務，保留既有行為；不順手重構、不升級無關依賴、不新增推測性功能。
- 預設以繁體中文溝通，保留英文技術術語。清楚區分已實施、已驗證、未驗證與受阻。
- 修改前確認實際工作目錄及 Git 狀態，讀取待改內容；不得覆蓋使用者或其他 Agent 的未提交修改。DSH 安裝目錄不是本專案工作區。
- 只要求分析、計畫或審查時，不修改產品程式碼。小型明確任務可直接完成，不為流程形式擴大工作量。
- Basemind 可用時，優先用 `code`／`graph` 查結構與符號、`git` 查差異與歷史；需要精確內容時再局部讀取。索引無結果不等於檔案不存在，必要時核對狀態並 fallback 至原生檔案工具。

## 2. 規範來源與相容性

DSH 插件契約優先查官方文件及目標 runtime 的實際服務介面，不憑舊計畫或外部範例猜 API：

- [打包與安裝插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish.md)：bundle、profile、patch 與相容性宣告。
- [Cordis 入門](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer.md)：依賴注入、事件及可撤銷副作用。
- [工具編寫參考](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool)：輸入、canonical output、render、取消及錯誤契約。
- [擴展插件形態](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/extension-cookbook.md)：服務與擴展點選擇；MCP 工具可直接註冊原始 JSON Schema 定義。

目前契約以 [package.json](./package.json) 為準：

- Node.js `>=24.20.0`，Volta 固定 `24.20.0`。
- DSH `>=0.2.1-rc.3 <0.3.0-0`，透過 `engines.dsh` 宣告；不要使用 DSH 不讀取的 `dsh.compatibility`。
- 純 JavaScript ESM、Node built-ins、零 runtime dependency，沒有 TypeScript 編譯或前端 build 步驟。沿用相鄰檔案風格，不為格式一致重寫整檔。
- 官方線上文件可能比支援的 runtime 新；引入新 API 前確認最低支援版本，不能因最新文件存在就假定舊版可用。
- BaseMind 不設版本閘門，能力以執行中 server 的 discovery 為準；`initialize.serverInfo.version` 不保證是 BaseMind 版本，不可用作功能判斷。

## 3. 檔案責任與修改落點

| 位置 | 責任 |
| --- | --- |
| [index.js](./index.js) | Cordis 入口、服務依賴、初始 discovery、動態工具同步、resources、prompt、重試及卸載 |
| [lib/config.js](./lib/config.js) | row config 驗證、預設值與範圍限制 |
| [lib/executable.js](./lib/executable.js) | 執行檔解析、環境清理、Windows launcher 與版本診斷 |
| [lib/stdio-client.js](./lib/stdio-client.js) | 子程序、JSON-RPC framing、pending requests、timeout、取消及關閉 |
| [lib/mcp-session.js](./lib/mcp-session.js) | MCP initialize、capabilities、tools/resources discovery 與呼叫 |
| [lib/workspace-pool.js](./lib/workspace-pool.js) | 按工作區共用 relay、初始化併發、容量及 disposal |
| [lib/schema.js](./lib/schema.js) | MCP schema 正規化、DSH schema 驗證與公開工具命名 |
| [lib/tool-bridge.js](./lib/tool-bridge.js) | ToolDefinition、逐次工作區解析與 MCP 錯誤映射 |
| [lib/result.js](./lib/result.js) | MCP 結果文字及內容投影 |
| [cordis.patch.yml](./cordis.patch.yml) | bundle 插入的插件 row，現有 id 為 `dsh-basemind` |
| [locale/en.json](./locale/en.json)、[locale/zh.json](./locale/zh.json)、[icon.svg](./icon.svg) | Plugin Manager 顯示 metadata，不代表存在 Client UI |
| [test/](./test/)、[fixtures/](./fixtures/) | Node test runner 測試及 fake MCP server |
| [scripts/](./scripts/)、[.github/workflows/](./.github/workflows/) | 語法、manifest、pack 檢查與 CI／發布流程 |
| [README.md](./README.md)、[README.zh.md](./README.zh.md)、[CHANGELOG.md](./CHANGELOG.md) | 對外說明及變更紀錄 |

[docs/](./docs/) 中的既有計畫與報告是歷史證據，不是現況保證；發生落差時核對實際程式、測試及當次需求。

## 4. Bundle 與 Cordis 開發約束

- 保留 [package.json](./package.json) 的 `type: module`、入口及 `dsh.bundle.patch`；[cordis.patch.yml](./cordis.patch.yml) 是 patch 條目陣列，安裝後的 row 按套件名稱解析，不使用開發機絕對路徑。
- 本 bundle 只插入自身 row；不自動新增／修改／刪除使用者的 MCP rows、agent presets、全局設定或其他 profile。
- 入口使用 `name`、`inject`、`apply(ctx, config)`。必需服務透過 `inject` 宣告，目前為 `tools`、`subprocess`、`workingDirectory`、`systemPrompt`；`mcpResources`、`agents` 維持可選並檢查可用性。
- 經由 `ctx` 公開服務與事件擴展；不要 import DSH 私有實作、從安裝目錄找內部模組，或依賴使用者 profile 的 `node_modules` 恰好可被解析。
- 本專案不匯出 `Config`；設定由 [lib/config.js](./lib/config.js) 手動驗證。新增選項須同步預設值、驗證、測試及相關文件，不為套用範例強加 Schemastery 依賴。
- 註冊、listener、timer、prompt section、resource provider 與子程序必須由 context-owned effect 管理並有清理路徑。維持現有單一 effect 的清理順序，防止卸載後的 async 結果重新註冊工具。
- 預設啟動失敗應可診斷及重試，不拖垮整個 Host；保留 `failOnStartupError` 的顯式選項語意，不能把所有失敗靜默轉成成功。
- server instructions 經 `ctx.systemPrompt.section()` 加入，維持長度上限及 `interpolate: false`；不直接覆寫整份 system prompt，也不把遠端文字當作本地設定模板展開。

## 5. 必須保持的 MCP 行為

### 工作區與 discovery

- 工具執行時以當次 Agent 的 `ctx.workingDirectory.ensure(agent, exec.signal)` 取得目錄，再經 pool 路由；不得以 `process.cwd()` 或固定啟動目錄取代。缺少可用 Agent 時明確失敗，不能猜另一個工作區。
- 每個解析後的工作區共用一個 `basemind serve` stdio relay；多工作階段不得互相混用 root。session 切換目錄後，下一次呼叫應使用新目錄。
- 預設 `discoveryRoot: 'agent'`，尚無 Agent 時不為預設目錄啟動 relay；保留其他顯式 discovery 策略的既有語意。
- `tools/list`、capabilities 與工具變更通知決定實際工具集，不硬編碼九個工具或 mode 清單，不以版本字串分支。新 relay 亦須載入自身工具清單。
- 公開名稱沿用 `mcp__<serverName>__<rawToolName>`；保留命名檢查及 collision 處理，不覆蓋其他來源的同名工具。
- MCP resources 經 DSH 的 `mcpResources` seam 橋接，使用呼叫者工作區。未獲需求授權不增加 MCP prompts 或其他 protocol extension。

### 工具及 schema 契約

- MCP 工具維持原始 `ToolDefinition` 路徑，不必為了使用 `defineTool` 而新增依賴。直接註冊不代表輸入自動受到完整驗證；維持 JSON object 邊界檢查及 server 端契約。
- 外部 MCP schema 必須經 [lib/schema.js](./lib/schema.js) 正規化與檢查，再交給 DSH；不能直接把 `$ref`、`anyOf`、type array 或任意 JSON Schema 關鍵字塞進支援範圍有限的 DSL。
- `execute` 回傳符合 `output.schema` 的單一 canonical JSON 值；目前 envelope 為 `{ text, content, isError: false }`。`output.render(args, value)` 從該值投影模型內容，不建立第二份業務結果。
- MCP 回覆的 `content` 可作為 envelope 資料，但不可直接當 DSH execute 的最外層內容塊回傳；image/audio/resource 的處理沿用明確文字診斷，不繞過 attachment admission。
- 啟動、傳輸及 MCP `isError` 等失敗要進入錯誤路徑；保留可定位訊息，不回傳看似成功的空結果。
- 將 `exec.signal` 向工作目錄、pool、MCP request 傳遞；維持 timeout、取消、pending request 清理及晚到回覆的邊界。
- 工具集含寫入、shell、rescan 等能力，目前 `isConcurrencySafe()` 回傳 `false`；未能證明安全前，不為提速改為全面可並行。

### 子程序與安全

- 正式程式經 `ctx.subprocess.resolveExecutable()`／`spawn()` 啟動，不以直接 `node:child_process` 繞過 DSH provider；Node 子程序 adapter 僅用於測試。
- 保留環境 allowlist 與敏感變數清理，不整份轉送 Host 環境或將 token、密碼寫入 log。顯式 `config.env` 的現有語意亦須保持。
- Windows `.cmd`／`.bat` launcher 使用既有 wrapper 及字元檢查；不拼接未驗證的 shell 字串。路徑解析及 canonicalization 應涵蓋 Windows 與非 Windows 行為。
- `basemind serve` 不保證在 stdin 關閉後退出；卸載須終止自身擁有的 relay 並清理 pool，不以關 stdin 代替 terminate，也不任意結束機器上其他共用 daemon。
- 保留 `autoProvision: false` 預設值；不擅自下載 BaseMind、建立索引或執行 scan/rescan。插件修改不得隱藏加入此類啟動副作用。

## 6. 驗證方式

所有命令從專案根目錄執行，強度與修改範圍相稱：

| 情境 | 命令／檢查 |
| --- | --- |
| 相關模組回歸 | `node --test test/<module>.test.mjs`，例如 `node --test test/schema.test.mjs test/tool-bridge.test.mjs` |
| 語法及 bundle manifest | `npm run check` |
| npm 發布內容 | `npm run check:pack`；會產生／覆寫根目錄的 `pack.json`，不得混入交付 |
| 全部測試 | `npm test` |
| 完整既有驗證入口 | `npm run verify`，依序執行 check、check:pack、test |
| 僅修改文件 | 核對內容、連結、命令及 Git 變更範圍；無須強跑產品 build 或整套測試 |

- 測試使用 Node built-in runner，fake server 位於 [fixtures/fake-mcp-server.mjs](./fixtures/fake-mcp-server.mjs)。新增行為或修復缺陷時，補上對應 targeted regression case。
- [test/integration.test.mjs](./test/integration.test.mjs) 會啟動真實 BaseMind；找不到 PATH 上的 `basemind` 時會 skip。`npm test` 成功不代表真實 integration 已執行，交付須列明 skip。
- 真實 integration 將 `BASEMIND_DATA_HOME` 及 `BASEMIND_COMMS_DIR` 指向測試暫存區；保留兩者隔離與 cleanup，不改用使用者的預設 cache／daemon。
- CI 涵蓋 Windows 與 Ubuntu、Node `24.20.0`。修改執行檔解析、stdio 或路徑處理時，需考慮兩個平台；只測一個平台就如實標明。
- 只有涉及安裝、Cordis 註冊、生命週期或真實 runtime 契約時，才在使用者授權的測試 profile 驗證載入、工具呼叫及停用清理；不要修改現用 Desktop profile 來完成普通單元測試。
- 本專案無 Client bundle／UI build，不宣稱前端 HMR 或重新整理會載入 Host 變更。原始碼及單元測試通過不等於已更新使用者安裝的 npm 版本。

## 7. 打包、文件與交付安全

- npm 內容由 [package.json](./package.json) 的 `files` 白名單控制；runtime JS、bundle patch、locale、icon 及必要公開文件必須可打包。不要因新增開發文件而順手擴大白名單。
- [scripts/check-manifest.mjs](./scripts/check-manifest.mjs) 檢查 DSH 讀取的 manifest；[scripts/check-pack.mjs](./scripts/check-pack.mjs) 檢查必要內容及禁止混入的 test/docs/scripts/dependency trees。
- 公開行為、安裝方式或相容性變動時同步 [README.md](./README.md) 與 [README.zh.md](./README.zh.md)，必要時更新 [CHANGELOG.md](./CHANGELOG.md)；不把未測版本寫成已驗證。
- 被要求的 Plan／Spec／Report 寫入 [docs/](./docs/)，使用當地日期及 `YYYY-MM-DD-主題-type.md` 命名；使用者指定檔名／位置時從其要求，例如本根目錄文件。
- **所有變更先交使用者人工審查，由使用者手動 commit。Agent 不執行 `git commit`、`git commit --amend` 或 `git push`。**
- 不執行 `npm run release`、`release:minor`、`release:major` 或預設會建立 commit/tag 的 `npm version`；這些現有腳本含提交／推送副作用，並非普通驗證命令。
- 不自行 publish、推 tag 或觸發發布。[.github/workflows/release.yml](./.github/workflows/release.yml) 在版本 tag 推送後可發布 npm 及 GitHub Release；一般實施授權不包含發布授權。
- 完成時簡報修改檔案、關鍵變化、實際驗證命令與結果、未驗證範圍及剩餘風險。不把局部自檢稱為獨立 Review，也不自動啟動 Review → Fix 循環。
