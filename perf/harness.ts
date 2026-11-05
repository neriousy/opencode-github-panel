import { FIELD, parseLog, parsePatch, RECORD } from "../src/git"
import { layout } from "../src/graph"

// What strobe's script target calls: the panel's own work on its biggest inputs, with no git, gh or network, so a run
// measures this code only. Inputs come from a fixed seed, so every variant parses the same text.

/** mulberry32: a small seeded generator, so the inputs are the same every run. */
const random = (seed: number) => {
  const state = { seed }
  return () => {
    state.seed = (state.seed + 0x6d2b79f5) | 0
    const a = Math.imul(state.seed ^ (state.seed >>> 15), 1 | state.seed)
    const b = (a + Math.imul(a ^ (a >>> 7), 61 | a)) ^ a
    return (b ^ (b >>> 14)) >>> 0
  }
}

const hash = (index: number) => index.toString(16).padStart(40, "0")

/** `git log --format=LOG_FORMAT` of a history with side branches merged every few commits, as busy repositories have. */
function history(count: number) {
  const next = random(count)
  return Array.from({ length: count }, (_, index) => {
    const merge = index % 6 === 0 && index + 2 < count
    const parents = [index + 1, ...(merge ? [index + 2 + (next() % 30)] : [])].filter((parent) => parent < count).map(hash)
    const refs = index === 0 ? "HEAD -> refs/heads/main, refs/remotes/origin/main" : index % 50 === 0 ? `refs/remotes/origin/feature-${index}` : ""
    return [hash(index), parents.join(" "), `Author ${next() % 40}`, "a@example.com", String(1_800_000_000 - index * 600), `fix: change number ${index}`, refs].join(FIELD)
  }).join(`${RECORD}\n`)
}

/** A unified diff of `files` files with a few hunks each, as a pull request's Files section reads them. */
function patches(files: number) {
  const next = random(files)
  return Array.from({ length: files }, () =>
    Array.from({ length: 4 }, (_, hunk) => {
      const start = hunk * 120 + 1
      const lines = Array.from({ length: 40 }, () => {
        const roll = next() % 10
        return `${roll < 2 ? "-" : roll < 5 ? "+" : " "}  const value${next() % 1000} = compute(${next() % 100}, "${next().toString(36)}")`
      })
      return [`@@ -${start},40 +${start},40 @@ function section${hunk}()`, ...lines].join("\n")
    }).join("\n"),
  )
}

const inputs = new Map<string, unknown>()
const input = <T>(key: string, make: () => T) => {
  if (!inputs.has(key)) inputs.set(key, make())
  return inputs.get(key) as T
}

/** The History tab: parse the log and lay out the graph. */
export function graph(count: number) {
  const commits = parseLog(input(`log:${count}`, () => history(count)))
  return layout(commits).length
}

/** A pull request's Files section: parse every file's patch into lines. */
export function diff(files: number) {
  return input(`patch:${files}`, () => patches(files)).reduce((total, patch) => total + parsePatch(patch).length, 0)
}
