/** @jsxImportSource @opentui/solid */
// CLI plugin entry: /tokens_usage command, route detection, selector, panel.
// Pure script — no LLM anywhere.
//
// Presentation uses the documented session-panel mechanism (v2 docs,
// "Session panels"): a `session.panel` slot contribution renders the stats,
// and the command opens it with `ui.panel.open(name, { presentation:
// "fullscreen" })`. The host owns sizing, focus, and full-screen layout
// (it also hides the sidebar); the plugin owns its contents.

import { createSignal, Show } from "solid-js"
import { Plugin, usePlugin as usePluginTui } from "@opencode/plugin/tui"
import type { SessionInfo } from "@opencode/client"
import { loadSnapshot, listRootSessions, setContextLimitLoader, type LoadContext } from "./data.ts"
import { buildViewModel } from "./stats.ts"
import { StatsView, type ViewState } from "./view.tsx"
import { formatCompact, formatCost, formatRelative } from "./format.ts"
import { usageTotal } from "./types.ts"

/** The TUI plugin context; imported structurally to avoid type-name drift. */
type TuiContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

/** Panel name for this plugin's stats contribution (plugin-prefixed). */
const PANEL_NAME = "loaf.tokens-usage.stats"

export default Plugin.define({
  id: "loaf.tokens-usage",
  setup(ctx) {
    pluginCtx = ctx
    setContextLimitLoader(() => resolveContextLimit(ctx))

    // Register the panel contribution once at setup; it renders only when
    // this panel is selected (host passes panel.name to every contribution).
    ctx.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL_NAME}>
          <PanelHost panel={panel} />
        </Show>
      ),
    })

    // Command layer lives on an app-slot component so it is disposed and
    // re-created with the plugin lifecycle per the docs' example pattern.
    ctx.ui.slot({
      append: "app",
      render: () => {
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
        return null
      },
    })
  },
})

// ---------------------------------------------------------------------------
// Panel wiring: one stats session at a time, shared via module-level signals.
// ---------------------------------------------------------------------------

type PanelApi = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

const [panelState, setPanelState] = createSignal<ViewState>({ status: "loading" })
const [panelRefreshing, setPanelRefreshing] = createSignal(false)
let panelSessionID: string | undefined
let panelGeneration = 0
/** Captured during setup; panel contributions and commands run inside the plugin. */
let pluginCtx: PanelApi | undefined

function PanelHost(props: {
  panel: { sessionID: string; close: () => void; focused: boolean }
}) {
  // Mounting the contribution means the panel is open for this sessionID.
  // Kick a load if this is a newly opened panel (different session).
  if (panelSessionID !== props.panel.sessionID && pluginCtx) {
    void refreshPanel(pluginCtx, props.panel.sessionID)
  }
  // Panel-scoped keymap layer: active only while the panel owns input
  // (docs: "Its keyboard layers ... are active only while the panel owns
  // input"), and disposed automatically when the panel closes.
  usePluginTui().keymap.layer(() => ({
    mode: "global",
    priority: 100,
    commands: [
      { id: "tokens-usage.close", bind: "escape", run: () => props.panel.close() },
      {
        id: "tokens-usage.refresh",
        bind: "r",
        run: () => {
          if (panelSessionID && pluginCtx) void refreshPanel(pluginCtx, panelSessionID)
        },
      },
    ],
    bindings: ["tokens-usage.close", "tokens-usage.refresh"],
  }))
  return (
    <StatsView
      state={panelState()}
      refreshing={panelRefreshing()}
      onClose={props.panel.close}
      onRefresh={() => {
        if (panelSessionID && pluginCtx) void refreshPanel(pluginCtx, panelSessionID)
      }}
    />
  )
}


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
  if (ctx.ui.panel.current()?.name === PANEL_NAME) return // already open
  const sessionID = currentSessionID(ctx)
  if (sessionID) {
    openPanelFor(ctx, sessionID)
    return
  }
  await showSelector(ctx)
}

/**
 * Prepare data for `sessionID` and open the panel in full-screen presentation.
 * The contribution (PanelHost) renders once the host mounts it; if the panel
 * is already open for a different session, the same signals swap the content.
 */
function openPanelFor(ctx: TuiContext, sessionID: string): void {
  panelSessionID = sessionID
  void refreshPanel(ctx, sessionID)
  const opened = ctx.ui.panel.open(PANEL_NAME, { presentation: "fullscreen" })
  if (!opened) {
    panelSessionID = undefined
    ctx.ui.toast.show({ message: "Open a session first", variant: "warning" })
  }
}

/** Load (or reload) stats for the panel's session into the shared signals. */
async function refreshPanel(ctx: TuiContext, sessionID: string): Promise<void> {
  const generation = ++panelGeneration
  if (panelState().status === "ready") {
    setPanelRefreshing(true)
  }
  try {
    ctx.data.session.message.invalidate(sessionID)
    const snapshot = await loadSnapshot(ctx as unknown as LoadContext, sessionID)
    if (generation !== panelGeneration) return // stale
    setPanelState({ status: "ready", model: buildViewModel(snapshot) })
  } catch (error) {
    if (generation !== panelGeneration) return
    setPanelState({
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    if (generation === panelGeneration) setPanelRefreshing(false)
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

  // The host's dialog select() resets size/centered internally, so set the
  // presentation AFTER opening (set applies to the active dialog).
  ctx.ui.dialog.set({ size: "xlarge", centered: true })
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
  // Panels open only inside a session; from the home screen, navigate to the
  // chosen session first, then open the panel.
  ctx.ui.router.navigate({ type: "session", sessionID: selected })
  openPanelFor(ctx, selected)
}
