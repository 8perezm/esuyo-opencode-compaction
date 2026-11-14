import { Rpc } from "@opencode/plugin/rpc"

const sessionID = { type: "string" } as const
const textOutput = {
  type: "object",
  properties: {
    text: { type: "string" },
  },
  required: ["text"],
  additionalProperties: false,
} as const

/**
 * Server methods and a feedback event. The server-side slash command uses the
 * same methods as the TUI so both stay in sync, and the TUI shows the returned
 * text as a toast instead of adding a message to the conversation.
 */
export const CompactionRpc = Rpc.define({
  id: "esuyo.compaction",
  methods: {
    status: {
      input: {
        type: "object",
        properties: { sessionID },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: textOutput,
    },
    configure: {
      input: {
        type: "object",
        properties: {
          sessionID,
          action: {
            type: "string",
            enum: ["status", "on", "off", "toggle", "reset", "reload", "help"],
          },
        },
        required: ["sessionID", "action"],
        additionalProperties: false,
      },
      output: textOutput,
    },
  },
  events: {
    feedback: {
      schema: {
        type: "object",
        properties: {
          sessionID,
          text: { type: "string" },
          variant: {
            type: "string",
            enum: ["info", "success", "warning", "error"],
          },
        },
        required: ["sessionID", "text"],
        additionalProperties: false,
      },
    },
  },
})
