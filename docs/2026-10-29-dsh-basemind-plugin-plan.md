# dsh-basemind-plugin 實施計畫（DSH Host-only Bundle）

- 日期：2026-10-29
- 狀態：**已於 2026-10-29 完成實作、測試與 profile 安裝**；本文件保留為原始規劃基線，執行結果、驗證證據與偏離見 `docs/2026-10-29-dsh-basemind-plugin-execution-report.md`。§15.3 的 7 項建議已納入，並同步到對應章節。
- 目標 workspace：`D:\02_zengjunlin\github\dsh-basemind-plugin`
- DSH Runtime：`0.2.1-rc.3`（Desktop profile `desktop`）
- BaseMind：本機已安裝 `0.29.3`；GitHub 最新 release `v0.31.0`（2026-10-23）；npm `latest` 於本次檢查回報 `0.30.0`（待確認發佈落差）
- BaseMind 倉庫：<https://github.com/Goldziher/basemind>
- BaseMind v0.31.0 release：<https://github.com/Goldziher/basemind/releases/tag/v0.31.0>
- BaseMind npm：<https://www.npmjs.com/package/basemind>

---

## 1. 需求、目標與成功標準

### 1.1 需求

| 編號 | 需求 |
|---|---|
| R1 | 插件名稱 `dsh-basemind-plugin`，可在 DSH 的所有一般使用場景使用。 |
| R2 | 使用者不需要再單獨建立 BaseMind MCP row；插件自行啟動、連線、註冊工具。 |
| R3 | 不限制使用者安裝的 BaseMind 版本；插件不得以版本號 gate 功能。 |
| R4 | 插件依最新 BaseMind（目標 `0.31.0`）提供完整能力；較新版本新增的 tool/mode 應可自動出現，較舊版本缺少的能力應優雅降級。 |
| R5 | 本階段只交付可執行 Plan；不改代碼、不安裝插件、不改 Standard Agent Preset、不改任何現有 BaseMind MCP 配置。 |

### 1.2 成功標準（Acceptance）

1. 在 profile 安裝 bundle 後，**不新增任何 MCP row**，新 session 直接看到 BaseMind 的 9 個 domain tools（`admin`、`agents`、`code`、`git`、`graph`、`memory`、`shell`、`web`、`workspace`），名稱形如 `mcp__basemind__code`。
2. 同一 Host 內，session A（workspace A）與 session B（workspace B）呼叫同一個工具時，分別由各自的 BaseMind workspace root 服務；session 內 `cd` 後下一次呼叫切換到新 root。
3. 以 BaseMind `0.29.3` 與 `0.31.0` 測試皆可取得該版本實際暴露的 tools；插件不因版本不同而拒絕啟動。
4. BaseMind 的兩個 resources（`basemind://status`、`basemind://repo/map`）可透過 DSH 既有的 `list_mcp_resources` / `read_mcp_resource` 取得。
5. BaseMind 的 server instructions 進入 system prompt 的 MCP section；無 instructions 時不產生空 section。
6. BaseMind 不存在、啟動失敗或 crash 時，DSH 仍可正常啟動與使用；插件記錄清楚錯誤，下一次呼叫可重試。
7. 插件卸載/停用後，工具、resource provider、prompt section 與插件自己啟動的子程序都被清理；不留下可由插件證明的 orphan process。
8. 既有 `basemind` MCP row 存在時，插件不產生重複工具名稱，也不修改該 row；文件明示二者只能啟用其一。
9. 單元測試、schema normalization 測試、真實 BaseMind integration test 通過；runtime 以 `cordis_inspect_query` 驗證工具與 row。
10. Plugin Manager 顯示正確的 title/description/icon（en/zh）。

### 1.3 非目標（Non-goals）

- 不做 Client UI 頁面/panel；本插件是 Host-only bundle，只提供 Plugin Manager 的顯示 metadata。
- 不修改 Standard Agent Preset 或其他 preset 的工具白名單/隔離設定。
- 不修改、遷移或刪除任何現有 MCP row（包含既有 `basemind` row）。
- 不自動 `basemind scan`/`rescan`、不自動建立索引、不自動安裝 BaseMind binary（`autoProvision` 預設 false，見 §10）。
- 不橋接 MCP prompt templates（DSH 官方 `dsh-mcp-client` 明示不支援；BaseMind 的 prompts 多為工具組合的便利入口）。列為已知限制，未來可另案。
- 不支援 MCP tasks extension、sampling、elicitation、completions。
- 不處理 remote/SSH workspace 的 BaseMind 安裝；插件使用 `ctx.subprocess`，若該 provider 的 execution world 有 BaseMind 即可運作，否則列為待確認。

---

## 2. 已確認事實與證據

### 2.1 DSH Runtime（以 `cordis_inspect_list` / `cordis_inspect_query` 確認）

| 項目 | 已確認內容 | 證據 |
|---|---|---|
| Service `tools` | `register(definition): () => void`；global 或 agent scope；scoped 可 shadow global；同一層 duplicate 與保留名 `run_code` 會失敗。`get(name, scope)`、`schemas(scope)`。 | `Service.listService({service:'tools'})` |
| `ToolDefinition` | `name`、`description`、`parameters: Record<string, unknown>`、`output: { schema, render(args,value) }`、`execute(args, exec)`、optional `timeoutMs`、`isConcurrencySafe`、`presentCall`、`presentResult`。 | `tools` service referencedTypes |
| JSON Schema 邊界 | `JsonSchemaNode` 只支援單一 `type`、`oneOf`、`properties`、`required`、`additionalProperties: boolean`、`items`、`enum`、`const`、`description`、`title`、`default`、`examples`；**不支援 `anyOf`、type array、`$ref`、`format`、`minimum`**。`dsh-mcp-manager` 對 MCP schema 做 degrade 可作為先例。 | `dsh-tools` README §Use this package；`dsh-mcp-manager` `sanitizeValue()` |
| Service `subprocess` | `resolveExecutable(command, env?, signal?)`；`spawn(spec)` 回傳 `SubprocessHandle`（`stdin/stdout/stderr`、`done`、`terminate()`、`waitForExit()`）。`SubprocessSpawnSpec` 有 `argv`、`cwd`、`stdio`、`graceMs`、`signal`、`env`。 | `Service.listService({service:'subprocess'})` |
| Windows 執行檔 | `dsh-subprocess-local` 的 `resolveExecutable` 會解析 `.COM/.EXE/.BAT/.CMD`；Windows 一般子程序以 Job runner 啟動。**`.cmd` 直接 spawn 的行為未驗證**；Plan 預設採 `cmd.exe /d /s /c` wrapper，direct spawn 只作已驗證優化。 | `dsh-subprocess-local` README §Resolving executables |
| Service `workingDirectory` | `defaultDirectory: string`；`ensure(agent, signal?) => Promise<string>`；`get(session)`；`set(agent,path)`。`ensure` 會驗證目前目錄，必要時恢復原專案。 | `Service.listService({service:'workingDirectory'})` |
| Service `systemPrompt` | `section({name, order, text, interpolate?, complete?})`；`getSectionOrder(name)`；`MCP_SERVERS` 的 order 為 **3100**。 | `dsh-system-prompt/lib/index.js` `SECTION_ORDERS`；service contract |
| Service `mcpResources` | `register(server, provider): () => void`；`McpResourceProvider.request({method:'resources/list'|'resources/templates/list'|'resources/read', ...}, exec)`；shared tools 為 `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`。 | `Service.listService({service:'mcpResources'})`；`dsh-mcp-resources` README |
| Event `agent/created` | serial；payload `{agent, source, signal?}`；每個 agent 建立後觸發。 | `Event.listEvents()` |
| Event `agent/disposed` | emit；payload `{agent}`。 | `Event.listEvents()` |
| Event `tools/change` | emit；工具註冊/移除/restriction 變更。 | `Event.listEvents()` |
| Event `system-prompt/change` | emit；prompt provider 變更。 | `Event.listEvents()` |
| Presets | profile 有 `preset-standard`、`preset-ptc`、`preset-minimal`、`preset-cordis` 四個 row；本插件只插 root row，不動 preset。Standard preset 的 child plugin 清單未在本次 live 查詢中展開；官方 `dsh-agent-preset` README 的 standard 範例為 `plugins: []`。 | `Config.listConfigs({name:'@deepseek-ai/dsh-agent-preset'})` |
| 既有 MCP rows | profile 目前有 `mcp-context7`、`mcp-tdesign-mcp-server`、`mcp-dbx`；**沒有 basemind MCP row**。`mcp-manager.json` 的 servers 也沒有 basemind。 | `Config.listConfigs({name:'@deepseek-ai/dsh-mcp-client'})`；`C:\Users\sanny\.dsh\mcp-manager.json` |
| 既有插件 row | 目前沒有 `dsh-basemind-plugin` row。 | `Config.listConfigs({name:'dsh-basemind-plugin'})` 回傳空 |
| 官方 MCP client | `@deepseek-ai/dsh-mcp-client` 的 stdio 設定需要固定的 `command`、`args`、`cwd`；`cwd` 是靜態 row 設定，不能跟隨每個 session 的 working directory。 | `Config.listConfigs({entry:'include:mcp-context7'})` schema；`dsh-mcp-client` README |
| 官方 MCP client 可否被 local bundle import | 從 profile 解析 `@deepseek-ai/dsh-mcp-client` 失敗（`MODULE_NOT_FOUND`）；local directory install 是 link checkout，插件檔案在 workspace，不能依賴 profile `node_modules`。 | 以 `require.resolve(..., {paths:[profileDir]})` 實測 |
| Config schema | 本插件不打算匯出 `Config`；`dsh-mcp-manager` 也沒有 `Config`/schemastery export，仍可正常作為 profile plugin。 | `dsh-mcp-manager/lib/index.js` 無 `export const Config` |
| Tool 現況 | 目前可見的 MCP 工具命名為 `mcp__<serverName>__<rawName>`（例：`mcp__sequentialthinking__sequentialthinking`）；shared resource tools 已存在。 | `Tool.listTools()` |
| Lifecycle 介面 | DSH 沒有獨立的 Lifecycle service；plugin activation/disposal 由 Cordis `apply` + `ctx.effect` 管理，agent 生命週期由 `agent/created` / `agent/disposed` events 觀測。 | `cordis-plugin-development` `references/host-plugin.md`；`Event.listEvents()` |

