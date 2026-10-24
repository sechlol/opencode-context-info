// Pure aggregation: SessionSnapshot → StatsViewModel.
// No OpenCode imports, no I/O — fully fixture-testable.

import {
  addUsage,
  EMPTY_USAGE,
  subUsage,
  usageTotal,
  type ModelUsage,
  type SessionSnapshot,
  type StatsViewModel,
  type StepRow,
  type Usage,
  type UsageRecord,
} from "./types.ts"
import { modelKey } from "./keys.ts"

/** How many recent steps the dialog shows by default. */
export const STEP_ROWS = 10

export function buildViewModel(snapshot: SessionSnapshot): StatsViewModel {
  const completed = snapshot.records.filter((r) => r.completed && r.usage)

  const totals: Usage = snapshot.sessionTokens ? { ...snapshot.sessionTokens } : { ...EMPTY_USAGE }


  // Attribution from records (assistant + compaction, completed only).
  let attributed = { ...EMPTY_USAGE }
  let attributedCost = 0
  for (const r of completed) {
    attributed = addUsage(attributed, r.usage)
    attributedCost += r.cost
  }
  if (!snapshot.sessionTokens) {
    // No authoritative total available — attributed becomes the best known truth.
    totals.input = attributed.input
    totals.output = attributed.output
    totals.reasoning = attributed.reasoning
    totals.cacheRead = attributed.cacheRead
    totals.cacheWrite = attributed.cacheWrite
  }
  const sessionCostKnown = snapshot.sessionCost !== undefined

  const unattributed = sessionCostKnown || snapshot.sessionTokens ? subUsage(totals, attributed) : { ...EMPTY_USAGE }
  const unattributedCost = sessionCostKnown ? (snapshot.sessionCost ?? 0) - attributedCost : 0

  const models = aggregateModels(completed)
  const steps = toStepRows(snapshot.records)

  const attributedSteps = completed.length
  const runningSteps = snapshot.records.filter((r) => !r.completed).length

  const context =
    snapshot.contextUsed !== undefined && snapshot.contextLimit !== undefined && snapshot.contextLimit > 0
      ? { used: snapshot.contextUsed, limit: snapshot.contextLimit }
      : undefined

  const warnings = [...snapshot.warnings]

  // Flag material unattributed usage so the UI can explain (or fail to explain) the bill.
  const totalReported = usageTotal(totals)
  const totalAttributed = usageTotal(attributed)
  if (totalReported > 0 && totalAttributed === 0) {
    warnings.push("usage reported but no attributed steps found")
  } else if (totalReported > 0 && totalAttributed / totalReported < 0.9) {
    warnings.push(`${Math.round((1 - totalAttributed / totalReported) * 100)}% of usage unattributed to steps`)
  }

  return {
    title: snapshot.title ?? "Untitled",
    status: snapshot.status,
    updatedAt: snapshot.updatedAt,
    totals,
    totalCost: sessionCostKnown ? (snapshot.sessionCost ?? 0) : attributedCost,
    attributed,
    attributedCost,
    unattributed,
    unattributedCost,
    attributedSteps,
    runningSteps,
    context,
    models,
    steps,
    subagents: snapshot.subagents,
    project: snapshot.project,
    warnings,
  }
}

function aggregateModels(records: UsageRecord[]): ModelUsage[] {
  const byKey = new Map<string, ModelUsage & { _counted: boolean }>()
  for (const r of records) {
    const key = modelKey(r.model)
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        providerID: r.model.providerID,
        id: r.model.id,
        variant: r.model.variant,
        steps: 0,
        tokens: 0,
        cost: 0,
        _counted: false,
      }
      byKey.set(key, entry)
    }
    entry.steps++
    entry.tokens += usageTotal(r.usage!)
    entry.cost += r.cost
  }
  return [...byKey.values()]
    .map(({ _counted, ...m }): ModelUsage => m)
    .sort((a, b) => b.tokens - a.tokens)
}

function toStepRows(records: UsageRecord[]): StepRow[] {
  const rows: StepRow[] = []
  for (const r of records) {
    const usage = r.usage
    if (!usage) {
      rows.push({
        at: r.at,
        status: r.completed ? "error" : "running",
        model: modelKey(r.model),
        input: 0,
        output: 0,
        reasoning: 0,
        cost: 0,
        toolCalls: r.toolCalls,
      })
      continue
    }
    rows.push({
      at: r.at,
      status: "ok",
      model: modelKey(r.model),
      input: usage.input,
      output: usage.output,
      reasoning: usage.reasoning,
      cost: r.cost,
      toolCalls: r.toolCalls,
    })
  }
  return rows.sort((a, b) => b.at - a.at)
}

/** Current-context estimate: the prompt side of the most recent completed step. */
export function estimateContextUsed(records: UsageRecord[]): number | undefined {
  const completed = records
    .filter((r) => r.completed && r.usage)
    .sort((a, b) => b.at - a.at)
  const last = completed[0]
  if (!last?.usage) return undefined
  return last.usage.input + last.usage.cacheRead + last.usage.cacheWrite
}
