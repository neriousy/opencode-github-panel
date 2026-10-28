import { createMemo, createSignal, For, Show } from "solid-js"
import { createKeyed, type Context, type DialogHandle, type UiMenuEntry } from "@opencode/plugin/gui"
import { errorMessage, folderOf, pullFor, type Actions } from "./actions"
import { cleanupCandidates, type CleanupCandidate, type CleanupReason } from "./cleanup"
import type { Branch } from "./contract"
import { ago, PrChip } from "./panel"
import { latest } from "./queries"

const RECENT = 5
const REMOTE_LIMIT = 200

/** Opens the branch picker for the repository at `cwd`: search, switch, and every branch action. */
export function openBranchPicker(ctx: Context, actions: Actions, cwd: string) {
  ctx.dialogs.open((dialog) => <BranchPicker ctx={ctx} actions={actions} cwd={cwd} dialog={dialog} />)
}

interface Row {
  readonly section: "current" | "recent" | "pulls" | "local" | "remote"
  readonly branch: Branch
}

function BranchPicker(props: { ctx: Context; actions: Actions; cwd: string; dialog: DialogHandle }) {
  const ctx = props.ctx
  const ui = ctx.ui
  const t = ctx.t
  const q = props.actions.queries
  const [filter, setFilter] = createSignal("")
  const [showRemote, setShowRemote] = createSignal(false)
  const [active, setActive] = createSignal(0)
  const [busy, setBusy] = createSignal<string>()
  const branchData = createBranchData(props.actions, () => props.cwd)
  const overview = branchData.overview
  const root = branchData.root
  const prFor = branchData.prFor
  const all = () => branchData.branches() ?? []
  const locals = createMemo(() => all().filter((branch) => !branch.remote))

  const rows = createMemo((): Row[] => {
    const query = filter().trim().toLowerCase()
    const matches = (branch: Branch) => {
      if (!query) return true
      const pr = prFor(shortName(branch))
      return branch.name.toLowerCase().includes(query) || (!!pr && `#${pr.number}`.startsWith(query))
    }
    const names = new Set(locals().map((branch) => branch.name))
    const current = locals().filter((branch) => branch.current)
    const others = locals().filter((branch) => !branch.current)
    const recent = others.slice(0, RECENT)
    const rest = others.slice(RECENT)
    const pulls = rest.filter((branch) => prFor(branch.name)?.state === "OPEN")
    const local = rest.filter((branch) => prFor(branch.name)?.state !== "OPEN")
    // A remote branch with a local copy is listed once, as the local branch.
    const remote = all().filter((branch) => branch.remote && !names.has(shortName(branch)))
    const section = (name: Row["section"], list: readonly Branch[]) => list.filter(matches).map((branch): Row => ({ section: name, branch }))
    return [
      ...section("current", current),
      ...section("recent", recent),
      ...section("pulls", pulls),
      ...section("local", local),
      ...(showRemote() || query ? section("remote", remote).slice(0, REMOTE_LIMIT) : []),
    ]
  })
  const remoteCount = () => all().filter((branch) => branch.remote).length
  // Enter goes to the first branch that is not the current one, like `git switch -`.
  const reset = () => setActive(Math.max(0, rows().findIndex((row) => !row.branch.current)))
  createKeyed(() => !!branchData.branches(), reset)

  const run = async (id: string, work: () => Promise<unknown>, close = false) => {
    if (busy()) return
    setBusy(id)
    const done = await work()
    setBusy(undefined)
    if (close && done !== undefined) props.dialog.close()
  }
  const checkout = (branch: Branch) => {
    if (branch.current) return
    // Checked out in another worktree: git refuses to check it out here, so its folder opens instead.
    const worktree = branch.worktree
    if (worktree) {
      props.dialog.close()
      void props.actions.openDirectory(worktree, branch.name)
      return
    }
    void run(
      "checkout",
      () =>
        props.actions.checkoutBranch(
          root(),
          branch,
          locals().map((item) => item.name),
        ),
      true,
    )
  }
  const move = (by: number) => {
    const count = rows().length
    if (count === 0) return
    const next = (active() + by + count) % count
    setActive(next)
    document.querySelector(`[data-ghp-pick-index="${next}"]`)?.scrollIntoView({ block: "nearest" })
  }

  const items = (branch: Branch): UiMenuEntry[] => {
    const current = overview()?.branch
    const remote = overview()?.remote
    const pr = prFor(shortName(branch))
    const disabled = !!busy()
    return [
      branch.worktree
        ? { label: t("picker.openWorktree"), icon: "new-session", onSelect: () => checkout(branch) }
        : { label: t("action.checkout"), icon: "enter", disabled: branch.current || disabled, onSelect: () => checkout(branch) },
      {
        label: t("action.branchFrom"),
        icon: "branch-out",
        disabled,
        onSelect: () => void run("branch", () => props.actions.newBranch(root(), { ref: branch.name, label: branch.name }), true),
      },
      { type: "separator" },
      {
        label: t("action.mergeInto") + (current ? ` (${current})` : ""),
        icon: "fork",
        disabled: branch.current || !current || disabled,
        onSelect: () => void run("merge", () => props.actions.attempt(() => props.actions.git.merge({ cwd: root(), ref: branch.name }))),
      },
      {
        label: t("action.rebaseOnto"),
        icon: "split",
        disabled: branch.current || !current || disabled,
        onSelect: () => void run("rebase", () => props.actions.attempt(() => props.actions.git.rebase({ cwd: root(), ref: branch.name }))),
      },
      ...(branch.remote
        ? []
        : [
            {
              label: t("action.pushBranch"),
              icon: "cloud-upload" as const,
              disabled,
              onSelect: () =>
                void run("push", () =>
                  props.actions.progress(t("action.push"), () => props.actions.git.pushBranch({ cwd: root(), name: branch.name }), t("toast.pushed")),
                ),
            },
          ]),
      { type: "separator" },
      pr
        ? {
            label: `${t("action.openPr")} #${pr.number}`,
            icon: "github",
            onSelect: () => {
              props.dialog.close()
              ctx.system.openExternal(pr.url)
            },
          }
        : {
            label: t("action.createPr"),
            icon: "github",
            disabled: !branch.current || !remote,
            onSelect: () => {
              props.dialog.close()
              void props.actions.createPr(root(), overview())
            },
          },
      {
        label: t("action.openOnGitHub"),
        icon: "square-arrow-top-right",
        disabled: !remote,
        onSelect: () => {
          if (remote) ctx.system.openExternal(`${remote.web}/tree/${shortName(branch).split("/").map(encodeURIComponent).join("/")}`)
        },
      },
      { label: t("action.copyName"), icon: "copy", onSelect: () => void props.actions.copy(shortName(branch)) },
      { type: "separator" },
      branch.remote
        ? {
            label: t("action.deleteRemote"),
            icon: "outline-trash",
            disabled,
            onSelect: () => void run("delete", () => props.actions.deleteRemoteBranch(root(), branch.name)),
          }
        : {
            label: t(branch.worktree ? "picker.deleteInWorktree" : "action.delete"),
            icon: "outline-trash",
            disabled: branch.current || !!branch.worktree || disabled,
            onSelect: () => void run("delete", () => props.actions.deleteBranch(root(), branch.name)),
          },
    ]
  }

  return (
    <ui.Dialog title={t("picker.title")} description={overview()?.remote ? `${overview()?.remote?.owner}/${overview()?.remote?.repo}` : overview()?.name} size="large">
      <div class="ghp-picker">
        <div
          class="ghp-picker-search"
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
            event.preventDefault()
            move(event.key === "ArrowDown" ? 1 : -1)
          }}
        >
          <ui.TextInput
            class="ghp-grow"
            label={t("branches.search")}
            placeholder={t("branches.search")}
            type="search"
            autofocus
            value={filter()}
            onInput={(value) => {
              setFilter(value)
              reset()
            }}
            onSubmit={() => {
              const row = rows()[active()]
              if (row) checkout(row.branch)
            }}
          />
          <ui.Button size="small" variant="ghost" icon="plus" disabled={!!busy()} onClick={() => void run("branch", () => props.actions.newBranch(root()), true)}>
            {t("action.newBranchShort")}
          </ui.Button>
          <ui.Button
            size="small"
            variant="ghost"
            icon="outline-trash"
            disabled={!!busy() || !branchData.branches()}
            onClick={() => openCleanup(ctx, props.actions, root())}
          >
            {t("cleanup.open")}
          </ui.Button>
        </div>
        <Show
          when={branchData.branches()}
          fallback={
            <div class="ghp-empty ghp-empty-inline">
              <Show when={branchData.error()} fallback={<ui.Loader />}>
                {errorMessage(branchData.error())}
              </Show>
            </div>
          }
        >
          <div class="ghp-picker-list" role="listbox" aria-label={t("picker.title")}>
            <For each={rows()} fallback={<div class="ghp-faint ghp-pad">{t("branches.empty")}</div>}>
              {(row, index) => (
                <>
                  <Show when={rows()[index() - 1]?.section !== row.section}>
                    <div class="ghp-picker-heading">{t(`picker.section.${row.section}`)}</div>
                  </Show>
                  <PickerRow
                    ctx={ctx}
                    branch={row.branch}
                    index={index()}
                    active={active() === index()}
                    busy={!!busy()}
                    pr={prFor(shortName(row.branch))}
                    items={items(row.branch)}
                    onActive={() => setActive(index())}
                    onCheckout={() => checkout(row.branch)}
                    onOpenPr={(ref) => {
                      props.dialog.close()
                      props.actions.openItem(ref)
                    }}
                  />
                </>
              )}
            </For>
            <Show when={!filter().trim() && remoteCount() > 0}>
              <button type="button" class="ghp-picker-more" onClick={() => setShowRemote(!showRemote())}>
                <ctx.ui.Icon name={showRemote() ? "chevron-down" : "chevron-right"} size="small" />
                {showRemote() ? t("picker.hideRemote") : t("picker.showRemote", { count: remoteCount() })}
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </ui.Dialog>
  )
}