### 2.2 BaseMind 0.29.3（本機實測）

以 `basemind serve --root <dir>` + JSON-RPC 實測：

- `initialize` 回傳 protocolVersion `2025-06-18`；`serverInfo.name = rmcp`、`serverInfo.version = 3.5.1`（**不是** BaseMind 版本）。
- capabilities：`tools`、`resources`、`prompts`、`completions`、`extensions.io.modelcontextprotocol/tasks`。
- `tools/list` 共 **9** 個工具：
  | tool | inputSchema 大小（約） | 重點 |
  |---|---:|---|
  | `admin` | 2.6 KB | `status`、`repo`、`rescan`、`cache_stats`、`gc`、`cache_clear`、`telemetry`、`compress`、`delta`、`checkpoint`、`waste` |
  | `agents` | 4.7 KB | 多 agent comms |
  | `code` | 4.8 KB | `outline`、`symbols`、`grep`、`files`、`find`、`definition`、`references`、`callers`、`implementations`、`dependents`、`expand`、`semantic`、`chunk` |
  | `git` | 3.9 KB | status/history/blame/diff 等 |
  | `graph` | 5.8 KB | calls/neighbors/path/subgraph/communities/map/export 等 |
  | `memory` | 4.0 KB | memory put/recall、documents search 等 |
  | `shell` | 2.2 KB | long-lived shell sessions |
  | `web` | 1.4 KB | scrape/crawl/list |
  | `workspace` | 0.7 KB | workspaces/worktrees/branches/claims |
- `resources/list` 回傳 2 個 resource：`basemind://status`、`basemind://repo/map`。
- `prompts/list` 回傳至少 4 個 prompt：`explain-file`、`onboard-repo`、`review-working-tree`、`trace-symbol`（其餘被輸出截斷）。
- `initialize.instructions` 存在，內容大意：BaseMind 是此 repo 的 indexed context layer；每個 tool 有 required `mode`；優先 basemind，shell/grep/git 作為 fallback。
- 工具 schema 使用 JSON Schema draft 2020-12，含 `$schema`、`type: ["string","null"]`、`default: null`、`enum`、`format`、`minimum` 等；**不能原樣餵給 DSH 的 `JsonSchemaNode`**，必須 normalization。
- `serve --root` 會把 root 向上解析到 repo root（實測 `resolved repo root upward`）。
- `serve` 的 stdout 是 MCP 協定；日誌在 stderr。
- `serve` 會確保 `comms daemon`（BaseMind 自己的 daemon）存在；實測 `serve` process tree 可能包含 `comms daemon`。
- 關閉 `serve` 的 stdin **不會**在 5 秒內讓它退出（實測 timeout），因此插件卸載時必須 `terminate()`，不能只 `stdin.end()`。
- `basemind daemon ensure --json` 實測回傳 `{"ready":false,"http":"disabled","grant":"BASEMIND_ALLOW_HTTP"}`：**此環境的 HTTP transport 預設關閉**，因此本計畫選 stdio `serve`，不依賴 HTTP。
- `basemind --version` = `0.29.3`；本機 binary 由 npm launcher (`basemind.js` → `basemind.exe`) 啟動。
- 本機 `basemind status` 曾回報 git-history index permission denied / telemetry write failed；這是 BaseMind cache/ACL 的環境警告，插件只把它當 stderr 診斷，不視為 fatal。

### 2.3 BaseMind 0.31.0 / npm

- GitHub release `v0.31.0` 存在（2026-10-23），release body 只有 `Release v0.31.0`，沒有 changelog。
- `npm view basemind version` 回報 `0.30.0`；`npm registry` 的 `latest` 與 GitHub release 有落差，**待確認**。本計畫以「任何版本皆可」為設計，不以 `0.31.0` 作 gate。
- BaseMind 官方 plugin README（其他 harness）確認：九個 domain tools、`BASEMIND_BIN` 可指定本地 build、Hermes/Pi 需要 `basemind` 在 PATH；這支持本計畫的 binary resolution 與 dynamic discovery。

### 2.4 Workspace 現況與規劃注意事項

- 本次規劃開始時，workspace 只有未 commit 的 `src/mcp/bridge.ts`，但該檔在讀取時持續 `EPERM`（Windows 檔案權限），**內容從未被讀取**；後續檢查時 `src/` 已不存在，workspace 只剩 `.git`，沒有 commit。
- 因此本計畫**假設全新實作**，不假設 `bridge.ts` 的內容。若該檔其實是使用者先前的實作，請在執行前先恢復/確認；不要默認覆蓋未知內容。
- 目前 workspace 沒有 `package.json`、沒有 build tool、沒有測試；本計畫採 zero-dependency、plain ESM、Node built-in test。

### 2.5 套用的官方 Skill / 規範

- 已載入 `cordis-plugin-development` 並讀取其 `references/host-plugin.md`（bundle manifest、Host export forms、display metadata、install/observe）、`references/mcp-bundle.md`（config-only MCP bundle 的可行性與限制）、`references/practices.md`（session log、context-owned effects、extension point 強弱、prompt/state 原則）、`references/verification.md`（無 UI 時可驗證到什麼程度）。
- 未套用 `references/ui-plugin.md`、`references/user-actions.md` 與 `templates/decoration/*`：本插件沒有 Client half、沒有 slot、沒有使用者操作；`templates/mcp/*` 只用來理解 config-only 方案，最後因 static `cwd` 不滿足需求而否決。
- 未使用 `editing-cordis-compositions`：本階段不改任何 agent preset；未來若要處理 preset isolation 才需要。
- 「官方最新規範」以本機安裝的 `0.2.1-rc.3` 套件 README、`lib/types`、`cordis_inspect_query` 的 runtime contract 為權威；不引用外部部落格或假設未來 API。

---

## 3. 架構決策（Decision Log）

| 編號 | 決策 | 理由 |
|---|---|---|
| D1 | **Host-only bundle + profile-root row**，不是 config-only MCP bundle。 | 官方 `dsh-mcp-client` 的 `cwd` 是靜態 row 設定；BaseMind `serve --root` 綁定單一 workspace。DSH 每個 session 有獨立 working directory，只有 Host plugin 能在每次呼叫時解析 root。 |
| D2 | **Dynamic MCP discovery**：啟動時 `tools/list`，不寫死 tool 名稱、mode、版本。 | 同時滿足 R3（任何版本）與 R4（最新功能自動出現）。`serverInfo.version` 是 rmcp 版本，不能用來判斷 BaseMind 版本。 |
| D3 | **每個 workspace root 一個 `basemind serve` stdio relay**；呼叫時 `workingDirectory.ensure(agent)` 決定 root。 | 語意正確、與 BaseMind 的 workspace 模型一致；HTTP transport 在此環境預設 disabled（`BASEMIND_ALLOW_HTTP`），不可依賴。 |
| D4 | **Global tool registration**（root `ctx.tools`），tool execute 內 per-call 路由。 | 所有 agent/session 都看得到工具；不需要 per-agent registration；`exec.agent` 足以解析 cwd。 |
| D5 | **不做 idle eviction**（v1）；relay 保留到插件卸載，`maxClients` 上限保護。 | `serve` 關 stdin 不會退出；若中途 `terminate()` 可能帶走 shared `comms daemon`，影響其他 workspace。保持 relay 到卸載最安全。 |
| D6 | **Resources 透過 `ctx.mcpResources.register` 橋接**；**prompts 不橋接**。 | Resources 是 DSH 既有 seam，BaseMind 有 2 個；DSH 官方 MCP client 不支援 prompt templates，硬做會發明非標準行為。 |
| D7 | **Zero dependency、plain ESM、無 build**；不匯出 `Config`，手動驗證 config。 | local directory install 是 link checkout；從 workspace 解析不到 profile `node_modules`（實測 `@deepseek-ai/dsh-mcp-client` 失敗）。`dsh-mcp-manager` 證明無 Config 的 profile plugin 可行。 |
| D8 | **Text-first result projection**；image/audio/resource 以明確 diagnostic text 呈現。 | BaseMind 的九個工具主要回傳 JSON text；避免未經 attachment admission 的 image block 污染 session。 |
| D9 | **No UI**；只提供 locale meta 與原創 icon。 | 需求沒有視覺頁面；Host-only 降低風險。 |
| D10 | **不自動安裝 BaseMind、不自動 scan/rescan**；`autoProvision` 預設 false。 | 避免 silent download / index mutation；BaseMind 安裝與索引是使用者可控的環境行為。 |

- **範圍**：安裝範圍是單一 DSH profile；其他 profile 需各自安裝同一 bundle（profile root tools 不跨 profile）。
- **表面**：Host-only 插件不依賴 Web Client；同一 profile 的 Web GUI、CLI、headless session 都使用同一 Host composition。沒有 Client half 不影響工具可用性。

### 3.1 為何不用官方 `@deepseek-ai/dsh-mcp-client` 當 library

- 從 profile 解析 `@deepseek-ai/dsh-mcp-client` 失敗；local bundle 的檔案在 workspace，Node resolution 不會到 app.asar 或 profile `node_modules`。
- 官方 client 的 connection/transport 綁定單一 config，沒有「per-call cwd / per-workspace pool」介面。
- 本插件只借用它的**行為契約**：`mcp__<server>__<raw>` 命名、text result projection、schema 降級、server instructions section；實作以 Node built-ins 完成，和 `dsh-mcp-manager` 的自帶 stdio client 同型。

