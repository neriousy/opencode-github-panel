import { Schema } from "effect"

// Schemas shared by every part of the plugin. No window, main or server imports here: each part loads this file.

export const FileChange = Schema.Struct({
  path: Schema.String,
  origPath: Schema.NullOr(Schema.String),
  /** Porcelain v2 index status: M, A, D, R, C, T, U or "." for unchanged. */
  index: Schema.String,
  /** Porcelain v2 work tree status, with "?" for untracked files. */
  worktree: Schema.String,
  conflicted: Schema.Boolean,
  untracked: Schema.Boolean,
})
export type FileChange = typeof FileChange.Type

export const Remote = Schema.Struct({
  name: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  /** https://github.com/<owner>/<repo> */
  web: Schema.String,
})
export type Remote = typeof Remote.Type

export const Overview = Schema.Struct({
  root: Schema.String,
  name: Schema.String,
  branch: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  upstream: Schema.NullOr(Schema.String),
  ahead: Schema.Number,
  behind: Schema.Number,
  remote: Schema.NullOr(Remote),
  defaultBranch: Schema.NullOr(Schema.String),
  operation: Schema.NullOr(Schema.Literals(["merge", "rebase", "am", "cherry-pick", "revert"])),
  stashes: Schema.Number,
  files: Schema.Array(FileChange),
})
export type Overview = typeof Overview.Type

export const Ref = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["head", "local", "remote", "tag"]),
})
export type Ref = typeof Ref.Type

export const Commit = Schema.Struct({
  hash: Schema.String,
  parents: Schema.Array(Schema.String),
  author: Schema.String,
  email: Schema.String,
  date: Schema.Number,
  subject: Schema.String,
  refs: Schema.Array(Ref),
})
export type Commit = typeof Commit.Type

export const CommitDetails = Schema.Struct({
  hash: Schema.String,
  author: Schema.String,
  email: Schema.String,
  date: Schema.Number,
  body: Schema.String,
  files: Schema.Array(Schema.Struct({ status: Schema.String, path: Schema.String })),
})
export type CommitDetails = typeof CommitDetails.Type

export const Branch = Schema.Struct({
  name: Schema.String,
  remote: Schema.Boolean,
  current: Schema.Boolean,
  upstream: Schema.NullOr(Schema.String),
  ahead: Schema.Number,
  behind: Schema.Number,
  gone: Schema.Boolean,
  sha: Schema.String,
  date: Schema.Number,
  subject: Schema.String,
  /** The folder of another worktree this local branch is checked out in; git refuses to check it out here or delete it. */
  worktree: Schema.optional(Schema.String),
})
export type Branch = typeof Branch.Type

export const PullRequest = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  draft: Schema.Boolean,
  url: Schema.String,
  head: Schema.String,
  /** The head branch lives in a fork, so a local branch of the same name is not this pull request's branch. */
  cross: Schema.Boolean,
  base: Schema.String,
  author: Schema.String,
  review: Schema.NullOr(Schema.String),
  checks: Schema.Literals(["success", "failure", "pending", "none"]),
  updated: Schema.String,
  /** The head commit, when the source reports it: a local branch at another commit has moved on since. */
  sha: Schema.optional(Schema.String),
})
export type PullRequest = typeof PullRequest.Type

export const Pulls = Schema.Struct({
  /** Why pull requests could not be read: gh missing, not signed in, or not a GitHub repository. */
  error: Schema.NullOr(Schema.String),
  items: Schema.Array(PullRequest),
})
export type Pulls = typeof Pulls.Type

export const Label = Schema.Struct({ name: Schema.String, color: Schema.String })
export type Label = typeof Label.Type

export const Issue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  url: Schema.String,
  author: Schema.String,
  labels: Schema.Array(Label),
  assignees: Schema.Array(Schema.String),
  updated: Schema.String,
})
export type Issue = typeof Issue.Type

export const Issues = Schema.Struct({
  error: Schema.NullOr(Schema.String),
  items: Schema.Array(Issue),
})
export type Issues = typeof Issues.Type

