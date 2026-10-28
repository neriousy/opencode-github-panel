import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Option, Schema, type JsonSchema } from "effect"
import type { Plugin } from "@opencode/plugin"
import type { Backend, BackendDeps, BackendKit } from "./backend"
import { itemContext } from "./context"
import { backoff, blocker, checkRepo, describe, edits, expand, MAX_BATCH, parseShell, parseWrite, settle, triageProgress, undoFor, type Proposal, type WriteKind } from "./plan"
import { AgentQueue, type AgentAction, type AgentPayload, type AgentResult, type SearchItem, type TriageStart } from "./schemas"

// Writes of one plugin instance at least this far apart: GitHub's secondary rate limits punish bursts of writes.
const PACE = 1000
// Finished actions kept per session; pending ones are never dropped.
const KEEP = 500
// The longest the `actions` tool waits for the user's decisions before it reports what it has.
const WAIT = 10 * 60_000
const FINAL: readonly AgentAction["status"][] = ["done", "failed", "skipped", "undone"]

// One read-modify-write of a stored key at a time. Module state, so every plugin instance in this process shares it.
const locks = new Map<string, Promise<unknown>>()
// Tool calls waiting for a session's queue to settle, told about each change. Module state too: the server runs one
// plugin instance per directory, and the window's decisions may reach another instance than the waiting tool call.
const watchers = new Map<string, Set<(queue: AgentQueue) => void>>()
// How often a waiting tool call reads the stored queue anyway, for changes made by an instance of another module copy.
const POLL = 5000

function serialize<T>(key: string, work: () => Promise<T>) {
  const next = (locks.get(key) ?? Promise.resolve()).then(work, work)
  const settled = next.catch(() => undefined)
  locks.set(key, settled)
  void settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key)
  })
  return next
}

type Emit = BackendDeps["emit"]

/** What a run already did, so a retry after a rate limit does not post a comment twice or forget what it changed. */
interface Progress {
  changed?: boolean
  cleaned?: boolean
  comment?: { id: number; url: string }
  result?: AgentResult
}

/**
 * The agent's GitHub actions in the server part: its tools, the per-session queue the user approves from, the paced
 * executor with undo, and the `gh` commands the agent runs in the shell. Kept with `ctx.storage`, so a queue survives
 * server restarts.
 */
