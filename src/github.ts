import type { ChangedFile, Inbox, InboxEntry, Job, RemoteCommit, RepoMeta, Reviews, Run, RunDetails, SearchItem, SearchPage } from "./schemas"
import { stateReason } from "./git"

type ItemState = { state: "OPEN" | "CLOSED" | "MERGED"; reason?: "completed" | "not_planned" | "duplicate" }

const META_TTL = 5 * 60_000
const INBOX_TTL = 60_000
const RUNS_TTL = 15_000
const LOG_LIMIT = 400_000

const SEARCH_QUERY = `query($q:String!,$after:String,$first:Int!){search(query:$q,type:ISSUE,first:$first,after:$after){issueCount pageInfo{hasNextPage endCursor}
  nodes{__typename
    ... on Issue{number title state stateReason url createdAt updatedAt author{login} comments{totalCount} labels(first:6){nodes{name color}} repository{nameWithOwner}}
    ... on PullRequest{number title state isDraft url createdAt updatedAt author{login} comments{totalCount} labels(first:6){nodes{name color}} repository{nameWithOwner}
      headRefName baseRefName reviewDecision}}}}`

const ITEM_INFO = `__typename
  ... on Issue{title state stateReason labels(first:100){nodes{name}} assignees(first:100){nodes{login}}}
  ... on PullRequest{title state labels(first:100){nodes{name}} assignees(first:100){nodes{login}}}`

