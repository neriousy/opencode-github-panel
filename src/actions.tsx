import { createSignal, For, onMount, Show } from "solid-js"
import type { Context, SetupContext, UiMenuEntry } from "@opencode/plugin/gui"
import { itemContext, type Context as ChatContext } from "./context"
import { tabId, type TabTarget } from "./tabs"
import { createQueries } from "./queries"
import { createTransport, type GitClient } from "./transport"
import type { Branch, Item, ItemRef, Overview, PullRequest, Pulls } from "./contract"
import type { definition } from "./definition"
import { issueBranchName, issueFromBranch, withClosing } from "./git"

export type { GitClient } from "./transport"
export type Actions = ReturnType<typeof createActions>

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message
  return String(error)
}

/** The pull request a branch belongs to: an open one first, else the most recent. */
export function pullFor(pulls: Pulls | undefined, branch: string | null | undefined): PullRequest | undefined {
  if (!pulls || !branch) return undefined
  const matching = pulls.items.filter((item) => item.head === branch && !item.cross)
  return matching.find((item) => item.state === "OPEN") ?? matching[0]
}

export function repoOf(overview: Overview | null | undefined) {
  return overview?.remote ? `${overview.remote.owner}/${overview.remote.repo}` : undefined
}

/** The user-facing git flows, shared by the panel and the command palette. Each one reports its own outcome. */
export function createActions(ctx: SetupContext<typeof definition>) {
  const git = createTransport(ctx)
  const queries = createQueries(git)

  const attempt = async <T,>(work: () => Promise<T>, success?: string): Promise<T | undefined> => {
    try {
      const result = await work()
      if (success) ctx.toast.show({ variant: "success", title: success })
      return result
    } catch (error) {
      ctx.toast.show({ variant: "error", title: ctx.t("toast.error"), description: errorMessage(error), duration: 10_000 })
      return undefined
    }
  }

  const progress = async <T,>(title: string, work: () => Promise<T>, success?: string) => {
    const toast = ctx.toast.show({ variant: "loading", title, persistent: true })
    const result = await attempt(work, success)
    toast.dismiss()
    return result
  }

  const fetch = (cwd: string) => progress(ctx.t("action.fetch"), () => git.fetch({ cwd }), ctx.t("toast.fetched"))
  const pull = (cwd: string) => progress(ctx.t("action.pull"), () => git.pull({ cwd }), ctx.t("toast.pulled"))

  const push = async (cwd: string, force = false) => {
    if (force) {
      const overview = await git.overview({ cwd }).catch(() => null)
      const ok = await ctx.dialogs.confirm({
        title: ctx.t("dialog.forcePush", { branch: overview?.branch ?? "HEAD" }),
        description: ctx.t("dialog.forcePushDescription"),
        confirm: ctx.t("action.forcePush"),
        danger: true,
      })
      if (!ok) return
    }
    return progress(ctx.t("action.push"), () => git.push({ cwd, force }), ctx.t("toast.pushed"))
  }

  const commit = (cwd: string, input: { message: string; amend: boolean; all: boolean; push: boolean }) =>
    attempt(async () => {
      if (!input.message.trim() && !input.amend) throw new Error(ctx.t("changes.emptyMessage"))
      await git.commit({ cwd, message: input.message.trim(), amend: input.amend, all: input.all })
      if (input.push) await git.push({ cwd, force: false })
      return true
    }, input.push ? ctx.t("toast.pushed") : ctx.t("changes.committed"))

  const newBranch = async (cwd: string, start?: { ref: string; label: string }) => {
    const name = await ctx.dialogs.prompt({
      title: start ? ctx.t("dialog.newBranchFrom", { start: start.label }) : ctx.t("dialog.newBranch"),
      placeholder: ctx.t("dialog.branchName"),
      submit: ctx.t("dialog.newBranch"),
    })
    const trimmed = name?.trim().replace(/\s+/g, "-")
    if (!trimmed) return
    return attempt(
      () => git.createBranch({ cwd, name: trimmed, start: start?.ref ?? null, checkout: true }),
      ctx.t("toast.branchCreated", { name: trimmed }),
    )
  }

  const checkoutBranch = async (cwd: string, branch: Pick<Branch, "name" | "remote">, locals?: readonly string[]) => {
    if (!branch.remote) return attempt(() => git.checkout({ cwd, ref: branch.name, track: null }), ctx.t("toast.switched", { name: branch.name }))
    const local = branch.name.slice(branch.name.indexOf("/") + 1)
    const known = locals ?? (await git.branches({ cwd }).catch(() => [])).filter((item) => !item.remote).map((item) => item.name)
    return attempt(
      () => git.checkout({ cwd, ref: local, track: known.includes(local) ? null : branch.name }),
      ctx.t("toast.switched", { name: local }),
    )
  }

  const checkout = (cwd: string, ref: string, label: string) =>
    attempt(() => git.checkout({ cwd, ref, track: null }), ctx.t("toast.switched", { name: label }))

  const deleteBranch = async (cwd: string, name: string) => {
    const ok = await ctx.dialogs.confirm({
      title: ctx.t("dialog.deleteBranch", { name }),
      confirm: ctx.t("dialog.delete"),
      danger: true,
    })
    if (!ok) return
    try {
      await git.deleteBranch({ cwd, name, force: false })
    } catch (error) {
      if (!/not fully merged/i.test(errorMessage(error))) {
        ctx.toast.show({ variant: "error", title: ctx.t("toast.error"), description: errorMessage(error), duration: 10_000 })
        return
      }
      const force = await ctx.dialogs.confirm({
        title: ctx.t("dialog.forceDelete", { name }),
        confirm: ctx.t("dialog.forceDeleteConfirm"),
        danger: true,
      })
      if (force) await attempt(() => git.deleteBranch({ cwd, name, force: true }))
    }
  }

  const deleteRemoteBranch = async (cwd: string, full: string) => {
    const remote = full.slice(0, full.indexOf("/"))
    const name = full.slice(remote.length + 1)
    const ok = await ctx.dialogs.confirm({
      title: ctx.t("dialog.deleteRemote", { name, remote }),
      confirm: ctx.t("dialog.delete"),
      danger: true,
    })
    if (ok) await progress(ctx.t("action.deleteRemote"), () => git.deleteRemoteBranch({ cwd, remote, name }))
  }

  const createPr = async (cwd: string, given?: Overview | null) => {
    const overview = given ?? (await attempt(() => git.overview({ cwd })))
    if (!overview?.branch) {
      ctx.toast.show({ variant: "error", title: ctx.t("toast.noRepo") })
      return
    }
    const branch = overview.branch
    const remote = overview.remote
    const repo = repoOf(overview)
    const linked = repo ? linkedIssue(repo, branch) : undefined
    // Read while the dialog opens; the item tab or the branch strip has usually cached it.
    const issue =
      repo && linked
        ? queries.client.fetchQuery(queries.options.item({ repo, number: linked })).then(
            (item) => (item.kind === "issue" ? { number: item.number, title: item.title } : undefined),
            () => undefined,
          )
        : Promise.resolve(undefined)
    ctx.dialogs.open((dialog) => (
      <CreatePullRequest
        ctx={ctx}
        git={git}
        cwd={cwd}
        branch={branch}
        base={overview.defaultBranch ?? "main"}
        issue={issue}
        draft={ctx.stores.prefs.value.prDraft ?? false}
        onDraft={(draft) =>
          ctx.stores.prefs.update((prefs) => {
            prefs.prDraft = draft
          })
        }
        onCompare={
          remote
            ? (base) => {
                ctx.system.openExternal(`${remote.web}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`)
                dialog.close()
              }
            : undefined
        }
        onCreate={async (input) => {
          const url = await progress(ctx.t("dialog.prCreate"), () => git.createPr({ cwd, ...input }), ctx.t("toast.prCreated"))
          if (!url) return false
          dialog.close()
          if (url.startsWith("https://")) ctx.system.openExternal(url)
          return true
        }}
      />
    ))
  }

  const openPr = async (cwd: string) => {
    const [overview, pulls] = await Promise.all([git.overview({ cwd }).catch(() => null), git.pulls({ cwd, fresh: false }).catch(() => undefined)])
    const pr = pullFor(pulls, overview?.branch)
    if (pr) return ctx.system.openExternal(pr.url)
    if (!overview?.branch) return ctx.toast.show({ variant: "error", title: ctx.t("toast.noRepo") })
    ctx.toast.show({
      title: ctx.t("toast.noPr", { branch: overview.branch }),
      actions: [{ label: ctx.t("action.createPr"), run: () => void createPr(cwd, overview) }],
    })
  }

  // A section an item tab should show first, such as Files for a link to a pull request's files. The tab reads it once.
  const focus = new Map<string, string>()

  const openTab = (target: TabTarget, fallback: string) => {
    const session = ctx.sessions.current()
    if (!session) {
      ctx.system.openExternal(fallback)
      return
    }
    ctx.layout.open(`${ctx.id}:${tabId(target)}`, session, { tab: "select", background: true })
  }

  // An open without a section clears an older request that no mount consumed (the tab was already open), so it does not
  // apply the next time the tab mounts.
  const openItem = (ref: ItemRef, section?: "files" | "checks") => {
    const id = tabId({ kind: "item", ref })
    if (section) focus.set(id, section)
    if (!section) focus.delete(id)
    openTab({ kind: "item", ref }, `https://github.com/${ref.repo}/issues/${ref.number}`)
  }

  const openRun = (repo: string, id: number, job?: number | null) => {
    const key = tabId({ kind: "run", repo, id })
    if (job) focus.set(key, String(job))
    if (!job) focus.delete(key)
    openTab({ kind: "run", repo, id }, `https://github.com/${repo}/actions/runs/${id}`)
  }

  const openCommit = (repo: string, sha: string) => openTab({ kind: "commit", repo, sha }, `https://github.com/${repo}/commit/${sha}`)

  /** The section a tab was asked to show first, once. */
  const takeFocus = (target: TabTarget) => {
    const id = tabId(target)
    const value = focus.get(id)
    focus.delete(id)
    return value
  }

  const createIssue = async (cwd: string) => {
    ctx.dialogs.open((dialog) => (
      <ComposeIssue
        ctx={ctx}
        onCreate={async (input) => {
          const url = await progress(ctx.t("dialog.issueCreate"), () => git.createIssue({ cwd, ...input }), ctx.t("toast.issueCreated"))
          if (!url) return
          dialog.close()
          const created = /\/issues\/(\d+)/.exec(url)
          const repo = /github\.com\/([^/]+\/[^/]+)\//.exec(url)
          if (created?.[1] && repo?.[1]) openItem({ repo: repo[1], number: Number(created[1]) })
        }}
      />
    ))
  }

  /** The issue a branch was started for: the link "Start working" stored, else the number in its name. */
  const linkedIssue = (repo: string, branch: string) => ctx.stores.prefs.value.issueBranches?.[`${repo}:${branch}`] ?? issueFromBranch(branch)

  const linkIssue = (repo: string, branch: string, number: number | undefined) =>
    ctx.stores.prefs.update((prefs) => {
      const links = { ...prefs.issueBranches }
      delete links[`${repo}:${branch}`]
      if (number) links[`${repo}:${branch}`] = number
      // The oldest links go first; a branch from long ago is rarely worked on again.
      prefs.issueBranches = Object.fromEntries(Object.entries(links).slice(-300))
    })

  /**
   * Starts work on an issue in one dialog: a branch named after it (fresh from the default branch, or from the current
   * one), what to do with uncommitted changes, and the agent with the issue as context, in a new session or this one.
   */
  const startIssue = async (cwd: string, issue: { number: number; title: string; repo?: string }) => {
    const [overview, branches] = await Promise.all([attempt(() => git.overview({ cwd })), git.branches({ cwd }).catch(() => [])])
    if (!overview) return
    const repo = issue.repo ?? repoOf(overview)
    if (!repo) {
      ctx.toast.show({ variant: "error", title: ctx.t("toast.noRepo") })
      return
    }
    const locals = branches.filter((branch) => !branch.remote).map((branch) => branch.name)
    const existing = [overview.branch ?? "", ...locals].find((name) => name && linkedIssue(repo, name) === issue.number)
    ctx.dialogs.open((dialog) => (
      <StartWork
        ctx={ctx}
        issue={issue}
        overview={overview}
        name={existing ?? issueBranchName(issue.number, issue.title)}
        locals={locals}
        onStart={async (input) => {
          const done = await startWork(cwd, { ...issue, repo }, overview, locals, input)
          if (done) dialog.close()
          return done
        }}
      />
    ))
  }

  const startWork = async (
    cwd: string,
    issue: { number: number; title: string; repo: string },
    overview: Overview,
    locals: readonly string[],
    input: StartInput,
  ) => {
    const name = input.name
    if (name !== overview.branch) {
      if (input.stash && (await attempt(() => git.stash({ cwd }))) === undefined) return false
      const exists = locals.includes(name)
      const start = exists || input.base === "current" ? null : await freshBase(cwd, overview)
      const switched = await progress(
        ctx.t(exists ? "action.switchBranch" : "dialog.newBranch"),
        () => (exists ? git.checkout({ cwd, ref: name, track: null }) : git.createBranch({ cwd, name, start, checkout: true })),
        ctx.t(exists ? "toast.switched" : "toast.branchCreated", { name }),
      )
      if (switched === undefined) {
        if (input.stash) ctx.toast.show({ title: ctx.t("start.stashKept"), duration: 8000 })
        return false
      }
    }
    linkIssue(issue.repo, name, issue.number)
    if (input.agent === "none") return true
    const context = await attempt(() => contextOf({ repo: issue.repo, number: issue.number }))
    if (!context) return true
    const prompt = ctx.t("agent.prompt.start", { number: issue.number, title: issue.title })
    if (input.agent === "session") startSession(context, prompt)
    if (input.agent === "chat") attach(context, prompt)
    return true
  }

  // The default branch as the remote has it now: fetched first, so the new branch does not start from a stale copy.
  const freshBase = async (cwd: string, overview: Overview) => {
    const base = overview.defaultBranch
    const remote = overview.remote?.name
    if (!base || !remote) return base
    await progress(ctx.t("start.fetching", { remote }), () => git.fetch({ cwd }))
    const branches = await git.branches({ cwd }).catch(() => [])
    return branches.some((branch) => branch.remote && branch.name === `${remote}/${base}`) ? `${remote}/${base}` : base
  }

  /**
   * After the branch's pull request merged: switches to the default branch, pulls it, and deletes the branch. Deletes it
   * without asking only when it is exactly what the pull request merged.
   */
  const finishBranch = async (cwd: string, overview: Overview, pr: Pick<PullRequest, "number" | "sha">) => {
    const branch = overview.branch
    const base = overview.defaultBranch
    if (!branch || !base) return
    const ok = await ctx.dialogs.confirm({
      title: ctx.t("finish.title", { base, branch }),
      description: ctx.t("finish.description", { number: pr.number }),
      confirm: ctx.t("finish.confirm"),
    })
    if (!ok) return
    const branches = await git.branches({ cwd }).catch(() => [])
    const locals = branches.filter((item) => !item.remote).map((item) => item.name)
    const remote = overview.remote?.name ?? "origin"
    const target = locals.includes(base) ? { name: base, remote: false } : { name: `${remote}/${base}`, remote: true }
    if ((await checkoutBranch(cwd, target, locals)) === undefined) return
    // A default branch just made from the remote's copy is current already.
    if (!target.remote && overview.remote) await attempt(() => git.pull({ cwd }))
    const tip = branches.find((item) => !item.remote && item.name === branch)?.sha
    const merged = !!tip && !!pr.sha?.startsWith(tip)
    const deleted = await git.deleteBranch({ cwd, name: branch, force: merged }).then(
      () => true,
      async (error: unknown) => {
        if (!/not fully merged/i.test(errorMessage(error))) {
          ctx.toast.show({ variant: "error", title: ctx.t("toast.error"), description: errorMessage(error), duration: 10_000 })
          return false
        }
        const force = await ctx.dialogs.confirm({
          title: ctx.t("dialog.forceDelete", { name: branch }),
          description: ctx.t("finish.moved", { number: pr.number }),
          confirm: ctx.t("dialog.forceDeleteConfirm"),
          danger: true,
        })
        return force && (await attempt(() => git.deleteBranch({ cwd, name: branch, force: true }))) !== undefined
      },
    )
    if (!deleted) return
    const repo = repoOf(overview)
    if (repo) linkIssue(repo, branch, undefined)
    ctx.toast.show({ variant: "success", title: ctx.t("finish.done", { base, branch }) })
  }

  /** Quotes context into the routed session's next prompt; with a prompt, fills an empty composer with it too. */
  const attach = (context: ChatContext, prompt?: string) => {
    const composer = ctx.screen.current()?.composer
    if (!composer?.quotable()) {
      ctx.toast.show({ variant: "error", title: ctx.t("toast.noComposer") })
      return false
    }
    composer.attach({
      type: "quote",
      commentID: crypto.randomUUID(),
      text: context.text,
      source: { label: context.label, icon: "github", subject: context.subject },
    })
    if (prompt && !composer.text().trim()) composer.setText(prompt)
    composer.focus()
    ctx.toast.show({ variant: "success", title: ctx.t("toast.attached", { label: context.label }), duration: 2000 })
    return true
  }

  /** Opens a new draft session in the same project, with the context written into its prompt for review. */
  const startSession = (context: ChatContext, prompt: string) => {
    const session = ctx.sessions.current()
    if (!session) {
      ctx.toast.show({ variant: "error", title: ctx.t("toast.noComposer") })
      return
    }
    ctx.layout.draft({
      server: session.server.id,
      directory: session.directory,
      prompt: `${prompt}\n\n<context source="${context.subject.replaceAll('"', "'")}">\n${context.text}\n</context>`,
    })
  }

  /** An issue or pull request with what the agent needs: comments, and for a PR its reviews and changed files. */
  const contextOf = async (ref: ItemRef) => {
    // Through the query cache: what the item's tab already loaded is reused.
    const item = await queries.client.fetchQuery(queries.options.item(ref))
    if (item.kind !== "pr") return itemContext(item)
    const head = item.pr?.sha
    const [reviews, files] = await Promise.all([
      queries.client.fetchQuery(queries.options.reviews(ref)).catch(() => undefined),
      head ? queries.client.fetchQuery(queries.options.files(ref, head)).catch(() => undefined) : undefined,
    ])
    return itemContext(item, { reviews, files })
  }

  // Reading an item's context can take seconds; a second click meanwhile would quote it twice.
  const asking = new Set<string>()

  const ask = async (ref: ItemRef, preset: string | undefined, mode: "chat" | "session" = "chat") => {
    const label = `${ref.repo}#${ref.number}`
    if (asking.has(label)) return
    asking.add(label)
    const pending: { toast?: { dismiss(): void } } = {}
    const timer = setTimeout(() => {
      pending.toast = ctx.toast.show({ variant: "loading", title: ctx.t("agent.reading", { ref: label }), persistent: true })
    }, 500)
    const context = await attempt(() => contextOf(ref))
    clearTimeout(timer)
    pending.toast?.dismiss()
    asking.delete(label)
    if (!context) return
    const prompt = preset ? ctx.t(`agent.prompt.${preset}`, { ref: label }) : undefined
    if (mode === "session") return startSession(context, prompt ?? ctx.t("agent.prompt.look", { ref: label }))
    attach(context, prompt)
  }

  /** The agent actions for an issue or pull request, shared by its tab, rows and the inbox. */
  const agentMenu = (ref: ItemRef, kind: "issue" | "pr" | "unknown"): UiMenuEntry[] => {
    const presets = kind === "pr" ? ["review", "address", "checks"] : kind === "issue" ? ["investigate", "fix"] : ["look"]
    return [
      { label: ctx.t("action.addToChat"), icon: "bubble-5", onSelect: () => void ask(ref, undefined) },
      ...presets.map((preset) => ({ label: ctx.t(`agent.preset.${preset}`), icon: "brain" as const, onSelect: () => void ask(ref, preset) })),
      { type: "separator" as const },
      // The agent's review becomes a draft review the user edits and submits in the pull request's Files section.
      ...(kind === "pr" ? [{ label: ctx.t("agent.preset.prereview"), icon: "review" as const, onSelect: () => void ask(ref, "prereview", "session") }] : []),
      {
        label: ctx.t("agent.newSession"),
        icon: "new-session",
        onSelect: () => void ask(ref, kind === "pr" ? "review" : kind === "issue" ? "fix" : "look", "session"),
      },
    ]
  }

  /** Quotes an issue or pull request into the next prompt, so the agent reads it. */
  const addToChat = (item: Item) => void ask({ repo: item.repo, number: item.number }, undefined)

  const setItemState = async (item: Item, open: boolean) => {
    if (!open) {
      const ok = await ctx.dialogs.confirm({
        title: ctx.t(item.kind === "pr" ? "dialog.closePr" : "dialog.closeIssue", { number: item.number }),
        description: item.title,
        confirm: ctx.t("action.close"),
        danger: true,
      })
      if (!ok) return
    }
    return attempt(() => git.setState({ repo: item.repo, number: item.number, kind: item.kind, open }))
  }

  const mergePr = async (cwd: string, pr: Pick<PullRequest, "number" | "title" | "head">, repo: string | null = null) => {
    const method = await ctx.dialogs.select({
      title: ctx.t("dialog.mergeMethod", { number: pr.number }),
      options: [
        { title: ctx.t("dialog.squash"), value: "squash" as const, description: pr.title },
        { title: ctx.t("dialog.merge"), value: "merge" as const, description: pr.title },
        { title: ctx.t("dialog.rebase"), value: "rebase" as const, description: pr.title },
      ],
    })
    if (!method) return
    // A choice rather than a confirm: dismissing it cancels the merge instead of merging and keeping the branch.
    const branch = await ctx.dialogs.select({
      title: ctx.t("dialog.deleteAfterMerge"),
      options: [
        { title: ctx.t("dialog.deleteAfterMergeConfirm"), value: "delete" as const, description: pr.head },
        { title: ctx.t("dialog.keepBranch"), value: "keep" as const, description: pr.head },
      ],
    })
    if (!branch) return
    const deleteBranch = branch === "delete"
    return progress(ctx.t("action.mergePr"), () => git.mergePr({ cwd, repo, number: pr.number, method, deleteBranch }), ctx.t("toast.prMerged"))
  }

  // The agent's GitHub actions: the user's decisions on what it proposed.
  const agent = {
    decide: (sessionID: string, ids: readonly string[] | null, decision: "approve" | "skip", batch: string | null = null) =>
      attempt(() => git.agentDecide({ sessionID, ids: ids ? [...ids] : null, batch, decision })),
    undo: (sessionID: string, id: string) => attempt(() => git.agentUndo({ sessionID, id })),
    retry: (sessionID: string, ids: readonly string[]) => attempt(() => git.agentRetry({ sessionID, ids: [...ids] })),
    setAuto: (sessionID: string, auto: boolean) => attempt(() => git.agentAuto({ sessionID, auto })),
  }

  // A page the panel should show, asked from outside it, such as the composer pill; the panel clears it once shown.
  const [pageRequest, setPageRequest] = createSignal<"activity">()
  const openActivity = () => {
    const session = ctx.sessions.current()
    if (!session) return
    setPageRequest("activity")
    ctx.layout.open(`${ctx.id}:main`, session, { tab: "select" })
  }

  const copy = (text: string) =>
    attempt(async () => {
      await ctx.system.copy(text)
      ctx.toast.show({ variant: "success", title: ctx.t("toast.copied"), duration: 1500 })
    })

  return {
    git,
    queries,
    attempt,
    progress,
    fetch,
    pull,
    push,
    commit,
    newBranch,
    checkout,
    checkoutBranch,
    deleteBranch,
    deleteRemoteBranch,
    createPr,
    openPr,
    mergePr,
    openItem,
    openRun,
    openCommit,
    takeFocus,
    createIssue,
    startIssue,
    linkedIssue,
    finishBranch,
    addToChat,
    attach,
    startSession,
    ask,
    agentMenu,
    setItemState,
    copy,
    agent,
    openActivity,
    pageRequest,
    clearPageRequest: () => setPageRequest(undefined),
  }
}

