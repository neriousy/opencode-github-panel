import { describe, expect, test } from "bun:test"
import { layout } from "./graph"
import { parseBranches, parseDecorations, parseLog, parseRemote, parseStatus } from "./git"

describe("parseStatus", () => {
  test("reads branch headers, renames, conflicts and untracked files", () => {
    const output = [
      "# branch.oid 1234567890abcdef",
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 aaa bbb src/a file.ts",
      "2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts",
      "src/old.ts",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts",
      "? notes.md",
      "",
    ].join("\0")
    const parsed = parseStatus(output)
    expect(parsed.branch).toEqual({
      head: "1234567890abcdef",
      branch: "feature/x",
      upstream: "origin/feature/x",
      ahead: 2,
      behind: 1,
    })
    expect(parsed.files.map((file) => [file.path, file.index, file.worktree, file.origPath])).toEqual([
      ["src/a file.ts", ".", "M", null],
      ["src/new.ts", "R", ".", "src/old.ts"],
      ["conflict.ts", "U", "U", null],
      ["notes.md", ".", "?", null],
    ])
    expect(parsed.files[2]?.conflicted).toBe(true)
    expect(parsed.files[3]?.untracked).toBe(true)
  })

  test("reads detached and initial heads", () => {
    const parsed = parseStatus(["# branch.oid (initial)", "# branch.head (detached)", ""].join("\0"))
    expect(parsed.branch.head).toBeNull()
    expect(parsed.branch.branch).toBeNull()
  })
})

test("parseDecorations", () => {
  expect(parseDecorations("HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1")).toEqual([
    { name: "HEAD", kind: "head" },
    { name: "main", kind: "local" },
    { name: "origin/main", kind: "remote" },
    { name: "v1", kind: "tag" },
  ])
  expect(parseDecorations("HEAD, refs/stash, refs/pull/1/head, grafted")).toEqual([{ name: "HEAD", kind: "head" }])
})

test("parseLog", () => {
  const output = "a\x1fb c\x1fAda\x1fada@x.dev\x1f100\x1fMerge thing\x1frefs/heads/dev\x1e\nb\x1f\x1fAda\x1fada@x.dev\x1f90\x1fRoot\x1f\x1e\n"
  expect(parseLog(output)).toEqual([
    { hash: "a", parents: ["b", "c"], author: "Ada", email: "ada@x.dev", date: 100, subject: "Merge thing", refs: [{ name: "dev", kind: "local" }] },
    { hash: "b", parents: [], author: "Ada", email: "ada@x.dev", date: 90, subject: "Root", refs: [] },
  ])
})

test("parseBranches", () => {
  const output = [
    "refs/heads/main\x1fabc\x1forigin/main\x1fahead 1, behind 2\x1f100\x1fFix\x1f*",
    "refs/heads/old\x1fdef\x1forigin/old\x1fgone\x1f90\x1fOld\x1f ",
    "refs/remotes/origin/HEAD\x1fabc\x1f\x1f\x1f100\x1fFix\x1f ",
    "refs/remotes/origin\x1fabc\x1f\x1f\x1f100\x1fFix\x1f ",
    "refs/remotes/origin/main\x1fabc\x1f\x1f\x1f100\x1fFix\x1f ",
  ].join("\n")
  expect(parseBranches(output).map((branch) => [branch.name, branch.remote, branch.current, branch.ahead, branch.behind, branch.gone])).toEqual([
    ["main", false, true, 1, 2, false],
    ["old", false, false, 0, 0, true],
    ["origin/main", true, false, 0, 0, false],
  ])
})

test("parseRemote", () => {
  const expected = { name: "origin", owner: "anomalyco", repo: "opencode", web: "https://github.com/anomalyco/opencode" }
  expect(parseRemote("origin", "git@github.com:anomalyco/opencode.git")).toEqual(expected)
  expect(parseRemote("origin", "https://github.com/anomalyco/opencode")).toEqual(expected)
  expect(parseRemote("origin", "ssh://git@github.com/anomalyco/opencode.git")).toEqual(expected)
  expect(parseRemote("origin", "https://token@github.com/anomalyco/opencode.git/")).toEqual(expected)
  expect(parseRemote("origin", "ssh://git@ssh.github.com:443/anomalyco/opencode.git")).toEqual(expected)
  expect(parseRemote("origin", "https://github.com:443/anomalyco/opencode.git\r\n")).toEqual(expected)
  expect(parseRemote("origin", "org-123@github.com:anomalyco/opencode.git")).toEqual(expected)
  expect(parseRemote("origin", "git@github.com:anomalyco/opencode")).toEqual(expected)
  expect(parseRemote("fork", "git@github.com:a.b/c.d.git")).toEqual({ name: "fork", owner: "a.b", repo: "c.d", web: "https://github.com/a.b/c.d" })
  expect(parseRemote("origin", "git@gitlab.com:a/b.git")).toBeUndefined()
  expect(parseRemote("origin", "https://github.com.evil.dev/a/b.git")).toBeUndefined()
  expect(parseRemote("origin", "https://github.com/a/b/c")).toBeUndefined()
})

