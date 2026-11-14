import assert from "node:assert/strict"
import { test } from "node:test"
import type { SessionMessageInfo } from "@opencode/client"
import {
  compactionState,
  estimateMessage,
  measureContext,
  promptTokens,
} from "../src/measure.js"

const model = { providerID: "test", id: "model" } as const

function assistant(overrides: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    id: "msg_a",
    time: { created: 1 },
    agent: "build",
    model,
    content: [{ type: "text", text: "hello" }],
    tokens: {
      input: 100,
      output: 10,
      reasoning: 5,
      cache: { read: 1_000, write: 50 },
    },
    ...overrides,
  }
}

function messages(items: unknown[]): SessionMessageInfo[] {
  return items as unknown as SessionMessageInfo[]
}

test("prompt tokens include both cache kinds", () => {
  assert.equal(
    promptTokens({
      input: 100,
      output: 10,
      reasoning: 5,
      cache: { read: 1_000, write: 50 },
    }),
    1_150,
  )
})

test("measurement combines the provider count with text after the last response", () => {
  const result = measureContext(
    messages([
      { type: "user", id: "msg_u1", time: { created: 1 }, text: "old" },
      assistant(),
      { type: "user", id: "msg_u2", time: { created: 2 }, text: "12345678" },
    ]),
  )

  assert.ok(result)
  // 1,150 prompt + 10 output + 5 reasoning
  assert.equal(result.measured, 1_165)
  assert.equal(result.estimated, 2)
  assert.equal(result.total, 1_167)
  assert.equal(result.anchorID, "msg_a")
})

test("an assistant response from another provider is not used as the anchor", () => {
  const result = measureContext(
    messages([assistant({ model: { providerID: "other", id: "model" } })]),
    { providerID: "test", id: "model" },
  )
  assert.equal(result, undefined)
})

test("messages before the anchor are already in the measured count", () => {
  const result = measureContext(
    messages([
      { type: "user", id: "msg_u1", time: { created: 1 }, text: "a".repeat(4_000) },
      assistant(),
    ]),
  )
  assert.ok(result)
  assert.equal(result.estimated, 0)
})

test("image attachments use a fixed estimate instead of their base64 payload", () => {
  const size = estimateMessage(
    messages([
      {
        type: "user",
        id: "msg_u",
        time: { created: 1 },
        text: "",
        files: [{ data: "A".repeat(400_000), mime: "image/png", source: { type: "inline" } }],
      },
    ])[0]!,
  )
  assert.equal(size, 1_500)
})

test("a completed compaction is reported so Compaction can wait", () => {
  const state = compactionState(
    messages([
      {
        type: "compaction",
        id: "msg_c",
        time: { created: 1 },
        status: "completed",
        reason: "manual",
        summary: "summary",
      },
    ]),
  )
  assert.equal(state, "completed")
})
