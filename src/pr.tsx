import { createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { usePlugin, type UiMenuEntry } from "@opencode/plugin/gui"
import { latest } from "./queries"
import { errorMessage, type Actions } from "./actions"
import type { Check, Item, Review, Reviews, Run, Thread } from "./contract"
import { fileContext, threadContext } from "./context"
import { DiffList } from "./diff"
import { DraftBar, DraftEntry, DraftNote, type Draft } from "./drafting"
import { Chevron, Clamp, firstLine, Group, type Folds } from "./fold"
import { parseGitHubLink, parsePatch } from "./git"
import { ago } from "./panel"

type Entry =
  | { readonly kind: "comment"; readonly id: string; readonly at: string; readonly author: string; readonly body: string }
  | { readonly kind: "review"; readonly id: string; readonly at: string; readonly review: Review }
  | { readonly kind: "thread"; readonly id: string; readonly at: string; readonly thread: Thread }

/** Past this many entries, a conversation shows its first and its latest few until asked for the rest. */
const LONG = 12
const RECENT = 5
/** Replies of a review thread shown before the older ones fold away. */
const REPLIES = 3
// Accounts GitHub reports without the `[bot]` suffix, or whose reports are long and rarely read in full.
const BOTS = new Set([
  "github-actions",
  "coderabbitai",
  "codecov",
  "codecov-commenter",
  "vercel",
  "changeset-bot",
  "netlify",
  "dependabot",
  "renovate",
  "sonarcloud",
  "copilot-pull-request-reviewer",
])
const REVIEW_ICON = { APPROVED: "circle-check", CHANGES_REQUESTED: "circle-exclamation", DISMISSED: "circle-x" } as const

export function isBot(login: string) {
  const name = login.toLowerCase()
  return name.endsWith("[bot]") || BOTS.has(name)
}

/** The description, then comments, reviews and review threads in the order they happened. */
export function Conversation(props: { item: Item; reviews: Reviews | undefined; actions: Actions; folds: Folds; draft?: Draft; onOpenDraft?: () => void }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  // Query results keep unchanged objects across refetches; reusing their entries keeps <For> from remounting every
  // thread whenever the item or its reviews refetch.
  const known = new WeakMap<object, Entry>()
  const entry = (source: object, make: () => Entry) => {
    const found = known.get(source)
    if (found) return found
    const created = make()
    known.set(source, created)
    return created
  }
  const entries = createMemo((): Entry[] => {
    const comments = props.item.comments.map((comment) =>
      entry(comment, () => ({ kind: "comment", id: `c:${comment.author}:${comment.created}`, at: comment.created, author: comment.author, body: comment.body })),
    )
    // Each inline comment arrives inside an empty COMMENTED review; its thread shows it, so the empty review is noise.
    const reviews = (props.reviews?.reviews ?? [])
      .filter((review) => review.state !== "PENDING" && (review.state !== "COMMENTED" || review.body.trim()))
      .map((review) => entry(review, () => ({ kind: "review", id: `r:${review.id}`, at: review.submitted ?? "", review })))
    const threads = (props.reviews?.threads ?? []).map((thread) =>
      entry(thread, () => ({ kind: "thread", id: `t:${thread.id}`, at: thread.comments[0]?.created ?? "", thread })),
    )
    return [...comments, ...reviews, ...threads].sort((a, b) => a.at.localeCompare(b.at))
  })
  const unresolved = () => (props.reviews?.threads ?? []).filter((thread) => !thread.resolved).length
  const split = () => Math.max(0, entries().length - RECENT)
  const earlier = () => props.folds.smart() && props.folds.all() !== false && !props.folds.flag("earlier") && entries().length > LONG
  const head = () => entries().slice(0, earlier() ? 1 : split())
  const tail = () => entries().slice(split())

  const render = (item: Entry) => (
    <Switch>
      <Match when={item.kind === "comment" && item}>
        {(comment) => <Note id={comment().id} author={comment().author} at={comment().at} body={comment().body} folds={props.folds} lines={8} suggested={isBot(comment().author)} />}
      </Match>
      <Match when={item.kind === "review" && !item.review.body.trim() && item}>
        {(event) => (
          <div class="ghp-entry ghp-entry-event" data-state={event().review.state}>
            <ReviewIcon state={event().review.state} />
            <span class="ghp-ellipsis">
              <b>{event().review.author}</b> <span class="ghp-review-verb">{t(`view.review.${event().review.state}`)}</span>
            </span>
            <span class="ghp-faint">· {ago(Date.parse(event().at) / 1000)}</span>
          </div>
        )}
      </Match>
      <Match when={item.kind === "review" && item}>
        {(event) => (
          <Note
            id={event().id}
            author={event().review.author}
            at={event().at}
            body={event().review.body}
            folds={props.folds}
            lines={8}
            suggested={isBot(event().review.author)}
            state={event().review.state}
            verb={
              <>
                <ReviewIcon state={event().review.state} />
                <span class="ghp-review-verb">{t(`view.review.${event().review.state}`)}</span>
              </>
            }
          />
        )}
      </Match>
      <Match when={item.kind === "thread" && item}>
        {(thread) => (
          <div class="ghp-entry ghp-entry-thread">
            <ThreadView thread={thread().thread} item={props.item} actions={props.actions} folds={props.folds} showHunk />
          </div>
        )}
      </Match>
    </Switch>
  )

  return (
    <div class="ghp-conv">
      <div class="ghp-bar">
        <span class="ghp-faint ghp-ellipsis">
          {ctx.plural("item.comments", entries().length)}
          <Show when={unresolved() > 0}> · {t("view.unresolved", { count: unresolved() })}</Show>
        </span>
        <div class="ghp-spacer" />
        <Show when={entries().length > 0}>
          <ui.Button
            size="small"
            variant="ghost-muted"
            icon={props.folds.all() ? "expand" : "collapse"}
            class="ghp-fold-all"
            onClick={() => props.folds.foldAll(!props.folds.all())}
          >
            {props.folds.all() ? t("view.unfoldAll") : t("view.foldAll")}
          </ui.Button>
        </Show>
      </div>
      <Note
        id="description"
        author={props.item.author}
        at={props.item.created}
        body={props.item.body}
        folds={props.folds}
        lines={12}
        suggested={false}
        description
        verb={<span class="ghp-faint">{t("view.opened")}</span>}
      />
      <For each={head()}>{render}</For>
      <Show when={earlier()}>
        <button type="button" class="ghp-earlier" aria-expanded={false} onClick={() => props.folds.setFlag("earlier", true)}>
          <span>{ctx.plural("view.earlier", split() - 1)}</span>
        </button>
      </Show>
      <For each={tail()}>{render}</For>
      <Show when={props.draft?.draft()}>{(draft) => <DraftEntry draft={draft()} folds={props.folds} onOpen={() => props.onOpenDraft?.()} />}</Show>
    </div>
  )
}

/**
 * A comment, review or the description: its header folds it to one line, and long text clamps. The description stays
 * out of Fold all.
 */
function Note(props: {
  id: string
  author: string
  at: string
  body: string
  folds: Folds
  lines: number
  suggested: boolean
  state?: string
  verb?: JSX.Element
  description?: boolean
}) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const folded = () => (props.description ? props.folds.flag("description:folded") : props.folds.folded(props.id, props.suggested))
  const toggle = () => {
    if (props.description) return props.folds.setFlag("description:folded", !folded())
    props.folds.fold(props.id, !folded())
  }
  return (
    <article
      class="ghp-entry ghp-note"
      data-id={props.id}
      data-state={props.state}
      data-bot={isBot(props.author) ? "" : undefined}
      data-folded={folded() ? "" : undefined}
    >
      <button type="button" class="ghp-entry-head" aria-expanded={!folded()} onClick={toggle}>
        <Chevron open={!folded()} />
        <b class="ghp-entry-author">{props.author}</b>
        {props.verb}
        <span class="ghp-faint">{ago(Date.parse(props.at) / 1000)}</span>
        <Show when={folded()}>
          <span class="ghp-entry-summary ghp-ellipsis">{firstLine(props.body)}</span>
        </Show>
      </button>
      <Show when={!folded()}>
        <div class="ghp-entry-body">
          <Show when={props.body.trim()} fallback={<span class="ghp-faint">{ctx.t("item.noBody")}</span>}>
            <Clamp lines={props.folds.smart() ? props.lines : 0} open={props.folds.flag(`${props.id}:more`)} onOpen={(open) => props.folds.setFlag(`${props.id}:more`, open)}>
              <ui.Markdown text={props.body} />
            </Clamp>
          </Show>
        </div>
      </Show>
    </article>
  )
}

