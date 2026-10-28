import { createEffect, createMemo, createSignal, createUniqueId, For, mapArray, on, onCleanup, onMount, Show, untrack } from "solid-js"
import { createKeyed, type Context, type UiMenuEntry } from "@opencode/plugin/gui"
import { errorMessage, repoOf } from "./actions"
import { agentMarks } from "./activity"
import { latest } from "./queries"
import type { Label, SearchItem } from "./contract"
import { IssueIcon, LabelPill } from "./item"
import { ago, PrIcon, type State } from "./panel"
import { toggleRange } from "./plan"
import { BulkBar, manageReplies, openTriage } from "./triage"

type Kind = "pr" | "issue"
type Saved = NonNullable<State["ctx"]["stores"]["prefs"]["value"]["savedSearches"]>[number]

const PRESETS = {
  pr: [
    { id: "open", query: "is:open" },
    { id: "mine", query: "is:open author:@me" },
    { id: "review", query: "is:open review-requested:@me" },
    { id: "draft", query: "is:open draft:true" },
    { id: "merged", query: "is:merged" },
    { id: "closed", query: "is:closed is:unmerged" },
  ],
  issue: [
    { id: "open", query: "is:open" },
    { id: "assigned", query: "is:open assignee:@me" },
    { id: "created", query: "is:open author:@me" },
    { id: "mentioned", query: "is:open mentions:@me" },
    { id: "closed", query: "is:closed" },
  ],
} as const

const SORTS = [
  { id: "created-desc", key: "list.sort.newest" },
  { id: "created-asc", key: "list.sort.oldest" },
  { id: "updated-desc", key: "list.sort.updated" },
  { id: "updated-asc", key: "list.sort.leastUpdated" },
  { id: "comments-desc", key: "list.sort.comments" },
  { id: "reactions-desc", key: "list.sort.reactions" },
  { id: "interactions-desc", key: "list.sort.interactions" },
] as const
const DEFAULT_SORT = "created-desc"

const KEYS = ["is", "label", "author", "assignee", "milestone", "review", "draft", "sort", "no"] as const
const PR_KEYS = new Set(["review", "draft"])
// Qualifiers listed as removable chips; `sort:` shows in the results header instead.
const CHIP_KEYS = new Set([
  "is",
  "label",
  "author",
  "assignee",
  "milestone",
  "review",
  "draft",
  "no",
  "mentions",
  "involves",
  "commenter",
  "review-requested",
  "reviewed-by",
  "base",
  "head",
  "created",
  "updated",
  "closed",
  "merged",
  "comments",
  "reactions",
  "linked",
  "in",
  "state",
  "type",
  "reason",
])
const REVIEWS = ["approved", "changes_requested", "required", "none"]
const ROW = { compact: 32, comfortable: 48 }
const OVERSCAN = 8

interface Qualifier {
  readonly key: string
  readonly value: string
  readonly negated: boolean
  readonly start: number
  readonly end: number
}

interface Suggestion {
  readonly insert: string
  readonly complete: boolean
  readonly text: string
  readonly hint?: string
  readonly label?: Label
}

interface PickOption {
  readonly value: string
  readonly label?: Label
}

/**
 * Pull requests or issues from a GitHub search: a preset or saved search, filters and free text in GitHub's syntax,
 * and a sort, a page at a time. Only the rows on screen render; pages stay cached per query, so switching back is
 * instant, and check states load per page after the rows.
 */
