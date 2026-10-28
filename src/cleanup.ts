import type { Branch, PullRequest } from "./contract"

/** Why a local branch looks done with. */
export type CleanupReason =
  | { readonly kind: "merged-pr" | "closed-pr"; readonly number: number }
  | { readonly kind: "gone" }
  | { readonly kind: "merged"; readonly base: string }

export interface CleanupCandidate {
  readonly name: string
  readonly reasons: readonly CleanupReason[]
  /**
   * Commits deleting it could lose, so it starts unchecked: `unpushed` ones its upstream lacks, commits `moved` on
   * after its pull request with no remote branch left, or `unmerged` work whose remote branch is gone.
   */
  readonly risk: "unpushed" | "moved" | "unmerged" | null
}

/**
 * Local branches that look done with: their pull request is merged or closed, their upstream was deleted, or they are
 * merged into the default branch. Never the current or the default branch, nor one with an open pull request.
 */
export function cleanupCandidates(input: {
  readonly branches: readonly Branch[]
  readonly current: string | null
  readonly base: string | null
  readonly merged: readonly string[]
  readonly pullFor: (name: string) => PullRequest | undefined
}): CleanupCandidate[] {
  return input.branches.flatMap((branch): CleanupCandidate[] => {
    if (branch.remote || branch.current || branch.name === input.current || branch.name === input.base) return []
    const pr = input.pullFor(branch.name)
    if (pr?.state === "OPEN") return []
    const merged = input.merged.includes(branch.name)
    const reasons: CleanupReason[] = [
      ...(pr ? [{ kind: pr.state === "MERGED" ? ("merged-pr" as const) : ("closed-pr" as const), number: pr.number }] : []),
      ...(branch.gone ? [{ kind: "gone" as const }] : []),
      ...(merged && input.base ? [{ kind: "merged" as const, base: input.base }] : []),
    ]
    if (reasons.length === 0) return []
    return [{ name: branch.name, reasons, risk: merged ? null : risk(branch, pr) }]
  })
}

function risk(branch: Branch, pr: PullRequest | undefined): CleanupCandidate["risk"] {
  if (branch.ahead > 0) return "unpushed"
  const published = !!branch.upstream && !branch.gone
  // GitHub keeps a pull request's commits after its branch is deleted; only commits made after it are at stake.
  if (pr) return !published && pr.sha && !pr.sha.startsWith(branch.sha) ? "moved" : null
  return published ? null : "unmerged"
}