function CreatePullRequest(props: {
  ctx: Context
  git: GitClient
  cwd: string
  branch: string
  base: string
  /** The issue the branch works on: its title becomes the title, and the body closes it. */
  issue: Promise<{ number: number; title: string } | undefined>
  draft: boolean
  onDraft: (draft: boolean) => void
  onCompare?: (base: string) => void
  onCreate: (input: { title: string; body: string; base: string; draft: boolean }) => Promise<boolean>
}) {
  const ui = props.ctx.ui
  const t = props.ctx.t
  const [title, setTitle] = createSignal("")
  const [body, setBody] = createSignal("")
  const [base, setBase] = createSignal(props.base)
  const [draft, setDraft] = createSignal(props.draft)
  const [busy, setBusy] = createSignal(false)
  const [issue, setIssue] = createSignal<number>()
  const touched = { title: false, body: false }

  onMount(() => {
    void Promise.all([props.git.prDefaults({ cwd: props.cwd, base: props.base }).catch(() => undefined), props.issue]).then(([defaults, linked]) => {
      setIssue(linked?.number)
      // A repository's template replaces the list of commits, as on GitHub.
      const text = defaults?.template ?? defaults?.body ?? ""
      if (!touched.title) setTitle(linked?.title ?? defaults?.title ?? "")
      if (!touched.body) setBody(linked ? withClosing(text, linked.number) : text)
    })
  })

  const submit = async () => {
    if (!title().trim() || busy()) return
    setBusy(true)
    await props.onCreate({ title: title().trim(), body: body(), base: base().trim() || props.base, draft: draft() })
    setBusy(false)
  }

  return (
    <ui.Dialog
      title={t("dialog.createPr")}
      description={[`${props.branch} → ${base() || props.base}`, issue() ? t("dialog.prFixes", { number: issue() ?? 0 }) : ""].filter(Boolean).join(" · ")}
      size="normal"
      footer={
        <div class="ghp-dialog-footer">
          <Show when={props.onCompare}>
            {(compare) => (
              <ui.Button variant="ghost" icon="square-arrow-top-right" onClick={() => compare()(base() || props.base)}>
                {t("dialog.prCompare")}
              </ui.Button>
            )}
          </Show>
          <ui.Button variant="contrast" icon="github" busy={busy()} disabled={!title().trim()} onClick={() => void submit()}>
            {t("dialog.prCreate")}
          </ui.Button>
        </div>
      }
    >
      <div class="ghp-form">
        <ui.TextInput
          label={t("dialog.prTitle")}
          value={title()}
          autofocus
          onInput={(value) => {
            touched.title = true
            setTitle(value)
          }}
          onSubmit={() => void submit()}
        />
        <ui.TextInput label={t("dialog.prBase")} value={base()} onInput={setBase} />
        <label class="ghp-field">
          <span class="ghp-field-label">{t("dialog.prBody")}</span>
          <textarea
            class="ghp-textarea"
            rows={8}
            value={body()}
            onInput={(event) => {
              touched.body = true
              setBody(event.currentTarget.value)
            }}
          />
        </label>
        <ui.Switch
          label={t("dialog.prDraft")}
          checked={draft()}
          onChange={(value) => {
            setDraft(value)
            props.onDraft(value)
          }}
        />
      </div>
    </ui.Dialog>
  )
}

