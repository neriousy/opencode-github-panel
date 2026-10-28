import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type { Context } from "@opencode/plugin/gui"
import type { Actions } from "./actions"
import type { Item, Label } from "./contract"
import { LabelPill } from "./item"

const NONE = {
  addLabels: [],
  removeLabels: [],
  addAssignees: [],
  removeAssignees: [],
  addReviewers: [],
  removeReviewers: [],
}

/** Editing an issue's or pull request's metadata, each through one dialog. */
export function createEditor(ctx: Context, actions: Actions) {
  const git = actions.git
  const t = ctx.t

  const pick = (input: { title: string; options: readonly { value: string; label?: Label }[]; selected: readonly string[] }) =>
    new Promise<string[] | undefined>((resolve) => {
      // The dialog unmounts however it closes; resolving twice is a no-op, so Escape and outside clicks answer undefined.
      ctx.dialogs.open((dialog) => (
        <PickMany
          ctx={ctx}
          title={input.title.replace(/…$/, "")}
          options={input.options}
          selected={input.selected}
          onClose={() => resolve(undefined)}
          onDone={(value) => {
            resolve(value)
            dialog.close()
          }}
        />
      ))
    })

  const diff = (before: readonly string[], after: readonly string[]) => ({
    add: after.filter((value) => !before.includes(value)),
    remove: before.filter((value) => !after.includes(value)),
  })

  const labels = async (item: Item) => {
    const meta = await actions.attempt(() => actions.queries.client.fetchQuery(actions.queries.options.meta(item.repo)))
    if (!meta) return
    const before = item.labels.map((label) => label.name)
    const after = await pick({
      title: t("edit.labels"),
      // The repository's list stops at 200 labels; keep the item's own so they stay visible and removable.
      options: [...meta.labels, ...item.labels.filter((label) => !meta.labels.some((known) => known.name === label.name))].map((label) => ({
        value: label.name,
        label,
      })),
      selected: before,
    })
    if (!after) return
    const change = diff(before, after)
    return actions.attempt(() => git.edit({ repo: item.repo, number: item.number, kind: item.kind, ...NONE, addLabels: change.add, removeLabels: change.remove }))
  }

  const people = async (item: Item, field: "assignees" | "reviewers") => {
    const meta = await actions.attempt(() => actions.queries.client.fetchQuery(actions.queries.options.meta(item.repo)))
    if (!meta) return
    const before = field === "assignees" ? [...item.assignees] : [...(item.pr?.requested ?? [])]
    const after = await pick({
      title: t(field === "assignees" ? "edit.assignees" : "edit.reviewers"),
      // GitHub refuses a review request to the pull request's author.
      options: [...new Set([...before, ...meta.people])]
        .filter((value) => field === "assignees" || value !== item.author)
        .map((value) => ({ value })),
      selected: before,
    })
    if (!after) return
    const change = diff(before, after)
    return actions.attempt(() =>
      git.edit({
        repo: item.repo,
        number: item.number,
        kind: item.kind,
        ...NONE,
        ...(field === "assignees"
          ? { addAssignees: change.add, removeAssignees: change.remove }
          : { addReviewers: change.add, removeReviewers: change.remove }),
      }),
    )
  }

  const milestone = async (item: Item) => {
    const meta = await actions.attempt(() => actions.queries.client.fetchQuery(actions.queries.options.meta(item.repo)))
    if (!meta) return
    const picked = await ctx.dialogs.select({
      title: t("edit.milestone"),
      current: item.milestone ?? "",
      options: [{ title: t("edit.noMilestone"), value: "" }, ...meta.milestones.map((title) => ({ title, value: title }))],
    })
    if (picked === undefined || picked === (item.milestone ?? "")) return
    return actions.attempt(() => git.edit({ repo: item.repo, number: item.number, kind: item.kind, ...NONE, milestone: picked || null }))
  }

  const text = (item: Item) =>
    new Promise<void>((resolve) => {
      ctx.dialogs.open((dialog) => (
        <EditText
          ctx={ctx}
          item={item}
          onSave={async (value) => {
            const done = await actions.attempt(() =>
              git.edit({ repo: item.repo, number: item.number, kind: item.kind, ...NONE, title: value.title, body: value.body }),
            )
            if (done === undefined) return
            dialog.close()
            resolve()
          }}
        />
      ))
    })

  const draft = (item: Item) => actions.attempt(() => git.setDraft({ repo: item.repo, number: item.number, draft: !item.draft }))

  return { labels, people, milestone, text, draft }
}