### 3.2 為何不是 config-only MCP bundle

`cordis.patch.yml` 只能插入一個 `@deepseek-ai/dsh-mcp-client` row；`cwd` 固定。若使用 `workingDirectory.defaultDirectory`，所有 session 都會被綁到同一個 repo，無法滿足 R1/R2。因此必須有 Host code。

---

## 4. 總體架構

```text
DSH Host root context
│
├─ ctx.tools.register(...)                 ← 9 個 mcp__basemind__*（動態）
├─ ctx.mcpResources.register('basemind')   ← resources provider（動態）
├─ ctx.systemPrompt.section('mcp:basemind')← server instructions
├─ ctx.on('agent/created')                 ← 啟動失敗時重試
│
└─ WorkspacePool
     ├─ root A → McpSession A → spawn `basemind serve --root A`
     ├─ root B → McpSession B → spawn `basemind serve --root B`
     └─ ...
          │
          └─ JSON-RPC over stdio (newline-delimited)
               initialize → tools/list → tools/call
               resources/list → resources/read
```

Tool call 流程：

```text
model calls mcp__basemind__code({mode:"outline", path:"src/x.ts"})
  → ToolDefinition.execute(args, exec)
  → root = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  → pool.clientFor(root)
  → session.callTool('code', args, {signal, timeoutMs})
  → MCP tools/call
  → normalize result content
  → output.render → ContentBlock[]
```

---

## 5. DSH 契約與擴展點

### 5.1 Plugin entry

```js
export const name = 'dsh-basemind-plugin';
export const inject = ['tools', 'subprocess', 'workingDirectory', 'systemPrompt'];

export function apply(ctx, config) {
  // parse config
  // create pool
  // start primary session (defaultDirectory)
  // register tools/resources/prompt on success
  // return cleanup through ctx.effect
}
```

- `mcpResources` 不放入 hard `inject`；用 `ctx.get('mcpResources')` optional，缺少時跳過 resources。
- 所有註冊（tool disposer、resource provider、prompt section、event listener、pool）都放入同一個 `ctx.effect` cleanup，確保 unload/HMR 清理。
- 不在 `apply` 內直接 `await` 無界初始化；以背景 promise + `agent/created` 重試，避免 BaseMind 慢啟動阻塞 DSH。

### 5.2 Tool registration

每個 discovered MCP tool 轉成：

```js
{
  name: `mcp__${serverName}__${normalizedRawName}`,
  description: rawTool.description || `BaseMind ${rawTool.name}`,
  parameters: normalizeInputSchema(rawTool.inputSchema),
  output: {
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        content: { type: 'array', items: { type: 'object' } },
      },
      required: ['text'],
    },
    render(_args, value) { return projectContent(value); },
  },
  timeoutMs: toolCallTimeoutMs,
  isConcurrencySafe: () => false,
  async execute(args, exec) { /* route + call */ },
}
```

- `isConcurrencySafe: () => false`：BaseMind 工具包含寫入（memory put、web scrape、shell spawn、rescan），且版本無從靜態判斷；v1 以安全序列化為先。
- `timeoutMs` 只作宣告；真正 timeout 由 `lib/stdio-client` 的 per-request timer 執行（DSH 的 `timeoutMs` 不主動 enforce，見 `dsh-tools` 限制）。
- 不設定 `presentCall`/`presentResult`：Web Client 不使用 host presentation descriptors，交由 DSH 依 raw args/content 選 renderer。

### 5.3 Resource provider

```js
const mcpResources = ctx.get('mcpResources');
if (mcpResources) {
  mcpResources.register(serverName, {
    async request(request, exec) {
      const agent = exec.agent ?? ctx.get('agents')?.currentInitiator();
      if (!agent) throw new Error('BaseMind resource request requires an Agent to resolve the workspace');
      const root = await ctx.workingDirectory.ensure(agent, exec.signal);
      const session = await pool.clientFor(root, exec.signal);
      switch (request.method) {
        case 'resources/list': return session.request('resources/list', { cursor: request.cursor });
        case 'resources/templates/list': return session.request('resources/templates/list', { cursor: request.cursor });
        case 'resources/read': return session.request('resources/read', { uri: request.uri });
      }
    },
  });
}
```

- 這會讓 DSH 既有的三個 shared resource tools 認得 `basemind`，並在 `MCP resource servers` prompt section 列出它。
- 若 `register` 因同名 server 已存在而失敗：catch、warn、跳過（不影響 tools）。

### 5.4 System prompt instructions

```js
ctx.systemPrompt.section({
  name: `mcp:${serverName}`,
  order: ctx.systemPrompt.getSectionOrder('MCP_SERVERS'), // verified 3100
  text: instructions,
  interpolate: false, // BaseMind instructions 可能含 {{...}} 字面
});
```

- 只在 `initialize.instructions` 非空時註冊；上限 32 KiB（超過截斷並 warn）。
- 若同名 section 已存在（例如手動 BaseMind MCP row）：catch duplicate，改用 `mcp:${serverName}:plugin` 或跳過；文件明示不要同時啟用兩個來源。

### 5.5 Agent / cwd

- `ctx.workingDirectory.ensure(exec.agent, exec.signal)` 回傳目前 session 的有效目錄；`exec.agent` 可能 undefined（例如某些 PTC 呼叫），先以 `ctx.get('agents')?.currentInitiator()` 補；若仍無，tool/resource call 直接報錯（不要猜 `defaultDirectory`，避免讀寫錯 repo）。`defaultDirectory` 只用於 primary discovery。
- 每次 tool call 都重新解析 root；session `cd` 後下一次呼叫自然切換。
- 舊 root 的 relay 保留（D5），不因 cwd 改變而終止。

### 5.6 Logging

- 使用 `ctx.logger.warn` / `ctx.logger.error`（`dsh-mcp-manager` 已使用 `ctx.logger.warn`；`info` 若不存在則用 `warn`）。
- 不記錄 tool args 或完整 result（可能含敏感內容）；只記錄 tool name、root、duration、error code。
- stderr tail 最多 8 KiB，僅在啟動失敗或連線中斷時輸出。

---

## 6. BaseMind MCP 協定契約

### 6.1 Transport

- `stdio`，newline-delimited JSON-RPC 2.0。
- 啟動命令：`<resolved basemind> <args...> --root <absolute root>`；預設 `args = ['serve']`。
- stdout 只讀 JSON；stderr 收集 tail。
- 每個 workspace root 一個 session；session 內 multiplex 多個 request id。

### 6.2 Initialize

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "dsh-basemind-plugin", "version": "0.1.0" }
  }
}
```

- 接受 server 回傳的任何 `protocolVersion`；若與請求不同，log 一次（不視為失敗）。
- 若 server 以 `-32602` 拒絕版本：關閉並以 `2025-03-26` 重試，再以 `2024-11-05` 重試；每次重試重啟 process。此 fallback 為待確認（0.29.3 已接受 2025-06-18）。
- 發送 `notifications/initialized` 後才 `tools/list`。
- `capabilities.tools` 不存在時：不註冊 tools，但仍可註冊 resources/instructions（若有）。

### 6.3 Tools

- `tools/list` 支援 `cursor` 分頁；最多 100 頁保護。
- 每個 tool 保留 `name`、`description`、`inputSchema`、optional `outputSchema`、`annotations`（不強制使用）。
- `tools/call` 參數：`{ name: rawName, arguments: args }`；** wire name 永遠是 raw name**，不是 `mcp__...`。
- 結果：
  - `content` 陣列：`text`、`image`、`audio`、`resource_link`、`resource`。
  - `structuredContent`：保留在 canonical value。
  - `isError: true`：轉成 DSH tool error（throw），message 取 text content 串接。
- 取消：`exec.signal` abort 時送 `notifications/cancelled`（`requestId`、`reason`），並 reject pending；不 kill relay。
- Timeout：預設 120000 ms；超時送 cancelled，reject；不自動重試 tool call（避免重複寫入）。
- 不自動重試 `tools/call`；連線建立失敗才重試。

### 6.4 Resources

- `resources/list`、`resources/templates/list`、`resources/read` 直接代理。
- BaseMind 0.29.3 有 2 個 resources；較新版本可能增加，動態轉發。
- `resources/subscribe` 不支援；DSH mcp-resources 也不支援 subscriptions。

### 6.5 Prompts

- 不呼叫 `prompts/list` / `prompts/get`；不註冊 prompt templates。
- 理由：DSH 官方 `dsh-mcp-client` 明示不支援 MCP prompt templates；BaseMind prompts 是工具組合的便利入口，模型可直接用 tools 達成。
- 文件列為 known limitation；若未來 DSH 新增 prompt seam，再另案。

### 6.6 Notifications / server requests

- `notifications/tools/list_changed`：觸發 tool generation re-sync（serialize）。
- `notifications/resources/list_changed`：不做事（下次 list 自然更新）。
- `notifications/message`：debug log（可關）。
- server → client `ping`：回 `{jsonrpc:'2.0', id, result:{}}`。
- `roots/list`：回 `{roots: []}`（BaseMind 不應依賴）。
- `sampling/createMessage`、`elicitation/create`：回 JSON-RPC error `-32601`（不支援）。
- 其他未知 request：回 `-32601`；未知 notification：忽略。

### 6.7 版本與能力

- 不解析 BaseMind semver 來決定功能；`serverInfo.version` 是 rmcp 版本，不是 BaseMind。
- `basemind --version` 只用於 diagnostics；spawn 一次，背景執行，不阻塞。
- 功能集合 = 該版本 `tools/list` + `resources/list` 的實際結果。
- 升級 BaseMind 後：既有 relay 仍是舊版本；新 root 或重啟後的新 relay 使用新版本。文件說明重啟 DSH 或停用/啟用插件可刷新；若 BaseMind 支援 `tools/list_changed`，會自動 re-sync。

---

## 7. 模組設計與檔案佈局

```text
dsh-basemind-plugin/
├─ package.json
├─ cordis.patch.yml
├─ index.js
├─ lib/
│  ├─ config.js
│  ├─ executable.js
│  ├─ stdio-client.js
│  ├─ mcp-session.js
│  ├─ schema.js
│  ├─ result.js
│  ├─ tool-bridge.js
│  └─ workspace-pool.js
├─ locale/
│  ├─ en.json
│  └─ zh.json
├─ icon.svg
├─ README.md
└─ test/
   ├─ schema.test.mjs
   ├─ stdio-client.test.mjs
   ├─ tool-bridge.test.mjs
   ├─ workspace-pool.test.mjs
   └─ integration.test.mjs