function PickerRow(props: {
  ctx: Context
  branch: Branch
  index: number
  active: boolean
  busy: boolean
  pr: ReturnType<typeof pullFor>
  items: UiMenuEntry[]
  onActive: () => void
  onCheckout: () => void
  onOpenPr: (ref: { repo: string; number: number }) => void
}) {
  const ui = props.ctx.ui
  const t = props.ctx.t
  return (
    <div
      class="ghp-pick-branch"
      role="option"
      aria-selected={props.active}
      data-active={props.active ? "" : undefined}
      data-current={props.branch.current ? "" : undefined}
      data-ghp-pick-index={props.index}
      title={props.branch.subject}
      onMouseMove={() => !props.active && props.onActive()}
      onClick={props.onCheckout}
    >
      <ui.Icon name={props.branch.current ? "check-small" : "branch"} size="small" class="ghp-pick-icon" />
      <span class="ghp-pick-name ghp-ellipsis">{props.branch.name}</span>
      <Show when={props.branch.ahead > 0}>
        <span class="ghp-track" title={t("action.push")}>
          ↑{props.branch.ahead}
        </span>
      </Show>
      <Show when={props.branch.behind > 0}>
        <span class="ghp-track" title={t("action.pull")}>
          ↓{props.branch.behind}
        </span>
      </Show>
      <Show when={props.branch.gone}>
        <span class="ghp-pill">{t("branches.gone")}</span>
      </Show>
      <Show when={props.branch.worktree}>
        {(directory) => (
          <ui.Tooltip value={t("picker.worktreeTitle", { directory: directory() })}>
            <span class="ghp-pill ghp-pick-worktree">
              <ui.Icon name="folder" size="small" />
              {folderOf(directory())}
            </span>
          </ui.Tooltip>
        )}
      </Show>
      <Show when={props.pr}>{(pr) => <PrChip ctx={props.ctx} pr={pr()} onOpen={props.onOpenPr} />}</Show>
      <span class="ghp-pick-subject ghp-ellipsis">{props.branch.subject}</span>
      <span class="ghp-pick-age">{ago(props.branch.date)}</span>
      <div class="ghp-row-actions" onClick={(event) => event.stopPropagation()}>
        <Show when={!props.branch.current}>
          <ui.Tooltip value={t(props.branch.worktree ? "picker.openWorktree" : "action.checkout")}>
            <ui.IconButton
              icon={props.branch.worktree ? "new-session" : "enter"}
              label={t(props.branch.worktree ? "picker.openWorktree" : "action.checkout")}
              size="small"
              variant="ghost"
              disabled={props.busy}
              onClick={props.onCheckout}
            />
          </ui.Tooltip>
        </Show>
        <ui.Menu label={t("action.more")} trigger="icon" icon="outline-dots" placement="bottom-end" items={props.items} />
      </div>
    </div>
  )
}

