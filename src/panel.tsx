import { createEffect, createMemo, createSignal, For, Match, onMount, Show, Switch, type Accessor, type JSX } from "solid-js"
import { createKeyed, usePanel, usePlugin, type Context, type MountedSession, type UiMenuEntry } from "@opencode/plugin/gui"
import { errorMessage, pullFor, repoOf, type Actions } from "./actions"
import { ActivityView } from "./activity"
import { openBranchPicker } from "./branches"
import { fileContext } from "./context"
import { latest } from "./queries"
import type { AgentQueue, Commit, FileChange, Overview, PullRequest, Pulls } from "./contract"
import type { definition, View } from "./definition"
import { closingRefs, parseItemUrl } from "./git"
import { layout, type GraphEdge, type GraphRow } from "./graph"
import { InboxView } from "./inbox"
import { IssueIcon, ItemHover } from "./item"
import { RunsView } from "./run"
import { SearchList } from "./search"

const LANE = 14
const ROW = 28
const PAD = 6
const MAX_LANES = 12
const WORKTREE = "*worktree"
const TABS = ["changes", "graph", "pulls", "issues"] as const

type Ctx = ReturnType<typeof usePlugin<typeof definition>>
type Tab = (typeof TABS)[number]
/** A view the top bar opens over the tabs: the inbox, the workflow runs or the agent's GitHub actions. */
type Page = "inbox" | "runs" | "activity"
type Outgoing = Awaited<ReturnType<Actions["git"]["outgoing"]>>

export interface State {
  readonly ctx: Ctx
  readonly actions: Actions
  readonly session: MountedSession
  readonly overview: Accessor<Overview>
  readonly pulls: Accessor<Pulls | undefined>
  readonly pullsLoading: Accessor<boolean>
  /** The current branch's unpushed commits, and how far it is ahead of the default branch. */
  readonly outgoing: Accessor<Outgoing | undefined>
  readonly unread: Accessor<number>
  /** The session's agent actions on GitHub. */
  readonly agent: Accessor<AgentQueue | undefined>
  readonly cwd: Accessor<string>
  /** The panel is on screen; local reads poll only then. */
  readonly visible: Accessor<boolean>
  readonly busy: Accessor<string | undefined>
  /** The selected tab: the stored view, or Changes for one this repository cannot show. */
  readonly view: Accessor<Tab>
  /** The inbox or the workflow runs, shown instead of the selected tab. */
  readonly page: Accessor<Page | undefined>
  readonly run: (id: string, work: () => Promise<unknown>) => Promise<void>
  readonly refresh: () => void
  readonly refreshPulls: (force?: boolean) => void
  readonly setView: (view: View) => void
  readonly setPage: (page: Page | undefined) => void
  /** Shows a commit in History, expanded. */
  readonly reveal: (hash: string) => void
  /** The commit History was asked to show, once. */
  readonly takeReveal: () => string | undefined
}

/** Keeps a value's identity while a refetch returns the same data, so lists do not re-render every poll. */
function stable<T>(read: () => T) {
  return createMemo(read, undefined, { equals: (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b) })
}

export function GitPanel(props: { session: MountedSession; actions: Actions }) {
  const ctx = usePlugin<typeof definition>()
  const ui = ctx.ui
  const t = ctx.t
  const frame = usePanel()
  const q = props.actions.queries
  const [busy, setBusy] = createSignal<string>()
  // Local git reads poll while the panel is on screen, so edits by the agent or an editor show up; GitHub data refreshes
  // on its own staleness and on the backend's events.
  const visible = () => frame.visible()
  const poll = (ms: number) => (visible() ? ms : false)

  const overviewQuery = latest(
    q.query(() => ({ ...q.options.overview(props.session.directory), refetchInterval: poll(4000), refetchOnWindowFocus: true })),
  )
  const overview = stable(() => overviewQuery.latest)
  const cwd = () => overview()?.root ?? props.session.directory

  const pullsQuery = latest(q.query(() => ({ ...q.options.pulls(cwd()), enabled: !!overview()?.remote, refetchInterval: poll(90_000) })))
  const pulls = stable(() => pullsQuery.latest)

  const outgoingQuery = latest(q.query(() => ({ ...q.options.outgoing(cwd()), enabled: !!overview()?.branch, refetchInterval: poll(10_000) })))
  const outgoing = stable(() => outgoingQuery.latest)
  // A commit, push or switch shows in the overview first; read what is unpushed again at once.
  createKeyed(
    () => {
      const current = overview()
      return current ? `${current.branch}\n${current.head}\n${current.upstream}\n${current.ahead}` : undefined
    },
    () => q.invalidate(q.keys.outgoing(cwd())),
  )

  const inbox = latest(q.query(() => ({ ...q.options.inbox(), refetchInterval: poll(120_000) })))
  const agent = latest(q.query(() => q.options.agent(props.session.id)))

  const refresh = () => q.invalidate(["git"])
  const refreshPulls = (_force = false) => {
    q.invalidate(q.keys.pulls(cwd()))
    q.invalidate(["gh"])
  }

  const run = async (id: string, work: () => Promise<unknown>) => {
    if (busy()) return
    setBusy(id)
    try {
      await work()
    } finally {
      setBusy(undefined)
      refresh()
    }
  }

  // Views of earlier versions, still in stored preferences, open as the page that replaced them.
  const stored = ctx.stores.prefs.value.view
  const [page, setPage] = createSignal<Page | undefined>(stored === "inbox" ? "inbox" : stored === "actions" ? "runs" : undefined)
  // The composer pill asks for the activity page from outside the panel.
  createEffect(() => {
    const requested = props.actions.pageRequest()
    if (!requested) return
    setPage(requested)
    props.actions.clearPageRequest()
  })
  const revealed: { hash?: string } = {}

  const setView = (view: View) => {
    setPage(undefined)
    ctx.stores.prefs.update((draft) => {
      draft.view = view
    })
  }

  return (
    <div class="ghp" data-ghp-source="the git panel" data-ghp-label="Git">
      <Switch>
        <Match when={overviewQuery.error !== undefined && overview() === undefined}>
          <div class="ghp-empty">
            <ui.Icon name="circle-exclamation" />
            <span>{ctx.app.platform === "desktop" ? errorMessage(overviewQuery.error) : t("repo.unavailable")}</span>
            <ui.Button size="small" variant="neutral" icon="refresh" busy={overviewQuery.loading} onClick={refresh}>
              {t("action.retry")}
            </ui.Button>
          </div>
        </Match>
        <Match when={overview() === undefined}>
          <div class="ghp-empty">
            <ui.Loader />
            <span>{t("repo.loading")}</span>
          </div>
        </Match>
        <Match when={overview() === null}>
          <div class="ghp-empty">
            <ui.Icon name="branch" />
            <span>{t("repo.none")}</span>
          </div>
        </Match>
        <Match when={overview()}>
          {(current) => {
            const view = (): Tab => {
              const value = ctx.stores.prefs.value.view
              if (value === "graph" || (value === "pulls" && current().remote) || (value === "issues" && current().remote)) return value
              return "changes"
            }
            const shown = () => (page() === "runs" && !current().remote ? undefined : page())
            const state: State = {
              ctx,
              actions: props.actions,
              session: props.session,
              overview: current,
              pulls,
              pullsLoading: () => pullsQuery.loading,
              outgoing,
              unread: () => inbox.latest?.notifications.filter((entry) => entry.unread).length ?? 0,
              agent: () => agent.latest,
              cwd,
              visible,
              busy,
              view,
              page: shown,
              run,
              refresh,
              refreshPulls,
              setView,
              setPage,
              reveal: (hash) => {
                revealed.hash = hash
                setView("graph")
              },
              takeReveal: () => {
                const hash = revealed.hash
                revealed.hash = undefined
                return hash
              },
            }
            return (
              <>
                <TopBar state={state} />
                <Switch>
                  <Match when={shown()}>{(value) => <PageBar state={state} page={value()} />}</Match>
                  <Match when={view() === "changes" || view() === "graph"}>
                    <BranchBar state={state} />
                  </Match>
                </Switch>
                <div class="ghp-body">
                  <Switch>
                    <Match when={shown() === "inbox"}>
                      <InboxView actions={props.actions} />
                    </Match>
                    <Match when={shown() === "activity"}>
                      <ActivityView session={props.session} actions={props.actions} />
                    </Match>
                    <Match when={shown() === "runs" && repoOf(current())}>
                      {(repo) => <RunsView repo={repo()} branch={current().branch} actions={props.actions} />}
                    </Match>
                    <Match when={view() === "changes"}>
                      <ChangesView state={state} />
                    </Match>
                    <Match when={view() === "graph"}>
                      <GraphView state={state} />
                    </Match>
                    <Match when={view() === "pulls"}>
                      <PullsView state={state} />
                    </Match>
                    <Match when={view() === "issues"}>
                      <IssuesView state={state} />
                    </Match>
                  </Switch>
                </div>
              </>
            )
          }}
        </Match>
      </Switch>
    </div>
  )
}

