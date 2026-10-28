import { describe, expect, test } from "bun:test"
import { cleanupCandidates } from "./cleanup"
import type { Branch, PullRequest } from "./contract"

const branch = (name: string, extra: Partial<Branch> = {}): Branch => ({
  name,
  remote: false,
  current: false,
  upstream: `origin/${name}`,
  ahead: 0,
  behind: 0,
  gone: false,
  sha: "abc1234",
  date: 0,
  subject: "",
  ...extra,
})

const pr = (head: string, state: PullRequest["state"], sha = "abc1234def"): PullRequest => ({
  number: head.length,
  title: head,
  state,
  draft: false,
  url: "",
  head,
  cross: false,
  base: "dev",
  author: "me",
  review: null,
  checks: "none",
  updated: "",
  sha,
})

describe("cleanupCandidates", () => {
  test("lists done branches with their reasons and flags the ones that could lose commits", () => {
    const pulls = [pr("squashed", "MERGED"), pr("abandoned", "CLOSED"), pr("active", "OPEN"), pr("moved-on", "MERGED", "fff0000")]
    const candidates = cleanupCandidates({
      branches: [
        branch("dev"),
        branch("work", { current: true, gone: true }),
        branch("squashed", { gone: true }),
        branch("abandoned"),
        branch("active", { gone: true }),
        branch("moved-on", { gone: true }),
        branch("deleted", { gone: true }),
        branch("unpushed", { ahead: 2, gone: false }),
        branch("merged", { upstream: null }),
        branch("fresh", { upstream: null }),
        branch("origin/squashed", { remote: true }),
      ],
      current: "work",
      base: "dev",
      merged: ["dev", "merged", "unpushed"],
      pullFor: (name) => pulls.find((item) => item.head === name),
    })
    expect(candidates).toEqual([
      { name: "squashed", reasons: [{ kind: "merged-pr", number: 8 }, { kind: "gone" }], risk: null },
      { name: "abandoned", reasons: [{ kind: "closed-pr", number: 9 }], risk: null },
      { name: "moved-on", reasons: [{ kind: "merged-pr", number: 8 }, { kind: "gone" }], risk: "moved" },
      { name: "deleted", reasons: [{ kind: "gone" }], risk: "unmerged" },
      { name: "unpushed", reasons: [{ kind: "merged", base: "dev" }], risk: null },
      { name: "merged", reasons: [{ kind: "merged", base: "dev" }], risk: null },
    ])
  })

  test("flags unpushed commits on a branch whose pull request is done", () => {
    const candidates = cleanupCandidates({
      branches: [branch("later", { ahead: 1 })],
      current: null,
      base: "main",
      merged: [],
      pullFor: () => pr("later", "MERGED"),
    })
    expect(candidates[0]?.risk).toBe("unpushed")
  })
})
