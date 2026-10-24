import assert from "node:assert/strict"
import { test } from "node:test"
import { buildViewModel, estimateContextUsed, STEP_ROWS } from "../src/stats.ts"
import {
  assistantRecord,
  compactionRecord,
  erroredRecord,
  runningRecord,
  SESSION_TOTALS,
} from "./fixtures.ts"
import { usageTotal } from "../src/types.ts"

test("aggregates assistant records into totals, models and steps", () => {
  const records = [
    assistantRecord({ model: { providerID: "a", id: "m1" }, usage: { input: 100, output: 10, reasoning: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0.1 }),
    assistantRecord({ model: { providerID: "a", id: "m1" }, usage: { input: 200, output: 20, reasoning: 0, cacheRead: 50, cacheWrite: 0 }, cost: 0.2 }),
    assistantRecord({ model: { providerID: "b", id: "m2" }, usage: { input: 400, output: 40, reasoning: 0, cacheRead: 0, cacheWrite: 7 }, cost: 0.4 }),
  ]
  const vm = buildViewModel({ sessionID: "s", status: "idle", updatedAt: 0, records, subagents: [], warnings: [] })

  assert.equal(vm.attributed.input, 700)
  assert.equal(vm.attributed.output, 70)
  assert.equal(vm.attributed.cacheRead, 50)
  assert.equal(vm.attributed.cacheWrite, 7)
  assert.ok(Math.abs(vm.attributedCost - 0.7) < 1e-9)
  assert.equal(vm.totalCost, vm.attributedCost) // no authoritative cost → attributed is truth
  assert.equal(vm.attributedSteps, 3)
  assert.equal(vm.runningSteps, 0)

  // per-model grouping
  assert.equal(vm.models.length, 2)
  const m1 = vm.models.find((m) => m.id === "m1")!
  assert.equal(m1.steps, 2)
  assert.equal(m1.tokens, 385) // (100+10+5) + (200+20+50)
  const m2 = vm.models.find((m) => m.id === "m2")!
  assert.equal(m2.tokens, 447) // 400+40+7

  // steps sorted newest-first
  assert.equal(vm.steps.length, 3)
  assert.ok(vm.steps[0]!.at >= vm.steps[1]!.at)
})

test("authoritative session totals are used with reconciliation", () => {
  const records = [assistantRecord({ usage: { input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.01 })]
  const vm = buildViewModel({
    sessionID: "s",
    status: "idle",
    updatedAt: 0,
    sessionTokens: SESSION_TOTALS,
    sessionCost: 0.5,
    records,
    subagents: [],
    warnings: [],
  })

  assert.equal(vm.totals.input, SESSION_TOTALS.input)
  assert.equal(vm.totals.cacheRead, SESSION_TOTALS.cacheRead)
  assert.equal(vm.totalCost, 0.5)
  assert.equal(vm.attributed.input, 100)
  assert.equal(vm.unattributed.input, SESSION_TOTALS.input - 100)
  assert.ok(vm.unattributedCost > 0)
  // <90% attributed → warning present
  assert.ok(vm.warnings.some((w) => w.includes("unattributed")))
})

test("in-progress and errored steps are excluded from totals but listed", () => {
  const records = [
    assistantRecord(),
    runningRecord(),
    erroredRecord(),
  ]
  const vm = buildViewModel({ sessionID: "s", status: "running", updatedAt: 0, records, subagents: [], warnings: [] })
  assert.equal(vm.attributedSteps, 1)
  assert.equal(vm.runningSteps, 1)
  assert.equal(vm.steps.find((s) => s.status === "running")!.model, "openrouter/z-ai/glm-flash")
  assert.equal(vm.steps.find((s) => s.status === "error")!.output, 0)
})

test("compaction records contribute to attribution", () => {
  const records = [
    assistantRecord({ usage: { input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
    compactionRecord({ usage: { input: 500, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.05 }),
  ]
  const vm = buildViewModel({ sessionID: "s", status: "idle", updatedAt: 0, records, subagents: [], warnings: [] })
  assert.equal(vm.attributed.input, 600)
  assert.ok(Math.abs(vm.attributedCost - 0.06) < 1e-9)
})

test("same model with different variants groups separately", () => {
  const records = [
    assistantRecord({ model: { providerID: "p", id: "m", variant: "high" } }),
    assistantRecord({ model: { providerID: "p", id: "m", variant: "low" } }),
    assistantRecord({ model: { providerID: "p", id: "m" } }),
  ]
  const vm = buildViewModel({ sessionID: "s", status: "idle", updatedAt: 0, records, subagents: [], warnings: [] })
  assert.equal(vm.models.length, 3)
})

test("empty session → zero attribution, no fabricated totals", () => {
  const vm = buildViewModel({ sessionID: "s", status: "idle", updatedAt: 0, records: [], subagents: [], warnings: [] })
  assert.equal(vm.attributedSteps, 0)
  assert.equal(vm.totalCost, 0)
  assert.equal(vm.models.length, 0)
  assert.equal(vm.context, undefined)
  assert.equal(vm.warnings.length, 0)
})

test("usage reported but nothing attributable → warning", () => {
  const vm = buildViewModel({
    sessionID: "s",
    status: "idle",
    updatedAt: 0,
    sessionTokens: SESSION_TOTALS,
    sessionCost: 0.5,
    records: [],
    subagents: [],
    warnings: [],
  })
  assert.ok(vm.warnings.some((w) => w.includes("no attributed steps")))
})

test("subagents pass through; project stats pass through", () => {
  const subagents = [
    { sessionID: "c1", title: "explore", tokens: 6100, cost: 0.009 },
    { sessionID: "c2", title: "review", tokens: 3100, cost: 0.004 },
  ]
  const project = {
    rangeFrom: 0,
    rangeTo: 0,
    sessions: 4,
    subagents: 3,
    prompts: 10,
    steps: 40,
    tokens: 310_000,
    cost: 1.02,
  }
  const vm = buildViewModel({
    sessionID: "s",
    status: "idle",
    updatedAt: 0,
    records: [assistantRecord()],
    subagents,
    project,
    warnings: [],
  })
  assert.equal(vm.subagents.length, 2)
  assert.equal(vm.project?.tokens, 310_000)
})

test("estimateContextUsed uses the newest completed step's prompt side", () => {
  const records = [
    assistantRecord({ at: 1000, usage: { input: 100, output: 10, reasoning: 0, cacheRead: 500, cacheWrite: 40 } }),
    assistantRecord({ at: 2000, usage: { input: 200, output: 20, reasoning: 0, cacheRead: 800, cacheWrite: 0 } }),
  ]
  assert.equal(estimateContextUsed(records), 200 + 800 + 0)
})

test("estimateContextUsed ignores running/errored steps", () => {
  const records = [runningRecord({ at: 3000 }), erroredRecord({ at: 2500 }), assistantRecord({ at: 1000 })]
  assert.ok(estimateContextUsed(records)! > 0)
})

test("step rows are capped by the view later, stats keep everything", () => {
  const records = Array.from({ length: STEP_ROWS + 5 }, (_, i) => assistantRecord({ at: i }))
  const vm = buildViewModel({ sessionID: "s", status: "idle", updatedAt: 0, records, subagents: [], warnings: [] })
  assert.equal(vm.steps.length, STEP_ROWS + 5)
  assert.ok(vm.steps[0]!.at! > vm.steps[1]!.at!)
})