/** The repository, the tabs, and what is repository-wide: the inbox and the repository's menu. */
function TopBar(props: { state: State }) {
  const s = props.state
  const ctx = s.ctx
  const ui = ctx.ui
  const t = ctx.t
  const ov = s.overview
  const togglePage = (page: Page) => s.setPage(s.page() === page ? undefined : page)

  const items = (): UiMenuEntry[] => [
    {
      label: t("action.fetch"),
      icon: "outline-rotate-clockwise",
      disabled: !!s.busy(),
      onSelect: () =>
        void s.run("fetch", async () => {
          await s.actions.fetch(s.cwd())
          s.refreshPulls(true)
        }),
    },
    {
      label: t("action.refresh"),
      icon: "refresh",
      onSelect: () => {
        s.refresh()
        s.refreshPulls(true)
      },
    },
    { type: "separator" },
    { label: t("page.runs"), icon: "status", disabled: !ov().remote, onSelect: () => togglePage("runs") },
    { label: t("page.inbox"), icon: "notifications", onSelect: () => togglePage("inbox") },
    { label: t("page.activity"), icon: "checklist", onSelect: () => togglePage("activity") },
    {
      label: t("repo.github"),
      icon: "square-arrow-top-right",
      disabled: !ov().remote,
      onSelect: () => {
        const remote = ov().remote
        if (remote) ctx.system.openExternal(remote.web)
      },
    },
    { label: t("action.newIssue"), icon: "plus", disabled: !ov().remote, onSelect: () => void s.actions.createIssue(s.cwd()) },
    { type: "separator" },
    {
      label: t("action.headerChip"),
      icon: ctx.stores.prefs.value.headerChip ? "check" : undefined,
      onSelect: () =>
        ctx.stores.prefs.update((draft) => {
          draft.headerChip = !draft.headerChip
        }),
    },
  ]

  return (
    <div class="ghp-topbar">
      <span class="ghp-repo ghp-ellipsis" title={ov().root}>
        <Show when={ov().remote} fallback={ov().name}>
          {(remote) => (
            <>
              <span class="ghp-faint">{remote().owner}/</span>
              {remote().repo}
            </>
          )}
        </Show>
      </span>
      <Tabs state={s} />
      <div class="ghp-topbar-actions">
        <Show when={(s.agent()?.actions.length ?? 0) > 0}>
          <ui.Tooltip value={t("page.activity")}>
            <ui.Button
              class="ghp-bell ghp-activity-button"
              size="small"
              variant="ghost"
              icon="checklist"
              aria-label={t("page.activity")}
              aria-pressed={s.page() === "activity"}
              data-pressed={s.page() === "activity" ? "" : undefined}
              onClick={() => togglePage("activity")}
            >
              <Show when={s.agent()?.actions.filter((action) => action.status === "proposed").length}>
                {(count) => <span class="ghp-count" data-active="" data-tone="attention">{count() > 99 ? "99+" : count()}</span>}
              </Show>
            </ui.Button>
          </ui.Tooltip>
        </Show>
        <ui.Tooltip value={t("page.inbox")}>
          <ui.Button
            class="ghp-bell"
            size="small"
            variant="ghost"
            icon="notifications"
            aria-label={t("page.inbox")}
            aria-pressed={s.page() === "inbox"}
            data-pressed={s.page() === "inbox" ? "" : undefined}
            onClick={() => togglePage("inbox")}
          >
            <Show when={s.unread()}>{(count) => <span class="ghp-count" data-active="">{count() > 99 ? "99+" : count()}</span>}</Show>
          </ui.Button>
        </ui.Tooltip>
        <ui.Menu label={t("action.more")} trigger="icon" icon="outline-dots" placement="bottom-end" items={items()} />
      </div>
    </div>
  )
}

function Tabs(props: { state: State }) {
  const s = props.state
  const t = s.ctx.t
  // Keyed by id, so a count changing on a poll does not remount the buttons (and drop keyboard focus).
  const tabs = () => TABS.filter((id) => s.overview().remote || (id !== "pulls" && id !== "issues"))
  return (
    <div class="ghp-tabs" role="tablist">
      <For each={tabs()}>
        {(id) => {
          const selected = () => !s.page() && s.view() === id
          return (
            <button
              type="button"
              role="tab"
              class="ghp-tab"
              aria-selected={selected()}
              data-selected={selected() ? "" : undefined}
              title={t(`view.${id}`)}
              onClick={() => s.setView(id)}
            >
              <span class="ghp-tab-label-long">{t(`view.${id}`)}</span>
              <span class="ghp-tab-label-short">{t(`view.short.${id}`)}</span>
              <Show when={id === "changes" && s.overview().files.length}>
                {(count) => <span class="ghp-tab-count">{count()}</span>}
              </Show>
            </button>
          )
        }}
      </For>
    </div>
  )
}

/** The way back from a page the top bar opened. */
function PageBar(props: { state: State; page: Page }) {
  const ui = props.state.ctx.ui
  const t = props.state.ctx.t
  return (
    <div class="ghp-pagebar">
      <ui.Tooltip value={t("page.back")}>
        <ui.IconButton icon="arrow-left" label={t("page.back")} size="small" variant="ghost" onClick={() => props.state.setPage(undefined)} />
      </ui.Tooltip>
      <span class="ghp-pagebar-title">{t(`page.${props.page}`)}</span>
      <Show when={props.page === "runs" && props.state.overview().branch}>
        {(branch) => <span class="ghp-faint ghp-ellipsis">{branch()}</span>}
      </Show>
    </div>
  )
}

