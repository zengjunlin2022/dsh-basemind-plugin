/**
 * BaseMind MCP session: a thin, cache-owning protocol layer over one started
 * stdio client. The session never spawns, never retries a `tools/call`, and
 * never interprets `isError` (the caller decides).
 *
 * @typedef {object} RawTool
 * @property {string} name
 * @property {string} [description]
 * @property {object} [inputSchema]
 * @property {object} [outputSchema]
 * @property {object} [annotations]
 *
 * @typedef {object} CallToolResult
 * @property {unknown[]} content
 * @property {unknown} [structuredContent]
 * @property {boolean} isError
 */

/** Hard protection against a server that keeps returning `nextCursor`. */
const MAX_TOOL_PAGES = 100;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Create one MCP session over an already-startable BaseMind stdio client.
 *
 * @param {{ start: Function, request: Function, close: Function, terminateSync: Function }} client
 *   The lower-level stdio client (owned by `lib/stdio-client.js`); this module
 *   only calls `start`, `request`, `close` and `terminateSync`.
 * @param {{ logger?: { warn?: (message: string) => void }, serverName?: string }} [options]
 * @returns {{
 *   initialize: (signal?: AbortSignal) => Promise<{ protocolVersion?: string, serverInfo?: object, capabilities?: object, instructions?: string }>,
 *   listTools: (signal?: AbortSignal, options?: { refresh?: boolean }) => Promise<RawTool[]>,
 *   callTool: (rawName: string, args: object, options?: { signal?: AbortSignal, timeoutMs?: number }) => Promise<CallToolResult>,
 *   listResources: (cursor?: string, signal?: AbortSignal) => Promise<any>,
 *   listResourceTemplates: (cursor?: string, signal?: AbortSignal) => Promise<any>,
 *   readResource: (uri: string, signal?: AbortSignal) => Promise<any>,
 *   hasTool: (rawName: string) => boolean,
 *   close: () => Promise<void>,
 *   terminateSync: () => void,
 *   readonly instructions: string | undefined,
 *   readonly capabilities: object | undefined,
 *   readonly serverInfo: object | undefined,
 *   readonly tools: RawTool[],
 * }}
 */