function PickMany(props: {
  ctx: Context
  title: string
  options: readonly { value: string; label?: Label }[]
  selected: readonly string[]
  onDone: (value: string[]) => void
  onClose: () => void
}) {
  onCleanup(props.onClose)
  const ui = props.ctx.ui
  const t = props.ctx.t
  const [query, setQuery] = createSignal("")
  const [chosen, setChosen] = createSignal<string[]>([...props.selected])
  const visible = createMemo(() => {
    const q = query().trim().toLowerCase()
    const list = props.options.filter((option) => !q || option.value.toLowerCase().includes(q))
    // Selected when the dialog opened first, then alphabetical, so the current state is visible without scrolling.
    // Sorting by the live choice would move a row out from under the pointer as it is ticked.
    return [...list]
      .sort((a, b) => Number(props.selected.includes(b.value)) - Number(props.selected.includes(a.value)) || a.value.localeCompare(b.value))
      .slice(0, 200)
  })
  const toggle = (value: string) => setChosen(chosen().includes(value) ? chosen().filter((item) => item !== value) : [...chosen(), value])
  return (
    <ui.Dialog
      title={props.title}
      size="normal"
      footer={
        <div class="ghp-dialog-footer">
          <ui.Button variant="contrast" onClick={() => props.onDone(chosen())}>
            {t("edit.apply")}
          </ui.Button>
        </div>
      }
    >
      <div class="ghp-form">
        <ui.TextInput label={t("edit.filter")} placeholder={t("edit.filter")} type="search" value={query()} onInput={setQuery} autofocus />
        <div class="ghp-picklist">
          <For each={visible()} fallback={<div class="ghp-faint ghp-pad">{t("edit.nothing")}</div>}>
            {(option) => (
              <label class="ghp-pick">
                <input type="checkbox" checked={chosen().includes(option.value)} onChange={() => toggle(option.value)} />
                <Show when={option.label} fallback={<span>{option.value}</span>}>
                  {(label) => <LabelPill label={label()} />}
                </Show>
              </label>
            )}
          </For>
        </div>
      </div>
    </ui.Dialog>
  )
}

function EditText(props: { ctx: Context; item: Item; onSave: (value: { title: string; body: string }) => Promise<void> }) {
  const ui = props.ctx.ui
  const t = props.ctx.t
  const [title, setTitle] = createSignal(props.item.title)
  const [body, setBody] = createSignal(props.item.body)
  const [busy, setBusy] = createSignal(false)
  const save = async () => {
    if (!title().trim() || busy()) return
    setBusy(true)
    await props.onSave({ title: title().trim(), body: body() })
    setBusy(false)
  }
  return (
    <ui.Dialog
      title={t("edit.text", { number: props.item.number })}
      size="large"
      footer={
        <div class="ghp-dialog-footer">
          <ui.Button variant="contrast" busy={busy()} disabled={!title().trim()} onClick={() => void save()}>
            {t("edit.save")}
          </ui.Button>
        </div>
      }
    >
      <div class="ghp-form">
        <ui.TextInput label={t("dialog.prTitle")} value={title()} onInput={setTitle} autofocus />
        <label class="ghp-field">
          <span class="ghp-field-label">{t("dialog.prBody")}</span>
          <textarea class="ghp-textarea ghp-mono" rows={18} value={body()} onInput={(event) => setBody(event.currentTarget.value)} />
        </label>
      </div>
    </ui.Dialog>
  )
}
