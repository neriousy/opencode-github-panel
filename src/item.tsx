import { createMemo, createSignal, For, Match, onCleanup, Show, Switch, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { AgentBanner } from "./activity"
import { createDraft, DraftBanner } from "./drafting"
import { createEditor } from "./edit"
import { createFolds } from "./fold"
import { Conversation, PrChecks, PrFiles } from "./pr"
import { createKeyed, usePlugin, type Context, type MountedSession, type UiMenuEntry } from "@opencode/plugin/gui"
import { latest } from "./queries"
import { errorMessage, repoOf, type Actions } from "./actions"
import { parseItemUrl, pullFor } from "./git"
import type { Check, Item, ItemRef, Label } from "./contract"
import type { definition } from "./definition"
import { ago, PrIcon } from "./panel"

/** A side tab showing one issue or pull request, with its conversation and actions. */
export function ItemView(props: { item: ItemRef; session: MountedSession; actions: Actions }) {
  const ctx = usePlugin<typeof definition>()
  const ui = ctx.ui
  const t = ctx.t
  const git = props.actions.git
  const editor = createEditor(ctx, props.actions)
  const [comment, setComment] = createSignal("")
  const [busy, setBusy] = createSignal<string>()
  const [section, setSection] = createSignal<"conversation" | "files" | "checks">(
    (props.actions.takeFocus({ kind: "item", ref: props.item }) as "files" | "checks" | undefined) ?? "conversation",
  )

  const smart = () => ctx.stores.prefs.value.foldItems ?? true
  const folds = { conversation: createFolds(smart), files: createFolds(), checks: createFolds() }

  const q = props.actions.queries
  const data = latest(q.query(() => q.options.item(props.item)))
  const reviews = latest(q.query(() => ({ ...q.options.reviews(props.item), enabled: data.latest?.kind === "pr" })))
  const overview = latest(q.query(() => q.options.overview(props.session.directory)))
  const local = () => repoOf(overview.latest) === props.item.repo
  const refresh = () => q.invalidate(q.keys.item(props.item))
  const draft = createDraft({ ref: props.item, item: () => data.latest, session: props.session, actions: props.actions })
  // Loads the Files section while the user reads the conversation, so switching to it is instant.
  createKeyed(
    () => data.latest?.pr?.sha,
    (head) => q.prefetch(q.options.files(props.item, head)),
  )

  const run = async (id: string, work: () => Promise<unknown>) => {
    if (busy()) return
    setBusy(id)
    try {
      await work()
    } finally {
      setBusy(undefined)
    }
  }

  const send = (item: Item, event?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT") =>
    run("comment", async () => {
      const typed = comment()
      const body = typed.trim()
      if (!body && event !== "APPROVE") return
      const done = await props.actions.attempt(
        () =>
          event
            ? git.submitReview({ repo: item.repo, number: item.number, event, body })
            : git.comment({ repo: item.repo, number: item.number, kind: item.kind, body }),
        event ? t(`review.sent.${event}`) : undefined,
      )
      // Keeps whatever was typed while the comment was sending.
      if (done !== undefined && comment() === typed) setComment("")
    })

  const edits = (item: Item): UiMenuEntry[] => [
    { label: t("edit.textMenu"), icon: "edit", onSelect: () => void editor.text(item) },
    { label: t("edit.labels"), icon: "bullet-list", onSelect: () => void editor.labels(item) },
    { label: t("edit.assignees"), icon: "status", onSelect: () => void editor.people(item, "assignees") },
    ...(item.kind === "pr"
      ? [{ label: t("edit.reviewers"), icon: "review" as const, onSelect: () => void editor.people(item, "reviewers") }]
      : []),
    { label: t("edit.milestone"), icon: "flask", onSelect: () => void editor.milestone(item) },
    ...(item.kind === "pr" && item.state === "OPEN"
      ? [{ label: item.draft ? t("edit.ready") : t("edit.toDraft"), icon: "check" as const, disabled: !!busy(), onSelect: () => void run("draft", () => editor.draft(item)) }]
      : []),
  ]

  const more = (item: Item): UiMenuEntry[] => [
    { label: t("action.openOnGitHub"), icon: "square-arrow-top-right", onSelect: () => ctx.system.openExternal(item.url) },
    { label: t("action.copyLink"), icon: "link", onSelect: () => void props.actions.copy(item.url) },
    { label: t("action.refresh"), icon: "refresh", onSelect: refresh },
    { type: "separator" },
    {
      label: t("view.foldPref"),
      icon: smart() ? "check" : undefined,
      onSelect: () =>
        ctx.stores.prefs.update((draft) => {
          draft.foldItems = !(draft.foldItems ?? true)
        }),
    },
    { type: "separator" },
    ...(item.state === "OPEN"
      ? props.actions.closeMenu(item, (work) => void run("state", work))
      : [{
          label: t("action.reopen"),
          icon: "outline-undo" as const,
          disabled: item.state === "MERGED",
          onSelect: () => void run("state", () => props.actions.setItemState(item, true)),
        }]),
  ]

  return (
    <div class="ghp ghp-item" data-repo={props.item.repo} data-ghp-source={`the GitHub item ${props.item.repo}#${props.item.number}`} data-ghp-label={`#${props.item.number}`}>
      <Show
        when={data.latest}
        fallback={
          <div class="ghp-empty">
            <Show when={data.error} fallback={<ui.Loader />}>
              <ui.Icon name="circle-exclamation" />
            </Show>
            <span>{data.error ? errorMessage(data.error) : t("item.loading")}</span>
            <Show when={data.error}>
              <ui.Button size="small" variant="neutral" icon="refresh" onClick={refresh}>
                {t("action.retry")}
              </ui.Button>
            </Show>
          </div>
        }
      >
        {(current) => (
          <div class="ghp-item-scroll">
            <AgentBanner item={props.item} session={props.session} actions={props.actions} />
            <DraftBanner draft={draft} onOpen={() => setSection("files")} />
            <header class="ghp-item-header">
              <div class="ghp-item-top">
                <StateChip ctx={ctx} item={current()} />
                <span class="ghp-faint ghp-ellipsis">
                  {current().repo}#{current().number}
                </span>
                <div class="ghp-spacer" />
                <Show when={data.loading}>
                  <ui.Loader size="small" />
                </Show>
                <ui.Menu
                  label={t("agent.menu")}
                  trigger="icon"
                  icon="bubble-5"
                  placement="bottom-end"
                  items={props.actions.agentMenu(props.item, current().kind)}
                />
                <ui.Menu label={t("edit.menu")} trigger="icon" icon="edit" placement="bottom-end" items={edits(current())} />
                <ui.Menu label={t("action.more")} trigger="icon" icon="outline-dots" placement="bottom-end" items={more(current())} />
              </div>
              <h2 class="ghp-item-title">{current().title}</h2>
              <div class="ghp-item-meta">
                <span>
                  <b>{current().author}</b> {t("item.opened", { ago: ago(Date.parse(current().created) / 1000) })}
                </span>
                <span>· {ctx.plural("item.comments", current().comments.length)}</span>
              </div>
              <div class="ghp-item-labels">
                <For each={current().labels}>{(label) => <LabelPill label={label} />}</For>
                <For each={current().assignees}>{(login) => <span class="ghp-pill">@{login}</span>}</For>
                <Show when={current().milestone}>{(milestone) => <span class="ghp-pill">◇ {milestone()}</span>}</Show>
                <Show when={(current().pr?.requested.length ?? 0) > 0}>
                  <span class="ghp-pill">
                    {t("item.reviewers")}: {current().pr?.requested.join(", ")}
                  </span>
                </Show>
              </div>
              <Show when={current().pr}>
                {(pr) => (
                  <>
                    <div class="ghp-item-branches">
                      <ui.Icon name="branch" size="small" />
                      <code>{pr().head}</code>
                      <span class="ghp-faint">→</span>
                      <code>{pr().base}</code>
                      <Show when={pr().cross}>
                        <span class="ghp-pill">{t("item.fork")}</span>
                      </Show>
                    </div>
                    <div class="ghp-item-stats">
                      <span class="ghp-add">+{pr().additions}</span>
                      <span class="ghp-del">−{pr().deletions}</span>
                      <span class="ghp-faint">{ctx.plural("item.files", pr().files)}</span>
                      <Show when={current().state === "OPEN"}>
                        <span class="ghp-pill" data-mergeable={pr().mergeable}>
                          {t(`item.mergeable.${pr().mergeable}`)}
                        </span>
                      </Show>
                      <Show when={pr().review}>
                        {(review) => (
                          <span class="ghp-pill" data-review={review()}>
                            {t(`pulls.review.${review()}`)}
                          </span>
                        )}
                      </Show>
                      <Show when={pr().checks.length > 0}>
                        <button type="button" class="ghp-item-checks-toggle" onClick={() => setSection("checks")}>
                          <ChecksSummary checks={pr().checks} />
                        </button>
                      </Show>
                    </div>
                    <Show when={current().state === "OPEN"}>
                      <div class="ghp-item-actions">
                        <ui.Button
                          size="small"
                          variant="neutral"
                          icon="enter"
                          busy={busy() === "checkout"}
                          disabled={!local() || !!busy()}
                          onClick={() =>
                            void run("checkout", () =>
                              props.actions.progress(
                                t("action.checkoutPr"),
                                () => git.checkoutPr({ cwd: overview.latest?.root ?? props.session.directory, number: current().number, repo: current().repo }),
                                t("toast.switched", { name: pr().head }),
                              ),
                            )
                          }
                        >
                          {t("action.checkoutPr")}
                        </ui.Button>
                        <Show when={current().draft && current().state === "OPEN"}>
                          <ui.Button
                            size="small"
                            variant="neutral"
                            icon="check"
                            busy={busy() === "draft"}
                            disabled={!!busy()}
                            onClick={() => void run("draft", () => editor.draft(current()))}
                          >
                            {t("edit.ready")}
                          </ui.Button>
                        </Show>
                        <ui.Button
                          size="small"
                          variant="contrast"
                          icon="fork"
                          busy={busy() === "merge"}
                          disabled={current().draft || !!busy()}
                          onClick={() =>
                            void run("merge", () =>
                              props.actions.mergePr(
                                props.session.directory,
                                { number: current().number, title: current().title, head: pr().head },
                                current().repo,
                              ),
                            )
                          }
                        >
                          {t("action.mergePr")}
                        </ui.Button>
                      </div>
                    </Show>
                  </>
                )}
              </Show>
              <Show when={current().kind === "issue"}>
                <LinkedWork
                  item={current()}
                  cwd={local() ? (overview.latest?.root ?? props.session.directory) : undefined}
                  current={overview.latest?.branch ?? null}
                  actions={props.actions}
                  busy={busy()}
                  onSwitch={(name) => void run("checkout", () => props.actions.checkout(overview.latest?.root ?? props.session.directory, name, name))}
                />
              </Show>
              <Show when={current().kind === "issue" && current().state === "OPEN" && local()}>
                <div class="ghp-item-actions">
                  <ui.Button
                    size="small"
                    variant="contrast"
                    icon="branch-out"
                    busy={busy() === "branch"}
                    disabled={!!busy()}
                    onClick={() => void run("branch", () => props.actions.startIssue(props.session.directory, current()))}
                  >
                    {t("action.startIssue")}
                  </ui.Button>
                </div>
              </Show>
            </header>

            <Show when={current().pr}>
              {(pr) => (
                <div class="ghp-tabs ghp-item-tabs" role="tablist">
                  <For each={["conversation", "files", "checks"] as const}>
                    {(id) => (
                      <button
                        type="button"
                        role="tab"
                        class="ghp-tab"
                        aria-selected={section() === id}
                        data-selected={section() === id ? "" : undefined}
                        onClick={() => setSection(id)}
                      >
                        {t(`item.section.${id}`)}
                        <Show when={id === "files"}>
                          <span class="ghp-tab-count">{pr().files}</span>
                        </Show>
                        <Show when={id === "files" && draft.draft()}>
                          {(current) => (
                            <span class="ghp-tab-count ghp-draft-count" title={t("draft.title")}>
                              ✎ {current().comments.length}
                            </span>
                          )}
                        </Show>
                        <Show when={id === "checks" && pr().checks.length > 0}>
                          <span class="ghp-tab-count">{pr().checks.length}</span>
                        </Show>
                        <Show when={id === "conversation" && (reviews.latest?.threads.filter((thread) => !thread.resolved).length ?? 0) > 0}>
                          <span class="ghp-tab-count">💬 {reviews.latest?.threads.filter((thread) => !thread.resolved).length}</span>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </Show>

            <Switch>
              <Match when={current().kind === "pr" && section() === "files"}>
                <PrFiles item={current()} reviews={reviews.latest} actions={props.actions} folds={folds.files} threads={folds.conversation} draft={draft} />
              </Match>
              <Match when={current().kind === "pr" && section() === "checks"}>
                <PrChecks item={current()} actions={props.actions} folds={folds.checks} />
              </Match>
              <Match when={true}>
                <Conversation item={current()} reviews={reviews.latest} actions={props.actions} folds={folds.conversation} draft={draft} onOpenDraft={() => setSection("files")} />

                <div class="ghp-item-reply">
                  <textarea
                    class="ghp-textarea"
                    rows={3}
                    placeholder={t("item.commentPlaceholder")}
                    aria-label={t("item.commentPlaceholder")}
                    value={comment()}
                    onInput={(event) => setComment(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault()
                        void send(current())
                      }
                    }}
                  />
                  <div class="ghp-item-actions">
                    <Show when={current().state === "OPEN"} fallback={
                      <Show when={current().state === "CLOSED"}>
                        <ui.Button
                          size="small"
                          variant="ghost"
                          disabled={!!busy()}
                          onClick={() =>
                            void run("state", async () => {
                              const typed = comment()
                              const done = await props.actions.setItemState(current(), true, { comment: typed.trim() })
                              if (done !== undefined && comment() === typed) setComment("")
                            })
                          }
                        >
                          {comment().trim() ? t("close.reopenWithComment") : t("action.reopen")}
                        </ui.Button>
                      </Show>
                    }>
                      <ui.Menu
                        label={comment().trim() ? t("close.withComment") : t(current().kind === "pr" ? "close.pr" : "close.issue")}
                        trigger="button"
                        icon="circle-x"
                        placement="top-start"
                        disabled={!!busy()}
                        items={props.actions.closeMenu(
                          current(),
                          (work) =>
                            void run("state", async () => {
                              const typed = comment()
                              const done = await work()
                              if (done !== undefined && comment() === typed) setComment("")
                            }),
                          comment,
                        )}
                      />
                    </Show>
                    <div class="ghp-spacer" />
                    <Show when={current().kind === "pr" && current().state === "OPEN"}>
                      <ui.Menu
                        label={t("review.submit")}
                        trigger="button"
                        icon="review"
                        placement="top-end"
                        disabled={!!busy()}
                        items={[
                          { label: t("review.approve"), icon: "circle-check", disabled: reviews.latest?.mine !== false, onSelect: () => void send(current(), "APPROVE") },
                          {
                            label: t("review.requestChanges"),
                            icon: "circle-exclamation",
                            disabled: reviews.latest?.mine !== false || !comment().trim(),
                            onSelect: () => void send(current(), "REQUEST_CHANGES"),
                          },
                          { label: t("review.comment"), icon: "comment", disabled: !comment().trim(), onSelect: () => void send(current(), "COMMENT") },
                        ]}
                      />
                    </Show>
                    <ui.Button
                      size="small"
                      variant="contrast"
                      busy={busy() === "comment"}
                      disabled={!comment().trim() || !!busy()}
                      onClick={() => void send(current())}
                    >
                      {t("item.comment")}
                    </ui.Button>
                  </div>
                  <Show when={current().kind === "pr" && reviews.latest?.mine}>
                    <div class="ghp-faint ghp-hint">{t("review.ownPr")}</div>
                  </Show>
                </div>
              </Match>
            </Switch>
          </div>
        )}
      </Show>
    </div>
  )
}

/**
 * The work on an issue in one row: local branches started for it or named after it, and the pull requests that close
 * it (from GitHub, or opened from those branches). Nothing when there is none.
 */
function LinkedWork(props: {
  item: Item
  /** The session's repository root, when it is the issue's repository: only then are its branches this issue's. */
  cwd: string | undefined
  current: string | null
  actions: Actions
  busy: string | undefined
  onSwitch: (name: string) => void
}) {
  const ctx = usePlugin<typeof definition>()
  const ui = ctx.ui
  const t = ctx.t
  const q = props.actions.queries
  const branches = latest(q.query(() => ({ ...q.options.branches(props.cwd ?? ""), enabled: !!props.cwd })))
  const own = () => (branches.latest ?? []).filter((branch) => !branch.remote && props.actions.linkedIssue(props.item.repo, branch.name) === props.item.number)
  const linked = createMemo(
    () => own().map((branch) => branch.name),
    [],
    { equals: (a, b) => a.join("\n") === b.join("\n") },
  )
  // A branch checked out in another worktree cannot be switched to here; its session opens there instead.
  const worktreeOf = (name: string) => own().find((branch) => branch.name === name)?.worktree
  const pulls = latest(q.query(() => ({ ...q.options.branchPulls(props.cwd ?? "", linked()), enabled: !!props.cwd && linked().length > 0 })))
  const prs = () => {
    const opened = linked().flatMap((name) => {
      const pr = pullFor(pulls.latest, name)
      const ref = pr ? parseItemUrl(pr.url) : undefined
      return ref ? [ref] : []
    })
    return [...(props.item.links ?? []), ...opened].filter(
      (ref, index, all) => all.findIndex((other) => other.repo === ref.repo && other.number === ref.number) === index,
    )
  }
  return (
    <Show when={linked().length > 0 || prs().length > 0}>
      <div class="ghp-item-linked">
        <span class="ghp-faint">{t("linked.label")}</span>
        <For each={linked()}>
          {(name) => (
            <span class="ghp-item-linked-branch" title={t("linked.branch")}>
              <ui.Icon name="branch" size="small" />
              <code class="ghp-ellipsis">{name}</code>
              <Show
                when={name !== props.current}
                fallback={<span class="ghp-faint">{t("linked.current")}</span>}
              >
                <Show
                  when={worktreeOf(name)}
                  fallback={
                    <button type="button" class="ghp-item-linked-action" disabled={!!props.busy} onClick={() => props.onSwitch(name)}>
                      {t("linked.switch")}
                    </button>
                  }
                >
                  {(directory) => (
                    <button
                      type="button"
                      class="ghp-item-linked-action"
                      title={t("linked.worktreeTitle", { directory: directory() })}
                      onClick={() => void props.actions.openDirectory(directory(), name)}
                    >
                      {t("linked.worktree")}
                    </button>
                  )}
                </Show>
              </Show>
            </span>
          )}
        </For>
        <For each={prs()}>{(ref) => <LinkedPull actions={props.actions} item={ref} />}</For>
      </div>
    </Show>
  )
}

/** A pull request linked to an issue: its number, state and checks; a click opens it. */
function LinkedPull(props: { actions: Actions; item: ItemRef }) {
  const ctx = usePlugin()
  const q = props.actions.queries
  const pr = latest(q.query(() => q.options.item(props.item)))
  const state = () => {
    const current = pr.latest
    if (!current) return "OPEN"
    return current.draft && current.state === "OPEN" ? "DRAFT" : current.state
  }
  const checks = () => {
    const list = pr.latest?.pr?.checks.filter((check) => check.state !== "skipped") ?? []
    if (list.length === 0 || pr.latest?.state !== "OPEN") return undefined
    if (list.some((check) => check.state === "failure")) return "failure"
    if (list.some((check) => check.state === "pending")) return "pending"
    return "success"
  }
  return (
    <ItemHover actions={props.actions} item={props.item}>
      <button
        type="button"
        class="ghp-pr-chip ghp-item-linked-pr"
        data-state={state()}
        title={ctx.t("linked.openPr")}
        onClick={(event) => {
          const url = pr.latest?.url
          if (url && (event.metaKey || event.ctrlKey)) return ctx.system.openExternal(url)
          props.actions.openItem(props.item)
        }}
      >
        <PrIcon state={state()} />
        <span>#{props.item.number}</span>
        <Show when={pr.latest}>
          <span class="ghp-pr-chip-state">{ctx.t(state() === "DRAFT" ? "pulls.draft" : `pulls.state.${state()}`)}</span>
        </Show>
        <Show when={checks()}>{(value) => <span class="ghp-check-dot" data-state={value()} title={ctx.t(`pulls.checks.${value()}`)} />}</Show>
      </button>
    </ItemHover>
  )
}

/** Shows an issue's or pull request's hover card while the pointer rests on the children, as timeline mentions do. */
export function ItemHover(props: { actions: Actions; item: ItemRef; children: JSX.Element }) {
  const [rect, setRect] = createSignal<DOMRect>()
  const timers: { show?: ReturnType<typeof setTimeout>; hide?: ReturnType<typeof setTimeout> } = {}
  const show = (element: Element) => {
    clearTimeout(timers.hide)
    clearTimeout(timers.show)
    timers.show = setTimeout(() => setRect(element.getBoundingClientRect()), 400)
  }
  const hide = (delay = 200) => {
    clearTimeout(timers.show)
    clearTimeout(timers.hide)
    timers.hide = setTimeout(() => setRect(undefined), delay)
  }
  onCleanup(() => {
    clearTimeout(timers.show)
    clearTimeout(timers.hide)
  })
  return (
    <span class="ghp-hover" onMouseEnter={(event) => show(event.currentTarget)} onMouseLeave={() => hide()} onClick={() => hide(0)}>
      {props.children}
      <Show when={rect()}>
        {(box) => (
          <Portal>
            <HoverCard
              actions={props.actions}
              item={props.item}
              rect={box()}
              onEnter={() => clearTimeout(timers.hide)}
              onLeave={() => hide()}
              onOpen={() => {
                hide(0)
                props.actions.openItem(props.item)
              }}
            />
          </Portal>
        )}
      </Show>
    </span>
  )
}

function HoverCard(props: { actions: Actions; item: ItemRef; rect: DOMRect; onEnter: () => void; onLeave: () => void; onOpen: () => void }) {
  const ctx = usePlugin()
  const q = props.actions.queries
  const item = latest(q.query(() => q.options.item(props.item)))
  const width = 340
  const left = () => Math.max(8, Math.min(props.rect.x, window.innerWidth - width - 8))
  const below = () => props.rect.y + props.rect.height + 6
  const above = () => below() + 220 > window.innerHeight
  return (
    <div
      class="ghp-card"
      role="button"
      tabIndex={-1}
      style={{
        left: `${left()}px`,
        width: `${width}px`,
        ...(above() ? { bottom: `${window.innerHeight - props.rect.y + 6}px` } : { top: `${below()}px` }),
      }}
      onMouseEnter={props.onEnter}
      onMouseLeave={props.onLeave}
      onClick={(event) => {
        const current = item.latest
        if ((event.metaKey || event.ctrlKey) && current) return ctx.system.openExternal(current.url)
        props.onOpen()
      }}
    >
      <Show
        when={item.latest}
        fallback={
          <div class="ghp-card-loading">
            <Show when={item.error} fallback={<ctx.ui.Loader size="small" />}>
              <ctx.ui.Icon name="circle-exclamation" size="small" />
            </Show>
            <span class="ghp-faint">
              {props.item.repo}#{props.item.number}
            </span>
          </div>
        }
      >
        {(current) => <ItemCard ctx={ctx} item={current()} />}
      </Show>
    </div>
  )
}

/** The hover card for a mention in the timeline. */
export function ItemCard(props: { ctx: Context; item: Item }) {
  const t = props.ctx.t
  const pr = () => props.item.pr
  const excerpt = () => {
    const text = props.item.body
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/[#*_`>]/g, "")
      .replace(/\s+/g, " ")
      .trim()
    return text.length > 220 ? `${text.slice(0, 220)}…` : text
  }
  return (
    <div class="ghp-card-body">
      <div class="ghp-item-top">
        <StateChip ctx={props.ctx} item={props.item} />
        <span class="ghp-faint ghp-ellipsis">
          {props.item.repo}#{props.item.number}
        </span>
      </div>
      <div class="ghp-card-title">{props.item.title}</div>
      <div class="ghp-item-meta">
        <span>
          <b>{props.item.author}</b> {t("item.opened", { ago: ago(Date.parse(props.item.created) / 1000) })}
        </span>
        <span>· {props.ctx.plural("item.comments", props.item.comments.length)}</span>
      </div>
      <Show when={pr()}>
        {(info) => (
          <div class="ghp-item-stats">
            <code class="ghp-ellipsis">{info().head}</code>
            <span class="ghp-add">+{info().additions}</span>
            <span class="ghp-del">−{info().deletions}</span>
            <Show when={info().checks.length > 0}>
              <ChecksSummary checks={info().checks} />
            </Show>
          </div>
        )}
      </Show>
      <Show when={props.item.labels.length > 0}>
        <div class="ghp-item-labels">
          <For each={props.item.labels.slice(0, 5)}>{(label) => <LabelPill label={label} />}</For>
        </div>
      </Show>
      <Show when={excerpt()}>
        <p class="ghp-card-excerpt">{excerpt()}</p>
      </Show>
      <div class="ghp-card-hint">{t("item.hint")}</div>
    </div>
  )
}

export function StateChip(props: { ctx: Context; item: Pick<Item, "kind" | "state" | "draft" | "reason"> }) {
  const state = () => (props.item.draft && props.item.state === "OPEN" ? "DRAFT" : props.item.state)
  const reason = () => (props.item.kind === "issue" && props.item.state === "CLOSED" ? props.item.reason : undefined)
  const label = () => {
    if (state() === "DRAFT") return props.ctx.t("pulls.draft")
    const why = reason()
    if (why) return props.ctx.t(`state.closed.${why}`)
    return props.ctx.t(`pulls.state.${props.item.state}`)
  }
  return (
    <span class="ghp-state" data-state={state()} data-kind={props.item.kind} data-reason={reason()}>
      <Switch>
        <Match when={props.item.kind === "pr"}>
          <PrIcon state={state()} />
        </Match>
        <Match when={props.item.kind === "issue"}>
          <IssueIcon state={props.item.state} reason={reason()} />
        </Match>
      </Switch>
      {label()}
    </span>
  )
}

/** GitHub's issue icons: open, closed as completed (a check), closed otherwise (a slash: not planned or duplicate). */
export function IssueIcon(props: { state: string; reason?: string }): JSX.Element {
  const skipped = () => props.state === "CLOSED" && !!props.reason && props.reason !== "completed"
  return (
    <svg class="ghp-pr-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <Show
        when={props.state === "OPEN"}
        fallback={
          <Show
            when={skipped()}
            fallback={
              <path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5ZM16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z" />
            }
          >
            <path d="M10.78 6.28a.75.75 0 0 0-1.06-1.06l-4.5 4.5a.75.75 0 1 0 1.06 1.06ZM16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z" />
          </Show>
        }
      >
        <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
        <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
      </Show>
    </svg>
  )
}

export function LabelPill(props: { label: Label }) {
  return (
    <span class="ghp-label" style={{ "--ghp-label": `#${props.label.color}` }}>
      {props.label.name}
    </span>
  )
}

function ChecksSummary(props: { checks: readonly Check[] }) {
  const ctx = usePlugin()
  const count = (state: Check["state"]) => props.checks.filter((check) => check.state === state).length
  const overall = () => (count("failure") > 0 ? "failure" : count("pending") > 0 ? "pending" : "success")
  return (
    <span class="ghp-checks-summary" data-state={overall()}>
      <span class="ghp-check-dot" data-state={overall()} />
      {ctx.t(`pulls.checks.${overall()}`)}
      <span class="ghp-faint">
        {count("success")}✓ {count("failure") > 0 ? `${count("failure")}✕ ` : ""}
        {count("pending") > 0 ? `${count("pending")}● ` : ""}
      </span>
    </span>
  )
}
