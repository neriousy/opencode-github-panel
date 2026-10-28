import { Plugin } from "@opencode/plugin"
import { createAgent } from "./agent"
import { createBackend } from "./backend"
import { createReview } from "./review"
import { GitRpc } from "./rpc"
import { serverMethods } from "./schemas"

/**
 * The server part: serves git and gh over RPC from the OpenCode server, next to the repository. A desktop app
 * connected to this server from another machine calls it through the session's server client. It also gives the
 * agent its GitHub tools, whose writes wait in a per-session queue for the user's approval.
 */
export default Plugin.define({
  id: "github-panel",
  async setup(ctx) {
    const box: { emit?: (name: string, data: object) => Promise<void> } = {}
    const emit = (name: string, data: object) => void box.emit?.(name, data).catch(() => undefined)
    const parts = createBackend({
      log: (level, message, data) => {
        if (level === "warn" || level === "error") console.warn(`[github-panel] ${message}`, data ?? "")
      },
      emit,
    })
    const agent = createAgent({ ctx, backend: parts.backend, kit: parts.kit, emit })
    const review = createReview({ ctx, backend: parts.backend, kit: parts.kit, emit })
    const served = { ...parts.backend, ...agent.methods, ...review.methods }
    const handlers = Object.fromEntries(
      (Object.keys(serverMethods) as (keyof typeof serverMethods)[]).map((name) => [
        name,
        async (input: unknown, context: { signal: AbortSignal; error: (type: "failed", message: string, data: object) => unknown }) => {
          try {
            // SAFETY: the RPC layer decoded `input` with this method's schema before calling.
            return await (served[name] as (input: unknown, caller: { signal: AbortSignal }) => unknown)(input, { signal: context.signal })
          } catch (error) {
            // A declared error keeps git's message; an undeclared one would reach the window as a generic failure.
            return context.error("failed", error instanceof Error ? error.message : String(error), {})
          }
        },
      ]),
    )
    // SAFETY: one handler per method of GitRpc, each with the context the RPC layer passes.
    const registration = await ctx.rpc.register(GitRpc, handlers as never)
    // SAFETY: event names and data come from the same `events` table GitRpc was built from.
    box.emit = (name, data) => registration.events.emit(...([name, data] as unknown as Parameters<typeof registration.events.emit>))
    const stops = await Promise.all([agent.start(), review.start()])
    return async () => {
      await Promise.all(stops.map((stop) => stop()))
    }
  },
})
