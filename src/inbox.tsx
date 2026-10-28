import { createSignal, For, Show } from "solid-js"
import { usePlugin, type UiMenuEntry } from "@opencode/plugin/gui"
import { latest } from "./queries"
import { errorMessage, type Actions } from "./actions"
import type { InboxEntry } from "./contract"
import { createFolds, Group } from "./fold"
import { IssueIcon } from "./item"
import { ago, PrIcon } from "./panel"

/** Notifications, review requests, assigned issues and your open pull requests across every repository. */
export function InboxView(props: { actions: Actions; onCount?: (count: number) => void }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  const git = props.actions.git
  const q = props.actions.queries
  const [unreadOnly, setUnreadOnly] = createSignal(true)
  const [marking, setMarking] = createSignal(false)
  const refresh = () => q.invalidate(q.keys.inbox())
  const inbox = latest(q.query(() => ({ ...q.options.inbox(), refetchInterval: 60_000 })))
  const notifications = () => (inbox.latest?.notifications ?? []).filter((entry) => !unreadOnly() || entry.unread)

  // Marks every notification on GitHub read, not only the ones listed here, so it asks first.
  const markAll = async () => {
    if (marking()) return
    const ok = await ctx.dialogs.confirm({ title: t("inbox.markAll"), confirm: t("inbox.markAll") })
    if (!ok) return
    setMarking(true)
    await props.actions.attempt(() => git.markRead({ thread: null }))
    setMarking(false)
  }

  // Folded sections and repositories stay folded across the minute's refetch.
  const folds = createFolds()
  // Repositories in the order of their latest notification.
  const repos = () => [...new Set(notifications().map((entry) => entry.repo))]
  const byRepo = (repo: string) => notifications().filter((entry) => entry.repo === repo)
  // Fixed objects with accessors, so a refetch does not remount the sections.
  const sections = [
    { id: "reviews", title: () => t("inbox.reviews"), entries: () => inbox.latest?.reviews ?? [] },
    { id: "assigned", title: () => t("inbox.assigned"), entries: () => inbox.latest?.assigned ?? [] },
    { id: "authored", title: () => t("inbox.authored"), entries: () => inbox.latest?.authored ?? [] },
  ]

  return (
    <div class="ghp-pulls">
      <div class="ghp-toolbar">
        <div class="ghp-segmented">
          <button type="button" data-selected={unreadOnly() ? "" : undefined} onClick={() => setUnreadOnly(true)}>
            {t("inbox.unread")}
          </button>
          <button type="button" data-selected={unreadOnly() ? undefined : ""} onClick={() => setUnreadOnly(false)}>
            {t("inbox.allNotifications")}
          </button>
        </div>
        <div class="ghp-spacer" />
        <Show when={inbox.loading}>
          <ui.Loader size="small" />
        </Show>
        <ui.Tooltip value={t("inbox.markAll")}>
          <ui.IconButton
            icon="check"
            label={t("inbox.markAll")}
            size="small"
            variant="ghost"
            disabled={marking() || !inbox.latest?.notifications.some((entry) => entry.unread)}
            onClick={() => void markAll()}
          />
        </ui.Tooltip>
        <ui.Tooltip value={t("action.refresh")}>
          <ui.IconButton icon="refresh" label={t("action.refresh")} size="small" variant="ghost" onClick={refresh} />
        </ui.Tooltip>
      </div>
      <Show
        when={inbox.latest}
        fallback={
          <div class="ghp-empty ghp-empty-inline">
            <Show when={inbox.error} fallback={<ui.Loader />}>
              {errorMessage(inbox.error)}
            </Show>
          </div>
        }
      >
        <Show when={inbox.latest?.error}>
          {(error) => (
            <div class="ghp-callout" data-tone="error">
              <span>{error()}</span>
            </div>
          )}
        </Show>
        <Group
          class="ghp-inbox-section"
          title={t("inbox.notifications")}
          count={notifications().length}
          open={folds.flag("notifications", true)}
          onToggle={() => folds.setFlag("notifications", !folds.flag("notifications", true))}
        >
          <For each={repos()} fallback={<div class="ghp-faint ghp-pad">{t("inbox.empty")}</div>}>
            {(repo) => (
              <Group
                class="ghp-inbox-repo"
                title={repo}
                count={byRepo(repo).length}
                open={folds.flag(`repo:${repo}`, true)}
                onToggle={() => folds.setFlag(`repo:${repo}`, !folds.flag(`repo:${repo}`, true))}
              >
                <For each={byRepo(repo)}>{(entry) => <InboxRow entry={entry} actions={props.actions} grouped />}</For>
              </Group>
            )}
          </For>
        </Group>
        <For each={sections}>
          {(section) => (
            <Show when={section.entries().length > 0}>
              <Group
                class="ghp-inbox-section"
                title={section.title()}
                count={section.entries().length}
                open={folds.flag(section.id, true)}
                onToggle={() => folds.setFlag(section.id, !folds.flag(section.id, true))}
              >
                <For each={section.entries()}>{(entry) => <InboxRow entry={entry} actions={props.actions} />}</For>
              </Group>
            </Show>
          )}
        </For>
      </Show>
    </div>
  )
}

