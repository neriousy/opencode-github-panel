import { batch, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { usePlugin } from "@opencode/plugin/gui"

export type Folds = ReturnType<typeof createFolds>

/**
 * What the user folded, unfolded and expanded in a view, by entry id, so it outlives refetches, polling and remounts
 * (switching sections). `smart` turns the views' own folding on: without it, entries start unfolded and unclamped.
 */
export function createFolds(smart: () => boolean = () => true) {
  const [state, setState] = createStore<{ all?: boolean; folded: Record<string, boolean>; flags: Record<string, boolean>; text: Record<string, string> }>({
    folded: {},
    flags: {},
    text: {},
  })
  return {
    smart,
    /** Folded by the user, else by Fold all / Unfold all, else as the view suggests; `keepOpen` resists Fold all. */
    folded: (id: string, suggested: boolean, keepOpen = false) => state.folded[id] ?? (keepOpen ? false : (state.all ?? (smart() && suggested))),
    fold: (id: string, folded: boolean) => setState("folded", id, folded),
    /** True after Fold all, false after Unfold all, until the next one. */
    all: () => state.all,
    foldAll: (folded: boolean) =>
      batch(() => {
        setState("folded", reconcile({}))
        setState("all", folded)
      }),
    /** Other remembered toggles, which Fold all leaves alone: an expanded clamp, the earlier comments, an open reply box. */
    flag: (id: string, initial = false) => state.flags[id] ?? initial,
    setFlag: (id: string, value: boolean) => setState("flags", id, value),
    /** Drafts kept outside the components that edit them, so folding or remounting them loses nothing. */
    text: (id: string) => state.text[id] ?? "",
    setText: (id: string, value: string) => setState("text", id, value),
    reset: () => setState(reconcile({ folded: {}, flags: {}, text: {} })),
  }
}

export function Chevron(props: { open: boolean }) {
  const ctx = usePlugin()
  return <ctx.ui.Icon name={props.open ? "chevron-down" : "chevron-right"} size="small" class="ghp-chevron" />
}

/** A titled run of rows that folds under its header. */
export function Group(props: { title: JSX.Element; count?: number; open: boolean; onToggle: () => void; children: JSX.Element; class?: string }) {
  return (
    <section class={props.class ? `ghp-group ${props.class}` : "ghp-group"} data-open={props.open ? "" : undefined}>
      <button type="button" class="ghp-group-head" aria-expanded={props.open} onClick={() => props.onToggle()}>
        <Chevron open={props.open} />
        <span class="ghp-group-title ghp-ellipsis">{props.title}</span>
        <Show when={props.count !== undefined}>
          <span class="ghp-tab-count">{props.count}</span>
        </Show>
      </button>
      <Show when={props.open}>
        <div class="ghp-group-body">{props.children}</div>
      </Show>
    </section>
  )
}

/**
 * Content cut to `lines` lines with a fade and a Show more / Show less toggle, measured as it renders (Markdown fills in
 * asynchronously), and only when it is clearly longer. `lines` 0 never clamps.
 */
export function Clamp(props: { lines: number; open?: boolean; onOpen?: (open: boolean) => void; children: JSX.Element }) {
  const ctx = usePlugin()
  const [own, setOwn] = createSignal(false)
  const [size, setSize] = createSignal({ line: 0, height: 0 })
  const box: { element?: HTMLDivElement } = {}
  const open = () => props.open ?? own()
  const limit = () => size().line * props.lines
  // A couple of lines past the limit read better in full than behind a toggle.
  const clamps = () => props.lines > 0 && size().line > 0 && size().height > limit() + size().line * 2
  const folded = () => clamps() && !open()
  const observe = (element: HTMLDivElement) => {
    const observer = new ResizeObserver(() => {
      const style = getComputedStyle(element)
      setSize({ line: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5, height: element.scrollHeight })
    })
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  }
  const toggle = () => {
    const next = !open()
    setOwn(next)
    props.onOpen?.(next)
    // Folding a long text back up would leave the reader far below it.
    if (!next) requestAnimationFrame(() => box.element?.scrollIntoView({ block: "nearest" }))
  }
  return (
    <div class="ghp-clamp" ref={(element) => (box.element = element)} data-clamped={folded() ? "" : undefined}>
      <div class="ghp-clamp-box" style={{ "max-height": folded() ? `${limit()}px` : undefined }}>
        <div ref={observe}>{props.children}</div>
      </div>
      <Show when={clamps()}>
        <button type="button" class="ghp-clamp-toggle" aria-expanded={open()} onClick={toggle}>
          {open() ? ctx.t("view.showLess") : ctx.t("view.showMore")}
        </button>
      </Show>
    </div>
  )
}

/** The first line of Markdown as plain text, for a folded entry's summary. */
export function firstLine(text: string) {
  const line =
    text
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .split("\n")
      .map((part) => part.replace(/[#*_`>|~]/g, "").replace(/\s+/g, " ").trim())
      .find((part) => part && !/^[-:\s]+$/.test(part)) ?? ""
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}