function ReviewIcon(props: { state: string }) {
  const ctx = usePlugin()
  const name = () => (props.state in REVIEW_ICON ? REVIEW_ICON[props.state as keyof typeof REVIEW_ICON] : "comment")
  return <ctx.ui.Icon name={name()} size="small" class="ghp-review-icon" />
}

/**
 * A review thread: where it is, its comments, a reply box and resolve. Resolved and outdated threads start folded to one
 * line; the reply draft lives in `folds`, so folding or remounting the thread keeps it.
 */
export function ThreadView(props: { thread: Thread; item: Item; actions: Actions; folds: Folds; showHunk?: boolean }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  const git = props.actions.git
  const id = () => `t:${props.thread.id}`
  const draft = () => props.folds.text(id())
  const replying = () => props.folds.flag(`${id()}:reply`)
  const setReplying = (value: boolean) => props.folds.setFlag(`${id()}:reply`, value)
  const folded = () => props.folds.folded(id(), props.thread.resolved || props.thread.outdated, replying() && !!draft().trim())
  const [busy, setBusy] = createSignal(false)
  const first = () => props.thread.comments[0]
  const replies = () => props.thread.comments.slice(1)
  const short = () => props.folds.smart() && replies().length > REPLIES && !props.folds.flag(`${id()}:replies`)
  const shown = () => (short() ? replies().slice(-(REPLIES - 1)) : replies())
  const hunk = () => {
    const lines = parsePatch(first()?.hunk ?? "").filter((line) => line.kind !== "hunk")
    return lines.slice(-4)
  }
  const send = async () => {
    const typed = draft()
    if (!typed.trim() || busy()) return
    setBusy(true)
    const done = await props.actions.attempt(() =>
      git.replyThread({ repo: props.item.repo, number: props.item.number, thread: props.thread.id, body: typed.trim() }),
    )
    setBusy(false)
    // Keeps whatever was typed while the reply was sending.
    if (done === undefined || draft() !== typed) return
    props.folds.setText(id(), "")
    setReplying(false)
  }
  const resolve = async () => {
    if (busy()) return
    setBusy(true)
    await props.actions.attempt(() =>
      git.resolveThread({ repo: props.item.repo, number: props.item.number, thread: props.thread.id, resolved: !props.thread.resolved }),
    )
    setBusy(false)
  }
  return (
    <div class="ghp-thread" data-id={id()} data-resolved={props.thread.resolved ? "" : undefined} data-folded={folded() ? "" : undefined}>
      <button type="button" class="ghp-thread-head" aria-expanded={!folded()} onClick={() => props.folds.fold(id(), !folded())}>
        <Chevron open={!folded()} />
        <code class="ghp-thread-path ghp-ellipsis">
          {props.thread.path}
          {props.thread.line ? `:${props.thread.line}` : ""}
        </code>
        <Show when={folded() && first()} fallback={<span class="ghp-spacer" />}>
          {(comment) => (
            <>
              <b class="ghp-entry-author">{comment().author}</b>
              <span class="ghp-entry-summary ghp-ellipsis">{firstLine(comment().body)}</span>
            </>
          )}
        </Show>
        <Show when={props.thread.outdated}>
          <span class="ghp-pill">{t("review.outdated")}</span>
        </Show>
        <Show when={props.thread.resolved}>
          <span class="ghp-pill" data-review="APPROVED">
            {t("review.resolved")}
          </span>
        </Show>
        <Show when={!folded() || props.thread.comments.length > 1}>
          <span class="ghp-faint ghp-thread-count">{ctx.plural("item.comments", props.thread.comments.length)}</span>
        </Show>
      </button>
      <Show when={!folded()}>
        <div class="ghp-thread-body">
          <Show when={props.showHunk && hunk().length > 0}>
            <div class="ghp-diff-table ghp-thread-hunk">
              <For each={hunk()}>
                {(line) => (
                  <div class="ghp-dline" data-kind={line.kind}>
                    <span class="ghp-dnum">{line.old ?? ""}</span>
                    <span class="ghp-dnum">{line.new ?? ""}</span>
                    <span class="ghp-dtext">
                      <span class="ghp-dsign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
                      {line.text}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={first()}>{(comment) => <ThreadComment comment={comment()} folds={props.folds} />}</Show>
          <Show when={short()}>
            <button type="button" class="ghp-more-replies" aria-expanded={false} onClick={() => props.folds.setFlag(`${id()}:replies`, true)}>
              {ctx.plural("view.moreReplies", replies().length - shown().length)}
            </button>
          </Show>
          <For each={shown()}>{(comment) => <ThreadComment comment={comment} folds={props.folds} />}</For>
          <div class="ghp-thread-foot">
            <Show
              when={replying()}
              fallback={
                <>
                  <button type="button" class="ghp-reply-stub" onClick={() => setReplying(true)}>
                    {draft().trim() || t("review.reply")}
                  </button>
                  <ui.Button size="small" variant="ghost" busy={busy()} disabled={busy()} onClick={() => void resolve()}>
                    {props.thread.resolved ? t("review.unresolve") : t("review.resolve")}
                  </ui.Button>
                  <ui.Menu
                    label={t("agent.menu")}
                    trigger="icon"
                    icon="bubble-5"
                    placement="bottom-end"
                    items={[
                      { label: t("action.addToChat"), icon: "bubble-5", onSelect: () => props.actions.attach(threadContext(props.item, props.thread)) },
                      {
                        label: t("agent.preset.thread"),
                        icon: "brain",
                        onSelect: () => props.actions.attach(threadContext(props.item, props.thread), t("agent.prompt.thread")),
                      },
                    ]}
                  />
                </>
              }
            >
              <div class="ghp-composer">
                <textarea
                  class="ghp-textarea"
                  rows={3}
                  autofocus
                  placeholder={t("review.replyPlaceholder")}
                  aria-label={t("review.replyPlaceholder")}
                  value={draft()}
                  onInput={(event) => props.folds.setText(id(), event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      void send()
                    }
                    if (event.key === "Escape") setReplying(false)
                  }}
                />
                <div class="ghp-item-actions">
                  <div class="ghp-spacer" />
                  <ui.Button size="small" variant="ghost" onClick={() => setReplying(false)}>
                    {t("cancel")}
                  </ui.Button>
                  <ui.Button size="small" variant="contrast" busy={busy()} disabled={!draft().trim() || busy()} onClick={() => void send()}>
                    {t("review.reply")}
                  </ui.Button>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ThreadComment(props: { comment: Thread["comments"][number]; folds: Folds }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  return (
    <div class="ghp-thread-comment">
      <div class="ghp-entry-meta">
        <b class="ghp-entry-author">{props.comment.author}</b>
        <span class="ghp-faint">{ago(Date.parse(props.comment.created) / 1000)}</span>
      </div>
      <Clamp
        lines={props.folds.smart() ? 8 : 0}
        open={props.folds.flag(`${props.comment.id}:more`)}
        onOpen={(open) => props.folds.setFlag(`${props.comment.id}:more`, open)}
      >
        <ui.Markdown text={props.comment.body} />
      </Clamp>
    </div>
  )
}

// Files marked viewed, by pull request and head commit, for as long as the window is open: a new push starts over.
const viewedFiles = new Map<string, ReadonlySet<string>>()
const NONE: ReadonlySet<string> = new Set()

/**
 * The pull request's changed files, with review threads and draft review comments under their lines, a comment box on
 * every line (a single comment, or one for the draft review), and the draft review's bar while there is one.
 */
export function PrFiles(props: { item: Item; reviews: Reviews | undefined; actions: Actions; folds: Folds; threads: Folds; draft: Draft }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  const git = props.actions.git
  const q = props.actions.queries
  // The query input goes to the backend as is, so it gets the reference, not the whole item.
  const ref = () => ({ repo: props.item.repo, number: props.item.number })
  const files = latest(q.query(() => q.options.files(ref(), props.item.pr?.sha ?? "")))
  const key = () => `${props.item.repo}#${props.item.number}@${props.item.pr?.sha ?? ""}`
  const [version, setVersion] = createSignal(0)
  const viewed = () => {
    version()
    return viewedFiles.get(key()) ?? NONE
  }
  const setViewed = (path: string, value: boolean) => {
    const next = new Set(viewed())
    if (value) next.add(path)
    if (!value) next.delete(path)
    viewedFiles.set(key(), next)
    setVersion(version() + 1)
  }
  return (
    <Show
      when={files.latest}
      fallback={
        <div class="ghp-empty ghp-empty-inline">
          <Show when={files.error} fallback={<ui.Loader />}>
            <span>{errorMessage(files.error)}</span>
            <ui.Button size="small" variant="neutral" icon="refresh" onClick={() => q.invalidate(q.keys.files(ref(), props.item.pr?.sha ?? ""))}>
              {t("action.retry")}
            </ui.Button>
          </Show>
        </div>
      }
    >
      {(list) => (
        <>
          <DiffList
            files={list()}
            folds={props.folds}
            viewed={viewed()}
            onViewed={setViewed}
            threads={props.reviews?.threads}
            renderThread={(thread) => <ThreadView thread={thread} item={props.item} actions={props.actions} folds={props.threads} />}
            drafts={props.draft.draft()?.comments}
            drafting={!!props.draft.draft()}
            renderDraft={(comment, orphan) => <DraftNote comment={comment} draft={props.draft} folds={props.threads} orphan={orphan} />}
            onDraft={props.item.state === "OPEN" && props.item.pr?.sha ? (file, at, body) => props.draft.add(file, at, body) : undefined}
            onAttach={(file) =>
              props.actions.attach(fileContext(file.path, file.patch ?? "", `in pull request ${props.item.repo}#${props.item.number}`), t("agent.prompt.diff"))
            }
            onComment={
              props.item.state === "OPEN" && props.item.pr?.sha
                ? async (file, at, body) =>
                    (await props.actions.attempt(() =>
                      git.lineComment({
                        repo: props.item.repo,
                        number: props.item.number,
                        sha: props.item.pr?.sha ?? "",
                        path: file.path,
                        line: at.line,
                        side: at.side,
                        body,
                      }),
                    )) !== undefined
                : undefined
            }
          />
          <DraftBar draft={props.draft} item={props.item} files={list()} mine={props.reviews?.mine ?? false} folds={props.threads} />
        </>
      )}
    </Show>
  )
}

const CHECK_STATES = ["failure", "pending", "success", "skipped"] as const

/** Status checks grouped by outcome, failing first, and the GitHub Actions runs of the pull request's latest commit. */
export function PrChecks(props: { item: Item; actions: Actions; folds: Folds }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  const q = props.actions.queries
  const runs = latest(
    q.query(() => ({
      ...q.options.runs(props.item.repo, props.item.pr?.head ?? null),
      enabled: !!props.item.pr && !props.item.pr.cross,
      // Follows runs that are still going.
      refetchInterval: (query) => ((query.state.data ?? []).some((run) => run.status !== "completed") ? 10_000 : false),
    })),
  )
  // The status checks come with the item; while any is pending and this section is open, refresh it so they settle.
  q.query(() => ({
    ...q.options.item({ repo: props.item.repo, number: props.item.number }),
    refetchInterval: (query) => (query.state.data?.state === "OPEN" && query.state.data.pr?.checks.some((check) => check.state === "pending") ? 30_000 : false),
  }))
  const openCheck = (url: string | null) => {
    if (!url) return
    const link = parseGitHubLink(url)
    if (link?.kind === "run") return props.actions.openRun(link.repo, link.id, link.job)
    ctx.system.openExternal(url)
  }
  const checks = (state: Check["state"]) => (props.item.pr?.checks ?? []).filter((check) => check.state === state)
  // Failing and running checks need a look; passed and skipped ones start folded to their count.
  const open = (state: Check["state"]) => props.folds.flag(`checks:${state}`, state === "failure" || state === "pending")
  // Only runs for the pull request's latest commit; older ones live in the Actions view.
  const current = () => (runs.latest ?? []).filter((run) => run.sha === props.item.pr?.sha)
  return (
    <div class="ghp-checks-view">
      <Show when={(props.item.pr?.checks.length ?? 0) === 0}>
        <div class="ghp-faint ghp-pad">{t("checks.none")}</div>
      </Show>
      <For each={CHECK_STATES}>
        {(state) => (
          <Show when={checks(state).length > 0}>
            <Group
              class="ghp-check-group"
              title={
                <>
                  <span class="ghp-check-dot" data-state={state} />
                  {t(`view.checks.${state}`, { count: checks(state).length })}
                </>
              }
              open={open(state)}
              onToggle={() => props.folds.setFlag(`checks:${state}`, !open(state))}
            >
              <For each={checks(state)}>
                {(check) => (
                  <button type="button" class="ghp-check-row" data-state={check.state} disabled={!check.url} onClick={() => openCheck(check.url)}>
                    <span class="ghp-check-dot" data-state={check.state} />
                    <span class="ghp-ellipsis">{check.name}</span>
                    <span class="ghp-faint">{t(`checks.${check.state}`)}</span>
                  </button>
                )}
              </For>
            </Group>
          </Show>
        )}
      </For>
      <Show when={props.item.pr && !props.item.pr.cross}>
        <Group
          class="ghp-check-group ghp-check-runs"
          title={
            <>
              {t("checks.runs")}
              <Show when={runs.loading}>
                <ui.Loader size="small" />
              </Show>
            </>
          }
          count={runs.latest ? current().length : undefined}
          open={props.folds.flag("runs", true)}
          onToggle={() => props.folds.setFlag("runs", !props.folds.flag("runs", true))}
        >
          <For each={current()} fallback={<div class="ghp-faint ghp-pad">{runs.latest ? t("checks.noRuns") : ""}</div>}>
            {(run) => <RunRow run={run} repo={props.item.repo} actions={props.actions} />}
          </For>
        </Group>
      </Show>
    </div>
  )
}

export function RunRow(props: { run: Run; repo: string; actions: Actions; showBranch?: boolean }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  const git = props.actions.git
  const active = () => props.run.status !== "completed"
  const items = (): UiMenuEntry[] => [
    {
      label: t("run.rerunFailed"),
      icon: "refresh",
      disabled: active() || props.run.conclusion !== "failure",
      onSelect: () => void props.actions.attempt(() => git.rerun({ repo: props.repo, id: props.run.id, failed: true }), t("run.rerunStarted")),
    },
    {
      label: t("run.rerunAll"),
      icon: "outline-rotate-clockwise",
      disabled: active(),
      onSelect: () => void props.actions.attempt(() => git.rerun({ repo: props.repo, id: props.run.id, failed: false }), t("run.rerunStarted")),
    },
    {
      label: t("run.cancel"),
      icon: "stop",
      disabled: !active(),
      onSelect: () => void props.actions.attempt(() => git.cancelRun({ repo: props.repo, id: props.run.id })),
    },
    { type: "separator" },
    { label: t("action.openOnGitHub"), icon: "square-arrow-top-right", onSelect: () => ctx.system.openExternal(props.run.url) },
  ]
  return (
    <div
      class="ghp-pr"
      role="button"
      tabIndex={0}
      onClick={() => props.actions.openRun(props.repo, props.run.id)}
      onKeyDown={(event) => {
        // Keys pressed in the row's menu bubble up here; only the row itself opens the run.
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return
        event.preventDefault()
        props.actions.openRun(props.repo, props.run.id)
      }}
    >
      <RunStatus status={props.run.status} conclusion={props.run.conclusion} />
      <div class="ghp-pr-main">
        <div class="ghp-pr-title">
          <span class="ghp-ellipsis">{props.run.workflow}</span>
          <span class="ghp-faint ghp-ellipsis">{props.run.title}</span>
        </div>
        <div class="ghp-pr-sub">
          <span class="ghp-ellipsis">
            {props.showBranch ? `${props.run.branch} · ` : ""}
            {props.run.event} · {props.run.sha.slice(0, 7)} · {ago(Date.parse(props.run.created) / 1000)}
            {props.run.attempt > 1 ? ` · ${t("run.attempt", { count: props.run.attempt })}` : ""}
          </span>
        </div>
      </div>
      <div class="ghp-row-actions ghp-row-actions-visible" onClick={(event) => event.stopPropagation()}>
        <ui.Menu label={t("action.more")} trigger="icon" icon="outline-dots" placement="bottom-end" items={items()} />
      </div>
    </div>
  )
}

export function RunStatus(props: { status: string; conclusion: string }) {
  const state = () => {
    if (props.status !== "completed") return "pending"
    if (props.conclusion === "success") return "success"
    if (["skipped", "neutral", "cancelled"].includes(props.conclusion)) return "skipped"
    return "failure"
  }
  return (
    <span class="ghp-run-status" data-state={state()} data-active={props.status === "in_progress" ? "" : undefined}>
      {state() === "success" ? "✓" : state() === "failure" ? "✕" : state() === "skipped" ? "–" : "●"}
    </span>
  )
}