describe("layout", () => {
  test("a straight history stays in one lane", () => {
    const rows = layout([
      { hash: "c", parents: ["b"] },
      { hash: "b", parents: ["a"] },
      { hash: "a", parents: [] },
    ])
    expect(rows.map((row) => row.col)).toEqual([0, 0, 0])
    expect(rows.map((row) => row.width)).toEqual([1, 1, 1])
  })

  test("a merge opens a second lane that joins back at the fork point", () => {
    // m merges f into d; both come from a.
    const rows = layout([
      { hash: "m", parents: ["d", "f"] },
      { hash: "d", parents: ["a"] },
      { hash: "f", parents: ["a"] },
      { hash: "a", parents: [] },
    ])
    expect(rows.map((row) => row.col)).toEqual([0, 0, 1, 0])
    expect(rows[0]?.edges).toEqual([
      { kind: "out", from: 0, to: 0, color: 0 },
      { kind: "out", from: 0, to: 1, color: 1 },
    ])
    // f's lane points at a, which lane 0 already expects, so it curves back into lane 0 in its own color.
    expect(rows[2]?.edges).toContainEqual({ kind: "out", from: 1, to: 0, color: 1 })
    expect(rows[3]?.width).toBe(1)
    expect(rows[3]?.edges.filter((edge) => edge.kind === "in")).toHaveLength(1)
  })

  test("two branch tips get their own lanes", () => {
    const rows = layout([
      { hash: "x", parents: ["a"] },
      { hash: "y", parents: ["a"] },
      { hash: "a", parents: [] },
    ])
    expect(rows.map((row) => row.col)).toEqual([0, 1, 0])
    // y joins the lane that already leads to a.
    expect(rows[1]?.edges).toContainEqual({ kind: "out", from: 1, to: 0, color: 1 })
    expect(rows[2]?.width).toBe(1)
  })
})

describe("mentions", () => {
  test("findRefs", async () => {
    const { findRefs } = await import("./git")
    expect(findRefs("Fixes #12, see anomalyco/opencode#59437 and (#7).").map((ref) => [ref.repo, ref.number])).toEqual([
      [undefined, 12],
      ["anomalyco/opencode", 59437],
      [undefined, 7],
    ])
    expect(findRefs("color #fff, a#1, &#123; path/#5, C# 7, issue#9")).toEqual([])
  })

  test("parseItemUrl", async () => {
    const { parseItemUrl } = await import("./git")
    expect(parseItemUrl("https://github.com/anomalyco/opencode/pull/59437/files")).toEqual({ repo: "anomalyco/opencode", number: 59437 })
    expect(parseItemUrl("https://github.com/anomalyco/opencode/issues/27167#issuecomment-1")).toEqual({ repo: "anomalyco/opencode", number: 27167 })
    expect(parseItemUrl("https://github.com/anomalyco/opencode/pulls")).toBeUndefined()
    expect(parseItemUrl("https://example.com/a/b/pull/1")).toBeUndefined()
  })
})

test("parseGitHubLink", async () => {
  const { parseGitHubLink } = await import("./git")
  expect(parseGitHubLink("https://github.com/a/b/pull/3/files")).toEqual({ kind: "item", ref: { repo: "a/b", number: 3 }, files: true })
  expect(parseGitHubLink("https://github.com/a/b/issues/1#issuecomment-2")).toEqual({ kind: "item", ref: { repo: "a/b", number: 1 }, files: false })
  expect(parseGitHubLink("https://github.com/a/b/commit/abc1234")).toEqual({ kind: "commit", repo: "a/b", sha: "abc1234" })
  expect(parseGitHubLink("https://github.com/a/b/pull/3/commits/abcdef12")).toEqual({ kind: "commit", repo: "a/b", sha: "abcdef12" })
  expect(parseGitHubLink("https://github.com/a/b/actions/runs/40/job/41")).toEqual({ kind: "run", repo: "a/b", id: 40, job: 41 })
  expect(parseGitHubLink("https://github.com/a/b/actions/runs/40")).toEqual({ kind: "run", repo: "a/b", id: 40, job: null })
  expect(parseGitHubLink("https://github.com/a/b")).toBeUndefined()
  expect(parseGitHubLink("https://github.com/a/b/tree/main")).toBeUndefined()
})

