/**
 * The bootstrap prompt section for a ready BaseMind relay.
 *
 * The MCP server instructions (registered separately) are the authoritative
 * playbook, so this text deliberately covers only what they do not: the CLI-only
 * analyses, the fallback rule, and workspace semantics. It is dynamic but stable:
 * the same readiness snapshot renders byte-identical text, with no timestamps and
 * no absolute paths, so the system-prompt prefix stays cache-friendly.
 *
 * @module dsh-basemind-plugin/lib/prompt/bootstrap
 */

import { publicToolName } from '../schema.js'

/** Server name used when the caller passes nothing usable. */
const DEFAULT_SERVER_NAME = 'basemind'

/** Placement offset after the MCP_SERVERS section. */
const ORDER_OFFSET = 10

/** Fallback MCP_SERVERS placement, mirroring index.js. */
const MCP_SERVERS_ORDER_FALLBACK = 3100

/** @param {unknown} error @returns {string} a short message for a thrown value. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @returns {string} the string value, or the fallback when unusable. */
function textOr(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/**
 * Section name for one server's bootstrap text; distinct from `mcp:<server>`.
 * @param {unknown} serverName
 * @returns {string}
 */
export function sectionNameFor(serverName) {
  return 'mcp:' + textOr(serverName, DEFAULT_SERVER_NAME) + ':bootstrap'
}

/**
 * Resolve the section placement: an explicit order wins, otherwise the
 * MCP_SERVERS slot plus 10.
 * @param {any} ctx
 * @param {unknown} order
 * @returns {number}
 */
function resolveOrder(ctx, order) {
  if (Number.isFinite(order)) return order
  let base = MCP_SERVERS_ORDER_FALLBACK
  try {
    const value = ctx?.systemPrompt?.getSectionOrder?.('MCP_SERVERS')
    if (Number.isFinite(value)) base = value
  } catch {
    // The order is cosmetic; the fallback keeps the section registrable.
  }
  return base + ORDER_OFFSET
}

/**
 * Build the bootstrap text for one readiness snapshot.
 *
 * Returns '' until the binary is READY, so the prompt never advertises tools that
 * were not registered. Contains no absolute path, timestamp or instructions text.
 *
 * @param {{ ready?: boolean, serverName?: string, version?: string, source?: string,
 *           cliToolName?: string }} [snapshot]
 * @returns {string}
 */
export function bootstrapText(snapshot) {
  const input = snapshot !== undefined && snapshot !== null ? snapshot : {}
  if (input.ready !== true) return ''
  if (input.verified === false) {
    // 'any' mode: the MCP bridge works, but the version-dependent surfaces are
    // deliberately off, so the prompt must not point at them.
    const anyServer = textOr(input.serverName, DEFAULT_SERVER_NAME)
    return (
      'BaseMind is wired into this session as the MCP server "' + anyServer + '" (dsh-basemind-plugin).\n' +
      'Its version is unverified (binaryPolicy: any): the official skills, the CLI bridge and this note\'s\n' +
      'version-specific guidance are therefore disabled. Use the tools\' own instructions.'
    )
  }

  const server = textOr(input.serverName, DEFAULT_SERVER_NAME)
  const version = textOr(input.version, 'unknown')
  const source = textOr(input.source, 'unknown')
  const explicitCli = input.cliToolName
  const cli =
    explicitCli === undefined ? publicToolName(server, 'cli') : typeof explicitCli === 'string' ? explicitCli : ''

  const lines = [
    'BaseMind is wired into this session as the workspace-aware MCP server "' + server + '"',
    '(dsh-basemind-plugin, BaseMind ' + version + ', binary source: ' + source + ').',
    '',
    "Use the tools' own instructions first — they are the authoritative playbook.",
    'This note only covers what they do not:',
    '',
  ]
  if (cli !== '') {
    lines.push(
      '- Advanced analysis with no MCP tool: ' + cli + ' runs the same verified binary',
      '  as the MCP server with argv (no shell). Read-only verbs:',
      '    code explain <path|symbol>   code impact <path>   code deadcode',
      '    code cycles                  code migration check  overview',
      '    git hotspots                 doctor   status   upgrade --plan   manual [topic]',
      '  Do not invoke a bare `basemind` from PATH: it may be a different version.',
    )
  }
  lines.push(
    '- When BaseMind cannot answer — the file/language is outside the index, a result is',
    "  empty, or it reports index_unavailable / stale — fall back to the harness's own",
    '  read/grep/glob/bash tools instead of retrying BaseMind.',
    '- The index belongs to the workspace this session is working in; after changing',
    '  directory, the next call is routed to the new workspace automatically.',
  )
  if (input.skills !== false) {
    lines.push('- The `basemind` skill holds the long-form playbook for each capability; load it', '  through the skill tool only when you need that detail.')
  }
  return lines.join('\n')
}

/**
 * Register the bootstrap prompt section.
 *
 * The text is a function so a later READY transition (or a later byte-identical
 * snapshot) needs no re-registration and never toggles the prompt twice. A missing
 * systemPrompt service is tolerated: the caller keeps working without the section.
 *
 * @param {any} ctx
 * @param {{ serverName?: string, getText?: () => string, order?: number, logger?: any }} [options]
 * @returns {() => void} the disposer returned by ctx.systemPrompt.section.
 */
export function registerBootstrapSection(ctx, options) {
  const input = options !== undefined && options !== null ? options : {}
  const name = sectionNameFor(input.serverName)
  const getText = typeof input.getText === 'function' ? input.getText : () => ''
  const logger = input.logger

  const section = {
    name,
    order: resolveOrder(ctx, input.order),
    interpolate: false,
    text() {
      try {
        const value = getText()
        return typeof value === 'string' ? value : ''
      } catch (error) {
        logger?.warn?.('[dsh-basemind-plugin] bootstrap text failed: ' + describe(error))
        return ''
      }
    },
  }

  try {
    const dispose = ctx?.systemPrompt?.section?.(section)
    return typeof dispose === 'function' ? dispose : () => {}
  } catch (error) {
    logger?.warn?.(
      '[dsh-basemind-plugin] bootstrap prompt section ' + name + ' is unavailable: ' + describe(error),
    )
    return () => {}
  }
}
