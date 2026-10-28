import { Show } from "solid-js"
import { Command, ComposerPill, MenuItem, Panel, Slot, Style, usePlugin, type MountedSession, type PanelTab, type Plugin } from "@opencode/plugin/gui"
import { createActions, errorMessage, pullFor, repoOf, type Actions } from "./actions"
import { createAgentPill } from "./activity"
import { openBranchPicker } from "./branches"
import { CommitView } from "./commit"
import { RunView } from "./run"
import { parseTab, type TabTarget } from "./tabs"
import type { definition } from "./definition"
import { parseItemUrl } from "./git"
import { IssueIcon, ItemView } from "./item"
import { RunStatus } from "./pr"
import { GitPanel, PrChip, PrIcon } from "./panel"
import { latest } from "./queries"
import { createRefs } from "./refs"
import { createSelectionQuote } from "./selection"
import css from "./panel.css?inline"
import itemCss from "./item.css?inline"
import searchCss from "./search.css?inline"
import activityCss from "./activity.css?inline"
import triageCss from "./triage.css?inline"

export const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const actions = createActions(ctx)
  const key = `${ctx.id}:main`

  ctx.add(Style, [css, searchCss, itemCss, activityCss, triageCss].join("\n"))
  ctx.add(ComposerPill, createAgentPill(ctx, actions))

  const tab: PanelTab = {
    id: "main",
    get title() {
      return ctx.t("title")
    },
    closable: "compact",
    fallback: true,
  }

  // Issue, pull request, CI run and commit tabs; the host keeps their ids, so they come back after a reload.
  const sideTabs = new Map<string, PanelTab>()
  const sideTab = (id: string, target: TabTarget) => {
    const known = sideTabs.get(id)
    if (known) return known
    const created: PanelTab = {
      id,
      title:
        target.kind === "item"
          ? `${target.ref.repo}#${target.ref.number}`
          : target.kind === "run"
            ? `${target.repo} run ${target.id}`
            : `${target.repo}@${target.sha.slice(0, 7)}`,
      closable: "hover",
      label: () => <SideTabLabel target={target} actions={actions} />,
    }
    sideTabs.set(id, created)
    return created
  }

  ctx.add(Panel, {
    id: "main",
    region: "side",
    wide: true,
    mobile: {
      get title() {
        return ctx.t("title")
      },
      order: 46,
      kind: "menu",
      icon: "github",
    },
    list: (input) => [
      ...(input.open.includes("main") ? [tab] : []),
      ...input.open.flatMap((id) => {
        const target = parseTab(id)
        return target ? [sideTab(id, target)] : []
      }),
    ],
    render: (props) => {
      const target = parseTab(props.tab.id)
      if (!target) return <GitPanel session={props.session} actions={actions} />
      if (target.kind === "run") return <RunView repo={target.repo} id={target.id} actions={actions} />
      if (target.kind === "commit") return <CommitView repo={target.repo} sha={target.sha} actions={actions} />
      return <ItemView item={target.ref} session={props.session} actions={actions} />
    },
  })

  const refs = createRefs(ctx, actions)
  const quote = createSelectionQuote(ctx, actions)
  ctx.add(Slot, {
    at: "window.bottom",
    render: () => (
      <>
        <refs.HoverLayer />
        <quote.SelectionLayer />
      </>
    ),
  })

  const open = () => {
    const session = ctx.sessions.current()
    if (session) ctx.layout.open(key, session, { tab: "select" })
  }

  ctx.add(MenuItem, (): MenuItem => {
    const session = ctx.sessions.current()
    return {
      menu: "session.panel",
      id: "open",
      title: ctx.t("menu.open"),
      description: ctx.t("menu.description"),
      icon: "github",
      order: 40,
      keybind: `${ctx.id}.open`,
      opened: !!session && ctx.layout.state(key, session) !== "closed",
      run: open,
    }
  })

  // Every palette command acts on the routed session's directory.
  const withCwd = (work: (cwd: string) => unknown) => () => {
    const session = ctx.sessions.current()
    if (!session) {
      ctx.toast.show({ variant: "error", title: ctx.t("toast.noRepo") })
      return
    }
    void Promise.resolve()
      .then(() => work(session.directory))
      .catch((error: unknown) =>
        ctx.toast.show({ variant: "error", title: ctx.t("toast.error"), description: errorMessage(error), duration: 10_000 }),
      )
  }

  ctx.add(
    Command,
    (): Command => ({
      id: "open",
      title: ctx.t("command.open"),
      group: ctx.t("command.group"),
      keywords: "git github graph branches pull request commit gitlens",
      bind: "mod+shift+g",
      slash: { name: "git" },
      enabled: !!ctx.sessions.current(),
      run: () => {
        const session = ctx.sessions.current()
        if (session) ctx.layout.toggle(key, session)
      },
    }),
  )

  const commands: { id: string; title: string; keywords: string; run: (cwd: string) => unknown }[] = [
    { id: "fetch", title: "command.fetch", keywords: "git fetch remote", run: (cwd) => actions.fetch(cwd) },
    { id: "pull", title: "command.pull", keywords: "git pull", run: (cwd) => actions.pull(cwd) },
    { id: "push", title: "command.push", keywords: "git push publish", run: (cwd) => actions.push(cwd) },
    { id: "commit", title: "command.commit", keywords: "git commit", run: (cwd) => commit(ctx, actions, cwd) },
    { id: "new-branch", title: "command.newBranch", keywords: "git branch create new", run: (cwd) => actions.newBranch(cwd) },
    { id: "switch-branch", title: "command.switchBranch", keywords: "git checkout switch branch", run: (cwd) => openBranchPicker(ctx, actions, cwd) },
    { id: "create-pr", title: "command.createPr", keywords: "github pull request pr create", run: (cwd) => actions.createPr(cwd) },
    { id: "open-pr", title: "command.openPr", keywords: "github pull request pr open browser", run: (cwd) => actions.openPr(cwd) },
    { id: "new-issue", title: "command.newIssue", keywords: "github issue create new", run: (cwd) => actions.createIssue(cwd) },
    {
      id: "open-item",
      title: "command.openItem",
      keywords: "github issue pull request pr open number",
      run: async (cwd) => {
        const input = await ctx.dialogs.prompt({ title: ctx.t("command.openItem"), placeholder: "#123, owner/repo#123 or a GitHub URL" })
        if (!input) return
        const url = parseItemUrl(input.trim())
        if (url) return actions.openItem(url)
        // A repository needs its `#`, or `owner/repo123` would read as `owner/repo12#3`.
        const match = /^(?:([\w.-]+\/[\w.-]+)#|#?)(\d+)$/.exec(input.trim())
        if (!match?.[2]) return
        const repo = match[1] ?? (await actions.git.overview({ cwd }).then(repoOf, () => undefined))
        if (!repo) return ctx.toast.show({ variant: "error", title: ctx.t("toast.noRepo") })
        actions.openItem({ repo, number: Number(match[2]) })
      },
    },
    {
      id: "open-repo",
      title: "command.openRepo",
      keywords: "github repository browser",
      run: async (cwd) => {
        const overview = await actions.git.overview({ cwd }).catch(() => null)
        if (!overview?.remote) return ctx.toast.show({ variant: "error", title: ctx.t("toast.noRepo") })
        ctx.system.openExternal(overview.remote.web)
      },
    },
  ]
  commands.forEach((item) =>
    ctx.add(
      Command,
      (): Command => ({
        id: item.id,
        title: ctx.t(item.title),
        group: ctx.t("command.group"),
        keywords: item.keywords,
        enabled: !!ctx.sessions.current() && ctx.app.platform === "desktop",
        run: withCwd(item.run),
      }),
    ),
  )

  ctx.add(
    Command,
    (): Command => ({
      id: "header-chip",
      title: ctx.t("command.headerChip"),
      group: ctx.t("command.group"),
      run: () =>
        ctx.stores.prefs.update((draft) => {
          draft.headerChip = !draft.headerChip
        }),
    }),
  )

  ctx.add(Slot, (): Slot | undefined =>
    ctx.stores.prefs.value.headerChip && ctx.app.platform === "desktop"
      ? {
          at: "session.header",
          order: 30,
          render: (input) => (
            <Show when={input.active}>
              <HeaderChip session={input.session} actions={actions} onOpen={open} />
            </Show>
          ),
        }
      : undefined,
  )
}

