import { createEffect, createMemo, createRoot, createSignal, createUniqueId, For, on, onCleanup, Show } from "solid-js"
import type { Context, ToastHandle, UiMenuEntry } from "@opencode/plugin/gui"
import { errorMessage } from "./actions"
import { firstLine } from "./fold"
import { LabelPill } from "./item"
import type { State } from "./panel"
import { itemList, MAX_BATCH, triagePrompt } from "./plan"
import { GitRpc } from "./rpc"
import type { agentMethods, AgentAction, CloseReason, Label, SearchItem, TriageStart } from "./schemas"

type Kind = "pr" | "issue"
type Ctx = State["ctx"]
type Reply = NonNullable<Ctx["stores"]["prefs"]["value"]["savedReplies"]>[number]
type Agent = typeof agentMethods
type Write = Omit<Agent["agentQueue"]["input"]["Type"], "sessionID" | "repo" | "numbers">

const FINAL: readonly AgentAction["status"][] = ["done", "failed", "skipped", "undone"]
const BATCH = 20

/**
 * Calls a method only the server part has (the user's bulk writes, a triage run) on the routed session's server. They
 * are not in the window's Git client: the main process, its fallback, keeps no agent queue.
 */
export function serverCall<Name extends keyof Agent>(ctx: Context, name: Name, input: Agent[Name]["input"]["Type"]): Promise<Agent[Name]["output"]["Type"]> {
  const session = ctx.sessions.current()
  if (!session) return Promise.reject(new Error(ctx.t("toast.noComposer")))
  // SAFETY: GitRpc is built from `serverMethods`, which has each agent method with these inputs and outputs.
  const rpc = session.server.client.rpc(GitRpc) as unknown as Record<Name, (input: unknown, options: object) => Promise<Agent[Name]["output"]["Type"]>>
  return rpc[name](input, { location: { directory: session.directory } }).catch((error: unknown) => Promise.reject(new Error(errorMessage(error))))
}

/* Saved replies: per repository, in the preferences. */

export function repliesOf(ctx: Ctx, repo: string) {
  return (ctx.stores.prefs.value.savedReplies ?? []).filter((reply) => reply.repo === repo)
}

/** A menu that inserts one of the repository's saved replies into a comment box, and manages them. */
export function ReplyMenu(props: { ctx: Ctx; repo: string; onInsert: (body: string) => void }) {
  const ui = props.ctx.ui
  const t = props.ctx.t
  const items = (): UiMenuEntry[] => {
    const replies = repliesOf(props.ctx, props.repo)
    return [
      ...replies.map((reply) => ({ label: reply.name, onSelect: () => props.onInsert(reply.body) })),
      ...(replies.length > 0 ? [{ type: "separator" as const }] : []),
      { label: t("triage.replies.add"), icon: "plus" as const, onSelect: () => editReply(props.ctx, props.repo) },
      { label: t("triage.replies.manage"), icon: "edit" as const, onSelect: () => manageReplies(props.ctx, props.repo) },
    ]
  }
  return (
    <span class="ghp-reply-menu">
      <ui.Menu label={t("triage.replies.insert")} trigger="button" icon="speech-bubble" placement="bottom-end" items={items()} />
    </span>
  )
}

/** Appends a saved reply to what a comment box holds. */
export function withReply(text: string, reply: string) {
  return text.trim() ? `${text.trimEnd()}\n\n${reply}` : reply
}

export function manageReplies(ctx: Ctx, repo: string) {
  ctx.dialogs.open(() => <RepliesDialog ctx={ctx} repo={repo} />)
}