const REVIEWS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  viewerDidAuthor
  reviews(first:100){nodes{id author{login} state body submittedAt}}
  reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine diffSide
    comments(first:100){nodes{id author{login} body createdAt diffHunk}}}}}}}`

interface Deps {
  /** Runs gh with --repo style arguments; it never reads the repository in the directory. */
  gh(args: readonly string[]): Promise<string>
  /** Runs gh with `input` on its standard input, for request bodies that are more than flat fields. */
  ghInput(args: readonly string[], input: string): Promise<string>
  /** An issue or pull request changed: drop caches and tell windows, with its new state when known. */
  changed(repo: string, number: number, state?: ItemState): void
  runChanged(repo: string, id: number): void
  inboxChanged(): void
}

/** The GitHub-only methods of the Git Ipc: reviews, files, CI, metadata and the inbox. */
export function createGitHub(deps: Deps) {
  const gh = deps.gh
  const meta = new Map<string, { time: number; value: Promise<RepoMeta> }>()
  // Values that only change through this plugin's own writes, or never: kept until `forget` drops them.
  const reviews = new Map<string, { time: number; value: Promise<Reviews> }>()
  const prFiles = new Map<string, Promise<ChangedFile[]>>()
  const commits = new Map<string, Promise<RemoteCommit>>()
  const finished = new Map<string, Promise<RunDetails>>()
  const logs = new Map<string, Promise<string>>()
  const runs = new Map<string, { time: number; value: Promise<Run[]> }>()
  const inbox: { cached?: { time: number; value: Promise<Inbox> } } = {}
  const viewer: { value?: Promise<string> } = {}

  const change = async <T>(repo: string, number: number, work: () => Promise<T>, state?: ItemState) => {
    const outcome = await work().then(
      (value) => ({ value, ok: true as const }),
      (error: unknown) => ({ error, ok: false as const }),
    )
    forget(repo, number)
    deps.changed(repo, number, outcome.ok ? state : undefined)
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }

  /** Drops what this backend cached about one issue or pull request. */
  const forget = (repo: string, number: number) => {
    reviews.delete(`${repo}#${number}`)
    ;[...prFiles.keys()].filter((key) => key.startsWith(`${repo}#${number}@`)).forEach((key) => prFiles.delete(key))
  }

  /** Keeps a promise in a map, and drops it again if it fails so the next call retries. */
  const keep = <T>(map: Map<string, Promise<T>>, key: string, make: () => Promise<T>, size = 100) => {
    const known = map.get(key)
    if (known) return known
    const value = make()
    remember(map, key, value, size)
    value.catch(() => {
      if (map.get(key) === value) map.delete(key)
    })
    return value
  }

  const files = async (repo: string, path: string, list = ".[]") => {
    const output = await gh([
      "api",
      "--paginate",
      apiPath(repo, path),
      "--jq",
      `${list} | {path: .filename, previous: .previous_filename, status, additions, deletions, patch}`,
    ])
    return lines(output).map(
      (line): ChangedFile => {
        // SAFETY: the jq filter above builds exactly these fields.
        const file = JSON.parse(line) as { path: string; previous?: string | null; status: string; additions: number; deletions: number; patch?: string | null }
        return { ...file, previous: file.previous ?? null, patch: file.patch ?? null }
      },
    )
  }

  const graphql = (query: string, variables: Record<string, string | number>) =>
    gh([
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      ...Object.entries(variables).flatMap(([key, value]) => [typeof value === "number" ? "-F" : "-f", `${key}=${value}`]),
    ])

  const readInbox = async (): Promise<Inbox> => {
    const search = (args: readonly string[], kind: "issue" | "pr", reason: string) =>
      gh(["search", kind === "pr" ? "prs" : "issues", ...args, "--state", "open", "--limit", "30", "--json", "number,title,repository,url,updatedAt"]).then(
        (output) => {
          // SAFETY: gh returns the fields requested with --json.
          const items = JSON.parse(output || "[]") as { number: number; title: string; repository: { nameWithOwner: string }; url: string; updatedAt: string }[]
          return items.map(
            (item): InboxEntry => ({
              thread: null,
              repo: item.repository.nameWithOwner,
              number: item.number,
              kind,
              title: item.title,
              reason,
              updated: item.updatedAt,
              unread: false,
              url: item.url,
            }),
          )
        },
      )
    const results = await Promise.allSettled([
      gh(["api", "notifications?per_page=50"]).then(parseNotifications),
      search(["--review-requested=@me"], "pr", "review_requested"),
      search(["--assignee=@me"], "issue", "assign"),
      search(["--author=@me"], "pr", "author"),
    ])
    const [notifications, reviews, assigned, authored] = results.map((result) => (result.status === "fulfilled" ? result.value : []))
    const failure = results.find((result) => result.status === "rejected")
    return {
      error: failure && results.every((result) => result.status === "rejected") ? message(failure.reason) : null,
      notifications: notifications ?? [],
      reviews: reviews ?? [],
      assigned: assigned ?? [],
      authored: authored ?? [],
    }
  }

  const readReviews = async ({ repo, number }: { repo: string; number: number }): Promise<Reviews> => {
      const [owner, name] = repo.split("/")
      const output = await graphql(REVIEWS_QUERY, { owner: owner ?? "", name: name ?? "", number })
      // SAFETY: the query above selects exactly these fields.
      const pr = (JSON.parse(output) as { data: { repository: { pullRequest: GqlPull | null } | null } }).data.repository?.pullRequest
      if (!pr) throw new Error(`${repo}#${number} is not a pull request.`)
      return {
        mine: pr.viewerDidAuthor,
        reviews: pr.reviews.nodes.map((review) => ({
          id: review.id,
          author: review.author?.login ?? "ghost",
          state: review.state,
          body: review.body,
          submitted: review.submittedAt,
        })),
        threads: pr.reviewThreads.nodes.map((thread) => ({
          id: thread.id,
          resolved: thread.isResolved,
          outdated: thread.isOutdated,
          path: thread.path,
          line: thread.line ?? thread.originalLine,
          side: thread.diffSide,
          comments: thread.comments.nodes.map((comment) => ({
            id: comment.id,
            author: comment.author?.login ?? "ghost",
            body: comment.body,
            created: comment.createdAt,
            hunk: comment.diffHunk,
          })),
        })),
      }
  }

  const searchPage = async (q: string, cursor: string | null, first: number): Promise<SearchPage> => {
    const output = await graphql(SEARCH_QUERY, { q, first, ...(cursor ? { after: cursor } : {}) })
    // SAFETY: the query above selects exactly these fields.
    const data = (JSON.parse(output) as { data: { search: GqlSearch } }).data.search
    return {
      total: data.issueCount,
      cursor: data.pageInfo.hasNextPage ? data.pageInfo.endCursor : null,
      items: data.nodes.flatMap((node): SearchItem[] => {
        // A result the token cannot read, such as one behind SAML, comes back as null.
        if (!node || (node.__typename !== "Issue" && node.__typename !== "PullRequest")) return []
        const pr = node.__typename === "PullRequest"
        return [
          {
            kind: pr ? "pr" : "issue",
            repo: node.repository.nameWithOwner,
            number: node.number,
            title: node.title,
            state: node.state === "MERGED" ? "MERGED" : node.state === "CLOSED" ? "CLOSED" : "OPEN",
            ...(!pr && node.state === "CLOSED" ? { reason: stateReason(node.stateReason) } : {}),
            draft: node.isDraft === true,
            url: node.url,
            author: node.author?.login ?? "ghost",
            labels: (node.labels?.nodes ?? []).map((label) => ({ name: label.name, color: label.color })),
            comments: node.comments.totalCount,
            created: node.createdAt,
            updated: node.updatedAt,
            head: node.headRefName ?? null,
            base: node.baseRefName ?? null,
            review: node.reviewDecision ?? null,
            checks: "none",
          },
        ]
      }),
    }
  }

  return {
    // A pull request's files only change with a new head commit; the window passes the head it shows. Without one
    // there is nothing to tell a stale list by.
    prFiles: ({ repo, number, head }: { repo: string; number: number; head?: string }) =>
      head
        ? keep(prFiles, `${repo}#${number}@${head}`, () => files(repo, `pulls/${number}/files?per_page=100`), 50)
        : files(repo, `pulls/${number}/files?per_page=100`),

    reviews: (input: { repo: string; number: number }) => {
      const key = `${input.repo}#${input.number}`
      const cached = reviews.get(key)
      if (cached && Date.now() - cached.time < 20_000) return cached.value
      const value = readReviews(input)
      remember(reviews, key, { time: Date.now(), value }, 100)
      value.catch(() => {
        if (reviews.get(key)?.value === value) reviews.delete(key)
      })
      return value
    },

    // Check state is the slow part of a pull request search on a busy repository, so the window asks for it separately,
    // for the rows it shows.
    prChecks: async ({ repo, numbers }: { repo: string; numbers: readonly number[] }) => {
      // Numbers go into the query text, so only positive integers; an issue number answers with no commits.
      const wanted = [...new Set(numbers)].filter((number) => Number.isSafeInteger(number) && number > 0).slice(0, 50)
      if (wanted.length === 0) return []
      const [owner, name] = repo.split("/")
      const fields = wanted
        .map((number) => `p${number}:issueOrPullRequest(number:${number}){... on PullRequest{commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}`)
        .join(" ")
      const output = await graphql(`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields}}}`, { owner: owner ?? "", name: name ?? "" })
      // SAFETY: the query above selects these fields under one alias per number.
      const data = (JSON.parse(output) as { data: { repository: Record<string, { commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] } } | null> } }).data.repository
      return Object.entries(data).map(([alias, pr]) => {
        const state = pr?.commits?.nodes[0]?.commit.statusCheckRollup?.state
        return {
          number: Number(alias.slice(1)),
          checks: !state ? ("none" as const) : state === "SUCCESS" ? ("success" as const) : state === "PENDING" || state === "EXPECTED" ? ("pending" as const) : ("failure" as const),
        }
      })
    },

    search: async ({ repo, kind, query, cursor }: { repo: string; kind: "issue" | "pr"; query: string; cursor: string | null }): Promise<SearchPage> => {
      // Newest first, as GitHub's own lists: an old issue with a fresh comment does not jump to the top.
      const sort = /(^|\s)sort:/.test(query) ? "" : " sort:created-desc"
      return searchPage(`repo:${repo} is:${kind} ${query}${sort}`.trim(), cursor, 30)
    },

    /** Issues and pull requests together, for the agent's search tool. */
    searchAny: async ({ repo, query, cursor, limit }: { repo: string; query: string; cursor: string | null; limit: number }) => {
      const sort = /(^|\s)sort:/.test(query) ? "" : " sort:created-desc"
      return searchPage(`repo:${repo} ${query}${sort}`.trim(), cursor, Math.min(100, Math.max(1, Math.floor(limit) || 30)))
    },

    submitReview: ({ repo, number, event, body }: { repo: string; number: number; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string }) =>
      change(repo, number, () =>
        gh([
          "pr",
          "review",
          String(number),
          "--repo",
          repo,
          event === "APPROVE" ? "--approve" : event === "REQUEST_CHANGES" ? "--request-changes" : "--comment",
          ...(body ? ["--body", body] : []),
        ]),
      ),

    replyThread: ({ repo, number, thread, body }: { repo: string; number: number; thread: string; body: string }) =>
      change(repo, number, () =>
        graphql(
          "mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id}}}",
          { thread, body },
        ),
      ),

    resolveThread: ({ repo, number, thread, resolved }: { repo: string; number: number; thread: string; resolved: boolean }) =>
      change(repo, number, () =>
        graphql(
          resolved
            ? "mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id}}}"
            : "mutation($thread:ID!){unresolveReviewThread(input:{threadId:$thread}){thread{id}}}",
          { thread },
        ),
      ),

    lineComment: (input: { repo: string; number: number; sha: string; path: string; line: number; side: "LEFT" | "RIGHT"; body: string }) =>
      change(input.repo, input.number, async () =>
        gh([
          "api",
          apiPath(input.repo, `pulls/${input.number}/comments`),
          "-f",
          `body=${input.body}`,
          "-f",
          `commit_id=${input.sha}`,
          "-f",
          `path=${input.path}`,
          "-F",
          `line=${input.line}`,
          "-f",
          `side=${input.side}`,
        ]),
      ),

    /**
     * Submits a review with its inline comments in one GraphQL call; falls back to the REST endpoint. Returns the
     * review's URL.
     */
    createReview: (input: { repo: string; number: number; sha: string; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string; comments: readonly ReviewThread[] }) =>
      change(input.repo, input.number, async () => {
        const [owner, name] = apiPath(input.repo, "").split("/").slice(1, 3)
        const viaGraphql = async () => {
          const found = await graphql("query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id}}}", {
            owner: owner ?? "",
            name: name ?? "",
            number: input.number,
          })
          // SAFETY: the query above selects exactly this field.
          const id = (JSON.parse(found) as { data: { repository: { pullRequest: { id: string } | null } | null } }).data.repository?.pullRequest?.id
          if (!id) throw new Error(`${input.repo}#${input.number} is not a pull request.`)
          const threads = input.comments.map((comment) => ({
            path: comment.path,
            line: comment.line,
            side: comment.side,
            ...(comment.startLine !== null && comment.startLine !== comment.line ? { startLine: comment.startLine, startSide: comment.side } : {}),
            body: comment.body,
          }))
          const output = await deps.ghInput(
            ["api", "graphql", "--input", "-"],
            JSON.stringify({
              query:
                "mutation($input:AddPullRequestReviewInput!){addPullRequestReview(input:$input){pullRequestReview{url}}}",
              variables: { input: { pullRequestId: id, commitOID: input.sha, event: input.event, body: input.body, threads } },
            }),
          )
          // SAFETY: the mutation above selects exactly this field.
          return (JSON.parse(output) as { data: { addPullRequestReview: { pullRequestReview: { url: string } | null } | null } }).data.addPullRequestReview?.pullRequestReview?.url ?? ""
        }
        const viaRest = () =>
          deps
            .ghInput(
              ["api", "-X", "POST", apiPath(input.repo, `pulls/${input.number}/reviews`), "--input", "-", "--jq", ".html_url"],
              JSON.stringify({
                commit_id: input.sha,
                event: input.event,
                body: input.body,
                comments: input.comments.map((comment) => ({
                  path: comment.path,
                  line: comment.line,
                  side: comment.side,
                  ...(comment.startLine !== null && comment.startLine !== comment.line ? { start_line: comment.startLine, start_side: comment.side } : {}),
                  body: comment.body,
                })),
              }),
            )
            .then((output) => output.trim())
        return viaGraphql().catch(async (error: unknown) => {
          // A review GitHub rejected stays rejected; only a mutation an older GitHub does not know, or a server error, is
          // worth the REST retry.
          if (!/not defined by type|doesn't (exist|accept)|invalid value|unknown argument|HTTP 5\d\d/i.test(message(error))) throw error
          return viaRest().catch((rest: unknown) => Promise.reject(new Error(`${message(error)}\n(REST fallback: ${message(rest)})`)))
        })
      }),

    edit: (input: {
      repo: string
      number: number
      kind: "issue" | "pr"
      title?: string
      body?: string
      addLabels: readonly string[]
      removeLabels: readonly string[]
      addAssignees: readonly string[]
      removeAssignees: readonly string[]
      addReviewers: readonly string[]
      removeReviewers: readonly string[]
      milestone?: string | null
    }) => {
      const list = (flag: string, values: readonly string[]) => (values.length > 0 ? [flag, values.join(",")] : [])
      const args = [
        ...(input.title !== undefined ? ["--title", input.title] : []),
        ...(input.body !== undefined ? ["--body", input.body] : []),
        ...list("--add-label", input.addLabels),
        ...list("--remove-label", input.removeLabels),
        ...list("--add-assignee", input.addAssignees),
        ...list("--remove-assignee", input.removeAssignees),
        ...(input.kind === "pr" ? [...list("--add-reviewer", input.addReviewers), ...list("--remove-reviewer", input.removeReviewers)] : []),
        ...(input.milestone === null ? ["--remove-milestone"] : input.milestone !== undefined ? ["--milestone", input.milestone] : []),
      ]
      if (args.length === 0) return Promise.resolve("")
      return change(input.repo, input.number, () => gh([input.kind, "edit", String(input.number), "--repo", input.repo, ...args]))
    },

    setDraft: ({ repo, number, draft }: { repo: string; number: number; draft: boolean }) =>
      change(repo, number, () => gh(["pr", "ready", String(number), "--repo", repo, ...(draft ? ["--undo"] : [])])),

    repoMeta: async ({ repo }: { repo: string }) => {
      const cached = meta.get(repo)
      if (cached && Date.now() - cached.time < META_TTL) return cached.value
      const failed = { any: false }
      const fallback = () => {
        failed.any = true
        return []
      }
      const value = Promise.all([
        gh(["label", "list", "--repo", repo, "--limit", "200", "--json", "name,color"]).then(
          // SAFETY: gh returns the fields requested with --json.
          (output) => (JSON.parse(output || "[]") as { name: string; color: string }[]).map((label) => ({ name: label.name, color: label.color })),
          fallback,
        ),
        gh(["api", "--paginate", apiPath(repo, "assignees?per_page=100"), "--jq", ".[].login"]).then(lines, fallback),
        gh(["api", apiPath(repo, "milestones?state=open&per_page=100"), "--jq", ".[].title"]).then(lines, fallback),
      ]).then(([labels, people, milestones]) => ({ labels, people, milestones }))
      remember(meta, repo, { time: Date.now(), value }, 20)
      // A partial answer still fills the editor, but the next open asks again.
      void value.then(() => {
        if (failed.any && meta.get(repo)?.value === value) meta.delete(repo)
      })
      return value
    },

    commit: ({ repo, sha }: { repo: string; sha: string }) => keep(commits, `${repo}@${sha}`, async () => {
      const [info, changed] = await Promise.all([
        gh(["api", apiPath(repo, `commits/${sha}`), "--jq", "{sha, url: .html_url, message: .commit.message, author: .commit.author.name, date: .commit.author.date, parents: [.parents[].sha]}"]),
        files(repo, `commits/${sha}?per_page=100`, ".files[]").catch(() => []),
      ])
      // SAFETY: the jq filter above builds exactly these fields.
      const parsed = JSON.parse(info) as { sha: string; url: string; message: string; author: string; date: string; parents: string[] }
      return { repo, ...parsed, files: changed }
    }),

    runs: ({ repo, branch, fresh }: { repo: string; branch: string | null; fresh: boolean }) => {
      const key = `${repo}\n${branch ?? ""}`
      const cached = runs.get(key)
      if (!fresh && cached && Date.now() - cached.time < RUNS_TTL) return cached.value
      const value = gh([
        "run",
        "list",
        "--repo",
        repo,
        ...(branch ? ["--branch", branch] : []),
        "--limit",
        "30",
        "--json",
        "databaseId,displayTitle,workflowName,status,conclusion,event,headBranch,headSha,createdAt,url,attempt",
      ]).then((output) => (JSON.parse(output || "[]") as GhRun[]).map(runOf))
      remember(runs, key, { time: Date.now(), value }, 50)
      value.catch(() => {
        if (runs.get(key)?.value === value) runs.delete(key)
      })
      return value
    },

    run: async ({ repo, id }: { repo: string; id: number }): Promise<RunDetails> => {
      // A finished run never changes until someone re-runs it, which drops it below.
      const done = finished.get(`${repo}#${id}`)
      if (done) return done
      const output = await gh([
        "run",
        "view",
        String(id),
        "--repo",
        repo,
        "--json",
        "databaseId,displayTitle,workflowName,status,conclusion,event,headBranch,headSha,createdAt,url,attempt,jobs",
      ])
      // SAFETY: gh returns the fields requested with --json.
      const parsed = JSON.parse(output) as GhRun & { jobs: GhJob[] }
      const details: RunDetails = {
        run: runOf(parsed),
        jobs: parsed.jobs.map(
          (job): Job => ({
            id: job.databaseId,
            name: job.name,
            status: job.status,
            conclusion: job.conclusion ?? "",
            started: job.startedAt || null,
            completed: job.completedAt || null,
            steps: (job.steps ?? []).map((step) => ({ number: step.number, name: step.name, status: step.status, conclusion: step.conclusion ?? "" })),
          }),
        ),
      }
      if (details.run.status === "completed") remember(finished, `${repo}#${id}`, Promise.resolve(details), 100)
      return details
    },

    jobLog: async ({ repo, job }: { repo: string; job: number }) => {
      const known = logs.get(`${repo}#${job}`)
      if (known) return known
      const raw = await gh(["api", apiPath(repo, `actions/jobs/${job}/logs`)])
      // Drop the runner's timestamps and color codes; keep its ##[group] and ##[error] markers for the viewer.
      const output = raw
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n")
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
        .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/gm, "")
      // Logs can run to megabytes; the end holds the failure.
      const text = output.length > LOG_LIMIT ? `… (${Math.round((output.length - LOG_LIMIT) / 1024)} KB earlier output omitted)\n${output.slice(-LOG_LIMIT)}` : output
      // A finished job's log ends with the runner's cleanup; only then is it final.
      if (/Cleaning up orphan processes|Job completed|Evaluate and set job outputs/.test(text.slice(-4000))) remember(logs, `${repo}#${job}`, Promise.resolve(text), 20)
      return text
    },

    rerun: async ({ repo, id, failed }: { repo: string; id: number; failed: boolean }) => {
      finished.delete(`${repo}#${id}`)
      try {
        return await gh(["run", "rerun", String(id), "--repo", repo, ...(failed ? ["--failed"] : [])])
      } finally {
        runs.clear()
        deps.runChanged(repo, id)
      }
    },

    cancelRun: async ({ repo, id }: { repo: string; id: number }) => {
      try {
        return await gh(["run", "cancel", String(id), "--repo", repo])
      } finally {
        runs.clear()
        deps.runChanged(repo, id)
      }
    },

    inbox: ({ fresh }: { fresh: boolean }) => {
      if (!fresh && inbox.cached && Date.now() - inbox.cached.time < INBOX_TTL) return inbox.cached.value
      const value = readInbox()
      inbox.cached = { time: Date.now(), value }
      return value
    },

    markRead: async ({ thread }: { thread: string | null }) => {
      try {
        return await gh(thread ? ["api", "-X", "PATCH", `notifications/threads/${thread}`] : ["api", "-X", "PUT", "notifications", "-F", "read=true"])
      } finally {
        inbox.cached = undefined
        deps.inboxChanged()
      }
    },

    /** Each number's kind, title, state, labels and assignees; numbers that do not exist are left out. */
    itemsInfo: async (repo: string, numbers: readonly number[]): Promise<Map<number, ItemInfo>> => {
      const [owner, name] = apiPath(repo, "").split("/").slice(1, 3)
      const wanted = [...new Set(numbers)].filter((number) => Number.isSafeInteger(number) && number > 0)
      const read = async (list: readonly number[]): Promise<Map<number, ItemInfo>> => {
        if (list.length === 0) return new Map()
        const fields = list.map((number) => `n${number}:issueOrPullRequest(number:${number}){${ITEM_INFO}}`).join(" ")
        const output = await graphql(`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields}}}`, { owner: owner ?? "", name: name ?? "" }).catch(
          (error: unknown) => {
            // One missing number fails the whole query; ask again without the ones GitHub named.
            const missing = [...message(error).matchAll(/repository\.n(\d+)|with the number of (\d+)/g)].map((match) => Number(match[1] ?? match[2]))
            if (missing.length === 0) throw error
            return read(list.filter((number) => !missing.includes(number)))
          },
        )
        if (output instanceof Map) return output
        // SAFETY: the query above selects ITEM_INFO under one alias per number.
        const data = (JSON.parse(output) as { data: { repository: Record<string, GqlItemInfo | null> | null } }).data.repository ?? {}
        return new Map(
          Object.entries(data).flatMap(([alias, node]): [number, ItemInfo][] =>
            node && (node.__typename === "Issue" || node.__typename === "PullRequest")
              ? [
                  [
                    Number(alias.slice(1)),
                    {
                      item: node.__typename === "PullRequest" ? "pr" : "issue",
                      title: node.title,
                      state: node.state === "MERGED" ? "MERGED" : node.state === "CLOSED" ? "CLOSED" : "OPEN",
                      reason: node.stateReason === "NOT_PLANNED" ? "not_planned" : node.stateReason === "DUPLICATE" ? "duplicate" : node.stateReason === "COMPLETED" ? "completed" : null,
                      labels: node.labels.nodes.map((label) => label.name),
                      assignees: node.assignees.nodes.map((user) => user.login),
                    },
                  ],
                ]
              : [],
          ),
        )
      }
      return read(wanted)
    },

    /** Posts a comment and returns its id, so it can be deleted again. */
    addComment: (repo: string, number: number, body: string) =>
      change(repo, number, async () => {
        const output = await gh(["api", "-X", "POST", apiPath(repo, `issues/${number}/comments`), "-f", `body=${body}`, "--jq", "{id: .id, url: .html_url}"])
        // SAFETY: the jq filter above builds exactly these fields.
        return JSON.parse(output) as { id: number; url: string }
      }),

    deleteComment: (repo: string, number: number, id: number) =>
      change(repo, number, () => gh(["api", "-X", "DELETE", apiPath(repo, `issues/comments/${id}`)])),

    /** Closes an issue with a reason, or a pull request; returns the comment it had to post for an older gh's duplicate. */
    closeItem: (repo: string, number: number, item: "issue" | "pr", reason: "completed" | "not_planned" | "duplicate", duplicateOf?: number) =>
      change(repo, number, async (): Promise<{ commentId?: number; url?: string }> => {
        if (item === "pr") return gh(["pr", "close", String(number), "--repo", repo]).then(() => ({}))
        const close = (why: "completed" | "not_planned") => gh(["issue", "close", String(number), "--repo", repo, "--reason", why === "not_planned" ? "not planned" : "completed"]).then(() => ({}))
        if (reason !== "duplicate" || !duplicateOf) return close(reason === "not_planned" ? "not_planned" : "completed")
        return gh(["issue", "close", String(number), "--repo", repo, "--duplicate-of", String(duplicateOf)]).then(
          () => ({}),
          async (error: unknown) => {
            if (!/unknown flag/i.test(message(error))) throw error
            // gh before --duplicate-of: GitHub reads "Duplicate of #N" as marking the duplicate.
            const output = await gh(["api", "-X", "POST", apiPath(repo, `issues/${number}/comments`), "-f", `body=Duplicate of #${duplicateOf}`, "--jq", "{id: .id, url: .html_url}"])
            await close("not_planned")
            // SAFETY: the jq filter above builds exactly these fields.
            const created = JSON.parse(output) as { id: number; url: string }
            return { commentId: created.id, url: created.url }
          },
        )
      }, item === "pr" ? { state: "CLOSED" } : { state: "CLOSED", reason: reason === "duplicate" && !duplicateOf ? "completed" : reason }),

    reopenItem: (repo: string, number: number, item: "issue" | "pr") =>
      change(repo, number, () => gh([item, "reopen", String(number), "--repo", repo]), { state: "OPEN" }),

    /** Adds and removes labels or assignees through the issues API, which covers pull requests too. */
    editPeople: (repo: string, number: number, kind: "labels" | "assignees", add: readonly string[], remove: readonly string[]) =>
      change(repo, number, async () => {
        const path = apiPath(repo, `issues/${number}/${kind}`)
        const fields = (names: readonly string[]) => names.flatMap((value) => ["-f", `${kind}[]=${value}`])
        if (add.length > 0) await gh(["api", "-X", "POST", path, ...fields(add)])
        if (remove.length === 0) return
        if (kind === "assignees") return void (await gh(["api", "-X", "DELETE", path, ...fields(remove)]))
        for (const label of remove) await gh(["api", "-X", "DELETE", `${path}/${encodeURIComponent(label)}`])
      }),

    /** The signed-in user's login, for `@me`. */
    viewer: () => {
      viewer.value ??= gh(["api", "user", "--jq", ".login"]).then((output) => output.trim())
      viewer.value.catch(() => (viewer.value = undefined))
      return viewer.value
    },

    /** Drops cached CI runs, for example after a push starts new ones. */
    forgetRuns: () => runs.clear(),
    forgetInbox: () => {
      inbox.cached = undefined
    },
  }
}