export function SearchList(props: { state: State; kind: Kind }) {
  const s = props.state
  const ctx = s.ctx
  const ui = ctx.ui
  const t = ctx.t
  const q = s.actions.queries
  const prefs = ctx.stores.prefs
  const listId = createUniqueId()
  const repo = () => repoOf(s.overview())
  const compact = () => prefs.value.compactRows === true
  const rowHeight = () => (compact() ? ROW.compact : ROW.comfortable)

  const saved = () => (prefs.value.savedSearches ?? []).filter((entry) => entry.repo === repo() && entry.kind === props.kind)
  const storedPreset = () => (props.kind === "pr" ? prefs.value.prPreset : prefs.value.issuePreset)
  const base = (): { id: string; query: string; saved?: Saved } => {
    const stored = storedPreset()
    const entry = saved().find((item) => `saved:${item.id}` === stored)
    if (entry) return { id: `saved:${entry.id}`, query: entry.query, saved: entry }
    const preset = PRESETS[props.kind].find((item) => item.id === stored) ?? PRESETS[props.kind][0]
    return { id: preset.id, query: preset.query }
  }
  const choose = (id: string) =>
    prefs.update((draft) => {
      if (props.kind === "pr") draft.prPreset = id
      else draft.issuePreset = id
    })

  const [text, setText] = createSignal("")
  const [search, setSearch] = createSignal("")
  // Waits for a pause in typing before searching, and skips a qualifier still being typed (`label:`, `label:"needs`).
  createKeyed(
    text,
    (value) => {
      const timer = setTimeout(() => {
        if (!incomplete(value)) setSearch(value.trim())
      }, 400)
      onCleanup(() => clearTimeout(timer))
    },
    { otherwise: () => setSearch("") },
  )
  const apply = (next: string) => {
    setText(next)
    setSearch(next.trim())
  }
  // Filters belong to the repository they were typed for.
  createEffect(on(repo, () => apply(""), { defer: true }))

  const applied = createMemo(() => qualifiers(search()))
  const typedSort = () => [...qualifiers(base().query), ...applied()].findLast((item) => item.key === "sort" && !item.negated)?.value
  const storedSort = () => prefs.value.listSort?.[props.kind] ?? DEFAULT_SORT
  const sort = () => typedSort() ?? storedSort()
  const sortLabel = () => {
    const known = SORTS.find((item) => item.id === sort())
    return known ? t(known.key) : t("list.sort.custom")
  }
  const timeField = () => (sort().startsWith("updated") ? "updated" : "created")
  const setSort = (id: string) => {
    prefs.update((draft) => {
      draft.listSort = { ...draft.listSort, [props.kind]: id }
    })
    // A sort typed into the field would win over the menu's choice; the menu's choice replaces it.
    const typed = qualifiers(text()).filter((item) => item.key === "sort")
    if (typed.length > 0) apply(strip(text(), typed))
  }
  const query = () => `${base().query} ${search()}${typedSort() ? "" : ` sort:${storedSort()}`}`.replace(/\s+/g, " ").trim()

  const results = q.infinite(() => ({ ...q.search(repo() ?? "", props.kind, query()), enabled: !!repo() }))
  const pages = () => results.data?.pages ?? []
  const total = () => pages()[0]?.total
  const items = createMemo(() => {
    const known = new Set<number>()
    // A result can move to a later page between fetches while the list is sorted by activity; show it once.
    return pages().flatMap((page) =>
      page.items.filter((item) => {
        if (known.has(item.number)) return false
        known.add(item.number)
        return true
      }),
    )
  })

  // One check-state request per loaded page, whichever of its rows are on screen.
  const pageChecks = mapArray(pages, (page) => {
    const numbers = page.items.filter((item) => item.kind === "pr" && item.state === "OPEN").map((item) => item.number)
    return latest(q.query(() => ({ ...q.options.checks(repo() ?? "", numbers), enabled: props.kind === "pr" && numbers.length > 0 })))
  })
  const marks = createMemo(() => agentMarks(s.agent(), repo() ?? ""))

  // Rows picked for a bulk action, by number, so the selection outlives the virtual scroller's rows.
  const [selected, setSelected] = createSignal<ReadonlySet<number>>(new Set())
  const [anchor, setAnchor] = createSignal<number>()
  const picked = createMemo(() => items().filter((item) => selected().has(item.number)))
  const toggle = (index: number, range: boolean) => {
    setSelected(
      toggleRange(
        selected(),
        items().map((item) => item.number),
        index,
        anchor(),
        range,
      ),
    )
    setAnchor(index)
  }
  const selectAll = () => setSelected(new Set(items().map((item) => item.number)))
  const clearSelection = () => {
    setSelected(new Set<number>())
    setAnchor(undefined)
  }
  const checks = createMemo(() => new Map(pageChecks().flatMap((entry) => entry.latest ?? []).map((entry) => [entry.number, entry.checks])))

  // Marks what changed since the last visit: the previous visit's time stays for this one, and leaving stores now.
  const [since, setSince] = createSignal<number>()
  createKeyed(
    () => repo() && `${repo()}:${props.kind}`,
    (key) => {
      setSince(untrack(() => prefs.value.seen?.[key]))
      onCleanup(() =>
        prefs.update((draft) => {
          draft.seen = { ...draft.seen, [key]: Date.now() }
        }),
      )
    },
  )
  const freshness = (item: SearchItem) => {
    const last = since()
    if (last === undefined) return undefined
    if (Date.parse(item.created) > last) return "new" as const
    if (Date.parse(item.updated) > last) return "updated" as const
    return undefined
  }
  const counts = createMemo(() => {
    const marks = items().map(freshness)
    return { fresh: marks.filter((mark) => mark === "new").length, updated: marks.filter((mark) => mark === "updated").length }
  })

  // Repository metadata, for label, people and milestone suggestions; loaded once the search field is used.
  const [wantMeta, setWantMeta] = createSignal(false)
  const meta = latest(q.query(() => ({ ...q.options.meta(repo() ?? ""), enabled: !!repo() && wantMeta() })))

  /* Virtual scrolling, in the panel's own scroll container. */

  let root: HTMLDivElement | undefined
  let head: HTMLDivElement | undefined
  let scroller: HTMLElement | undefined
  const [rows, setRows] = createSignal<HTMLDivElement>()
  const [view, setView] = createSignal({ top: 0, height: 0 })
  const measure = () => {
    const list = rows()
    if (!list?.isConnected || !scroller) return
    setView({ top: scroller.getBoundingClientRect().top - list.getBoundingClientRect().top, height: scroller.clientHeight })
  }
  let frame = 0
  const schedule = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      measure()
    })
  }
  onMount(() => {
    const container = scrollParent(root)
    scroller = container
    container.addEventListener("scroll", schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(container)
    if (head) observer.observe(head)
    onCleanup(() => {
      cancelAnimationFrame(frame)
      container.removeEventListener("scroll", schedule)
      observer.disconnect()
    })
  })
  createEffect(on(rows, schedule))

  const range = createMemo(() => {
    const h = rowHeight()
    const v = view()
    const count = items().length
    return {
      start: Math.min(count, Math.max(0, Math.floor(v.top / h) - OVERSCAN)),
      end: Math.min(count, Math.max(0, Math.ceil((v.top + v.height) / h) + OVERSCAN)),
    }
  })
  const visible = createMemo(() => items().slice(range().start, range().end))

  // Loads the next page as the rendered window nears the end. A failed page waits for Load more instead of retrying.
  createEffect(() => {
    if (range().end < items().length - 10) return
    if (!results.hasNextPage || results.isFetching || results.isFetchNextPageError || results.isPlaceholderData) return
    void results.fetchNextPage()
  })

  const rowTop = (list: HTMLElement, container: HTMLElement) =>
    list.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
  const reveal = (index: number) => {
    const list = rows()
    if (!list || !scroller) return
    const h = rowHeight()
    const top = rowTop(list, scroller) + index * h
    const covered = head?.offsetHeight ?? 0
    if (top < scroller.scrollTop + covered) scroller.scrollTop = top - covered
    if (top + h > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + h - scroller.clientHeight
    measure()
  }

  const [active, setActive] = createSignal(0)
  const current = () => Math.min(active(), items().length - 1)
  const rowId = (index: number) => `${listId}-row-${index}`
  const select = (index: number) => {
    const next = Math.max(0, Math.min(items().length - 1, index))
    setActive(next)
    reveal(next)
  }

  // A new query starts at its top: first row active, scrolled back to the list's start.
  createKeyed(query, () =>
    untrack(() => {
      setActive(0)
      clearSelection()
      const list = rows()
      if (!list?.isConnected || !scroller) return
      const top = rowTop(list, scroller) - (head?.offsetHeight ?? 0)
      if (scroller.scrollTop > top) scroller.scrollTop = Math.max(0, top)
    }),
  )

  const openMenu = (index: number) => {
    reveal(index)
    document
      .getElementById(rowId(index))
      ?.querySelector(".ghp-row-actions button")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  }

  const NAV = ["ArrowDown", "ArrowUp", "j", "k", "Home", "End", "PageDown", "PageUp"]
  const onListKey = (event: KeyboardEvent) => {
    const list = rows()
    if (!list) return
    if (event.target !== list) {
      // Focus returns to a row's menu button when its menu closes; arrows go back to the list from there.
      if (!NAV.includes(event.key) || !(event.target instanceof Element) || !event.target.closest(".ghp-row-actions")) return
      list.focus()
    }
    const handle = (run: () => void) => {
      event.preventDefault()
      event.stopPropagation()
      run()
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "a") return handle(selectAll)
    if (event.altKey || ((event.metaKey || event.ctrlKey) && event.key !== "Enter")) return
    if (event.key === "Escape" && picked().length > 0) return handle(clearSelection)
    const item = items()[current()]
    if (!item) return
    const page = Math.max(1, Math.floor(view().height / rowHeight()) - 2)
    if (event.key === "x" || event.key === "X") return handle(() => toggle(current(), event.shiftKey))
    if (event.key === "ArrowDown" || event.key === "j") return handle(() => select(current() + 1))
    if (event.key === "ArrowUp" || event.key === "k") return handle(() => select(current() - 1))
    if (event.key === "Home") return handle(() => select(0))
    if (event.key === "End") return handle(() => select(items().length - 1))
    if (event.key === "PageDown") return handle(() => select(current() + page))
    if (event.key === "PageUp") return handle(() => select(current() - page))
    if (event.key === "Enter") return handle(() => openItem(s, item, event.metaKey || event.ctrlKey))
    if (event.key === "a" && !event.shiftKey) return handle(() => void s.actions.ask({ repo: item.repo, number: item.number }, undefined))
    if (event.key === "." || event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) return handle(() => openMenu(current()))
  }

  /* The search field, with qualifier suggestions. */

  const [input, setInput] = createSignal<HTMLInputElement>()
  const [caret, setCaret] = createSignal(0)
  const [focused, setFocused] = createSignal(false)
  const [suggesting, setSuggesting] = createSignal(false)
  const [highlight, setHighlight] = createSignal(-1)
  const token = createMemo(() => tokenAt(text(), caret()))

  const values = (key: string): { value: string; label?: Label; hint?: string }[] => {
    const known = meta.latest
    if (key === "is") return (props.kind === "pr" ? ["open", "closed", "merged", "unmerged", "draft"] : ["open", "closed"]).map((value) => ({ value }))
    if (key === "label") return (known?.labels ?? []).map((label) => ({ value: label.name, label }))
    if (key === "author" || key === "assignee") return ["@me", ...(known?.people ?? [])].map((value) => ({ value, hint: value === "@me" ? t("list.me") : undefined }))
    if (key === "milestone") return (known?.milestones ?? []).map((value) => ({ value }))
    if (key === "review") return REVIEWS.map((value) => ({ value }))
    if (key === "draft") return ["true", "false"].map((value) => ({ value }))
    if (key === "sort") return SORTS.map((item) => ({ value: item.id, hint: t(item.key) }))
    if (key === "no") return ["label", "assignee", "milestone"].map((value) => ({ value }))
    return []
  }

  const suggestions = createMemo((): Suggestion[] => {
    const tok = token()
    if (!tok) return []
    const keys = KEYS.filter((key) => props.kind === "pr" || !PR_KEYS.has(key))
    if (tok.key === undefined) {
      const word = tok.value.toLowerCase()
      return keys
        .filter((key) => key.startsWith(word))
        .map((key) => ({ insert: `${tok.negated}${key}:`, complete: false, text: `${key}:`, hint: t(`list.key.${key}`) }))
    }
    const key = tok.key
    const needle = tok.value.toLowerCase()
    return values(key)
      .filter((option) => option.value.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.value.toLowerCase().startsWith(needle)) - Number(a.value.toLowerCase().startsWith(needle)))
      .slice(0, 50)
      .map((option) => ({ insert: `${tok.negated}${key}:${format(option.value)} `, complete: true, text: option.value, hint: option.hint, label: option.label }))
  })
  const showing = () => focused() && suggesting() && suggestions().length > 0
  const suggestId = `${listId}-suggest`
  const optionId = (index: number) => `${suggestId}-${index}`

  // A bare word suggests qualifier names without picking one, so Enter still searches for the word; a value list
  // starts on its first entry.
  createEffect(on(() => `${token()?.key ?? ""}\u0000${token()?.value ?? ""}`, () => setHighlight(token()?.key === undefined ? -1 : 0)))

  createEffect(() => {
    const element = input()
    if (!element) return
    element.setAttribute("role", "combobox")
    element.setAttribute("aria-autocomplete", "list")
    element.setAttribute("aria-controls", suggestId)
    element.setAttribute("aria-expanded", String(showing()))
    const index = highlight()
    if (showing() && index >= 0) element.setAttribute("aria-activedescendant", optionId(index))
    if (!showing() || index < 0) element.removeAttribute("aria-activedescendant")
  })
  createEffect(() => {
    if (showing() && highlight() >= 0) document.getElementById(optionId(highlight()))?.scrollIntoView({ block: "nearest" })
  })

  const syncCaret = () => setCaret(input()?.selectionStart ?? text().length)
  const accept = (suggestion: Suggestion) => {
    const tok = token()
    const element = input()
    if (!tok || !element) return
    const rest = text().slice(tok.end)
    const next = text().slice(0, tok.start) + suggestion.insert + (suggestion.complete ? rest.replace(/^\s+/, "") : rest)
    const position = tok.start + suggestion.insert.length
    setText(next)
    setCaret(position)
    queueMicrotask(() => element.setSelectionRange(position, position))
    if (!suggestion.complete) return setSuggesting(true)
    setSuggesting(false)
    setSearch(next.trim())
  }

  const onSearchKey = (event: KeyboardEvent) => {
    if (event.isComposing) return
    const list = suggestions()
    const open = showing()
    const handle = (run: () => void) => {
      event.preventDefault()
      event.stopPropagation()
      run()
    }
    if (event.key === "ArrowDown")
      return handle(() => {
        if (!open) {
          setSuggesting(true)
          return
        }
        setHighlight((highlight() + 1) % list.length)
      })
    if (event.key === "ArrowUp" && open) return handle(() => setHighlight(highlight() <= 0 ? list.length - 1 : highlight() - 1))
    const chosen = list[Math.max(0, highlight())]
    if (event.key === "Enter" && open && chosen && highlight() >= 0) return handle(() => accept(chosen))
    if (event.key === "Tab" && !event.shiftKey && open && chosen) return handle(() => accept(chosen))
    if (event.key === "Escape")
      return handle(() => {
        if (open) return setSuggesting(false)
        rows()?.focus()
      })
  }

  const searchBox = (element: HTMLDivElement) => {
    element.addEventListener("keydown", onSearchKey, true)
    element.addEventListener("keyup", syncCaret)
    element.addEventListener("click", syncCaret)
    element.addEventListener("input", () => {
      // Runs before the field's own handler, which the app delegates to the document: read the text from the field.
      setText(input()?.value ?? text())
      syncCaret()
      const tok = token()
      setSuggesting(!!tok && (tok.key !== undefined || tok.value !== ""))
    })
    element.addEventListener("focusin", () => {
      setFocused(true)
      setWantMeta(true)
    })
    element.addEventListener("focusout", () => {
      setFocused(false)
      setSuggesting(false)
    })
    onMount(() => setInput(element.querySelector("input") ?? undefined))
  }

  /* Filters and sort. */

  const chips = () => applied().filter((item) => CHIP_KEYS.has(item.key))
  const removeChip = (chip: Qualifier) => {
    const typed = qualifiers(text()).filter((item) => item.key === chip.key && item.value === chip.value && item.negated === chip.negated)
    apply(strip(text(), typed))
  }
  const addFilter = (key: string, value: string, multiple = false) => {
    const current = text()
    const existing = qualifiers(current).filter((item) => item.key === key && !item.negated)
    if (multiple && existing.some((item) => item.value === value)) return
    apply(`${multiple ? current : strip(current, existing)} ${key}:${format(value)}`.trim())
  }
  const clear = () => apply("")

  const pick = async (field: "label" | "author" | "assignee" | "milestone") => {
    const name = repo()
    if (!name) return
    const known = await s.actions.attempt(() => q.client.fetchQuery(q.options.meta(name)))
    if (!known) return
    const options: PickOption[] =
      field === "label"
        ? known.labels.map((label) => ({ value: label.name, label }))
        : field === "milestone"
          ? known.milestones.map((value) => ({ value }))
          : ["@me", ...known.people].map((value) => ({ value }))
    const value = await new Promise<string | undefined>((resolve) => {
      // The dialog unmounts however it closes; resolving twice is a no-op, so Escape and outside clicks answer undefined.
      ctx.dialogs.open((dialog) => (
        <Picker
          ctx={ctx}
          title={t(`list.filter.${field}`)}
          options={options}
          custom={field === "author" || field === "assignee"}
          onClose={() => resolve(undefined)}
          onPick={(picked) => {
            resolve(picked)
            dialog.close()
          }}
        />
      ))
    })
    if (value) addFilter(field, value, field === "label")
  }

  const filterItems = (): UiMenuEntry[] => [
    { label: t("list.filter.label"), icon: "edit", onSelect: () => void pick("label") },
    { label: t("list.filter.author"), icon: "edit", onSelect: () => void pick("author") },
    { label: t("list.filter.assignee"), icon: "edit", onSelect: () => void pick("assignee") },
    { label: t("list.filter.milestone"), icon: "edit", onSelect: () => void pick("milestone") },
    ...(props.kind === "pr"
      ? [
          {
            type: "group" as const,
            label: t("list.filter.review"),
            items: REVIEWS.map((value) => ({ label: t(`list.review.${value}`), onSelect: () => addFilter("review", value) })),
          },
          {
            type: "group" as const,
            label: t("list.filter.draft"),
            items: [
              { label: t("list.draft.true"), onSelect: () => addFilter("draft", "true") },
              { label: t("list.draft.false"), onSelect: () => addFilter("draft", "false") },
            ],
          },
        ]
      : []),
    {
      type: "group",
      label: t("list.filter.missing"),
      items: ["label", "assignee", "milestone"].map((value) => ({ label: t(`list.no.${value}`), onSelect: () => addFilter("no", value, true) })),
    },
  ]

  const sortItems = (): UiMenuEntry[] =>
    SORTS.map((item) => ({ label: t(item.key), icon: item.id === sort() ? ("check" as const) : undefined, onSelect: () => setSort(item.id) }))

  /* Saved searches. */

  // The sort is the list's own choice, so a saved search keeps only what it filters.
  const savedQuery = () => strip(`${base().query} ${search()}`, qualifiers(`${base().query} ${search()}`).filter((item) => item.key === "sort"))
  const normal = (value: string) => value.replace(/\s+/g, " ").trim()
  const savable = () =>
    normal(savedQuery()) !== normal(base().query) && ![...PRESETS[props.kind], ...saved()].some((item) => normal(item.query) === normal(savedQuery()))
  const updateSaved = (change: (list: Saved[]) => Saved[]) =>
    prefs.update((draft) => {
      draft.savedSearches = change([...(draft.savedSearches ?? [])])
    })
  const save = async () => {
    const name = repo()
    if (!name) return
    const title = await ctx.dialogs.prompt({ title: t("list.save.title"), placeholder: t("list.save.placeholder"), value: search(), submit: t("list.save.submit") })
    if (!title?.trim()) return
    const id = crypto.randomUUID()
    const query = savedQuery()
    updateSaved((list) => [...list, { id, repo: name, kind: props.kind, name: title.trim(), query }])
    choose(`saved:${id}`)
    apply("")
  }
  const rename = async (entry: Saved) => {
    const title = await ctx.dialogs.prompt({ title: t("list.rename.title"), value: entry.name, submit: t("list.rename.submit") })
    if (!title?.trim()) return
    updateSaved((list) => list.map((item) => (item.id === entry.id ? { ...item, name: title.trim() } : item)))
  }
  const remove = (entry: Saved) => {
    if (base().saved?.id === entry.id) choose(PRESETS[props.kind][0].id)
    updateSaved((list) => list.filter((item) => item.id !== entry.id))
  }

  const moreItems = (): UiMenuEntry[] => {
    const entry = base().saved
    return [
      ...(savable() ? [{ label: t("list.save.action"), icon: "plus" as const, onSelect: () => void save() }] : []),
      ...(entry
        ? [
            { label: t("list.rename.action", { name: entry.name }), icon: "edit" as const, onSelect: () => void rename(entry) },
            { label: t("list.delete.action", { name: entry.name }), icon: "trash" as const, onSelect: () => remove(entry) },
          ]
        : []),
      ...(search() ? [{ label: t("list.clear"), icon: "xmark-small" as const, onSelect: clear }] : []),
      { type: "separator" },
      { label: t("triage.action"), icon: "brain", disabled: !repo() || !total(), onSelect: triage },
      { label: t("triage.replies.manage"), icon: "speech-bubble", disabled: !repo(), onSelect: () => manageReplies(ctx, repo() ?? "") },
      {
        type: "group",
        label: t("list.density"),
        items: [
          { label: t("list.comfortable"), icon: compact() ? undefined : ("check" as const), onSelect: () => setCompact(false) },
          { label: t("list.compact"), icon: compact() ? ("check" as const) : undefined, onSelect: () => setCompact(true) },
        ],
      },
    ]
  }
  // The agent searches both kinds unless told which.
  const triage = () => {
    const name = repo()
    if (!name) return
    const scoped = qualifiers(query()).some((item) => item.key === "is" && !item.negated && (item.value === "issue" || item.value === "pr"))
    openTriage(s, { kind: props.kind, repo: name, query: scoped ? query() : `is:${props.kind} ${query()}`, numbers: [], total: total() ?? 0 })
  }
  const setCompact = (value: boolean) =>
    prefs.update((draft) => {
      draft.compactRows = value
    })

  /* Preset chips scroll sideways, with faded edges where more is hidden. */

  const [fade, setFade] = createSignal({ start: false, end: false })
  const chipStrip = (element: HTMLDivElement) => {
    const update = () =>
      setFade({ start: element.scrollLeft > 1, end: element.scrollLeft + element.clientWidth < element.scrollWidth - 1 })
    element.addEventListener("scroll", update, { passive: true })
    element.addEventListener(
      "wheel",
      (event) => {
        if (event.deltaX !== 0 || element.scrollWidth <= element.clientWidth) return
        element.scrollLeft += event.deltaY
        event.preventDefault()
      },
      { passive: false },
    )
    const observer = new ResizeObserver(update)
    observer.observe(element)
    onCleanup(() => observer.disconnect())
    createEffect(on(() => saved().length, () => requestAnimationFrame(update)))
  }

  return (
    <div
      class="ghp-list"
      data-density={compact() ? "compact" : "comfortable"}
      ref={root}
      onKeyDown={(event) => {
        if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return
        if (event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))) return
        event.preventDefault()
        input()?.focus()
      }}
    >
      <div class="ghp-list-head" ref={head}>
        <div class="ghp-list-presets">
          <div class="ghp-chips" role="group" aria-label={t("list.presets")} data-fade-start={fade().start ? "" : undefined} data-fade-end={fade().end ? "" : undefined} ref={chipStrip}>
            <For each={PRESETS[props.kind]}>
              {(item) => (
                <button type="button" class="ghp-chip" aria-pressed={base().id === item.id} data-selected={base().id === item.id ? "" : undefined} onClick={() => choose(item.id)}>
                  {t(`search.${props.kind}.${item.id}`)}
                </button>
              )}
            </For>
            <For each={saved()}>
              {(entry) => (
                <span class="ghp-chip ghp-chip-saved" data-selected={base().saved?.id === entry.id ? "" : undefined}>
                  <button type="button" class="ghp-chip-label" aria-pressed={base().saved?.id === entry.id} title={entry.query} onClick={() => choose(`saved:${entry.id}`)}>
                    {entry.name}
                  </button>
                  <button type="button" class="ghp-chip-remove" aria-label={t("list.delete.action", { name: entry.name })} onClick={() => remove(entry)}>
                    <ui.Icon name="xmark-small" size="small" />
                  </button>
                </span>
              )}
            </For>
          </div>
          <Show when={results.isFetching && !results.isFetchingNextPage}>
            <ui.Loader size="small" />
          </Show>
          <ui.Tooltip value={t("action.refresh")}>
            <ui.IconButton icon="refresh" label={t("action.refresh")} size="small" variant="ghost" onClick={() => void results.refetch()} />
          </ui.Tooltip>
          <Show when={props.kind === "issue"}>
            <ui.Tooltip value={t("issues.new")}>
              <ui.IconButton icon="plus" label={t("issues.new")} size="small" variant="ghost" onClick={() => void s.actions.createIssue(s.cwd())} />
            </ui.Tooltip>
          </Show>
        </div>

        <div class="ghp-list-toolbar">
          <div class="ghp-search" ref={searchBox}>
            <ui.TextInput
              class="ghp-search-input"
              label={t("list.placeholder")}
              placeholder={t("list.placeholder")}
              type="search"
              value={text()}
              onInput={setText}
              onSubmit={(value) => {
                setSuggesting(false)
                setSearch(value.trim())
              }}
            />
            <Show when={showing()}>
              <div class="ghp-search-suggest" id={suggestId} role="listbox" aria-label={t("list.suggestions")}>
                <For each={suggestions()}>
                  {(suggestion, index) => (
                    <div
                      class="ghp-search-option"
                      id={optionId(index())}
                      role="option"
                      aria-selected={highlight() === index()}
                      data-active={highlight() === index() ? "" : undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => setHighlight(index())}
                      onClick={() => accept(suggestion)}
                    >
                      <Show when={suggestion.label}>{(label) => <span class="ghp-swatch" style={{ "--ghp-label": `#${label().color}` }} />}</Show>
                      <span class="ghp-ellipsis">{suggestion.text}</span>
                      <Show when={suggestion.hint}>
                        <span class="ghp-search-option-hint ghp-ellipsis">{suggestion.hint}</span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <ui.Menu label={t("list.filter")} trigger="icon" icon="outline-sliders" placement="bottom-end" items={filterItems()} />
          <ui.Menu label={t("action.more")} trigger="icon" icon="outline-dots" placement="bottom-end" items={moreItems()} />
        </div>

        <Show when={chips().length > 0}>
          <div class="ghp-list-filters">
            <For each={chips()}>
              {(chip) => {
                const label = () => (chip.key === "label" ? meta.latest?.labels.find((item) => item.name === chip.value) : undefined)
                return (
                  <span class="ghp-filter-chip" data-negated={chip.negated ? "" : undefined}>
                    <Show when={label()}>{(known) => <span class="ghp-swatch" style={{ "--ghp-label": `#${known().color}` }} />}</Show>
                    <span class="ghp-filter-chip-key">
                      {chip.negated ? "-" : ""}
                      {chip.key}:
                    </span>
                    <span class="ghp-filter-chip-value ghp-ellipsis">{chip.value}</span>
                    <button type="button" class="ghp-filter-chip-remove" aria-label={t("list.removeFilter", { filter: `${chip.key}:${chip.value}` })} onClick={() => removeChip(chip)}>
                      <ui.Icon name="xmark-small" size="small" />
                    </button>
                  </span>
                )
              }}
            </For>
          </div>
        </Show>

        <Show
          when={picked().length > 0 && repo()}
          fallback={
            <div class="ghp-list-summary">
              <span class="ghp-list-count ghp-ellipsis">
                <Show when={total() !== undefined}>{ctx.plural(`search.count.${props.kind}`, total() ?? 0)}</Show>
                <Show when={counts().fresh > 0}>
                  <span class="ghp-list-new"> · {t("list.newCount", { count: counts().fresh })}</span>
                </Show>
                <Show when={counts().updated > 0}>
                  <span class="ghp-faint"> · {t("list.updatedCount", { count: counts().updated })}</span>
                </Show>
              </span>
              <Show when={savable()}>
                <ui.Button size="small" variant="ghost" icon="plus-small" class="ghp-list-save" onClick={() => void save()}>
                  {t("list.save.short")}
                </ui.Button>
              </Show>
              <div class="ghp-list-sort" title={t("list.sort")}>
                <ui.Menu label={sortLabel()} trigger="button" placement="bottom-end" items={sortItems()} />
              </div>
            </div>
          }
        >
          {(name) => <BulkBar state={s} kind={props.kind} repo={name()} items={picked()} loaded={items().length} onClear={clearSelection} onSelectAll={selectAll} />}
        </Show>
      </div>

      <Show when={repo()} fallback={<div class="ghp-empty ghp-empty-inline">{t("list.noRemote")}</div>}>
        <Show
          when={results.data}
          fallback={
            <div class="ghp-empty ghp-empty-inline ghp-list-error">
              <Show when={results.error} fallback={<ui.Loader />}>
                <span>{errorMessage(results.error)}</span>
                <div class="ghp-list-error-actions">
                  <ui.Button size="small" variant="neutral" icon="refresh" onClick={() => void results.refetch()}>
                    {t("action.retry")}
                  </ui.Button>
                  <Show when={search()}>
                    <ui.Button size="small" variant="ghost" onClick={clear}>
                      {t("list.clear")}
                    </ui.Button>
                  </Show>
                </div>
              </Show>
            </div>
          }
        >
          <Show
            when={items().length > 0}
            fallback={
              <div class="ghp-empty ghp-empty-inline ghp-list-empty">
                <span>{t("list.empty")}</span>
                <Show when={search()}>
                  <ui.Button size="small" variant="neutral" onClick={clear}>
                    {t("list.clear")}
                  </ui.Button>
                </Show>
              </div>
            }
          >
            <div
              class="ghp-results"
              role="listbox"
              tabIndex={0}
              aria-label={t(props.kind === "pr" ? "view.pulls" : "view.issues")}
              aria-activedescendant={current() >= range().start && current() < range().end ? rowId(current()) : undefined}
              aria-multiselectable={picked().length > 0 ? "true" : undefined}
              data-stale={results.isPlaceholderData ? "" : undefined}
              data-selecting={picked().length > 0 ? "" : undefined}
              style={{ height: `${items().length * rowHeight()}px` }}
              ref={(element) => {
                setRows(element)
                element.addEventListener("keydown", onListKey, true)
              }}
            >
              <For each={visible()}>
                {(item, index) => (
                  <ItemRow
                    state={s}
                    item={item}
                    checks={checks().get(item.number) ?? item.checks}
                    id={rowId(range().start + index())}
                    index={range().start + index()}
                    top={(range().start + index()) * rowHeight()}
                    active={current() === range().start + index()}
                    mark={freshness(item)}
                    agent={marks().get(item.number)}
                    compact={compact()}
                    time={timeField()}
                    picked={selected().has(item.number)}
                    onSelect={setActive}
                    onPick={toggle}
                  />
                )}
              </For>
            </div>
          </Show>
          <Show when={results.hasNextPage}>
            <div class="ghp-more">
              <Show when={results.isFetchNextPageError}>
                <span class="ghp-faint ghp-ellipsis">{errorMessage(results.error)}</span>
              </Show>
              <ui.Button size="small" variant="ghost" busy={results.isFetchingNextPage} onClick={() => void results.fetchNextPage()}>
                {t("search.more")}
              </ui.Button>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

function ItemRow(props: {
  state: State
  item: SearchItem
  checks: SearchItem["checks"]
  id: string
  index: number
  top: number
  active: boolean
  mark: "new" | "updated" | undefined
  /** The agent proposed a change to this row in this session, or made one. */
  agent: "pending" | "done" | undefined
  compact: boolean
  time: "created" | "updated"
  /** Picked for a bulk action. */
  picked: boolean
  onSelect: (index: number) => void
  onPick: (index: number, range: boolean) => void
}) {
  const s = props.state
  const ctx = s.ctx
  const ui = ctx.ui
  const t = ctx.t
  const q = s.actions.queries
  const ref = () => ({ repo: props.item.repo, number: props.item.number })
  const state = () => (props.item.draft && props.item.state === "OPEN" ? "DRAFT" : props.item.state)
  const stamp = () => Date.parse(props.time === "created" ? props.item.created : props.item.updated)
  const short = () => ago(stamp() / 1000)
  const when = () => {
    const kind = props.time === "created" ? "opened" : "updated"
    return short() === "now" ? t(`list.time.${kind}Now`) : t(`list.time.${kind}`, { time: short() })
  }
  const whenFull = () => t(props.time === "created" ? "list.time.openedFull" : "list.time.updatedFull", { time: relative(stamp()), date: new Date(stamp()).toLocaleString() })
  const shown = () => props.item.labels.slice(0, 2)
  const hidden = () => props.item.labels.slice(2)
  let actions: HTMLDivElement | undefined
  let prefetch: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(prefetch))
  // Only the list is a tab stop; a row's menu opens with `.`, Shift+F10 or a right click.
  onMount(() => actions?.querySelector("button")?.setAttribute("tabindex", "-1"))

  const items = (): UiMenuEntry[] => [
    { label: t("action.openDetails"), icon: "info", onSelect: () => openItem(s, props.item, false) },
    { label: t("action.openOnGitHub"), icon: "square-arrow-top-right", onSelect: () => openItem(s, props.item, true) },
    { label: t("action.copyLink"), icon: "link", onSelect: () => void s.actions.copy(props.item.url) },
    { type: "separator" },
    ...(props.item.kind === "issue" && props.item.state === "OPEN"
      ? [{ label: t("action.startIssue"), icon: "branch-out" as const, onSelect: () => void s.run("branch", () => s.actions.startIssue(s.cwd(), props.item)) }]
      : []),
    ...s.actions.agentMenu(ref(), props.item.kind),
    ...(props.item.kind === "pr" && props.item.state === "OPEN"
      ? [
          { type: "separator" as const },
          {
            label: t("action.checkoutPr"),
            icon: "enter" as const,
            disabled: props.item.head === s.overview().branch,
            onSelect: () =>
              void s.run("checkout", () =>
                s.actions.progress(
                  t("action.checkoutPr"),
                  () => s.actions.git.checkoutPr({ cwd: s.cwd(), number: props.item.number, repo: null }),
                  t("toast.switched", { name: props.item.head ?? "" }),
                ),
              ),
          },
          {
            label: t("action.mergePr"),
            icon: "fork" as const,
            disabled: props.item.draft,
            onSelect: () =>
              void s.run("merge", () => s.actions.mergePr(s.cwd(), { number: props.item.number, title: props.item.title, head: props.item.head ?? "" })),
          },
        ]
      : []),
  ]

  const labels = () => (
    <Show when={props.item.labels.length > 0}>
      <span class="ghp-pr-labels" title={props.item.labels.map((label) => label.name).join(", ")}>
        <For each={shown()}>{(label) => <LabelPill label={label} />}</For>
        <Show when={hidden().length > 0}>
          <span class="ghp-pill ghp-pr-more">+{hidden().length}</span>
        </Show>
      </span>
    </Show>
  )

  return (
    <div
      class="ghp-pr"
      id={props.id}
      role="option"
      aria-selected={props.active}
      data-active={props.active ? "" : undefined}
      data-mark={props.mark}
      data-picked={props.picked ? "" : undefined}
      data-current={props.item.kind === "pr" && props.item.head === s.overview().branch ? "" : undefined}
      style={{ transform: `translateY(${props.top}px)` }}
      // Starts loading the details once the pointer rests on the row, so opening it is instant; scrolling past does not.
      onMouseEnter={() => {
        clearTimeout(prefetch)
        prefetch = setTimeout(() => q.prefetch(q.options.item(ref())), 150)
      }}
      onMouseLeave={() => clearTimeout(prefetch)}
      // Shift-click picks a range of rows; without this it would also select their text.
      onMouseDown={(event) => event.shiftKey && event.preventDefault()}
      onClick={(event) => {
        props.onSelect(props.index)
        if (event.shiftKey) return props.onPick(props.index, true)
        openItem(s, props.item, event.metaKey || event.ctrlKey)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        props.onSelect(props.index)
        actions?.querySelector("button")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))
      }}
    >
      <span class="ghp-pr-state" data-state={props.item.kind === "issue" && props.item.state === "CLOSED" ? "MERGED" : state()}>
        <Show when={props.item.kind === "pr"} fallback={<IssueIcon state={props.item.state} />}>
          <PrIcon state={state()} />
        </Show>
        <button
          type="button"
          class="ghp-pr-check"
          role="checkbox"
          tabIndex={-1}
          aria-checked={props.picked}
          aria-label={t("list.pick", { number: props.item.number })}
          onClick={(event) => {
            event.stopPropagation()
            props.onSelect(props.index)
            props.onPick(props.index, event.shiftKey)
          }}
        >
          <Show when={props.picked}>
            <ui.Icon name="check-small" size="small" />
          </Show>
        </button>
      </span>
      <div class="ghp-pr-main">
        <div class="ghp-pr-title">
          <Show when={props.mark}>
            {(mark) => <span class="ghp-pr-mark" data-mark={mark()} title={t(`list.mark.${mark()}`)} aria-label={t(`list.mark.${mark()}`)} />}
          </Show>
          <span class="ghp-ellipsis" title={props.item.title}>
            {props.item.title}
          </span>
          <span class="ghp-faint ghp-pr-number">#{props.item.number}</span>
          <Show when={props.agent}>
            {(agent) => (
              <span class="ghp-pr-agent" data-agent={agent()} title={t(`activity.mark.${agent()}`)} aria-label={t(`activity.mark.${agent()}`)}>
                <ui.Icon name="brain" size="small" />
              </span>
            )}
          </Show>
          <Show when={props.compact}>{labels()}</Show>
        </div>
        <Show when={!props.compact}>
          <div class="ghp-pr-sub">
            <span class="ghp-ellipsis" title={whenFull()}>
              {props.item.author} · {when()}
              {props.item.head ? ` · ${props.item.head} → ${props.item.base}` : ""}
            </span>
            {labels()}
          </div>
        </Show>
      </div>
      <div class="ghp-pr-meta">
        <Show when={!props.compact && props.item.state === "OPEN" && props.item.review}>
          {(review) => (
            <span class="ghp-pill" data-review={review()}>
              {t(`pulls.review.${review()}`)}
            </span>
          )}
        </Show>
        <Show when={props.item.kind === "pr"}>
          <span class="ghp-pr-checks" data-checks={props.checks} title={props.item.state === "OPEN" && props.checks !== "none" ? t(`pulls.checks.${props.checks}`) : undefined}>
            <Show when={props.item.state === "OPEN"}>
              <Show when={props.checks === "success"}>
                <ui.Icon name="check-small" size="small" />
              </Show>
              <Show when={props.checks === "failure"}>
                <ui.Icon name="xmark-small" size="small" />
              </Show>
              <Show when={props.checks === "pending"}>
                <span class="ghp-pr-pending" />
              </Show>
            </Show>
          </span>
        </Show>
        <span class="ghp-pr-comments" title={props.item.comments > 0 ? ctx.plural("list.comments", props.item.comments) : undefined}>
          <Show when={props.item.comments > 0}>
            <ui.Icon name="speech-bubble" size="small" />
            <span>{props.item.comments}</span>
          </Show>
        </span>
        <Show when={props.compact}>
          <span class="ghp-pr-time" title={whenFull()}>
            {short()}
          </span>
        </Show>
      </div>
      <div class="ghp-row-actions" ref={actions} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}>
        <ui.Menu label={t("action.more")} trigger="icon" icon="outline-dots" placement="bottom-end" items={items()} />
      </div>
    </div>
  )
}