/** The current branch above Changes and History: switching, syncing, an operation in progress, and its pull request. */
function BranchBar(props: { state: State }) {
  const s = props.state
  const ctx = s.ctx
  const ui = ctx.ui
  const t = ctx.t
  const ov = s.overview
  // The upstream is worth a word only when it is not the branch's namesake on the remote.
  const upstreamNote = () => {
    const upstream = ov().upstream
    const branch = ov().branch
    if (!branch) return undefined
    if (!upstream) return t("repo.noUpstream")
    return upstream.endsWith(`/${branch}`) ? undefined : `→ ${upstream}`
  }

  const items = (): UiMenuEntry[] => [
    {
      label: t("action.newBranch"),
      icon: "branch-out",
      disabled: !!s.busy(),
      onSelect: () => void s.run("branch", () => s.actions.newBranch(s.cwd())),
    },
    {
      label: t("action.createPr"),
      icon: "github",
      disabled: !ov().branch || !ov().remote,
      onSelect: () => void s.actions.createPr(s.cwd(), ov()),
    },
    {
      label: t("action.forcePush"),
      icon: "cloud-upload",
      disabled: !ov().branch || !!s.busy(),
      onSelect: () => void s.run("push", () => s.actions.push(s.cwd(), true)),
    },
    { type: "separator" },
    {
      label: t("action.stash"),
      icon: "archive",
      disabled: ov().files.length === 0 || !!s.busy(),
      onSelect: () => void s.run("stash", () => s.actions.attempt(() => s.actions.git.stash({ cwd: s.cwd() }), t("toast.stashed"))),
    },
    {
      label: t("action.stashPop", { count: ov().stashes }),
      icon: "outline-undo",
      disabled: ov().stashes === 0 || !!s.busy(),
      onSelect: () => void s.run("stash", () => s.actions.attempt(() => s.actions.git.stashPop({ cwd: s.cwd() }))),
    },
  ]

  return (
    <div class="ghp-branchbar">
      <div class="ghp-branchbar-row">
        <button
          type="button"
          class="ghp-branch-button"
          title={[t("action.switchBranch"), ov().upstream].filter(Boolean).join(" · ")}
          onClick={() => openBranchPicker(ctx, s.actions, s.cwd())}
        >
          <ui.Icon name="branch" size="small" />
          <span class="ghp-ellipsis">{ov().branch ?? `${t("repo.detached")} ${ov().head?.slice(0, 7) ?? ""}`}</span>
          <ui.Icon name="chevron-down" size="small" class="ghp-faint" />
        </button>
        <Show when={upstreamNote()}>{(note) => <span class="ghp-upstream ghp-ellipsis">{note()}</span>}</Show>
        <div class="ghp-spacer" />
        <Show
          when={ov().upstream || !ov().branch}
          fallback={
            <ui.Button
              size="small"
              variant="ghost"
              icon="cloud-upload"
              busy={s.busy() === "push"}
              disabled={!!s.busy()}
              onClick={() => void s.run("push", () => s.actions.push(s.cwd()))}
            >
              {t("action.publish")}
            </ui.Button>
          }
        >
          <ui.Tooltip value={t("action.pull")}>
            <ui.Button
              size="small"
              variant="ghost"
              icon="download"
              busy={s.busy() === "pull"}
              disabled={!!s.busy() || !ov().upstream}
              onClick={() => void s.run("pull", () => s.actions.pull(s.cwd()))}
            >
              <span class="ghp-count" data-active={ov().behind > 0 ? "" : undefined}>
                {ov().behind}
              </span>
            </ui.Button>
          </ui.Tooltip>
          <ui.Tooltip value={t("action.push")}>
            <ui.Button
              size="small"
              variant="ghost"
              icon="cloud-upload"
              busy={s.busy() === "push"}
              disabled={!!s.busy() || !ov().upstream}
              onClick={() => void s.run("push", () => s.actions.push(s.cwd()))}
            >
              <span class="ghp-count" data-active={ov().ahead > 0 ? "" : undefined}>
                {ov().ahead}
              </span>
            </ui.Button>
          </ui.Tooltip>
        </Show>
        <ui.Tooltip value={t("action.fetch")}>
          <ui.IconButton
            icon="outline-rotate-clockwise"
            label={t("action.fetch")}
            variant="ghost"
            size="small"
            busy={s.busy() === "fetch"}
            disabled={!!s.busy()}
            onClick={() =>
              void s.run("fetch", async () => {
                await s.actions.fetch(s.cwd())
                s.refreshPulls(true)
              })
            }
          />
        </ui.Tooltip>
        <ui.Menu label={t("branch.more")} trigger="icon" icon="outline-dots" placement="bottom-end" items={items()} />
      </div>
      <Show when={ov().operation}>
        {(op) => (
          <div class="ghp-banner">
            <ui.Icon name="warning" size="small" />
            <span>{t(`operation.${op()}`)}</span>
            <div class="ghp-spacer" />
            <ui.Button
              size="small"
              variant="ghost"
              busy={s.busy() === "abort"}
              disabled={!!s.busy()}
              onClick={() =>
                void s.run("abort", async () => {
                  const ok = await ctx.dialogs.confirm({
                    title: ctx.t("dialog.abort"),
                    description: ctx.t("dialog.abortDescription"),
                    confirm: ctx.t("action.abort"),
                    danger: true,
                  })
                  if (ok) await s.actions.attempt(() => s.actions.git.abort({ cwd: s.cwd() }))
                })
              }
            >
              {t("action.abort")}
            </ui.Button>
            <ui.Button
              size="small"
              variant="contrast"
              busy={s.busy() === "continue"}
              disabled={!!s.busy()}
              onClick={() => void s.run("continue", () => s.actions.attempt(() => s.actions.git.continue({ cwd: s.cwd() })))}
            >
              {t("action.continue")}
            </ui.Button>
          </div>
        )}
      </Show>
      <BranchStrip state={s} />
    </div>
  )
}

/**
 * The current branch's pull request in one line: its state, checks and review, what is unpushed, and the next step.
 * Without one on a feature branch, how far the branch is ahead and a way to open one. Nothing on the default branch.
 */
