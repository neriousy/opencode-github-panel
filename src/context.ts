import type { ChangedFile, Check, Item, Job, Reviews, RunDetails, Thread } from "./contract"

/** What the composer quotes: the chip label, what the model is told it is, and the quoted text. */
export interface Context {
  readonly label: string
  readonly subject: string
  readonly text: string
}

const LIMIT = 24_000
// Parts that would otherwise crowd out the rest: a huge description, a pull request touching thousands of files, a
// minified line in a log.
const DESCRIPTION = 8_000
const FILES = 300
const LINE = 500

/** An issue or pull request with its conversation, review state and changed files, as Markdown for the agent. */
export function itemContext(item: Item, extra: { reviews?: Reviews; files?: readonly ChangedFile[] } = {}): Context {
  const kind = item.kind === "pr" ? "pull request" : "issue"
  const pr = item.pr
  const head = [
    `# ${item.kind === "pr" ? "Pull request" : "Issue"} ${item.repo}#${item.number}: ${item.title}`,
    "",
    `- State: ${item.draft && item.state === "OPEN" ? "draft" : item.state.toLowerCase()}`,
    `- Author: @${item.author}`,
    `- URL: ${item.url}`,
    ...(item.labels.length > 0 ? [`- Labels: ${item.labels.map((label) => label.name).join(", ")}`] : []),
    ...(item.assignees.length > 0 ? [`- Assignees: ${item.assignees.map((login) => `@${login}`).join(", ")}`] : []),
    ...(item.milestone ? [`- Milestone: ${item.milestone}`] : []),
    ...(pr
      ? [
          `- Branch: ${pr.head} → ${pr.base}${pr.cross ? " (from a fork)" : ""}`,
          `- Size: +${pr.additions} −${pr.deletions} in ${pr.files} files`,
          ...(pr.review ? [`- Review decision: ${pr.review.toLowerCase().replace(/_/g, " ")}`] : []),
          ...(pr.checks.length > 0 ? [`- Checks: ${checks(pr.checks)}`] : []),
        ]
      : []),
  ]
  const description = ["", "## Description", "", clip(item.body.trim(), DESCRIPTION) || "_No description._"]
  const threads = (extra.reviews?.threads ?? []).filter((thread) => !thread.resolved)
  const review = threads.length > 0 ? ["", `## Unresolved review threads (${threads.length})`, ...threads.flatMap((thread) => ["", ...threadLines(thread)])] : []
  const reviews = (extra.reviews?.reviews ?? []).filter((entry) => entry.state === "APPROVED" || entry.state === "CHANGES_REQUESTED" || entry.body.trim())
  const verdicts = reviews.length > 0 ? ["", "## Reviews", ...reviews.map((entry) => `- @${entry.author}: ${entry.state.toLowerCase().replace(/_/g, " ")}${entry.body.trim() ? ` — ${oneLine(entry.body)}` : ""}`)] : []
  const files =
    extra.files && extra.files.length > 0
      ? [
          "",
          "## Changed files",
          ...extra.files.slice(0, FILES).map((file) => `- ${file.status} ${file.path} (+${file.additions} −${file.deletions})`),
          ...(extra.files.length > FILES ? [`- _${extra.files.length - FILES} more files omitted._`] : []),
        ]
      : []
  // The newest comments matter most; older ones go first when the text is too long.
  const comments = item.comments.map((comment) => ["", `### @${comment.author} (${comment.created.slice(0, 10)})`, "", clip(comment.body.trim(), DESCRIPTION)].join("\n"))
  const fixed = [...head, ...description, ...verdicts, ...review, ...files].join("\n")
  const kept: string[] = []
  let size = fixed.length
  for (const comment of [...comments].reverse()) {
    if (size + comment.length > LIMIT) break
    kept.unshift(comment)
    size += comment.length
  }
  const dropped = comments.length - kept.length
  const conversation = comments.length > 0 ? ["", `## Comments (${comments.length})`, ...(dropped > 0 ? ["", `_${dropped} older comments omitted._`] : []), ...kept] : []
  return {
    label: `#${item.number}`,
    subject: `the GitHub ${kind} ${item.repo}#${item.number} (${item.url})`,
    text: clip([fixed, ...conversation].join("\n")),
  }
}

export function threadContext(item: Item, thread: Thread): Context {
  return {
    label: `${thread.path.split("/").pop()}${thread.line ? `:${thread.line}` : ""}`,
    subject: `a review thread on ${item.repo}#${item.number} (${item.url}), file ${thread.path}${thread.line ? ` line ${thread.line}` : ""}`,
    text: clip(threadLines(thread).join("\n")),
  }
}

/** A failed (or any) job: its steps and the part of the log around the first error. */
export function jobContext(repo: string, details: RunDetails, job: Job, log: string): Context {
  const lines = log.split("\n")
  const first = lines.findIndex((line) => line.startsWith("##[error]"))
  const start = first === -1 ? Math.max(0, lines.length - 150) : Math.max(0, first - 100)
  const steps = job.steps.map((step) => `- ${step.conclusion || step.status}: ${step.name}`)
  return {
    label: job.name,
    subject: `the GitHub Actions job "${job.name}" of workflow "${details.run.workflow}" in ${repo} (${details.run.url})`,
    text: clip(
      [
        `# ${details.run.workflow} / ${job.name}: ${job.conclusion || job.status}`,
        "",
        `- Run: ${details.run.title} (${details.run.url})`,
        `- Branch: ${details.run.branch} at ${details.run.sha.slice(0, 7)}, triggered by ${details.run.event}`,
        "",
        "## Steps",
        ...steps,
        "",
        `## Log${start > 0 ? ` (from line ${start + 1})` : ""}`,
        "",
        ...lines.slice(start, start + 200).map((line) => (line.length > LINE ? `${line.slice(0, LINE)}…` : line)),
      ].join("\n"),
    ),
  }
}

export function fileContext(path: string, patch: string, where: string): Context {
  return {
    label: path.split("/").pop() ?? path,
    subject: `the diff of ${path} ${where}`,
    text: clip(`diff of ${path}\n\n${patch}`),
  }
}

function threadLines(thread: Thread) {
  const hunk = (thread.comments[0]?.hunk ?? "").split("\n").slice(-6).join("\n")
  return [
    `### ${thread.path}${thread.line ? `:${thread.line}` : ""}${thread.outdated ? " (outdated)" : ""}`,
    "",
    "```diff",
    hunk,
    "```",
    ...thread.comments.flatMap((comment) => ["", `@${comment.author}: ${comment.body.trim()}`]),
  ]
}

function checks(list: readonly Check[]) {
  const failed = list.filter((check) => check.state === "failure").map((check) => check.name)
  const pending = list.filter((check) => check.state === "pending").length
  const passed = list.filter((check) => check.state === "success").length
  return [failed.length > 0 ? `failing: ${failed.join(", ")}` : "", pending > 0 ? `${pending} running` : "", `${passed} passed`].filter(Boolean).join("; ")
}

function oneLine(text: string) {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

/** Text cut to a size, saying how much was left out. */
export function clip(text: string, limit = LIMIT) {
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters omitted)` : text
}