/** An issue or pull request named by its repository and number, as the timeline and the panel mention them. */
export const ItemRef = Schema.Struct({ repo: Schema.String, number: Schema.Number })
export type ItemRef = typeof ItemRef.Type

export const Comment = Schema.Struct({ author: Schema.String, body: Schema.String, created: Schema.String })

export const Check = Schema.Struct({
  name: Schema.String,
  state: Schema.Literals(["success", "failure", "pending", "skipped"]),
  url: Schema.NullOr(Schema.String),
})
export type Check = typeof Check.Type

/** One issue or pull request with its conversation, read on demand for a detail tab or a hover card. */
export const Item = Schema.Struct({
  kind: Schema.Literals(["issue", "pr"]),
  repo: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  draft: Schema.Boolean,
  url: Schema.String,
  author: Schema.String,
  body: Schema.String,
  labels: Schema.Array(Label),
  assignees: Schema.Array(Schema.String),
  milestone: Schema.NullOr(Schema.String),
  created: Schema.String,
  updated: Schema.String,
  comments: Schema.Array(Comment),
  pr: Schema.NullOr(
    Schema.Struct({
      head: Schema.String,
      sha: Schema.String,
      requested: Schema.Array(Schema.String),
      base: Schema.String,
      cross: Schema.Boolean,
      additions: Schema.Number,
      deletions: Schema.Number,
      files: Schema.Number,
      review: Schema.NullOr(Schema.String),
      mergeable: Schema.String,
      checks: Schema.Array(Check),
    }),
  ),
  /** For an issue, the pull requests that close it; for a pull request, the issues it closes. */
  links: Schema.optional(Schema.Array(ItemRef)),
})
export type Item = typeof Item.Type

/** A file a pull request or commit changes, with its unified diff when GitHub returns one (not for binaries or huge files). */
export const ChangedFile = Schema.Struct({
  path: Schema.String,
  previous: Schema.NullOr(Schema.String),
  status: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  patch: Schema.NullOr(Schema.String),
})
export type ChangedFile = typeof ChangedFile.Type

export const ThreadComment = Schema.Struct({
  id: Schema.String,
  author: Schema.String,
  body: Schema.String,
  created: Schema.String,
  hunk: Schema.String,
})

export const Thread = Schema.Struct({
  id: Schema.String,
  resolved: Schema.Boolean,
  outdated: Schema.Boolean,
  path: Schema.String,
  line: Schema.NullOr(Schema.Number),
  side: Schema.String,
  comments: Schema.Array(ThreadComment),
})
export type Thread = typeof Thread.Type

export const Review = Schema.Struct({
  id: Schema.String,
  author: Schema.String,
  state: Schema.String,
  body: Schema.String,
  submitted: Schema.NullOr(Schema.String),
})
export type Review = typeof Review.Type

/** A pull request's reviews and inline review threads. */
export const Reviews = Schema.Struct({
  reviews: Schema.Array(Review),
  threads: Schema.Array(Thread),
  mine: Schema.Boolean,
})
export type Reviews = typeof Reviews.Type

export const RemoteCommit = Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  message: Schema.String,
  author: Schema.String,
  date: Schema.String,
  url: Schema.String,
  parents: Schema.Array(Schema.String),
  files: Schema.Array(ChangedFile),
})
export type RemoteCommit = typeof RemoteCommit.Type

export const Run = Schema.Struct({
  id: Schema.Number,
  title: Schema.String,
  workflow: Schema.String,
  status: Schema.String,
  conclusion: Schema.String,
  branch: Schema.String,
  event: Schema.String,
  sha: Schema.String,
  created: Schema.String,
  url: Schema.String,
  attempt: Schema.Number,
})
export type Run = typeof Run.Type

export const Step = Schema.Struct({ number: Schema.Number, name: Schema.String, status: Schema.String, conclusion: Schema.String })

export const Job = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.String,
  started: Schema.NullOr(Schema.String),
  completed: Schema.NullOr(Schema.String),
  steps: Schema.Array(Step),
})
export type Job = typeof Job.Type

