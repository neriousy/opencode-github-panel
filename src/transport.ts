import { createEffect, getOwner, on, onCleanup } from "solid-js"
import { createKeyed, type Context, type IpcCallOptions, type IpcClient, type ServerRef } from "@opencode/plugin/gui"
import { Git } from "./contract"
import { GitRpc } from "./rpc"
import { events, methods } from "./schemas"

export type GitClient = IpcClient<(typeof Git)["spec"]>

// How long a server without the server part stays on the fallback before it is asked again, so installing the plugin
// there takes effect without reloading the app.
const RETRY = 60_000

// The app sends every request to a server through one queue of four, and counts a plugin call (a POST) as a write that
// goes first. The panel's reads shell out to gh and take seconds, longer on a remote server, so a burst of them would hold
// the queue while the timeline waits for its messages. At most this many run at once per server, and reads wait a moment
// after a session switch, so the timeline's first requests go ahead of them.
const PER_SERVER = 2
const SETTLE = 900

/** Methods that only read; any other call changes something and goes ahead of them. */
const reads = new Set<string>([
  "overview",
  "log",
  "show",
  "branches",
  "pulls",
  "branchPulls",
  "search",
  "prChecks",
  "issues",
  "item",
  "prFiles",
  "reviews",
  "repoMeta",
  "remoteCommit",
  "runs",
  "run",
  "jobLog",
  "inbox",
  "diff",
  "prDefaults",
  "merged",
  "mergedBranches",
  "outgoing",
  "agentActions",
  "agentRecent",
  "reviewDrafts",
])

/**
 * Calls the backend where the routed session's repository lives: the server part over RPC on the session's server,
 * remote servers included. When that server has no server part and runs on this machine, it falls back to this app's
 * main process. Views use it like the Ipc client, so they never pick a transport.
 */
