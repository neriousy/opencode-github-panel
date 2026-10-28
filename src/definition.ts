import { Schema } from "effect"
import { Plugin, Store } from "@opencode/plugin/gui"
import { en } from "./i18n/en"

// "branches", "actions" and "inbox" were tabs of earlier versions; stored preferences may still hold them.
export const View = Schema.Literals(["changes", "graph", "branches", "pulls", "issues", "actions", "inbox"])
export type View = typeof View.Type

export const definition = Plugin.define({
  stores: {
    prefs: Store.global(
      Schema.Struct({
        view: View,
        graphScope: Schema.optional(Schema.Literals(["current", "local", "all"])),
        pullFilter: Schema.Literals(["open", "all"]),
        headerChip: Schema.Boolean,
        issueState: Schema.optional(Schema.Literals(["open", "closed", "all"])),
        issueMine: Schema.optional(Schema.Boolean),
        prPreset: Schema.optional(Schema.String),
        issuePreset: Schema.optional(Schema.String),
        /** Searches the user saved as presets, per repository and list. */
        savedSearches: Schema.optional(
          Schema.Array(Schema.Struct({ id: Schema.String, repo: Schema.String, kind: Schema.Literals(["pr", "issue"]), name: Schema.String, query: Schema.String })),
        ),
        /** When each list was last looked at, by `repo:kind`, in epoch milliseconds: items updated since are marked new. */
        seen: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
        /** One-line rows in the pull request and issue lists. */
        compactRows: Schema.optional(Schema.Boolean),
        /** Long comments, bot comments and resolved threads start folded in issue and pull request tabs. */
        foldItems: Schema.optional(Schema.Boolean),
        /** The sort of each list, by kind ("pr" or "issue"): a GitHub `sort:` value such as `created-desc`. */
        listSort: Schema.optional(Schema.Record(Schema.String, Schema.String)),
        /** Comment texts the user reuses, per repository: offered in comment boxes and to triage runs. */
        savedReplies: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, repo: Schema.String, name: Schema.String, body: Schema.String }))),
        /** The triage rules last used, by repository, to start the next run from. */
        triageRules: Schema.optional(Schema.Record(Schema.String, Schema.String)),
        /** The issue each branch was started for, by `repo:branch`. */
        issueBranches: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
        /** New pull requests start as drafts. */
        prDraft: Schema.optional(Schema.Boolean),
      }),
      { view: "changes", graphScope: "local", pullFilter: "open", headerChip: true },
    ),
  },
  i18n: { en },
})