/** The repository's branches with the pull request of each: one lookup for every local branch, cached per branch. */
function createBranchData(actions: Actions, cwd: () => string) {
  const q = actions.queries
  const overview = latest(q.query(() => q.options.overview(cwd())))
  const root = () => overview.latest?.root ?? cwd()
  const branches = latest(q.query(() => ({ ...q.options.branches(root()), enabled: !!overview.latest })))
  const remote = () => !!overview.latest?.remote
  const pulls = latest(q.query(() => ({ ...q.options.pulls(root()), enabled: remote() })))
  const names = createMemo(
    () => (branches.latest ?? []).filter((branch) => !branch.remote).map((branch) => branch.name),
    [],
    { equals: (a, b) => a.join("\n") === b.join("\n") },
  )
  const branchPulls = latest(q.query(() => ({ ...q.options.branchPulls(root(), names()), enabled: remote() && names().length > 0 })))
  const prFor = (name: string) => pullFor(branchPulls.latest, name) ?? pullFor(pulls.latest, name)
  return {
    overview: () => overview.latest,
    root,
    branches: () => branches.latest,
    error: () => branches.error ?? overview.error,
    prFor,
    /** Pull requests are known for every branch, or cannot be: no GitHub remote, or the lookup failed. */
    prsSettled: () => !remote() || names().length === 0 || branchPulls.latest !== undefined || branchPulls.error !== undefined,
  }
}