function BranchStrip(props: { state: State }) {
  const s = props.state
  const ctx = s.ctx
  const ui = ctx.ui
  const t = ctx.t
  const q = s.actions.queries
  const ov = s.overview
  const shown = () => !!ov().branch && !!ov().remote && ov().branch !== ov().defaultBranch && !!s.pulls() && !s.pulls()?.error
  const pr = () => pullFor(s.pulls(), ov().branch)
  const ref = () => {
    const current = pr()
    return current ? parseItemUrl(current.url) : undefined
  }
  // The full pull request, for the count of checks, whether it can merge and the issues it closes; the list only has the
  // rollup.
  const item = latest(
    q.query(() => ({
      ...q.options.item(ref() ?? { repo: "", number: 0 }),
      enabled: !!ref(),
      refetchInterval: (query) => (s.visible() && query.state.data?.pr?.checks.some((check) => check.state === "pending") ? 30_000 : false),
    })),
  )
  const repo = () => repoOf(ov())
  // The issue this branch works on: stored by "Start working", named in the branch, or closed by its pull request.
  const issueNumber = createMemo(() => {
    const branch = ov().branch
    const name = repo()
    if (!branch || !name) return undefined
    const linked = s.actions.linkedIssue(name, branch)
    if (linked) return linked
    const full = item.latest?.number === pr()?.number ? item.latest : undefined
    if (!full) return undefined
    return full.links?.find((link) => link.repo === name)?.number ?? closingRefs(full.body).find((found) => !found.repo || found.repo === name)?.number
  })
  const issueRef = () => {
    const name = repo()
    const number = issueNumber()
    return name && number ? { repo: name, number } : undefined
  }
  const issueQuery = latest(q.query(() => ({ ...q.options.item(issueRef() ?? { repo: "", number: 0 }), enabled: !!issueRef() })))
  const issue = () => {
    const current = issueQuery.latest
    return current && current.kind === "issue" && current.number === issueNumber() && current.repo === repo() ? current : undefined
  }
  // Until it loads the number shows alone; a number that names a pull request or nothing shows nothing.
  const issueShown = () => (issue() || (issueQuery.latest === undefined && !issueQuery.error) ? issueRef() : undefined)
  // A merge closes the issue on GitHub ("Fixes #N"); read it again then.
  createKeyed(
    () => (pr()?.state === "MERGED" && issueRef() ? `${repo()}#${issueNumber()}` : undefined),
    () => {
      const target = issueRef()
      if (target) q.invalidate(q.keys.item(target))
    },
  )
  const checks = () => {
    const list = item.latest?.number === pr()?.number ? item.latest?.pr?.checks.filter((check) => check.state !== "skipped") : undefined
    if (!list) return undefined
    return {
      total: list.length,
      passed: list.filter((check) => check.state === "success").length,
      failed: list.filter((check) => check.state === "failure").length,
      pending: list.filter((check) => check.state === "pending").length,
    }
  }
  const checkState = () => {
    const counts = checks()
    if (!counts) return pr()?.checks ?? "none"
    if (counts.total === 0) return "none"
    if (counts.failed > 0) return "failure"
    if (counts.pending > 0) return "pending"
    return "success"
  }
  const checkText = () => {
    const counts = checks()
    const state = checkState()
    if (state === "failure") return `✕ ${counts ? t("strip.failing", { count: counts.failed }) : t("checks.failure")}`
    if (state === "pending") return `● ${counts ? t("strip.pending", { count: counts.pending }) : t("checks.pending")}`
    return `✓ ${counts ? `${counts.passed}/${counts.total}` : t("checks.success")}`
  }
  const unpushed = () => (ov().upstream ? ov().ahead : (s.outgoing()?.unpushed.length ?? 0))
  const push = () => void s.run("push", () => s.actions.push(s.cwd()))

  const next = (): { label: string; icon: "cloud-upload" | "eye" | "fork" | "branch"; busy: string; run: () => void } | undefined => {
    const current = pr()
    if (!current) return undefined
    // Commits a squash merge left behind count as unpushed; the work is done either way.
    if (current.state === "MERGED" && ov().defaultBranch)
      return {
        label: t("strip.finish", { base: ov().defaultBranch ?? "" }),
        icon: "branch",
        busy: "finish",
        run: () => void s.run("finish", () => s.actions.finishBranch(s.cwd(), ov(), current)),
      }
    if (unpushed() > 0) return { label: t("action.push"), icon: "cloud-upload", busy: "push", run: push }
    if (current.state !== "OPEN") return undefined
    if (current.draft)
      return {
        label: t("edit.ready"),
        icon: "eye",
        busy: "ready",
        run: () =>
          void s.run("ready", async () => {
            const target = ref()
            if (!target) return
            await s.actions.attempt(() => s.actions.git.setDraft({ ...target, draft: false }), t("edit.ready"))
            s.refreshPulls(true)
          }),
      }
    const mergeable = item.latest?.number === current.number && item.latest.pr?.mergeable === "MERGEABLE"
    if (mergeable && checkState() !== "failure" && checkState() !== "pending" && current.review !== "CHANGES_REQUESTED")
      return {
        label: t("action.mergePr"),
        icon: "fork",
        busy: "merge",
        run: () =>
          void s.run("merge", async () => {
            await s.actions.mergePr(s.cwd(), current)
            s.refreshPulls(true)
          }),
      }
    return undefined
  }

  return (
    <Show when={shown()}>
      <div class="ghp-strip">
        <Show when={issueShown()}>
          {(target) => (
            <ItemHover actions={s.actions} item={target()}>
              <button
                type="button"
                class="ghp-strip-issue"
                data-state={issue()?.state}
                onClick={(event) => {
                  const url = issue()?.url
                  if (url && (event.metaKey || event.ctrlKey)) return ctx.system.openExternal(url)
                  s.actions.openItem(target())
                }}
              >
                <IssueIcon state={issue()?.state ?? "OPEN"} />
                <Show
                  when={!(pr()?.state === "MERGED" && issue()?.state === "CLOSED")}
                  fallback={<span>{t("strip.issueClosed", { number: target().number })}</span>}
                >
                  <span class="ghp-strip-issue-number">#{target().number}</span>
                  <Show when={issue()} fallback={issueQuery.loading ? <ui.Loader size="small" /> : null}>
                    {(current) => (
                      <>
                        <span class="ghp-strip-issue-title">{current().title}</span>
                        <Show when={current().state !== "OPEN"}>
                          <span class="ghp-strip-issue-state">{t("strip.closed")}</span>
                        </Show>
                      </>
                    )}
                  </Show>
                </Show>
              </button>
            </ItemHover>
          )}
        </Show>
        <Show
          when={pr()}
          fallback={
            <>
              <Show when={!issueShown()}>
                <span class="ghp-strip-none">{t("strip.noPr")}</span>
              </Show>
              <Show when={s.outgoing()}>
                {(out) => (
                  <span class="ghp-faint">
                    {out().ahead > 0 ? ctx.plural("strip.ahead", out().ahead, { base: out().base ?? "" }) : t("strip.even", { base: out().base ?? "" })}
                  </span>
                )}
              </Show>
            </>
          }
        >
          {(current) => (
            <>
              <PrChip ctx={ctx} pr={current()} onOpen={s.actions.openItem} />
              <Show when={current().state === "OPEN" && checkState() !== "none"}>
                <button
                  type="button"
                  class="ghp-strip-checks ghp-checks"
                  data-checks={checkState()}
                  title={t(`pulls.checks.${checkState()}`)}
                  onClick={() => {
                    const target = ref()
                    if (target) s.actions.openItem(target, "checks")
                  }}
                >
                  {checkText()}
                </button>
              </Show>
              <Show when={current().state === "OPEN" && current().review}>
                {(review) => (
                  <span class="ghp-pill" data-review={review()}>
                    {t(`pulls.review.${review()}`)}
                  </span>
                )}
              </Show>
            </>
          )}
        </Show>
        <div class="ghp-spacer" />
        <Show when={next()}>
          {(action) => (
            <ui.Button size="small" variant="neutral" icon={action().icon} busy={s.busy() === action().busy} disabled={!!s.busy()} onClick={() => action().run()}>
              {action().label}
            </ui.Button>
          )}
        </Show>
        <Show when={!pr() && (s.outgoing()?.ahead ?? 0) > 0}>
          <ui.Button size="small" variant="neutral" icon="github" disabled={!!s.busy()} onClick={() => void s.actions.createPr(s.cwd(), ov())}>
            {t("strip.createPr")}
          </ui.Button>
        </Show>
        <button type="button" class="ghp-strip-link" title={t("page.runs")} onClick={() => s.setPage("runs")}>
          {t("strip.runs")}
        </button>
      </div>
    </Show>
  )
}

/* Changes */

