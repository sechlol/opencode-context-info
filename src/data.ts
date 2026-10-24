// Async I/O: loads a SessionSnapshot from the opencode client + cached data.
// This is the ONLY module that knows OpenCode schema details; everything
// downstream consumes the view-model types from types.ts.
//
// LoadContext is Pick-ed from the real TUI plugin Context shipped with
// @opencode/plugin (`@opencode/plugin/tui/context`), so every member signature
// is the installed one — no hand-rolled schema guesses. The full Context
// passed to `setup(ctx)` satisfies it structurally, so call sites need no
// casts, while tests can still mock just the members they exercise.

import type { Context } from "@opencode/plugin/tui/context"
import type { SessionMessageInfo, SessionInfo, TokenUsageInfo } from "@opencode/client"
import type { UsageRecord, SessionSnapshot, Usage } from "./types.ts"
import { latestCompletedStep, promptTokens } from "./stats.ts"

export type LoadContext = {
  client: {
    session: Pick<Context["client"]["session"], "list" | "stats">
    location: Pick<Context["client"]["location"], "get">
  }
  data: {
    session: Pick<Context["data"]["session"], "list" | "get" | "root" | "family" | "cost" | "status" | "sync"> & {
      message: Pick<Context["data"]["session"]["message"], "list" | "sync" | "invalidate">
    }
    location: Pick<Context["data"]["location"], "default"> & {
      model: Pick<Context["data"]["location"]["model"], "list">
    }
  }
  ui: {
    model: Pick<Context["ui"]["model"], "current">
  }
}

