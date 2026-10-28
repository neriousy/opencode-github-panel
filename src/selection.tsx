import { createSignal, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import type { Context } from "@opencode/plugin/gui"
import type { Actions } from "./actions"
import { clip } from "./context"

interface Selected {
  readonly text: string
  readonly label: string
  readonly subject: string
  readonly x: number
  readonly y: number
}

/**
 * Text selected anywhere in the plugin's views (a comment, a log line, a diff) gets a floating "Add to chat" button
 * that quotes it into the next prompt. Each view names itself with `data-ghp-source` and `data-ghp-label`.
 */
export function createSelectionQuote(ctx: Context, actions: Actions) {
  const [selected, setSelected] = createSignal<Selected>()

  const read = () => {
    const selection = window.getSelection()
    const text = selection?.toString().trim() ?? ""
    if (!selection || selection.rangeCount === 0 || text.length < 3) return setSelected(undefined)
    const range = selection.getRangeAt(0)
    const node = range.commonAncestorContainer
    const element = node instanceof Element ? node : node.parentElement
    const source = element?.closest("[data-ghp-source]")
    if (!(source instanceof HTMLElement) || element?.closest("textarea, input")) return setSelected(undefined)
    const rects = range.getClientRects()
    const last = rects[rects.length - 1] ?? range.getBoundingClientRect()
    setSelected({
      text: clip(text),
      label: source.dataset.ghpLabel ?? "GitHub",
      subject: source.dataset.ghpSource ?? "the git panel",
      x: Math.min(last.right, window.innerWidth - 130),
      y: last.bottom + 6,
    })
  }

  const onUp = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest(".ghp-quote")) return
    // The selection settles after mouseup.
    requestAnimationFrame(read)
  }
  const onChange = () => {
    if (!window.getSelection()?.toString().trim()) return setSelected(undefined)
    // A selection changed from the keyboard moves the button and changes what it quotes.
    if (selected()) read()
  }
  const onScroll = () => setSelected(undefined)

  document.addEventListener("mouseup", onUp)
  document.addEventListener("selectionchange", onChange)
  document.addEventListener("scroll", onScroll, { capture: true, passive: true })
  onCleanup(() => {
    document.removeEventListener("mouseup", onUp)
    document.removeEventListener("selectionchange", onChange)
    document.removeEventListener("scroll", onScroll, { capture: true })
  })

  function SelectionLayer() {
    return (
      <Show when={selected()}>
        {(current) => (
          <Portal>
            <button
              type="button"
              class="ghp-quote"
              style={{ left: `${current().x}px`, top: `${current().y}px` }}
              // Keep the selection: a mousedown on a button would otherwise clear it before the click.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                actions.attach({ label: current().label, subject: current().subject, text: current().text })
                window.getSelection()?.removeAllRanges()
                setSelected(undefined)
              }}
            >
              <ctx.ui.Icon name="bubble-5" size="small" />
              {ctx.t("agent.selection")}
            </button>
          </Portal>
        )}
      </Show>
    )
  }

  return { SelectionLayer }
}
