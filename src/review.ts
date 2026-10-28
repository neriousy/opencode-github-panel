import { join, resolve } from "node:path"
import { Option, Schema } from "effect"
import type { Plugin } from "@opencode/plugin"
import type { Backend, BackendDeps, BackendKit } from "./backend"
import { diffText, editDraft, MAX_COMMENTS, parseReview, placementError, splitDrift, withMoved } from "./draft"
import { checkRepo } from "./plan"
import { DraftReview, type DiffSide, type ReviewEvent } from "./schemas"

// One read-modify-write of a draft at a time.
const locks = new Map<string, Promise<unknown>>()

function serialize<T>(key: string, work: () => Promise<T>) {
  const next = (locks.get(key) ?? Promise.resolve()).then(work, work)
  const settled = next.catch(() => undefined)
  locks.set(key, settled)
  void settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key)
  })
  return next
}

const prefix = (repo: string, number: number) => `review/${repo.toLowerCase()}#${number}/`
const draftKey = (repo: string, number: number, sessionID: string) => `${prefix(repo, number)}${sessionID}`

/**
 * Review mode in the server part: the agent's `review` tool drafts a review the user edits and submits in the panel,
 * and `diff` gives it the numbered diff to place comments by. Drafts live in plugin storage under
 * `review/<owner/name>#<number>/<sessionID>`, one per session and pull request; nothing reaches GitHub until the user
 * submits.
 */
