import { describe, expect, test } from "bun:test"
import {
  backoff,
  blocker,
  counts,
  describe as describeAction,
  edits,
  expand,
  itemList,
  MAX_BATCH,
  parseShell,
  parseWrite,
  settle,
  STALE,
  toggleRange,
  triageProgress,
  triagePrompt,
  undoFor,
} from "./plan"
import type { AgentAction } from "./schemas"

const action = (extra: Partial<AgentAction> = {}): AgentAction => ({
  id: "a1",
  sessionID: "ses_1",
  batch: "b1",
  repo: "octo/repo",
  number: 12,
  item: "issue",
  title: "A bug",
  kind: "close",
  payload: { reason: "not_planned" },
  note: "stale",
  status: "done",
  error: null,
  result: {},
  source: "tool",
  undoOf: null,
  undoneBy: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
})

describe("parseWrite", () => {
  test("checks numbers, note and repo", () => {
    expect(parseWrite("reopen", { numbers: [3, 3, "#4"], note: " why " })).toEqual({
      repo: null,
      numbers: [3, 4],
      kind: "reopen",
      payload: {},
      note: "why",
    })
    expect(() => parseWrite("reopen", { numbers: [], note: "x" })).toThrow("at least one")
    expect(() => parseWrite("reopen", { numbers: [0], note: "x" })).toThrow("positive whole numbers")
    expect(() => parseWrite("reopen", { numbers: [1.5], note: "x" })).toThrow("positive whole numbers")
    expect(() => parseWrite("reopen", { numbers: [1] })).toThrow("`note` is required")
    expect(() => parseWrite("reopen", { numbers: [1], note: "x", repo: "nope" })).toThrow("owner/name")
    expect(() => parseWrite("reopen", { numbers: [1], note: "x", repo: "a/.." })).toThrow("owner/name")
    expect(parseWrite("reopen", { numbers: [1], note: "x", repo: "a/b" }).repo).toBe("a/b")
    const many = Array.from({ length: MAX_BATCH + 1 }, (_, index) => index + 1)
    expect(() => parseWrite("reopen", { numbers: many, note: "x" })).toThrow(`At most ${MAX_BATCH}`)
  })

  test("close reasons and duplicates", () => {
    expect(parseWrite("close", { numbers: [1], note: "x" }).payload).toEqual({ reason: "completed" })
    expect(parseWrite("close", { numbers: [1], note: "x", reason: "not planned", comment: "Thanks!" }).payload).toEqual({ reason: "not_planned", body: "Thanks!" })
    expect(parseWrite("close", { numbers: [1], note: "x", duplicate_of: 9 }).payload).toEqual({ reason: "duplicate", duplicateOf: 9 })
    expect(() => parseWrite("close", { numbers: [1], note: "x", reason: "duplicate" })).toThrow("`duplicate_of` is required")
    expect(() => parseWrite("close", { numbers: [1], note: "x", reason: "completed", duplicate_of: 2 })).toThrow("only goes with")
    expect(() => parseWrite("close", { numbers: [1, 2], note: "x", duplicate_of: 2 })).toThrow("itself")
    expect(() => parseWrite("close", { numbers: [1], note: "x", reason: "wontfix" })).toThrow("`reason` must be")
  })

  test("comments, labels and assignees", () => {
    expect(() => parseWrite("comment", { numbers: [1], note: "x", body: "  " })).toThrow("must not be empty")
    expect(() => parseWrite("comment", { numbers: [1], note: "x", body: "a".repeat(70_000) })).toThrow("GitHub allows")
    expect(parseWrite("label", { numbers: [1], note: "x", add: [" bug ", "bug"], remove: ["triage"] }).payload).toEqual({ add: ["bug"], remove: ["triage"] })
    expect(() => parseWrite("label", { numbers: [1], note: "x" })).toThrow("at least one name")
    expect(() => parseWrite("label", { numbers: [1], note: "x", add: [""] })).toThrow("empty name")
    expect(() => parseWrite("label", { numbers: [1], note: "x", add: ["a"], remove: ["a"] })).toThrow("both added and removed")
    expect(parseWrite("assign", { numbers: [1], note: "x", add: ["@octocat", "@me"] }).payload).toEqual({ add: ["octocat", "@me"], remove: [] })
    expect(() => parseWrite("assign", { numbers: [1], note: "x", add: ["not a login"] })).toThrow("not a GitHub login")
  })
})

