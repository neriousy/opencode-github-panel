import type { ItemRef } from "./contract"

/** What a side tab of this plugin shows, besides the main Git panel. `~` appears in no GitHub owner or repo name. */
export type TabTarget =
  | { readonly kind: "item"; readonly ref: ItemRef }
  | { readonly kind: "run"; readonly repo: string; readonly id: number }
  | { readonly kind: "commit"; readonly repo: string; readonly sha: string }

export function tabId(target: TabTarget) {
  if (target.kind === "item") return `ref~${target.ref.repo.replace("/", "~")}~${target.ref.number}`
  if (target.kind === "run") return `run~${target.repo.replace("/", "~")}~${target.id}`
  return `commit~${target.repo.replace("/", "~")}~${target.sha}`
}

export function parseTab(id: string): TabTarget | undefined {
  const match = /^(ref|run|commit)~([^~]+)~([^~]+)~([^~]+)$/.exec(id)
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return undefined
  const repo = `${match[2]}/${match[3]}`
  if (match[1] === "ref" && /^\d+$/.test(match[4])) return { kind: "item", ref: { repo, number: Number(match[4]) } }
  if (match[1] === "run" && /^\d+$/.test(match[4])) return { kind: "run", repo, id: Number(match[4]) }
  if (match[1] === "commit" && /^[0-9a-f]{7,40}$/.test(match[4])) return { kind: "commit", repo, sha: match[4] }
  return undefined
}