export function createReview(input: { ctx: Plugin.Context; backend: Backend; kit: BackendKit; emit: BackendDeps["emit"] }) {
  const ctx = input.ctx
  const backend = input.backend

  const decode = (value: unknown) => Option.getOrUndefined(Schema.decodeUnknownOption(DraftReview)(value))
  const load = async (repo: string, number: number, sessionID: string) => decode(await ctx.storage.get(draftKey(repo, number, sessionID)))
  const store = async (draft: DraftReview) => {
    await ctx.storage.set(draftKey(draft.repo, draft.number, draft.sessionID), JSON.parse(JSON.stringify(draft)))
    input.emit("review", { repo: draft.repo, number: draft.number })
    return draft
  }
  const drop = async (repo: string, number: number, sessionID: string) => {
    await ctx.storage.remove(draftKey(repo, number, sessionID))
    input.emit("review", { repo, number })
  }
  const change = (repo: string, number: number, sessionID: string, work: (draft: DraftReview | undefined) => Promise<DraftReview>) =>
    serialize(draftKey(repo, number, sessionID), async () => store(await work(await load(repo, number, sessionID))))

  /** The open pull request with its head and changed files at that head. */
  const pullRequest = async (repo: string, number: number) => {
    const item = await backend.item({ repo, number, fresh: true }, {})
    if (item.kind !== "pr" || !item.pr) throw new Error(`${repo}#${number} is an issue, not a pull request.`)
    const sha = item.pr.sha
    return { item, sha, files: await backend.prFiles({ repo, number, head: sha }, {}) }
  }

  const repoOf = async (sessionID: string, repo: string | null) => {
    if (repo) return repo
    const session = await ctx.session.get({ sessionID }).catch(() => undefined)
    const directory = resolve(session ? join(session.location.directory, session.subpath ?? "") : ctx.location.directory)
    const found = await input.kit.repoOf(directory).catch(() => null)
    if (!found) throw new Error("This session's directory has no GitHub remote; pass `repo` as owner/name.")
    return found
  }

  // The tools.

  const draftTool = async (raw: unknown, sessionID: string) => {
    const review = parseReview(raw, checkRepo)
    const repo = await repoOf(sessionID, review.repo)
    const number = review.number
    const [pr, mine] = await Promise.all([pullRequest(repo, number), input.kit.github.reviews({ repo, number }).then((found) => found.mine, () => false)])
    if (pr.item.state !== "OPEN") throw new Error(`${repo}#${number} is ${pr.item.state.toLowerCase()}; only an open pull request can be reviewed.`)
    const problems = review.comments.flatMap((comment, index) => {
      const error = placementError(pr.files, comment)
      return error ? [`- comments[${index}] (${comment.path}:${comment.line}): ${error}`] : []
    })
    if (problems.length > 0)
      throw new Error(
        [
          `Nothing was drafted: ${problems.length} of ${review.comments.length} comments are not on lines of the diff at the head (${pr.sha.slice(0, 7)}). Fix them and call again with every comment; use the diff tool for line numbers.`,
          ...problems,
        ].join("\n"),
      )
    const event: ReviewEvent = mine && review.event !== "COMMENT" ? "COMMENT" : review.event
    const now = Date.now()
    const replaced = await load(repo, number, sessionID)
    await change(repo, number, sessionID, async () => ({
      sessionID,
      repo,
      number,
      sha: pr.sha,
      summary: review.summary,
      event,
      note: review.note,
      source: "agent",
      comments: review.comments.map((comment) => ({ id: commentId(), ...comment, source: "agent", edited: false })),
      createdAt: now,
      updatedAt: now,
    }))
    return [
      `Drafted a review of #${number} with ${review.comments.length} inline comment${review.comments.length === 1 ? "" : "s"}. The user reviews and submits it in the GitHub panel.`,
      ...(event !== review.event ? [`The suggested verdict is "COMMENT": GitHub does not let the user ${review.event === "APPROVE" ? "approve" : "request changes on"} their own pull request.`] : []),
      ...(replaced ? ["It replaces the draft you made earlier in this session."] : []),
      "Don't submit it another way (such as gh in the shell); stop here unless the user asks for more.",
    ].join("\n")
  }

  const diffTool = async (raw: unknown, sessionID: string) => {
    const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
    const number = Number(typeof value.number === "string" ? value.number.replace("#", "") : value.number)
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error("`number` must be a positive whole number.")
    const repo = await repoOf(sessionID, value.repo ? checkRepo(value.repo) : null)
    const pr = await pullRequest(repo, number)
    const path = typeof value.path === "string" && value.path.trim() ? value.path.trim().replace(/^\.?\//, "") : null
    return `# ${repo}#${number} at ${pr.sha.slice(0, 7)}: ${pr.item.title}\n\n${diffText(pr.files, path)}`
  }

  // The RPC methods the window edits and submits drafts with.

  type Ref = { sessionID: string; repo: string; number: number }

  const methods = {
    reviewDrafts: async ({ repo, number, sessionID }: { repo: string; number: number; sessionID: string | null }) => {
      const found = await ctx.storage.scan({ prefix: prefix(repo, number), limit: 100 })
      return found.entries
        .flatMap((entry) => decode(entry.value) ?? [])
        .sort((a, b) => Number(b.sessionID === sessionID) - Number(a.sessionID === sessionID) || b.updatedAt - a.updatedAt)
    },
    reviewEdit: async (edit: Ref & {
      summary?: string
      event?: ReviewEvent
      update?: { id: string; body: string }
      remove?: string
      add?: { path: string; line: number; side: DiffSide; startLine: number | null; body: string }
      sha?: string
    }) => {
      const add = edit.add
      // A new comment must land on the diff it will be submitted against.
      const files = add ? (await pullRequest(edit.repo, edit.number)).files : []
      const error = add ? placementError(files, add) : undefined
      if (error) throw new Error(error)
      return change(edit.repo, edit.number, edit.sessionID, async (draft) => {
        const now = Date.now()
        const base: DraftReview | undefined =
          draft ??
          (add && edit.sha
            ? { sessionID: edit.sessionID, repo: edit.repo, number: edit.number, sha: edit.sha, summary: "", event: "COMMENT", note: "", source: "user", comments: [], createdAt: now, updatedAt: now }
            : undefined)
        if (!base) throw new Error("This draft review is gone: it was submitted or discarded.")
        return editDraft(
          base,
          { summary: edit.summary, event: edit.event, update: edit.update, remove: edit.remove, add: add ? { id: commentId(), ...add, source: "user", edited: false } : undefined },
          now,
        )
      })
    },
    reviewDiscard: async ({ sessionID, repo, number }: Ref) => {
      await serialize(draftKey(repo, number, sessionID), () => drop(repo, number, sessionID))
      return "Draft review discarded."
    },
    reviewSubmit: async ({ sessionID, repo, number, force }: Ref & { force: boolean }) =>
      serialize(draftKey(repo, number, sessionID), async () => {
        const draft = await load(repo, number, sessionID)
        if (!draft) throw new Error("This draft review is gone: it was submitted or discarded.")
        const pr = await pullRequest(repo, number)
        if (pr.item.state !== "OPEN") throw new Error(`#${number} is ${pr.item.state.toLowerCase()}; GitHub takes reviews only on open pull requests.`)
        const split = splitDrift(draft.comments, pr.files)
        if (pr.sha !== draft.sha && !force) {
          return {
            submitted: false,
            url: null,
            moved: split.moved,
            message: `#${number} has new commits since this review was drafted.${split.moved.length > 0 ? ` ${split.moved.length} of ${draft.comments.length} comments are on lines no longer in the diff; submitting moves them into the summary.` : " Every comment's line is still in the diff."}`,
          }
        }
        const body = withMoved(draft.summary, split.moved)
        if (draft.event === "REQUEST_CHANGES" && !body.trim()) throw new Error("Requesting changes needs a summary.")
        if (draft.event === "COMMENT" && !body.trim() && split.valid.length === 0) throw new Error("Write a summary or add a comment first.")
        const url = await input.kit.github.createReview({ repo, number, sha: pr.sha, event: draft.event, body, comments: split.valid })
        await drop(repo, number, sessionID)
        return {
          submitted: true,
          url: url || null,
          moved: split.moved,
          message: `Review submitted with ${split.valid.length} inline comment${split.valid.length === 1 ? "" : "s"}${split.moved.length > 0 ? `; ${split.moved.length} moved into the summary` : ""}.`,
        }
      }),
  }

  /** Registers the tools; the returned function removes them. */
  const start = async () => {
    const tools = await ctx.tool.transform((editor) => {
      const options = { namespace: NAMESPACE, codemode: true, pinned: true } as const
      editor.add({
        name: "review",
        description: REVIEW_DESCRIPTION,
        input: REVIEW_INPUT,
        options,
        execute: async (raw, context) => ({ content: await draftTool(raw, context.sessionID) }),
      })
      editor.add({
        name: "diff",
        description: DIFF_DESCRIPTION,
        input: DIFF_INPUT,
        options,
        execute: async (raw, context) => ({ content: await diffTool(raw, context.sessionID) }),
      })
    })
    return () => tools.dispose()
  }

  return { methods, start }
}

function commentId() {
  return `c_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
}

const NAMESPACE = "github_panel"

const REPO = {
  type: "string",
  description: "Repository as owner/name. Omit it to use the GitHub repository of this session's working directory.",
} as const

const DIFF_DESCRIPTION =
  "Read a pull request's changed files with their diffs, each line numbered with its old (LEFT) and new (RIGHT) line number, and the line ranges review comments can go on per file. Long diffs are cut; pass `path` to read one file in full. Read-only, runs at once. Use it before the `review` tool to place inline comments."

const DIFF_INPUT = {
  type: "object",
  properties: {
    number: { type: "integer", minimum: 1, description: "The pull request number." },
    repo: REPO,
    path: { type: "string", description: "Only this file, shown in full." },
  },
  required: ["number"],
  additionalProperties: false,
} as const

const REVIEW_DESCRIPTION = `Draft a review of a pull request: a summary, a suggested verdict and inline comments on lines of its diff. Nothing is posted: the draft appears in the user's GitHub panel, where they edit, add to and submit it (or discard it). Every comment must be on a line inside a hunk of the current diff (see the \`diff\` tool): RIGHT with the new line number for added or unchanged lines, LEFT with the old number for removed lines; \`start_line\` makes it span lines of one hunk. An invalid line rejects the whole call with the valid ranges, so nothing is half drafted. For a small concrete fix, put a GitHub suggestion block in the body (\`\`\`suggestion … \`\`\`) holding the replacement for the commented lines. Calling it again for the same pull request replaces this session's draft. Up to ${MAX_COMMENTS} comments.`

const REVIEW_INPUT = {
  type: "object",
  properties: {
    number: { type: "integer", minimum: 1, description: "The pull request number." },
    repo: REPO,
    summary: { type: "string", minLength: 1, description: "The review's body in GitHub Markdown: the verdict in a sentence, then the main points." },
    event: {
      type: "string",
      enum: ["COMMENT", "REQUEST_CHANGES", "APPROVE"],
      description: 'The suggested verdict: "REQUEST_CHANGES" for problems that must be fixed, "APPROVE" when it is ready, else "COMMENT". Defaults to "COMMENT". The user decides.',
    },
    comments: {
      type: "array",
      maxItems: MAX_COMMENTS,
      description: "Inline comments, each on a line of the diff.",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file's path in the repository, as the diff lists it." },
          line: { type: "integer", minimum: 1, description: "The line the comment is on (the last line, with start_line)." },
          side: { type: "string", enum: ["RIGHT", "LEFT"], description: 'RIGHT (default): the new file\'s line number. LEFT: the old file\'s, for removed lines.' },
          start_line: { type: "integer", minimum: 1, description: "For a comment on several lines: the first one, in the same hunk and on the same side." },
          body: { type: "string", minLength: 1, description: "The comment in GitHub Markdown; may hold a ```suggestion block replacing the commented lines." },
        },
        required: ["path", "line", "body"],
        additionalProperties: false,
      },
    },
    note: { type: "string", description: "One short sentence for the user about this review, shown with the draft." },
  },
  required: ["number", "summary", "note"],
  additionalProperties: false,
} as const