export const RunDetails = Schema.Struct({ run: Run, jobs: Schema.Array(Job) })
export type RunDetails = typeof RunDetails.Type

export const RepoMeta = Schema.Struct({
  labels: Schema.Array(Label),
  people: Schema.Array(Schema.String),
  milestones: Schema.Array(Schema.String),
})
export type RepoMeta = typeof RepoMeta.Type

export const InboxEntry = Schema.Struct({
  /** The notification thread, for marking it read; null for entries that come from a search. */
  thread: Schema.NullOr(Schema.String),
  repo: Schema.String,
  number: Schema.NullOr(Schema.Number),
  kind: Schema.Literals(["issue", "pr", "other"]),
  title: Schema.String,
  reason: Schema.String,
  updated: Schema.String,
  unread: Schema.Boolean,
  url: Schema.String,
})
export type InboxEntry = typeof InboxEntry.Type

export const Inbox = Schema.Struct({
  error: Schema.NullOr(Schema.String),
  notifications: Schema.Array(InboxEntry),
  reviews: Schema.Array(InboxEntry),
  assigned: Schema.Array(InboxEntry),
  authored: Schema.Array(InboxEntry),
})
export type Inbox = typeof Inbox.Type

/** One row of a pull request or issue search. */
export const SearchItem = Schema.Struct({
  kind: Schema.Literals(["issue", "pr"]),
  repo: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  draft: Schema.Boolean,
  url: Schema.String,
  author: Schema.String,
  labels: Schema.Array(Label),
  comments: Schema.Number,
  /** When it was opened, as an ISO date. */
  created: Schema.String,
  updated: Schema.String,
  head: Schema.NullOr(Schema.String),
  base: Schema.NullOr(Schema.String),
  review: Schema.NullOr(Schema.String),
  checks: Schema.Literals(["success", "failure", "pending", "none"]),
})
export type SearchItem = typeof SearchItem.Type

/** One page of search results; `cursor` asks for the next page. */
export const SearchPage = Schema.Struct({
  total: Schema.Number,
  items: Schema.Array(SearchItem),
  cursor: Schema.NullOr(Schema.String),
})
export type SearchPage = typeof SearchPage.Type

export const AgentKind = Schema.Literals(["comment", "close", "reopen", "label", "assign", "uncomment", "other"])
export type AgentKind = typeof AgentKind.Type
export const AgentStatus = Schema.Literals(["proposed", "approved", "running", "done", "failed", "skipped", "undone"])
export type AgentStatus = typeof AgentStatus.Type
export const CloseReason = Schema.Literals(["completed", "not_planned", "duplicate"])
export type CloseReason = typeof CloseReason.Type

/** What an agent action does: the comment, the close reason, the labels or people to add and remove. */
export const AgentPayload = Schema.Struct({
  body: Schema.optional(Schema.String),
  reason: Schema.optional(CloseReason),
  duplicateOf: Schema.optional(Schema.Number),
  add: Schema.optional(Schema.Array(Schema.String)),
  remove: Schema.optional(Schema.Array(Schema.String)),
  /** The comment an `uncomment` deletes, or a close or reopen's own comment that its undo deletes. */
  commentId: Schema.optional(Schema.Number),
  /** The command line of a `gh` command the agent ran in the shell. */
  command: Schema.optional(Schema.String),
})
export type AgentPayload = typeof AgentPayload.Type

/** What running an action changed, for its undo: the comment it posted, the state it left, the labels it really added. */
export const AgentResult = Schema.Struct({
  commentId: Schema.optional(Schema.Number),
  url: Schema.optional(Schema.String),
  /** The close reason an item had before a reopen. */
  reason: Schema.optional(CloseReason),
  added: Schema.optional(Schema.Array(Schema.String)),
  removed: Schema.optional(Schema.Array(Schema.String)),
  /** The item was already in the asked state, so nothing changed. */
  noop: Schema.optional(Schema.Boolean),
})
export type AgentResult = typeof AgentResult.Type