test("expand makes one action per number in a shared batch", () => {
  const ids = ["x", "y"]
  const actions = expand(parseWrite("close", { numbers: [5, 6], note: "dupes", duplicate_of: 4 }), {
    sessionID: "ses",
    repo: "o/r",
    batch: "b",
    now: 10,
    status: "proposed",
    items: new Map([[5, { title: "Five", item: "issue" as const }]]),
    id: () => ids.shift() ?? "z",
  })
  expect(actions.map((item) => [item.id, item.number, item.title, item.item, item.batch, item.status])).toEqual([
    ["x", 5, "Five", "issue", "b", "proposed"],
    ["y", 6, "", null, "b", "proposed"],
  ])
  expect(describeAction(actions[0]!)).toBe("close as duplicate of #4")
})

test("describe", () => {
  expect(describeAction(action({ payload: { reason: "not_planned", body: "bye" } }))).toBe("close as not planned, with a comment")
  expect(describeAction(action({ item: "pr", payload: { reason: "not_planned" } }))).toBe("close")
  expect(describeAction(action({ kind: "label", payload: { add: ["bug", "p1"], remove: ["triage"] } }))).toBe("add labels bug, p1, remove label triage")
  expect(describeAction(action({ kind: "assign", payload: { add: ["me"], remove: [] } }))).toBe("add assignee @me")
})

describe("undoFor", () => {
  test("maps each done action to its reverse", () => {
    expect(undoFor(action({ result: { commentId: 7 } }))).toEqual({ kind: "reopen", payload: { commentId: 7 } })
    expect(undoFor(action({ kind: "reopen", payload: {}, result: { reason: "not_planned" } }))).toEqual({ kind: "close", payload: { reason: "not_planned" } })
    expect(undoFor(action({ kind: "reopen", payload: {}, result: { reason: "duplicate" } }))).toEqual({ kind: "close", payload: { reason: "completed" } })
    expect(undoFor(action({ kind: "comment", payload: { body: "hi" }, result: { commentId: 3 } }))).toEqual({ kind: "uncomment", payload: { commentId: 3 } })
    expect(undoFor(action({ kind: "label", payload: { add: ["a", "b"], remove: ["c"] }, result: { added: ["a"], removed: ["c"] } }))).toEqual({
      kind: "label",
      payload: { add: ["c"], remove: ["a"] },
    })
  })

  test("refuses what cannot be reverted for certain", () => {
    expect(undoFor(action({ status: "proposed" }))).toBeUndefined()
    expect(undoFor(action({ undoneBy: "a2" }))).toBeUndefined()
    expect(undoFor(action({ undoOf: "a0" }))).toBeUndefined()
    expect(undoFor(action({ result: { noop: true } }))).toBeUndefined()
    expect(undoFor(action({ kind: "comment", payload: { body: "hi" }, result: {} }))).toBeUndefined()
    expect(undoFor(action({ kind: "label", payload: { add: ["a"] }, result: { added: [], removed: [] } }))).toBeUndefined()
    expect(undoFor(action({ kind: "uncomment", payload: { commentId: 1 } }))).toBeUndefined()
    // From the shell only a close is clearly reversible.
    expect(undoFor(action({ source: "shell", result: null }))).toEqual({ kind: "reopen", payload: {} })
    expect(undoFor(action({ source: "shell", kind: "label", payload: { add: ["a"] }, result: null }))).toBeUndefined()
    expect(undoFor(action({ source: "shell", kind: "reopen", payload: {}, result: null }))).toBeUndefined()
  })
})

