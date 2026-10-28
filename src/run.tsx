import { createMemo, createSignal, For, Index, Show } from "solid-js"
import { keepPreviousData } from "@tanstack/query-core"
import { createKeyed, usePlugin, type UiMenuEntry } from "@opencode/plugin/gui"
import { latest } from "./queries"
import { errorMessage, type Actions } from "./actions"
import { jobContext } from "./context"
import type { Job } from "./contract"
import { Chevron, createFolds, type Folds } from "./fold"
import { ago } from "./panel"
import { RunRow, RunStatus } from "./pr"

const LOG_LINES = 3000

/** A side tab with one GitHub Actions run: its jobs, steps and logs. */
export function RunView(props: { repo: string; id: number; actions: Actions }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  const git = props.actions.git
  const q = props.actions.queries
  const [chosen, setChosen] = createSignal<number | undefined>(Number(props.actions.takeFocus({ kind: "run", repo: props.repo, id: props.id })) || undefined)
  const refresh = () => {
    q.invalidate(q.keys.run(props.repo, props.id))
    const current = job()
    if (current) q.invalidate(q.keys.job(props.repo, current.id))
  }

  // GitHub lists a re-run as queued only after a few seconds; until then the run still reads as completed.
  const rerun = { until: 0 }
  const data = latest(
    q.query(() => ({
      ...q.options.run(props.repo, props.id),
      // Follows a run that is still going, so its jobs and log fill in.
      refetchInterval: (query) => {
        if (query.state.data && query.state.data.run.status !== "completed") return 5000
        return Date.now() < rerun.until ? 3000 : false
      },
    })),
  )
  const active = () => !!data.latest && data.latest.run.status !== "completed"

  const job = createMemo((): Job | undefined => {
    const jobs = data.latest?.jobs ?? []
    return jobs.find((item) => item.id === chosen()) ?? jobs.find((item) => item.conclusion === "failure") ?? jobs[0]
  })
  const log = latest(
    q.query(() => {
      const current = job()
      const done = current?.status === "completed"
      return {
        ...q.options.job(props.repo, current?.id ?? 0, done),
        enabled: !!current && current.status !== "queued",
        refetchInterval: done ? false : 5000,
      }
    }),
  )
  // A finished job's log never goes stale, so a log last read while the job ran (or just as it ended, before the
  // runner uploaded the rest) would stay cut off; read it once more.
  createKeyed(
    () => {
      const current = job()
      return current?.status === "completed" && current.completed ? current : undefined
    },
    (current) => {
      const state = q.client.getQueryState(q.keys.job(props.repo, current.id))
      if (state?.data !== undefined && state.dataUpdatedAt < Date.parse(current.completed ?? "") + 30_000) q.invalidate(q.keys.job(props.repo, current.id))
    },
    { equals: (previous, next) => previous.id === next.id },
  )
  // Failed and running jobs start open with their steps; the rest fold to one row. Choosing a job shows its log.
  const folds = createFolds()
  const jobOpen = (item: Job) => !folds.folded(`job:${item.id}`, item.status === "completed" && item.conclusion !== "failure")
  const pickJob = (item: Job) => {
    if (job()?.id !== item.id) {
      setChosen(item.id)
      folds.fold(`job:${item.id}`, false)
      return
    }
    folds.fold(`job:${item.id}`, jobOpen(item))
  }
  const [busy, setBusy] = createSignal<string>()
  const act = async (id: string, work: () => Promise<unknown>, success?: string) => {
    if (busy()) return
    setBusy(id)
    const done = await props.actions.attempt(work, success)
    setBusy(undefined)
    if (done === undefined || id === "cancel") return
    rerun.until = Date.now() + 30_000
    refresh()
  }

  const more = (): UiMenuEntry[] => [
    { label: t("action.openOnGitHub"), icon: "square-arrow-top-right", onSelect: () => data.latest && ctx.system.openExternal(data.latest.run.url) },
    { label: t("run.copyLog"), icon: "copy", disabled: !log.latest, onSelect: () => log.latest && void props.actions.copy(log.latest) },
    { label: t("action.refresh"), icon: "refresh", onSelect: refresh },
  ]

  const context = () => {
    const current = job()
    const details = data.latest
    if (!current || !details || log.latest === undefined) return undefined
    return jobContext(props.repo, details, current, log.latest)
  }
  const agentItems = (): UiMenuEntry[] => [
    { label: t("action.addToChat"), icon: "bubble-5", onSelect: () => context() && props.actions.attach(context()!) },
    { label: t("agent.preset.job"), icon: "brain", onSelect: () => context() && props.actions.attach(context()!, t("agent.prompt.job")) },
    { type: "separator" },
    { label: t("agent.newSession"), icon: "new-session", onSelect: () => context() && props.actions.startSession(context()!, t("agent.prompt.job")) },
  ]

  return (
    <div class="ghp ghp-item" data-repo={props.repo} data-ghp-source={`the GitHub Actions run ${props.repo} ${props.id}`} data-ghp-label="CI">
      <Show
        when={data.latest}
        fallback={
          <div class="ghp-empty">
            <Show when={data.error} fallback={<ui.Loader />}>
              <span>{errorMessage(data.error)}</span>
              <ui.Button size="small" variant="neutral" icon="refresh" onClick={refresh}>
                {t("action.retry")}
              </ui.Button>
            </Show>
          </div>
        }
      >
        {(details) => (
          <div class="ghp-item-scroll">
            <header class="ghp-item-header">
              <div class="ghp-item-top">
                <RunStatus status={details().run.status} conclusion={details().run.conclusion} />
                <span class="ghp-faint ghp-ellipsis">
                  {props.repo} · {details().run.workflow}
                </span>
                <div class="ghp-spacer" />
                <Show when={data.loading}>
                  <ui.Loader size="small" />
                </Show>
                <ui.Menu label={t("action.more")} trigger="icon" icon="outline-dots" placement="bottom-end" items={more()} />
              </div>
              <h2 class="ghp-item-title">{details().run.title}</h2>
              <div class="ghp-item-meta">
                <span>
                  <code>{details().run.branch}</code> · {details().run.event} · {details().run.sha.slice(0, 7)} ·{" "}
                  {ago(Date.parse(details().run.created) / 1000)}
                </span>
                <Show when={details().run.attempt > 1}>
                  <span>· {t("run.attempt", { count: details().run.attempt })}</span>
                </Show>
              </div>
              <div class="ghp-item-actions">
                <Show
                  when={!active()}
                  fallback={
                    <ui.Button
                      size="small"
                      variant="neutral"
                      icon="stop"
                      busy={busy() === "cancel"}
                      disabled={!!busy()}
                      onClick={() => void act("cancel", () => git.cancelRun({ repo: props.repo, id: props.id }))}
                    >
                      {t("run.cancel")}
                    </ui.Button>
                  }
                >
                  <ui.Button
                    size="small"
                    variant="contrast"
                    icon="refresh"
                    busy={busy() === "failed"}
                    disabled={details().run.conclusion !== "failure" || !!busy()}
                    onClick={() => void act("failed", () => git.rerun({ repo: props.repo, id: props.id, failed: true }), t("run.rerunStarted"))}
                  >
                    {t("run.rerunFailed")}
                  </ui.Button>
                  <ui.Button
                    size="small"
                    variant="neutral"
                    icon="outline-rotate-clockwise"
                    busy={busy() === "all"}
                    disabled={!!busy()}
                    onClick={() => void act("all", () => git.rerun({ repo: props.repo, id: props.id, failed: false }), t("run.rerunStarted"))}
                  >
                    {t("run.rerunAll")}
                  </ui.Button>
                </Show>
              </div>
            </header>
            <div class="ghp-jobs">
              <For each={details().jobs}>
                {(item) => (
                  <div class="ghp-job-group" data-id={item.id} data-selected={job()?.id === item.id ? "" : undefined}>
                    <button type="button" class="ghp-job" aria-expanded={jobOpen(item)} onClick={() => pickJob(item)}>
                      <Chevron open={jobOpen(item)} />
                      <RunStatus status={item.status} conclusion={item.conclusion} />
                      <span class="ghp-ellipsis">{item.name}</span>
                      <Show when={job()?.id === item.id && details().jobs.length > 1}>
                        <span class="ghp-faint ghp-job-log-mark">{t("run.log")}</span>
                      </Show>
                      <span class="ghp-faint">{duration(item.started, item.completed)}</span>
                    </button>
                    <Show when={jobOpen(item)}>
                      <Steps job={item} folds={folds} />
                    </Show>
                  </div>
                )}
              </For>
            </div>
            <Show when={job()}>
              {(current) => (
                <section class="ghp-job-detail">
                  <div class="ghp-log-head">
                    <span class="ghp-section-title">
                      <span class="ghp-ellipsis">
                        {t("run.log")} · {current().name}
                      </span>
                    </span>
                    <ui.Menu label={t("agent.menu")} trigger="button" icon="bubble-5" placement="bottom-end" disabled={log.latest === undefined} items={agentItems()} />
                  </div>
                  <Show
                    when={log.latest !== undefined}
                    fallback={
                      <div class="ghp-faint ghp-pad">
                        <Show when={log.error} fallback={current().status === "queued" ? t("run.queued") : <ui.Loader size="small" />}>
                          {errorMessage(log.error)}
                        </Show>
                      </div>
                    }
                  >
                    <Show when={current().id} keyed>
                      <LogView text={log.latest ?? ""} />
                    </Show>
                  </Show>
                </section>
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

/** A job's steps: when some failed, the steps that passed fold behind one row. */
function Steps(props: { job: Job; folds: Folds }) {
  const ctx = usePlugin()
  const passed = (step: Job["steps"][number]) => step.status === "completed" && step.conclusion !== "failure"
  const failed = () => props.job.steps.some((step) => step.conclusion === "failure")
  const all = () => !failed() || props.folds.flag(`steps:${props.job.id}`)
  const hidden = () => (all() ? 0 : props.job.steps.filter(passed).length)
  return (
    <div class="ghp-steps">
      <For each={props.job.steps.filter((step) => all() || !passed(step))}>
        {(step) => (
          <div class="ghp-step" data-state={step.conclusion || step.status}>
            <RunStatus status={step.status} conclusion={step.conclusion} />
            <span class="ghp-ellipsis">{step.name}</span>
          </div>
        )}
      </For>
      <Show when={hidden() > 0}>
        <button type="button" class="ghp-steps-more" aria-expanded={false} onClick={() => props.folds.setFlag(`steps:${props.job.id}`, true)}>
          {ctx.plural("view.passedSteps", hidden())}
        </button>
      </Show>
      <Show when={failed() && props.folds.flag(`steps:${props.job.id}`)}>
        <button type="button" class="ghp-steps-more" aria-expanded onClick={() => props.folds.setFlag(`steps:${props.job.id}`, false)}>
          {ctx.t("view.hidePassedSteps")}
        </button>
      </Show>
    </div>
  )
}

/** A runner log with its groups, errors and warnings marked, scrolled to the first error. */
function LogView(props: { text: string }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  const [all, setAll] = createSignal(false)
  const lines = createMemo(() =>
    props.text
      // Escape sequences the backend's color stripping leaves, such as cursor moves and line erases.
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
      .split(/\r?\n/)
      .filter((line) => !line.startsWith("##[endgroup]"))
      .map((line) => {
        if (line.startsWith("##[group]")) return { kind: "group", text: line.slice(9) }
        if (line.startsWith("##[error]")) return { kind: "error", text: line.slice(9) }
        if (line.startsWith("##[warning]")) return { kind: "warning", text: line.slice(11) }
        return { kind: "line", text: line }
      }),
  )
  // A long log renders its end, where failures are, until the user asks for the rest.
  const hidden = () => (all() ? 0 : Math.max(0, lines().length - LOG_LINES))
  const shown = createMemo(() => (hidden() > 0 ? lines().slice(hidden()) : lines()))
  const box: { element?: HTMLDivElement; placed: boolean; follow: boolean } = { placed: false, follow: true }
  // First render: the first error, else the end. Later polls of a running job follow the end only if the user is there.
  // Scrolls only the log box, never the tab around it.
  createKeyed(
    () => props.text,
    () =>
      requestAnimationFrame(() => {
        const element = box.element
        if (!element) return
        if (box.placed) {
          if (box.follow) element.scrollTop = element.scrollHeight
          return
        }
        box.placed = true
        const error = element.querySelector('[data-kind="error"]')
        if (!(error instanceof HTMLElement)) {
          element.scrollTop = element.scrollHeight
          return
        }
        element.scrollTop += error.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientHeight / 2
      }),
  )
  return (
    <div
      class="ghp-log"
      ref={(element) => (box.element = element)}
      style={{ "font-family": ctx.appearance.font("mono") }}
      onScroll={(event) => {
        const element = event.currentTarget
        box.follow = element.scrollTop + element.clientHeight >= element.scrollHeight - 24
      }}
    >
      <Show when={hidden() > 0}>
        <div class="ghp-more">
          <ui.Button size="small" variant="ghost" onClick={() => setAll(true)}>
            {t("diff.showAll", { count: hidden() })}
          </ui.Button>
        </div>
      </Show>
      <Index each={shown()}>
        {(line, index) => (
          <div class="ghp-log-line" data-kind={line().kind}>
            <span class="ghp-log-num">{hidden() + index + 1}</span>
            <span class="ghp-log-text">{line().text}</span>
          </div>
        )}
      </Index>
    </div>
  )
}

/** The Actions tab of the panel: recent runs for the current branch or the whole repository. */
export function RunsView(props: { repo: string; branch: string | null; actions: Actions }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  const [scope, setScope] = createSignal<"branch" | "all">(props.branch ? "branch" : "all")
  const q = props.actions.queries
  const runs = latest(
    q.query(() => ({
      ...q.options.runs(props.repo, scope() === "branch" ? props.branch : null),
      placeholderData: keepPreviousData,
      // Keeps running workflows moving.
      refetchInterval: (query) => ((query.state.data ?? []).some((run) => run.status !== "completed") ? 8000 : false),
    })),
  )
  return (
    <div class="ghp-pulls">
      <div class="ghp-toolbar">
        <div class="ghp-segmented">
          <button type="button" disabled={!props.branch} data-selected={scope() === "branch" ? "" : undefined} onClick={() => setScope("branch")}>
            {props.branch ?? t("runs.branch")}
          </button>
          <button type="button" data-selected={scope() === "all" ? "" : undefined} onClick={() => setScope("all")}>
            {t("runs.all")}
          </button>
        </div>
        <div class="ghp-spacer" />
        <Show when={runs.loading}>
          <ui.Loader size="small" />
        </Show>
        <ui.Tooltip value={t("action.refresh")}>
          <ui.IconButton icon="refresh" label={t("action.refresh")} size="small" variant="ghost" onClick={() => q.invalidate(q.keys.runs(props.repo, scope() === "branch" ? props.branch : null))} />
        </ui.Tooltip>
      </div>
      <Show
        when={runs.latest}
        fallback={
          <div class="ghp-empty ghp-empty-inline">
            <Show when={runs.error} fallback={<ui.Loader />}>
              {errorMessage(runs.error)}
            </Show>
          </div>
        }
      >
        <For each={runs.latest ?? []} fallback={<div class="ghp-empty ghp-empty-inline">{t("checks.noRuns")}</div>}>
          {(run) => <RunRow run={run} repo={props.repo} actions={props.actions} showBranch={scope() === "all"} />}
        </For>
      </Show>
    </div>
  )
}

function duration(started: string | null, completed: string | null) {
  if (!started) return ""
  const seconds = Math.max(0, Math.round(((completed ? Date.parse(completed) : Date.now()) - Date.parse(started)) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