function ChangesView(props: { state: State }) {
  const s = props.state
  const ctx = s.ctx
  const ui = ctx.ui
  const t = ctx.t
  const [message, setMessage] = createSignal("")
  const [expanded, setExpanded] = createSignal<string>()
  // Keeps the entries of unchanged files, so rows (and an open diff) stay mounted when another file changes.
  const files = createMemo<readonly FileChange[]>((previous) => {
    const known = new Map(previous.map((file) => [file.path, file]))
    return s.overview().files.map((file) => {
      const same = known.get(file.path)
      return same && JSON.stringify(same) === JSON.stringify(file) ? same : file
    })
  }, [])
  const conflicts = () => files().filter((file) => file.conflicted)
  const staged = () => files().filter((file) => !file.conflicted && !file.untracked && file.index !== ".")
  const unstaged = () => files().filter((file) => !file.conflicted && (file.untracked || file.worktree !== "."))
  const nothing = () => files().length === 0
  const blocked = () => conflicts().length > 0 || !!s.busy()
  const ready = () => !nothing() && !!message().trim() && !blocked()

  const commit = (options: { amend?: boolean; push?: boolean; all?: boolean }) =>
    s.run("commit", async () => {
      // The last commit is already on the remote: amending it means a force push later.
      const pushed = options.amend && !!s.overview().upstream && s.overview().ahead === 0
      if (
        pushed &&
        !(await ctx.dialogs.confirm({
          title: ctx.t("dialog.amendPushed"),
          description: ctx.t("dialog.amendPushedDescription"),
          confirm: ctx.t("changes.amend"),
          danger: true,
        }))
      )
        return
      const done = await s.actions.commit(s.cwd(), {
        message: message(),
        amend: options.amend ?? false,
        // Amending takes only what is staged, like `git commit --amend`; sweeping in every change would rewrite history.
        all: options.all ?? (!options.amend && staged().length === 0),
        push: options.push ?? false,
      })
      if (done) setMessage("")
    })

  const attachDiff = async (file: FileChange, staged: boolean) => {
    const diff = await s.actions.attempt(() => s.actions.git.diff({ cwd: s.cwd(), path: file.path, staged, untracked: file.untracked }))
    if (!diff?.trim()) return
    s.actions.attach(fileContext(file.path, diff, staged ? "staged in the working tree" : "uncommitted in the working tree"), ctx.t("agent.prompt.diff"))
  }
  const stage = (paths: string[]) => s.run("stage", () => s.actions.attempt(() => s.actions.git.stage({ cwd: s.cwd(), paths })))
  const unstage = (paths: string[]) => s.run("stage", () => s.actions.attempt(() => s.actions.git.unstage({ cwd: s.cwd(), paths })))
  const discard = async (list: FileChange[]) => {
    const ok = await ctx.dialogs.confirm({
      title: t("changes.discardTitle", { target: list.length === 1 ? (list[0]?.path ?? "") : ctx.plural("changes.allFiles", list.length) }),
      description: t("changes.discardDescription"),
      confirm: t("changes.discard"),
      danger: true,
    })
    if (!ok) return
    await s.run("discard", () =>
      s.actions.attempt(() =>
        s.actions.git.discard({
          cwd: s.cwd(),
          tracked: list.filter((file) => !file.untracked).map((file) => file.path),
          untracked: list.filter((file) => file.untracked).map((file) => file.path),
        }),
      ),
    )
  }

  const commitItems = (): UiMenuEntry[] => [
    { label: t("changes.commitPush"), icon: "cloud-upload", disabled: !ready(), onSelect: () => void commit({ push: true }) },
    { label: t("changes.commitAll"), icon: "checklist", disabled: !ready(), onSelect: () => void commit({ all: true }) },
    { label: t("changes.amend"), icon: "edit", disabled: !s.overview().head || blocked(), onSelect: () => void commit({ amend: true }) },
  ]

  return (
    <div class="ghp-changes">
      <div class="ghp-commit-box">
        <textarea
          class="ghp-textarea"
          rows={3}
          aria-label={t("changes.message")}
          placeholder={t("changes.placeholder")}
          value={message()}
          onInput={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              if (ready()) void commit({})
            }
          }}
        />
        <div class="ghp-commit-actions">
          <ui.Button
            class="ghp-grow"
            variant="contrast"
            size="small"
            icon="check"
            busy={s.busy() === "commit"}
            disabled={!ready()}
            onClick={() => void commit({})}
          >
            {staged().length > 0 ? t("changes.commit") : t("changes.commitAll")}
          </ui.Button>
          <ui.Menu label={t("changes.commitOptions")} trigger="icon" icon="chevron-down" placement="bottom-end" items={commitItems()} />
        </div>
      </div>

      <Show when={nothing()}>
        <div class="ghp-empty ghp-empty-inline">
          <ui.Icon name="circle-check" />
          <span>{t("changes.clean")}</span>
        </div>
      </Show>

      <FileSection
        state={s}
        title={t("changes.conflicts")}
        files={conflicts()}
        section="conflict"
        expanded={expanded()}
        onToggle={(key) => setExpanded(expanded() === key ? undefined : key)}
        actions={[
          { icon: "bubble-5", label: t("action.addToChat"), run: (list) => list[0] && void attachDiff(list[0], false), single: true },
          { icon: "check", label: t("changes.stage"), run: (list) => void stage(list.map((file) => file.path)) },
        ]}
      />
      <FileSection
        state={s}
        title={t("changes.staged")}
        files={staged()}
        section="staged"
        expanded={expanded()}
        onToggle={(key) => setExpanded(expanded() === key ? undefined : key)}
        actions={[
          { icon: "bubble-5", label: t("action.addToChat"), run: (list) => list[0] && void attachDiff(list[0], true), single: true },
          { icon: "minus", label: t("changes.unstage"), bulk: t("changes.unstageAll"), run: (list) => void unstage(list.map((file) => file.path)) },
        ]}
      />
      <FileSection
        state={s}
        title={t("changes.unstaged")}
        files={unstaged()}
        section="unstaged"
        expanded={expanded()}
        onToggle={(key) => setExpanded(expanded() === key ? undefined : key)}
        actions={[
          { icon: "bubble-5", label: t("action.addToChat"), run: (list) => list[0] && void attachDiff(list[0], false), single: true },
          { icon: "outline-undo", label: t("changes.discard"), bulk: t("changes.discardAll"), run: (list) => void discard(list) },
          { icon: "plus", label: t("changes.stage"), bulk: t("changes.stageAll"), run: (list) => void stage(list.map((file) => file.path)) },
        ]}
      />
      <UnpushedSection
        state={s}
        onAmend={() => void commit({ amend: true })}
        onUndone={(subject) => {
          if (!message().trim()) setMessage(subject)
        }}
      />
    </div>
  )
}