function RepliesDialog(props: { ctx: Ctx; repo: string }) {
  const ui = props.ctx.ui
  const t = props.ctx.t
  const remove = async (reply: Reply) => {
    const ok = await props.ctx.dialogs.confirm({ title: t("triage.replies.deleteConfirm", { name: reply.name }), confirm: t("dialog.delete"), danger: true })
    if (!ok) return
    props.ctx.stores.prefs.update((draft) => {
      draft.savedReplies = (draft.savedReplies ?? []).filter((item) => item.id !== reply.id)
    })
  }
  return (
    <ui.Dialog
      title={t("triage.replies.title")}
      description={t("triage.replies.description", { repo: props.repo })}
      size="normal"
      footer={
        <div class="ghp-dialog-footer">
          <ui.Button variant="contrast" icon="plus" onClick={() => editReply(props.ctx, props.repo)}>
            {t("triage.replies.add")}
          </ui.Button>
        </div>
      }
    >
      <div class="ghp-replies">
        <For each={repliesOf(props.ctx, props.repo)} fallback={<div class="ghp-faint ghp-pad">{t("triage.replies.empty")}</div>}>
          {(reply) => (
            <div class="ghp-reply">
              <div class="ghp-reply-text">
                <span class="ghp-reply-name ghp-ellipsis">{reply.name}</span>
                <span class="ghp-faint ghp-ellipsis">{firstLine(reply.body)}</span>
              </div>
              <ui.IconButton icon="edit" label={t("triage.replies.edit", { name: reply.name })} size="small" variant="ghost" onClick={() => editReply(props.ctx, props.repo, reply)} />
              <ui.IconButton icon="trash" label={t("triage.replies.delete", { name: reply.name })} size="small" variant="ghost" onClick={() => void remove(reply)} />
            </div>
          )}
        </For>
      </div>
    </ui.Dialog>
  )
}

export function editReply(ctx: Ctx, repo: string, reply?: Reply) {
  ctx.dialogs.open((dialog) => (
    <ReplyEditor
      ctx={ctx}
      reply={reply}
      onSave={(name, body) => {
        ctx.stores.prefs.update((draft) => {
          const list = draft.savedReplies ?? []
          draft.savedReplies = reply
            ? list.map((item) => (item.id === reply.id ? { ...item, name, body } : item))
            : [...list, { id: crypto.randomUUID(), repo, name, body }]
        })
        dialog.close()
      }}
    />
  ))
}

function ReplyEditor(props: { ctx: Ctx; reply?: Reply; onSave: (name: string, body: string) => void }) {
  const ui = props.ctx.ui
  const t = props.ctx.t
  const [name, setName] = createSignal(props.reply?.name ?? "")
  const [body, setBody] = createSignal(props.reply?.body ?? "")
  const ready = () => !!name().trim() && !!body().trim()
  const save = () => {
    if (ready()) props.onSave(name().trim(), body())
  }
  return (
    <ui.Dialog
      title={props.reply ? t("triage.replies.editTitle") : t("triage.replies.newTitle")}
      size="normal"
      footer={
        <div class="ghp-dialog-footer">
          <ui.Button variant="contrast" icon="check" disabled={!ready()} onClick={save}>
            {t("triage.replies.save")}
          </ui.Button>
        </div>
      }
    >
      <div class="ghp-form">
        <ui.TextInput label={t("triage.replies.name")} placeholder={t("triage.replies.name")} value={name()} autofocus onInput={setName} />
        <label class="ghp-field">
          <span class="ghp-field-label">{t("triage.replies.body")}</span>
          <textarea class="ghp-textarea" rows={8} value={body()} onInput={(event) => setBody(event.currentTarget.value)} />
        </label>
      </div>
    </ui.Dialog>
  )
}

/* Bulk actions on the rows selected in a list. */

