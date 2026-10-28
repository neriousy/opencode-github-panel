# opencode-github-panel

A Git and GitHub side panel for OpenCode Desktop, in the spirit of GitLens.

The panel has a top bar for the repository (name, the four tabs, an inbox bell with the unread count, and a menu with
fetch, workflow runs and open on GitHub). Branch details appear only on the two local tabs.

- **Branch bar** (Changes and History): the branch picker, pull ↓ and push ↑ (or publish) with counts, fetch, and a menu
  with new branch, create pull request, force push, stash and pop. Under it, a merge, rebase, `git am`, cherry-pick or
  revert in progress shows Continue and Abort (Abort asks first). A strip shows the current branch's pull request,
  checks, review state and the next step (Push, Ready for review, Merge), or "No pull request · N ahead" with Create PR.
- **Branch picker**: searchable, with current, recent, branches with an open pull request, local and remote branches,
  each with ahead/behind, its pull request and last commit; checkout, merge into current, rebase onto, push, delete and
  more. A branch checked out in another worktree shows that worktree's folder, and opens a session there instead of
  checking out. **Clean up…** lists branches whose pull request was merged or closed, whose upstream is gone, or that
  are merged into the default branch, with the reason for each; branches with unpushed work start unchecked, and
  branches checked out in a worktree are left out.
- **Changes**: staged, unstaged and conflicted files with inline diffs; stage, unstage and discard per file or all at
  once; commit, commit all, commit & push, amend (⌘⏎ commits; amending a pushed commit asks first). **Unpushed
  commits** lists what is not on the remote yet, with Push, Amend and Undo last commit.
- **History**: a commit graph with lanes, merge curves, branch, remote and tag badges, and the pull request of each
  branch. Shows local branches with their upstreams, the current branch, or everything. Click a commit for its files,
  message and actions: checkout, new branch from here, cherry-pick, revert, copy hash, open on GitHub.
- **Pull requests** and **Issues**: GitHub search, newest first, 30 at a time with only the visible rows rendered.
  Presets plus your own saved searches; a search box with autocomplete for qualifiers, labels, people and milestones;
  Filter and Sort menus (newest, oldest, recently updated, most commented, most reactions…), with filters shown as
  removable chips. Rows come comfortable or compact, with checks, comments and time on the right, and a dot on items
  opened (or a ring on items updated) since your last visit. Keyboard: ↑↓ or j/k, Enter, `/` to search, `a` to ask the
  agent, `.` for the row menu.
- **Bulk actions**: a checkbox takes a row's state icon on hover; click it, shift-click for a range, `x` for the active
  row, ⌘A for every loaded row, Esc to clear. While rows are picked, a bar replaces the results line: Close (reason and
  an optional comment), Label, Comment, and in its menu Reopen, Assign, "Ask agent about these N" (quotes a compact list
  into the chat) and "Triage these N with agent". Bulk writes go through the same queue as the agent's, already
  approved: they run paced, show their progress in a toast and on the Agent activity page, and can be undone. Closing or
  reopening more than one asks first.
- **Saved replies**: comment texts per repository (list menu › Saved replies…), insertable in the bulk Comment and Close
  dialogs and when editing a proposal, and offered to triage runs.
- **Triage with agent** (list menu, or the bulk bar for picked rows): rules in your words, the saved replies to use and a
  batch size. Start opens a new session in the same folder with a prompt that lists the search (or the numbers), the
  rules and replies, and how to work: only propose, a note on each proposal, identical actions in one call, and after
  each batch wait for your review with the `actions` tool. Its Agent activity page shows the run (search, rules,
  "12 of 40 reviewed · 8 approved · 4 skipped") and groups proposals by batch; keys `a` approve the batch and `u` take
  back the last decision while it has not run. The agent is told which proposals you skipped or edited, and how.