/** Commits on this branch that no remote has yet: push them, or take back or amend the newest one. */
function UnpushedSection(props: { state: State; onAmend: () => void; onUndone: (subject: string) => void }) {
  const s = props.state
  const ctx = s.ctx
  const ui = ctx.ui
  const t = ctx.t
  const [collapsed, setCollapsed] = createSignal(false)
  const commits = () => s.outgoing()?.unpushed ?? []
  // Only the commit HEAD points at, and not a merge: undoing anything else would rewrite more than the last step.
  const undoable = (commit: Commit) => commit.hash === s.overview().head && commit.parents.length === 1

  const undo = async (commit: Commit) => {
    const ok = await ctx.dialogs.confirm({
      title: t("dialog.undoCommit"),
      description: t("dialog.undoCommitDescription", { subject: commit.subject }),
      confirm: t("changes.undo"),
    })
    if (!ok) return
    await s.run("undo", async () => {
      const done = await s.actions.attempt(() => s.actions.git.undoCommit({ cwd: s.cwd() }), t("toast.undone"))
      if (done !== undefined) props.onUndone(commit.subject)
    })
  }

  return (
    <Show when={commits().length > 0}>
      <section class="ghp-section">
        <div class="ghp-section-header">
          <button type="button" class="ghp-section-toggle" onClick={() => setCollapsed(!collapsed())}>
            <ui.Icon name={collapsed() ? "chevron-right" : "chevron-down"} size="small" />
            <span>{t("changes.unpushed")}</span>
            <span class="ghp-tab-count">{commits().length >= 50 ? "50+" : commits().length}</span>
          </button>
          <div class="ghp-row-actions ghp-row-actions-visible">
            <ui.Tooltip value={s.overview().upstream ? t("action.push") : t("action.publish")}>
              <ui.IconButton
                icon="cloud-upload"
                label={t("action.push")}
                size="small"
                variant="ghost"
                busy={s.busy() === "push"}
                disabled={!!s.busy()}
                onClick={() => void s.run("push", () => s.actions.push(s.cwd()))}
              />
            </ui.Tooltip>
          </div>
        </div>
        <Show when={!collapsed()}>
          <For each={commits()}>
            {(commit) => (
              <div
                class="ghp-file ghp-unpushed"
                role="button"
                tabIndex={0}
                title={`${commit.author} · ${new Date(commit.date * 1000).toLocaleString()}`}
                onClick={() => s.reveal(commit.hash)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return
                  event.preventDefault()
                  s.reveal(commit.hash)
                }}
              >
                <span class="ghp-file-name ghp-unpushed-subject">{commit.subject}</span>
                <span class="ghp-mono ghp-faint">{commit.hash.slice(0, 7)}</span>
                <span class="ghp-faint">{ago(commit.date)}</span>
                <Show when={undoable(commit)}>
                  <div class="ghp-row-actions" onClick={(event) => event.stopPropagation()}>
                    <ui.Tooltip value={t("changes.amendStaged")}>
                      <ui.IconButton icon="edit" label={t("changes.amendStaged")} size="small" variant="ghost" disabled={!!s.busy()} onClick={props.onAmend} />
                    </ui.Tooltip>
                    <ui.Tooltip value={t("changes.undo")}>
                      <ui.IconButton
                        icon="outline-undo"
                        label={t("changes.undo")}
                        size="small"
                        variant="ghost"
                        busy={s.busy() === "undo"}
                        disabled={!!s.busy()}
                        onClick={() => void undo(commit)}
                      />
                    </ui.Tooltip>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </section>
    </Show>
  )
}

interface FileAction {
  readonly icon: "check" | "minus" | "plus" | "outline-undo" | "bubble-5"
  readonly label: string
  readonly bulk?: string
  /** Only for one file at a time; never offered as a section-wide action. */
  readonly single?: boolean
  run(files: FileChange[]): void
}

function FileSection(props: {
  state: State
  title: string
  files: FileChange[]
  section: "staged" | "unstaged" | "conflict"
  expanded: string | undefined
  onToggle: (key: string) => void
  actions: FileAction[]
}) {
  const ui = props.state.ctx.ui
  const [collapsed, setCollapsed] = createSignal(false)
  return (
    <Show when={props.files.length > 0}>
      <section class="ghp-section">
        <div class="ghp-section-header">
          <button type="button" class="ghp-section-toggle" onClick={() => setCollapsed(!collapsed())}>
            <ui.Icon name={collapsed() ? "chevron-right" : "chevron-down"} size="small" />
            <span>{props.title}</span>
            <span class="ghp-tab-count">{props.files.length}</span>
          </button>
          <div class="ghp-row-actions ghp-row-actions-visible">
            <For each={props.actions.filter((action) => action.bulk)}>
              {(action) => (
                <ui.Tooltip value={action.bulk}>
                  <ui.IconButton
                    icon={action.icon}
                    label={action.bulk ?? action.label}
                    size="small"
                    variant="ghost"
                    disabled={!!props.state.busy()}
                    onClick={() => action.run(props.files)}
                  />
                </ui.Tooltip>
              )}
            </For>
          </div>
        </div>
        <Show when={!collapsed()}>
          <For each={props.files}>
            {(file) => {
              const key = () => `${props.section}:${file.path}`
              const letter = () => {
                if (props.section === "conflict") return "!"
                if (props.section === "staged") return file.index
                return file.untracked ? "U" : file.worktree
              }
              // Untracked folders end with a slash; name them by their last segment.
              const trimmed = file.path.replace(/\/$/, "")
              const slash = trimmed.lastIndexOf("/")
              return (
                <>
                  <div
                    class="ghp-file"
                    role="button"
                    tabIndex={0}
                    aria-expanded={props.expanded === key()}
                    data-open={props.expanded === key() ? "" : undefined}
                    onClick={() => props.onToggle(key())}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        props.onToggle(key())
                      }
                    }}
                  >
                    <span class="ghp-status" data-status={letter()}>
                      {letter()}
                    </span>
                    <span class="ghp-file-name">
                      {slash === -1 ? trimmed : trimmed.slice(slash + 1)}
                      {file.path.endsWith("/") ? "/" : ""}
                    </span>
                    <span class="ghp-file-dir">
                      {file.origPath ? `${file.origPath} → ` : ""}
                      {slash === -1 ? "" : trimmed.slice(0, slash)}
                    </span>
                    <div class="ghp-row-actions" onClick={(event) => event.stopPropagation()}>
                      <For each={props.actions}>
                        {(action) => (
                          <ui.Tooltip value={action.label}>
                            <ui.IconButton
                              icon={action.icon}
                              label={action.label}
                              size="small"
                              variant="ghost"
                              disabled={!!props.state.busy()}
                              onClick={() => action.run([file])}
                            />
                          </ui.Tooltip>
                        )}
                      </For>
                    </div>
                  </div>
                  <Show when={props.expanded === key()}>
                    <DiffView state={props.state} file={file} staged={props.section === "staged"} />
                  </Show>
                </>
              )
            }}
          </For>
        </Show>
      </section>
    </Show>
  )
}

function DiffView(props: { state: State; file: FileChange; staged: boolean }) {
  const s = props.state
  const ui = s.ctx.ui
  const q = s.actions.queries
  // Refetched at once when the file's status changes, such as when it is staged.
  createKeyed(
    () => JSON.stringify(s.overview().files.find((file) => file.path === props.file.path) ?? null),
    () => q.invalidate(q.keys.diff(s.cwd(), props.file.path, props.staged, props.file.untracked)),
  )
  // A content edit leaves the file's status as it was, so the open diff also polls while the panel is on screen.
  const diff = latest(
    q.query(() => ({
      ...q.options.diff(s.cwd(), props.file.path, props.staged, props.file.untracked),
      refetchInterval: s.visible() ? 4000 : false,
    })),
  )
  const content = () => {
    const text = diff.latest ?? ""
    return text.length > 200_000 ? `${text.slice(0, 200_000)}\n…` : text
  }
  return (
    <div class="ghp-diff">
      <Show when={diff.latest !== undefined} fallback={diff.error ? <span class="ghp-faint">{errorMessage(diff.error)}</span> : <ui.Loader size="small" />}>
        <Show when={content().trim()} fallback={<span class="ghp-faint">—</span>}>
          <ui.Code content={content()} language="diff" />
        </Show>
      </Show>
    </div>
  )
}

/* Graph */

