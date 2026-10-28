import { parsePatch } from "./git"
import type { ChangedFile, DiffSide, DraftComment, DraftReview, ReviewEvent } from "./schemas"

export const MAX_COMMENTS = 100
export const MAX_BODY = 65_536
// Lines of one file's diff the diff tool shows: all files at once, or the one file asked for.
const FILE_LINES = 400
const PATH_LINES = 3000
const DIFF_BUDGET = 80_000

export type Range = readonly [number, number]
export type Ranges = Readonly<Record<DiffSide, readonly Range[]>>

/** A placed comment as the review tool and the window describe it. */
export interface Placement {
  readonly path: string
  readonly line: number
  readonly side: DiffSide
  readonly startLine: number | null
}

/**
 * The lines of a patch an inline comment can go on, per hunk: the new file's lines (added and context) on the RIGHT, the
 * old file's (removed and context) on the LEFT. GitHub takes nothing outside the hunks.
 */
export function hunkRanges(patch: string | null): Ranges {
  if (!patch) return { LEFT: [], RIGHT: [] }
  const hunks = parsePatch(patch.replace(/\r\n/g, "\n")).reduce<{ left: number[]; right: number[] }[]>((all, line) => {
    if (line.kind === "hunk") return [...all, { left: [], right: [] }]
    const hunk = all[all.length - 1]
    if (!hunk) return all
    if (line.old !== null) hunk.left.push(line.old)
    if (line.new !== null) hunk.right.push(line.new)
    return all
  }, [])
  const span = (lines: readonly number[]): Range[] => (lines.length > 0 ? [[Math.min(...lines), Math.max(...lines)]] : [])
  return { LEFT: hunks.flatMap((hunk) => span(hunk.left)), RIGHT: hunks.flatMap((hunk) => span(hunk.right)) }
}

export function formatRanges(ranges: Ranges) {
  const side = (name: DiffSide) => (ranges[name].length > 0 ? `${name} ${ranges[name].map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`)).join(", ")}` : "")
  return [side("RIGHT"), side("LEFT")].filter(Boolean).join("; ") || "none"
}

/** Why a comment cannot go where it is placed in this diff, or undefined when it can. */
export function placementError(files: readonly ChangedFile[], comment: Placement) {
  const file = files.find((item) => item.path === comment.path)
  if (!file) {
    const renamed = files.find((item) => item.previous === comment.path)
    if (renamed) return `\`${comment.path}\` was renamed to \`${renamed.path}\`; use the new path.`
    const names = files.map((item) => item.path)
    return `\`${comment.path}\` is not changed in this pull request. Changed files: ${names.slice(0, 40).join(", ")}${names.length > 40 ? ", …" : ""}.`
  }
  if (!file.patch) return `\`${comment.path}\` has no diff GitHub can comment on (binary or too large); mention it in the summary instead.`
  const ranges = hunkRanges(file.patch)
  const valid = `Lines you can comment on in \`${comment.path}\`: ${formatRanges(ranges)}.`
  const hunk = ranges[comment.side].find(([from, to]) => comment.line >= from && comment.line <= to)
  const sideHint = comment.side === "RIGHT" ? "RIGHT counts the new file's lines: added and unchanged ones" : "LEFT counts the old file's lines: removed and unchanged ones"
  if (!hunk) return `Line ${comment.line} on the ${comment.side} side of \`${comment.path}\` is outside the diff; ${sideHint}. ${valid}`
  if (comment.startLine === null) return undefined
  if (comment.startLine > comment.line) return `\`start_line\` ${comment.startLine} comes after \`line\` ${comment.line} in \`${comment.path}\`; \`start_line\` is the first line of the range.`
  if (comment.startLine < hunk[0]) return `Lines ${comment.startLine}–${comment.line} of \`${comment.path}\` span more than one hunk; a comment's lines must be in one hunk (${comment.side} ${hunk[0]}–${hunk[1]}). ${valid}`
  return undefined
}

