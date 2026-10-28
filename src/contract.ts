import { Ipc } from "@opencode/plugin/gui"
import { events, methods } from "./schemas"

export * from "./schemas"

/** Runs git and gh in the desktop app's main process: the fallback when the session's server lacks the server part. */
export const Git = Ipc.define({ id: "github-panel.git", methods, events })