interface StartInput {
  readonly name: string
  readonly base: "default" | "current"
  readonly stash: boolean
  readonly agent: "session" | "chat" | "none"
}

function StartWork(props: {
  ctx: Context
  issue: { number: number; title: string }
  overview: Overview
  name: string
  locals: readonly string[]
  onStart: (input: StartInput) => Promise<boolean>
}) {
  const ui = props.ctx.ui
  const t = props.ctx.t
  const [name, setName] = createSignal(props.name)
  const [base, setBase] = createSignal<StartInput["base"]>("default")
  const [changes, setChanges] = createSignal<"carry" | "stash">("carry")
  const [agent, setAgent] = createSignal<StartInput["agent"]>("session")
  const [busy, setBusy] = createSignal(false)
  const trimmed = () => name().trim().replace(/\s+/g, "-")
  const current = () => trimmed() === props.overview.branch
  const exists = () => !current() && props.locals.includes(trimmed())
  const dirty = () => props.overview.files.length
  const remoteBase = () => {
    const remote = props.overview.remote?.name
    const branch = props.overview.defaultBranch
    if (!branch) return undefined
    return remote ? `${remote}/${branch}` : branch
  }

  const submit = async () => {
    if (!trimmed() || busy()) return
    setBusy(true)
    await props.onStart({ name: trimmed(), base: remoteBase() ? base() : "current", stash: !current() && dirty() > 0 && changes() === "stash", agent: agent() })
    setBusy(false)
  }

  return (
    <ui.Dialog
      title={t("start.title", { number: props.issue.number })}
      description={props.issue.title}
      size="fit"
      footer={
        <div class="ghp-dialog-footer">
          <ui.Button variant="contrast" icon="branch-out" busy={busy()} disabled={!trimmed()} onClick={() => void submit()}>
            {t("start.submit")}
          </ui.Button>
        </div>
      }
    >
      <div class="ghp-form ghp-start">
        <div class="ghp-field">
          <span class="ghp-field-label">{t("start.branch")}</span>
          <ui.TextInput label={t("start.branch")} value={name()} autofocus onInput={setName} onSubmit={() => void submit()} />
          <Show when={current() || exists()}>
            <span class="ghp-start-note">{t(current() ? "start.current" : "start.existing", { name: trimmed() })}</span>
          </Show>
        </div>
        <Show when={!current() && !exists() && remoteBase()}>
          {(fresh) => (
            <Choice
              label={t("start.base")}
              value={base()}
              onChange={setBase}
              options={[
                { value: "default", label: t("start.base.default", { base: fresh() }) },
                { value: "current", label: t("start.base.current", { branch: props.overview.branch ?? "HEAD" }) },
              ]}
            />
          )}
        </Show>
        <Show when={!current() && dirty() > 0}>
          <Choice
            label={props.ctx.plural("start.changes", dirty())}
            value={changes()}
            onChange={setChanges}
            options={[
              { value: "carry", label: t("start.changes.carry") },
              { value: "stash", label: t("start.changes.stash") },
            ]}
          />
        </Show>
        <Choice
          label={t("start.agent")}
          value={agent()}
          onChange={setAgent}
          options={[
            { value: "session", label: t("start.agent.session") },
            { value: "chat", label: t("start.agent.chat") },
            { value: "none", label: t("start.agent.none") },
          ]}
        />
      </div>
    </ui.Dialog>
  )
}

