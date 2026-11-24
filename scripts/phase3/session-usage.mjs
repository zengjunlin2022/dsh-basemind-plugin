// Read one persisted DSH session log and report usage/tool/prompt metrics.
//
// The log is a concatenation of independent zstd frames; zstdDecompressSync only
// decodes the first one, so the frames are split on the zstd magic number first.
// Every node wraps its payload in `data`; only aggregate numbers are printed.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** Offsets of every zstd frame magic in a buffer. */
function frameOffsets(buffer) {
  const offsets = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === MAGIC[0] && buffer[i + 1] === MAGIC[1] && buffer[i + 2] === MAGIC[2] && buffer[i + 3] === MAGIC[3]) {
      offsets.push(i)
    }
  }
  return offsets
}

/** Decode every frame; a malformed slice is skipped, never fatal. */
export function decodeFrames(buffer) {
  const offsets = frameOffsets(buffer)
  if (offsets.length === 0) return { text: '', frames: 0, skipped: 0 }
  const parts = []
  let skipped = 0
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
    } catch {
      skipped += 1
    }
  }
  return { text: parts.join(''), frames: offsets.length - skipped, skipped }
}

/** Text of a message payload (content parts are the only place text lives). */
function messageText(payload) {
  const content = payload?.message?.content
  if (typeof payload?.text === 'string') return payload.text
  if (!Array.isArray(content)) return ''
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
}

export function summarise(path) {
  const buffer = readFileSync(path)
  const { text, frames, skipped } = decodeFrames(buffer)
  const nodes = text.split('\n').filter((line) => line.trim() !== '')
  const summary = {
    logBytes: buffer.length,
    frames,
    skippedFrames: skipped,
    lines: nodes.length,
    events: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, assistantMessages: 0, maxTotalPerMessage: 0 },
    toolCalls: { total: 0, byName: {}, basemindMcp: 0, basemindCli: 0, skillLoads: 0, native: 0, errors: 0 },
    prompt: {
      systemMessages: 0,
      systemMessageBytes: 0,
      distinctSystemHashes: 0,
      requests: 0,
      lastToolCount: 0,
      largestToolCount: 0,
      toolSchemaBytes: 0,
      largestToolSchemaBytes: 0,
    },
    catalogMessages: 0,
  }
  const events = new Map()
  const tools = new Map()
  const systemHashes = new Set()

  for (const line of nodes) {
    let node
    try {
      node = JSON.parse(line)
    } catch {
      continue
    }
    const type = String(node.type ?? 'unknown')
    const payload = node.data ?? {}
    events.set(type, (events.get(type) ?? 0) + 1)

    if (type === 'assistant/message') {
      const usage = payload.usage
      if (usage !== undefined && usage !== null) {
        summary.usage.assistantMessages += 1
        for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
          const value = usage[field]
          if (typeof value === 'number' && Number.isFinite(value)) summary.usage[field] += value
        }
        if (typeof usage.totalTokens === 'number' && usage.totalTokens > summary.usage.maxTotalPerMessage) {
          summary.usage.maxTotalPerMessage = usage.totalTokens
        }
      }
    }

    if (type === 'tool/call') {
      const name = String(payload.name ?? payload.call?.name ?? 'unknown')
      tools.set(name, (tools.get(name) ?? 0) + 1)
      summary.toolCalls.total += 1
      if (name.startsWith('mcp__basemind__cli')) summary.toolCalls.basemindCli += 1
      else if (name.startsWith('mcp__basemind__')) summary.toolCalls.basemindMcp += 1
      else if (name === 'skill') summary.toolCalls.skillLoads += 1
      else summary.toolCalls.native += 1
    }
    if (type === 'tool/result' && (payload.isError === true || payload.error !== undefined)) summary.toolCalls.errors += 1

    if (type === 'system/message') {
      const textValue = messageText(payload)
      summary.prompt.systemMessages += 1
      summary.prompt.systemMessageBytes += Buffer.byteLength(textValue, 'utf8')
      systemHashes.add(Buffer.from(textValue, 'utf8').toString('base64').slice(0, 24))
    }

    if (type === 'request/header') {
      summary.prompt.requests += 1
      const schemas = payload.header?.tools
      if (Array.isArray(schemas)) {
        summary.prompt.lastToolCount = schemas.length
        if (schemas.length > summary.prompt.largestToolCount) summary.prompt.largestToolCount = schemas.length
        for (const schema of schemas) {
          const bytes = Buffer.byteLength(JSON.stringify(schema), 'utf8')
          summary.prompt.toolSchemaBytes += bytes
          if (bytes > summary.prompt.largestToolSchemaBytes) summary.prompt.largestToolSchemaBytes = bytes
        }
      }
    }

    if (type === 'user/message' && String(payload.message?.source?.kind ?? '').includes('skill')) summary.catalogMessages += 1
  }

  summary.events = Object.fromEntries([...events.entries()].sort())
  summary.toolCalls.byName = Object.fromEntries([...tools.entries()].sort((a, b) => b[1] - a[1]))
  summary.prompt.distinctSystemHashes = systemHashes.size
  return summary
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = process.argv[2]
  if (!target) {
    console.error('usage: node scripts/phase3/session-usage.mjs <session.v4.jsonl.zstd>')
    process.exit(2)
  }
  console.log(JSON.stringify(summarise(target), null, 2))
}
