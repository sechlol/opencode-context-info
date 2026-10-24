// View-model and record types, deliberately independent of OpenCode schemas.
// `data.ts` is the only module that converts OpenCode shapes into these.

export type Usage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type UsageRecord = {
  at: number
  /** false for in-progress / errored steps (excluded from totals) */
  completed: boolean
  kind: "assistant" | "compaction"
  agent?: string
  model: { providerID: string; id: string; variant?: string }
  /** undefined when the provider reported no usage for this step */
  usage?: Usage
  /** 0 when unknown; distinguish "free" from "unknown" via usage presence */
  cost: number
  toolCalls: number
}

export type ModelUsage = {
  providerID: string
  id: string
  variant?: string
  steps: number
  tokens: number
  cost: number
}

export type StepRow = {
  at: number
  status: "running" | "error" | "ok"
  model: string
  input: number
  output: number
  reasoning: number
  cost: number
  toolCalls: number
}

export type SubagentRow = {
  sessionID: string
  title: string
  tokens: number
  cost: number
}

export type ProjectStats = {
  rangeFrom: number
  rangeTo: number
  sessions: number
  subagents: number
  prompts: number
  steps: number
  tokens: number
  cost: number
}

export type SessionSnapshot = {
  sessionID: string
  title?: string
  status: "idle" | "running"
  updatedAt: number
  /** authoritative session totals as reported by opencode */
  sessionTokens?: Usage
  sessionCost?: number
  contextLimit?: number
  contextUsed?: number
  records: UsageRecord[]
  subagents: SubagentRow[]
  project?: ProjectStats
  /** non-fatal issues to surface in the UI */
  warnings: string[]
}

export type StatsViewModel = {
  title: string
  status: "idle" | "running"
  updatedAt: number
  /** authoritative, from SessionInfo */
  totals: Usage
  totalCost: number
  /** sum of attributed records, per category */
  attributed: Usage
  attributedCost: number
  /** sessionTotals − attributed; material values render as "other/auxiliary" */
  unattributed: Usage
  unattributedCost: number
  attributedSteps: number
  runningSteps: number
  context?: { used: number; limit: number }
  models: ModelUsage[]
  steps: StepRow[]
  subagents: SubagentRow[]
  project?: ProjectStats
  warnings: string[]
}

export const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

export function usageTotal(u: Usage): number {
  return u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite
}

export function addUsage(a: Usage, b: Usage | undefined): Usage {
  if (!b) return { ...a }
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

export function subUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input - b.input,
    output: a.output - b.output,
    reasoning: a.reasoning - b.reasoning,
    cacheRead: a.cacheRead - b.cacheRead,
    cacheWrite: a.cacheWrite - b.cacheWrite,
  }
}