function shortName(branch: Pick<Branch, "name" | "remote">) {
  return branch.remote ? branch.name.slice(branch.name.indexOf("/") + 1) : branch.name
}

/* Clean up */

function openCleanup(ctx: Context, actions: Actions, cwd: string) {
  ctx.dialogs.open((dialog) => <Cleanup ctx={ctx} actions={actions} cwd={cwd} dialog={dialog} />)
}

function Cleanup(props: { ctx: Context; actions: Actions; cwd: string; dialog: DialogHandle }) {
  const ctx = props.ctx
  const ui = ctx.ui
  const t = ctx.t
  const q = props.actions.queries
  const data = createBranchData(props.actions, () => props.cwd)
  const merged = latest(q.query(() => q.options.merged(data.root())))
  const [overrides, setOverrides] = createSignal<Record<string, boolean>>({})
  const [busy, setBusy] = createSignal(false)
  const ready = () => !!data.branches() && merged.latest !== undefined && data.prsSettled()
  const candidates = createMemo(() =>
    ready()
      ? cleanupCandidates({
          branches: data.branches() ?? [],
          current: data.overview()?.branch ?? null,
          base: data.overview()?.defaultBranch ?? null,
          merged: merged.latest ?? [],
          pullFor: data.prFor,
        })
      : [],
  )
  const checked = (candidate: CleanupCandidate) => overrides()[candidate.name] ?? candidate.risk === null
  const chosen = () => candidates().filter(checked)

  const reason = (item: CleanupReason) => {
    if (item.kind === "gone") return t("cleanup.reason.gone")
    if (item.kind === "merged") return t("cleanup.reason.merged", { base: item.base })
    return t(`cleanup.reason.${item.kind}`, { number: item.number })
  }

  const remove = async () => {
    const names = chosen().map((candidate) => candidate.name)
    if (names.length === 0 || busy()) return
    setBusy(true)
    // Squash-merged branches are not merged as far as git can tell; the reasons listed are why forcing is safe.
    const results = await props.actions.attempt(() => props.actions.git.deleteBranches({ cwd: data.root(), names, force: true }))
    setBusy(false)
    if (!results) return
    props.dialog.close()
    const failed = results.filter((result) => result.error)
    const deleted = ctx.plural("cleanup.deleted", results.length - failed.length)
    if (failed.length === 0) return ctx.toast.show({ variant: "success", title: deleted })
    ctx.toast.show({
      variant: "error",
      title: `${deleted} · ${ctx.plural("cleanup.failed", failed.length)}`,
      description: failed.map((result) => `${result.name}: ${result.error?.split("\n")[0] ?? ""}`).join("\n"),
      duration: 15_000,
    })
  }

  return (
    <ui.Dialog
      title={t("cleanup.title")}
      description={t("cleanup.description")}
      size="large"
      footer={
        <div class="ghp-dialog-footer">
          <ui.Button variant="ghost" onClick={() => props.dialog.close()}>
            {t("cancel")}
          </ui.Button>
          <ui.Button variant="danger" icon="outline-trash" busy={busy()} disabled={chosen().length === 0} onClick={() => void remove()}>
            {ctx.plural("cleanup.delete", chosen().length)}
          </ui.Button>
        </div>
      }
    >
      <Show
        when={ready()}
        fallback={
          <div class="ghp-empty ghp-empty-inline">
            <Show when={merged.error ?? data.error()} fallback={<ui.Loader />}>
              {(error) => errorMessage(error())}
            </Show>
          </div>
        }
      >
        <div class="ghp-cleanup" role="group" aria-label={t("cleanup.title")}>
          <For each={candidates()} fallback={<div class="ghp-empty ghp-empty-inline">{t("cleanup.none")}</div>}>
            {(candidate) => (
              <label class="ghp-cleanup-row" data-risk={candidate.risk ?? undefined}>
                <input
                  type="checkbox"
                  checked={checked(candidate)}
                  onChange={(event) => {
                    const value = event.currentTarget.checked
                    setOverrides((previous) => ({ ...previous, [candidate.name]: value }))
                  }}
                />
                <span class="ghp-cleanup-name ghp-ellipsis">{candidate.name}</span>
                <span class="ghp-cleanup-reasons ghp-ellipsis">{candidate.reasons.map(reason).join(" · ")}</span>
                <Show when={candidate.risk}>{(risk) => <span class="ghp-cleanup-risk">{t(`cleanup.risk.${risk()}`)}</span>}</Show>
              </label>
            )}
          </For>
        </div>
      </Show>
    </ui.Dialog>
  )
}
