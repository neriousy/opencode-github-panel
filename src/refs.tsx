import { createEffect, createSignal, on, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import type { Context } from "@opencode/plugin/gui"
import { latest } from "./queries"
import { repoOf, type Actions } from "./actions"
import type { ItemRef } from "./contract"
import { findRefs, parseGitHubLink, parseItemUrl } from "./git"
import { ItemCard } from "./item"

const HIGHLIGHT = "ghp-ref"
const MARKDOWN = '[data-component="markdown"]'
// Text in these never holds a mention we style: code, links (handled as links), and our own hover card.
const SKIP = "code, pre, a, textarea, [contenteditable], .ghp-card"

interface Hover {
  readonly ref: ItemRef
  readonly rect: { x: number; y: number; width: number; height: number }
  /** What the pointer was over; the card closes when it leaves the document (a re-render, another session). */
  readonly element: Element
}

/**
 * Makes issue and pull request mentions in rendered Markdown, the session timeline included, open in the panel:
 * github.com issue and pull links, and bare `#123` or `owner/repo#123` text. The timeline exposes no API for this, so
 * it styles mentions with a CSS highlight (no DOM changes to the timeline) and listens for clicks and hovers on the
 * document. ⌘-click and middle click keep their usual behavior.
 */
export function createRefs(ctx: Context, actions: Actions) {
  const q = actions.queries
  const [hover, setHover] = createSignal<Hover>()
  const highlight = typeof CSS !== "undefined" && "highlights" in CSS ? new Highlight() : undefined
  const cache = new WeakMap<Element, { key: string; ranges: { range: Range; repo?: string; number: number }[] }>()
  const mentions: { range: Range; repo?: string; number: number }[] = []
  const timers: { scan?: ReturnType<typeof setTimeout>; show?: ReturnType<typeof setTimeout>; hide?: ReturnType<typeof setTimeout> } = {}

  if (highlight) CSS.highlights.set(HIGHLIGHT, highlight)

  const repoFor = (element: Element) => {
    const scoped = element.closest("[data-repo]")?.getAttribute("data-repo")
    if (scoped) return Promise.resolve(scoped)
    const directory = ctx.sessions.current()?.directory
    if (!directory) return Promise.resolve(undefined)
    // The overview the panel and header chip already loaded, until a repository change invalidates it. A failure is not
    // cached, so the next mention asks again.
    return q.client.fetchQuery({ ...q.options.overview(directory), staleTime: Infinity }).then(repoOf, () => undefined)
  }

  const scan = () => {
    timers.scan = undefined
    const current = hover()
    if (current && !current.element.isConnected) hide()
    if (!highlight) return
    highlight.clear()
    mentions.length = 0
    document.querySelectorAll(MARKDOWN).forEach((root) => {
      const blocks = root.querySelectorAll("[data-markdown-block]")
      ;(blocks.length > 0 ? [...blocks] : [root]).forEach((block) => {
        // A streaming block is rewritten word by word; it is scanned once it completes.
        if (block instanceof HTMLElement && block.dataset.markdownMode === "live") return
        const key = (block instanceof HTMLElement && block.dataset.markdownHash) || block.textContent || ""
        const cached = cache.get(block)
        const valid = cached && cached.key === key && cached.ranges.every((item) => item.range.startContainer.isConnected)
        const entry = valid ? cached : { key, ranges: rangesIn(block) }
        if (!valid) cache.set(block, entry)
        entry.ranges.forEach((item) => {
          highlight.add(item.range)
          mentions.push(item)
        })
      })
    })
  }

  const schedule = () => {
    if (timers.scan === undefined) timers.scan = setTimeout(scan, 400)
  }

  // Only Markdown changes need a scan: rendered, edited, finished streaming, or removed (which also drops the ranges that
  // would keep its nodes alive). Other app updates (spinners, timers, the panel) would otherwise rescan every 400ms.
  const relevant = (record: MutationRecord) =>
    !!(record.target instanceof Element ? record.target : record.target.parentElement)?.closest(MARKDOWN) ||
    [...record.addedNodes, ...record.removedNodes].some(
      (node) => node instanceof Element && (node.matches(MARKDOWN) || node.querySelector(MARKDOWN) !== null),
    )
  const observer = new MutationObserver((records) => {
    if (timers.scan === undefined && records.some(relevant)) schedule()
  })
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-markdown-mode"],
  })
  schedule()

  /** The mention under a point: a GitHub link, or highlighted text. Its repository is resolved only when asked for. */
  const mentionAt = (event: MouseEvent): { ref: () => Promise<ItemRef | undefined>; element: Element; rect: DOMRect } | undefined => {
    if (!(event.target instanceof Element)) return undefined
    const anchor = event.target.closest("a[href]")
    if (anchor instanceof HTMLAnchorElement) {
      const ref = parseItemUrl(anchor.href)
      if (!ref || !anchor.closest(MARKDOWN)) return undefined
      return { ref: () => Promise.resolve(ref), element: anchor, rect: anchor.getBoundingClientRect() }
    }
    if (!event.target.closest(MARKDOWN) || mentions.length === 0) return undefined
    const caret = caretAt(event.clientX, event.clientY)
    if (!caret) return undefined
    // Each mention lies in one text node; compare that first instead of a range check against every mention.
    const found = mentions.find((item) => item.range.startContainer === caret.node && item.range.isPointInRange(caret.node, caret.offset))
    if (!found) return undefined
    // The caret snaps to the nearest character; make sure the pointer is really over the mention.
    const rect = [...found.range.getClientRects()].find(
      (box) => event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom,
    )
    if (!rect) return undefined
    const element = event.target
    return {
      ref: () => (found.repo ? Promise.resolve(found.repo) : repoFor(element)).then((repo) => (repo ? { repo, number: found.number } : undefined)),
      element,
      rect,
    }
  }

  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (event.target instanceof Element && event.target.closest(".ghp-card")) return
    // Selecting text in a message is not a click on a mention.
    if (!window.getSelection()?.isCollapsed) return
    // Commit, CI and files links open their own tabs; issue and pull links go through the mention path below.
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null
    if (anchor instanceof HTMLAnchorElement && anchor.closest(MARKDOWN)) {
      const link = parseGitHubLink(anchor.href)
      if (link && (link.kind !== "item" || link.files)) {
        event.preventDefault()
        event.stopPropagation()
        hide()
        if (link.kind === "commit") actions.openCommit(link.repo, link.sha)
        if (link.kind === "run") actions.openRun(link.repo, link.id, link.job)
        if (link.kind === "item") actions.openItem(link.ref, "files")
        return
      }
    }
    const mention = mentionAt(event)
    if (!mention) return
    event.preventDefault()
    event.stopPropagation()
    hide()
    void mention.ref().then((ref) => {
      if (!ref) return ctx.toast.show({ variant: "error", title: ctx.t("toast.noRepo") })
      actions.openItem(ref)
    })
  }

  // Where the pointer is, kept up to date from pointer moves (at most once a frame) and the card's own enter and leave.
  const pointer = { frame: 0, last: undefined as MouseEvent | undefined, over: "", card: false }

  const hide = () => {
    clearTimeout(timers.show)
    clearTimeout(timers.hide)
    pointer.over = ""
    pointer.card = false
    if (hover()) setHover(undefined)
  }

  const hideSoon = () => {
    clearTimeout(timers.show)
    clearTimeout(timers.hide)
    // A short delay lets the pointer cross the gap between a mention and its card.
    timers.hide = setTimeout(hide, 200)
  }

  const onMove = (event: MouseEvent) => {
    pointer.last = event
    if (pointer.frame) return
    pointer.frame = requestAnimationFrame(() => {
      pointer.frame = 0
      const last = pointer.last
      // The pointer left the window or the window lost focus since this move: nothing to update.
      if (!last) return
      if (pointer.card) return
      const mention = mentionAt(last)
      document.documentElement.toggleAttribute("data-ghp-ref-hover", !!mention && !(mention.element instanceof HTMLAnchorElement))
      if (!mention) {
        pointer.over = ""
        if (hover()) hideSoon()
        else clearTimeout(timers.show)
        return
      }
      const key = `${Math.round(mention.rect.x)}:${Math.round(mention.rect.y)}`
      if (pointer.over === key) {
        clearTimeout(timers.hide)
        return
      }
      pointer.over = key
      // Moving to another mention keeps the open card until the new one replaces it.
      clearTimeout(timers.show)
      clearTimeout(timers.hide)
      const rect = { x: mention.rect.x, y: mention.rect.y, width: mention.rect.width, height: mention.rect.height }
      timers.show = setTimeout(() => {
        void mention.ref().then((ref) => {
          if (pointer.over !== key) return
          clearTimeout(timers.hide)
          if (!ref) return hide()
          setHover({ ref, rect, element: mention.element })
        })
      }, 350)
    })
  }

  // The pointer left the window: no more moves will come to close the card.
  const onOut = (event: MouseEvent) => {
    if (event.relatedTarget !== null) return
    pointer.last = undefined
    document.documentElement.removeAttribute("data-ghp-ref-hover")
    hide()
  }
  const onAway = () => {
    pointer.last = undefined
    hide()
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && hover()) hide()
  }
  const onDown = (event: PointerEvent) => {
    if (event.target instanceof Element && event.target.closest(".ghp-card")) return
    hide()
  }
  const onScroll = (event: Event) => {
    if (event.target instanceof Element && event.target.closest(".ghp-card")) return
    hide()
  }
  const onVisibility = () => {
    if (document.hidden) onAway()
  }

  window.addEventListener("click", onClick, true)
  window.addEventListener("mousemove", onMove, { capture: true, passive: true })
  document.addEventListener("mouseout", onOut, { capture: true, passive: true })
  window.addEventListener("blur", onAway)
  window.addEventListener("keydown", onKey, true)
  window.addEventListener("pointerdown", onDown, { capture: true, passive: true })
  document.addEventListener("scroll", onScroll, { capture: true, passive: true })
  document.addEventListener("visibilitychange", onVisibility)
  // A card from the previous session never stays open over the next one.
  createEffect(on(() => ctx.sessions.current()?.id, hide, { defer: true }))

  onCleanup(() => {
    observer.disconnect()
    window.removeEventListener("click", onClick, true)
    window.removeEventListener("mousemove", onMove, { capture: true })
    document.removeEventListener("mouseout", onOut, { capture: true })
    window.removeEventListener("blur", onAway)
    window.removeEventListener("keydown", onKey, true)
    window.removeEventListener("pointerdown", onDown, { capture: true })
    document.removeEventListener("scroll", onScroll, { capture: true })
    document.removeEventListener("visibilitychange", onVisibility)
    Object.values(timers).forEach((timer) => clearTimeout(timer))
    cancelAnimationFrame(pointer.frame)
    document.documentElement.removeAttribute("data-ghp-ref-hover")
    // A setup that replaced this one (a plugin reload) may already have registered its own highlight under the name.
    if (highlight && CSS.highlights.get(HIGHLIGHT) === highlight) CSS.highlights.delete(HIGHLIGHT)
  })

  /** The hover card, rendered from a window slot into the document body. */
  function HoverLayer() {
    return (
      <Show when={hover()}>
        {(current) => (
          <Portal>
            <HoverCard
              ctx={ctx}
              actions={actions}
              hover={current()}
              onEnter={() => {
                pointer.card = true
                clearTimeout(timers.hide)
              }}
              onLeave={() => {
                // Back onto its mention keeps the card; anywhere else closes it.
                pointer.card = false
                hideSoon()
              }}
              onOpen={() => {
                const ref = current().ref
                hide()
                actions.openItem(ref)
              }}
            />
          </Portal>
        )}
      </Show>
    )
  }

  return { HoverLayer }
}