export function createAgent(input: { ctx: Plugin.Context; backend: Backend; kit: BackendKit; emit: Emit }) {
  const ctx = input.ctx
  const github = input.kit.github
  const repos = new Map<string, Promise<string | null>>()
  const waiting = new Set<string>()
  const waiters = new Map<string, (action: AgentAction) => void>()
  // This instance's waiting tool calls, ended early when it stops.
  const waits = new Set<() => void>()
  const worker = { running: false, stopped: false, last: 0, wake: undefined as (() => void) | undefined }

  const sessionKey = (sessionID: string) => `agent/session/${sessionID}`
  const repoKey = (repo: string) => `agent/repo/${repo.toLowerCase()}`

  const load = async (sessionID: string): Promise<AgentQueue> => {
    const stored = Option.getOrUndefined(Schema.decodeUnknownOption(AgentQueue)(await ctx.storage.get(sessionKey(sessionID))))
    return { auto: stored?.auto ?? false, actions: settle(stored?.actions ?? [], Date.now()), ...(stored?.triage ? { triage: stored.triage } : {}) }
  }

  /** Changes a session's queue under its lock, stores it, and tells windows and waiting tool calls. */
  const update = (sessionID: string, change: (queue: AgentQueue) => AgentQueue) =>
    serialize(sessionKey(sessionID), async () => {
      const next = trim(change(await load(sessionID)))
      // JSON drops the optional fields that are undefined, which storage cannot hold.
      await ctx.storage.set(sessionKey(sessionID), JSON.parse(JSON.stringify(next)))
      input.emit("agent", { sessionID })
      next.actions.forEach((action) => {
        if (!FINAL.includes(action.status)) return
        waiters.get(action.id)?.(action)
        waiters.delete(action.id)
      })
      watchers.get(sessionID)?.forEach((watch) => watch(next))
      return next
    })

  /** Resolves true once nothing in the session waits for the user or runs, false after WAIT, an abort or a stop. */
  const quiet = (sessionID: string, signal: AbortSignal) =>
    new Promise<boolean>((done) => {
      const set = watchers.get(sessionID) ?? new Set()
      watchers.set(sessionID, set)
      const timer = setTimeout(() => finish(false), WAIT)
      const poll = setInterval(() => void load(sessionID).then(watch, () => undefined), POLL)
      const abort = () => finish(false)
      const watch = (queue: AgentQueue) => {
        if (queue.actions.every((action) => action.status !== "proposed" && action.status !== "approved" && action.status !== "running")) finish(true)
      }
      const finish = (value: boolean) => {
        clearTimeout(timer)
        clearInterval(poll)
        signal.removeEventListener("abort", abort)
        waits.delete(abort)
        set.delete(watch)
        if (set.size === 0 && watchers.get(sessionID) === set) watchers.delete(sessionID)
        done(value)
      }
      set.add(watch)
      waits.add(abort)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted || worker.stopped) return finish(false)
      void load(sessionID).then(watch, () => finish(false))
    })

  const patch = (action: AgentAction, change: Partial<AgentAction>) =>
    update(action.sessionID, (queue) => ({
      ...queue,
      actions: queue.actions.map((item) => (item.id === action.id ? { ...item, ...change, updatedAt: Date.now() } : item)),
    }))

  /** Remembers which sessions acted on a repository, for its recent activity across sessions. */
  const index = (repo: string, sessionID: string) =>
    serialize(repoKey(repo), async () => {
      const known = await ctx.storage.get(repoKey(repo))
      const list = Array.isArray(known) ? known.filter((item): item is string => typeof item === "string") : []
      await ctx.storage.set(repoKey(repo), [sessionID, ...list.filter((item) => item !== sessionID)].slice(0, 50))
    })

  const add = async (sessionID: string, actions: readonly AgentAction[]) => {
    if (actions.length === 0) return
    await update(sessionID, (queue) => ({ ...queue, actions: [...queue.actions, ...actions] }))
    await Promise.all([...new Set(actions.map((action) => action.repo))].map((repo) => index(repo, sessionID)))
  }

  /** The GitHub repository of the session's directory, or of the directory a shell command ran in. */
  const repoOfSession = async (sessionID: string, ...relative: string[]) => {
    const session = await ctx.session.get({ sessionID }).catch(() => undefined)
    const directory = resolve(session ? join(session.location.directory, session.subpath ?? "") : ctx.location.directory, ...relative)
    const known = repos.get(directory)
    if (known) return known
    const found = input.kit.repoOf(directory).catch(() => null)
    repos.set(directory, found)
    void found.then((repo) => {
      if (!repo) repos.delete(directory)
    })
    return found
  }

  const requireRepo = async (repo: string | null, sessionID: string) => {
    const found = repo ?? (await repoOfSession(sessionID))
    if (!found) throw new Error("This session's directory has no GitHub remote; pass `repo` as owner/name.")
    return found
  }

  // The executor: one write at a time, approved actions in the order they were proposed.

  const kick = (sessionID: string) => {
    waiting.add(sessionID)
    if (!worker.running) void drain()
  }

  const drain = async () => {
    worker.running = true
    while (waiting.size > 0 && !worker.stopped) {
      const sessionID = waiting.values().next().value ?? ""
      const next = await load(sessionID).then(
        (queue) => queue.actions.find((action) => action.status === "approved"),
        () => undefined,
      )
      if (!next) {
        waiting.delete(sessionID)
        continue
      }
      await execute(next).catch((error: unknown) => {
        // The queue cannot be stored: stop here rather than retry the same action in a loop.
        console.warn("[github-panel] agent action failed", error)
        waiting.delete(sessionID)
      })
    }
    worker.running = false
  }

  const sleep = (ms: number) =>
    new Promise<void>((done) => {
      const timer = setTimeout(done, ms)
      worker.wake = () => {
        clearTimeout(timer)
        done()
      }
    })

  /** Runs one write at least PACE after the last one. */
  const paced = async <T>(work: () => Promise<T>) => {
    const wait = worker.last + PACE - Date.now()
    if (wait > 0) await sleep(wait)
    worker.last = Date.now()
    return work()
  }

  const execute = async (action: AgentAction) => {
    // Taken under the lock, so a skip that came in meanwhile wins, and no other run takes it too.
    const taken = { value: false }
    const claimed = await update(action.sessionID, (queue) => ({
      ...queue,
      actions: queue.actions.map((item) => {
        if (item.id !== action.id || item.status !== "approved") return item
        taken.value = true
        return { ...item, status: "running", error: null, updatedAt: Date.now() }
      }),
    }))
    const current = claimed.actions.find((item) => item.id === action.id)
    if (!taken.value || !current) return
    const outcome = await attempt(current, 0)
    const finished = await patch(current, "error" in outcome ? { status: "failed", error: outcome.error } : { status: "done", error: null, result: outcome.result })
    const original = current.undoOf ? finished.actions.find((item) => item.id === current.undoOf) : undefined
    if (!original) return
    // A failed undo leaves the original undoable again.
    await patch(original, "error" in outcome ? { undoneBy: null } : { status: "undone" })
  }

  const attempt = async (action: AgentAction, tries: number, progress: Progress = {}): Promise<{ result: AgentResult } | { error: string }> => {
    try {
      return { result: await perform(action, progress) }
    } catch (error) {
      const text = message(error)
      const wait = backoff(text, tries)
      if (wait === undefined || worker.stopped) return { error: tries > 0 ? `${text} (after ${tries} retries)` : text }
      await patch(action, { error: `GitHub rate limit; retrying in ${Math.round(wait / 1000)} s.` })
      await sleep(wait)
      return attempt(action, tries + 1, progress)
    }
  }

  const perform = async (action: AgentAction, progress: Progress): Promise<AgentResult> => {
    const repo = action.repo
    const number = action.number
    const payload = action.payload
    const info = (await github.itemsInfo(repo, [number])).get(number)
    if (!info) throw new Error(`${repo}#${number} does not exist or cannot be read.`)
    const comment = async () => {
      if (payload.body && !progress.comment) progress.comment = await paced(() => github.addComment(repo, number, payload.body ?? ""))
      return progress.comment ? { commentId: progress.comment.id, url: progress.comment.url } : {}
    }
    // An undo of a close or reopen also deletes the comment that came with it.
    const cleanup = async () => {
      if (payload.commentId && !progress.cleaned) await paced(() => github.deleteComment(repo, number, payload.commentId ?? 0))
      progress.cleaned = true
    }
    if (action.kind === "comment") return comment()
    if (action.kind === "uncomment") {
      await cleanup()
      return {}
    }
    if (action.kind === "close") {
      if (info.state !== "OPEN" && !progress.changed) return { noop: true }
      const posted = await comment()
      if (info.state === "OPEN") progress.result = await paced(() => github.closeItem(repo, number, info.item, payload.reason ?? "completed", payload.duplicateOf))
      progress.changed = true
      await cleanup()
      return { ...progress.result, ...posted }
    }
    if (action.kind === "reopen") {
      if (info.state === "MERGED") throw new Error(`#${number} is merged; a merged pull request cannot be reopened.`)
      if (info.state === "OPEN" && !progress.changed) return { noop: true }
      progress.result ??= info.reason ? { reason: info.reason } : {}
      if (info.state !== "OPEN") await paced(() => github.reopenItem(repo, number, info.item))
      progress.changed = true
      await cleanup()
      return { ...progress.result, ...(await comment()) }
    }
    if (action.kind === "label" || action.kind === "assign") {
      const me = [...(payload.add ?? []), ...(payload.remove ?? [])].includes("@me") ? await github.viewer() : ""
      const names = (list: readonly string[] | undefined) => (list ?? []).map((name) => (name === "@me" ? me : name))
      const present = action.kind === "label" ? info.labels : info.assignees
      const has = (name: string) => present.find((item) => item.toLowerCase() === name.toLowerCase())
      const added = names(payload.add).filter((name) => !has(name))
      const removed = names(payload.remove).flatMap((name) => has(name) ?? [])
      // What the first try found to change is what an undo reverts.
      progress.result ??= { added, removed }
      if (added.length > 0 || removed.length > 0) await paced(() => github.editPeople(repo, number, action.kind === "label" ? "labels" : "assignees", added, removed))
      const result = progress.result
      return (result.added?.length ?? 0) + (result.removed?.length ?? 0) > 0 ? result : { noop: true }
    }
    throw new Error("Commands the agent ran in the shell are recorded, not run again.")
  }

  /** Resolves when each action is done, failed or skipped; an aborted tool call skips the ones not started yet. */
  const settled = (ids: readonly string[], sessionID: string, signal: AbortSignal) =>
    new Promise<AgentAction[]>((done) => {
      const results = new Map<string, AgentAction>()
      const finish = () => done(ids.flatMap((id) => results.get(id) ?? []))
      ids.forEach((id) =>
        waiters.set(id, (action) => {
          results.set(id, action)
          if (results.size === ids.length) finish()
        }),
      )
      signal.addEventListener(
        "abort",
        () =>
          void update(sessionID, (queue) => ({
            ...queue,
            actions: queue.actions.map((action) =>
              ids.includes(action.id) && action.status === "approved" ? { ...action, status: "skipped", error: "Cancelled with the tool call.", updatedAt: Date.now() } : action,
            ),
          })).finally(finish),
        { once: true },
      )
    })

  // The tools.

  const propose = async (kind: WriteKind, raw: unknown, context: { sessionID: string; signal: AbortSignal }) => {
    const proposal = parseWrite(kind, raw)
    const repo = await requireRepo(proposal.repo, context.sessionID)
    const payload = kind === "label" ? await knownLabels(repo, proposal) : proposal.payload
    const [info, queue] = await Promise.all([github.itemsInfo(repo, proposal.numbers), load(context.sessionID)])
    const reasons = blockers(kind, repo, proposal.numbers, payload, info, queue)
    const skipped = new Map(reasons)
    const numbers = proposal.numbers.filter((number) => !skipped.has(number))
    const batch = `b_${randomUUID().replaceAll("-", "").slice(0, 8)}`
    const actions = expand(
      { ...proposal, numbers, payload },
      {
        sessionID: context.sessionID,
        repo,
        batch,
        now: Date.now(),
        status: queue.auto ? "approved" : "proposed",
        items: info,
        id: () => `a_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
        round: queue.triage?.round,
      },
    )
    await add(context.sessionID, actions)
    const notProposed = reasons.length > 0 ? ["", "Not proposed:", ...reasons.map(([number, reason]) => `- #${number}: ${reason}`)] : []
    if (actions.length === 0) return [`Nothing was proposed on ${repo}.`, ...notProposed].join("\n")
    if (!queue.auto) {
      return [
        `Proposed ${plural(actions.length, "action")} on ${repo} (batch ${batch}). ${actions.length === 1 ? "It is" : "They are"} waiting for the user's approval in the GitHub panel:`,
        ...actions.map((action) => `- #${action.number}${action.title ? ` "${action.title}"` : ""}: ${describe(action)}`),
        ...notProposed,
        "",
        "Don't propose these again, and don't run them another way (such as gh in the shell). The user may approve, edit or skip each one; call the github_panel `actions` tool later to see what was decided.",
      ].join("\n")
    }
    kick(context.sessionID)
    const done = await settled(
      actions.map((action) => action.id),
      context.sessionID,
      context.signal,
    )
    return [
      `Ran ${plural(actions.length, "action")} on ${repo} (auto-run is on for this session):`,
      ...done.map((action) => `- #${action.number}${action.title ? ` "${action.title}"` : ""}: ${describe(action)} — ${statusText(action)}`),
      ...notProposed,
    ].join("\n")
  }

  /** The numbers a write cannot go ahead on, with why: missing, already in that state, or already queued the same way. */
  const blockers = (
    kind: WriteKind,
    repo: string,
    numbers: readonly number[],
    payload: AgentPayload,
    info: Awaited<ReturnType<typeof github.itemsInfo>>,
    queue: AgentQueue,
  ) => {
    const pending = queue.actions.filter((action) => action.status === "proposed" || action.status === "approved" || action.status === "running")
    return numbers.flatMap((number): [number, string][] => {
      const same = pending.find((action) => action.repo === repo && action.number === number && action.kind === kind && JSON.stringify(action.payload) === JSON.stringify(payload))
      const reason = blocker(kind, info.get(number), same)
      return reason ? [[number, reason]] : []
    })
  }

  /** Label names as the repository spells them; names it does not have are an error listing the ones it has. */
  const knownLabels = async (repo: string, proposal: Proposal) => {
    const labels = (await input.backend.repoMeta({ repo }, {})).labels.map((label) => label.name)
    if (labels.length === 0) return proposal.payload
    const spelled = (name: string) => labels.find((label) => label.toLowerCase() === name.toLowerCase())
    const unknown = (proposal.payload.add ?? []).filter((name) => !spelled(name))
    if (unknown.length > 0)
      throw new Error(`${repo} has no label ${unknown.map((name) => `"${name}"`).join(", ")}. Its labels: ${labels.slice(0, 100).join(", ")}${labels.length > 100 ? ", …" : ""}`)
    return {
      add: (proposal.payload.add ?? []).map((name) => spelled(name) ?? name),
      remove: (proposal.payload.remove ?? []).map((name) => spelled(name) ?? name),
    }
  }

  const search = async (raw: unknown, sessionID: string) => {
    const value = record(raw)
    const query = typeof value.query === "string" ? value.query.replace(/(^|\s)repo:\S+/g, " ").trim() : ""
    const repo = await requireRepo(value.repo ? checkRepo(value.repo) : null, sessionID)
    const limit = typeof value.limit === "number" ? Math.min(100, Math.max(1, Math.floor(value.limit))) : 30
    const page = await github.searchAny({ repo, query, cursor: typeof value.cursor === "string" && value.cursor ? value.cursor : null, limit })
    return [
      `${repo}: ${plural(page.total, "result")}${query ? ` for \`${query}\`` : ""}${page.items.length < page.total ? `, showing ${page.items.length}` : ""}.`,
      ...page.items.map(searchLine),
      ...(page.cursor ? ["", `More: call again with cursor "${page.cursor}".`] : []),
    ].join("\n")
  }

  const view = async (raw: unknown, sessionID: string) => {
    const value = record(raw)
    const number = Number(typeof value.number === "string" ? value.number.replace("#", "") : value.number)
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error("`number` must be a positive whole number.")
    const repo = await requireRepo(value.repo ? checkRepo(value.repo) : null, sessionID)
    const keep = typeof value.comments === "number" ? Math.min(50, Math.max(0, Math.floor(value.comments))) : 10
    const [item, queue] = await Promise.all([input.backend.item({ repo, number, fresh: true }, {}), load(sessionID)])
    const older = item.comments.length - keep
    const context = itemContext({ ...item, comments: keep === 0 ? [] : item.comments.slice(-keep) })
    const mine = queue.actions.filter((action) => action.repo === repo && action.number === number)
    return [
      context.text,
      ...(older > 0 ? ["", `_${older} older comments not shown; pass a larger \`comments\` to read them._`] : []),
      ...(mine.length > 0 ? ["", "## Agent actions on it in this session", ...mine.map((action) => `- ${describe(action)} — ${statusText(action)}`)] : []),
    ].join("\n")
  }

  const status = async (raw: unknown, context: { sessionID: string; signal: AbortSignal }) => {
    const value = record(raw)
    const sessionID = context.sessionID
    const reviewed = Array.isArray(value.reviewed) ? value.reviewed.filter((number): number is number => Number.isSafeInteger(number) && number > 0) : []
    // Looking at the actions closes the triage batch: what the agent proposes next is the next batch.
    const before = await update(sessionID, (queue) => {
      const triage = queue.triage
      if (!triage) return queue
      const used = queue.actions.some((action) => action.round === triage.round)
      return { ...queue, triage: { ...triage, round: used ? triage.round + 1 : triage.round, reviewed: [...new Set([...triage.reviewed, ...reviewed])] } }
    })
    const settled = value.wait === true ? await quiet(sessionID, context.signal) : true
    const queue = before.triage && value.all !== true ? await markChecked(sessionID) : await load(sessionID)
    const triage = before.triage
    if (triage && value.all !== true) return triageStatus(queue, triage.checkedAt, settled)
    const wanted = typeof value.status === "string" && value.status !== "all" ? value.status : undefined
    const list = queue.actions.filter((action) => (!wanted || action.status === wanted) && (!value.repo || action.repo === value.repo))
    const waited = settled ? [] : ["", "Some actions still wait for the user; call again with `wait: true` to keep waiting."]
    if (list.length === 0) return [`No GitHub actions${wanted ? ` ${wanted}` : ""} in this session. Auto-run is ${queue.auto ? "on" : "off"}.`, ...waited].join("\n")
    return [
      `${plural(list.length, "action")} in this session, oldest first. Auto-run is ${queue.auto ? "on: writes run at once" : "off: writes wait for the user's approval"}.`,
      ...list.map((action) => `- ${action.id} ${actionLine(action)}`),
      ...waited,
    ].join("\n")
  }

  /** Records that the agent read the decisions so far; returns the queue as it read it. */
  const markChecked = (sessionID: string) => update(sessionID, (queue) => (queue.triage ? { ...queue, triage: { ...queue.triage, checkedAt: Date.now() } } : queue))

  // The shell: record the gh writes the agent ran, so they show with the rest and open views refresh.

  const recordShell = async (sessionID: string, command: string, workdir: string | undefined) => {
    const found = parseShell(command)
    if (found.length === 0) return
    // Without --repo, gh uses the repository of the directory the command ran in.
    const resolved = await Promise.all(
      found.map(async (entry) => ({
        ...entry,
        repo: entry.repo ?? (entry.cd === "?" ? null : await repoOfSession(sessionID, workdir ?? ".", (entry.cd ?? ".").replace(/^~(?=\/|$)/, homedir()))),
      })),
    )
    const known = resolved.flatMap((entry) => (entry.repo ? [{ ...entry, repo: entry.repo }] : []))
    const infos = new Map(
      await Promise.all(
        [...new Set(known.map((entry) => entry.repo))].map(
          async (repo) => [repo, await github.itemsInfo(repo, known.filter((entry) => entry.repo === repo).map((entry) => entry.number)).catch(() => new Map())] as const,
        ),
      ),
    )
    const batch = `b_${randomUUID().replaceAll("-", "").slice(0, 8)}`
    const now = Date.now()
    await add(
      sessionID,
      known.map((entry) => {
        const info = infos.get(entry.repo)?.get(entry.number)
        return {
          id: `a_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          sessionID,
          batch,
          repo: entry.repo,
          number: entry.number,
          item: info?.item ?? entry.group,
          title: info?.title ?? "",
          kind: entry.kind,
          payload: entry.payload,
          note: "",
          status: "done",
          error: null,
          result: null,
          source: "shell",
          undoOf: null,
          undoneBy: null,
          createdAt: now,
          updatedAt: now,
        }
      }),
    )
    known.forEach((entry) => input.kit.changed(entry.repo, entry.number))
  }

  // The RPC methods: the window's view of the queue and the user's decisions.

  const methods = {
    agentActions: async ({ sessionID, repo }: { sessionID: string; repo: string | null }) => {
      const queue = await load(sessionID)
      return repo ? { ...queue, actions: queue.actions.filter((action) => action.repo === repo) } : queue
    },
    agentRecent: async ({ repo, limit }: { repo: string; limit: number }) => {
      const known = await ctx.storage.get(repoKey(repo))
      const sessions = Array.isArray(known) ? known.filter((item): item is string => typeof item === "string") : []
      const queues = await Promise.all(sessions.map(load))
      return queues
        .flatMap((queue) => queue.actions.filter((action) => action.repo === repo))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, Math.max(1, Math.min(500, Math.floor(limit) || 50)))
    },
    agentDecide: async ({ sessionID, ids, batch, decision }: { sessionID: string; ids: readonly string[] | null; batch: string | null; decision: "approve" | "skip" | "reset" }) => {
      // Approving an approved action again restarts its run, should the server that took it have stopped. A reset takes
      // back what has not run: an approved action not started yet, or one the user skipped (not one a cancel skipped).
      const decidable = (action: AgentAction) =>
        decision === "reset"
          ? action.source === "tool" && (action.status === "approved" || (action.status === "skipped" && !action.error))
          : action.status === "proposed" || action.status === "approved"
      const picked = (action: AgentAction) => (ids ? ids.includes(action.id) : true) && (!batch || action.batch === batch) && decidable(action)
      const status = decision === "approve" ? "approved" : decision === "skip" ? "skipped" : "proposed"
      const count = { value: 0 }
      await update(sessionID, (queue) => {
        count.value = queue.actions.filter(picked).length
        return { ...queue, actions: queue.actions.map((action) => (picked(action) ? { ...action, status, updatedAt: Date.now() } : action)) }
      })
      if (decision === "approve") kick(sessionID)
      return `${decision === "approve" ? "Approved" : decision === "skip" ? "Skipped" : "Took back"} ${plural(count.value, "action")}.`
    },
    agentQueue: async (input: {
      sessionID: string
      repo: string
      kind: WriteKind
      numbers: readonly number[]
      body?: string
      reason?: "completed" | "not_planned" | "duplicate"
      duplicateOf?: number
      add?: readonly string[]
      remove?: readonly string[]
    }) => {
      const proposal = parseWrite(input.kind, {
        repo: input.repo,
        numbers: input.numbers,
        note: "user",
        ...(input.kind === "comment" ? { body: input.body } : { comment: input.body }),
        reason: input.reason,
        duplicate_of: input.duplicateOf,
        add: input.add,
        remove: input.remove,
      })
      const repo = proposal.repo ?? input.repo
      const payload = input.kind === "label" ? await knownLabels(repo, proposal) : proposal.payload
      const [info, queue] = await Promise.all([github.itemsInfo(repo, proposal.numbers), load(input.sessionID)])
      const reasons = blockers(input.kind, repo, proposal.numbers, payload, info, queue)
      const skipped = new Map(reasons)
      const numbers = proposal.numbers.filter((number) => !skipped.has(number))
      const batch = `b_${randomUUID().replaceAll("-", "").slice(0, 8)}`
      const actions = expand(
        { ...proposal, numbers, payload },
        { sessionID: input.sessionID, repo, batch, now: Date.now(), status: "approved", items: info, id: () => `a_${randomUUID().replaceAll("-", "").slice(0, 12)}`, source: "user" },
      )
      await add(input.sessionID, actions)
      kick(input.sessionID)
      return { batch, queued: numbers, skipped: reasons.map(([number, reason]) => ({ number, reason })) }
    },
    agentTriage: async ({ sessionID, triage }: { sessionID: string; triage: TriageStart }) => {
      const now = Date.now()
      await update(sessionID, (queue) => ({ ...queue, triage: { ...triage, round: 1, reviewed: [], checkedAt: now, createdAt: now } }))
      await index(checkRepo(triage.repo), sessionID)
      return "Triage started."
    },
    agentEdit: async (edit: {
      sessionID: string
      id: string
      body?: string
      reason?: "completed" | "not_planned" | "duplicate"
      duplicateOf?: number | null
      add?: readonly string[]
      remove?: readonly string[]
    }) => {
      const action = (await load(edit.sessionID)).actions.find((item) => item.id === edit.id)
      if (!action) throw new Error("That action is gone.")
      if (action.status !== "proposed") throw new Error("Only an action waiting for approval can be edited.")
      if (action.kind !== "comment" && action.kind !== "close" && action.kind !== "reopen" && action.kind !== "label" && action.kind !== "assign")
        throw new Error("This action cannot be edited.")
      const payload = action.payload
      const body = edit.body ?? payload.body
      const reason = edit.reason ?? payload.reason
      const duplicateOf = edit.duplicateOf === null || reason !== "duplicate" ? undefined : (edit.duplicateOf ?? payload.duplicateOf)
      const checked = parseWrite(action.kind, {
        numbers: [action.number],
        note: action.note || "edited",
        ...(action.kind === "comment" ? { body } : { comment: body }),
        reason,
        duplicate_of: duplicateOf,
        add: edit.add ?? payload.add,
        remove: edit.remove ?? payload.remove,
      })
      const next = action.kind === "label" ? await knownLabels(action.repo, checked) : checked.payload
      const updated = await update(edit.sessionID, (queue) => ({
        ...queue,
        actions: queue.actions.map((item) =>
          item.id === action.id && item.status === "proposed" ? { ...item, payload: next, edited: true, original: item.original ?? item.payload, updatedAt: Date.now() } : item,
        ),
      }))
      const result = updated.actions.find((item) => item.id === action.id)
      if (result?.status !== "proposed") throw new Error("The action was decided while you edited it.")
      return result
    },
    agentUndo: async ({ sessionID, id }: { sessionID: string; id: string }) => {
      const action = (await load(sessionID)).actions.find((item) => item.id === id)
      const plan = action ? undoFor(action) : undefined
      if (!action || !plan) throw new Error("This action cannot be undone.")
      const now = Date.now()
      const undo: AgentAction = {
        ...action,
        id: `a_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
        batch: `b_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        kind: plan.kind,
        payload: plan.payload,
        note: `Undo: ${describe(action)}`,
        status: "approved",
        error: null,
        result: null,
        source: "user",
        undoOf: action.id,
        undoneBy: null,
        edited: undefined,
        original: undefined,
        round: undefined,
        createdAt: now,
        updatedAt: now,
      }
      await update(sessionID, (queue) => ({
        ...queue,
        actions: [...queue.actions.map((item) => (item.id === id ? { ...item, undoneBy: undo.id, updatedAt: now } : item)), undo],
      }))
      kick(sessionID)
      return `Undoing: ${describe(undo)}.`
    },
    agentRetry: async ({ sessionID, ids }: { sessionID: string; ids: readonly string[] }) => {
      await update(sessionID, (queue) => ({
        ...queue,
        actions: queue.actions.map((action) => (ids.includes(action.id) && action.status === "failed" ? { ...action, status: "approved", error: null, updatedAt: Date.now() } : action)),
      }))
      kick(sessionID)
      return "Retrying."
    },
    agentAuto: async ({ sessionID, auto }: { sessionID: string; auto: boolean }) => {
      await update(sessionID, (queue) => ({ ...queue, auto }))
      return auto ? "Auto-run on." : "Auto-run off."
    },
  }

  /** Registers the tools and the shell hook; the returned function removes them and stops the executor. */
  const start = async () => {
    const tools = await ctx.tool.transform((editor) => {
      editor.namespace({ name: NAMESPACE, description: NAMESPACE_DESCRIPTION })
      const options = { namespace: NAMESPACE, codemode: true, pinned: true } as const
      editor.add({
        name: "search",
        description: SEARCH_DESCRIPTION,
        input: SEARCH_INPUT,
        options,
        execute: async (raw, context) => ({ content: await search(raw, context.sessionID) }),
      })
      editor.add({
        name: "view",
        description: VIEW_DESCRIPTION,
        input: VIEW_INPUT,
        options,
        execute: async (raw, context) => ({ content: await view(raw, context.sessionID) }),
      })
      WRITES.forEach((tool) =>
        editor.add({
          name: tool.kind,
          description: tool.description,
          input: tool.input,
          options,
          execute: async (raw, context) => ({ content: await propose(tool.kind, raw, context) }),
        }),
      )
      editor.add({
        name: "actions",
        description: ACTIONS_DESCRIPTION,
        input: ACTIONS_INPUT,
        options,
        execute: async (raw, context) => ({ content: await status(raw, context) }),
      })
    })
    const hook = await ctx.tool.hook("execute.after", (event) => {
      if (event.tool !== "shell" || event.status !== "completed") return
      const call = record(event.input)
      const output = record(event.result.output)
      // Background commands report later, and a failed command changed nothing for certain.
      if (typeof call.command !== "string" || !/\bgh\b/.test(call.command) || output.exit !== 0 || output.status === "running") return
      void recordShell(event.sessionID, call.command, typeof call.workdir === "string" ? call.workdir : undefined).catch((error: unknown) =>
        console.warn("[github-panel] could not record a gh command", message(error)),
      )
    })
    return async () => {
      worker.stopped = true
      worker.wake?.()
      waits.forEach((abort) => abort())
      await Promise.all([tools.dispose(), hook.dispose()])
    }
  }

  return { methods, start }
}

function trim(queue: AgentQueue): AgentQueue {
  const finished = queue.actions.filter((action) => FINAL.includes(action.status))
  if (finished.length <= KEEP) return queue
  const drop = new Set(finished.slice(0, finished.length - KEEP).map((action) => action.id))
  return { ...queue, actions: queue.actions.filter((action) => !drop.has(action.id)) }
}

function statusText(action: AgentAction) {
  if (action.status === "done") return action.result?.noop ? "done (nothing to change)" : action.undoneBy ? "done, then undone by the user" : "done"
  if (action.status === "failed") return `failed: ${action.error ?? "unknown error"}`
  if (action.status === "skipped") return action.error ? `skipped: ${action.error}` : "skipped by the user"
  if (action.status === "proposed") return "waiting for the user's approval"
  if (action.status === "approved") return "approved, queued to run"
  if (action.status === "running") return action.error ? `running (${action.error})` : "running"
  return "undone by the user"
}

function actionLine(action: AgentAction) {
  const edit = edits(action)
  return `${action.repo}#${action.number}${action.title ? ` "${action.title}"` : ""}: ${describe(action)} — ${statusText(action)}${edit ? ` (${edit})` : ""}${action.source === "shell" ? " (ran in the shell)" : ""}${action.source === "user" && !action.undoOf ? " (the user's own action)" : ""}`
}

/** The actions tool's report in a triage session: progress, the decisions since the agent last looked, and the user's edits and skips. */
function triageStatus(queue: AgentQueue, since: number, settled: boolean) {
  const triage = queue.triage
  if (!triage) return ""
  const progress = triageProgress(triage, queue.actions)
  const mine = queue.actions.filter((action) => action.round !== undefined && action.source === "tool")
  const news = mine.filter((action) => action.updatedAt > since && action.status !== "proposed")
  const skipped = news.filter((action) => action.status === "skipped" && !action.error)
  const edited = news.filter((action) => action.edited)
  const waiting = mine.filter((action) => action.status === "proposed")
  return [
    `Triage of ${triage.repo}: ${progress.reviewed} of ${progress.total} items reviewed · ${progress.approved} approved · ${progress.skipped} skipped · ${progress.waiting} waiting for the user. New proposals go into batch ${triage.round}.`,
    ...(news.length > 0 ? ["", "Decided since you last looked:", ...news.map((action) => `- ${actionLine(action)}`)] : ["", "Nothing was decided since you last looked."]),
    ...(skipped.length > 0 || edited.length > 0
      ? [
          "",
          "The user's preferences from these decisions; follow them for the remaining items:",
          ...skipped.map((action) => `- Skipped on #${action.number}: ${describe(action)}${action.note ? ` (your note: ${action.note})` : ""}. Don't propose it again.`),
          ...edited.map((action) => `- On #${action.number}, ${edits(action)}`),
        ]
      : []),
    ...(waiting.length > 0
      ? [
          "",
          `Still waiting for the user: ${waiting.map((action) => `#${action.number} ${describe(action)}`).join("; ")}.`,
          settled ? "Call this tool with `wait: true` to wait for the decisions." : "Call this tool again with `wait: true` to keep waiting.",
        ]
      : []),
    ...(progress.reviewed >= progress.total && waiting.length === 0 ? ["", "Every item is reviewed: summarize the run for the user."] : []),
  ].join("\n")
}

function searchLine(item: SearchItem) {
  const state = item.draft && item.state === "OPEN" ? "draft" : item.state.toLowerCase()
  const labels = item.labels.length > 0 ? ` [${item.labels.map((label) => label.name).join(", ")}]` : ""
  return `#${item.number} ${item.kind === "pr" ? "PR" : "issue"} ${state}: ${item.title}${labels} · @${item.author} · ${age(item.created)} · ${plural(item.comments, "comment")}`
}

function age(date: string) {
  const days = Math.floor((Date.now() - Date.parse(date)) / 86_400_000)
  if (days < 1) return "today"
  if (days < 60) return `${days}d ago`
  if (days < 730) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const NAMESPACE = "github_panel"

const NAMESPACE_DESCRIPTION =
  "GitHub issues and pull requests through the user's GitHub panel. Reads run at once. Writes (comment, close, reopen, label, assign) are proposed: the user approves, edits or skips each one in the panel, unless they turned on auto-run for this session. Prefer these over gh in the shell for issue and pull request writes."

const REPO = {
  type: "string",
  description: "Repository as owner/name. Omit it to use the GitHub repository of this session's working directory.",
} as const

const NUMBERS = {
  type: "array",
  items: { type: "integer", minimum: 1 },
  minItems: 1,
  maxItems: MAX_BATCH,
  description: `Issue or pull request numbers, up to ${MAX_BATCH}. Each becomes its own action that the user approves or skips; batch items that share the same change and reason.`,
} as const

const NOTE = {
  type: "string",
  description: 'One short sentence telling the user why, shown next to each action, e.g. "Same crash as #120, which has the fix".',
} as const

const APPROVAL =
  "Nothing is written right away: each number becomes a proposed action the user approves, edits or skips in the GitHub panel, and the result lists what was proposed. When the user has turned on auto-run for this session, the actions run at once instead and the result reports each outcome. Don't propose the same thing twice or run it another way (such as gh in the shell); use the `actions` tool to see what the user decided."

const SEARCH_DESCRIPTION =
  "Search a GitHub repository's issues and pull requests with GitHub search syntax and get a compact list: number, kind, state, title, labels, author, age and comment count, with the total. Read-only, runs at once. `query` is GitHub search syntax without `repo:`, such as `is:issue is:open label:bug no:assignee`, `is:pr is:open review:required`, `crash in:title,body` or `is:issue is:open sort:updated-asc`. Without `is:issue` or `is:pr` both kinds are listed. Newest first unless the query has `sort:`. Use `cursor` from a result for the next page, and the `view` tool to read one item in full."

const SEARCH_INPUT = {
  type: "object",
  properties: {
    query: { type: "string", description: "GitHub search qualifiers and words, without repo:. Empty lists everything, newest first." },
    repo: REPO,
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Results per page, 1 to 100. Defaults to 30." },
    cursor: { type: "string", description: "The cursor a previous result gave, for the next page." },
  },
  required: ["query"],
  additionalProperties: false,
} as const

const VIEW_DESCRIPTION =
  "Read one GitHub issue or pull request: title, state, author, labels, assignees, milestone, description and the latest comments (long text is cut), and for a pull request its branches, size, review decision and checks. Also lists the agent actions already proposed or done on it in this session. Read-only, runs at once."

const VIEW_INPUT = {
  type: "object",
  properties: {
    number: { type: "integer", minimum: 1, description: "The issue or pull request number." },
    repo: REPO,
    comments: { type: "integer", minimum: 0, maximum: 50, description: "How many of the latest comments to include, 0 to 50. Defaults to 10." },
  },
  required: ["number"],
  additionalProperties: false,
} as const

const NAMES = (what: string) => ({ type: "array", items: { type: "string", minLength: 1 }, description: what }) as const

const WRITES: readonly { kind: WriteKind; description: string; input: JsonSchema.JsonSchema }[] = [
  {
    kind: "comment",
    description: `Propose a comment on GitHub issues or pull requests (Markdown, up to 65,536 characters). ${APPROVAL}`,
    input: {
      type: "object",
      properties: { numbers: NUMBERS, body: { type: "string", minLength: 1, description: "The comment, in GitHub Markdown." }, note: NOTE, repo: REPO },
      required: ["numbers", "body", "note"],
      additionalProperties: false,
    },
  },
  {
    kind: "close",
    description: `Propose closing GitHub issues or pull requests, with a reason and an optional closing comment. reason: "completed" (fixed or done), "not_planned" (won't fix, stale, invalid, out of scope) or "duplicate" with duplicate_of, the issue to keep. Reasons apply to issues; pull requests simply close. Items already closed are left out. ${APPROVAL}`,
    input: {
      type: "object",
      properties: {
        numbers: NUMBERS,
        reason: { type: "string", enum: ["completed", "not_planned", "duplicate"], description: 'Why: "completed", "not_planned" or "duplicate". Defaults to "completed".' },
        duplicate_of: { type: "integer", minimum: 1, description: 'With reason "duplicate": the issue these duplicate.' },
        comment: { type: "string", description: "Optional comment posted before closing, in GitHub Markdown, e.g. thanking the author and saying why." },
        note: NOTE,
        repo: REPO,
      },
      required: ["numbers", "note"],
      additionalProperties: false,
    },
  },
  {
    kind: "reopen",
    description: `Propose reopening closed GitHub issues or pull requests, with an optional comment. Merged pull requests cannot be reopened. ${APPROVAL}`,
    input: {
      type: "object",
      properties: { numbers: NUMBERS, comment: { type: "string", description: "Optional comment posted after reopening." }, note: NOTE, repo: REPO },
      required: ["numbers", "note"],
      additionalProperties: false,
    },
  },
  {
    kind: "label",
    description: `Propose adding and removing labels on GitHub issues or pull requests. Use the repository's existing labels: an unknown name is an error that lists the valid ones. Labels already there (or already absent) are left alone. ${APPROVAL}`,
    input: {
      type: "object",
      properties: { numbers: NUMBERS, add: NAMES("Label names to add."), remove: NAMES("Label names to remove."), note: NOTE, repo: REPO },
      required: ["numbers", "note"],
      additionalProperties: false,
    },
  },
  {
    kind: "assign",
    description: `Propose assigning or unassigning people on GitHub issues or pull requests, by GitHub login (or @me for the signed-in user). ${APPROVAL}`,
    input: {
      type: "object",
      properties: { numbers: NUMBERS, add: NAMES("Logins to assign."), remove: NAMES("Logins to unassign."), note: NOTE, repo: REPO },
      required: ["numbers", "note"],
      additionalProperties: false,
    },
  },
]

const ACTIONS_DESCRIPTION =
  "List this session's GitHub actions with their status: waiting for the user's approval, approved and queued, running, done, failed (with GitHub's error), skipped by the user, or undone; and what the user changed when they edited one. Includes gh writes you ran in the shell and the user's own bulk actions. Call it after proposing to learn what the user decided before following up; don't propose skipped actions again unless the user asks, and follow the user's edits. With `wait: true` it first waits (up to 10 minutes) until the user has decided every proposal and the approved ones have run. In a triage session it reports the run's progress and only the decisions since you last called it (pass `all: true` for the full list), and each call starts a new batch."

const ACTIONS_INPUT = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["all", "proposed", "approved", "running", "done", "failed", "skipped", "undone"],
      description: 'Only actions with this status. Defaults to "all".',
    },
    repo: REPO,
    wait: { type: "boolean", description: "Wait until the user has decided every proposal and the approved ones have run, then report. Defaults to false." },
    reviewed: {
      type: "array",
      items: { type: "integer", minimum: 1 },
      description: "In a triage session: every issue or pull request number you reviewed since the last call, including the ones you proposed nothing for. Counts toward the run's progress.",
    },
    all: { type: "boolean", description: "In a triage session: list every action instead of only the decisions since the last call." },
  },
  additionalProperties: false,
} as const