function Choice<T extends string>(props: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div class="ghp-field">
      <span class="ghp-field-label">{props.label}</span>
      <div class="ghp-segmented ghp-choice" role="radiogroup" aria-label={props.label}>
        <For each={props.options}>
          {(option) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.value === option.value}
              data-selected={props.value === option.value ? "" : undefined}
              onClick={() => props.onChange(option.value)}
            >
              {option.label}
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

function ComposeIssue(props: { ctx: Context; onCreate: (input: { title: string; body: string }) => Promise<void> }) {
  const ui = props.ctx.ui
  const t = props.ctx.t
  const [title, setTitle] = createSignal("")
  const [body, setBody] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const submit = async () => {
    if (!title().trim() || busy()) return
    setBusy(true)
    await props.onCreate({ title: title().trim(), body: body() })
    setBusy(false)
  }
  return (
    <ui.Dialog
      title={t("dialog.issueNew")}
      size="normal"
      footer={
        <div class="ghp-dialog-footer">
          <ui.Button variant="contrast" icon="github" busy={busy()} disabled={!title().trim()} onClick={() => void submit()}>
            {t("dialog.issueCreate")}
          </ui.Button>
        </div>
      }
    >
      <div class="ghp-form">
        <ui.TextInput label={t("dialog.prTitle")} value={title()} autofocus onInput={setTitle} onSubmit={() => void submit()} />
        <label class="ghp-field">
          <span class="ghp-field-label">{t("dialog.prBody")}</span>
          <textarea class="ghp-textarea" rows={10} value={body()} onInput={(event) => setBody(event.currentTarget.value)} />
        </label>
      </div>
    </ui.Dialog>
  )
}