```

### 7.1 `package.json`

```json
{
  "name": "dsh-basemind-plugin",
  "version": "0.1.0",
  "private": true,
  "description": "Workspace-aware BaseMind MCP bridge for DeepSeek Harness.",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": [
    "index.js",
    "lib/**/*.js",
    "cordis.patch.yml",
    "locale/*.json",
    "icon.svg",
    "README.md"
  ],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "compatibility": { "dsh": ">=0.2.1-rc.3", "node": ">=22" }
  },
  "engines": { "node": ">=22" },
  "license": "MIT",
  "scripts": { "test": "node --test" }
}
```

- 無 `dependencies` / `devDependencies`。
- `private: true` 避免誤發佈；local bundle 仍可安裝。
- 不用 `build`；`node --check` 驗證語法。

### 7.2 `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-basemind
      name: 'dsh-basemind-plugin'
      config:
        serverName: basemind
```

- 只用預設值；使用者可在自己的 `cordis.patch.yml` 以 `id: dsh-basemind` override（注意：override 會**整段取代** `config`，需重述所有要保留的欄位）。
- 不插入 `@deepseek-ai/dsh-mcp-client`；不修改任何既有 row。

### 7.3 `lib/config.js`

```js
export const DEFAULTS = {
  serverName: 'basemind',
  command: 'basemind',       // BASEMIND_BIN 優先
  args: ['serve'],
  env: {},
  toolCallTimeoutMs: 120000,
  startupTimeoutMs: 60000,
  maxClients: 32,
  autoProvision: false,
  npxSpec: 'basemind@latest',
  failOnStartupError: false,
  logStderr: true,
};