/** A GitHub write an agent proposed, ran in the shell, or the user undid, per session. */
export const AgentAction = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  /** Actions from one tool call share a batch. */
  batch: Schema.String,
  repo: Schema.String,
  number: Schema.Number,
  item: Schema.NullOr(Schema.Literals(["issue", "pr"])),
  title: Schema.String,
  kind: AgentKind,
  payload: AgentPayload,
  /** The agent's reason, shown to the user. */
  note: Schema.String,
  status: AgentStatus,
  error: Schema.NullOr(Schema.String),
  result: Schema.NullOr(AgentResult),
  source: Schema.Literals(["tool", "shell", "user"]),
  /** The action this one undoes. */
  undoOf: Schema.NullOr(Schema.String),
  /** The action that undid this one. */
  undoneBy: Schema.NullOr(Schema.String),
  /** The user changed what the agent proposed. */
  edited: Schema.optional(Schema.Boolean),
  /** What the agent proposed before the user's first edit. */
  original: Schema.optional(AgentPayload),
  /** The triage batch it was proposed in, in a session with a triage run. */
  round: Schema.optional(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type AgentAction = typeof AgentAction.Type

export const SavedReply = Schema.Struct({ name: Schema.String, body: Schema.String })

/** What the user asks for when starting a triage run: the items, the rules, the replies to use. */
export const TriageStart = Schema.Struct({
  repo: Schema.String,
  kind: Schema.Literals(["issue", "pr"]),
  /** The search it goes through, GitHub syntax without `repo:`; null when it goes through `numbers`. */
  query: Schema.NullOr(Schema.String),
  numbers: Schema.Array(Schema.Number),
  rules: Schema.String,
  replies: Schema.Array(SavedReply),
  /** Items per batch the agent reviews before waiting for the user. */
  batch: Schema.Number,
  /** How many items it covers, as counted when it started. */
  total: Schema.Number,
})
export type TriageStart = typeof TriageStart.Type

/** A triage run of a session, kept with its queue. */
export const AgentTriage = Schema.Struct({
  ...TriageStart.fields,
  /** The batch new proposals join; the agent's next look at its actions closes it. */
  round: Schema.Number,
  /** Items the agent said it reviewed, with a proposal or without. */
  reviewed: Schema.Array(Schema.Number),
  /** When the agent last read its actions: decisions since are news to it. */
  checkedAt: Schema.Number,
  createdAt: Schema.Number,
})
export type AgentTriage = typeof AgentTriage.Type

/** One session's agent actions, oldest first, whether its writes run without asking, and its triage run. */
export const AgentQueue = Schema.Struct({ auto: Schema.Boolean, actions: Schema.Array(AgentAction), triage: Schema.optional(AgentTriage) })
export type AgentQueue = typeof AgentQueue.Type

export const WriteKind = Schema.Literals(["comment", "close", "reopen", "label", "assign"])

const Cwd = Schema.Struct({ cwd: Schema.String })
const Paths = Schema.Struct({ cwd: Schema.String, paths: Schema.Array(Schema.String) })
const Output = Schema.String

/** Every operation of the plugin, by name. The main process serves them over an Ipc, the server part over RPC. */
export const methods = {
  overview: { input: Cwd, output: Schema.NullOr(Overview) },
  log: {
    input: Schema.Struct({ cwd: Schema.String, limit: Schema.Number, scope: Schema.Literals(["current", "local", "all"]) }),
    output: Schema.Array(Commit),
  },
  show: { input: Schema.Struct({ cwd: Schema.String, hash: Schema.String }), output: CommitDetails },
  branches: { input: Cwd, output: Schema.Array(Branch) },
  pulls: { input: Schema.Struct({ cwd: Schema.String, fresh: Schema.Boolean }), output: Pulls },
  /** The pull requests whose head is one of these branches of the repository's GitHub remote, newest first per branch. */
  branchPulls: { input: Schema.Struct({ cwd: Schema.String, names: Schema.Array(Schema.String), fresh: Schema.Boolean }), output: Pulls },
  /** Local branches whose tip is in the default branch (on the remote when it has one). */
  mergedBranches: { input: Cwd, output: Schema.Array(Schema.String) },
  /** What the current branch has that no remote has yet, and how far it is ahead of the default branch. */
  outgoing: {
    input: Cwd,
    output: Schema.Struct({ unpushed: Schema.Array(Commit), base: Schema.NullOr(Schema.String), ahead: Schema.Number }),
  },
  search: {
    input: Schema.Struct({
      repo: Schema.String,
      kind: Schema.Literals(["issue", "pr"]),
      /** GitHub search syntax, without the repository and type, such as `is:open author:@me label:bug`. */
      query: Schema.String,
      cursor: Schema.NullOr(Schema.String),
    }),
    output: SearchPage,
  },
  prChecks: {
    input: Schema.Struct({ repo: Schema.String, numbers: Schema.Array(Schema.Number) }),
    output: Schema.Array(Schema.Struct({ number: Schema.Number, checks: Schema.Literals(["success", "failure", "pending", "none"]) })),
  },
  issues: {
    input: Schema.Struct({
      cwd: Schema.String,
      state: Schema.Literals(["open", "closed", "all"]),
      mine: Schema.Boolean,
      search: Schema.String,
      fresh: Schema.Boolean,
    }),
    output: Issues,
  },
  item: { input: Schema.Struct({ repo: Schema.String, number: Schema.Number, fresh: Schema.Boolean }), output: Item },
  comment: {
    input: Schema.Struct({ repo: Schema.String, number: Schema.Number, kind: Schema.Literals(["issue", "pr"]), body: Schema.String }),
    output: Output,
  },
  setState: {
    input: Schema.Struct({
      repo: Schema.String,
      number: Schema.Number,
      kind: Schema.Literals(["issue", "pr"]),
      open: Schema.Boolean,
      /** Why an issue closes; pull requests have none. Omitted: GitHub's default, completed. */
      reason: Schema.optional(Schema.Literals(["completed", "not_planned", "duplicate"])),
      duplicateOf: Schema.optional(Schema.Number),
      /** Posted before closing, or after reopening. */
      comment: Schema.optional(Schema.String),
    }),
    output: Output,
  },
  prFiles: {
    input: Schema.Struct({ repo: Schema.String, number: Schema.Number, head: Schema.optional(Schema.String) }),
    output: Schema.Array(ChangedFile),
  },
  reviews: { input: ItemRef, output: Reviews },
  submitReview: {
    input: Schema.Struct({
      repo: Schema.String,
      number: Schema.Number,
      event: Schema.Literals(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
      body: Schema.String,
    }),
    output: Output,
  },
  replyThread: {
    input: Schema.Struct({ repo: Schema.String, number: Schema.Number, thread: Schema.String, body: Schema.String }),
    output: Output,
  },
  resolveThread: {
    input: Schema.Struct({ repo: Schema.String, number: Schema.Number, thread: Schema.String, resolved: Schema.Boolean }),
    output: Output,
  },
  lineComment: {
    input: Schema.Struct({
      repo: Schema.String,
      number: Schema.Number,
      sha: Schema.String,
      path: Schema.String,
      line: Schema.Number,
      side: Schema.Literals(["LEFT", "RIGHT"]),
      body: Schema.String,
    }),
    output: Output,
  },
  edit: {
    input: Schema.Struct({
      repo: Schema.String,
      number: Schema.Number,
      kind: Schema.Literals(["issue", "pr"]),
      title: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
      addLabels: Schema.Array(Schema.String),
      removeLabels: Schema.Array(Schema.String),
      addAssignees: Schema.Array(Schema.String),
      removeAssignees: Schema.Array(Schema.String),
      addReviewers: Schema.Array(Schema.String),
      removeReviewers: Schema.Array(Schema.String),
      /** A milestone title to set, null to remove it, or omitted to leave it. */
      milestone: Schema.optional(Schema.NullOr(Schema.String)),
    }),
    output: Output,
  },
  setDraft: { input: Schema.Struct({ repo: Schema.String, number: Schema.Number, draft: Schema.Boolean }), output: Output },
  repoMeta: { input: Schema.Struct({ repo: Schema.String }), output: RepoMeta },
  remoteCommit: { input: Schema.Struct({ repo: Schema.String, sha: Schema.String }), output: RemoteCommit },
  runs: {
    input: Schema.Struct({ repo: Schema.String, branch: Schema.NullOr(Schema.String), fresh: Schema.Boolean }),
    output: Schema.Array(Run),
  },
  run: { input: Schema.Struct({ repo: Schema.String, id: Schema.Number }), output: RunDetails },
  jobLog: { input: Schema.Struct({ repo: Schema.String, job: Schema.Number }), output: Schema.String },
  rerun: { input: Schema.Struct({ repo: Schema.String, id: Schema.Number, failed: Schema.Boolean }), output: Output },
  cancelRun: { input: Schema.Struct({ repo: Schema.String, id: Schema.Number }), output: Output },
  inbox: { input: Schema.Struct({ fresh: Schema.Boolean }), output: Inbox },
  markRead: { input: Schema.Struct({ thread: Schema.NullOr(Schema.String) }), output: Output },
  createIssue: {
    input: Schema.Struct({ cwd: Schema.String, title: Schema.String, body: Schema.String }),
    output: Schema.String,
  },
  diff: {
    input: Schema.Struct({
      cwd: Schema.String,
      path: Schema.String,
      staged: Schema.Boolean,
      untracked: Schema.Boolean,
    }),
    output: Output,
  },
  prDefaults: {
    input: Schema.Struct({ cwd: Schema.String, base: Schema.String }),
    /** `template` is the repository's pull request template, when it has one. */
    output: Schema.Struct({ title: Schema.String, body: Schema.String, template: Schema.optional(Schema.String) }),
  },

  stage: { input: Paths, output: Output },
  unstage: { input: Paths, output: Output },
  discard: {
    input: Schema.Struct({ cwd: Schema.String, tracked: Schema.Array(Schema.String), untracked: Schema.Array(Schema.String) }),
    output: Output,
  },
  commit: {
    input: Schema.Struct({ cwd: Schema.String, message: Schema.String, amend: Schema.Boolean, all: Schema.Boolean }),
    output: Output,
  },
  checkout: {
    input: Schema.Struct({ cwd: Schema.String, ref: Schema.String, track: Schema.NullOr(Schema.String) }),
    output: Output,
  },
  createBranch: {
    input: Schema.Struct({
      cwd: Schema.String,
      name: Schema.String,
      start: Schema.NullOr(Schema.String),
      checkout: Schema.Boolean,
    }),
    output: Output,
  },
  deleteBranch: {
    input: Schema.Struct({ cwd: Schema.String, name: Schema.String, force: Schema.Boolean }),
    output: Output,
  },
  /** Deletes each branch on its own; one that fails does not stop the rest. */
  deleteBranches: {
    input: Schema.Struct({ cwd: Schema.String, names: Schema.Array(Schema.String), force: Schema.Boolean }),
    output: Schema.Array(Schema.Struct({ name: Schema.String, error: Schema.NullOr(Schema.String) })),
  },
  /** Undoes the last commit and keeps its changes staged; refuses a merge commit or one any remote has. */
  undoCommit: { input: Cwd, output: Output },
  deleteRemoteBranch: {
    input: Schema.Struct({ cwd: Schema.String, remote: Schema.String, name: Schema.String }),
    output: Output,
  },
  merge: { input: Schema.Struct({ cwd: Schema.String, ref: Schema.String }), output: Output },
  rebase: { input: Schema.Struct({ cwd: Schema.String, ref: Schema.String }), output: Output },
  cherryPick: { input: Schema.Struct({ cwd: Schema.String, hash: Schema.String }), output: Output },
  revert: { input: Schema.Struct({ cwd: Schema.String, hash: Schema.String }), output: Output },
  abort: { input: Cwd, output: Output },
  continue: { input: Cwd, output: Output },
  fetch: { input: Cwd, output: Output },
  pull: { input: Cwd, output: Output },
  push: { input: Schema.Struct({ cwd: Schema.String, force: Schema.Boolean }), output: Output },
  pushBranch: { input: Schema.Struct({ cwd: Schema.String, name: Schema.String }), output: Output },
  stash: { input: Cwd, output: Output },
  stashPop: { input: Cwd, output: Output },
  createPr: {
    input: Schema.Struct({
      cwd: Schema.String,
      title: Schema.String,
      body: Schema.String,
      base: Schema.String,
      draft: Schema.Boolean,
    }),
    output: Schema.String,
  },
  checkoutPr: {
    input: Schema.Struct({ cwd: Schema.String, number: Schema.Number, repo: Schema.NullOr(Schema.String) }),
    output: Output,
  },
  mergePr: {
    input: Schema.Struct({
      cwd: Schema.String,
      repo: Schema.NullOr(Schema.String),
      number: Schema.Number,
      method: Schema.Literals(["merge", "squash", "rebase"]),
      deleteBranch: Schema.Boolean,
    }),
    output: Output,
  },

  /** A session's agent actions, all or of one repository. Only the server part keeps them. */
  agentActions: { input: Schema.Struct({ sessionID: Schema.String, repo: Schema.NullOr(Schema.String) }), output: AgentQueue },
  /** The newest agent actions on a repository across sessions. */
  agentRecent: { input: Schema.Struct({ repo: Schema.String, limit: Schema.Number }), output: Schema.Array(AgentAction) },
  /**
   * Approves or skips proposed actions: these ids, or every proposed one of the session (or of one batch). "reset" takes
   * a decision back: approved actions that have not started and actions the user skipped wait for approval again.
   */
  agentDecide: {
    input: Schema.Struct({
      sessionID: Schema.String,
      ids: Schema.NullOr(Schema.Array(Schema.String)),
      batch: Schema.NullOr(Schema.String),
      decision: Schema.Literals(["approve", "skip", "reset"]),
    }),
    output: Output,
  },
  /** Changes a proposed action before it is approved. */
  agentEdit: {
    input: Schema.Struct({
      sessionID: Schema.String,
      id: Schema.String,
      body: Schema.optional(Schema.String),
      reason: Schema.optional(CloseReason),
      duplicateOf: Schema.optional(Schema.NullOr(Schema.Number)),
      add: Schema.optional(Schema.Array(Schema.String)),
      remove: Schema.optional(Schema.Array(Schema.String)),
    }),
    output: AgentAction,
  },
  agentUndo: { input: Schema.Struct({ sessionID: Schema.String, id: Schema.String }), output: Output },
  agentRetry: { input: Schema.Struct({ sessionID: Schema.String, ids: Schema.Array(Schema.String) }), output: Output },
  /** Whether the agent's writes in this session run at once instead of waiting for approval. */
  agentAuto: { input: Schema.Struct({ sessionID: Schema.String, auto: Schema.Boolean }), output: Output },
}

/**
 * Methods only the server part serves, kept out of `methods`: the backend (and the main process's Ipc) does not answer
 * them, and the window calls them on the session's server directly.
 */
export const agentMethods = {
  /** The user's own writes on many items, queued approved: they run paced, show on the activity page and can be undone. */
  agentQueue: {
    input: Schema.Struct({
      sessionID: Schema.String,
      repo: Schema.String,
      kind: WriteKind,
      numbers: Schema.Array(Schema.Number),
      body: Schema.optional(Schema.String),
      reason: Schema.optional(CloseReason),
      duplicateOf: Schema.optional(Schema.Number),
      add: Schema.optional(Schema.Array(Schema.String)),
      remove: Schema.optional(Schema.Array(Schema.String)),
    }),
    output: Schema.Struct({
      batch: Schema.String,
      queued: Schema.Array(Schema.Number),
      skipped: Schema.Array(Schema.Struct({ number: Schema.Number, reason: Schema.String })),
    }),
  },
  /** Marks a session as a triage run, so its activity page shows the run and the agent's tools track its batches. */
  agentTriage: { input: Schema.Struct({ sessionID: Schema.String, triage: TriageStart }), output: Output },
}

export const ReviewEvent = Schema.Literals(["COMMENT", "APPROVE", "REQUEST_CHANGES"])
export type ReviewEvent = typeof ReviewEvent.Type
export const DiffSide = Schema.Literals(["LEFT", "RIGHT"])
export type DiffSide = typeof DiffSide.Type

/** An inline comment of a draft review, on a line of the pull request's diff (or lines `startLine` to `line`). */
export const DraftComment = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  line: Schema.Number,
  side: DiffSide,
  startLine: Schema.NullOr(Schema.Number),
  body: Schema.String,
  source: Schema.Literals(["agent", "user"]),
  /** The user changed the agent's text. */
  edited: Schema.Boolean,
})
export type DraftComment = typeof DraftComment.Type

