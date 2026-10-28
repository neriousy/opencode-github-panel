/** Strings of the issue-solving flow: starting work on an issue, its link to a branch and pull request, and finishing. */
export const issue = {
  "start.title": "Start working on #{{number}}",
  "start.branch": "Branch",
  "start.current": "You are on this branch already.",
  "start.existing": "{{name}} exists; it will be checked out.",
  "start.base": "Start from",
  "start.base.default": "Latest {{base}}",
  "start.base.current": "Current: {{branch}}",
  "start.changes.one": "{{count}} uncommitted change",
  "start.changes.other": "{{count}} uncommitted changes",
  "start.changes.carry": "Bring along",
  "start.changes.stash": "Stash",
  "start.agent": "Agent",
  "start.agent.session": "New session",
  "start.agent.chat": "This session",
  "start.agent.none": "Not now",
  "start.submit": "Start working",
  "start.fetching": "Fetching {{remote}}…",
  "start.stashKept": "Your changes are in the stash; Pop latest stash brings them back.",
  "agent.prompt.start":
    "Fix #{{number}}: {{title}}. Read the issue (github_panel.view), reproduce, implement the fix with tests, keep changes focused; when done, summarize and suggest a PR title/body that says 'Fixes #{{number}}'.",

  "dialog.prFixes": "Fixes #{{number}}",

  "strip.issueClosed": "Issue #{{number}} closed",
  "strip.closed": "closed",
  "strip.finish": "Switch to {{base}} & delete branch",

  "finish.title": "Switch to {{base}} and delete {{branch}}?",
  "finish.description": "Pull request #{{number}} is merged. The default branch is pulled after switching.",
  "finish.confirm": "Switch and delete",
  "finish.moved": "#{{number}} is merged, but this branch has commits the pull request does not. They will be lost.",
  "finish.done": "Switched to {{base}} and deleted {{branch}}",

  "linked.label": "Linked",
  "linked.branch": "Local branch for this issue",
  "linked.switch": "Switch",
  "linked.current": "current",
  "linked.openPr": "Open PR",
}