/** The comments whose lines are still in the diff, and the ones a newer head moved out of it. */
export function splitDrift<T extends Placement>(comments: readonly T[], files: readonly ChangedFile[]) {
  const moved = comments.filter((comment) => placementError(files, comment) !== undefined)
  return { valid: comments.filter((comment) => !moved.includes(comment)), moved }
}

/** The summary with the comments that lost their lines appended, each under its old place. */
export function withMoved(summary: string, moved: readonly (Placement & { readonly body: string })[]) {
  if (moved.length === 0) return summary
  const entries = moved.map((comment) => {
    const lines = comment.startLine !== null && comment.startLine !== comment.line ? `${comment.startLine}-${comment.line}` : `${comment.line}`
    return `**\`${comment.path}:${lines}\`**${comment.side === "LEFT" ? " (removed lines)" : ""}\n\n${comment.body.trim()}`
  })
  return [summary.trim(), "---", "_Comments on lines that are no longer in the diff:_", ...entries].filter(Boolean).join("\n\n")
}

export interface DraftEdit {
  readonly summary?: string
  readonly event?: ReviewEvent
  readonly update?: { readonly id: string; readonly body: string }
  readonly remove?: string
  readonly add?: DraftComment
}

/** A draft with one edit applied; a comment that is gone is an error. */
export function editDraft(draft: DraftReview, edit: DraftEdit, now: number): DraftReview {
  const update = edit.update
  if (update && !draft.comments.some((comment) => comment.id === update.id)) throw new Error("That comment is no longer in the draft.")
  if (edit.remove && !draft.comments.some((comment) => comment.id === edit.remove)) throw new Error("That comment is no longer in the draft.")
  if (update && !update.body.trim()) throw new Error("A comment cannot be empty; delete it instead.")
  if (edit.add && !edit.add.body.trim()) throw new Error("A comment cannot be empty.")
  checkLength(edit.summary ?? "", "The summary")
  checkLength(update?.body ?? edit.add?.body ?? "", "A comment")
  const comments = draft.comments
    .filter((comment) => comment.id !== edit.remove)
    .map((comment) => (update && comment.id === update.id && comment.body !== update.body ? { ...comment, body: update.body, edited: comment.edited || comment.source === "agent" } : comment))
  if (edit.add && comments.length >= MAX_COMMENTS) throw new Error(`A review holds at most ${MAX_COMMENTS} comments.`)
  return {
    ...draft,
    summary: edit.summary ?? draft.summary,
    event: edit.event ?? draft.event,
    comments: edit.add ? [...comments, edit.add] : comments,
    updatedAt: now,
  }
}

function checkLength(text: string, what: string) {
  if (text.length > MAX_BODY) throw new Error(`${what} is ${text.length} characters; GitHub allows ${MAX_BODY}.`)
}

/** The review tool's input, checked. */
export interface ReviewInput {
  readonly number: number
  readonly repo: string | null
  readonly summary: string
  readonly event: ReviewEvent
  readonly note: string
  readonly comments: readonly { path: string; line: number; side: DiffSide; startLine: number | null; body: string }[]
}

