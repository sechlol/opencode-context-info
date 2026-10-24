// Async I/O: loads a SessionSnapshot from the opencode client + cached data.
// This is the ONLY module that knows OpenCode schema details; everything
// downstream consumes the view-model types from types.ts.

import type { SessionMessageInfo, SessionInfo, TokenUsageInfo } from "@opencode/client"
import type { UsageRecord, SessionSnapshot, Usage } from "./types.ts"

/** Minimal structural slice of the TUI plugin context we depend on. */
export interface LoadContext {
  client: {
    session: {
      stats(input?: {
        project?: string
        tools?: "none" | "summary" | "detail"
      }): Promise<{
        range: { from: number; to: number }
        sessions: number
        subagents: number
        prompts: number
        steps: number
        tokens: TokenUsageInfo
        cost: number
      }>
      list(input?: {
        limit?: number
        order?: "asc" | "desc"
        parentID?: string | null
        archived?: boolean
        directory?: string
        project?: string
        search?: string
      }): Promise<{ sessions?: SessionInfo[] } & Record<string, unknown>>
      context?(input: { sessionID: string }): Promise<SessionMessageInfo[]>
    }
    location: {
      get(input?: { location?: { directory?: string } }): Promise<{
        project: { id: string; directory: string; canonical: string }
      }>
    }
  }
  data: {
    session: {
      list(): SessionInfo[]
      get(sessionID: string): SessionInfo | undefined
      root(sessionID: string): string
      family(sessionID: string): string[]
      cost(sessionID: string): number
      status(sessionID: string): "idle" | "running"
      sync(sessionID: string): Promise<void>
      message: {
        list(sessionID: string): SessionMessageInfo[]
        sync(sessionID: string): Promise<void>
        invalidate(sessionID: string): void
      }
    }
    location: {
      default(): { directory: string }
    }
  }
}

function toUsage(t: TokenUsageInfo | undefined): Usage | undefined {
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

function isRecord(m: SessionMessageInfo): m is SessionMessageInfo & { type: "assistant" } {
  return (m as { type?: string }).type === "assistant"
}

function isCompaction(m: SessionMessageInfo): boolean {
  return (m as { type?: string }).type === "compaction"
}

function countToolCalls(m: SessionMessageInfo): number {
  const content = (m as { content?: unknown }).content
  if (!Array.isArray(content)) return 0
  return content.filter((part) => (part as { type?: string })?.type === "tool").length
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
      if (isRecord(m)) {
        const time = (m as { time?: { created?: number } }).time
        const model = (m as { model?: { id?: string; providerID?: string; variant?: string } }).model
        const usage = toUsage((m as { tokens?: TokenUsageInfo }).tokens)
        const costRaw = (m as { cost?: unknown }).cost
        const cost = num(costRaw)
        const finish = (m as { finish?: unknown }).finish
        records.push({
          at: num(time?.created),
          completed: usage !== undefined && finish !== "error",
          kind: "assistant",
          agent: (m as { agent?: string }).agent,
          model: {
            providerID: model?.providerID ?? "unknown",
            id: model?.id ?? "unknown",
            variant: model?.variant,
          },
          usage,
          cost: usage !== undefined ? cost : 0,
          toolCalls: countToolCalls(m),
        })
        continue
      }
      if (isCompaction(m)) {
        const status = (m as { status?: string }).status
        if (status !== "completed" && status !== "failed") continue
        const usage = toUsage((m as { tokens?: TokenUsageInfo }).tokens)
        const cost = num((m as { cost?: unknown }).cost)
        records.push({
          at: num((m as { time?: { created?: number } }).time?.created),
          completed: usage !== undefined && status !== "failed",
          kind: "compaction",
          model: { providerID: "unknown", id: "compaction" },
          usage,
          cost: usage !== undefined ? cost : 0,
          toolCalls: 0,
        })
        continue
      }
      skipped++
    } catch {
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

/** Context-window estimate: prompt side of the newest assistant step, if any. */
function contextUsedFromRecords(records: UsageRecord[]): number | undefined {
  const last = [...records]
    .filter((r) => r.kind === "assistant" && r.completed && r.usage)
    .sort((a, b) => b.at - a.at)[0]
  if (!last?.usage) return undefined
  return last.usage.input + last.usage.cacheRead + last.usage.cacheWrite
}

const projectIDCache = new Map<string, string>()

async function resolveProjectID(
  ctx: LoadContext,
  directory: string,
  session: SessionInfo | undefined,
): Promise<string | undefined> {
  const fromSession = (session as { projectID?: string } | undefined)?.projectID
  if (fromSession) return fromSession
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

  const contextUsed = contextUsedFromRecords(records)
  const contextLimit = contextLimitLoader?.()
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
 * The model context limit comes from the host's model registry, which lives in
 * the TUI plugin context rather than the LoadContext slice. `tui.tsx` injects
 * a loader here during setup.
 */
let contextLimitLoader: (() => number | undefined) | undefined

export function setContextLimitLoader(loader: () => number | undefined): void {
  contextLimitLoader = loader
}

/** Fetch root sessions for the selector, server-side, newest first. */
export async function listRootSessions(
  ctx: LoadContext,
  directory: string,
  limit = 100,
): Promise<SessionInfo[]> {
  try {
    const res = await ctx.client.session.list({
      parentID: null,
      archived: false,
      directory,
      order: "desc",
      limit,
    })
    const sessions = (res as { sessions?: SessionInfo[]; data?: { sessions?: SessionInfo[] } })
    return sessions.sessions ?? (sessions as unknown as { data?: { sessions?: SessionInfo[] } }).data?.sessions ?? []
  } catch {
    // fall back to the cache; filter to roots client-side
    return ctx.data.session
      .list()
      .filter((s) => !(s as { parentID?: string }).parentID)
      .sort((a, b) => num(b.time?.updated) - num(a.time?.updated))
  }
}
