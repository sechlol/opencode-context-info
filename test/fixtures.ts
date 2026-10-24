import type { UsageRecord } from "../src/types.ts"

let counter = 0

function usage(partial: Partial<UsageRecord["usage"]> = {}): NonNullable<UsageRecord["usage"]> {
  return {
    input: 1000,
    output: 100,
    reasoning: 50,
    cacheRead: 0,
    cacheWrite: 0,
    ...partial,
  }
}

export function assistantRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  counter++
  return {
    at: 1_700_000_000_000 + counter,
    completed: true,
    kind: "assistant",
    model: { providerID: "openrouter", id: "z-ai/glm-flash" },
    usage: usage(),
    cost: 0.01,
    toolCalls: 0,
    ...overrides,
  }
}

export function compactionRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return assistantRecord({ kind: "compaction", ...overrides })
}

export function runningRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return assistantRecord({ completed: false, usage: undefined, cost: 0, ...overrides })
}

export function erroredRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return assistantRecord({ completed: true, usage: undefined, cost: 0, ...overrides })
}

export const SESSION_TOTALS: {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
} = {
  input: 12_340,
  output: 3_210,
  reasoning: 1_870,
  cacheRead: 41_000,
  cacheWrite: 4_000,
}
