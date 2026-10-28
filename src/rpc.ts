import { Schema } from "effect"
import { Rpc } from "@opencode/plugin/rpc"
import { events, serverMethods } from "./schemas"

/** A git or gh command failed; the message is git's or gh's own. */
const failed = { type: "object", additionalProperties: true } as const

/**
 * The backend as a server RPC, so it runs on the machine that hosts the repository, a remote server included. Built
 * from the same method table as the main-process Ipc, plus the agent methods only the server part has. The Promise
 * clients take Standard Schemas; each Effect schema is wrapped, which keeps it an Effect schema the server decodes with.
 */
export const GitRpc = Rpc.define({
  id: "github-panel",
  methods: Object.fromEntries(
    Object.entries(serverMethods).map(([name, method]) => [
      name,
      { input: Schema.toStandardSchemaV1(method.input), output: Schema.toStandardSchemaV1(method.output), errors: { failed } },
    ]),
  ),
  events: Object.fromEntries(Object.entries(events).map(([name, schema]) => [name, { schema: Schema.toStandardSchemaV1(schema) }])),
  // SAFETY: built from the typed tables above; callers go through the typed transport, not this record's keys.
}) as Rpc.PortableDefinition
