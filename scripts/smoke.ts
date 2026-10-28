// Runs the main-process implementation outside Electron against a repository, to check the git and gh plumbing.
// Only read methods: it never writes to the repository or GitHub.
// Usage: bun scripts/smoke.ts [directory]
import { main } from "../src/main"

const cwd = process.argv[2] ?? process.cwd()
const impl: Record<string, (input: unknown, caller: { window: number; signal: AbortSignal }) => Promise<unknown>> = {}
const ctx = {
  log: { write: () => undefined },
  provide: (_token: unknown, value: typeof impl) => {
    Object.assign(impl, value)
    return { emit: () => undefined, changed: () => undefined, dispose: () => undefined }
  },
}
// SAFETY: main reads only `log` and `provide` from its context.
await main(ctx as never)
const caller = { window: 0, signal: new AbortController().signal }
const call = (name: string, input: unknown) => impl[name]!(input, caller)

const time = async <T>(label: string, work: () => Promise<T>) => {
  const start = performance.now()
  const result = await work().catch((error: unknown) => {
    console.log(`${label} failed:`, error instanceof Error ? error.message : error)
    return undefined
  })
  console.log(`${label}: ${(performance.now() - start).toFixed(0)}ms`)
  return result
}

const overview = (await time("overview", () => call("overview", { cwd }))) as { files: { path: string; untracked: boolean }[]; remote: { owner: string; repo: string } | null; branch: string | null } | null
if (!overview) throw new Error(`${cwd} is not a git repository`)
console.log(JSON.stringify({ ...overview, files: overview.files.slice(0, 3) }, null, 2))
const log = ((await time("log", () => call("log", { cwd, limit: 300, scope: "all" }))) ?? []) as { hash: string; refs: unknown[]; subject: string }[]
console.log(log.length, log.slice(0, 3))
const branches = ((await time("branches", () => call("branches", { cwd }))) ?? []) as unknown[]
console.log(branches.length, branches.slice(0, 2))
const first = log[0]
if (first) console.log(await time("show", () => call("show", { cwd, hash: first.hash })))
const merge = log.find((commit) => (commit as unknown as { parents: string[] }).parents.length > 1)
if (merge) console.log("merge files", ((await time("show merge", () => call("show", { cwd, hash: merge.hash }))) as { files: unknown[] }).files.length)
const changed = overview.files[0]
if (changed) console.log(((await time("diff", () => call("diff", { cwd, path: changed.path, staged: false, untracked: changed.untracked }))) as string)?.slice(0, 300))
console.log(await time("show -x", () => call("show", { cwd, hash: "--output=/tmp/x" })))
console.log(await time("overview missing", () => call("overview", { cwd: "/nonexistent/dir" })))

const pulls = (await time("pulls", () => call("pulls", { cwd, fresh: true }))) as { error: string | null; items: { number: number }[] }
console.log(pulls.error, pulls.items.length, pulls.items.slice(0, 2))
const repo = overview.remote ? `${overview.remote.owner}/${overview.remote.repo}` : null
if (repo) {
  const issues = (await time("issues", () => call("issues", { cwd, state: "all", mine: false, search: "", fresh: true }))) as { error: string | null; items: unknown[] }
  console.log(issues.error, issues.items.length)
  const search = (await time("search", () => call("search", { repo, kind: "pr", query: "is:open", cursor: null }))) as { total: number; items: { number: number }[] }
  console.log(search.total, search.items.length)
  console.log(await time("prChecks", () => call("prChecks", { repo, numbers: [...pulls.items.map((pr) => pr.number).slice(0, 5), 1, -1, 1.5] })))
  const number = pulls.items[0]?.number
  if (number) {
    const item = (await time("item", () => call("item", { repo, number, fresh: true }))) as { title: string; pr: unknown }
    console.log(item?.title, !!item?.pr)
    const reviews = (await time("reviews", () => call("reviews", { repo, number }))) as { reviews: unknown[]; threads: unknown[] }
    console.log(reviews?.reviews.length, reviews?.threads.length)
    const files = (await time("prFiles", () => call("prFiles", { repo, number }))) as unknown[]
    console.log(files?.length)
  }
  const runs = (await time("runs", () => call("runs", { repo, branch: null, fresh: true }))) as unknown[]
  console.log(runs?.length)
  console.log(await time("item bad repo", () => call("item", { repo: "../../user", number: 1, fresh: true })))
}