export function createMcpSession(client, { logger, serverName = 'basemind' } = {}) {
  /** @param {string} message */
  const warn = (message) => logger?.warn?.(`[${serverName}] ${message}`);

  /** @type {{ protocolVersion?: string, serverInfo?: object, capabilities?: object, instructions?: string } | undefined} */
  let handshake;
  /** @type {Promise<any> | undefined} */
  let initializePromise;
  /** @type {RawTool[]} */
  let toolsCache = [];
  /** @type {Set<string>} */
  let toolNames = new Set();
  let toolsLoaded = false;

  /**
   * Perform (or return the cached) MCP handshake.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ protocolVersion?: string, serverInfo?: object, capabilities?: object, instructions?: string }>}
   */
  function initialize(signal) {
    if (handshake) return Promise.resolve(handshake);
    if (!initializePromise) {
      initializePromise = (async () => {
        const result = await client.start(signal);
        handshake = {
          protocolVersion: result?.protocolVersion,
          serverInfo: result?.serverInfo,
          capabilities: result?.capabilities,
          instructions: result?.instructions,
        };
        return handshake;
      })().catch((error) => {
        // Allow a later call to retry the handshake instead of caching a failure.
        initializePromise = undefined;
        throw error;
      });
    }
    return initializePromise;
  }

  /**
   * Run one full paginated `tools/list` walk and merge the pages.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ tools: RawTool[], names: Set<string> }>}
   */
  async function fetchTools(signal) {
    /** @type {RawTool[]} */
    const tools = [];
    /** @type {Set<string>} */
    const names = new Set();
    /** @type {string | undefined} */
    let cursor;
    let pages = 0;
    let truncated = false;

    for (;;) {
      if (pages >= MAX_TOOL_PAGES) {
        truncated = true;
        break;
      }

      const params = cursor === undefined ? {} : { cursor };
      const result = await client.request('tools/list', params, { signal });
      pages += 1;

      const page = Array.isArray(result?.tools) ? result.tools : [];
      for (const entry of page) {
        if (!isPlainObject(entry)) {
          warn(`tools/list returned a non-object tool entry (${describeValue(entry)}); skipping it`);
          continue;
        }
        const name = entry.name;
        if (typeof name !== 'string' || name.length === 0) {
          warn('tools/list returned a tool without a non-empty string name; skipping it');
          continue;
        }
        if (names.has(name)) {
          warn(`tools/list returned duplicate tool name "${name}"; keeping the first occurrence`);
          continue;
        }
        names.add(name);
        tools.push(entry);
      }

      // An empty page ends the walk, even if the server still advertises a cursor.
      if (page.length === 0) break;
      const nextCursor = result?.nextCursor;
      if (typeof nextCursor !== 'string' || nextCursor.length === 0) break;
      cursor = nextCursor;
    }

    if (truncated) {
      warn(`tools/list pagination stopped after ${MAX_TOOL_PAGES} pages; the server kept returning nextCursor`);
    }

    return { tools, names };
  }

  /**
   * List (and cache) the server tools.
   *
   * @param {AbortSignal} [signal]
   * @param {{ refresh?: boolean }} [options] `refresh: true` forces a re-fetch
   *   (used for `notifications/tools/list_changed`) and replaces the cache.
   * @returns {Promise<RawTool[]>}
   */
  async function listTools(signal, options = {}) {
    const refresh = options?.refresh === true;
    if (!refresh && toolsLoaded) return toolsCache;

    // Assign only after a successful walk: a failed refresh keeps the old cache.
    const fetched = await fetchTools(signal);
    toolsCache = fetched.tools;
    toolNames = fetched.names;
    toolsLoaded = true;
    return toolsCache;
  }

  /**
   * Call one tool by its RAW BaseMind name (never the `mcp__*` wire name).
   *
   * @param {string} rawName
   * @param {object} args plain object of tool arguments
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<CallToolResult>}
   */
  async function callTool(rawName, args, { signal, timeoutMs } = {}) {
    if (!isPlainObject(args)) {
      throw new Error(
        `BaseMind tool "${String(rawName)}" expects a plain object of arguments, received ${describeValue(args)}`,
      );
    }

    const result = await client.request(
      'tools/call',
      { name: rawName, arguments: args },
      { signal, timeoutMs },
    );

    return {
      content: Array.isArray(result?.content) ? result.content : [],
      structuredContent: result?.structuredContent,
      isError: result?.isError === true,
    };
  }

  /** @param {string} [cursor] @param {AbortSignal} [signal] */
  function listResources(cursor, signal) {
    return client.request('resources/list', cursor === undefined || cursor === null ? {} : { cursor }, { signal });
  }

  /** @param {string} [cursor] @param {AbortSignal} [signal] */
  function listResourceTemplates(cursor, signal) {
    return client.request(
      'resources/templates/list',
      cursor === undefined || cursor === null ? {} : { cursor },
      { signal },
    );
  }

  /** @param {string} uri @param {AbortSignal} [signal] */
  function readResource(uri, signal) {
    return client.request('resources/read', { uri }, { signal });
  }

  /** @param {string} rawName */
  function hasTool(rawName) {
    return toolNames.has(rawName);
  }

  /** @returns {Promise<void>} */
  async function close() {
    await client.close();
  }

  function terminateSync() {
    client.terminateSync();
  }

  return {
    initialize,
    listTools,
    callTool,
    listResources,
    listResourceTemplates,
    readResource,
    hasTool,
    close,
    terminateSync,
    get instructions() {
      return handshake?.instructions;
    },
    get capabilities() {
      return handshake?.capabilities;
    },
    get serverInfo() {
      return handshake?.serverInfo;
    },
    get tools() {
      return toolsCache;
    },
  };
}
