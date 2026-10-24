/** @jsxImportSource @opentui/solid */
// CLI plugin entry: /tokens_usage command, route detection, selector, dialog.
// Pure script — no LLM anywhere.

import { createSignal, Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import type { SessionInfo } from "@opencode/client"
import { loadSnapshot, listRootSessions, setContextLimitLoader, type LoadContext } from "./data.ts"
import { buildViewModel } from "./stats.ts"
import { StatsView, type ViewState } from "./view.tsx"
import { formatCompact, formatCost, formatRelative } from "./format.ts"
import { usageTotal } from "./types.ts"

/** The TUI plugin context; imported structurally to avoid type-name drift. */
type TuiContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

/** Guard against overlapping runs and stale async results. */
let runGeneration = 0
let dialogOpen = false

export default Plugin.define({
  id: "loaf.tokens-usage",
  setup(ctx) {
    setContextLimitLoader(() => resolveContextLimit(ctx))

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "tokens-usage.show",
          title: "Show token usage",
          group: "Tokens",
          description: "Session token statistics and cost, no LLM involved",
          palette: true,
          slash: { name: "tokens_usage", aliases: ["usage"] },
          run: () => {
            void show(ctx)
          },
        },
      ],
    }))
  },
})

function resolveContextLimit(ctx: TuiContext): number | undefined {
  try {
    const location = ctx.location ?? ctx.data.location.default()
    const models = ctx.data.location.model.list(location) ?? []
    let best: number | undefined
    for (const m of models) {
      const c = (m as { limit?: { context?: number } }).limit?.context
      if (typeof c === "number" && c > 0 && (best === undefined || c > best)) best = c
    }
    return best
  } catch {
    return undefined
  }
}

function currentSessionID(ctx: TuiContext): string | undefined {
  try {
    const route = ctx.ui.router.current()
    if (route.type === "session") return route.sessionID
    return undefined
  } catch {
    return undefined
  }
}

async function show(ctx: TuiContext): Promise<void> {
  if (dialogOpen) return
  const sessionID = currentSessionID(ctx)
  if (sessionID) {
    await showStats(ctx, sessionID)
    return
  }
  await showSelector(ctx)
}

function dialogSize(_ctx: TuiContext): "xlarge" {
  // The host maps DialogSize presets to FIXED widths (medium 60 / large 88 /
  // xlarge 116 columns) — not fractions of the terminal. StatsView therefore
  // sizes its own content box to 85% of the terminal (see view.tsx); here we
  // just request the largest container so wide terminals aren't capped at 116.
  return "xlarge"
}

async function showStats(ctx: TuiContext, sessionID: string): Promise<void> {
  const generation = ++runGeneration
  dialogOpen = true

  const [state, setState] = createSignal<ViewState>({ status: "loading" })
  const [refreshing, setRefreshing] = createSignal(false)

  const close = () => {
    ctx.ui.dialog.clear()
  }

  const load = async (isRefresh: boolean) => {
    if (isRefresh) {
      const current = state()
      setState({ status: "loading", previous: current.status === "ready" ? current.model : current.previous })
    }
    try {
      ctx.data.session.message.invalidate(sessionID)
      const snapshot = await loadSnapshot(ctx as unknown as LoadContext, sessionID)
      if (generation !== runGeneration) return // stale
      setState({ status: "ready", model: buildViewModel(snapshot) })
    } catch (error) {
      if (generation !== runGeneration) return
      const current = state()
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        previous: current.status === "ready" ? current.model : current.previous,
      })
    }
  }

  await load(false)
  if (generation !== runGeneration) {
    dialogOpen = false
    return
  }
  if (currentSessionID(ctx) !== sessionID) {
    dialogOpen = false
    return // user navigated away mid-load
  }

  // centered: true — vertically/horizontally centered instead of bottom-docked.
  // size: pick the largest preset that fits the terminal (the host owns the
  // exact pixel mapping; DialogSize has no percentage option).
  ctx.ui.dialog.set({ size: dialogSize(ctx), centered: true })
  // In-dialog keymap layer: escape closes (NOT guaranteed for custom dialogs),
  // r refreshes. mode: "global" because the layer default is "base" and a
  // dialog may not be in that mode.
  ctx.keymap.layer(() => ({
    mode: "global",
    priority: 100,
    commands: [
      {
        id: "tokens-usage.close",
        bind: "escape",
        run: () => close(),
      },
      {
        id: "tokens-usage.refresh",
        bind: "r",
        run: () => {
          void refresh()
        },
      },
    ],
    bindings: ["tokens-usage.close", "tokens-usage.refresh"],
  }))

  ctx.ui.dialog.show(
    () => (
      <Show when={dialogOpen}>
        <StatsView state={state()} refreshing={refreshing()} />
      </Show>
    ),
    () => {
      dialogOpen = false
      runGeneration++ // cancel in-flight refreshes
    },
  )

  async function refresh() {
    if (refreshing()) return
    setRefreshing(true)
    try {
      await load(true)
    } finally {
      setRefreshing(false)
    }
  }
}
async function showSelector(ctx: TuiContext): Promise<void> {
  const location = ctx.location ?? ctx.data.location.default()
  const directory = (location as { directory?: string }).directory ?? ""
  let sessions: SessionInfo[] = []
  try {
    sessions = await listRootSessions(ctx as unknown as LoadContext, directory, 100)
  } catch {
    sessions = ctx.data.session.list().filter((s) => !(s as { parentID?: string }).parentID)
  }
  if (sessions.length === 0) {
    ctx.ui.toast.show({ message: "No sessions in this project", variant: "info" })
    return
  }

  const options = sessions.map((s) => {
    const tokens = s.tokens
      ? usageTotal({
          input: s.tokens.input,
          output: s.tokens.output,
          reasoning: s.tokens.reasoning,
          cacheRead: s.tokens.cache?.read ?? 0,
          cacheWrite: s.tokens.cache?.write ?? 0,
        })
      : 0
    let busy = false
    try {
      busy = ctx.data.session.status(s.id) === "running"
    } catch {
      busy = false
    }
    return {
      title: s.title || "Untitled",
      value: s.id,
      description: `${formatRelative(s.time?.updated ?? 0)} · ${busy ? "running" : "idle"} · ${formatCompact(tokens)} tk`,
      footer: formatCost(s.cost),
    }
  })

  ctx.ui.dialog.set({ size: dialogSize(ctx), centered: true })
  const selected = await ctx.ui.dialog.select({
    title: "Token usage — select a session",
    options,
    search: (query, opts) => {
      const q = query.toLowerCase()
      if (!q) return opts
      return opts.filter((o) => o.title.toLowerCase().includes(q))
    },
  })

  if (!selected) return
  await showStats(ctx, selected)
}
