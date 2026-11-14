import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { Plugin } from "@opencode/plugin"
import { createCompaction } from "../src/compaction.js"

type Event = unknown

class EventQueue implements AsyncIterable<Event> {
  private readonly items: Event[] = []
  private readonly waiters: Array<(value: IteratorResult<Event>) => void> = []

  push(event: Event): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.items.push(event)
  }

  next(): Promise<IteratorResult<Event>> {
    if (this.items.length > 0) {
      return Promise.resolve({ value: this.items.shift()!, done: false })
    }
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  [Symbol.asyncIterator](): AsyncIterator<Event> {
    return { next: () => this.next() }
  }
}

function withTimeout<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ])
}

test("reaching the threshold requests one compaction, and a session override stops it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compaction-"))
  const configPath = join(directory, "esuyo-opencode-compaction.json")
  await writeFile(
    configPath,
    JSON.stringify({ triggerTokens: 100, debounceMs: 0, enabled: true }),
  )

  const events = new EventQueue()
  const model = { providerID: "test", id: "model" }
  const messages = [
    { type: "user", id: "msg_u", time: { created: 1 }, text: "hello" },
    {
      type: "assistant",
      id: "msg_a",
      time: { created: 2 },
      agent: "build",
      model,
      content: [{ type: "text", text: "hi" }],
      tokens: {
        input: 80,
        output: 10,
        reasoning: 10,
        cache: { read: 0, write: 0 },
      },
    },
  ]

  let compactCalls = 0
  let resolveCompaction: (() => void) | undefined
  const compacted = new Promise<void>((resolve) => {
    resolveCompaction = resolve
  })

  const stored = new Map<string, unknown>()
  const rpcHandlers: Record<string, (input: unknown) => Promise<unknown>> = {}

  const ctx = {
    location: { directory },
    options: {},
    app: { version: "test" },
    model: {
      list: async () => ({
        location: { directory },
        data: [{ ...model, limit: { context: 1_000, output: 1_000 } }],
      }),
    },
    session: {
      get: async () => ({ model }),
      context: async () => messages,
      compact: async () => {
        compactCalls++
        resolveCompaction?.()
        return {}
      },
    },
    storage: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => {
        stored.set(key, value)
      },
      remove: async (key: string) => {
        stored.delete(key)
      },
      scan: async () => ({ entries: [] }),
    },
    event: {
      subscribe: () => events,
    },
    command: {
      transform: async (callback: (editor: { add: (value: unknown) => void }) => void) => {
        callback({ add: () => {} })
        return { dispose: async () => {} }
      },
    },
    rpc: {
      register: async (
        _definition: unknown,
        handlers: Record<string, (input: unknown) => Promise<unknown>>,
      ) => {
        Object.assign(rpcHandlers, handlers)
        return {
          events: { emit: async () => {} },
          dispose: async () => {},
        }
      },
    },
  } as unknown as Plugin.Context

  const compaction = await createCompaction(ctx, { configPath })

  try {
    events.push({ type: "session.step.ended", data: { sessionID: "ses_test" } })
    await withTimeout(compacted)
    assert.equal(compactCalls, 1)

    // The next step must not request another compaction while the first is pending.
    events.push({ type: "session.step.ended", data: { sessionID: "ses_test" } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(compactCalls, 1)

    const off = (await rpcHandlers.configure!({
      sessionID: "ses_test",
      action: "off",
    })) as { text: string }
    assert.match(off.text, /OFF \(session override\)/)

    events.push({ type: "session.compaction.ended", data: { sessionID: "ses_test" } })
    events.push({ type: "session.step.ended", data: { sessionID: "ses_test" } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(compactCalls, 1)

    await rpcHandlers.configure!({ sessionID: "ses_test", action: "on" })
    events.push({ type: "session.step.ended", data: { sessionID: "ses_test" } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(compactCalls, 1, "cooldown after a compaction still applies")
  } finally {
    await compaction.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
