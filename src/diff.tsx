import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { ChangedFile, DraftComment, Thread } from "./contract"
import { Chevron, Group, type Folds } from "./fold"
import { parsePatch, type DiffLine } from "./git"

const LINE_LIMIT = 1500
/** Changed lines past which a file starts collapsed when there are others to read. */
export const LARGE_FILE = 600

export interface Target {
  readonly line: number
  readonly side: "LEFT" | "RIGHT"
}

/**
 * The changed files of a pull request or commit: a summary with Collapse all / Expand all, an index that jumps to a
 * file, and the diffs. With `viewed`, each file has a Viewed box that folds it.
 */
export function DiffList(props: {
  files: readonly ChangedFile[]
  folds: Folds
  viewed?: ReadonlySet<string>
  onViewed?: (path: string, viewed: boolean) => void
  threads?: readonly Thread[]
  renderThread?: (thread: Thread) => JSX.Element
  onComment?: (file: ChangedFile, target: Target, body: string) => Promise<boolean>
  /** Adds a comment to the draft review, or starts one; `drafting` says one exists. */
  onDraft?: (file: ChangedFile, target: Target, body: string) => Promise<boolean>
  drafting?: boolean
  drafts?: readonly DraftComment[]
  renderDraft?: (comment: DraftComment, orphan: boolean) => JSX.Element
  onAttach?: (file: ChangedFile) => void
}) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  const elements = new Map<string, HTMLElement>()
  const large = (file: ChangedFile) => props.files.length > 15 || file.additions + file.deletions > LARGE_FILE
  // A file the draft review comments on starts open, large or not.
  const drafted = (file: ChangedFile) => (props.drafts ?? []).some((comment) => comment.path === file.path)
  const open = (file: ChangedFile) => !props.folds.folded(file.path, !!props.viewed?.has(file.path) || (props.files.length > 1 && large(file) && !drafted(file)))
  const jump = (file: ChangedFile) => {
    props.folds.fold(file.path, false)
    requestAnimationFrame(() => {
      const element = elements.get(file.path)
      element?.scrollIntoView({ block: "start" })
      element?.querySelector<HTMLElement>(".ghp-dfile-toggle")?.focus({ preventScroll: true })
    })
  }
  return (
    <div class="ghp-files">
      <div class="ghp-bar">
        <span class="ghp-faint ghp-ellipsis">
          {ctx.plural("item.files", props.files.length)} · <span class="ghp-add">+{props.files.reduce((sum, file) => sum + file.additions, 0)}</span>{" "}
          <span class="ghp-del">−{props.files.reduce((sum, file) => sum + file.deletions, 0)}</span>
          <Show when={props.viewed}>
            {(viewed) => ` · ${t("view.viewedCount", { count: props.files.filter((file) => viewed().has(file.path)).length, total: props.files.length })}`}
          </Show>
        </span>
        <div class="ghp-spacer" />
        <Show when={props.files.length > 1}>
          <ui.Button
            size="small"
            variant="ghost-muted"
            icon={props.folds.all() ? "expand" : "collapse"}
            class="ghp-fold-all"
            onClick={() => props.folds.foldAll(!props.folds.all())}
          >
            {props.folds.all() ? t("view.expandAll") : t("view.collapseAll")}
          </ui.Button>
        </Show>
      </div>
      <Show when={props.files.length > 1}>
        <Group
          class="ghp-findex"
          title={t("view.changedFiles")}
          count={props.files.length}
          open={props.folds.flag("index", props.files.length <= 25)}
          onToggle={() => props.folds.setFlag("index", !props.folds.flag("index", props.files.length <= 25))}
        >
          <For each={props.files}>
            {(file) => (
              <button type="button" class="ghp-findex-row" data-viewed={props.viewed?.has(file.path) ? "" : undefined} onClick={() => jump(file)}>
                <span class="ghp-status" data-status={statusLetter(file.status)}>
                  {statusLetter(file.status)}
                </span>
                <span class="ghp-dfile-path" title={file.path}>
                  {file.path}
                </span>
                <Show when={props.viewed?.has(file.path)}>
                  <ui.Icon name="check" size="small" class="ghp-faint" />
                </Show>
                <span class="ghp-add">+{file.additions}</span>
                <span class="ghp-del">−{file.deletions}</span>
              </button>
            )}
          </For>
        </Group>
      </Show>
      <For each={props.files} fallback={<div class="ghp-empty ghp-empty-inline">{t("diff.none")}</div>}>
        {(file) => (
          <DiffFile
            file={file}
            ref={(element) => elements.set(file.path, element)}
            open={open(file)}
            onToggle={(next) => props.folds.fold(file.path, !next)}
            viewed={props.viewed ? props.viewed.has(file.path) : undefined}
            onViewed={
              props.onViewed
                ? (viewed) => {
                    props.onViewed?.(file.path, viewed)
                    props.folds.fold(file.path, viewed)
                  }
                : undefined
            }
            threads={(props.threads ?? []).filter((thread) => thread.path === file.path)}
            renderThread={props.renderThread}
            onComment={props.onComment ? (target, body) => props.onComment?.(file, target, body) ?? Promise.resolve(false) : undefined}
            onDraft={props.onDraft ? (target, body) => props.onDraft?.(file, target, body) ?? Promise.resolve(false) : undefined}
            drafting={props.drafting}
            drafts={(props.drafts ?? []).filter((comment) => comment.path === file.path)}
            renderDraft={props.renderDraft}
            onAttach={props.onAttach ? () => props.onAttach?.(file) : undefined}
          />
        )}
      </For>
    </div>
  )
}