/** An inline comment of a review being submitted. */
export interface ReviewThread {
  readonly path: string
  readonly line: number
  readonly side: "LEFT" | "RIGHT"
  readonly startLine: number | null
  readonly body: string
}

/** What the agent's actions need to know about an issue or pull request before and while changing it. */
export interface ItemInfo {
  readonly item: "issue" | "pr"
  readonly title: string
  readonly state: "OPEN" | "CLOSED" | "MERGED"
  readonly reason: "completed" | "not_planned" | "duplicate" | null
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
}

interface GqlItemInfo {
  __typename: string
  title: string
  state: string
  stateReason?: string | null
  labels: { nodes: { name: string }[] }
  assignees: { nodes: { login: string }[] }
}

interface GqlSearch {
  issueCount: number
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: ({
    __typename: string
    number: number
    title: string
    state: string
    stateReason?: string | null
    isDraft?: boolean
    url: string
    createdAt: string
    updatedAt: string
    author: { login: string } | null
    comments: { totalCount: number }
    labels: { nodes: { name: string; color: string }[] } | null
    repository: { nameWithOwner: string }
    headRefName?: string
    baseRefName?: string
    reviewDecision?: string | null
  } | null)[]
}

interface GqlPull {
  viewerDidAuthor: boolean
  reviews: { nodes: { id: string; author: { login: string } | null; state: string; body: string; submittedAt: string | null }[] }
  reviewThreads: {
    nodes: {
      id: string
      isResolved: boolean
      isOutdated: boolean
      path: string
      line: number | null
      originalLine: number | null
      diffSide: string
      comments: { nodes: { id: string; author: { login: string } | null; body: string; createdAt: string; diffHunk: string }[] }
    }[]
  }
}

