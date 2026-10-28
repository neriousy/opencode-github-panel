import { describe, expect, test } from "bun:test"
import { diffText, editDraft, formatRanges, hunkRanges, MAX_COMMENTS, parseReview, placementError, splitDrift, withMoved } from "./draft"
import { checkRepo } from "./plan"
import type { ChangedFile, DraftComment, DraftReview } from "./schemas"

// Two hunks: old 10–14 → new 10–15 (one line replaced by two), and old 40–42 → new 41–42 (one line removed).
const PATCH = [
  "@@ -10,5 +10,6 @@ function a() {",
  " one",
  " two",
  "-three",
  "+three a",
  "+three b",
  " four",
  " five",
  "@@ -40,3 +41,2 @@ function b() {",
  " forty",
  "-forty one",
  " forty two",
].join("\n")

const file = (extra: Partial<ChangedFile> = {}): ChangedFile => ({ path: "src/a.ts", previous: null, status: "modified", additions: 2, deletions: 2, patch: PATCH, ...extra })
const files = [file(), file({ path: "logo.png", patch: null }), file({ path: "src/new.ts", previous: "src/old.ts", status: "renamed" })]

const comment = (extra: Partial<DraftComment> = {}): DraftComment => ({
  id: "c1",
  path: "src/a.ts",
  line: 12,
  side: "RIGHT",
  startLine: null,
  body: "Looks off",
  source: "agent",
  edited: false,
  ...extra,
})

const draft = (extra: Partial<DraftReview> = {}): DraftReview => ({
  sessionID: "ses_1",
  repo: "octo/repo",
  number: 7,
  sha: "aaa",
  summary: "Mostly fine.",
  event: "REQUEST_CHANGES",
  note: "Two problems",
  source: "agent",
  comments: [comment(), comment({ id: "c2", line: 41, body: "Why?" })],
  createdAt: 1,
  updatedAt: 1,
  ...extra,
})

describe("hunk ranges", () => {
  test("each hunk gives one range per side", () => {
    expect(hunkRanges(PATCH)).toEqual({ RIGHT: [[10, 15], [41, 42]], LEFT: [[10, 14], [40, 42]] })
    expect(formatRanges(hunkRanges(PATCH))).toBe("RIGHT 10–15, 41–42; LEFT 10–14, 40–42")
  })

  test("a new file has only a right side, a missing patch none", () => {
    expect(hunkRanges("@@ -0,0 +1,2 @@\n+a\n+b")).toEqual({ RIGHT: [[1, 2]], LEFT: [] })
    expect(hunkRanges(null)).toEqual({ RIGHT: [], LEFT: [] })
    expect(formatRanges(hunkRanges(null))).toBe("none")
  })

  test("CRLF patches count the same lines", () => {
    expect(hunkRanges(PATCH.replace(/\n/g, "\r\n"))).toEqual(hunkRanges(PATCH))
  })
})

describe("placement", () => {
  test("lines inside a hunk on their side are valid", () => {
    expect(placementError(files, comment({ line: 12 }))).toBeUndefined()
    expect(placementError(files, comment({ line: 12, side: "LEFT" }))).toBeUndefined()
    expect(placementError(files, comment({ line: 41, side: "LEFT" }))).toBeUndefined()
  })

  test("a line between hunks or on the wrong side is rejected with the valid ranges", () => {
    const error = placementError(files, comment({ line: 30 }))
    expect(error).toContain("outside the diff")
    expect(error).toContain("RIGHT 10–15, 41–42; LEFT 10–14, 40–42")
    // Old line 40 exists on the left, but the right side starts at 41.
    expect(placementError(files, comment({ line: 40 }))).toContain("outside the diff")
    expect(placementError(files, comment({ line: 15, side: "LEFT" }))).toContain("LEFT counts the old file")
  })

  test("multi-line comments stay in one hunk and in order", () => {
    expect(placementError(files, comment({ startLine: 10, line: 15 }))).toBeUndefined()
    expect(placementError(files, comment({ startLine: 14, line: 41 }))).toContain("more than one hunk")
    expect(placementError(files, comment({ startLine: 14, line: 12 }))).toContain("comes after")
  })

  test("unknown, renamed and binary files explain themselves", () => {
    expect(placementError(files, comment({ path: "src/b.ts" }))).toContain("Changed files: src/a.ts, logo.png, src/new.ts")
    expect(placementError(files, comment({ path: "src/old.ts" }))).toContain("renamed to `src/new.ts`")
    expect(placementError(files, comment({ path: "logo.png" }))).toContain("no diff")
  })
})

