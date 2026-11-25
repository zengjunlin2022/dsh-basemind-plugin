/**
 * Dashboard, browser half. Hand-written in the DSH module-loader format
 * (window.__ModuleLoader__.load -> factory(require)), because this package is
 * plain ESM with no build step: the loader only needs a registered factory, not
 * a bundler output.
 *
 * It registers one entry in the Plugins page's `plugins.row.config` slot, keyed
 * `dsh-basemind-plugin#dsh-basemind` (the bundle package and the row id the
 * patch declares). That gives the BaseMind row a Configure control that opens a
 * full page; the page draws the four Dashboard tabs over the Host route family
 * at /api/dsh-basemind-dashboard.
 *
 * Constraints (plan §8): no background work while the page is closed, one
 * in-flight request per view, no model tokens, no new Agent surface.
 */
window.__ModuleLoader__.load({
  id: 'dsh-basemind-plugin',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    /** Locale namespace owned by this page. */
    const NS = "dshBasemindDashboard"
    /** The Plugins page row this page configures. */
    const ROW_KEY = 'dsh-basemind-plugin#dsh-basemind'
    /** Host route family; mirrors lib/dashboard/routes.js. */
    const DEFAULT_API_BASE = '/api/dsh-basemind-dashboard'
    /** Poll cadence while a Dashboard-submitted scan runs (plan §30). */
    const SCAN_POLL_MS = 3000

    const zh = {
      'title': 'BaseMind Dashboard',
      'subtitle': '專案索引健康、掃描、診斷與統計。所有資料來自本機 BaseMind，不使用模型。',
      'tab.overview': '總覽',
      'tab.scan': '掃描',
      'tab.diagnostics': '診斷',
      'tab.statistics': '統計',
      'workspace.label': '專案',
      'workspace.none': '沒有可用的 DSH 專案',
      'workspace.hint': '清單來自 DSH Workspace Registry；切換專案不會改動 Agent 的工作區。',
      'action.refresh': '重新整理',
      'action.reload': '重新查詢',
      'action.fullScan': '全量掃描',
      'action.incrementalScan': '增量掃描',
      'action.confirm': '確認執行',
      'action.cancel': '取消',
      'action.startScan': '開始掃描',
      'state.loading': '載入中…',
      'state.empty': '暫無資料',
      'state.unavailable': '暫不可用',
      'state.error': '查詢失敗',
      'state.retry': '重試',
      'health.ready': '索引可用',
      'health.not-indexed': '尚未建立索引',
      'health.degraded': '索引降級',
      'health.error': '索引異常',
      'health.unknown': '狀態未知',
      'overview.files': '已索引文件',
      'overview.blobs': 'Blob 數量',
      'overview.size': '索引大小',
      'overview.languages': '語言',
      'overview.health': '索引健康',
      'overview.branch': '分支 / HEAD',
      'overview.languageTable': '語言分佈',
      'overview.languageShare': '佔比',
      'overview.mostImported': '最多被引用',
      'overview.lastScan': '最近一次 Dashboard 掃描',
      'overview.activeScan': '進行中的掃描',
      'overview.noScan': '尚未由 Dashboard 發起掃描',
      'overview.notice': 'BaseMind 回報',
      'overview.largeFiles': '超長文件（> {lines} 行）',
      'overview.capability': 'BaseMind 不提供掃描時間戳；此處顯示的是 Dashboard 自己提交的掃描紀錄。',
      'scan.current': '目前任務',
      'scan.none': '目前沒有由 Dashboard 提交的掃描',
      'scan.type.full': '全量掃描',
      'scan.type.incremental': '增量掃描',
      'scan.state.queued': '排隊中',
      'scan.state.running': '執行中',
      'scan.state.completed': '完成',
      'scan.state.failed': '失敗',
      'scan.state.interrupted': '已中斷',
      'scan.elapsed': '已耗時',
      'scan.scope': '範圍',
      'scan.summary': '結果摘要',
      'scan.confirmTitle': '確認全量掃描',
      'scan.confirmBody': '將對 {path} 執行 BaseMind 全量掃描。掃描會消耗 CPU、RAM 與磁碟 IO，可能影響正在工作的 Agent。不會刪除現有索引。',
      'scan.incrementalHint': '輸入專案內的相對路徑（每行一個，例如 src/app.js）。若 BaseMind 判定需要全量重建，會事先說明。',
      'scan.incrementalPlaceholder': 'src/app.js\nsrc/lib',
      'scan.history': '最近 10 次 Dashboard 掃描',
      'scan.historyEmpty': '還沒有 Dashboard 掃描紀錄',
      'scan.historyDisabled': '掃描歷史已被設定停用（dashboardHistory: false）',
      'scan.progressUnavailable': 'BaseMind 0.34.0 沒有掃描進度 API；此處只顯示真實狀態與耗時。',
      'scan.busy': '此專案已有掃描在執行。',
      'diagnostics.checks': '檢查項目',
      'diagnostics.binary': 'Binary',
      'diagnostics.index': '索引',
      'diagnostics.relay': 'MCP Relay',
      'diagnostics.plugin': '外掛版本',
      'diagnostics.readonly': '診斷為唯讀：不修復、不下載、不重建索引、不重連 Relay。',
      'diagnostics.notReady': '尚未由 Agent 完成 Binary 選型，因此不能查詢。',
      'statistics.window': '時間範圍',
      'statistics.window.today': '今天',
      'statistics.window.1h': '近 1 小時',
      'statistics.window.24h': '近 24 小時',
      'statistics.window.all': '全部',
      'statistics.calls': '工具呼叫',
      'statistics.saved': '預估節省 Tokens',
      'statistics.respBytes': '回應位元組',
      'statistics.disk': '磁碟用量',
      'statistics.perTool': '各工具分佈',
      'statistics.components': '快取組成',
      'statistics.scopes': '統計範圍',
      'statistics.heuristic': 'Estimated Tokens Saved 是 BaseMind 對照 grep+讀檔基線的啟發式估算，不是 API 計費節省。',
      'statistics.global': '磁碟與 telemetry 為整台機器的全域統計，不是本專案獨享。',
      'statistics.rss': '查詢程序峰值 RSS',
      'statistics.truncated': 'BaseMind 回報結果已截斷。',
      'common.files': '檔案',
      'common.duration': '耗時',
      'common.status': '狀態',
      'common.type': '類型',
      'common.time': '時間',
      'common.name': '名稱',
      'common.value': '數值',
      'common.yes': '是',
      'common.no': '否',
      'common.scanned': '已掃描',
      'common.bytes': '位元組',
      'overview.importers': '引用者',
      'diagnostics.detail': '細節',
      'diagnostics.relayUnit': 'relay',
      'scan.summary.scanned': '掃描',
      'scan.summary.updated': '更新',
      'scan.summary.removed': '移除',
      'scan.summary.skipped': '略過',
      'scan.summary.errors': '錯誤',
    }
    const en = {
      'title': 'BaseMind Dashboard',
      'subtitle': 'Project index health, scans, diagnostics and statistics from the local BaseMind binary. No model calls.',
      'tab.overview': 'Overview',
      'tab.scan': 'Scan',
      'tab.diagnostics': 'Diagnostics',
      'tab.statistics': 'Statistics',
      'workspace.label': 'Project',
      'workspace.none': 'No DSH project is available',
      'workspace.hint': 'The list comes from the DSH Workspace registry. Switching projects never changes an Agent workspace.',
      'action.refresh': 'Refresh',
      'action.reload': 'Query again',
      'action.fullScan': 'Full scan',
      'action.incrementalScan': 'Incremental scan',
      'action.confirm': 'Confirm',
      'action.cancel': 'Cancel',
      'action.startScan': 'Start scan',
      'state.loading': 'Loading…',
      'state.empty': 'No data',
      'state.unavailable': 'Not available',
      'state.error': 'Query failed',
      'state.retry': 'Retry',
      'health.ready': 'Index ready',
      'health.not-indexed': 'Not indexed yet',
      'health.degraded': 'Index degraded',
      'health.error': 'Index error',
      'health.unknown': 'Unknown',
      'overview.files': 'Indexed files',
      'overview.blobs': 'Blobs',
      'overview.size': 'Index size',
      'overview.languages': 'Languages',
      'overview.health': 'Index health',
      'overview.branch': 'Branch / HEAD',
      'overview.languageTable': 'Language distribution',
      'overview.languageShare': 'Share',
      'overview.mostImported': 'Most imported',
      'overview.lastScan': 'Last Dashboard scan',
      'overview.activeScan': 'Scan in progress',
      'overview.noScan': 'No scan has been submitted from the Dashboard yet',
      'overview.notice': 'BaseMind reports',
      'overview.largeFiles': 'Oversized files (> {lines} lines)',
      'overview.capability': 'BaseMind exposes no scan timestamp; the last scan shown is the last one the Dashboard submitted.',
      'scan.current': 'Current task',
      'scan.none': 'No Dashboard-submitted scan',
      'scan.type.full': 'Full scan',
      'scan.type.incremental': 'Incremental scan',
      'scan.state.queued': 'Queued',
      'scan.state.running': 'Running',
      'scan.state.completed': 'Completed',
      'scan.state.failed': 'Failed',
      'scan.state.interrupted': 'Interrupted',
      'scan.elapsed': 'Elapsed',
      'scan.scope': 'Scope',
      'scan.summary': 'Result summary',
      'scan.confirmTitle': 'Confirm the full scan',
      'scan.confirmBody': 'A full BaseMind scan of {path} will run. It spends CPU, RAM and disk IO and may slow Agents that are working. The existing index is not deleted.',
      'scan.incrementalHint': 'Enter repo-relative paths, one per line (for example src/app.js). BaseMind says so up front if a rebuild degrades to a full scan.',
      'scan.incrementalPlaceholder': 'src/app.js\nsrc/lib',
      'scan.history': 'Last 10 Dashboard scans',
      'scan.historyEmpty': 'No Dashboard scan recorded yet',
      'scan.historyDisabled': 'Scan history is disabled by configuration (dashboardHistory: false)',
      'scan.progressUnavailable': 'BaseMind 0.34.0 exposes no scan progress API; only the real state and elapsed time are shown.',
      'scan.busy': 'A scan is already running for this project.',
      'diagnostics.checks': 'Checks',
      'diagnostics.binary': 'Binary',
      'diagnostics.index': 'Index',
      'diagnostics.relay': 'MCP relay',
      'diagnostics.plugin': 'Plugin version',
      'diagnostics.readonly': 'Diagnostics is read-only: nothing is repaired, downloaded, re-indexed or reconnected.',
      'diagnostics.notReady': 'No Agent has selected a BaseMind binary yet, so queries are unavailable.',
      'statistics.window': 'Window',
      'statistics.window.today': 'Today',
      'statistics.window.1h': 'Last hour',
      'statistics.window.24h': 'Last 24 hours',
      'statistics.window.all': 'All',
      'statistics.calls': 'Tool calls',
      'statistics.saved': 'Estimated tokens saved',
      'statistics.respBytes': 'Response bytes',
      'statistics.disk': 'Disk usage',
      'statistics.perTool': 'Per-tool distribution',
      'statistics.components': 'Cache components',
      'statistics.scopes': 'Scope',
      'statistics.heuristic': 'Estimated tokens saved is BaseMind heuristic against a grep+read baseline, not API billing.',
      'statistics.global': 'Disk usage and telemetry are machine-global figures, not this project alone.',
      'statistics.rss': 'Query process peak RSS',
      'statistics.truncated': 'BaseMind reported a truncated result.',
      'common.files': 'Files',
      'common.duration': 'Duration',
      'common.status': 'Status',
      'common.type': 'Type',
      'common.time': 'Time',
      'common.name': 'Name',
      'common.value': 'Value',
      'common.yes': 'Yes',
      'common.no': 'No',
      'common.scanned': 'Scanned',
      'common.bytes': 'Bytes',
      'overview.importers': 'Importers',
      'diagnostics.detail': 'Detail',
      'diagnostics.relayUnit': 'relay',
      'scan.summary.scanned': 'Scanned',
      'scan.summary.updated': 'Updated',
      'scan.summary.removed': 'Removed',
      'scan.summary.skipped': 'Skipped',
      'scan.summary.errors': 'Errors',
    }

    /** Resolve the API prefix against the page's own base (reverse-proxy sub-paths). */
    function resolveApiBase(baseUri) {
      if (typeof baseUri !== 'string' || baseUri === '') return DEFAULT_API_BASE
      let pathname
      try {
        pathname = new URL(baseUri).pathname
      } catch {
        return DEFAULT_API_BASE
      }
      if (!pathname.startsWith('/')) return DEFAULT_API_BASE
      const dir = pathname.endsWith('/index.html') ? pathname.slice(0, -'index.html'.length) : pathname
      const prefix = dir.endsWith('/') ? dir : dir + '/'
      return prefix === '/' ? DEFAULT_API_BASE : prefix + 'api/dsh-basemind-dashboard'
    }

    const API_BASE = resolveApiBase(typeof document === 'undefined' ? undefined : document.baseURI)

    /** One JSON request with a timeout and a caller signal. */
    async function requestJson(path, options) {
      const settings = options || {}
      const controller = new AbortController()
      const timeoutMs = settings.timeoutMs || 30000
      const timer = setTimeout(() => { controller.abort() }, timeoutMs)
      const onAbort = () => { controller.abort() }
      if (settings.signal) settings.signal.addEventListener('abort', onAbort, { once: true })
      try {
        const response = await fetch(API_BASE + path, {
          method: settings.method || 'GET',
          headers: settings.body === undefined ? undefined : { 'content-type': 'application/json' },
          body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
          credentials: 'same-origin',
          signal: controller.signal,
        })
        let payload = null
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        if (!response.ok) {
          const text = payload && typeof payload.error === 'string' ? payload.error : 'HTTP ' + String(response.status)
          const failure = new Error(text)
          failure.status = response.status
          failure.code = payload && typeof payload.code === 'string' ? payload.code : undefined
          throw failure
        }
        return payload
      } finally {
        clearTimeout(timer)
        if (settings.signal) settings.signal.removeEventListener('abort', onAbort)
      }
    }

    function bytes(value) {
      if (typeof value !== 'number' || !isFinite(value)) return null
      if (value < 1024) return String(value) + ' B'
      const units = ['KB', 'MB', 'GB', 'TB']
      let size = value
      let unit = -1
      do {
        size = size / 1024
        unit += 1
      } while (size >= 1024 && unit < units.length - 1)
      return size.toFixed(size >= 100 ? 0 : 1) + ' ' + units[unit]
    }

    function count(value) {
      if (typeof value !== 'number' || !isFinite(value)) return null
      return value.toLocaleString()
    }

    function percent(share) {
      if (typeof share !== 'number' || !isFinite(share)) return null
      return (share * 100).toFixed(share < 0.1 ? 1 : 0) + '%'
    }

    function duration(ms) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return null
      if (ms < 1000) return String(Math.round(ms)) + ' ms'
      const seconds = ms / 1000
      if (seconds < 60) return seconds.toFixed(1) + ' s'
      const minutes = Math.floor(seconds / 60)
      const rest = Math.round(seconds - minutes * 60)
      return String(minutes) + 'm ' + String(rest) + 's'
    }

    function timestamp(value) {
      if (typeof value !== 'string' || value === '') return null
      const parsed = new Date(value)
      if (isNaN(parsed.getTime())) return null
      return parsed.toLocaleString()
    }

    function elapsedSince(startedAt) {
      const parsed = typeof startedAt === 'string' ? new Date(startedAt) : null
      if (parsed === null || isNaN(parsed.getTime())) return null
      return duration(Math.max(0, Date.now() - parsed.getTime()))
    }

    function text(value, t) {
      if (value === null || value === undefined || value === '') return t('state.unavailable')
      return String(value)
    }

    const COLORS = {
      text: 'var(--dsw-alias-label-primary, #e8e8e8)',
      secondary: 'var(--dsw-alias-label-secondary, #b4b4b4)',
      tertiary: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
      border: 'var(--dsw-alias-border-l2, #333)',
      softBorder: 'var(--dsw-alias-border-l1, #2a2a2a)',
      layer: 'var(--dsw-alias-bg-layer-1, #1c1c1c)',
      layer2: 'var(--dsw-alias-bg-layer-2, #232323)',
      hover: 'var(--dsw-alias-interactive-bg-hover, #2a2a2a)',
      business: 'var(--dsw-alias-state-business-primary, #4c8dff)',
      success: 'var(--dsw-alias-state-success-primary, #3fb950)',
      warn: 'var(--dsw-alias-state-warn-primary, #d29922)',
      error: 'var(--dsw-alias-state-error-primary, #f85149)',
      radius: 'var(--dsw-radius-md, 8px)',
      radiusSm: 'var(--dsw-radius-sm, 6px)',
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '16px', color: COLORS.text, minWidth: 0 },
      subtitle: { color: COLORS.secondary, fontSize: '13px', margin: 0 },
      header: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' },
      spacer: { flex: '1 1 auto' },
      tabs: { display: 'flex', gap: '4px', borderBottom: '1px solid ' + COLORS.border, paddingBottom: '6px', flexWrap: 'wrap' },
      tab: {
        border: '1px solid transparent', background: 'transparent', color: COLORS.secondary,
        padding: '6px 12px', borderRadius: COLORS.radiusSm, cursor: 'pointer', fontSize: '13px',
      },
      tabActive: {
        border: '1px solid ' + COLORS.border, background: COLORS.layer2, color: COLORS.text,
        padding: '6px 12px', borderRadius: COLORS.radiusSm, cursor: 'pointer', fontSize: '13px',
      },
      button: {
        border: '1px solid ' + COLORS.border, background: COLORS.layer2, color: COLORS.text,
        padding: '6px 12px', borderRadius: COLORS.radiusSm, cursor: 'pointer', fontSize: '13px',
      },
      buttonPrimary: {
        border: '1px solid ' + COLORS.business, background: COLORS.business, color: '#fff',
        padding: '6px 12px', borderRadius: COLORS.radiusSm, cursor: 'pointer', fontSize: '13px',
      },
      buttonDisabled: {
        border: '1px solid ' + COLORS.softBorder, background: COLORS.layer, color: COLORS.tertiary,
        padding: '6px 12px', borderRadius: COLORS.radiusSm, cursor: 'not-allowed', fontSize: '13px',
      },
      select: {
        border: '1px solid ' + COLORS.border, background: COLORS.layer2, color: COLORS.text,
        padding: '6px 8px', borderRadius: COLORS.radiusSm, fontSize: '13px', maxWidth: '320px',
      },
      card: { border: '1px solid ' + COLORS.border, borderRadius: COLORS.radius, background: COLORS.layer, padding: '14px' },
      cardTitle: { margin: '0 0 10px 0', fontSize: '13px', color: COLORS.secondary, fontWeight: 500 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: '10px' },
      metricLabel: { fontSize: '12px', color: COLORS.tertiary, margin: 0 },
      metricValue: { fontSize: '20px', margin: '4px 0 0 0', fontWeight: 600, wordBreak: 'break-word' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
      th: { textAlign: 'left', padding: '6px 8px', color: COLORS.tertiary, fontWeight: 500, borderBottom: '1px solid ' + COLORS.border },
      td: { padding: '6px 8px', borderBottom: '1px solid ' + COLORS.softBorder, color: COLORS.text, verticalAlign: 'top' },
      barTrack: { height: '6px', background: COLORS.layer2, borderRadius: '3px', overflow: 'hidden', minWidth: '80px' },
      barFill: { height: '6px', background: COLORS.business, borderRadius: '3px' },
      notice: { border: '1px solid ' + COLORS.warn, borderRadius: COLORS.radiusSm, padding: '10px', color: COLORS.secondary, fontSize: '13px' },
      error: { border: '1px solid ' + COLORS.error, borderRadius: COLORS.radiusSm, padding: '10px', color: COLORS.text, fontSize: '13px' },
      hint: { color: COLORS.tertiary, fontSize: '12px', margin: '6px 0 0 0' },
      textarea: {
        width: '100%', minHeight: '70px', border: '1px solid ' + COLORS.border, background: COLORS.layer2,
        color: COLORS.text, borderRadius: COLORS.radiusSm, padding: '8px', fontSize: '13px', fontFamily: 'inherit',
      },
      chip: { display: 'inline-block', padding: '2px 8px', borderRadius: '999px', fontSize: '12px', border: '1px solid ' + COLORS.border },
      row: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
      mono: { fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: '12px' },
    }

    function Badge(props) {
      const tone = props.tone || 'neutral'
      const color = tone === 'ok' ? COLORS.success : tone === 'warn' ? COLORS.warn : tone === 'error' ? COLORS.error : COLORS.secondary
      return React.createElement('span', { style: Object.assign({}, S.chip, { color: color, borderColor: color }) }, props.children)
    }

    function Metric(props) {
      return React.createElement('div', { style: S.card },
        React.createElement('p', { style: S.metricLabel }, props.label),
        React.createElement('p', { style: S.metricValue }, props.value),
        props.hint ? React.createElement('p', { style: S.hint }, props.hint) : null)
    }

    function Card(props) {
      return React.createElement('section', { style: Object.assign({}, S.card, props.style) },
        props.title ? React.createElement('h3', { style: S.cardTitle }, props.title) : null,
        props.children)
    }

    function Loading(props) {
      return React.createElement('p', { style: { color: COLORS.tertiary, fontSize: '13px' } }, props.label)
    }

    function ErrorBox(props) {
      return React.createElement('div', { style: S.error },
        React.createElement('div', { style: { fontWeight: 600, marginBottom: '4px' } }, props.title),
        React.createElement('div', { style: { color: COLORS.secondary } }, props.message),
        props.onRetry ? React.createElement('button', { style: Object.assign({}, S.button, { marginTop: '8px' }), onClick: props.onRetry }, props.retryLabel) : null)
    }

    function Empty(props) {
      return React.createElement('p', { style: { color: COLORS.tertiary, fontSize: '13px' } }, props.label)
    }

    function Table(props) {
      return React.createElement('table', { style: S.table },
        React.createElement('thead', null,
          React.createElement('tr', null, props.columns.map((column) => React.createElement('th', { key: column.key, style: S.th }, column.label)))),
        React.createElement('tbody', null, props.rows))
    }

    function healthTone(state) {
      if (state === 'ready') return 'ok'
      if (state === 'not-indexed' || state === 'unknown') return 'warn'
      return 'error'
    }

    function scanTone(state) {
      if (state === 'completed') return 'ok'
      if (state === 'running' || state === 'queued') return 'neutral'
      return 'error'
    }

    function checkTone(status) {
      if (status === 'ok') return 'ok'
      if (status === 'warn') return 'warn'
      return 'error'
    }

    /** The page shell: workspace picker, tabs and the four views. */
    function DashboardPage(props) {
      const t = props.t
      const view = props.view
      const enabled = view === 'page'
      const [workspaces, setWorkspaces] = React.useState(null)
      const [workspaceError, setWorkspaceError] = React.useState(null)
      const [selectedId, setSelectedId] = React.useState(null)
      const [tab, setTab] = React.useState('overview')
      const [overview, setOverview] = React.useState({ state: 'idle' })
      const [scan, setScan] = React.useState({ state: 'idle' })
      const [diagnostics, setDiagnostics] = React.useState({ state: 'idle' })
      const [statistics, setStatistics] = React.useState({ state: 'idle' })
      const [telemetryWindow, setTelemetryWindow] = React.useState('today')
      const [relaunch, setRelaunch] = React.useState(0)
      const controllers = React.useRef({ overview: null, scan: null, diagnostics: null, statistics: null })
      const selected = workspaces && selectedId ? workspaces.items.find((item) => item.id === selectedId) : null

      function abort(name) {
        const controller = controllers.current[name]
        if (controller !== null) {
          controller.abort()
          controllers.current[name] = null
        }
      }

      React.useEffect(() => {
        if (!enabled) return undefined
        const controller = new AbortController()
        requestJson('/workspaces', { signal: controller.signal })
          .then((payload) => {
            if (controller.signal.aborted) return
            setWorkspaces(payload)
            setWorkspaceError(null)
            if (payload.items.length > 0) {
              setSelectedId((current) => current !== null && payload.items.some((item) => item.id === current) ? current : payload.items[0].id)
            }
          })
          .catch((error) => {
            if (controller.signal.aborted) return
            setWorkspaceError(error)
          })
        return () => { controller.abort() }
      }, [enabled, relaunch])

      React.useEffect(() => {
        if (!enabled || selectedId === null) return undefined
        if (tab !== 'overview') return undefined
        abort('overview')
        const controller = new AbortController()
        controllers.current.overview = controller
        setOverview({ state: 'loading' })
        requestJson('/overview?workspace=' + encodeURIComponent(selectedId), { signal: controller.signal })
          .then((payload) => {
            if (controller.signal.aborted) return
            setOverview({ state: 'ready', data: payload })
          })
          .catch((error) => {
            if (controller.signal.aborted || error.name === 'AbortError') return
            setOverview({ state: 'error', error: error })
          })
        return () => { controller.abort() }
      }, [enabled, selectedId, tab, relaunch])

      React.useEffect(() => {
        if (!enabled || selectedId === null) return undefined
        if (tab !== 'diagnostics') return undefined
        abort('diagnostics')
        const controller = new AbortController()
        controllers.current.diagnostics = controller
        setDiagnostics({ state: 'loading' })
        requestJson('/diagnostics?workspace=' + encodeURIComponent(selectedId), { signal: controller.signal, timeoutMs: 60000 })
          .then((payload) => {
            if (controller.signal.aborted) return
            setDiagnostics({ state: 'ready', data: payload })
          })
          .catch((error) => {
            if (controller.signal.aborted || error.name === 'AbortError') return
            setDiagnostics({ state: 'error', error: error })
          })
        return () => { controller.abort() }
      }, [enabled, selectedId, tab, relaunch])

      React.useEffect(() => {
        if (!enabled || selectedId === null) return undefined
        if (tab !== 'statistics') return undefined
        abort('statistics')
        const controller = new AbortController()
        controllers.current.statistics = controller
        setStatistics({ state: 'loading' })
        requestJson('/statistics?workspace=' + encodeURIComponent(selectedId) + '&window=' + encodeURIComponent(telemetryWindow), { signal: controller.signal, timeoutMs: 60000 })
          .then((payload) => {
            if (controller.signal.aborted) return
            setStatistics({ state: 'ready', data: payload })
          })
          .catch((error) => {
            if (controller.signal.aborted || error.name === 'AbortError') return
            setStatistics({ state: 'error', error: error })
          })
        return () => { controller.abort() }
      }, [enabled, selectedId, tab, telemetryWindow, relaunch])

      React.useEffect(() => {
        if (!enabled || selectedId === null) return undefined
        if (tab !== 'scan') return undefined
        let cancelled = false
        let timer = null
        abort('scan')
        const controller = new AbortController()
        controllers.current.scan = controller
        const load = () => {
          requestJson('/scan?workspace=' + encodeURIComponent(selectedId), { signal: controller.signal })
            .then((payload) => {
              if (controller.signal.aborted || cancelled) return
              setScan({ state: 'ready', data: payload })
              const active = payload.job !== null && (payload.job.state === 'queued' || payload.job.state === 'running')
              // Chain the next poll only after this one settled, so a slow Host can
              // never have two /scan reads in flight (plan §30).
              if (active && !cancelled) timer = setTimeout(load, SCAN_POLL_MS)
            })
            .catch((error) => {
              if (controller.signal.aborted || cancelled || error.name === 'AbortError') return
              setScan({ state: 'error', error: error })
            })
        }
        setScan({ state: 'loading' })
        load()
        return () => {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
          controller.abort()
        }
      }, [enabled, selectedId, tab, relaunch])

      if (!enabled) return null

      function reloadOverview() {
        if (selectedId === null) return
        abort('overview')
        const controller = new AbortController()
        controllers.current.overview = controller
        setOverview({ state: 'loading' })
        requestJson('/overview?workspace=' + encodeURIComponent(selectedId) + '&refresh=1', { signal: controller.signal })
          .then((payload) => {
            if (controller.signal.aborted) return
            setOverview({ state: 'ready', data: payload })
          })
          .catch((error) => {
            if (controller.signal.aborted || error.name === 'AbortError') return
            setOverview({ state: 'error', error: error })
          })
      }

      function startScan(mode, paths) {
        return requestJson('/scan', { method: 'POST', body: { workspace: selectedId, mode: mode, paths: paths } })
      }

      const tabs = [
        ['overview', 'tab.overview'],
        ['scan', 'tab.scan'],
        ['diagnostics', 'tab.diagnostics'],
        ['statistics', 'tab.statistics'],
      ]

      const activeScan = overview.state === 'ready' && overview.data.activeScan !== null
        ? overview.data.activeScan
        : scan.state === 'ready' && scan.data.job !== null && (scan.data.job.state === 'queued' || scan.data.job.state === 'running') ? scan.data.job : null

      // The header badge must not disappear when another tab is open: Overview owns
      // the primary state, Diagnostics carries the same index verdict.
      const health = overview.state === 'ready'
        ? overview.data.status.indexState
        : diagnostics.state === 'ready'
          ? diagnostics.data.index.state
          : null

      return React.createElement('div', { style: S.page },
        React.createElement('div', { style: S.header },
          React.createElement('label', { style: { color: COLORS.secondary, fontSize: '13px' } }, t('workspace.label')),
          workspaces === null
            ? React.createElement('span', { style: { color: COLORS.tertiary, fontSize: '13px' } }, workspaceError !== null ? t('state.error') : t('state.loading'))
            : React.createElement('select', {
              style: S.select,
              value: selectedId === null ? '' : selectedId,
              onChange: (event) => { setSelectedId(event.target.value === '' ? null : event.target.value) },
              disabled: workspaces.items.length === 0,
            },
              workspaces.items.length === 0
                ? React.createElement('option', { value: '' }, t('workspace.none'))
                : workspaces.items.map((item) => React.createElement('option', { key: item.id, value: item.id }, item.title + ' — ' + item.path)))
          ,
          health !== null ? React.createElement(Badge, { tone: healthTone(health) }, t('health.' + health)) : null,
          activeScan !== null ? React.createElement('button', { style: S.button, onClick: () => { setTab('scan') } }, t('overview.activeScan') + ': ' + t('scan.state.' + activeScan.state)) : null,
          React.createElement('span', { style: S.spacer }),
          React.createElement('button', { style: S.button, onClick: () => { setRelaunch((value) => value + 1) } }, t('action.refresh')),
        ),
        workspaces !== null && workspaces.items.length > 0 ? React.createElement('p', { style: S.hint }, t('workspace.hint')) : null,
        workspaceError !== null
          ? React.createElement(ErrorBox, { title: t('state.error'), message: String(workspaceError.message || workspaceError), onRetry: () => { setRelaunch((value) => value + 1) }, retryLabel: t('state.retry') })
          : null,
        workspaces !== null && workspaces.items.length === 0
          ? React.createElement(Card, { title: t('workspace.label') }, React.createElement(Empty, { label: t('workspace.none') }))
          : null,
        workspaces !== null && workspaces.items.length > 0
          ? React.createElement('div', { style: S.tabs }, tabs.map(([id, key]) => React.createElement('button', {
              key: id,
              style: tab === id ? S.tabActive : S.tab,
              onClick: () => { setTab(id) },
            }, t(key))))
          : null,
        workspaces !== null && workspaces.items.length > 0
          ? React.createElement(TabBody, {
            tab: tab,
            t: t,
            overview: overview,
            activeScan: activeScan,
            scan: scan,
            workspace: selected,
            diagnostics: diagnostics,
            statistics: statistics,
            window: telemetryWindow,
            onOverviewRefresh: reloadOverview,
            onOpenScan: () => { setTab('scan') },
            onStart: startScan,
            onWindow: setTelemetryWindow,
            onReload: () => { setRelaunch((value) => value + 1) },
          })
          : null,
      )
    }

    /**
     * The selected tab's view, rendered as a real component element.
     *
     * Never call a view as a plain function: ScanView owns hooks, and invoking it
     * inside DashboardPage's render would extend DashboardPage's hook chain only on
     * the Scan tab, which React rejects as "Rendered more hooks than during the
     * previous render".
     */
    function TabBody(props) {
      const t = props.t
      if (props.tab === 'overview') {
        return React.createElement(OverviewView, { t: t, state: props.overview, activeScan: props.activeScan, onRefresh: props.onOverviewRefresh, onScan: props.onOpenScan })
      }
      if (props.tab === 'scan') {
        return React.createElement(ScanView, { t: t, state: props.scan, workspace: props.workspace, onStart: props.onStart, onReload: props.onReload })
      }
      if (props.tab === 'diagnostics') {
        return React.createElement(DiagnosticsView, { t: t, state: props.diagnostics, onReload: props.onReload })
      }
      if (props.tab === 'statistics') {
        return React.createElement(StatisticsView, { t: t, state: props.statistics, window: props.window, onWindow: props.onWindow, onReload: props.onReload })
      }
      return null
    }

    /** One language row: name, file count and a CSS share bar. */
    function languageRow(t, row) {
      const share = percent(row.share)
      const track = React.createElement('div', { style: Object.assign({}, S.barTrack, { flex: '1 1 auto' }) },
        React.createElement('div', { style: Object.assign({}, S.barFill, { width: share || '0%' }) }))
      const value = React.createElement('span', { style: { color: COLORS.secondary, minWidth: '44px' } }, share || t('state.unavailable'))
      const cell = React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, track, value)
      return React.createElement('tr', { key: row.language },
        React.createElement('td', { style: S.td }, row.language),
        React.createElement('td', { style: S.td }, count(row.files) || '—'),
        React.createElement('td', { style: S.td }, cell))
    }

    function OverviewView(props) {
      const t = props.t
      const state = props.state
      if (state.state === 'loading' || state.state === 'idle') return React.createElement(Loading, { label: t('state.loading') })
      if (state.state === 'error') {
        return React.createElement(ErrorBox, { title: t('state.error'), message: String(state.error.message || state.error), onRetry: props.onRefresh, retryLabel: t('state.retry') })
      }
      const data = state.data
      const status = data.status
      const languages = status.languages || []
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        data.activeScan !== null
          ? React.createElement('div', { style: Object.assign({}, S.notice, { display: 'flex', alignItems: 'center', gap: '8px' }) },
            React.createElement(Badge, { tone: 'neutral' }, t('overview.activeScan')),
            React.createElement('span', null, t('scan.type.' + data.activeScan.scanType) + ' · ' + t('scan.state.' + data.activeScan.state) + ' · ' + t('scan.elapsed') + ' ' + (elapsedSince(data.activeScan.startedAt) || '—')),
            React.createElement('button', { style: S.button, onClick: props.onScan }, t('tab.scan')))
          : null,
        React.createElement('div', { style: S.grid },
          React.createElement(Metric, { label: t('overview.files'), value: text(count(status.fileCount), t) }),
          React.createElement(Metric, { label: t('overview.blobs'), value: text(count(status.blobCount), t) }),
          React.createElement(Metric, { label: t('overview.size'), value: text(bytes(status.totalSizeBytes), t) }),
          React.createElement(Metric, { label: t('overview.languages'), value: languages.length === 0 ? t('state.unavailable') : String(languages.length) }),
          React.createElement(Metric, { label: t('overview.health'), value: React.createElement(Badge, { tone: healthTone(status.indexState) }, t('health.' + status.indexState)) }),
          React.createElement(Metric, { label: t('overview.branch'), value: (status.branch || '—') + (status.head ? ' / ' + status.head : '') }),
        ),
        status.notice !== null
          ? React.createElement('div', { style: S.notice }, t('overview.notice') + ': ' + (status.notice.message || status.notice.state || ''))
          : null,
        React.createElement(Card, { title: t('overview.languageTable') },
          languages.length === 0
            ? React.createElement(Empty, { label: t('state.unavailable') })
            : React.createElement(Table, {
              columns: [
                { key: 'language', label: t('common.name') },
                { key: 'files', label: t('common.files') },
                { key: 'share', label: t('overview.languageShare') },
              ],
              rows: languages.map((row) => languageRow(t, row)),
            })),
        status.mostImported.length > 0
          ? React.createElement(Card, { title: t('overview.mostImported') },
            React.createElement(Table, {
              columns: [{ key: 'path', label: t('common.name') }, { key: 'importers', label: t('overview.importers') }],
              rows: status.mostImported.slice(0, 8).map((row) => React.createElement('tr', { key: row.path },
                React.createElement('td', { style: Object.assign({}, S.td, S.mono) }, row.path),
                React.createElement('td', { style: S.td }, count(row.importers) || '—'))),
            }))
          : null,
        status.largeFiles.count !== null && status.largeFiles.count > 0
          ? React.createElement(Card, { title: t('overview.largeFiles').replace('{lines}', String(status.largeFiles.thresholdLines || '')) },
            React.createElement('p', { style: S.metricValue }, count(status.largeFiles.count)))
          : null,
        React.createElement(Card, { title: t('overview.lastScan') },
          data.lastDashboardScan === null
            ? React.createElement(Empty, { label: t('overview.noScan') })
            : React.createElement('div', null,
              React.createElement('div', { style: S.row },
                React.createElement(Badge, { tone: scanTone(data.lastDashboardScan.status) }, t('scan.state.' + data.lastDashboardScan.status)),
                React.createElement('span', { style: { color: COLORS.secondary } }, t('scan.type.' + data.lastDashboardScan.scanType)),
                React.createElement('span', { style: { color: COLORS.tertiary } }, timestamp(data.lastDashboardScan.finishedAt) || ''),
                React.createElement('span', { style: { color: COLORS.tertiary } }, duration(data.lastDashboardScan.durationMs) || '')),
              data.lastDashboardScan.summary !== null
                ? React.createElement('p', { style: S.hint }, t('scan.summary.scanned') + ' ' + (count(data.lastDashboardScan.summary.scanned) || '—') + ' · ' + t('scan.summary.updated') + ' ' + (count(data.lastDashboardScan.summary.updated) || '—') + ' · ' + t('scan.summary.removed') + ' ' + (count(data.lastDashboardScan.summary.removed) || '—'))
                : null)),
        React.createElement('p', { style: S.hint }, t('overview.capability')),
      )
    }

    /** One finished-scan row. */
    function historyRow(t, entry) {
      return React.createElement('tr', { key: entry.taskId },
        React.createElement('td', { style: S.td }, timestamp(entry.finishedAt) || '—'),
        React.createElement('td', { style: S.td }, t('scan.type.' + entry.scanType)),
        React.createElement('td', { style: S.td }, React.createElement(Badge, { tone: scanTone(entry.status) }, t('scan.state.' + entry.status))),
        React.createElement('td', { style: S.td }, duration(entry.durationMs) || '—'),
        React.createElement('td', { style: S.td }, entry.summary ? (count(entry.summary.scanned) || '—') : '—'))
    }

    function ScanView(props) {
      const t = props.t
      const state = props.state
      const [pendingFull, setPendingFull] = React.useState(false)
      const [pathsText, setPathsText] = React.useState('')
      const [actionError, setActionError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      if (state.state === 'loading' || state.state === 'idle') return React.createElement(Loading, { label: t('state.loading') })
      if (state.state === 'error') {
        return React.createElement(ErrorBox, { title: t('state.error'), message: String(state.error.message || state.error), onRetry: props.onReload, retryLabel: t('state.retry') })
      }
      const data = state.data
      const job = data.job
      const active = job !== null && (job.state === 'queued' || job.state === 'running')
      const paths = pathsText.split('\n').map((line) => line.trim()).filter((line) => line !== '')
      const invalidPath = paths.find((line) => line.startsWith('/') || /^[A-Za-z]:/.test(line) || line.split('/').some((segment) => segment === '..'))
      const workspacePath = props.workspace !== null ? props.workspace.path : ''
      function submit(action) {
        setBusy(true)
        setActionError(null)
        action()
          .then(() => {
            setBusy(false)
            setPendingFull(false)
            props.onReload()
          })
          .catch((error) => {
            setBusy(false)
            setActionError(error)
          })
      }
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        actionError !== null
          ? React.createElement(ErrorBox, { title: t('state.error'), message: String(actionError.message || actionError) })
          : null,
        React.createElement(Card, { title: t('scan.current') },
          job === null
            ? React.createElement(Empty, { label: t('scan.none') })
            : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              React.createElement('div', { style: S.row },
                React.createElement(Badge, { tone: scanTone(job.state) }, t('scan.state.' + job.state)),
                React.createElement('span', { style: { color: COLORS.secondary } }, t('scan.type.' + job.scanType)),
                job.scope.length > 0 ? React.createElement('span', { style: Object.assign({}, S.mono, { color: COLORS.tertiary }) }, job.scope.join(', ')) : null,
                React.createElement('span', { style: { color: COLORS.tertiary } }, t('scan.elapsed') + ' ' + (job.durationMs !== null ? duration(job.durationMs) : elapsedSince(job.startedAt) || '—'))),
              job.summary !== null
                ? React.createElement('div', { style: S.row },
                  React.createElement('span', { style: S.mono }, t('scan.summary.scanned') + ' ' + (count(job.summary.scanned) || '—')),
                  React.createElement('span', { style: S.mono }, t('scan.summary.updated') + ' ' + (count(job.summary.updated) || '—')),
                  React.createElement('span', { style: S.mono }, t('scan.summary.removed') + ' ' + (count(job.summary.removed) || '—')),
                  React.createElement('span', { style: S.mono }, t('scan.summary.skipped') + ' ' + (count(job.summary.skippedUnchanged) || '—')),
                  React.createElement('span', { style: S.mono }, t('scan.summary.errors') + ' ' + (count(job.summary.extractFailed) || '—')),
                  job.summary.elapsedMs !== null ? React.createElement('span', { style: S.mono }, duration(job.summary.elapsedMs)) : null)
                : null,
              job.error !== null ? React.createElement('p', { style: { color: COLORS.error, fontSize: '13px', margin: 0 } }, job.error) : null)),
        React.createElement(Card, { title: t('action.fullScan') },
          pendingFull
            ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              React.createElement('p', { style: { margin: 0, color: COLORS.secondary, fontSize: '13px' } }, t('scan.confirmTitle')),
              React.createElement('p', { style: { margin: 0, color: COLORS.tertiary, fontSize: '13px' } }, t('scan.confirmBody').replace('{path}', workspacePath)),
              React.createElement('div', { style: S.row },
                React.createElement('button', { style: busy ? S.buttonDisabled : S.buttonPrimary, disabled: busy || active, onClick: () => { submit(() => props.onStart('full', [])) } }, t('action.confirm')),
                React.createElement('button', { style: S.button, onClick: () => { setPendingFull(false) } }, t('action.cancel'))))
            : React.createElement('div', { style: S.row },
              React.createElement('button', { style: active ? S.buttonDisabled : S.button, disabled: active, onClick: () => { setPendingFull(true) } }, t('action.startScan')),
              active ? React.createElement('span', { style: { color: COLORS.warn, fontSize: '13px' } }, t('scan.busy')) : null)),
        React.createElement(Card, { title: t('action.incrementalScan') },
          React.createElement('p', { style: S.hint }, t('scan.incrementalHint')),
          React.createElement('textarea', {
            style: S.textarea,
            value: pathsText,
            placeholder: t('scan.incrementalPlaceholder'),
            onChange: (event) => { setPathsText(event.target.value) },
          }),
          React.createElement('div', { style: Object.assign({}, S.row, { marginTop: '8px' }) },
            React.createElement('button', {
              style: busy || active || paths.length === 0 || invalidPath !== undefined ? S.buttonDisabled : S.button,
              disabled: busy || active || paths.length === 0 || invalidPath !== undefined,
              onClick: () => { submit(() => props.onStart('incremental', paths)) },
            }, t('action.incrementalScan')),
            invalidPath !== undefined
              ? React.createElement('span', { style: { color: COLORS.error, fontSize: '12px' } }, invalidPath)
              : null)),
        React.createElement(Card, { title: t('scan.history') },
          data.historyEnabled !== true
            ? React.createElement(Empty, { label: t('scan.historyDisabled') })
            : data.history.length === 0
              ? React.createElement(Empty, { label: t('scan.historyEmpty') })
              : React.createElement(Table, {
                columns: [
                  { key: 'time', label: t('common.time') },
                  { key: 'type', label: t('common.type') },
                  { key: 'status', label: t('common.status') },
                  { key: 'duration', label: t('common.duration') },
                  { key: 'scanned', label: t('common.scanned') },
                ],
                rows: data.history.slice(0, 10).map((entry) => historyRow(t, entry)),
              })),
        React.createElement('p', { style: S.hint }, t('scan.progressUnavailable')),
      )
    }

    function DiagnosticsView(props) {
      const t = props.t
      const state = props.state
      if (state.state === 'loading' || state.state === 'idle') return React.createElement(Loading, { label: t('state.loading') })
      if (state.state === 'error') {
        return React.createElement(ErrorBox, { title: t('state.error'), message: String(state.error.message || state.error), onRetry: props.onReload, retryLabel: t('state.retry') })
      }
      const data = state.data
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        React.createElement('div', { style: S.grid },
          React.createElement(Metric, { label: t('diagnostics.plugin'), value: text(data.plugin.version, t) }),
          React.createElement(Metric, { label: t('diagnostics.binary'), value: data.binary.ready ? 'BaseMind ' + (data.binary.version || '') : t('state.unavailable'), hint: data.binary.reason || data.binary.source || '' }),
          React.createElement(Metric, { label: t('diagnostics.index'), value: React.createElement(Badge, { tone: healthTone(data.index.state) }, t('health.' + data.index.state)) }),
          React.createElement(Metric, { label: t('diagnostics.relay'), value: data.relay !== null ? String(data.relay.relays) + ' ' + t('diagnostics.relayUnit') : t('state.unavailable') })),
        React.createElement(Card, { title: t('diagnostics.checks') },
          data.doctor.checks.length === 0
            ? React.createElement(Empty, { label: t('state.unavailable') })
            : React.createElement(Table, {
              columns: [
                { key: 'name', label: t('common.name') },
                { key: 'status', label: t('common.status') },
                { key: 'detail', label: t('diagnostics.detail') },
              ],
              rows: data.doctor.checks.map((check) => React.createElement('tr', { key: check.name },
                React.createElement('td', { style: Object.assign({}, S.td, S.mono) }, check.name),
                React.createElement('td', { style: S.td }, React.createElement(Badge, { tone: checkTone(check.status) }, check.status)),
                React.createElement('td', { style: Object.assign({}, S.td, { color: COLORS.secondary, whiteSpace: 'pre-wrap' }) }, check.detail || '—'))),
            })),
        React.createElement(Card, { title: t('statistics.scopes') },
          React.createElement('p', { style: S.hint }, t('diagnostics.readonly'))),
      )
    }

    function StatisticsView(props) {
      const t = props.t
      const state = props.state
      if (state.state === 'loading' || state.state === 'idle') return React.createElement(Loading, { label: t('state.loading') })
      if (state.state === 'error') {
        return React.createElement(ErrorBox, { title: t('state.error'), message: String(state.error.message || state.error), onRetry: props.onReload, retryLabel: t('state.retry') })
      }
      const data = state.data
      const windows = ['today', '1h', '24h', 'all']
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        React.createElement('div', { style: S.header },
          React.createElement('label', { style: { color: COLORS.secondary, fontSize: '13px' } }, t('statistics.window')),
          React.createElement('select', { style: S.select, value: props.window, onChange: (event) => { props.onWindow(event.target.value) } },
            windows.map((value) => React.createElement('option', { key: value, value: value }, t('statistics.window.' + value))))),
        React.createElement('div', { style: S.grid },
          React.createElement(Metric, { label: t('statistics.calls'), value: text(count(data.telemetry.totalCalls), t) }),
          React.createElement(Metric, { label: t('statistics.saved'), value: text(count(data.telemetry.estimatedTokensSaved), t) }),
          React.createElement(Metric, { label: t('statistics.respBytes'), value: text(bytes(data.telemetry.totalResponseBytes), t) }),
          React.createElement(Metric, { label: t('statistics.disk'), value: text(bytes(data.cache.totalBytes), t) }),
          React.createElement(Metric, { label: t('statistics.rss'), value: text(bytes(data.cache.cliProcessPeakRssBytes), t) })),
        data.telemetry.truncated ? React.createElement('div', { style: S.notice }, t('statistics.truncated')) : null,
        React.createElement(Card, { title: t('statistics.perTool') },
          data.telemetry.perTool.length === 0
            ? React.createElement(Empty, { label: t('state.empty') })
            : React.createElement(Table, {
              columns: [
                { key: 'tool', label: t('common.name') },
                { key: 'calls', label: t('statistics.calls') },
                { key: 'saved', label: t('statistics.saved') },
              ],
              rows: data.telemetry.perTool.map((row) => React.createElement('tr', { key: row.tool },
                React.createElement('td', { style: Object.assign({}, S.td, S.mono) }, row.tool),
                React.createElement('td', { style: S.td }, count(row.calls) || '—'),
                React.createElement('td', { style: S.td }, count(row.estTokensSaved) || '—'))),
            })),
        React.createElement(Card, { title: t('statistics.components') },
          data.cache.components.length === 0
            ? React.createElement(Empty, { label: t('state.empty') })
            : React.createElement(Table, {
              columns: [{ key: 'name', label: t('common.name') }, { key: 'bytes', label: t('common.bytes') }],
              rows: data.cache.components.map((row) => React.createElement('tr', { key: row.name },
                React.createElement('td', { style: Object.assign({}, S.td, S.mono) }, row.name),
                React.createElement('td', { style: S.td }, bytes(row.bytes) || '—'))),
            })),
        React.createElement(Card, { title: t('statistics.scopes') },
          React.createElement('p', { style: S.hint }, t('statistics.global')),
          React.createElement('p', { style: S.hint }, t('statistics.heuristic')),
          React.createElement('p', { style: S.hint }, data.scopes.cache),
          React.createElement('p', { style: S.hint }, data.scopes.telemetry)),
      )
    }

    /** Services this browser half needs before it can register. */
    exports.inject = ['slots', 'locale']

    /**
     * Register the Dashboard page on the BaseMind row.
     * @param {any} ctx - the client plugin context (slots and locale).
     */
    exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), 'basemind-dashboard: dictionaries')
      ctx.slots.inject('plugins.row.config', () => {
        try {
          return ctx.slots.register({
            name: 'plugins.row.config',
            key: ROW_KEY,
            locale: NS,
          }, DashboardPage)
        } catch {
          return () => {}
        }
      })
    }

    exports.DashboardPage = DashboardPage
    exports.resolveApiBase = resolveApiBase
    // Internal render surface: the page and its four views are exercised by
    // test/dashboard-client.test.mjs without a browser or a bundler.
    exports.__internals = { TabBody: TabBody, OverviewView: OverviewView, ScanView: ScanView, DiagnosticsView: DiagnosticsView, StatisticsView: StatisticsView }
    return module.exports
  },
})
