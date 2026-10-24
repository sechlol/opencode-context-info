import assert from "node:assert/strict"
import { test } from "node:test"
import {
  formatClock,
  formatCompact,
  formatCost,
  formatNumber,
  formatRange,
  formatRelative,
  truncateMiddle,
} from "../src/format.ts"

test("formatNumber", () => {
  assert.equal(formatNumber(0), "0")
  assert.equal(formatNumber(999), "999")
  assert.equal(formatNumber(1000), "1,000")
  assert.equal(formatNumber(1234567), "1,234,567")
  assert.equal(formatNumber(-42), "-42")
  assert.equal(formatNumber(NaN), "—")
})

test("formatCompact", () => {
  assert.equal(formatCompact(0), "0")
  assert.equal(formatCompact(999), "999")
  assert.equal(formatCompact(1000), "1k")
  assert.equal(formatCompact(1050), "1.1k")
  assert.equal(formatCompact(12_340), "12.3k")
  assert.equal(formatCompact(1_050_000), "1.1M")
  assert.equal(formatCompact(2_500_000_000), "2.5B")
})

test("formatCost never fabricates precision", () => {
  assert.equal(formatCost(0), "$0")
  assert.equal(formatCost(undefined), "—")
  assert.equal(formatCost(NaN), "—")
  assert.equal(formatCost(0.0012), "$0.0012")
  assert.equal(formatCost(0.184), "$0.184")
  assert.equal(formatCost(1.5), "$1.5")
  assert.equal(formatCost(123.456), "$123")
  assert.equal(formatCost(-0.5), "-$0.5")
})

test("formatClock is stable", () => {
  assert.equal(formatClock(new Date(2026, 0, 1, 14, 32).getTime()), "14:32")
  assert.equal(formatClock(new Date(2026, 0, 1, 3, 5).getTime()), "03:05")
})

test("formatRelative", () => {
  const now = 1_000_000_000
  assert.equal(formatRelative(now - 30_000, now), "just now")
  assert.equal(formatRelative(now - 5 * 60_000, now), "5m ago")
  assert.equal(formatRelative(now - 3 * 3_600_000, now), "3h ago")
  assert.equal(formatRelative(now - 2 * 86_400_000, now), "2d ago")
})

test("formatRange", () => {
  const day = 86_400_000
  assert.equal(formatRange(0, day), "today")
  assert.equal(formatRange(0, 7 * day), "last 7 days")
  assert.equal(formatRange(0, 45 * day), "last 2 months")
  assert.equal(formatRange(0, 400 * day), "last 1 year")
  assert.equal(formatRange(0, 800 * day), "last 2 years")
})

test("truncateMiddle keeps both ends", () => {
  assert.equal(truncateMiddle("short", 10), "short")
  assert.equal(truncateMiddle("openrouter/z-ai/glm-flash-latest", 20).length, 20)
  assert.ok(truncateMiddle("openrouter/z-ai/glm-flash-latest", 20).includes("…"))
  assert.equal(truncateMiddle("abcdef", 5), "ab…ef")
})
