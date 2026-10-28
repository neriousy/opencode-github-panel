import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, delimiter, join } from "node:path"
import type { events, Issues, Item, methods, Overview, PullRequest, Pulls } from "./schemas"
import { apiPath, createGitHub, remember } from "./github"
import { BRANCH_FORMAT, LOG_FORMAT, parseBranches, parseIssues, parseItem, parseLog, parseRemote, parseStatus, FIELD } from "./git"

const ISSUE_FIELDS = "number,title,state,url,author,labels,assignees,updatedAt"
const ITEM_FIELDS = "number,title,state,url,author,labels,assignees,updatedAt,createdAt,body,comments,milestone"
const PR_FIELDS = `${ITEM_FIELDS},isDraft,headRefName,baseRefName,isCrossRepository,additions,deletions,changedFiles,reviewDecision,mergeable,statusCheckRollup,headRefOid,reviewRequests`
const PULL_TTL = 60_000
// Which pull request a branch had changes rarely, and the branch picker asks for every local branch at once.
const HEADS_TTL = 5 * 60_000
// A network command that takes longer than this is stuck, and it holds the repository's write queue meanwhile.
const TIMEOUT = 5 * 60_000
const MAX_OUTPUT = 64 * 1024 * 1024
const GH_MISSING = "GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com."

type Methods = typeof methods
type Events = typeof events

/** What a caller can pass along with any method: the Ipc caller in main, the RPC context on a server. */
export interface Caller {
  readonly signal?: AbortSignal
}

export type Backend = {
  readonly [Name in keyof Methods]: (
    input: Methods[Name]["input"]["Type"],
    caller: Caller,
  ) => Promise<Methods[Name]["output"]["Type"]> | Methods[Name]["output"]["Type"]
}

export interface BackendDeps {
  log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void
  emit<Name extends keyof Events>(name: Name, data: Events[Name]["Type"]): void
}

/** What the server part's agent actions use besides the methods: the GitHub calls and the repository of a directory. */
export interface BackendKit {
  readonly github: ReturnType<typeof createGitHub>
  readonly repoOf: (cwd: string) => Promise<string | null>
  /** An issue or pull request changed outside the backend: drop its caches and tell windows. */
  readonly changed: (repo: string, number: number) => void
}

/**
 * Every git and gh operation, independent of where it runs: the desktop app's main process serves it over an Ipc for
 * local sessions, and the server part serves it over RPC on whichever machine hosts the repository.
 */
