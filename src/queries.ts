import { createComputed, createSignal, on, onCleanup } from "solid-js"
import {
  InfiniteQueryObserver,
  keepPreviousData,
  notifyManager,
  QueryClient,
  QueryObserver,
  type InfiniteData,
  type InfiniteQueryObserverResult,
  type QueryKey,
  type QueryObserverResult,
} from "@tanstack/query-core"
import type { AgentQueue, ItemRef, SearchPage } from "./schemas"
import type { GitClient } from "./transport"

/** The options the views pass to `query`. */
export interface QueryInput<T> {
  readonly queryKey: QueryKey
  readonly queryFn: () => Promise<T>
  readonly enabled?: boolean
  readonly staleTime?: number
  /** A fixed interval, or one decided from the latest data (for example: poll while a CI run is going). */
  readonly refetchInterval?: number | false | ((query: { readonly state: { readonly data: T | undefined } }) => number | false)
  readonly placeholderData?: unknown
  readonly refetchOnWindowFocus?: boolean
}

const SECOND = 1000
const MINUTE = 60 * SECOND

/**
 * Query functions take no abort signal on purpose: TanStack cancels a fetch whose signal was read when its last
 * observer unmounts, which a tab opening (mount, unmount, mount) would trigger, refetching for nothing. A fetch that
 * finishes after its view closed still fills the cache for the next one.
 *
 * The window's data layer, on TanStack Query. Every read goes through one QueryClient, so a view that mounts again (a
 * pull request section, a tab the user returns to) shows cached data at once and refreshes it in the background only
 * when it is stale. Equal requests share one fetch, rows prefetch on hover, and the backend's events invalidate exactly
 * the queries they affect.
 */