test("parsePatch", async () => {
  const { parsePatch } = await import("./git")
  const lines = parsePatch("@@ -1,3 +1,4 @@\n a\n-b\n+B\n+c\n d\n\\ No newline at end of file")
  expect(lines.map((line) => [line.kind, line.old, line.new, line.text])).toEqual([
    ["hunk", null, null, "@@ -1,3 +1,4 @@"],
    ["context", 1, 1, "a"],
    ["del", 2, null, "b"],
    ["add", null, 2, "B"],
    ["add", null, 3, "c"],
    ["context", 3, 4, "d"],
  ])
  expect(parsePatch("@@ -1 +1 @@\n-a\n+b\n").map((line) => line.kind)).toEqual(["hunk", "del", "add"])
})

describe("issue links", () => {
  test("issueBranchName", async () => {
    const { issueBranchName } = await import("./git")
    expect(issueBranchName(12, "Multiply returns imprecise results for floats, sometimes")).toBe("12-multiply-returns-imprecise-results-for-floats")
    expect(issueBranchName(7, "  ¿Qué?  ")).toBe("7-qu")
    expect(issueBranchName(3, "!!!")).toBe("3")
  })

  test("issueFromBranch", async () => {
    const { issueFromBranch } = await import("./git")
    expect(issueFromBranch("123-fix-the-thing")).toBe(123)
    expect(issueFromBranch("feat/45-add-x")).toBe(45)
    expect(issueFromBranch("issue-9")).toBe(9)
    expect(issueFromBranch("fix-77-crash")).toBe(77)
    expect(issueFromBranch("fix/88")).toBe(88)
    expect(issueFromBranch("bob/gh-5")).toBe(5)
    expect(issueFromBranch("issues_31")).toBe(31)
    expect(issueFromBranch("main")).toBeUndefined()
    expect(issueFromBranch("v2-release")).toBeUndefined()
    expect(issueFromBranch("fixture-12")).toBeUndefined()
    expect(issueFromBranch("0-zero")).toBeUndefined()
  })

  test("closingRefs", async () => {
    const { closingRefs } = await import("./git")
    expect(closingRefs("Fixes #12.\nAlso closes a/b#3 and resolved: https://github.com/c/d/issues/4")).toEqual([
      { repo: undefined, number: 12 },
      { repo: "a/b", number: 3 },
      { repo: "c/d", number: 4 },
    ])
    expect(closingRefs("Related to #5, see #6. Prefix #7")).toEqual([])
    expect(closingRefs("<!-- Fixes #1 -->\nfixed #2")).toEqual([{ repo: undefined, number: 2 }])
  })

  test("withClosing", async () => {
    const { withClosing } = await import("./git")
    expect(withClosing("", 4)).toBe("Fixes #4")
    expect(withClosing("- one\n- two\n\n", 4)).toBe("- one\n- two\n\nFixes #4")
    expect(withClosing("Closes #4 for good", 4)).toBe("Closes #4 for good")
    expect(withClosing("Closes other/repo#4", 4)).toBe("Closes other/repo#4\n\nFixes #4")
    // A template: its comments do not count, and the line goes at the end.
    expect(withClosing("## Summary\n\n<!-- Fixes #123 -->\n", 4)).toBe("## Summary\n\n<!-- Fixes #123 -->\n\nFixes #4")
    // A template's empty closing line takes the number; one in a comment does not.
    expect(withClosing("### Issue for this PR\n\nCloses #\n\n### Type", 4)).toBe("### Issue for this PR\n\nCloses #4\n\n### Type")
    expect(withClosing("<!-- Fixes # -->\nResolves: # (issue)", 4)).toBe("<!-- Fixes # -->\nResolves: #4 (issue)")
    expect(withClosing("Fixes ## nothing", 4)).toBe("Fixes ## nothing\n\nFixes #4")
  })

  test("parseItem reads closing references", async () => {
    const { parseItem } = await import("./git")
    const output = JSON.stringify({
      number: 1,
      title: "t",
      state: "CLOSED",
      url: "u",
      createdAt: "c",
      updatedAt: "u",
      closedByPullRequestsReferences: [{ number: 3, repository: { name: "sandbox", owner: { login: "me" } } }, { number: 4 }],
    })
    expect(parseItem("issue", "me/repo", output).links).toEqual([
      { repo: "me/sandbox", number: 3 },
      { repo: "me/repo", number: 4 },
    ])
  })
})
