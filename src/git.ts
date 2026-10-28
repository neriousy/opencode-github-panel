import type { Branch, Check, Commit, FileChange, Issue, Item, ItemRef, Label, PullRequest, Ref, Remote } from "./schemas"

export const FIELD = "\x1f"
export const RECORD = "\x1e"

export const LOG_FORMAT = ["%H", "%P", "%an", "%ae", "%at", "%s", "%D"].join("%x1f") + "%x1e"

export const BRANCH_FORMAT = [
  "%(refname)",
  "%(objectname:short)",
  "%(upstream:short)",
  "%(upstream:track,nobracket)",
  "%(committerdate:unix)",
  "%(contents:subject)",
  "%(HEAD)",
].join("%1f")

export interface StatusBranch {
  head: string | null
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatus(output: string) {
  const tokens = output.split("\0")
  const branch: StatusBranch = { head: null, branch: null, upstream: null, ahead: 0, behind: 0 }
  const files: FileChange[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    if (token.startsWith("# ")) {
      const [key, ...rest] = token.slice(2).split(" ")
      const value = rest.join(" ")
      if (key === "branch.oid") branch.head = value === "(initial)" ? null : value
      if (key === "branch.head") branch.branch = value === "(detached)" ? null : value
      if (key === "branch.upstream") branch.upstream = value
      if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        branch.ahead = Number(match?.[1] ?? 0)
        branch.behind = Number(match?.[2] ?? 0)
      }
      continue
    }
    const kind = token[0]
    if (kind === "?") {
      files.push(change(token.slice(2), null, ".", "?", false, true))
      continue
    }
    if (kind === "1") {
      const parts = token.split(" ")
      const xy = parts[1] ?? ".."
      files.push(change(parts.slice(8).join(" "), null, xy[0] ?? ".", xy[1] ?? ".", false, false))
      continue
    }
    if (kind === "2") {
      const parts = token.split(" ")
      const xy = parts[1] ?? ".."
      const orig = tokens[i + 1] ?? null
      i++
      files.push(change(parts.slice(9).join(" "), orig, xy[0] ?? ".", xy[1] ?? ".", false, false))
      continue
    }
    if (kind === "u") {
      const parts = token.split(" ")
      const xy = parts[1] ?? "UU"
      files.push(change(parts.slice(10).join(" "), null, xy[0] ?? "U", xy[1] ?? "U", true, false))
    }
  }

  return { branch, files }
}

function change(
  path: string,
  origPath: string | null,
  index: string,
  worktree: string,
  conflicted: boolean,
  untracked: boolean,
): FileChange {
  return { path, origPath, index, worktree, conflicted, untracked }
}

/** Parses `git log --decorate=full --format=LOG_FORMAT`. */
export function parseLog(output: string): Commit[] {
  return output
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.length > 0)
    .flatMap((record) => {
      const [hash, parents, author, email, date, subject, decorations] = record.split(FIELD)
      if (!hash) return []
      return [
        {
          hash,
          parents: parents ? parents.split(" ").filter(Boolean) : [],
          author: author ?? "",
          email: email ?? "",
          date: Number(date ?? 0),
          subject: subject ?? "",
          refs: parseDecorations(decorations ?? ""),
        },
      ]
    })
}