/** The bar that takes the results line's place while rows are selected. */
export function BulkBar(props: { state: State; kind: Kind; repo: string; items: readonly SearchItem[]; loaded: number; onClear: () => void; onSelectAll: () => void }) {
  const s = props.state
  const ctx = s.ctx
  const ui = ctx.ui
  const t = ctx.t
  const count = () => props.items.length
  const noun = () => ctx.plural(`triage.noun.${props.kind}`, count())
  const numbers = () => props.items.map((item) => item.number)

  /** Queues the write for the selected rows; the selection clears once it is queued. */
  const run = async (write: Write, title: string) => {
    const result = await s.actions.attempt(() => serverCall(ctx, "agentQueue", { sessionID: s.session.id, repo: props.repo, numbers: numbers(), ...write }))
    if (!result) return false
    track(s, result, title)
    props.onClear()
    return true
  }

  const confirm = (title: string) => (count() > 1 ? ctx.dialogs.confirm({ title, confirm: t("triage.bulk.confirm"), danger: true }) : Promise.resolve(true))

  const close = () =>
    ctx.dialogs.open((dialog) => (
      <CloseDialog
        ctx={ctx}
        repo={props.repo}
        kind={props.kind}
        title={t("triage.bulk.closeTitle", { what: noun() })}
        onSubmit={async (write) => {
          const reason = props.kind === "pr" ? "" : ` ${t(`triage.reason.${write.reason ?? "completed"}`, { number: write.duplicateOf ?? "" })}`
          if (!(await confirm(t("triage.bulk.confirmClose", { what: noun(), reason })))) return
          if (await run(write, t("triage.bulk.closing", { what: noun() }))) dialog.close()
        }}
      />
    ))

  const reopen = async () => {
    if (!(await confirm(t("triage.bulk.confirmReopen", { what: noun() })))) return
    await run({ kind: "reopen" }, t("triage.bulk.reopening", { what: noun() }))
  }

  const comment = () =>
    ctx.dialogs.open((dialog) => (
      <CommentDialog
        ctx={ctx}
        repo={props.repo}
        title={t("triage.bulk.commentTitle", { what: noun() })}
        onSubmit={async (body) => {
          if (await run({ kind: "comment", body }, t("triage.bulk.commenting", { what: noun() }))) dialog.close()
        }}
      />
    ))

  const names = async (kind: "label" | "assign") => {
    const meta = await s.actions.attempt(() => s.actions.queries.client.fetchQuery(s.actions.queries.options.meta(props.repo)))
    if (!meta) return
    const options = kind === "label" ? meta.labels.map((label) => ({ value: label.name, label })) : ["@me", ...meta.people].map((value) => ({ value }))
    ctx.dialogs.open((dialog) => (
      <NamesDialog
        ctx={ctx}
        kind={kind}
        title={t(kind === "label" ? "triage.bulk.labelTitle" : "triage.bulk.assignTitle", { what: noun() })}
        options={options}
        onSubmit={async (mode, picked) => {
          const write = mode === "add" ? { add: picked, remove: [] } : { add: [], remove: picked }
          if (await run({ kind, ...write }, t(kind === "label" ? "triage.bulk.labeling" : "triage.bulk.assigning", { what: noun() }))) dialog.close()
        }}
      />
    ))
  }

  const ask = () =>
    s.actions.attach({
      label: t("triage.bulk.askLabel", { what: noun(), repo: props.repo }),
      subject: `${props.repo} ${numbers()
        .map((number) => `#${number}`)
        .join(" ")}`,
      text: itemList(props.repo, props.kind, props.items),
    })

  const triage = () => openTriage(s, { kind: props.kind, repo: props.repo, query: null, numbers: numbers(), total: count() })

  const more = (): UiMenuEntry[] => [
    { label: t("triage.bulk.reopen"), icon: "refresh", onSelect: () => void reopen() },
    { label: t("triage.bulk.assign"), icon: "edit", onSelect: () => void names("assign") },
    { type: "separator" },
    { label: t("triage.bulk.ask", { what: noun() }), icon: "bubble-5", onSelect: ask },
    { label: t("triage.bulk.triage", { what: noun() }), icon: "brain", onSelect: triage },
    { type: "separator" },
    { label: t("triage.bulk.selectAll", { count: props.loaded }), icon: "check", disabled: props.loaded === count(), onSelect: props.onSelectAll },
  ]

  return (
    <div class="ghp-bulk" role="toolbar" aria-label={t("triage.bulk.toolbar")}>
      <ui.Tooltip value={t("triage.bulk.clear")}>
        <ui.IconButton icon="xmark-small" label={t("triage.bulk.clear")} size="small" variant="ghost" onClick={() => props.onClear()} />
      </ui.Tooltip>
      <span class="ghp-bulk-count ghp-ellipsis">{t("triage.bulk.selected", { count: count() })}</span>
      <ui.Button size="small" variant="ghost" icon="circle-x" onClick={close}>
        {t("triage.bulk.close")}
      </ui.Button>
      <ui.Button size="small" variant="ghost" icon="edit" onClick={() => void names("label")}>
        {t("triage.bulk.label")}
      </ui.Button>
      <ui.Button size="small" variant="ghost" icon="speech-bubble" onClick={comment}>
        {t("triage.bulk.comment")}
      </ui.Button>
      <ui.Menu label={t("action.more")} trigger="icon" icon="outline-dots" placement="bottom-end" items={more()} />
    </div>
  )
}

/** Follows a queued bulk write in a toast: progress while it runs, then what failed or was left out. */
function track(s: State, result: Agent["agentQueue"]["output"]["Type"], title: string) {
  const ctx = s.ctx
  const t = ctx.t
  const q = s.actions.queries
  const sessionID = s.session.id
  const open = { label: t("triage.bulk.open"), run: () => s.actions.openActivity() }
  const left = result.skipped.map((entry) => `#${entry.number}: ${entry.reason}`)
  q.invalidate(q.keys.agent(sessionID))
  if (result.queued.length === 0) {
    ctx.toast.show({ variant: "error", title: t("triage.bulk.nothing"), description: left.join("\n"), duration: 10_000 })
    return
  }
  createRoot((dispose) => {
    const data = q.query(() => q.options.agent(sessionID))
    const mine = () => (data.data?.actions ?? []).filter((action) => action.batch === result.batch)
    const shown: { toast?: ToastHandle } = {}
    const finish = (list: readonly AgentAction[]) => {
      shown.toast?.dismiss()
      const failed = list.filter((action) => action.status === "failed")
      const description = [...failed.map((action) => `#${action.number}: ${action.error ?? ""}`), ...left].join("\n")
      ctx.toast.show({
        variant: failed.length > 0 ? "error" : "success",
        title: failed.length > 0 ? t("triage.bulk.failed", { count: failed.length, total: list.length }) : t("triage.bulk.done", { title }),
        ...(description ? { description } : {}),
        ...(failed.length > 0 || left.length > 0 ? { duration: 15_000 } : {}),
        actions: [open],
      })
      queueMicrotask(dispose)
    }
    createEffect(
      on(
        () => mine().filter((action) => FINAL.includes(action.status)).length,
        (done) => {
          const list = mine()
          if (list.length > 0 && done >= list.length) return finish(list)
          shown.toast?.dismiss()
          shown.toast = ctx.toast.show({ variant: "loading", persistent: true, title, description: t("triage.bulk.progress", { done, total: result.queued.length }), actions: [open] })
        },
      ),
    )
    // A lost server or a closed window must not leave the toast up for good.
    const timer = setTimeout(() => {
      shown.toast?.dismiss()
      dispose()
    }, 15 * 60_000)
    onCleanup(() => clearTimeout(timer))
  })
}

function CloseDialog(props: { ctx: Ctx; repo: string; kind: Kind; title: string; onSubmit: (write: Write) => Promise<void> }) {
  const ui = props.ctx.ui
  const t = props.ctx.t
  const [reason, setReason] = createSignal<CloseReason>("completed")
  const [duplicate, setDuplicate] = createSignal("")
  const [body, setBody] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const duplicateOf = () => Number(duplicate().trim().replace("#", "")) || undefined
  const ready = () => props.kind === "pr" || reason() !== "duplicate" || !!duplicateOf()
  const submit = async () => {
    if (busy() || !ready()) return
    setBusy(true)
    await props.onSubmit({
      kind: "close",
      ...(props.kind === "issue" ? { reason: reason() } : {}),
      ...(props.kind === "issue" && reason() === "duplicate" ? { duplicateOf: duplicateOf() } : {}),
      ...(body().trim() ? { body: body() } : {}),
    })
    setBusy(false)
  }
  return (
    <ui.Dialog
      title={props.title}
      size="normal"
      footer={
        <div class="ghp-dialog-footer">
          <ui.Button variant="contrast" icon="circle-x" busy={busy()} disabled={!ready()} onClick={() => void submit()}>
            {t("triage.bulk.closeSubmit")}
          </ui.Button>
        </div>
      }
    >
      <div class="ghp-form">
        <Show when={props.kind === "issue"}>
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
            <ui.TextInput label={t("activity.dialog.duplicateOf")} placeholder={t("activity.dialog.duplicateOf")} value={duplicate()} autofocus onInput={setDuplicate} />
          </Show>
        </Show>
        <CommentField ctx={props.ctx} repo={props.repo} label={t("triage.bulk.closeComment")} value={body()} onInput={setBody} />
      </div>
    </ui.Dialog>
  )
}

function CommentDialog(props: { ctx: Ctx; repo: string; title: string; onSubmit: (body: string) => Promise<void> }) {
  const ui = props.ctx.ui
  const t = props.ctx.t
  const [body, setBody] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const submit = async () => {
    if (busy() || !body().trim()) return
    setBusy(true)
    await props.onSubmit(body())
    setBusy(false)
  }
  return (
    <ui.Dialog
      title={props.title}
      size="normal"
      footer={
        <div class="ghp-dialog-footer">
          <ui.Button variant="contrast" icon="speech-bubble" busy={busy()} disabled={!body().trim()} onClick={() => void submit()}>
            {t("triage.bulk.commentSubmit")}
          </ui.Button>
        </div>
      }
    >
      <div class="ghp-form">
        <CommentField ctx={props.ctx} repo={props.repo} label={t("activity.dialog.body")} value={body()} onInput={setBody} rows={10} />
      </div>
    </ui.Dialog>
  )
}

/** A comment box with the saved replies menu next to its label. */
export function CommentField(props: { ctx: Ctx; repo: string; label: string; value: string; onInput: (value: string) => void; rows?: number }) {
  return (
    <div class="ghp-field">
      <div class="ghp-field-head">
        <span class="ghp-field-label">{props.label}</span>
        <ReplyMenu ctx={props.ctx} repo={props.repo} onInsert={(reply) => props.onInput(withReply(props.value, reply))} />
      </div>
      <textarea class="ghp-textarea" aria-label={props.label} rows={props.rows ?? 6} value={props.value} onInput={(event) => props.onInput(event.currentTarget.value)} />
    </div>
  )
}

/** Picks labels or people to add to, or remove from, the selected rows. */
function NamesDialog(props: {
  ctx: Ctx
  kind: "label" | "assign"
  title: string
  options: readonly { value: string; label?: Label }[]
  onSubmit: (mode: "add" | "remove", names: string[]) => Promise<void>
}) {
  const ui = props.ctx.ui
  const t = props.ctx.t
  const id = createUniqueId()
  const [mode, setMode] = createSignal<"add" | "remove">("add")
  const [query, setQuery] = createSignal("")
  const [picked, setPicked] = createSignal<readonly string[]>([])
  const [active, setActive] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const visible = createMemo(() => {
    const typed = query().trim()
    const needle = typed.toLowerCase()
    const matches = props.options.filter((option) => option.value.toLowerCase().includes(needle)).slice(0, 200)
    const custom = props.kind === "assign" && typed && !props.options.some((option) => option.value.toLowerCase() === needle)
    return custom ? [...matches, { value: typed.replace(/^@(?!me$)/, "") }] : matches
  })
  createEffect(on(query, () => setActive(0), { defer: true }))
  createEffect(() => document.getElementById(`${id}-${active()}`)?.scrollIntoView({ block: "nearest" }))
  const toggle = (value: string) => setPicked(picked().includes(value) ? picked().filter((item) => item !== value) : [...picked(), value])
  const submit = async () => {
    if (busy() || picked().length === 0) return
    setBusy(true)
    await props.onSubmit(mode(), [...picked()])
    setBusy(false)
  }
  return (
    <ui.Dialog
      title={props.title}
      size="large"
      footer={
        <div class="ghp-dialog-footer">
          <span class="ghp-faint ghp-grow ghp-ellipsis">{picked().join(", ")}</span>
          <ui.Button variant="contrast" icon="check" busy={busy()} disabled={picked().length === 0} onClick={() => void submit()}>
            {t(`triage.names.${props.kind}.${mode()}`, { count: picked().length })}
          </ui.Button>
        </div>
      }
    >
      <div
        class="ghp-form"
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            const count = visible().length
            if (count > 0) setActive((active() + (event.key === "ArrowDown" ? 1 : count - 1)) % count)
            return
          }
          if (event.key !== "Enter" || event.isComposing) return
          event.preventDefault()
          const option = visible()[active()]
          if (option) toggle(option.value)
        }}
      >
        <div class="ghp-segmented">
          <For each={["add", "remove"] as const}>
            {(value) => (
              <button type="button" data-selected={mode() === value ? "" : undefined} onClick={() => setMode(value)}>
                {t(`triage.names.${value}`)}
              </button>
            )}
          </For>
        </div>
        <ui.TextInput label={t("edit.filter")} placeholder={t("edit.filter")} type="search" value={query()} onInput={setQuery} autofocus />
        <div class="ghp-list-picks" role="listbox" aria-multiselectable="true" aria-label={props.title}>
          <For each={visible()} fallback={<div class="ghp-faint ghp-pad">{t("edit.nothing")}</div>}>
            {(option, index) => (
              <div
                class="ghp-list-pick"
                id={`${id}-${index()}`}
                role="option"
                aria-selected={picked().includes(option.value)}
                data-active={active() === index() ? "" : undefined}
                onMouseMove={() => setActive(index())}
                onClick={() => toggle(option.value)}
              >
                <span class="ghp-pick-check" data-checked={picked().includes(option.value) ? "" : undefined}>
                  <Show when={picked().includes(option.value)}>
                    <ui.Icon name="check-small" size="small" />
                  </Show>
                </span>
                <Show when={option.label} fallback={<span class="ghp-ellipsis">{option.value}</span>}>
                  {(label) => <LabelPill label={label()} />}
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>
    </ui.Dialog>
  )
}

