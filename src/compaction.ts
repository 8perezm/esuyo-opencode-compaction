import { Plugin } from "@opencode/plugin"
import type { ModelRef, SessionMessageInfo } from "@opencode/client"
import {
  ConfigStore,
  thresholdFor,
  type EffectiveThreshold,
  type CompactionConfig,
} from "./config"
import {
  compactionState,
  measureContext,
  type CompactionState,
  type Measurement,
} from "./measure"
import { CompactionRpc } from "./rpc"

const LOG_PREFIX = "[compaction]"
const COMMAND_NAME = "compaction"
const STORAGE_PREFIX = "session/"
const REQUEST_TIMEOUT_MS = 120_000
const SUCCESS_COOLDOWN_MS = 3_000
const FAILURE_COOLDOWN_MS = 60_000
const MAX_FAILURE_COOLDOWN_MS = 15 * 60_000

type ModelInfo = Awaited<ReturnType<Plugin.Context["model"]["list"]>>["data"][number]

interface SessionOverride {
  readonly enabled: boolean
  readonly updatedAt: number
  // Allows the value to be stored directly as plugin JSON.
  readonly [key: string]: boolean | number
}

interface SessionState {
  lastCheck: number
  checking: boolean
  requestedAt: number | undefined
  cooldownUntil: number
  failures: number
}

interface Inspection {
  readonly messages: readonly SessionMessageInfo[]
  readonly measurement: Measurement | undefined
  readonly modelRef: ModelRef | undefined
  readonly model: ModelInfo | undefined
  readonly threshold: EffectiveThreshold
  readonly compaction: CompactionState
}

export interface Compaction {
  dispose(): Promise<void>
}

export interface CompactionOptions {
  readonly configPath: string
}

type FeedbackVariant = "info" | "success" | "warning" | "error"

interface Feedback {
  readonly text: string
  readonly variant: FeedbackVariant
}

export type CompactionAction =
  | { readonly kind: "status" | "on" | "off" | "toggle" | "reset" | "reload" | "help" }
  | { readonly kind: "unknown"; readonly value: string }

export function parseCommandAction(text: string): CompactionAction {
  const value = text.trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  switch (value) {
    case "":
    case "status":
    case "show":
      return { kind: "status" }
    case "on":
    case "enable":
    case "true":
      return { kind: "on" }
    case "off":
    case "disable":
    case "false":
      return { kind: "off" }
    case "toggle":
      return { kind: "toggle" }
    case "reset":
    case "clear":
    case "default":
      return { kind: "reset" }
    case "reload":
      return { kind: "reload" }
    case "help":
    case "?":
      return { kind: "help" }
    default:
      return { kind: "unknown", value }
  }
}

function log(...args: unknown[]): void {
  console.log(LOG_PREFIX, ...args)
}

function logError(...args: unknown[]): void {
  console.error(LOG_PREFIX, ...args)
}

