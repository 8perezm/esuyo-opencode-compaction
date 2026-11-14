import assert from "node:assert/strict"
import { test } from "node:test"
import { parseCommandAction } from "../src/compaction.js"

test("no argument shows status", () => {
  assert.deepEqual(parseCommandAction(""), { kind: "status" })
  assert.deepEqual(parseCommandAction("   "), { kind: "status" })
})

test("on, off, toggle, reset and reload are parsed case-insensitively", () => {
  assert.deepEqual(parseCommandAction("ON"), { kind: "on" })
  assert.deepEqual(parseCommandAction("disable"), { kind: "off" })
  assert.deepEqual(parseCommandAction("toggle"), { kind: "toggle" })
  assert.deepEqual(parseCommandAction("clear"), { kind: "reset" })
  assert.deepEqual(parseCommandAction("reload"), { kind: "reload" })
})

test("extra arguments are ignored", () => {
  assert.deepEqual(parseCommandAction("off please"), { kind: "off" })
})

test("an unknown action is reported", () => {
  assert.deepEqual(parseCommandAction("explode"), { kind: "unknown", value: "explode" })
})