async function commit(ctx: Parameters<Plugin.Setup<typeof definition>>[0], actions: Actions, cwd: string) {
  const message = await ctx.dialogs.prompt({
    title: ctx.t("dialog.commit"),
    placeholder: ctx.t("changes.message"),
    submit: ctx.t("changes.commit"),
  })
  if (!message) return
  // Without the status, "nothing staged" cannot be told apart from "unknown", which would commit every change.
  const overview = await actions.attempt(() => actions.git.overview({ cwd }))
  if (overview === undefined) return
  if (!overview) return ctx.toast.show({ variant: "error", title: ctx.t("toast.noRepo") })
  const staged = overview.files.some((file) => !file.untracked && !file.conflicted && file.index !== ".")
  await actions.commit(cwd, { message, amend: false, all: !staged, push: false })
}

/** The branch and its pull request in the session's title row; a click opens the panel. */
function HeaderChip(props: { session: MountedSession; actions: Actions; onOpen: () => void }) {
  const ctx = usePlugin<typeof definition>()
  const ui = ctx.ui
  const git = props.actions.git
  const q = props.actions.queries
  const overview = latest(q.query(() => ({ ...q.options.overview(props.session.directory), refetchInterval: 15_000 })))
  const pulls = latest(q.query(() => ({ ...q.options.pulls(overview.latest?.root ?? props.session.directory), enabled: !!overview.latest?.remote })))
  const pr = () => pullFor(pulls.latest, overview.latest?.branch)

  return (
    <Show when={overview.latest}>
      {(current) => (
        <div class="ghp-header-chip">
          <button type="button" class="ghp-header-chip-branch" title={ctx.t("command.open")} onClick={props.onOpen}>
            <ui.Icon name="branch" size="small" />
            <span class="ghp-ellipsis">{current().branch ?? current().head?.slice(0, 7) ?? ""}</span>
            <Show when={current().files.length > 0}>
              <span class="ghp-header-chip-dirty" title={ctx.plural("changes.allFiles", current().files.length)}>
                ●
              </span>
            </Show>
          </button>
          <Show when={pr()}>{(item) => <PrChip ctx={ctx} pr={item()} compact onOpen={props.actions.openItem} />}</Show>
        </div>
      )}
    </Show>
  )
}

