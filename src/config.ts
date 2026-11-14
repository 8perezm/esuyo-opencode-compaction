import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const CONFIG_FILE = "esuyo-opencode-compaction.json"

export interface CompactionConfig {
  /** Default for sessions that have no per-session override. */
  enabled: boolean
  /** Share of the model window kept free. 15 means compaction starts at 85% full. */
  reservePercent: number
  /** Absolute reserve in tokens. When set, overrides reservePercent. */
  reserveTokens: number | null
  /** Exact context size that triggers compaction. When set, overrides the window/reserve calculation. */
  triggerTokens: number | null
  /** Force a context window for every model. Defaults to 256k. Set null to use the selected model's limit. */
  contextWindow: number | null
  /** Window used when the model does not report one. */
  fallbackContextWindow: number
  /** Minimum time between context checks for one session. */
  debounceMs: number
  /** Show a toast when Compaction requests a compaction. */
  notify: boolean
  /** Log measurements to the OpenCode server log. */
  debug: boolean
}

export const DEFAULT_CONFIG: Readonly<CompactionConfig> = Object.freeze({
  enabled: true,
  reservePercent: 15,
  reserveTokens: null,
  triggerTokens: null,
  // Fixed reference window. Every model compacts at 256k - 15% = 217,600 tokens
  // unless this is explicitly set to null.
  contextWindow: 256_000,
  fallbackContextWindow: 256_000,
  debounceMs: 2_000,
  notify: false,
  debug: false,
})

export interface ModelLimit {
  readonly context?: number
  readonly input?: number
}

export interface EffectiveThreshold {
  readonly window: number
  readonly reserve: number
  readonly threshold: number
  readonly source: "triggerTokens" | "contextWindow" | "model" | "fallback"
}

/**
 * Resolve the config path the same way OpenCode resolves its own global
 * config: $XDG_CONFIG_HOME/opencode, otherwise ~/.config/opencode.
 */
export function defaultConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(home, ".config")
  return join(base, "opencode", CONFIG_FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function percentage(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().endsWith("%")
        ? Number.parseFloat(value)
        : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(99, Math.max(1, Math.round(parsed * 10) / 10))
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  return rounded > 0 ? rounded : null
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(60_000, Math.max(0, Math.round(value)))
}

/**
 * Accept the values a person is likely to put in the file and fall back to
 * defaults for anything unknown or out of range.
 */
export function normalizeConfig(value: unknown): CompactionConfig {
  const raw = isRecord(value) ? value : {}
  return {
    enabled: boolean(raw.enabled, DEFAULT_CONFIG.enabled),
    reservePercent: percentage(raw.reservePercent, DEFAULT_CONFIG.reservePercent),
    reserveTokens: positiveInteger(raw.reserveTokens),
    triggerTokens: positiveInteger(raw.triggerTokens),
    contextWindow: positiveInteger(raw.contextWindow),
    fallbackContextWindow:
      positiveInteger(raw.fallbackContextWindow) ?? DEFAULT_CONFIG.fallbackContextWindow,
    debounceMs: nonNegativeInteger(raw.debounceMs, DEFAULT_CONFIG.debounceMs),
    notify: boolean(raw.notify, DEFAULT_CONFIG.notify),
    debug: boolean(raw.debug, DEFAULT_CONFIG.debug),
  }
}

function stripTrailingCommas(text: string): string {
  let output = ""
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index++) {
    const char = text[index]

    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      output += char
      continue
    }

    if (char === ",") {
      let next = index + 1
      while (next < text.length && /\s/.test(text[next]!)) next++
      if (text[next] === "}" || text[next] === "]") continue
    }

    output += char
  }

  return output
}

/**
 * Remove comments and trailing commas so a JSONC file still loads. JSON itself
 * is a subset of this, so a plain .json file works too.
 */
export function parseJsonc(text: string): unknown {
  let output = ""
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    const next = text[index + 1]

    if (lineComment) {
      if (char === "\n") {
        lineComment = false
        output += char
      }
      continue
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        index++
      } else if (char === "\n") {
        output += char
      }
      continue
    }

    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      output += char
    } else if (char === "/" && next === "/") {
      lineComment = true
      index++
    } else if (char === "/" && next === "*") {
      blockComment = true
      index++
    } else {
      output += char
    }
  }

  // Commas before a closing bracket are not valid JSON.
  output = stripTrailingCommas(output)

  return JSON.parse(output.replace(/^\uFEFF/, ""))
}

function inputWindow(limit: ModelLimit | undefined): number {
  if (!limit) return 0
  const context = Number.isFinite(limit.context) ? Math.max(0, limit.context ?? 0) : 0
  const input = Number.isFinite(limit.input) ? Math.max(0, limit.input ?? 0) : 0
  if (input && context) return Math.min(input, context)
  return input || context
}

/**
 * Work out where compaction should start for one model.
 *
 * With the default config a 256k model triggers at 217,600 tokens
 * (256,000 - 15%). A model that reports no window uses the 256k fallback.
 */
export function thresholdFor(
  config: Pick<
    CompactionConfig,
    | "reservePercent"
    | "reserveTokens"
    | "triggerTokens"
    | "contextWindow"
    | "fallbackContextWindow"
  >,
  limit?: ModelLimit,
): EffectiveThreshold {
  const reported = inputWindow(limit)
  const window =
    config.contextWindow ?? (reported > 0 ? reported : config.fallbackContextWindow)
  const source: EffectiveThreshold["source"] =
    config.contextWindow !== null
      ? "contextWindow"
      : reported > 0
        ? "model"
        : "fallback"

  if (config.triggerTokens !== null) {
    const threshold = Math.max(1, Math.min(config.triggerTokens, window))
    return {
      window,
      reserve: Math.max(0, window - threshold),
      threshold,
      source: "triggerTokens",
    }
  }

  const requestedReserve =
    config.reserveTokens !== null
      ? config.reserveTokens
      : Math.round((window * config.reservePercent) / 100)
  const reserve = Math.min(requestedReserve, window - 1)

  return {
    window,
    reserve,
    threshold: Math.max(1, window - reserve),
    source,
  }
}

export interface ConfigReadResult {
  readonly config: CompactionConfig
  readonly path: string
}

/**
 * Reads the config on demand. The file's mtime is checked on every access, so
 * edits apply without restarting OpenCode, and a broken file keeps the last
 * good values instead of disabling Compaction.
 */
export class ConfigStore {
  readonly path: string
  private cached: CompactionConfig | undefined
  private mtimeMs = -1
  private lastError: string | undefined

  constructor(
    path: string,
    private readonly onError: (message: string) => void = (message) => console.error(message),
  ) {
    this.path = path
  }

  async get(force = false): Promise<ConfigReadResult> {
    let fileStat
    try {
      fileStat = await stat(this.path)
    } catch {
      // Missing file means defaults. Do not warn: the plugin works without it.
      this.cached = DEFAULT_CONFIG
      this.mtimeMs = -1
      return { config: this.cached, path: this.path }
    }

    if (!force && this.cached && fileStat.mtimeMs === this.mtimeMs) {
      return { config: this.cached, path: this.path }
    }

    try {
      const text = await readFile(this.path, "utf8")
      this.cached = normalizeConfig(parseJsonc(text))
      this.mtimeMs = fileStat.mtimeMs
      this.lastError = undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== this.lastError) {
        this.lastError = message
        this.onError(
          `[compaction] Could not read ${this.path}: ${message}. Using the last good config.`,
        )
      }
      this.cached ??= DEFAULT_CONFIG
    }

    return { config: this.cached, path: this.path }
  }
}
