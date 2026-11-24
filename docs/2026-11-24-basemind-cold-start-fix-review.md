# dsh-basemind-plugin — 冷啟動修復 Review（2026-11-24）

- 角色：Review Agent（只讀審查；**未修改任何暫存程式碼**）
- 基準：`HEAD = 2a17e9b`（`main`，已 push；`origin/main` 同步）
- 審查對象：目前 **staged** 的 7 個檔案（`git diff --cached`，+444／−14），尚未 commit
- 需求：新 session 的**第一輪**就要看到 BaseMind 工具、bootstrap、skills catalog；BaseMind 不可用時要有界 fallback，不得 hang
- 證據：staged diff、`docs/2026-11-24-basemind-agent-effectiveness-report.md` §11.16、DSH runtime 原始碼、真實 session log、測試結果

---

## 1. 結論

**No Critical。核心修復在預設 `agent` 模式下已被真實冷 process 證實有效。**

但目前**不建議直接 commit**，有兩個支援模式／邊界路徑仍會留下 first-turn gap：

1. **Important**：`discoveryRoot: 'agent-first'` 在初始 deployment root 失敗後，第一個真實 Agent 的 gate 被跳過（`index.js:688`）。
2. **Important**：`workingDirectory.ensure` 超過 `coldStartTimeoutMs` 時，adoption 被永久放棄；後續 retry 在 `agent` 模式沒有 root 可試（`index.js:662-670`、`630`）。
3. **Important（驗收／文件）**：預設 15s 預算短於 cold managed install（Phase 2 實測 13.5–55.7s）；第一次安裝後的第一個 session 仍可能沒有工具。
4. **Validation（非本次 regression）**：`npm test` 完整套件仍會因 `test/integration.test.mjs:578` 的 index build timeout 而不穩定；isolated integration 本次 8/8 pass。
5. **Minor**：`coldStartTimeoutMs` 未寫進 README；報告頂部 §0.2／§10 仍是舊快照。

---

## 2. 已確認有效的部分

### 2.1 根因與 host 契約正確

- `dsh-agent/src/index.ts:174-176`：`agent/created` listener 完成前不釋放 queued work。
- `dsh-agent/src/index.ts:458`：`await this.announce(agent, 'startup')`。
- `dsh-agent-loop/src/index.ts:506`：publication 未完成時 `await publication.promise`。
- 因此 `return adoptAgentRoot(...)` 是正確位置；**不是** host bug，也不需要改 DSH。

### 2.2 真實冷 process 證據（本 Review 重新核對 session log）

| session | 第 1 輪 tools | `mcp__basemind__` | system bytes | 備註 |
| --- | --- | --- | --- | --- |
| `0997fd98`（修復後） | 54 | **19** | 10,350 | bootstrap／10 個 basemind skills |
| `2c02a801`（同 process 第 2 個） | 54 | **19** | 10,350 | 同上 |
| `19c321d6`（修復前） | 34 | **0** | 6,334 | 原始 gap |

- 上述是從 `~/.dsh/sessions/--D-02_zengjunlin-github-dsh-basemind-plugin--/` 的 `session.v4.jsonl.zstd` 直接解出；不是只採信報告文字。
- 預設 `discoveryRoot: 'agent'` 模式的核心修復成立。

### 2.3 測試與檢查

| 命令 | 結果 |
| --- | --- |
| `node --test test/index.test.mjs test/config.test.mjs` | **51/51 pass**（7.2 s） |
| `npm run check` | syntax ok（20 files）＋bundle manifest ok |
| `node --test test/integration.test.mjs`（isolated） | **8/8 pass**（58.8 s） |
| `npm test`（完整，並行） | 本次在 `test/integration.test.mjs:578` index build timeout；未取得全綠 |

- 完整套件失敗與本次 diff 無直接關係：`integration.test.mjs` 不 import `apply()`、不觸發 `agent/created`；isolated 8/8 通過。但**不能宣稱 `npm test` 已全綠**。

---

## 3. Findings