- **Issue and pull request tabs**: click any issue or PR (in the lists, a branch badge, a PR chip, or the timeline) to
  open it in its own side tab: state, labels, description and comments, a comment box, close and reopen, and an edit
  menu for labels, assignees, reviewers, milestone and draft. Long content folds so there is less to scroll: long
  descriptions and comments clamp, bot comments and resolved threads start folded, long conversations hide the middle,
  and Fold all / Unfold all is one click (turn it off with "Fold long content"). Pull requests add **Files** (changed
  files list, Collapse all, a Viewed checkbox per file, inline review comments) and **Checks** (failing first; passed
  folded), with Checkout and Merge. **Add to chat** quotes the issue or PR into your next prompt.
- **CI runs**: jobs fold (failed ones open with their failing step), logs show the last 3,000 lines with ANSI codes
  stripped, and running jobs poll; re-run and cancel.
- **Inbox** (the bell): notifications grouped by repository, marked read only when you open one or ask to.
- **Timeline mentions**: in the session timeline, `#123`, `owner/repo#123` and github.com issue or pull links are
  clickable. Hover one for a card with its state, author, size and checks; click it to open its tab; ⌘-click still
  opens GitHub. Bare `#123` resolves against the session's repository. This uses a CSS highlight and document
  listeners, since the timeline has no plugin API for it; it never changes the timeline's DOM.
- **Session header chip**: the session's branch, a dot for uncommitted changes, and its pull request. Click it to open
  the panel. Turn it off from the panel's menu or the command palette.

- **Agent GitHub tools**: the server part gives the agent its own tools in the `github_panel` namespace (`search`,
  `view`, `comment`, `close`, `reopen`, `label`, `assign`, `actions`). Reads run at once. Writes become **proposed
  actions** in a per-session queue (kept in the server's plugin storage) that you approve, edit or skip; a per-session
  **Auto-run** switch runs them at once instead. Approved actions run one at a time, about one write a second, and back
  off on GitHub's rate limits. Done actions can be undone (reopen, delete the posted comment, remove the labels or
  assignees that were really added). `gh issue|pr close|reopen|comment|edit|merge|review|lock` commands the agent runs in
  the shell are recorded too. In the window: a composer pill ("GitHub · 3 to approve"), the **Agent activity** page
  (the checklist button in the top bar; keys y, n, e, a, u, o, j/k), a banner on the issue or pull request tab, and a mark
  on list rows. The `actions` tool can wait (`wait: true`) until the user has decided, and reports the user's edits as
  "you proposed X; the user changed it to Y".
- **Start working on an issue**: one dialog creates the branch (`123-slug`, from the freshly fetched default branch or
  the current one) and starts the agent with the issue. **Where**: a **new worktree** (the default; a separate folder
  made by the OpenCode server, so this checkout and its changes stay as they are) or **this checkout** (switch here,
  stashing or carrying your changes). A branch already checked out in another worktree is worked on there. The agent
  starts at once in a new session, in a background tab, with a toast to open it; in this checkout it can also go into
  this session's chat. The branch strip then shows the issue, the PR and, once merged, "Issue closed" with Switch to the
  default branch and delete the branch, or, in a worktree, Remove worktree & delete branch. Create PR fills in the
  title, your PR template and "Fixes #N". Issue tabs list their linked branches (with Open for one in a worktree) and
  pull requests.
- **Agent sessions start at once**: "Work on it in a new session", "Pre-review with agent", a CI job's new session and
  Start working create the session with the composer's model and send its first prompt, then open it in a background
  tab. Servers that cannot create sessions get a draft with the prompt instead.
- **Review mode**: "Pre-review with agent" on a pull request starts a session that reads the diff (`diff` tool) and
  drafts a review (`review` tool): a summary, a suggested verdict and inline comments, checked against the diff. Nothing
  reaches GitHub until you submit: the draft shows as a banner, inline draft comments you can edit or delete (add your
  own by clicking a line number), and a bar with the verdict, the summary and Submit review.