export function parseReview(input: unknown, checkRepo: (repo: unknown) => string): ReviewInput {
  if (typeof input !== "object" || input === null) throw new Error("Pass the arguments as an object.")
  const value = input as Record<string, unknown>
  const number = positive(value.number, "number")
  const repo = value.repo === undefined || value.repo === null || value.repo === "" ? null : checkRepo(value.repo)
  const summary = typeof value.summary === "string" ? value.summary : ""
  if (!summary.trim()) throw new Error("`summary` is required: the review's body in Markdown, the overall verdict and the main points.")
  checkLength(summary, "`summary`")
  const event = value.event === undefined || value.event === null ? "COMMENT" : value.event
  if (event !== "COMMENT" && event !== "APPROVE" && event !== "REQUEST_CHANGES") throw new Error('`event` must be "COMMENT", "APPROVE" or "REQUEST_CHANGES".')
  const note = typeof value.note === "string" ? value.note.trim().slice(0, 1000) : ""
  if (!note) throw new Error("`note` is required: one short sentence for the user about this review.")
  const list = value.comments === undefined || value.comments === null ? [] : value.comments
  if (!Array.isArray(list)) throw new Error("`comments` must be a list of inline comments.")
  if (list.length > MAX_COMMENTS) throw new Error(`At most ${MAX_COMMENTS} inline comments; keep the most important ones and summarize the rest.`)
  const comments = list.map((raw, index) => {
    const where = `comments[${index}]`
    if (typeof raw !== "object" || raw === null) throw new Error(`\`${where}\` must be an object with path, line and body.`)
    const item = raw as Record<string, unknown>
    if (typeof item.path !== "string" || !item.path.trim()) throw new Error(`\`${where}.path\` is required: the file's path in the repository.`)
    const side = item.side === undefined || item.side === null ? "RIGHT" : item.side
    if (side !== "LEFT" && side !== "RIGHT") throw new Error(`\`${where}.side\` must be "RIGHT" (new lines) or "LEFT" (removed lines).`)
    const line = positive(item.line, `${where}.line`)
    const start = item.start_line === undefined || item.start_line === null ? null : positive(item.start_line, `${where}.start_line`)
    if (typeof item.body !== "string" || !item.body.trim()) throw new Error(`\`${where}.body\` must not be empty.`)
    checkLength(item.body, `\`${where}.body\``)
    return { path: item.path.trim().replace(/^\.?\//, ""), line, side, startLine: start === line ? null : start, body: item.body } as const
  })
  return { number, repo, summary, event, note, comments }
}

function positive(value: unknown, field: string) {
  const number = typeof value === "string" ? Number(value.replace("#", "")) : value
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) throw new Error(`\`${field}\` must be a positive whole number.`)
  return number
}

/** A pull request's changed files with numbered diffs, for the agent to place review comments by. */
export function diffText(files: readonly ChangedFile[], path: string | null) {
  const picked = path ? files.filter((file) => file.path === path || file.previous === path) : files
  if (path && picked.length === 0) throw new Error(`\`${path}\` is not changed in this pull request. Changed files: ${files.map((file) => file.path).join(", ")}.`)
  const limit = path ? PATH_LINES : FILE_LINES
  const budget = { left: DIFF_BUDGET }
  const sections = picked.map((file) => {
    const head = `## ${file.previous && file.previous !== file.path ? `${file.previous} → ` : ""}${file.path} (${file.status}, +${file.additions} −${file.deletions})`
    if (!file.patch) return `${head}\nNo diff (binary or too large); comments cannot go on it.`
    if (budget.left <= 0) return `${head}\nDiff not shown to save space; call again with \`path: "${file.path}"\`.`
    const lines = parsePatch(file.patch.replace(/\r\n/g, "\n").replace(/\n$/, ""))
    const width = String(Math.max(0, ...lines.map((line) => Math.max(line.old ?? 0, line.new ?? 0)))).length
    const pad = (value: number | null) => (value === null ? "" : String(value)).padStart(width)
    const body = lines
      .slice(0, limit)
      .map((line) => (line.kind === "hunk" ? line.text : `${pad(line.old)} ${pad(line.new)} │${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "} ${line.text}`))
      .join("\n")
    const cut = lines.length > limit ? `\n… ${lines.length - limit} more lines${path ? "" : `; call again with \`path: "${file.path}"\` for the rest`}.` : ""
    const text = `${head}\nCommentable: ${formatRanges(hunkRanges(file.patch))}\n${body}${cut}`
    budget.left -= text.length
    return text
  })
  return [
    `${files.length} changed file${files.length === 1 ? "" : "s"}${path ? `, showing ${path}` : ""}. Each diff line shows the old (LEFT) line number, the new (RIGHT) line number, then +, - or a space and the text.`,
    "Review comments go on RIGHT with the new number for added and unchanged lines, or on LEFT with the old number for removed lines, and only on lines inside a hunk.",
    "",
    sections.join("\n\n"),
  ].join("\n")
}