/** Parses `%D` with `--decorate=full`: "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1". */
export function parseDecorations(value: string): Ref[] {
  return value
    .split(", ")
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((item): Ref[] => {
      if (item === "HEAD") return [{ name: "HEAD", kind: "head" }]
      if (item.startsWith("HEAD -> ")) {
        const name = item.slice("HEAD -> ".length)
        return [{ name: "HEAD", kind: "head" }, ...parseDecorations(name)]
      }
      if (item.startsWith("tag: ")) return [{ name: item.slice(5).replace(/^refs\/tags\//, ""), kind: "tag" }]
      if (item.startsWith("refs/heads/")) return [{ name: item.slice(11), kind: "local" }]
      if (item.startsWith("refs/remotes/")) {
        const name = item.slice(13)
        if (name.endsWith("/HEAD")) return []
        return [{ name, kind: "remote" }]
      }
      // refs/stash, refs/pull/*, refs/notes and the like, and "grafted" in shallow clones: not branches to show.
      return []
    })
}

/** Parses `git for-each-ref --format=BRANCH_FORMAT refs/heads refs/remotes`. */
export function parseBranches(output: string): Branch[] {
  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line): Branch[] => {
      const [ref, sha, upstream, track, date, subject, head] = line.split(FIELD)
      if (!ref) return []
      const remote = ref.startsWith("refs/remotes/")
      const name = ref.replace(/^refs\/(heads|remotes)\//, "")
      if (remote && (name.endsWith("/HEAD") || !name.includes("/"))) return []
      return [
        {
          name,
          remote,
          current: head === "*",
          upstream: upstream || null,
          ahead: Number(/ahead (\d+)/.exec(track ?? "")?.[1] ?? 0),
          behind: Number(/behind (\d+)/.exec(track ?? "")?.[1] ?? 0),
          gone: track === "gone",
          sha: sha ?? "",
          date: Number(date ?? 0),
          subject: subject ?? "",
        },
      ]
    })
}

/**
 * Reads a GitHub owner and repository from a remote URL, or undefined for other hosts: scp-like and ssh:// URLs (any
 * user, ssh.github.com on port 443 too), and https:// with or without credentials and port.
 */
export function parseRemote(name: string, url: string): Remote | undefined {
  const match =
    /^(?:[\w.-]+@|ssh:\/\/(?:[\w.-]+@)?|git\+ssh:\/\/(?:[\w.-]+@)?|https?:\/\/(?:[^@/]+@)?|git:\/\/)(?:www\.|ssh\.)?github\.com(?::\d+)?[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim())
  if (!match?.[1] || !match[2]) return undefined
  return { name, owner: match[1], repo: match[2], web: `https://github.com/${match[1]}/${match[2]}` }
}

interface GhCheck {
  readonly __typename?: string
  readonly name?: string
  readonly context?: string
  readonly status?: string
  readonly conclusion?: string
  readonly state?: string
  readonly detailsUrl?: string
  readonly targetUrl?: string
}

interface GhPull {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly isDraft: boolean
  readonly url: string
  readonly headRefName: string
  readonly baseRefName: string
  readonly isCrossRepository?: boolean
  readonly author?: { readonly login?: string }
  readonly reviewDecision?: string
  readonly statusCheckRollup?: readonly GhCheck[]
  readonly updatedAt: string
}

/** Parses `gh pr list --json ...`. */
export function parsePulls(output: string): PullRequest[] {
  const parsed: unknown = JSON.parse(output || "[]")
  if (!Array.isArray(parsed)) return []
  // SAFETY: gh returns the fields requested with --json; each one is read defensively below.
  return (parsed as GhPull[]).map((item) => ({
    number: item.number,
    title: item.title,
    state: item.state === "MERGED" ? "MERGED" : item.state === "CLOSED" ? "CLOSED" : "OPEN",
    draft: item.isDraft === true,
    url: item.url,
    head: item.headRefName,
    cross: item.isCrossRepository === true,
    base: item.baseRefName,
    author: item.author?.login ?? "",
    review: item.reviewDecision || null,
    checks: checks(item.statusCheckRollup),
    updated: item.updatedAt,
  }))
}

function checks(rollup: readonly GhCheck[] | undefined): PullRequest["checks"] {
  if (!rollup || rollup.length === 0) return "none"
  const states = rollup.map((check) => {
    if (check.__typename === "StatusContext") return check.state ?? ""
    if (check.status && check.status !== "COMPLETED") return "PENDING"
    return check.conclusion ?? ""
  })
  if (states.some((state) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(state)))
    return "failure"
  if (states.some((state) => ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", ""].includes(state)))
    return "pending"
  return "success"
}

interface GhLabel {
  readonly name: string
  readonly color?: string
}

interface GhIssue {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly url: string
  readonly author?: { readonly login?: string }
  readonly labels?: readonly GhLabel[]
  readonly assignees?: readonly { readonly login?: string }[]
  readonly updatedAt: string
}

const labels = (list: readonly GhLabel[] | undefined): Label[] =>
  (list ?? []).map((label) => ({ name: label.name, color: label.color ?? "888888" }))

const logins = (list: readonly { readonly login?: string }[] | undefined) =>
  (list ?? []).flatMap((item) => (item.login ? [item.login] : []))

/** Parses `gh issue list --json number,title,state,url,author,labels,assignees,updatedAt`. */
export function parseIssues(output: string): Issue[] {
  const parsed: unknown = JSON.parse(output || "[]")
  if (!Array.isArray(parsed)) return []
  // SAFETY: gh returns the fields requested with --json; optional ones are read defensively below.
  return (parsed as GhIssue[]).map((item) => ({
    number: item.number,
    title: item.title,
    state: item.state === "CLOSED" ? "CLOSED" : "OPEN",
    url: item.url,
    author: item.author?.login ?? "",
    labels: labels(item.labels),
    assignees: logins(item.assignees),
    updated: item.updatedAt,
  }))
}

interface GhItem extends GhIssue {
  readonly body?: string
  readonly createdAt: string
  readonly isDraft?: boolean
  readonly comments?: readonly { readonly author?: { readonly login?: string }; readonly body: string; readonly createdAt: string }[]
  readonly headRefName?: string
  readonly baseRefName?: string
  readonly isCrossRepository?: boolean
  readonly additions?: number
  readonly deletions?: number
  readonly changedFiles?: number
  readonly reviewDecision?: string
  readonly mergeable?: string
  readonly statusCheckRollup?: readonly GhCheck[]
  readonly milestone?: { readonly title?: string } | null
  readonly headRefOid?: string
  readonly reviewRequests?: readonly { readonly login?: string; readonly name?: string; readonly slug?: string }[]
  readonly closedByPullRequestsReferences?: readonly GhReference[]
  readonly closingIssuesReferences?: readonly GhReference[]
}

interface GhReference {
  readonly number?: number
  readonly repository?: { readonly name?: string; readonly owner?: { readonly login?: string } }
}

/** Parses `gh issue view --json ...` or `gh pr view --json ...` into one shape. */
export function parseItem(kind: Item["kind"], repo: string, output: string): Item {
  // SAFETY: gh returns the fields requested with --json; optional ones are read defensively below.
  const item = JSON.parse(output) as GhItem
  return {
    kind,
    repo,
    number: item.number,
    title: item.title,
    state: item.state === "MERGED" ? "MERGED" : item.state === "CLOSED" ? "CLOSED" : "OPEN",
    draft: item.isDraft === true,
    url: item.url,
    author: item.author?.login ?? "",
    body: item.body ?? "",
    labels: labels(item.labels),
    assignees: logins(item.assignees),
    milestone: item.milestone?.title ?? null,
    created: item.createdAt,
    updated: item.updatedAt,
    comments: (item.comments ?? []).map((comment) => ({
      author: comment.author?.login ?? "",
      body: comment.body,
      created: comment.createdAt,
    })),
    pr:
      kind === "pr"
        ? {
            head: item.headRefName ?? "",
            sha: item.headRefOid ?? "",
            requested: (item.reviewRequests ?? []).flatMap((request) => {
              const name = request.login ?? request.slug ?? request.name
              return name ? [name] : []
            }),
            base: item.baseRefName ?? "",
            cross: item.isCrossRepository === true,
            additions: item.additions ?? 0,
            deletions: item.deletions ?? 0,
            files: item.changedFiles ?? 0,
            review: item.reviewDecision || null,
            mergeable: item.mergeable ?? "UNKNOWN",
            checks: (item.statusCheckRollup ?? []).map(checkOf),
          }
        : null,
    links: (item.closedByPullRequestsReferences ?? item.closingIssuesReferences ?? []).flatMap((reference) => {
      const owner = reference.repository?.owner?.login
      const name = reference.repository?.name
      return reference.number ? [{ repo: owner && name ? `${owner}/${name}` : repo, number: reference.number }] : []
    }),
  }
}

function checkOf(check: GhCheck): Check {
  const raw = check.__typename === "StatusContext" ? (check.state ?? "") : check.status && check.status !== "COMPLETED" ? "PENDING" : (check.conclusion ?? "")
  const state: Check["state"] = ["SUCCESS", "NEUTRAL"].includes(raw)
    ? "success"
    : ["SKIPPED", "STALE"].includes(raw)
      ? "skipped"
      : ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(raw)
        ? "failure"
        : "pending"
  return { name: check.name ?? check.context ?? "check", state, url: check.detailsUrl ?? check.targetUrl ?? null }
}

/** Reads an issue or pull request from a github.com URL, such as a link the agent wrote. */
export function parseItemUrl(href: string): ItemRef | undefined {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/.exec(href)
  if (!match?.[1] || !match[2] || !match[3]) return undefined
  return { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) }
}

/** What a github.com link points at that the panel can show itself. */
export type GitHubLink =
  | { readonly kind: "item"; readonly ref: ItemRef; readonly files: boolean }
  | { readonly kind: "commit"; readonly repo: string; readonly sha: string }
  | { readonly kind: "run"; readonly repo: string; readonly id: number; readonly job: number | null }

export function parseGitHubLink(href: string): GitHubLink | undefined {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(.+)$/.exec(href)
  if (!match?.[1] || !match[2] || !match[3]) return undefined
  const repo = `${match[1]}/${match[2]}`
  const rest = match[3].split(/[?#]/)[0] ?? ""
  const commit = /^(?:pull\/\d+\/commits|commit)\/([0-9a-f]{7,40})/.exec(rest)
  if (commit?.[1]) return { kind: "commit", repo, sha: commit[1] }
  const run = /^actions\/runs\/(\d+)(?:\/(?:job|jobs)\/(\d+))?/.exec(rest)
  if (run?.[1]) return { kind: "run", repo, id: Number(run[1]), job: run[2] ? Number(run[2]) : null }
  const item = /^(?:issues|pull)\/(\d+)(\/files)?/.exec(rest)
  if (item?.[1]) return { kind: "item", ref: { repo, number: Number(item[1]) }, files: !!item[2] }
  return undefined
}

/** A branch name for an issue, like `123-fix-the-thing`: its number and the first six words of its title. */
export function issueBranchName(number: number, title: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-")
  return slug ? `${number}-${slug}` : String(number)
}

/** The issue a branch is named after: `123-fix-x`, `feat/123-x`, `issue-123`, `fix-123`, `fix/123`, `gh-123`. */
export function issueFromBranch(branch: string): number | undefined {
  const name = branch.slice(branch.lastIndexOf("/") + 1)
  const match = /^(\d{1,7})(?:[-_]|$)/.exec(name) ?? /(?:^|[-_])(?:issues?|fix|gh)[-_]?(\d{1,7})(?:[-_]|$)/i.exec(name)
  const number = Number(match?.[1])
  return number > 0 ? number : undefined
}

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(?:([\w.-]+\/[\w.-]+)?#(\d{1,7})\b|https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d{1,7})\b)/gi

/** The issues a pull request body closes with GitHub's keywords ("Fixes #12", "closes owner/repo#3"), outside HTML comments. */
export function closingRefs(body: string): { repo: string | undefined; number: number }[] {
  return [...body.replace(/<!--[\s\S]*?-->/g, "").matchAll(CLOSING)].map((match) => ({
    repo: match[1] ?? match[3],
    number: Number(match[2] ?? match[4]),
  }))
}

const PLACEHOLDER = /\b((?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s*)#(?![\w#])/i

/**
 * A pull request body that closes the issue: as it is when it already does; else a template's empty "Closes #" line
 * takes the number, or "Fixes #N" goes at the end.
 */
export function withClosing(body: string, number: number) {
  if (closingRefs(body).some((ref) => !ref.repo && ref.number === number)) return body
  // Odd parts are HTML comments, where a template explains itself.
  const parts = body.split(/(<!--[\s\S]*?-->)/)
  const at = parts.findIndex((part, index) => index % 2 === 0 && PLACEHOLDER.test(part))
  if (at !== -1) return parts.map((part, index) => (index === at ? part.replace(PLACEHOLDER, `$1#${number}`) : part)).join("")
  const trimmed = body.trimEnd()
  return trimmed ? `${trimmed}\n\nFixes #${number}` : `Fixes #${number}`
}

/** `#123` or `owner/repo#123`, not inside a word, a path or an HTML entity such as `&#123;`. */
export const REF_PATTERN = /(?<![\w/#&.-])(?:([\w.-]+\/[\w.-]+))?#(\d{1,7})\b/g

/** The references in a piece of text, with their offsets. A reference without a repository has `repo` undefined. */
export function findRefs(text: string) {
  return [...text.matchAll(REF_PATTERN)].map((match) => ({
    index: match.index,
    length: match[0].length,
    repo: match[1],
    number: Number(match[2]),
  }))
}

export interface DiffLine {
  readonly kind: "context" | "add" | "del" | "hunk"
  readonly text: string
  /** Line number in the old file, for context and deleted lines. */
  readonly old: number | null
  /** Line number in the new file, for context and added lines. */
  readonly new: number | null
}

/** Splits a unified diff patch into lines with their old and new line numbers. */
export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = []
  const at = { old: 0, new: 0 }
  patch.split("\n").forEach((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      at.old = Number(hunk[1])
      at.new = Number(hunk[2])
      lines.push({ kind: "hunk", text, old: null, new: null })
      return
    }
    // A context line always starts with a space; an empty string is the end of a patch that ends with a newline.
    if (text.startsWith("\\") || text === "") return
    if (text.startsWith("+")) {
      lines.push({ kind: "add", text: text.slice(1), old: null, new: at.new++ })
      return
    }
    if (text.startsWith("-")) {
      lines.push({ kind: "del", text: text.slice(1), old: at.old++, new: null })
      return
    }
    if (lines.length === 0) return
    lines.push({ kind: "context", text: text.slice(1), old: at.old++, new: at.new++ })
  })
  return lines
}