/** A review kept by the server part until the user submits it: one per session and pull request. */
export const DraftReview = Schema.Struct({
  sessionID: Schema.String,
  repo: Schema.String,
  number: Schema.Number,
  /** The head commit the comments were placed against; a newer head may have moved their lines. */
  sha: Schema.String,
  summary: Schema.String,
  event: ReviewEvent,
  /** The agent's note to the user. */
  note: Schema.String,
  source: Schema.Literals(["agent", "user"]),
  comments: Schema.Array(DraftComment),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type DraftReview = typeof DraftReview.Type

const DraftRef = { sessionID: Schema.String, repo: Schema.String, number: Schema.Number }

/** Draft reviews, which only the server part keeps; the window calls them on the session's server directly. */
export const reviewMethods = {
  /** A pull request's draft reviews: the given session's first, then the newest of other sessions. */
  reviewDrafts: {
    input: Schema.Struct({ repo: Schema.String, number: Schema.Number, sessionID: Schema.NullOr(Schema.String) }),
    output: Schema.Array(DraftReview),
  },
  /** Changes a draft; adding a comment to a pull request without one starts the user's own draft at `sha`. */
  reviewEdit: {
    input: Schema.Struct({
      ...DraftRef,
      summary: Schema.optional(Schema.String),
      event: Schema.optional(ReviewEvent),
      update: Schema.optional(Schema.Struct({ id: Schema.String, body: Schema.String })),
      remove: Schema.optional(Schema.String),
      add: Schema.optional(Schema.Struct({ path: Schema.String, line: Schema.Number, side: DiffSide, startLine: Schema.NullOr(Schema.Number), body: Schema.String })),
      sha: Schema.optional(Schema.String),
    }),
    output: DraftReview,
  },
  reviewDiscard: { input: Schema.Struct(DraftRef), output: Schema.String },
  /**
   * Submits a draft as one review. When the head moved since it was drafted, it is not submitted without `force`: the
   * answer lists the comments that would move into the summary because their lines left the diff.
   */
  reviewSubmit: {
    input: Schema.Struct({ ...DraftRef, force: Schema.Boolean }),
    output: Schema.Struct({ submitted: Schema.Boolean, url: Schema.NullOr(Schema.String), moved: Schema.Array(DraftComment), message: Schema.String }),
  },
}

/** Every method the server part serves over RPC. */
export const serverMethods = { ...methods, ...agentMethods, ...reviewMethods }

/** What the backend announces after a change, so views showing it refresh. */
export const events = {
  /** A command changed the repository at `cwd`; windows showing it refresh. */
  changed: Schema.Struct({ cwd: Schema.String, remote: Schema.optional(Schema.Boolean) }),
  /** An issue or pull request changed through this plugin; detail tabs showing it refresh. */
  item: ItemRef,
  /** A workflow run was re-run or cancelled through this plugin. */
  run: Schema.Struct({ repo: Schema.String, id: Schema.Number }),
  /** Notifications were marked read. */
  inbox: Schema.Struct({}),
  /** A session's agent actions changed: proposed, decided, edited, run or undone. */
  agent: Schema.Struct({ sessionID: Schema.String }),
  /** A pull request's draft reviews changed: drafted, edited, submitted or discarded. */
  review: ItemRef,
}