/** One changed file with its diff. With `onComment`, every line can take an inline review comment. */
export function DiffFile(props: {
  file: ChangedFile
  open: boolean
  onToggle: (open: boolean) => void
  ref?: (element: HTMLElement) => void
  viewed?: boolean
  onViewed?: (viewed: boolean) => void
  threads?: readonly Thread[]
  renderThread?: (thread: Thread) => JSX.Element
  onComment?: (target: Target, body: string) => Promise<boolean>
  onDraft?: (target: Target, body: string) => Promise<boolean>
  drafting?: boolean
  drafts?: readonly DraftComment[]
  renderDraft?: (comment: DraftComment, orphan: boolean) => JSX.Element
  onAttach?: () => void
}) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  const open = () => props.open
  const commentable = () => !!props.onComment || !!props.onDraft
  const [all, setAll] = createSignal(false)
  const [target, setTarget] = createSignal<Target>()
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  // Parsed only while open, so a pull request with hundreds of collapsed files mounts quickly. CRLF patches and a
  // trailing newline would otherwise show stray carriage returns and a phantom empty last line.
  const lines = createMemo(() => (open() && props.file.patch ? parsePatch(props.file.patch.replace(/\r\n/g, "\n").replace(/\n$/, "")) : []))
  const shown = () => (all() ? lines() : lines().slice(0, LINE_LIMIT))
  const anchor = (line: DiffLine): Target | undefined => {
    if (line.kind === "del" && line.old !== null) return { line: line.old, side: "LEFT" }
    if (line.new !== null) return { line: line.new, side: "RIGHT" }
    return undefined
  }
  const matches = (thread: { line: number | null; side: string }, line: DiffLine) =>
    thread.line !== null && (thread.side === "LEFT" ? line.kind !== "add" && line.old === thread.line : line.kind !== "del" && line.new === thread.line)
  const threadsAt = (line: DiffLine) => (line.kind === "hunk" ? [] : (props.threads ?? []).filter((thread) => matches(thread, line)))
  const draftsAt = (line: DiffLine) => (line.kind === "hunk" ? [] : (props.drafts ?? []).filter((comment) => matches(comment, line)))
  // Threads and draft comments on lines not shown: outdated, outside the hunks, or past the line limit.
  const orphans = () => (props.threads ?? []).filter((thread) => !shown().some((line) => line.kind !== "hunk" && matches(thread, line)))
  const orphanDrafts = () => (props.drafts ?? []).filter((comment) => !shown().some((line) => line.kind !== "hunk" && matches(comment, line)))
  const pick = (line: DiffLine) => {
    if (!commentable() || line.kind === "hunk") return
    setTarget(anchor(line))
    setDraft("")
  }
  const send = async (mode: "single" | "review") => {
    const at = target()
    const submit = mode === "review" ? props.onDraft : props.onComment
    if (!at || !draft().trim() || !submit || busy()) return
    setBusy(true)
    const done = await submit(at, draft().trim())
    setBusy(false)
    if (!done) return
    setDraft("")
    setTarget(undefined)
  }
  const slash = props.file.path.lastIndexOf("/")
  const renamed = () => !!props.file.previous && props.file.previous !== props.file.path

  return (
    <section class="ghp-dfile" ref={(element) => props.ref?.(element)} data-open={open() ? "" : undefined} data-viewed={props.viewed ? "" : undefined}>
      <div class="ghp-dfile-head">
        <button type="button" class="ghp-dfile-toggle" aria-expanded={open()} onClick={() => props.onToggle(!open())}>
          <Chevron open={open()} />
          <span class="ghp-status" data-status={statusLetter(props.file.status)}>
            {statusLetter(props.file.status)}
          </span>
          <span class="ghp-dfile-path" title={renamed() ? `${props.file.previous} → ${props.file.path}` : props.file.path}>
            <Show when={renamed()}>
              <span class="ghp-faint">{props.file.previous} → </span>
            </Show>
            <span class="ghp-faint">{slash === -1 ? "" : props.file.path.slice(0, slash + 1)}</span>
            {slash === -1 ? props.file.path : props.file.path.slice(slash + 1)}
          </span>
          <Show when={(props.threads ?? []).length > 0}>
            <span class="ghp-pill">💬 {(props.threads ?? []).length}</span>
          </Show>
          <Show when={(props.drafts ?? []).length > 0}>
            <span class="ghp-pill ghp-draft-pill" title={t("draft.title")}>
              ✎ {(props.drafts ?? []).length}
            </span>
          </Show>
          <span class="ghp-add">+{props.file.additions}</span>
          <span class="ghp-del">−{props.file.deletions}</span>
        </button>
        <Show when={props.onAttach && props.file.patch}>
          <ui.Tooltip value={t("action.addToChat")}>
            <ui.IconButton icon="bubble-5" label={t("action.addToChat")} size="small" variant="ghost-muted" onClick={() => props.onAttach?.()} />
          </ui.Tooltip>
        </Show>
        <Show when={props.onViewed}>
          <label class="ghp-dfile-viewed">
            <input type="checkbox" checked={!!props.viewed} onChange={(event) => props.onViewed?.(event.currentTarget.checked)} />
            {t("view.viewed")}
          </label>
        </Show>
      </div>

      <Show when={open()}>
        <Show when={props.file.patch} fallback={<div class="ghp-faint ghp-pad">{t("diff.noPatch")}</div>}>
          <div class="ghp-diff-table" role="table">
            <For each={shown()}>
              {(line) => (
                <>
                  <div class="ghp-dline" data-kind={line.kind} role="row">
                    <span class="ghp-dnum" data-commentable={commentable() && line.kind !== "hunk" ? "" : undefined} onClick={() => pick(line)}>
                      {line.old ?? ""}
                    </span>
                    <span class="ghp-dnum" data-commentable={commentable() && line.kind !== "hunk" ? "" : undefined} onClick={() => pick(line)}>
                      {line.new ?? ""}
                    </span>
                    <span class="ghp-dtext">
                      <Show when={commentable() && line.kind !== "hunk"}>
                        <button type="button" class="ghp-dadd" title={t("diff.comment")} onClick={() => pick(line)}>
                          +
                        </button>
                      </Show>
                      <span class="ghp-dsign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
                      {line.text}
                    </span>
                  </div>
                  <For each={threadsAt(line)}>{(thread) => <div class="ghp-dthread">{props.renderThread?.(thread)}</div>}</For>
                  <For each={draftsAt(line)}>{(comment) => <div class="ghp-dthread ghp-ddraft">{props.renderDraft?.(comment, false)}</div>}</For>
                  <Show when={target() && target()?.line === anchor(line)?.line && target()?.side === anchor(line)?.side}>
                    <div class="ghp-dthread">
                      <div class="ghp-composer">
                        <textarea
                          class="ghp-textarea"
                          rows={3}
                          autofocus
                          placeholder={t("diff.commentPlaceholder")}
                          value={draft()}
                          onInput={(event) => setDraft(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                              event.preventDefault()
                              // In a review, ⌘⏎ adds to it; otherwise it posts the single comment.
                              void send(props.onDraft && (props.drafting || !props.onComment) ? "review" : "single")
                            }
                            if (event.key === "Escape") setTarget(undefined)
                          }}
                        />
                        <div class="ghp-item-actions">
                          <div class="ghp-spacer" />
                          <ui.Button size="small" variant="ghost" onClick={() => setTarget(undefined)}>
                            {t("cancel")}
                          </ui.Button>
                          <Show when={props.onComment}>
                            <ui.Button
                              size="small"
                              variant={props.onDraft ? "neutral" : "contrast"}
                              busy={busy()}
                              disabled={!draft().trim()}
                              onClick={() => void send("single")}
                            >
                              {props.onDraft ? t("draft.addSingle") : t("diff.comment")}
                            </ui.Button>
                          </Show>
                          <Show when={props.onDraft}>
                            <ui.Button size="small" variant="contrast" icon="review" busy={busy()} disabled={!draft().trim()} onClick={() => void send("review")}>
                              {props.drafting ? t("draft.add") : t("draft.start")}
                            </ui.Button>
                          </Show>
                        </div>
                      </div>
                    </div>
                  </Show>
                </>
              )}
            </For>
          </div>
          <Show when={!all() && lines().length > LINE_LIMIT}>
            <div class="ghp-more">
              <ui.Button size="small" variant="ghost" onClick={() => setAll(true)}>
                {t("diff.showAll", { count: lines().length - LINE_LIMIT })}
              </ui.Button>
            </div>
          </Show>
        </Show>
        <For each={orphans()}>{(thread) => <div class="ghp-dthread">{props.renderThread?.(thread)}</div>}</For>
        <For each={orphanDrafts()}>{(comment) => <div class="ghp-dthread ghp-ddraft">{props.renderDraft?.(comment, true)}</div>}</For>
      </Show>
    </section>
  )
}

export function statusLetter(status: string) {
  if (status === "added") return "A"
  if (status === "removed") return "D"
  if (status === "renamed") return "R"
  if (status === "copied") return "C"
  return "M"
}