describe("parseShell", () => {
  test("finds gh writes with their number and repository", () => {
    expect(parseShell('gh issue close 12 --reason "not planned" -c "Thanks"')).toEqual([
      { group: "issue", verb: "close", number: 12, repo: null, cd: null, kind: "close", payload: { command: 'gh issue close 12 --reason "not planned" -c Thanks', reason: "not_planned" } },
    ])
    const [chained, second] = parseShell("cd x && gh -R octo/repo issue reopen #3; GH_REPO=a/b /opt/homebrew/bin/gh pr comment 4 --body 'a; b'")
    expect(chained).toMatchObject({ group: "issue", verb: "reopen", number: 3, repo: "octo/repo", kind: "reopen" })
    expect(second).toMatchObject({ group: "pr", verb: "comment", number: 4, repo: "a/b", kind: "comment" })
    expect(parseShell("gh issue close https://github.com/o/r/issues/77 --duplicate-of 70")[0]).toMatchObject({
      repo: "o/r",
      number: 77,
      payload: { reason: "duplicate", duplicateOf: 70 },
    })
    expect(parseShell("gh issue close 5 --repo=github.com/o/r")[0]?.repo).toBe("o/r")
  })

  test("follows cd, and gives up on a directory it cannot tell", () => {
    expect(parseShell("cd ../other && gh issue close 1")[0]?.cd).toBe("../other")
    expect(parseShell("cd /abs; cd sub && gh issue close 1")[0]?.cd).toBe("/abs/sub")
    expect(parseShell("cd $DIR && gh issue close 1")[0]?.cd).toBe("?")
    expect(parseShell("gh issue close 1 && cd x")[0]?.cd).toBeNull()
    expect(parseShell("cd x && gh issue close 1 -R o/r")[0]).toMatchObject({ repo: "o/r", cd: "x" })
  })

  test("labels and assignees from edit, anything else as other", () => {
    expect(parseShell("gh issue edit 9 --add-label bug,p1 --remove-label triage")[0]).toMatchObject({ kind: "label", payload: { add: ["bug", "p1"], remove: ["triage"] } })
    expect(parseShell("gh pr edit 9 --add-assignee @me")[0]).toMatchObject({ kind: "assign", payload: { add: ["@me"], remove: [] } })
    expect(parseShell("gh issue edit 9 --title x --add-label bug")[0]?.kind).toBe("other")
    expect(parseShell("gh pr merge 8 --squash --delete-branch")[0]).toMatchObject({ verb: "merge", number: 8, kind: "other" })
    expect(parseShell("gh pr review 8 -r -b 'please fix'")[0]).toMatchObject({ verb: "review", number: 8, kind: "other" })
  })

  test("leaves out what it cannot pin down", () => {
    expect(parseShell("gh pr merge --squash")).toEqual([])
    expect(parseShell("gh pr comment my-branch -b hi")).toEqual([])
    expect(parseShell("gh issue close $N")).toEqual([])
    expect(parseShell("gh issue view 3")).toEqual([])
    expect(parseShell("gh issue list --state open")).toEqual([])
    expect(parseShell("echo gh issue close 3")).toEqual([])
    expect(parseShell("git commit -m 'gh issue close 3'")).toEqual([])
  })
})

test("backoff retries rate limits only, a few times", () => {
  expect(backoff("HTTP 403: Resource not accessible by integration", 0)).toBeUndefined()
  expect(backoff("HTTP 403: You have exceeded a secondary rate limit", 0)).toBe(60_000)
  expect(backoff("HTTP 403: You have exceeded a secondary rate limit", 1)).toBe(120_000)
  expect(backoff("HTTP 429: Too Many Requests", 2)).toBe(240_000)
  expect(backoff("HTTP 429: Too Many Requests", 3)).toBeUndefined()
  expect(backoff("Retry-After: 5", 0)).toBe(5000)
})

test("settle fails running actions a stopped server left behind", () => {
  const [old, fresh, done] = settle([action({ status: "running", updatedAt: 0 }), action({ status: "running", updatedAt: STALE }), action()], STALE + 1)
  expect(old?.status).toBe("failed")
  expect(fresh?.status).toBe("running")
  expect(done?.status).toBe("done")
  expect(counts([action({ status: "proposed" }), action({ status: "approved" }), action()])).toEqual({ proposed: 1, running: 1, done: 1, failed: 0 })
})