function InboxRow(props: { entry: InboxEntry; actions: Actions; grouped?: boolean }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  const git = props.actions.git
  // Notification reasons GitHub adds later have no copy yet; show them as GitHub names them.
  const reason = () => {
    const key = `inbox.reason.${props.entry.reason}`
    const label = t(key)
    return label === key ? props.entry.reason.replace(/_/g, " ") : label
  }
  // Opening a notification reads it, as on GitHub; that failing is not worth a toast.
  const markRead = (quiet: boolean) => {
    const thread = props.entry.thread
    if (!thread || !props.entry.unread) return
    if (quiet) return void git.markRead({ thread }).catch(() => undefined)
    void props.actions.attempt(() => git.markRead({ thread }))
  }
  const open = (external: boolean) => {
    markRead(true)
    const number = props.entry.number
    if (number !== null && props.entry.kind !== "other" && !external) return props.actions.openItem({ repo: props.entry.repo, number })
    ctx.system.openExternal(props.entry.url)
  }
  const items = (): UiMenuEntry[] => [
    { label: t("inbox.markRead"), icon: "check", disabled: !props.entry.unread || !props.entry.thread, onSelect: () => markRead(false) },
    { label: t("action.openOnGitHub"), icon: "square-arrow-top-right", onSelect: () => open(true) },
    ...(props.entry.number !== null && props.entry.kind !== "other"
      ? [{ type: "separator" as const }, ...props.actions.agentMenu({ repo: props.entry.repo, number: props.entry.number }, props.entry.kind)]
      : []),
  ]
  return (
    <div
      class="ghp-pr ghp-inbox-row"
      role="link"
      tabIndex={0}
      data-unread={props.entry.unread ? "" : undefined}
      onClick={(event) => open(event.metaKey || event.ctrlKey)}
      onKeyDown={(event) => {
        // Keys pressed in the row's menu bubble up here; only the row itself opens the entry.
        if (event.target !== event.currentTarget || event.key !== "Enter") return
        open(event.metaKey || event.ctrlKey)
      }}
    >
      <span class="ghp-pr-state" data-state="OPEN">
        <Show when={props.entry.kind === "pr"} fallback={<IssueIcon state="OPEN" />}>
          <PrIcon state="OPEN" />
        </Show>
      </span>
      <span class="ghp-inbox-title ghp-ellipsis" title={props.entry.title}>
        {props.entry.title}
      </span>
      <span class="ghp-faint ghp-inbox-where ghp-ellipsis">
        {[`${props.grouped ? "" : props.entry.repo}${props.entry.number !== null ? `#${props.entry.number}` : ""}`, ago(Date.parse(props.entry.updated) / 1000)]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <span class="ghp-pill">{reason()}</span>
      <div class="ghp-row-actions ghp-row-actions-visible" onClick={(event) => event.stopPropagation()}>
        <ui.Menu label={t("action.more")} trigger="icon" icon="outline-dots" placement="bottom-end" items={items()} />
      </div>
    </div>
  )
}