export function resolveConfig(raw) { /* validate + clamp + warn */ }
```

- `serverName`：`/^[A-Za-z0-9_-]{1,32}$/`；不合法 fallback `basemind`。
- `command`：非空字串；`BASEMIND_BIN` 若設定且 `command` 是預設 `basemind`，優先使用 env。
- `args`：string array；`--root` 由插件附加，不允许使用者自行放入 `--root`（若放入，warn 並移除，避免重複）。
- `env`：只接受 string values。
- `toolCallTimeoutMs` / `startupTimeoutMs` / `maxClients`：clamp 到合理範圍。
- `autoProvision`：true 時，PATH 找不到 `basemind` 才用 `npx -y <npxSpec>`；預設 false。
- `failOnStartupError`：true 時，**sync preflight（`resolveExecutable`）失敗**才讓 plugin activation 失敗；完整 initialize 仍在背景，不依賴 async `apply`。預設 false。

### 7.4 `lib/executable.js`

```js
export async function resolveCommand({ command, env, ctx, signal }) { ... }
export function scrubEnv(env) { ... }
export function isWindowsScript(path) { ... }
export function buildArgv({ exe, args, root, shellFallback }) { ... }
export async function readVersion({ ctx, exe, env, signal }) { ... }
```

- 解析順序：
  1. `config.command`（若非預設）或 `BASEMIND_BIN`。
  2. `ctx.subprocess.resolveExecutable(command, env, signal)`；`env` 只傳 string-valued entries（`NodeJS.ProcessEnv` 的 undefined 先濾掉）。
  3. 若失敗且 `autoProvision`：解析 `npx` / `npx.cmd`，argv 為 `['-y', npxSpec, ...args, '--root', root]`。
- `scrubEnv`：移除名稱符合 `/KEY|PASSWORD|SECRET|TOKEN/i` 與 `DSH_*` 的變數；保留 `PATH`、`HOME`、`APPDATA`、`LOCALAPPDATA`、`TEMP`、`SystemRoot`、`ComSpec`、`USERPROFILE`、`PATHEXT`；merge `config.env`。
- Windows `.cmd`/`.bat`：
  - **預設**用 `process.env.ComSpec || 'cmd.exe'`，argv `['/d','/s','/c', buildCmdLine([resolved, ...args])]`；不把 direct spawn 當主要路徑。
  - 只有 execution spike 證實 direct 可用時，才把 direct spawn 當優化。
  - `buildCmdLine` 對每個 token 做 Windows quoting；測試含空白、`%`、`&`、`^`、`!`、括號的路徑。若 quoting 不穩定，Windows 要求 `BASEMIND_BIN` 指向 `.exe`。
- `readVersion`：`<exe> --version`，stdout 最多 4 KiB；失敗只 warn，不影響 tools。
- **待確認**：`ctx.subprocess` 對 `.cmd` 的直接支援；Plan 要求 execution 先做 5 分鐘 spike，再決定 primary path。

### 7.5 `lib/stdio-client.js`

```js
export function createStdioClient({
  argv, cwd, env, startupTimeoutMs, toolCallTimeoutMs,
  logger, onNotification, onClose,
  spawn = (spec) => ctx.subprocess.spawn(spec), // injectable for tests
}) { ... }
```

介面：

```js
{
  start(signal): Promise<void>,          // spawn + initialize handshake
  request(method, params, opts): Promise<any>,
  notify(method, params): void,
  close(): Promise<void>,
  readonly closed: boolean,
  readonly stderrTail: string,
}
```

重點：

- `start`：`spawn`；取得 `stdin/stdout/stderr`；attach readers；送 `initialize`；等待 response；送 `notifications/initialized`。
- `request`：遞增 id；寫入 `JSON.stringify(msg)+'\n'`；pending Map；timeout timer；`signal` abort listener；response/err 移除 listener。
- `stdout` 解析：以 `\n` 切行；每行 JSON；response 比對 id；notification 交 `onNotification`；server request 由 handler 回覆。
- `stderr`：累積 tail（最多 8 KiB）；`logStderr` 時 debug log。
- `done`：process exit 時 reject 所有 pending；標記 closed；呼叫 `onClose`；不自動重啟。
- `close`：移除 listeners；`stdin.end()`（盡力）；`handle.terminate()`；`await handle.waitForExit(AbortSignal.timeout(3000))`；若 timeout，warn；不 kill 其他 process。
- backpressure：`stdin.write` 回 false 時等待 `drain`（可選；message 小，先記錄）。
- 最大 line 保護：例如 16 MiB，超過則關閉並報錯。

### 7.6 `lib/mcp-session.js`

```js
export function createMcpSession(client, { serverName, logger }) {
  return {
    initialize(),
    listTools(),
    callTool(rawName, args, { signal, timeoutMs }),
    listResources(cursor),
    listResourceTemplates(cursor),
    readResource(uri),
    close(),
    get instructions(),
    get capabilities(),
  };
}
```

- `listTools`：loop `cursor`，合併 `tools`；遇到重複 raw name 視為 invalid（log，保留第一個）。
- `callTool`：`client.request('tools/call', {name, arguments}, ...)`。
- `readResource`：`client.request('resources/read', {uri})`。
- `initialize`：保存 `serverInfo`、`protocolVersion`、`capabilities`、`instructions`。
- `close`：委派 client。

### 7.7 `lib/schema.js`

```js
export function normalizeInputSchema(schema) { ... } // -> JsonSchemaNode
export function normalizeToolName(rawName) { ... }
export function publicToolName(serverName, rawName) { ... }
```

Normalization 規則：

1. root 必須是 object；否則回 `{type:'object', properties:{}}`。
2. `type` 是 array：
   - 移除 `'null'`；
   - 只剩一個 → 用該 type；
   - 多個 → `{ oneOf: [...] }`；
   - 空 → unconstrained object。
3. `type: 'object'`：遞迴 `properties`；`required` 只保留存在於 `properties` 的 key；`additionalProperties` 只保留 boolean。
4. `type: 'array'`：遞迴 `items`。
5. scalar：保留 `type`、`enum`（只留 scalar）、`const`、`description`、`title`、`default`。
6. 移除 `$schema`、`$id`、`$ref`、`anyOf`、`allOf`、`format`、`minimum`、`maximum`、`pattern`、`examples` 中 DSH 不支援者；`anyOf` 若只有一個分支，遞迴該分支；多分支則 `oneOf`（log 一次）。
7. 空 schema / 無法辨識 → `{ description: 'unconstrained JSON value' }`。
8. `required` 必須是 string array；`enum` 必須非空 scalar array。

- `normalizeToolName`：若 raw 符合 `/^[A-Za-z0-9_-]{1,64}$/` 直接用；否則替換非法字元為 `_`，若仍衝突，追加 8 位 SHA-256 hex。
- `publicToolName`：``mcp__${serverName}__${normalized}``；長度超過 64 時截斷 raw 並加 hash。

### 7.8 `lib/result.js`

```js
export function projectContent(value) { ... } // -> ContentBlock[]
export function resultText(value) { ... }
```

- `text` → text block（保留原順序）。
- `resource_link` → `Resource link: <name> (<uri>)`。
- `image` → `[image result: <mimeType>, <n> bytes; not projected into model context]`。
- `audio` → `[audio result unsupported: ...]`。
- `resource`（embedded）→ `[embedded resource unsupported; ...]`。
- 未知 type → `[unsupported MCP content type: ...]`。
- 空 content → 一個空 text block（DSH 需要至少一個 block）。
- 不把 base64 payload 寫入 text。

### 7.9 `lib/tool-bridge.js`

```js
export function createToolDefinition({ serverName, rawTool, pool, ctx, config }) { ... }
```

- `execute(args, exec)`：
  1. `if (exec.signal.aborted) throw exec.signal.reason ?? new Error('BaseMind call cancelled')`；args 必須是 plain object，否則 throw。
  2. `agent = exec.agent ?? ctx.get('agents')?.currentInitiator()`；若無 agent，throw（不要用 `defaultDirectory` 猜 workspace，避免讀寫錯 repo）。`root = await ctx.workingDirectory.ensure(agent, exec.signal)`。
  3. `session = await pool.clientFor(root, exec.signal)`.
  4. `if (!session.hasTool(rawTool.name)) throw new Error('BaseMind tool ... is not available in this workspace/version')`.
  5. `result = await session.callTool(rawTool.name, args, { signal: exec.signal, timeoutMs: config.toolCallTimeoutMs })`.
  6. `if (result.isError) throw new Error(resultText(result) || 'BaseMind tool failed')`.
  7. return `{ text: resultText(result), content: result.content ?? [] }`（`structuredContent` 留在 session 內部；v1 不進 model-facing output schema，避免額外 schema 邊界風險）。
- `output.render`：`projectContent(value)`。
- 錯誤訊息包含 raw tool name、root、BaseMind stderr tail（截斷），不包含 args/secret。
- `isConcurrencySafe: () => false`。
- `timeoutMs: config.toolCallTimeoutMs + 5000`（宣告用；內部 timeout 較早）。

### 7.10 `lib/workspace-pool.js`

```js
export function createWorkspacePool({ ctx, config, logger, createSession }) {
  return {
    clientFor(root, signal): Promise<McpSession>,
    drop(root): Promise<void>,
    disposeAll(): Promise<void>,
    get size(),
    get roots(),
  };
}
```

- key = `normalizeRoot(root)`：`path.resolve`；Windows 額外 `toLowerCase()` 作 key，但 spawn 用原路徑。
- `Map<key, {promise, session, root, lastUsed}>`；in-flight 用 promise 去重，避免同一 root 同時 spawn 多個。
- `maxClients` 到達時：不 evict；throw `BASEMIND_TOO_MANY_WORKSPACES`，訊息列出目前 roots 與調整 `maxClients` 的建議。
- `clientFor` 失敗：刪除 entry，讓下一次重試。
- **caller signal 只取消「等待」**：`clientFor(root, signal)` 不得把 caller 的 signal 傳給共享 spawn；否則第一個 caller abort 會殺掉其他 caller 共用的 session。spawn 使用 pool 自己的 controller；caller abort 只讓該次 `clientFor` reject，session 繼續供後續使用。
- `disposeAll`：逐一 `session.close()`；`Promise.allSettled`；清空 Map；記錄未正常關閉者。
- `drop(root)`：同步 terminate 該 session、從 Map 移除、等待退出；用於 collision 或明確失效。
- 不按 process name 搜尋/殺 process；只操作自己 spawn 的 handles。

### 7.11 `index.js`

- 解析 config；建立 pool。
- primary root = `ctx.workingDirectory.defaultDirectory`；`void initializePrimary()`。
- `initializePrimary`：
  - `session = await pool.clientFor(primaryRoot, signal)`（`clientFor` 回傳已完成 spawn + initialize handshake 的 session）；
  - `tools = await session.listTools()`；
  - **先做 collision 檢查**（見下）；若 collision，log、`await pool.drop(primaryRoot)`、`ready = false`，**不註冊 prompt/resources/tools**（避免 resources 指向一個沒有 tools 的來源）。
  - 若 instructions → register prompt section；
  - 若 `mcpResources` → register provider（失敗只 warn，不影響 tools）；
  - `syncTools(tools)`；
  - 設定 `ready = true`。
- `syncTools(tools)`：
  - 先檢查 collision：對每個 public name，`existing = ctx.tools.get(name)`；若存在且不是目前 generation 的 tool，log 並**整個 generation 跳過**（避免部分註冊）。
  - 對每個 tool 先做 normalize + local validator；validation error **只降級該 tool** 的 schema 為 unconstrained object 並 log，不讓整個 generation 失敗。
  - **先卸載舊 generation**（保存 `previous` 的 definitions + disposers），再依序 `ctx.tools.register` 新 generation；不能先註冊新 tool 再卸載舊 tool，否則同名會 duplicate。
  - 若新註冊 throw：dispose 新 generation 已註冊的部分，嘗試用 `previous` definitions 重建舊 generation；重建成功則回到舊狀態，失敗則 tools 暫時缺席並 log。
  - 成功後 `currentGeneration = new`；用 `syncChain` 序列化 list_changed 的 re-sync（re-sync 時重新 `listTools()`）。
- `agent/created` listener：若 `!ready` 且沒有 in-flight retry，重試 primary；有 backoff（例如 5s、30s、5min），避免每個 agent 都 spawn。
- `ctx.effect` cleanup：
  - `disposed = true`；abort init controller；
  - dispose prompt、resource provider、event listener；
  - dispose 所有 tool generations；
  - 先對每個 session **同步**呼叫 `handle.terminate()`（確保 process 立刻收到終止，不依賴 cleanup 是否被 await），再 `await pool.disposeAll()` 等待退出（每個 ≤3s）；
  - 不 throw（log）。
- `failOnStartupError: true`：只做 **sync preflight**（`resolveExecutable`）並在失敗時 throw；**不 await 完整 initialize**，也不依賴 async `apply`。完整 initialize 一律背景，失敗 warn + `agent/created` 重試。

---

## 8. Tool 名稱、Collision 與既有 MCP row

- 預設 `serverName = 'basemind'`，public name `mcp__basemind__<raw>`。
- 若 profile 已有 `@deepseek-ai/dsh-mcp-client` 且 `serverName: basemind`：
  - 插件在自己的 generation 前檢查 `ctx.tools.get('mcp__basemind__admin')` 等名稱；若已存在，log `basemind MCP already configured; dsh-basemind-plugin will stay inactive`，不註冊，避免 duplicate。
  - **Load order caveat**：若我們的 plugin 先載入、手動 MCP row 後載入，手動 row 可能因名稱衝突而失敗。因此 README 明示：啟用本插件前，先停用/移除既有 `serverName: basemind` 的 MCP row；插件不會代改。
  - 若既有 row 使用不同 `serverName`（例如 `basemind-repo`），兩者可共存；文件說明會看到兩套工具。
- `serverName` 可由 config 改；resource provider/prompt section 也跟著改。
- 不自動偵測/刪除其他 plugin 的工具；只跳過 collision。
- **不繞過 preset 政策**：不因 `ctx.tools.restrict` 或 `isolate` 而改用 `agent.ctx` per-agent 註冊；Standard/PTC 繼承 global，minimal 若刻意限制則接受；真正 isolate 的 preset 需另案加 preset row。

---

## 9. 生命週期、併發與清理

### 9.1 Activation

1. `apply` 解析 config、建立 pool、掛 `ctx.effect`；預設背景啟動 primary；`failOnStartupError:true` 只做 sync preflight（`resolveExecutable`），不 await 完整 initialize。
2. 成功後註冊 tools/resources/prompt；失敗只 warn。
3. 若 Primary 失敗，等 `agent/created` 重試；backoff 避免風暴。

### 9.2 Per-call

- 每次 tool call 重新 `workingDirectory.ensure`；不緩存 agent cwd。
- `pool.clientFor` 對同一 root 去重；不同 root 平行 spawn（但 tool 執行因 `isConcurrencySafe:false` 而序列化）。
- MCP request 有獨立 timeout；`exec.signal` abort 時送 cancelled。

### 9.3 Tool list change

- `notifications/tools/list_changed` → `syncTools`（serialize）。
- 先卸載舊 generation，再註冊新 generation；失敗時 dispose 新 partial 並嘗試用保存的 definitions 重建舊 generation。
- 重建失敗則 tools 暫時缺席並 log；下一次 list_changed / agent 重試再試。不因單一 tool 變更而留下半套 generation。

### 9.4 Relay crash

- `onClose`：reject pending；從 pool 移除；不自動重試 tool call。
- 下一次 `clientFor` 重新 spawn；若 daemon 已死，`serve` 會重建。
- 不在背景無限重連；避免 crash loop。

### 9.5 Shutdown / HMR

- `ctx.effect` cleanup：
  - abort init；
  - dispose tools/resources/prompt/listener；
  - 先同步 `terminate()` 每個 session handle，再 `pool.disposeAll()` 等待退出（≤3s/個）；
  - 若 terminate 失敗，warn；不按名稱殺 process。
- `serve` 關 stdin 不會退出，所以 `close` 必須 `terminate()`。
- BaseMind `comms daemon` 可能是 `serve` 的子程序；terminate 可能帶走 shared daemon。v1 接受「卸載時 daemon 可能重建」；文件說明。若 execution 證實 daemon 不在 Job tree，則只影響 relay。

### 9.6 無 idle eviction

- relay 保留到卸載；`maxClients` 預設 32。
- 理由：中途 terminate 可能影響 shared daemon；且 session 可能隨時切回舊 workspace。
- 若使用者長期開很多 workspace，可提高 `maxClients` 或重啟 DSH；文件說明。
- **同一 repo 的不同子目錄**會各自建立 relay（key 用 session cwd，不先解析 BaseMind 的 repo root）；v1 接受此重複，`maxClients` 保護。未來可用 `admin {mode:'repo'}` 或 `resources/read basemind://status` 的 root 做 canonicalization，非 v1 scope。