export function createBackend(deps: BackendDeps): { backend: Backend; kit: BackendKit } {
  const env = environment()
  // One mutation per repository at a time, so two clicks never race for index.lock.
  const queues = new Map<string, Promise<unknown>>()
  const pulls = new Map<string, { time: number; value: Promise<Pulls> }>()
  const issues = new Map<string, { time: number; value: Promise<Issues> }>()
  const items = new Map<string, { time: number; value: Promise<Item> }>()
  const heads = new Map<string, { time: number; value: Promise<PullRequest[]> }>()

  const run = (
    command: string,
    args: readonly string[],
    cwd: string,
    options: { signal?: AbortSignal; ok?: (code: number) => boolean; quiet?: boolean; env?: Record<string, string>; input?: string } = {},
  ) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: options.env ? { ...env, ...options.env } : env,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
        // Its own session on POSIX: with no controlling terminal, ssh and credential helpers fail instead of waiting
        // for an answer on the server's terminal, and the whole process group can be stopped at once.
        detached: process.platform !== "win32",
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const state = { size: 0, stopped: "", settled: false }
      const stop = (reason: string) => {
        if (state.stopped) return
        state.stopped = reason
        kill(child)
      }
      const signal = options.signal
      const timer = setTimeout(() => stop(`\`${command} ${args[0]}\` did not finish within ${TIMEOUT / 60_000} minutes.`), TIMEOUT)
      const abort = () => stop("Cancelled.")
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        state.size += chunk.length
        if (state.size > MAX_OUTPUT) return stop(`\`${command} ${args[0]}\` printed more than ${MAX_OUTPUT / 1024 / 1024} MB.`)
        into.push(chunk)
      }
      child.stdin?.on("error", () => undefined)
      child.stdin?.end(options.input)
      child.stdout?.on("data", collect(stdout))
      child.stderr?.on("data", collect(stderr))
      const finish = (code: number | null, error?: NodeJS.ErrnoException) => {
        if (state.settled) return
        state.settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        const out = Buffer.concat(stdout).toString("utf8")
        if (!error && !state.stopped && code !== null && (options.ok ?? ((code) => code === 0))(code)) return resolve(out)
        const output = Buffer.concat(stderr).toString("utf8").trim() || out.trim()
        const message =
          state.stopped ||
          (error ? spawnError(command, cwd, error) : "") ||
          (output.length > 4000 ? `${output.slice(0, 4000)}\n…` : output) ||
          `\`${command} ${args[0]}\` failed with exit code ${code}.`
        if (!signal?.aborted && !options.quiet) deps.log("warn", "github-panel command failed", { command, args, cwd, message })
        reject(new Error(message))
      }
      child.on("error", (error) => finish(null, error))
      child.on("close", (code) => finish(code))
    })

  const git = (cwd: string, args: readonly string[], signal?: AbortSignal) => run("git", args, cwd, { signal })
  const gh = (cwd: string, args: readonly string[], signal?: AbortSignal) => run("gh", args, cwd, { signal })
  // A question whose failure is an answer, such as a ref that does not exist: empty output, and nothing logged.
  const probe = (cwd: string, args: readonly string[], signal?: AbortSignal) => run("git", args, cwd, { signal, quiet: true }).catch(() => "")

  const mutate = <T>(cwd: string, work: () => Promise<T>, remote = false) => {
    const next = (queues.get(cwd) ?? Promise.resolve()).then(work, work)
    const settled = next.catch(() => undefined)
    queues.set(cwd, settled)
    void settled.then(() => {
      if (queues.get(cwd) === settled) queues.delete(cwd)
    })
    return next.finally(() => {
      // Only commands that talk to the remote can change pull requests; gh calls are slow on large repositories.
      if (remote) {
        pulls.clear()
        heads.clear()
        issues.clear()
        github.forgetRuns()
      }
      deps.emit("changed", { cwd, remote })
    })
  }

  const write = (cwd: string, args: readonly string[], remote = false) => mutate(cwd, () => git(cwd, args), remote)

  // One command per batch of paths: a command line on Windows holds at most 32k characters.
  const batched = (cwd: string, paths: readonly string[], args: (batch: string[]) => readonly string[]) =>
    batches(paths.map(pathspec)).reduce<Promise<string>>((previous, batch) => previous.then(() => git(cwd, args(batch))), Promise.resolve(""))

  const remote = async (cwd: string) => {
    const names = (await probe(cwd, ["remote"])).split("\n").filter(Boolean)
    const ordered = [...names.filter((name) => name === "origin"), ...names.filter((name) => name !== "origin")]
    for (const name of ordered) {
      const parsed = parseRemote(name, await probe(cwd, ["remote", "get-url", name]))
      if (parsed) return parsed
    }
    return null
  }

  // The repository the panel lists pull requests of. Without --repo, gh picks its own default, such as an `upstream`
  // remote, and #12 there is another pull request.
  const repoOf = async (cwd: string, repo: string | null) =>
    repo ?? (await remote(cwd).then((found) => (found ? `${found.owner}/${found.repo}` : null)))

  const defaultBranch = async (cwd: string, remoteName: string | undefined) => {
    if (remoteName) {
      const symbolic = (await probe(cwd, ["symbolic-ref", "--short", `refs/remotes/${remoteName}/HEAD`])).trim()
      if (symbolic) return symbolic.slice(remoteName.length + 1)
    }
    const local = (await probe(cwd, ["branch", "--list", "main", "master", "--format=%(refname:short)"]))
      .split("\n")
      .filter(Boolean)
    return local.includes("main") ? "main" : (local[0] ?? null)
  }

  const operation = (gitDir: string): Overview["operation"] => {
    // `git am` also uses rebase-apply; `applying` tells it apart, and it needs `git am --abort|--continue`.
    if (existsSync(join(gitDir, "rebase-apply", "applying"))) return "am"
    if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) return "rebase"
    if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge"
    if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick"
    if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert"
    return null
  }

  // Every variable is a string, passed raw with -f: a branch name never reaches the query text.
  const queryPulls = (cwd: string, body: string, variables: Record<string, string>, signal?: AbortSignal) =>
    gh(
      cwd,
      ["api", "graphql", "-f", `query=${body}`, ...Object.entries(variables).flatMap(([key, value]) => ["-f", `${key}=${value}`])],
      signal,
    ).then((output) => {
      // SAFETY: the queries select PULL_FRAGMENT fields under connections with `nodes`.
      const data = (JSON.parse(output) as { data: Record<string, unknown> }).data
      return pullNodes(data)
    })

  const readPulls = async (cwd: string, signal?: AbortSignal): Promise<Pulls> => {
    const repo = await remote(cwd)
    if (!repo) return { error: "No GitHub remote found for this repository.", items: [] }
    const name = `${repo.owner}/${repo.repo}`
    const branch = (await probe(cwd, ["branch", "--show-current"])).trim()
    const query = (body: string, variables: Record<string, string>) => queryPulls(cwd, body, variables, signal)
    const owner = { owner: repo.owner, name: repo.repo }
    // Small requests in parallel: on a busy repository one big query times out, and one slow part should not hold the
    // others. Only the current branch's and the user's own pull requests carry their check state.
    const results = await Promise.allSettled([
      branch
        ? query(
            `query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){pullRequests(headRefName:$branch,first:5,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${PULL_FRAGMENT} ${ROLLUP}}}}}`,
            { ...owner, branch },
          )
        : Promise.resolve([]),
      query(`query($q:String!){search(query:$q,type:ISSUE,first:30){nodes{... on PullRequest{${PULL_FRAGMENT} ${ROLLUP}}}}}`, {
        q: `repo:${name} is:pr author:@me sort:updated-desc`,
      }),
      query(
        `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:50,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${PULL_FRAGMENT}}}}}`,
        owner,
      ),
    ])
    const failure = results.find((result) => result.status === "rejected")
    if (results.every((result) => result.status === "rejected")) return { error: ghError(failure?.reason), items: [] }
    const seen = new Set<number>()
    const items = results
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .filter((item) => !seen.has(item.number) && !!seen.add(item.number))
      .sort((a, b) => Number(b.state === "OPEN") - Number(a.state === "OPEN") || b.updated.localeCompare(a.updated))
    return { error: null, items }
  }

  // The pull requests of many branches, 50 aliased lookups per query; each branch's answer is cached on its own.
  const readBranchPulls = async (cwd: string, names: readonly string[], fresh: boolean): Promise<Pulls> => {
    const repo = await remote(cwd)
    if (!repo) return { error: "No GitHub remote found for this repository.", items: [] }
    const key = (branch: string) => `${repo.owner}/${repo.repo}\n${branch}`
    const wanted = [...new Set(names)].filter(Boolean)
    const stale = wanted.filter((branch) => {
      const cached = heads.get(key(branch))
      return fresh || !cached || Date.now() - cached.time >= HEADS_TTL
    })
    chunks(stale, 50).forEach((chunk) => {
      const fields = chunk
        .map((_, index) => `b${index}:pullRequests(headRefName:$b${index},first:3,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${PULL_FRAGMENT}}}`)
        .join(" ")
      const declared = chunk.map((_, index) => `,$b${index}:String!`).join("")
      const value = queryPulls(cwd, `query($owner:String!,$name:String!${declared}){repository(owner:$owner,name:$name){${fields}}}`, {
        owner: repo.owner,
        name: repo.repo,
        ...Object.fromEntries(chunk.map((branch, index) => [`b${index}`, branch])),
      })
      chunk.forEach((branch) => {
        const entry = { time: Date.now(), value: value.then((items) => items.filter((item) => item.head === branch)) }
        remember(heads, key(branch), entry, 2000)
        // A failure is not worth keeping: the next open asks again.
        entry.value.catch(() => {
          if (heads.get(key(branch)) === entry) heads.delete(key(branch))
        })
      })
    })
    const results = await Promise.allSettled(wanted.flatMap((branch) => heads.get(key(branch))?.value ?? []))
    const failure = results.find((result) => result.status === "rejected")
    if (failure && results.every((result) => result.status === "rejected")) return { error: ghError(failure.reason), items: [] }
    return { error: null, items: results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])) }
  }

  // The default branch as a ref to compare with: the remote's copy when there is one, which a fetch keeps current.
  const baseRef = async (cwd: string) => {
    const remoteName = (await remote(cwd))?.name ?? "origin"
    const name = await defaultBranch(cwd, remoteName)
    if (!name) return null
    const tracked = (await probe(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteName}/${name}`])).trim()
    return { name, ref: tracked ? `${remoteName}/${name}` : name }
  }

  const currentBranch = async (cwd: string) => (await git(cwd, ["branch", "--show-current"])).trim()

  const ensurePushed = async (cwd: string) => {
    const status = parseStatus(await git(cwd, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"]))
    const branch = status.branch.branch
    if (!branch) throw new Error("Check out a branch before creating a pull request.")
    const upstreamRemote = (await probe(cwd, ["config", "--get", `branch.${branch}.remote`])).trim()
    // Only an upstream of the same name is this branch on GitHub: a branch started from origin/main tracks main.
    if (status.branch.upstream && status.branch.upstream === `${upstreamRemote}/${branch}`) {
      if (status.branch.ahead > 0) await git(cwd, ["push", upstreamRemote, `HEAD:refs/heads/${branch}`])
      return branch
    }
    const repo = await remote(cwd)
    await git(cwd, ["push", "-u", repo?.name ?? "origin", `HEAD:refs/heads/${branch}`])
    return branch
  }

  // gh needs a directory to run in; with --repo it never reads the repository there.
  const home = homedir()

  const readItem = async (repo: string, number: number): Promise<Item> => {
    const kind = (await gh(home, ["api", apiPath(repo, `issues/${number}`), "--jq", "if .pull_request then \"pr\" else \"issue\" end"])).trim()
    const pr = kind === "pr"
    const view = (fields: string) => gh(home, [pr ? "pr" : "issue", "view", String(number), "--repo", repo, "--json", fields])
    // Older gh releases lack the closing-reference fields; the item reads without its links there.
    const output = await view(pr ? `${PR_FIELDS},closingIssuesReferences` : `${ITEM_FIELDS},closedByPullRequestsReferences`).catch((error: unknown) => {
      if (error instanceof Error && /unknown json field/i.test(error.message)) return view(pr ? PR_FIELDS : ITEM_FIELDS)
      throw error
    })
    return parseItem(pr ? "pr" : "issue", repo, output)
  }

  const changeItem = async <T>(repo: string, number: number, work: () => Promise<T>) => {
    try {
      return await work()
    } finally {
      items.delete(`${repo}#${number}`)
      pulls.clear()
      heads.clear()
      issues.clear()
      deps.emit("item", { repo, number })
    }
  }

  const itemChanged = (repo: string, number: number) => {
    items.delete(`${repo}#${number}`)
    pulls.clear()
    heads.clear()
    issues.clear()
    github.forgetInbox()
    deps.emit("item", { repo, number })
  }

  const github = createGitHub({
    gh: (args) => gh(home, args),
    ghInput: (args, input) => run("gh", args, home, { input }),
    changed: itemChanged,
    runChanged: (repo, id) => deps.emit("run", { repo, id }),
    inboxChanged: () => deps.emit("inbox", {}),
  })

  // Only the server part keeps agent actions; the main process answers that there are none.
  const serverOnly = () => Promise.reject(new Error("Agent actions need the plugin's server part on the session's server."))

  const backend: Backend = {
    agentActions: () => ({ auto: false, actions: [] }),
    agentRecent: () => [],
    agentDecide: serverOnly,
    agentEdit: serverOnly,
    agentUndo: serverOnly,
    agentRetry: serverOnly,
    agentAuto: serverOnly,
    prFiles: github.prFiles,
    search: github.search,
    prChecks: github.prChecks,
    reviews: github.reviews,
    submitReview: github.submitReview,
    replyThread: github.replyThread,
    resolveThread: github.resolveThread,
    lineComment: github.lineComment,
    edit: github.edit,
    setDraft: github.setDraft,
    repoMeta: github.repoMeta,
    remoteCommit: github.commit,
    runs: github.runs,
    run: github.run,
    jobLog: github.jobLog,
    rerun: github.rerun,
    cancelRun: github.cancelRun,
    inbox: github.inbox,
    markRead: github.markRead,
    overview: async ({ cwd }, caller) => {
      const top = await probe(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir"], caller.signal)
      const [root, gitDir] = top.trim().split(/\r?\n/)
      if (!root || !gitDir) return null
      const [status, stash, repo] = await Promise.all([
        git(cwd, ["status", "--porcelain=v2", "--branch", "-z"], caller.signal),
        probe(cwd, ["stash", "list", "--format=%H"], caller.signal),
        remote(cwd),
      ])
      const parsed = parseStatus(status)
      return {
        root,
        name: basename(root),
        branch: parsed.branch.branch,
        head: parsed.branch.head,
        upstream: parsed.branch.upstream,
        ahead: parsed.branch.ahead,
        behind: parsed.branch.behind,
        remote: repo,
        defaultBranch: await defaultBranch(cwd, repo?.name),
        operation: operation(gitDir),
        stashes: stash.split("\n").filter(Boolean).length,
        files: parsed.files,
      }
    },
    log: async ({ cwd, limit, scope }, caller) => {
      const args = ["log", "--topo-order", "--decorate=full", "--no-show-signature", `--format=${LOG_FORMAT}`, `-n${Math.max(1, Math.floor(limit) || 1)}`]
      const refs = async () => {
        if (scope === "current") return ["HEAD"]
        if (scope === "all") return ["--branches", "--remotes", "--tags", "HEAD"]
        // Local branches and their upstreams: the user's own work, without every remote branch of a busy repository.
        const upstreams = (await probe(cwd, ["for-each-ref", "--format=%(upstream)", "refs/heads"], caller.signal))
          .split("\n")
          .filter((ref, index, all) => ref.startsWith("refs/remotes/") && all.indexOf(ref) === index)
        return ["--branches", "--tags", "HEAD", ...upstreams]
      }
      // `--` keeps a file named like a ref, such as HEAD, from making the arguments ambiguous.
      return parseLog(await git(cwd, [...args, ...(await refs()), "--"], caller.signal).catch(() => ""))
    },
    show: async ({ cwd, hash }, caller) => {
      const [meta, files] = await Promise.all([
        git(cwd, ["show", "-s", "--no-show-signature", `--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B`, arg(hash), "--"], caller.signal),
        // A merge shows what it brought into its first parent, as GitHub does; diff-tree shows nothing for merges.
        git(
          cwd,
          ["show", "--format=", "--no-show-signature", "--no-color", "--no-ext-diff", "--name-status", "-z", "-M", "-m", "--first-parent", hash, "--"],
          caller.signal,
        ),
      ])
      const [full, author, email, date, ...body] = meta.split(FIELD)
      const tokens = files.split("\0").filter(Boolean)
      const changed: { status: string; path: string }[] = []
      for (let i = 0; i < tokens.length; i++) {
        const status = tokens[i] ?? ""
        const renamed = status.startsWith("R") || status.startsWith("C")
        const path = renamed ? tokens[i + 2] : tokens[i + 1]
        i += renamed ? 2 : 1
        if (path) changed.push({ status: status[0] ?? "M", path })
      }
      return {
        hash: full ?? hash,
        author: author ?? "",
        email: email ?? "",
        date: Number(date ?? 0),
        body: body.join(FIELD).trim(),
        files: changed,
      }
    },
    branches: async ({ cwd }, caller) =>
      parseBranches(
        await git(cwd, ["for-each-ref", "--sort=-committerdate", `--format=${BRANCH_FORMAT}`, "refs/heads", "refs/remotes"], caller.signal),
      ),
    pulls: ({ cwd, fresh }) => {
      const cached = pulls.get(cwd)
      if (!fresh && cached && Date.now() - cached.time < PULL_TTL) return cached.value
      const value = readPulls(cwd)
      remember(pulls, cwd, { time: Date.now(), value }, 20)
      // A failure is not worth keeping: signing in to gh or a network blip should not wait out the TTL.
      void value.then((result) => {
        if (result.error && pulls.get(cwd)?.value === value) pulls.delete(cwd)
      })
      return value
    },
    branchPulls: ({ cwd, names, fresh }) => readBranchPulls(cwd, names, fresh),
    mergedBranches: async ({ cwd }, caller) => {
      const base = await baseRef(cwd)
      if (!base) return []
      const output = await git(cwd, ["for-each-ref", `--merged=${base.ref}`, "--format=%(refname:short)", "refs/heads"], caller.signal)
      return output.split("\n").filter(Boolean)
    },
    outgoing: async ({ cwd }, caller) => {
      const [remotes, base] = await Promise.all([probe(cwd, ["for-each-ref", "--count=1", "--format=%(refname)", "refs/remotes"], caller.signal), baseRef(cwd)])
      // Without remote branches every commit would count as unpushed.
      const unpushed = remotes.trim()
        ? parseLog(
            await probe(
              cwd,
              ["log", "--decorate=full", "--no-show-signature", `--format=${LOG_FORMAT}`, "-n50", "HEAD", "--not", "--remotes", "--"],
              caller.signal,
            ),
          )
        : []
      const ahead = base ? Number((await probe(cwd, ["rev-list", "--count", `${base.ref}..HEAD`, "--"], caller.signal)).trim()) || 0 : 0
      return { unpushed, base: base?.name ?? null, ahead }
    },
    issues: async ({ cwd, state, mine, search, fresh }) => {
      const key = JSON.stringify({ cwd, state, mine, search })
      const cached = issues.get(key)
      if (!fresh && cached && Date.now() - cached.time < PULL_TTL) return cached.value
      const value = (async (): Promise<Issues> => {
        const repo = await remote(cwd)
        if (!repo) return { error: "No GitHub remote found for this repository.", items: [] }
        const args = ["issue", "list", "--repo", `${repo.owner}/${repo.repo}`, "--state", state, "--limit", "60", "--json", ISSUE_FIELDS]
        if (mine) args.push("--assignee", "@me")
        if (search.trim()) args.push("--search", search.trim())
        return gh(cwd, args).then(
          (output) => ({ error: null, items: parseIssues(output) }),
          (error: unknown) => ({ error: ghError(error), items: [] }),
        )
      })()
      // Every search typed is a key; keep the recent ones.
      remember(issues, key, { time: Date.now(), value }, 50)
      void value.then((result) => {
        if (result.error && issues.get(key)?.value === value) issues.delete(key)
      })
      return value
    },
    item: ({ repo, number, fresh }) => {
      const key = `${repo}#${number}`
      const cached = items.get(key)
      if (!fresh && cached && Date.now() - cached.time < PULL_TTL) return cached.value
      const value = readItem(repo, number)
      remember(items, key, { time: Date.now(), value }, 200)
      // A failed read is not worth keeping: the next hover or open tries again.
      value.catch(() => {
        if (items.get(key)?.value === value) items.delete(key)
      })
      return value
    },
    comment: ({ repo, number, kind, body }) =>
      changeItem(repo, number, () => gh(home, [kind, "comment", String(number), "--repo", repo, "--body", body])),
    setState: ({ repo, number, kind, open }) =>
      changeItem(repo, number, () => gh(home, [kind, open ? "reopen" : "close", String(number), "--repo", repo])),
    createIssue: async ({ cwd, title, body }) => {
      const repo = await remote(cwd)
      if (!repo) throw new Error("No GitHub remote found for this repository.")
      const output = await gh(cwd, ["issue", "create", "--repo", `${repo.owner}/${repo.repo}`, "--title", title, "--body", body])
      issues.clear()
      return output.trim().split("\n").reverse().find((line) => line.startsWith("https://")) ?? output.trim()
    },
    diff: async ({ cwd, path, staged, untracked }, caller) => {
      if (untracked) {
        // An untracked folder is listed as one entry; show the diffs of the files inside it.
        const files = path.endsWith("/")
          ? (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec(path)], caller.signal)).split("\0").filter(Boolean)
          : [path]
        const diffs = await Promise.all(
          files.slice(0, 20).map((file) =>
            // `--no-index` exits 1 when the files differ, which they always do here; its stdout is the diff.
            run("git", ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", file], cwd, {
              signal: caller.signal,
              ok: (code) => code <= 1,
            }).catch(() => ""),
          ),
        )
        return diffs.join("") + (files.length > 20 ? `\n… ${files.length - 20} more files\n` : "")
      }
      return git(
        cwd,
        ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", ...(staged ? ["--cached"] : []), "--", pathspec(path)],
        caller.signal,
      )
    },
    prDefaults: async ({ cwd, base }) => {
      const remoteName = (await remote(cwd))?.name ?? "origin"
      const range = (await probe(cwd, ["rev-parse", "--verify", "--quiet", `${remoteName}/${arg(base)}`])).trim()
        ? `${remoteName}/${base}..HEAD`
        : `${base}..HEAD`
      const subjects = (await probe(cwd, ["log", "--reverse", "--no-show-signature", "--format=%s", range, "--"])).split("\n").filter(Boolean)
      const branch = await currentBranch(cwd)
      const title =
        subjects.length === 1 ? (subjects[0] ?? branch) : branch.replace(/^[^/]+\//, "").replace(/[-_]+/g, " ")
      const template = await prTemplate((await probe(cwd, ["rev-parse", "--show-toplevel"])).trim())
      // The RPC response is JSON: an absent template is a missing key, never `undefined`.
      return {
        title: title.charAt(0).toUpperCase() + title.slice(1),
        body: subjects.length > 1 ? subjects.map((subject) => `- ${subject}`).join("\n") : "",
        ...(template ? { template } : {}),
      }
    },

    // With no paths, `git add -A --` would stage the whole tree.
    stage: async ({ cwd, paths }) => (paths.length === 0 ? "" : mutate(cwd, () => batched(cwd, paths, (batch) => ["add", "-A", "--", ...batch]))),
    unstage: async ({ cwd, paths }) =>
      paths.length === 0
        ? ""
        : mutate(cwd, async () => {
            const hasHead = !!(await probe(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])).trim()
            return batched(cwd, paths, (batch) => (hasHead ? ["restore", "--staged", "--", ...batch] : ["rm", "--cached", "-r", "-q", "--", ...batch]))
          }),
    discard: ({ cwd, tracked, untracked }) =>
      mutate(cwd, async () => {
        if (tracked.length > 0) await batched(cwd, tracked, (batch) => ["restore", "--worktree", "--", ...batch])
        if (untracked.length > 0) await batched(cwd, untracked, (batch) => ["clean", "-fdq", "--", ...batch])
        return ""
      }),
    commit: ({ cwd, message, amend, all }) =>
      mutate(cwd, async () => {
        if (all) await git(cwd, ["add", "-A"])
        if (amend && !message) return git(cwd, ["commit", "--amend", "--no-edit"])
        return git(cwd, ["commit", "-m", message, ...(amend ? ["--amend"] : [])])
      }),
    checkout: async ({ cwd, ref, track }) =>
      write(cwd, track ? ["switch", "-c", arg(ref), "--track", arg(track)] : ["switch", arg(ref)], true).catch(
        (error: unknown) => {
          // A commit or tag is not a branch: switch to it detached.
          if (error instanceof Error && /a branch is expected|invalid reference/i.test(error.message))
            return write(cwd, ["switch", "--detach", ref], true)
          throw error
        },
      ),
    // A branch started from origin/main would track it, and then `git push` targets main or refuses.
    createBranch: async ({ cwd, name, start, checkout }) =>
      write(cwd, [...(checkout ? ["switch", "-c"] : ["branch"]), arg(name), ...(start ? ["--no-track", arg(start)] : [])]),
    deleteBranch: async ({ cwd, name, force }) => write(cwd, ["branch", force ? "-D" : "-d", arg(name)]),
    deleteBranches: ({ cwd, names, force }) =>
      mutate(cwd, () =>
        names.reduce<Promise<{ name: string; error: string | null }[]>>(async (previous, name) => {
          const done = await previous
          const error = await Promise.resolve()
            .then(() => git(cwd, ["branch", force ? "-D" : "-d", arg(name)]))
            .then(
              () => null,
              (failure: unknown) => (failure instanceof Error ? failure.message : String(failure)),
            )
          return [...done, { name, error }]
        }, Promise.resolve([])),
      ),
    undoCommit: ({ cwd }) =>
      mutate(cwd, async () => {
        const gitDir = (await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim()
        if (operation(gitDir)) throw new Error("Finish or abort the operation in progress first.")
        const parents = (await git(cwd, ["rev-list", "--parents", "-n1", "HEAD", "--"])).trim().split(" ").slice(1)
        if (parents.length === 0) throw new Error("The first commit of a repository cannot be undone here.")
        if (parents.length > 1) throw new Error("A merge commit cannot be undone here.")
        if ((await probe(cwd, ["branch", "-r", "--contains", "HEAD"])).trim())
          throw new Error("The last commit is already on a remote; undoing it would rewrite published history.")
        return git(cwd, ["reset", "--soft", "HEAD~1"])
      }),
    deleteRemoteBranch: async ({ cwd, remote: remoteName, name }) => write(cwd, ["push", arg(remoteName), "--delete", arg(name)], true),
    merge: async ({ cwd, ref }) => write(cwd, ["merge", "--no-edit", arg(ref)]),
    rebase: async ({ cwd, ref }) => write(cwd, ["rebase", arg(ref)]),
    cherryPick: async ({ cwd, hash }) => write(cwd, ["cherry-pick", arg(hash)]),
    revert: async ({ cwd, hash }) => write(cwd, ["revert", "--no-edit", arg(hash)]),
    abort: ({ cwd }) =>
      mutate(cwd, async () => {
        const gitDir = (await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim()
        const op = operation(gitDir)
        if (!op) return ""
        return git(cwd, [op, "--abort"])
      }),
    continue: ({ cwd }) =>
      mutate(cwd, async () => {
        const gitDir = (await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim()
        const op = operation(gitDir)
        if (!op) return ""
        if (op === "merge") return git(cwd, ["commit", "--no-edit"])
        return git(cwd, [op, "--continue"])
      }),
    fetch: ({ cwd }) => write(cwd, ["fetch", "--all", "--prune"], true),
    pull: ({ cwd }) => write(cwd, ["pull"], true),
    push: ({ cwd, force }) =>
      mutate(cwd, async () => {
        const upstream = await probe(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        if (upstream.trim()) return git(cwd, ["push", ...(force ? ["--force-with-lease"] : [])])
        const repo = await remote(cwd)
        return git(cwd, ["push", "-u", repo?.name ?? "origin", "HEAD", ...(force ? ["--force-with-lease"] : [])])
      }, true),
    pushBranch: ({ cwd, name }) =>
      mutate(cwd, async () => {
        const repo = await remote(cwd)
        return git(cwd, ["push", "-u", repo?.name ?? "origin", arg(name)])
      }, true),
    stash: ({ cwd }) => write(cwd, ["stash", "push", "--include-untracked"]),
    stashPop: ({ cwd }) => write(cwd, ["stash", "pop"]),
    createPr: ({ cwd, title, body, base, draft }) =>
      mutate(cwd, async () => {
        const branch = await ensurePushed(cwd)
        const repo = await repoOf(cwd, null)
        const output = await gh(cwd, [
          "pr",
          "create",
          ...(repo ? ["--repo", repo] : []),
          "--title",
          title,
          "--body",
          body,
          "--base",
          arg(base),
          "--head",
          branch,
          ...(draft ? ["--draft"] : []),
        ])
        return output.trim().split("\n").reverse().find((line) => line.startsWith("https://")) ?? output.trim()
      }, true),
    checkoutPr: ({ cwd, number, repo }) =>
      mutate(
        cwd,
        async () => {
          const target = await repoOf(cwd, repo)
          return gh(cwd, ["pr", "checkout", String(number), ...(target ? ["--repo", target] : [])])
        },
        true,
      ),
    mergePr: ({ cwd, repo, number, method, deleteBranch }) =>
      mutate(
        cwd,
        async () => {
          const target = await repoOf(cwd, repo)
          // For the repository's own pull requests GH_REPO, not --repo: with --repo, gh leaves the merged local branch.
          const output = await run(
            "gh",
            ["pr", "merge", String(number), `--${method}`, ...(deleteBranch ? ["--delete-branch"] : []), ...(repo ? ["--repo", repo] : [])],
            cwd,
            { env: target && !repo ? { GH_REPO: target } : undefined },
          )
          if (target) {
            items.delete(`${target}#${number}`)
            deps.emit("item", { repo: target, number })
          }
          return output
        },
        true,
      ),
  }
  return { backend, kit: { github, repoOf: (cwd) => repoOf(cwd, null), changed: itemChanged } }
}

const PULL_FRAGMENT = "number title state isDraft url headRefName headRefOid baseRefName isCrossRepository author{login} reviewDecision updatedAt"
const ROLLUP = "commits(last:1){nodes{commit{statusCheckRollup{state}}}}"

interface GqlPullNode {
  number?: number
  title: string
  state: string
  isDraft: boolean
  url: string
  headRefName: string
  headRefOid?: string
  baseRefName: string
  isCrossRepository: boolean
  author: { login: string } | null
  reviewDecision: string | null
  updatedAt: string
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
}

/** Every pull request node anywhere in a GraphQL response, as the panel's PullRequest. */
function pullNodes(data: unknown): Pulls["items"] {
  const found: GqlPullNode[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (typeof value !== "object" || value === null) return
    // SAFETY: an object with a number and headRefName is a PULL_FRAGMENT node.
    if ("headRefName" in value && "number" in value) return void found.push(value as GqlPullNode)
    Object.values(value).forEach(walk)
  }
  walk(data)
  return found.map((node) => {
    const rollup = node.commits?.nodes[0]?.commit.statusCheckRollup?.state
    return {
      number: node.number ?? 0,
      title: node.title,
      state: node.state === "MERGED" ? "MERGED" : node.state === "CLOSED" ? "CLOSED" : "OPEN",
      draft: node.isDraft,
      url: node.url,
      head: node.headRefName,
      cross: node.isCrossRepository,
      base: node.baseRefName,
      author: node.author?.login ?? "ghost",
      review: node.reviewDecision || null,
      checks: !rollup ? "none" : rollup === "SUCCESS" ? "success" : rollup === "PENDING" || rollup === "EXPECTED" ? "pending" : "failure",
      updated: node.updatedAt,
      sha: node.headRefOid,
    }
  })
}

/**
 * The repository's pull request template, where GitHub looks for one: `pull_request_template.md` in `.github`, the root
 * or `docs` (any case), else the first Markdown file of a `PULL_REQUEST_TEMPLATE` folder there.
 */
async function prTemplate(root: string) {
  if (!root) return undefined
  const dirs = await Promise.all(
    [join(root, ".github"), root, join(root, "docs")].map(async (dir) => ({ dir, names: await readdir(dir).catch(() => [] as string[]) })),
  )
  const named = (wanted: string) => dirs.flatMap((entry) => entry.names.filter((name) => name.toLowerCase() === wanted).map((name) => join(entry.dir, name)))
  const single = named("pull_request_template.md")[0]
  const folders = await Promise.all(
    named("pull_request_template").map(async (folder) =>
      (await readdir(folder).catch(() => [] as string[]))
        .filter((name) => name.toLowerCase().endsWith(".md"))
        .sort()
        .map((name) => join(folder, name)),
    ),
  )
  const path = single ?? folders.flat()[0]
  if (!path) return undefined
  const text = await readFile(path, "utf8").catch(() => undefined)
  return text?.trim() ? text.slice(0, 20_000) : undefined
}

function ghError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (/auth login|not logged/i.test(message)) return "GitHub CLI is not signed in. Run `gh auth login`."
  return message
}

/** A ref, remote or commit as a git argument: one starting with `-` would be read as an option, such as `-D`. */
function arg(value: string) {
  if (value.startsWith("-")) throw new Error(`"${value}" is not a valid name.`)
  return value
}

/** A path from `git status` as a pathspec: relative to the top of the work tree, with `*` and `[` taken literally. */
function pathspec(path: string) {
  return `:(top,literal)${path}`
}

function chunks<T>(list: readonly T[], size: number) {
  return Array.from({ length: Math.ceil(list.length / size) }, (_, index) => list.slice(index * size, (index + 1) * size))
}

function batches(paths: readonly string[]) {
  const all: string[][] = []
  const state = { size: 0 }
  paths.forEach((path) => {
    const last = all.at(-1)
    state.size += path.length + 3
    if (last && state.size < 24_000) return void last.push(path)
    all.push([path])
    state.size = path.length + 3
  })
  return all
}

function kill(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill())
    return
  }
  // The child leads its own process group; stop what it started too, such as ssh under git or git under gh.
  // A group that already exited throws ESRCH.
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
}

function spawnError(command: string, cwd: string, error: NodeJS.ErrnoException) {
  // A missing working directory fails with the same ENOENT as a missing command.
  if (error.code === "ENOENT" && !existsSync(cwd)) return `The directory ${cwd} does not exist.`
  if (error.code === "ENOENT") return command === "gh" ? GH_MISSING : `${command} is not installed or not on PATH.`
  return error.message
}

/** The desktop app loads the login shell's environment; GUI launches can still miss Homebrew's bin directories. */
function environment(): NodeJS.ProcessEnv {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
  const path = [...(process.env.PATH ?? "").split(delimiter), ...extra].filter(
    (item, index, all) => item && all.indexOf(item) === index,
  )
  return {
    ...process.env,
    PATH: path.join(delimiter),
    GIT_TERMINAL_PROMPT: "0",
    // Nothing here can answer an editor: `revert --continue` and friends keep the prepared message.
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_MERGE_AUTOEDIT: "no",
    GIT_OPTIONAL_LOCKS: "0",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    LANG: "C",
    LC_ALL: "C",
  }
}
