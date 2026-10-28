import type { AgentAction, AgentKind, AgentPayload, CloseReason } from "./schemas"

// The agent's GitHub actions as plain data: what a tool call asks for, what a shell command did, what undoes what, and
// when to retry. No I/O here; the server part, the window and the tests share it.

export const MAX_BATCH = 100
export const MAX_BODY = 65_536
const MAX_NOTE = 1000
const RETRIES = 3
/** A running action this old was left by a server that stopped; it is not running anymore. */
export const STALE = 15 * 60_000

export type WriteKind = "comment" | "close" | "reopen" | "label" | "assign"

/** A write tool's input, checked: one action per number. */
export interface Proposal {
  readonly repo: string | null
  readonly numbers: readonly number[]
  readonly kind: WriteKind
  readonly payload: AgentPayload
  readonly note: string
}

/** Checks a write tool's input and says what is wrong in words the agent can act on. */
export function parseWrite(kind: WriteKind, input: unknown): Proposal {
  if (typeof input !== "object" || input === null) throw new Error("Pass the arguments as an object.")
  const value = input as Record<string, unknown>
  const repo = value.repo === undefined || value.repo === null || value.repo === "" ? null : checkRepo(value.repo)
  const numbers = checkNumbers(value.numbers)
  const note = typeof value.note === "string" ? value.note.trim() : ""
  if (!note) throw new Error("`note` is required: one short sentence telling the user why, shown next to the action.")
  return { repo, numbers, kind, payload: payloadOf(kind, value, numbers), note: note.slice(0, MAX_NOTE) }
}

function payloadOf(kind: WriteKind, value: Record<string, unknown>, numbers: readonly number[]): AgentPayload {
  if (kind === "comment") return { body: checkBody(value.body, "body", true) }
  if (kind === "reopen") return optionalBody(value.comment)
  if (kind === "close") {
    const duplicateOf = value.duplicate_of === undefined || value.duplicate_of === null ? undefined : checkNumber(value.duplicate_of, "duplicate_of")
    const reason = value.reason === undefined || value.reason === null ? (duplicateOf ? "duplicate" : "completed") : checkReason(value.reason)
    if (reason === "duplicate" && !duplicateOf) throw new Error("`duplicate_of` is required when `reason` is \"duplicate\": the number of the issue to keep.")
    if (reason !== "duplicate" && duplicateOf) throw new Error("`duplicate_of` only goes with `reason` \"duplicate\".")
    if (duplicateOf && numbers.includes(duplicateOf)) throw new Error(`#${duplicateOf} cannot be closed as a duplicate of itself.`)
    return { reason, ...(duplicateOf ? { duplicateOf } : {}), ...optionalBody(value.comment) }
  }
  const add = checkNames(value.add, "add", kind)
  const remove = checkNames(value.remove, "remove", kind)
  if (add.length === 0 && remove.length === 0) throw new Error("Pass `add`, `remove` or both, with at least one name.")
  const both = add.filter((name) => remove.includes(name))
  if (both.length > 0) throw new Error(`${both.join(", ")} cannot be both added and removed.`)
  return { add, remove }
}

function optionalBody(body: unknown): AgentPayload {
  const text = checkBody(body, "comment", false)
  return text ? { body: text } : {}
}

export function checkRepo(repo: unknown) {
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo.trim()) || /(^|\/)\.\.?($|\/)/.test(repo.trim()))
    throw new Error("`repo` must look like owner/name, such as octocat/hello-world.")
  return repo.trim()
}

function checkNumbers(numbers: unknown) {
  if (!Array.isArray(numbers) || numbers.length === 0) throw new Error("`numbers` must list at least one issue or pull request number.")
  const unique = [...new Set(numbers.map((number) => checkNumber(number, "numbers")))]
  if (unique.length > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} numbers per call; split the rest into another call.`)
  return unique
}

function checkNumber(number: unknown, field: string) {
  const parsed = typeof number === "string" && /^#?\d+$/.test(number.trim()) ? Number(number.trim().replace("#", "")) : number
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`\`${field}\` takes positive whole numbers, not ${JSON.stringify(number)}.`)
  return parsed
}