/* Triage with the agent. */

/** Opens the triage form for a search or for picked items; Start opens a new session that works through them. */
export function openTriage(s: State, input: { kind: Kind; repo: string; query: string | null; numbers: readonly number[]; total: number }) {
  s.ctx.dialogs.open((dialog) => (
    <TriageDialog
      ctx={s.ctx}
      input={input}
      onStart={async (start) => {
        if (await startTriage(s, start)) dialog.close()
      }}
    />
  ))
}

function TriageDialog(props: {
  ctx: Ctx
  input: { kind: Kind; repo: string; query: string | null; numbers: readonly number[]; total: number }
  onStart: (start: TriageStart) => Promise<void>
}) {
  const ctx = props.ctx
  const ui = ctx.ui
  const t = ctx.t
  const repo = props.input.repo
  const [rules, setRules] = createSignal(ctx.stores.prefs.value.triageRules?.[repo] ?? "")
  const [batch, setBatch] = createSignal(String(BATCH))
  const [left, setLeft] = createSignal<readonly string[]>([])
  const [busy, setBusy] = createSignal(false)
  const replies = () => repliesOf(ctx, repo)
  const chosen = () => replies().filter((reply) => !left().includes(reply.id))
  const size = () => Math.min(MAX_BATCH, Math.max(1, Math.floor(Number(batch())) || BATCH))
  const noun = () => ctx.plural(`triage.noun.${props.input.kind}`, props.input.total)
  const start = async () => {
    if (busy() || props.input.total === 0) return
    setBusy(true)
    ctx.stores.prefs.update((draft) => {
      draft.triageRules = { ...draft.triageRules, [repo]: rules() }
    })
    await props.onStart({
      repo,
      kind: props.input.kind,
      query: props.input.query,
      numbers: [...props.input.numbers],
      rules: rules(),
      replies: chosen().map((reply) => ({ name: reply.name, body: reply.body })),
      batch: size(),
      total: props.input.total,
    })
    setBusy(false)
  }
  return (
    <ui.Dialog
      title={t("triage.dialog.title")}
      description={t("triage.dialog.description")}
      size="large"
      footer={
        <div class="ghp-dialog-footer">
          <ui.Button variant="contrast" icon="brain" busy={busy()} disabled={props.input.total === 0} onClick={() => void start()}>
            {t("triage.dialog.start", { what: noun() })}
          </ui.Button>
        </div>
      }
    >
      <div class="ghp-form ghp-triage-form">
        <div class="ghp-field">
          <span class="ghp-field-label">{t("triage.dialog.source")}</span>
          <div class="ghp-triage-source">
            <Show
              when={props.input.query}
              fallback={
                <span class="ghp-ellipsis">
                  {props.input.numbers
                    .slice(0, 30)
                    .map((number) => `#${number}`)
                    .join(", ")}
                  {props.input.numbers.length > 30 ? " …" : ""}
                </span>
              }
            >
              {(query) => <code class="ghp-triage-query ghp-ellipsis">{query()}</code>}
            </Show>
            <span class="ghp-faint">
              {repo} · {noun()}
            </span>
          </div>
        </div>
        <label class="ghp-field">
          <span class="ghp-field-label">{t("triage.dialog.rules")}</span>
          <textarea class="ghp-textarea" rows={7} placeholder={t("triage.dialog.rulesPlaceholder")} value={rules()} onInput={(event) => setRules(event.currentTarget.value)} />
        </label>
        <div class="ghp-field">
          <div class="ghp-field-head">
            <span class="ghp-field-label">{t("triage.dialog.replies")}</span>
            <ui.Button size="small" variant="ghost" icon="edit" onClick={() => manageReplies(ctx, repo)}>
              {t("triage.replies.manage")}
            </ui.Button>
          </div>
          <Show when={replies().length > 0} fallback={<span class="ghp-faint ghp-hint">{t("triage.dialog.noReplies")}</span>}>
            <div class="ghp-triage-replies">
              <For each={replies()}>
                {(reply) => (
                  <ui.Switch
                    label={reply.name}
                    description={firstLine(reply.body)}
                    checked={!left().includes(reply.id)}
                    onChange={(on) => setLeft(on ? left().filter((id) => id !== reply.id) : [...left(), reply.id])}
                  />
                )}
              </For>
            </div>
          </Show>
        </div>
        <div class="ghp-triage-batch">
          <ui.TextInput label={t("triage.dialog.batch")} value={batch()} onInput={setBatch} onSubmit={() => void start()} />
          <span class="ghp-faint">{t("triage.dialog.batchHint", { count: size() })}</span>
        </div>
      </div>
    </ui.Dialog>
  )
}

