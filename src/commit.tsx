import { For, Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { latest } from "./queries"
import { errorMessage, type Actions } from "./actions"
import { fileContext } from "./context"
import { DiffList } from "./diff"
import { Clamp, createFolds } from "./fold"
import { ago } from "./panel"

/** A side tab with one commit from GitHub: its message, parents and diff. */
export function CommitView(props: { repo: string; sha: string; actions: Actions }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const t = ctx.t
  const q = props.actions.queries
  const data = latest(q.query(() => q.options.commit(props.repo, props.sha)))
  const folds = createFolds()
  return (
    <div class="ghp ghp-item" data-repo={props.repo} data-ghp-source={`the commit ${props.repo}@${props.sha}`} data-ghp-label={props.sha.slice(0, 7)}>
      <Show
        when={data.latest}
        fallback={
          <div class="ghp-empty">
            <Show when={data.error} fallback={<ui.Loader />}>
              <span>{errorMessage(data.error)}</span>
              <ui.Button size="small" variant="neutral" icon="refresh" onClick={() => q.invalidate(q.keys.commit(props.repo, props.sha))}>
                {t("action.retry")}
              </ui.Button>
            </Show>
          </div>
        }
      >
        {(commit) => (
          <div class="ghp-item-scroll">
            <header class="ghp-item-header">
              <div class="ghp-item-top">
                <button type="button" class="ghp-hash" title={t("action.copyHash")} onClick={() => void props.actions.copy(commit().sha)}>
                  <ui.Icon name="copy" size="small" />
                  {commit().sha.slice(0, 7)}
                </button>
                <span class="ghp-faint ghp-ellipsis">{props.repo}</span>
                <div class="ghp-spacer" />
                <ui.Tooltip value={t("action.openOnGitHub")}>
                  <ui.IconButton
                    icon="square-arrow-top-right"
                    label={t("action.openOnGitHub")}
                    size="small"
                    variant="ghost"
                    onClick={() => ctx.system.openExternal(commit().url)}
                  />
                </ui.Tooltip>
              </div>
              <h2 class="ghp-item-title">{commit().message.split("\n")[0]}</h2>
              <Show when={commit().message.split("\n").slice(1).join("\n").trim()}>
                {(rest) => (
                  <Clamp lines={12}>
                    <pre class="ghp-commit-message">{rest()}</pre>
                  </Clamp>
                )}
              </Show>
              <div class="ghp-item-meta">
                <span>
                  <b>{commit().author}</b> · {ago(Date.parse(commit().date) / 1000)}
                </span>
                <For each={commit().parents}>
                  {(parent) => (
                    <button type="button" class="ghp-hash" onClick={() => props.actions.openCommit(props.repo, parent)}>
                      ↑ {parent.slice(0, 7)}
                    </button>
                  )}
                </For>
              </div>
            </header>
            <DiffList
              files={commit().files}
              folds={folds}
              onAttach={(file) =>
                props.actions.attach(fileContext(file.path, file.patch ?? "", `in commit ${props.repo}@${commit().sha.slice(0, 7)}`), t("agent.prompt.diff"))
              }
            />
          </div>
        )}
      </Show>
    </div>
  )
}
