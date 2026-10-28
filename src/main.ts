import type { IpcProvider, Plugin } from "@opencode/plugin/gui"
import { createBackend } from "./backend"
import { Git } from "./contract"

/** Serves the backend to this app's windows: for sessions on this machine when their server lacks the server part. */
export const main: Plugin.MainSetup = (ctx) => {
  const box: { provider?: IpcProvider<(typeof Git)["spec"]> } = {}
  const backend = createBackend({
    log: (level, message, data) => ctx.log.write(level, message, data),
    // SAFETY: both sides read the same `events` schemas; TypeScript cannot relate the two generic lookups.
    emit: (name, data) => box.provider?.emit(name, data as never),
  }).backend
  box.provider = ctx.provide(Git, backend)
}