export function createTransport(ctx: Context): GitClient {
  const local = ctx.main(Git)
  const missing = new Map<string, number>()
  const listeners = new Map<string, Set<(data: never) => void>>()

  const pools = new Map<string, { running: number; waiting: { write: boolean; start: () => void }[] }>()
  const switched = { at: 0 }
  createEffect(on(() => ctx.sessions.current()?.id, () => (switched.at = Date.now()), { defer: true }))

  /** Runs `work` within the server's share: writes first, reads after the settle time that follows a session switch. */
  const scheduled = async <T>(server: string, write: boolean, work: () => Promise<T>) => {
    const wait = switched.at + SETTLE - Date.now()
    if (!write && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    const pool = pools.get(server) ?? { running: 0, waiting: [] }
    pools.set(server, pool)
    if (pool.running >= PER_SERVER)
      await new Promise<void>((start) => {
        const index = write ? pool.waiting.findIndex((entry) => !entry.write) : -1
        pool.waiting.splice(index === -1 ? pool.waiting.length : index, 0, { write, start })
      })
    pool.running++
    try {
      return await work()
    } finally {
      pool.running--
      pool.waiting.shift()?.start()
    }
  }

  const target = () => {
    const session = ctx.sessions.current()
    const server = session?.server ?? ctx.servers.get("sidecar")
    return { server, directory: session?.directory }
  }

  // A write this window made is announced to its own views as soon as it returns, as the server's event will be: that
  // event takes a round trip more, and none comes from a server without the server part.
  const announce = (name: keyof typeof methods, input: unknown) => {
    if (typeof input !== "object" || input === null) return
    const repository = repositoryWrites[name]
    if (repository !== undefined) {
      const cwd = (input as Record<string, unknown>).cwd
      const remote = repository === "remote" || (name === "commit" && (input as Record<string, unknown>).push === true)
      if (typeof cwd === "string") listeners.get("changed")?.forEach((listener) => listener({ cwd, remote } as never))
    }
    const event = writes[name]
    if (!event) return
    // SAFETY: each listed method's input has the fields its event reads (repo and number, repo and id, or none).
    const data =
      event === "inbox" ? {} : event === "run" ? pick(input, ["repo", "id"]) : event === "agent" ? pick(input, ["sessionID"]) : pick(input, ["repo", "number"])
    listeners.get(event)?.forEach((listener) => listener(data as never))
  }

  const call = async (name: keyof typeof methods, input: unknown, options?: IpcCallOptions) => {
    const result = await send(name, input, options)
    announce(name, input)
    return result
  }

  const send = async (name: keyof typeof methods, input: unknown, options?: IpcCallOptions) => {
    const { server, directory } = target()
    const skip = server ? (missing.get(server.id) ?? 0) > Date.now() : true
    if (server && !skip) {
      try {
        // SAFETY: GitRpc is built from `methods`, so it has every method name with these inputs.
        const rpc = server.client.rpc(GitRpc) as unknown as Record<string, (input: unknown, options: object) => Promise<unknown>>
        const method = rpc[name]
        if (method)
          return await scheduled(server.id, !reads.has(name), () =>
            method(input, { location: directory ? { directory } : undefined, signal: options?.signal }),
          )
      } catch (error) {
        if (!unsupported(error)) throw asError(error)
        missing.set(server.id, Date.now() + RETRY)
      }
    }
    if (server && !server.local) throw new Error(ctx.t("remote.missing", { server: server.name }))
    // SAFETY: the Ipc client has the same method table.
    const fallback = local as unknown as Record<string, (input: unknown, options?: IpcCallOptions) => Promise<unknown>>
    return fallback[name]?.(input, options)
  }

  // Server events: subscribe on the routed session's server, again whenever it changes.
  createKeyed(
    () => target().server,
    (server: ServerRef) => {
      const rpc = server.client.rpc(GitRpc)
      const stops = Object.keys(events).map((name) =>
        // SAFETY: event names come from the `events` table GitRpc was built from.
        (rpc.events.on as (name: string, handler: (event: { data: unknown }) => void) => () => void)(name, (event) =>
          listeners.get(name)?.forEach((listener) => listener(event.data as never)),
        ),
      )
      onCleanup(() => stops.forEach((stop) => stop()))
    },
    { equals: (a, b) => a.id === b.id },
  )

  const client = Object.fromEntries(
    Object.entries(methods).map(([name]) => [
      name,
      (input: unknown, options?: IpcCallOptions) => call(name as keyof typeof methods, input, options),
    ]),
  )

  return Object.assign(client, {
    state: () => undefined,
    on: (name: string, listener: (data: never) => void) => {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      // The main process emits for the calls it serves.
      const stopLocal = (local.on as (name: string, listener: (data: never) => void) => () => void)(name, listener)
      const stop = () => {
        set.delete(listener)
        stopLocal()
      }
      if (getOwner()) onCleanup(stop)
      return stop
    },
    // SAFETY: one function per method of the Git table, plus `state` and `on`, as IpcClient types it.
  }) as unknown as GitClient
}

const writes: Partial<Record<keyof typeof methods, "item" | "run" | "inbox" | "agent">> = {
  comment: "item",
  setState: "item",
  edit: "item",
  setDraft: "item",
  submitReview: "item",
  replyThread: "item",
  resolveThread: "item",
  lineComment: "item",
  rerun: "run",
  cancelRun: "run",
  markRead: "inbox",
  agentDecide: "agent",
  agentEdit: "agent",
  agentUndo: "agent",
  agentRetry: "agent",
  agentAuto: "agent",
}

/** Writes to a repository, by whether they also change GitHub (a push, a merged or created pull request). */
const repositoryWrites: Partial<Record<keyof typeof methods, "local" | "remote">> = {
  stage: "local",
  unstage: "local",
  discard: "local",
  commit: "local",
  checkout: "local",
  createBranch: "local",
  deleteBranch: "local",
  deleteBranches: "local",
  undoCommit: "local",
  merge: "local",
  rebase: "local",
  cherryPick: "local",
  revert: "local",
  abort: "local",
  continue: "local",
  stash: "local",
  stashPop: "local",
  deleteRemoteBranch: "remote",
  fetch: "remote",
  pull: "remote",
  push: "remote",
  pushBranch: "remote",
  createPr: "remote",
  checkoutPr: "remote",
  mergePr: "remote",
}

function pick(input: object, fields: readonly string[]) {
  return Object.fromEntries(fields.map((field) => [field, (input as Record<string, unknown>)[field]]))
}

/** The server answered, but it has no such RPC: the plugin's server part is not installed or not loaded there. */
function unsupported(error: unknown) {
  if (typeof error !== "object" || error === null || !("type" in error)) return false
  return error.type === "rpc.unavailable" || error.type === "rpc.method_not_found"
}

function asError(error: unknown) {
  if (error instanceof Error) return error
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return new Error(error.message)
  return new Error(String(error))
}