/**
 * Starts a triage run: a new session in the same directory, marked as a triage run on the server, sent its first prompt
 * at once, then shown with its activity page. Without session creation it falls back to a draft with the prompt.
 */
async function startTriage(s: State, start: TriageStart) {
  const ctx = s.ctx
  const t = ctx.t
  const session = ctx.sessions.current()
  if (!session) {
    ctx.toast.show({ variant: "error", title: t("toast.noComposer") })
    return false
  }
  const text = triagePrompt(start)
  const model = ctx.screen.current()?.composer.model()
  const title = t("triage.sessionTitle", { what: start.query ?? ctx.plural(`triage.noun.${start.kind}`, start.total) })
  const info = await session.server.client.session
    .create({
      title: title.length > 80 ? `${title.slice(0, 79)}…` : title,
      location: { directory: session.directory },
      ...(model ? { model: { id: model.modelID, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) } } : {}),
    })
    .catch(() => undefined)
  if (!info) {
    ctx.layout.draft({ server: session.server.id, directory: session.directory, prompt: text })
    ctx.toast.show({ title: t("triage.draft") })
    return true
  }
  const started = await s.actions.attempt(async () => {
    await serverCall(ctx, "agentTriage", { sessionID: info.id, triage: start })
    await session.server.client.session.prompt({ sessionID: info.id, text })
    return true
  })
  ctx.tabs.open({ server: session.server.id, id: info.id }, { focus: true })
  if (started) showActivity(s, info.id)
  return true
}

/** Opens the activity page once the new session is routed. */
function showActivity(s: State, sessionID: string) {
  createRoot((dispose) => {
    createEffect(() => {
      if (s.ctx.sessions.current()?.id !== sessionID) return
      s.actions.openActivity()
      queueMicrotask(dispose)
    })
    const timer = setTimeout(dispose, 15_000)
    onCleanup(() => clearTimeout(timer))
  })
}