function GraphView(props: { state: State }) {
  const s = props.state
  const ctx = s.ctx
  const ui = ctx.ui
  const t = ctx.t
  const [limit, setLimit] = createSignal(300)
  const [selected, setSelected] = createSignal(s.takeReveal())
  const scope = () => ctx.stores.prefs.value.graphScope ?? "local"

  const q = s.actions.queries
  const logResult = q.query(() => ({ ...q.options.log(s.cwd(), scope(), limit()), refetchInterval: s.visible() ? 8000 : false }))
  const log = latest(logResult)
  const commits = stable(() => log.latest)
  // Narrowed, so an overview poll that changes other fields keeps the rows (and an open commit) mounted.
  const head = createMemo(() => s.overview().head)
  const dirty = createMemo(() => s.overview().files.length > 0)
  const worktree = createMemo(
    (): Commit => ({ hash: WORKTREE, parents: [head() ?? ""], author: "", email: "", date: Date.now() / 1000, subject: t("graph.worktree"), refs: [] }),
  )
  const nodes = createMemo((): readonly Commit[] => {
    const list = commits() ?? []
    const at = dirty() ? list.findIndex((commit) => commit.hash === head()) : -1
    // Uncommitted work sits right above HEAD, like a commit that is not made yet.
    if (at === -1) return list
    return [...list.slice(0, at), worktree(), ...list.slice(at)]
  })
  const rows = createMemo(() => layout(nodes()))
  // Sized for the rows near the top, which are on screen first; lanes further right are clipped.
  const lanes = () => Math.min(MAX_LANES, Math.max(1, ...rows().slice(0, 60).map((row) => row.width)))

  return (
    <div class="ghp-graph">
      <div class="ghp-toolbar">
        <div class="ghp-segmented" role="group" aria-label={t("graph.scope")}>
          <For each={["local", "current", "all"] as const}>
            {(value) => (
              <button
                type="button"
                data-selected={scope() === value ? "" : undefined}
                onClick={() =>
                  ctx.stores.prefs.update((draft) => {
                    draft.graphScope = value
                  })
                }
              >
                {t(`graph.${value}`)}
              </button>
            )}
          </For>
        </div>
        <div class="ghp-spacer" />
        <Show when={logResult.isPlaceholderData}>
          <ui.Loader size="small" />
        </Show>
      </div>
      <Show
        when={commits()}
        fallback={
          <div class="ghp-empty ghp-empty-inline">
            <Show when={log.error} fallback={<ui.Loader />}>
              {errorMessage(log.error)}
            </Show>
          </div>
        }
      >
        <Show when={nodes().length > 0} fallback={<div class="ghp-empty ghp-empty-inline">{t("graph.empty")}</div>}>
          <div class="ghp-graph-list" style={{ "--ghp-graph-width": `${lanes() * LANE + PAD * 2}px` }}>
            <For each={nodes()}>
              {(commit, index) => (
                <Show when={rows()[index()]}>
                  {(row) => (
                    <>
                      <CommitRow
                        state={s}
                        commit={commit}
                        row={row()}
                        lanes={lanes()}
                        selected={selected() === commit.hash}
                        onSelect={() => {
                          if (commit.hash === WORKTREE) return s.setView("changes")
                          setSelected(selected() === commit.hash ? undefined : commit.hash)
                        }}
                      />
                      <Show when={selected() === commit.hash}>
                        <CommitDetails state={s} commit={commit} row={row()} lanes={lanes()} />
                      </Show>
                    </>
                  )}
                </Show>
              )}
            </For>
            <Show when={(commits()?.length ?? 0) >= limit()}>
              <div class="ghp-more">
                <ui.Button size="small" variant="ghost" onClick={() => setLimit(limit() + 500)}>
                  {t("graph.more")}
                </ui.Button>
              </div>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  )
}

const x = (lane: number) => lane * LANE + LANE / 2 + PAD
const laneColor = (color: number) => `var(--ghp-lane-${color % 8})`

function edgePath(edge: GraphEdge) {
  const [y1, y2] = edge.kind === "pass" ? [0, ROW] : edge.kind === "in" ? [0, ROW / 2] : [ROW / 2, ROW]
  const x1 = x(edge.from)
  const x2 = x(edge.to)
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`
  const ym = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`
}

function GraphCell(props: { row: GraphRow; lanes: number; kind: "commit" | "merge" | "head" | "worktree" }) {
  const width = () => props.lanes * LANE + PAD * 2
  return (
    <svg class="ghp-graph-cell" width={width()} height={ROW} viewBox={`0 0 ${width()} ${ROW}`} aria-hidden="true">
      <For each={props.row.edges.filter((edge) => edge.from < MAX_LANES && edge.to < MAX_LANES)}>
        {(edge) => <path d={edgePath(edge)} stroke={laneColor(edge.color)} />}
      </For>
      <Show when={props.row.col < MAX_LANES}>
        <Switch>
          <Match when={props.kind === "worktree"}>
            <circle class="ghp-node-worktree" cx={x(props.row.col)} cy={ROW / 2} r={4.5} stroke={laneColor(props.row.color)} />
          </Match>
          <Match when={props.kind === "head"}>
            <circle class="ghp-node-head" cx={x(props.row.col)} cy={ROW / 2} r={5.5} stroke={laneColor(props.row.color)} />
            <circle cx={x(props.row.col)} cy={ROW / 2} r={2.5} fill={laneColor(props.row.color)} />
          </Match>
          <Match when={props.kind === "merge"}>
            <circle cx={x(props.row.col)} cy={ROW / 2} r={3} fill={laneColor(props.row.color)} />
          </Match>
          <Match when={props.kind === "commit"}>
            <circle class="ghp-node" cx={x(props.row.col)} cy={ROW / 2} r={4.5} fill={laneColor(props.row.color)} />
          </Match>
        </Switch>
      </Show>
    </svg>
  )
}

function CommitRow(props: { state: State; commit: Commit; row: GraphRow; lanes: number; selected: boolean; onSelect: () => void }) {
  const s = props.state
  const commit = () => props.commit
  const kind = () => {
    if (commit().hash === WORKTREE) return "worktree"
    if (commit().hash === s.overview().head) return "head"
    if (commit().parents.length > 1) return "merge"
    return "commit"
  }
  return (
    <div
      class="ghp-commit"
      role="button"
      tabIndex={0}
      data-selected={props.selected ? "" : undefined}
      aria-expanded={commit().hash === WORKTREE ? undefined : props.selected}
      data-kind={kind()}
      onClick={props.onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          props.onSelect()
        }
      }}
    >
      <GraphCell row={props.row} lanes={props.lanes} kind={kind()} />
      <div class="ghp-commit-main">
        <RefBadges state={s} commit={commit()} color={props.row.color} />
        <span class="ghp-commit-subject">{commit().subject}</span>
      </div>
      <Show when={commit().hash !== WORKTREE}>
        <span class="ghp-commit-meta" title={`${commit().author} · ${new Date(commit().date * 1000).toLocaleString()}`}>
          {initials(commit().author)} · {ago(commit().date)}
        </span>
      </Show>
    </div>
  )
}

interface Badge {
  readonly kind: "local" | "remote" | "tag" | "head"
  readonly name: string
  readonly current?: boolean
  readonly synced?: boolean
  readonly pr?: PullRequest
}

function RefBadges(props: { state: State; commit: Commit; color: number }) {
  const s = props.state
  const ctx = s.ctx
  const ui = ctx.ui
  const badges = createMemo((): Badge[] => {
    const refs = props.commit.refs
    const head = refs.some((ref) => ref.kind === "head")
    const short = (name: string) => name.slice(name.indexOf("/") + 1)
    const locals = refs.filter((ref) => ref.kind === "local").map((ref) => ref.name)
    const remotes = refs.filter((ref) => ref.kind === "remote").map((ref) => ref.name)
    const local = locals
      .map((name): Badge => ({
        kind: "local",
        name,
        current: head && name === s.overview().branch,
        synced: remotes.some((remote) => short(remote) === name),
        pr: pullFor(s.pulls(), name),
      }))
      .sort((a, b) => Number(b.current) - Number(a.current))
    return [
      ...(head && !s.overview().branch ? [{ kind: "head" as const, name: "HEAD" }] : []),
      ...local,
      ...remotes
        .filter((remote) => !locals.includes(short(remote)))
        .map((name): Badge => ({ kind: "remote", name, pr: pullFor(s.pulls(), short(name)) })),
      ...refs.filter((ref) => ref.kind === "tag").map((ref): Badge => ({ kind: "tag", name: ref.name })),
    ]
  })
  return (
    <For each={badges()}>
      {(badge) => (
        <span
          class="ghp-ref"
          data-kind={badge.kind}
          data-current={badge.current ? "" : undefined}
          style={{ "--ghp-ref-color": laneColor(props.color) }}
          title={badge.name}
        >
          <Show when={badge.current}>
            <ui.Icon name="check-small" size="small" />
          </Show>
          <span class="ghp-ellipsis">{badge.name}</span>
          <Show when={badge.synced}>
            <span class="ghp-ref-synced" title="Up to date with remote">
              ☁
            </span>
          </Show>
          <Show when={badge.pr}>
            {(pr) => (
              <button
                type="button"
                class="ghp-ref-pr"
                data-state={pr().draft && pr().state === "OPEN" ? "DRAFT" : pr().state}
                title={`#${pr().number} ${pr().title}`}
                onClick={(event) => {
                  event.stopPropagation()
                  const ref = parseItemUrl(pr().url)
                  if (ref && !event.metaKey && !event.ctrlKey) return s.actions.openItem(ref)
                  ctx.system.openExternal(pr().url)
                }}
              >
                #{pr().number}
              </button>
            )}
          </Show>
        </span>
      )}
    </For>
  )
}

