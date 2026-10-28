import { createMemo, createRoot, createSignal, For, Match, Show, Switch } from "solid-js"
import { usePlugin, type ComposerPill, type ComposerPillRow, type Context, type MountedSession } from "@opencode/plugin/gui"
import { errorMessage, type Actions } from "./actions"
import type { AgentAction, AgentQueue, AgentTriage, ItemRef } from "./contract"
import type { definition } from "./definition"
import { Clamp, createFolds, Group } from "./fold"
import { counts, triageProgress, undoFor } from "./plan"
import { latest } from "./queries"
import { CommentField } from "./triage"

/** What an action does, as the activity page, the banner and the pill say it. */
export function describeAction(t: Context["t"], action: AgentAction) {
  const payload = action.payload
  const names = (list: readonly string[] | undefined, mark: string) => (list ?? []).map((name) => (name === "@me" || !mark ? name : `${mark}${name}`)).join(", ")
  const withComment = payload.body ? ` · ${t("activity.withComment")}` : ""
  if (action.kind === "close") {
    if (action.item === "pr" || !payload.reason) return `${t("activity.kind.close")}${withComment}`
    return `${t(`activity.kind.close.${payload.reason}`, { number: payload.duplicateOf ?? "" })}${withComment}`
  }
  if (action.kind === "reopen") return `${t("activity.kind.reopen")}${withComment}`
  if (action.kind === "other") return t("activity.kind.other", { command: payload.command ?? "" })
  if (action.kind !== "label" && action.kind !== "assign") return t(`activity.kind.${action.kind}`)
  const mark = action.kind === "assign" ? "@" : ""
  return [
    payload.add?.length ? t(`activity.kind.${action.kind}Add`, { names: names(payload.add, mark) }) : "",
    payload.remove?.length ? t(`activity.kind.${action.kind}Remove`, { names: names(payload.remove, mark) }) : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

/** The agent's GitHub actions in this session: what waits for approval, what runs, what is done and can be undone. */
export function ActivityView(props: { session: MountedSession; actions: Actions }) {
  const ctx = usePlugin<typeof definition>()
  const ui = ctx.ui
  const t = ctx.t
  const q = props.actions.queries
  const agent = props.actions.agent
  const data = latest(q.query(() => q.options.agent(props.session.id)))
  const folds = createFolds()
  const [active, setActive] = createSignal<string>()
  // The user's decisions in this view, newest last, so `u` can take the last one back while it has not run.
  const [history, setHistory] = createSignal<readonly (readonly string[])[]>([])
  const all = () => data.latest?.actions ?? []
  const triage = () => data.latest?.triage
  const of = (...statuses: AgentAction["status"][]) => all().filter((action) => statuses.includes(action.status))
  const newest = (list: AgentAction[]) => list.toSorted((a, b) => b.updatedAt - a.updatedAt)
  const proposed = () => of("proposed")
  // In a triage run, proposals group by the batch the agent made them in.
  const groups = createMemo(() => {
    const list = proposed()
    if (!triage()) return list.length > 0 ? [{ round: undefined, list }] : []
    const rounds = [...new Set(list.map((action) => action.round))].toSorted((a, b) => (a ?? 0) - (b ?? 0))
    return rounds.map((round) => ({ round, list: list.filter((action) => action.round === round) }))
  })
  const sections = [
    { id: "running", list: () => of("approved", "running"), open: true },
    { id: "failed", list: () => newest(of("failed")), open: true },
    { id: "done", list: () => newest(of("done")), open: true },
    { id: "closed", list: () => newest(of("skipped", "undone")), open: false },
  ]
  // The rows in the order they show, for j and k.
  const order = () => [...groups().flatMap((group) => group.list), ...sections.flatMap((section) => (folds.flag(section.id, section.open) ? section.list() : []))]
  const current = () => order().find((action) => action.id === active()) ?? order()[0]
  const sessionID = () => props.session.id

  const decide = (ids: readonly string[], decision: "approve" | "skip") => {
    if (ids.length === 0) return
    setHistory([...history(), ids].slice(-50))
    void agent.decide(sessionID(), ids, decision)
  }
  const takeBack = async () => {
    const last = history().at(-1)
    if (!last) return
    setHistory(history().slice(0, -1))
    await props.actions.attempt(async () => {
      const message = await props.actions.git.agentDecide({ sessionID: sessionID(), ids: [...last], batch: null, decision: "reset" })
      ctx.toast.show({ title: message, duration: 2000 })
    })
  }
  const groupOf = (action: AgentAction | undefined) => groups().find((group) => group.list.some((item) => item.id === action?.id)) ?? groups()[0]

  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || (event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable]"))) return
    // Enter on a focused button presses it.
    if (event.key === "Enter" && event.target !== event.currentTarget) return
    const action = current()
    const rows = order()
    const index = action ? rows.indexOf(action) : -1
    const move = (step: number) => {
      const next = rows[Math.min(rows.length - 1, Math.max(0, index + step))]
      if (!next) return
      setActive(next.id)
      document.getElementById(`ghp-activity-${next.id}`)?.scrollIntoView({ block: "nearest" })
    }
    // Deciding moves on to the next row, so a run of proposals goes y, y, n, y.
    const decideCurrent = (decision: "approve" | "skip") => {
      if (action?.status !== "proposed") return
      move(1)
      decide([action.id], decision)
    }
    const keys: Record<string, () => void> = {
      j: () => move(1),
      ArrowDown: () => move(1),
      k: () => move(-1),
      ArrowUp: () => move(-1),
      y: () => decideCurrent("approve"),
      n: () => decideCurrent("skip"),
      a: () => decide(groupOf(action)?.list.map((item) => item.id) ?? [], "approve"),
      u: () => void takeBack(),
      e: () => action?.status === "proposed" && editAction(ctx, props.actions, action),
      o: () => action && props.actions.openItem(refOf(action)),
      Enter: () => action && props.actions.openItem(refOf(action)),
    }
    const run = keys[event.key]
    if (!run) return
    event.preventDefault()
    run()
  }

  const row = (action: AgentAction) => (
    <ActionRow action={action} session={props.session} actions={props.actions} active={current()?.id === action.id} onActive={() => setActive(action.id)} onDecide={decide} />
  )

  return (
    <div class="ghp-activity" tabIndex={0} onKeyDown={onKey} data-triage={triage() ? "" : undefined}>
      <div class="ghp-toolbar ghp-activity-toolbar">
        <ui.Tooltip value={t("activity.autoWarning")}>
          <ui.Switch label={t("activity.auto")} checked={data.latest?.auto ?? false} onChange={(auto) => void agent.setAuto(sessionID(), auto)} />
        </ui.Tooltip>
        <div class="ghp-spacer" />
        <Show when={data.loading}>
          <ui.Loader size="small" />
        </Show>
        <Show when={history().length > 0}>
          <ui.Tooltip value={t("activity.takeBack")} keys={["U"]}>
            <ui.IconButton icon="outline-undo" label={t("activity.takeBack")} size="small" variant="ghost" onClick={() => void takeBack()} />
          </ui.Tooltip>
        </Show>
        <ui.Tooltip value={t("action.refresh")}>
          <ui.IconButton icon="refresh" label={t("action.refresh")} size="small" variant="ghost" onClick={() => q.invalidate(q.keys.agent(sessionID()))} />
        </ui.Tooltip>
      </div>
      <Show when={triage()}>{(run) => <TriageHeader triage={run()} actions={all()} folds={folds} />}</Show>
      <Show
        when={all().length > 0}
        fallback={
          <div class="ghp-empty ghp-empty-inline">
            <Show when={data.latest || data.error} fallback={<ui.Loader />}>
              {data.error ? errorMessage(data.error) : triage() ? t("activity.triage.empty") : t("activity.empty")}
            </Show>
          </div>
        }
      >
        <For each={groups()}>
          {(group) => (
            <section class="ghp-activity-section" data-section="proposed" data-round={group.round}>
              <div class="ghp-section-header">
                <span class="ghp-section-title">
                  {group.round === undefined ? t("activity.section.proposed") : t("activity.section.round", { round: group.round })}
                  <span class="ghp-tab-count">{group.list.length}</span>
                </span>
                <ui.Button size="small" variant="ghost" onClick={() => decide(group.list.map((action) => action.id), "skip")}>
                  {group.round === undefined ? t("activity.skipAll") : t("activity.skipBatch")}
                </ui.Button>
                <ui.Button size="small" variant="contrast" icon="check" onClick={() => decide(group.list.map((action) => action.id), "approve")}>
                  {group.round === undefined ? t("activity.approveAll") : t("activity.approveBatch")}
                </ui.Button>
              </div>
              <For each={group.list}>{row}</For>
            </section>
          )}
        </For>
        <For each={sections}>
          {(section) => (
            <Show when={section.list().length > 0}>
              <Group
                class="ghp-activity-group"
                title={t(`activity.section.${section.id}`)}
                count={section.list().length}
                open={folds.flag(section.id, section.open)}
                onToggle={() => folds.setFlag(section.id, !folds.flag(section.id, section.open))}
              >
                <For each={section.list()}>{row}</For>
              </Group>
            </Show>
          )}
        </For>
        <div class="ghp-faint ghp-hint ghp-activity-keys">{t("activity.keys")}</div>
      </Show>
    </div>
  )
}

/** The triage run at the top of its session's activity: what it goes through, its rules and how far it got. */
function TriageHeader(props: { triage: AgentTriage; actions: readonly AgentAction[]; folds: ReturnType<typeof createFolds> }) {
  const ctx = usePlugin()
  const t = ctx.t
  const progress = () => triageProgress(props.triage, props.actions)
  const finished = () => progress().reviewed >= progress().total && progress().waiting === 0
  const share = () => (progress().total > 0 ? Math.min(100, Math.round((progress().reviewed / progress().total) * 100)) : 0)
  return (
    <section class="ghp-triage-head" data-finished={finished() ? "" : undefined}>
      <div class="ghp-triage-line">
        <span class="ghp-triage-title">{t("activity.triage.title")}</span>
        <span class="ghp-faint ghp-ellipsis">
          {props.triage.repo} · {ctx.plural(`triage.noun.${props.triage.kind}`, progress().total)}
        </span>
      </div>
      <Show
        when={props.triage.query}
        fallback={
          <div class="ghp-triage-source ghp-ellipsis">
            {props.triage.numbers
              .slice(0, 30)
              .map((number) => `#${number}`)
              .join(", ")}
            {props.triage.numbers.length > 30 ? " …" : ""}
          </div>
        }
      >
        {(query) => <code class="ghp-triage-query ghp-ellipsis">{query()}</code>}
      </Show>
      <div class="ghp-triage-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress().total} aria-valuenow={progress().reviewed} aria-label={t("activity.triage.title")}>
        <div class="ghp-triage-bar" style={{ width: `${share()}%` }} />
      </div>
      <div class="ghp-triage-counts">
        {t("activity.triage.progress", progress())}
        <Show when={finished()}>
          <span class="ghp-triage-done"> · {t("activity.triage.finished")}</span>
        </Show>
      </div>
      <Show when={props.triage.rules.trim()}>
        {(rules) => (
          <Clamp lines={2} open={props.folds.flag("triage-rules")} onOpen={(open) => props.folds.setFlag("triage-rules", open)}>
            <div class="ghp-triage-rules">{rules()}</div>
          </Clamp>
        )}
      </Show>
    </section>
  )
}

function ActionRow(props: {
  action: AgentAction
  session: MountedSession
  actions: Actions
  active: boolean
  onActive: () => void
  onDecide: (ids: readonly string[], decision: "approve" | "skip") => void
}) {
  const ctx = usePlugin<typeof definition>()
  const ui = ctx.ui
  const t = ctx.t
  const q = props.actions.queries
  const agent = props.actions.agent
  const sessionID = () => props.session.id
  const action = () => props.action
  let prefetch: ReturnType<typeof setTimeout> | undefined
  return (
    <div
      class="ghp-activity-row"
      id={`ghp-activity-${action().id}`}
      data-status={action().status}
      data-active={props.active ? "" : undefined}
      onClick={() => props.onActive()}
    >
      <div class="ghp-activity-line">
        <button
          type="button"
          class="ghp-activity-ref"
          title={`${action().repo}#${action().number}`}
          onMouseEnter={() => {
            clearTimeout(prefetch)
            prefetch = setTimeout(() => q.prefetch(q.options.item(refOf(action()))), 150)
          }}
          onMouseLeave={() => clearTimeout(prefetch)}
          onClick={() => props.actions.openItem(refOf(action()))}
        >
          <span class="ghp-faint">#{action().number}</span>
          <span class="ghp-ellipsis">{action().title || action().repo}</span>
        </button>
        <Show when={action().status !== "proposed"}>
          <span class="ghp-activity-status" data-status={action().status}>
            {action().result?.noop ? t("activity.noop") : t(`activity.status.${action().status}`)}
          </span>
        </Show>
      </div>
      <div class="ghp-activity-what">
        <span>{describeAction(t, action())}</span>
        <Show when={action().edited}>
          <span class="ghp-pill">{t("activity.edited")}</span>
        </Show>
        <Show when={action().source !== "tool"}>
          <span class="ghp-pill">{t(action().undoOf ? "activity.source.undo" : `activity.source.${action().source}`)}</span>
        </Show>
      </div>
      <Show when={action().note}>
        <div class="ghp-activity-note">{action().note}</div>
      </Show>
      <Show when={action().payload.body}>
        {(body) => (
          <div class="ghp-activity-body">
            <Clamp lines={3}>
              <div class="ghp-activity-text">{body()}</div>
            </Clamp>
          </div>
        )}
      </Show>
      <Show when={action().error}>{(error) => <div class="ghp-activity-error">{error()}</div>}</Show>
      <div class="ghp-activity-buttons" onClick={(event) => event.stopPropagation()}>
        <Switch>
          <Match when={action().status === "proposed"}>
            <ui.Button size="small" variant="contrast" icon="check" onClick={() => props.onDecide([action().id], "approve")}>
              {t("activity.approve")}
            </ui.Button>
            <ui.Button size="small" variant="ghost" icon="edit" onClick={() => editAction(ctx, props.actions, action())}>
              {t("activity.edit")}
            </ui.Button>
            <ui.Button size="small" variant="ghost" onClick={() => props.onDecide([action().id], "skip")}>
              {t("activity.skip")}
            </ui.Button>
          </Match>
          <Match when={action().status === "running" || action().status === "approved"}>
            <ui.Loader size="small" />
          </Match>
          <Match when={action().status === "failed"}>
            <ui.Button size="small" variant="neutral" icon="refresh" onClick={() => void agent.retry(sessionID(), [action().id])}>
              {t("activity.retry")}
            </ui.Button>
          </Match>
          <Match when={action().status === "done" && undoFor(action())}>
            <ui.Button size="small" variant="ghost" icon="outline-undo" onClick={() => void agent.undo(sessionID(), action().id)}>
              {t("activity.undo")}
            </ui.Button>
          </Match>
        </Switch>
        <div class="ghp-spacer" />
        <Show when={action().result?.url}>
          {(url) => (
            <ui.Tooltip value={t("action.openOnGitHub")}>
              <ui.IconButton icon="square-arrow-top-right" label={t("action.openOnGitHub")} size="small" variant="ghost" onClick={() => ctx.system.openExternal(url())} />
            </ui.Tooltip>
          )}
        </Show>
      </div>
    </div>
  )
}

/** The proposals for one issue or pull request in this session, at the top of its tab. */
export function AgentBanner(props: { item: ItemRef; session: MountedSession; actions: Actions }) {
  const ctx = usePlugin<typeof definition>()
  const ui = ctx.ui
  const t = ctx.t
  const q = props.actions.queries
  const data = latest(q.query(() => q.options.agent(props.session.id)))
  const proposals = () =>
    (data.latest?.actions ?? []).filter((action) => action.status === "proposed" && action.repo === props.item.repo && action.number === props.item.number)
  return (
    <For each={proposals()}>
      {(action) => (
        <div class="ghp-banner ghp-agent-banner">
          <div class="ghp-agent-banner-line">
            <ui.Icon name="brain" size="small" />
            <span class="ghp-grow">
              <b>{t("activity.proposes")}:</b> {describeAction(t, action)}
            </span>
            <ui.Button size="small" variant="contrast" icon="check" onClick={() => void props.actions.agent.decide(props.session.id, [action.id], "approve")}>
              {t("activity.approve")}
            </ui.Button>
            <ui.Button size="small" variant="ghost" icon="edit" onClick={() => editAction(ctx, props.actions, action)}>
              {t("activity.edit")}
            </ui.Button>
            <ui.Button size="small" variant="ghost" onClick={() => void props.actions.agent.decide(props.session.id, [action.id], "skip")}>
              {t("activity.discard")}
            </ui.Button>
          </div>
          <Show when={action.note}>
            <div class="ghp-activity-note">{action.note}</div>
          </Show>
          <Show when={action.payload.body}>
            {(body) => (
              <Clamp lines={3}>
                <div class="ghp-activity-text">{body()}</div>
              </Clamp>
            )}
          </Show>
        </div>
      )}
    </For>
  )
}

/** Which rows of a list the agent touched in this session: waiting for approval, or done. */
export function agentMarks(queue: AgentQueue | undefined, repo: string) {
  const mine = (queue?.actions ?? []).filter((action) => action.repo === repo && action.source !== "user")
  const numbers = (status: AgentAction["status"]) => mine.filter((action) => action.status === status).map((action) => action.number)
  // A pending proposal outweighs what is already done.
  return new Map<number, "pending" | "done">([...numbers("done").map((number) => [number, "done"] as const), ...numbers("proposed").map((number) => [number, "pending"] as const)])
}

/** The pill above the composer: what waits for approval, what failed, or what is done, with a way to the activity page. */
export function createAgentPill(ctx: Context, actions: Actions): ComposerPill {
  const q = actions.queries
  // One query per session that showed a pill, outside any view, so switching sessions keeps their data.
  const roots = new Map<string, { queue: () => AgentQueue | undefined; dispose: () => void }>()
  const watch = (sessionID: string) => {
    const known = roots.get(sessionID)
    if (known) return known.queue
    const made = createRoot((dispose) => {
      const result = q.query(() => q.options.agent(sessionID))
      return { queue: () => result.data, dispose }
    })
    roots.set(sessionID, made)
    ;[...roots.keys()].slice(0, Math.max(0, roots.size - 20)).forEach((old) => {
      roots.get(old)?.dispose()
      roots.delete(old)
    })
    return made.queue
  }
  return {
    id: "agent",
    order: 20,
    show: (input) => {
      const sessionID = input.session.id
      const list = watch(sessionID)()?.actions ?? []
      if (list.length === 0) return undefined
      const count = counts(list)
      const proposed = list.filter((action) => action.status === "proposed")
      const state =
        count.proposed > 0
          ? { label: ctx.t("activity.pill.approve", { count: count.proposed }), tone: "warning" as const }
          : count.failed > 0
            ? { label: ctx.t("activity.pill.failed", { count: count.failed }), tone: "danger" as const }
            : count.running > 0
              ? { label: ctx.t("activity.pill.running", { count: count.running }), tone: undefined }
              : { label: ctx.t("activity.pill.done", { count: count.done }), tone: "success" as const }
      const recent = list.toSorted((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)
      const rows: ComposerPillRow[] = [
        ...(proposed.length > 0
          ? [
              {
                id: "approve",
                label: ctx.t("activity.pill.approveAll", { count: proposed.length }),
                icon: "check" as const,
                run: () => void actions.agent.decide(sessionID, proposed.map((action) => action.id), "approve"),
              },
            ]
          : []),
        { id: "review", label: ctx.t("activity.pill.review"), icon: "checklist", run: actions.openActivity },
        ...recent.map(
          (action): ComposerPillRow => ({
            id: action.id,
            label: `#${action.number} ${describeAction(ctx.t, action)}`,
            detail: ctx.t(`activity.status.${action.status}`),
            tone: action.status === "failed" ? "danger" : action.status === "proposed" ? "warning" : action.status === "done" ? "success" : undefined,
            run: () => actions.openItem(refOf(action)),
          }),
        ),
      ]
      return { label: state.label, icon: "github", ...(state.tone ? { tone: state.tone } : {}), title: ctx.t("activity.pill.title"), rows }
    },
  }
}

type Ctx = ReturnType<typeof usePlugin<typeof definition>>

function refOf(action: AgentAction): ItemRef {
  return { repo: action.repo, number: action.number }
}

/** Opens a dialog to change a proposed action's comment, reason or names before approving it. */
export function editAction(ctx: Ctx, actions: Actions, action: AgentAction) {
  ctx.dialogs.open((dialog) => (
    <EditAction
      ctx={ctx}
      action={action}
      onSave={async (edit) => {
        const saved = await actions.attempt(() => actions.git.agentEdit({ sessionID: action.sessionID, id: action.id, ...edit }))
        if (saved) dialog.close()
      }}
    />
  ))
}

function EditAction(props: {
  ctx: Ctx
  action: AgentAction
  onSave: (edit: { body?: string; reason?: "completed" | "not_planned" | "duplicate"; duplicateOf?: number | null; add?: string[]; remove?: string[] }) => Promise<void>
}) {
  const ui = props.ctx.ui
  const t = props.ctx.t
  const payload = props.action.payload
  const kind = props.action.kind
  const [body, setBody] = createSignal(payload.body ?? "")
  const [reason, setReason] = createSignal(payload.reason ?? "completed")
  const [duplicate, setDuplicate] = createSignal(payload.duplicateOf ? String(payload.duplicateOf) : "")
  const [add, setAdd] = createSignal((payload.add ?? []).join(", "))
  const [remove, setRemove] = createSignal((payload.remove ?? []).join(", "))
  const [busy, setBusy] = createSignal(false)
  const split = (text: string) => text.split(",").map((name) => name.trim()).filter(Boolean)
  const save = async () => {
    if (busy()) return
    setBusy(true)
    await props.onSave(
      kind === "label" || kind === "assign"
        ? { add: split(add()), remove: split(remove()) }
        : kind === "close"
          ? { body: body(), reason: reason(), duplicateOf: reason() === "duplicate" ? Number(duplicate().replace("#", "")) || null : null }
          : { body: body() },
    )
    setBusy(false)
  }
  return (
    <ui.Dialog
      title={t("activity.dialog.title")}
      description={`${props.action.repo}#${props.action.number} ${props.action.title}`}
      size="normal"
      footer={
        <div class="ghp-dialog-footer">
          <ui.Button variant="contrast" icon="check" busy={busy()} onClick={() => void save()}>
            {t("activity.dialog.save")}
          </ui.Button>
        </div>
      }
    >
      <div class="ghp-form">
        <Show when={kind === "close" && props.action.item !== "pr"}>
          <span class="ghp-field-label">{t("activity.dialog.reason")}</span>
          <div class="ghp-segmented">
            <For each={["completed", "not_planned", "duplicate"] as const}>
              {(value) => (
                <button type="button" data-selected={reason() === value ? "" : undefined} onClick={() => setReason(value)}>
                  {t(`activity.reason.${value}`)}
                </button>
              )}
            </For>
          </div>
          <Show when={reason() === "duplicate"}>
            <ui.TextInput label={t("activity.dialog.duplicateOf")} value={duplicate()} onInput={setDuplicate} />
          </Show>
        </Show>
        <Show when={kind === "comment" || kind === "close" || kind === "reopen"}>
          <CommentField ctx={props.ctx} repo={props.action.repo} label={t("activity.dialog.body")} value={body()} onInput={setBody} rows={8} />
        </Show>
        <Show when={kind === "label" || kind === "assign"}>
          <ui.TextInput label={t("activity.dialog.add")} value={add()} autofocus onInput={setAdd} onSubmit={() => void save()} />
          <ui.TextInput label={t("activity.dialog.remove")} value={remove()} onInput={setRemove} onSubmit={() => void save()} />
        </Show>
      </div>
    </ui.Dialog>
  )
}
