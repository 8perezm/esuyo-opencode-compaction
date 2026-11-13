import type {
  ModelRef,
  SessionMessageAssistant,
  SessionMessageInfo,
  TokenUsageInfo,
} from "@opencode/client"

const CHARS_PER_TOKEN = 4
const IMAGE_TOKENS = 1_500
const PDF_TOKENS = 2_000

export interface Measurement {
  /** Prompt tokens the provider reported for the latest response. */
  readonly measured: number
  /** Estimated tokens added after that response. */
  readonly estimated: number
  readonly total: number
  readonly anchorID: string
  readonly anchorModel: ModelRef
}

export function estimateText(text: string | undefined): number {
  if (!text) return 0
  return Math.max(0, Math.round(text.length / CHARS_PER_TOKEN))
}

function estimateJson(value: unknown): number {
  if (value === undefined) return 0
  try {
    return estimateText(JSON.stringify(value))
  } catch {
    return 0
  }
}

function estimateMedia(mime: string | undefined, dataLength = 0): number {
  const type = mime?.toLowerCase() ?? ""
  if (type.startsWith("image/")) return IMAGE_TOKENS
  if (type === "application/pdf") return PDF_TOKENS
  if (type.startsWith("text/") || type === "application/json") {
    // The attachment is base64; a text attachment is inlined after decoding.
    return Math.round((dataLength * 0.75) / CHARS_PER_TOKEN)
  }
  return 0
}

/** Prompt tokens are everything the provider read: new input plus both cache kinds. */
export function promptTokens(tokens: TokenUsageInfo): number {
  return tokens.input + tokens.cache.read + tokens.cache.write
}

function estimateTool(part: SessionMessageAssistant["content"][number]): number {
  if (part.type !== "tool") return 0
  const state = part.state
  let total = estimateText(part.name)

  if (state.status === "streaming") {
    total += estimateText(state.input)
    return total
  }

  total += estimateJson(state.input)

  if (state.status === "completed") {
    for (const content of state.content) {
      total +=
        content.type === "text"
          ? estimateText(content.text)
          : estimateMedia(content.mime)
    }
  } else if (state.status === "error") {
    total += estimateText(state.error.message)
    for (const content of state.content ?? []) {
      total +=
        content.type === "text"
          ? estimateText(content.text)
          : estimateMedia(content.mime)
    }
  }

  return total
}

/**
 * Roughly how many tokens one stored message adds to the next request.
 * Attachments are sized by kind instead of by their base64 payload.
 */
export function estimateMessage(message: SessionMessageInfo): number {
  switch (message.type) {
    case "user": {
      let total = estimateText(message.text)
      for (const file of message.files ?? []) {
        total += estimateMedia(file.mime, file.data?.length)
      }
      return total
    }
    case "assistant": {
      let total = 0
      for (const part of message.content) {
        total +=
          part.type === "tool"
            ? estimateTool(part)
            : estimateText(part.text)
      }
      return total
    }
    case "compaction":
      return message.status === "failed" ? 0 : estimateText(message.summary)
    case "shell":
      return estimateText(message.command) + estimateText(message.output?.output)
    case "synthetic":
    case "system":
    case "skill":
      return estimateText(message.text)
    default:
      return 0
  }
}

function findAnchor(
  messages: readonly SessionMessageInfo[],
  expected?: ModelRef,
): { index: number; message: SessionMessageAssistant } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type !== "assistant") continue
    if (message.error || !message.tokens) continue
    if (promptTokens(message.tokens) <= 0) continue
    if (expected && message.model.providerID !== expected.providerID) continue
    return { index, message }
  }
  return undefined
}

/**
 * Estimate the prompt the next request would send.
 *
 * The provider's own count for the latest response is exact, but it does not
 * include messages or tool output produced after that response. Those are
 * estimated from text, exactly like OpenCode's built-in compaction does.
 *
 * Returns undefined until at least one response has been measured, because a
 * character estimate of a whole session (including system prompt and tools)
 * would be less reliable than simply waiting.
 */
export function measureContext(
  messages: readonly SessionMessageInfo[],
  expected?: ModelRef,
): Measurement | undefined {
  const anchor = findAnchor(messages, expected)
  if (!anchor) return undefined

  const tokens = anchor.message.tokens!
  const measured = promptTokens(tokens) + tokens.output + tokens.reasoning
  let estimated = 0
  for (let index = anchor.index + 1; index < messages.length; index++) {
    estimated += estimateMessage(messages[index]!)
  }

  return {
    measured,
    estimated,
    total: measured + estimated,
    anchorID: anchor.message.id,
    anchorModel: anchor.message.model,
  }
}

export type CompactionState = "none" | "running" | "completed" | "failed"

/** Mirrors OpenCode: a just-finished compaction is allowed to rebuild first. */
export function compactionState(messages: readonly SessionMessageInfo[]): CompactionState {
  const last = messages.at(-1)
  if (last?.type !== "compaction") return "none"
  return last.status
}