/** Convert the client's TokenUsageInfo into the internal Usage shape. */
export function toUsage(t: TokenUsageInfo | undefined): Usage | undefined {
  if (!t) return undefined
  return {
    input: num(t.input),
    output: num(t.output),
    reasoning: num(t.reasoning),
    cacheRead: num(t.cache?.read),
    cacheWrite: num(t.cache?.write),
  }
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Normalize messages into UsageRecords; unknown shapes are skipped and counted. */
export function normalizeMessages(messages: readonly SessionMessageInfo[]): {
  records: UsageRecord[]
  skipped: number
} {
  const records: UsageRecord[] = []
  let skipped = 0
  for (const m of messages) {
    try {
      // SessionMessageInfo is a discriminated union on `type` — narrowing
      // gives fully typed fields (no structural guessing).
      if (m.type === "assistant") {
        const usage = toUsage(m.tokens)
        records.push({
          at: num(m.time.created),
          completed: usage !== undefined && m.finish !== "error",
          kind: "assistant",
          agent: m.agent,
          model: {
            providerID: m.model.providerID,
            id: m.model.id,
            variant: m.model.variant,
          },
          usage,
          cost: usage !== undefined ? num(m.cost) : 0,
          toolCalls: m.content.filter((part) => part.type === "tool").length,
        })
        continue
      }
      if (m.type === "compaction") {
        // "running" compactions carry no usage yet and are not steps.
        if (m.status !== "completed" && m.status !== "failed") continue
        const usage = toUsage(m.tokens)
        records.push({
          at: num(m.time.created),
          completed: usage !== undefined && m.status !== "failed",
          kind: "compaction",
          model:
            "model" in m && m.model
              ? { providerID: m.model.providerID, id: m.model.id, variant: m.model.variant }
              : { providerID: "unknown", id: "compaction" },
          usage,
          cost: usage !== undefined ? num(m.cost) : 0,
          toolCalls: 0,
        })
        continue
      }
      skipped++
    } catch {
      // Defensive: a degraded message must not take the whole panel down.
      skipped++
    }
  }
  return { records, skipped }
}

/** Session totals straight from the authoritative SessionInfo record. */
function sessionUsage(session: SessionInfo | undefined): Usage | undefined {
  const t = session?.tokens
  if (!t) return undefined
  return {
    input: num(t.input),
    output: num(t.output),
    reasoning: num(t.reasoning),
    cacheRead: num(t.cache?.read),
    cacheWrite: num(t.cache?.write),
  }
}

/** Directory → project id cache for the rare degraded-session fallback. */
const projectIDCache = new Map<string, string>()

/**
 * Project id for a session: SessionInfo carries it directly (typed, no cast),
 * with a location lookup as the only fallback for degraded session info.
 */
async function resolveProjectID(
  ctx: LoadContext,
  directory: string,
  session: SessionInfo | undefined,
): Promise<string | undefined> {
  if (session?.projectID) return session.projectID
  const cached = projectIDCache.get(directory)
  if (cached) return cached
  try {
    const info = await ctx.client.location.get({ location: { directory } })
    if (info?.project?.id) {
      projectIDCache.set(directory, info.project.id)
      return info.project.id
    }
  } catch {
    // non-fatal
  }
  return undefined
}

/**
 * Load everything the stats view needs. Individual failures degrade to
 * warnings — only a total failure of the session's own data rejects.
 */
export async function loadSnapshot(
  ctx: LoadContext,
  sessionID: string,
  options: { projectStats?: boolean; directory?: string } = {},
): Promise<SessionSnapshot> {
  const warnings: string[] = []

  const settled = await Promise.allSettled([
    ctx.data.session.sync(sessionID),
    ctx.data.session.message.sync(sessionID),
    Promise.resolve(ctx.data.session.get(sessionID)),
    Promise.resolve(ctx.data.session.message.list(sessionID)),
    Promise.resolve(ctx.data.session.family(sessionID)),
    Promise.resolve(ctx.data.session.status(sessionID)),
    Promise.resolve(ctx.data.session.cost(sessionID)),
  ])

  if (settled[0]?.status === "rejected") warnings.push("session sync failed")
  if (settled[1]?.status === "rejected") warnings.push("message sync failed")

  const session = settled[2]?.status === "fulfilled" ? settled[2].value : undefined
  const messages = settled[3]?.status === "fulfilled" ? (settled[3].value ?? []) : []
  const family = settled[4]?.status === "fulfilled" ? (settled[4].value ?? []) : []
  const status = settled[5]?.status === "fulfilled" ? settled[5].value : "idle"
  const reportedCost = settled[6]?.status === "fulfilled" ? settled[6].value : undefined

  if (!session && messages.length === 0) {
    // Nothing cached and nothing synced — the session is unknown to this server.
    throw new Error(`session ${sessionID} not found`)
  }
  if (!session && messages.length > 0) {
    warnings.push("session info unavailable")
  }

  const { records, skipped } = normalizeMessages(messages)
  if (skipped > 0) warnings.push(`${skipped} message(s) with unknown shape skipped`)

  // Subagents: family may include this session itself — exclude it, and
  // sync each child so the cached info is fresh. Nested descendants are
  // deduplicated: a child rooted at another child is dropped (its parent's
  // SessionInfo already reports the whole subtree).
  const childIDs = [...new Set(family)].filter((id) => id && id !== sessionID)
  const ownRoot = safeRoot(ctx, sessionID)
  const childIDSet = new Set(childIDs)
  const subagentRows: SessionSnapshot["subagents"] = []
  const subagentResults = await Promise.allSettled(
    childIDs.map(async (id) => {
      await ctx.data.session.sync(id).catch(() => undefined)
      const info = ctx.data.session.get(id)
      const usage = sessionUsage(info)
      return {
        sessionID: id,
        title: info?.title ?? "Untitled",
        tokens: usage
          ? usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
          : 0,
        cost: num(info?.cost),
        root: safeRoot(ctx, id),
      }
    }),
  )
  for (const r of subagentResults) {
    if (r.status !== "fulfilled") continue
    const v = r.value
    // A child whose root is ANOTHER CHILD of this family is a nested
    // descendant: its parent-child's SessionInfo already reports the subtree,
    // so summing both would double-count. Children rooted at the session's
    // own root are direct children — keep them.
    if (v.root !== v.sessionID && childIDSet.has(v.root) && v.root !== ownRoot) continue
    if (v.tokens > 0 || v.cost > 0) {
      subagentRows.push({ sessionID: v.sessionID, title: v.title, tokens: v.tokens, cost: v.cost })
    }
  }

  // Project stats: best-effort, experimental endpoint.
  let project: SessionSnapshot["project"]
  if (options.projectStats !== false) {
    try {
      const directory = options.directory ?? ctx.data.location.default().directory
      const projectID = await resolveProjectID(ctx, directory, session)
      if (projectID) {
        const stats = await ctx.client.session.stats({ project: projectID, tools: "detail" })
        if (stats?.range) {
          project = {
            rangeFrom: num(stats.range.from),
            rangeTo: num(stats.range.to),
            sessions: num(stats.sessions),
            subagents: num(stats.subagents),
            prompts: num(stats.prompts),
            steps: num(stats.steps),
            tokens:
              num(stats.tokens?.input) +
              num(stats.tokens?.output) +
              num(stats.tokens?.reasoning) +
              num(stats.tokens?.cache?.read) +
              num(stats.tokens?.cache?.write),
            cost: num(stats.cost),
          }
        }
      } else {
        warnings.push("project id unavailable — project totals hidden")
      }
    } catch {
      warnings.push("project totals unavailable")
    }
  }

  const latest = latestCompletedStep(records)
  const contextUsed = latest?.usage ? promptTokens(latest.usage) : undefined
  const contextLimit = resolveContextLimit(ctx, latest?.model)
  const sessionTokens = sessionUsage(session)
  const costKnown = session !== undefined && (session.cost !== undefined || reportedCost !== undefined)

  return {
    sessionID,
    title: session?.title,
    status,
    updatedAt: num(session?.time?.updated),
    sessionTokens,
    sessionCost: costKnown ? (session?.cost ?? reportedCost) : undefined,
    contextLimit,
    contextUsed,
    records,
    subagents: subagentRows,
    project,
    warnings,
  }
}

function safeRoot(ctx: LoadContext, sessionID: string): string {
  try {
    return ctx.data.session.root(sessionID)
  } catch {
    return sessionID
  }
}

/**
 * Context-window limit for the model that produced the newest step, resolved
 * through the documented location model registry (`data.location.model.list`),
 * with the prompt's selected model (`ui.model.current`) as fallback. Unknown
 * model → undefined (the context row is hidden rather than guessed).
 */
function resolveContextLimit(
  ctx: LoadContext,
  stepModel?: { providerID: string; id: string },
): number | undefined {
  try {
    const models = ctx.data.location.model.list(ctx.data.location.default()) ?? []
    const matches = (m: { providerID: string; id: string; modelID: string }, ref: { providerID: string; id: string }) =>
      m.providerID === ref.providerID && (m.id === ref.id || m.modelID === ref.id)
    const selected = ctx.ui.model.current()
    const hit =
      (stepModel && models.find((m) => matches(m, stepModel))) ||
      (selected && models.find((m) => matches(m, { providerID: selected.providerID, id: selected.modelID })))
    return hit?.limit.context
  } catch {
    return undefined
  }
}

/** Fetch root sessions for the selector, server-side, newest first. */
export async function listRootSessions(
  ctx: LoadContext,
  directory: string,
  limit = 100,
): Promise<SessionInfo[]> {
  try {
    // The generated client returns SessionsResponse: { data: SessionInfo[], cursor }.
    const res = await ctx.client.session.list({
      parentID: null,
      archived: false,
      directory,
      order: "desc",
      limit,
    })
    return res.data
  } catch {
    // fall back to the cache; filter to roots client-side
    return ctx.data.session
      .list()
      .filter((s) => !s.parentID)
      .sort((a, b) => num(b.time?.updated) - num(a.time?.updated))
  }
}