function HoverCard(props: { ctx: Context; actions: Actions; hover: Hover; onEnter: () => void; onLeave: () => void; onOpen: () => void }) {
  const ui = props.ctx.ui
  const q = props.actions.queries
  const item = latest(q.query(() => q.options.item(props.hover.ref)))
  const width = 340
  const left = () => Math.max(8, Math.min(props.hover.rect.x, window.innerWidth - width - 8))
  const below = () => props.hover.rect.y + props.hover.rect.height + 6
  // Open above the mention when there is no room below it.
  const above = () => below() + 220 > window.innerHeight
  return (
    <div
      class="ghp-card"
      role="button"
      tabIndex={-1}
      style={{
        left: `${left()}px`,
        width: `${width}px`,
        ...(above() ? { bottom: `${window.innerHeight - props.hover.rect.y + 6}px` } : { top: `${below()}px` }),
      }}
      onMouseEnter={props.onEnter}
      onMouseLeave={props.onLeave}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) {
          const current = item.latest
          if (current) props.ctx.system.openExternal(current.url)
          return
        }
        props.onOpen()
      }}
    >
      <Show
        when={item.latest}
        fallback={
          <div class="ghp-card-loading">
            <Show when={item.error} fallback={<ui.Loader size="small" />}>
              <ui.Icon name="circle-exclamation" size="small" />
            </Show>
            <span class="ghp-faint">
              {props.hover.ref.repo}#{props.hover.ref.number}
            </span>
          </div>
        }
      >
        {(current) => <ItemCard ctx={props.ctx} item={current()} />}
      </Show>
    </div>
  )
}

function rangesIn(block: Element) {
  const ranges: { range: Range; repo?: string; number: number }[] = []
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeValue?.includes("#") && !node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? ""
    findRefs(text).forEach((found) => {
      const range = document.createRange()
      range.setStart(node, found.index)
      range.setEnd(node, found.index + found.length)
      ranges.push({ range, repo: found.repo, number: found.number })
    })
  }
  return ranges
}

function caretAt(x: number, y: number): { node: Node; offset: number } | undefined {
  const position = document.caretPositionFromPoint?.(x, y)
  if (position) return { node: position.offsetNode, offset: position.offset }
  // Chromium before 128 has only the older, non-standard API.
  const range = document.caretRangeFromPoint?.(x, y)
  if (range) return { node: range.startContainer, offset: range.startOffset }
  return undefined
}