export function createQueries(git: GitClient) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30 * SECOND, gcTime: 15 * MINUTE, retry: 1, refetchOnWindowFocus: false },
    },
  })
  // Git runs on this machine or the session's server, not over the internet: never pause it while the browser reports
  // being offline.
  client.setQueryDefaults(["git"], { networkMode: "always" })
  client.setQueryDefaults(["agent"], { networkMode: "always" })
  client.setQueryDefaults(["review"], { networkMode: "always" })
  client.mount()
  onCleanup(() => {
    client.unmount()
    client.clear()
  })

  // A refetch of data the window already shows: skip the backend's own caches, so the user gets GitHub's current state.
  const fresh = (key: QueryKey) => client.getQueryData(key) !== undefined

  const keys = {
    git: (cwd: string) => ["git", cwd] as const,
    overview: (cwd: string) => ["git", cwd, "overview"] as const,
    branches: (cwd: string) => ["git", cwd, "branches"] as const,
    log: (cwd: string, scope: string, limit: number) => ["git", cwd, "log", scope, limit] as const,
    show: (cwd: string, hash: string) => ["git", cwd, "show", hash] as const,
    diff: (cwd: string, path: string, staged: boolean, untracked: boolean) => ["git", cwd, "diff", path, staged, untracked] as const,
    merged: (cwd: string) => ["git", cwd, "merged"] as const,
    outgoing: (cwd: string) => ["git", cwd, "outgoing"] as const,
    pulls: (cwd: string) => ["pulls", cwd] as const,
    branchPulls: (cwd: string, names: readonly string[]) => ["pulls", cwd, "branches", names.join("\n")] as const,
    item: (ref: ItemRef) => ["gh", ref.repo, "item", ref.number] as const,
    reviews: (ref: ItemRef) => ["gh", ref.repo, "item", ref.number, "reviews"] as const,
    files: (ref: ItemRef, head: string) => ["gh", ref.repo, "item", ref.number, "files", head] as const,
    search: (repo: string, kind: "issue" | "pr", query: string) => ["gh", repo, "search", kind, query] as const,
    checks: (repo: string, numbers: readonly number[]) => ["gh", repo, "checks", numbers.join(",")] as const,
    runs: (repo: string, branch: string | null) => ["gh", repo, "runs", branch ?? ""] as const,
    run: (repo: string, id: number) => ["gh", repo, "run", id] as const,
    job: (repo: string, job: number) => ["gh", repo, "job", job] as const,
    commit: (repo: string, sha: string) => ["gh", repo, "commit", sha] as const,
    meta: (repo: string) => ["gh", repo, "meta"] as const,
    inbox: () => ["inbox"] as const,
    agent: (sessionID: string) => ["agent", sessionID] as const,
    /** A pull request's draft reviews, which the server part keeps. */
    review: (ref: ItemRef) => ["review", ref.repo, ref.number] as const,
  }

  const options = {
    overview: (cwd: string) => ({
      queryKey: keys.overview(cwd),
      queryFn: () => git.overview({ cwd }),
      staleTime: 2 * SECOND,
    }),
    branches: (cwd: string) => ({
      queryKey: keys.branches(cwd),
      queryFn: () => git.branches({ cwd }),
      staleTime: 5 * SECOND,
    }),
    log: (cwd: string, scope: "current" | "local" | "all", limit: number) => ({
      queryKey: keys.log(cwd, scope, limit),
      queryFn: () => git.log({ cwd, scope, limit }),
      staleTime: 5 * SECOND,
      placeholderData: keepPreviousData,
    }),
    show: (cwd: string, hash: string) => ({
      queryKey: keys.show(cwd, hash),
      queryFn: () => git.show({ cwd, hash }),
      // A commit never changes.
      staleTime: Infinity,
    }),
    diff: (cwd: string, path: string, staged: boolean, untracked: boolean) => ({
      queryKey: keys.diff(cwd, path, staged, untracked),
      queryFn: () => git.diff({ cwd, path, staged, untracked }),
      staleTime: 2 * SECOND,
    }),
    merged: (cwd: string) => ({
      queryKey: keys.merged(cwd),
      queryFn: () => git.mergedBranches({ cwd }),
      staleTime: 10 * SECOND,
    }),
    outgoing: (cwd: string) => ({
      queryKey: keys.outgoing(cwd),
      queryFn: () => git.outgoing({ cwd }),
      staleTime: 2 * SECOND,
    }),
    branchPulls: (cwd: string, names: readonly string[]) => ({
      queryKey: keys.branchPulls(cwd, names),
      queryFn: () => git.branchPulls({ cwd, names: [...names], fresh: fresh(keys.branchPulls(cwd, names)) }),
      staleTime: 2 * MINUTE,
      placeholderData: keepPreviousData,
    }),
    pulls: (cwd: string) => ({
      queryKey: keys.pulls(cwd),
      queryFn: () => git.pulls({ cwd, fresh: fresh(keys.pulls(cwd)) }),
      staleTime: 60 * SECOND,
    }),
    item: (ref: ItemRef) => ({
      queryKey: keys.item(ref),
      queryFn: () => git.item({ ...ref, fresh: fresh(keys.item(ref)) }),
      staleTime: 60 * SECOND,
    }),
    reviews: (ref: ItemRef) => ({
      queryKey: keys.reviews(ref),
      queryFn: () => git.reviews(ref),
      staleTime: 60 * SECOND,
    }),
    files: (ref: ItemRef, head: string) => ({
      queryKey: keys.files(ref, head),
      queryFn: () => git.prFiles({ ...ref, head }),
      // Files only change with a new head commit, which is part of the key.
      staleTime: Infinity,
    }),
    checks: (repo: string, numbers: readonly number[]) => ({
      queryKey: keys.checks(repo, numbers),
      queryFn: () => git.prChecks({ repo, numbers: [...numbers] }),
      staleTime: 60 * SECOND,
    }),
    runs: (repo: string, branch: string | null) => ({
      queryKey: keys.runs(repo, branch),
      queryFn: () => git.runs({ repo, branch, fresh: fresh(keys.runs(repo, branch)) }),
      staleTime: 15 * SECOND,
    }),
    run: (repo: string, id: number) => ({
      queryKey: keys.run(repo, id),
      queryFn: () => git.run({ repo, id }),
      staleTime: 10 * SECOND,
    }),
    job: (repo: string, job: number, done: boolean) => ({
      queryKey: keys.job(repo, job),
      queryFn: () => git.jobLog({ repo, job }),
      // A finished job's log is final.
      staleTime: done ? Infinity : 5 * SECOND,
    }),
    commit: (repo: string, sha: string) => ({
      queryKey: keys.commit(repo, sha),
      queryFn: () => git.remoteCommit({ repo, sha }),
      staleTime: Infinity,
    }),
    meta: (repo: string) => ({
      queryKey: keys.meta(repo),
      queryFn: () => git.repoMeta({ repo }),
      staleTime: 5 * MINUTE,
    }),
    inbox: () => ({
      queryKey: keys.inbox(),
      queryFn: () => git.inbox({ fresh: fresh(keys.inbox()) }),
      staleTime: 60 * SECOND,
    }),
    /** A session's agent actions. The server announces every change; while some run, polling covers a missed one. */
    agent: (sessionID: string) => ({
      queryKey: keys.agent(sessionID),
      queryFn: (): Promise<AgentQueue> => git.agentActions({ sessionID, repo: null }),
      staleTime: 30 * SECOND,
      refetchInterval: (query: { state: { data: AgentQueue | undefined } }) =>
        query.state.data?.actions.some((action) => action.status === "approved" || action.status === "running") ? 3 * SECOND : false,
    }),
  }

  /** Pull requests or issues matching a GitHub search, a page at a time. */
  const search = (repo: string, kind: "issue" | "pr", query: string) => ({
    queryKey: keys.search(repo, kind, query),
    queryFn: ({ pageParam }: { pageParam: string | null }) => git.search({ repo, kind, query, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page: SearchPage) => page.cursor,
    staleTime: 60 * SECOND,
    placeholderData: keepPreviousData,
  })

  const invalidate = (queryKey: QueryKey) => void client.invalidateQueries({ queryKey })

  // The backend reports every change it makes; mark exactly what it touched stale. Views showing it refetch at once,
  // others when they next mount.
  git.on("item", (changed) => {
    invalidate(["gh", changed.repo, "item", changed.number])
    invalidate(["gh", changed.repo, "search"])
    invalidate(["gh", changed.repo, "checks"])
    invalidate(["pulls"])
    invalidate(["inbox"])
  })
  git.on("changed", (changed) => {
    invalidate(["git"])
    if (!changed.remote) return
    invalidate(["pulls"])
    void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === "gh" && query.queryKey[2] === "search" })
    void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === "gh" && query.queryKey[2] === "runs" })
  })
  git.on("run", (changed) => {
    invalidate(["gh", changed.repo, "runs"])
    invalidate(["gh", changed.repo, "run", changed.id])
    // A re-run or cancel changes the status checks of the pull requests that show this run.
    invalidate(["gh", changed.repo, "checks"])
    void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === "gh" && query.queryKey[1] === changed.repo && query.queryKey[2] === "item" && query.queryKey.length === 4 })
  })
  git.on("inbox", () => invalidate(["inbox"]))
  git.on("agent", (changed) => invalidate(keys.agent(changed.sessionID)))
  // The agent may spell the repository in another case than the tab that shows it.
  git.on("review", (changed) =>
    void client.invalidateQueries({
      predicate: (query) => query.queryKey[0] === "review" && String(query.queryKey[1]).toLowerCase() === changed.repo.toLowerCase() && query.queryKey[2] === changed.number,
    }),
  )

  return {
    client,
    keys,
    options,
    search,
    invalidate,
    /** A query bound to this window's client, typed by the query function's result. */
    query: <T>(accessor: () => QueryInput<T>) =>
      observe<QueryObserverResult<T, Error>>(client, (options) => new QueryObserver(client, options), accessor),
    /** A search a page at a time, bound to this window's client. */
    infinite: (accessor: () => ReturnType<typeof search> & { readonly enabled?: boolean }) =>
      observe<InfiniteQueryObserverResult<InfiniteData<SearchPage, string | null>, Error>>(
        client,
        (options) => new InfiniteQueryObserver(client, options),
        accessor,
      ),
    /** Loads a query in the background, for example when the pointer rests on a row. */
    prefetch: (input: { queryKey: QueryKey; queryFn: () => Promise<unknown>; staleTime?: number }) =>
      void client.prefetchQuery(input as never),
  }
}