function checkReason(reason: unknown): CloseReason {
  const text = typeof reason === "string" ? reason.trim().toLowerCase().replace(/[\s-]+/g, "_") : ""
  if (text === "completed" || text === "not_planned" || text === "duplicate") return text
  throw new Error('`reason` must be "completed", "not_planned" or "duplicate".')
}

function checkBody(body: unknown, field: string, required: boolean) {
  if (body === undefined || body === null) {
    if (required) throw new Error(`\`${field}\` is required.`)
    return ""
  }
  if (typeof body !== "string") throw new Error(`\`${field}\` must be text.`)
  if (required && !body.trim()) throw new Error(`\`${field}\` must not be empty.`)
  if (body.length > MAX_BODY) throw new Error(`\`${field}\` is ${body.length} characters; GitHub allows ${MAX_BODY}.`)
  return body.trim() ? body : ""
}

function checkNames(names: unknown, field: string, kind: WriteKind) {
  if (names === undefined || names === null) return []
  if (!Array.isArray(names)) throw new Error(`\`${field}\` must be a list of ${kind === "label" ? "label names" : "GitHub logins"}.`)
  const checked = names.map((name) => {
    if (typeof name !== "string" || !name.trim()) throw new Error(`\`${field}\` has an empty name.`)
    if (kind === "label") return name.trim()
    const login = name.trim() === "@me" ? "@me" : name.trim().replace(/^@/, "")
    if (login !== "@me" && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(login)) throw new Error(`"${name}" is not a GitHub login.`)
    return login
  })
  return [...new Set(checked)]
}

/** One proposed (or, with auto-run, approved) action per number of a write tool call. */
export function expand(
  proposal: Proposal,
  input: {
    readonly sessionID: string
    readonly repo: string
    readonly batch: string
    readonly now: number
    readonly status: "proposed" | "approved"
    readonly items: ReadonlyMap<number, { readonly title: string; readonly item: "issue" | "pr" }>
    readonly id: () => string
    /** Who asked: the agent's tool (the default) or the user's bulk action. */
    readonly source?: "tool" | "user"
    /** The triage batch, in a session with a triage run. */
    readonly round?: number
  },
): AgentAction[] {
  return proposal.numbers.map((number) => ({
    id: input.id(),
    sessionID: input.sessionID,
    batch: input.batch,
    repo: input.repo,
    number,
    item: input.items.get(number)?.item ?? null,
    title: input.items.get(number)?.title ?? "",
    kind: proposal.kind,
    payload: proposal.payload,
    note: input.source === "user" ? "" : proposal.note,
    status: input.status,
    error: null,
    result: null,
    source: input.source ?? "tool",
    undoOf: null,
    undoneBy: null,
    ...(input.round === undefined ? {} : { round: input.round }),
    createdAt: input.now,
    updatedAt: input.now,
  }))
}

/** Why a write cannot go ahead on an item, or undefined when it can. */
export function blocker(
  kind: WriteKind,
  info: { readonly state: "OPEN" | "CLOSED" | "MERGED" } | undefined,
  same: Pick<AgentAction, "status"> | undefined,
) {
  if (!info) return "does not exist or cannot be read"
  if (kind === "close" && info.state !== "OPEN") return `already ${info.state.toLowerCase()}`
  if (kind === "reopen" && info.state === "MERGED") return "merged; it cannot be reopened"
  if (kind === "reopen" && info.state === "OPEN") return "already open"
  if (same) return `already ${same.status === "proposed" ? "proposed and waiting for the user" : "approved and running"}`
  return undefined
}

/** What the user changed in a proposal, told to the agent so it can follow the user's preferences. */
export function edits(action: Pick<AgentAction, "kind" | "payload" | "item" | "edited" | "original">) {
  if (!action.edited) return undefined
  const original = action.original
  if (!original) return "edited by the user"
  const before = describe({ ...action, payload: original })
  const after = describe(action)
  const body = (original.body ?? "") !== (action.payload.body ?? "")
  const same = describe({ ...action, payload: { ...original, body: undefined } }) === describe({ ...action, payload: { ...action.payload, body: undefined } })
  const changed = same ? (body ? "the user rewrote the comment" : "the user saved it unchanged") : `the user changed it to ${after}`
  const comments = body ? ` Your comment: "${oneLine(original.body ?? "", 300)}"; the user's: "${oneLine(action.payload.body ?? "", 300)}".` : ""
  return `edited by the user: you proposed ${before}; ${changed}.${comments}`
}