interface GhRun {
  databaseId: number
  displayTitle: string
  workflowName: string
  status: string
  conclusion?: string
  event: string
  headBranch: string
  headSha: string
  createdAt: string
  url: string
  attempt?: number
}

interface GhJob {
  databaseId: number
  name: string
  status: string
  conclusion?: string
  startedAt?: string
  completedAt?: string
  steps?: { number: number; name: string; status: string; conclusion?: string }[]
}

function runOf(run: GhRun): Run {
  return {
    id: run.databaseId,
    title: run.displayTitle,
    workflow: run.workflowName,
    status: run.status,
    conclusion: run.conclusion ?? "",
    branch: run.headBranch,
    event: run.event,
    sha: run.headSha,
    created: run.createdAt,
    url: run.url,
    attempt: run.attempt ?? 1,
  }
}

interface GhNotification {
  id: string
  unread: boolean
  reason: string
  updated_at: string
  subject: { title: string; url: string | null; type: string }
  repository: { full_name: string; html_url: string }
}

function parseNotifications(output: string): InboxEntry[] {
  // SAFETY: the notifications REST API returns these fields.
  const list = JSON.parse(output || "[]") as GhNotification[]
  return list.map((item) => {
    const number = /\/(?:issues|pulls)\/(\d+)$/.exec(item.subject.url ?? "")?.[1]
    const kind = item.subject.type === "PullRequest" ? "pr" : item.subject.type === "Issue" ? "issue" : "other"
    return {
      thread: item.id,
      repo: item.repository.full_name,
      number: number ? Number(number) : null,
      kind,
      title: item.subject.title,
      reason: item.reason,
      updated: item.updated_at,
      unread: item.unread,
      url: number ? `${item.repository.html_url}/${kind === "pr" ? "pull" : "issues"}/${number}` : item.repository.html_url,
    }
  })
}

function lines(output: string) {
  return output.split(/\r?\n/).filter(Boolean)
}

/** A REST path under a repository; the name comes from links and the window, so it must not climb out of `repos/`. */
export function apiPath(repo: string, path: string) {
  const [owner, name, ...rest] = repo.split("/")
  const part = (value: string | undefined) => !!value && /^[\w.-]+$/.test(value) && value !== "." && value !== ".."
  if (rest.length > 0 || !part(owner) || !part(name)) throw new Error(`"${repo}" is not a GitHub repository name.`)
  return `repos/${repo}/${path}`
}

/** Sets a cache entry as the newest one and drops the oldest beyond `size`, so long-running servers do not grow. */
export function remember<K, V>(map: Map<K, V>, key: K, value: V, size: number) {
  map.delete(key)
  map.set(key, value)
  ;[...map.keys()].slice(0, Math.max(0, map.size - size)).forEach((old) => map.delete(old))
}

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}
