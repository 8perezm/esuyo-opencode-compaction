import assert from "node:assert/strict"
import { test } from "node:test"
import {
  DEFAULT_CONFIG,
  normalizeConfig,
  parseJsonc,
  thresholdFor,
} from "../src/config.js"

test("defaults compact every model at 256k - 15%", () => {
  const result = thresholdFor(DEFAULT_CONFIG, { context: 256_000 })
  assert.equal(result.window, 256_000)
  assert.equal(result.reserve, 38_400)
  assert.equal(result.threshold, 217_600)
  assert.equal(result.source, "contextWindow")
})

test("the default trigger is the same on a model with another window", () => {
  const result = thresholdFor(DEFAULT_CONFIG, { context: 1_000_000 })
  assert.equal(result.window, 256_000)
  assert.equal(result.threshold, 217_600)
  assert.equal(result.source, "contextWindow")
})

test("the fixed default applies even when the model reports no window", () => {
  const result = thresholdFor(DEFAULT_CONFIG, undefined)
  assert.equal(result.window, 256_000)
  assert.equal(result.threshold, 217_600)
  assert.equal(result.source, "contextWindow")
})

test("contextWindow: null follows the model window, then the fallback", () => {
  const config = { ...DEFAULT_CONFIG, contextWindow: null }
  assert.deepEqual(
    (({ window, threshold, source }) => ({ window, threshold, source }))(
      thresholdFor(config, { context: 1_000_000 }),
    ),
    { window: 1_000_000, threshold: 850_000, source: "model" },
  )
  assert.deepEqual(
    (({ window, threshold, source }) => ({ window, threshold, source }))(
      thresholdFor(config, undefined),
    ),
    { window: 256_000, threshold: 217_600, source: "fallback" },
  )
})

test("contextWindow and reserveTokens override the calculated values", () => {
  const result = thresholdFor(
    {
      ...DEFAULT_CONFIG,
      contextWindow: 128_000,
      reserveTokens: 20_000,
    },
    { context: 1_000_000 },
  )
  assert.equal(result.window, 128_000)
  assert.equal(result.reserve, 20_000)
  assert.equal(result.threshold, 108_000)
})

test("triggerTokens is an exact trigger and is capped to the window", () => {
  assert.equal(
    thresholdFor({ ...DEFAULT_CONFIG, triggerTokens: 150_000 }, { context: 256_000 })
      .threshold,
    150_000,
  )
  assert.equal(
    thresholdFor({ ...DEFAULT_CONFIG, triggerTokens: 300_000 }, { context: 256_000 })
      .threshold,
    256_000,
  )
})

test("a percentage string is accepted", () => {
  const config = normalizeConfig({ reservePercent: "12.5%" })
  assert.equal(config.reservePercent, 12.5)
})

test("invalid and out-of-range values fall back safely", () => {
  const config = normalizeConfig({
    enabled: "yes",
    reservePercent: 500,
    reserveTokens: -1,
    fallbackContextWindow: 0,
    debounceMs: 999_999,
  })
  assert.equal(config.enabled, DEFAULT_CONFIG.enabled)
  assert.equal(config.reservePercent, 99)
  assert.equal(config.reserveTokens, null)
  assert.equal(config.fallbackContextWindow, DEFAULT_CONFIG.fallbackContextWindow)
  assert.equal(config.debounceMs, 60_000)
})

test("JSONC comments and trailing commas are accepted", () => {
  const parsed = parseJsonc(`{
    // a comment
    "enabled": true,
    "reservePercent": 20, /* inline */
  }`)
  assert.deepEqual(parsed, { enabled: true, reservePercent: 20 })
})

test("comment markers inside strings are preserved", () => {
  const parsed = parseJsonc(`{"path": "C:/a//b/*c*/"}`)
  assert.deepEqual(parsed, { path: "C:/a//b/*c*/" })
})