/** A side tab's trigger: an item's state icon and number, a run's status, or a commit's hash. */
function SideTabLabel(props: { target: TabTarget; actions: Actions }) {
  const target = props.target
  if (target.kind === "commit") return <span class="ghp-tab-label" data-state="CLOSED">⎔ {target.sha.slice(0, 7)}</span>
  if (target.kind === "run") return <RunTabLabel repo={target.repo} id={target.id} actions={props.actions} />
  const q = props.actions.queries
  const item = latest(q.query(() => q.options.item(target.ref)))
  const state = () => {
    const current = item.latest
    if (!current) return "OPEN"
    return current.draft && current.state === "OPEN" ? "DRAFT" : current.state
  }
  return (
    <span class="ghp-tab-label" data-state={state()} data-kind={item.latest?.kind}>
      <Show when={item.latest?.kind === "issue"} fallback={<PrIcon state={state()} />}>
        <IssueIcon state={item.latest?.state ?? "OPEN"} />
      </Show>
      #{target.ref.number}
    </span>
  )
}

function RunTabLabel(props: { repo: string; id: number; actions: Actions }) {
  const q = props.actions.queries
  const run = latest(q.query(() => q.options.run(props.repo, props.id)))
  return (
    <span class="ghp-tab-label" data-state="CLOSED">
      <RunStatus status={run.latest?.run.status ?? "queued"} conclusion={run.latest?.run.conclusion ?? ""} />
      {run.latest?.run.workflow ?? "CI"}
    </span>
  )
}