function CommitDetails(props: { state: State; commit: Commit; row: GraphRow; lanes: number }) {
  const s = props.state
  const ctx = s.ctx
  const ui = ctx.ui
  const t = ctx.t
  const info = latest(s.actions.queries.query(() => s.actions.queries.options.show(s.cwd(), props.commit.hash)))
  const short = () => props.commit.hash.slice(0, 7)
  const branchesHere = () =>
    props.commit.refs.filter((ref) => ref.kind === "local" && ref.name !== s.overview().branch).map((ref) => ref.name)
  const width = () => props.lanes * LANE + PAD * 2

  return (
    <div class="ghp-details" ref={(element) => onMount(() => element.scrollIntoView({ block: "nearest" }))}>
      <svg class="ghp-details-lanes" width={width()} height="100%" aria-hidden="true">
        <For each={props.row.below.filter((item) => item.lane < MAX_LANES)}>
          {(item) => <line x1={x(item.lane)} x2={x(item.lane)} y1="0" y2="100%" stroke={laneColor(item.color)} />}
        </For>
      </svg>
      <div class="ghp-details-body">
        <div class="ghp-details-head">
          <button type="button" class="ghp-hash" title={t("action.copyHash")} onClick={() => void s.actions.copy(props.commit.hash)}>
            <ui.Icon name="copy" size="small" />
            {short()}
          </button>
          <span class="ghp-faint ghp-ellipsis">
            {props.commit.author} · {new Date(props.commit.date * 1000).toLocaleString()}
          </span>
        </div>
        <Show when={info.latest} fallback={info.error ? <span class="ghp-faint">{errorMessage(info.error)}</span> : <ui.Loader size="small" />}>
          {(details) => (
            <>
              <Show when={details().body.split("\n").slice(1).join("\n").trim()}>
                {(rest) => <pre class="ghp-details-message">{rest()}</pre>}
              </Show>
              <div class="ghp-faint ghp-details-count">{ctx.plural("graph.files", details().files.length)}</div>
              <div class="ghp-details-files">
                <For each={details().files.slice(0, 50)}>
                  {(file) => (
                    <div class="ghp-details-file">
                      <span class="ghp-status" data-status={file.status}>
                        {file.status}
                      </span>
                      <span class="ghp-ellipsis">{file.path}</span>
                    </div>
                  )}
                </For>
              </div>
            </>
          )}
        </Show>
        <div class="ghp-details-actions">
          <For each={branchesHere()}>
            {(name) => (
              <ui.Button
                size="small"
                variant="neutral"
                icon="branch"
                busy={s.busy() === "checkout"}
                disabled={!!s.busy()}
                onClick={() => void s.run("checkout", () => s.actions.checkout(s.cwd(), name, name))}
              >
                {`${t("action.checkout")} ${name}`}
              </ui.Button>
            )}
          </For>
          <ui.Button
            size="small"
            variant="ghost"
            icon="branch-out"
            disabled={!!s.busy()}
            onClick={() => void s.run("branch", () => s.actions.newBranch(s.cwd(), { ref: props.commit.hash, label: short() }))}
          >
            {t("action.branchFrom")}
          </ui.Button>
          <ui.Menu
            label={t("action.more")}
            trigger="icon"
            icon="outline-dots"
            items={[
              {
                label: `${t("action.checkout")} ${short()}`,
                icon: "enter",
                disabled: !!s.busy(),
                onSelect: () => void s.run("checkout", () => s.actions.checkout(s.cwd(), props.commit.hash, short())),
              },
              {
                label: t("action.cherryPick"),
                icon: "fork",
                disabled: !!s.busy(),
                onSelect: () =>
                  void s.run("cherry", () => s.actions.attempt(() => s.actions.git.cherryPick({ cwd: s.cwd(), hash: props.commit.hash }))),
              },
              {
                label: t("action.revert"),
                icon: "outline-undo",
                disabled: !!s.busy(),
                onSelect: () =>
                  void s.run("revert", () => s.actions.attempt(() => s.actions.git.revert({ cwd: s.cwd(), hash: props.commit.hash }))),
              },
              { type: "separator" },
              {
                label: t("action.addToChat"),
                icon: "bubble-5",
                onSelect: () =>
                  s.actions.attach(
                    {
                      label: short(),
                      subject: `the commit ${props.commit.hash} in this repository`,
                      text: [
                        `commit ${props.commit.hash}`,
                        `Author: ${props.commit.author} <${props.commit.email}>`,
                        `Date: ${new Date(props.commit.date * 1000).toISOString()}`,
                        "",
                        info.latest?.body ?? props.commit.subject,
                        "",
                        ...(info.latest?.files ?? []).map((file) => `${file.status} ${file.path}`),
                      ].join("\n"),
                    },
                    t("agent.prompt.commit", { sha: short() }),
                  ),
              },
              { label: t("action.copyHash"), icon: "copy", onSelect: () => void s.actions.copy(props.commit.hash) },
              {
                label: t("action.openOnGitHub"),
                icon: "github",
                disabled: !s.overview().remote,
                onSelect: () => {
                  const remote = s.overview().remote
                  if (remote) ctx.system.openExternal(`${remote.web}/commit/${props.commit.hash}`)
                },
              },
            ]}
          />
        </div>
      </div>
    </div>
  )
}

/* Pull requests and issues */

function PullsView(props: { state: State }) {
  return (
    <div class="ghp-pulls">
      <SearchList state={props.state} kind="pr" />
    </div>
  )
}

function IssuesView(props: { state: State }) {
  return (
    <div class="ghp-pulls">
      <SearchList state={props.state} kind="issue" />
    </div>
  )
}

export function PrChip(props: { ctx: Context; pr: PullRequest; compact?: boolean; onOpen: (ref: { repo: string; number: number }) => void }) {
  const state = () => (props.pr.draft && props.pr.state === "OPEN" ? "DRAFT" : props.pr.state)
  return (
    <button
      type="button"
      class="ghp-pr-chip"
      data-state={state()}
      title={props.pr.title}
      onClick={(event) => {
        event.stopPropagation()
        const ref = parseItemUrl(props.pr.url)
        if (ref && !event.metaKey && !event.ctrlKey) return props.onOpen(ref)
        props.ctx.system.openExternal(props.pr.url)
      }}
    >
      <PrIcon state={state()} />
      <span>#{props.pr.number}</span>
      <Show when={!props.compact}>
        <span class="ghp-pr-chip-state">{props.ctx.t(state() === "DRAFT" ? "pulls.draft" : `pulls.state.${props.pr.state}`)}</span>
      </Show>
    </button>
  )
}

/** GitHub's pull request glyphs, drawn inline since the app's icon catalog has none. */
export function PrIcon(props: { state: string }): JSX.Element {
  return (
    <svg class="ghp-pr-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <Switch>
        <Match when={props.state === "MERGED"}>
          <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z" />
        </Match>
        <Match when={props.state === "CLOSED"}>
          <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
        </Match>
        <Match when={props.state === "DRAFT"}>
          <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z" />
        </Match>
        <Match when={true}>
          <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
        </Match>
      </Switch>
    </svg>
  )
}

export function ago(seconds: number) {
  const diff = Math.max(0, Date.now() / 1000 - seconds)
  if (diff < 60) return "now"
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h`
  if (diff < 86_400 * 30) return `${Math.floor(diff / 86_400)}d`
  if (diff < 86_400 * 365) return `${Math.floor(diff / (86_400 * 30))}mo`
  return `${Math.floor(diff / (86_400 * 365))}y`
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
}
