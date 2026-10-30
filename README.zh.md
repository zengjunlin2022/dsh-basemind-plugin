# dsh-basemind-plugin

[English](README.md) | 繁體中文

[![npm](https://img.shields.io/npm/v/dsh-basemind-plugin)](https://www.npmjs.com/package/dsh-basemind-plugin)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

DeepSeek Harness 的工作區感知 BaseMind 橋接插件。安裝這個 bundle 之後，每個工作階段都能直接使用 BaseMind 的程式碼理解工具，而且工具會跟隨該工作階段所在的儲存庫——不需要設定 MCP 列，也不需要修改任何 agent preset。

第一次接觸 BaseMind？請先閱讀 [BaseMind 介紹](https://basemind.ai/start/introduction/)。

## 1. 這是什麼

這是一個 DSH bundle。它為工作階段所在的儲存庫啟動 BaseMind 自己的 MCP 伺服器（`basemind serve`），註冊 BaseMind 宣告的工具，並在工作階段移動時讓工具跟著指向正確的工作區。在工作階段內 `cd` 之後，下一次呼叫就會使用新的儲存庫，不需要重啟任何東西。它沒有 UI 頁面，也不會修改任何 agent preset。

| | 手動設定 `basemind` MCP 列 | 這個 bundle |
|---|---|---|
| 工作區根目錄 | 列設定中的靜態 `cwd` | 每次呼叫時由工作階段的工作目錄解析 |
| 工具集 | 連線時固定，只服務那一個根目錄 | 從 `tools/list` 發現 |
| 需要設定的列 | 一列 MCP（外加一筆 manager 記錄） | 無——bundle 自己插入插件列 |
| 多個儲存庫 | 每個再加一列 | 每個根目錄自動一個 relay |

## 2. 版本

插件可在 npm 上以 `dsh-basemind-plugin` 取得，上方 badge 顯示目前版本。若要查詢某個 profile 中的版本：

```bash
npm view dsh-basemind-plugin version
```

## 3. 相容性

| 元件 | 需求 |
|---|---|
| DeepSeek Harness | `>= 0.2.1-rc.3 < 0.3.0-0`，宣告於 `engines.dsh`，DSH 會在安裝與啟動時檢查。本版本已於 `0.2.1-rc.5` 實測。 |
| Node.js | `>= 22`（宣告於 `engines`）。插件是純 ESM，沒有依賴。 |
| BaseMind | 任何版本。插件不鎖定也不設版本閘門：它提供的工具就是執行中的 `basemind serve` 透過 `tools/list` 宣告的內容。 |

## 4. 安裝

### 4.1 安裝 BaseMind

先依 [BaseMind 介紹](https://basemind.ai/start/introduction/)安裝 `basemind` 程式，並確認 DSH 執行環境看得到它：

```bash
basemind --version
```

若 DSH 在 `PATH` 上找不到 `basemind`，請用絕對路徑的 `BASEMIND_BIN`（或插件的 `command` 選項）指向執行檔。

### 4.2 安裝 bundle

- **DSH Desktop：** 開啟插件管理器（**Plugins** 頁），安裝 `dsh-basemind-plugin` 並啟用。
- **CLI 管理的 profile：** 用你要啟動的 profile 安裝：

  ```bash
  dsh plugin --profile <profile> add dsh-basemind-plugin
  ```

安裝是 per profile 的。若執行時要求重新啟動或停用/啟用一次以載入新 bundle，請照做。

### 4.3 驗證

在一個開在專案上的工作階段裡，呼叫 `mcp__basemind__admin`，參數 `{ "mode": "repo" }`。它會回傳該工作階段儲存庫的工作區根目錄與 HEAD。在預設 `serverName` 下會註冊九個工具：`admin`、`agents`、`code`、`git`、`graph`、`memory`、`shell`、`web`、`workspace`。

### 4.4 更新與移除

- **更新：** Plugins 頁 → Update，或 `dsh plugin --profile <profile> add dsh-basemind-plugin@latest`。
- **移除：** 在插件管理器停用或卸載，或 `dsh plugin --profile <profile> remove dsh-basemind-plugin`。

## 5. 使用

每個工具都需要一個必填的 `mode` 加上該模式的參數，呼叫名稱帶 `mcp__basemind__<tool>` 前綴。

**先看檔案結構，再決定要不要讀**

```json
{ "tool": "mcp__basemind__code", "arguments": { "mode": "outline", "path": "index.js" } }
```

**找符號定義位置**

```json
{ "tool": "mcp__basemind__code", "arguments": { "mode": "symbols", "name": "createWorkspacePool" } }
```

**找某個符號的所有呼叫點**

```json
{ "tool": "mcp__basemind__code", "arguments": { "mode": "references", "name": "publicToolName" } }
```

**以符號解析度讀 git 歷史**

```json
{ "tool": "mcp__basemind__git", "arguments": { "mode": "blame_symbol", "path": "index.js", "name": "activate" } }
```

**看整個儲存庫的架構**

```json
{ "tool": "mcp__basemind__graph", "arguments": { "mode": "map" } }
```

**檢查目前工作區的索引狀態**

```json
{ "tool": "mcp__basemind__admin", "arguments": { "mode": "status" } }
```

### 工具

| 工具 | 涵蓋 |
|---|---|
| `mcp__basemind__admin` | status、repo 資訊、rescan、快取統計、gc、telemetry |
| `mcp__basemind__agents` | 多 agent 通訊 |
| `mcp__basemind__code` | outline、symbols、grep、files、find、definition、references、callers、implementations、dependents、expand、語意搜尋、chunk |
| `mcp__basemind__git` | status、歷史、blame、diff |
| `mcp__basemind__graph` | calls、neighbours、paths、subgraphs、communities、map、export |
| `mcp__basemind__memory` | memory put/recall、文件搜尋 |
| `mcp__basemind__shell` | 長駐 shell session |
| `mcp__basemind__web` | scrape、crawl、list |
| `mcp__basemind__workspace` | workspaces、worktrees、branches、claims |

模式清單取自執行中的 BaseMind，較新版本可能提供更多。BaseMind 的 MCP resources（`basemind://status`、`basemind://repo/map`）以 resource server `basemind` 提供，因此 `list_mcp_resources` 與 `read_mcp_resource` 都能對它們運作。

---

MIT © 2026 Ken。見 [LICENSE](LICENSE)。