---

## 10. 配置（row config）

| 欄位 | 預設 | 說明 |
|---|---|---|
| `serverName` | `basemind` | tool prefix 與 resource provider 名稱；`[A-Za-z0-9_-]{1,32}` |
| `command` | `basemind` | BaseMind executable；`BASEMIND_BIN` 優先 |
| `args` | `['serve']` | 傳給 BaseMind 的 args；插件在末尾附加 `--root <root>` |
| `env` | `{}` | 額外環境變數；覆蓋 scrubbed parent env |
| `toolCallTimeoutMs` | `120000` | 單次 tools/call timeout |
| `startupTimeoutMs` | `60000` | spawn + initialize timeout |
| `maxClients` | `32` | workspace relay 上限；到達時拒絕新 root，不 evict |
| `autoProvision` | `false` | PATH 找不到時是否用 `npx -y <npxSpec>` |
| `npxSpec` | `basemind@latest` | `autoProvision` 使用；可指定任何版本 |
| `failOnStartupError` | `false` | true 時只有 sync preflight（`resolveExecutable`）失敗才讓 activation 失敗；完整 initialize 仍背景 |
| `logStderr` | `true` | 是否 debug log BaseMind stderr tail |

範例（使用者自己的 `cordis.patch.yml`）：

```yaml
- id: dsh-basemind
  config:
    serverName: basemind
    command: 'C:\Tools\basemind.exe'
    args: ['serve']
    toolCallTimeoutMs: 300000
```

注意：override 會整段取代 bundle 的 `config`；未列出的欄位回到程式預設（本插件以 `resolveConfig` 補預設）。

- 需求 R1/R2 的「不需要 MCP 設定」由插件完成；BaseMind binary 本身仍是外部依賴。若要做到連 binary 都零安裝，將 `autoProvision: true`，插件會在 PATH 找不到時以 `npx -y basemind@latest` 啟動（需要 Node/npm 與網路）；預設 false 以避免 silent download。

### 10.1 為何沒有 `Config` schema

- local directory install 是 link checkout；插件檔案在 workspace，從 workspace 解析不到 profile 的 `@deepseek-ai/schemastery`（實測 `@deepseek-ai/dsh-mcp-client` 也解析不到）。
- 不引入 dependency 是為了 zero-install、可移植、避免 pnpm/build script。
- `dsh-mcp-manager` 是無 `Config` 的 profile plugin 先例。
- 代價：Plugin Manager 不會顯示結構化 settings form；使用者以 `cordis.patch.yml` 設定。README 完整記錄欄位。
- 待確認：無 `Config` 的 row 在 `Config.listConfigs` 的 `status` 顯示；execution 需確認不是 load failure。

---

## 11. 錯誤處理、安全與邊界

| 情境 | 行為 |
|---|---|
| BaseMind 不在 PATH | primary init 失敗；warn（含 command、`BASEMIND_BIN`）；不註冊 tools；`agent/created` 重試；DSH 正常 |
| `resolveExecutable` 失敗 | 同上；訊息含嘗試的 command，不含 env secret |
| spawn 失敗 | 同上；保留 stderr tail |
| initialize timeout | 關閉 relay；warn；下一次呼叫重試 |
| tools/list 為空 | 不註冊 tools；仍可 resources/instructions；log |
| tools/call timeout | 送 cancelled；throw `BaseMind tool timed out after ...`；不自動重試 |
| tools/call `isError` | throw，message 取 text content；DSH 標記 tool error |
| relay crash | reject pending；pool 移除；下一次呼叫重啟 |
| schema 無法 normalize | 降級為 unconstrained object；log 一次；不讓整個 generation 失敗 |
| tool name collision | 整個 generation 跳過；保留既有工具；log |
| `mcpResources` 不存在 | 跳過 resources；tools 正常 |
| resource provider 同名 | catch；warn；跳過 |
| prompt section 同名 | catch；改用 `mcp:<server>:plugin` 或跳過 |
| root 太多 | throw `BASEMIND_TOO_MANY_WORKSPACES`；列出 roots；不 evict |
| agent cwd 被刪除 | `workingDirectory.ensure` 會嘗試恢復；失敗則 tool error |
| 非 git 目錄 | BaseMind 可能仍可 serve；若失敗，tool error；待確認 |
| remote workspace | 依 `ctx.subprocess` provider；若 execution world 沒有 BaseMind，tool error；文件說明 |

安全：

- `scrubEnv` 移除 `*KEY*`、`*PASSWORD*`、`*SECRET*`、`*TOKEN*` 與 `DSH_*`；保留執行必需變數。
- 不用 shell interpolation（除 Windows `.cmd` fallback 的必要 quoting）；tool args 不進 shell。
- 不記錄完整 args/result；stderr tail 8 KiB。
- `autoProvision` 預設 false；開啟時只執行 `npx -y <npxSpec>`，`npxSpec` 由使用者設定。
- 不自動 scan/rescan；不寫 repo；BaseMind 自己管理 cache。
- 只 terminate 自己 spawn 的 handles；不按 process name 掃描/殺 process。
- Tool result 不靜默截斷；交由 DSH 的 tool-result pruner。

---

## 12. 版本兼容策略

1. **No version gate**：不解析 BaseMind semver 來 allow/deny；任何能完成 MCP initialize 的版本都可。
2. **Feature = discovery**：`tools/list` / `resources/list` 是唯一功能來源；新 tool/mode 自動出現，舊版缺少的自動不出現。
3. **Protocol fallback**：`2025-06-18` → `2025-03-26` → `2024-11-05`；每次失敗重啟 process。0.29.3 已驗證第一個。
4. **Schema robustness**：normalize type array/`anyOf`/`$ref`/bounds；base 0.29.3 與 0.31.0 fixtures 都跑測試。
5. **Result robustness**：只保證 text；image/audio/resource 以 diagnostic text，不讓未知 block 讓 tool crash。
6. **Upgrade behavior**：既有 relay 保留舊版本；新 root/重啟後用新版本；若 server 發 `tools/list_changed` 自動 re-sync。文件說明「升級 BaseMind 後重啟 DSH 或停用/啟用插件」。
7. **Side-by-side**：`command`/`BASEMIND_BIN` 可指向不同版本；`serverName` 可改，避免與其他 MCP 衝突。
8. **Test matrix**：`0.29.3`（本機）、`0.30.0`（npm latest 回報）、`0.31.0`（GitHub latest）；可選 `0.22.x` 驗證舊版 protocol fallback。`0.31.0` 是最新功能目標，但不作 gate。
9. **單一 Host 假設**：同一 Host 內以一個 BaseMind 安裝/版本為主；global tool schema 由 primary session 決定。若不同 workspace 指向不同 binary（v1 config 不支援 per-root command），只保證 primary 的 tool 集合；其他 workspace 缺少的 tool 會在呼叫時明確報錯。

---

## 13. 測試計畫

### 13.1 單元測試（Node `node:test`，無外部依賴）

| 測試 | 內容 |
|---|---|
| `stdio-client.test.mjs` | 注入 fake spawn/streams；初始化、request/response、notification、server request（ping）、timeout、abort/cancelled、close、partial line、invalid JSON、stderr tail |
| `schema.test.mjs` | BaseMind 0.29.3 `code`/`admin`/`graph` fixture；type array → single/oneOf；`mode` enum 保留；`required` 保留；`$schema`/format 移除；root 非 object；deep nested |
| `tool-bridge.test.mjs` | fake pool/session；args 驗證；root 解析；missing tool；isError；text/resource_link/image diagnostic；output.render |
| `workspace-pool.test.mjs` | 同 root 去重；不同 root；失敗移除；maxClients；disposeAll |
| `index-sync.test.mjs` | 初次註冊；list_changed 替換（先卸載舊、再註冊新）；registration failure 時 restore 舊 generation；restore 失敗時 tools 缺席；collision 時整個 generation 跳過 |
| `config.test.mjs` | defaults、invalid serverName、args `--root` 移除、clamp、env merge |
| `executable.test.mjs` | POSIX 直跑；Windows `.cmd` wrapper quoting（含空白、`%`、`&`、`^`、`!`、括號路徑）；scrubEnv |

### 13.2 Integration（真實 BaseMind，可選跳過）

- `basemind` 不存在時 `skip`（`t.skip`）。
- 兩個 root（workspace + 暫存目錄）各啟動一個 session；`tools/list` 至少 9 個；`admin {mode:'status'}` 回傳的 `root` 與傳入 root 相符；`code {mode:'outline', path:...}` 回傳內容。
- `resources/list` 包含 `basemind://status`；`resources/read` 回傳 JSON。
- `close()` 後 process 不再存活（用 `waitForExit` 驗證；不按名稱掃描）。
- 測試結束清理所有 session；不留下 daemon（若 daemon 是 shared，允許留下並記錄）。

### 13.3 DSH Runtime 驗證（execution phase）

1. `node --check index.js`、`node --check lib/*.js`、`node --test`。
2. `plugin_manager` `install_bundle`（absolute package dir）；確認回傳 `application: applied`，保留 `warnings`。
3. `cordis_inspect_query Config.listConfigs`：entry `include:dsh-basemind`（或實際 patchId）存在；確認 `status` 不是 load failure。
4. `cordis_inspect_query Tool.listTools`：9 個 `mcp__basemind__*`；名稱/描述/schema 與 BaseMind `tools/list` 對應。
5. Session A（workspace A）呼叫 `mcp__basemind__admin {mode:'status'}`；確認 `root` = A。
6. Session A `cd` 到 workspace B；再呼叫；確認 `root` = B（可能 spawn 第二個 relay）。
7. 呼叫 `mcp__basemind__code {mode:'outline', path:'...'}`；確認內容。
8. `list_mcp_resources {server:'basemind'}`；`read_mcp_resource {server:'basemind', uri:'basemind://status'}`。
9. 檢查 system prompt 是否含 BaseMind instructions：可用 session log / `system/message` 或 DSH 的 prompt 檢視；若無直接介面，至少以 unit test 驗證 section 註冊，並在報告標明「runtime prompt 未直接觀測」。
10. 停用/卸載 bundle：`Tool.listTools` 不再有 `mcp__basemind__*`；process 清理；resource tools 的 server 名稱消失。
11. 缺少 binary：暫時以 `command: 'definitely-not-basemind'` 測（在可回復的測試 row/profile），確認 DSH 啟動、warning、無 tools；測完還原。
12. 既有 `basemind` MCP row：在測試 profile 或暫存 row 測 collision；不要改使用者現有配置。
13. Plugin Manager 顯示 title/description/icon（en/zh）；無 console error。