test("expand marks the user's own actions and the triage batch", () => {
  const [user] = expand(parseWrite("label", { numbers: [5], note: "user", add: ["bug"] }), {
    sessionID: "ses",
    repo: "o/r",
    batch: "b",
    now: 1,
    status: "approved",
    items: new Map(),
    id: () => "x",
    source: "user",
  })
  expect(user).toMatchObject({ source: "user", note: "", status: "approved" })
  expect(user?.round).toBeUndefined()
  const [tool] = expand(parseWrite("reopen", { numbers: [5], note: "why" }), { sessionID: "ses", repo: "o/r", batch: "b", now: 1, status: "proposed", items: new Map(), id: () => "y", round: 3 })
  expect(tool).toMatchObject({ source: "tool", note: "why", round: 3 })
})

test("blocker", () => {
  expect(blocker("close", undefined, undefined)).toBe("does not exist or cannot be read")
  expect(blocker("close", { state: "CLOSED" }, undefined)).toBe("already closed")
  expect(blocker("reopen", { state: "MERGED" }, undefined)).toBe("merged; it cannot be reopened")
  expect(blocker("reopen", { state: "OPEN" }, undefined)).toBe("already open")
  expect(blocker("label", { state: "OPEN" }, { status: "proposed" })).toBe("already proposed and waiting for the user")
  expect(blocker("comment", { state: "CLOSED" }, undefined)).toBeUndefined()
})

test("edits tells the agent what the user changed", () => {
  expect(edits(action())).toBeUndefined()
  expect(edits(action({ edited: true }))).toBe("edited by the user")
  expect(edits(action({ edited: true, original: { reason: "completed" }, payload: { reason: "not_planned" } }))).toBe(
    "edited by the user: you proposed close as completed; the user changed it to close as not planned.",
  )
  expect(edits(action({ kind: "comment", edited: true, original: { body: "Hi\nthere" }, payload: { body: "Hello" } }))).toBe(
    'edited by the user: you proposed comment "Hi there"; the user rewrote the comment. Your comment: "Hi there"; the user\'s: "Hello".',
  )
})

test("triageProgress counts reviewed items and the user's decisions", () => {
  const actions = [
    action({ number: 1, round: 1, status: "done" }),
    action({ number: 1, round: 1, kind: "label", status: "skipped" }),
    action({ number: 2, round: 2, status: "proposed" }),
    action({ number: 9, source: "user", round: undefined }),
  ]
  expect(triageProgress({ total: 10, reviewed: [1, 3] }, actions)).toEqual({ reviewed: 3, total: 10, approved: 1, skipped: 1, waiting: 1 })
  expect(triageProgress({ total: 1, reviewed: [] }, actions).total).toBe(2)
})

test("toggleRange", () => {
  const numbers = [10, 11, 12, 13]
  expect([...toggleRange(new Set(), numbers, 1, undefined, false)]).toEqual([11])
  expect([...toggleRange(new Set([11]), numbers, 1, 1, false)]).toEqual([])
  expect([...toggleRange(new Set([11]), numbers, 3, 1, true)].sort()).toEqual([11, 12, 13])
  expect([...toggleRange(new Set([10, 11, 12, 13]), numbers, 0, 2, true)].sort()).toEqual([13])
  expect([...toggleRange(new Set([10]), numbers, 9, 0, true)]).toEqual([10])
})

test("itemList and triagePrompt", () => {
  expect(itemList("o/r", "issue", [{ number: 3, title: "Crash", state: "OPEN", author: "ann", labels: [{ name: "bug" }] }])).toBe("1 issues in o/r:\n\n- #3 (open) Crash [bug] · @ann")
  const prompt = triagePrompt({
    repo: "o/r",
    kind: "issue",
    query: "is:open label:quota sort:created-asc",
    numbers: [],
    total: 40,
    rules: "Close free-tier quota questions as not planned.",
    replies: [{ name: "Free tier", body: "The free tier has a quota." }],
    batch: 20,
  })
  expect(prompt).toContain('repo "o/r", exactly this query')
  expect(prompt).toContain("is:open label:quota sort:created-asc")
  expect(prompt).toContain("### Free tier\n\nThe free tier has a quota.")
  expect(prompt).toContain("batches of 20")
  expect(prompt).toContain("`wait: true`")
  expect(prompt).toContain("no gh in the shell")
  expect(triagePrompt({ repo: "o/r", kind: "pr", query: null, numbers: [4, 5], total: 2, rules: "", replies: [], batch: 5 })).toContain("These 2 pull requests: #4, #5.")
})