Palette commands (all under "Git"): toggle the panel (⌘⇧G or `/git`), fetch, pull, push, commit, create and switch
branches, create or open the pull request for the current branch, new issue, open an issue or PR by number or URL,
and open the repository on GitHub.

## How it works

The plugin has three parts that share one backend (`src/backend.ts`, `src/github.ts`), which spawns `git` and `gh`:

- **Server part** (`src/index.ts`, `.` export): serves the backend over RPC (`src/rpc.ts`) from the OpenCode server, next
  to the repository. This is what makes remote servers work.
- **GUI** (`dist/gui-experimental.cjs`): the panel, tabs, timeline mentions and hover cards. It calls the backend on the
  **routed session's server** (`src/transport.ts`), with the session's directory as the RPC location.
- **Main process** (`src/main.ts`): the same backend over an Ipc. Only a fallback, used when the session's server runs on
  this machine but has no server part.

The GUI keeps its data in TanStack Query (`src/queries.ts`), one client per window. Lists, items, reviews, files, runs
and the inbox stay cached while you switch sessions, files, tabs or sections, and refresh in the background when stale;
hovering a row prefetches its tab, and opening a pull request prefetches its files. Local git changes refresh git
views only; commands that talk to the remote also refresh GitHub data. The server adds its own short caches for things
that cannot change (files per head commit, finished runs and their logs). Writes to one repository run one at a time.
The panel polls git every 4 seconds while it is visible. It needs `git`, and `gh` signed in
(`gh auth login`) for GitHub features, on the machine that hosts the repository.

## Remote servers

When the desktop app on one machine (say Windows) is connected to an OpenCode server on another (say a Mac), git and gh
run on the server, where the repository is. Install the plugin on both machines:

1. **On the server machine** (the Mac): add the plugin to `~/.config/opencode/opencode.jsonc` so the server loads its
   server part, install `gh`, and run `gh auth login`. Restart the OpenCode server.
2. **On the desktop machine** (Windows): the desktop app loads GUI parts only from its own background server, so add
   the plugin there too, in `%USERPROFILE%\.config\opencode\opencode.jsonc`:

   ```jsonc
   "plugins": ["opencode-github-panel"]
   ```

If the session's server has no server part, the panel says so instead of running git on the wrong machine.
Commands outside a session, such as the inbox on Home, use the desktop machine's own server.

## Install

Requirements: OpenCode Desktop 2.2 or later, `git`, and the GitHub CLI signed in (`gh auth login`) on the machine that
runs the OpenCode server.

Add the plugin to `~/.config/opencode/opencode.jsonc` (on Windows `%USERPROFILE%\.config\opencode\opencode.jsonc`):

```jsonc
{
  "plugins": ["opencode-github-panel"]
}
```

Restart OpenCode, then open the panel from the side panel's **+** menu (**Git & GitHub**), ⌘⇧G, `/git`, or the branch
chip in the session header.

### From source

```bash
git clone https://github.com/neriousy/opencode-github-panel
cd opencode-github-panel
bun install
bun run build      # dist/gui-experimental.cjs
bun run dev        # rebuild on change; the app reloads the plugin
```

and list the folder instead of the package name: `"plugins": ["/path/to/opencode-github-panel"]`.

## Development

```bash
bun run typecheck
bun test                        # parsers, the graph layout, branch clean-up and agent action plans
bun scripts/smoke.ts <repo>     # runs the main-process code against a repository, outside Electron
```

When a rebuild changes `src/contract.ts`, reload the window (⌘R) as well. The app caches each Ipc client by id, so a
window keeps encoding calls with the previous schemas until it reloads.

The OpenCode server reloads the server part when a file it imports changes. If it reloads while an edit is half done
(one file already importing a name another does not export yet), Bun can keep the broken module cached and every later
reload fails with the same error ("Export named … not found"), while the old code keeps serving. The server log shows
it (`failed to load plugin`); `opencode service restart` clears it. Edit the server files in one go, or stop the server
while doing multi-file refactors.
