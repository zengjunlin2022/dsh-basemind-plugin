# 同步下一個 BaseMind 官方版本

本文件是「BaseMind 升版」的操作清單。所有版本事實都在 [`lib/upstream.js`](../lib/upstream.js)，不要在其他地方另外寫死版本。

## 適用範圍

- 只升 patch／minor 並確認 MCP tool 面、CLI 動詞、skills 文本都相容時，走本清單。
- 若上游 bump `RELEASE_MINOR`（索引 schema 世代），本清單仍適用；但使用者的索引會在首次開啟時重建，這是上游行為，插件不代為遷移、不自動 `scan`。

## 步驟

1. **確認目標 release**
   - 取得 tag、commit、四個平台的 asset 名稱與 bytes（GitHub Releases API）。
   - 確認 `basemind_<version>_checksums.txt` 存在且涵蓋所有 asset。

2. **更新單一來源**
   - 修改 `lib/upstream.js` 的 `version`、`tag`、`commit`、`checksums.name`、`assets[*].bytes`，必要時更新 `skills.names`。
   - 不改 `package.json` 的 `version`（那是插件版本）。

3. **重新同步 skills**
   - `node scripts/sync-basemind-skills.mjs --tag v<version>`
   - 任何一條 DSH 適配規則失配（0 命中或次數變動）都要停下來判斷：是上游文字改了，還是我們的替換目標改了。修正 `skills/.dsh-adapt.json` 後重跑，不要手改 `skills/**`。

4. **採集 fixtures（僅在 MCP tool 面真的變動時）**
   - 以隔離的 `BASEMIND_DATA_HOME`／`BASEMIND_COMMS_DIR` 啟動新 binary，採集 `tools/list` 與 server instructions，存成 `fixtures/basemind-<version>-{tools.json,instructions.txt}`。
   - 舊版 fixture 保留作回歸資產；不要手寫或推測內容。

5. **跑 gate**

   ```bash
   npm run check
   npm run check:skills
   npm run check:pack
   npm test
   BASEMIND_REQUIRE_INTEGRATION=1 node --test test/integration.test.mjs
   ```

6. **更新文件**
   - README（兩語言）的「已驗證版本」與 asset 說明。
   - CHANGELOG 的 `[Unreleased]` 或既有版本段落。

## 不要在升版時做的事

- 不改用 `latest`，不從 main 分支取 skills。
- 不自動執行 `scan`／`rescan`／`comms stop`／`cache clear`／`memory clear`／`upgrade`。
- 不刪除舊版 managed binary 快取目錄（可能仍有 relay 在用；由使用者手動清理）。
- 不把未實測平台寫成已驗證。
