/** @jsxImportSource @opentui/solid */
// CLI plugin entry: /tokens_usage command, session selector, centered stats
// dialog. Pure script — no LLM anywhere.
//
// Presentation uses the documented dialog mechanism (v2 docs, "Dialogs and
// toasts"). One verified deviation from the docs example: `dialog.set()` must
// be called IMMEDIATELY AFTER `dialog.show()`, not before it as the docs show
// — on 2.1.4 set-before-show is a no-op (all dialogs stay on the default
// 60-col preset), while show-then-set applies size and re-centers. Verified
// empirically; see docs/discrepancies_verification.md.
//
// Size presets are fixed column widths (medium 60 / large 88 / xlarge 116),
// so fittedDialogSize() picks the largest preset that fits the terminal —
// no content-width hacks, no terminal-dimension probing in the view.

import { createSignal } from "solid-js"
import { Plugin, usePlugin as usePluginTui } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"
import { loadSnapshot, listRootSessions, toUsage } from "./data.ts"
import { buildViewModel } from "./stats.ts"
import { StatsView, type ViewState } from "./view.tsx"
import { formatCompact, formatCost, formatRelative } from "./format.ts"
import { usageTotal } from "./types.ts"

/** Set while the stats dialog is open; consulted by the setup-level event hook. */
let dialogOpen = false
let activeSessionID: string | undefined
let activeRefresh: (() => void) | undefined
/** Escape-close for the active dialog; set while the stats dialog is open. */
let requestClose: (() => void) | undefined

export default Plugin.define({
  id: "loaf.tokens-usage",
  setup(ctx) {
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

    // Documented event API (docs: Events → data.on): refresh the open dialog
    // when a run in ITS session finishes, debounced so batched events
    // coalesce. Unsubscribed via the cleanup returned from setup.
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const stop = ctx.data.on("session.execution.succeeded", (event) => {
      if (!dialogOpen || event.data.sessionID !== activeSessionID) return
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        if (dialogOpen) activeRefresh?.()
      }, 500)
    })
    return () => {
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      stop()
    }
  },
})

// ---------------------------------------------------------------------------
// Dialog lifecycle: fresh signals per open, no stale-session flashes.
// ---------------------------------------------------------------------------

function currentSessionID(ctx: Context): string | undefined {
  try {
    const route = ctx.ui.router.current()
    if (route.type === "session") return route.sessionID
    return undefined
  } catch {
    return undefined
  }
}

/** Largest fixed preset that fits the terminal (presets are 60/88/116 cols). */
function fittedDialogSize(ctx: Context): "medium" | "large" | "xlarge" {
  try {
    const cols = ctx.renderer.width
    if (cols >= 120) return "xlarge"
    if (cols >= 92) return "large"
  } catch {
    // renderer not ready — fall through
  }
  return "medium"
}

async function show(ctx: Context): Promise<void> {
  if (dialogOpen) return // one stats dialog at a time
  const sessionID = currentSessionID(ctx) ?? (await showSelector(ctx))
  if (sessionID) openStatsDialog(ctx, sessionID)
}

function openStatsDialog(ctx: Context, sessionID: string): void {
  dialogOpen = true
  activeSessionID = sessionID

  const [state, setState] = createSignal<ViewState>({ status: "loading" })
  const [refreshing, setRefreshing] = createSignal(false)
  let generation = 0

  const load = async (isRefresh: boolean): Promise<void> => {
    const gen = ++generation
    if (isRefresh && state().status === "ready") setRefreshing(true)
    try {
      ctx.data.session.message.invalidate(sessionID)
      const snapshot = await loadSnapshot(ctx, sessionID)
      if (gen !== generation) return // stale
      setState({ status: "ready", model: buildViewModel(snapshot) })
    } catch (error) {
      if (gen !== generation) return
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (gen === generation) setRefreshing(false)
    }
  }

  activeRefresh = () => {
    void load(true)
  }

  // Idempotent state reset — used both as show()'s onClose and (together
  // with clear()) by the escape binding, so reopening works whether or not
  // clear() ends up invoking onClose.
  const reset = () => {
    dialogOpen = false
    activeSessionID = undefined
    activeRefresh = undefined
    requestClose = undefined
    generation++ // cancel in-flight loads
  }
  requestClose = () => {
    reset()
    ctx.ui.dialog.clear()
  }

  // Show first, THEN set — verified order (see header comment): set() applies
  // to the active dialog; before show() it is silently ignored.
  ctx.ui.dialog.show(
    () => <DialogHost state={state()} refreshing={refreshing()} onRefresh={() => void load(true)} />,
    reset,
  )
  ctx.ui.dialog.set({ size: fittedDialogSize(ctx), centered: true })
  void load(false)
}

/**
 * In-dialog body: escape closes (custom dialogs have no guaranteed
 * escape-to-close) and r refreshes. The layer lives on this component, so it
 * is disposed automatically when the dialog closes (docs: layers created by a
 * component die with it).
 */
function DialogHost(props: { state: ViewState; refreshing: boolean; onRefresh: () => void }) {
  const ctx = usePluginTui()
  ctx.keymap.layer(() => ({
    mode: "global",
    priority: 100,
    commands: [
      { id: "tokens-usage.close", bind: "escape", run: () => requestClose?.() },
      { id: "tokens-usage.refresh", bind: "r", run: props.onRefresh },
    ],
    bindings: ["tokens-usage.close", "tokens-usage.refresh"],
  }))
  return <StatsView state={props.state} refreshing={props.refreshing} onRefresh={props.onRefresh} />
}

/** Session picker for when no session is focused (home screen). */
async function showSelector(ctx: Context): Promise<string | undefined> {
  const location = ctx.location ?? ctx.data.location.default()
  const directory = location.directory
  let sessions: SessionInfo[] = []
  try {
    sessions = await listRootSessions(ctx, directory, 100)
  } catch {
    sessions = ctx.data.session.list().filter((s) => !s.parentID)
  }
  if (sessions.length === 0) {
    ctx.ui.toast.show({ message: "No sessions in this project", variant: "info" })
    return undefined
  }

  const options = sessions.map((s) => {
    const usage = toUsage(s.tokens)
    const tokens = usage ? usageTotal(usage) : 0
    const busy = ctx.data.session.status(s.id) === "running"
    return {
      title: s.title || "Untitled",
      value: s.id,
      description: `${formatRelative(s.time.updated)} · ${busy ? "running" : "idle"} · ${formatCompact(tokens)} tk`,
      footer: formatCost(s.cost),
    }
  })

  // Promise-based select at the host default size (fits any terminal).
  // dialog.set() before select() was never observed to apply (see
  // docs/discrepancies_verification.md), so no size is requested here.
  return await ctx.ui.dialog.select({
    title: "Token usage — select a session",
    options,
    search: (query, opts) => {
      const q = query.toLowerCase()
      if (!q) return opts
      return opts.filter((o) => o.title.toLowerCase().includes(q))
    },
  })
}