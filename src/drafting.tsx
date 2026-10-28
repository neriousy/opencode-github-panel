import { createMemo, createSignal, For, Show } from "solid-js"
import { usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { errorMessage, type Actions } from "./actions"
import type { ChangedFile, DraftComment, DraftReview, Item, ItemRef, ReviewEvent } from "./contract"
import { splitDrift } from "./draft"
import { Chevron, Clamp, firstLine, type Folds } from "./fold"
import { latest } from "./queries"
import { GitRpc } from "./rpc"
import type { reviewMethods } from "./schemas"
import type { Target } from "./diff"

type Methods = typeof reviewMethods
type Edit = Omit<Methods["reviewEdit"]["input"]["Type"], "sessionID" | "repo" | "number">

const EVENTS: readonly ReviewEvent[] = ["COMMENT", "APPROVE", "REQUEST_CHANGES"]

/** Calls a draft review method on the session's server; only the server part keeps drafts. */
function reviewCall<Name extends keyof Methods>(session: MountedSession, name: Name, input: Methods[Name]["input"]["Type"]): Promise<Methods[Name]["output"]["Type"]> {
  // SAFETY: GitRpc is built from `serverMethods`, which has each review method with these inputs and outputs.
  const rpc = session.server.client.rpc(GitRpc) as unknown as Record<Name, (input: unknown, options: object) => Promise<Methods[Name]["output"]["Type"]>>
  return rpc[name](input, { location: { directory: session.directory } }).catch((error: unknown) => Promise.reject(new Error(errorMessage(error))))
}

export type Draft = ReturnType<typeof createDraft>

/**
 * A pull request's draft review, as its tab shows and edits it: the routed session's draft first, else the newest one
 * another session drafted. Adding a comment without a draft starts the user's own.
 */
export function createDraft(props: { ref: ItemRef; item: () => Item | undefined; session: MountedSession; actions: Actions }) {
  const ctx = usePlugin()
  const t = ctx.t
  const q = props.actions.queries
  const ref = () => ({ repo: props.ref.repo, number: props.ref.number })
  const data = latest(
    q.query(() => ({
      queryKey: q.keys.review(ref()),
      // A server without the server part keeps no drafts.
      queryFn: () => reviewCall(props.session, "reviewDrafts", { ...ref(), sessionID: props.session.id }).catch(() => []),
      staleTime: 30_000,
      enabled: props.item()?.kind === "pr",
    })),
  )
  const [busy, setBusy] = createSignal<string>()
  const draft = () => data.latest?.[0]
  const owner = () => draft()?.sessionID ?? props.session.id

  const put = (next: DraftReview | undefined, sessionID: string) =>
    q.client.setQueryData<DraftReview[]>(q.keys.review(ref()), (list) => {
      const rest = (list ?? []).filter((item) => item.sessionID !== sessionID)
      return next ? [next, ...rest] : rest
    })

  const edit = async (change: Edit) => {
    const sessionID = owner()
    const result = await props.actions.attempt(() => reviewCall(props.session, "reviewEdit", { ...ref(), sessionID, ...change }))
    if (result) put(result, sessionID)
    return result !== undefined
  }

  const add = (file: ChangedFile, target: Target, body: string) =>
    edit({ add: { path: file.path, line: target.line, side: target.side, startLine: null, body }, sha: props.item()?.pr?.sha })

  const discard = async () => {
    const current = draft()
    if (!current || busy()) return
    const ok = await ctx.dialogs.confirm({
      title: t("draft.discardTitle"),
      description: ctx.plural("draft.comments", current.comments.length),
      confirm: t("draft.discard"),
      danger: true,
    })
    if (!ok) return
    setBusy("discard")
    const done = await props.actions.attempt(() => reviewCall(props.session, "reviewDiscard", { ...ref(), sessionID: current.sessionID }))
    setBusy(undefined)
    if (done !== undefined) put(undefined, current.sessionID)
  }

  const submit = async (summary?: string) => {
    const current = draft()
    if (!current || busy()) return false
    setBusy("submit")
    const toast = ctx.toast.show({ variant: "loading", title: t("draft.submitting"), persistent: true })
    const run = async () => {
      if (summary !== undefined && summary !== current.summary && !(await edit({ summary }))) return false
      const first = await reviewCall(props.session, "reviewSubmit", { ...ref(), sessionID: current.sessionID, force: false })
      if (first.submitted) return first
      toast.dismiss()
      const ok = await ctx.dialogs.confirm({ title: t("draft.driftTitle"), description: first.message, confirm: t("draft.submitAnyway") })
      if (!ok) return false
      return reviewCall(props.session, "reviewSubmit", { ...ref(), sessionID: current.sessionID, force: true })
    }
    const result = await props.actions.attempt(run)
    toast.dismiss()
    setBusy(undefined)
    if (!result) return false
    put(undefined, current.sessionID)
    const url = result.url
    ctx.toast.show({
      variant: "success",
      title: t("draft.submitted"),
      description: result.message,
      ...(url ? { actions: [{ label: t("action.openOnGitHub"), run: () => ctx.system.openExternal(url) }] } : {}),
    })
    return true
  }

  return { draft, edit, add, discard, submit, busy, loading: () => data.loading }
}

/** At the top of a pull request tab: a draft review waits, with its size and suggested verdict. */
export function DraftBanner(props: { draft: Draft; onOpen: () => void }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  return (
    <Show when={props.draft.draft()}>
      {(current) => (
        <div class="ghp-banner ghp-draft-banner" data-source={current().source}>
          <div class="ghp-draft-banner-line">
            <ui.Icon name={current().source === "agent" ? "brain" : "review"} size="small" />
            <span class="ghp-grow ghp-ellipsis">
              <b>{t(current().source === "agent" ? "draft.bannerAgent" : "draft.bannerUser")}</b>
              {" · "}
              {ctx.plural("draft.comments", current().comments.length)}
              <Show when={current().source === "agent" && current().event !== "COMMENT"}>
                {" · "}
                {t("draft.suggests", { event: t(`draft.event.${current().event}`) })}
              </Show>
            </span>
            <ui.Button size="small" variant="ghost" icon="review" onClick={props.onOpen}>
              {t("draft.open")}
            </ui.Button>
            <ui.Button size="small" variant="contrast" busy={props.draft.busy() === "submit"} disabled={!!props.draft.busy()} onClick={() => void props.draft.submit()}>
              {t("draft.submit")}
            </ui.Button>
            <ui.Button size="small" variant="ghost" disabled={!!props.draft.busy()} onClick={() => void props.draft.discard()}>
              {t("draft.discard")}
            </ui.Button>
          </div>
          <Show when={current().note}>
            <div class="ghp-draft-note">{current().note}</div>
          </Show>
        </div>
      )}
    </Show>
  )
}

/**
 * The bar under a pull request's files while a draft review exists: its size, the verdict, the summary (folded), and
 * Submit or Discard. Approve and Request changes are off on the user's own pull request, as on GitHub.
 */
export function DraftBar(props: { draft: Draft; item: Item; files: readonly ChangedFile[] | undefined; mine: boolean; folds: Folds }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  return (
    <Show when={props.draft.draft()}>
      {(current) => {
        const key = () => `draft:${current().sessionID}:summary`
        const open = () => props.folds.flag(`${key()}:open`)
        // What the user typed and has not saved yet; the stored summary otherwise.
        const typed = () => (props.folds.flag(`${key()}:dirty`) ? props.folds.text(key()) : current().summary)
        const type = (value: string) => {
          props.folds.setText(key(), value)
          props.folds.setFlag(`${key()}:dirty`, true)
        }
        const save = async () => {
          if (!props.folds.flag(`${key()}:dirty`)) return
          const value = props.folds.text(key())
          if (value !== current().summary && !(await props.draft.edit({ summary: value }))) return
          props.folds.setFlag(`${key()}:dirty`, false)
        }
        const submit = async () => {
          if (await props.draft.submit(typed())) props.folds.setFlag(`${key()}:dirty`, false)
        }
        // The comments whose lines are not in the diff shown, which submitting moves into the summary.
        const moved = createMemo(() => (props.files ? splitDrift(current().comments, props.files).moved : []))
        const drift = () => !!props.item.pr && props.item.pr.sha !== current().sha
        return (
          <div class="ghp-draft-bar" data-source={current().source}>
            <div class="ghp-draft-bar-line">
              <ui.Icon name="review" size="small" />
              <b class="ghp-ellipsis">{t("draft.title")}</b>
              <span class="ghp-faint ghp-ellipsis">
                {ctx.plural("draft.comments", current().comments.length)}
                {current().source === "agent" ? ` · ${t("draft.byAgent")}` : ""}
              </span>
              <div class="ghp-spacer" />
              <div class="ghp-segmented ghp-draft-verdict" role="radiogroup" aria-label={t("draft.verdict")}>
                <For each={EVENTS}>
                  {(event) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={current().event === event}
                      data-selected={current().event === event ? "" : undefined}
                      data-event={event}
                      disabled={(props.mine && event !== "COMMENT") || !!props.draft.busy()}
                      title={props.mine && event !== "COMMENT" ? t("review.ownPr") : undefined}
                      onClick={() => current().event !== event && void props.draft.edit({ event })}
                    >
                      {t(`draft.event.${event}`)}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <Show when={drift() || moved().length > 0}>
              <div class="ghp-draft-drift">
                <ui.Icon name="warning" size="small" />
                <span>{moved().length > 0 ? ctx.plural("draft.moved", moved().length) : t("draft.drift")}</span>
              </div>
            </Show>
            <Show when={open()}>
              <textarea
                class="ghp-textarea ghp-draft-summary"
                rows={5}
                placeholder={t("draft.summaryPlaceholder")}
                aria-label={t("draft.summary")}
                value={typed()}
                onInput={(event) => type(event.currentTarget.value)}
                onBlur={() => void save()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    void submit()
                  }
                }}
              />
            </Show>
            <div class="ghp-draft-bar-line">
              <button
                type="button"
                class="ghp-draft-summary-toggle"
                aria-expanded={open()}
                onClick={() => {
                  if (open()) void save()
                  props.folds.setFlag(`${key()}:open`, !open())
                }}
              >
                <Chevron open={open()} />
                <span>{t("draft.summary")}</span>
                <Show when={!open()}>
                  <span class="ghp-faint ghp-ellipsis">{firstLine(typed()) || t("draft.noSummary")}</span>
                </Show>
              </button>
              <ui.Button size="small" variant="ghost" disabled={!!props.draft.busy()} onClick={() => void props.draft.discard()}>
                {t("draft.discard")}
              </ui.Button>
              <ui.Button size="small" variant="contrast" icon="review" busy={props.draft.busy() === "submit"} disabled={!!props.draft.busy()} onClick={() => void submit()}>
                {t("draft.submit")}
              </ui.Button>
            </div>
          </div>
        )
      }}
    </Show>
  )
}