function formatTokens(value: number): string {
  return Math.round(value).toLocaleString("en-US")
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`
}

function sourceLabel(source: EffectiveThreshold["source"]): string {
  switch (source) {
    case "model":
      return "model window"
    case "contextWindow":
      return "fixed window"
    case "triggerTokens":
      return "triggerTokens"
    case "fallback":
      return "fallback window (model did not report one)"
  }
}

function backoff(failures: number): number {
  return Math.min(
    MAX_FAILURE_COOLDOWN_MS,
    FAILURE_COOLDOWN_MS * 2 ** Math.max(0, failures - 1),
  )
}

function helpText(): string {
  return [
    "Compaction commands:",
    `/${COMMAND_NAME}            show status`,
    `/${COMMAND_NAME} on         enable for this session`,
    `/${COMMAND_NAME} off        disable for this session`,
    `/${COMMAND_NAME} toggle     switch this session`,
    `/${COMMAND_NAME} reset      use the global default`,
    `/${COMMAND_NAME} reload     reread the config file`,
  ].join("\n")
}

export async function createCompaction(
  ctx: Plugin.Context,
  options: CompactionOptions,
): Promise<Compaction> {
  const store = new ConfigStore(options.configPath, logError)
  const initial = await store.get()

  const states = new Map<string, SessionState>()
  const overrides = new Map<string, SessionOverride | null>()
  const sessionModels = new Map<string, ModelRef>()
  const active = new Set<string>()

  let models = new Map<string, ModelInfo>()
  let modelsAt = 0

  function stateFor(sessionID: string): SessionState {
    let state = states.get(sessionID)
    if (!state) {
      state = {
        lastCheck: 0,
        checking: false,
        requestedAt: undefined,
        cooldownUntil: 0,
        failures: 0,
      }
      states.set(sessionID, state)
    }
    return state
  }

  async function loadModels(force = false): Promise<void> {
    if (!force && models.size > 0 && Date.now() - modelsAt < 60_000) return
    try {
      const result = await ctx.model.list()
      const next = new Map<string, ModelInfo>()
      for (const model of result.data) {
        next.set(`${model.providerID}/${model.id}`, model)
      }
      models = next
      modelsAt = Date.now()
    } catch (error) {
      logError("Could not read the model list:", error)
    }
  }

  async function modelFor(ref: ModelRef | undefined): Promise<ModelInfo | undefined> {
    if (!ref) return undefined
    await loadModels()
    return models.get(`${ref.providerID}/${ref.id}`)
  }

  async function sessionModel(sessionID: string): Promise<ModelRef | undefined> {
    const cached = sessionModels.get(sessionID)
    if (cached) return cached
    try {
      const session = await ctx.session.get({ sessionID })
      if (session.model) {
        sessionModels.set(sessionID, session.model)
        return session.model
      }
    } catch (error) {
      logError(`Could not read session ${sessionID}:`, error)
    }
    return undefined
  }

  function storageKey(sessionID: string): string {
    return `${STORAGE_PREFIX}${sessionID}`
  }

  async function overrideFor(sessionID: string): Promise<SessionOverride | undefined> {
    if (overrides.has(sessionID)) return overrides.get(sessionID) ?? undefined
    try {
      const raw = await ctx.storage.get(storageKey(sessionID))
      if (
        raw &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        typeof (raw as { enabled?: unknown }).enabled === "boolean"
      ) {
        const value = raw as { enabled: boolean; updatedAt?: number }
        const override = {
          enabled: value.enabled,
          updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
        }
        overrides.set(sessionID, override)
        return override
      }
    } catch (error) {
      logError(`Could not read the Compaction state for ${sessionID}:`, error)
    }
    overrides.set(sessionID, null)
    return undefined
  }

  async function setOverride(sessionID: string, enabled: boolean): Promise<void> {
    const value: SessionOverride = { enabled, updatedAt: Date.now() }
    await ctx.storage.set(storageKey(sessionID), value)
    overrides.set(sessionID, value)
  }

  async function clearOverride(sessionID: string): Promise<void> {
    await ctx.storage.remove(storageKey(sessionID))
    overrides.set(sessionID, null)
  }

  async function isEnabled(
    sessionID: string,
    config: CompactionConfig,
  ): Promise<{ enabled: boolean; override: SessionOverride | undefined }> {
    const override = await overrideFor(sessionID)
    return { enabled: override?.enabled ?? config.enabled, override }
  }

  async function inspect(sessionID: string, config: CompactionConfig): Promise<Inspection> {
    const messages = await ctx.session.context({ sessionID })
    const expected = await sessionModel(sessionID)
    const measurement = measureContext(messages, expected)
    const modelRef = measurement?.anchorModel ?? expected
    const model = await modelFor(modelRef)
    return {
      messages,
      measurement,
      modelRef,
      model,
      threshold: thresholdFor(config, model?.limit),
      compaction: compactionState(messages),
    }
  }

  async function check(
    sessionID: string,
    reason: "step" | "idle" | "model",
    force = false,
  ): Promise<void> {
    const { config } = await store.get()
    const state = stateFor(sessionID)
    const now = Date.now()

    // A busy turn emits one step end per tool call. On a huge session, loading the
    // whole context for every one of those is wasted work; the idle event is the
    // final safety net.
    if (!force && reason === "step" && now - state.lastCheck < config.debounceMs) return
    if (state.checking) return

    state.checking = true
    state.lastCheck = now

    try {
      const { enabled } = await isEnabled(sessionID, config)
      if (!enabled) return
      if (now < state.cooldownUntil) return
      if (active.has(sessionID)) return

      if (state.requestedAt !== undefined) {
        if (now - state.requestedAt < REQUEST_TIMEOUT_MS) return
        // The request never produced a compaction event; allow another try.
        state.requestedAt = undefined
      }

      const inspection = await inspect(sessionID, config)
      const measurement = inspection.measurement
      if (!measurement) return
      if (inspection.compaction !== "none") return

      const { threshold, window } = inspection.threshold
      if (measurement.total < threshold) return

      log(
        `Compacting ${sessionID}: ~${formatTokens(measurement.total)} / ${formatTokens(window)} tokens ` +
          `(${formatPercent((measurement.total / window) * 100)})`,
      )

      state.requestedAt = Date.now()
      try {
        await ctx.session.compact({ sessionID })
      } catch (error) {
        state.requestedAt = undefined
        state.failures++
        state.cooldownUntil = Date.now() + backoff(state.failures)
        logError(`Compaction request failed for ${sessionID}:`, error)
        return
      }

      if (config.notify) {
        await emitFeedback(sessionID, {
          text:
            `Compaction: context is ~${formatTokens(measurement.total)} of ` +
            `${formatTokens(window)} tokens (${formatPercent((measurement.total / window) * 100)}). ` +
            "Requesting compaction.",
          variant: "info",
        })
      }
    } catch (error) {
      logError(`Compaction check failed for ${sessionID}:`, error)
    } finally {
      state.checking = false
    }
  }

  function formatStatus(
    sessionID: string,
    inspection: Inspection,
    config: CompactionConfig,
    path: string,
    enabled: boolean,
    override: SessionOverride | undefined,
  ): string {
    const state = stateFor(sessionID)
    const { threshold, window, reserve, source } = inspection.threshold
    const origin = override ? "session override" : "global default"
    const lines = [
      `Compaction: ${enabled ? "ON" : "OFF"} (${origin})`,
      `Trigger: ${formatTokens(threshold)} / ${formatTokens(window)} tokens ` +
        `(${formatPercent((threshold / window) * 100)} full, reserve ${formatTokens(reserve)}; ${sourceLabel(source)})`,
    ]

    if (inspection.measurement) {
      const m = inspection.measurement
      lines.push(
        `Current: ~${formatTokens(m.total)} tokens ` +
          `(${formatPercent((m.total / window) * 100)} full; ` +
          `measured ${formatTokens(m.measured)} + ~${formatTokens(m.estimated)} since last response)`,
      )
    } else {
      lines.push("Current: unknown (waiting for the first measured response)")
    }

    if (inspection.compaction !== "none") {
      lines.push(`Compaction state: ${inspection.compaction}`)
    }
    if (active.has(sessionID) || state.requestedAt !== undefined) {
      lines.push("Status: compaction requested")
    } else if (Date.now() < state.cooldownUntil) {
      lines.push(`Status: cooling down for ${Math.ceil((state.cooldownUntil - Date.now()) / 1000)}s`)
    }
    if (config.debug) {
      lines.push(
        `Config: ${path}` +
          (inspection.modelRef
            ? ` (${inspection.modelRef.providerID}/${inspection.modelRef.id})`
            : ""),
      )
    } else {
      lines.push(`Config: ${path}`)
    }
    lines.push(`Commands: /${COMMAND_NAME} on|off|toggle|reset|reload`)
    return lines.join("\n")
  }

  async function statusFeedback(sessionID: string): Promise<Feedback> {
    const { config, path } = await store.get()
    const { enabled, override } = await isEnabled(sessionID, config)
    const inspection = await inspect(sessionID, config)
    return {
      text: formatStatus(sessionID, inspection, config, path, enabled, override),
      variant: enabled ? "info" : "warning",
    }
  }

  async function runAction(sessionID: string, action: CompactionAction): Promise<Feedback> {
    if (action.kind === "help") return { text: helpText(), variant: "info" }

    if (action.kind === "unknown") {
      return {
        text: `Unknown compaction action "${action.value}".\n\n${helpText()}`,
        variant: "error",
      }
    }

    let { config, path } = await store.get()

    switch (action.kind) {
      case "on":
        await setOverride(sessionID, true)
        break
      case "off":
        await setOverride(sessionID, false)
        break
      case "toggle": {
        const current = await isEnabled(sessionID, config)
        await setOverride(sessionID, !current.enabled)
        break
      }
      case "reset":
        await clearOverride(sessionID)
        break
      case "reload":
        ;({ config, path } = await store.get(true))
        break
      case "status":
        break
    }

    const { enabled, override } = await isEnabled(sessionID, config)
    const inspection = await inspect(sessionID, config)
    return {
      text: formatStatus(sessionID, inspection, config, path, enabled, override),
      variant: enabled ? "info" : "warning",
    }
  }

  const rpc = await ctx.rpc.register(CompactionRpc, {
    status: async (input) => {
      const { sessionID } = input as { sessionID: string }
      return { text: (await statusFeedback(sessionID)).text }
    },
    configure: async (input) => {
      const { sessionID, action } = input as {
        sessionID: string
        action: "status" | "on" | "off" | "toggle" | "reset" | "reload" | "help"
      }
      return { text: (await runAction(sessionID, { kind: action })).text }
    },
  })

  async function emitFeedback(sessionID: string, feedback: Feedback): Promise<void> {
    try {
      await rpc.events.emit("feedback", {
        sessionID,
        text: feedback.text,
        variant: feedback.variant,
      })
    } catch (error) {
      logError(`Could not emit feedback for ${sessionID}:`, error)
    }
  }

  const command = await ctx.command.transform((editor) => {
    editor.add({
      name: COMMAND_NAME,
      description: "Control early automatic compaction (on|off|status|toggle|reset)",
      execute: async (input) => {
        const action = parseCommandAction(input.prompt.text)
        const feedback = await runAction(input.sessionID, action)
        await emitFeedback(input.sessionID, feedback)
      },
    })
  })

  const controller = new AbortController()
  const types = [
    "session.step.ended",
    "session.idle",
    "session.model.selected",
    "session.agent.selected",
    "session.compaction.started",
    "session.compaction.ended",
    "session.compaction.failed",
    "session.deleted",
  ] as const

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({
        types: [...types],
        signal: controller.signal,
      })) {
        switch (event.type) {
          case "session.step.ended":
            void check(event.data.sessionID, "step")
            break
          case "session.idle":
            void check(event.data.sessionID, "idle")
            break
          case "session.model.selected":
            sessionModels.set(event.data.sessionID, event.data.model)
            void check(event.data.sessionID, "model", true)
            break
          case "session.agent.selected":
            // An agent can change the model, so re-read it before the next check.
            sessionModels.delete(event.data.sessionID)
            void check(event.data.sessionID, "model", true)
            break
          case "session.compaction.started":
            active.add(event.data.sessionID)
            stateFor(event.data.sessionID).requestedAt = undefined
            break
          case "session.compaction.ended": {
            const state = stateFor(event.data.sessionID)
            active.delete(event.data.sessionID)
            state.requestedAt = undefined
            state.failures = 0
            state.cooldownUntil = Date.now() + SUCCESS_COOLDOWN_MS
            break
          }
          case "session.compaction.failed": {
            const state = stateFor(event.data.sessionID)
            active.delete(event.data.sessionID)
            state.requestedAt = undefined
            state.failures++
            state.cooldownUntil = Date.now() + backoff(state.failures)
            logError(
              `Compaction failed in ${event.data.sessionID}:`,
              event.data.error?.message ?? event.data.error,
            )
            break
          }
          case "session.deleted": {
            const sessionID = event.data.sessionID
            states.delete(sessionID)
            active.delete(sessionID)
            sessionModels.delete(sessionID)
            overrides.delete(sessionID)
            void ctx.storage.remove(storageKey(sessionID)).catch(() => {})
            break
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) logError("Event stream stopped:", error)
    }
  })()

  if (initial.config.debug) {
    log(`Loaded config from ${initial.path}; reserve is ${initial.config.reservePercent}%`)
  }

  return {
    async dispose() {
      controller.abort()
      await command.dispose()
      await rpc.dispose()
    },
  }
}