### 13.4 效能/容量

- 量測 primary 啟動到 tools 可見的時間（目標 < 3s；首次 daemon 啟動可能更久）。
- 量測 9 個 tool schema 的 token 成本（約 34 KB JSON；實際 token 由 model tokenizer 決定）；記錄在 README。
- 量測 cold/warm tool call latency；`admin status`、`code outline`。
- 量測多 root（2–4）process 數與記憶體；確認 `maxClients` 行為。

### 13.5 驗收矩陣

| 編號 | 驗收 | 方法 |
|---|---|---|
| A1 | 不安裝 MCP row 也能用 | Tool.listTools + 實際 call |
| A2 | 9 tools / 最新版功能 | 0.29.3 + 0.31.0 tools/list |
| A3 | per-workspace routing | A/B root 驗證 |
| A4 | resources | shared resource tools |
| A5 | instructions | prompt section / log |
| A6 | missing binary graceful | 測試 row |
| A7 | unload cleanup | process/tool 檢查 |
| A8 | no duplicate | collision 測試 |
| A9 | display metadata | Plugin Manager |
| A10 | tests pass | `node --test` |

---

## 14. 安裝、回滾與授權

### 14.1 安裝（execution phase）

- 以 `plugin_manager` `action: install_bundle`、`target` = workspace 絕對路徑（`D:\02_zengjunlin\github\dsh-basemind-plugin`）。
- 不要手寫 profile `package.json` / `cordis.patch.yml`；不要 `pnpm add`。
- 讀回 `application` / `warnings`；只有 `application: applied` 才視為 live。
- 若套件含 install script（本計畫沒有），才需要 `approvedBuilds`；本插件不應有。
- 安裝後可能 HMR 生效；若是 replacement/版本更新，可能需要重啟 DSH 才能載入新 JS generation。

### 14.2 回滾

- `plugin_manager` `set_bundle`/`remove_bundle` 或 `set_plugin` 停用；不改既有 MCP rows。
- 若使用者曾手動 override `id: dsh-basemind`，回滾時保留其 patch；必要時由使用者自行移除。
- 不在本階段執行。

### 14.3 授權

- 本 session 的 approval policy 目前為 `never`；`plugin_manager` actions 需要 approval，**在目前 session 不能安裝**。Execution 必須在可 approval / full access 的 session 且取得使用者明確授權後進行。
- Git：不得自行 commit/push；完成後由使用者審查。

---

## 15. 風險與待確認事項

### 15.1 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| Standard/PTC/minimal preset 對 tools 做 restrict/isolate | 某些 preset 看不到 BaseMind tools | 不改 preset、不以 per-agent scoped registration 繞過 restrict；文件說明「root tools 受 preset 政策影響」；驗證 standard/ptc；minimal 若刻意限制則接受 |
| `serve` relay 與 shared `comms daemon` 生命週期 | terminate relay 可能帶走 daemon，影響其他 root | v1 不 evict；卸載才 terminate；接受 daemon 由 BaseMind 重建；文件說明；不按名稱殺 process |
| Windows `.cmd` 不能直接 spawn | 插件在 Windows 無法啟動 | **預設 `cmd.exe /d /s /c` wrapper**；direct spawn 只作已驗證優化；測試含空白/`%`/`&`/`^`/`!`/括號路徑 |
| DSH `JsonSchemaNode` 邊界拒絕 BaseMind schema | tools 註冊失敗 | normalize（type array → single/oneOf、移除不支援 keyword）；fixture 測試；失敗降級 unconstrained |
| 既有 `basemind` MCP row 名稱衝突 | 其中一方載入失敗 | 啟動前 collision 檢查；README 要求先停用舊 row；不改舊 row |
| 9 個大 schema 的 token 成本 | 每 request 增加 context | 量測；README 記錄；未來可評估 `deferLoading` 或 broker 模式（非 v1） |
| BaseMind 首次啟動/daemon 慢 | 第一 turn 看不到 tools | 背景初始化；`agent/created` 重試；不阻塞 DSH |
| BaseMind 升級後舊 relay 仍用舊版 | 功能看似未更新 | 文件說明重啟/停用啟用；支援 `tools/list_changed` 時自動 re-sync |
| remote/SSH workspace 沒有 BaseMind | tool error | 文件說明；使用 `ctx.subprocess` 跟隨 execution world；未來可加 detection |
| 無 `Config` schema | 使用者沒有 settings form | README 完整欄位；以 `cordis.patch.yml` 設定；未來可評估 bundled dependency |
| npm latest 0.30.0 vs GitHub 0.31.0 | 測試/文件版本不一致 | 以 GitHub 0.31.0 為 target；用 `npx basemind@0.31.0` 或 `BASEMIND_BIN` 測試；文件註明 |

### 15.2 待確認（不得自行假設）

| 編號 | 待確認 | 確認方式 | 若失敗的 fallback |
|---|---|---|---|
| Q1 | `ctx.subprocess.spawn` 能否直接執行 Windows `.cmd` | 以 `resolveExecutable('basemind')` + 小 spike | **預設 `cmd.exe /d /s /c` wrapper**；direct spawn 只在 spike 證實後當優化 |
| Q2 | `resolveExecutable('basemind')` 回傳的實際 path/類型 | 在 execution 印出 `/^.*\.(cmd|bat|exe)$/i` | 以 `BASEMIND_BIN` 指定 `.exe`；`.cmd` 走 wrapper |
| Q3 | DSH registry 對 normalized schema 的完整接受度 | 以 9 個 fixture schema 逐一 `ctx.tools.register` | 降級為 unconstrained object / 縮減 keyword |
| Q4 | `mcpResources.register` 從 profile-local plugin 註冊/provider `exec.agent` 是否總存在 | runtime 呼叫 `list_mcp_resources` | 若 provider 不可用，跳過 resources，只提供 tools |
| Q5 | prompt section 在 standard/ptc/minimal presets 的可見性；`getSectionOrder('MCP_SERVERS')` runtime 是否回 3100 | 各 preset 開 session 檢查 prompt；unit/runtime 呼叫 | 文件說明 preset 政策；order 直接用常數 3100 |
| Q6 | 0.31.0 的 tools/resources 與 0.29.3 差異 | 以 `BASEMIND_BIN`/`npx basemind@0.31.0` 跑 probe | dynamic discovery 自然處理；記錄差異 |
| Q7 | BaseMind 是否發 `tools/list_changed` | 長時間 session / 升級 binary 後觀察 | 重啟/停用啟用刷新；文件說明 |
| Q8 | `serve` 的 `comms daemon` 是否在 relay Job tree | 以 `ctx.subprocess` spawn 後 terminate，檢查 daemon | 若會帶走 daemon，**接受卸載時 daemon 重建**；v1 不加 anchor relay；文件說明 |
| Q9 | BaseMind 非 git 目錄行為 | 在暫存空目錄 `serve` + `admin status` | tool error 明示；文件說明需 repo |
| Q10 | 無 `Config` 的 row 在 Plugin Manager/`Config.listConfigs` 的狀態 | install 後查詢 | 若 loader 要求 Config，改為 bundled `schemastery`（需重新評估 dependency） |
| Q11 | 既有 profile 是否有其他 `serverName: basemind` row | 檢查所有 profile 的 `cordis.patch.yml` / `mcp-manager.json` | 文件要求先停用；collision skip |
| Q12 | Standard preset 的 child plugins 是否隔離 tools | 讀 live preset composition 或實測 | 若隔離，需另案討論是否加 preset row（目前禁止）；不繞過 |
| Q13 | `dsh.compatibility` metadata 是否造成 install 阻擋 | install 後看 `application`/`warnings` | 移除 `compatibility` 或放寬 range |
| Q14 | `apply` 回傳 Promise 是否被 Loader await | 只在需要完整 fail-fast 時做最小 spike | **核心不依賴**；`failOnStartupError` 只做 sync preflight，完整 init 背景 |
| Q15 | PTC `run_code` 的 nested BaseMind call 是否總有 `exec.agent` 或可用的 `currentInitiator()` | 在 `preset-ptc` 以 `run_code` 呼叫 BaseMind tool | 若都沒有，明確報錯並要求 native 模式；不要猜 workspace |

### 15.3 優先 7 項的建議（Decision Recommendation）