/** A triage run's progress: items the agent reviewed of the total, and the user's decisions on its proposals. */
export function triageProgress(triage: { readonly total: number; readonly reviewed: readonly number[] }, actions: readonly AgentAction[]) {
  const mine = actions.filter((action) => action.round !== undefined && action.source === "tool")
  const reviewed = new Set([...triage.reviewed, ...mine.map((action) => action.number)]).size
  const of = (...statuses: AgentAction["status"][]) => mine.filter((action) => statuses.includes(action.status)).length
  return {
    reviewed,
    total: Math.max(triage.total, reviewed),
    approved: of("approved", "running", "done", "failed", "undone"),
    skipped: of("skipped"),
    waiting: of("proposed"),
  }
}

/** The selection after a click on the row at `index`: that row toggled, or with `range`, the rows from the anchor on set as it now is. */
export function toggleRange(selected: ReadonlySet<number>, numbers: readonly number[], index: number, anchor: number | undefined, range: boolean) {
  const number = numbers[index]
  if (number === undefined) return new Set(selected)
  const on = !selected.has(number)
  const from = range && anchor !== undefined ? Math.min(anchor, index) : index
  const to = range && anchor !== undefined ? Math.max(anchor, index) : index
  const span = numbers.slice(from, to + 1)
  return on ? new Set([...selected, ...span]) : new Set([...selected].filter((item) => !span.includes(item)))
}

/** Issues or pull requests as a compact Markdown list for the agent: number, state, title, labels and author. */
export function itemList(
  repo: string,
  kind: "issue" | "pr",
  items: readonly { readonly number: number; readonly title: string; readonly state: string; readonly author: string; readonly labels: readonly { readonly name: string }[] }[],
) {
  return [
    `${items.length} ${kind === "pr" ? "pull requests" : "issues"} in ${repo}:`,
    "",
    ...items.map(
      (item) =>
        `- #${item.number} (${item.state.toLowerCase()}) ${item.title}${item.labels.length > 0 ? ` [${item.labels.map((label) => label.name).join(", ")}]` : ""} · @${item.author}`,
    ),
  ].join("\n")
}