function Picker(props: { ctx: Context; title: string; options: readonly PickOption[]; custom: boolean; onPick: (value: string) => void; onClose: () => void }) {
  onCleanup(props.onClose)
  const ui = props.ctx.ui
  const t = props.ctx.t
  const id = createUniqueId()
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const visible = createMemo((): PickOption[] => {
    const typed = query().trim()
    const needle = typed.toLowerCase()
    const matches = props.options.filter((option) => option.value.toLowerCase().includes(needle)).slice(0, 200)
    const exact = props.options.some((option) => option.value.toLowerCase() === needle)
    return props.custom && typed && !exact ? [...matches, { value: typed }] : matches
  })
  createEffect(on(query, () => setActive(0), { defer: true }))
  createEffect(() => document.getElementById(`${id}-${active()}`)?.scrollIntoView({ block: "nearest" }))
  const choose = (index: number) => {
    const option = visible()[index]
    if (option) props.onPick(option.value)
  }
  return (
    <ui.Dialog title={props.title} size="normal">
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
          choose(active())
        }}
      >
        <ui.TextInput label={t("edit.filter")} placeholder={t("edit.filter")} type="search" value={query()} onInput={setQuery} autofocus />
        <div class="ghp-list-picks" role="listbox" aria-label={props.title}>
          <For each={visible()} fallback={<div class="ghp-faint ghp-pad">{t("edit.nothing")}</div>}>
            {(option, index) => (
              <div
                class="ghp-list-pick"
                id={`${id}-${index()}`}
                role="option"
                aria-selected={active() === index()}
                data-active={active() === index() ? "" : undefined}
                onMouseMove={() => setActive(index())}
                onClick={() => choose(index())}
              >
                <Show when={option.label} fallback={<span class="ghp-ellipsis">{props.options.includes(option) ? option.value : t("list.pick.use", { value: option.value })}</span>}>
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

function openItem(s: State, item: SearchItem, external: boolean) {
  if (!external) return s.actions.openItem({ repo: item.repo, number: item.number })
  s.ctx.system.openExternal(item.url)
}

/** The `key:value` qualifiers of a GitHub search, in order, with quoted values unquoted. */
function qualifiers(text: string): Qualifier[] {
  return [...text.matchAll(/(^|\s)(-?)([a-z-]+):(?:"([^"]*)"?|(\S+))/gi)].map((match) => ({
    key: (match[3] ?? "").toLowerCase(),
    value: match[4] ?? match[5] ?? "",
    negated: match[2] === "-",
    start: match.index + (match[1] ?? "").length,
    end: match.index + match[0].length,
  }))
}