/**
 * A draft comment between the diff lines, marked as a draft: its text, or a box to edit it, and Delete. `orphan` marks
 * one whose line is not in the diff shown, which submitting moves into the summary.
 */
export function DraftNote(props: { comment: DraftComment; draft: Draft; folds: Folds; orphan?: boolean }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  const id = () => `d:${props.comment.id}`
  const editing = () => props.folds.flag(`${id()}:edit`)
  const text = () => props.folds.text(id())
  const [busy, setBusy] = createSignal(false)
  const start = () => {
    props.folds.setText(id(), props.comment.body)
    props.folds.setFlag(`${id()}:edit`, true)
  }
  const save = async () => {
    if (!text().trim() || busy()) return
    setBusy(true)
    const done = text() === props.comment.body || (await props.draft.edit({ update: { id: props.comment.id, body: text() } }))
    setBusy(false)
    if (done) props.folds.setFlag(`${id()}:edit`, false)
  }
  const remove = async () => {
    if (busy()) return
    setBusy(true)
    await props.draft.edit({ remove: props.comment.id })
    setBusy(false)
  }
  const lines = () =>
    props.comment.startLine !== null && props.comment.startLine !== props.comment.line
      ? t("draft.lines", { from: props.comment.startLine, to: props.comment.line })
      : t("draft.line", { line: props.comment.line })
  return (
    <div class="ghp-draft-comment" data-id={id()} data-source={props.comment.source} data-orphan={props.orphan ? "" : undefined}>
      <div class="ghp-draft-comment-head">
        <span class="ghp-pill ghp-draft-pill">{t(props.comment.source === "agent" ? "draft.agent" : "draft.you")}</span>
        <span class="ghp-faint ghp-ellipsis">
          {lines()}
          {props.comment.side === "LEFT" ? ` · ${t("draft.removedSide")}` : ""}
          {props.comment.edited ? ` · ${t("draft.edited")}` : ""}
        </span>
        <Show when={props.orphan}>
          <span class="ghp-pill" data-mergeable="CONFLICTING" title={t("draft.orphanHint")}>
            {t("draft.orphan")}
          </span>
        </Show>
        <div class="ghp-spacer" />
        <Show when={!editing()}>
          <ui.IconButton icon="edit" label={t("draft.edit")} size="small" variant="ghost-muted" onClick={start} />
          <ui.IconButton icon="trash" label={t("draft.delete")} size="small" variant="ghost-muted" disabled={busy()} onClick={() => void remove()} />
        </Show>
      </div>
      <Show
        when={editing()}
        fallback={
          <div class="ghp-draft-comment-body">
            <Clamp lines={props.folds.smart() ? 10 : 0} open={props.folds.flag(`${id()}:more`)} onOpen={(open) => props.folds.setFlag(`${id()}:more`, open)}>
              <ui.Markdown text={props.comment.body} />
            </Clamp>
          </div>
        }
      >
        <div class="ghp-composer">
          <textarea
            class="ghp-textarea"
            rows={Math.min(12, Math.max(3, text().split("\n").length + 1))}
            autofocus
            aria-label={t("draft.edit")}
            value={text()}
            onInput={(event) => props.folds.setText(id(), event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void save()
              }
              if (event.key === "Escape") props.folds.setFlag(`${id()}:edit`, false)
            }}
          />
          <div class="ghp-item-actions">
            <div class="ghp-spacer" />
            <ui.Button size="small" variant="ghost" onClick={() => props.folds.setFlag(`${id()}:edit`, false)}>
              {t("cancel")}
            </ui.Button>
            <ui.Button size="small" variant="contrast" busy={busy()} disabled={!text().trim() || busy()} onClick={() => void save()}>
              {t("draft.save")}
            </ui.Button>
          </div>
        </div>
      </Show>
    </div>
  )
}