### Important 1 — `agent-first` 仍會在初始 deployment root 失敗後跳過 gate

- **位置**：`index.js:631`（`state.attempted = true`）、`index.js:688`（`gate = ...`）、`index.js:692`（`void startPrimary()`）；測試 `test/index.test.mjs:509-526`。
- **觸發條件**：
  - `discoveryRoot: 'agent-first'`（支援的設定；`fakeSettings` 預設也是這個模式）。
  - apply 時先對 deployment default directory 嘗試；若它不是 project（BaseMind 拒絕），`ensurePrimary` 失敗並設 `state.attempted = true`。
  - 之後第一個真實 Agent 建立，`adoptAgentRoot` 算出的 `gate` 為 `false`（`attempted` 已 true、`initPromise` 已清空），`startPrimary()` 只被 `void`，host 立刻釋放第一輪。
  - 若初始 attempt 仍在進行但稍後失敗，`waitForPrimary` 只等該 attempt；`recheck` 觸發的新 attempt 沒有被等待，第一輪仍可能在 tools 註冊前釋放。
- **證據**：上述行；現有 `agent-first` 測試（`test/index.test.mjs:509`）只 `waitFor` 工具出現，沒有 await `ctx.emit('agent/created')`，也沒有斷言「emit resolve 時 tools 已存在」。新 cold-start 測試（`test/index.test.mjs:404-505`）全部是 `discoveryRoot: 'agent'`，沒有覆蓋 `agent-first`。
- **預期 vs 實際**：預期與預設 `agent` 模式一樣，第一輪等到該 Agent root 的 relay；實際會回到原本的 34 tools／0 BaseMind 症狀。
- **影響**：支援的 `agent-first` 模式（deployment default 不是 project 時正是它的用途）仍沒有 first-turn BaseMind；修復宣稱不完整。
- **最小修復建議**：記錄「最後一次 attempt 的 root」；當目前 Agent 的 `preferredRoot` 與該 root 不同（或尚未有任何成功 attempt）時 gate。並讓 recheck 的新 attempt 也進入 `state.initPromise`／被 `waitForPrimary` 觀察。加一個 `agent-first`＋`failRoots`＋慢 relay 的測試，await `agent/created` 後立即斷言 tools／section 存在。

### Important 2 — `workingDirectory.ensure` timeout 會永久放棄 adoption

- **位置**：`index.js:661-670`、`index.js:630`。
- **觸發條件**：`ctx.workingDirectory.ensure` 在 `coldStartTimeoutMs` 內沒有 settle（慢速／遠端 cwd），或 signal abort。
- **證據**：timeout 分支只記 debug、`scheduleRetry()`、`return`；`state.preferredRoot` 沒有設定。之後 retry 的 `ensurePrimary()` 在 `discoveryRoot: 'agent'` 下因 `candidateRoots()` 為空而直接 return（`index.js:630`），晚到的 directory promise 沒有被觀察。舊行為是 await `ensure` 後初始化。
- **預期 vs 實際**：預期 timeout 只釋放第一輪，directory 晚到時仍在背景 adoption；實際是該 session 可能永久沒有 BaseMind（下一個 Agent 才可能恢復）。
- **影響**：慢 cwd 的第一個 session 完全沒有工具；相對舊行為是 regression（雖然少見）。
- **最小修復建議**：timeout 時仍對 `directoryPromise` 掛一個 non-blocking continuation：在 `!disposed && !ready && !blocked` 時設 `preferredRoot`、`retryIndex=0`、`startPrimary()`；不要 await。加一個 delayed `ensure` 的測試。

### Important 3 — 預設 15s 短於 cold managed install，第一次安裝後仍可能 race