/** The search without some of its qualifiers; removed from the end first so earlier positions stay valid. */
function strip(text: string, remove: readonly Qualifier[]) {
  return remove
    .reduceRight((rest, item) => rest.slice(0, item.start) + rest.slice(item.end), text)
    .replace(/\s+/g, " ")
    .trim()
}

function format(value: string) {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', "")}"` : value
}

/** A qualifier the user is still typing: a key without a value, or an open quote. */
function incomplete(text: string) {
  return /(^|\s)-?[a-z-]+:$/i.test(text.trimEnd()) || (text.match(/"/g)?.length ?? 0) % 2 === 1
}

/** The word under the caret: a qualifier's key and partial value, or a bare word that may become a key. */
function tokenAt(text: string, caret: number) {
  const before = text.slice(0, caret)
  const quoted = /(^|\s)(-?)([a-z-]+):"([^"]*)$/i.exec(before)
  const match = quoted ?? /(^|\s)(-?)(?:([a-z-]+):)?([^\s"]*)$/i.exec(before)
  if (!match) return undefined
  const tail = (quoted ? /^[^"]*"?/ : /^\S*/).exec(text.slice(caret))
  return {
    start: match.index + (match[1] ?? "").length,
    end: caret + (tail?.[0].length ?? 0),
    negated: match[2] ?? "",
    key: match[3]?.toLowerCase(),
    value: match[4] ?? "",
  }
}

/** The nearest ancestor that scrolls vertically: the panel body. */
function scrollParent(element: HTMLElement | undefined): HTMLElement {
  const found = (node: HTMLElement | null): HTMLElement | undefined => {
    if (!node) return undefined
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node
    return found(node.parentElement)
  }
  return found(element?.parentElement ?? null) ?? element?.parentElement ?? document.documentElement
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
const UNITS = [
  { unit: "year", seconds: 31_536_000 },
  { unit: "month", seconds: 2_592_000 },
  { unit: "day", seconds: 86_400 },
  { unit: "hour", seconds: 3600 },
  { unit: "minute", seconds: 60 },
] as const

function relative(ms: number) {
  const seconds = Math.round((ms - Date.now()) / 1000)
  const unit = UNITS.find((entry) => Math.abs(seconds) >= entry.seconds)
  if (!unit) return RELATIVE.format(0, "second")
  return RELATIVE.format(Math.round(seconds / unit.seconds), unit.unit)
}