/** The draft review's summary at the end of the conversation, folded to a line until opened. */
export function DraftEntry(props: { draft: DraftReview; folds: Folds; onOpen: () => void }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  const folded = () => props.folds.folded("draft", true)
  return (
    <article class="ghp-entry ghp-note ghp-draft-entry" data-id="draft" data-folded={folded() ? "" : undefined}>
      <button type="button" class="ghp-entry-head" aria-expanded={!folded()} onClick={() => props.folds.fold("draft", !folded())}>
        <Chevron open={!folded()} />
        <span class="ghp-pill ghp-draft-pill">{t(props.draft.source === "agent" ? "draft.agent" : "draft.you")}</span>
        <b class="ghp-entry-author">{t("draft.title")}</b>
        <span class="ghp-faint">
          {t(`draft.event.${props.draft.event}`)} · {ctx.plural("draft.comments", props.draft.comments.length)}
        </span>
        <Show when={folded()}>
          <span class="ghp-entry-summary ghp-ellipsis">{firstLine(props.draft.summary)}</span>
        </Show>
      </button>
      <Show when={!folded()}>
        <div class="ghp-entry-body">
          <Show when={props.draft.summary.trim()} fallback={<span class="ghp-faint">{t("draft.noSummary")}</span>}>
            <Clamp lines={props.folds.smart() ? 8 : 0} open={props.folds.flag("draft:more")} onOpen={(open) => props.folds.setFlag("draft:more", open)}>
              <ui.Markdown text={props.draft.summary} />
            </Clamp>
          </Show>
          <div class="ghp-item-actions">
            <ui.Button size="small" variant="ghost" icon="review" onClick={props.onOpen}>
              {t("draft.open")}
            </ui.Button>
          </div>
        </div>
      </Show>
    </article>
  )
}