/** The first prompt of a triage session: what to go through, the user's rules and replies, and how to work. */
export function triagePrompt(input: {
  readonly repo: string
  readonly kind: "issue" | "pr"
  readonly query: string | null
  readonly numbers: readonly number[]
  readonly total: number
  readonly rules: string
  readonly replies: readonly { readonly name: string; readonly body: string }[]
  readonly batch: number
}) {
  const noun = input.kind === "pr" ? "pull requests" : "issues"
  const what = input.query
    ? [
        `The ${input.total} ${noun} matching this search, in this order:`,
        "",
        "```",
        input.query,
        "```",
        "",
        `First list them all: call the github_panel \`search\` tool with repo "${input.repo}", exactly this query and limit 100, and follow its cursor to the last page. Work through that fixed list; don't search again between batches, since items the user closes drop out of the results and would shift the pages.`,
      ]
    : [`These ${input.numbers.length} ${noun}: ${input.numbers.map((number) => `#${number}`).join(", ")}.`]
  const replies =
    input.replies.length > 0
      ? [
          "",
          "## Saved replies",
          "",
          "Use these replies, word for word, where the rules call for them (fill in only what a reply leaves for you to fill in):",
          ...input.replies.flatMap((reply) => ["", `### ${reply.name}`, "", reply.body.trim()]),
        ]
      : []
  return [
    `Triage ${noun} in ${input.repo} with me, using the github_panel tools. I review every change you propose in the GitHub panel.`,
    "",
    "## What to go through",
    "",
    ...what,
    "",
    "## My rules",
    "",
    input.rules.trim() || "(No rules given: propose only what is clearly right, such as labels that fit and duplicates.)",
    ...replies,
    "",
    "## How to work",
    "",
    `- Work in batches of ${input.batch} items. Read each item's search line, and call \`view\` when the title and labels are not enough to decide.`,
    "- Only propose. Use the github_panel `comment`, `close`, `reopen`, `label` and `assign` tools: each queues proposals that I approve, edit or skip. Never write to GitHub any other way: no gh in the shell, no API calls.",
    "- Give every proposal a short `note` saying why; I see it next to the action.",
    "- Put identical actions in one tool call: all the numbers that get the same close reason and reply, or the same labels, go together.",
    "- When no rule applies or you are not sure, leave the item alone and mention it in the batch summary instead of guessing.",
    `- After each batch, call the \`actions\` tool with \`wait: true\` and \`reviewed\` set to every number you looked at in the batch, including the ones you left alone. It returns once I have decided, with what I approved, skipped and edited. If it returns while proposals still wait, call it again the same way. Don't stop to ask me between batches.`,
    "- Learn from my skips and edits before the next batch: follow how I changed your proposals, and don't propose what I skipped again.",
    "- When every item is done, stop and summarize: what I approved, what I skipped, and the items you left alone with the reason for each.",
  ].join("\n")
}

/** What an action does, in a few words for the agent's tool results. */
export function describe(action: Pick<AgentAction, "kind" | "payload" | "item">) {
  const payload = action.payload
  const comment = payload.body ? ", with a comment" : ""
  if (action.kind === "comment") return `comment "${oneLine(payload.body ?? "", 60)}"`
  if (action.kind === "close") {
    if (action.item === "pr") return `close${comment}`
    if (payload.reason === "duplicate") return `close as duplicate of #${payload.duplicateOf}${comment}`
    return `close as ${payload.reason === "not_planned" ? "not planned" : "completed"}${comment}`
  }
  if (action.kind === "reopen") return `reopen${comment}`
  if (action.kind === "uncomment") return "delete a comment"
  if (action.kind === "other") return `ran \`${oneLine(payload.command ?? "", 80)}\``
  const noun = action.kind === "label" ? "label" : "assignee"
  const mark = action.kind === "label" ? "" : "@"
  const list = (names: readonly string[] | undefined) => (names ?? []).map((name) => (name === "@me" ? name : `${mark}${name}`)).join(", ")
  return [
    payload.add?.length ? `add ${noun}${payload.add.length > 1 ? "s" : ""} ${list(payload.add)}` : "",
    payload.remove?.length ? `remove ${noun}${payload.remove.length > 1 ? "s" : ""} ${list(payload.remove)}` : "",
  ]
    .filter(Boolean)
    .join(", ")
}

/** The action that reverts a done one, or undefined when it cannot be reverted for certain. */
export function undoFor(action: AgentAction): { kind: AgentKind; payload: AgentPayload } | undefined {
  if (action.status !== "done" || action.undoOf || action.undoneBy || action.result?.noop) return undefined
  const result = action.result ?? {}
  const comment = result.commentId ? { commentId: result.commentId } : {}
  if (action.kind === "close") return { kind: "reopen", payload: comment }
  // Commands from the shell only say what was asked, not what the item was before.
  if (action.source === "shell") return undefined
  if (action.kind === "reopen") return { kind: "close", payload: { reason: result.reason === "not_planned" ? "not_planned" : "completed", ...comment } }
  if (action.kind === "comment") return result.commentId ? { kind: "uncomment", payload: { commentId: result.commentId } } : undefined
  if (action.kind !== "label" && action.kind !== "assign") return undefined
  const add = result.removed ?? []
  const remove = result.added ?? []
  if (add.length === 0 && remove.length === 0) return undefined
  return { kind: action.kind, payload: { add, remove } }
}

/** How long to wait before running a write again after this error, or undefined to give up. */
export function backoff(message: string, attempt: number) {
  const after = /retry[- ]after:?\s*(\d+)/i.exec(message)
  const limited = !!after || /rate limit|abuse detection|HTTP 429/i.test(message)
  if (!limited || attempt >= RETRIES) return undefined
  if (after) return Math.min(Number(after[1]), 600) * 1000
  // GitHub asks to wait at least a minute after a secondary rate limit.
  return 60_000 * 2 ** attempt
}

/** Running actions a stopped server left behind, as failed: their outcome is unknown. */
export function settle(actions: readonly AgentAction[], now: number): AgentAction[] {
  return actions.map((action) =>
    action.status === "running" && now - action.updatedAt > STALE
      ? { ...action, status: "failed", error: "Interrupted before it finished; check the item, then retry or skip it.", updatedAt: now }
      : action,
  )
}

/** The counts the pill and the top bar show. */
export function counts(actions: readonly AgentAction[]) {
  const of = (status: AgentAction["status"]) => actions.filter((action) => action.status === status).length
  return { proposed: of("proposed"), running: of("running") + of("approved"), done: of("done"), failed: of("failed") }
}

/** A `gh issue|pr …` command found in a shell command line, with what it targets. */
export interface ShellGh {
  readonly group: "issue" | "pr"
  readonly verb: string
  readonly number: number
  readonly repo: string | null
  /** The directory an earlier `cd` in the line moved to, relative to where it started; "?" when it cannot be told. */
  readonly cd: string | null
  readonly kind: AgentKind
  readonly payload: AgentPayload
}

const VERBS = new Set(["close", "reopen", "comment", "edit", "merge", "review", "lock", "unlock"])
// Flags that take a value, per verb; everything else is a switch. `-r` and `-c` mean different things per verb.
const VALUE_FLAGS: Record<string, readonly string[]> = {
  close: ["-c", "--comment", "-r", "--reason", "--duplicate-of"],
  reopen: ["-c", "--comment"],
  comment: ["-b", "--body", "-F", "--body-file"],
  edit: [
    "-b", "--body", "-F", "--body-file", "-t", "--title", "-m", "--milestone", "-B", "--base",
    "--add-label", "--remove-label", "--add-assignee", "--remove-assignee", "--add-reviewer", "--remove-reviewer",
    "--add-project", "--remove-project", "--type",
  ],
  merge: ["-b", "--body", "-F", "--body-file", "-t", "--subject", "-A", "--author-email", "--match-head-commit"],
  review: ["-b", "--body", "-F", "--body-file"],
  lock: ["-r", "--reason"],
  unlock: [],
}

/**
 * The `gh issue|pr close|reopen|comment|edit|merge|review|lock` commands in a shell command line that name their
 * issue or pull request by number or URL. Commands that target the current branch, or whose number comes from a
 * variable, are left out: what they changed cannot be told for certain.
 */
export function parseShell(command: string): ShellGh[] {
  const where = { cd: null as string | null }
  return segments(command).flatMap((tokens) => {
    if (tokens[0] === "cd" || tokens[0] === "pushd") {
      const target = tokens[1] ?? "~"
      where.cd = where.cd === "?" || /[$`*?]/.test(target) || target === "-" ? "?" : where.cd && !/^[~/]/.test(target) ? `${where.cd}/${target}` : target
      return []
    }
    const env = tokens.findIndex((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
    if (env === -1) return []
    const gh = tokens[env] ?? ""
    if (gh !== "gh" && !gh.endsWith("/gh")) return []
    const ghRepo = tokens.slice(0, env).find((token) => token.startsWith("GH_REPO="))?.slice("GH_REPO=".length)
    const args = tokens.slice(env + 1)
    const flags = new Map<string, string[]>()
    const positional: string[] = []
    const verbAt = { group: "", verb: "" }
    for (let index = 0; index < args.length; index++) {
      const arg = args[index] ?? ""
      const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined]
      const takes = flag === "-R" || flag === "--repo" || (VALUE_FLAGS[verbAt.verb] ?? []).includes(flag)
      if (flag.startsWith("-") && flag !== "-") {
        const value = inline ?? (takes ? args[++index] : "")
        flags.set(flag, [...(flags.get(flag) ?? []), value ?? ""])
        continue
      }
      if (!verbAt.group) {
        if (arg !== "issue" && arg !== "pr") return []
        verbAt.group = arg
        continue
      }
      if (!verbAt.verb) {
        if (!VERBS.has(arg)) return []
        verbAt.verb = arg
        continue
      }
      positional.push(arg)
    }
    if (!verbAt.verb) return []
    const target = targetOf(positional[0] ?? "")
    if (!target) return []
    const flagRepo = flags.get("-R")?.at(-1) ?? flags.get("--repo")?.at(-1)
    const repo = target.repo ?? repoName(flagRepo) ?? repoName(ghRepo)
    const group = verbAt.group === "pr" ? "pr" : "issue"
    const line = tokens.map((token) => (/^[\w@%+=:,./#-]+$/.test(token) ? token : JSON.stringify(token))).join(" ")
    return [{ group, verb: verbAt.verb, number: target.number, repo, cd: where.cd, ...shellKind(verbAt.verb, flags, line) }]
  })
}

function shellKind(verb: string, flags: ReadonlyMap<string, string[]>, command: string): { kind: AgentKind; payload: AgentPayload } {
  const values = (...names: string[]) => names.flatMap((name) => flags.get(name) ?? []).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean)
  const line = { command: oneLine(command, 500) }
  if (verb === "close") {
    const duplicate = values("--duplicate-of")[0]
    const reason = values("-r", "--reason")[0]?.toLowerCase().replace(/[\s-]+/g, "_")
    const duplicateOf = duplicate ? targetOf(duplicate)?.number : undefined
    return {
      kind: "close",
      payload: {
        ...line,
        reason: duplicateOf || reason === "duplicate" ? "duplicate" : reason === "not_planned" ? "not_planned" : "completed",
        ...(duplicateOf ? { duplicateOf } : {}),
      },
    }
  }
  if (verb === "reopen") return { kind: "reopen", payload: line }
  if (verb === "comment") return { kind: "comment", payload: line }
  if (verb !== "edit") return { kind: "other", payload: line }
  const labels = { add: values("--add-label"), remove: values("--remove-label") }
  const people = { add: values("--add-assignee"), remove: values("--remove-assignee") }
  const other = [...flags.keys()].some((flag) => !["-R", "--repo", "--add-label", "--remove-label", "--add-assignee", "--remove-assignee"].includes(flag))
  const hasLabels = labels.add.length + labels.remove.length > 0
  const hasPeople = people.add.length + people.remove.length > 0
  if (!other && hasLabels && !hasPeople) return { kind: "label", payload: { ...line, ...labels } }
  if (!other && hasPeople && !hasLabels) return { kind: "assign", payload: { ...line, ...people } }
  return { kind: "other", payload: line }
}

function targetOf(arg: string) {
  const url = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/.exec(arg)
  if (url?.[1] && url[2]) return { repo: url[1], number: Number(url[2]) }
  const number = /^#?(\d+)$/.exec(arg)?.[1]
  if (!number || !Number.isSafeInteger(Number(number)) || Number(number) <= 0) return undefined
  return { repo: null, number: Number(number) }
}

/** `owner/repo` from gh's `[HOST/]OWNER/REPO`. */
function repoName(value: string | undefined) {
  const parts = value?.replace(/^https?:\/\//, "").replace(/\.git$/, "").split("/").filter(Boolean) ?? []
  const name = parts.slice(-2).join("/")
  return parts.length >= 2 && /^[\w.-]+\/[\w.-]+$/.test(name) ? name : null
}

/** A command line split into simple commands, each as its words with quotes removed. */
function segments(command: string): string[][] {
  const all: string[][] = [[]]
  const state = { word: "", started: false, quote: "" }
  const push = () => {
    if (state.started) all.at(-1)?.push(state.word)
    state.word = ""
    state.started = false
  }
  const split = () => {
    push()
    all.push([])
  }
  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? ""
    if (state.quote === "'") {
      if (char === "'") state.quote = ""
      else state.word += char
      continue
    }
    if (state.quote === '"') {
      if (char === '"') state.quote = ""
      else if (char === "\\" && /["\\$`]/.test(command[index + 1] ?? "")) state.word += command[++index]
      else state.word += char
      continue
    }
    if (char === "'" || char === '"') {
      state.quote = char
      state.started = true
      continue
    }
    if (char === "\\") {
      if (command[index + 1] === "\n") index++
      else {
        state.word += command[++index] ?? ""
        state.started = true
      }
      continue
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n" || char === "(" || char === ")") {
      split()
      continue
    }
    if (/\s/.test(char)) {
      push()
      continue
    }
    state.word += char
    state.started = true
  }
  push()
  return all.filter((tokens) => tokens.length > 0)
}

function oneLine(text: string, limit: number) {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}