- **位置**：`lib/config.js:21`（`coldStartTimeoutMs: 15_000`）、`index.js:543`；報告 §11.16 殘留風險。
- **觸發條件**：全新 cache、沒有本地 BaseMind、`binaryDownload: true`；第一個 session 的 relay 需要下載 75–102 MB。
- **證據**：Phase 2 實測冷安裝 13,506–55,713 ms；`startupTimeoutMs` 是 60,000 ms；本修復的 cold process 驗證使用已存在的 binary／cache，沒有覆蓋第一次 managed 下載。
- **預期 vs 實際**：預期第一個 session 第一輪有工具；實際在 15s timeout 後就釋放第一輪，下載仍可在背景完成，下一輪才有工具。也就是說，修復對「已安裝／暖 cache」有效，對「第一次安裝」不完整。
- **影響**：首次使用者的第一輪 UX 仍可能沒有 BaseMind；報告的「new session first turn no longer races」需要加條件。
- **最小處理**：明確文件化 first-ever install 的限制，或在驗收上接受；若要真的覆蓋，需另行設計（直接把 agent creation 擋到 55s 並不是好方案）。至少加一個 cold-cache 的實測或把限制寫進 README／報告。

### Validation 4 — 完整 `npm test` 仍不穩定（非本次 regression）

- **位置**：`test/integration.test.mjs:578`；報告 §11.16。
- **證據**：本次完整 `npm test` 也在 `ensureIndexed` timeout；報告 4 次 run 有 3 次出現 1–2 個 integration 失敗；本次 isolated integration 8/8 pass。其餘 targeted 51/51、check 綠。
- **影響**：不能宣稱完整 gate 已綠；CI／release 可能 flake。這不是 cold-start diff 造成，但交付時必須如實列出。
- **建議**：另案處理 `INDEX_BUILD_TIMEOUT_MS`（提高或 retry）；本 diff 不應順手改。

### Minor 5 — 文件

- `coldStartTimeoutMs` 未出現在 `README.md`／`README.zh.md`；新預設會讓第一個 session 最多多等 15s，使用者需要知道 `0` 可停用。`CHANGELOG.md:19` 有記錄，但 README 是設定參考；依專案 AGENTS §4 應同步。
- 報告頂部 §0.2／§10 仍是 20:40／原始快照；§11.16 已是最新，但讀者可能誤讀。建議加「最新見 §11.16」的指標。

---

## 4. 未驗證／限制

- 只測 **Windows**；macOS／Linux 的真實 cold start 未跑。
- `agent-first` 的 cold-start gate 沒有測試；上述 Finding 1 是程式碼路徑分析，未以真實 session 重現。
- working-directory timeout 的 Finding 2 是程式碼路徑分析；沒有 slow-cwd 實測。
- cold managed install（Finding 3）沒有在本次以全新 cache 實測。
- 報告的 `npm test` 452 tests 數據來自 Execution；本 Review 只重跑 targeted／isolated，未取得完整綠色。
- 真實 cold 驗證使用 working-tree pack 安裝到 `bm-bench-c`；Phase B 必須從新 commit 重建 tarball 重驗。

---

## 5. 建議的處理順序

1. 修 **Finding 1**（`agent-first`／recheck gate）＋加測試；這是支援模式的功能缺口。
2. 修 **Finding 2**（timeout 後仍背景 adoption）＋加 delayed-ensure 測試。
3. 決定 **Finding 3**：文件化 first-ever install 限制，或另案設計；不要直接把 15s 拉到 60s 而不評估 UX。
4. **Finding 4** 另案處理 integration timeout；本 diff 不擴大 scope。
5. 補 README（`coldStartTimeoutMs`）與報告頂部狀態。
6. 重跑 targeted＋真實 cold session＋isolated integration；完整 `npm test` 如仍 flake，如實記錄。
7. 以上完成後再交人工 commit；本 Review 未修改任何 staged 程式碼。

---

## 6. 最終判定

- **Critical**：0
- **Important**：3（Finding 1、2、3；Finding 4 為 validation caveat）
- **Minor**：文件與報告一致性
- **是否可 commit**：**暫不建議**；核心修復在預設 `agent` 模式已驗證，但 `agent-first` 與 directory-timeout 路徑仍是實質缺口。若人工決定接受這兩個限制，必須在 README／報告明示，不能宣稱「所有新模式第一輪都已修復」。