export type Queries = ReturnType<typeof createQueries>

/**
 * Follows one query in a signal. This deliberately skips @tanstack/solid-query: it reads results through a Solid
 * resource, and a resource read before it first settles (even with cached data, for a tick) suspends the nearest
 * Suspense boundary, which is the app's session page. That blanked the page while an issue loaded and remounted the
 * timeline, losing its scroll position, whenever a hover card, chip or tab mounted a query.
 */
function observe<R extends object>(
  client: QueryClient,
  create: (options: never) => {
    getOptimisticResult(options: never): unknown
    getCurrentResult(): unknown
    setOptions(options: never): void
    subscribe(listener: (result: R) => void): () => void
  },
  accessor: () => unknown,
) {
  // SAFETY: the accessors pass options built for this observer kind; defaulting only fills in client defaults.
  const options = () => client.defaultQueryOptions(accessor() as never) as never
  const observer = create(options())
  const [result, setResult] = createSignal(observer.getOptimisticResult(options()) as R, { equals: false })
  createComputed(
    on(options, (next) => {
      observer.setOptions(next)
      setResult(() => observer.getOptimisticResult(next) as R)
    }, { defer: true }),
  )
  // Notifications arrive batched, after the fact: read the observer then, so a result queued before the options changed
  // never replaces the newer one.
  onCleanup(observer.subscribe(notifyManager.batchCalls(() => setResult(() => observer.getCurrentResult() as R))))
  return new Proxy({} as R, { get: (_, key) => Reflect.get(result(), key) })
}

/**
 * A query result in the shape the views read: the data, whether a fetch is running (also in the background), and the
 * error only while there is nothing to show.
 */
export function latest<T>(result: { readonly data: T | undefined; readonly isFetching: boolean; readonly error: unknown }) {
  return {
    get latest() {
      return result.data
    },
    get loading() {
      return result.isFetching
    },
    get error() {
      return result.data === undefined ? (result.error ?? undefined) : undefined
    },
  }
}
