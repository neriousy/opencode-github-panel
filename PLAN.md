# Agent workflows plan

Decided with the user: agent writes to GitHub queue for approval by default (a per-session switch allows auto-run), the
plugin gives the agent its own GitHub tools, and all five phases get built, after the panel redesign lands.

## 1. Agent tools and activity

Status: built (server part `src/agent.ts`, pure logic `src/plan.ts`, window `src/activity.tsx`).

- Server part registers tools with `ctx.tool.transform` (see `@opencode/plugin` `promise/tool.d.ts`):
  - read, run at once: `github_search` (query → compact list: number, title, labels, author, age, comments),
    `github_view` (issue/PR with comments, truncated).
  - write, batchable (`numbers: number[]`): `github_comment`, `github_close` (reason completed | not_planned |
    duplicate of #N, optional comment), `github_reopen`, `github_label` (add/remove), `github_assign`.
- Writes become **proposed actions** in a per-session queue kept by the server part (storage via `ctx.storage` so it
  survives reloads); the tool result says what was proposed and that the user reviews it. With auto-run on, they
  execute at once. Execution is paced (GitHub secondary rate limits), reports per-item results, and records undo info.
- `ctx.tool.hook("execute.after")` on the shell tool detects `gh issue|pr close|comment|edit|reopen|merge …`, logs
  them as executed actions and emits `item` events so open views refresh.
- RPC: list queue/activity per session, approve/skip/edit/approve-all, undo, auto-run switch; events on change.
- GUI:
  - composer pill "GitHub · N to approve · M done" with rows (approve all, open queue, recent actions).
  - Activity view in the panel (top bar, next to the bell): per session, newest first, each with Undo and a link.
  - item tab banner for proposals on that item (Approve / Edit / Discard).
  - list row badges for pending/done agent actions.

## 2. Triage mode

Status: built (`src/triage.tsx`; run metadata in the session queue's `triage`; prompt in `plan.ts` `triagePrompt`).

- "Triage with agent" from a search or saved search: a form with the rules (free text) and optional saved replies →
  new session with instructions to use the plugin tools, work in batches, and only propose.
- Triage queue: one row per issue with the proposed action and comment preview; keys y (approve), n (skip),
  e (edit), o (open); approve all per batch; progress and a final summary with undo.
- Saved replies per repo (prefs), usable by the user and offered to the agent.

## 3. Manual bulk actions

Status: built (selection in `src/search.tsx`, bar and dialogs in `src/triage.tsx`, server-only RPC `agentQueue`).

- Multi-select rows in the PR/issue lists (checkbox on hover, shift-click ranges, `x` key).
- Bulk bar: close (reason + comment), label, assign, "Ask agent about these N".

## 4. Issue-solving flow

Status: built (Start working dialog in `src/actions.tsx`, issue link in the branch strip in `src/panel.tsx`, linked
branches and PRs in `src/item.tsx`, PR template and "Fixes #N" via `prDefaults`).

- Start working on an issue → branch + session with context (exists: `startIssue`).
- Branch strip links issue → branch → PR; PR body gets "Fixes #N"; merged PR closes the issue.

## 5. Review mode

Status: built (tools `diff` and `review` in `src/review.ts`, line checks in `src/draft.ts`, window `src/drafting.tsx`;
drafts stay in plugin storage until the user submits them in one `addPullRequestReview` call).

- From review-requested PRs: "Pre-review with agent" → the agent's comments become a pending review (GraphQL
  `addPullRequestReview` with threads) that the user edits and submits in the Files section.
