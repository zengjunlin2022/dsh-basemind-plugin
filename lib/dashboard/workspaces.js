/**
 * The Dashboard's workspace catalogue: the DSH Workspace registry, read lazily.
 *
 * `ctx.workspaceRegistry` is an optional service (headless compositions may omit
 * it), so it is read with `ctx.get()` at call time and never declared in the
 * plugin's required `inject`. A client-supplied identifier is only ever an id
 * from this list: the Host never accepts an arbitrary absolute path (plan §17).
 *
 * @module dsh-basemind-plugin/lib/dashboard/workspaces
 */
import path from 'node:path'

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One workspace row as the Dashboard sees it.
 * @typedef {{ id: string, title: string, path: string, name: string }} DashboardWorkspace
 */

/**
 * Create the workspace provider.
 * @param {{ ctx: any, logger?: any }} options
 */
export function createWorkspaceProvider({ ctx, logger } = {}) {
  function service() {
    try {
      const registry = ctx?.get?.('workspaceRegistry')
      return registry !== undefined && registry !== null && typeof registry.list === 'function' ? registry : undefined
    } catch {
      return undefined
    }
  }

  /**
   * @returns {{ source: 'workspace-registry' | 'unavailable' | 'error', items: DashboardWorkspace[], message?: string }}
   */
  function list() {
    const registry = service()
    if (registry === undefined) {
      return { source: 'unavailable', items: [], message: 'The DSH Workspace registry is not composed, so no project list is available.' }
    }
    try {
      const items = registry.list().map((workspace) => ({
        id: String(workspace.id),
        title: String(workspace.title),
        path: String(workspace.path),
        name: path.basename(String(workspace.path)) || String(workspace.path),
      }))
      return { source: 'workspace-registry', items }
    } catch (error) {
      logger?.warn?.('[dsh-basemind-plugin] dashboard: the workspace registry could not be listed: ' + message(error))
      return { source: 'error', items: [], message: 'The DSH Workspace registry could not be read: ' + message(error) }
    }
  }

  /**
   * Resolve one registry id. Unknown ids are refused; no path ever enters here.
   * @returns {DashboardWorkspace | undefined}
   */
  function find(id) {
    if (typeof id !== 'string' || id === '') return undefined
    return list().items.find((item) => item.id === id)
  }

  return { list, find }
}