describe("head drift", () => {
  test("comments whose lines left the diff move into the summary", () => {
    const newer = [file({ patch: "@@ -10,3 +10,3 @@\n one\n-two\n+two!\n three" })]
    const comments = [comment({ line: 11 }), comment({ id: "c2", line: 41, body: "Gone\n```suggestion\nx\n```" }), comment({ id: "c3", path: "src/gone.ts", line: 3, side: "LEFT", startLine: 1 })]
    const split = splitDrift(comments, newer)
    expect(split.valid.map((item) => item.id)).toEqual(["c1"])
    expect(split.moved.map((item) => item.id)).toEqual(["c2", "c3"])
    const body = withMoved("Mostly fine.", split.moved)
    expect(body.startsWith("Mostly fine.\n\n---\n\n")).toBe(true)
    expect(body).toContain("**`src/a.ts:41`**\n\nGone\n```suggestion\nx\n```")
    expect(body).toContain("**`src/gone.ts:1-3`** (removed lines)")
  })

  test("nothing moved leaves the summary as is, and an empty summary still lists them", () => {
    expect(withMoved("Fine.", [])).toBe("Fine.")
    expect(withMoved("", [comment()])).toBe("---\n\n_Comments on lines that are no longer in the diff:_\n\n**`src/a.ts:12`**\n\nLooks off")
  })
})

describe("draft edits", () => {
  test("summary and verdict change, the rest stays", () => {
    const next = editDraft(draft(), { summary: "New", event: "COMMENT" }, 5)
    expect(next.summary).toBe("New")
    expect(next.event).toBe("COMMENT")
    expect(next.comments).toEqual(draft().comments)
    expect(next.updatedAt).toBe(5)
  })

  test("editing an agent comment marks it edited; an unchanged body does not", () => {
    const next = editDraft(draft(), { update: { id: "c2", body: "Why this?" } }, 5)
    expect(next.comments[1]).toMatchObject({ id: "c2", body: "Why this?", edited: true })
    expect(editDraft(draft(), { update: { id: "c2", body: "Why?" } }, 5).comments[1]?.edited).toBe(false)
  })

  test("comments are removed and added", () => {
    const added = comment({ id: "c3", source: "user", line: 14 })
    const next = editDraft(draft(), { remove: "c1", add: added }, 5)
    expect(next.comments.map((item) => item.id)).toEqual(["c2", "c3"])
  })

  test("a gone or empty comment is an error", () => {
    expect(() => editDraft(draft(), { update: { id: "nope", body: "x" } }, 5)).toThrow("no longer in the draft")
    expect(() => editDraft(draft(), { remove: "nope" }, 5)).toThrow("no longer in the draft")
    expect(() => editDraft(draft(), { update: { id: "c1", body: "  " } }, 5)).toThrow("delete it instead")
    expect(() => editDraft(draft(), { add: comment({ id: "c9", body: "" }) }, 5)).toThrow("cannot be empty")
  })

  test("a full draft takes no more comments", () => {
    const full = draft({ comments: Array.from({ length: MAX_COMMENTS }, (_, index) => comment({ id: `c${index}` })) })
    expect(() => editDraft(full, { add: comment({ id: "extra" }) }, 5)).toThrow(`at most ${MAX_COMMENTS}`)
  })
})

describe("review tool input", () => {
  const valid = { number: 7, summary: "Fine", note: "Quick look", comments: [{ path: "./src/a.ts", line: 12, body: "x" }] }

  test("defaults the verdict and side, and normalizes paths", () => {
    const parsed = parseReview(valid, checkRepo)
    expect(parsed).toMatchObject({ number: 7, repo: null, event: "COMMENT", comments: [{ path: "src/a.ts", line: 12, side: "RIGHT", startLine: null }] })
  })

  test("a start line equal to the line is a single-line comment", () => {
    expect(parseReview({ ...valid, comments: [{ path: "a", line: 3, start_line: 3, body: "x" }] }, checkRepo).comments[0]?.startLine).toBeNull()
  })

  test("rejects what GitHub would", () => {
    expect(() => parseReview({ ...valid, summary: " " }, checkRepo)).toThrow("`summary` is required")
    expect(() => parseReview({ ...valid, note: "" }, checkRepo)).toThrow("`note` is required")
    expect(() => parseReview({ ...valid, event: "MERGE" }, checkRepo)).toThrow("`event` must be")
    expect(() => parseReview({ ...valid, comments: [{ path: "a", line: 0, body: "x" }] }, checkRepo)).toThrow("comments[0].line")
    expect(() => parseReview({ ...valid, comments: [{ path: "a", line: 1, side: "UP", body: "x" }] }, checkRepo)).toThrow("comments[0].side")
    expect(() => parseReview({ ...valid, comments: Array.from({ length: MAX_COMMENTS + 1 }, () => valid.comments[0]) }, checkRepo)).toThrow(`At most ${MAX_COMMENTS}`)
    expect(() => parseReview({ ...valid, repo: "../x" }, checkRepo)).toThrow("owner/name")
  })
})

describe("diff text", () => {
  test("numbers each line by side and lists the commentable ranges", () => {
    const text = diffText([file()], null)
    expect(text).toContain("## src/a.ts (modified, +2 −2)")
    expect(text).toContain("Commentable: RIGHT 10–15, 41–42; LEFT 10–14, 40–42")
    expect(text).toContain("12    │- three")
    expect(text).toContain("   12 │+ three a")
    expect(text).toContain("40 41 │  forty")
  })

  test("a path picks one file, also by its old name", () => {
    expect(diffText(files, "src/old.ts")).toContain("## src/old.ts → src/new.ts")
    expect(() => diffText(files, "nope.ts")).toThrow("not changed in this pull request")
    expect(diffText(files, "logo.png")).toContain("No diff")
  })
})