| 優先項 | 對應 Q | 建議 | 理由 / 驗證 |
|---|---|---|---|
| 1. Windows `.cmd` | Q1/Q2 | **預設走 `cmd.exe /d /s /c` wrapper，不依賴 direct spawn**；只有 runtime 證實 direct 可用才當優化。 | 直接 spawn `.cmd` 在 Windows 不保證成功；wrapper 可預測。測試含空白、`%`、`&`、`^`、`!`、括號路徑；失敗時要求 `BASEMIND_BIN` 指向 `.exe`。 |
| 2. Schema 邊界 | Q3 | **本地 strict normalize + local validator；永不 raw passthrough**。type array → single/oneOf；移除 `$schema`/`format`/bounds/`$ref`；保留 `mode` enum、required、properties、description。 | DSH `JsonSchemaNode` 不支援 type array/anyOf；先驗證再註冊，避免 registry 半途失敗。以 9 個 fixture schema 逐一驗證；validation error 只降級該 tool，name conflict 才跳過整個 generation。 |
| 3. `mcpResources` | Q4 | **做成 optional、non-fatal**：collision 檢查後才註冊；失敗只 warn，tools 仍可用。 | Resources 是加值，不是核心；shared resource tools 已存在。provider 用 `exec.agent ?? currentInitiator()`，兩者都無就明確報錯。 |
| 4. Preset 隔離/限制 | Q5/Q12 | **維持 profile-root global scope，不繞過 preset 政策**。Standard/PTC 列為 acceptance gate；minimal 若刻意 restrict，接受並文件化。 | 用 per-agent scoped registration 繞過 restrict 會違反 preset 意圖、增加 9×N 工具與維護成本；若 preset isolate `tools`，唯一正解是加 preset row（目前禁止）。 |
| 5. `comms daemon` 生命週期 | Q8 | **v1 不做 idle eviction；relay 保留到插件卸載；卸載才 terminate**。接受 daemon 可能被一起帶走並由 BaseMind 重建。 | `serve` 關 stdin 不會退出；中途 terminate 可能影響其他 root。不要按 process name 殺 process；只 terminate 自己的 handles。 |
| 6. Async `apply` | Q14 | **核心不依賴 async apply**：`apply` 保持同步，初始化背景跑；`failOnStartupError` 改成「sync preflight（resolveExecutable）失敗才 throw」，或 v1 直接移除。 | Loader 是否 await `apply` 未確認；把 activation 綁在未知行為上不值得。背景初始化 + `agent/created` 重試已足夠。 |
| 7. PTC agent | Q15 | **`exec.agent ?? ctx.get('agents')?.currentInitiator()`；兩者都無就 fail closed**，不要用 `defaultDirectory` 猜 workspace。 | 猜錯 root 可能讀寫錯 repo；PTC 若真的沒有 agent，應明示限制，而非默默路由。以 `preset-ptc` 的 `run_code` 驗證。 |

**建議實作順序**：先做 Q3（schema validator）與 Q15（PTC agent fail-closed），因為它們直接影響正確性；Q1 以 wrapper 實作、不阻塞；Q4、Q5/Q12、Q8、Q14 可在 runtime 驗證階段處理，不阻擋第一版。

---

## 16. 執行任務分解（給 Execution Agent）

> 以下任務**尚未執行**。每個任務都要有 targeted verification；不要擴大 scope。

### T0 — Preflight（0.5h）

- 確認 workspace、Git baseline（`git status`，目前無 commit）、Node `>=22`、`basemind --version`。
- 確認 profile 沒有 `dsh-basemind` row、沒有 `serverName: basemind` 的 MCP row；若有，先記錄，不修改。
- 確認 approval policy；若 `never`，停止安裝相關步驟，先完成 code/tests。
- 輸出：baseline 記錄、風險清單。

### T1 — Scaffold（1h）

- 建立 `package.json`、`cordis.patch.yml`、`locale/en.json`、`locale/zh.json`、`icon.svg`、`README.md` skeleton。
- `icon.svg` 必須原創（例：抽象節點圖 + B 字母），不得複製 BaseMind logo；MIT。
- 驗證：`node --check` 不適用 JSON；以 `node -e "JSON.parse(...)"` 驗證 manifest/locale；確認 `exports`/`files` 包含所有 runtime 檔。

### T2 — stdio client（2–3h）

- 實作 `lib/executable.js`、`lib/stdio-client.js`。
- 以 injectable spawn/streams 寫 `stdio-client.test.mjs`。
- 先做 Q1/Q2 spike：以最小 test plugin（或 DSH 內部 harness）呼叫 `ctx.subprocess.resolveExecutable` + `spawn` 測 `.cmd`；**預設直接採 `cmd.exe /d /s /c` wrapper**，direct spawn 只在 spike 證實可用時當優化，不阻塞。
- 驗證：`node --test test/stdio-client.test.mjs`。

### T3 — MCP session（1–2h）

- 實作 `lib/mcp-session.js`：initialize、tools/list pagination、tools/call、resources。
- 寫 mock server integration（可與 T2 合併）。
- 驗證：unit tests；以真實 `basemind serve` 做一次手動 probe（不進 CI）。

### T4 — Schema / result / tool bridge（3–4h）

- 實作 `lib/schema.js`、`lib/result.js`、`lib/tool-bridge.js`。
- 以 BaseMind 0.29.3 的 `code`、`admin`、`graph` schema 做 fixtures；若 0.31.0 可取得，另存 fixture。
- 驗證：`schema.test.mjs`、`tool-bridge.test.mjs`；確認 `mode` enum/required 未丟失。

### T5 — Workspace pool（2h）

- 實作 `lib/workspace-pool.js`；注入 `createSession` 以便測試。
- 測試同 root 去重、不同 root、失敗重試、maxClients、disposeAll。
- 驗證：`workspace-pool.test.mjs`。

### T6 — Plugin entry / resources / prompt / lifecycle（3–4h）

- 實作 `index.js`、`lib/config.js`。
- 接入 `ctx.tools.register`、`ctx.mcpResources.register`、`ctx.systemPrompt.section`、`ctx.on('agent/created')`、`ctx.effect` cleanup。
- 驗證：以 fake ctx unit test（可選）或直接進入 T7。

### T7 — Tests / fixtures（2–3h）

- 完成 `node --test`；真實 BaseMind integration（可 skip）。
- `node --check` 全部 JS。
- 驗證：測試全綠；記錄 skip 原因。

### T8 — Install / runtime verification（execution phase，需授權）

- `plugin_manager install_bundle`；讀 `application`/`warnings`。
- 依 §13.3 逐項驗證；記錄每個結果。
- 若 schema/collision/daemon 問題：修同一 bundle，重新安裝；不要建立 duplicate bundle。
- 若需要重啟 DSH：先詢問使用者；不要自行重啟。

### T9 — Docs / handoff（1h）

- README：安裝、設定、版本策略、工具清單、resources、限制、troubleshooting、與手動 MCP row 的關係。
- Execution Report：完成/部分/受阻、檔案、驗證命令與結果、Plan 偏差、風險。
- 不 commit；由使用者審查。

---

## 17. 驗收清單（Execution 完成時逐項勾選）

- [ ] `package.json` 無 dependencies；`exports`/`files` 完整；locale/icon 可讀。
- [ ] `cordis.patch.yml` 只 insert `dsh-basemind`，未改任何既有 row。
- [ ] `node --check` 全部 JS 通過。
- [ ] `node --test` 全部通過（integration 可 skip，需註明）。
- [ ] `plugin_manager install_bundle` 回傳 `application: applied`（或明確的 restart-required 並已處理）。
- [ ] `Config.listConfigs` 找到 `dsh-basemind`，無 load failure。
- [ ] `Tool.listTools` 有 9 個 `mcp__basemind__*`（或該版本實際數量）。
- [ ] Session A/B 的 `admin status` root 正確。
- [ ] `cd` 後下一次呼叫切換 root。
- [ ] `code outline` 有實際內容。
- [ ] `list_mcp_resources`/`read_mcp_resource` 可用。
- [ ] BaseMind instructions 進入 prompt（或明示未直接觀測）。
- [ ] 缺 binary 時 DSH 正常、warning、無 tools。
- [ ] collision 時不產生重複工具。
- [ ] 停用/卸載後 tools/resource/prompt 移除，無 orphan。
- [ ] Plugin Manager 顯示 title/description/icon（en/zh）。
- [ ] README 與 Execution Report 完成；未 commit。

---

## 18. 交接注意事項

1. **不要**把 `basemind` 加入 `package.json` dependencies，也不要用 `npx` 當預設啟動方式；版本自由是需求。
2. **不要**修改 Standard Agent Preset、其他 preset、既有 `cordis.patch.yml` MCP rows、`mcp-manager.json`。
3. **不要**用 `plugin_manager` 以外的 shell 指令手寫 profile `package.json`/patch。
4. **不要**在 schema 邊界不確定時放寬 DSH 的驗證；修正 normalization。
5. **不要**按 process name 殺 `basemind`；只 terminate 自己 spawn 的 handle。
6. 若 Q1/Q3/Q4/Q8 任一失敗，先回到 Plan 調整架構，不要用疊加 fallback 硬上。
7. 若 `serve`/daemon 清理會影響其他 workspace，停止並回報；**v1 不引入 anchor relay**，接受卸載時 daemon 由 BaseMind 重建；必要時限制 `maxClients`。
8. 所有 runtime 測試後恢復使用者狀態（停用測試 row、移除暫存檔、確認無 orphan）。
9. 最終報告分開陳述「已實作」「已驗證」「未驗證」「受阻」。

---

## 19. 參考資料

- BaseMind repo: <https://github.com/Goldziher/basemind>
- BaseMind v0.31.0 release: <https://github.com/Goldziher/basemind/releases/tag/v0.31.0>
- BaseMind plugin README（其他 harness 的橋接經驗）: <https://github.com/Goldziher/basemind/blob/main/plugin/README.md>
- BaseMind npm: <https://www.npmjs.com/package/basemind>
- DSH `cordis-plugin-development` skill references: `references/host-plugin.md`、`references/mcp-bundle.md`、`references/practices.md`、`references/verification.md`
- DSH packages: `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-subprocess`、`@deepseek-ai/dsh-subprocess-local`、`@deepseek-ai/dsh-working-directory`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-mcp-resources`、`@deepseek-ai/dsh-mcp-client`
- 既有 profile plugin 參考：`dsh-mcp-manager`（stdio JSON-RPC、tool 註冊、schema sanitize、result projection）
